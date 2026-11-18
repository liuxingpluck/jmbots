/**
 * 录启动：把这次启动走过的路记下来，给教程页「画布 → 启动流程」画泳道图。原来的 boot-trail 插件，11-17 并进 tutorial。
 * tutorial 要写在 config.yaml plugins 段的第一个：Cordis 不补发旧事件，写在后面就漏掉前面的插件。
 * 记什么：
 *   骨架四步（入口读参数、resources、tools、sessions）：tutorial 挂上时已经做完，照当时的结果补记，耗时算不出来；
 *   每个插件：听 Cordis 的 internal/plugin（开始挂）、internal/status（挂好或出错）、internal/service（多了哪个服务）；
 *   ready、接着跑上次没跑完的会话、HTTP 开始监听（跟踪点 Http.listen）。
 * 每一步带“文件:行号”、关键变量（原值，调试用不打码）、那段代码自己的 JSDoc（Source.ts 取）。只存内存，只看这一次启动。
 * 每一步做完还拍一份运行时变量的快照（plugins/tutorial/Snapshot.ts）：骨架四步共用挂上时那份，插件那步是挂好（或出错）那一刻，ready、HTTP 监听各一份。
 * 交出去的行和 journal 的跟踪行同形状（journal/Trail.ts 的 TrailLine），按请求轨迹的办法收成步骤。
 * HTTP 监听那步记完，叫 Files.ts 把整段启动写成 data/flow/boot.json。
 */
import type * as cordis from 'cordis';
import * as sourceDirModule from '../../utils/SourceDir.ts';
import * as snapshotModule from './Snapshot.ts';
import type * as filesModule from './Files.ts';
import * as sourceModule from './Source.ts';
import { FOLDERS } from '../journal/Trail.ts';


/** 一步的关键变量：只放短的字、数、真假。 */
export type Facts = Record<string, string | number | boolean>;


/** 交出去的一行，和 journal/Trail.ts 的 TrailLine 同形状。 */
export interface BootLine {
  /** 第几行，从 1 起。 */
  id: number;
  /** 什么时刻，毫秒时间戳。 */
  at: number;
  /** 都是“函数”：一步对应一段代码。 */
  kind: string;
  /** 函数名或插件名。 */
  name: string;
  /** 听的人：启动轨迹不记，空的。 */
  listeners: string[];
  /** 一句人话：那段代码注释的第一句，取不到用本文件写的一句。 */
  text: string;
  /** 文件:行号，相对代码目录。 */
  site: string;
  /** 启动时没有会话。 */
  sessionId: null;
  /** 启动时没有消息。 */
  messageId: null;
  /** 和 facts 同一份；journal/Trail.ts 认“出错”看这里。 */
  vars: Facts;
  /** 泳道图上的道：main、resources、tools、sessions，或插件名。 */
  node: string;
  /** 关键变量，已经挑过，可以露在网页上。 */
  facts: Facts;
  /** 这一步的函数注释。 */
  docs: sourceModule.CodeDoc[];
}


/** 一份拍下的运行时变量。 */
export interface BootShot {
  /** 什么时刻，毫秒时间戳。 */
  at: number;
  /** 这一刻的运行时变量。 */
  groups: snapshotModule.StateGroup[];
}


/** 记着的一步，读注释前的样子。 */
interface Step {
  /** 泳道图上的道。 */
  node: string;
  /** 函数名或插件名。 */
  name: string;
  /** 取不到注释时的人话。 */
  fallback: string;
  /** 什么时刻，毫秒时间戳。 */
  at: number;
  /** 这一步对应哪一行代码。 */
  site: sourceModule.CodeRef;
  /** 插件那一步：插件入口文件，取它开头那段注释（插件的职责）。 */
  head?: string;
  /** 要取注释的函数。 */
  docs: sourceModule.DocRef[];
  /** 关键变量。 */
  facts: Facts;
  /** 这一步做完时的运行时变量；还没拍（插件还在等服务）是 undefined。 */
  snapshot?: BootShot;
}


/** 源码根目录前缀（src7/utils/SourceDir.ts），下面骨架文件的路径都从它拼。 */
const ROOT = sourceDirModule.SOURCE_PREFIX;

/** 入口文件。 */
const MAIN = `${ROOT}Main.ts`;

/** 检查函数的文件。 */
const CHECKS = `${ROOT}utils/Checks.ts`;

/** 内嵌文件表（认编译版）。 */
const EMBEDDED = `${ROOT}utils/Embedded.ts`;

/** 骨架的资源模块。 */
const RESOURCES = `${ROOT}Resources.ts`;

/** 骨架的工具模块。 */
const TOOLS = `${ROOT}Tools.ts`;

/** 骨架的会话模块。 */
const SESSIONS = `${ROOT}Sessions.ts`;

/** http 插件（记“开始监听”那一步）。 */
const HTTP = `${ROOT}plugins/http/index.ts`;

/** 每步关键变量（facts）的英文键 → 中文解释：所有步共用这一张，跟启动轨迹一起交给网页。 */
const FACT_NOTES: Record<string, string> = {
  root: '运行时目录',
  backfilled: '补记：tutorial 挂上时这步已经做完，照当时的结果记，耗时算不出来',
  configFile: '配置文件',
  dbFile: '数据库文件',
  defaultModel: '默认模型',
  providers: '供应商（只有名字）',
  plugins: '插件个数',
  thinking: '思考档',
  tools: '工具',
  table: '建的数据表',
  services: '这时 ctx 上有的服务',
  state: '状态',
  ms: '挂了几毫秒',
  failed: '出错',
  error: '没挂上的原因',
  external: '外部插件（名字是文件夹路径）',
  inject: '要用的服务',
  newServices: '这步多出的服务',
  newTools: '这步多登记的工具',
  mounted: '挂上的个数',
  notMounted: '没挂上的插件',
  notStarted: '挂了但缺服务没开工的插件',
  running: '接着跑几场会话',
  host: 'HTTP 监听地址',
  port: 'HTTP 端口',
  hasToken: '配了令牌没有',
};


/**
 * 一个要取注释的函数。
 * @param file 相对代码目录的文件。
 * @param find 定义那一行里一定有的一段代码。
 * @param refName 页面上显示的名字。
 * @param important 会改数据、会影响后面走向的展开显示。
 */
function fn(file: string, find: string, refName: string, important: boolean): sourceModule.DocRef {
  return { file, find, name: refName, important };
}


/**
 * 一个插件的文件夹名：自带插件里名字和文件夹不一样的（wechat-kefu）换成文件夹名。
 * @param plugin config.yaml 里写的名字。
 */
export function getFolder(plugin: string): string {
  const folder = FOLDERS[plugin];
  if (folder !== undefined) return folder;

  return plugin;
}


/** 这次启动的轨迹。tutorial 的 apply 第一件事就建它，好赶上后面每个插件开始挂。 */
export class BootTrail {
  /** 关键变量的说明表（FACT_NOTES），跟启动轨迹一起交给网页。 */
  readonly notes = FACT_NOTES;

  /** 读源码、取注释；同一次启动每个文件只读一次。/api/tutorial/source、说明.md 也用它读。 */
  //M 共用源码与注释缓存器，同一进程周期内避免重复读盘。
  readonly source = new sourceModule.SourceDocs();

  /** 骨架那几步，挂上时补记。 */
  private readonly skeleton: Step[] = [];

  /** 插件那几步，照开始挂的先后。 */
  private readonly plugins: Step[] = [];

  /** ready 时照 pluginStatus 排好的插件步骤（含 loadPlugin 就失败、没 fiber 的）；ready 前是 undefined。 */
  private ordered: Step[] | undefined;

  /** ready 以后的几步。 */
  private readonly tail: Step[] = [];

  /** 插件的 fiber → 它那一步：internal/status 来时对回去。 */
  private readonly fibers = new Map<cordis.Fiber, Step>();

  /** 正在挂的插件那一步：这时候冒出来的服务算它的。 */
  private current: Step | undefined;

  /** ctx 上已经有的服务名，照出现先后（不含 Cordis 自带的）。 */
  private readonly services: string[] = [];

  /** 已经记到某个插件头上的工具名（onStatus 比出“新工具”用）。 */
  private readonly knownTools: string[] = [];

  /** 工具名 → 登记它的插件名：挂插件的那一刻多出来的工具算它的（onStatus 记）。挂完以后（ready 之后）才登记的工具不在这里。 */
  readonly toolOwners = new Map<string, string>();

  /** 最近拍的一份：下一份没变的组沿用它的。 */
  private lastShot: snapshotModule.StateGroup[] = [];

  /**
   * 补记骨架四步，记下 tutorial 自己这一步，挂上五个监听。
   * @param ctx tutorial 的 ctx。
   * @param files HTTP 监听那步记完时，叫它写 boot.json。
   * 副作用：听 internal/plugin、internal/status、internal/service、ready、trace。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly files: filesModule.FlowFiles,
  ) {
    //M 根 fiber：父亲是它的才是 config.yaml 里写的插件。
    const root = ctx.fiber.parent.fiber;

    //M 骨架已经挂好的服务先记下，再补记骨架四步，四步共用这一刻拍的快照。
    const servicesNow = this.getServicesNow(root);
    this.services.push(...servicesNow);
    this.addSkeleton();
    const shot = this.shoot();
    for (const step of this.skeleton) {
      step.snapshot = shot;
    }

    //M tutorial 自己开始挂的那一下已经过去了（internal/plugin 在 apply 之前发），直接记一步；它提供的 flow 服务随后算到这一步头上。
    this.onPlugin(ctx.fiber, root);

    //M 往后每个插件开始挂、挂好、多出服务，和 ready、HTTP 开始监听，各记一笔。
    this.ctx.on('internal/plugin', (fiber) => {
      this.onPlugin(fiber, root);
    });
    this.ctx.on('internal/status', (fiber) => {
      this.onStatus(fiber);
    });
    this.ctx.on('internal/service', (service, value) => {
      this.onService(service, value);
    });
    this.ctx.on('ready', () => {
      this.onReady();
    });
    this.ctx.on('trace', (where, _text, _code, vars) => {
      if (where === 'Http.listen') this.onListen(vars);
    });
  }

  /**
   * 交出去的行：到这时才读源码取注释（读过的缓存着）。
   * @returns 照先后排好的行。
   */
  async getLines(): Promise<BootLine[]> {
    const lines: BootLine[] = [];
    //M 按启动实际先后逐一读出每步关联的函数文档与源码位置，整理成展示行。
    for (const step of this.getSteps()) {
      //M 注释：插件那步先放插件文件开头那段，再放它的函数。
      const docs: sourceModule.CodeDoc[] = [];
      if (step.head !== undefined) {
        const head = await this.source.getHead(step.name, step.head);
        docs.push(head);
      }
      for (const ref of step.docs) {
        const doc = await this.source.getDoc(ref);
        docs.push(doc);
      }

      //M 人话：第一段注释的第一句；取不到用本文件写的那句。
      const summary = docs[0]?.summary ?? '';
      let text = sourceModule.getFirstSentence(summary);
      if (text === '') {
        text = step.fallback;
      }

      //M 查找该步落点源码的“文件:行号”，连同前面整理好的摘要和变量记入结果行。
      const site = await this.source.getSite(step.site);
      lines.push({
        id: lines.length + 1,
        at: step.at,
        kind: '函数',
        name: step.name,
        listeners: [],
        text,
        site,
        sessionId: null,
        messageId: null,
        vars: step.facts,
        node: step.node,
        facts: step.facts,
        docs,
      });
    }
    return lines;
  }

  /**
   * 第几行那一步拍的快照。
   * @param id getLines() 里的 id（从 1 起）。
   * @returns 没有这一行、这一步没拍到是 undefined。
   */
  getSnapshot(id: number): BootShot | undefined {
    //M 先把当前步骤排定顺序，再按展示行号（1 基）取出对应的启动快照。
    const steps = this.getSteps();
    const step = steps[id - 1];
    return step?.snapshot;
  }

  /** 照先后排好的步：骨架、插件（ready 后照 pluginStatus 排）、ready 以后。getLines() 的 id 就是这里的下标加一。 */
  private getSteps(): Step[] {
    let plugins = this.plugins;
    if (this.ordered !== undefined) {
      plugins = this.ordered;
    }
    return [...this.skeleton, ...plugins, ...this.tail];
  }

  /** 拍一份运行时变量，记成最近一份。 */
  private shoot(): BootShot {
    //M 以前一刻快照为基线拍当前服务状态（未变分组直接沿用，节省序列化与对比开销）。
    this.lastShot = snapshotModule.getSnapshot(this.ctx, this.lastShot);
    return { at: Date.now(), groups: this.lastShot };
  }

  /** 骨架四步：tutorial 挂上时它们都做完了，照现在读得到的结果记，时刻都是这一刻。 */
  private addSkeleton(): void {
    const resources = this.ctx.resources;
    const config = resources.config;
    const at = Date.now();

    //M 入口：读命令行，定运行时目录（完整路径，调试用原样给）。
    this.skeleton.push({
      node: 'main',
      name: 'main',
      fallback: '读命令行参数，定运行时目录',
      at,
      site: { file: MAIN, find: 'const args = checks.checkArgs(' },
      docs: [
        fn(MAIN, 'async function main(', 'main', true),
        fn(CHECKS, 'export function checkArgs(', 'checkArgs', true),
        fn(CHECKS, 'function defaultDataDir(', 'defaultDataDir', true),
        fn(EMBEDDED, 'export function isCompiled(', 'isCompiled', false),
      ],
      facts: { root: resources.root, backfilled: true },
    });

    //M resources：读配置、校验、开库、建供应商。这一步只列供应商名字，完整配置在运行时变量的 resources 组里。
    let providers = Object.keys(config.providers).join('、');
    if (providers === '') {
      providers = '（没有）';
    }
    this.skeleton.push({
      node: 'resources',
      name: 'Resources',
      fallback: '读配置并校验、开数据库、建好供应商',
      at,
      site: { file: MAIN, find: 'await app.plugin(resourcesModule.Resources' },
      docs: [
        fn(RESOURCES, 'constructor(ctx: cordis.Context, config: ResourcesConfig)', 'Resources 构造', true),
        fn(CHECKS, 'export function checkConfig(', 'checkConfig', true),
        fn(RESOURCES, '  dir(...parts: string[])', 'Resources.dir', true),
        fn(CHECKS, 'function record(', 'record', false),
        fn(CHECKS, 'function list(', 'list', false),
        fn(CHECKS, 'function text(', 'text', false),
        fn(CHECKS, 'function int(', 'int', false),
        fn(CHECKS, 'function oneOf<', 'oneOf', false),
      ],
      facts: {
        configFile: 'config.yaml',
        dbFile: 'data/jmbots7.db',
        defaultModel: config.defaultModel,
        providers,
        plugins: config.plugins.length,
        thinking: config.thinking,
        backfilled: true,
      },
    });

    //M tools：登记成服务，挂到 Cordis 上。
    this.skeleton.push({
      node: 'tools',
      name: 'Tools',
      fallback: '登记 tools 插件（以后用 ctx.tools 取）',
      at,
      site: { file: MAIN, find: 'await app.plugin(toolsModule.Tools)' },
      docs: [fn(TOOLS, 'constructor(ctx: cordis.Context) {', 'Tools 构造', true)],
      facts: { tools: '还没有，插件挂上时登记', backfilled: true },
    });

    //M sessions：登记成服务，没有表就建。
    this.skeleton.push({
      node: 'sessions',
      name: 'Sessions',
      fallback: '登记 sessions 插件（以后用 ctx.sessions 取），没有表就建',
      at,
      site: { file: MAIN, find: 'await app.plugin(sessionsModule.Sessions)' },
      docs: [fn(SESSIONS, 'constructor(ctx: cordis.Context) {', 'Sessions 构造', true)],
      facts: { table: 'sessions', services: this.services.join('、'), backfilled: true },
    });
  }

  /**
   * 响应 internal/plugin：一个顶层插件开始挂，记一步。
   * 它在 config.plugins 里的下标就是这时 pluginStatus 的长度（Main.ts 每挂完、挂失败一个都推一行）。
   * @param fiber 这个插件的 fiber。
   * @param root 根 fiber：父亲是它的才是 config.yaml 里写的插件，插件里再挂的子插件不算。
   */
  private onPlugin(fiber: cordis.Fiber, root: cordis.Fiber): void {
    //G 拔掉时也发这个事件（uid 是 null）；插件里再挂的子插件不算。
    if (fiber.uid === null || fiber.parent.fiber !== root) return;

    //M 名字照 config.yaml 里写的取；取不到用 fiber 的名字。
    const resources = this.ctx.resources;
    const entry = resources.config.plugins[resources.pluginStatus.length];
    let pluginName = fiber.name;
    if (entry !== undefined) {
      pluginName = entry.name;
    }

    //M 构造该插件挂载步骤并登记 fiber 映射，方便 onStatus 回填耗时与结果。
    const step = this.getPluginStep(pluginName, Date.now());
    this.plugins.push(step);
    this.fibers.set(fiber, step);
    this.current = step;
  }

  /**
   * 一个插件那一步。第一个插件那步多带 loadPlugin 的注释（Main.ts 怎么找到插件）。
   * @param plugin config.yaml 里写的名字。
   * @param at 开始挂的时刻。
   */
  private getPluginStep(plugin: string, at: number): Step {
    const facts: Facts = { state: '正在挂' };

    //G 外部插件（名字是文件夹路径）：源码在运行时目录下，不取注释。
    if (plugin.includes('/') || plugin.includes('\\')) {
      facts['external'] = true;
      const site = { file: MAIN, find: 'await app.plugin(plugin, entry.config)' };
      return { node: plugin, name: plugin, fallback: `挂外部插件 ${plugin}`, at, site, docs: [], facts };
    }

    //M 自带插件：取它 index.ts 的 apply 和文件开头的注释。
    const file = `${ROOT}plugins/${getFolder(plugin)}/index.ts`;
    const docs = [fn(file, 'function apply(', `${plugin}.apply`, true)];
    if (this.plugins.length === 0) {
      docs.unshift(fn(MAIN, 'async function loadPlugin(', 'loadPlugin', true));
    }
    return {
      node: plugin,
      name: plugin,
      fallback: `挂插件 ${plugin}`,
      at,
      site: { file, find: 'function apply(' },
      head: file,
      docs,
      facts,
    };
  }

  /**
   * 响应 internal/status：插件挂好了（2）或 apply 出错了（3），记下用了多久。
   * 0 是在等 inject 的服务，ready 时照 pluginStatus 说清缺谁。
   * @param fiber 状态变了的 fiber。
   */
  private onStatus(fiber: cordis.Fiber): void {
    //M 按 fiber 找到对应的开始步骤；只处理挂好（2）与出错（3）两种终态。
    const step = this.fibers.get(fiber);
    const state = fiber.state as number;
    if (step === undefined) return;
    if (state !== 2 && state !== 3) return;

    //M 挂好还是出错，用了多久。
    step.facts['state'] = 'apply 出错';
    if (state === 2) {
      step.facts['state'] = '挂好了';
    }
    if (state !== 2) {
      step.facts['failed'] = true;
    }
    step.facts['ms'] = Date.now() - step.at;

    //M 这时多出来的工具算这个插件登记的。tools 不在 inject 里（测试里可以没有），现取；登记表是 Tools 的私有字段，用 ['specs'] 读，不改骨架。
    const tools = this.ctx.get('tools');
    const names = [...(tools?.['specs'].keys() ?? [])];
    const added = names.filter((tool) => !this.knownTools.includes(tool));
    this.knownTools.push(...added);
    for (const tool of added) {
      this.toolOwners.set(tool, step.name);
    }
    if (added.length > 0) {
      step.facts['newTools'] = added.join('、');
    }

    //M 挂好（或出错）这一刻的运行时变量。
    step.snapshot = this.shoot();
  }

  /**
   * 响应 internal/service：ctx 上多了一个服务，记到正在挂的插件头上。同一个服务状态变了会再通知一遍，只认头一次。
   * @param service 服务名。
   * @param value 服务本身；撤掉时是 undefined。
   */
  private onService(service: string, value: unknown): void {
    if (value === undefined) return;
    if (this.services.includes(service)) return;

    this.services.push(service);
    if (this.current === undefined) return;

    //M 记到正在挂的插件头上，连成一串字给页面（泳道图「服务就绪」那一列也看它）。
    const before = this.current.facts['newServices'];
    let joined = service;
    if (typeof before === 'string') {
      joined = `${before}、${service}`;
    }
    this.current.facts['newServices'] = joined;
  }

  /**
   * 响应 ready：照 pluginStatus 补每个插件的结果，再记 ready、接着跑会话两步。
   * loadPlugin 就失败的插件（找不到）没有 fiber，这里补一行，时刻跟前一个插件。
   */
  private onReady(): void {
    const at = Date.now();
    const status = this.ctx.resources.pluginStatus;
    //M ready 这一刻拍一份：ready、接着跑两步用它，没挂上、没开工的插件那步（没等到挂好）也用它。
    const shot = this.shoot();

    //M 照 pluginStatus 的先后排插件那几步；名字对不上的（loadPlugin 就失败了）补一步。
    const ordered: Step[] = [];
    let next = 0;
    const takeStep = (rowName: string): Step => {
      const candidate = this.plugins[next];
      if (candidate !== undefined && candidate.name === rowName) {
        next += 1;
        return candidate;
      }
      //M 对不上的条目说明 loadPlugin 阶段已失败未建 fiber，按上一项时刻补记一个挂插件失败步。
      const lastAt = ordered.at(-1)?.at ?? at;
      return this.getPluginStep(rowName, lastAt);
    };
    //M 遍历启动记录表顺序拼齐最终插件列表并写回状态。
    for (const row of status) {
      const step = takeStep(row.name);

      //M 要用的服务、没挂上、没开工，写进这一步。
      let inject = row.inject.join('、');
      if (inject === '') {
        inject = '（不用别的服务）';
      }
      step.facts['inject'] = inject;
      if (!row.mounted) {
        step.facts['state'] = '没挂上';
        step.facts['error'] = row.error;
        step.facts['failed'] = true;
      }
      if (row.mounted && !row.started) {
        step.facts['state'] = `没开工，缺 ${row.missing.join('、')}`;
        step.facts['failed'] = true;
      }
      step.snapshot ??= shot;
      ordered.push(step);
    }
    this.ordered = ordered;
    this.current = undefined;

    //M ready：Main.ts 发给大家“开工”。
    const failed = status.filter((row) => !row.mounted).map((row) => row.name);
    const waiting = status.filter((row) => row.mounted && !row.started).map((row) => row.name);
    let notMounted = failed.join('、');
    if (notMounted === '') {
      notMounted = '（没有）';
    }
    let notStarted = waiting.join('、');
    if (notStarted === '') {
      notStarted = '（没有）';
    }
    this.tail.push({
      node: 'main',
      name: 'ready',
      fallback: '都挂完了，告诉大家开工',
      at,
      site: { file: MAIN, find: "app.emit('ready'" },
      docs: [fn(MAIN, "'ready'(argv: string[])", 'ready 事件', true)],
      facts: {
        plugins: status.length,
        mounted: status.length - failed.length - waiting.length,
        notMounted,
        notStarted,
        services: this.services.join('、'),
      },
      snapshot: shot,
    });

    //M 接着跑：Main.ts 发完 ready 就把库里还是 running 的会话一场场推起来。这时还没推，数一下有几场。
    const running = this.ctx.sessions.find({ state: 'running' }).length;
    this.tail.push({
      node: 'main',
      name: '接着跑会话',
      fallback: '上次没跑完的会话，接着跑',
      at,
      site: { file: MAIN, find: "app.sessions.find({ state: 'running' })" },
      docs: [
        fn(SESSIONS, '  find(where: Partial<SessionMeta>)', 'Sessions.find', false),
        fn(SESSIONS, '  async run(): Promise<void>', 'Session.run', true),
      ],
      facts: { running },
      snapshot: shot,
    });
  }

  /**
   * 响应跟踪点 Http.listen：HTTP 开始监听，从这一刻起收得到消息。记完叫 Files.ts 写 boot.json。
   * @param vars http 插件给的关键变量（跟踪点的中文名）：地址、端口、有没有令牌；记成英文键 host、port、hasToken。
   */
  private onListen(vars: Record<string, unknown>): void {
    const facts: Facts = {};
    const keys: Record<string, string> = { 地址: 'host', 端口: 'port', 有令牌: 'hasToken' };
    for (const [said, key] of Object.entries(keys)) {
      const value = vars[said];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        facts[key] = value;
      }
    }

    //M 先拍好服务监听一刻的快照，再记录“HTTP 开始监听”尾步并关联 listen 源码注释。
    const shot = this.shoot();
    this.tail.push({
      node: 'http',
      name: 'Http.listen',
      fallback: 'HTTP 服务开始监听，开始收消息',
      at: Date.now(),
      site: { file: HTTP, find: 'private async listen(' },
      docs: [fn(HTTP, 'private async listen(', 'Http.listen', true)],
      facts,
      snapshot: shot,
    });

    //M 启动走完：整段写成 data/flow/boot.json，重启前都看得到。
    this.files.writeBoot(this);
  }

  /**
   * ctx 上现在有的服务名：不含 Cordis 自带的（那些是根 fiber 提供的）。
   * @param root 根 fiber。
   */
  private getServicesNow(root: cordis.Fiber): string[] {
    const store = this.ctx.reflect.store;
    const names: string[] = [];
    for (const key of Object.getOwnPropertySymbols(store)) {
      const impl = store[key];
      if (impl === undefined) continue;
      if (impl.value === undefined) continue;
      if (impl.ctx.fiber === root) continue;

      names.push(impl.name);
    }
    return names;
  }
}
