/**
 * 跟踪行 → 一步一步：“journal 行整理成步骤”只在这里写一份（11-18 从 tutorial/Trail.ts 挪来，web-api/Trace.ts 挑行那段也并进来）。
 * 一条真实请求的轨迹：从收件表记下这条消息起，到回话写回去为止，按先后列出经过的插件。
 * 数据是 journal 的跟踪行（utils/Trace.ts 那一种：事件名、听的人、会话、文件:行号）。
 * 每一行算到「发它的那一段代码」头上（看 site：plugins/<名字>/ 是插件，Sessions.ts、Tools.ts 这些是骨架服务）；
 * 连着落在同一处的行收成一步，tutorial 的泳道图（tutorial/Lanes.ts）再把步摆进格子。
 * 每步只留事件名、听的人、代码位置、工具名、模型、状态这些（见 FACT_KEYS）；整条带一句用户原话（preview，左栏和标题用）。
 * 启动轨迹（tutorial/Boot.ts 记的）也收成同一个格式，消息号写 0。
 * 教程页用 pick 保留收尾附近的行。聊天页由 index.ts 查询到指定回话为止。
 * 对外：index.ts 的 journal/request 用 trail、boot-trail、reply-lines 三个 action 交出去；tutorial 不 import 本文件，发事件取。
 * 形状（Trail、TrailLine 等）和 NOISE、FOLDERS 放在 utils/Trail.ts，journal、tutorial 共用。
 * 本文件不 import 别的插件，也不 import 同目录的 index.ts。
 */
import * as traceText from '../../../web/src/locales/Trace.ts';
import { FOLDERS, NOISE } from '../../utils/Trail.ts';
import type { Trail, TrailLine, TrailRow, TrailStep } from '../../utils/Trail.ts';


/** 只记账、什么都不改的插件：不算“经过”。tutorial 自己（录、拍、打印）也只是看。 */
const PASSIVE = new Set(['journal', 'tutorial', 'usage']);

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
  思考档: 'thinking',
  会话种类: 'sessionKind',
  角色: 'role',
  要了工具: 'toolCalls',
  工具: 'tool',
  出错: 'failed',
  原状态: 'stateBefore',
  状态: 'state',
  话多少字: 'textLength',
  回话字数: 'replyLength',
  已回几条: 'replyCount',
  这一轮几条: 'turnMessages',
  带了几条往来: 'contextMessages',
  对话几条: 'messageCount',
  加工前提示词段数: 'systemBefore',
  加工后提示词段数: 'systemAfter',
  可用工具数: 'toolsCount',
  插件代答: 'answeredByPlugin',
  回答来源: 'answeredBy',
  附件几个: 'attachmentCount',
  数据表: 'table',
  收件状态: 'status',
  自动兜底回话: 'autoFinal',
  指定会话: 'targetSession',
  消息类型: 'type',
  聊天类型: 'chat',
  叫了机器人: 'called',
  说话人: 'personName',
  说话人身份: 'speakerRole',
  裁剪前词元: 'tokensBefore',
  裁剪后词元: 'tokensAfter',
  截短几条: 'trimmedCount',
  丢掉几条: 'droppedCount',
  审核结论: 'verdict',
  决策来源: 'decidedBy',
  命中技能数: 'skillCount',
  命中引用数: 'citationCount',
};

/** 请求轨迹关键变量的说明表：英文键 → 中文解释。 */
const FACT_NOTES = Object.fromEntries(Object.entries(FACT_KEYS).map(([said, key]) => [key, said]));

/** 网页一步里几行都带变量时，每项多一个 name，启动和请求轨迹共用这句解释。 */
const ROW_NOTES: Record<string, string> = { name: '这一行是哪个函数或事件' };

/** 会话状态的说法。 */
const STATE_TEXT: Record<string, string> = {
  running: 'trace.event.sessionRunning',
  done: 'trace.event.sessionDone',
  failed: 'trace.event.sessionFailed',
  stopped: 'trace.event.sessionStopped',
};

/** 旧流水里的事件仍照原样存储，拼轨迹时用当前的事件名。 */
const TRAIL_EVENT_NAMES = new Map([
  ['session/request', 'session/before-model'],
  ['session/message', 'session/new-message'],
  ['model/failed', 'session/model-failed'],
  ['channel/settled', 'bot/settled'],
  ['model/cooldown', 'model-catalog/cooldown'],
  ['model/fallback', 'model-catalog/fallback'],
  ['usage/list', 'model-catalog/usage'],
  ['usage/list-result', 'model-catalog/usage-result'],
  ['program/state', 'programs/state'],
  ['resource/pressure', 'programs/pressure'],
  ['resource/request', 'programs/resource-request'],
  ['resource/result', 'programs/resource-result'],
  ['flow/state', 'tutorial/state'],
]);

/** 事件名 → 一句人话（session/change、session/new-message 要看变量，另外配）。 */
const EVENT_TEXT: Record<string, string> = {
  'web-api/received': 'trace.event.webApiReceived',
  'web-api/replied': 'trace.event.webApiReplied',
  'channel/direct': 'trace.event.channelDirect',
  'channel/mention': 'trace.event.channelMention',
  'channel/listen': 'trace.event.channelListen',
  'channel/reply': 'trace.event.channelReply',
  'channel/replied': 'trace.event.channelReplied',
  'bot/receive': 'trace.event.botReceive',
  'bot/say': 'trace.event.botSay',
  'session/before-model': 'trace.event.sessionRequest',
  'session/after-model': 'trace.event.sessionAfterModel',
  'session/before-tool': 'trace.event.sessionBeforeTool',
  'session/after-tool': 'trace.event.sessionAfterTool',
  'session/model-failed': 'trace.event.modelFailed',
};

/** 会话收尾后，再收几毫秒内的同会话行（回话写回收件表那几行）。 */
const TAIL_MS = 3000;

/** 文件夹名 → 插件名（FOLDERS 反过来）：wechat → wechat-kefu。 */
const PLUGIN_OF_FOLDER = Object.fromEntries(Object.entries(FOLDERS).map(([plugin, folder]) => [folder, plugin]));


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
  //M 旧流水与现行事件用同一个名字判断模型失败。
  const name = TRAIL_EVENT_NAMES.get(line.name) ?? line.name;
  if (name === 'session/model-failed') return true;

  //M 优先读取稳定键，旧流水原字段仍可定位错误。
  const failed = line.vars['failed'] ?? line.vars['出错'];
  if (failed === true || failed === 'true' || failed === 1) return true;

  const state = line.vars['state'] ?? line.vars['状态'];
  return line.name === 'session/change' && state === 'failed';
}


/**
 * 事件行配一句人话。
 * @param line 事件行。
 * @param name 当前事件名，旧流水中的名字已映射。
 * @returns 认不得的事件是空串。
 */
export function getEventTextId(line: TrailLine, name: string): string {
  if (name === 'session/change') {
    const state = String(line.vars['state'] ?? line.vars['状态'] ?? '');
    return STATE_TEXT[state] ?? 'trace.event.sessionChanged';
  }
  if (name !== 'session/new-message') return EVENT_TEXT[name] ?? '';

  const role = line.vars['role'] ?? line.vars['角色'];
  if (role === 'user') return 'trace.event.userMessage';
  if (role === 'toolResult') return 'trace.event.toolResult';
  if (role !== 'assistant') return 'trace.event.sessionMessage';
  const calls = line.vars['toolCalls'] ?? line.vars['要了工具'];
  if (calls === undefined) return 'trace.event.modelAnswer';

  return 'trace.event.toolCalls';
}


/** 新行交画布文案编号，旧行保持之前的显示。 */
function getEventText(line: TrailLine, name: string): string {
  const id = getEventTextId(line, name);
  const mode = line.mode ?? '';
  if (traceText.getTraceModeId(mode) !== mode) return id;

  const params = {
    state: String(line.vars['state'] ?? line.vars['状态'] ?? ''),
    tool: String(line.vars['tool'] ?? line.vars['工具'] ?? ''),
    toolCalls: String(line.vars['toolCalls'] ?? line.vars['要了工具'] ?? ''),
  };
  return traceText.getTraceText('zh', id, params);
}


/**
 * 只留 FACT_KEYS 里的、短的值，键换成英文名；People.resolve 的 role 映射为 speakerRole 免得和消息角色重名。
 * @param vars 跟踪行的变量（中文名或英文名）。
 * @param lineName 跟踪行名称（如 People.resolve）。
 */
function getFacts(vars: Record<string, unknown>, lineName = ''): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const isPeople = lineName === 'People.resolve';
  for (const [said, key] of Object.entries(FACT_KEYS)) {
    if (isPeople && key === 'role') continue;

    let value = vars[key] ?? vars[said];
    if (isPeople && key === 'speakerRole' && value === undefined) {
      value = vars['role'];
    }
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
export function pick(
  message: number,
  lines: TrailLine[],
): { picked: TrailLine[]; session: string | null; state: string } {
  //M 会话：先找带着这个消息号又带会话的行（Timeline.reply）；没有就用开始后第一个出现的会话（Bot.receive）。
  //M   渠道来的消息，收件行前面还有渠道那几行（飞书收到、去重、认 @、channel/direct 等进来的事件）：没有收件号和会话、只带这条的标准消息号，也算。
  const sourceLine = lines.find((line) => line.messageId === message && typeof line.sourceId === 'string');
  const sourceId = sourceLine?.sourceId ?? null;
  const carriesSource = (line: TrailLine): boolean => {
    return sourceId !== null && line.messageId === null && line.sessionId === null && line.sourceId === sourceId;
  };
  const carries = (line: TrailLine): boolean => {
    const varMessage = line.vars['messageId'] ?? line.vars['消息号'];
    return line.messageId === message || varMessage === message || carriesSource(line);
  };
  const byMessage = lines.find((line) => line.sessionId !== null && carries(line));
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
    const mine = carries(line);
    const sameSession = session !== null && line.sessionId === session;
    const rawMessageId = line.vars['messageId'] ?? line.vars['消息号'];
    const loose = !seenSession && line.sessionId === null && line.messageId === null && rawMessageId === undefined;
    if (endAt !== null && !sameSession && !mine) continue;
    if (!mine && !sameSession && !loose) continue;

    //G 会话出现过以后，不带会话的散行不再算。
    if (sameSession) {
      seenSession = true;
    }

    //M 是这条请求的：收下。
    picked.push(line);

    //M 会话这一轮结束了：记下时刻和状态，再收一小会儿。
    const recordedState = line.vars['state'] ?? line.vars['状态'];
    const ended = sameSession && line.name === 'session/change' && recordedState !== 'running';
    if (ended && endAt === null) {
      endAt = line.at;
      state = String(recordedState ?? 'unknown');
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
    //M 新旧流水用相同事件名分组和取描述，函数行用跟踪点自带的描述。
    const name = TRAIL_EVENT_NAMES.get(line.name) ?? line.name;
    let text = getEventText(line, name);
    if (line.kind === '函数') {
      text = line.text;
    }
    const row: TrailRow = {
      t: line.at - start,
      gap,
      kind: line.kind,
      name,
      text,
      params: traceText.getTraceParams(text, line.vars),
      listeners: line.listeners.filter((name) => !PASSIVE.has(name)),
      site: line.site,
      facts: line.facts ?? getFacts(line.vars, name),
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
    steps.push({
      no: steps.length + 1, node, title: '', t: row.t, ms: 0, error, notified: [], rows: [row], docs: [...docs],
    });
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
    step.title = traceText.getTraceStepTitle(step.rows, (text, params) => traceText.getTraceText('zh', text, params));

    //M 收到通知但这一轮里自己没留下跟踪点的插件，单列出来。
    const heard = new Set(step.rows.flatMap((row) => row.listeners));
    step.notified = [...heard].filter((name) => !acted.has(name));
  });
  return { steps, start, end };
}


/**
 * 一条请求的轨迹：挑出属于它的行，收成一步一步。只要轨迹的用它；还要挑中的行的用 getPickedTrail。
 * @param message 消息号。
 * @param lines 从 web-api/received 那行起、按号从小到大（行数由请求的 maxLines 限定）。
 */
export function getTrail(message: number, lines: TrailLine[]): Trail {
  return getPickedTrail(message, lines).trail;
}


/**
 * 一条请求的轨迹，连同挑中的行一起交回：journal/request 的 trail 两样都要（tutorial 拿挑中的行对快照），只挑一遍。
 * @param message 消息号。
 * @param lines 从 web-api/received 那行起、按号从小到大（行数由请求的 maxLines 限定）。
 * @returns trail 是收好的轨迹，picked 是 pick 挑中的行。
 */
export function getPickedTrail(message: number, lines: TrailLine[]): { trail: Trail; picked: TrailLine[] } {
  //M 先按消息号与所属会话筛出请求起止范围内的轨迹行。
  const { picked, session, state } = pick(message, lines);
  //M 再把连续落在同一道上的跟踪行归并成一步一步。
  const { steps, start, end } = getSteps(picked);

  //M 机器人、渠道、用户那句话：各找第一行带着的。
  const botLine = picked.find((line) => typeof (line.vars['bot'] ?? line.vars['机器人']) === 'string');
  const channelLine = picked.find((line) => typeof (line.vars['channel'] ?? line.vars['渠道']) === 'string');
  const userLine = picked.find((line) => {
    const role = line.vars['role'] ?? line.vars['角色'];
    const content = line.vars['content'] ?? line.vars['说了'];
    return role === 'user' && typeof content === 'string';
  });
  const preview = String(userLine?.vars['content'] ?? userLine?.vars['说了'] ?? '').trim();

  const anyError = steps.some((step) => step.error);
  const trail: Trail = {
    message,
    session,
    bot: String(botLine?.vars['bot'] ?? botLine?.vars['机器人'] ?? ''),
    channel: String(channelLine?.vars['channel'] ?? channelLine?.vars['渠道'] ?? ''),
    preview,
    at: start,
    ms: end - start,
    state,
    error: anyError || state === 'failed',
    steps,
    notes: { ...ROW_NOTES, ...FACT_NOTES },
  };
  return { trail, picked };
}


/**
 * 这次启动的轨迹：tutorial/Boot.ts 交来的行收成一步一步，和请求轨迹同一个格式。
 * 消息号写 0（页面按它认出是启动），渠道写“启动”。
 * @param lines tutorial/Boot.ts 的 getLines()。
 * @param notes tutorial/Boot.ts 的关键变量说明表（BootTrail.notes）。
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


