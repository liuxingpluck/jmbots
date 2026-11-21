/**
 * 快照与事件载荷共用的对象遍历（walk）和结构对比（getDiff / computePayloadDiff）：
 *   1. 快照（Snapshot.ts / Files.ts）传 { slim: false }：照 CLAUDE.md 调试插件约定全量原样读出，不打码、不截断；
 *   2. 载荷（Payload.ts）传 { limit, slim: true }：每个白名单事件要拷前后两份并落盘导出，
 *      必须按单份字节上限流式截断、隐藏凭据、把图片 base64 换成尺寸占位并折叠嵌套 Session/Bot，防止撑爆内存磁盘或外泄密钥；
 *   3. 差异对比共用同一棵递归遍历树 walkDiff：快照取完整键路径数组 string[][]，载荷取带前后预览的 PayloadDiff[]（最多 500 条 + 顶层 same）。
 */
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { Database } from 'bun:sqlite';
import * as cordis from 'cordis';
import * as traceUtils from '../../utils/Trace.ts';


//==========================================================
//M 对外类型与常量（遍历规矩、载荷差异结构、脱敏与截断阈值）
//==========================================================

/**
 * 遍历的规矩。
 * 快照照 CLAUDE.md 调试例外全量原样（slim: false，不传 limit）；
 * 载荷每个事件拷两份且支持导出文件，打开 slim 与单份字节 limit 以免撑爆内存磁盘或泄露凭据。
 */
export interface WalkRule {
  /** 单份最多多少 UTF-8 字节；不给是不限（快照）。 */
  limit?: number;
  /** 隐藏凭据、图片换占位、嵌套会话和 Bot 折叠；快照是 false，载荷是 true。 */
  slim: boolean;
}


/** walk 交回的序列化结果。 */
export interface Walked {
  /** 能直接 JSON 化的安全值。 */
  value: unknown;
  /** JSON 序列化后的 UTF-8 字节数（设了 limit 时精确计算；未设 limit 时为 0）。 */
  bytes: number;
  /** 是否撞了单份上限发生截断。 */
  truncated: boolean;
}


/** 一个路径上的变化（Payload.ts 对外 JSON 契约）。 */
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


/** 载荷 diff 中 add / change / remove 最多保留条数。 */
export const DIFF_MAX = 500;

/** diff 前后值单行预览截到多少字再补“…”（连省略号共 200 字），交给 traceUtils.formatTraceValue。 */
export const PREVIEW_CHARS = 199;

/** 凭据键名匹配规则（设计文档 3.4 及云端 31 加固）：slim 模式下命中时值替换为 [凭据 已隐藏]。 */
const CREDENTIAL_KEY = new RegExp(
  'apiKey|api_key|secret|token|authorization|password|cookie|x-jmbots-key|webhook_header|webhookHeader',
  'iu',
);

/** Data URL 形式的图片 base64 正则。 */
const DATA_IMAGE_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/iu;

/** 普通点分标识符属性名。 */
const IDENTIFIER_KEY = /^[A-Za-z_$][\w$]*$/u;

/** 已拍下的快照组数组集合：遍历时再次碰到（如 boot-trail 存着的快照）只写 [快照]，不往里展开。 */
const TAKEN = new WeakSet<object>();


/**
 * 登记一份已拍下的快照，防止后续遍历服务对象时把历史快照再次递归展开。
 * @param snapshot Snapshot.getSnapshot 交出的快照数组。
 */
export function markTaken(snapshot: object): void {
  TAKEN.add(snapshot);
}


//==========================================================
//M 统一对象遍历：外部资源识别、流式预算控制与可选脱敏折叠
//==========================================================

/** 单次遍历的内部预算与省略开关状态。 */
interface WalkBudget {
  /** 已估算占用的 UTF-8 字节数。 */
  used: number;
  /** 单份允许的最大字节数；undefined 表示不限。 */
  limit: number | undefined;
  /** 是否启用凭据隐藏、图片占位与嵌套折叠。 */
  slim: boolean;
  /** 是否撞了单份上限发生截断。 */
  truncated: boolean;
}


/** 对象单字段写入时的上下文标记。 */
interface ObjectFieldContext {
  imageMime: string | undefined;
  nestedSession: boolean;
  botObj: boolean;
  inNestedSessionRow: boolean;
}


/**
 * 识别不往里展开的外部资源或框架实例：Cordis 的 ctx/fiber、数据库、EventEmitter、Fastify、Promise、二进制与取消信号。
 * @param value 待检查的对象。
 * @returns 类名；普通业务对象返回 undefined。
 */
export function getResourceName(value: object): string | undefined {
  if (cordis.Context.is(value)) return 'Context';

  //M Fastify 实例是普通对象，按它特有的几个方法认（只用 in，不读值，免得触发 getter）。
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
 * 不触发 getter 地读取对象自身的属性值。
 * @param target 目标对象。
 * @param key 属性名。
 */
export function getOwnDataValue(target: object, key: string): unknown {
  const slot = Object.getOwnPropertyDescriptor(target, key);
  if (slot === undefined || slot.get !== undefined) return undefined;

  return slot.value;
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


/** 判断当前是否已撞单份字节预算。 */
function hitLimit(budget: WalkBudget): boolean {
  return budget.limit !== undefined && budget.used >= budget.limit;
}


/**
 * 将对象或 Map 的单个键值写入目标对象；slim 打开时执行凭据隐藏、图片占位与嵌套会话/Bot 折叠。
 */
function writeObjectField(
  out: Record<string, unknown>,
  key: string,
  rawItem: unknown,
  ctx: ObjectFieldContext,
  above: object[],
  budget: WalkBudget,
): void {
  budget.used += Buffer.byteLength(key, 'utf8') + 4;

  if (budget.slim) {
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
  }

  const enteringNestedRow = budget.slim && ctx.nestedSession && key === 'row';
  out[key] = walkNode(rawItem, above, budget, enteringNestedRow);
}


/**
 * 递归把任意运行值连私有字段读成可 JSON 化的样子：原地出入栈防循环、不调 getter，按 WalkBudget 控制省略与截断。
 */
function walkNode(
  value: unknown,
  above: object[],
  budget: WalkBudget,
  inNestedSessionRow: boolean,
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
    if (budget.slim) {
      //M Data URL 形式的内嵌图片直接替换成 [图片 mime NKB] 占位。
      const dataMatch = DATA_IMAGE_URL.exec(value);
      if (dataMatch !== null) {
        const placeholder = formatImagePlaceholder(dataMatch[1] ?? 'image/*', dataMatch[2] ?? '');
        budget.used += Buffer.byteLength(placeholder, 'utf8') + 2;
        return placeholder;
      }
    }
    const strBytes = Buffer.byteLength(value, 'utf8') + 2;
    if (budget.limit !== undefined && budget.used + strBytes > budget.limit) {
      budget.truncated = true;
      const clipped = clipStringByUtf8(value, budget.limit - budget.used);
      budget.used = budget.limit;
      return clipped;
    }
    budget.used += strBytes;
    return value;
  }
  if (typeof value !== 'object') return String(value);

  //G 拍过的快照、循环引用与外部重资源对象只记标签，不往里递归。
  if (TAKEN.has(value)) return '[快照]';
  if (above.includes(value)) return '[循环]';
  const resource = getResourceName(value);
  if (resource !== undefined) return `[${resource}]`;

  if (value instanceof Date) return value.toLocaleString('zh-CN', { hourCycle: 'h23' });
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value instanceof RegExp || value instanceof URL) return String(value);

  const nestedSession = budget.slim && above.length >= 1 && isSessionObject(value);
  above.push(value);
  try {
    //M 数组：直接按下标流式遍历，设了上限时撞线立即停下，不预先展开整份数组。
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      budget.used += 2;
      for (let index = 0; index < value.length; index += 1) {
        if (hitLimit(budget)) {
          budget.truncated = true;
          out.push(`[已截断 剩 ${String(value.length - index)} 项]`);
          break;
        }
        out.push(walkNode(value[index], above, budget, false));
      }
      return out;
    }

    //M Set：用迭代器流式遍历转成数组，设了上限时撞线即停。
    if (value instanceof Set) {
      const total = value.size;
      const out: unknown[] = [];
      budget.used += 2;
      let index = 0;
      for (const item of value as Set<unknown>) {
        if (hitLimit(budget)) {
          budget.truncated = true;
          out.push(`[已截断 剩 ${String(total - index)} 项]`);
          break;
        }
        out.push(walkNode(item, above, budget, false));
        index += 1;
      }
      return out;
    }

    let imageMime: string | undefined;
    let botObj = false;
    if (budget.slim) {
      imageMime = getObjectImageMime(value);
      botObj = isBotInstance(value);
    }
    const fieldCtx: ObjectFieldContext = {
      imageMime,
      nestedSession,
      botObj,
      inNestedSessionRow,
    };
    const out: Record<string, unknown> = {};

    //M Map：按条目迭代器转成字符串键对象，设了上限时撞线即停。
    if (value instanceof Map) {
      const total = value.size;
      budget.used += 2;
      let index = 0;
      for (const [mapKey, mapVal] of value as Map<unknown, unknown>) {
        if (hitLimit(budget)) {
          budget.truncated = true;
          out['__truncated__'] = `[已截断 剩 ${String(total - index)} 项]`;
          break;
        }
        writeObjectField(out, String(mapKey), mapVal, fieldCtx, above, budget);
        index += 1;
      }
      return out;
    }

    //M 普通对象与类实例：用 for..in + Object.hasOwn 流式读自身字段（含 TS private），getter 不调写 [getter]。
    budget.used += 2;
    let seenOwn = false;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;

      seenOwn = true;
      if (hitLimit(budget)) {
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

    //G 没有自身字段的类实例（非普通对象）只写 [类名]。
    const proto = Object.getPrototypeOf(value) as object | null;
    const plain = proto === Object.prototype || proto === null;
    if (!seenOwn && !plain) return `[${value.constructor.name || 'Object'}]`;

    return out;
  } finally {
    above.pop();
  }
}


/**
 * 把一个值连私有字段读成能 JSON 化的样子（快照与载荷统一入口）。
 * @param value 要读的值。
 * @param rule 遍历规矩（见 WalkRule）。
 * @returns 读出来的值、JSON 字节数与截断标记。
 */
export function walk(value: unknown, rule: WalkRule): Walked {
  const budget: WalkBudget = {
    used: 0,
    limit: rule.limit,
    slim: rule.slim,
    truncated: false,
  };
  const cloned = walkNode(value, [], budget, false);
  if (rule.limit === undefined) {
    return { value: cloned, bytes: 0, truncated: false };
  }
  const json = JSON.stringify(cloned) ?? 'null';
  const bytes = Buffer.byteLength(json, 'utf8');
  const truncated = budget.truncated || bytes > rule.limit;
  return { value: cloned, bytes, truncated };
}


//==========================================================
//M 统一结构对比：共用递归对比树，支持快照全路径与载荷带预览对比
//==========================================================

/** 递归对比的收集器状态。 */
interface DiffState {
  /** 最多收集多少处变化；undefined 表示不限（快照）。 */
  limit: number | undefined;
  /** 快照收集的键名路径数组列表；不需要时为 undefined。 */
  paths: string[][] | undefined;
  /** 载荷收集的带预览变化列表；不需要时为 undefined。 */
  changes: PayloadDiff[] | undefined;
}


/**
 * 拼接对象子属性路径（普通标识符用 a.b，其余特殊键名把点号换成下划线拼回点分文本）。
 * @param base 父路径。
 * @param key 属性名。
 */
function joinObjectPath(base: string, key: string): string {
  if (base === '') return key;
  if (IDENTIFIER_KEY.test(key)) return `${base}.${key}`;

  return `${base}.${key.replaceAll('.', '_')}`;
}


/** 判断对比收集器是否已满。 */
function isDiffFull(state: DiffState): boolean {
  if (state.limit === undefined) return false;

  const count = state.changes?.length ?? state.paths?.length ?? 0;
  return count >= state.limit;
}


/** 写入一处新增、修改或删除变化。 */
function recordDiff(
  state: DiffState,
  segments: string[],
  path: string,
  kind: 'add' | 'change' | 'remove',
  older: unknown,
  newer: unknown,
): void {
  if (state.paths !== undefined) {
    state.paths.push(segments);
  }
  if (state.changes !== undefined) {
    const item: PayloadDiff = { path: path || '(root)', kind };
    if (kind !== 'add') {
      item.before = traceUtils.formatTraceValue(older, PREVIEW_CHARS);
    }
    if (kind !== 'remove') {
      item.after = traceUtils.formatTraceValue(newer, PREVIEW_CHARS);
    }
    state.changes.push(item);
  }
}


/**
 * 递归对比两份已通过 walk 序列化的值：同一个引用直接跳过，数组按下标比，普通对象合并键去重逐个比。
 */
function walkDiff(
  older: unknown,
  newer: unknown,
  segments: string[],
  currentPath: string,
  state: DiffState,
): void {
  if (isDiffFull(state)) return;
  if (older === newer || Object.is(older, newer)) return;

  if (Array.isArray(older) && Array.isArray(newer)) {
    const shared = Math.min(older.length, newer.length);
    for (let idx = 0; idx < shared; idx += 1) {
      if (isDiffFull(state)) return;

      const seg = String(idx);
      walkDiff(older[idx], newer[idx], [...segments, seg], `${currentPath}[${seg}]`, state);
    }
    for (let idx = older.length; idx < newer.length; idx += 1) {
      if (isDiffFull(state)) return;

      const seg = String(idx);
      recordDiff(state, [...segments, seg], `${currentPath}[${seg}]`, 'add', undefined, newer[idx]);
    }
    for (let idx = newer.length; idx < older.length; idx += 1) {
      if (isDiffFull(state)) return;

      const seg = String(idx);
      recordDiff(state, [...segments, seg], `${currentPath}[${seg}]`, 'remove', older[idx], undefined);
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
      if (isDiffFull(state)) return;
      if (key === '__truncated__') continue;

      const childSegs = [...segments, key];
      const childPath = joinObjectPath(currentPath, key);
      const inOld = Object.hasOwn(oldRec, key);
      const inNew = Object.hasOwn(newRec, key);
      if (!inOld && inNew) {
        recordDiff(state, childSegs, childPath, 'add', undefined, newRec[key]);
        continue;
      }
      if (inOld && !inNew) {
        recordDiff(state, childSegs, childPath, 'remove', oldRec[key], undefined);
        continue;
      }
      walkDiff(oldRec[key], newRec[key], childSegs, childPath, state);
    }
    return;
  }

  recordDiff(state, segments, currentPath, 'change', older, newer);
}


/**
 * 从指定路径前缀起比较两份子值，将 add / change / remove 推入 out（最多 DIFF_MAX 条，供模型关口按引用配对复用）。
 * @param older 前值拷贝。
 * @param newer 后值拷贝。
 * @param currentPath 当前路径前缀（如 messages[2999]）。
 * @param out 累积变化列表。
 */
export function collectChanges(
  older: unknown,
  newer: unknown,
  currentPath: string,
  out: PayloadDiff[],
): void {
  walkDiff(older, newer, [], currentPath, { limit: DIFF_MAX, paths: undefined, changes: out });
}


/**
 * 计算载荷 before 与 after 之间的逐路径差异：add / change / remove 最多 500 条，same 只列顶层未变键。
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

    const preview = traceUtils.formatTraceValue(oldTop[key], PREVIEW_CHARS);
    diffs.push({ path: key, kind: 'same', before: preview, after: preview });
  }
  return diffs;
}


/**
 * 比较两份快照值哪些路径变了：同一个引用（沿用的未变组）直接跳过，交回全部变更键路径数组。
 * @param before 上一份。
 * @param after 这一份。
 * @returns 变了的地方，每处是一串键名（列表下标写成数字字符串）；新增或删除只报它自己那一层。
 */
export function getDiff(before: unknown, after: unknown): string[][] {
  const paths: string[][] = [];
  walkDiff(before, after, [], '', { limit: undefined, paths, changes: undefined });
  return paths;
}
