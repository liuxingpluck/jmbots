/**
 * 测试里建各个业务对象的小工具：都从一份测试用的依赖（Deps）建，建法和入口 src/entries/App.ts 一样。
 * 各个测试文件不再自己写 dispatcherOf、botLoopOf 这类小函数。
 */
import * as botLoopModule from '../src/bots/BotLoop.ts';
import * as agentTasksModule from '../src/capabilities/AgentTasks.ts';
import * as contextModule from '../src/capabilities/Context.ts';
import * as miniLoopModule from '../src/capabilities/MiniLoop.ts';
import * as progressModule from '../src/capabilities/Progress.ts';
import * as reviewModule from '../src/capabilities/Review.ts';
import * as updateWatchModule from '../src/capabilities/UpdateWatch.ts';
import * as toolsModule from '../src/capabilities/tools/Tools.ts';
import * as dispatchModule from '../src/dispatch/Dispatch.ts';
import * as agentLoop from '../src/executors/AgentLoop.ts';
import * as execReview from '../src/executors/ExecReview.ts';
import * as runsModule from '../src/executors/Runs.ts';
import type * as httpModule from '../src/channels/Http.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import type * as modelModule from '../src/capabilities/Model.ts';
import type * as approvalsModule from '../src/capabilities/Approvals.ts';
import * as eventsModule from '../src/capabilities/Events.ts';
import type * as filesModule from '../src/capabilities/Files.ts';
import type * as secretsModule from '../src/capabilities/Secrets.ts';
import type * as storeModule from '../src/capabilities/Store.ts';
import type * as resourcesModule from '../src/resources/Resources.ts';


/**
 * 测试用的一包对象：各个测试搭好（真的数据库、文件库，假的模型、渠道），下面的 …Of 函数从它拆出各个类要的对象。
 * 生产代码里没有这一包：入口 src/entries/App.ts 把对象一个个建好、需要谁传谁。
 */
export interface TestDeps {
  /** 资源：config.yaml、机器人、提示词（只读）。 */
  resources: resourcesModule.Resources;
  /** 数据库：收件表和会话表。 */
  store: storeModule.Store;
  /** 文件库：机器人文件夹里的文件、技能。 */
  files: filesModule.Files;
  /** 模型库（多半是 fakeAi 做的假的）。 */
  ai: modelModule.Ai;
  /** 密钥替身。 */
  secrets: secretsModule.Secrets;
  /** 待确认。 */
  approvals: approvalsModule.Approvals;
  /** 往渠道发东西（多半是记下发了什么的假出口）；对象拿到的是 outOf 转发过的，换了照样生效。 */
  out: depsModule.Outlet;
  /** 测试可预先提供进度对象；未提供时构造真实 Progress。 */
  progress?: progressModule.Progress;
  /** 测试可预先提供事件总线；未提供时构造真实 EventBus。 */
  events?: eventsModule.EventBus;
}


/**
 * 获取测试共享的真实事件总线；只在测试组装处补齐依赖。
 * @param deps 测试用的依赖。
 * @returns 事件总线。
 */
export function eventsOf(deps: TestDeps): eventsModule.EventBus {
  if (!deps.events) {
    deps.events = new eventsModule.EventBus(deps.store, deps.resources, deps.secrets);
  }
  return deps.events;
}


/** 获取测试共享的真实进度对象；只在测试组装处补齐依赖。 */
function sharedProgress(deps: TestDeps): progressModule.Progress {
  if (!deps.progress) {
    deps.progress = progressOf(deps);
  }
  return deps.progress;
}


/** 建测试用的小循环，模型替身由调用者提供。 */
export function miniLoopOf(deps: TestDeps): miniLoopModule.MiniLoop {
  return new miniLoopModule.MiniLoop(deps.ai, deps.secrets);
}


/**
 * 建外部 AI 任务通道。
 * @param deps 测试用的依赖（取运行时目录）。
 * @returns 任务通道。
 */
export function agentTaskChannelOf(deps: TestDeps): agentTasksModule.AgentTaskChannel {
  return new agentTasksModule.AgentTaskChannel(deps.resources.dir);
}


/**
 * 建记忆库搜索。
 * @param deps 测试用的依赖。
 * @returns 记忆库搜索。
 */
export function memorySearchOf(deps: TestDeps): contextModule.MemorySearch {
  return new contextModule.MemorySearch(deps.resources);
}


/**
 * 建工具库。
 * @param deps 测试用的依赖。
 * @returns 工具库。
 */
export function toolBoxOf(deps: TestDeps): toolsModule.ToolBox {
  return new toolsModule.ToolBox(
    deps.resources,
    deps.store,
    deps.files,
    deps.ai,
    deps.secrets,
    outOf(deps),
    agentTaskChannelOf(deps),
    memorySearchOf(deps),
    eventsOf(deps),
  );
}


/**
 * 建分派。
 * @param deps 测试用的依赖。
 * @returns 分派。
 */
export function dispatcherOf(deps: TestDeps): dispatchModule.Dispatcher {
  return new dispatchModule.Dispatcher(
    deps.resources,
    deps.store,
    deps.files,
    deps.ai,
    deps.approvals,
    miniLoopOf(deps),
    toolBoxOf(deps),
    eventsOf(deps),
  );
}


/**
 * 建命令审核器。
 * @param deps 测试用的依赖。
 * @returns 命令审核器。
 */
export function reviewerOf(deps: TestDeps): execReview.ExecReviewer {
  return new execReview.ExecReviewer(
    deps.resources,
    deps.store,
    deps.files,
    deps.ai,
    deps.approvals,
    miniLoopOf(deps),
    toolBoxOf(deps),
    outOf(deps),
  );
}


/**
 * 建命令窗口。
 * @param deps 测试用的依赖。
 * @returns 命令窗口（审核器用 reviewerOf 建的）。
 */
export function runsOf(deps: TestDeps): runsModule.Runs {
  return new runsModule.Runs(deps.resources, deps.approvals, reviewerOf(deps));
}


/**
 * 建会话运行器。
 * @param deps 测试用的依赖。
 * @returns 会话运行器。
 */
export function runnerOf(deps: TestDeps): agentLoop.SessionRunner {
  return new agentLoop.SessionRunner({
    resources: deps.resources,
    store: deps.store,
    files: deps.files,
    ai: deps.ai,
    out: outOf(deps),
    progress: sharedProgress(deps),
    reviewer: reviewerOf(deps),
    toolBox: toolBoxOf(deps),
    memorySearch: memorySearchOf(deps),
    events: eventsOf(deps),
  });
}


/**
 * 建机器人循环。
 * @param deps 测试用的依赖。
 * @returns 机器人循环。
 */
export function botLoopOf(deps: TestDeps): botLoopModule.BotLoop {
  return new botLoopModule.BotLoop(
    deps.resources,
    deps.store,
    deps.files,
    deps.ai,
    deps.approvals,
    outOf(deps),
    dispatcherOf(deps),
    runnerOf(deps),
    sharedProgress(deps),
    eventsOf(deps),
  );
}


/**
 * 建进度登记表。
 * @param deps 测试用的依赖。
 * @param minuteMs 一分钟算多少毫秒；测试里常缩成 10。
 * @returns 进度登记表。
 */
export function progressOf(deps: TestDeps, minuteMs?: number): progressModule.Progress {
  const outlet = outOf(deps);
  const events = eventsOf(deps);
  return new progressModule.Progress(
    deps.resources,
    deps.store,
    deps.ai,
    outlet,
    events,
    minuteMs,
  );
}


/**
 * 建复盘。
 * @param deps 测试用的依赖。
 * @returns 复盘。
 */
export function runReviewOf(deps: TestDeps): reviewModule.RunReview {
  return new reviewModule.RunReview(
    deps.resources,
    deps.store,
    deps.files,
    deps.ai,
    deps.approvals,
    outOf(deps),
  );
}


/**
 * 建更新监视。
 * @param deps 测试用的依赖。
 * @returns 更新监视。
 */
export function updateWatchOf(deps: TestDeps): updateWatchModule.UpdateWatch {
  return new updateWatchModule.UpdateWatch(deps.resources, deps.approvals, outOf(deps));
}


/**
 * 转发的出口：每次调用时才去读 deps.out。测试常在建好对象以后才换 deps.out（换成记录发了什么的假出口），
 * 类在构造时就把出口存成字段，直接传 deps.out 就跟不上了；传这个，建的先后就无所谓。
 * @param deps 测试用的依赖。
 * @returns 出口。
 */
export function outOf(deps: TestDeps): depsModule.Outlet {
  return {
    send: (...args) => deps.out.send(...args),
    stopTyping: (...args) => deps.out.stopTyping?.(...args) ?? Promise.resolve(),
    sendApproval: (...args) => deps.out.sendApproval(...args),
    publishDoc: (...args) => deps.out.publishDoc(...args),
    deleteDoc: (...args) => deps.out.deleteDoc(...args),
    channelStatus: () => deps.out.channelStatus?.() ?? [],
    addChannel: (...args) => deps.out.addChannel?.(...args) ?? Promise.reject(new Error('这个出口不能加渠道')),
    sendProgress: (...args) => deps.out.sendProgress?.(...args) ?? Promise.resolve(undefined),
    updateProgress: (...args) => deps.out.updateProgress?.(...args) ?? Promise.resolve(),
  };
}


/**
 * HTTP 这一层要用的对象（src/channels/Http.ts 的 HttpParts）：从测试用的依赖建，可以换掉其中几样（比如假的机器人循环）。
 * @param deps 测试用的依赖。
 * @param overrides 要换掉的几样。
 * @returns HttpParts。
 */
export function httpPartsOf(deps: TestDeps, overrides: Partial<httpModule.HttpParts> = {}): httpModule.HttpParts {
  return {
    resources: deps.resources,
    store: deps.store,
    files: deps.files,
    ai: deps.ai,
    secrets: deps.secrets,
    approvals: deps.approvals,
    progress: sharedProgress(deps),
    out: outOf(deps),
    botLoop: overrides.botLoop ?? botLoopOf(deps),
    agentTaskChannel: overrides.agentTaskChannel ?? agentTaskChannelOf(deps),
    runs: overrides.runs ?? runsOf(deps),
    toolBox: overrides.toolBox ?? toolBoxOf(deps),
    events: eventsOf(deps),
    ...overrides,
  };
}


/**
 * 假的模型库：测试只写 chat、decide、hasDecision、listModels 四个方法，
 * 这里把它当作 Ai（Ai 是 class，有私有字段，对象字面量不能直接当它用）。
 * @param parts 四个方法的假实现。
 * @returns 当作 Ai 用的假对象。
 */
export function fakeAi(
  parts: Pick<modelModule.Ai, 'chat' | 'decide' | 'hasDecision' | 'listModels'>,
): modelModule.Ai {
  return parts as unknown as modelModule.Ai;
}
