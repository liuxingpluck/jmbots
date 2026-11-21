/**
 * 运行时变量的快照：骨架三个服务和每个插件提供的服务对象，连私有字段一起全量读出来，给教程页右栏「运行时变量」。
 * 这是调试用的（CLAUDE.md：调试插件一律全量原样显示），不打码、不截断、不限层数；只有三样不往里读：
 * 绕回来的写 [循环]，函数写 ƒ 名字，Cordis 的 ctx、数据库连接、网络连接、Fastify 这类外部资源对象写 [类名]。
 * 启动每一步（Boot.ts）和带快照关键词的消息每一步（State.ts）都用这里；底层遍历与差异对比由同目录 Walk.ts 共用实现。
 * 函数：walkState 遍历，getDiff 比差异，group 读一组，getSnapshot 拼一份，getBytes 估一份新占多少字节。只读不改：不调 getter，不发事件。
 */
import { Buffer } from 'node:buffer';
import * as process from 'node:process';
import type * as cordis from 'cordis';
import * as textModule from '../../utils/Text.ts';
import * as walkModule from './Walk.ts';

export { getDiff } from './Walk.ts';

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

/** 快照全量原样遍历规则：不限字节、不隐藏凭据、不折叠嵌套对象。 */
const SNAPSHOT_RULE: walkModule.WalkRule = { slim: false };

/** 每组的 JSON：拍下一份时和上一份同名的组比，没变就沿用上一份的那组，几百份快照不至于占太多内存。 */
const JSON_OF = new WeakMap<StateGroup, string>();


/**
 * 遍历：把一个值连私有字段全量读成能 JSON 化的样子，原样给，不打码、不截断（转调 Walk.ts 的 walk）。
 * @param value 要读的值；顶层一般是一个服务对象。
 */
export function walkState(value: unknown): unknown {
  return walkModule.walk(value, SNAPSHOT_RULE).value;
}


/**
 * 读一组：读的时候出错不挡别的组，写成 error。和上一份同名的组一样，就沿用上一份的那组（省内存，比差异时一眼跳过）。
 * @param name 组名。
 * @param note 一句人话。
 * @param read 交回这一刻的值；交出去前过 walkModule.walk。
 * @param previous 上一份快照；没有给 []。
 * @param notes 手写的键的中文解释；读出错时换成 error 那一句。
 */
export function group(
  name: string,
  note: string,
  read: () => unknown,
  previous: StateGroup[] = [],
  notes: Record<string, string> = {},
): StateGroup {
  let value: unknown;
  let shown = notes;
  try {
    //M 快照全量原样：不限字节、不省略，任一服务读取报错不拖累整份快照。
    value = walkModule.walk(read(), SNAPSHOT_RULE).value;
  } catch (error) {
    value = { error: textModule.getErrorMessage(error) };
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
  walkModule.markTaken(groups);
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
