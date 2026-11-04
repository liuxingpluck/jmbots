/**
 * 执行器（Executor）的统一接口和登记表：事件循环只认这一套，不认识具体是哪个执行器。
 *
 * 执行器各管一类事件：接话执行器管 message，干活执行器管 execution，审核执行器管 review。
 * 每个执行器在自己的文件里实现 Executor 并登记；事件循环拿到一个事件，按 canHandle 从登记表里
 * 找第一个认的，调它的 run 做这一步。
 *
 * **一次 run 只做一步**（docs/05_框架设计.md 6.1）：一次 run = 一次模型调用 + 这次要用的工具
 * + 一次判断，做完就返回；下一步做什么放进返回的 next，由事件循环写进事件表。这样中断只丢正在
 * 跑的那一步——断电、换版本、进程被杀，恢复时事件表把 running 改回 pending 重跑这一步就行，
 * 不用从头再来；顺序也真的存在事件里，不是写死在 for 循环里。
 *
 * 这一版只有接口和登记表，先不接线：三个执行器怎么实现、事件循环怎么调，之后再做。
 */
import type * as resourcesModule from '../resources/Resources.ts';
import type * as eventsModule from '../events/Events.ts';


/** 事件类型：只有这三种（docs/05_框架设计.md 5.2）；没有 route 事件，也没有 reply 事件。 */
export type EventKind = 'message' | 'execution' | 'review';


/** 下一步要做的事：执行器做完一步后，交给事件循环写进事件表的新事件。 */
export interface NewEvent {
  /** 事件类型：这个新事件归哪一类，事件循环之后按它找执行器。 */
  type: EventKind;

  /** 事件内容：这一步留给下一步的东西（会话 ID、交给谁、上一步的结果等），具体结构由产生它的执行器定。 */
  payload: unknown;
}


/** 流水行：写进人看的 流水.log 的一行（docs/05_框架设计.md 5.9）；事件循环拿它去调 日志库.note()。 */
export interface TimelineLine {
  /** 谁做的这事，写成“模块.函数”，如 干活执行器.run()；人对着它找代码。 */
  who: string;

  /** 做到的什么，一句话。 */
  what: string;
}


/** 一次 run 的返回（docs/05_框架设计.md 6.1）：状态、要发回去的话、下一步的新事件、要写进流水的行。 */
export interface StepResult {
  /** 这一步的结局：completed 做完、failed 失败、paused 等用户确认后才能接着做。 */
  status: 'completed' | 'failed' | 'paused';

  /** 要发回去的话，事件循环拿它去调 渠道.send()；没有话就不写这一项。 */
  reply?: string;

  /** 下一步做什么，零到多条；事件循环用 事件表.finish() 和这个事件一起写进去。 */
  next: NewEvent[];

  /** 要写进流水的那几行；没有就不写。 */
  timeline: TimelineLine[];
}


/** 一次 run 的入参：资源、事件、会话三样。 */
export interface RunInput {
  /** 资源：配置、模型清单、角色、工作区、设置；执行器从这里拿“有什么”，不自己去读 config.yaml。 */
  resources: resourcesModule.Resources;

  /** 这次要处理的事件：从 id 知道是哪件事，从 type 和 payload 知道要做什么。 */
  event: eventsModule.EventRow;

  /** 这个事件所属的会话：带机器人、智能体、工作区、来源、状态。 */
  session: eventsModule.SessionRow;
}


/** 执行器：事件循环只认这一套，不认识具体是哪个执行器。 */
export interface Executor {
  /** 执行器名，写流水和报错用，如 '接话执行器'。 */
  name(): string;

  /** 这个事件归不归我：按事件的类型（需要时再看 payload）判断；一次 run 只做一步，一个事件只该有一个执行器认。 */
  canHandle(event: eventsModule.EventRow): boolean;

  /** 做这一步，返回状态、要发回去的话、下一步的新事件、要写进流水的行；具体副作用（调模型、跑工具）由各执行器自己定，这一版还没有实现。 */
  run(input: RunInput): Promise<StepResult>;
}


/** 登记表：按登记顺序排的执行器；找执行器时取第一个认的。 */
const executors: Executor[] = [];


/**
 * 登记一个执行器。
 * @param executor 执行器；按 name() 认人。
 * 副作用：写进登记表，排在已有执行器的后面（先登记的优先）。
 * @throws 同名重复登记时抛错，免得两处代码抢一个名字。
 */
export function registerExecutor(executor: Executor): void {
  //G 同一个名字登记两次，多半是代码写错了，早点报出来。
  if (executors.some((registered) => registered.name() === executor.name())) {
    throw new Error(`执行器 ${executor.name()} 已经登记过了`);
  }
  executors.push(executor);
}


/**
 * 找能处理这个事件的执行器。
 * @param event 要处理的事件。
 * @returns 第一个认这个事件的执行器，顺序就是登记顺序，不是随机。
 * @throws 没有执行器认这个事件时抛错，错误里带事件号（如 #12）和事件类型（如 review）；
 * 不返回 undefined 让调用方忘了判断。
 */
export function findExecutor(event: eventsModule.EventRow): Executor {
  /** 登记顺序里第一个认这个事件的执行器。 */
  const executor = executors.find((registered) => registered.canHandle(event));
  //G 找不到就报清楚：事件类型和事件号都要有，才看得出是哪条事件没人管。
  if (executor === undefined) {
    throw new Error(`没有执行器能处理事件 #${event.id}（类型 ${event.type}）`);
  }
  return executor;
}


/**
 * 登记表里现在有哪些执行器。
 * @returns 执行器的副本，顺序和登记顺序一致；外面改这个数组不影响登记表。
 */
export function listExecutors(): Executor[] {
  //M 返回副本：调用方排序、清空都打乱不了登记表。
  return [...executors];
}


/**
 * 清空登记表。
 * 只给测试用：每个用例开始前清一下，互不影响。正式代码里不要调。
 * 副作用：登记过的执行器全没了。
 */
export function clearExecutors(): void {
  executors.length = 0;
}
