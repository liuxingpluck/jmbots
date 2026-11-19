/**
 * 教程插件 tutorial：一个页面看懂每个插件、每条流程。11-17 由 flow（画布、运行时变量、快照）、boot-trail（录启动）、trace（打印执行路径）合成。
 * 要写在 config.yaml plugins 段的第一个：录启动要赶上后面每个插件开始挂（Boot.ts）。所以只 inject 骨架的 resources、sessions，
 * HTTP 接口等 http 插件起来后再登记（ctx.inject(['http'])）。
 * 几块各在哪个文件：
 *   Boot.ts   录这次启动：每个插件挂了多久、多出哪些服务和工具、每步的快照；
 *   State.ts  带快照关键词（默认 #调试）的消息，每个事件拍一份运行时变量；
 *   Files.ts  快照写成 data/flow/boot.json、<消息号>.json，左栏「画布」读的就是这些文件；
 *   Lanes.ts  把轨迹摆成泳道图；跟踪行、录下的启动 → 一步一步在 journal/Trail.ts（消息的问 journal 要，启动的直接调）；
 *   Source.ts 读源码：注释、函数源码、谁调它，和插件的 说明.md；
 *   Print.ts  控制台打印执行路径（原 trace 插件），配置 trace_console 打开。
 * 页面 /tutorial/ 由 web 插件按约定托管（dist/web/tutorial.html，源码 web/src/Tutorial/）；/flow/ 跳到 /tutorial/。接口：
 *   GET /api/tutorial/plugins               左栏插件：名字、版本、挂没挂上、有没有说明，加快照关键词、源码根目录
 *   GET /api/tutorial/readme?name=          插件的 说明.md 原文；还没写是空串
 *   GET /api/tutorial/state?name=           这个插件现在的运行时变量：它提供的服务对象，加它用 ctx.flow.state 登记的，全量原样
 *   GET /api/tutorial/canvases              左栏画布：启动流程，加 data/flow/ 里每条带关键词的消息
 *   GET /api/tutorial/canvas?name=          一张画布：轨迹和泳道图（name 是 boot 或消息号）
 *   GET /api/tutorial/snapshot?name=&step=  画布上点中一步时那一刻的运行时变量，和上一步比变了哪些
 *   GET /api/tutorial/code?name=            「代码」「试一试」：这个插件的对外函数、登记的 HTTP 接口、模型工具，加认不出归属的接口（Code.ts）
 *   GET /api/tutorial/source?file=&line=    “看实现”：这一行所在函数的完整源码、里面调到的函数、谁调它
 * 提供服务 flow（名字沿用，relay、web-api 在用）：别的插件用 ctx.flow.state(名字, 取值函数) 露自己的运行时变量；
 *   不走 bot/receive 的路用 ctx.flow.mark 认快照关键词。是可选依赖，接法见 FlowState。
 */
import type * as cordis from 'cordis';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as sourceDirModule from '../../utils/SourceDir.ts';
import * as snapshotModule from './Snapshot.ts';
import type * as pluginIndex from '../Index.ts';
import * as bootModule from './Boot.ts';
import * as codeModule from './Code.ts';
import * as filesModule from './Files.ts';
import * as lanesModule from './Lanes.ts';
import * as printModule from './Print.ts';
import * as skeletonModule from './Skeleton.ts';
import * as sourceModule from './Source.ts';
import * as stateModule from './State.ts';
import * as trailModule from '../journal/Trail.ts';


declare module 'cordis' {
  interface Context {
    /** tutorial 插件给别的插件露运行时变量的口子（名字沿用原来的 flow 插件），实现在本文件的 Tutorial。可选依赖，用 ctx.inject(['flow'], …) 接。 */
    flow: FlowState;
  }
  interface Events {
    /**
     * 通知：插件露自己的运行时变量（和 ctx.flow.state 一样，只是不用 inject flow；契约 3.2 第 12 条）。本插件听，没挂 tutorial 就没人听、什么也不发生。
     * 带 read 是登记（同名再登记换掉旧的）；不带 read 是注销那一组（插件被拔掉时在 ctx.effect 里发）。
     * 谁发：暂无
     * 谁接：src7/plugins/tutorial/index.ts 的 Tutorial.constructor
     */
    'flow/state'(notice: FlowStateNotice): void;
  }
}


/** 事件 flow/state 的数据。 */
export interface FlowStateNotice {
  /** 组名，写插件名：「状态」标签按它归到那个插件下面。 */
  name: string;
  /** 交回这一刻的状态；不给就是注销这一组。 */
  read?: () => Record<string, unknown>;
  /** 键的中文解释：英文键 → 解释。 */
  notes?: Record<string, string>;
}


/**
 * ctx.flow：插件登记自己的运行时变量，教程页「状态」标签每次刷新现调。
 * 接法（tutorial 没挂时什么都不发生）：
 *   void ctx.inject(['flow'], (sub) => { sub.effect(() => sub.flow.state('名字', () => 对象)); });
 */
export interface FlowState {
  /**
   * 登记一组。
   * @param name 组名，写插件名：「状态」标签按它归到那个插件下面。
   * @param read 交回这一刻的状态；键用英文（代码里的名字），交给网页前过 plugins/tutorial/Snapshot.ts 的 walkState 全量读出（不打码）。
   * @param notes 键的中文解释：英文键 → 解释；网页在那一行后面灰字显示。
   * @returns 撤掉登记的函数：放进 ctx.effect，插件被拔掉时自动撤。
   */
  state(name: string, read: () => unknown, notes?: Record<string, string>): () => void;

  /**
   * 话交给一场已有会话之前（不走 bot/receive 的路，比如 web-api 接着某场会话发）认快照关键词。
   * 实现在 State.ts 的 Shots.mark，和 bot/receive 那处共用一个判断（Shots.strip）。
   * @param text 用户的话。
   * @param sessionId 交给哪一场。
   * @returns 去掉关键词的话（带了就记下这场会话要拍）；不带原样交回。
   */
  mark(text: string, sessionId: string): string;
}


/** 插件名。 */
export const name = 'tutorial';

//M 版本号：改了对外的接口、页面、配置就往上加。
/** 版本号。 */
//M 1.1.8：运行时变量快照（Snapshot.ts）从骨架 utils/ 挪进本插件，只有 tutorial 用。
//M 1.1.10：Trail.ts 挪进 journal（journal/Trail.ts）；消息的轨迹改发 journal/request 的 trail 要现成的，不再自己取行再收。
export const version = '1.1.11';

/** 用到的服务：都是骨架的，tutorial 排第一个挂时已经有了。http、journal 是可选的，用到时现取。 */
export const inject = ['resources', 'sessions'];


/** tutorial 的配置：config.yaml plugins 段里它的 config，每一项都可以不写。 */
export interface TutorialConfig {
  /** 用户的话里带它才给这条消息拍运行时快照（拍完从话里去掉，模型看不到）。不写是 #调试，不能是空串。 */
  snapshot_keyword?: unknown;
  /** 运行时快照加起来最多占多少 MB（按 JSON 字节数估），超了从最旧的扔。不写是 200，要是正数。 */
  snapshot_max_mb?: unknown;
  /** data/flow/ 里消息快照文件留几个（boot.json 不算），多了删最旧的。不写是 20，要是正整数。 */
  snapshot_files?: unknown;
  /** 「会话」左栏从 journal 按消息号去重最多列最近几条消息。不写是 50，要是正整数。 */
  recent_messages?: unknown;
  /** 源码根目录，给「在 VS Code 里打开」拼路径用。不写就从运行时目录往上找放着源码根目录（src7/Main.ts）的那一层，要是字符串。 */
  workspace?: unknown;
  /** 控制台打印执行路径（原 trace 插件）。不写是 false。 */
  trace_console?: unknown;
  /** 执行路径同时写到运行时目录 trace/ 下当天的文件。不写是 false。 */
  trace_file?: unknown;
  /** 打印时一个变量、一段话最多打多少字。不写是 200，要是正整数。 */
  trace_var_limit?: unknown;
}


/** 校验过的配置。 */
interface Settings {
  /** 快照关键词。 */
  keyword: string;
  /** 快照加起来最多占多少字节。 */
  maxBytes: number;
  /** 消息快照文件留几个。 */
  keep: number;
  /** 「会话」左栏最近消息最多列几条。 */
  recentMessages: number;
  /** 配置里写的源码根目录；没写是空串。 */
  workspace: string;
  /** 打印的配置。 */
  print: printModule.PrintConfig;
}


/** 「会话」左栏列表的一项（不限是否带快照关键词）。 */
export interface MessageCanvasItem {
  /** 消息号（字符串）。 */
  name: string;
  /** 消息收到或文件写入时刻，毫秒时间戳。 */
  at: number;
  /** 用户那句话；没记到是空串。 */
  preview: string;
  /** 渠道名（方便左栏标出飞书/网页与搜索过滤）。 */
  channel?: string;
  /** 目标机器人名。 */
  bot?: string;
  /** 这条消息有没有运行时变量快照（磁盘文件或内存还在）。 */
  hasSnapshot: boolean;
}


/** 左栏插件列表的一项。 */
interface PluginItem {
  /** config.yaml 里的名字（没挂的自带插件是名单里的名字）。 */
  name: string;
  /** 插件 index.ts 导出的 version；外部插件、还没写的是空串。 */
  version: string;
  /** ok 挂上开工了，failed 没挂上，waiting 挂了但缺服务没开工，idle 配置里没挂。 */
  state: string;
  /** 没挂上的原因；缺服务时写缺谁。 */
  error: string;
  /** 它声明要的服务。 */
  inject: string[];
  /** 有没有 说明.md。 */
  hasReadme: boolean;
  /** skeleton 系统自带骨架模块，plugin 普通插件。 */
  kind: 'skeleton' | 'plugin';
}


/** Fastify 路由的查询参数。 */
type Query = { Querystring: Record<string, string | undefined> };

/** 不写 snapshot_keyword 时的关键词。 */
const DEFAULT_KEYWORD = '#调试';

/** 不写 snapshot_max_mb 时的上限，MB。 */
const DEFAULT_MAX_MB = 200;

/** 不写 snapshot_files 时留几个消息文件。 */
const DEFAULT_FILES = 20;

/** 不写 recent_messages 时「会话」列表默认列几条最近消息。 */
const DEFAULT_RECENT_MESSAGES = 50;

/** 为最近消息补预览时最多扫几行流水。 */
const PREVIEW_SCAN_LINES = 50;

/** 不写 trace_var_limit 时一个值最多打几个字。 */
const DEFAULT_VAR_LIMIT = 200;

/** 画布名：boot 或消息号。 */
const CANVAS_NAME = /^(?:boot|\d+)$/u;

/** 插件名：小写字母开头，字母、数字、横线。 */
const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/u;


/**
 * 一个插件的 说明.md 在代码目录里的位置。
 * @param plugin 插件名。
 */
function getReadmeFile(plugin: string): string {
  //M 解析别名插件对应的实际源码目录名，再拼接出该插件的说明文档相对路径。
  const folder = bootModule.getFolder(plugin);
  return `${sourceDirModule.SOURCE_PREFIX}plugins/${folder}/说明.md`;
}


/**
 * 自带插件名单（plugins/Index.ts 的 BUILT_IN）。用到时才 import：Index.ts 静态 import 了本文件，
 * 本文件再静态 import 它就成了环，先加载本文件时（测试里）Index.ts 登记完查版本号会读到还没初始化的 version。
 */
async function getBuiltIn(): Promise<Record<string, pluginIndex.PluginModule>> {
  const loaded = await import('../Index.ts');
  return loaded.BUILT_IN;
}


/**
 * 一个自带插件导出的 version。还没写的是空串。
 * @param plugin 自带名单里的模块；外部插件是 undefined。
 */
function getVersion(plugin: pluginIndex.PluginModule | undefined): string {
  const exported = (plugin as { version?: unknown } | undefined)?.version;
  if (typeof exported === 'string') return exported;

  return '';
}


/**
 * 原来 /flow/ 的地址换成 /tutorial/，查询参数原样带上。
 * @param url 请求的地址，如 /flow/?message=5。
 * @returns 如 /tutorial/?message=5。
 */
function getTutorialUrl(url: string): string {
  const at = url.indexOf('?');
  if (at < 0) return '/tutorial/';

  const search = url.slice(at);
  return `/tutorial/${search}`;
}


/**
 * 找出源码根目录（「在 VS Code 里打开」拼路径用）：配置优先，否则从运行时目录往上找带 src7/Main.ts 的那一层，再看当前目录。
 * @param configured 配置里写的路径，没写是空串。
 * @param start 开始往上找的目录（运行时目录）。
 * @returns 找不到是空串，页面就不显示那个按钮。
 */
export function getWorkspace(configured: string, start: string): string {
  //M 配置里写了、确实是源码目录：用它。
  const trimmed = configured.trim();
  if (trimmed !== '' && isWorkspace(trimmed)) return path.resolve(trimmed);

  //M 从运行时目录往上找几层。源码和运行时分开放的（正式运行），在配置 tutorial.workspace 里写源码目录，不按目录名去猜。
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (isWorkspace(dir)) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) break;

    dir = parent;
  }

  //M 源码模式下当前目录就是源码目录。
  const cwd = path.resolve(process.cwd());
  if (isWorkspace(cwd)) return cwd;

  return '';
}


/**
 * 这个目录是不是仓库根目录：里面有 <源码根目录名>/Main.ts（源码根目录名见 src7/utils/SourceDir.ts）。
 * @param dir 目录。
 */
function isWorkspace(dir: string): boolean {
  const main = path.join(dir, sourceDirModule.SOURCE_DIR, 'Main.ts');
  return fs.existsSync(main);
}


/** 教程插件：录启动、拍快照、打印，提供 flow 服务，登记页面要的接口。 */
class Tutorial {
  /** 快照文件。 */
  private readonly files: filesModule.FlowFiles;

  /** 这次启动的轨迹。 */
  private readonly boot: bootModule.BootTrail;

  /** 带关键词的消息的快照。 */
  private readonly shots: stateModule.Shots;

  /** 插件用 ctx.flow.state 登记的取值函数：组名 → 取值函数和键的解释。 */
  private readonly registered = new Map<string, { read: () => unknown; notes: Record<string, string> }>();

  /** 源码根目录；找不到是空串。 */
  private readonly workspace: string;

  /** 「代码」「试一试」标签的数据。 */
  private readonly code: codeModule.PluginCode;

  /**
   * 先建录启动的（要赶上后面的插件），再建快照、打印，提供 flow 服务，等 http 起来登记接口。
   * @param ctx tutorial 的 ctx。
   * @param settings apply 校验过的配置。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly settings: Settings,
  ) {
    //M 录启动、拍快照、写文件三块：文件先建，另外两块写文件要用它。
    this.files = new filesModule.FlowFiles(ctx, settings.keep);
    this.boot = new bootModule.BootTrail(ctx, this.files);
    this.shots = new stateModule.Shots(ctx, settings.keyword, settings.maxBytes, this.files);
    this.workspace = getWorkspace(settings.workspace, ctx.resources.root);
    this.code = new codeModule.PluginCode(ctx, this.boot.source, this.boot.toolOwners);

    //M 打印：控制台、文件都没开就不挂监听，省得每个事件都拼一行。
    const print = settings.print;
    if (print.console || print.file) {
      new printModule.Printer(ctx, print);
    }

    //M 提供 ctx.flow：插件登记的取值函数放在 registered，「状态」标签现调；mark 给不走 bot/receive 的路认快照关键词。
    const flow: FlowState = {
      state: (groupName, read, notes = {}) => this.addState(groupName, read, notes),
      mark: (text, sessionId) => this.shots.mark(text, sessionId),
    };
    ctx.provide('flow', flow);

    //M 通知 flow/state（契约 3.2 第 12 条）：和 ctx.flow.state 并存，插件不用 inject flow 也能露变量；不带 read 是注销那一组。
    ctx.on('flow/state', (notice) => this.onFlowState(notice));

    //M 接口：http 插件挂上（排在 tutorial 后面）以后再登记。
    void ctx.inject(['http'], (sub) => {
      this.addRoutes(sub);
    });
  }

  /**
   * ctx.flow.state 的实现：登记一组。
   * @param groupName 组名。
   * @param read 取值函数。
   * @param notes 键的中文解释。
   * @returns 撤掉这次登记的函数。
   */
  private addState(groupName: string, read: () => unknown, notes: Record<string, string>): () => void {
    //M 登记该插件状态读取回调，供每次打开「状态」页签时现调现算。
    this.registered.set(groupName, { read, notes });
    return () => {
      //M 仅当当前槽位仍指向本次登记的 read 回调时才撤销，防止误删后续重挂的新插件记录。
      const now = this.registered.get(groupName);
      if (now?.read === read) {
        this.registered.delete(groupName);
      }
    };
  }

  /**
   * 响应通知 flow/state：带 read 登记一组（同 addState，同名换掉旧的），不带 read 注销那一组。
   * @param notice 组名、取值函数、键的解释。
   */
  private onFlowState(notice: FlowStateNotice): void {
    //M 不带 read：发通知的插件被拔掉了，按组名撤掉。
    if (notice.read === undefined) {
      this.registered.delete(notice.name);
      return;
    }

    //M 带 read：登记成一组，「状态」标签现调。撤销靠注销通知，不用 addState 交回的函数。
    const notes = notice.notes ?? {};
    this.addState(notice.name, notice.read, notes);
  }

  /**
   * 登记页面要的接口，和 /flow/ 的跳转。
   * @param sub ctx.inject(['http']) 交来的 ctx，从它取 http 插件的 Fastify。
   */
  private addRoutes(sub: cordis.Context): void {
    const app = sub.http.app;

    //M 原来的 /flow/（主网页的事件面板还开它）跳到 /tutorial/，带着原来的查询参数。
    app.get('/flow', (request, reply) => reply.redirect(getTutorialUrl(request.url)));
    app.get('/flow/', (request, reply) => reply.redirect(getTutorialUrl(request.url)));

    //M 登记左栏插件列表接口，返回所有启用及内置未启用插件元数据。
    app.get('/api/tutorial/plugins', async () => {
      //M 查询左栏插件清单，并附带快照关键词与工作区路径供页面跳转 VS Code。
      const list = await this.getPlugins();
      return { list, keyword: this.settings.keyword, workspace: this.workspace };
    });

    //M 登记插件 说明.md 原文读取接口，先校验插件名防止目录穿越。
    app.get<Query>('/api/tutorial/readme', async (request, reply) => {
      //G 外面进来的插件名：只认小写字母、数字、横线，拼进路径前先挡掉 ..、斜杠。
      const plugin = request.query['name'] ?? '';
      if (!PLUGIN_NAME.test(plugin)) return reply.code(400).send({ error: '要给 name（插件名）' });

      //M 系统骨架模块没有磁盘 说明.md，从源码注释与事件声明实时提取说明返回。
      if (skeletonModule.isSkeleton(plugin)) {
        return skeletonModule.getSkeletonReadme(plugin, this.boot.source);
      }

      //M 拼出插件 说明.md 路径并实时读盘返回全文。
      const file = getReadmeFile(plugin);
      const lines = await sourceModule.readLines(file);
      let text = '';
      if (lines !== undefined) {
        text = lines.join('\n');
      }
      return { name: plugin, file, text };
    });

    //M 登记「代码」「试一试」数据接口，返回插件导出的函数、路由和模型工具。
    app.get<Query>('/api/tutorial/code', async (request, reply) => {
      //G 外面进来的插件名：只认小写字母、数字、横线。
      const plugin = request.query['name'] ?? '';
      if (!PLUGIN_NAME.test(plugin)) return reply.code(400).send({ error: '要给 name（插件名）' });

      //M 返回该插件对外函数、注册路由及模型工具的代码索引。
      return this.code.getCode(plugin);
    });

    //M 登记运行时变量快照接口，按插件名即时采集当前状态分组。
    app.get<Query>('/api/tutorial/state', async (request) => {
      //M 现拍指定插件此刻的运行时变量分组与字段注释表。
      const plugin = request.query['name'] ?? '';
      const groups = await this.getState(plugin);
      return { at: Date.now(), groups };
    });

    //M 登记左栏画布列表接口，汇总启动流程、已保存快照及最近全部消息。
    app.get('/api/tutorial/canvases', async () => {
      //M 读取启动流程、已保存快照及近期全量消息列表，返回左栏画布清单。
      const { list, messages } = await this.getCanvases();
      return { list, messages, keyword: this.settings.keyword };
    });

    //M 登记单张画布查询接口，返回轨迹步骤与泳道图网格结构。
    app.get<Query>('/api/tutorial/canvas', async (request, reply) => {
      //G 外面进来的画布名：boot 或消息号。
      const canvas = request.query['name'] ?? '';
      if (!CANVAS_NAME.test(canvas)) return reply.code(400).send({ error: '要给 name（boot 或消息号）' });

      //M 读取或现算对应轨迹，不存在则报 404，否则展开成泳道图数据结构。
      const trail = await this.getTrail(canvas);
      if (trail === undefined) return reply.code(404).send({ error: `没有画布 ${canvas}：快照文件没有，跟踪行里也没有（没挂 journal，或过期删了）` });

      //M 将按时间串行的步骤摆进道与阶段列生成泳道图。
      const lanes = lanesModule.getLanes(trail);
      return { trail, lanes };
    });

    //M 登记步骤快照查询接口，读取画布上指定步骤那一刻的运行时变量。
    app.get<Query>('/api/tutorial/snapshot', async (request, reply) => {
      //G 画布名和第几步。
      const canvas = request.query['name'] ?? '';
      const no = Number.parseInt(request.query['step'] ?? '', 10);
      if (!CANVAS_NAME.test(canvas)) return reply.code(400).send({ error: '要给 name（boot 或消息号）' });
      if (!Number.isSafeInteger(no) || no < 1) return reply.code(400).send({ error: '要给 step（第几步，从 1 起）' });

      //M 取出该画布指定步骤的运行时变量快照并对比上一步变化。
      const shot = await this.getSnapshot(canvas, no);
      if (shot === undefined) {
        const why = `这一步没有快照：消息没带 ${this.settings.keyword}，或运行时的快照被挤掉了（只留最近 ${String(stateModule.SHOTS_MAX)} 份）`;
        return reply.code(404).send({ error: why });
      }
      return shot;
    });

    //M 登记源码查看接口，支持按文件路径和行号返回完整函数体及上下游调用。
    app.get<Query>('/api/tutorial/source', async (request, reply) => {
      //G 外面进来的文件名：位置可能带着前面的目录，从最后一处源码根前缀截起（不认 web/ 下面那个）；只认源码根下的 .ts，不许 ..。
      const raw = (request.query['file'] ?? '').replaceAll('\\', '/');
      const prefix = sourceDirModule.SOURCE_PREFIX;
      const found = sourceDirModule.getSourceStart(raw);
      const from = Math.max(found, 0);
      const file = raw.slice(from);
      const rest = file.slice(prefix.length);
      const line = Number.parseInt(request.query['line'] ?? '', 10);
      const fileOk = file.startsWith(prefix) && /^[\w\-./]+\.ts$/u.test(rest) && !file.includes('..');
      const lineOk = Number.isSafeInteger(line) && line >= 1;
      const usage = `要给 file（${prefix} 下的 .ts）和 line（第几行，从 1 起）`;
      if (!fileOk || !lineOk) return reply.code(400).send({ error: usage });

      //M 按文件与行号截取完整函数源码、内部调用及调用方信息。
      const source = await this.boot.source.getSource(file, line);
      if (source === undefined) return reply.code(404).send({ error: `读不到 ${file} 第 ${String(line)} 行` });

      return source;
    });
  }

  /**
   * 左栏插件：先是这次照配置挂过的（挂载结果的先后，tutorial 在最前），再是自带名单里没挂的。别名指向同一个模块的只列一次。
   * @returns 每个插件一项。
   */
  private async getPlugins(): Promise<PluginItem[]> {
    //M 初始化结果（先放系统自带的骨架模块），再用去重集合并动态读取自带插件名录表。
    const items: PluginItem[] = [...skeletonModule.getSkeletonItems()];
    const seen = new Set<pluginIndex.PluginModule>();
    const builtIn = await getBuiltIn();

    //M 挂过的：照挂载结果。
    for (const row of this.ctx.resources.pluginStatus) {
      const plugin = builtIn[row.name];
      if (plugin !== undefined) {
        seen.add(plugin);
      }

      //M 状态：没挂上、缺服务、开工了。
      let state = 'ok';
      let error = row.error;
      if (!row.mounted) {
        state = 'failed';
      }
      if (row.mounted && !row.started) {
        state = 'waiting';
        error = `缺 ${row.missing.join('、')}`;
      }

      //M 检查插件是否自带 说明.md，汇总版本号与状态后加入左栏条目。
      const hasReadme = await this.hasReadme(row.name);
      items.push({ name: row.name, version: getVersion(plugin), state, error, inject: row.inject, hasReadme, kind: 'plugin' });
    }

    //M 自带名单里没挂的。
    for (const [pluginName, plugin] of Object.entries(builtIn)) {
      if (seen.has(plugin)) continue;

      seen.add(plugin);
      //M 补充未启用自带插件的文档存在性与依赖清单，标记为 idle。
      const hasReadme = await this.hasReadme(pluginName);
      const inject = plugin.inject ?? [];
      items.push({ name: pluginName, version: getVersion(plugin), state: 'idle', error: '', inject, hasReadme, kind: 'plugin' });
    }
    return items;
  }

  /**
   * 这个插件有没有 说明.md。
   * @param plugin 插件名；外部插件（名字是路径）没有。
   */
  private async hasReadme(plugin: string): Promise<boolean> {
    if (!PLUGIN_NAME.test(plugin)) return false;

    //M 构造该插件 说明.md 路径并试读内容以判断文档是否存在。
    const file = getReadmeFile(plugin);
    const lines = await sourceModule.readLines(file);
    return lines !== undefined;
  }

  /**
   * 一个插件现在的运行时变量：它提供的服务对象各一组，加它用 ctx.flow.state 登记的那组，全量原样。
   * @param plugin 插件名；空串是全部。
   * @returns 各组；这个插件没提供服务、也没登记的是空的。
   */
  private async getState(plugin: string): Promise<snapshotModule.StateGroup[]> {
    //M 服务是谁提供的：服务表里那一项的 fiber 名就是插件导出的 name（wechat-kefu 的是 wechat），这里按它认。
    const builtIn = await getBuiltIn();
    const pluginModule = builtIn[plugin];
    const fiberName = pluginModule?.name ?? plugin;
    const owned = new Set<string>();
    if (skeletonModule.isSkeleton(plugin)) {
      //M 骨架快照在 plugins/tutorial/Snapshot.ts 里固定按小写名字（main/resources/tools/sessions）分组，直接纳入筛选集合。
      owned.add(plugin);
    }
    const store = this.ctx.reflect.store;
    for (const key of Object.getOwnPropertySymbols(store)) {
      const impl = store[key];
      if (impl?.value === undefined) continue;
      if (impl.ctx.fiber.name !== fiberName) continue;

      owned.add(impl.name);
    }

    //M 拍一份，留下这个插件的组；空串是全部。
    const all = snapshotModule.getSnapshot(this.ctx);
    const groups = all.filter((item) => plugin === '' || owned.has(item.name));

    //M 插件自己登记的：组名就是插件名的那组；全部时每组都给。
    for (const [groupName, item] of this.registered) {
      if (plugin !== '' && groupName !== plugin) continue;

      //M 把插件自定义状态读取回调封装成统一快照组结构并追加进结果。
      const note = `插件 ${groupName} 自己露的运行时变量`;
      const group = snapshotModule.group(groupName, note, item.read, [], item.notes);
      groups.push(group);
    }
    return groups;
  }

  /**
   * 画布数据：list 保持 boot + 快照文件消息，messages 列最近 N 条全部消息（不限是否带快照关键词）。
   * @returns list 与 messages。
   */
  private async getCanvases(): Promise<{ list: filesModule.CanvasItem[]; messages: MessageCanvasItem[] }> {
    //M 读取磁盘快照列表，排除启动快照后与本次启动时间戳、近期全量消息清单汇总。
    const fromFiles = await this.files.getList();
    const fileMessages = fromFiles.filter((item) => item.name !== 'boot');
    const lines = await this.boot.getLines();
    const bootAt = lines[0]?.at ?? 0;
    const boot = { name: 'boot', at: bootAt, preview: '' };
    //M 等最近消息和已有快照合成左栏列表。
    const messages = await this.getRecentMessages(fileMessages);
    return { list: [boot, ...fileMessages], messages };
  }

  /**
   * 打开页面时按现有 journal 跟踪行读最近 N 条消息（不改写入，零运行时开销），再并入只有磁盘快照文件的消息。
   * @param fileMessages data/flow/ 里已有快照文件的消息项。
   * @returns 按时刻从新到旧排好的消息清单。
   */
  private async getRecentMessages(fileMessages: filesModule.CanvasItem[]): Promise<MessageCanvasItem[]> {
    const byFile = new Map(fileMessages.map((item) => [item.name, item]));
    const rowLimit = Math.min(this.settings.recentMessages * 2, 1000);
    const limit = String(rowLimit);
    const request = { action: 'query', params: { name: 'web-api/received', limit } } as const;
    const options = {
      timeoutMs: 5000,
      onFallback: () => ({ requestId: '', ok: false, lines: [] }),
    };

    //M 通过事件取最近的收件行。流水缺席时继续用磁盘快照。
    const result = await requestEventModule.requestEvent(this.ctx, 'journal/request', 'journal/result', request, options);
    const received = result.lines ?? [];
    const entries = new Map<string, Promise<MessageCanvasItem>>();

    //M 倒序取最近 N 条不同的消息，同时查询缺少的预览，避免逐条累积等待。
    for (let index = received.length - 1; index >= 0; index -= 1) {
      if (entries.size >= this.settings.recentMessages) break;

      const row = received[index];
      if (row === undefined || typeof row.messageId !== 'number' || !Number.isSafeInteger(row.messageId) || row.messageId <= 0) continue;

      const key = String(row.messageId);
      if (entries.has(key)) continue;

      //M 先认出磁盘或内存已抓拍的消息，保留快照标记。
      const fileItem = byFile.get(key);
      const hasSnapshot = fileItem !== undefined || this.shots.hasMessage(row.messageId);

      //M 文件或内存有抓拍时保留快照标记，再补充用户话、渠道与机器人。
      const summary = this.getMessageSummary(row.messageId, fileItem);
      const pending = summary.then((info) => {
        const entry: MessageCanvasItem = {
          name: key,
          at: row.at,
          preview: info.preview,
          hasSnapshot,
        };
        if (info.channel !== '') {
          entry.channel = info.channel;
        }
        if (info.bot !== '') {
          entry.bot = info.bot;
        }
        return entry;
      });
      entries.set(key, pending);
    }

    const live = await Promise.all(entries.values());
    const byId = new Map(live.map((item) => [item.name, item]));

    //M 补上只有磁盘快照文件、跟踪行已经过期或未挂 journal 的消息。
    for (const item of fileMessages) {
      if (byId.has(item.name)) continue;

      const entry: MessageCanvasItem = {
        name: item.name,
        at: item.at,
        preview: item.preview,
        hasSnapshot: true,
      };
      if (item.channel !== undefined && item.channel !== '') {
        entry.channel = item.channel;
      }
      if (item.bot !== undefined && item.bot !== '') {
        entry.bot = item.bot;
      }
      byId.set(item.name, entry);
    }

    const sorted = [...byId.values()].sort((a, b) => b.at - a.at || Number(b.name) - Number(a.name));
    return sorted.slice(0, this.settings.recentMessages);
  }

  /**
   * 拿一条消息在左栏显示的用户原话、渠道和机器人：快照文件已有直接用，缺项再从 journal 跟踪行里补。
   * @param messageId 收件表消息号。
   * @param fileItem 同号快照文件项。
   */
  private async getMessageSummary(
    messageId: number,
    fileItem?: filesModule.CanvasItem,
  ): Promise<{ preview: string; channel: string; bot: string }> {
    let preview = fileItem?.preview ?? '';
    let channel = fileItem?.channel ?? '';
    let bot = fileItem?.bot ?? '';
    if (preview !== '' && channel !== '' && bot !== '') {
      return { preview, channel, bot };
    }

    //M 磁盘快照文件缺失全部或部分摘要时，按消息号问 journal 要一次轨迹。
    const got = await this.files.getMessageTrail(messageId, PREVIEW_SCAN_LINES);
    if (got === undefined) return { preview, channel, bot };

    //M 轨迹里的原话、渠道、机器人就是这条消息的行里各自第一条带着的，缺哪样补哪样。
    if (preview === '') {
      preview = got.trail.preview;
    }
    if (channel === '') {
      channel = got.trail.channel;
    }
    if (bot === '') {
      bot = got.trail.bot;
    }
    return { preview, channel, bot };
  }

  /**
   * 一张画布的轨迹：启动是这次录下的；消息先读快照文件，没有再从 journal 现算（主网页事件面板跳过来的消息不一定带关键词）。
   * @param canvas boot 或消息号。
   * @returns 都找不到是 undefined。
   */
  private async getTrail(canvas: string): Promise<trailModule.Trail | undefined> {
    //M 启动：这次录下的行。
    if (canvas === 'boot') {
      const lines = await this.boot.getLines();
      return trailModule.getBootTrail(lines, this.boot.notes);
    }

    //M 快照文件：去掉每步快照（很大，点中一步再要），只给轨迹。
    const file = await this.files.getFile(canvas);
    if (file !== undefined) {
      const { snapshots: _snapshots, ...trail } = file;
      return trail;
    }

    //M 没有文件：问 journal 现算。
    const message = Number.parseInt(canvas, 10);
    const got = await this.files.getMessageTrail(message, trailModule.TRAIL_MAX_LINES);
    return got?.trail;
  }

  /**
   * 画布上点中一步时那一刻的运行时变量。
   * @param canvas boot 或消息号。
   * @param no 第几步，从 1 起。
   * @returns 没有这一步、这一步没拍到是 undefined。
   */
  private async getSnapshot(canvas: string, no: number): Promise<filesModule.StepShot | undefined> {
    //M 启动：这次录下的每行各有一份。
    if (canvas === 'boot') {
      const lines = await this.boot.getLines();
      const taken = lines.map((line) => this.boot.getSnapshot(line.id));
      const steps = trailModule.getSteps(lines).steps;
      return filesModule.getStepShot(steps, taken, no);
    }

    //M 快照文件里存好了每步的。
    const file = await this.files.getFile(canvas);
    if (file !== undefined) return file.snapshots[no - 1] ?? undefined;

    //M 还没写成文件（还在跑）：问 journal 要轨迹，和内存里的快照对。
    const message = Number.parseInt(canvas, 10);
    const got = await this.files.getMessageTrail(message, trailModule.TRAIL_MAX_LINES);
    if (got === undefined) return undefined;

    //M journal 挑出的行逐行对回内存快照，按轨迹的步定位第 no 步对应的运行时状态。
    const taken = this.shots.getMatched(got.picked);
    return filesModule.getStepShot(got.trail.steps, taken, no);
  }
}


/**
 * 挂上教程插件。apply 是 Cordis 插件的入口函数：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 等 inject 里的服务都就绪后调一次。
 * 配置是外面进来的，在这里校验一次。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config 见 TutorialConfig；每一项都可以不写。
 * 副作用：开始录启动、拍快照；提供服务 flow；http 起来后登记接口。
 * @throws 配置项写了但类型、范围不对时抛错。
 */
export function apply(ctx: cordis.Context, config: TutorialConfig = {}): void {
  //M 快照关键词：非空字符串。
  const keyword = config.snapshot_keyword ?? DEFAULT_KEYWORD;
  if (typeof keyword !== 'string' || keyword.trim() === '') throw new Error('tutorial 的 snapshot_keyword 要是非空字符串');

  //M 快照上限：正数，MB。
  const maxMb = config.snapshot_max_mb ?? DEFAULT_MAX_MB;
  if (typeof maxMb !== 'number' || !Number.isFinite(maxMb) || maxMb <= 0) throw new Error('tutorial 的 snapshot_max_mb 要是正数');

  //M 留几个消息文件：正整数。
  const keep = config.snapshot_files ?? DEFAULT_FILES;
  if (typeof keep !== 'number' || !Number.isSafeInteger(keep) || keep <= 0) throw new Error('tutorial 的 snapshot_files 要是正整数');

  //M 「会话」画布最近列几条消息：正整数。
  const recentMessages = config.recent_messages ?? DEFAULT_RECENT_MESSAGES;
  if (typeof recentMessages !== 'number' || !Number.isSafeInteger(recentMessages) || recentMessages <= 0) throw new Error('tutorial 的 recent_messages 要是正整数');

  //M 源码根目录：字符串。
  const workspace = config.workspace ?? '';
  if (typeof workspace !== 'string') throw new Error('tutorial 的 workspace 要是字符串');

  //M 打印：两个开关是真假，字数是正整数。
  const traceConsole = config.trace_console ?? false;
  if (typeof traceConsole !== 'boolean') throw new Error('tutorial 的 trace_console 要是 true 或 false');

  const traceFile = config.trace_file ?? false;
  if (typeof traceFile !== 'boolean') throw new Error('tutorial 的 trace_file 要是 true 或 false');

  const varLimit = config.trace_var_limit ?? DEFAULT_VAR_LIMIT;
  if (typeof varLimit !== 'number' || !Number.isSafeInteger(varLimit) || varLimit <= 0) throw new Error('tutorial 的 trace_var_limit 要是正整数');

  const settings: Settings = {
    keyword,
    maxBytes: maxMb * 1024 * 1024,
    keep,
    recentMessages,
    workspace,
    print: { console: traceConsole, file: traceFile, varLimit },
  };
  //M 初始化并启动教程插件主实例（登记状态服务、启动轨迹与 HTTP 接口）。
  new Tutorial(ctx, settings);
}
