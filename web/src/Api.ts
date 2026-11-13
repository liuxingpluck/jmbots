/**
 * 和后端说话：一律用相对地址（网页由后端托管，同源），不认识任何地址和端口。
 * 出错时抛 ApiError：status 是 HTTP 状态码，连不上时是 0。
 * 访问令牌（docs/界面/05_外部AI任务通道.md 第 3 节）：从局域网打开时地址带 ?token=，这里记进浏览器、从地址栏去掉，之后每个请求都带上；本机也要。
 */
import type * as types from './Types.ts';


/** 访问令牌在浏览器里存的键。 */
const TOKEN_KEY = 'jmbots.token';


/**
 * 现在用的访问令牌：地址里带了就记下（并从地址栏去掉，免得截图、复制时带出去），没带就用记着的。
 * @returns 令牌；没有是空字符串。
 */
function accessToken(): string {
  try {
    /** 地址里的。 */
    const fromUrl = new URLSearchParams(window.location.search).get('token');
    if (fromUrl) {
      window.localStorage.setItem(TOKEN_KEY, fromUrl);
      /** 去掉 token 以后的地址。 */
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      window.history.replaceState(null, '', url.toString());
    }
    return window.localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    //G 不是浏览器（测试里）或者存不了：当没有。
    return '';
  }
}


/** 启动时取一次。 */
const TOKEN = accessToken();


/** 接口出的错。 */
export class ApiError extends Error {
  /**
   * @param status HTTP 状态码；连不上后端时是 0。
   * @param message 说明（后端给的 error，或者网络错误）。
   */
  constructor(readonly status: number, message: string) {
    super(message);
  }
}


/**
 * 发请求、读 JSON。
 * @param url 相对地址，如 /api/bots。
 * @param init fetch 的选项。
 * @returns 解析好的 JSON。
 * @throws ApiError。
 */
export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  /** 回答。 */
  let response: Response;
  try {
    /** 令牌只在请求边界附加，调用方保留自己的其他选项。 */
    let requestOptions = init;
    if (TOKEN) {
      const headers = {
        ...(init?.headers as Record<string, string> | undefined),
        authorization: `Bearer ${TOKEN}`,
      };
      requestOptions = {
        ...init,
        headers,
      };
    }

    response = await fetch(url, requestOptions);
  } catch (error) {
    throw new ApiError(0, `连不上后端：${String(error)}`);
  }
  /** 正文。 */
  const text = await response.text();
  if (!response.ok) {
    //G 401 是让填令牌：发一个事件，TokenPrompt.tsx 听到就弹输入框。
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('jmbots:unauthorized'));
    }
    /** 后端给的错误说明。 */
    let message = text || response.statusText;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {
      //M 不是 JSON 就用原文。
    }
    throw new ApiError(response.status, message);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}


/**
 * 发 JSON。
 * @param url 相对地址。
 * @param method POST 或 PUT。
 * @param body 请求体。
 */
export function sendJson<T>(url: string, method: 'POST' | 'PUT', body: unknown): Promise<T> {
  /** 已序列化的 JSON 请求。 */
  const options = {
    method,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };

  return getJson<T>(url, options);
}


/** 健康检查。 */
export function health(): Promise<{ ok: boolean; problems: string[] }> {
  return getJson('/api/health');
}


/** 全部机器人和状态。 */
export function bots(): Promise<types.BotView[]> {
  return getJson('/api/bots');
}


/** 还在等用户点的命令。 */
export function approvals(): Promise<types.ApprovalView[]> {
  return getJson('/api/approvals');
}


/**
 * 消息列表。
 * @param bot 机器人名。
 * @param query before（往前翻）、after（取变化）、limit、origin（web 只要网页发的，other 只要别的渠道的）。
 */
export function messages(bot: string, query: { before?: number; after?: number; limit?: number; origin?: types.MessageOrigin } = {}): Promise<types.MessagePage> {
  /** 查询参数。 */
  const params = new URLSearchParams({ bot });
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(name, String(value));
    }
  }
  return getJson(`/api/messages?${params.toString()}`);
}


/**
 * 查看一条已发送回复的事件、来源和记录边界，只发只读请求。
 * @param messageId 收件表消息号。
 * @param replyIndex replies 的真实下标，从 0 开始。
 * @returns 后端已经做过关联与脱敏的追踪；不存在时抛 ApiError。
 */
export function messageTrace(
  messageId: number,
  replyIndex: number,
): Promise<types.ReplyTraceView> {
  /** 查询使用回复下标；不根据正文或时间戳寻找相近的回复。 */
  const query = new URLSearchParams({ reply: String(replyIndex) });
  const url = `/api/messages/${String(messageId)}/trace?${query.toString()}`;

  return getJson(url);
}


/**
 * 按明确 ID 补取当前未加载消息，不翻页、不写库、不请求模型。
 * @param bot 已选择的机器人，后端仍会检查每条归属。
 * @param ids 最多 100 个正整数消息号；更多来源由调用方分批。
 */
export function resolveMessages(bot: string, ids: number[]): Promise<types.MessageResolution> {
  const query = new URLSearchParams({ bot, ids: ids.join(',') });
  return getJson(`/api/messages/resolve?${query.toString()}`);
}


/**
 * 文件的地址（img、audio、video 直接用）。
 * @param path 绝对路径。
 */
export function fileUrl(path: string): string {
  //M img、video 加不了请求头，令牌放进地址。
  return `/api/files?path=${encodeURIComponent(path)}${TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ''}`;
}


/** 一个访问令牌（后端 Tokens.ts 的 TokenInfo）。 */
export interface TokenInfo {
  /** 号。 */
  id: string;
  /** 名字：给谁用的。 */
  name: string;
  /** 值。 */
  value: string;
  /** 临时的：几分钟。 */
  minutes?: number;
  /** 建的时间，毫秒。 */
  createdAt: number;
  /** 失效的时间，毫秒；永久的没有。 */
  expiresAt?: number;
  /** 最近一次用的时间，毫秒。 */
  usedAt?: number;
}


/** 全部访问令牌（只有本机能看）。 */
export function tokens(): Promise<TokenInfo[]> {
  return getJson('/api/tokens');
}


/**
 * 新建访问令牌。
 * @param name 给谁用的。
 * @param minutes 临时的写几分钟；不写是永久的。
 */
export function createToken(name: string, minutes?: number): Promise<TokenInfo> {
  return sendJson('/api/tokens', 'POST', { name, minutes });
}


/**
 * 换一个新值（旧的马上失效）。
 * @param id 号。
 */
export function refreshToken(id: string): Promise<TokenInfo> {
  return sendJson(`/api/tokens/${encodeURIComponent(id)}/refresh`, 'POST', {});
}


/**
 * 删掉访问令牌。
 * @param id 号。
 */
export function deleteToken(id: string): Promise<{ ok: boolean }> {
  return getJson(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
}


/** 上传完的一个附件（PUT /api/uploads/:name 的回答）。 */
export interface UploadResult {
  /** 上传号：发消息时放进 uploads。 */
  id: string;
  /** 落盘的名字。 */
  name: string;
  /** 大小，字节。 */
  size: number;
  /** 类别。 */
  kind: types.AttachmentKind;
}


/**
 * 上传一个文件：原始字节，不转 base64；用 XMLHttpRequest 才拿得到进度。
 * @param file 文件。
 * @param onProgress 进度，0～1。
 * @returns 上传号等。
 * @throws ApiError。
 */
export function uploadFile(file: File, onProgress: (ratio: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    /** 请求。 */
    const request = new XMLHttpRequest();
    request.open('PUT', `/api/uploads/${encodeURIComponent(file.name || 'file')}`);
    //G 所有 /api/* 都要 token，XHR 也要带（和 getJson 同一套，不用另写）。
    if (TOKEN) {
      request.setRequestHeader('authorization', `Bearer ${TOKEN}`);
    }
    request.setRequestHeader('content-type', 'application/octet-stream');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded / event.total);
      }
    };
    request.onload = () => {
      try {
        /** 回答。 */
        const body = JSON.parse(request.responseText) as UploadResult & { error?: string };
        if (request.status >= 200 && request.status < 300) {
          resolve(body);
        } else {
          reject(new ApiError(request.status, body.error ?? request.statusText));
        }
      } catch {
        reject(new ApiError(request.status, request.responseText || '上传的回答读不出来'));
      }
    };
    request.onerror = () => reject(new ApiError(0, '连不上后端，上传失败'));
    request.send(file);
  });
}


/**
 * 发一条消息（POST /api/message）。
 * @param input text 原话（Markdown）；bot 发给谁；uploads 先传好的附件；session 指定会话（不分派）。
 * @returns 消息号和消息文件。
 */
export function sendMessage(input: {
  /** 用户输入的 Markdown 正文。 */
  text: string;
  /** 接收消息的机器人。 */
  bot: string;
  /** 事先上传的附件标识。 */
  uploads: string[];
  /** 明确选择的会话；省略时由后端分派。 */
  session?: string;
}): Promise<{
  /** 后端分配的消息号。 */
  id: number;
  /** 消息文件路径。 */
  file: string;
}> {
  /** 后端消息入口所需的字段。 */
  const body = {
    text: input.text,
    bot: input.bot,
    from: 'web',
    uploads: input.uploads,
    session: input.session,
  };

  return sendJson('/api/message', 'POST', body);
}


/** 一个会话的简要（GET /api/ui/sessions 的一项）。 */
export interface SessionBrief {
  /** 会话 ID。 */
  id: string;
  /** 工作区。 */
  workspace: string;
  /** 标题。 */
  title: string;
  /** 摘要。 */
  summary: string;
  /** 模型。 */
  model: string;
  /** 状态：idle、running、error。 */
  status: string;
  /** 最后改动的时间，毫秒。 */
  updatedAt: number;
  /** 三个文件。 */
  files: { md: string; json: string; compact: string };
}


/**
 * 会话列表。
 * @param bot 机器人名。
 * @param status 只要这种状态的（不写是全部）。
 */
export function sessions(bot: string, status?: string): Promise<SessionBrief[]> {
  /** 查询参数。 */
  const params = new URLSearchParams({ bot });
  if (status) {
    params.set('status', status);
  }
  return getJson(`/api/ui/sessions?${params.toString()}`);
}


/**
 * 会话详情（GET /api/sessions/:id）：信息、文件、给人看的 md。
 * @param id 会话号。
 */
export function sessionDetail(id: string): Promise<types.SessionDetail> {
  return getJson(`/api/sessions/${encodeURIComponent(id)}`);
}


/**
 * 会话的步骤（GET /api/sessions/:id/steps）：分派记录也在里面。
 * @param id 会话号。
 * @param after 从第几步之后取；0 是从头。
 * @param limit 最多取几步（后端上限 500）。
 */
export function sessionSteps(id: string, after = 0, limit = 500): Promise<types.SessionStep[]> {
  /** 查询参数。 */
  const params = new URLSearchParams({ after: String(after), limit: String(limit) });
  return getJson(`/api/sessions/${encodeURIComponent(id)}/steps?${params.toString()}`);
}


/**
 * 换会话的模型和思考档（POST /api/sessions/:id/model）：下一步调模型就生效。
 * @param id 会话号。
 * @param model 模型完整 ID「供应商/模型」。
 * @param thinking 思考档；null 是让会话用这个模型的最高档。
 */
export function changeSessionModel(
  id: string,
  model: string,
  thinking: string | null,
): Promise<{ id: string; model: string; thinking: string | null; status: string }> {
  return sendJson(`/api/sessions/${encodeURIComponent(id)}/model`, 'POST', { model, thinking });
}


/**
 * 要求会话停下（POST /api/sessions/:id/stop）：下一次检查点结束这次运行。
 * @param id 会话号。
 * @param reason 为什么停；不写后端记「用户停的」。
 * @returns stopped 是 false 时（会话没在跑）带 reason 说明。
 */
export function stopSession(
  id: string,
  reason?: string,
): Promise<{ id: string; stopped: boolean; status: string; reason?: string }> {
  return sendJson(`/api/sessions/${encodeURIComponent(id)}/stop`, 'POST', { reason });
}


/**
 * 决定一条待确认（POST /api/approvals/:id {approve}）。
 * @param id 待确认的号。
 * @param approve true 同意执行，false 拒绝。
 * @returns 接口的状态码：200 成功、404 已经处理过了；连不上是 0。不抛错。
 */
export async function decideApproval(id: number, approve: boolean): Promise<number> {
  try {
    await sendJson(`/api/approvals/${id}`, 'POST', { approve });
    return 200;
  } catch (error) {
    return error instanceof ApiError ? error.status : 0;
  }
}


/** 一个机器人的目录、工作区、记忆概要（GET /api/ui/bots/:name）。 */
export interface BotInfo {
  /** 名字。 */
  name: string;
  /** 语言。 */
  language: string;
  /** 几个目录（绝对路径）。 */
  paths: { botDir: string; messageDir: string; workspaceRoot: string; memoryDir: string };
  /** 工作区：名字、说明、工作目录。 */
  workspaces: { name: string; description: string; dir: string }[];
  /** 记忆概要（memory/索引.md）。 */
  memoryIndex: string;
}


/**
 * 一个机器人的目录、工作区、记忆概要。
 * @param name 机器人名。
 */
export function botInfo(name: string): Promise<BotInfo> {
  return getJson(`/api/ui/bots/${encodeURIComponent(name)}`);
}


/** 目录里的一项（GET /api/files/list）。 */
export interface DirEntry {
  /** 名字。 */
  name: string;
  /** 绝对路径。 */
  path: string;
  /** 是不是文件夹。 */
  dir: boolean;
  /** 大小，字节。 */
  size: number;
  /** 修改时间，毫秒。 */
  mtime: number;
}


/**
 * 列目录。
 * @param path 绝对路径。
 */
export function listDir(path: string): Promise<DirEntry[]> {
  return getJson(`/api/files/list?path=${encodeURIComponent(path)}`);
}


/** 单次范围读取的文字，端点均按实际 UTF-8 字节位置计算。 */
export interface FileTextPage {
  /** 本段完整字符；没有把整份大文件缓存到仓库。 */
  text: string;
  /** 当前是否仅为文件的一段，包含非零起点。 */
  partial: boolean;
  /** 本段第一个完整字符的字节位置，包含。 */
  start: number;
  /** 本段最后一个完整字符之后的字节位置，不包含。 */
  end: number;
  /** 文件总字节数；服务器未报告时为 null。 */
  total: number | null;
  /** 下一段应从哪里继续；末尾不足一个字符的字节留给下一段，读完为 null。 */
  nextOffset: number | null;
}


/** 当前预览目标的异步守卫；只保留版本号，不缓存任何旧文件正文。 */
export class FilePreviewLoader {
  /** 每次读取或取消递增，已失效的响应不能回写新页面。 */
  private revision = 0;

  /** @param maxBytes 单次文字预算；由 PreviewKind.MAX_TEXT_BYTES 交来。 */
  constructor(private readonly maxBytes: number) {}

  /** 读本段；旧请求的成功或错误均丢弃，当前请求的错误仍原样抛出。 */
  async read(path: string, offset: number): Promise<FileTextPage | undefined> {
    this.revision += 1;
    const revision = this.revision;
    try {
      const page = await fileText(path, this.maxBytes, offset);
      if (revision !== this.revision) {
        return undefined;
      }
      return page;
    } catch (error) {
      if (revision !== this.revision) {
        return undefined;
      }
      throw error;
    }
  }

  /** 离开或换目标时让未完成请求失效，不操作服务或原文件。 */
  cancel(): void {
    this.revision += 1;
  }
}


/**
 * 按 Range 读不超过 1MB 的片段，UTF-8 跨界不漏字；旧调用省略 offset 仍读开头。
 * @param path 已由后端文件接口检查的绝对路径。
 * @param maxBytes 本次字节预算，至少 4，最多 1MB。
 * @param offset 字节起点，通常使用上次返回的 nextOffset。
 * @returns 本段文字、真实范围与后续位置；不会积累文件全文。
 * @throws ApiError；服务器不支持非零范围时明确报错，不下载全文代替。
 */
export async function fileText(path: string, maxBytes: number, offset = 0): Promise<FileTextPage> {
  /** 请求边界与正文内存上限一致，不能因服务器忽略 Range 而读入巨型文件。 */
  const limit = Math.min(1024 * 1024, Math.max(4, Math.floor(maxBytes)));
  const requestedStart = Math.max(0, Math.floor(offset));
  /** 回答。 */
  let response: Response;
  try {
    const headers = { range: `bytes=${requestedStart}-${requestedStart + limit - 1}` };
    response = await fetch(fileUrl(path), { headers, cache: 'no-store' });
  } catch (error) {
    throw new ApiError(0, `连不上后端：${String(error)}`);
  }
  if (!response.ok) {
    throw new ApiError(response.status, (await response.text()) || response.statusText);
  }
  if (requestedStart > 0 && response.status !== 206) {
    await response.body?.cancel();
    throw new ApiError(response.status, '文件服务没有返回请求的分段，不能继续读取；可下载原文件');
  }

  /** 206 的总长与起点优先来自 Content-Range；200 才退到 Content-Length。 */
  const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('content-range') ?? '');
  const contentLength = response.headers.get('content-length');
  const totalText = range?.[3] === '*' ? null : range?.[3] ?? contentLength;
  const total = totalText === null || totalText === undefined ? null : Number(totalText);
  const rangeStart = range ? Number(range[1]) : requestedStart;
  const bytes = await boundedBytes(response, limit);
  const atEnd = total !== null ? rangeStart + bytes.length >= total : bytes.length < limit;
  const span = utf8Span(bytes, rangeStart > 0, atEnd);
  if (!atEnd) {
    /** 有完整行时在行末继续，避免把标题或围栏拆成伪结构；超长行仍保持字节预算。 */
    const newline = bytes.lastIndexOf(10, span.end - 1);
    if (newline >= span.start) {
      span.end = newline + 1;
    }
  }
  const start = rangeStart + span.start;
  const end = rangeStart + span.end;
  const hasMore = total !== null ? end < total : !atEnd;

  return {
    text: new TextDecoder().decode(bytes.subarray(span.start, span.end)),
    partial: start > 0 || hasMore,
    start,
    end,
    total,
    nextOffset: hasMore ? end : null,
  };
}


/** 从响应流最多收 limit 字节；服务器忽略 Range 也不会把全文读进内存。 */
async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }
  const buffer = new Uint8Array(limit);
  let length = 0;
  try {
    while (length < limit) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const accepted = chunk.value.subarray(0, limit - length);
      buffer.set(accepted, length);
      length += accepted.length;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return buffer.subarray(0, length);
}


/** 合法 UTF-8 在分段边缘可能不完整；尾部留给下次，任意中段起点跳过残余续字节。 */
function utf8Span(bytes: Uint8Array, middle: boolean, atEnd: boolean): { start: number; end: number } {
  let start = 0;
  if (middle) {
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
      start += 1;
    }
  }
  let end = bytes.length;
  if (!atEnd && end > start) {
    let lead = end - 1;
    while (lead > start && (bytes[lead]! & 0xc0) === 0x80) {
      lead -= 1;
    }
    const byte = bytes[lead]!;
    /** UTF-8 前缀决定完整字符长度；ASCII 和坏字节不擅自删除。 */
    let expected = 1;
    if ((byte & 0xf8) === 0xf0) {
      expected = 4;
    } else if ((byte & 0xf0) === 0xe0) {
      expected = 3;
    } else if ((byte & 0xe0) === 0xc0) {
      expected = 2;
    }
    if (end - lead < expected) {
      end = lead;
    }
  }
  return { start, end };
}


/** 一个模型（GET /api/models 的一项）。 */
export interface ModelInfo {
  /** 供应商/模型 ID。 */
  id: string;
  /** 显示名。 */
  name: string;
  /** chat 常规模型，decision 决策模型。 */
  kind: 'chat' | 'decision';
  /** 上下文长度。 */
  contextWindow: number;
  /** 最大输出；决策模型没有。 */
  maxOutputTokens?: number;
  /** 支持的思考档。 */
  thinking: string[];
  /** 能不能看图。 */
  vision?: boolean;
  /** 价格，美元每百万 token。 */
  price: { input: number; output: number };
}


/**
 * 直接问一家供应商有哪些模型（设置页“获取可用模型”，用还没保存的地址和密钥，不用重启）。
 * @param input 供应商的名字、地址、密钥、协议。
 */
export function providerModels(input: { provider: string; base_url: string; api_key: string; api: string }): Promise<{ models: ModelInfo[] }> {
  return sendJson('/api/ui/provider-models', 'POST', input);
}


/** 版本更新的状态（基地的 GET /update，经后端转发）。 */
export interface UpdateInfo {
  /** 基地在管更新吗。 */
  managed: boolean;
  /** 现在跑的版本。 */
  current?: { version: string; builtAt: number } | null;
  /** 新版本和它比现在多做了什么；没有是 null。 */
  available?: { version: string; builtAt: number; changes: { version: string; date: string; changes: string[] }[] } | null;
  /** 正在换吗。 */
  applying?: boolean;
  /** 上一次换的结果。 */
  message?: string;
}


/** 版本更新的状态。 */
export function updateInfo(): Promise<UpdateInfo> {
  return getJson('/api/update');
}


/** 开始换版本（先试运行，失败退回）。 */
export function applyUpdate(): Promise<{ ok: boolean }> {
  return sendJson('/api/update/apply', 'POST', {});
}


/** 各渠道连着没有。 */
export function uiStatus(): Promise<{ channels: { name: string; bot?: string; connected: boolean; detail: string }[] }> {
  return getJson('/api/ui/status');
}


/** 这个机器人正在做的事的进度（新的在前）。 */
export function progress(bot: string): Promise<types.ProgressView[]> {
  return getJson(`/api/progress?bot=${encodeURIComponent(bot)}`);
}


/** 点进度上的按钮：终止，或限时（minutes 是 0 就是不限时）。 */
export function progressAct(id: number, action: 'stop' | 'limit', minutes: number): Promise<{ text: string }> {
  return sendJson(`/api/progress/${id}`, 'POST', { action, minutes });
}


/**
 * 重新测试模型连接：让后端向供应商重拉模型清单，拉到了原地换掉，不用重启（设置“重连”用）。
 * @param provider 只重连这一家；不给就每家都重连。
 */
export function reconnectModels(provider?: string): Promise<{ results: types.ReconnectResult[] }> {
  return sendJson('/api/models/reconnect', 'POST', { provider });
}


/** 开机自启开着没有（基地没开、是老版本时报错）。 */
export function autostart(): Promise<{ enabled: boolean }> {
  return getJson('/api/autostart');
}


/** 打开或关掉开机自启。 */
export function setAutostart(enabled: boolean): Promise<{ enabled: boolean }> {
  return sendJson('/api/autostart', 'POST', { enabled });
}


/** 全部可用的模型。 */
export function models(): Promise<ModelInfo[]> {
  return getJson('/api/models');
}


/** 配置内容（密钥已打码）。 */
export function settings(): Promise<{ config: Record<string, unknown> }> {
  return getJson('/api/settings');
}


/**
 * 保存改动（按顺序做到 config.yaml 上）。
 * @param edits 改动。
 */
export function saveSettings(edits: unknown[]): Promise<{ ok: boolean; changed: number; note: string }> {
  return sendJson('/api/settings', 'PUT', edits);
}


/** 重启生效：后端在后台换版本，马上返回。 */
export function applySettings(): Promise<{ ok: boolean; startedAt: number }> {
  return sendJson('/api/settings/apply', 'POST', {});
}


/** 重启服务（设置“重连”用）：基地停掉后端再拉起，马上返回；老版本基地、源码模式和重启生效一样。 */
export function restartService(): Promise<{ ok: boolean; startedAt: number }> {
  return sendJson('/api/service/restart', 'POST', {});
}


/** 这个后端进程什么时候起的（重启后会变）、界面语言（config.yaml 的 ui.language，没写不带）。 */
export function uiInfo(): Promise<{ startedAt: number; version?: string; language?: string }> {
  return getJson('/api/ui/info');
}


/** 等重启最多等多久，毫秒（提示里写的“3 分钟”就是它）。 */
const RESTART_TIMEOUT_MS = 180_000;

/** 等重启时多久问一次，毫秒。 */
const RESTART_POLL_MS = 2000;


/**
 * 等后端换成新进程：每隔一会儿问 /api/ui/info，起来的时间变了就是新进程（重启那几秒连不上是正常的）。
 * 设置页的“立即重启”和“重连”里的“重启服务”都用它。
 * @param startedAt 旧进程起来的时间（重启接口回的）。
 * @returns 3 分钟内等到了是 true，超时是 false。
 */
export async function waitNewProcess(startedAt: number): Promise<boolean> {
  /** 等到什么时候。 */
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_MS));
    try {
      /** 现在的进程。 */
      const info = await uiInfo();
      if (info.startedAt !== startedAt) {
        return true;
      }
    } catch {
      //M 重启那几秒连不上是正常的，接着等。
    }
  }
  return false;
}


/** 记忆搜索的一条命中（壳子 /search，memorycli 那一套）。 */
export interface MemoryHit {
  /** 哪个库。 */
  lib?: string;
  /** 相对库根目录的路径。 */
  path: string;
  /** 绝对路径（库里记着根目录时才有）。 */
  abs_path?: string;
  /** RRF 融合后的分数。 */
  score: number;
  /** 哪几路命中：text、symbol、tag、path（配了嵌入模型还有 vector）。 */
  matched: string[];
  /** AI 摘要。 */
  summary?: string;
  /** 标签。 */
  tags: string[];
  /** 命中的片段。 */
  snippets: { start_line: number; end_line: number; title: string; text: string }[];
}


/** RAG 检索的一条：一个片段（壳子 /rag/search）。 */
export interface RagHit {
  /** 哪个库。 */
  lib: string;
  /** 相对库根目录的路径。 */
  path: string;
  /** 绝对路径。 */
  abs_path?: string;
  /** 块的标题。 */
  title: string;
  /** 行号。 */
  start_line: number;
  end_line: number;
  /** 正文片段。 */
  text: string;
  /** BM25 分数。 */
  score: number;
}


/** 记忆库的清单（壳子 /health）。 */
export function memoryLibs(): Promise<{ libs: { name: string; root?: string | null }[] }> {
  return getJson('/api/memory/health');
}


/**
 * 记忆搜索。
 * @param query 搜什么。
 * @param libs 只搜这几个库（空是全部）。
 * @param limit 最多几个文件。
 */
export function memorySearch(query: string, libs: string[], limit = 10): Promise<{ hits: MemoryHit[] }> {
  /** 查询参数。 */
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (libs.length > 0) {
    params.set('lib', libs.join(','));
  }
  return getJson(`/api/memory/search?${params.toString()}`);
}


/**
 * RAG 检索。
 * @param query 搜什么。
 * @param libs 只搜这几个库（空是全部）。
 * @param limit 最多几条。
 */
export function ragSearch(query: string, libs: string[], limit = 10): Promise<{ hits: RagHit[]; not_indexed: string[] }> {
  /** 查询参数。 */
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (libs.length > 0) {
    params.set('lib', libs.join(','));
  }
  return getJson(`/api/rag/search?${params.toString()}`);
}


/**
 * 给几个库建 RAG 索引（后台跑，马上返回）。
 * @param libs 库名（空是全部）。
 */
export function ragIndex(libs: string[]): Promise<{ started: string[]; already_running: string[] }> {
  return sendJson('/api/rag/index', 'POST', libs.length > 0 ? { lib: libs.join(',') } : {});
}


/**
 * 搜聊天内容（docs/界面/01_界面设计.md 6.1）：消息原话和回复、会话标题和摘要。
 * @param keyword 关键字。
 * @param bot 只搜这个机器人；不写搜所有的。
 * @throws 后端说不行时抛错，带原因。
 */
export function searchChat(keyword: string, bot?: string): Promise<types.SearchResult> {
  /** 查询参数。 */
  const query = new URLSearchParams({ q: keyword, ...(bot ? { bot } : {}) });
  return getJson<types.SearchResult>(`/api/search?${query.toString()}`);
}


/**
 * 新建机器人（6.2）：不用重启就能用。
 * @param input 填的东西。
 * @throws 名字不对、重名、模型不在清单里时抛错，带原因。
 */
export function createBot(input: types.NewBotInput): Promise<types.NewBotResult> {
  return sendJson<types.NewBotResult>('/api/bots', 'POST', input);
}



/**
 * 模型用量（docs/15_用量表.md 第 3 节）：按时间段、按分组合计的 token、调用、失败、钱。
 * @param query 按什么切时间段、按什么分组、从哪个时刻到哪个时刻（毫秒）。
 * @throws 后端说不行时抛错，带原因。
 */
export function usage(query: {
  by: types.UsageBy;
  group: types.UsageGroup;
  from: number;
  to: number;
}): Promise<types.UsageReport> {
  /** 查询参数。 */
  const params = new URLSearchParams({
    by: query.by,
    group: query.group,
    from: String(query.from),
    to: String(query.to),
  });
  return getJson<types.UsageReport>(`/api/usage?${params.toString()}`);
}
