/**
 * 和后端说话：一律用相对地址（网页由后端托管，同源），不认识任何地址和端口。
 * 出错时抛 ApiError：status 是 HTTP 状态码，连不上时是 0。
 * 访问令牌（docs/界面/05_外部AI任务通道.md 第 3 节）：从局域网打开时地址带 ?token=，这里记进浏览器、从地址栏去掉，之后每个请求都带上；本机也要。
 */
import type * as types from './Types.ts';


//M 2026-11-14 22:50 EST：令牌读取挪到 Token.ts，所有网页共用一份（原来这里的 accessToken 搬过去成了 takeToken）。
import { TOKEN, withToken } from './Token.ts';


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
    //G fetch 抛异常说明断网或后端未响应，包装成 status=0 的 ApiError 供轮询和界面统一按离线处理。
    throw new ApiError(0, `连不上后端：${String(error)}`);
  }

  /** 正文。 */
  //M 先读出响应原始文本，既用于非 2xx 时提取错误信息，也避免空响应体直接进 JSON.parse 报错。
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

    //G 非 2xx 统一转成带 HTTP 状态码和错误说明的 ApiError 抛出，便于调用方区分 401/404 与 5xx。
    throw new ApiError(response.status, message);
  }
  if (!text) return undefined as T;

  return JSON.parse(text) as T;
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

  //M 复用 getJson 统一注入 Bearer 令牌、广播 401 事件与包装 ApiError，避免维护两套错误处理。
  return getJson<T>(url, options);
}


/** 健康检查。 */
export function health(): Promise<{ ok: boolean; problems: string[] }> {
  //M 拉取后端及插件健康检查结果，用于展示启动或运行时诊断问题。
  return getJson('/api/health');
}


/** 全部机器人和状态。 */
export function bots(): Promise<types.BotView[]> {
  //M 拉取全量机器人状态列表，供轮询刷新左栏机器人卡片与在线态。
  return getJson('/api/bots');
}


/** 还在等用户点的命令。 */
export function approvals(): Promise<types.ApprovalView[]> {
  //M 拉取当前待人工确认的命令审批卡片，供轮询更新审批弹窗和右栏待审核页。
  return getJson('/api/approvals');
}


/**
 * 消息列表。
 * @param bot 机器人名。
 * @param query before（往前翻）、after（取变化）、limit、origin（web 只要网页发的，other 只要别的渠道的）。
 */
export function messages(bot: string, query: { before?: number; after?: number; limit?: number; origin?: types.MessageOrigin; channel?: string } = {}): Promise<types.MessagePage> {
  /** 查询参数。 */
  const params = new URLSearchParams({ bot });
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(name, String(value));
    }
  }
  //M 携带机器人名、分页游标与渠道筛选参数请求消息分页，支撑时间线加载更多与增量同步。
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

  //M 按精确消息号和回复下标拉取只读脱敏追溯数据，供右栏事件页展示因果与用量。
  return getJson(url);
}


/**
 * 按明确 ID 补取当前未加载消息，不翻页、不写库、不请求模型。
 * @param bot 已选择的机器人，后端仍会检查每条归属。
 * @param ids 最多 100 个正整数消息号；更多来源由调用方分批。
 */
export function resolveMessages(bot: string, ids: number[]): Promise<types.MessageResolution> {
  const query = new URLSearchParams({ bot, ids: ids.join(',') });
  //M 按指定消息号列表补取未在当前分页内的关联来源消息，不改变现有时间线游标。
  return getJson(`/api/messages/resolve?${query.toString()}`);
}


/**
 * 文件的地址（img、audio、video 直接用）。
 * @param path 绝对路径。
 */
export function getFileUrl(path: string): string {
  //M img、video 加不了请求头，令牌放进地址。
  return withToken(`/api/files?path=${encodeURIComponent(path)}`, TOKEN);
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
  //M 拉取全部访问令牌元信息供设置页管理列表展示（仅本机请求可通过鉴权）。
  return getJson('/api/tokens');
}


/**
 * 新建访问令牌。
 * @param name 给谁用的。
 * @param minutes 临时的写几分钟；不写是永久的。
 */
export function createToken(name: string, minutes?: number): Promise<TokenInfo> {
  //M 提交令牌用途名和可选有效期让后端签发新令牌，拿到含值的对象供用户复制。
  return sendJson('/api/tokens', 'POST', { name, minutes });
}


/**
 * 换一个新值（旧的马上失效）。
 * @param id 号。
 */
export function refreshToken(id: string): Promise<TokenInfo> {
  //M 通知后端立即轮换该令牌的密钥值，让旧凭证作废并返回更新后的新令牌。
  return sendJson(`/api/tokens/${encodeURIComponent(id)}/refresh`, 'POST', {});
}


/**
 * 删掉访问令牌。
 * @param id 号。
 */
export function deleteToken(id: string): Promise<{ ok: boolean }> {
  //M 请求后端吊销并移除指定访问令牌，立即终止外部客户端的访问授权。
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
          return;
        }

        //G 非 2xx 时用后端返回的状态码和 error 文案拒绝 Promise，供输入框展示上传失败提示。
        reject(new ApiError(request.status, body.error ?? request.statusText));
      } catch {
        //G 响应正文不是合法 JSON（如网关错误页）时仍带状态码与原始文本拒绝，不吞掉错误。
        reject(new ApiError(request.status, request.responseText || '上传的回答读不出来'));
      }
    };

    //G 发生网络断开或跨域拦截时触发 onerror，统一包装成 status=0 的 ApiError 拒绝。
    request.onerror = () => reject(new ApiError(0, '连不上后端，上传失败'));
    //M 直接发送原始 File 字节流（不做 base64 编码），配合 XHR 上传进度事件回调。
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
  /** 被回复的收件消息号，保持数值类型。 */
  reply_to?: number;
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
    reply_to: input.reply_to,
  };

  //M 把网页消息文本、附件上传号及可选指定会话发给入站接口，拿回分配的消息号用于时间线关联。
  return sendJson('/api/message', 'POST', body);
}


/** 一个会话的简要（GET /api/ui/sessions 的一项）。 */
export interface SessionBrief {
  /** 会话 ID。 */
  id: string;
  /** 种类：front 前台对话、work 后台会话。 */
  kind?: string;
  /** 嵌在哪场会话里；只有后台子会话有。 */
  parent?: string;
  /** 客户号，渠道:用户。 */
  customer?: string;
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

  //M 按机器人名称与可选状态条件拉取会话列表，供工作区会话清单展示与筛选。
  return getJson(`/api/ui/sessions?${params.toString()}`);
}


/** 一个正在跑的前台或后台任务（GET /api/ui/running 的一项）。 */
export interface RunningTask {
  /** 会话号。 */
  id: string;
  /** 种类：front 前台、work 后台。 */
  kind: string;
  /** 嵌在哪场前台会话里；前台没有。 */
  parent?: string;
  /** 标题。 */
  title: string;
  /** 客户号，渠道:用户。 */
  customer: string;
  /** 给人看的渠道标签，比如 网页、飞书、微信。 */
  customerLabel: string;
  /** 状态，现在都是 running。 */
  status: string;
  /** 本轮开始时间，毫秒。 */
  startedAt: number;
  /** 最后改动的时间，毫秒。 */
  updatedAt: number;
  /** 最新一条进度。 */
  action: string;
}


/**
 * 这个机器人正在跑的前台和后台任务（含后台子会话）。
 * @param bot 机器人名。
 */
export function runningTasks(bot: string): Promise<RunningTask[]> {
  //M 拉取指定机器人当前运行中的前后台任务，供右栏顶部实时任务栏展示进度与跳转。
  return getJson(`/api/ui/running?bot=${encodeURIComponent(bot)}`);
}


/**
 * 会话详情（GET /api/sessions/:id）：信息、文件、给人看的 md。
 * @param id 会话号。
 */
export function sessionDetail(id: string): Promise<types.SessionDetail> {
  //M 获取会话元信息、运行历史与 Markdown 记录全文，供右栏会话页和 #session 深链接使用。
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
  //M 带增量序号游标拉取会话步骤与分派记录，实现右栏会话详情的增量追加渲染。
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
  //M 把会话的新模型和思考档写回后端会话记录，使该会话下一轮调用按新配置执行。
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
  //M 通知后端在下一次检查点中断指定运行中的会话，拿回是否停下及未停原因用于界面反馈。
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
    //M 把用户的批准或拒绝决定发给审批接口，成功则返回 200 让卡片立即收口。
    await sendJson(`/api/approvals/${id}`, 'POST', { approve });
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;

    return 0;
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
  //M 拉取单个机器人的目录位置、工作区清单和记忆索引全文，供右栏工作区与记忆页渲染。
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
  //M 列出指定目录的直接子文件与子文件夹元数据，供右栏工作区文件树按需展开。
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
      //M 按当前偏移和单页字节预算拉取这一段文本，返回前再比对 revision 以免过期响应回写。
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
    const headers: Record<string, string> = { range: `bytes=${requestedStart}-${requestedStart + limit - 1}` };
    if (TOKEN) {
      headers.authorization = `Bearer ${TOKEN}`;
    }

    //M 拼出带令牌的文件 URL 并附带 Range 头只请求该字节区间，防止预览大文件时下载全文。
    response = await fetch(getFileUrl(path), { headers, cache: 'no-store' });
  } catch (error) {
    //G 网络中断或连不上后端时包装成 status=0 的 ApiError 抛出，与 getJson 保持统一离线口径。
    throw new ApiError(0, `连不上后端：${String(error)}`);
  }
  if (!response.ok) {
    //M 读取错误响应正文，优先抽后端 JSON 里的 error 字段，否则退回状态描述。
    const raw = await response.text();
    let message = raw || response.statusText;
    try {
      message = (JSON.parse(raw) as { error?: string }).error ?? message;
    } catch {
      //M 不是 JSON 就用原文。
    }

    //G 服务端返回非 2xx 时抛出带状态码和原因的 ApiError，交由预览组件展示报错。
    throw new ApiError(response.status, message);
  }
  if (requestedStart > 0 && response.status !== 206) {
    //G 非零起点未返回 206 分段，先取消响应流防止下载整份大文件，再报错提示改为下载原文件。
    await response.body?.cancel();
    //G 明确拒绝降级为全量读取，提醒调用方只能改用原文件下载入口。
    throw new ApiError(response.status, '文件服务没有返回请求的分段，不能继续读取；可下载原文件');
  }

  /** 206 的总长与起点优先来自 Content-Range；200 才退到 Content-Length。 */
  //M 解析 Content-Range 响应头，还原后端实际返回分段的起始偏移与文件总字节数。
  const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('content-range') ?? '');
  //M 当响应为 200 或 Content-Range 未给出精确总长时，取 Content-Length 作为总字节数兜底。
  const contentLength = response.headers.get('content-length');
  let totalText: string | null = contentLength;
  if (range?.[3] === '*') {
    totalText = null;
  }
  if (range?.[3] && range[3] !== '*') {
    totalText = range[3];
  }
  let total: number | null = null;
  if (totalText !== null && totalText !== undefined) {
    total = Number(totalText);
  }
  let rangeStart = requestedStart;
  if (range) {
    rangeStart = Number(range[1]);
  }

  //M 从响应流按上限最多收取 limit 字节，保证即使服务器忽略 Range 也不会把巨型文件吃进内存。
  const bytes = await boundedBytes(response, limit);
  let atEnd = bytes.length < limit;
  if (total !== null) {
    atEnd = rangeStart + bytes.length >= total;
  }

  //M 裁掉分片首尾被截断的 UTF-8 半个字符，避免解码出现乱码并把末尾残余字节留给下一段。
  const span = getUtf8Span(bytes, rangeStart > 0, atEnd);
  if (!atEnd) {
    /** 有完整行时在行末继续，避免把标题或围栏拆成伪结构；超长行仍保持字节预算。 */
    const newline = bytes.lastIndexOf(10, span.end - 1);
    if (newline >= span.start) {
      span.end = newline + 1;
    }
  }
  const start = rangeStart + span.start;
  const end = rangeStart + span.end;
  let hasMore = !atEnd;
  if (total !== null) {
    hasMore = end < total;
  }
  let nextOffset: number | null = null;
  if (hasMore) {
    nextOffset = end;
  }

  return {
    text: new TextDecoder().decode(bytes.subarray(span.start, span.end)),
    partial: start > 0 || hasMore,
    start,
    end,
    total,
    nextOffset,
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
      //M 按流逐块读取响应字节，在达到单页字节预算时立刻停读，防止大响应撑爆内存。
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const accepted = chunk.value.subarray(0, limit - length);
      buffer.set(accepted, length);
      length += accepted.length;
    }
  } finally {
    //M 达到上限提前结束或读流异常时主动取消剩余响应体并释放锁，避免挂起网络连接。
    await reader.cancel();
    reader.releaseLock();
  }
  return buffer.subarray(0, length);
}


/** 按 UTF-8 首字节前缀判断完整字符长度；ASCII 和坏字节按 1 处理。 */
function getUtf8CharLength(byte: number): number {
  if ((byte & 0xf8) === 0xf0) return 4;

  if ((byte & 0xf0) === 0xe0) return 3;

  if ((byte & 0xe0) === 0xc0) return 2;

  return 1;
}


/** 合法 UTF-8 在分段边缘可能不完整；尾部留给下次，任意中段起点跳过残余续字节。 */
function getUtf8Span(bytes: Uint8Array, middle: boolean, atEnd: boolean): { start: number; end: number } {
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

    //M 根据末尾多字节字符首字节计算完整字符应占字节数，判断结尾字符是否被分片截断。
    const expected = getUtf8CharLength(bytes[lead]!);
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
  //M 把表单里暂未落盘的供应商地址与密钥直接发给后端拉取模型清单，支持设置页先试连再保存。
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
  //M 查询经后端转发的基地更新状态，供左下角提示新版本及变更说明。
  return getJson('/api/update');
}


/** 开始换版本（先试运行，失败退回）。 */
export function applyUpdate(): Promise<{ ok: boolean }> {
  //M 触发基地试运行新版本并执行切换，按钮点下后由后端与基地协同换版。
  return sendJson('/api/update/apply', 'POST', {});
}


/** 各渠道连着没有。 */
export function uiStatus(): Promise<{ channels: { name: string; bot?: string; connected: boolean; detail: string }[] }> {
  //M 拉取各外接渠道的连接健康状态，供左下角连接指示灯与悬停详情渲染。
  return getJson('/api/ui/status');
}


/** 后端已挂载的插件状态（'loading' 还没问过；'unknown' 没有教程接口、按全部可见处理；数组是 state==='ok' 的插件名）。 */
export type MountedPlugins = 'loading' | 'unknown' | readonly string[];


/**
 * 查一次当前后端真正挂载（state === 'ok'）的插件名单，避免反复轮询未挂载插件的 404 接口。
 * @returns 已挂载插件名列表；如果连 /api/tutorial/plugins 都没有（404）返回 'unknown'。
 */
export async function mountedPlugins(): Promise<string[] | 'unknown'> {
  try {
    //M 请求插件挂载清单接口筛选 state 为 ok 的插件名，供轮询与界面入口按需门控。
    const result = await getJson<{ list?: { name: string; state: string }[] }>('/api/tutorial/plugins');
    if (!Array.isArray(result?.list)) {
      return 'unknown';
    }
    return result.list.filter((item) => item.state === 'ok').map((item) => item.name);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return 'unknown';
    }
    throw error;
  }
}


/**
 * 判断某个插件的界面或轮询现在要不要启用。
 * @param mounted 已拿到的挂载状态。
 * @param name 插件名。
 * @param whileLoading 还在加载时要不要先显示（比如静态菜单可先显示，轮询要等拿到再开）。
 */
export function isPluginMounted(mounted: MountedPlugins, name: string, whileLoading = false): boolean {
  if (mounted === 'loading') return whileLoading;

  if (mounted === 'unknown') return true;

  return mounted.includes(name);
}


/** 全部机器人正在做的事的进度（新的在前），由 Poll.ts 每轮取一次放进仓库。 */
export function progress(): Promise<types.ProgressView[]> {
  //M 不带 bot 就是全部机器人；各处从仓库按机器人自己筛。
  return getJson('/api/progress');
}


/** 点进度上的按钮：终止，或限时（minutes 是 0 就是不限时）。 */
export function progressAct(id: number, action: 'stop' | 'limit', minutes: number): Promise<{ text: string }> {
  //M 把用户在进度卡片上选择的终止或改限时操作提交给后端执行，返回提示结果文案。
  return sendJson(`/api/progress/${id}`, 'POST', { action, minutes });
}


/**
 * 重新测试模型连接：让后端向供应商重拉模型清单，拉到了原地换掉，不用重启（设置“重连”用）。
 * @param provider 只重连这一家；不给就每家都重连。
 */
export function reconnectModels(provider?: string): Promise<{ results: types.ReconnectResult[] }> {
  //M 让后端向指定或全部供应商重拉模型清单并原地刷新目录，在设置页无需重启即可重连。
  return sendJson('/api/models/reconnect', 'POST', { provider });
}


/** 一条目录授权（GET /api/grants，后端 approval 的 Grants.ts）：谁（人或群）绑到哪个目录。 */
export interface GrantItem {
  /** 号：撤销用。 */
  id: number;
  /** 谁：人是个人身份（飞书 feishu:<open_id>），群是群的客户号（feishu:group:<chat_id>）。 */
  subject: string;
  /** 给人看的名字。 */
  label: string;
  /** 是不是群。 */
  group: boolean;
  /** 目录，绝对路径。 */
  dir: string;
  /** 谁设的：tool（对机器人说的）、http（网页）。 */
  by: string;
  /** 设的毫秒时刻。 */
  createdAt: number;
}

/** 最近说过话的人和群（后端内存里记的，重启清空）：设授权时挑人用。 */
export interface GrantSeen {
  /** 人或群的身份，和 GrantItem.subject 同一种写法。 */
  subject: string;
  /** 名字。 */
  label: string;
  /** 是不是群。 */
  group: boolean;
}


/** 目录授权清单和最近说过话的人、群（设置“目录授权”用）。 */
export function grants(): Promise<{ items: GrantItem[]; seen: GrantSeen[] }> {
  //M 拉取全部目录授权和最近见过的人、群，供设置页列表和挑人下拉框使用。
  return getJson('/api/grants');
}


/**
 * 设一条目录授权：这个人或群在这个目录和子目录里读写、跑命令、发文件不用再问。
 * @param input 谁、名字、目录（绝对路径，后端查目录在不在）。
 */
export function addGrant(input: { subject: string; label: string; dir: string }): Promise<{ ok: boolean; grant: GrantItem }> {
  //M 提交新授权；目录写错时后端回 400，错误原因交给调用方显示。
  return sendJson('/api/grants', 'POST', { action: 'add', ...input });
}


/**
 * 撤一条目录授权。
 * @param id 授权的号。
 */
export function removeGrant(id: number): Promise<{ ok: boolean }> {
  //M 按号撤销；没有这一条时后端回 404。
  return sendJson('/api/grants', 'POST', { action: 'remove', id });
}


/** 读取基地的开机自启状态；查询失败交给调用方处理。 */
export function autostart(): Promise<{ enabled: boolean }> {
  //M 经后端转发查询基地上的开机自启配置状态，供设置页初始化开关状态。
  return getJson('/api/autostart');
}


/** 打开或关掉开机自启。 */
export function setAutostart(enabled: boolean): Promise<{ enabled: boolean }> {
  //M 经后端转发修改基地开机自启开关，并返回实际落盘后的启用状态。
  return sendJson('/api/autostart', 'POST', { enabled });
}


/** 全部可用的模型。 */
export function models(): Promise<ModelInfo[]> {
  //M 拉取当前后端所有已加载的可用模型清单，供会话切换模型、设置页和建机器人下拉框使用。
  return getJson('/api/models');
}


/** 配置内容（密钥已打码）。 */
export function settings(): Promise<{ config: Record<string, unknown> }> {
  //M 拉取密钥已脱敏的 config.yaml 配置对象，供设置页加载表单初值与比对改动。
  return getJson('/api/settings');
}


/**
 * 保存改动（按顺序做到 config.yaml 上）。
 * @param edits 改动。
 */
export function saveSettings(edits: unknown[]): Promise<{ ok: boolean; changed: number; note: string }> {
  //M 按顺序提交设置页记录的增量路径修改写回 config.yaml，保留原配置文件的注释和结构。
  return sendJson('/api/settings', 'PUT', edits);
}


/** 重启生效：后端在后台换版本，马上返回。 */
export function applySettings(): Promise<{ ok: boolean; startedAt: number }> {
  //M 通知后端应用刚保存的配置并在后台触发重启，返回旧进程 startedAt 供前端等待新进程就绪。
  return sendJson('/api/settings/apply', 'POST', {});
}


/** 请求重启后端并立即返回重启前的启动时刻，供页面轮询恢复。 */
export function restartService(): Promise<{ ok: boolean; startedAt: number }> {
  //M 请求由基地守护拉起或源码重启后端服务，拿回旧进程 startedAt 供前端轮询恢复。
  return sendJson('/api/service/restart', 'POST', {});
}


/** 这个后端进程什么时候起的（重启后会变）、界面语言（config.yaml 的 ui.language，没写不带）。 */
/** 一份程序的版本和编译时刻（毫秒；没有是 0）。 */
export interface ProgramVersion {
  version: string;
  builtAt: number;
}

/** 网页左下角用的界面信息。 */
export interface UiInfo {
  startedAt: number;
  /** 后端版本（兼容旧字段）。 */
  version?: string;
  builtAt?: number;
  language?: string;
  /** 后端 jmbots-server。 */
  server?: ProgramVersion;
  /** 壳子 jmbots.exe；旧壳子或没连上是 null。 */
  shell?: ProgramVersion | null;
}

/**
 * 读取当前后端进程与界面信息（GET /api/ui/info）：后端启动时刻、界面配置语言，以及后端与壳子版本。
 * 轮询依赖 startedAt 变化感知后端重启；左下角版本显示、语言同步和重启等待新进程都会调用它。
 * @returns 包含进程启动时间、可选语言及前后端版本信息的对象。
 */
export function uiInfo(): Promise<UiInfo> {
  //M 向后端请求进程启动时刻、界面语言与版本号，供轮询检测重启、同步语言和左下角显示版本。
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
      //M 轮询查询当前进程启动时刻，只要与重启前记录的 startedAt 不同即确认新进程已就绪。
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


/** 统一记忆搜索的一条命中。 */
export interface MemoryHit {
  /** 命中来源。 */
  source: 'history' | 'channel' | 'knowledge' | 'card';
  /** 来源内的编号。 */
  id: string;
  /** 标题或发言人。 */
  title: string;
  /** 正文摘要。 */
  snippet: string;
  /** RRF 归一化分数。 */
  score: number;
  /** 毫秒时间戳。 */
  at: number;
  /** 原文引用。 */
  ref: string;
  /** 命中通路，如 keyword、vector、graph。 */
  via: string[];
  /** 客户号。 */
  customer: string;
  /** 关联机器人。 */
  bot: string;
  /** 可以在编辑器中打开的原文件。 */
  file?: string;
  /** 原文件内的位置。 */
  where?: string;
  /** 原文件不可直接打开时的可读出处。 */
  origin?: string;
  /** 命中段落的关系。 */
  relations?: string[];
}


/** Rust 记忆服务状态与统计。 */
export interface MemoryHealth {
  /** 服务名（jmbots-memory）。 */
  service?: string;
  /** 服务版本号。 */
  version?: string;
  /** 服务是否健康。 */
  ok?: boolean;
  /** 探活失败原因。 */
  error?: string;
  /** 探测经过的毫秒数。 */
  ms?: number;
  /** 服务使用的抽图模型。 */
  extractModel?: string;
  /** 嵌入模型就绪状态。 */
  embedding?: { model?: string; ready?: boolean };
  /** 服务统计。 */
  counts?: {
    customers?: number;
    docs?: number;
    embedded?: number;
    entities?: number;
    relations?: number;
    history?: number;
    knowledge?: number;
    graphDone?: number;
    graphPending?: number;
    graphFailed?: number;
    graphSkipped?: number;
  };
}


/** 记忆插件直接探测 Rust 记忆服务，供右栏显示统计。 */
export function memoryHealth(): Promise<MemoryHealth> {
  //M 从 memory 插件读取 Rust 探活和计数。
  return getJson('/api/memory/health');
}

/** 渠道归档回填状态，已入库以 Rust 回执为准。 */
export interface MemoryBackfill {
  /** 已完成 Rust 写入的消息数。 */
  done: number;
  /** 当前已发现的手机、网页及命令行消息数。 */
  total: number;
  /** 用户是否要求回填继续运行。 */
  running: boolean;
  /** 是否仍在发现归档，发现期间总数会增加。 */
  scanning: boolean;
  /** 暂停、等待或完成的具体原因。 */
  reason: string;
}

/** 读渠道回填状态。 */
export function memoryBackfill(signal: AbortSignal): Promise<MemoryBackfill> {
  const options = { signal };
  //M 使用与同页记忆接口一致的鉴权和错误包装。
  return getJson('/api/memory/backfill', options);
}

/** 按用户选择开始或暂停渠道历史回填。 */
export function setMemoryBackfill(running: boolean): Promise<MemoryBackfill> {
  const body = { running };
  //M 服务端写入断点后返回新状态。
  return sendJson('/api/memory/backfill', 'POST', body);
}

/** 拉飞书群历史的结果（POST /api/feishu/history）。 */
export interface FeishuHistoryResult {
  /** 新交给记忆和聊天 MD 的条数。 */
  pulled: number;
  /** 跳过的条数：本地聊天日志里已有、机器人自己发的、已撤回的。 */
  skipped: number;
  /** 没处理成的条数。 */
  failed: number;
}

/**
 * 拉一个飞书群最近的历史消息。
 * @throws ApiError 权限不够等失败时 message 是后端给的中文原因。
 */
export function pullFeishuHistory(chatId: string, limit: number): Promise<FeishuHistoryResult> {
  const body = { chat_id: chatId, limit };
  //M 后端校验群号和条数，拉的过程出错会把原因放在 error 里。
  return sendJson('/api/feishu/history', 'POST', body);
}


/** 统一记忆搜索结果，图谱开启且查到关系时可带命中子图。 */
export interface MemorySearchResult {
  /** 相关片段。 */
  hits: MemoryHit[];
  /** 未能响应的来源。 */
  unavailable: MemoryHit['source'][];
  /** 根据权限或范围跳过的来源。 */
  skipped: MemoryHit['source'][];
  /** 检索中的提示。 */
  warnings: string[];
  /** 本次使用的检索方式。 */
  mode: string;
  /** 关系三元组。 */
  relations: string[];
  /** 问题里匹配的实体。 */
  queryEntities: string[];
  /** 毫秒耗时。 */
  total_ms: number;
  /** 用于显示命中多跳路径的子图。 */
  graph?: import('./Graph/GraphApi.ts').Found['graph'];
}


/**
 * 统一记忆搜索，参数由发起查询的页面按所选来源和范围提供。
 * @param params 查询串，q 必填，sources、mode、customer、bot 等可选。
 */
export function memorySearch(params: URLSearchParams): Promise<MemorySearchResult> {
  //M 记忆和图谱页面都从同一入口拿各路结果。
  const query = params.toString();
  return getJson<MemorySearchResult>(`/api/memory/search?${query}`);
}


/**
 * 搜聊天内容（docs/界面/01_界面设计.md 6.1）：消息原话和回复、会话标题和摘要。
 * @param keyword 关键字。
 * @param bot 只搜这个机器人；不写搜所有的。
 * @throws 后端说不行时抛错，带原因。
 */
export function searchChat(keyword: string, bot?: string): Promise<types.SearchResult> {
  /** 查询参数。 */
  const query = new URLSearchParams({ q: keyword });
  if (bot) {
    query.set('bot', bot);
  }

  //M 把关键字与可选机器人过滤发给全文搜索接口，用于搜索弹窗渲染命中的消息和会话。
  return getJson<types.SearchResult>(`/api/search?${query.toString()}`);
}


/**
 * 新建机器人（6.2）：不用重启就能用。
 * @param input 填的东西。
 * @throws 名字不对、重名、模型不在清单里时抛错，带原因。
 */
export function createBot(input: types.NewBotInput): Promise<types.NewBotResult> {
  //M 提交新建机器人的身份、语言、模型和飞书参数，让后端即时创建并热挂载生效。
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
  //M 携带时间粒度、分组维度与时间窗口查询用量汇总报表，供右栏用量页展示表格与图表。
  return getJson<types.UsageReport>(`/api/usage?${params.toString()}`);
}


/** 模型的一条会话评价（GET /api/model-notes 里的一项）。 */
export interface ModelRatingItem {
  /** 评价时间。 */
  at: string;
  /** 评价者。 */
  by: string;
  /** 分数，1 到 5。 */
  score: number;
  /** 关联会话号；旧记录为空串。 */
  session: string;
  /** 当时思考档；没有为空串。 */
  thinking: string;
  /** 旧格式任务名。 */
  task: string;
  /** 一句话评语。 */
  note: string;
}


/** 一个模型的介绍与评价汇总。 */
export interface ModelNoteItem {
  /** 模型 ID。 */
  model: string;
  /** 模型介绍。 */
  intro: string;
  /** 评价列表（旧在前，已按同人同会话去重）。 */
  ratings: ModelRatingItem[];
  /** 打过分的会话数 N。 */
  sessionCount: number;
  /** 平均分（1 位小数；无评价为 0）。 */
  average: number;
}


/**
 * 取所有模型的介绍与评价汇总（GET /api/model-notes）。
 */
export function getModelNotes(): Promise<{ list: ModelNoteItem[] }> {
  //M 拉取所有模型的介绍与会话评价汇总，供模型评价页或详情展示。
  return getJson<{ list: ModelNoteItem[] }>('/api/model-notes');
}


/**
 * 给指定会话打分或改分（POST /api/model-notes/rate）。
 * @param input session 会话号，by 评价者，score 1..5，note 一句话可选。
 */
export function rateSession(input: { session: string; by: string; score: number; note: string }): Promise<{ ok: boolean; note: ModelNoteItem }> {
  //M 提交用户对指定会话的评分与一句话评语，拿回更新后的模型汇总用于页面即时刷新。
  return sendJson<{ ok: boolean; note: ModelNoteItem }>('/api/model-notes/rate', 'POST', input);
}
