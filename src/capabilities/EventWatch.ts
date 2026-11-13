/**
 * 观察处理器（docs/11_附_事件总线_第一步实现.md 第 5 节）：只看事件、不拦，看出问题就再报一条事件，都写进事件表，复盘、限时规则用。
 *   限时不在这里计：计时只有一个来源，是进度卡片里的限时规则（src/capabilities/Progress.ts，docs/界面/03 第 2.1 节），由它报 limit.*。
 *   思考：一步想太久、一次运行走太多步，报 watch.thinking。
 *   工具：同一个工具连着出错几次，报 watch.toolfail。
 *   搜索：没搜到、搜太慢、同一个会话反复搜同一句，报 watch.search。
 * 自己报的 watch.* 不订阅，免得转圈；parent 都指向这次运行的 run.started，一条事件链就能看到全过程。
 * 入口 src/entries/App.ts 建一个、调 start；试运行（换版本时）不开。
 */
import type * as resourcesModule from '../resources/Resources.ts';
import type * as eventsModule from './Events.ts';


/** 一个会话这次运行看到的。 */
interface RunWatch {
  /** 这次运行的 run.started 事件号（报的事件都挂在它下面）。 */
  startEventId: number;
  /** 哪个机器人的。 */
  bot: string | undefined;
  /** “走太多步”报过没有（一次运行只报一次）。 */
  manyReported: boolean;
  /** 每个工具连着出错几次。 */
  toolErrors: Map<string, number>;
  /** 每句搜索（去掉空白）搜了几次。 */
  queries: Map<string, number>;
}


/** 观察处理器：一个进程一个。 */
export class EventWatch {
  /** 会话号 → 这次运行看到的。 */
  private readonly runs = new Map<string, RunWatch>();
  /** 取消订阅的函数。 */
  private readonly unsubscribes: (() => void)[] = [];

  /**
   * @param events 事件总线（src/capabilities/Events.ts 的 EventBus，入口建的）：订阅、报事件。
   * @param resources 资源：几个阈值（config.yaml 的 events 段）。
   */
  constructor(
    private readonly events: eventsModule.EventBus,
    private readonly resources: resourcesModule.Resources,
  ) {}

  /** 开始看：订阅一次运行的开始结束、每一步、每个工具、每次搜索。 */
  start(): void {
    this.unsubscribes.push(
      this.events.on('run.started', (record) => this.onRunStarted(record)),
      this.events.on('run.ended', (record) => this.onRunEnded(record)),
      this.events.on('step.after', (record) => this.onStep(record)),
      this.events.on('tool.after', (record) => this.onTool(record)),
      this.events.on('search.done', (record) => this.onSearch(record)),
    );
  }

  /** 不看了：取消订阅、清掉计数。 */
  stop(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
    this.runs.clear();
  }

  /**
   * 一次运行开始：记下来，计数从头算。
   * @param record run.started 事件。
   */
  private onRunStarted(record: eventsModule.EventRecord): void {
    /** 会话号。 */
    const sessionId = record.sessionId;
    if (!sessionId) {
      return;
    }
    this.runs.set(sessionId, {
      startEventId: record.id,
      bot: record.bot ?? undefined,
      manyReported: false,
      toolErrors: new Map(),
      queries: new Map(),
    });
  }

  /**
   * 一次运行结束：清掉计数。
   * @param record run.ended 事件。
   */
  private onRunEnded(record: eventsModule.EventRecord): void {
    if (record.sessionId) {
      this.runs.delete(record.sessionId);
    }
  }

  /**
   * 一步做完：想太久、走太多步就报 watch.thinking。
   * @param record step.after 事件（data 里有 step、ms）。
   */
  private onStep(record: eventsModule.EventRecord): void {
    /** 这次运行看到的。 */
    const watch = record.sessionId ? this.runs.get(record.sessionId) : undefined;
    if (!watch || !record.sessionId) {
      return;
    }
    /** 用了多久。 */
    const ms = Number(record.data.ms) || 0;
    /** 第几步。 */
    const step = Number(record.data.step) || 0;
    /** 太慢的门槛，毫秒。 */
    const slowMs = this.resources.getSetting('watchThinkSlowSeconds') * 1000;
    if (ms > slowMs) {
      this.report(record.sessionId, 'watch.thinking', { reason: 'slow', step, ms, limitMs: slowMs });
    }
    /** 太多步的门槛。 */
    const maxSteps = this.resources.getSetting('watchThinkMaxSteps');
    if (step > maxSteps && !watch.manyReported) {
      watch.manyReported = true;
      this.report(record.sessionId, 'watch.thinking', { reason: 'many', step, limitSteps: maxSteps });
    }
  }

  /**
   * 一个工具做完：同一个工具连着出错到门槛就报 watch.toolfail（到门槛那一次报一回），成功了从头数。
   * @param record tool.after 事件（data 里有 tool、isError）。
   */
  private onTool(record: eventsModule.EventRecord): void {
    /** 这次运行看到的。 */
    const watch = record.sessionId ? this.runs.get(record.sessionId) : undefined;
    if (!watch || !record.sessionId) {
      return;
    }
    /** 工具名。 */
    const tool = textOf(record.data.tool);
    if (record.data.isError !== true) {
      watch.toolErrors.delete(tool);
      return;
    }
    /** 连着出错几次。 */
    const count = (watch.toolErrors.get(tool) ?? 0) + 1;
    watch.toolErrors.set(tool, count);
    if (count === this.resources.getSetting('watchToolFailRun')) {
      this.report(record.sessionId, 'watch.toolfail', { tool, count });
    }
  }

  /**
   * 一次搜索：没搜到、太慢、同一句搜到门槛次数，各报一条 watch.search。
   * @param record search.done 事件（data 里有 kind、query、hits、ms）。
   */
  private onSearch(record: eventsModule.EventRecord): void {
    /** 这次运行看到的。 */
    const watch = record.sessionId ? this.runs.get(record.sessionId) : undefined;
    if (!watch || !record.sessionId) {
      return;
    }
    /** 搜的哪种。 */
    const kind = textOf(record.data.kind);
    /** 搜的话。 */
    const query = textOf(record.data.query);
    /** 用了多久。 */
    const ms = Number(record.data.ms) || 0;
    if (Number(record.data.hits) === 0) {
      this.report(record.sessionId, 'watch.search', { reason: 'empty', kind, query });
    }
    /** 太慢的门槛。 */
    const slowMs = this.resources.getSetting('watchRagSlowMs');
    if (ms > slowMs) {
      this.report(record.sessionId, 'watch.search', { reason: 'slow', kind, query, ms, limitMs: slowMs });
    }
    /** 去掉空白的那句（同一句算一种）。 */
    const normalized = query.replace(/\s+/g, '');
    /** 第几次搜这句。 */
    const times = (watch.queries.get(normalized) ?? 0) + 1;
    watch.queries.set(normalized, times);
    if (times === this.resources.getSetting('watchRagRepeat')) {
      this.report(record.sessionId, 'watch.search', { reason: 'repeat', kind, query, times });
    }
  }

  /**
   * 报一条：挂在这次运行的 run.started 下面。
   * @param sessionId 会话号。
   * @param type 类型。
   * @param data 数据。
   */
  private report(sessionId: string, type: string, data: Record<string, unknown>): void {
    /** 这次运行看到的。 */
    const watch = this.runs.get(sessionId);
    if (!watch) {
      return;
    }
    this.events.emit(type, data, { source: 'EventWatch', bot: watch.bot, sessionId, parent: watch.startEventId });
  }

}


/**
 * 事件数据里的一个文字字段；不是文字就当空的。
 * @param value 字段的值。
 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
