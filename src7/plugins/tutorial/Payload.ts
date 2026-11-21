/**
 * 事件参数载荷采集（tutorial 1.2.3）：零改骨架，监听 Cordis 已有的 internal/dispatch，
 * 按 15 个核心事件白名单在发出刻深拷贝 before 并留住活引用，同会话下一事件到来或本轮结束时补拷 after，
 * 逐路径算出 add / change / remove（最多 500 条）与顶层 same 透传键，原子落盘 data/flow/<消息号>.payload.json。
 * 两个模型关口的顶层数组（system、tools、messages）按引用比：发出时只留浅拷，补拷时只深拷变了的那几条。
 * “这个事件属于哪条消息”不在这里猜：用 utils/Trace.ts 的 buildDispatchLine 认出的那一份（和 journal 同一份）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as filesModule from '../../utils/Files.ts';
import * as utils from '../../utils/index.ts';
import * as textModule from '../../utils/Text.ts';
import * as traceUtils from '../../utils/Trace.ts';
import { PASSIVE } from '../../utils/Trail.ts';
import type { Trail } from '../../utils/Trail.ts';
import type * as filesPluginModule from './Files.ts';
import * as walkModule from './Walk.ts';

export { computePayloadDiff, type PayloadDiff } from './Walk.ts';
import type { PayloadDiff } from './Walk.ts';


//==========================================================
//M 对外 JSON 契约类型（见同目录 说明.md）
//==========================================================


/** 一个事件参数对象，在这一步的前后两份。 */
export interface PayloadItem {
  /** 本消息内从 1 开始的序号。 */
  seq: number;
  /** 发出时刻，毫秒。 */
  at: number;
  /** 对应 trail.steps[].no：按 traceSeq 对上轨迹那一行所在的步；对不上是 0。 */
  step: number;
  /** utils/Trace.ts 发的号，和 journal 那一行的 seq 是同一个；改版前录的旧载荷没有。 */
  traceSeq?: number;
  /** 事件名，如 session/before-model。 */
  event: string;
  /** 参数对象的类型名，按事件名查表，如 ChatRequest。 */
  object: string;
  /** 发出位置“文件:行号”，取自对应 journal 行的 site。 */
  site: string;
  /** 听这个事件的插件，取自 dispatch 时的监听者。 */
  listeners: string[];
  /** dispatch 那一刻的深拷贝。 */
  before: unknown;
  /** 同一会话下一个被记录的事件发出时（或一轮结束时）再拷一次；没取到为 null。 */
  after: unknown | null;
  /** before 和 after 的逐路径对比。 */
  diff: PayloadDiff[];
  /** 拷贝时撞了单份上限：before、after 只保留到上限，diff 照常算到能算的部分。 */
  truncated: boolean;
}


/** 整条消息的载荷。 */
export interface PayloadTrail {
  /** 查询成功标记。 */
  ok: true;
  /** 消息号，同 canvas 的 name。 */
  message: string;
  /** 为什么没有或不全（没录、被挤掉、超上限）；完整录到时为空字符串。 */
  note: string;
  /** 事件参数载荷列表。 */
  items: PayloadItem[];
}


/** 录制模式：all 每条消息都录，keyword 只录带快照关键词的。 */
export type PayloadRecordMode = 'all' | 'keyword';


/** PayloadRecorder 校验后的配置。 */
export interface PayloadSettings {
  /** 录制模式。 */
  recordMode: PayloadRecordMode;
  /** 快照关键词（keyword 模式用）。 */
  keyword: string;
  /** 单份拷贝序列化后的字节上限（默认 256KB）。 */
  maxItemBytes: number;
  /** 单条消息总字节上限（默认 8MB）。 */
  maxMessageBytes: number;
  /** 内存与磁盘保留最近几条消息（默认 20）。 */
  maxMessages: number;
  /** 配置里额外追加的白名单事件名。 */
  extraEvents: string[];
}


//==========================================================
//M 常量表：15 个默认白名单事件、类型名映射与脱敏规则
//==========================================================

/** 设计文档 3.2 规定的 15 个默认记录事件。 */
export const DEFAULT_PAYLOAD_EVENTS: readonly string[] = [
  'channel/direct',
  'channel/mention',
  'channel/listen',
  'bot/receive',
  'session/new-message',
  'session/before-model',
  'session/after-model',
  'session/model-failed',
  'session/before-tool',
  'session/after-tool',
  'session/change',
  'channel/reply',
  'channel/replied',
  'bot/settled',
  'web-api/replied',
];

/** 渠道入站三事件：参数是 (ChannelMessage, control)，合成 { message, control }。 */
const CHANNEL_INBOUND_EVENTS = new Set([
  'channel/direct',
  'channel/mention',
  'channel/listen',
]);

/** 事件名 → 参数对象的 TypeScript 类型名。 */
const EVENT_OBJECT_NAMES: Record<string, string> = {
  'channel/direct': 'ChannelMessage',
  'channel/mention': 'ChannelMessage',
  'channel/listen': 'ChannelMessage',
  'bot/receive': 'ReceiveEvent',
  'session/new-message': 'Message',
  'session/before-model': 'ChatRequest',
  'session/after-model': 'AnsweredRequest',
  'session/model-failed': 'ModelFailed',
  'session/before-tool': 'ToolGate',
  'session/after-tool': 'ToolDone',
  'session/change': 'Session',
  'channel/reply': 'ChannelReplyRequest',
  'channel/replied': 'ChannelRepliedEvent',
  'bot/settled': 'ChannelSettledEvent',
  'web-api/replied': 'WebApiReplied',
};

/** 两个模型关口：顶层数组按引用比，只深拷变了的那几条（云端 31 第 3 条）。 */
const MODEL_GATE_EVENTS = new Set(['session/before-model', 'session/after-model']);

/** 模型关口参数里按引用比的顶层数组（每步都带整段历史和工具定义，最占地方）。 */
const GATE_ARRAY_KEYS: readonly string[] = ['system', 'tools', 'messages'];

/** 磁盘上的消息载荷文件名：<消息号>.payload.json。 */
const PAYLOAD_FILE = /^(\d+)\.payload\.json$/u;

/** 尚未绑定收件号但刚收到 web-api/received 的短时间配对窗口，毫秒。 */
const PENDING_RECEIVE_MS = 10_000;


/** 深拷贝结果（同 Walk.ts 的 Walked）。 */
export type ClonedPayload = walkModule.Walked;


/**
 * 深拷贝一份事件载荷并计算序列化字节数与截断标记（共用 Walk.ts 的流式遍历与脱敏规则）。
 * @param value 原始事件参数对象。
 * @param maxBytes 单份允许的最大字节数（payload_item_kb 换算）。
 */
export function clonePayload(value: unknown, maxBytes: number): ClonedPayload {
  //M 载荷要省地方：单份有上限，凭据、图片、嵌套会话都省略。
  const rule: walkModule.WalkRule = {
    limit: maxBytes,
    slim: true,
  };
  return walkModule.walk(value, rule);
}


//==========================================================
//M 模型关口按引用比：顶层数组发出时只留浅拷，补拷 after 时只深拷变了的那几条（云端 31 第 3 条）
//==========================================================

/** 补拷 after 的结果：普通事件 before 原样；模型关口的 before 补上了删掉、换掉的旧条目。 */
interface AfterCopy {
  /** 这一条的 before（模型关口补过旧条目的那份）。 */
  before: unknown;
  /** 这一条的 after。 */
  after: unknown;
  /** 这次补拷新占的字节数（记进单条消息的总量）。 */
  bytes: number;
  /** 这次补拷撞没撞单份上限。 */
  truncated: boolean;
  /** before 和 after 的逐路径对比。 */
  diff: PayloadDiff[];
}


/** 一个顶层数组前后按引用比的结果。 */
interface RefChanges {
  /** 新数组里新加、换上的条目下标：旧数组里没有这个引用（字符串按值）。 */
  added: number[];
  /** 旧数组里删掉、换掉的条目下标：新数组里没有这个引用。 */
  removed: number[];
  /** 换掉的下标：同一下标一删一加，而且前面删的和加的条数一样多（前面一一对齐），算“改了这一条”，往里逐路径比。 */
  paired: Set<number>;
  /** 前后条数一样。 */
  sameLength: boolean;
}


/**
 * 留下模型关口参数顶层数组的浅拷：只拷每条的引用，几乎不占地方。
 * 监听者整个换数组、往后 push、map 出新数组，都改不到这份浅拷；补拷 after 时拿它逐条比。
 * @param target 事件参数（ChatRequest 或 AnsweredRequest）。
 * @returns 数组键 → 这一刻的浅拷；不是数组的键不留。
 */
function takeGateRefs(target: unknown): Record<string, unknown[]> {
  const record = utils.getOptionalRecord(target);
  const refs: Record<string, unknown[]> = {};
  for (const key of GATE_ARRAY_KEYS) {
    const list = record?.[key];
    if (Array.isArray(list)) {
      refs[key] = [...list];
    }
  }
  return refs;
}


/**
 * 把模型关口参数拼成要深拷的样子：别的字段照原样（还是引用），顶层数组写成 { count, 下标: 条目 }。
 * @param record 事件参数。
 * @param lists 顶层数组（takeGateRefs 留的浅拷）。
 * @param picks 每个顶层数组要带上的条目下标；不给就只记条数。
 * @returns 交给 clonePayload 的对象。
 */
function shapeGateFrame(
  record: Record<string, unknown>,
  lists: Record<string, unknown[]>,
  picks: Record<string, number[]> | undefined,
): Record<string, unknown> {
  const shaped: Record<string, unknown> = {};

  //M 小字段在前：answer、stop、model 这些先拷，单份撞上限时不会被长历史挤掉。
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    if (Object.hasOwn(lists, key)) continue;

    shaped[key] = walkModule.getOwnDataValue(record, key);
  }

  //M 顶层数组在后：只记条数，再带上点到的那几条。
  for (const key of GATE_ARRAY_KEYS) {
    const list = lists[key];
    if (list === undefined) continue;

    const summary: Record<string, unknown> = { count: list.length };
    const indexes = picks?.[key] ?? [];
    for (const index of indexes) {
      summary[String(index)] = list[index];
    }
    shaped[key] = summary;
  }
  return shaped;
}


/**
 * 一个顶层数组前后逐条按引用比：两边都有的引用不管挪没挪位置都算没变，只挑出真新加的、真删掉的。
 * @param older 发出时的浅拷。
 * @param newer 现在的数组。
 */
function getRefChanges(older: unknown[], newer: unknown[]): RefChanges {
  const olderSet = new Set(older);
  const newerSet = new Set(newer);

  const added: number[] = [];
  for (let index = 0; index < newer.length; index += 1) {
    if (!olderSet.has(newer[index])) {
      added.push(index);
    }
  }

  const removed: number[] = [];
  for (let index = 0; index < older.length; index += 1) {
    if (!newerSet.has(older[index])) {
      removed.push(index);
    }
  }

  //M 换掉的：同一下标一删一加，而且排在它前面删掉的条数和新加的条数一样多（两边前面一一对齐）。
  //M   context-fit 把开头 61 条换成 1 条摘要时，后面挪了位置的条目不会被错配成“改了”。
  const paired = new Set<number>();
  let cursor = 0;
  for (let order = 0; order < added.length; order += 1) {
    const index = added[order] ?? -1;
    while (cursor < removed.length && (removed[cursor] ?? index) < index) {
      cursor += 1;
    }
    const sameIndex = removed[cursor] === index;
    const alignedBefore = cursor === order;
    if (sameIndex && alignedBefore) {
      paired.add(index);
    }
  }
  return { added, removed, paired, sameLength: older.length === newer.length };
}


/**
 * 去掉顶层数组，只留小字段：小字段照常逐路径比。
 * @param value before 或 after 的拷贝。
 */
function omitGateKeys(value: unknown): unknown {
  const record = utils.getOptionalRecord(value);
  if (record === undefined) return value;

  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (GATE_ARRAY_KEYS.includes(key)) continue;

    rest[key] = record[key];
  }
  return rest;
}


/**
 * 把补拷的旧条目并进发出时的 before：before 的顶层数组原来只记了条数。
 * @param before 发出时的拷贝。
 * @param extra 旧条目的拷贝（shapeGateFrame 拼、clonePayload 拷）。
 * @returns 新的 before，不改原来那份（教程页现拍时还要用原来的）。
 */
function mergeGateFrame(before: unknown, extra: unknown): unknown {
  const base = utils.getOptionalRecord(before);
  const more = utils.getOptionalRecord(extra);
  if (base === undefined || more === undefined) return before;

  const merged: Record<string, unknown> = { ...base };
  for (const key of GATE_ARRAY_KEYS) {
    const baseList = utils.getOptionalRecord(base[key]);
    const moreList = utils.getOptionalRecord(more[key]);
    if (baseList === undefined || moreList === undefined) continue;

    merged[key] = { ...baseList, ...moreList };
  }
  return merged;
}


/**
 * 列出一个顶层数组的变化：新加的 add，删掉的 remove，换掉的（paired）往里逐路径比。
 * @param key 数组键，如 messages。
 * @param changes getRefChanges 比出来的结果。
 * @param beforeList before 里这个数组（{ count, 下标: 旧条目 }）。
 * @param afterList after 里这个数组（{ count, 下标: 新条目 }）。
 * @param out 累积变化列表（最多 DIFF_MAX 条）。
 */
function addRefDiff(
  key: string,
  changes: RefChanges,
  beforeList: Record<string, unknown> | undefined,
  afterList: Record<string, unknown> | undefined,
  out: PayloadDiff[],
): void {
  //M 新加、换上的：换掉的往里比，否则是新加。
  for (const index of changes.added) {
    if (out.length >= walkModule.DIFF_MAX) return;

    const slot = String(index);
    const itemPath = `${key}[${slot}]`;
    const newer = afterList?.[slot];
    if (changes.paired.has(index)) {
      walkModule.collectChanges(beforeList?.[slot], newer, itemPath, out);
      continue;
    }
    const after = traceUtils.formatTraceValue(newer, walkModule.PREVIEW_CHARS);
    out.push({ path: itemPath, kind: 'add', after });
  }

  //M 删掉、换掉的：上面已经当“改了”比过的跳过。
  for (const index of changes.removed) {
    if (out.length >= walkModule.DIFF_MAX) return;
    if (changes.paired.has(index)) continue;

    const slot = String(index);
    const before = traceUtils.formatTraceValue(beforeList?.[slot], walkModule.PREVIEW_CHARS);
    out.push({ path: `${key}[${slot}]`, kind: 'remove', before });
  }
}


/**
 * 模型关口的差异：小字段逐路径比，顶层数组按引用比的结果逐条列；same 放最后。
 * @param before 补过旧条目的 before。
 * @param after 补拷的 after。
 * @param changes 每个顶层数组按引用比的结果。
 */
function computeGateDiff(before: unknown, after: unknown, changes: Record<string, RefChanges>): PayloadDiff[] {
  const small = walkModule.computePayloadDiff(omitGateKeys(before), omitGateKeys(after));
  const diffs = small.filter((row) => row.kind !== 'same');
  const sames = small.filter((row) => row.kind === 'same');
  const beforeRec = utils.getOptionalRecord(before);
  const afterRec = utils.getOptionalRecord(after);

  for (const key of GATE_ARRAY_KEYS) {
    const found = changes[key];
    if (found === undefined) continue;

    const beforeList = utils.getOptionalRecord(beforeRec?.[key]);
    const afterList = utils.getOptionalRecord(afterRec?.[key]);
    addRefDiff(key, found, beforeList, afterList, diffs);

    //M 一条没变的数组也标 same：读的人知道它原样透传。
    const untouched = found.added.length === 0 && found.removed.length === 0 && found.sameLength;
    if (untouched) {
      const preview = `${String(afterList?.['count'])} 条`;
      sames.push({ path: key, kind: 'same', before: preview, after: preview });
    }
  }
  return [...diffs, ...sames];
}


/**
 * 拷事件发出时的 before。模型关口：小字段深拷，顶层数组只记条数，另外留一份浅拷给补拷 after 用。
 * @param event 事件名。
 * @param target 事件参数（buildTargetRef 取的）。
 * @param maxBytes 单份上限。
 * @returns 拷贝；refs 是模型关口顶层数组的浅拷，别的事件是 undefined。
 */
function cloneBefore(
  event: string,
  target: unknown,
  maxBytes: number,
): { cloned: ClonedPayload; refs: Record<string, unknown[]> | undefined } {
  //M 别的事件整份深拷。
  if (!MODEL_GATE_EVENTS.has(event)) {
    const whole = clonePayload(target, maxBytes);
    return { cloned: whole, refs: undefined };
  }

  //M 模型关口：顶层数组只记条数，浅拷留着补拷时逐条比。
  const record = utils.getOptionalRecord(target) ?? {};
  const refs = takeGateRefs(target);
  const shaped = shapeGateFrame(record, refs, undefined);
  const cloned = clonePayload(shaped, maxBytes);
  return { cloned, refs };
}


/**
 * 补拷模型关口的 after：顶层数组逐条按引用比，只深拷新加、换上的那几条，before 只补删掉、换掉的旧条目。
 * 长会话每步不再深拷 4 份整段历史，最新几条和 answer 不会被 256KB 单份上限截掉。
 * 前提：监听者不原地改单条消息（核过：context-fit、bots、file-tools、progress 都是换数组、push 或换新对象）。
 * @param before 发出时的拷贝（cloneGateBefore 拷的）。
 * @param older 发出时顶层数组的浅拷。
 * @param target 事件参数的活引用。
 * @param maxBytes 单份上限：after、旧条目各按这个上限拷。
 */
function cloneGateAfter(
  before: unknown,
  older: Record<string, unknown[]>,
  target: unknown,
  maxBytes: number,
): AfterCopy {
  const record = utils.getOptionalRecord(target) ?? {};
  const newer = takeGateRefs(target);

  //M 1. 逐个顶层数组按引用比：哪几条是新加、换上的，哪几条是删掉、换掉的。
  const changes: Record<string, RefChanges> = {};
  const addedPicks: Record<string, number[]> = {};
  const removedPicks: Record<string, number[]> = {};
  for (const key of Object.keys(newer)) {
    const olderList = older[key] ?? [];
    const newerList = newer[key] ?? [];
    const found = getRefChanges(olderList, newerList);
    changes[key] = found;
    addedPicks[key] = found.added;
    removedPicks[key] = found.removed;
  }

  //M 2. after：小字段照常深拷，顶层数组只深拷新加、换上的那几条。
  const afterShaped = shapeGateFrame(record, newer, addedPicks);
  const afterClone = clonePayload(afterShaped, maxBytes);

  //M 3. before：发出时顶层数组只记了条数，这里补拷删掉、换掉的旧条目（没人原地改，现在拷和发出时一样）。
  const removedShaped = shapeGateFrame({}, older, removedPicks);
  const removedClone = clonePayload(removedShaped, maxBytes);
  const fullBefore = mergeGateFrame(before, removedClone.value);

  //M 4. 差异：小字段逐路径比，顶层数组按引用比的结果逐条列。
  const diff = computeGateDiff(fullBefore, afterClone.value, changes);
  return {
    before: fullBefore,
    after: afterClone.value,
    bytes: afterClone.bytes + removedClone.bytes,
    truncated: afterClone.truncated || removedClone.truncated,
    diff,
  };
}


//==========================================================
//M 按 utils/Trace.ts 发的号对上轨迹的事件行，取 step 与 site
//==========================================================

/**
 * 将录到的 PayloadItem 列表对齐到 journal 轨迹的步骤号与事件行源码位置：按 utils/Trace.ts 发的号取，不对时刻。
 * @param items 原始载荷列表。
 * @param trail 对应消息的轨迹；未挂 journal 或查不到时为 undefined。
 * @returns 对上的带步号和 journal 记的 site；改版前没有号的旧载荷、旧轨迹原样交回（step 照旧），不再猜。
 */
export function assignTrailSteps(items: PayloadItem[], trail: Trail | undefined): PayloadItem[] {
  if (trail === undefined || trail.steps.length === 0) return items;

  //M 轨迹里带号的事件行按号建表：号 → 步号和 journal 记的位置。
  const bySeq = new Map<number, { stepNo: number; site: string }>();
  for (const step of trail.steps) {
    for (const row of step.rows) {
      if (row.kind !== '事件') continue;
      if (row.seq === undefined) continue;

      bySeq.set(row.seq, { stepNo: step.no, site: row.site });
    }
  }

  return items.map((item) => {
    //G 没有号的旧载荷、号不在这条轨迹里的：原样交回。
    if (item.traceSeq === undefined) return item;

    const row = bySeq.get(item.traceSeq);
    if (row === undefined) return item;

    //M 对上了：步号取轨迹的；journal 记下了位置就用它。
    let site = item.site;
    if (row.site !== '' && row.site !== '位置不明') {
      site = row.site;
    }
    return { ...item, step: row.stepNo, site };
  });
}


//==========================================================
//M 运行时录制器 PayloadRecorder：监听、活引用补拷、内存淘汰与原子落盘
//==========================================================

/** 单条已录事件在内存中的跟踪项（收尾前保留活引用）。 */
interface RecordedEntry {
  /** 对外返回的载荷项。 */
  item: PayloadItem;
  /** 事件所属会话号；渠道入站尚未分会话时为 null。 */
  sessionId: string | null;
  /** 是否为渠道入站外层串行事件（等进会话或本轮结束再补拷 after，确保拿到认领结果 claims）。 */
  outerChannel: boolean;
  /** 事件参数的活引用；补拷完 after 后立即置 undefined 释放内存。 */
  liveRef: unknown;
  /** 模型关口发出时顶层数组的浅拷（每条的引用），补拷 after 时逐条按引用比；别的事件、补拷完是 undefined。 */
  gateRefs: Record<string, unknown[]> | undefined;
  /** 是否已完成 after 补拷。 */
  settled: boolean;
}


/** 单条消息在内存中的载荷桶。 */
interface PayloadBucket {
  /** 桶内部唯一键。 */
  key: string;
  /** 收件表数字消息号（web_messages.id）；渠道刚收到尚未插入收件表时为 null。 */
  messageId: number | null;
  /** 标准渠道消息号（如 ["feishu","app","om_x"] 或 ["http","local","42"]）。 */
  sourceId: string | null;
  /** 目标机器人名。 */
  bot: string;
  /** 关联的会话号集合（含子会话）。 */
  sessions: Set<string>;
  /** 按发出先后排列的事件载荷项。 */
  entries: RecordedEntry[];
  /** 已累计拷贝的字节数。 */
  bytes: number;
  /** 是否已撞单条消息字节上限。 */
  capped: boolean;
  /** 给前端显示的说明（超上限等原因；正常完整录制为空串）。 */
  note: string;
  /** 该消息是否命中录制条件（all 模式恒为 true，keyword 模式带关键词才为 true）。 */
  wanted: boolean;
  /** 最近一次更新时刻，毫秒。 */
  updatedAt: number;
  /** 是否已有挂起中的写盘定时器（合并同一轮收尾连续触发的多次写盘请求）。 */
  writeScheduled: boolean;
}


/**
 * 从事件参数里提取目标拷贝对象（渠道三事件合成 { message, control }，双参会话事件保留第二参，其余取 args[0]）。
 * @param event 事件名。
 * @param args dispatch 原始参数列表。
 */
function buildTargetRef(event: string, args: unknown[]): unknown {
  if (CHANNEL_INBOUND_EVENTS.has(event)) {
    return { message: args[0], control: args[1] };
  }
  if (event === 'session/new-message' && args.length >= 2) {
    return { session: args[0], message: args[1] };
  }
  if (event === 'session/change' && args.length >= 2 && args[1] !== undefined) {
    return { session: args[0], stateBefore: args[1] };
  }
  return args[0];
}


/** 负责采集、配对、缓存与落盘每条消息真实事件载荷的控制器。 */
export class PayloadRecorder {
  /** 载荷文件目录：<运行时目录>/data/flow/。 */
  readonly dir: string;

  /** 允许录制的事件白名单。 */
  private readonly whitelist: Set<string>;

  /** 内存中按先后保留的桶列表（最多 maxMessages 个）。 */
  private readonly buckets: PayloadBucket[] = [];

  /** 数字消息号 → 桶。 */
  private readonly byMessage = new Map<number, PayloadBucket>();

  /** 标准消息号（或 标准消息号 + 机器人）→ 桶。 */
  private readonly bySource = new Map<string, PayloadBucket>();

  /** 会话号 → 桶。 */
  private readonly bySession = new Map<string, PayloadBucket>();

  /** channel/reply 的 requestId → 桶（供紧随其后的 channel/replied 配对）。 */
  private readonly byReplyId = new Map<string, PayloadBucket>();

  /** keyword 模式下命中关键词的会话集合（支持 ctx.flow.mark 显式标记）。 */
  private readonly markedSessions = new Set<string>();

  /** 刚收到 web-api/received、等待首个尚未绑定收件号的会话事件接入的桶（兼容假 ctx 直发测试）。 */
  private recentUnbound: { bucket: PayloadBucket; at: number } | undefined;

  /** 桶内部自增序号。 */
  private nextBucketSeq = 1;

  /** 最近一次读过的磁盘载荷文件缓存。 */
  private cachedFile: { name: string; mtime: number; trail: PayloadTrail } | undefined;

  /** 串行化落盘与旧文件清理队列，防止并发读写删除冲突。 */
  private writeQueue: Promise<void> = Promise.resolve();

  /**
   * 挂载 internal/dispatch、bot/receive（prepend 认关键词）与 trace（桥接收件号与会话号）监听。
   * @param ctx tutorial 的 ctx。
   * @param settings apply 校验过的载荷配置。
   * @param files 共用 FlowFiles 查询 journal 轨迹以对齐 step。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly settings: PayloadSettings,
    private readonly files: filesPluginModule.FlowFiles,
  ) {
    this.dir = path.join(ctx.resources.root, 'data', 'flow');
    this.whitelist = new Set([...DEFAULT_PAYLOAD_EVENTS, ...settings.extraEvents]);

    //M prepend 监听 bot/receive：在 State.ts 剥掉关键词之前或同时记住 keyword 命中。
    this.ctx.on('bot/receive', (event) => {
      if (!this.hasKeyword(event.message.text)) return;

      const src = traceUtils.getSourceId(event.message.sourceId);
      if (src !== undefined) {
        const found = this.findBySource(src, event.message.bot);
        if (found !== undefined) {
          found.wanted = true;
        }
      }
      if (event.session !== undefined) {
        this.markedSessions.add(event.session.id);
      }
    }, true);

    //M 监听 Timeline.insert / Timeline.bindSession 跟踪点，第一时间把标准消息号、会话号桥接到数字收件号。
    traceUtils.onTrace(this.ctx, 'tutorial.payload', (where, _text, _code, vars) => {
      if (where !== 'Timeline.insert' && where !== 'Timeline.bindSession') return;

      const msgId = traceUtils.getPositiveInt(vars, 'messageId');
      if (msgId === undefined) return;

      const srcId = traceUtils.getSourceId(vars['sourceId']);
      let sesId: string | undefined;
      if (typeof vars['session'] === 'string' && vars['session'] !== '') {
        sesId = vars['session'];
      }
      let botName: string | undefined;
      if (typeof vars['bot'] === 'string') {
        botName = vars['bot'];
      }
      this.bridgeIdentifiers(msgId, srcId, sesId, botName);
    });

    //M 核心监听：Cordis 同步发完 internal/dispatch 才调各插件监听，此刻拷 before 并留活引用。
    //M   跟踪点、Cordis 内部的事件 onDispatch 已滤掉；录载荷出错只记日志，不拦业务事件。
    traceUtils.onDispatch(this.ctx, 'tutorial.payload', (line, args) => {
      if (line.name === 'web-api/received') {
        this.onWebReceived(args[0]);
        return;
      }
      if (!this.whitelist.has(line.name)) return;

      this.onWhitelistedDispatch(line, args);
    });
  }

  /**
   * 供 ctx.flow.mark 联动：web-api 接着已有会话发带关键词的消息时，同步标记该会话需要录载荷。
   * @param sessionId 会话号。
   */
  markSession(sessionId: string): void {
    this.markedSessions.add(sessionId);
    const bucket = this.bySession.get(sessionId);
    if (bucket !== undefined) {
      bucket.wanted = true;
    }
  }

  /**
   * 未录到载荷时返回给前端 note 字段的原因说明。
   */
  getMissingNote(): string {
    const keep = String(this.settings.maxMessages);
    if (this.settings.recordMode === 'keyword') {
      return `当前配置只录带 ${this.settings.keyword} 的消息，或已被新消息挤掉（最多留最近 ${keep} 条）`;
    }
    return `旧消息未录制，或已被新消息挤掉（最多留最近 ${keep} 条）`;
  }

  /**
   * 按消息号读取整条消息的载荷（优先读内存最新状态，其次读磁盘 .payload.json），并按轨迹对齐 step 与 site。
   * @param name 消息号字符串（调用方已排除 boot 并校验过纯数字）。
   * @param trail 对应消息的轨迹（按号对齐 step）。
   */
  async getPayload(name: string, trail: Trail | undefined): Promise<PayloadTrail> {
    const messageId = Number.parseInt(name, 10);
    let liveBucket = this.byMessage.get(messageId);
    if (liveBucket === undefined && trail?.session !== null && trail?.session !== undefined) {
      const candidate = this.findBySession(trail.session);
      const matchId = candidate?.messageId === null || candidate?.messageId === messageId;
      if (candidate !== undefined && matchId) {
        liveBucket = candidate;
      }
    }
    if (liveBucket !== undefined && liveBucket.wanted && liveBucket.entries.length > 0) {
      return this.buildTrailFromBucket(name, liveBucket, trail);
    }

    const fromDisk = await this.readDiskFile(name);
    if (fromDisk !== undefined) {
      const aligned = assignTrailSteps(fromDisk.items, trail);
      return { ...fromDisk, items: aligned };
    }

    if (liveBucket !== undefined && liveBucket.note !== '') {
      return { ok: true, message: name, note: liveBucket.note, items: [] };
    }
    return { ok: true, message: name, note: this.getMissingNote(), items: [] };
  }

  /**
   * 按会话号读取当前内存中的载荷桶（供离线假 ctx 单元测试直接按会话断言前后拷贝与 diff）。
   * @param sessionId 会话号。
   * @param trail 可选轨迹，提供时一并对齐 step。
   */
  getBySession(sessionId: string, trail?: Trail): PayloadTrail {
    const bucket = this.findBySession(sessionId);
    if (bucket === undefined || !bucket.wanted || bucket.entries.length === 0) {
      return { ok: true, message: sessionId, note: this.getMissingNote(), items: [] };
    }
    let label = sessionId;
    if (bucket.messageId !== null) {
      label = String(bucket.messageId);
    }
    return this.buildTrailFromBucket(label, bucket, trail);
  }

  //==========================================================
  //M 内部事件关联、前后补拷与收尾写盘
  //==========================================================

  /** 判断文本是否带快照关键词。 */
  private hasKeyword(text: unknown): boolean {
    return typeof text === 'string' && text.includes(this.settings.keyword);
  }

  /**
   * 处理 web-api/received：建立或绑定数字消息号桶，供后续渠道/会话事件挂入。
   * @param payload Timeline.insert 发出的收件行摘要。
   */
  private onWebReceived(payload: unknown): void {
    const rec = utils.getOptionalRecord(payload);
    const id = traceUtils.getPositiveInt(rec, 'id');
    if (id === undefined) return;

    let bot = '';
    if (typeof rec?.['bot'] === 'string') {
      bot = rec['bot'];
    }
    const text = rec?.['text'];
    const wanted = this.settings.recordMode === 'all' || this.hasKeyword(text);
    let bucket = this.byMessage.get(id);
    if (bucket === undefined) {
      bucket = this.createBucket({ messageId: id, sourceId: null, bot, wanted });
    }
    if (wanted) {
      bucket.wanted = true;
    }
    this.recentUnbound = { bucket, at: Date.now() };
  }

  /**
   * 将 Timeline.insert / bindSession 暴露的收件号、标准消息号、会话号桥接到同一个桶。
   */
  private bridgeIdentifiers(
    messageId: number,
    sourceId: string | undefined,
    sessionId: string | undefined,
    bot: string | undefined,
  ): void {
    let bucket = this.byMessage.get(messageId);
    if (bucket === undefined && sourceId !== undefined) {
      bucket = this.findBySource(sourceId, bot);
    }
    if (bucket === undefined && sessionId !== undefined) {
      bucket = this.findBySession(sessionId);
    }
    if (bucket === undefined) {
      const wanted = this.settings.recordMode === 'all'
        || (sessionId !== undefined && this.markedSessions.has(sessionId));
      bucket = this.createBucket({
        messageId,
        sourceId: sourceId ?? null,
        bot: bot ?? '',
        wanted,
      });
    }
    this.bindBucket(bucket, messageId, sourceId, sessionId, bot);
  }

  /**
   * 处理命中的 15 类白名单事件：定位桶 → 先补拷同会话前序事件 after → 拷本次 before 并留住活引用 → 判断本轮收尾。
   * 会话号、消息号、回复请求号、会话状态都用共用事件行 line 里认出的（utils/Trace.ts 的 buildDispatchLine）。
   */
  private onWhitelistedDispatch(line: traceUtils.SharedLine, args: unknown[]): void {
    const event = line.name;
    const bucket = this.resolveOrCreateBucket(line, args);
    if (bucket === null || !bucket.wanted) return;

    bucket.updatedAt = Date.now();

    //M 1. 同桶前序事件补拷 after：
    //M    - 进入会话事件时，先前未结算的 bot/receive 与同会话上一事件已完成监听修改，立即补拷；
    //M    - 进到模型关口或收尾事件时，外层 channel/* 认领 claims 也已填齐，一并补拷；
    //M    - channel/replied 到来时，补拷对应的 channel/reply（handled 已置 true）。
    this.settlePreviousEntries(bucket, event, line.session ?? null);

    //M 2. 若本消息已超单消息字节上限，不再录新事件。
    if (bucket.capped) {
      this.checkRoundEnd(bucket, event, line.sessionState);
      return;
    }

    //M 3. 深拷贝当前事件的 before，检查单消息 8MB 预算（模型关口的顶层数组只记条数、留浅拷）。
    const targetRef = buildTargetRef(event, args);
    const taken = cloneBefore(event, targetRef, this.settings.maxItemBytes);
    const beforeClone = taken.cloned;
    const wouldExceed = bucket.bytes + beforeClone.bytes > this.settings.maxMessageBytes;
    if (wouldExceed && bucket.entries.length > 0) {
      bucket.capped = true;
      bucket.note = this.formatCapNote();
      this.checkRoundEnd(bucket, event, line.sessionState);
      return;
    }

    bucket.bytes += beforeClone.bytes;
    if (bucket.bytes > this.settings.maxMessageBytes) {
      bucket.capped = true;
      bucket.note = this.formatCapNote();
    }

    //M 只记账的插件（utils/Trail.ts 的 PASSIVE）和没名字的监听不算“经过”。
    const listeners = line.listeners.filter((plugin) => !PASSIVE.has(plugin) && plugin !== '');
    const objectName = EVENT_OBJECT_NAMES[event] ?? 'Object';
    const site = line.site;
    const item: PayloadItem = {
      seq: bucket.entries.length + 1,
      traceSeq: line.seq,
      at: Date.now(),
      step: 0,
      event,
      object: objectName,
      site,
      listeners,
      before: beforeClone.value,
      after: null,
      diff: [],
      truncated: beforeClone.truncated,
    };
    const entry: RecordedEntry = {
      item,
      sessionId: line.session ?? null,
      outerChannel: CHANNEL_INBOUND_EVENTS.has(event),
      liveRef: targetRef,
      gateRefs: taken.refs,
      settled: false,
    };
    bucket.entries.push(entry);

    //M 4. 检查这一轮是否收尾；收尾则在当前事件监听跑完后补齐剩余 after 并原子写盘。
    this.checkRoundEnd(bucket, event, line.sessionState);
  }

  /**
   * 根据事件类型推进桶内前序未结算条目的 after 补拷。
   */
  private settlePreviousEntries(bucket: PayloadBucket, incomingEvent: string, sessionId: string | null): void {
    for (const entry of bucket.entries) {
      if (entry.settled) continue;

      //G 渠道入站外层事件（channel/direct 等）内部嵌套发 bot/receive 时，claims 还没填，等进会话后再补拷。
      if (entry.outerChannel && incomingEvent === 'bot/receive') continue;

      if (entry.outerChannel) {
        const claimsReady = incomingEvent.startsWith('session/')
          || incomingEvent === 'channel/reply'
          || incomingEvent === 'bot/settled'
          || incomingEvent === 'web-api/replied';
        if (claimsReady) {
          this.finalizeEntry(bucket, entry);
        }
        continue;
      }

      //M bot/receive 在首个会话事件或回复事件到来时已完成认领与关键词剥离。
      if (entry.item.event === 'bot/receive' && incomingEvent !== 'bot/receive') {
        this.finalizeEntry(bucket, entry);
        continue;
      }

      //M channel/reply 在 channel/replied / bot/settled / web-api/replied 到来时已走完渠道响应器。
      if (entry.item.event === 'channel/reply' && incomingEvent !== 'channel/reply') {
        this.finalizeEntry(bucket, entry);
        continue;
      }

      //M 同一会话的下一个事件到来时，前一个同会话事件的 ctx.serial 已全部跑完，立即补拷 after。
      if (sessionId !== null && entry.sessionId === sessionId) {
        this.finalizeEntry(bucket, entry);
      }
    }
  }

  /**
   * 补拷单条记录的 after，计算 diff，并释放活引用防内存泄漏。
   */
  private finalizeEntry(bucket: PayloadBucket, entry: RecordedEntry): void {
    if (entry.settled) return;

    entry.settled = true;
    const ref = entry.liveRef;
    const gateRefs = entry.gateRefs;
    entry.liveRef = undefined;
    entry.gateRefs = undefined;
    if (ref === undefined) return;

    //G 若补拷前已严重超出消息总上限，after 留 null 并记明原因。
    if (bucket.bytes >= this.settings.maxMessageBytes && bucket.capped) {
      if (bucket.note === '') {
        bucket.note = this.formatCapNote();
      }
      return;
    }

    const copy = this.copyAfter(entry.item.before, gateRefs, ref);
    bucket.bytes += copy.bytes;
    if (bucket.bytes > this.settings.maxMessageBytes) {
      bucket.capped = true;
      bucket.note = this.formatCapNote();
    }
    entry.item.before = copy.before;
    entry.item.after = copy.after;
    entry.item.truncated = entry.item.truncated || copy.truncated;
    entry.item.diff = copy.diff;
  }

  /**
   * 补拷一条的 after 并算差异：模型关口按引用比（cloneGateAfter），别的事件整份深拷再逐路径比。
   * @param before 发出时的拷贝。
   * @param gateRefs 模型关口发出时顶层数组的浅拷；别的事件是 undefined。
   * @param ref 事件参数的活引用。
   */
  private copyAfter(before: unknown, gateRefs: Record<string, unknown[]> | undefined, ref: unknown): AfterCopy {
    const maxBytes = this.settings.maxItemBytes;
    if (gateRefs !== undefined) return cloneGateAfter(before, gateRefs, ref, maxBytes);

    const cloned = clonePayload(ref, maxBytes);
    const diff = walkModule.computePayloadDiff(before, cloned.value);
    return { before, after: cloned.value, bytes: cloned.bytes, truncated: cloned.truncated, diff };
  }

  /**
   * 结算桶内所有尚未补拷 after 的条目。
   */
  private finalizeAllEntries(bucket: PayloadBucket): void {
    for (const entry of bucket.entries) {
      this.finalizeEntry(bucket, entry);
    }
  }

  /**
   * 判断一轮是否结束（session/change 变为非 running、bot/settled，或非运行态会话的 web-api/replied），结束则排期补齐并写文件。
   */
  private checkRoundEnd(bucket: PayloadBucket, event: string, sessionState: string | undefined): void {
    const changeEnded = event === 'session/change' && sessionState !== undefined && sessionState !== 'running';
    const settledEnded = event === 'bot/settled';
    const repliedEnded = event === 'web-api/replied' && sessionState !== 'running';
    if (!changeEnded && !settledEnded && !repliedEnded) return;

    this.scheduleWrite(bucket);
  }

  /**
   * 推到当前事件循环之后补齐最后一条事件的 after（合并同轮连续收尾事件），串行落盘。
   */
  private scheduleWrite(bucket: PayloadBucket): void {
    if (bucket.writeScheduled) return;

    bucket.writeScheduled = true;
    setTimeout(() => {
      bucket.writeScheduled = false;
      this.finalizeAllEntries(bucket);
      if (bucket.messageId === null || bucket.entries.length === 0 || !bucket.wanted) return;

      const messageId = bucket.messageId;
      this.writeQueue = this.writeQueue
        .then(() => this.persistBucket(messageId, bucket))
        .catch((error: unknown) => {
          const reason = textModule.getErrorMessage(error);
          console.error(`tutorial 写 ${String(messageId)}.payload.json 没写成：${reason}`);
        });
    }, 0);
  }

  /**
   * 查询 journal 轨迹对齐 step 与 site，原子写出 <消息号>.payload.json 并清理超量旧文件。
   */
  private async persistBucket(messageId: number, bucket: PayloadBucket): Promise<void> {
    const got = await this.files.getMessageTrail(messageId, 800);
    //G 跟踪行里没有这条消息（如离线模拟测试未挂 journal）时不落盘，避免孤立载荷文件。
    if (got === undefined) return;

    const name = String(messageId);
    const payload = this.buildTrailFromBucket(name, bucket, got.trail);
    const full = path.join(this.dir, `${name}.payload.json`);
    filesModule.writeTextAtomic(full, JSON.stringify(payload), true);
    this.cachedFile = undefined;
    await this.pruneDiskFiles();
  }

  /**
   * 从内存桶组装一份 PayloadTrail；尚未结算的末尾事件用当前活引用现拍一份供即时查看，不提前清掉活引用。
   */
  private buildTrailFromBucket(name: string, bucket: PayloadBucket, trail: Trail | undefined): PayloadTrail {
    const rawItems: PayloadItem[] = bucket.entries.map((entry) => {
      if (entry.settled || entry.liveRef === undefined) {
        return { ...entry.item };
      }
      const live = this.copyAfter(entry.item.before, entry.gateRefs, entry.liveRef);
      return {
        ...entry.item,
        before: live.before,
        after: live.after,
        diff: live.diff,
        truncated: entry.item.truncated || live.truncated,
      };
    });
    const items = assignTrailSteps(rawItems, trail);
    return {
      ok: true,
      message: name,
      note: bucket.note,
      items,
    };
  }

  //==========================================================
  //M 桶查找、绑定、内存淘汰与磁盘文件轮转
  //==========================================================

  /**
   * 按共用事件行认出的线索查找已有桶，或在入站起点新建桶。
   * @param line 共用事件行：回复请求号、收件号、会话号、标准消息号、机器人都从它取。
   * @param args 事件参数（认快照关键词用）。
   */
  private resolveOrCreateBucket(line: traceUtils.SharedLine, args: unknown[]): PayloadBucket | null {
    const event = line.name;

    //M 1. 先按明确线索依次查：replyRequestId → 数字收件号 → 会话号（含父会话）→ 标准消息号。
    let bucket: PayloadBucket | undefined;
    if (line.replyRequestId !== undefined) {
      bucket = this.byReplyId.get(line.replyRequestId);
    }
    if (bucket === undefined && line.messageId !== undefined) {
      bucket = this.byMessage.get(line.messageId);
    }
    if (bucket === undefined && line.session !== undefined) {
      bucket = this.findBySession(line.session);
    }
    if (bucket === undefined && line.sourceId !== undefined) {
      bucket = this.findBySource(line.sourceId, line.bot);
    }

    //M 2. 兼容刚发过 web-api/received 但未走 Timeline.bindSession 的直发会话事件（与 Trail.pick 的 firstSession 一致）。
    if (bucket === undefined && line.session !== undefined && this.recentUnbound !== undefined) {
      const fresh = Date.now() - this.recentUnbound.at <= PENDING_RECEIVE_MS;
      if (fresh && this.recentUnbound.bucket.sessions.size === 0) {
        bucket = this.recentUnbound.bucket;
        this.recentUnbound = undefined;
      }
    }

    //M 3. 仍未找到时：渠道入站、bot/receive 或带明确消息号/已标会话的事件原地建桶。
    if (bucket === undefined) {
      const canStart = CHANNEL_INBOUND_EVENTS.has(event)
        || event === 'bot/receive'
        || line.messageId !== undefined
        || line.session !== undefined;
      if (!canStart) return null;

      const hasKw = this.detectEventKeyword(event, args, line.session);
      const wanted = this.settings.recordMode === 'all' || hasKw;
      bucket = this.createBucket({
        messageId: line.messageId ?? null,
        sourceId: line.sourceId ?? null,
        bot: line.bot ?? '',
        wanted,
      });
    }

    //M 4. 把本次新露面的线索绑回同一个桶，后续同链事件即可直接命中。
    this.bindBucket(bucket, line.messageId, line.sourceId, line.session, line.bot);
    if (line.replyRequestId !== undefined) {
      this.byReplyId.set(line.replyRequestId, bucket);
      if (this.byReplyId.size > 500) {
        const oldestReq = this.byReplyId.keys().next().value;
        if (oldestReq !== undefined) {
          this.byReplyId.delete(oldestReq);
        }
      }
    }
    if (this.detectEventKeyword(event, args, line.session)) {
      bucket.wanted = true;
    }
    return bucket;
  }

  /** 检查事件参数或关联会话是否命中快照关键词。 */
  private detectEventKeyword(event: string, args: unknown[], sessionId: string | undefined): boolean {
    if (sessionId !== undefined && this.markedSessions.has(sessionId)) return true;

    const first = utils.getOptionalRecord(args[0]);
    if (CHANNEL_INBOUND_EVENTS.has(event)) {
      return this.hasKeyword(first?.['rawText']) || this.hasKeyword(first?.['text']);
    }
    if (event === 'bot/receive') {
      const msg = utils.getOptionalRecord(first?.['message']);
      return this.hasKeyword(msg?.['text']);
    }
    return false;
  }

  /** 按标准消息号（优先精确匹配 标准消息号 + 机器人）查桶。 */
  private findBySource(sourceId: string, bot: string | undefined): PayloadBucket | undefined {
    if (bot !== undefined && bot !== '') {
      const scoped = this.bySource.get(`${sourceId}::${bot}`);
      if (scoped !== undefined) return scoped;
    }
    return this.bySource.get(sourceId);
  }

  /** 按会话号查桶；若当前是派生子会话（row.parent 已在桶中），自动连带绑入父会话的桶。 */
  private findBySession(sessionId: string): PayloadBucket | undefined {
    const direct = this.bySession.get(sessionId);
    if (direct !== undefined) return direct;

    const opened = this.ctx.get('sessions')?.['openedSessions'];
    if (!(opened instanceof Map)) return undefined;

    const parentId = (opened.get(sessionId) as { row?: { parent?: unknown } } | undefined)?.row?.parent;
    if (typeof parentId !== 'string' || parentId === '') return undefined;

    const parentBucket = this.findBySession(parentId);
    if (parentBucket !== undefined) {
      parentBucket.sessions.add(sessionId);
      this.bySession.set(sessionId, parentBucket);
    }
    return parentBucket;
  }

  /** 新建一个消息载荷桶，并按 maxMessages 淘汰最旧的内存桶。 */
  private createBucket(init: {
    messageId: number | null;
    sourceId: string | null;
    bot: string;
    wanted: boolean;
  }): PayloadBucket {
    const key = `b${String(this.nextBucketSeq)}`;
    this.nextBucketSeq += 1;
    const bucket: PayloadBucket = {
      key,
      messageId: init.messageId,
      sourceId: init.sourceId,
      bot: init.bot,
      sessions: new Set<string>(),
      entries: [],
      bytes: 0,
      capped: false,
      note: '',
      wanted: init.wanted,
      updatedAt: Date.now(),
      writeScheduled: false,
    };
    this.buckets.push(bucket);
    this.bindBucket(bucket, init.messageId ?? undefined, init.sourceId ?? undefined, undefined, init.bot);
    this.evictOldBuckets();
    return bucket;
  }

  /** 将新发现的消息号、标准消息号、会话号索引到桶上。 */
  private bindBucket(
    bucket: PayloadBucket,
    messageId: number | undefined,
    sourceId: string | undefined,
    sessionId: string | undefined,
    bot: string | undefined,
  ): void {
    if (bot !== undefined && bot !== '' && bucket.bot === '') {
      bucket.bot = bot;
    }
    if (messageId !== undefined) {
      bucket.messageId = messageId;
      this.byMessage.set(messageId, bucket);
    }
    if (sourceId !== undefined) {
      bucket.sourceId = sourceId;
      if (!this.bySource.has(sourceId)) {
        this.bySource.set(sourceId, bucket);
      }
      const effectiveBot = bot ?? bucket.bot;
      if (effectiveBot !== '') {
        this.bySource.set(`${sourceId}::${effectiveBot}`, bucket);
      }
    }
    if (sessionId !== undefined && sessionId !== '') {
      bucket.sessions.add(sessionId);
      this.bySession.set(sessionId, bucket);
      if (this.recentUnbound?.bucket === bucket) {
        this.recentUnbound = undefined;
      }
    }
  }

  /** 内存桶数超过 maxMessages 时淘汰最早的桶并清理对应索引。 */
  private evictOldBuckets(): void {
    while (this.buckets.length > this.settings.maxMessages) {
      const oldest = this.buckets.shift();
      if (oldest === undefined) break;

      this.finalizeAllEntries(oldest);
      if (oldest.messageId !== null && this.byMessage.get(oldest.messageId) === oldest) {
        this.byMessage.delete(oldest.messageId);
      }
      if (oldest.sourceId !== null) {
        if (this.bySource.get(oldest.sourceId) === oldest) {
          this.bySource.delete(oldest.sourceId);
        }
        const scopedKey = `${oldest.sourceId}::${oldest.bot}`;
        if (this.bySource.get(scopedKey) === oldest) {
          this.bySource.delete(scopedKey);
        }
      }
      for (const ses of oldest.sessions) {
        if (this.bySession.get(ses) === oldest) {
          this.bySession.delete(ses);
        }
      }
    }
  }

  /** 单条消息总大小超上限时的说明文案。 */
  private formatCapNote(): string {
    const mb = Number((this.settings.maxMessageBytes / (1024 * 1024)).toFixed(2));
    return `单条消息载荷已达 ${String(mb)}MB 上限，后续事件未再录制`;
  }

  /** 读取磁盘上的 data/flow/<消息号>.payload.json。 */
  private async readDiskFile(name: string): Promise<PayloadTrail | undefined> {
    const full = path.join(this.dir, `${name}.payload.json`);
    if (!fs.existsSync(full)) return undefined;

    const stat = await fs.promises.stat(full);
    const cached = this.cachedFile;
    if (cached !== undefined && cached.name === name && cached.mtime === stat.mtimeMs) {
      return cached.trail;
    }
    const text = await fs.promises.readFile(full, 'utf8');
    const parsed = JSON.parse(text) as PayloadTrail;
    this.cachedFile = { name, mtime: stat.mtimeMs, trail: parsed };
    return parsed;
  }

  /** 磁盘上的 *.payload.json 超过 maxMessages 个时，按修改时间删最旧的（不动 boot.json 与 <消息号>.json）。 */
  private async pruneDiskFiles(): Promise<void> {
    if (!fs.existsSync(this.dir)) return;

    const all = await fs.promises.readdir(this.dir);
    const payloadNames = all.filter((file) => PAYLOAD_FILE.test(file));
    if (payloadNames.length <= this.settings.maxMessages) return;

    const dated: { name: string; at: number; no: number }[] = [];
    for (const file of payloadNames) {
      const match = PAYLOAD_FILE.exec(file);
      const no = Number.parseInt(match?.[1] ?? '0', 10);
      const stat = await fs.promises.stat(path.join(this.dir, file));
      dated.push({ name: file, at: stat.mtimeMs, no });
    }
    dated.sort((a, b) => a.at - b.at || a.no - b.no);

    const extra = dated.slice(0, dated.length - this.settings.maxMessages);
    for (const item of extra) {
      await fs.promises.unlink(path.join(this.dir, item.name)).catch(() => undefined);
    }
  }
}
