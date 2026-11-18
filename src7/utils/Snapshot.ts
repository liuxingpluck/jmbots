/**
 * 运行时变量的快照：骨架三个服务和每个插件提供的服务对象，连私有字段一起全量读出来，给 /flow/ 右栏「运行时变量」。
 * 这是调试用的（CLAUDE.md：调试插件一律全量原样显示），不打码、不截断、不限层数；只有三样不往里读：
 * 绕回来的写 [循环]，函数写 ƒ 名字，Cordis 的 ctx、数据库连接、网络连接、Fastify 这类外部资源对象写 [类名]。
 * boot-trail（启动每一步拍一份）和 flow（现在、运行时每个事件拍一份）都用这里；放 utils 是因为插件之间不互相 import。
 * 函数：walkState 遍历，getDiff 比差异，group 读一组，getSnapshot 拼一份，getBytes 估一份新占多少字节。只读不改：不调 getter，不发事件。
 */
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import * as process from 'node:process';
import { Database } from 'bun:sqlite';
import * as cordis from 'cordis';
import * as textModule from './Text.ts';


/** 一份快照里的一组：一个服务，或 main、插件登记的。 */
export interface StateGroup {
  /** 组名：main、服务名（resources、tools、sessions、bots……），或插件用 ctx.flow.state 登记的名字。 */
  name: string;
  /** 一句人话，说这组是什么。 */
  note: string;
  /** 原样的值，能直接 JSON 化（Map 转成对象、Set 转成数组）。键是代码里的英文名。 */
  value: unknown;
  /** 手写的键的中文解释：英文键 → 解释（main 组、插件登记的）；服务对象自己的字段名不用解释，是空的。 */
  notes: Record<string, string>;
}


/** main 组和读出错时的键的说明表。 */
const NOTES: Record<string, string> = {
  argv: '启动参数',
  candidate: '是不是试运行（--mode candidate）',
  pid: '进程号',
  error: '这组读不到的原因',
};

/** getSnapshot 拍下的快照：遍历时又遇到（boot-trail 每步存着的）只写 [快照]，不往里读。 */
const TAKEN = new WeakSet<object>();

/** 每组的 JSON：拍下一份时和上一份同名的组比，没变就沿用上一份的那组，几百份快照不至于占太多内存。 */
const JSON_OF = new WeakMap<StateGroup, string>();


/**
 * 外部资源对象只写类名：Cordis 的 ctx 和 fiber、数据库、网络连接和别的 EventEmitter、Fastify、Promise、二进制。
 * 读进去会巨大又没意义（里面是连接、句柄、整个框架）。
 * @param value 一个对象。
 * @returns 类名；不是这类是 undefined。
 */
function getResourceName(value: object): string | undefined {
  if (cordis.Context.is(value)) return 'Context';

  //M Fastify 实例是普通对象，按它特有的几个方法认（用 in，不读值，免得碰到 getter）。
  if ('inject' in value && 'listen' in value && 'register' in value && 'server' in value) return 'Fastify';

  const resource = value instanceof cordis.Fiber
    || value instanceof Database
    || value instanceof EventEmitter
    || value instanceof Promise
    || value instanceof WeakMap
    || value instanceof WeakSet
    || value instanceof ArrayBuffer
    || ArrayBuffer.isView(value);
  if (resource) return value.constructor.name;

  return undefined;
}


/**
 * 遍历：把一个值连私有字段全量读成能 JSON 化的样子，原样给，不打码、不截断。
 * @param value 要读的值；顶层一般是一个服务对象。
 * @param above 从顶层到这里经过的对象，认循环用。
 * @returns 函数写 ƒ 名字；外部资源对象写 [类名]；循环写 [循环]；Map 转成对象（键转成字），Set 转成数组；
 *   没有自己字段的类对象写 [类名]；getter 不调，写 [getter]；undefined 写 null（键留着）。
 */
export function walkState(value: unknown, above: object[] = []): unknown {
  if (typeof value === 'function') return `ƒ ${value.name || '（匿名）'}`;
  if (typeof value === 'bigint') return String(value);
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;

  //G 拍下的快照、绕回来的、外部资源：只写一个记号，不往里读。
  if (TAKEN.has(value)) return '[快照]';
  if (above.includes(value)) return '[循环]';
  const resource = getResourceName(value);
  if (resource !== undefined) return `[${resource}]`;

  if (value instanceof Date) return value.toLocaleString('zh-CN', { hourCycle: 'h23' });
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value instanceof RegExp || value instanceof URL) return String(value);

  const inner = [...above, value];

  //M 列表、Set：每一项都读。
  if (Array.isArray(value) || value instanceof Set) {
    return [...(value as Iterable<unknown>)].map((item) => walkState(item, inner));
  }

  /** 要往下读的每一对：键（转成字）和值。 */
  const pairs: [string, unknown][] = [];

  //M Map 读每一对，键转成字；别的对象读自己的字段（含 TypeScript 的 private），getter 不调，写 [getter]。
  if (value instanceof Map) {
    for (const [name, item] of value as Map<unknown, unknown>) {
      pairs.push([String(name), item]);
    }
  }
  if (!(value instanceof Map)) {
    for (const name of Object.keys(value)) {
      const slot = Object.getOwnPropertyDescriptor(value, name);
      let item: unknown = '[getter]';
      if (slot?.get === undefined) {
        item = slot?.value;
      }
      pairs.push([name, item]);
    }
  }

  //G 没有自己字段的类对象（不是普通对象、也不是 Map）→ 只写类名。
  const proto = Object.getPrototypeOf(value) as object | null;
  const plain = proto === Object.prototype || proto === null || value instanceof Map;
  if (pairs.length === 0 && !plain) return `[${value.constructor.name}]`;

  const out: Record<string, unknown> = {};
  //M 逐对递归展开下层字段，完成全量可读结构转换。
  for (const [name, item] of pairs) {
    out[name] = walkState(item, inner);
  }
  return out;
}


/**
 * 读一组：读的时候出错不挡别的组，写成 error。和上一份同名的组一样，就沿用上一份的那组（省内存，比差异时一眼跳过）。
 * @param name 组名。
 * @param note 一句人话。
 * @param read 交回这一刻的值；交出去前过 walkState。
 * @param previous 上一份快照；没有给 []。
 * @param notes 手写的键的中文解释；读出错时换成 error 那一句。
 */
export function group(name: string, note: string, read: () => unknown, previous: StateGroup[] = [], notes: Record<string, string> = {}): StateGroup {
  let value: unknown;
  let shown = notes;
  try {
    //M 现取该组服务对象并用 walkState 安全序列化；任一服务读取报错不拖累整份快照。
    value = walkState(read());
  } catch (error) {
    value = { error: textModule.getMessage(error) };
    shown = { error: NOTES['error'] ?? '' };
  }
  //M 序列化对比上一份同名组的 JSON，完全一致直接沿用旧对象节省内存与 diff 开销。
  const json = JSON.stringify(value);
  const old = previous.find((item) => item.name === name);
  if (old !== undefined && JSON_OF.get(old) === json) return old;

  const fresh = { name, note, value, notes: shown };
  JSON_OF.set(fresh, json);
  return fresh;
}


/**
 * 拍一份：main（启动参数、试运行、进程号），再按挂上的先后，每个插件提供的服务一组（骨架的 resources、tools、sessions 在最前）。
 * @param ctx 任意一个插件的 ctx：服务表 ctx.reflect.store 是大家共用的一张。
 * @param previous 上一份；同名的组没变就沿用。
 * @returns 各组。
 */
export function getSnapshot(ctx: cordis.Context, previous: StateGroup[] = []): StateGroup[] {
  //M main 组：启动参数、是不是试运行（照 --mode candidate 认）、进程号。
  const argv = process.argv.slice(2);
  const mode = argv.indexOf('--mode');
  const candidate = mode >= 0 && argv[mode + 1] === 'candidate';
  const readMain = (): unknown => ({ argv, candidate, pid: process.pid });
  const main = group('main', '入口：启动参数、是不是试运行、进程号', readMain, previous, NOTES);
  const groups = [main];

  //M 再按挂上的先后，每个服务一组。

  const store = ctx.reflect.store;
  for (const symbol of Object.getOwnPropertySymbols(store)) {
    const impl = store[symbol];
    //G 撤掉的、Cordis 自带的（根 fiber 提供的，runtime 是 null）不看。
    if (impl?.value === undefined || impl.ctx.fiber.runtime === null) continue;

    //M 读取该插件提供的服务对象并归组（只读不改）。
    const read = (): unknown => impl.value;
    groups.push(group(impl.name, `${impl.ctx.fiber.name} 提供的服务`, read, previous));
  }
  TAKEN.add(groups);
  return groups;
}


/**
 * 一份快照新占了多少字节：JSON 的 UTF-8 字节数估。沿用上一份的组不算（group 拍的时候已经算好 JSON，这里不重算）。
 * @param groups 这一份。
 * @param previous 上一份；没有给 []。
 */
export function getBytes(groups: StateGroup[], previous: StateGroup[] = []): number {
  let bytes = 0;
  for (const item of groups) {
    if (previous.includes(item)) continue;

    bytes += Buffer.byteLength(JSON_OF.get(item) ?? '', 'utf8');
  }
  return bytes;
}


/**
 * 比差异：两份 walkState 交出的值，哪些地方变了。同一个对象（沿用的组）直接跳过。
 * @param before 上一份。
 * @param after 这一份。
 * @param at 走到哪了：一串键名，顶层 []。
 * @param out 收结果的地方。
 * @returns 变了的地方，每处是一串键名（列表的下标也写成字）；多了、少了、改了都算，多了少了只报它自己那一层。
 */
export function getDiff(before: unknown, after: unknown, at: string[] = [], out: string[][] = []): string[][] {
  if (before === after) return out;

  const nested = typeof before === 'object' && before !== null
    && typeof after === 'object' && after !== null
    && Array.isArray(before) === Array.isArray(after);
  if (!nested) {
    out.push(at);
    return out;
  }

  //M 两边的键合在一起去重，逐个往下比。
  const older = before as Record<string, unknown>;
  const newer = after as Record<string, unknown>;
  const names = new Set([...Object.keys(older), ...Object.keys(newer)]);
  for (const name of names) {
    const childAt = [...at, name];
    getDiff(older[name], newer[name], childAt, out);
  }
  return out;
}
