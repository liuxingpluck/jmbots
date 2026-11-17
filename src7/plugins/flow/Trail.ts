/**
 * 一条真实请求的轨迹：从收件表记下这条消息起，到回话写回去为止，按先后列出经过的插件。
 * 数据是 journal 的跟踪行（utils/Trace.ts 那一种：事件名、听的人、会话、文件:行号），不用 0.4 的老事件。
 * 每一行算到「发它的那一段代码」头上（看 site：plugins/<名字>/ 是插件，Sessions.ts、Tools.ts 这些是骨架服务）；
 * 连着落在同一处的行收成一步，步与步之间就是图上的一条线。
 * 每步只留事件名、听的人、代码位置、工具名、模型、状态这些（见 FACT_KEYS）；整条带一句用户原话（preview，列表和标题用）。
 * 一步里每行完整的变量、对话.md、用量在 /api/flow/detail（flow/index.ts），点开「变量 / 详情」才取。
 */
import { catalogOf } from './Catalog.ts';


/** journal 跟踪行里这里用到的字段（不 import journal 插件）。 */
export interface TrailLine {
  id: number;
  at: number;
  kind: string;
  name: string;
  listeners: string[];
  text: string;
  site: string;
  sessionId: string | null;
  messageId: number | null;
  vars: Record<string, unknown>;
  /** 图上的点；不给就按 site 认（nodeOf）。启动轨迹（boot-trail）给：一个插件一步。 */
  node?: string;
  /** 已经挑过、可以露的关键值；不给就从 vars 里按 FACT_KEYS 挑。 */
  facts?: Record<string, string | number | boolean>;
  /** 这一行对应的函数注释（boot-trail 从源码取的）。 */
  docs?: CodeDoc[];
}


/** 一段函数注释（和 boot-trail/Source.ts 的 CodeDoc 同形状，不 import 它）。 */
export interface CodeDoc {
  /** 名字。 */
  name: string;
  /** 定义在哪：文件:行号；找不到这段代码时只有文件名。 */
  site: string;
  /** 重要的展开显示，不重要的只显示 summary。 */
  important: boolean;
  /** 空串是取到了；不然是原因：缺注释、读不到源码、找不到这段代码。 */
  missing: string;
  /** 函数原型，一行；文件开头的注释、找不到代码时是空串。 */
  signature: string;
  /** 它干什么。 */
  summary: string;
  /** 参数名和说明。 */
  params: { name: string; text: string }[];
  /** 返回什么。 */
  returns: string;
  /** 什么时候抛错。 */
  throws: string;
  /** 它改了什么。 */
  effects: string;
}


/** 一步里的一行，给页面展开看。 */
export interface TrailRow {
  /** 离这条请求开始过了多少毫秒。 */
  t: number;
  /** 到下一行隔了多少毫秒（最后一行是 0）。 */
  gap: number;
  kind: string;
  name: string;
  /** 一句人话：函数行用它自己的，事件行按事件名配。 */
  text: string;
  /** 事件行：听的人（去掉只记账的 journal、trace、usage）。 */
  listeners: string[];
  /** 文件:行号。 */
  site: string;
  /** 不含对话内容的几个关键值。 */
  facts: Record<string, string | number | boolean>;
  error: boolean;
}


/** 轨迹的一步：连着落在同一个插件（或骨架服务）上的几行。 */
export interface TrailStep {
  /** 第几步，从 1 起。 */
  no: number;
  /** 图上的点：插件名，或 resources / tools / sessions。 */
  node: string;
  /** 这一步在干什么（一句话）。 */
  title: string;
  /** 离开始多少毫秒。 */
  t: number;
  /** 这一步用了多少毫秒（到下一步开始）。 */
  ms: number;
  error: boolean;
  /** 收到通知但没留下跟踪点的插件（只听不说的）。 */
  notified: string[];
  rows: TrailRow[];
  /** 这一步的函数注释，照行的先后；请求轨迹没有，是空的。 */
  docs: CodeDoc[];
}


/** 一条请求的轨迹。 */
export interface Trail {
  message: number;
  session: string | null;
  bot: string;
  channel: string;
  /** 用户那句话（调试用不打码）；启动、没记到的是空串。 */
  preview: string;
  /** 开始时刻，毫秒时间戳。 */
  at: number;
  /** 从收下到回话写回用了多少毫秒。 */
  ms: number;
  /** running：还没回完；done、failed、stopped：会话最后的状态；unknown：没找到收尾。 */
  state: string;
  error: boolean;
  steps: TrailStep[];
  /** 关键变量的英文键 → 中文解释，整条轨迹共用一张（网页在 JSON 那行后面灰字显示）。 */
  notes: Record<string, string>;
}


/** 只记账、什么都不改的插件：不算“经过”。 */
const PASSIVE = new Set(['journal', 'trace', 'usage']);

/** 和这条请求无关、隔一会儿就来一次的事件。State.ts 拍快照时也跳过这些。 */
export const NOISE = new Set(['web-api/status', 'trace', 'ready']);

/**
 * 页面上可以露的几个值（不含说了什么、参数、回话正文）：跟踪点里的中文变量名 → 交给页面的英文键。
 * 只写这一张：反过来就是说明表 FACT_NOTES（中文名就是解释）。
 */
const FACT_KEYS: Record<string, string> = {
  消息号: 'messageId',
  机器人: 'bot',
  渠道: 'channel',
  字数: 'length',
  第几步: 'step',
  模型: 'model',
  角色: 'role',
  要了工具: 'toolCalls',
  工具: 'tool',
  出错: 'failed',
  状态: 'state',
  话多少字: 'textLength',
  这一轮几条: 'turnMessages',
  带了几条往来: 'contextMessages',
  对话几条: 'messageCount',
  附件几个: 'attachmentCount',
};

/** 请求轨迹关键变量的说明表：英文键 → 中文解释。 */
const FACT_NOTES = Object.fromEntries(Object.entries(FACT_KEYS).map(([said, key]) => [key, said]));

/** 网页一步里几行都带变量时，每项多一个 name（FlowPage 的 varsOfStep），启动和请求轨迹共用这句解释。 */
const ROW_NOTES: Record<string, string> = { name: '这一行是哪个函数或事件' };

/** 会话状态的说法。 */
const STATE_WORDS: Record<string, string> = { running: '开始跑', done: '做完了', failed: '出错停了', stopped: '被停下' };

/** 一条请求最多拿几行。 */
export const TRAIL_MAX_LINES = 800;

/** 会话收尾后，再收几毫秒内的同会话行（回话写回收件表那几行）。 */
const TAIL_MS = 3000;


/**
 * 这一行算到图上哪个点：看是哪个文件发的。
 * @param site 文件:行号。
 */
export function nodeOf(site: string): string {
  const file = site.replaceAll('\\', '/');
  const plugin = /(?:^|\/)plugins\/([^/]+)\//u.exec(file);
  if (plugin?.[1] !== undefined) return catalogOf(plugin[1])?.name ?? plugin[1];
  if (/(?:^|\/)Tools\.ts:/u.test(file)) return 'tools';
  if (/(?:^|\/)Resources\.ts:/u.test(file)) return 'resources';
  //M Sessions.ts、Chat.ts（调模型）、Main.ts 都归会话这块。
  return 'sessions';
}


/**
 * 这一行算不算出错。
 * @param line 跟踪行。
 */
export function lineError(line: TrailLine): boolean {
  if (line.name === 'model/failed') return true;
  //M 跟踪点的变量是中文名（出错）；启动轨迹的行 vars 就是 facts，是英文名（failed）。
  const failed = line.vars['出错'] ?? line.vars['failed'];
  if (failed === true || failed === 'true' || failed === 1) return true;
  return line.name === 'session/change' && line.vars['状态'] === 'failed';
}


/** 事件行配一句人话。 */
function eventText(line: TrailLine): string {
  const role = line.vars['角色'];
  switch (line.name) {
    case 'web-api/received': return '收件表记下这条消息';
    case 'web-api/replied': return '回话写回收件表（网页轮询就能看到）';
    case 'bot/receive': return '挨个问：这条消息谁来接、进哪场会话';
    case 'bot/say': return '会话中途先回一句';
    case 'session/request': return '要调模型了，挨个问各插件补提示词、工具、记忆';
    case 'session/before-tool': return '调工具前挨个问一声（审批可以拦）';
    case 'model/failed': return '模型调用失败';
    case 'session/change': return `会话${STATE_WORDS[String(line.vars['状态'] ?? '')] ?? `状态变成 ${String(line.vars['状态'] ?? '')}`}`;
    case 'session/message':
      if (role === 'user') return '记下用户这句话';
      if (role === 'assistant') return line.vars['要了工具'] === undefined ? '模型给出回答' : `模型要用工具：${String(line.vars['要了工具'])}`;
      if (role === 'toolResult') return `工具 ${String(line.vars['工具'] ?? '')} 给了结果`;
      return '会话里多了一条';
    default: return '';
  }
}


/** 只留 FACT_KEYS 里的、短的值，键换成英文名。 */
function factsOf(vars: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [said, key] of Object.entries(FACT_KEYS)) {
    const value = vars[said];
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && value !== '') out[key] = value.length > 60 ? `${value.slice(0, 60)}…` : value;
  }
  return out;
}


/**
 * 从“收件表记下这条消息”那一行往后，挑出属于这条请求的行。
 * 认法：消息号对得上；或会话对得上；会话还没出现之前、没有会话也没有消息号的行（WebApi.accept、Bots.receive、bot/receive 这些）也算。
 * 收尾：会话变成 done / failed / stopped 后，再收 TAIL_MS 内同会话的行就停。
 * @param message 消息号。
 * @param lines 从 web-api/received 那行起、按号从小到大。
 */
export function pick(message: number, lines: TrailLine[]): { picked: TrailLine[]; session: string | null; state: string } {
  //M 会话：先找带着这个消息号又带会话的行（Timeline.reply）；没有就用开始后第一个出现的会话（Bot.receive）。
  const byMessage = lines.find((line) => line.sessionId !== null && (line.messageId === message || line.vars['消息号'] === message));
  const firstSession = lines.find((line) => line.sessionId !== null);
  const session = byMessage?.sessionId ?? firstSession?.sessionId ?? null;

  const picked: TrailLine[] = [];
  let seenSession = false;
  let endAt: number | null = null;
  let state = session === null ? 'unknown' : 'running';
  for (const line of lines) {
    if (endAt !== null && line.at - endAt > TAIL_MS) break;
    if (NOISE.has(line.name)) continue;
    const mine = line.messageId === message || line.vars['消息号'] === message;
    const sameSession = session !== null && line.sessionId === session;
    const loose = !seenSession && line.sessionId === null && line.messageId === null && line.vars['消息号'] === undefined;
    if (endAt !== null && !sameSession && !mine) continue;
    if (!mine && !sameSession && !loose) continue;
    if (sameSession) seenSession = true;
    picked.push(line);
    if (sameSession && line.name === 'session/change' && line.vars['状态'] !== 'running' && endAt === null) {
      endAt = line.at;
      state = String(line.vars['状态'] ?? 'unknown');
    }
    //G 回话已写回收件表 → 这条请求结束。
    if (endAt !== null && line.name === 'web-api/replied') break;
  }
  return { picked, session, state };
}


/**
 * 把一串行收成一步一步：连着落在同一个点上的行收成一步，耗时算到下一步开始。请求轨迹和启动轨迹共用。
 * @param lines 按先后排好的行。行上有 node 就用它，没有按 site 认；有 facts 就用它，没有从 vars 里挑。
 * @returns 步骤，和第一行、最后一行的时刻。
 */
export function stepsOf(lines: TrailLine[]): { steps: TrailStep[]; start: number; end: number } {
  const start = lines[0]?.at ?? 0;
  const steps: TrailStep[] = [];
  lines.forEach((line, index) => {
    const next = lines[index + 1];
    const node = line.node ?? nodeOf(line.site);
    const error = lineError(line);
    const row: TrailRow = {
      t: line.at - start,
      gap: next === undefined ? 0 : next.at - line.at,
      kind: line.kind,
      name: line.name,
      text: line.kind === '函数' ? line.text : eventText(line),
      listeners: line.listeners.filter((name) => !PASSIVE.has(name)),
      site: line.site,
      facts: line.facts ?? factsOf(line.vars),
      error,
    };
    const docs = line.docs ?? [];
    const last = steps[steps.length - 1];
    if (last !== undefined && last.node === node) {
      last.rows.push(row);
      last.docs.push(...docs);
      last.error ||= error;
      return;
    }
    steps.push({ no: steps.length + 1, node, title: '', t: row.t, ms: 0, error, notified: [], rows: [row], docs: [...docs] });
  });

  const end = lines[lines.length - 1]?.at ?? start;
  steps.forEach((step, index) => {
    const next = steps[index + 1];
    step.ms = (next === undefined ? end - start : next.t) - step.t;
    step.title = titleOf(step);
    //M 收到通知但这一轮里自己没留下跟踪点的插件，单列出来（图上画浅色）。
    const acted = new Set(steps.map((item) => item.node));
    const heard = new Set(step.rows.flatMap((row) => row.listeners));
    step.notified = [...heard].filter((name) => !acted.has(name));
  });
  return { steps, start, end };
}


/**
 * 一条请求的轨迹：挑出属于它的行，收成一步一步。
 * @param message 消息号。
 * @param lines 从 web-api/received 那行起、按号从小到大（最多 TRAIL_MAX_LINES 行）。
 */
export function trailOf(message: number, lines: TrailLine[]): Trail {
  const { picked, session, state } = pick(message, lines);
  const { steps, start, end } = stepsOf(picked);
  const botLine = picked.find((line) => typeof line.vars['机器人'] === 'string');
  const channelLine = picked.find((line) => typeof line.vars['渠道'] === 'string');
  //M 用户那句话：记下用户这句话（session/message，角色 user）那行的「说了」。
  const userLine = picked.find((line) => line.vars['角色'] === 'user' && typeof line.vars['说了'] === 'string');
  return {
    message,
    session,
    bot: String(botLine?.vars['机器人'] ?? ''),
    channel: String(channelLine?.vars['渠道'] ?? ''),
    preview: String(userLine?.vars['说了'] ?? '').trim(),
    at: start,
    ms: end - start,
    state,
    error: steps.some((step) => step.error) || state === 'failed',
    steps,
    notes: { ...ROW_NOTES, ...FACT_NOTES },
  };
}


/**
 * 这次启动的轨迹：boot-trail 交来的行收成一步一步，和请求轨迹同一个格式，画布照样放。
 * 消息号写 0（页面按它认出是启动），渠道写“启动”。
 * @param lines boot-trail 的 lines()。
 * @param notes boot-trail 的关键变量说明表（BootTrail.notes）。
 */
export function bootTrailOf(lines: TrailLine[], notes: Record<string, string> = {}): Trail {
  const { steps, start, end } = stepsOf(lines);
  const ready = lines.some((line) => line.name === 'ready');
  return {
    message: 0,
    session: null,
    bot: '',
    channel: '启动',
    preview: '',
    at: start,
    ms: end - start,
    state: ready ? 'done' : 'running',
    error: steps.some((step) => step.error),
    steps,
    notes: { ...ROW_NOTES, ...notes },
  };
}


/** 一步的标题：优先用第一句函数行的人话，没有就用第一句事件说明；有等模型的长间隔就点出来。 */
function titleOf(step: TrailStep): string {
  //M 没有函数行（全是事件）时，把前三句不同的事件说明连起来。
  const events = [...new Set(step.rows.map((row) => row.text).filter((text) => text !== ''))].slice(0, 3).join('，');
  const said = step.rows.find((row) => row.kind === '函数' && row.text !== '')?.text
    ?? (events !== '' ? events : step.rows[0]?.name ?? '');
  const waited = step.rows.find((row) => row.name === 'Session.loop' && row.gap >= 500);
  //M 执行工具这类，标题里带上工具名。
  const tool = step.rows.find((row) => row.kind === '函数' && typeof row.facts['tool'] === 'string')?.facts['tool'];
  if (waited === undefined && typeof tool === 'string' && !said.includes(tool)) return `${said}：${tool}`;
  if (waited !== undefined) return `调模型（等了 ${(waited.gap / 1000).toFixed(1)} 秒）→ ${step.rows.find((row) => row.name === 'session/message' && row.facts['role'] === 'assistant')?.text ?? said}`;
  return said;
}
