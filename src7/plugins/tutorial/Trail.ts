/**
 * 一条真实请求的轨迹：从收件表记下这条消息起，到回话写回去为止，按先后列出经过的插件。
 * 数据是 journal 的跟踪行（utils/Trace.ts 那一种：事件名、听的人、会话、文件:行号）。
 * 每一行算到「发它的那一段代码」头上（看 site：plugins/<名字>/ 是插件，Sessions.ts、Tools.ts 这些是骨架服务）；
 * 连着落在同一处的行收成一步，泳道图（Lanes.ts）再把步摆进格子。
 * 每步只留事件名、听的人、代码位置、工具名、模型、状态这些（见 FACT_KEYS）；整条带一句用户原话（preview，左栏和标题用）。
 * 启动轨迹（Boot.ts 记的）也收成同一个格式，消息号写 0。
 */
import type * as sourceModule from './Source.ts';
import * as bootModule from './Boot.ts';


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
  /** 泳道图上的道；不给就按 site 认（getNode）。启动轨迹给：一个插件一步。 */
  node?: string;
  /** 已经挑过、可以露的关键值；不给就从 vars 里按 FACT_KEYS 挑。 */
  facts?: Record<string, string | number | boolean>;
  /** 这一行对应的函数注释（启动轨迹从源码取的）。 */
  docs?: sourceModule.CodeDoc[];
}


/** 一步里的一行，给页面展开看。 */
export interface TrailRow {
  /** 离这条请求开始过了多少毫秒。 */
  t: number;
  /** 到下一行隔了多少毫秒（最后一行是 0）。 */
  gap: number;
  /** 函数（跟踪点）还是事件。 */
  kind: string;
  /** 跟踪点是“模块.函数”，事件是事件名。 */
  name: string;
  /** 一句人话：函数行用它自己的，事件行按事件名配。 */
  text: string;
  /** 事件行：听的人（去掉只记账的 journal、tutorial、usage）。 */
  listeners: string[];
  /** 文件:行号。 */
  site: string;
  /** 不含对话内容的几个关键值。 */
  facts: Record<string, string | number | boolean>;
  /** 这一行算不算出错。 */
  error: boolean;
}


/** 轨迹的一步：连着落在同一个插件（或骨架服务）上的几行。 */
export interface TrailStep {
  /** 第几步，从 1 起。 */
  no: number;
  /** 泳道图上的道：插件名，或 main / resources / tools / sessions。 */
  node: string;
  /** 这一步在干什么（一句话）。 */
  title: string;
  /** 离开始多少毫秒。 */
  t: number;
  /** 这一步用了多少毫秒（到下一步开始）。 */
  ms: number;
  /** 这一步里有没有出错的行。 */
  error: boolean;
  /** 收到通知但没留下跟踪点的插件（只听不说的）。 */
  notified: string[];
  /** 这一步的几行。 */
  rows: TrailRow[];
  /** 这一步的函数注释，照行的先后；请求轨迹没有，是空的。 */
  docs: sourceModule.CodeDoc[];
}


/** 一条请求的轨迹。 */
export interface Trail {
  /** 收件表消息号；启动是 0。 */
  message: number;
  /** 哪场会话；启动、没找到是 null。 */
  session: string | null;
  /** 哪个机器人。 */
  bot: string;
  /** 哪个渠道；启动写“启动”。 */
  channel: string;
  /** 用户那句话（调试用不打码）；启动、没记到的是空串。 */
  preview: string;
  /** 开始时刻，毫秒时间戳。 */
  at: number;
  /** 从收下到回话写回用了多少毫秒。 */
  ms: number;
  /** running：还没回完；done、failed、stopped：会话最后的状态；unknown：没找到收尾。 */
  state: string;
  /** 有没有出错的步。 */
  error: boolean;
  /** 一步一步。 */
  steps: TrailStep[];
  /** 关键变量的英文键 → 中文解释，整条轨迹共用一张（网页在 JSON 那行后面灰字显示）。 */
  notes: Record<string, string>;
}


/** 只记账、什么都不改的插件：不算“经过”。tutorial 自己（录、拍、打印）也只是看。 */
const PASSIVE = new Set(['journal', 'tutorial', 'usage']);

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

/** 网页一步里几行都带变量时，每项多一个 name，启动和请求轨迹共用这句解释。 */
const ROW_NOTES: Record<string, string> = { name: '这一行是哪个函数或事件' };

/** 会话状态的说法。 */
const STATE_WORDS: Record<string, string> = { running: '开始跑', done: '做完了', failed: '出错停了', stopped: '被停下' };

/** 事件名 → 一句人话（session/change、session/message 要看变量，另外配）。 */
const EVENT_WORDS: Record<string, string> = {
  'web-api/received': '收件表记下这条消息',
  'web-api/replied': '回话写回收件表（网页轮询就能看到）',
  'channel/message': '渠道收到消息并广播给各机器人按名字认领',
  'channel/reply': '请求渠道发出纯文字回复',
  'channel/replied': '渠道返回发送回执',
  'channel/history': '向渠道查询当前聊天或提及历史',
  'channel/history-result': '渠道返回历史记录结果',
  'bot/receive': '挨个问：这条消息谁来接、进哪场会话',
  'bot/say': '会话中途先回一句',
  'session/request': '要调模型了，挨个问各插件补提示词、工具、记忆',
  'session/after-model': '模型回来了，回答接进对话前挨个问一声（能改、能喊停）',
  'session/before-tool': '调工具前挨个问一声（审批可以拦）',
  'session/after-tool': '工具做完了，结果接进对话前挨个问一声（能改、能喊停）',
  'model/failed': '模型调用失败',
};

/** 一条请求最多拿几行。 */
export const TRAIL_MAX_LINES = 800;

/** 会话收尾后，再收几毫秒内的同会话行（回话写回收件表那几行）。 */
const TAIL_MS = 3000;

/** 文件夹名 → 插件名（Boot.ts 的 FOLDERS 反过来）：wechat → wechat-kefu。 */
const PLUGIN_OF_FOLDER = Object.fromEntries(Object.entries(bootModule.FOLDERS).map(([plugin, folder]) => [folder, plugin]));


/**
 * 这一行算到哪条道上：看是哪个文件发的。
 * @param site 文件:行号。
 */
export function getNode(site: string): string {
  const file = site.replaceAll('\\', '/');

  //M 插件目录下的：道名是插件名（文件夹名和插件名不一样的换回来）。
  const plugin = /(?:^|\/)plugins\/([^/]+)\//u.exec(file);
  const folder = plugin?.[1];
  if (folder !== undefined) return PLUGIN_OF_FOLDER[folder] ?? folder;

  //M 骨架的文件：Tools.ts、Resources.ts 各一道。
  if (/(?:^|\/)Tools\.ts:/u.test(file)) return 'tools';
  if (/(?:^|\/)Resources\.ts:/u.test(file)) return 'resources';

  //M Sessions.ts（会话和调模型）、Main.ts 都归会话这道。
  return 'sessions';
}


/**
 * 这一行算不算出错。
 * @param line 跟踪行。
 */
export function isLineError(line: TrailLine): boolean {
  if (line.name === 'model/failed') return true;

  //M 跟踪点的变量是中文名（出错）；启动轨迹的行 vars 就是 facts，是英文名（failed）。
  const failed = line.vars['出错'] ?? line.vars['failed'];
  if (failed === true || failed === 'true' || failed === 1) return true;

  return line.name === 'session/change' && line.vars['状态'] === 'failed';
}


/**
 * 事件行配一句人话。
 * @param line 事件行。
 * @returns 认不得的事件是空串。
 */
function getEventText(line: TrailLine): string {
  //M 会话状态变了：照状态说。
  if (line.name === 'session/change') {
    const state = String(line.vars['状态'] ?? '');
    const word = STATE_WORDS[state];
    if (word !== undefined) return `会话${word}`;

    return `会话状态变成 ${state}`;
  }

  //M 会话里多了一条：照角色说；模型的回答要了工具就说要了哪些。
  if (line.name === 'session/message') {
    const role = line.vars['角色'];
    if (role === 'user') return '记下用户这句话';
    if (role === 'toolResult') return `工具 ${String(line.vars['工具'] ?? '')} 给了结果`;
    if (role !== 'assistant') return '会话里多了一条';

    const calls = line.vars['要了工具'];
    if (calls === undefined) return '模型给出回答';

    return `模型要用工具：${String(calls)}`;
  }

  //M 别的事件：查表，查不到是空串。
  return EVENT_WORDS[line.name] ?? '';
}


/**
 * 只留 FACT_KEYS 里的、短的值，键换成英文名。
 * @param vars 跟踪行的变量（中文名）。
 */
function getFacts(vars: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [said, key] of Object.entries(FACT_KEYS)) {
    const value = vars[said];
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (typeof value !== 'string' || value === '') continue;

    //M 字太长的截到 60 个字。
    let shown = value;
    if (value.length > 60) {
      shown = `${value.slice(0, 60)}…`;
    }
    out[key] = shown;
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
  let state = 'running';
  if (session === null) {
    state = 'unknown';
  }
  for (const line of lines) {
    //G 收尾以后过了 TAIL_MS：不再往后看；定时的杂事件跳过。
    if (endAt !== null && line.at - endAt > TAIL_MS) break;
    if (NOISE.has(line.name)) continue;

    //M 这一行是不是这条请求的：消息号对得上、会话对得上、或会话出现前不带会话和消息号的。
    const mine = line.messageId === message || line.vars['消息号'] === message;
    const sameSession = session !== null && line.sessionId === session;
    const loose = !seenSession && line.sessionId === null && line.messageId === null && line.vars['消息号'] === undefined;
    if (endAt !== null && !sameSession && !mine) continue;
    if (!mine && !sameSession && !loose) continue;

    if (sameSession) {
      seenSession = true;
    }
    picked.push(line);

    //M 会话这一轮结束了：记下时刻和状态，再收一小会儿。
    const ended = sameSession && line.name === 'session/change' && line.vars['状态'] !== 'running';
    if (ended && endAt === null) {
      endAt = line.at;
      state = String(line.vars['状态'] ?? 'unknown');
    }

    //G 回话已写回收件表 → 这条请求结束。
    if (endAt !== null && line.name === 'web-api/replied') break;
  }
  return { picked, session, state };
}


/**
 * 把一串行收成一步一步：连着落在同一条道上的行收成一步，耗时算到下一步开始。请求轨迹和启动轨迹共用。
 * @param lines 按先后排好的行。行上有 node 就用它，没有按 site 认；有 facts 就用它，没有从 vars 里挑。
 * @returns 步骤，和第一行、最后一行的时刻。
 */
export function getSteps(lines: TrailLine[]): { steps: TrailStep[]; start: number; end: number } {
  const start = lines[0]?.at ?? 0;
  const steps: TrailStep[] = [];
  lines.forEach((line, index) => {
    //M 这一行在哪条道、离下一行多久、人话、变量。
    const next = lines[index + 1];
    const node = line.node ?? getNode(line.site);
    const error = isLineError(line);
    let gap = 0;
    if (next !== undefined) {
      gap = next.at - line.at;
    }
    //M 事件行按预设描述模板取人话，函数行再覆写为跟踪点自带的描述。
    let text = getEventText(line);
    if (line.kind === '函数') {
      text = line.text;
    }
    const row: TrailRow = {
      t: line.at - start,
      gap,
      kind: line.kind,
      name: line.name,
      text,
      listeners: line.listeners.filter((name) => !PASSIVE.has(name)),
      site: line.site,
      facts: line.facts ?? getFacts(line.vars),
      error,
    };
    const docs = line.docs ?? [];

    //M 和上一步在同一条道上：并进上一步。
    const last = steps[steps.length - 1];
    if (last !== undefined && last.node === node) {
      last.rows.push(row);
      last.docs.push(...docs);
      last.error ||= error;
      return;
    }

    //M 换了道：新起一步。
    steps.push({ no: steps.length + 1, node, title: '', t: row.t, ms: 0, error, notified: [], rows: [row], docs: [...docs] });
  });

  //M 每步用了多久（到下一步开始，最后一步到最后一行）、标题、只听不说的插件。
  const end = lines[lines.length - 1]?.at ?? start;
  const acted = new Set(steps.map((item) => item.node));
  steps.forEach((step, index) => {
    const next = steps[index + 1];
    let until = end - start;
    if (next !== undefined) {
      until = next.t;
    }
    //M 用到下一步开始的间隔算耗时，再提炼这一步的标题。
    step.ms = until - step.t;
    step.title = getTitle(step);

    //M 收到通知但这一轮里自己没留下跟踪点的插件，单列出来。
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
export function getTrail(message: number, lines: TrailLine[]): Trail {
  //M 先按消息号与所属会话筛出请求起止范围内的轨迹行。
  const { picked, session, state } = pick(message, lines);
  //M 再把连续落在同一道上的跟踪行归并成一步一步。
  const { steps, start, end } = getSteps(picked);

  //M 机器人、渠道、用户那句话：各找第一行带着的。
  const botLine = picked.find((line) => typeof line.vars['机器人'] === 'string');
  const channelLine = picked.find((line) => typeof line.vars['渠道'] === 'string');
  const userLine = picked.find((line) => line.vars['角色'] === 'user' && typeof line.vars['说了'] === 'string');
  const preview = String(userLine?.vars['说了'] ?? '').trim();

  const anyError = steps.some((step) => step.error);
  return {
    message,
    session,
    bot: String(botLine?.vars['机器人'] ?? ''),
    channel: String(channelLine?.vars['渠道'] ?? ''),
    preview,
    at: start,
    ms: end - start,
    state,
    error: anyError || state === 'failed',
    steps,
    notes: { ...ROW_NOTES, ...FACT_NOTES },
  };
}


/**
 * 这次启动的轨迹：Boot.ts 交来的行收成一步一步，和请求轨迹同一个格式。
 * 消息号写 0（页面按它认出是启动），渠道写“启动”。
 * @param lines Boot.ts 的 getLines()。
 * @param notes Boot.ts 的关键变量说明表（BootTrail.notes）。
 */
export function getBootTrail(lines: TrailLine[], notes: Record<string, string> = {}): Trail {
  //M 沿用统一归并算法把启动各阶段行按道收成步骤。
  const { steps, start, end } = getSteps(lines);

  //M 记到 ready 了才算启动走完。
  const ready = lines.some((line) => line.name === 'ready');
  let state = 'running';
  if (ready) {
    state = 'done';
  }
  return {
    message: 0,
    session: null,
    bot: '',
    channel: '启动',
    preview: '',
    at: start,
    ms: end - start,
    state,
    error: steps.some((step) => step.error),
    steps,
    notes: { ...ROW_NOTES, ...notes },
  };
}


/**
 * 一步的标题：优先用第一句函数行的人话，没有就用前三句事件说明；等模型的长间隔、执行的工具点出来。
 * @param step 收好的一步。
 */
function getTitle(step: TrailStep): string {
  //M 先找函数行的人话；没有函数行（全是事件）时，把前三句不同的事件说明连起来；再没有用第一行的名字。
  const texts = step.rows.map((row) => row.text).filter((text) => text !== '');
  const events = [...new Set(texts)].slice(0, 3).join('，');
  const fnRow = step.rows.find((row) => row.kind === '函数' && row.text !== '');
  let said = fnRow?.text ?? events;
  if (said === '') {
    said = step.rows[0]?.name ?? '';
  }

  //M 有等模型的长间隔：标题写等了几秒，接着是模型的回答。
  const waited = step.rows.find((row) => row.name === 'Session.loop' && row.gap >= 500);
  if (waited !== undefined) {
    const answer = step.rows.find((row) => row.name === 'session/message' && row.facts['role'] === 'assistant');
    const seconds = (waited.gap / 1000).toFixed(1);
    return `调模型（等了 ${seconds} 秒）→ ${answer?.text ?? said}`;
  }

  //M 执行工具这类，标题里带上工具名。
  const toolRow = step.rows.find((row) => row.kind === '函数' && typeof row.facts['tool'] === 'string');
  const tool = toolRow?.facts['tool'];
  if (typeof tool === 'string' && !said.includes(tool)) return `${said}：${tool}`;

  return said;
}
