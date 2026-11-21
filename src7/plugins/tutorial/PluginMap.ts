/**
 * 插件 X 光图谱（GET /api/tutorial/plugin-map）：每个插件挂没挂、要哪些服务、正在听哪些事件、源码和说明在哪、一句话简介；
 * 再按事件倒排“谁在听、照挂上的先后”，附当前登记的全部工具名。
 * 只读 Cordis 运行时（registry 的插件名、events._hooks 的监听归属）和源码目录里的文件，不改骨架；
 * 插件的 config 一律不碰（里面可能有密钥），只交结构和元信息。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';


/** 一个插件的透视结果。 */
export interface PluginNode {
  /** 插件名（config.yaml 里写的）。 */
  name: string;
  /** 插件导出的 version；没有是空串。 */
  version: string;
  /** 它声明要的服务。 */
  inject: string[];
  /** 它正在听的业务事件（去重排序，不含 internal/*）。 */
  events: string[];
  /** 它听的 internal/* 事件（如 tutorial 听 internal/dispatch）。 */
  internalEvents: string[];
  /** src7/plugins/<名字>/index.ts 在就给相对路径，否则空串。 */
  entryFile: string;
  /** src7/plugins/<名字>/说明.md 在就给相对路径，否则空串。 */
  docFile: string;
  /** 从 说明.md 或 index.ts 文件头取的一句话简介（≤120 字），取不到是空串。 */
  summary: string;
}

/** GET /api/tutorial/plugin-map 的回执。 */
export interface PluginMapResponse {
  /** 成功。 */
  ok: true;
  /** 生成时刻（ISO）。 */
  generatedAt: string;
  /** 插件个数。 */
  totalPlugins: number;
  /** 插件（按名字排序）。 */
  plugins: PluginNode[];
  /** 事件名 → 听它的插件名，照实际挂上的先后。 */
  eventIndex: Record<string, string[]>;
  /** 当前登记的全部工具名（排序）；没挂工具服务是空数组。 */
  toolNames: string[];
}

/** 插件模块里本工具读的两项（version、inject），从插件名录取。 */
export interface PluginInfo {
  /** 插件版本。 */
  version?: string;
  /** 声明要的服务。 */
  inject?: string[] | Record<string, unknown>;
}

/** 简介最多几个字。 */
const SUMMARY_MAX = 120;

/** 拿不到全部工具名时，按这几种会话把工具列出来再合并。 */
const TOOL_KINDS = ['front', 'work'];

/** 简介缓存：文件路径 → 简介（说明改了要重启才更新，和 Source.ts 读源码一样）。 */
const summaryCache = new Map<string, string>();


/**
 * 声明的服务名：inject 可能写成数组，也可能写成 { 服务名: 选项 }。
 * @param inject 插件的 inject。
 * @returns 服务名。
 */
function getInjectNames(inject: PluginInfo['inject']): string[] {
  if (inject === undefined) return [];

  if (Array.isArray(inject)) return [...inject];

  return Object.keys(inject);
}


/**
 * 截到 SUMMARY_MAX 个字。
 * @param text 文字。
 * @returns 截好的文字。
 */
function clip(text: string): string {
  const chars = [...text.trim()];
  if (chars.length <= SUMMARY_MAX) return chars.join('');

  return `${chars.slice(0, SUMMARY_MAX - 1).join('')}…`;
}


/**
 * 从 说明.md 取简介：跳过标题、空行和以版本号开头的改版段落，取第一段正文。
 * @param text 说明原文。
 * @returns 简介；没有是空串。
 */
function getReadmeSummary(text: string): string {
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('>')) continue;

    //G 说明开头常是“1.2.0 改了什么”这样的改版记录，不当简介。
    if (/^\d+\.\d+\.\d+/u.test(line)) continue;

    return clip(line.replace(/^[-*]\s+/u, ''));
  }
  return '';
}


/**
 * 从 index.ts 文件头注释取简介：/** 后第一行有字的注释。
 * @param text 源码原文。
 * @returns 简介；没有是空串。
 */
function getEntrySummary(text: string): string {
  const head = /^\s*\/\*\*([\s\S]*?)\*\//u.exec(text);
  if (head === null) return '';

  for (const raw of head[1]!.split(/\r?\n/u)) {
    const line = raw.replace(/^\s*\*\s?/u, '').trim();
    if (line !== '') return clip(line);
  }
  return '';
}


/**
 * 读一个文件取简介，按路径缓存。
 * @param file 绝对路径。
 * @param pick 从原文取简介的函数。
 * @returns 简介；读不到是空串。
 */
function getCachedSummary(file: string, pick: (text: string) => string): string {
  const cached = summaryCache.get(file);
  if (cached !== undefined) return cached;

  let summary = '';
  try {
    summary = pick(fs.readFileSync(file, 'utf8'));
  } catch {
    //G 读不到（权限、编码）：简介留空，不挡图谱。
  }
  summaryCache.set(file, summary);
  return summary;
}


/**
 * 插件的源码入口、说明和简介。
 * @param name 插件名。
 * @param sourceRoot 源码根目录；空串（编成二进制、没带源码）时三样都给空。
 * @returns 入口相对路径、说明相对路径、简介。
 */
function getFiles(name: string, sourceRoot: string): Pick<PluginNode, 'entryFile' | 'docFile' | 'summary'> {
  if (sourceRoot === '') return { entryFile: '', docFile: '', summary: '' };

  const folder = path.join('src7', 'plugins', name);
  const entry = path.join(folder, 'index.ts');
  const doc = path.join(folder, '说明.md');
  let entryFile = '';
  if (fs.existsSync(path.join(sourceRoot, entry))) {
    entryFile = entry.split(path.sep).join('/');
  }
  let docFile = '';
  if (fs.existsSync(path.join(sourceRoot, doc))) {
    docFile = doc.split(path.sep).join('/');
  }

  //M 简介：说明里有就用说明的，没有再看 index.ts 文件头。
  let summary = '';
  if (docFile !== '') {
    summary = getCachedSummary(path.join(sourceRoot, doc), getReadmeSummary);
  }
  if (summary === '' && entryFile !== '') {
    summary = getCachedSummary(path.join(sourceRoot, entry), getEntrySummary);
  }
  return { entryFile, docFile, summary };
}


/**
 * 全部工具名：工具服务的登记表是 Map 就直接取；以后结构变了，退回按会话种类列出来再合并。
 * @param ctx 插件 ctx。
 * @returns 排好序的工具名。
 */
function getToolNames(ctx: cordis.Context): string[] {
  const tools = ctx.get('tools');
  if (tools === undefined) return [];

  const specs = (tools as unknown as { specs?: unknown }).specs;
  if (specs instanceof Map) return [...specs.keys()].map(String).sort();

  const names = new Set<string>();
  for (const kind of TOOL_KINDS) {
    for (const tool of tools.listToolsForSessionKind(kind)) {
      names.add(tool.name);
    }
  }
  return [...names].sort();
}


/**
 * 透视插件：名单来自 Cordis 注册表，监听来自 events._hooks（每个监听归到登记它的插件），版本和依赖来自插件名录。
 * @param ctx 任意插件的 ctx（registry、events 是全局服务，读的是同一份注册表和事件表）。
 * @param sourceRoot 源码根目录，用来找 index.ts、说明.md；没有源码传空串。
 * @param modules 插件名 → 插件模块（version、inject）；名录里没有的版本给空串、依赖照运行时。
 * @returns 图谱。
 */
export function inspectPluginMap(
  ctx: cordis.Context,
  sourceRoot: string,
  modules: Record<string, PluginInfo>,
): PluginMapResponse {
  //M 插件名单：注册表里每个有名字的运行时；同时记下运行时声明的依赖，名录里没有时用它。
  const runtimeInject = new Map<string, string[]>();
  for (const [, runtime] of ctx.registry.entries()) {
    const name = runtime.name;
    if (typeof name !== 'string' || name === '' || runtimeInject.has(name)) continue;

    //M fibers 是可迭代的列表，取第一个挂载实例的 inject（只读依赖名，不碰 config）。
    const [fiber] = [...runtime.fibers];
    runtimeInject.set(name, getInjectNames(fiber?.inject));
  }

  //M 事件倒排：每个监听取登记它的插件名，照事件表里的先后（就是实际挂上的先后），只收名单里的插件。
  const eventIndex: Record<string, string[]> = {};
  const listened = new Map<string, Set<string>>();
  const hooks = ctx.events._hooks as Record<string, { ctx: cordis.Context }[] | undefined>;
  for (const event of Object.keys(hooks).sort()) {
    const owners: string[] = [];
    for (const hook of hooks[event] ?? []) {
      const owner = hook.ctx.fiber.name;
      if (!runtimeInject.has(owner) || owners.includes(owner)) continue;

      owners.push(owner);
      const set = listened.get(owner) ?? new Set<string>();
      set.add(event);
      listened.set(owner, set);
    }
    if (owners.length > 0) {
      eventIndex[event] = owners;
    }
  }

  //M 拼每个插件：版本、依赖、业务事件和 internal 事件分开、源码和说明。
  const plugins: PluginNode[] = [...runtimeInject.keys()].sort().map((name) => {
    const info = modules[name];
    let inject = runtimeInject.get(name) ?? [];
    if (info?.inject !== undefined) {
      inject = getInjectNames(info.inject);
    }
    const all = [...(listened.get(name) ?? [])].sort();
    return {
      name,
      version: info?.version ?? '',
      inject,
      events: all.filter((event) => !event.startsWith('internal/')),
      internalEvents: all.filter((event) => event.startsWith('internal/')),
      ...getFiles(name, sourceRoot),
    };
  });

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    totalPlugins: plugins.length,
    plugins,
    eventIndex,
    toolNames: getToolNames(ctx),
  };
}


/**
 * 只看一个插件：图谱里只留它，事件倒排只留它听的事件（每个事件的插件顺序照原样）。
 * @param map 完整图谱。
 * @param name 插件名。
 * @returns 只含它的图谱；没有这个插件是 undefined。
 */
export function pickPlugin(map: PluginMapResponse, name: string): PluginMapResponse | undefined {
  const plugin = map.plugins.find((item) => item.name === name);
  if (plugin === undefined) return undefined;

  const eventIndex: Record<string, string[]> = {};
  for (const event of [...plugin.events, ...plugin.internalEvents]) {
    eventIndex[event] = map.eventIndex[event] ?? [];
  }
  return { ...map, totalPlugins: 1, plugins: [plugin], eventIndex };
}
