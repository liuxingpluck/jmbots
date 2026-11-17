/**
 * boot-trail：把这次启动走过的路记下来，给 /flow/ 的“看启动”一步一步画出来。
 * 要写在 config.yaml plugins 段的第一个：Cordis 不补发旧事件，写在后面就漏掉前面的插件。
 * 记什么：
 *   骨架四步（入口读参数、resources、tools、sessions）：本插件挂上时已经做完，照当时的结果补记，耗时算不出来；
 *   每个插件：听 Cordis 的 internal/plugin（开始挂）、internal/status（挂好或出错）、internal/service（多了哪个服务）；
 *   ready、接着跑上次没跑完的会话、HTTP 开始监听（trace 里的 Http.listen）。
 * 每一步带“文件:行号”、关键变量（原值，调试用不打码）、那段代码自己的 JSDoc（Source.ts 取）。只存内存，只看这一次启动。
 * 每一步做完还拍一份运行时变量的快照（utils/Snapshot.ts）：骨架四步共用挂上时那份，插件那步是挂好（或出错）那一刻，ready、HTTP 监听各一份。
 * 交给 flow 的行和 journal 的跟踪行同形状（flow/Trail.ts 的 TrailLine），flow 照请求轨迹的办法收成步骤；不 import flow。
 * 还交给 flow：每个插件多出的服务、工具（provided()，画总览图的边）；HTTP 监听那步记完发 boot-trail/done（flow 写 boot.json）。
 */
import * as cordis from 'cordis';
import * as snapshotModule from '../../utils/Snapshot.ts';
import * as sourceModule from './Source.ts';


/** 插件名。 */
export const name = 'boot-trail';

/** 用到的服务：都是骨架的，本插件挂上时已经有了。 */
export const inject = ['resources', 'sessions'];


declare module 'cordis' {
  interface Context {
    /** 这次启动的轨迹（boot-trail 插件）。 */
    bootTrail: BootTrail;
  }

  interface Events {
    /** 启动走完（HTTP 开始监听那步记完、拍完快照）。flow 听它写 boot.json；插件内部用的事件，不进骨架。 */
    'boot-trail/done'(): void;
  }
}


/** 一个插件挂上时多出来的服务、工具（provided() 交给 flow 画边）。 */
export interface Provided {
  /** config.yaml 里写的插件名。 */
  name: string;
  /** 这一步多出的服务名。 */
  services: string[];
  /** 这一步多登记的工具名。 */
  tools: string[];
}


/** 一步的关键变量：只放短的字、数、真假。 */
export type Facts = Record<string, string | number | boolean>;


/** 交给 flow 的一行，和 flow/Trail.ts 的 TrailLine 同形状。 */
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
  /** 一句人话：那段代码注释的第一句，取不到用本插件写的一句。 */
  text: string;
  /** 文件:行号，相对代码目录。 */
  site: string;
  /** 启动时没有会话。 */
  sessionId: null;
  /** 启动时没有消息。 */
  messageId: null;
  /** 和 facts 同一份；flow 认“出错”看这里。 */
  vars: Facts;
  /** 图上的点：main、resources、tools、sessions，或插件名。 */
  node: string;
  /** 关键变量，已经挑过，可以露在网页上。 */
  facts: Facts;
  /** 这一步的函数注释。 */
  docs: sourceModule.CodeDoc[];
}


/** 记着的一步，读注释前的样子。 */
interface Step {
  /** 图上的点。 */
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
  /** 插件那一步：多出的服务名（facts.newServices 是它连起来的）。 */
  services?: string[];
  /** 插件那一步：多登记的工具名（facts.newTools 是它连起来的）。 */
  tools?: string[];
  /** 这一步做完时的运行时变量；还没拍（插件还在等服务）是 undefined。 */
  snapshot?: { at: number; groups: snapshotModule.StateGroup[] };
}


/** Cordis 服务表里的一项（cordis 没导出这个类型，从 ctx.reflect.store 取）。 */
type Impl = cordis.Context['reflect']['store'][symbol];

const MAIN = 'src7/Main.ts';
const CHECKS = 'src7/utils/Checks.ts';

/** 自带插件里名字和文件夹不一样的（plugins/Index.ts 的别名）。 */
const FOLDERS: Record<string, string> = { 'wechat-kefu': 'wechat' };

/** 每步关键变量（facts）的英文键 → 中文解释：所有步共用这一张，flow 跟轨迹一起交给网页。 */
const FACT_NOTES: Record<string, string> = {
  root: '运行时目录',
  backfilled: '补记：本插件挂上时这步已经做完，照当时的结果记，耗时算不出来',
  configFile: '配置文件',
  dbFile: '数据库文件',
  defaultModel: '默认模型',
  providers: '供应商（只有名字）',
  plugins: '插件个数',
  maxSteps: '一轮最多几步',
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
 * @param important 会改数据、会影响后面走向的展开显示（见进度文件 132_启动画布 的“哪些算重要”）。
 */
function fn(file: string, find: string, refName: string, important: boolean): sourceModule.DocRef {
  return { file, find, name: refName, important };
}


/** 这次启动的轨迹。服务名 bootTrail，flow 用 ctx.get('bootTrail') 现取。 */
export class BootTrail extends cordis.Service {
  /** 关键变量的说明表（FACT_NOTES），flow 的 /api/flow/boot 原样带上。 */
  readonly notes = FACT_NOTES;

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

  /** 读源码、取注释；同一次启动每个文件只读一次。flow 的 /api/flow/source 也用它取函数源码（sourceOf）。 */
  readonly source = new sourceModule.SourceDocs();

  /** 最近拍的一份：下一份没变的组沿用它的。 */
  private lastShot: snapshotModule.StateGroup[] = [];

  /**
   * 补记骨架四步，记下本插件自己这一步，挂上四个监听。
   * @param ctx Cordis 给这个插件的 ctx。
   * 副作用：登记服务 bootTrail；听 internal/plugin、internal/status、internal/service、ready、trace。
   */
  constructor(ctx: cordis.Context) {
    super(ctx, 'bootTrail');
    const root = ctx.fiber.parent.fiber;
    this.services.push(...this.servicesNow(ctx, root));
    this.addSkeleton();
    const shot = this.shoot();
    for (const step of this.skeleton) {
      step.snapshot = shot;
    }

    //M 本插件自己开始挂的那一下已经过去了（internal/plugin 在 apply 之前发），直接记一步；bootTrail 算它的新服务。
    this.onPlugin(ctx.fiber, root);
    this.onService('bootTrail', this);

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
   * 交给 flow 的行：到这时才读源码取注释（读过的缓存着）。
   * @returns 照先后排好的行。
   */
  async lines(): Promise<BootLine[]> {
    const lines: BootLine[] = [];
    for (const step of this.steps()) {
      const docs: sourceModule.CodeDoc[] = [];
      if (step.head !== undefined) docs.push(await this.source.headOf(step.name, step.head));
      for (const ref of step.docs) {
        docs.push(await this.source.docOf(ref));
      }
      const said = sourceModule.firstSentence(docs[0]?.summary ?? '');
      lines.push({
        id: lines.length + 1,
        at: step.at,
        kind: '函数',
        name: step.name,
        listeners: [],
        text: said === '' ? step.fallback : said,
        site: await this.source.siteOf(step.site),
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
   * 第几行那一步拍的快照，给 flow 的 /api/flow/snapshot。
   * @param id lines() 里的 id（从 1 起）。
   * @returns 没有这一行、这一步没拍到是 undefined。
   */
  snapshot(id: number): { at: number; groups: snapshotModule.StateGroup[] } | undefined {
    return this.steps()[id - 1]?.snapshot;
  }

  /**
   * 每个插件挂上时多出的服务、工具，给 flow 画总览图的边（flow/index.ts 的 graphOf）。
   * @returns 照插件挂的先后；ready 前只有已经开始挂的。
   */
  provided(): Provided[] {
    const steps = this.ordered ?? this.plugins;
    return steps.map((step) => ({ name: step.name, services: step.services ?? [], tools: step.tools ?? [] }));
  }

  /** 照先后排好的步：骨架、插件（ready 后照 pluginStatus 排）、ready 以后。lines() 的 id 就是这里的下标加一。 */
  private steps(): Step[] {
    return [...this.skeleton, ...(this.ordered ?? this.plugins), ...this.tail];
  }

  /** 拍一份运行时变量，记成最近一份。 */
  private shoot(): NonNullable<Step['snapshot']> {
    this.lastShot = snapshotModule.snapshotOf(this.ctx, this.lastShot);
    return { at: Date.now(), groups: this.lastShot };
  }

  /** 骨架四步：本插件挂上时它们都做完了，照现在读得到的结果记，时刻都是这一刻。 */
  private addSkeleton(): void {
    const resources = this.ctx.resources;
    const config = resources.config;
    const at = Date.now();
    const add = (step: Omit<Step, 'at'>): void => {
      this.skeleton.push({ ...step, at });
    };

    //M 入口：读命令行，定运行时目录（完整路径，调试用原样给）。
    add({
      node: 'main',
      name: 'main',
      fallback: '读命令行参数，定运行时目录',
      site: { file: MAIN, find: 'const args = checks.checkArgs(' },
      docs: [
        fn(MAIN, 'async function main(', 'main', true),
        fn(CHECKS, 'export function checkArgs(', 'checkArgs', true),
        fn(CHECKS, 'function defaultDataDir(', 'defaultDataDir', true),
        fn('src7/utils/Embedded.ts', 'export function isCompiled(', 'isCompiled', false),
      ],
      facts: { root: resources.root, backfilled: true },
    });

    //M resources：读配置、校验、开库、建供应商。这一步只列供应商名字，完整配置在运行时变量的 resources 组里。
    add({
      node: 'resources',
      name: 'Resources',
      fallback: '读配置并校验、开数据库、建好供应商',
      site: { file: MAIN, find: 'await app.plugin(resourcesModule.Resources' },
      docs: [
        fn('src7/Resources.ts', 'constructor(ctx: cordis.Context, config: ResourcesConfig)', 'Resources 构造', true),
        fn(CHECKS, 'export function checkConfig(', 'checkConfig', true),
        fn('src7/Resources.ts', '  dir(...parts: string[])', 'Resources.dir', true),
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
        providers: Object.keys(config.providers).join('、') || '（没有）',
        plugins: config.plugins.length,
        maxSteps: config.maxSteps,
        thinking: config.thinking,
        backfilled: true,
      },
    });

    //M tools、sessions：登记插件，作为服务挂到 Cordis 上；sessions 建表。
    add({
      node: 'tools',
      name: 'Tools',
      fallback: '登记 tools 插件（以后用 ctx.tools 取）',
      site: { file: MAIN, find: 'await app.plugin(toolsModule.Tools)' },
      docs: [fn('src7/Tools.ts', 'constructor(ctx: cordis.Context) {', 'Tools 构造', true)],
      facts: { tools: '还没有，插件挂上时登记', backfilled: true },
    });
    add({
      node: 'sessions',
      name: 'Sessions',
      fallback: '登记 sessions 插件（以后用 ctx.sessions 取），没有表就建',
      site: { file: MAIN, find: 'await app.plugin(sessionsModule.Sessions)' },
      docs: [fn('src7/Sessions.ts', 'constructor(ctx: cordis.Context) {', 'Sessions 构造', true)],
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
    //G 拔掉时也发这个事件（uid 是 null）。
    if (fiber.uid === null || fiber.parent.fiber !== root) return;

    const resources = this.ctx.resources;
    const entry = resources.config.plugins[resources.pluginStatus.length];
    const step = this.pluginStep(entry?.name ?? fiber.name, Date.now());
    this.plugins.push(step);
    this.fibers.set(fiber, step);
    this.current = step;
  }

  /**
   * 一个插件那一步。第一个插件那步多带 loadPlugin 的注释（Main.ts 怎么找到插件）。
   * @param plugin config.yaml 里写的名字。
   * @param at 开始挂的时刻。
   */
  private pluginStep(plugin: string, at: number): Step {
    const facts: Facts = { state: '正在挂' };

    //G 外部插件（名字是文件夹路径）：源码在运行时目录下，不取注释。
    if (plugin.includes('/') || plugin.includes('\\')) {
      facts['external'] = true;
      const site = { file: MAIN, find: 'await app.plugin(plugin, entry.config)' };
      return { node: plugin, name: plugin, fallback: `挂外部插件 ${plugin}`, at, site, docs: [], facts };
    }

    const file = `src7/plugins/${FOLDERS[plugin] ?? plugin}/index.ts`;
    const docs = [fn(file, 'function apply(', `${plugin}.apply`, true)];
    if (this.plugins.length === 0) docs.unshift(fn(MAIN, 'async function loadPlugin(', 'loadPlugin', true));
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
    const step = this.fibers.get(fiber);
    const state = fiber.state as number;
    if (step === undefined || (state !== 2 && state !== 3)) return;

    step.facts['state'] = state === 2 ? '挂好了' : 'apply 出错';
    step.facts['ms'] = Date.now() - step.at;
    if (state === 3) step.facts['failed'] = true;

    //M 这时多出来的工具算这个插件登记的：/flow/ 的「运行时变量」靠它说清工具是谁的。
    //M   tools 不在 inject 里（测试里可以没有），现取；登记表是 Tools 的私有字段，用 ['specs'] 读，不改骨架。
    const names = [...(this.ctx.get('tools')?.['specs'].keys() ?? [])];
    const added = names.filter((tool) => !this.knownTools.includes(tool));
    this.knownTools.push(...added);
    step.tools = added;
    if (added.length > 0) step.facts['newTools'] = added.join('、');

    //M 挂好（或出错）这一刻的运行时变量。
    step.snapshot = this.shoot();
  }

  /**
   * 响应 internal/service：ctx 上多了一个服务，记到正在挂的插件头上。同一个服务状态变了会再通知一遍，只认头一次。
   * @param service 服务名。
   * @param value 服务本身；撤掉时是 undefined。
   */
  private onService(service: string, value: unknown): void {
    if (value === undefined || this.services.includes(service)) return;

    this.services.push(service);
    if (this.current === undefined) return;

    //M 记到正在挂的插件头上：数组给 provided()，连起来的字给页面。
    const services = this.current.services ?? [];
    services.push(service);
    this.current.services = services;
    this.current.facts['newServices'] = services.join('、');
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
    const ordered: Step[] = [];
    let next = 0;
    for (const row of status) {
      let step = this.plugins[next];
      if (step?.name === row.name) {
        next += 1;
      } else {
        step = this.pluginStep(row.name, ordered.at(-1)?.at ?? at);
      }
      step.facts['inject'] = row.inject.join('、') || '（不用别的服务）';
      if (!row.mounted) {
        step.facts['state'] = '没挂上';
        step.facts['error'] = row.error;
        step.facts['failed'] = true;
      } else if (!row.started) {
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
        notMounted: failed.join('、') || '（没有）',
        notStarted: waiting.join('、') || '（没有）',
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
        fn('src7/Sessions.ts', '  find(where: Partial<SessionMeta>)', 'Sessions.find', false),
        fn('src7/Sessions.ts', '  async run(): Promise<void>', 'Session.run', true),
      ],
      facts: { running },
      snapshot: shot,
    });
  }

  /**
   * 响应 trace 里的 Http.listen：HTTP 开始监听，从这一刻起收得到消息。
   * @param vars http 插件给的关键变量（跟踪点的中文名）：地址、端口、有没有令牌；记成英文键 host、port、hasToken。
   */
  private onListen(vars: Record<string, unknown>): void {
    const facts: Facts = {};
    const keys: Record<string, string> = { 地址: 'host', 端口: 'port', 有令牌: 'hasToken' };
    for (const [said, key] of Object.entries(keys)) {
      const value = vars[said];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') facts[key] = value;
    }
    this.tail.push({
      node: 'http',
      name: 'Http.listen',
      fallback: 'HTTP 服务开始监听，开始收消息',
      at: Date.now(),
      site: { file: 'src7/plugins/http/index.ts', find: 'private async listen(' },
      docs: [fn('src7/plugins/http/index.ts', 'private async listen(', 'Http.listen', true)],
      facts,
      snapshot: this.shoot(),
    });

    //M 启动走完：告诉要用整段启动轨迹的（flow 写 boot.json），它们不用再自己从 trace 认 Http.listen。
    this.ctx.emit('boot-trail/done');
  }

  /**
   * ctx 上现在有的服务名：不含 Cordis 自带的（那些是根 fiber 提供的），也不含本插件自己的 bootTrail。
   * @param ctx 本插件的 ctx。
   * @param root 根 fiber。
   */
  private servicesNow(ctx: cordis.Context, root: cordis.Fiber): string[] {
    const store = ctx.reflect.store;
    const others = (impl: Impl | undefined): impl is Impl => impl !== undefined
      && impl.value !== undefined
      && impl.ctx.fiber !== root
      && impl.ctx.fiber !== ctx.fiber;
    return Object.getOwnPropertySymbols(store)
      .map((key) => store[key])
      .filter(others)
      .map((impl) => impl.name);
  }
}


/**
 * 挂上 boot-trail。要写在 config.yaml 的 plugins 段第一个。
 * apply 是 Cordis 插件的入口函数：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 等 inject 里的服务都就绪后调一次。
 * @param ctx Cordis 给这个插件的 ctx。
 * 副作用：登记服务 bootTrail，开始记这次启动。
 */
export function apply(ctx: cordis.Context): void {
  new BootTrail(ctx);
}
