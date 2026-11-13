/** 飞书媒体：应用令牌、素材上传、消息发送与入站资源下载。 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as feishu from './Feishu.ts';

/** 飞书消息类型。 */
export type MessageType = 'image' | 'file' | 'audio' | 'media' | 'post' | 'interactive';
/** 工具和渠道之间的发送参数；路径由工具按工作区解析。 */
export type SendRequest = feishu.MediaRequest;
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
/**
 * 飞书开放接口的客户端：自建应用的 tenant_access_token 自动缓存、刷新（并发时只刷新一次）；
 * JSON 接口遇到 429 等一等再试；下载资源。上传时由 fetch 设置 multipart boundary。
 * 建它的地方：src/channels/Feishu.ts 的 SdkTransport（发卡片、图片、附件）和 FeishuChannel（云文档）。
 */
export class FeishuOpenApi implements OpenApi {
  /** 缓存的令牌和过期时间（毫秒）。 */
  private cached: { token: string; expiresAt: number } | undefined;
  /** 正在刷新令牌的那一次（几个请求同时要令牌时只刷新一次）。 */
  private refreshing: Promise<string> | undefined;

  /**
   * @param appId 应用 ID。
   * @param appSecret 应用密钥。
   * @param http 发请求的函数；默认 fetch，测试可以换。
   */
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly http: FetchLike = fetch,
  ) {}

  /**
   * 调一个 JSON 接口。飞书写入接口有 QPS 限制，429 时等一等再试（没被接受，重试不会重复插块）；其他错误直接抛。
   * @param method HTTP 方法。
   * @param apiPath /open-apis 后面的路径。
   * @param body 请求体（JSON，或上传用的 FormData）。
   * @returns 返回里的 data。
   */
  async json(method: string, apiPath: string, body?: unknown): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      /** 回应。 */
      const response = await this.request(method, apiPath, body);
      /** 先当文本读：出错时可能没有 body，也可能不是 JSON。 */
      const text = await response.text();
      /** 解析后的结果；不是 JSON 时没有。 */
      let result: { code?: number; msg?: string; data?: Record<string, unknown> } | undefined;
      try {
        result = text ? (JSON.parse(text) as typeof result) : undefined;
      } catch {
        result = undefined;
      }
      if (response.status === 429 && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      if (!response.ok || result?.code !== 0) {
        throw result
          ? apiError(apiPath, result)
          : new Error(`飞书接口 ${apiPath}：HTTP ${response.status}，返回的不是 JSON：${text.slice(0, 300) || '（空）'}`);
      }
      return result.data ?? {};
    }
  }

  /**
   * 下载一个资源（图片、附件）。
   * @param apiPath /open-apis 后面的路径。
   * @returns 回应（正文就是文件）。
   */
  async download(apiPath: string): Promise<Response> {
    /** 回应。 */
    const response = await this.request('GET', apiPath);
    if (!response.ok) {
      throw apiError(apiPath, (await response.json()) as { code?: number; msg?: string });
    }
    if (response.headers.get('content-type')?.includes('application/json') && !response.headers.has('content-disposition')) {
      /** 回了 JSON 而不是文件：多半是错误。 */
      const result = (await response.clone().json()) as { code?: number; msg?: string };
      if (typeof result.code === 'number' && result.code !== 0) {
        throw apiError(apiPath, result);
      }
    }
    return response;
  }

  /** 拿令牌：缓存没过期就用缓存，过期了刷新一次。 */
  private async token(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.token;
    }
    this.refreshing ??= (async () => {
      /** 回应。 */
      const response = await this.http('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
        signal: AbortSignal.timeout(30_000),
      });
      /** 结果。 */
      const result = (await response.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
      if (!response.ok || result.code !== 0 || !result.tenant_access_token) {
        throw apiError('/auth/v3/tenant_access_token/internal', result);
      }
      this.cached = { token: result.tenant_access_token, expiresAt: Date.now() + Math.max(1, (result.expire ?? 7200) - 300) * 1000 };
      return this.cached.token;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  /**
   * 带上令牌发一个请求。
   * @param method HTTP 方法。
   * @param apiPath /open-apis 后面的路径。
   * @param body 请求体：FormData 原样发，别的转成 JSON。
   * @returns 回应。
   */
  private async request(method: string, apiPath: string, body?: unknown): Promise<Response> {
    /** 是不是上传。 */
    const multipart = body instanceof FormData;
    /** 请求体。 */
    let requestBody: BodyInit | undefined;
    if (multipart) {
      requestBody = body;
    } else if (body !== undefined) {
      requestBody = JSON.stringify(body);
    }
    return this.http(`https://open.feishu.cn/open-apis${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, ...(!multipart ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
      body: requestBody,
      signal: AbortSignal.timeout(120_000),
    });
  }
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
/**
 * 飞书传输层的媒体那一半：上传素材再发图片、文件、语音、视频，下载收到的附件（和文字、卡片共用消息接口）。
 * src/channels/Feishu.ts 的 SdkTransport 继承它，再加上文字、卡片、表情、收消息。
 */
export class MediaTransport implements Pick<feishu.FeishuTransport, 'sendMedia' | 'downloadResource'> {
  /**
   * @param api 飞书开放接口（FeishuOpenApi，SdkTransport 建的）。
   */
  constructor(protected readonly api: OpenApi) {}

  /**
   * 上传素材并发消息（post、interactive 直接发 content）。
   * @param to 发给谁。
   * @param request 素材种类、本地路径、名字、时长、封面，或者现成的 content。
   * @returns 消息 ID。
   */
  async sendMedia(to: feishu.FeishuTarget, request: feishu.MediaRequest): Promise<string> {
    /** 消息内容。 */
    let content = request.content;
    if (request.type !== 'post' && request.type !== 'interactive') {
      if (!request.path) {
        throw new Error('缺少本地素材 path');
      }
      //G 请求形状是渠道通用的（type 是 string），飞书只认下面这几种，别的在这里就挡住。
      if (request.type !== 'image' && request.type !== 'file' && request.type !== 'audio' && request.type !== 'media') {
        throw new Error(`飞书不支持的素材种类 ${request.type}；只能是 image、file、audio、media、post、interactive`);
      }
      /** 素材 key。 */
      const key = await upload(this.api, request.path, request.type, request.name, request.duration);
      content = request.type === 'image' ? { image_key: key } : { file_key: key };
      if (request.type === 'media' && request.coverPath) {
        content.image_key = await upload(this.api, request.coverPath, 'image');
      }
    }
    if (!content || !Object.keys(content).length) {
      throw new Error('消息 content 不能为空');
    }
    /** 按聊天发还是按 open_id 发。 */
    const target = 'chatId' in to ? { id: to.chatId, type: 'chat_id' } : { id: to.openId, type: 'open_id' };
    /** 返回的数据。 */
    const data = await this.api.json('POST', `/im/v1/messages?receive_id_type=${target.type}`, {
      receive_id: target.id,
      msg_type: request.type,
      content: JSON.stringify(content),
    });
    if (typeof data.message_id !== 'string' || !data.message_id) {
      throw new Error('飞书发送成功但没有返回消息 ID');
    }
    return data.message_id;
  }

  /**
   * 把消息里的资源下载到指定文件（最多 100MB，服务端没给长度时逐块检查）。
   * @param messageId 消息 ID。
   * @param resource 资源（key、种类）。
   * @param destination 存到哪（已有同名文件时报错）。
   */
  async downloadResource(messageId: string, resource: feishu.Resource, destination: string): Promise<void> {
    /** 回应。 */
    const response = await this.api.download(`/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resource.key)}?type=${resource.type}`);
    /** 上限。 */
    const max = 100 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > max) {
      await response.body?.cancel();
      throw new Error('飞书附件超过 100MB 下载限制');
    }
    /** 读正文的。 */
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('飞书资源响应没有内容');
    }
    /** 读到的块。 */
    const chunks: Uint8Array[] = [];
    /** 读了多少字节。 */
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.length;
        if (size > max) {
          throw new Error('飞书附件超过 100MB 下载限制');
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, Buffer.concat(chunks), { flag: 'wx' });
  }
}
