/**
 * 教程页「4段路线」10秒自测页内直答工具：
 * 1. 动态从 GET /api/bots 读取配置好的机器人列表（零硬编码机器人名），支持自由切换批改机器人并记住上次选择；
 * 2. 复用现有 POST /api/message 与 GET /api/messages/:id 有界轮询回显批改评语，区分永久错误与可重试抖动；
 * 3. 在浏览器 localStorage 持久化答题、所用机器人与过关进度，并防刷新后无限轮询死循环。
 */
import * as tokenModule from '../Token.ts';
import type * as meta from './CompactMetaData.ts';


/** 单块自测提交状态。 */
export type QuizStatus = 'idle' | 'sending' | 'pending' | 'replied' | 'error';


/** 单个学习小块的本地自测与批改记录。 */
export interface QuizRecord {
  /** 小块唯一编号（如 '1.1'）。 */
  chunkId: string;
  /** 本次提交发给的机器人名（来自 GET /api/bots 动态配置）。 */
  bot: string;
  /** 老板最新填写的回答正文。 */
  answer: string;
  /** POST /api/message 返回的消息号；未发或已失效时为 null。 */
  messageId: number | null;
  /** 当前提交与批改状态。 */
  status: QuizStatus;
  /** 机器人返回的最终批改评语；未回时为空串。 */
  replyText: string;
  /** 是否已判定通过本块自测。 */
  passed: boolean;
  /** 发送或轮询失败时的简短报错提示。 */
  error: string;
  /** 提交时是否请该机器人以自身身份把批改结果顺手发一条飞书私聊。 */
  syncFeishu: boolean;
  /** 最近一次更新时间戳（毫秒）。 */
  updatedAt: number;
}


/** 以 chunkId 为键的本地自测记录映射表。 */
export type QuizStore = Record<string, QuizRecord>;


/** 拉取可用机器人列表的结果。 */
export interface BotsLoadResult {
  /** 后端已配置的机器人名称列表。 */
  bots: string[];
  /** 拉取失败时的中文提示；成功时为空串。 */
  error: string;
}


/** 单次轮询 GET /api/messages/:id 的三态判定结果。 */
export type PollQuizResult =
  | {
      /** 已收到真实批改评语。 */
      kind: 'reply';
      /** 机器人返回的最终批改正文。 */
      text: string;
    }
  | {
      /** 仍在等待批改，或遇到可重试的瞬时网络/服务抖动。 */
      kind: 'pending';
    }
  | {
      /** 遇到不可恢复的永久性错误（如 401/403/404/410），应立即停表。 */
      kind: 'fatal';
      /** 面向用户的中文错误原因。 */
      reason: string;
      /** 是否应清空失效的 messageId（如 404/410 消息不存在时为 true）。 */
      clearMessageId: boolean;
    };


/** 浏览器 localStorage 持久化自测记录键名。 */
export const QUIZ_STORAGE_KEY = 'jmbots.tutorial.quiz.v1';

/** 浏览器 localStorage 记住上次所选批改机器人的键名。 */
export const QUIZ_BOT_STORAGE_KEY = 'jmbots.tutorial.quiz.bot.v1';

/** POST /api/message 标记来源字段，便于追溯教程页直答记录。 */
export const QUIZ_FROM = 'tutorial-quiz';

/** 轮询机器人批改回信的间隔（毫秒）。 */
export const POLL_INTERVAL_MS = 2500;

/** 单条待批改记录允许轮询的最大总时长（毫秒，5 分钟）。 */
export const MAX_POLL_MS = 5 * 60 * 1000;

/** 单轮轮询最多执行的请求次数上限（与 5 分钟总时长匹配）。 */
export const MAX_POLL_ATTEMPTS = 120;

/** 等待批改超时后的统一中文提示文案。 */
export const PENDING_TIMEOUT_ERROR = '等待批改超时（超过 5 分钟），可点击「重新查询」或重新发送';

/** relay 即时占位回复前缀；轮询时跳过占位，只采纳真正的批改回信。 */
const PLACEHOLDER_PREFIXES = ['已转给 ', '已转交给 '];

/** 允许持久化的合法状态集合。 */
const VALID_STATUSES = new Set<QuizStatus>(['idle', 'sending', 'pending', 'replied', 'error']);

/** 轮询遇到这些 HTTP 状态码时立刻终止，不再重试空转。 */
const FATAL_AUTH_STATUSES = new Set([401, 403]);

/** 消息已被清理或不存在的永久状态码集合。 */
const FATAL_MISSING_STATUSES = new Set([404, 410]);


/**
 * 从 GET /api/bots 响应数组中提取去重后的可用机器人名列表。
 * @param raw 后端返回的未知数据。
 * @returns 机器人名称列表（保持后端配置顺序）。
 */
export function parseBotNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];

  const names: string[] = [];
  const seen = new Set<string>();
  //M 按后端返回顺序提取非空且去重的机器人名。
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const name = (item as Record<string, unknown>)['name'];
    if (typeof name !== 'string' || name.trim() === '' || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}


/**
 * 结合可用机器人列表与用户上次选择，决定当前生效的批改机器人（零硬编码默认值）。
 * @param availableBots 后端配置提供的机器人名列表。
 * @param preferred 用户偏好或上次保存的机器人名。
 * @returns 合法的机器人名；列表为空时返回空串。
 */
export function resolveSelectedBot(availableBots: readonly string[], preferred: string): string {
  if (availableBots.length === 0) return '';
  if (preferred !== '' && availableBots.includes(preferred)) return preferred;

  return availableBots[0] ?? '';
}


/**
 * 从浏览器存储读取上次选中的批改机器人名。
 * @param storage 可选存储对象（单测注入用，默认 window.localStorage）。
 */
export function loadPreferredBot(storage?: Pick<Storage, 'getItem'>): string {
  try {
    let target = storage;
    if (target === undefined) {
      target = window.localStorage;
    }
    return target.getItem(QUIZ_BOT_STORAGE_KEY) ?? '';
  } catch {
    //G 存储不可用时回落为空串，由后端列表首项兜底。
    return '';
  }
}


/**
 * 把当前选中的批改机器人名写入浏览器存储。
 * @param bot 机器人名。
 * @param storage 可选存储对象（单测注入用，默认 window.localStorage）。
 */
export function savePreferredBot(bot: string, storage?: Pick<Storage, 'setItem'>): void {
  if (bot === '') return;

  try {
    let target = storage;
    if (target === undefined) {
      target = window.localStorage;
    }
    target.setItem(QUIZ_BOT_STORAGE_KEY, bot);
  } catch {
    //G 存储不可用时仅保留当前页面状态。
  }
}


/**
 * 从 GET /api/bots 拉取当前系统已配置的全部机器人名，并显式区分成功与失败原因。
 * @param fetcher 可选请求实现（单测注入用，默认全局 fetch）。
 * @returns 机器人名数组及可能的中文报错。
 */
export async function fetchAvailableBots(fetcher: typeof fetch = fetch): Promise<BotsLoadResult> {
  try {
    const url = tokenModule.withToken('/api/bots', tokenModule.TOKEN);
    const response = await fetcher(url);
    if (!response.ok) {
      const reason = await readErrorMessage(response);
      return { bots: [], error: `机器人列表加载失败：${reason}` };
    }
    const data: unknown = await response.json();
    return { bots: parseBotNames(data), error: '' };
  } catch {
    //G 网络中断或响应解析异常时暴露清晰失败提示，允许用户点击重试。
    return { bots: [], error: '网络异常，机器人列表加载失败' };
  }
}


/**
 * 按统一格式拼装发给所选机器人的教程自测消息，方便批改机器人识别块号、原题与是否抄送飞书。
 * @param chunk 当前学习小块元数据。
 * @param answer 老板填写的回答正文。
 * @param syncFeishu 是否请批改机器人以自身身份把结论抄送一条飞书私聊。
 * @returns 规范化后的待发送正文。
 */
export function buildQuizPrompt(chunk: meta.StageChunk, answer: string, syncFeishu: boolean): string {
  const trimmed = answer.trim();
  const lines = [
    `【教程自测·${chunk.title}】`,
    `问题：${chunk.quiz}`,
    `我的回答：${trimmed}`,
  ];
  if (syncFeishu) {
    lines.push('（批改完成后请以你的机器人身份顺手发我一条飞书私聊同步结果）');
  }
  return lines.join('\n');
}


/**
 * 判断一条回话是否仅为 relay 自动发出的“已转给…”占位提示。
 * @param text 单条回话正文。
 * @returns true 表示占位提示，尚未收到真正的批改结果。
 */
export function isRelayPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  for (const prefix of PLACEHOLDER_PREFIXES) {
    if (trimmed.startsWith(prefix)) return true;
  }
  return false;
}


/**
 * 从 GET /api/messages/:id 返回的 replies 数组中提取最后一条非占位的真实批改回复。
 * @param replies 消息对象上的回话列表。
 * @returns 真实回复正文；尚未收到则返回 undefined。
 */
export function extractFinalReply(replies: ReadonlyArray<{ text?: unknown }>): string | undefined {
  let latest: string | undefined;
  //M 跳过空文本与 relay 即时占位提示，始终保留最新一条真实批改回信。
  for (const item of replies) {
    if (typeof item.text !== 'string') {
      continue;
    }
    const trimmed = item.text.trim();
    if (trimmed === '' || isRelayPlaceholder(trimmed)) {
      continue;
    }
    latest = trimmed;
  }
  return latest;
}


/**
 * 根据批改评语文本判定本块自测是否过关。
 * @param replyText 机器人返回的评语正文。
 * @returns true 表示通过，false 表示需继续巩固。
 */
export function detectQuizPassed(replyText: string): boolean {
  if (replyText.includes('【未过关】') || replyText.includes('未过关') || replyText.includes('暂未通过')) {
    return false;
  }
  if (replyText.includes('【过关】') || replyText.includes('已过关') || replyText.includes('✅')) {
    return true;
  }
  return false;
}


/**
 * 判断一条处于 pending 状态的自测记录是否已超过允许的轮询有效期。
 * @param updatedAt 记录最近更新时间戳（毫秒）。
 * @param now 当前时间戳（毫秒，默认 Date.now()）。
 * @returns true 表示时间戳缺失/非法或已超过 MAX_POLL_MS，应停止自动轮询。
 */
export function isPendingExpired(updatedAt: number, now: number = Date.now()): boolean {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return true;

  return now - updatedAt >= MAX_POLL_MS;
}


/**
 * 将单次 GET /api/messages/:id 的状态码与响应体映射为三态轮询结果。
 * @param status HTTP 状态码。
 * @param body 已解析的响应 JSON（非 2xx 时可传 null）。
 * @returns reply（已批改）、pending（继续等待）或 fatal（立即停表）。
 */
export function classifyPollResponse(status: number, body: unknown): PollQuizResult {
  //G 鉴权失效属于不可自愈错误，立刻停表提示重新携带令牌打开页面。
  if (FATAL_AUTH_STATUSES.has(status)) {
    return {
      kind: 'fatal',
      reason: '访问令牌缺失或已失效，请从带令牌的链接重新打开教程页',
      clearMessageId: false,
    };
  }
  //G 消息记录不存在或已移除时立刻停表并清空失效消息号。
  if (FATAL_MISSING_STATUSES.has(status)) {
    return {
      kind: 'fatal',
      reason: '该条批改消息已不存在，请重新发送回答',
      clearMessageId: true,
    };
  }
  //G 5xx 等瞬时错误保留在轮询上限内重试，不误杀批改流程。
  if (status < 200 || status >= 300) {
    return { kind: 'pending' };
  }
  if (typeof body !== 'object' || body === null) {
    return { kind: 'pending' };
  }

  const replies = (body as Record<string, unknown>)['replies'];
  if (!Array.isArray(replies)) {
    return { kind: 'pending' };
  }

  const finalText = extractFinalReply(replies as ReadonlyArray<{ text?: unknown }>);
  if (finalText === undefined) {
    return { kind: 'pending' };
  }
  return { kind: 'reply', text: finalText };
}


/**
 * 校验单条持久化记录字段合法性，过滤掉损坏或版本不兼容的旧项，并防止过期 pending 刷新后死循环。
 * @param chunkId 键名。
 * @param raw 反序列化后的未知对象。
 * @param now 当前时间戳（毫秒）。
 * @returns 规范化后的 QuizRecord；不合法则返回 undefined。
 */
function parseRecord(chunkId: string, raw: unknown, now: number): QuizRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;

  const obj = raw as Record<string, unknown>;
  if (typeof obj['answer'] !== 'string') return undefined;

  let status: QuizStatus = 'idle';
  if (typeof obj['status'] === 'string' && VALID_STATUSES.has(obj['status'] as QuizStatus)) {
    status = obj['status'] as QuizStatus;
  }
  //G 刷新前若停留在 sending 瞬态，恢复后回落为 idle 避免按钮永久卡死。
  if (status === 'sending') {
    status = 'idle';
  }

  let bot = '';
  if (typeof obj['bot'] === 'string') {
    bot = obj['bot'];
  }

  let messageId: number | null = null;
  if (typeof obj['messageId'] === 'number' && Number.isSafeInteger(obj['messageId']) && obj['messageId'] > 0) {
    messageId = obj['messageId'];
  }

  let replyText = '';
  if (typeof obj['replyText'] === 'string') {
    replyText = obj['replyText'];
  }

  let error = '';
  if (typeof obj['error'] === 'string') {
    error = obj['error'];
  }

  let updatedAt = 0;
  if (typeof obj['updatedAt'] === 'number' && Number.isFinite(obj['updatedAt'])) {
    updatedAt = obj['updatedAt'];
  }

  //G 持久化 pending 若缺消息号直接回落 idle；若已超轮询有效期或无合法时间戳，降级为超时提示态防刷新死循环。
  if (status === 'pending' && messageId === null) {
    status = 'idle';
  }
  if (status === 'pending' && isPendingExpired(updatedAt, now)) {
    status = 'error';
    if (error === '') {
      error = PENDING_TIMEOUT_ERROR;
    }
  }

  return {
    chunkId,
    bot,
    answer: obj['answer'],
    messageId,
    status,
    replyText,
    passed: obj['passed'] === true,
    error,
    syncFeishu: obj['syncFeishu'] === true,
    updatedAt,
  };
}


/**
 * 从浏览器存储读取已保存的自测记录映射表。
 * @param storage 可选存储对象（单测注入用，默认 window.localStorage）。
 * @param now 当前时间戳（毫秒，单测注入用，默认 Date.now()）。
 * @returns 安全的记录映射表；读取或解析失败时返回空对象。
 */
export function loadQuizStore(
  storage?: Pick<Storage, 'getItem'>,
  now: number = Date.now(),
): QuizStore {
  try {
    let target = storage;
    if (target === undefined) {
      target = window.localStorage;
    }
    const raw = target.getItem(QUIZ_STORAGE_KEY);
    if (raw === null || raw === '') return {};

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    const result: QuizStore = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = parseRecord(key, value, now);
      if (record !== undefined) {
        result[key] = record;
      }
    }
    return result;
  } catch {
    //G 存储不可用或旧数据损坏时降级为空记录，不阻塞页面打开。
    return {};
  }
}


/**
 * 把最新自测记录映射表写回浏览器存储。
 * @param store 当前映射表。
 * @param storage 可选存储对象（单测注入用，默认 window.localStorage）。
 */
export function saveQuizStore(store: QuizStore, storage?: Pick<Storage, 'setItem'>): void {
  try {
    let target = storage;
    if (target === undefined) {
      target = window.localStorage;
    }
    target.setItem(QUIZ_STORAGE_KEY, JSON.stringify(store));
  } catch {
    //G 隐私模式或存储配额满时静默降级，仅保持内存态可用。
  }
}


/**
 * 从失败的 HTTP 响应中提取简短可读报错。
 * @param response Fetch 响应对象。
 * @returns 中文报错说明。
 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data: unknown = await response.json();
    if (typeof data === 'object' && data !== null) {
      const err = (data as Record<string, unknown>)['error'];
      if (typeof err === 'string' && err !== '') return err;
    }
  } catch {
    //G 非 JSON 报错体回落到状态码提示。
  }
  return `请求失败（HTTP ${String(response.status)}）`;
}


/**
 * 提交单块自测回答到 POST /api/message（发给用户在界面选定的任意配置机器人）。
 * @param bot 目标机器人名（来自 /api/bots 动态列表）。
 * @param chunk 当前学习小块。
 * @param answer 回答正文。
 * @param syncFeishu 是否请机器人以自身身份同步发一条飞书私聊。
 * @returns 后端写入的消息号。
 */
export async function submitQuizAnswer(
  bot: string,
  chunk: meta.StageChunk,
  answer: string,
  syncFeishu: boolean,
): Promise<{ messageId: number }> {
  if (bot.trim() === '') {
    throw new Error('请先选择一个批改机器人');
  }
  const text = buildQuizPrompt(chunk, answer, syncFeishu);
  const url = tokenModule.withToken('/api/message', tokenModule.TOKEN);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bot,
      from: QUIZ_FROM,
      text,
    }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null) {
    throw new Error('接口返回格式异常');
  }
  const id = (data as Record<string, unknown>)['id'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error('未返回有效消息号');
  }
  return { messageId: id };
}


/**
 * 按消息号查询 GET /api/messages/:id，返回三态批改结果（已回 / 等待 / 永久错误）。
 * @param messageId POST /api/message 返回的消息号。
 * @param fetcher 可选请求实现（单测注入用，默认全局 fetch）。
 * @returns 三态轮询结果对象。
 */
export async function pollQuizReply(
  messageId: number,
  fetcher: typeof fetch = fetch,
): Promise<PollQuizResult> {
  try {
    const url = tokenModule.withToken(`/api/messages/${String(messageId)}`, tokenModule.TOKEN);
    const response = await fetcher(url);
    if (!response.ok) {
      return classifyPollResponse(response.status, null);
    }
    const data: unknown = await response.json();
    return classifyPollResponse(response.status, data);
  } catch {
    //G 单次网络抖动或 JSON 截断视为 pending，交由调用方按轮询上限兜底。
    return { kind: 'pending' };
  }
}
