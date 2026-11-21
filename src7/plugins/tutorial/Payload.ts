/**
 * 事件参数载荷采集（tutorial 1.2.0）：零改骨架，监听 Cordis 已有的 internal/dispatch，
 * 按 15 个核心事件白名单在发出刻深拷贝 before 并留住活引用，同会话下一事件到来或本轮结束时补拷 after，
 * 逐路径算出 add / change / remove（最多 500 条）与顶层 same 透传键，原子落盘 data/flow/<消息号>.payload.json。
 */
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import * as cordis from 'cordis';
import * as filesModule from '../../utils/Files.ts';
import * as textModule from '../../utils/Text.ts';
import * as traceUtils from '../../utils/Trace.ts';
import type * as filesPluginModule from './Files.ts';
import type { Trail, TrailStep } from '../../utils/Trail.ts';


//==========================================================
//M 对外 JSON 契约类型（严格对齐设计文档 3.1）
//==========================================================

/** 一个路径上的变化。 */
export interface PayloadDiff {
  /** 路径，如 messages[3].content、system[2]。 */
  path: string;
  /** add 新增、change 修改、remove 删除、same 透传（只列顶层键）。 */
  kind: 'add' | 'change' | 'remove' | 'same';
  /** 前值的一句话预览，最多 200 字；add 没有这一项。 */
  before?: string;
  /** 后值的一句话预览，最多 200 字；remove 没有这一项。 */
  after?: string;
}


/** 一个事件参数对象，在这一步的前后两份。 */
export interface PayloadItem {
  /** 本消息内从 1 开始的序号。 */
  seq: number;
  /** 发出时刻，毫秒。 */
  at: number;
  /** 对应 trail.steps[].no：后端按 at 落进哪一步的时间窗来算。 */
  step: number;
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

/** 只记账不改数据的观察者插件名，不在监听者名单里单列。 */
const PASSIVE_LISTENERS = new Set(['', 'journal', 'tutorial', 'usage']);

/** 凭据键名匹配规则（设计文档 3.4 及云端 31 加固）：命中时值替换为 [凭据 已隐藏]。 */
const CREDENTIAL_KEY = new RegExp(
  'apiKey|api_key|secret|token|authorization|password|cookie|x-jmbots-key|webhook_header|webhookHeader',
  'iu',
);

/** Data URL 形式的图片 base64 正则。 */
const DATA_IMAGE_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/iu;

/** 普通点分标识符属性名。 */
const IDENTIFIER_KEY = /^[A-Za-z_$][\w$]*$/u;

/** 磁盘上的消息载荷文件名：<消息号>.payload.json。 */
const PAYLOAD_FILE = /^(\d+)\.payload\.json$/u;

/** diff 中 add / change / remove 最多保留条数。 */
const DIFF_MAX = 500;

/** diff 前后值单行预览最大字数。 */
const PREVIEW_MAX_CHARS = 200;

/** 与 journal 事件行核对时间戳允许的误差毫秒。 */
const ROW_MATCH_MS = 200;

/** 尚未绑定收件号但刚收到 web-api/received 的短时间配对窗口，毫秒。 */
const PENDING_RECEIVE_MS = 10_000;


//==========================================================
//M 深拷贝、图片 base64 压缩、凭据隐藏与单份字节上限截断
//==========================================================

/** 单次深拷贝的字节预算状态。 */
interface CloneBudget {
  /** 已估算占用的 UTF-8 字节数。 */
  used: number;
  /** 单份允许的最大字节数。 */
  limit: number;
  /** 是否撞了单份上限发生截断。 */
  truncated: boolean;
}


/** 深拷贝结果。 */
export interface ClonedPayload {
  /** 可直接 JSON 序列化的安全副本。 */
  value: unknown;
  /** JSON 序列化后的 UTF-8 字节数。 */
  bytes: number;
  /** 是否超过单份上限并做了截断。 */
  truncated: boolean;
}


/**
 * 识别不往里展开的外部资源或框架实例（沿用 Snapshot.ts 规则并补齐取消信号）。
 * @param value 待检查的对象。
 */
function getResourceName(value: object): string | undefined {
  if (cordis.Context.is(value)) return 'Context';

  //M Fastify 实例按特有方法识别，只用 in 检查不触发 getter。
  if ('inject' in value && 'listen' in value && 'register' in value && 'server' in value) return 'Fastify';

  const isResource = value instanceof cordis.Fiber
    || value instanceof Database
    || value instanceof EventEmitter
    || value instanceof Promise
    || value instanceof WeakMap
    || value instanceof WeakSet
    || value instanceof ArrayBuffer
    || ArrayBuffer.isView(value)
    || value instanceof AbortSignal
    || value instanceof AbortController;
  if (isResource) return value.constructor.name || 'Resource';

  return undefined;
}


/**
 * 计算一段 base64 字符串解码后的近似 KB 数（非空至少记 1KB），拼成占位文本。
 * @param mime 图片 MIME，如 image/png。
 * @param rawBase64 原始 base64 段。
 */
function formatImagePlaceholder(mime: string, rawBase64: string): string {
  const clean = rawBase64.replace(/\s+/gu, '');
  const bytes = Buffer.byteLength(clean, 'base64');
  let kb = Math.round(bytes / 1024);
  if (bytes > 0 && kb === 0) {
    kb = 1;
  }
  return `[图片 ${mime} ${String(kb)}KB]`;
}


/**
 * 不触发 getter 地读取对象自身的属性值。
 * @param target 目标对象。
 * @param key 属性名。
 */
function getOwnDataValue(target: object, key: string): unknown {
  const slot = Object.getOwnPropertyDescriptor(target, key);
  if (slot === undefined || slot.get !== undefined) return undefined;

  return slot.value;
}


/**
 * 判断对象是否为图片内容块（如 pi-ai ImageContent 或带 image/* mime 的块），返回其 MIME。
 * @param target 待检查对象。
 */
function getObjectImageMime(target: object): string | undefined {
  const mimeFields = ['mimeType', 'mime', 'mediaType', 'media_type'];
  for (const field of mimeFields) {
    const raw = getOwnDataValue(target, field);
    if (typeof raw === 'string' && raw.startsWith('image/')) return raw;
  }
  const blockType = getOwnDataValue(target, 'type');
  if (blockType === 'image') return 'image/*';

  return undefined;
}


/**
 * 判断凭据键对应的值是否需要隐藏：保留数字（如 totalTokens、maxTokens）、布尔和空值，隐藏非空字符串与对象凭据。
 * @param value 字段原值。
 */
function shouldMaskCredential(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'number' || typeof value === 'boolean') return false;

  return true;
}


/**
 * 按剩余 UTF-8 字节上限截断长字符串，避免切碎多字节字符。
 * @param text 原字符串。
 * @param maxBytes 允许保留的最大字节数。
 */
function clipStringByUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 24) return '[已截断]';

  //M 逐步按字符长度收敛，保证最终 UTF-8 字节数不超过剩余预算。
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes - 18) {
    end = Math.floor(end * 0.8);
  }
  return `${text.slice(0, end)}…[已截断]`;
}


/**
 * 判断对象是否为嵌套的 Session 实例（含 id 与 row.messages），避免在 ChatRequest.session 等内层重复展开整场历史。
 * @param value 待判断对象。
 */
function isSessionObject(value: object): boolean {
  const id = getOwnDataValue(value, 'id');
  const row = getOwnDataValue(value, 'row');
  if (typeof id !== 'string' || typeof row !== 'object' || row === null) return false;

  const messages = getOwnDataValue(row, 'messages');
  return Array.isArray(messages);
}


/**
 * 判断对象是否为 Bots 插件里的 Bot 实例（含 name 与 home 服务引用），避免把整个 Bots 服务表拷进 bot/receive。
 * @param value 待判断对象。
 */
function isBotInstance(value: object): boolean {
  const botName = getOwnDataValue(value, 'name');
  if (typeof botName !== 'string') return false;

  return Object.hasOwn(value, 'home') && typeof getOwnDataValue(value, 'home') === 'object';
}


/** 对象单字段写入时的上下文标记。 */
interface ObjectFieldContext {
  imageMime: string | undefined;
  nestedSession: boolean;
  botObj: boolean;
  inNestedSessionRow: boolean;
}


/**
 * 将对象或 Map 的单个键值按脱敏、图片占位与嵌套折叠规则写入目标对象。
 */
function writeObjectField(
  out: Record<string, unknown>,
  key: string,
  rawItem: unknown,
  ctx: ObjectFieldContext,
  above: object[],
  budget: CloneBudget,
): void {
  budget.used += Buffer.byteLength(key, 'utf8') + 4;

  //M Bot 实例里的 home 指向整个 Bots 服务，写成 [Bots] 免得把全局服务表带进来。
  if (ctx.botObj && key === 'home') {
    out[key] = '[Bots]';
    return;
  }
  //M 嵌套 Session.row 里的整场历史 messages 写成条数摘要（顶层 ChatRequest.messages 仍完整保留）。
  if (ctx.inNestedSessionRow && key === 'messages' && Array.isArray(rawItem)) {
    out[key] = `[对话历史 ${String(rawItem.length)} 条]`;
    return;
  }
  //M 命中凭据键名时隐藏敏感值。
  if (CREDENTIAL_KEY.test(key) && shouldMaskCredential(rawItem)) {
    out[key] = '[凭据 已隐藏]';
    return;
  }
  //M 图片对象里的 data / base64 字段或显式 imageBase64 字段换成 [图片 mime NKB]。
  if (typeof rawItem === 'string' && rawItem !== '' && !rawItem.startsWith('[图片 ')) {
    const isImgData = ctx.imageMime !== undefined && (key === 'data' || key === 'base64');
    const isNamedB64 = key === 'imageBase64' || key === 'image_base64';
    if (isImgData || isNamedB64) {
      out[key] = formatImagePlaceholder(ctx.imageMime ?? 'image/*', rawItem);
      return;
    }
  }

  const enteringNestedRow = ctx.nestedSession && key === 'row';
  out[key] = walkPayload(rawItem, above, budget, enteringNestedRow);
}


/**
 * 递归深拷贝事件参数：防循环、转特殊资源、压缩图片 base64、隐藏凭据，并按单份字节预算边遍历边停。
 * @param value 当前节点值。
 * @param above 祖先对象栈（原地 push/pop 检测循环引用，避免每层复制数组）。
 * @param budget 单份字节预算。
 * @param inNestedSessionRow 是否正处于嵌套 Session 的 row 对象内（避免重复展开整场历史 messages）。
 */
function walkPayload(
  value: unknown,
  above: object[],
  budget: CloneBudget,
  inNestedSessionRow = false,
): unknown {
  if (typeof value === 'function') return `ƒ ${value.name || '（匿名）'}`;
  if (typeof value === 'bigint') return String(value);
  if (value === undefined) return null;
  if (value === null || typeof value === 'boolean') {
    budget.used += 5;
    return value;
  }
  if (typeof value === 'number') {
    budget.used += 8;
    if (!Number.isFinite(value)) return null;

    return value;
  }
  if (typeof value === 'string') {
    //M Data URL 形式的内嵌图片直接替换成 [图片 mime NKB] 占位。
    const dataMatch = DATA_IMAGE_URL.exec(value);
    if (dataMatch !== null) {
      const placeholder = formatImagePlaceholder(dataMatch[1] ?? 'image/*', dataMatch[2] ?? '');
      budget.used += Buffer.byteLength(placeholder, 'utf8') + 2;
      return placeholder;
    }
    const strBytes = Buffer.byteLength(value, 'utf8') + 2;
    if (budget.used + strBytes > budget.limit) {
      budget.truncated = true;
      const clipped = clipStringByUtf8(value, budget.limit - budget.used);
      budget.used = budget.limit;
      return clipped;
    }
    budget.used += strBytes;
    return value;
  }
  if (typeof value !== 'object') return String(value);

  //G 循环引用与外部重资源对象只记标签，不往里递归。
  if (above.includes(value)) return '[循环]';
  const resource = getResourceName(value);
  if (resource !== undefined) return `[${resource}]`;

  if (value instanceof Date) return value.toLocaleString('zh-CN', { hourCycle: 'h23' });
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value instanceof RegExp || value instanceof URL) return String(value);

  const nestedSession = above.length >= 1 && isSessionObject(value);
  above.push(value);
  try {
    //M 数组：直接按下标流式遍历，撞预算上限立即停下，不预先 [...value] 整份展开。
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      budget.used += 2;
      for (let index = 0; index < value.length; index += 1) {
        if (budget.used >= budget.limit) {
          budget.truncated = true;
          out.push(`[已截断 剩 ${String(value.length - index)} 项]`);
          break;
        }
        out.push(walkPayload(value[index], above, budget, false));
      }
      return out;
    }

    //M Set：直接用迭代器流式遍历，撞预算上限立即停下，不转中间数组。
    if (value instanceof Set) {
      const total = value.size;
      const out: unknown[] = [];
      budget.used += 2;
      let index = 0;
      for (const item of value as Set<unknown>) {
        if (budget.used >= budget.limit) {
          budget.truncated = true;
          out.push(`[已截断 剩 ${String(total - index)} 项]`);
          break;
        }
        out.push(walkPayload(item, above, budget, false));
        index += 1;
      }
      return out;
    }

    const fieldCtx: ObjectFieldContext = {
      imageMime: getObjectImageMime(value),
      nestedSession,
      botObj: isBotInstance(value),
      inNestedSessionRow,
    };
    const out: Record<string, unknown> = {};

    //M Map：按条目迭代器边走边算预算，撞上限即停，不建中间 pairs 数组。
    if (value instanceof Map) {
      const total = value.size;
      budget.used += 2;
      let index = 0;
      for (const [mapKey, mapVal] of value as Map<unknown, unknown>) {
        if (budget.used >= budget.limit) {
          budget.truncated = true;
          out['__truncated__'] = `[已截断 剩 ${String(total - index)} 项]`;
          break;
        }
        writeObjectField(out, String(mapKey), mapVal, fieldCtx, above, budget);
        index += 1;
      }
      return out;
    }

    //M 普通对象与类实例：用 for..in + Object.hasOwn 流式扫描自身字段（不调 getter），撞预算立即 break。
    budget.used += 2;
    let seenOwn = false;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;

      seenOwn = true;
      if (budget.used >= budget.limit) {
        budget.truncated = true;
        out['__truncated__'] = '[已截断 后续字段省略]';
        break;
      }
      const slot = Object.getOwnPropertyDescriptor(value, key);
      let rawItem: unknown = '[getter]';
      if (slot?.get === undefined) {
        rawItem = slot?.value;
      }
      writeObjectField(out, key, rawItem, fieldCtx, above, budget);
    }

    const proto = Object.getPrototypeOf(value) as object | null;
    const plain = proto === Object.prototype || proto === null;
    if (!seenOwn && !plain) return `[${value.constructor.name || 'Object'}]`;

    return out;
  } finally {
    above.pop();
  }
}


/**
 * 深拷贝一份事件载荷并计算序列化字节数与截断标记。
 * @param value 原始事件参数对象。
 * @param maxBytes 单份允许的最大字节数（payload_item_kb 换算）。
 */
export function clonePayload(value: unknown, maxBytes: number): ClonedPayload {
  const budget: CloneBudget = { used: 0, limit: maxBytes, truncated: false };
  const cloned = walkPayload(value, [], budget, false);
  const json = JSON.stringify(cloned) ?? 'null';
  const bytes = Buffer.byteLength(json, 'utf8');
  const truncated = budget.truncated || bytes > maxBytes;
  return { value: cloned, bytes, truncated };
}


//==========================================================
//M 前后两份载荷逐路径对比（add / change / remove <= 500 + 顶层 same）
//==========================================================

/**
 * 生成单行值预览，最多 200 字。
 * @param value 任意已深拷贝的值。
 */
function formatPreview(value: unknown): string {
  let raw = '';
  if (typeof value === 'string') {
    raw = value;
  }
  if (typeof value !== 'string') {
    raw = JSON.stringify(value) ?? String(value);
  }
  const singleLine = raw.replace(/\s+/gu, ' ');
  if (singleLine.length > PREVIEW_MAX_CHARS) {
    return `${singleLine.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
  }
  return singleLine;
}


/**
 * 拼接对象子属性路径（普通标识符用 a.b，其余特殊键名拼回点分文本）。
 * @param base 父路径。
 * @param key 属性名。
 */
function joinObjectPath(base: string, key: string): string {
  if (base === '') return key;
  if (IDENTIFIER_KEY.test(key)) return `${base}.${key}`;

  return `${base}.${key.replaceAll('.', '_')}`;
}


/**
 * 递归比较两份已深拷贝的值，将 add / change / remove 推入 out（最多 DIFF_MAX 条）。
 * @param older 进来时的拷贝。
 * @param newer 交出去时的拷贝。
 * @param currentPath 当前路径。
 * @param out 累积变化列表。
 */
function collectChanges(
  older: unknown,
  newer: unknown,
  currentPath: string,
  out: PayloadDiff[],
): void {
  if (out.length >= DIFF_MAX) return;
  if (Object.is(older, newer)) return;

  const bothArrays = Array.isArray(older) && Array.isArray(newer);
  if (bothArrays) {
    const shared = Math.min(older.length, newer.length);
    for (let idx = 0; idx < shared; idx += 1) {
      if (out.length >= DIFF_MAX) return;

      const elemPath = `${currentPath}[${String(idx)}]`;
      collectChanges(older[idx], newer[idx], elemPath, out);
    }
    for (let idx = older.length; idx < newer.length; idx += 1) {
      if (out.length >= DIFF_MAX) return;

      out.push({
        path: `${currentPath}[${String(idx)}]`,
        kind: 'add',
        after: formatPreview(newer[idx]),
      });
    }
    for (let idx = newer.length; idx < older.length; idx += 1) {
      if (out.length >= DIFF_MAX) return;

      out.push({
        path: `${currentPath}[${String(idx)}]`,
        kind: 'remove',
        before: formatPreview(older[idx]),
      });
    }
    return;
  }

  const bothPlainObjects = typeof older === 'object' && older !== null && !Array.isArray(older)
    && typeof newer === 'object' && newer !== null && !Array.isArray(newer);
  if (bothPlainObjects) {
    const oldRec = older as Record<string, unknown>;
    const newRec = newer as Record<string, unknown>;
    const keys = new Set([...Object.keys(oldRec), ...Object.keys(newRec)]);
    for (const key of keys) {
      if (out.length >= DIFF_MAX) return;
      if (key === '__truncated__') continue;

      const childPath = joinObjectPath(currentPath, key);
      const inOld = Object.hasOwn(oldRec, key);
      const inNew = Object.hasOwn(newRec, key);
      if (!inOld && inNew) {
        out.push({ path: childPath, kind: 'add', after: formatPreview(newRec[key]) });
        continue;
      }
      if (inOld && !inNew) {
        out.push({ path: childPath, kind: 'remove', before: formatPreview(oldRec[key]) });
        continue;
      }
      collectChanges(oldRec[key], newRec[key], childPath, out);
    }
    return;
  }

  out.push({
    path: currentPath || '(root)',
    kind: 'change',
    before: formatPreview(older),
    after: formatPreview(newer),
  });
}


/**
 * 计算 before 与 after 之间的逐路径差异：add / change / remove 最多 500 条，same 只列顶层未变键。
 * @param before 发出刻深拷贝。
 * @param after 下一事件或收尾时的深拷贝；未取到传 null。
 */
export function computePayloadDiff(before: unknown, after: unknown | null): PayloadDiff[] {
  if (after === null) return [];

  const diffs: PayloadDiff[] = [];
  collectChanges(before, after, '', diffs);

  //M 顶层均为普通对象时，把前后完全一致的顶层键标为 same（透传）。
  const bothObjects = typeof before === 'object' && before !== null && !Array.isArray(before)
    && typeof after === 'object' && after !== null && !Array.isArray(after);
  if (!bothObjects) return diffs;

  const oldTop = before as Record<string, unknown>;
  const newTop = after as Record<string, unknown>;
  for (const key of Object.keys(oldTop)) {
    if (key === '__truncated__' || !Object.hasOwn(newTop, key)) continue;

    const sameJson = JSON.stringify(oldTop[key]) === JSON.stringify(newTop[key]);
    if (!sameJson) continue;

    const preview = formatPreview(oldTop[key]);
    diffs.push({ path: key, kind: 'same', before: preview, after: preview });
  }
  return diffs;
}


//==========================================================
//M 按轨迹步骤时间窗与事件行核对 step 与 site
//==========================================================

/**
 * 按时刻落进哪一步的时间窗算出 step 编号（1..N）。
 * @param at 事件发出时刻（毫秒）。
 * @param start 轨迹起点时刻（trail.at）。
 * @param steps 轨迹步骤数组。
 */
function findStepByWindow(at: number, start: number, steps: TrailStep[]): number {
  const first = steps[0];
  if (first === undefined) return 0;
  if (at <= start + first.t) return first.no;

  //M 先找严格落在 [stepStart, stepEnd] 时间窗里的步骤。
  for (const step of steps) {
    const stepStart = start + step.t;
    const stepEnd = stepStart + Math.max(step.ms, 0);
    if (at >= stepStart && at <= stepEnd) return step.no;
  }

  //M 落在步间空隙或收尾稍后时，归入已开始但最接近的那一步。
  let chosen = first.no;
  for (const step of steps) {
    if (start + step.t <= at) {
      chosen = step.no;
    }
  }
  return chosen;
}


/**
 * 将录到的 PayloadItem 列表对齐到 journal 轨迹的步骤号与事件行源码位置。
 * @param items 原始载荷列表。
 * @param trail 对应消息的轨迹；未挂 journal 或查不到时为 undefined。
 */
export function assignTrailSteps(items: PayloadItem[], trail: Trail | undefined): PayloadItem[] {
  if (trail === undefined || trail.steps.length === 0) return items;

  //M 展平轨迹里所有事件行，按顺序优先精确配对同名且时刻接近的行以复用 journal 的 site 和步号。
  const eventRows: { stepNo: number; name: string; at: number; site: string; used: boolean }[] = [];
  for (const step of trail.steps) {
    for (const row of step.rows) {
      if (row.kind !== '事件') continue;

      eventRows.push({
        stepNo: step.no,
        name: row.name,
        at: trail.at + row.t,
        site: row.site,
        used: false,
      });
    }
  }

  let cursor = 0;
  return items.map((item) => {
    for (let idx = cursor; idx < eventRows.length; idx += 1) {
      const row = eventRows[idx];
      if (row === undefined || row.used) continue;
      if (row.name !== item.event) continue;
      if (Math.abs(row.at - item.at) > ROW_MATCH_MS) continue;

      row.used = true;
      cursor = idx + 1;
      let site = item.site;
      if (row.site !== '' && row.site !== '位置不明') {
        site = row.site;
      }
      return { ...item, step: row.stepNo, site };
    }

    const fallbackStep = findStepByWindow(item.at, trail.at, trail.steps);
    return { ...item, step: fallbackStep };
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
 * 将未知值安全窄化为非空、非数组的普通键值对象；不满足时返回 undefined。
 * @param value 待判断值。
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  return value as Record<string, unknown>;
}


/**
 * 从普通对象安全取出数字形式的正整数消息号。
 * @param record 待读取对象。
 * @param key 字段名。
 */
function readPositiveInt(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const raw = record?.[key];
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw;

  return undefined;
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


/**
 * 从任意事件参数中深度挖掘标准消息号、数字收件号、会话号、回复请求号与会话当前状态。
 */
interface ExtractedRefs {
  messageId: number | undefined;
  sourceId: string | undefined;
  sessionId: string | undefined;
  bot: string | undefined;
  replyRequestId: string | undefined;
  sessionState: string | undefined;
}


/**
 * 结合共用事件行（utils/Trace.ts 的 onDispatch 交来的）与渠道回复/收尾快照提取关联线索，覆盖全部 15 种白名单事件。
 * @param line 共用的事件行：会话号、机器人、消息号先从它取。
 * @param args 事件参数。
 * @returns 认出的关联线索。
 */
function extractEventRefs(line: traceUtils.SharedLine, args: unknown[]): ExtractedRefs {
  const event = line.name;
  const first = asRecord(args[0]);
  let messageId = line.messageId;
  let sourceId = line.sourceId;
  let sessionId = line.session;
  let bot = line.bot;
  let replyRequestId: string | undefined;
  let sessionState: string | undefined;

  //M 1. 渠道消息与 bot/receive：从 origin.address 或 message.address 提取网页收件号。
  const origin = asRecord(first?.['origin']);
  const originAddr = asRecord(origin?.['address']);
  const innerMsg = asRecord(first?.['message']);
  const innerAddr = asRecord(innerMsg?.['address']);
  if (messageId === undefined) {
    messageId = readPositiveInt(originAddr, 'messageId') ?? readPositiveInt(innerAddr, 'messageId');
  }
  if (bot === undefined && typeof innerMsg?.['bot'] === 'string') {
    bot = innerMsg['bot'];
  }

  //M 2. 会话对象自身携带的 activeSourceSnapshot 与 row.address（兜底认出所属渠道消息与收件号）。
  const sessionObj = asRecord(first?.['session']) ?? first;
  const sessionRow = asRecord(sessionObj?.['row']);
  if (sessionRow !== undefined) {
    if (typeof sessionRow['state'] === 'string') {
      sessionState = sessionRow['state'];
    }
    const rowAddr = asRecord(sessionRow['address']);
    if (messageId === undefined) {
      messageId = readPositiveInt(rowAddr, 'messageId');
    }
    const activeSnap = asRecord(sessionRow['activeSourceSnapshot']);
    if (sourceId === undefined) {
      sourceId = traceUtils.getSourceId(activeSnap?.['messageId']);
    }
  }

  //M 3. channel/reply、channel/replied、bot/settled：从 sourceSnapshot、request、target.address 提取线索。
  const reqObj = asRecord(first?.['request']) ?? first;
  if (event === 'channel/reply' || event === 'channel/replied') {
    if (typeof reqObj?.['requestId'] === 'string') {
      replyRequestId = reqObj['requestId'];
    }
    if (sessionId === undefined && typeof reqObj?.['sessionId'] === 'string' && reqObj['sessionId'] !== '') {
      sessionId = reqObj['sessionId'];
    }
    if (bot === undefined && typeof reqObj?.['bot'] === 'string') {
      bot = reqObj['bot'];
    }
  }
  const snap = asRecord(reqObj?.['sourceSnapshot']) ?? asRecord(first?.['sourceSnapshot']);
  if (snap !== undefined) {
    if (sourceId === undefined) {
      sourceId = traceUtils.getSourceId(snap['messageId']);
    }
    if (bot === undefined && typeof snap['botName'] === 'string') {
      bot = snap['botName'];
    }
    const snapOrigin = asRecord(snap['origin']);
    const snapAddr = asRecord(snapOrigin?.['address']);
    if (messageId === undefined) {
      messageId = readPositiveInt(snapAddr, 'messageId');
    }
  }
  const targetObj = asRecord(reqObj?.['target']);
  const targetAddr = asRecord(targetObj?.['address']);
  if (messageId === undefined) {
    messageId = readPositiveInt(targetAddr, 'messageId');
  }

  return { messageId, sourceId, sessionId, bot, replyRequestId, sessionState };
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

      const msgId = readPositiveInt(vars, 'messageId');
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
   * @param trail 对应消息的轨迹（用于计算 step 时间窗）。
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
    const rec = asRecord(payload);
    const id = readPositiveInt(rec, 'id');
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
   */
  private onWhitelistedDispatch(line: traceUtils.SharedLine, args: unknown[]): void {
    const event = line.name;
    const refs = extractEventRefs(line, args);
    const bucket = this.resolveOrCreateBucket(event, args, refs);
    if (bucket === null || !bucket.wanted) return;

    bucket.updatedAt = Date.now();

    //M 1. 同桶前序事件补拷 after：
    //M    - 进入会话事件时，先前未结算的 bot/receive 与同会话上一事件已完成监听修改，立即补拷；
    //M    - 进到模型关口或收尾事件时，外层 channel/* 认领 claims 也已填齐，一并补拷；
    //M    - channel/replied 到来时，补拷对应的 channel/reply（handled 已置 true）。
    this.settlePreviousEntries(bucket, event, refs.sessionId ?? null);

    //M 2. 若本消息已超单消息字节上限，不再录新事件。
    if (bucket.capped) {
      this.checkRoundEnd(bucket, event, refs.sessionState);
      return;
    }

    //M 3. 深拷贝当前事件的 before，检查单消息 8MB 预算。
    const targetRef = buildTargetRef(event, args);
    const beforeClone = clonePayload(targetRef, this.settings.maxItemBytes);
    const wouldExceed = bucket.bytes + beforeClone.bytes > this.settings.maxMessageBytes;
    if (wouldExceed && bucket.entries.length > 0) {
      bucket.capped = true;
      bucket.note = this.formatCapNote();
      this.checkRoundEnd(bucket, event, refs.sessionState);
      return;
    }

    bucket.bytes += beforeClone.bytes;
    if (bucket.bytes > this.settings.maxMessageBytes) {
      bucket.capped = true;
      bucket.note = this.formatCapNote();
    }

    const listeners = line.listeners.filter((plugin) => !PASSIVE_LISTENERS.has(plugin));
    const objectName = EVENT_OBJECT_NAMES[event] ?? 'Object';
    const site = line.site;
    const item: PayloadItem = {
      seq: bucket.entries.length + 1,
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
      sessionId: refs.sessionId ?? null,
      outerChannel: CHANNEL_INBOUND_EVENTS.has(event),
      liveRef: targetRef,
      settled: false,
    };
    bucket.entries.push(entry);

    //M 4. 检查这一轮是否收尾；收尾则在当前事件监听跑完后补齐剩余 after 并原子写盘。
    this.checkRoundEnd(bucket, event, refs.sessionState);
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
    entry.liveRef = undefined;
    if (ref === undefined) return;

    //G 若补拷前已严重超出消息总上限，after 留 null 并记明原因。
    if (bucket.bytes >= this.settings.maxMessageBytes && bucket.capped) {
      if (bucket.note === '') {
        bucket.note = this.formatCapNote();
      }
      return;
    }

    const afterClone = clonePayload(ref, this.settings.maxItemBytes);
    bucket.bytes += afterClone.bytes;
    if (bucket.bytes > this.settings.maxMessageBytes) {
      bucket.capped = true;
      bucket.note = this.formatCapNote();
    }
    entry.item.after = afterClone.value;
    entry.item.truncated = entry.item.truncated || afterClone.truncated;
    entry.item.diff = computePayloadDiff(entry.item.before, afterClone.value);
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
      const liveAfter = clonePayload(entry.liveRef, this.settings.maxItemBytes);
      const diff = computePayloadDiff(entry.item.before, liveAfter.value);
      return {
        ...entry.item,
        after: liveAfter.value,
        diff,
        truncated: entry.item.truncated || liveAfter.truncated,
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
   * 按事件携带的线索查找已有桶，或在入站起点新建桶。
   */
  private resolveOrCreateBucket(event: string, args: unknown[], refs: ExtractedRefs): PayloadBucket | null {
    //M 1. 先按明确线索依次查：replyRequestId → 数字收件号 → 会话号（含父会话）→ 标准消息号。
    let bucket: PayloadBucket | undefined;
    if (refs.replyRequestId !== undefined) {
      bucket = this.byReplyId.get(refs.replyRequestId);
    }
    if (bucket === undefined && refs.messageId !== undefined) {
      bucket = this.byMessage.get(refs.messageId);
    }
    if (bucket === undefined && refs.sessionId !== undefined) {
      bucket = this.findBySession(refs.sessionId);
    }
    if (bucket === undefined && refs.sourceId !== undefined) {
      bucket = this.findBySource(refs.sourceId, refs.bot);
    }

    //M 2. 兼容刚发过 web-api/received 但未走 Timeline.bindSession 的直发会话事件（与 Trail.pick 的 firstSession 一致）。
    if (bucket === undefined && refs.sessionId !== undefined && this.recentUnbound !== undefined) {
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
        || refs.messageId !== undefined
        || refs.sessionId !== undefined;
      if (!canStart) return null;

      const hasKw = this.detectEventKeyword(event, args, refs.sessionId);
      const wanted = this.settings.recordMode === 'all' || hasKw;
      bucket = this.createBucket({
        messageId: refs.messageId ?? null,
        sourceId: refs.sourceId ?? null,
        bot: refs.bot ?? '',
        wanted,
      });
    }

    //M 4. 把本次新露面的线索绑回同一个桶，后续同链事件即可直接命中。
    this.bindBucket(bucket, refs.messageId, refs.sourceId, refs.sessionId, refs.bot);
    if (refs.replyRequestId !== undefined) {
      this.byReplyId.set(refs.replyRequestId, bucket);
      if (this.byReplyId.size > 500) {
        const oldestReq = this.byReplyId.keys().next().value;
        if (oldestReq !== undefined) {
          this.byReplyId.delete(oldestReq);
        }
      }
    }
    if (this.detectEventKeyword(event, args, refs.sessionId)) {
      bucket.wanted = true;
    }
    return bucket;
  }

  /** 检查事件参数或关联会话是否命中快照关键词。 */
  private detectEventKeyword(event: string, args: unknown[], sessionId: string | undefined): boolean {
    if (sessionId !== undefined && this.markedSessions.has(sessionId)) return true;

    const first = asRecord(args[0]);
    if (CHANNEL_INBOUND_EVENTS.has(event)) {
      return this.hasKeyword(first?.['rawText']) || this.hasKeyword(first?.['text']);
    }
    if (event === 'bot/receive') {
      const msg = asRecord(first?.['message']);
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

  /** 磁盘上的 *.payload.json 超过 maxMessages 个时，按修改时间删最旧的（绝不碰 boot.json 与 <消息号>.json）。 */
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
