/** 飞书媒体：应用令牌、素材上传、消息发送与入站资源下载。 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as feishu from './Feishu.ts';

/** 飞书消息类型。 */
export type MessageType = 'image' | 'file' | 'audio' | 'media' | 'post' | 'interactive';
/** 工具和渠道之间的发送参数；路径由工具按工作区解析。 */
export interface SendRequest {
  type: MessageType;
  path?: string;
  name?: string;
  duration?: number;
  coverPath?: string;
  content?: Record<string, unknown>;
}
/** 飞书 JSON 接口与资源接口共用的客户端。 */
export interface OpenApi {
  json(method: string, apiPath: string, body?: unknown): Promise<Record<string, unknown>>;
  download(apiPath: string): Promise<Response>;
}
/** 接口错误包含权限提示，不暴露令牌或密钥。 */
function apiError(apiPath: string, result: { code?: number; msg?: string }): Error {
  const permission = /permission|scope|access denied/i.test(result.msg ?? '') || result.code === 99991672 || result.code === 234009;
  return new Error(`飞书接口 ${apiPath}：${result.msg ?? '请求失败'}（code ${String(result.code)}）${permission ? '；请检查应用权限 im:resource（上传）、im:message（资源下载）、im:message:send_as_bot（发送），发布应用版本后重试' : ''}`);
}
/** 可注入 HTTP，用于离线验证权限报错及令牌缓存。 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
/** 自建应用 tenant_access_token 自动缓存、刷新；上传时由 fetch 设置 multipart boundary。 */
export function createOpenApi(appId: string, appSecret: string, http: FetchLike = fetch): OpenApi {
  let cached: { token: string; expiresAt: number } | undefined;
  let refreshing: Promise<string> | undefined;
  async function token(): Promise<string> {
    if (cached && Date.now() < cached.expiresAt) {
      return cached.token;
    }
    refreshing ??= (async () => {
      const response = await http('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }), signal: AbortSignal.timeout(30_000),
      });
      const result = await response.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
      if (!response.ok || result.code !== 0 || !result.tenant_access_token) {
        throw apiError('/auth/v3/tenant_access_token/internal', result);
      }
      cached = { token: result.tenant_access_token, expiresAt: Date.now() + Math.max(1, (result.expire ?? 7200) - 300) * 1000 };
      return cached.token;
    })();
    try {
      return await refreshing;
    } finally {
      refreshing = undefined;
    }
  }
  async function request(method: string, apiPath: string, body?: unknown): Promise<Response> {
    const multipart = body instanceof FormData;
    let requestBody: BodyInit | undefined;
    if (multipart) { requestBody = body; }
    else if (body !== undefined) { requestBody = JSON.stringify(body); }
    const response = await http(`https://open.feishu.cn/open-apis${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, ...(!multipart ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
      body: requestBody,
      signal: AbortSignal.timeout(120_000),
    });
    return response;
  }
  return {
    async json(method, apiPath, body) {
      //M 飞书写入接口有 QPS 限制，429 时等一等等再试（没被接受，重试不会重复插块）；其他错误直接抛。
      for (let attempt = 0; ; attempt++) {
        const response = await request(method, apiPath, body);
        /** 先当文本读：出错时可能没有 body，也可能不是 JSON。 */
        const text = await response.text();
        /** 解析后的结果；不是 JSON 时没有。 */
        let result: { code?: number; msg?: string; data?: Record<string, unknown> } | undefined;
        try { result = text ? JSON.parse(text) as typeof result : undefined; } catch { result = undefined; }
        if (response.status === 429 && attempt < 5) {
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
          continue;
        }
        if (!response.ok || result?.code !== 0) {
          const detail = result
            ? apiError(apiPath, result)
            : new Error(`飞书接口 ${apiPath}：HTTP ${response.status}，返回的不是 JSON：${text.slice(0, 300) || '（空）'}`);
          throw detail;
        }
        return result.data ?? {};
      }
    },
    async download(apiPath) {
      const response = await request('GET', apiPath);
      if (!response.ok) {
        throw apiError(apiPath, await response.json() as { code?: number; msg?: string });
      }
      if (response.headers.get('content-type')?.includes('application/json') && !response.headers.has('content-disposition')) {
        const result = await response.clone().json() as { code?: number; msg?: string };
        if (typeof result.code === 'number' && result.code !== 0) { throw apiError(apiPath, result); }
      }
      return response;
    },
  };
}
/** 上传本地素材；空文件、目录、超限及不支持的语音/视频格式在上传前报错。 */
async function upload(api: OpenApi, file: string, type: 'image' | 'file' | 'audio' | 'media', name?: string, duration?: number): Promise<string> {
  const stat = await fs.stat(file);
  const max = (type === 'image' ? 10 : 30) * 1024 * 1024;
  if (!stat.isFile() || stat.size === 0 || stat.size > max) {
    throw new Error(`素材必须是非空文件，${type === 'image' ? '图片不超过 10MB' : '文件不超过 30MB'}：${file}`);
  }
  const ext = path.extname(file).toLowerCase();
  if (type === 'audio' && ext !== '.opus') {
    throw new Error('飞书语音消息需要 .opus 文件；其他音频可用 feishu_send_file 发送，或先转成 Opus');
  }
  if (type === 'media' && ext !== '.mp4') {
    throw new Error('飞书视频消息需要 .mp4 文件；其他格式可用 feishu_send_file 发送');
  }
  if (type === 'image' && !['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.tif', '.bmp', '.ico'].includes(ext)) {
    throw new Error('图片格式需为 JPEG/PNG/WEBP/GIF/TIFF/BMP/ICO');
  }
  if (duration !== undefined && (!Number.isInteger(duration) || duration < 1)) {
    throw new Error('duration 必须是正整数毫秒');
  }
  const form = new FormData();
  const fileName = path.basename((name ?? path.basename(file)).replaceAll('\\', '/'));
  const image = type === 'image';
  if (image) {
    form.set('image_type', 'message');
  } else {
    const types: Record<string, string> = { '.pdf': 'pdf', '.doc': 'doc', '.docx': 'doc', '.xls': 'xls', '.xlsx': 'xls', '.ppt': 'ppt', '.pptx': 'ppt' };
    let fileType = types[ext] ?? 'stream';
    if (type === 'audio') { fileType = 'opus'; }
    if (type === 'media') { fileType = 'mp4'; }
    form.set('file_type', fileType);
    form.set('file_name', fileName);
    if (duration !== undefined) { form.set('duration', String(duration)); }
  }
  form.set(image ? 'image' : 'file', new Blob([await fs.readFile(file)]), fileName);
  const data = await api.json('POST', image ? '/im/v1/images' : '/im/v1/files', form);
  const key = data[image ? 'image_key' : 'file_key'];
  if (typeof key !== 'string' || !key) { throw new Error('飞书上传成功但没有返回素材 key'); }
  return key;
}
/** 真实传输层的媒体能力，与文字/卡片共用消息 API。 */
export function createMediaTransport(api: OpenApi): Pick<feishu.FeishuTransport, 'sendMedia' | 'downloadResource'> {
  return {
    async sendMedia(to, request) {
      let content = request.content;
      if (request.type !== 'post' && request.type !== 'interactive') {
        if (!request.path) { throw new Error('缺少本地素材 path'); }
        const key = await upload(api, request.path, request.type, request.name, request.duration);
        content = request.type === 'image' ? { image_key: key } : { file_key: key };
        if (request.type === 'media' && request.coverPath) {
          content.image_key = await upload(api, request.coverPath, 'image');
        }
      }
      if (!content || !Object.keys(content).length) { throw new Error('消息 content 不能为空'); }
      const target = 'chatId' in to ? { id: to.chatId, type: 'chat_id' } : { id: to.openId, type: 'open_id' };
      const data = await api.json('POST', `/im/v1/messages?receive_id_type=${target.type}`, {
        receive_id: target.id, msg_type: request.type, content: JSON.stringify(content),
      });
      if (typeof data.message_id !== 'string' || !data.message_id) { throw new Error('飞书发送成功但没有返回消息 ID'); }
      return data.message_id;
    },
    async downloadResource(messageId, resource, destination) {
      const response = await api.download(`/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resource.key)}?type=${resource.type}`);
      // 限制响应体大小，服务端未给 content-length 时也逐块检查。
      const max = 100 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > max) {
        await response.body?.cancel();
        throw new Error('飞书附件超过 100MB 下载限制');
      }
      const reader = response.body?.getReader();
      if (!reader) { throw new Error('飞书资源响应没有内容'); }
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { break; }
          size += value.length;
          if (size > max) { throw new Error('飞书附件超过 100MB 下载限制'); }
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, Buffer.concat(chunks), { flag: 'wx' });
    },
  };
}
