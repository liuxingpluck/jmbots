/**
 * 事件总线（docs/11_独立事件系统_20261106.md 第 5、6.1 节；第一步的细化在 docs/11_附_事件总线_第一步实现.md）。
 * 主线在断点上报一声（emit）或问一声（gate），只是记录，不驱动任何流程：
 *   报：过密钥替身、截短，写进 events 表，告诉订阅的观察处理器，不等它们；
 *   问：先报，再按 order 一个个问挂在这个断点上的拦处理器，谁回 go:false 就停；没人挂就马上回放行，不 await。
 * 写库出错、处理器出错或超时，都只打一行日志，不挡主线（docs/11 第 2 节规矩 1、2）。
 * 入口 src/entries/App.ts 建一个，构造时交给要报事件的对象（机器人循环、分派、会话循环、工具库、观察处理器）。
 */
import * as utils from '../utils/Utils.ts';
import type * as resourcesModule from '../resources/Resources.ts';
import type * as secretsModule from './Secrets.ts';
import type * as storeModule from './Store.ts';


/** 一条事件（和 events 表的一行一样）。 */
export type EventRecord = storeModule.EventRow;


/** 报、问的时候给的：谁发的，属于哪个机器人、会话、消息，去重的键，引出它的事件。 */
export interface EmitOptions {
  /** 谁发的：BotLoop、Dispatch、AgentLoop、Tools、EventWatch…… */
  source: string;
  /** 哪个机器人的。 */
  bot?: string;
  /** 哪个会话的。 */
  sessionId?: string;
  /** 哪条消息的。 */
  messageId?: number;
  /** 去重的键：同一个类型、同一个键第二次来就不算新事件。 */
  key?: string;
  /** 引出它的事件号：链条的层数由它算。 */
  parent?: number;
}


/** 问的结果。 */
export interface GateResult {
  /** 放行吗；false = 停（在 limit.reached 上是“先别停”）。 */
  go: boolean;
  /** 停的原因。 */
  reason?: string;
  /** 叫停（或改了结论）的处理器。 */
  by?: string;
  /** limit.reached 上：再给几分钟（docs/11 第 5.2 节）。 */
  extendMinutes?: number;
  /** dispatch.decided 上：改过的分派结论，要再过分派的核对（docs/11_附 第 3.4 节）。 */
  decision?: Record<string, unknown>;
}


/** 观察处理器：只看、不等；出错只打日志。 */
export type EventHandler = (record: EventRecord) => void | Promise<void>;


/** 拦处理器：主线等它回话（有时限，超时按放行）。 */
export type GateHandler = (record: EventRecord) => GateResult | Promise<GateResult>;


/** 一条事件的数据最多多少字（JSON 后）。 */
const DATA_MAX_CHARS = 16_000;

/** 数据里一个字符串最多留多少字（再长的截短、注明原长）。 */
const TEXT_MAX_CHARS = 2000;

/** 多久删一次过期的事件，毫秒。 */
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;


/**
 * 事件总线：一个进程一个。订阅表、拦处理器表在内存里，事件写进数据库。
 * 调试时点开 this：observers、gates 是谁挂在哪些事件上。
 */
export class EventBus {
  /** 观察处理器：订的类型（全名或 xxx.*）和处理器。 */
  private readonly observers: { pattern: string; handler: EventHandler }[] = [];
  /** 拦处理器：挂的类型、处理器、先后、名字。 */
  private readonly gates: { pattern: string; handler: GateHandler; order: number; name: string }[] = [];
  /** 上次删过期事件的时间，毫秒。 */
  private prunedAt = 0;

  /**
   * @param store 数据库：事件表、记过的键（src/capabilities/Store.ts，入口建的）。
   * @param resources 资源：留几天、链条几层、拦处理器等多久（events 段）。
   * @param secrets 密钥替身：事件数据写库前把密钥换成替身。
   */
  constructor(
    private readonly store: storeModule.Store,
    private readonly resources: resourcesModule.Resources,
    private readonly secrets: secretsModule.Secrets,
  ) {}

  /**
   * 报：记一条事件，告诉订阅它的观察处理器（不等）。
   * @param type 类型，点分层（如 tool.after）。
   * @param data 数据（会过密钥替身、截短）。
   * @param options 谁发的、属于谁、键、引出它的事件。
   * @returns 记下的事件；被去重、链条太长、写库出错时是 undefined。从不抛错。
   * 副作用：写库；叫观察处理器；一天删一次过期事件。
   */
  emit(type: string, data: Record<string, unknown>, options: EmitOptions): EventRecord | undefined {
    try {
      //M 1. 链条第几层：太深就不记，改记一条 event.too_deep。
      /** 层数。 */
      const depth = options.parent === undefined ? 0 : this.depthOf(options.parent) + 1;
      if (depth > this.resources.getSetting('eventsMaxDepth')) {
        this.emit('event.too_deep', { type, from: options.source, parent: options.parent }, { source: 'EventBus' });
        return undefined;
      }
      //M 2. 过密钥替身、截短，写库（带键的记过就不算新事件）。
      /** 要写的一行。 */
      const row: Omit<EventRecord, 'id'> = {
        type,
        at: Date.now(),
        source: options.source,
        bot: options.bot ?? null,
        sessionId: options.sessionId ?? null,
        messageId: options.messageId ?? null,
        key: options.key ?? null,
        data: this.shrink(data),
        parent: options.parent ?? null,
        depth,
      };
      /** 事件号。 */
      const id = this.store.addEvent(row);
      if (id === undefined) {
        return undefined;
      }
      /** 记下的事件。 */
      const record: EventRecord = { id, ...row };
      //M 3. 告诉观察处理器；顺手删过期的。
      this.notify(record);
      this.prune();
      return record;
    } catch (error) {
      //G 记不上不挡主线。
      console.error(`${utils.formatTime()} 事件 ${type} 没记上：${utils.errorText(error)}`);
      return undefined;
    }
  }

  /**
   * 问：先报，再按 order 一个个问挂在这里的拦处理器；谁回 go:false 就停，后面的不再问。
   * 处理器出错、超过 events.gate_timeout_ms 都按放行。问完记一条 gate.decided（每个处理器的回答和用时）。
   * @param type 类型。
   * @param data 数据。
   * @param options 谁发的、属于谁。
   * @returns 结果：停了的那个回答；都放行时是 go:true（带着最后一个给了 decision、extendMinutes 的）。从不抛错。
   * 副作用：写库；调拦处理器。
   */
  async gate(type: string, data: Record<string, unknown>, options: EmitOptions): Promise<GateResult> {
    /** 先报一条。 */
    const record = this.emit(type, data, options);
    /** 挂在这里的，按先后。 */
    const handlers = this.gates.filter((item) => matches(item.pattern, type)).sort((left, right) => left.order - right.order);
    if (!record || handlers.length === 0) {
      return { go: true };
    }
    /** 每个处理器的回答。 */
    const answers: { by: string; go: boolean; reason?: string; ms: number }[] = [];
    /** 结果。 */
    let result: GateResult = { go: true };
    for (const item of handlers) {
      /** 开始问的时间。 */
      const startedAt = Date.now();
      /** 这一个的回答。 */
      const answer = await this.ask(item.handler, record);
      answers.push({ by: item.name, go: answer.go, reason: answer.reason, ms: Date.now() - startedAt });
      if (answer.decision !== undefined || answer.extendMinutes !== undefined) {
        result = { ...result, ...answer, by: item.name };
      }
      if (!answer.go) {
        result = { ...answer, by: item.name };
        break;
      }
    }
    this.emit('gate.decided', { type, answers }, { ...options, source: 'EventBus', key: undefined, parent: record.id });
    return result;
  }

  /**
   * 订阅（观察）：这种事件记下以后叫它，不等。
   * @param pattern 类型全名，或者写到某一层加 .*（如 tool.*）。
   * @param handler 处理器。
   * @returns 取消订阅的函数。
   */
  on(pattern: string, handler: EventHandler): () => void {
    /** 这一条。 */
    const entry = { pattern, handler };
    this.observers.push(entry);
    return () => {
      this.observers.splice(this.observers.indexOf(entry), 1);
    };
  }

  /**
   * 挂拦处理器：问到这种事件时主线等它回话。
   * @param pattern 类型全名，或者 xxx.*。
   * @param handler 处理器。
   * @param order 先后，小的先问，默认 100。
   * @param name 名字（记在 gate.decided 和结果的 by 里），默认处理器的函数名。
   * @returns 取下的函数。
   */
  onGate(pattern: string, handler: GateHandler, order = 100, name = handler.name || '拦处理器'): () => void {
    /** 这一条。 */
    const entry = { pattern, handler, order, name };
    this.gates.push(entry);
    return () => {
      this.gates.splice(this.gates.indexOf(entry), 1);
    };
  }

  /**
   * 这种事件有没有挂拦处理器：断点用它决定要不要 await（没人挂就不等）。
   * @param type 类型。
   */
  hasGate(type: string): boolean {
    return this.gates.some((item) => matches(item.pattern, type));
  }

  /**
   * 这个键记过没有。
   * @param type 类型。
   * @param key 键。
   */
  seen(type: string, key: string): boolean {
    return this.store.hasEventKey(type, key);
  }

  /**
   * 删掉一个记过的键（要重新来一次时）。
   * @param type 类型。
   * @param key 键。
   * @returns 有没有删到。
   */
  forget(type: string, key: string): boolean {
    return this.store.deleteEventKey(type, key);
  }

  /**
   * 查事件：按类型（全名或 xxx.*）、会话、时间，最新的 limit 条，按号从小到大。
   * @param query 条件。
   */
  list(query: storeModule.EventQuery): EventRecord[] {
    return this.store.listEvents(query);
  }

  /**
   * 一条事件往上往下的整串（学习界面回放、看一次运行的全过程用）。
   * @param id 事件号。
   */
  chain(id: number): EventRecord[] {
    return this.store.eventChain(id);
  }

  /**
   * 引出它的那条事件在第几层（找不到算 0 层）。
   * @param parent 事件号。
   */
  private depthOf(parent: number): number {
    return this.store.getEvent(parent)?.depth ?? 0;
  }

  /**
   * 问一个拦处理器：出错、超时都按放行。
   * @param handler 处理器。
   * @param record 这次问的事件。
   * @returns 回答。
   */
  private async ask(handler: GateHandler, record: EventRecord): Promise<GateResult> {
    /** 时限。 */
    const timeoutMs = this.resources.getSetting('gateTimeoutMs');
    /** 超时计时器。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 到点就当放行。 */
    const timeout = new Promise<GateResult>((resolve) => {
      timer = setTimeout(() => resolve({ go: true, reason: `超过 ${String(timeoutMs)} 毫秒没回，按放行` }), timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => handler(record)), timeout]);
    } catch (error) {
      console.error(`${utils.formatTime()} 事件 ${record.type} 的拦处理器出错，按放行：${utils.errorText(error)}`);
      return { go: true, reason: `出错，按放行：${utils.errorText(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 数据进库前：每个字符串过密钥替身、太长的截短（注明原长）；整条 JSON 还超过上限就只留开头。
   * @param data 数据。
   * @returns 可以写库的数据（新对象，不改原来的）。
   */
  private shrink(data: Record<string, unknown>): Record<string, unknown> {
    /**
     * 一个值：字符串过替身、截短；数组、对象往里走；别的原样。
     * @param value 值。
     */
    const clean = (value: unknown): unknown => {
      if (typeof value === 'string') {
        /** 换过密钥的。 */
        const masked = this.secrets.mask(value);
        return masked.length > TEXT_MAX_CHARS ? `${masked.slice(0, TEXT_MAX_CHARS)}……（共 ${String(masked.length)} 字）` : masked;
      }
      if (Array.isArray(value)) {
        return value.map(clean);
      }
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
      }
      return value;
    };
    /** 处理过的。 */
    const cleaned = clean(data) as Record<string, unknown>;
    /** 整条的 JSON。 */
    const json = JSON.stringify(cleaned);
    if (json.length <= DATA_MAX_CHARS) {
      return cleaned;
    }
    /** 大数据被截短时仍保留只读关联键，避免它从回复链中消失。 */
    return {
      truncated: true,
      chars: json.length,
      run: cleaned.run,
      step: cleaned.step,
      messageIds: cleaned.messageIds,
      requestId: cleaned.requestId,
      attemptId: cleaned.attemptId,
      head: json.slice(0, DATA_MAX_CHARS),
    };
  }

  /**
   * 叫订阅了这种事件的观察处理器：一个出错不挡别的，异步的不等。
   * @param record 事件。
   */
  private notify(record: EventRecord): void {
    for (const item of this.observers.filter((entry) => matches(entry.pattern, record.type))) {
      try {
        /** 处理器的返回（异步的接住出错）。 */
        const result = item.handler(record);
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            console.error(`${utils.formatTime()} 事件 ${record.type} 的观察处理器出错：${utils.errorText(error)}`);
          });
        }
      } catch (error) {
        console.error(`${utils.formatTime()} 事件 ${record.type} 的观察处理器出错：${utils.errorText(error)}`);
      }
    }
  }

  /** 一天删一次过期的事件（events.keep_days 天以前的；记过的键不删）。 */
  private prune(): void {
    /** 现在。 */
    const now = Date.now();
    if (now - this.prunedAt < PRUNE_EVERY_MS) {
      return;
    }
    this.prunedAt = now;
    /** 删了几条。 */
    const removed = this.store.pruneEvents(now - this.resources.getSetting('eventsKeepDays') * PRUNE_EVERY_MS);
    if (removed > 0) {
      console.log(`${utils.formatTime()} 删了 ${String(removed)} 条过期的事件`);
    }
  }
}


/**
 * 订的类型对不对得上：全名一样，或者订的是 xxx.*、事件在 xxx. 下面。
 * @param pattern 订的。
 * @param type 事件的类型。
 */
function matches(pattern: string, type: string): boolean {
  return pattern.endsWith('.*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type;
}
