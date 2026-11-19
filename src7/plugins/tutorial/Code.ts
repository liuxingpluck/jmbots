/**
 * 教程页「代码」「试一试」两个标签要的数据：一个插件的对外函数、HTTP 接口、模型工具。
 * 都不手写清单，各从实际的东西里认：
 *   对外函数：读插件文件夹里每个 .ts（不含测试）顶层的 export function / export class，附上它上方注释的第一句；
 *   HTTP 接口：问 http 插件登记簿（http/Routes.ts）实际登记过哪些路径，按登记它的插件文件夹分；
 *   模型工具：Boot.ts 记的“挂插件那一刻多出来的工具”，在插件文件夹里找 name: '工具名' 那一行当位置。
 * 点一项看实现、谁调它：页面用 /api/tutorial/source（Source.ts）按“文件:行号”取，不在这里另写一份。
 */
import type * as cordis from 'cordis';
import * as sourceDirModule from '../../utils/SourceDir.ts';
import * as skeletonModule from './Skeleton.ts';
import * as sourceModule from './Source.ts';
import { getFolder } from './Boot.ts';
import type { RouteInfo } from '../http/Routes.ts';


/** 一个对外函数（或类）。 */
export interface FunctionItem {
  /** 名字。 */
  name: string;
  /** function 或 class。 */
  kind: string;
  /** 文件:行号。 */
  site: string;
  /** 上方注释的第一句；没写是空串。 */
  summary: string;
}


/** 谁调了这个接口：src7 里写了这条路径的地方。 */
export interface UrlCaller {
  /** 文件:行号。 */
  site: string;
  /** 那一行代码。 */
  code: string;
  /** 上方 //M 注释；没写是空串。 */
  why: string;
}


/** 一个 HTTP 接口。 */
export interface RouteItem {
  /** 方法，大写。 */
  method: string;
  /** 路径，可能带 :参数。 */
  url: string;
  /** 登记那一句的位置：文件:行号；认不出是谁登记的是空串。 */
  site: string;
  /** 登记它的插件文件夹；认不出是空串。 */
  owner: string;
  /** src7 里谁写了这条路径（调它的代码）；网页那边的调用不在这里。 */
  callers: UrlCaller[];
}


/** 一个模型工具。 */
export interface ToolItem {
  /** 工具名（给模型看的）。 */
  name: string;
  /** 给模型看的说明第一句。 */
  summary: string;
  /** 实现的位置：文件:行号；找不到是空串。 */
  site: string;
  /** 给哪几种会话用。 */
  kinds: string[];
}


/** 「代码」「试一试」的数据。 */
export interface PluginCodeInfo {
  /** 对外函数。 */
  functions: FunctionItem[];
  /** 这个插件登记的接口。 */
  routes: RouteItem[];
  /** 这个插件登记的工具。 */
  tools: ToolItem[];
  /** 认不出是哪个插件登记的接口（原因见 http/Routes.ts 文件头），归在“其他”。 */
  others: RouteItem[];
}


/** 工具登记表里一项要用到的部分（Tools.ts 的 ToolSpec；specs 是私有字段，读法同 Boot.ts）。 */
interface ToolSpecLike {
  definition: { name: string; description?: string };
  sessionKinds: string[];
}

/** 顶层 export function / export class。 */
const EXPORTED = /^export\s+(?:async\s+)?(function|class)\s*\*?\s*([\w$]+)/u;


/** 取一个插件的代码信息。 */
export class PluginCode {
  /**
   * @param ctx tutorial 的 ctx：取 http（登记簿）、tools（登记表）。
   * @param source 读源码（和别处共用一份缓存）。
   * @param toolOwners 工具名 → 登记它的插件名（Boot.ts）。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly source: sourceModule.SourceDocs,
    private readonly toolOwners: Map<string, string>,
  ) {}

  /**
   * 一个插件的对外函数、接口、工具，加上认不出归属的接口。
   * @param plugin 插件名（config.yaml 里的名字）；文件夹名按 getFolder 换。
   */
  async getCode(plugin: string): Promise<PluginCodeInfo> {
    //M 骨架模块直接从骨架与 utils 源码抽取导出符号，接口与工具均为空，只保留未归属接口。
    if (skeletonModule.isSkeleton(plugin)) {
      const functions = await skeletonModule.getSkeletonFunctions(plugin, this.source);
      const all = await this.getRoutes();
      const others = all.filter((item) => item.owner === '');
      return { functions, routes: [], tools: [], others };
    }

    //M 先把配置里的插件名折算成磁盘目录，再并齐该插件的函数、接口与工具清单。
    const folder = getFolder(plugin);
    const functions = await this.getFunctions(folder);
    const all = await this.getRoutes();
    const routes = all.filter((item) => item.owner === folder);
    const others = all.filter((item) => item.owner === '');
    const tools = await this.getTools(plugin, folder);
    return { functions, routes, tools, others };
  }

  /**
   * 插件文件夹里顶层 export 的函数和类。
   * @param folder 插件文件夹名。
   */
  private async getFunctions(folder: string): Promise<FunctionItem[]> {
    const items: FunctionItem[] = [];
    const prefix = `${sourceDirModule.SOURCE_PREFIX}plugins/${folder}/`;
    //M 从源码缓存索引列出全库源码，只挑属于当前插件文件夹的文件提取顶层导出声明。
    const files = await this.source.getSourceFiles();
    for (const file of files) {
      if (!file.startsWith(prefix)) continue;

      //M 读入源码行数组，准备正则扫描顶层导出函数与类。
      const lines = await this.source.read(file);
      if (lines === undefined) continue;

      //M 扫描顶层 export function / export class，提取上方一行摘要与定义位置。
      for (let index = 0; index < lines.length; index++) {
        const found = EXPORTED.exec(lines[index] ?? '');
        if (found === null) continue;

        //M 截取定义正上方 JSDoc 首句作为该导出符号的一句话说明。
        const summary = this.getSummary(lines, index);
        const site = `${file}:${String(index + 1)}`;
        items.push({ name: found[2] ?? '', kind: found[1] ?? '', site, summary });
      }
    }
    return items;
  }

  /**
   * 定义那一行上方注释的第一句。
   * @param lines 整个文件。
   * @param index 定义那一行的下标。
   * @returns 没写注释是空串。
   */
  private getSummary(lines: string[], index: number): string {
    //M 取出贴在定义行上方的 JSDoc 块并摘出首句作为教程卡片简介。
    const block = sourceModule.getBlockAbove(lines, index);
    if (block === undefined) return '';

    //M 拆解 JSDoc 区块并截取 summary 第一句供代码条目副标题显示。
    const parsed = sourceModule.splitDoc(block);
    return sourceModule.getFirstSentence(parsed.summary);
  }

  /**
   * http 插件登记簿里的全部接口，各带 src7 里谁写了这条路径。登记簿没有（http 没挂）是空的。
   */
  private async getRoutes(): Promise<RouteItem[]> {
    //M 按需现取 http 服务登记簿（没挂 http 插件时视为空清单），逐个接口检索 src7 内的路由字符串引用处。
    const http = this.ctx.get('http');
    const list: RouteInfo[] = http?.routes ?? [];
    const items: RouteItem[] = [];
    for (const route of list) {
      const callers = await this.getUrlCallers(route.url, route.site);
      items.push({ method: route.method, url: route.url, site: route.site, owner: route.owner, callers });
    }
    return items;
  }

  /**
   * src7 里哪些行写了这条路径（带引号的，如 '/api/x' 或 `/api/x?…`）。登记那一句本身不算。
   * @param url 路径。
   * @param registered 登记那一句的位置（文件:行号），不算调用。
   */
  private async getUrlCallers(url: string, registered: string): Promise<UrlCaller[]> {
    const callers: UrlCaller[] = [];
    //M 挨个读 src7 源码，查找用引号引用该接口 URL 的位置（跳过路由注册那一行本身）。
    const files = await this.source.getSourceFiles();
    for (const file of files) {
      const lines = await this.source.read(file);
      if (lines === undefined) continue;

      lines.forEach((text, index) => {
        const site = `${file}:${String(index + 1)}`;
        if (site === registered) return;

        //G 路径紧跟在引号后面才算（避免 /api/a 误中 /api/ab）；后面是引号、问号、斜杠、反引号之外的不算。
        const at = text.indexOf(url);
        if (at < 1) return;

        const before = text[at - 1] ?? '';
        const after = text[at + url.length] ?? '';
        if (!`'"\``.includes(before)) return;
        if (after !== '' && !`'"\`?`.includes(after)) return;

        //M 命中 URL 调用行后顺带读出紧贴上方的 //M/G/T 注释说明为何调用。
        callers.push({ site, code: text.trim(), why: sourceModule.getWhyAbove(lines, index) });
      });
    }
    return callers;
  }

  /**
   * 这个插件登记的工具：名字、说明、位置。
   * @param plugin 插件名。
   * @param folder 插件文件夹名。
   */
  private async getTools(plugin: string, folder: string): Promise<ToolItem[]> {
    //M 现取 tools 登记表（测试环境下可能未挂），按 Boot 记住的归属插件找出各工具。
    const tools = this.ctx.get('tools');
    const specs = tools?.['specs'] as Map<string, ToolSpecLike> | undefined;
    const items: ToolItem[] = [];
    if (specs === undefined) return items;

    for (const [toolName, owner] of this.toolOwners) {
      if (owner !== plugin) continue;

      //M 从工具服务登记表取出当前工具的定义与分组标签，跳过已注销的条目。
      const spec = specs.get(toolName);
      if (spec === undefined) continue;

      //M 提取工具实现行号与一句话描述，供教程页「试一试/工具」展示。
      const site = await this.getToolSite(folder, toolName);
      const summary = sourceModule.getFirstSentence(spec.definition.description ?? '');
      items.push({ name: toolName, summary, site, kinds: spec.sessionKinds });
    }
    return items;
  }

  /**
   * 工具的实现在哪：插件文件夹里第一处写了 name: '工具名' 的行；它后面 80 行内的 run 那一行更准，有就用它。
   * @param folder 插件文件夹名。
   * @param toolName 工具名。
   * @returns 找不到是空串。
   */
  private async getToolSite(folder: string, toolName: string): Promise<string> {
    const prefix = `${sourceDirModule.SOURCE_PREFIX}plugins/${folder}/`;
    const named = new RegExp(`name\\s*:\\s*['"\`]${toolName}['"\`]`, 'u');
    //M 列出全库源码并只扫描当前插件文件夹下的文件，定位工具声明和 run 入口行。
    const files = await this.source.getSourceFiles();
    for (const file of files) {
      if (!file.startsWith(prefix)) continue;

      //M 读取插件源码全文以搜索对应工具声明行。
      const lines = await this.source.read(file);
      if (lines === undefined) continue;

      const at = lines.findIndex((text) => named.test(text));
      if (at < 0) continue;

      //M 往后找 run：没找到就用 name 那一行。
      const window = lines.slice(at, at + 80);
      const run = window.findIndex((text) => /^\s*(?:async\s+)?run\s*[(:]/u.test(text));
      if (run < 0) return `${file}:${String(at + 1)}`;

      return `${file}:${String(at + run + 1)}`;
    }
    return '';
  }
}
