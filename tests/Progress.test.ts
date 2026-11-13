/**
 * 进度卡片（src/capabilities/Progress.ts，docs/界面/任务书/进度卡片_DSH.md）的离线测试。
 * 用假的渠道（发卡、改卡、发文字都记下调用）、内存数据库、临时运行时目录和固定文字的假模型；
 * new Progress(...)（minuteMs 传 10，经 progressOf） 把一分钟缩成 10 毫秒，好让限时在测试里真的走到。
 * 覆盖：一条消息一张卡、合并插话、终止、限时（从 startedAt 算、超限时马上收尾、不限时）、
 * 限时新规则（默认上限、报时、到点判断延长、延够两次停下、没配判断模型直接停）、
 * 限时第 5 条（审核发现离谱、转新会话、转不成、只转一次、审核读不出结论、limit_review_model）、
 * 收尾总结只调一次模型、结束的卡、画不了卡片的渠道、list(bot)、飞书卡片按钮与回调、HTTP 接口。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import * as eventsModule from '../src/capabilities/Events.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import type * as model from '../src/capabilities/Model.ts';
import * as progressModule from '../src/capabilities/Progress.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as feishu from '../src/channels/Feishu.ts';
import * as http from '../src/channels/Http.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import * as builders from './Builders.ts';
import type * as botLoopModule from '../src/bots/BotLoop.ts';
import type * as dispatchModule from '../src/dispatch/Dispatch.ts';


/** 测试用的模型 ID：会话、默认模型、收尾模型都用它。 */
const MODEL_ID = 'fake/test';

/** 假模型固定回的收尾总结（短于截短上限，结果里应原样出现）。 */
const WRAPUP_TEXT = '做到哪了：写完两段；卡在哪：工具慢；还剩：接着测';

/** 假的渠道卡片号。 */
const CARD_HANDLE = 'card-1';

/** 合并改写窗口（PUSH_EVERY_MS=1000）：等它触发一次，证明中间阶段是“改”。 */
const PUSH_WAIT_MS = 1050;

/** 用例超时，毫秒：有几个用例要等合并窗口。 */
const TEST_TIMEOUT_MS = 30_000;


/** 发出去的一条文字。 */
interface Sent {
  /** 渠道。 */
  channel: string;
  /** 回复地址。 */
  address: Record<string, unknown>;
  /** 文字。 */
  text: string;
}


/** 发过的一张卡片。 */
interface SentCard {
  /** 渠道。 */
  channel: string;
  /** 回复地址。 */
  address: Record<string, unknown>;
  /** 当时的卡片。 */
  view: progressModule.ProgressView;
}


/** 改过的一次卡片。 */
interface UpdatedCard {
  /** 渠道。 */
  channel: string;
  /** 渠道里的卡片号。 */
  handle: string;
  /** 当时的卡片。 */
  view: progressModule.ProgressView;
}


/** 一套测试用的依赖和记录。 */
interface Harness {
  /** 依赖。 */
  deps: builders.TestDeps;
  /** 内存数据库。 */
  store: storeModule.Store;
  /** 发出去的文字。 */
  sent: Sent[];
  /** 发过的卡片。 */
  sentCards: SentCard[];
  /** 改过的卡片。 */
  updatedCards: UpdatedCard[];
  /** 假模型收到的每次对话参数。 */
  chatCalls: model.ChatInput[];
}


/**
 * 建依赖：临时运行时目录、一个机器人“小测”、内存数据库，假渠道和假模型。
 * @param noCard 为真时 sendProgress 回 undefined，模拟渠道画不了卡片。
 * @param overtimeMinutes 给了就写进 config.yaml 的 engine.overtime_minutes，调小超时登记阈值；不给用默认 10 分钟。
 * @returns 依赖和记录。
 * 副作用：在系统临时目录造 config.yaml（不含密钥）和机器人目录。
 */
async function setup(noCard = false, overtimeMinutes?: number): Promise<Harness> {
  /** 临时运行时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-progress-'));
  /** 可选的一行：把超时登记阈值写进 engine 段，不给就用默认 10 分钟。 */
  let overtimeLine = '';
  //G 只有显式给了阈值才写这一行，别的用例保持原来的 config.yaml（默认 10 分钟）。
  if (overtimeMinutes !== undefined) {
    overtimeLine = `  overtime_minutes: ${overtimeMinutes}\n`;
  }
  fs.writeFileSync(path.join(dir, 'config.yaml'), `providers: {}\ndefault_model: ${MODEL_ID}\nbots:\n  - name: 小测\n    language: zh\nhttp:\n  port: 1\n  token: tk-fake\nengine:\n  poll_ms: 10\n  limit_default_minutes: 1000\n${overtimeLine}`);
  /** 资源（只读）。 */
  const resources = await resourcesModule.Resources.load(dir);
  /** 文件库。 */
  const files = new filesModule.Files(resources);
  await files.ensureBot('小测');
  /** 内存数据库。 */
  const store = new storeModule.Store(':memory:');
  /** 发出去的文字。 */
  const sent: Sent[] = [];
  /** 发过的卡片。 */
  const sentCards: SentCard[] = [];
  /** 改过的卡片。 */
  const updatedCards: UpdatedCard[] = [];
  /** 假模型收到的参数。 */
  const chatCalls: model.ChatInput[] = [];
  /** 假模型：chat 固定回 WRAPUP_TEXT，listModels 给全思考档。 */
  const ai = builders.fakeAi({
    chat: (input) => {
      chatCalls.push(input);
      return Promise.resolve(chatOutput(WRAPUP_TEXT));
    },
    decide: () => Promise.reject(new Error('没有决策模型')),
    hasDecision: () => false,
    listModels: () => [{ id: MODEL_ID, name: 'test', kind: 'chat', contextWindow: 100_000, thinking: ['off', 'low', 'medium', 'high'], vision: true, price: { input: 0, output: 0 } }],
  });
  /** 假渠道：发、改、发文字都只记下调用。 */
  const out: depsModule.Outlet = {
    send: (channel, address, text) => {
      sent.push({ channel, address, text });
      return Promise.resolve();
    },
    sendApproval: () => Promise.resolve([]),
    publishDoc: () => Promise.reject(new Error('无')),
    deleteDoc: () => Promise.reject(new Error('无')),
    sendProgress: (channel, address, view) => {
      sentCards.push({ channel, address, view });
      return Promise.resolve(noCard ? undefined : CARD_HANDLE);
    },
    updateProgress: (channel, handle, view) => {
      updatedCards.push({ channel, handle, view });
      return Promise.resolve();
    },
  };
  /** 依赖。 */
  const deps: builders.TestDeps = { resources, files, ai, store, secrets: new secretsModule.Secrets([]), approvals: new approvalsModule.Approvals(), out };
  return { deps, store, sent, sentCards, updatedCards, chatCalls };
}


/**
 * 假模型的一次回复（Pi 的格式给全）。
 * @param text 回复的文字。
 * @returns 一次对话的结果。
 */
function chatOutput(text: string): model.ChatOutput {
  /** 假回复。 */
  const message = { role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'fake', model: 'test', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } as piAi.AssistantMessage;
  return { message, text, thinking: '', toolCalls: [], ms: 1, request: { model: MODEL_ID, thinkingAsked: 'off', thinking: 'off', system: '', tools: [], messages: [] } };
}


/**
 * 往真内存库里记一条收件，返回带自增 id 的行。
 * @param h 依赖和记录。
 * @param bot 哪个机器人。
 * @param text 原话。
 * @returns 收件行。
 * 副作用：写库。
 */
function addRow(h: Harness, bot: string, text: string): storeModule.MessageRow {
  return h.store.addMessage({ bot, channel: 'http', source: '测试', address: {}, file: '', text });
}


/**
 * 开一个正在跑的会话（interrupt 只有 running 才写得进去）。
 * @param h 依赖和记录。
 * @returns 会话行。
 * 副作用：写库。
 */
function openSession(h: Harness): storeModule.SessionRow {
  /** 新会话。 */
  const session = h.store.createSession({ bot: '小测', workspace: '日常', title: '一件事', model: MODEL_ID, thinking: null });
  return h.store.updateSession(session.id, { status: 'running' });
}


/**
 * 造分派记录（Progress 只用 ms）。
 * @param ms 分派用了多久。
 * @returns 分派记录。
 */
function recordOf(ms: number): dispatchModule.DispatchRecord {
  return { ms } as dispatchModule.DispatchRecord;
}


/**
 * 等排队的发卡/改卡跑完（send 是串成 Promise 链的异步操作）。
 * @param ms 等多久，毫秒。
 */
async function flush(ms = 20): Promise<void> {
  await Bun.sleep(ms);
}


/**
 * 等到条件成立（最多 5 秒）。
 * @param condition 条件。
 * @param what 在等什么。
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let index = 0; index < 500; index += 1) {
    if (condition()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`等不到：${what}`);
}


/**
 * 造一张给渠道画卡片用的视图。
 * @param overrides 要覆盖的字段。
 * @returns 卡片视图。
 */
function viewOf(overrides: Partial<progressModule.ProgressView> = {}): progressModule.ProgressView {
  return { id: 1, bot: '小测', messageIds: [1], text: '干活', stage: 'running', action: '正在做', startedAt: Date.now() - 1000, timings: { dispatchMs: 100, modelMs: 0, steps: 0, tools: [] }, ...overrides };
}


/**
 * 读超时登记文件（data/overtime.jsonl）里已经落下的每一行。
 * @param h 依赖和记录。
 * @returns 每行解析成对象；文件还没写出来、还是空的，返回空数组。
 */
function overtimeLines(h: Harness): Record<string, unknown>[] {
  /** 登记文件：close() 用 mkdir().then(appendFile()) 异步写，可能还没出现。 */
  const file = path.join(h.deps.resources.dir, 'data', 'overtime.jsonl');
  //G 文件没建好就当 0 行：断言“不记”的用例靠这个拿到空数组。
  if (!fs.existsSync(file)) {
    return [];
  }
  /** 全文（去掉末尾换行）。 */
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) {
    return [];
  }
  //M 一行一条 JSON，逐行解析；追加写不会覆盖前面的行。
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}


/**
 * 等超时登记文件攒够 N 行（close() 写文件是 fire-and-forget，断言前必须轮询）。
 * @param h 依赖和记录。
 * @param count 要等到的行数。
 */
async function untilOvertime(h: Harness, count: number): Promise<void> {
  await until(() => {
    //G 正好读到写了一半的行会 JSON.parse 失败：当没攒够，下一轮再看。
    try {
      return overtimeLines(h).length >= count;
    } catch {
      return false;
    }
  }, `超时登记攒够 ${count} 行`);
}


bunTest.describe('耗时文字（纯函数）', () => {
  bunTest.test('formatDuration：秒和分', () => {
    bunTest.expect(progressModule.formatDuration(12_300)).toBe('12.3 秒');
    bunTest.expect(progressModule.formatDuration(125_000)).toBe('2 分 5 秒');
  });

  bunTest.test('describeTimings：分派、思考几步、工具次数和耗时、总共', () => {
    /** 一张走了 5 步、调过两种工具的卡。 */
    const view = viewOf({ timings: { dispatchMs: 2100, modelMs: 40_200, steps: 5, tools: [{ name: 'find', count: 3, ms: 18_400 }, { name: 'read', count: 5, ms: 2100 }] }, endedAt: Date.now() });
    /** 说成的一句话。 */
    const text = progressModule.describeTimings(view);
    bunTest.expect(text).toContain('分派 2.1 秒');
    bunTest.expect(text).toContain('思考 5 步 40.2 秒');
    bunTest.expect(text).toContain('find ×3 18.4 秒');
    bunTest.expect(text).toContain('read ×5 2.1 秒');
    bunTest.expect(text).toContain('总共');
  });
});


bunTest.describe('一条消息一张卡', () => {
  bunTest.test('received → dispatched → thinking → tool → toolDone → ended(done)：只发一次，之后都是改，结束马上改', async () => {
    const h = await setup();
    /** 登记表：一分钟当 10 毫秒。 */
    const progress = builders.progressOf(h.deps, 10);
    /** 一批话。 */
    const rows = [addRow(h, '小测', '干活')];
    /** 正在跑的会话。 */
    const session = openSession(h);

    progress.received(rows);
    await flush();
    bunTest.expect(h.sentCards).toHaveLength(1);
    bunTest.expect(h.updatedCards).toHaveLength(0);

    progress.dispatched(rows, session.id, recordOf(120));
    await Bun.sleep(PUSH_WAIT_MS);
    progress.thinking(session.id, 1, MODEL_ID);
    progress.thought(session.id, 20, '先看看');
    progress.thinking(session.id, 2, MODEL_ID);
    progress.thought(session.id, 25, '接着做');
    await Bun.sleep(PUSH_WAIT_MS);
    progress.tool(session.id, 'read', { path: 'a.ts' });
    progress.toolDone(session.id, 'read', { path: 'a.ts' }, 18, '文件内容');
    progress.tool(session.id, 'find', { pattern: 'TODO' });
    progress.toolDone(session.id, 'find', { pattern: 'TODO' }, 30, '找到 2 处');
    await Bun.sleep(PUSH_WAIT_MS);

    /** 结束前的改写次数。 */
    const before = h.updatedCards.length;
    progress.ended(session.id, 'done', '做完了');
    //M 只等 20ms（远小于 1000ms 合并窗口）就多一次改：结束是马上改的。
    await flush(20);
    bunTest.expect(h.sentCards).toHaveLength(1);
    bunTest.expect(h.updatedCards.length).toBe(before + 1);
    bunTest.expect(h.updatedCards.every((item) => item.handle === CARD_HANDLE)).toBe(true);

    /** 定格后的卡片。 */
    const view = progress.list()[0]!;
    bunTest.expect(view.stage).toBe('done');
    bunTest.expect(view.result).toBe('做完了');
    bunTest.expect(view.timings.steps).toBe(2);
    bunTest.expect(view.timings.modelMs).toBeGreaterThan(0);
    /** 各段耗时那句话。 */
    const text = progressModule.describeTimings(view);
    bunTest.expect(text).toContain('分派');
    bunTest.expect(text).toContain('思考 2 步');
    bunTest.expect(text).toContain('read ×1');
    bunTest.expect(text).toContain('find ×1');
    bunTest.expect(text).toContain('总共');
  }, TEST_TIMEOUT_MS);

  bunTest.test('同一会话已有卡在跑时再 dispatched：话并进那张，新卡阶段 merged', async () => {
    const h = await setup();
    const progress = builders.progressOf(h.deps, 10);
    const session = openSession(h);
    /** 第一批。 */
    const first = [addRow(h, '小测', '第一句')];
    /** 插进来的第二批。 */
    const second = [addRow(h, '小测', '插一句')];
    progress.received(first);
    progress.dispatched(first, session.id, recordOf(50));
    await flush();
    progress.received(second);
    await flush();
    progress.dispatched(second, session.id, recordOf(50));
    await flush();
    /** 新的在前：插进来的那张（merged）。 */
    const list = progress.list();
    bunTest.expect(list[0]!.stage).toBe('merged');
    bunTest.expect(list[0]!.endedAt).toBeDefined();
    bunTest.expect(list[1]!.stage).toBe('running');
    bunTest.expect(list[1]!.messageIds).toEqual([...first.map((row) => row.id), ...second.map((row) => row.id)]);
  }, TEST_TIMEOUT_MS);

  bunTest.test('渠道画不了卡片（sendProgress 回 undefined）：以后不再改', async () => {
    const h = await setup(true);
    const progress = builders.progressOf(h.deps, 10);
    const rows = [addRow(h, '小测', '干活')];
    const session = openSession(h);
    progress.received(rows);
    await flush();
    bunTest.expect(h.sentCards).toHaveLength(1);
    progress.dispatched(rows, session.id, recordOf(50));
    await Bun.sleep(PUSH_WAIT_MS);
    progress.tool(session.id, 'read', { path: 'a.ts' });
    progress.ended(session.id, 'done', '做完了');
    await flush();
    bunTest.expect(h.sentCards).toHaveLength(1);
    bunTest.expect(h.updatedCards).toHaveLength(0);
  }, TEST_TIMEOUT_MS);
});


bunTest.describe('按钮动作', () => {
  bunTest.test("act(stop)：会话在跑时写 interrupt；ended('interrupted') 后阶段 stopped", async () => {
    const h = await setup();
    const progress = builders.progressOf(h.deps, 10);
    const rows = [addRow(h, '小测', '干活')];
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    await flush();
    bunTest.expect(progress.act(1, 'stop')).toBe('收到，马上停');
    bunTest.expect(h.store.getSession(session.id)!.interrupt).toBe(rows.at(-1)!.id);
    progress.ended(session.id, 'interrupted', '');
    await flush();
    bunTest.expect(progress.list()[0]!.stage).toBe('stopped');
    bunTest.expect(h.chatCalls).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  bunTest.test("act(limit,1)：从 startedAt 算，到点写 interrupt；ended('interrupted') 后只调一次收尾模型", async () => {
    const h = await setup();
    const progress = builders.progressOf(h.deps, 10);
    const rows = [addRow(h, '小测', '干活')];
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    //M 同步连着点：startedAt 刚记下，1 分钟（=10ms）的窗口还没过，才算“到点”。
    const reply = progress.act(1, 'limit', 1);
    bunTest.expect(reply).toContain('最多做 1 分钟，还剩');
    await Bun.sleep(30);
    bunTest.expect(h.store.getSession(session.id)!.interrupt).toBe(rows.at(-1)!.id);

    progress.ended(session.id, 'interrupted', '');
    await until(() => h.chatCalls.length === 1 && h.sent.length === 1, '收尾总结写完并发出');
    bunTest.expect(h.chatCalls).toHaveLength(1);
    bunTest.expect(h.chatCalls[0]!.tools).toEqual([]);
    //M 思考档是这个模型最低的非 off 档。
    bunTest.expect(h.chatCalls[0]!.thinking).toBe('low');
    bunTest.expect(h.chatCalls[0]!.model).toBe(MODEL_ID);
    /** 定格后的卡片。 */
    const view = progress.list()[0]!;
    bunTest.expect(view.stage).toBe('timeout');
    bunTest.expect(view.result).toBe(WRAPUP_TEXT);
    bunTest.expect(h.store.getMessage(rows.at(-1)!.id)!.replies.map((item) => item.text).join('\n')).toContain(WRAPUP_TEXT);
    bunTest.expect(h.sent[0]!.text).toContain(WRAPUP_TEXT);
    /** 总结正文来自此次收尾调用，外层提示是程序包装，不冒充会话生成。 */
    const generation = h.store.getMessage(rows.at(-1)!.id)!.replies.at(-1)!.generation!;
    bunTest.expect(generation.kind).toBe('model-wrapped');
    bunTest.expect(generation.model).toBe(MODEL_ID);
    bunTest.expect(generation.purpose).toBe('wrapup');
    bunTest.expect(generation.thinkingReported).toBeNull();
  }, TEST_TIMEOUT_MS);

  bunTest.test('收尾模型失败时回复仍是程序失败提示，不冒充成功的总结模型', async () => {
    const h = await setup();
    h.deps.ai.chat = () => Promise.resolve({ ...chatOutput(''), error: '模型暂时不可用' });
    const progress = builders.progressOf(h.deps, 10);
    const row = addRow(h, '小测', '干活');
    const session = openSession(h);
    progress.received([row]);
    progress.dispatched([row], session.id, recordOf(50));
    progress.act(1, 'limit', 1);
    await Bun.sleep(30);
    progress.ended(session.id, 'interrupted', '');
    await until(() => h.sent.length === 1, '失败提示发出');
    const reply = h.store.getMessage(row.id)!.replies.at(-1)!;
    bunTest.expect(reply.text).toContain('收尾总结没写成');
    bunTest.expect(reply.generation?.kind).toBe('program');
    bunTest.expect(reply.generation?.model).toBeNull();
  }, TEST_TIMEOUT_MS);

  bunTest.test('开始后已经超过限时再点：马上写 interrupt，回“已经超过 … 马上收尾”', async () => {
    const h = await setup();
    const progress = builders.progressOf(h.deps, 10);
    const rows = [addRow(h, '小测', '干活')];
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    //M 一分钟=10ms：等 30ms，模拟活儿已经干了 3 分钟，再点“最多 1 分钟”就已超限。
    await Bun.sleep(30);
    bunTest.expect(h.store.getSession(session.id)!.interrupt).toBeNull();
    const reply = progress.act(1, 'limit', 1);
    bunTest.expect(reply).toBe('已经超过 1 分钟，马上收尾');
    await flush(20);
    //M 还没 ended 就已经写了 interrupt：是 act 自己马上叫停的，不是等会话结束。
    bunTest.expect(h.store.getSession(session.id)!.interrupt).toBe(rows.at(-1)!.id);
    bunTest.expect(progress.list()[0]!.endedAt).toBeUndefined();
  }, TEST_TIMEOUT_MS);

  bunTest.test('act(limit) 不给分钟：不限时，取消定时器', async () => {
    const h = await setup();
    const progress = builders.progressOf(h.deps, 10);
    const rows = [addRow(h, '小测', '干活')];
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    bunTest.expect(progress.act(1, 'limit', 1)).toContain('最多做 1 分钟，还剩');
    bunTest.expect(progress.act(1, 'limit')).toBe('不限时，一直做，也不报时');
    bunTest.expect(progress.list()[0]!.limitMinutes).toBeUndefined();
    //M 等过 10ms：定时器若没取消，会把卡标成 timeout、并写 interrupt。
    await Bun.sleep(30);
    bunTest.expect(h.store.getSession(session.id)!.interrupt).toBeNull();
    progress.ended(session.id, 'done', '做完了');
    await flush();
    bunTest.expect(progress.list()[0]!.stage).toBe('done');
    bunTest.expect(h.chatCalls).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  bunTest.test('结束的卡片 act 回“这件事已经结束了”', async () => {
    const h = await setup();
    const progress = builders.progressOf(h.deps, 10);
    const rows = [addRow(h, '小测', '干活')];
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    progress.ended(session.id, 'done', '做完了');
    await flush();
    bunTest.expect(progress.act(1, 'stop')).toBe('这件事已经结束了');
    bunTest.expect(progress.act(1, 'limit', 5)).toBe('这件事已经结束了');
  }, TEST_TIMEOUT_MS);
});


bunTest.describe('list(bot)', () => {
  bunTest.test('只给这个机器人的，新的在前', async () => {
    const h = await setup();
    const progress = builders.progressOf(h.deps, 10);
    progress.received([addRow(h, '小测', '第一句')]);
    progress.received([addRow(h, '别的', '另一句')]);
    progress.received([addRow(h, '小测', '第三句')]);
    await flush();
    bunTest.expect(progress.list('小测').map((item) => item.id)).toEqual([3, 1]);
    bunTest.expect(progress.list('别的').map((item) => item.id)).toEqual([2]);
    bunTest.expect(progress.list().map((item) => item.id)).toEqual([3, 2, 1]);
    bunTest.expect(progress.list('没人')).toEqual([]);
  }, TEST_TIMEOUT_MS);
});


bunTest.describe('飞书渠道（假传输层）', () => {
  bunTest.test("onCardAction 收到 kind:'progress' 会调 deps.progress.act", async () => {
    const h = await setup();
    /** act 收到的参数。 */
    const actCalls: [number, 'stop' | 'limit', number | undefined][] = [];
    h.deps.progress = {
      act: (id: number, action: 'stop' | 'limit', minutes?: number): string => {
        actCalls.push([id, action, minutes]);
        return '收到，马上停';
      },
    } as unknown as progressModule.Progress;
    /** listen 捕获到的点卡片回调。 */
    let onCard: ((action: feishu.CardAction) => Promise<unknown>) | undefined;
    /** 假传输层。 */
    const transport: feishu.FeishuTransport = {
      listen: (_event, card) => {
        onCard = card;
        return Promise.resolve();
      },
      sendText: () => Promise.resolve('m1'),
      close: () => undefined,
    };
    const channel = feishu.createFeishuChannel({ app_id: 'cli_test', app_secret: 'secret_xxxxxxxx', bot: '小测' }, h.deps, transport);
    const stop = await channel.start(() => Promise.resolve());
    try {
      bunTest.expect(onCard).toBeDefined();
      /** 点“终止”。 */
      const answer = await onCard!({ openId: 'ou_1', messageId: 'om_1', chatId: 'oc_1', value: { kind: 'progress', card_id: 7, action: 'stop' } });
      bunTest.expect(answer).toEqual({ toast: { type: 'info', content: '收到，马上停' } });
      /** 点“最多 15 分钟”。 */
      await onCard!({ openId: 'ou_1', messageId: 'om_1', chatId: 'oc_1', value: { kind: 'progress', card_id: 7, action: 'limit', minutes: 15 } });
      bunTest.expect(actCalls).toEqual([[7, 'stop', undefined], [7, 'limit', 15]]);
    } finally {
      await stop();
    }
  }, TEST_TIMEOUT_MS);

  bunTest.test('progressCard：没结束时 4 个按钮（15 / 20 分钟、不限时、终止），结束后没有按钮', async () => {
    const h = await setup();
    h.deps.progress = { act: (): string => '' } as unknown as progressModule.Progress;
    /** 假传输层收到的卡片。 */
    const cards: Record<string, unknown>[] = [];
    const transport: feishu.FeishuTransport = {
      listen: () => Promise.resolve(),
      sendText: () => Promise.resolve('m1'),
      sendCard: (_to, card) => {
        cards.push(card);
        return Promise.resolve('card-1');
      },
      updateCard: () => Promise.resolve(),
      close: () => undefined,
    };
    const channel = feishu.createFeishuChannel({ app_id: 'cli_test', app_secret: 'secret_xxxxxxxx', bot: '小测' }, h.deps, transport);
    const stop = await channel.start(() => Promise.resolve());
    try {
      bunTest.expect(progressModule.LIMIT_CHOICES).toEqual([15, 20]);
      await channel.sendProgress({ chatId: 'oc_1' }, viewOf());
      /** 没结束那张卡片的元素。 */
      const running = cards.at(-1)! as { elements: { tag: string; actions?: { text: { content: string }; value: Record<string, unknown> }[] }[] };
      /** 那排按钮。 */
      const action = running.elements.find((item) => item.tag === 'action');
      bunTest.expect(action?.actions?.map((item) => item.text.content)).toEqual(['最多 15 分钟', '最多 20 分钟', '不限时', '终止']);
      bunTest.expect(action?.actions?.map((item) => item.value.minutes)).toEqual([15, 20, 0, undefined]);
      bunTest.expect(action?.actions?.every((item) => item.value.kind === 'progress' && item.value.card_id === 1)).toBe(true);

      await channel.sendProgress({ chatId: 'oc_1' }, viewOf({ stage: 'done', endedAt: Date.now() }));
      /** 结束那张卡片的元素。 */
      const ended = cards.at(-1)! as { elements: { tag: string }[] };
      bunTest.expect(ended.elements.some((item) => item.tag === 'action')).toBe(false);
    } finally {
      await stop();
    }
  }, TEST_TIMEOUT_MS);
});


bunTest.describe('HTTP 接口', () => {
  bunTest.test('GET /api/progress?bot= 把 bot 交给 list；POST /api/progress/:id 解析动作与分钟', async () => {
    const h = await setup();
    /** act 收到的参数。 */
    const actCalls: [number, 'stop' | 'limit', number | undefined][] = [];
    /** list 收到的 bot。 */
    const listCalls: (string | undefined)[] = [];
    /** 两张卡，新的在前。 */
    const views: progressModule.ProgressView[] = [viewOf({ id: 2, bot: '别的' }), viewOf({ id: 1, bot: '小测' })];
    h.deps.progress = {
      act: (id: number, action: 'stop' | 'limit', minutes?: number): string => {
        actCalls.push([id, action, minutes]);
        return '假回话';
      },
      list: (bot?: string): progressModule.ProgressView[] => {
        listCalls.push(bot);
        return bot ? views.filter((item) => item.bot === bot) : views;
      },
    } as unknown as progressModule.Progress;
    const app = new http.HttpApp(builders.httpPartsOf(h.deps, {
      botLoop: {
        receive: () => Promise.reject(new Error('本用例不收消息')),
        start: () => () => undefined,
      },
    })).build();
    try {
      const all = (await app.inject({ method: 'GET', url: '/api/progress' })).json<progressModule.ProgressView[]>();
      bunTest.expect(all.map((item) => item.id)).toEqual([2, 1]);
      const one = (await app.inject({ method: 'GET', url: `/api/progress?bot=${encodeURIComponent('小测')}` })).json<progressModule.ProgressView[]>();
      bunTest.expect(one.map((item) => item.id)).toEqual([1]);
      bunTest.expect(listCalls).toEqual([undefined, '小测']);

      const stopped = (await app.inject({ method: 'POST', url: '/api/progress/1', payload: { action: 'stop' } })).json<{ text: string }>();
      bunTest.expect(stopped.text).toBe('假回话');
      const limited = (await app.inject({ method: 'POST', url: '/api/progress/2', payload: { action: 'limit', minutes: 15 } })).json<{ text: string }>();
      bunTest.expect(limited.text).toBe('假回话');
      const unlimited = (await app.inject({ method: 'POST', url: '/api/progress/2', payload: { action: 'limit' } })).json<{ text: string }>();
      bunTest.expect(unlimited.text).toBe('假回话');
      bunTest.expect(actCalls).toEqual([[1, 'stop', undefined], [2, 'limit', 15], [2, 'limit', undefined]]);
    } finally {
      await app.close();
    }
  }, TEST_TIMEOUT_MS);
});


bunTest.describe('超时登记（data/overtime.jsonl）', () => {
  bunTest.test('用得久：两张卡各追加一行，追加不覆盖，字段齐全', async () => {
    const h = await setup(false, 0.0005);
    const progress = builders.progressOf(h.deps, 10);
    /** 两张卡各进一个会话，互不合并。 */
    const sessionA = openSession(h);
    const sessionB = openSession(h);
    /** 第一张卡的话。 */
    const first = [addRow(h, '小测', '第一件事')];
    progress.received(first);
    progress.dispatched(first, sessionA.id, recordOf(50));
    //M 用够 80ms（0.0005 分 = 30ms）：让 usedMs 这一条触发登记。
    await Bun.sleep(80);
    progress.ended(sessionA.id, 'done', '做完了');
    await untilOvertime(h, 1);
    /** 第二张卡的话。 */
    const second = [addRow(h, '小测', '第二件事')];
    progress.received(second);
    progress.dispatched(second, sessionB.id, recordOf(50));
    await Bun.sleep(80);
    progress.ended(sessionB.id, 'done', '做完了');
    //M 第二行是追加：文件里原先已有 1 行，若是覆盖这里只会停在 1 行。
    await untilOvertime(h, 2);
    /** 登记的两行。 */
    const lines = overtimeLines(h);
    bunTest.expect(lines).toHaveLength(2);
    //M 两行都得是合法 JSON（overtimeLines 已逐行解析），且带齐复盘要用的字段。
    for (const line of lines) {
      bunTest.expect(line.stage).toBe('done');
      bunTest.expect(line.usedMs).toBeGreaterThan(0);
      bunTest.expect(line.bot).toBe('小测');
      bunTest.expect(line.at).toBeDefined();
      bunTest.expect(line.text).toBeDefined();
      bunTest.expect(line.messageIds).toBeDefined();
      bunTest.expect(line.timings).toBeDefined();
    }
  }, TEST_TIMEOUT_MS);

  bunTest.test('限时到点：stage=timeout 也登记，带 limitMinutes（靠 stage，不是用得久）', async () => {
    const h = await setup(false, 600);
    const progress = builders.progressOf(h.deps, 10);
    const rows = [addRow(h, '小测', '干活')];
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    progress.act(1, 'limit', 1);
    //M 一分钟=10ms：等定时器把 stopAsked 设成 timeout。
    await Bun.sleep(30);
    progress.ended(session.id, 'interrupted', '');
    //M 收尾总结是异步 wrapUp，close 在它之后才写登记：轮询等落盘。
    await untilOvertime(h, 1);
    /** 登记的那一行。 */
    const line = overtimeLines(h)[0]!;
    bunTest.expect(line.stage).toBe('timeout');
    bunTest.expect(line.limitMinutes).toBe(1);
    bunTest.expect(line.bot).toBe('小测');
    bunTest.expect(overtimeLines(h)).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  bunTest.test('用户终止：stage=stopped 也登记（靠 stage）', async () => {
    const h = await setup(false, 600);
    const progress = builders.progressOf(h.deps, 10);
    const rows = [addRow(h, '小测', '干活')];
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    progress.act(1, 'stop');
    progress.ended(session.id, 'interrupted', '');
    await untilOvertime(h, 1);
    /** 登记的那一行。 */
    const line = overtimeLines(h)[0]!;
    bunTest.expect(line.stage).toBe('stopped');
    bunTest.expect(line.bot).toBe('小测');
    bunTest.expect(overtimeLines(h)).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  bunTest.test('合并插话：stage=merged 不登记，哪怕时长够格', async () => {
    const h = await setup(false, 0.0005);
    const progress = builders.progressOf(h.deps, 10);
    const session = openSession(h);
    /** 第一张卡（一直在跑，不 ended）。 */
    const first = [addRow(h, '小测', '第一句')];
    /** 插进来触发合并的第二张卡。 */
    const second = [addRow(h, '小测', '插一句')];
    progress.received(first);
    progress.dispatched(first, session.id, recordOf(50));
    await flush();
    progress.received(second);
    //M 让第二张卡也用够 80ms（阈值 30ms）：merged 短路，仍不该登记。
    await Bun.sleep(80);
    progress.dispatched(second, session.id, recordOf(50));
    await flush();
    bunTest.expect(progress.list()[0]!.stage).toBe('merged');
    //M 等过 fire-and-forget 落盘窗口：登记文件应仍是 0 行。
    await Bun.sleep(200);
    bunTest.expect(overtimeLines(h)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  bunTest.test('做得快：done 且没到阈值，不登记', async () => {
    const h = await setup(false, 0.05);
    const progress = builders.progressOf(h.deps, 10);
    const rows = [addRow(h, '小测', '干活')];
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    //M 立刻结束：usedMs 远小于 0.05 分（3000ms）阈值，stage 也不是 timeout/stopped。
    progress.ended(session.id, 'done', '做完了');
    //M 等过 fire-and-forget 落盘窗口：登记文件应仍是 0 行。
    await Bun.sleep(200);
    bunTest.expect(overtimeLines(h)).toHaveLength(0);
    bunTest.expect(progress.list()[0]!.stage).toBe('done');
  }, TEST_TIMEOUT_MS);
});


/** 判断模型三题都过：还在推进、5 分钟内能做完、没在打转（“是”的概率够 0.5）。 */
const JUDGE_EXTEND: Record<string, piAi.ClassifierAnswer> = {
  progressing: { type: 'bool', probability: 0.9 },
  nearlyDone: { type: 'bool', probability: 0.9 },
  looping: { type: 'bool', probability: 0.1 },
};

/** 判断模型认为在打转：looping 够 0.5，不该延长。 */
const JUDGE_LOOPING: Record<string, piAi.ClassifierAnswer> = {
  progressing: { type: 'bool', probability: 0.9 },
  nearlyDone: { type: 'bool', probability: 0.9 },
  looping: { type: 'bool', probability: 0.9 },
};

/** 没配判断模型时的占位答案：decide 不该被调到。 */
const JUDGE_NONE: Record<string, piAi.ClassifierAnswer> = {};


/** 限时新规则用例里，假判断模型和假审核模型怎么配。 */
interface LimitOptions {
  /** decide 回的三道题答案。 */
  answers: Record<string, piAi.ClassifierAnswer>;
  /** 写不写 engine.limit_judge_model；写了就有判断模型。 */
  judgeModel?: boolean;
  /** ai.hasDecision() 回什么；默认 false。 */
  hasDecision?: boolean;
  /** 审核模型（purpose='limit-review'）回的文字；不给就回 WRAPUP_TEXT（读不出结论）。 */
  reviewText?: string;
  /** 额外写进 config.yaml 的 engine 段的行（如 limit_review_model）。 */
  engineLines?: string;
  /** listModels 额外给的一个模型（第 8 条用）。 */
  extraModel?: model.ModelSummary;
}


/**
 * 把 setup() 的依赖换成限时新规则要的：config.yaml 写明四个限时值（20/10/5/2，替掉防干扰的 1000 分钟），
 * 按需写 limit_judge_model；decide 回指定答案；挂一个事件总线。
 * @param h setup() 建好的依赖和记录。
 * @param options 判断模型的答案、有没有判断模型。
 * @returns 事件总线和 decide 收到的参数（数被问了几次）。
 * 副作用：改写临时运行时目录的 config.yaml；换掉 h.deps 的 resources、ai、events。
 */
async function limitDeps(
  h: Harness,
  options: LimitOptions,
): Promise<{ bus: eventsModule.EventBus; decideInputs: model.DecideInput[] }> {
  /** 判断模型的配置行；配了才写。 */
  const judgeLine = options.judgeModel ? `  limit_judge_model: ${MODEL_ID}\n` : '';
  /** 四个限时设置都写成设计文档 2.1 节定的值。 */
  const config = 'providers: {}\n'
    + `default_model: ${MODEL_ID}\n`
    + 'bots:\n  - name: 小测\n    language: zh\n'
    + 'http:\n  port: 1\n  token: tk-fake\n'
    + 'engine:\n  poll_ms: 10\n'
    + '  limit_default_minutes: 20\n'
    + '  limit_remind_before_minutes: 10\n'
    + '  limit_extend_minutes: 5\n'
    + '  limit_extend_times: 2\n'
    + judgeLine
    + (options.engineLines ?? '');
  fs.writeFileSync(path.join(h.deps.resources.dir, 'config.yaml'), config);
  /** 重读设置：默认上限从 1000 换成 20。 */
  const resources = await resourcesModule.Resources.load(h.deps.resources.dir);
  h.deps.resources = resources;
  /** decide 收到的参数。 */
  const decideInputs: model.DecideInput[] = [];
  /** 假模型清单：默认只有测试模型，第 8 条再加一个审核模型。 */
  const models: model.ModelSummary[] = [
    { id: MODEL_ID, name: 'test', kind: 'chat', contextWindow: 100_000, thinking: ['off', 'low', 'medium', 'high'], vision: true, price: { input: 0, output: 0 } },
  ];
  if (options.extraModel) {
    models.push(options.extraModel);
  }
  /** 假模型：审核那次回审核结论，别的（收尾总结）回 WRAPUP_TEXT；decide 回指定答案。 */
  h.deps.ai = builders.fakeAi({
    chat: (input) => {
      h.chatCalls.push(input);
      /** 这次回给模型的文字。 */
      let text = WRAPUP_TEXT;
      if (input.purpose === 'limit-review') {
        text = options.reviewText ?? WRAPUP_TEXT;
      }
      return Promise.resolve(chatOutput(text));
    },
    decide: (input) => {
      decideInputs.push(input);
      return Promise.resolve({
        answers: options.answers,
        ms: 1,
        request: { model: input.model ?? MODEL_ID, state: input.state, questions: input.questions },
      });
    },
    hasDecision: () => options.hasDecision ?? false,
    listModels: () => models,
  });
  /** 事件总线：单独的内存库，写法照 tests/Events.test.ts 的 setup。 */
  const bus = new eventsModule.EventBus(new storeModule.Store(':memory:'), resources, new secretsModule.Secrets([]));
  h.deps.events = bus;
  return { bus, decideInputs };
}


bunTest.describe('限时新规则（03 文档 2.1 节）', () => {
  bunTest.test('不点按钮：默认上限 20 分钟、limitChosen=false', async () => {
    const h = await setup();
    const { bus } = await limitDeps(h, { answers: JUDGE_NONE });
    /** 登记表：一分钟当 10 毫秒。 */
    const progress = builders.progressOf(h.deps, 10);
    /** 一批话。 */
    const rows = [addRow(h, '小测', '干活')];
    /** 正在跑的会话。 */
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    /** 刚分派完的卡片。 */
    const view = progress.list()[0]!;
    bunTest.expect(view.limitMinutes).toBe(20);
    bunTest.expect(view.limitChosen).toBe(false);
    bunTest.expect(view.extended).toBe(0);
    //M 还没到报时点：上限是分派这刻排下的，不用点按钮。
    bunTest.expect(progress.clockNote(session.id)).toBeUndefined();
    bunTest.expect(bus.list({ type: 'limit.*', limit: 50 })).toHaveLength(0);
    //M 取消两个定时器，免得用例结束后还去报 limit.warned、到点停下。
    bunTest.expect(progress.act(1, 'limit')).toBe('不限时，一直做，也不报时');
  }, TEST_TIMEOUT_MS);

  bunTest.test('报时：报时点前回 undefined，过了带「已经干了」；选 15/20 分钟提前 5 分钟', async () => {
    const h = await setup();
    await limitDeps(h, { answers: JUDGE_NONE });
    /** 登记表：一分钟当 10 毫秒。 */
    const progress = builders.progressOf(h.deps, 10);
    /** 三张卡各进一个会话，互不合并。 */
    const rowsA = [addRow(h, '小测', '默认那件')];
    const sessionA = openSession(h);
    const rowsB = [addRow(h, '小测', '选 20 分钟')];
    const sessionB = openSession(h);
    const rowsC = [addRow(h, '小测', '选 15 分钟')];
    const sessionC = openSession(h);
    /** 冻结前的真实时刻，拿来当三张卡的 startedAt。 */
    const base = Date.now();
    bunTest.setSystemTime(base);
    try {
      progress.received(rowsA);
      progress.dispatched(rowsA, sessionA.id, recordOf(50));
      progress.received(rowsB);
      progress.dispatched(rowsB, sessionB.id, recordOf(50));
      progress.received(rowsC);
      progress.dispatched(rowsC, sessionC.id, recordOf(50));
      //M 卡片号 1/2/3：2 选 20 分钟、3 选 15 分钟，都是提前 5 分钟报时。
      bunTest.expect(progress.act(2, 'limit', 20)).toContain('最多做 20 分钟');
      bunTest.expect(progress.act(3, 'limit', 15)).toContain('最多做 15 分钟');
      //M 默认 20 分钟在第 10 分钟报时（+100ms）；选 20 分钟在第 15 分钟（+150ms）；选 15 分钟在 +100ms。
      bunTest.setSystemTime(base + 60);
      bunTest.expect(progress.clockNote(sessionA.id)).toBeUndefined();
      bunTest.expect(progress.clockNote(sessionB.id)).toBeUndefined();
      bunTest.expect(progress.clockNote(sessionC.id)).toBeUndefined();
      bunTest.setSystemTime(base + 99);
      bunTest.expect(progress.clockNote(sessionA.id)).toBeUndefined();
      bunTest.expect(progress.clockNote(sessionB.id)).toBeUndefined();
      bunTest.setSystemTime(base + 100);
      bunTest.expect(progress.clockNote(sessionA.id)).toContain('已经干了');
      bunTest.expect(progress.clockNote(sessionC.id)).toContain('已经干了');
      bunTest.expect(progress.clockNote(sessionB.id)).toBeUndefined();
      bunTest.setSystemTime(base + 150);
      bunTest.expect(progress.clockNote(sessionB.id)).toContain('已经干了');
    } finally {
      //G 先还原真实时间，再取消三张卡的定时器，免得影响后面的用例。
      bunTest.setSystemTime();
      bunTest.expect(progress.act(1, 'limit')).toBe('不限时，一直做，也不报时');
      bunTest.expect(progress.act(2, 'limit')).toBe('不限时，一直做，也不报时');
      bunTest.expect(progress.act(3, 'limit')).toBe('不限时，一直做，也不报时');
    }
  }, TEST_TIMEOUT_MS);

  bunTest.test('到点判断都过：延长一次、不写 interrupt、报 limit.extended', async () => {
    const h = await setup();
    const { bus, decideInputs } = await limitDeps(h, { answers: JUDGE_EXTEND, judgeModel: true });
    /** 登记表：一分钟当 10 毫秒，20 分钟就是 200 毫秒。 */
    const progress = builders.progressOf(h.deps, 10);
    /** 一批话。 */
    const rows = [addRow(h, '小测', '干活')];
    /** 正在跑的会话（interrupt 只有 running 才写得进去）。 */
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    //M 等到判断模型让延长：extended 从 0 变 1。
    await until(() => progress.list()[0]!.extended === 1, '到点判断后延长一次');
    /** 事件表里 limit.* 的每一行。 */
    const events = bus.list({ type: 'limit.*', limit: 50 });
    /** 事件类型。 */
    const types = events.map((item) => item.type);
    /** 那一条延长事件：带着延了几次、几分钟。 */
    const extendedEvent = events.find((item) => item.type === 'limit.extended')!;
    bunTest.expect(progress.list()[0]!.extended).toBe(1);
    bunTest.expect(decideInputs).toHaveLength(1);
    bunTest.expect(types.filter((item) => item === 'limit.extended')).toHaveLength(1);
    bunTest.expect(extendedEvent.data.times).toBe(1);
    bunTest.expect(extendedEvent.data.minutes).toBe(5);
    bunTest.expect(types).toContain('limit.reached');
    bunTest.expect(types).not.toContain('limit.stopped');
    bunTest.expect(h.store.getSession(session.id)!.interrupt).toBeNull();
    //M 取消后续定时器：第二次到点还会再延长，本例只看第一次。
    bunTest.expect(progress.act(1, 'limit')).toBe('不限时，一直做，也不报时');
  }, TEST_TIMEOUT_MS);

  bunTest.test('延够两次就停：第三次到点不再问判断模型、写 interrupt', async () => {
    const h = await setup();
    const { bus, decideInputs } = await limitDeps(h, { answers: JUDGE_EXTEND, judgeModel: true });
    /** 登记表：一分钟当 10 毫秒，每次延长 5 分钟就是 50 毫秒。 */
    const progress = builders.progressOf(h.deps, 10);
    /** 一批话。 */
    const rows = [addRow(h, '小测', '干活')];
    /** 正在跑的会话。 */
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    //M 200ms 第一次到点延长、250ms 第二次延长、300ms 第三次直接停。
    await until(
      () => bus.list({ type: 'limit.*', limit: 50 }).some((item) => item.type === 'limit.stopped'),
      '第三次到点停下',
    );
    /** 事件表里 limit.* 的类型。 */
    const types = bus.list({ type: 'limit.*', limit: 50 }).map((item) => item.type);
    //M 三次到点各报一条 limit.reached：第三次没再问判断模型，只问了两次。
    bunTest.expect(types.filter((item) => item === 'limit.reached')).toHaveLength(3);
    bunTest.expect(decideInputs).toHaveLength(2);
    bunTest.expect(types.filter((item) => item === 'limit.extended')).toHaveLength(2);
    bunTest.expect(types.filter((item) => item === 'limit.stopped')).toHaveLength(1);
    bunTest.expect(progress.list()[0]!.extended).toBe(2);
    bunTest.expect(h.store.getSession(session.id)!.interrupt).toBe(rows.at(-1)!.id);
    //M 第三次到点先问审核模型：回答不是 JSON，读不出结论，就停下收尾。
    bunTest.expect(h.chatCalls.filter((item) => item.purpose === 'limit-review')).toHaveLength(1);
    /** 停下那条事件。 */
    const stopped = bus.list({ type: 'limit.*', limit: 50 }).find((item) => item.type === 'limit.stopped')!;
    bunTest.expect(stopped.data.review).toBe('stop');
  }, TEST_TIMEOUT_MS);

  bunTest.test('判断不让延：在打转、没配判断模型，都写 interrupt 并报 limit.stopped', async () => {
    /** 在打转：判断模型回 looping 够 0.5。 */
    const hLoop = await setup();
    const loop = await limitDeps(hLoop, { answers: JUDGE_LOOPING, judgeModel: true });
    /** 登记表。 */
    const progressLoop = builders.progressOf(hLoop.deps, 10);
    /** 一批话。 */
    const rowsLoop = [addRow(hLoop, '小测', '干活')];
    /** 正在跑的会话。 */
    const sessionLoop = openSession(hLoop);
    progressLoop.received(rowsLoop);
    progressLoop.dispatched(rowsLoop, sessionLoop.id, recordOf(50));
    await until(
      () => loop.bus.list({ type: 'limit.*', limit: 50 }).some((item) => item.type === 'limit.stopped'),
      '在打转，到点就停',
    );
    /** 在打转那张卡报的 limit.* 类型。 */
    const loopTypes = loop.bus.list({ type: 'limit.*', limit: 50 }).map((item) => item.type);
    bunTest.expect(loop.decideInputs).toHaveLength(1);
    bunTest.expect(loopTypes.filter((item) => item === 'limit.extended')).toHaveLength(0);
    bunTest.expect(loopTypes.filter((item) => item === 'limit.stopped')).toHaveLength(1);
    bunTest.expect(hLoop.store.getSession(sessionLoop.id)!.interrupt).toBe(rowsLoop.at(-1)!.id);

    /** 没配判断模型：limit_judge_model 不写、hasDecision 回 false，到点直接停。 */
    const hNone = await setup();
    const none = await limitDeps(hNone, { answers: JUDGE_NONE });
    /** 登记表。 */
    const progressNone = builders.progressOf(hNone.deps, 10);
    /** 一批话。 */
    const rowsNone = [addRow(hNone, '小测', '干活')];
    /** 正在跑的会话。 */
    const sessionNone = openSession(hNone);
    progressNone.received(rowsNone);
    progressNone.dispatched(rowsNone, sessionNone.id, recordOf(50));
    await until(
      () => none.bus.list({ type: 'limit.*', limit: 50 }).some((item) => item.type === 'limit.stopped'),
      '没配判断模型，到点直接停',
    );
    bunTest.expect(none.decideInputs).toHaveLength(0);
    bunTest.expect(none.bus.list({ type: 'limit.*', limit: 50 }).filter((item) => item.type === 'limit.stopped')).toHaveLength(1);
    bunTest.expect(hNone.store.getSession(sessionNone.id)!.interrupt).toBe(rowsNone.at(-1)!.id);
  }, TEST_TIMEOUT_MS);
});


/** 审核发现离谱的回答（JSON 字符串）。 */
const REVIEW_ABSURD = JSON.stringify({
  absurd: true,
  absurdWhy: '同一条命令失败了三次',
  handoff: false,
  handoffNote: '',
});

/** 审核说不离谱、也不转新会话的回答。 */
const REVIEW_STOP = JSON.stringify({ absurd: false, absurdWhy: '', handoff: false, handoffNote: '' });

/** 审核建议转新会话时写的交接说明：四段，每段一个小标题。 */
const HANDOFF_NOTE = [
  '目标：把年度报告写完交给用户。',
  '做到哪了：已经读完三份源表，写了前两段。',
  '卡在哪：第三段的汇总一直算不对，旧会话里全是失败的尝试。',
  '别再怎么做：别再重跑那条没改过的汇总命令。',
].join('\n');

/** 审核建议转新会话的回答。 */
const REVIEW_HANDOFF = JSON.stringify({ absurd: false, absurdWhy: '', handoff: true, handoffNote: HANDOFF_NOTE });

/** 建议转却没写交接说明的回答。 */
const REVIEW_NO_NOTE = JSON.stringify({ absurd: false, absurdWhy: '', handoff: true, handoffNote: '' });

/** absurd 不是 true/false 的回答。 */
const REVIEW_BAD_ABSURD = JSON.stringify({ absurd: 'yes', absurdWhy: '', handoff: false, handoffNote: '' });

/** 超过卡片 80 字截短上限的用户原话：证明审核、交接用的是全文。 */
const LONG_TEXT = '请把今年所有区域的销售数据整理成一份完整的年度报告，先按季度汇总收入和利润，'
  + '再和去年同期的数字逐项对比，把变化最大的三个区域单独列出来说明原因，最后写成可以直接交给管理层的中文稿，'
  + '并且把用到的源表路径一条不落地写在附录里，别漏掉任何一个区域。';


/**
 * 造一个假的机器人循环：只实现 handOff，记下参数，再真建一个新会话行回给 Progress。
 * @param h 依赖和记录。
 * @param rejectWith 给了就让 handOff 回这个错（模拟转新会话没成）。
 * @returns handOff 收到的参数、可以 attachBotLoop 的假循环。
 */
function fakeBotLoop(
  h: Harness,
  rejectWith?: Error,
): { calls: botLoopModule.HandOffInput[]; loop: botLoopModule.BotLoop } {
  /** handOff 收到的参数。 */
  const calls: botLoopModule.HandOffInput[] = [];
  /** 假的机器人循环：只有 handOff 这一个方法。 */
  const loop = {
    handOff: (input: botLoopModule.HandOffInput): Promise<storeModule.SessionRow> => {
      calls.push(input);
      if (rejectWith) {
        return Promise.reject(rejectWith);
      }
      /** 真建出来的新会话行。 */
      const session = h.store.createSession({
        bot: '小测',
        workspace: '日常',
        title: '一件事（接着做）',
        model: MODEL_ID,
        thinking: null,
      });
      return Promise.resolve(session);
    },
  } as unknown as botLoopModule.BotLoop;
  return { calls, loop };
}


/**
 * 等到事件表出现 limit.stopped。
 * @param bus 事件总线。
 * @param what 在等什么。
 */
async function untilStopped(bus: eventsModule.EventBus, what: string): Promise<void> {
  await until(
    () => bus.list({ type: 'limit.*', limit: 50 }).some((item) => item.type === 'limit.stopped'),
    what,
  );
}


/**
 * 取事件表里那条 limit.stopped。
 * @param bus 事件总线。
 * @returns 那条事件。
 */
function stoppedEvent(bus: eventsModule.EventBus): eventsModule.EventRecord {
  /** 那条事件。 */
  const row = bus.list({ type: 'limit.*', limit: 50 }).find((item) => item.type === 'limit.stopped');
  if (!row) {
    throw new Error('事件表里没有 limit.stopped');
  }
  return row;
}


bunTest.describe('限时第 5 条：审核、转新会话（03 文档 2.1 节）', () => {
  bunTest.test('选了 15 分钟上限：到点就停，不问判断模型、不延长', async () => {
    const h = await setup();
    const { bus, decideInputs } = await limitDeps(h, { answers: JUDGE_EXTEND, judgeModel: true });
    /** 登记表：一分钟当 10 毫秒，15 分钟就是 150 毫秒。 */
    const progress = builders.progressOf(h.deps, 10);
    /** 一批话。 */
    const rows = [addRow(h, '小测', '干活')];
    /** 正在跑的会话。 */
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    /** 用户在卡片上选 15 分钟。 */
    const answer = progress.act(1, 'limit', 15);
    bunTest.expect(answer).toContain('最多做 15 分钟');
    await untilStopped(bus, '选了上限，到点停下');
    /** 事件表里 limit.* 的类型。 */
    const types = bus.list({ type: 'limit.*', limit: 50 }).map((item) => item.type);
    bunTest.expect(types).toContain('limit.reached');
    bunTest.expect(types).toContain('limit.stopped');
    bunTest.expect(decideInputs).toHaveLength(0);
    bunTest.expect(progress.list()[0]!.extended).toBe(0);
    bunTest.expect(h.store.getSession(session.id)!.interrupt).toBe(rows.at(-1)!.id);
    //G 取消还没到点的定时器。
    bunTest.expect(progress.act(1, 'limit')).toBe('不限时，一直做，也不报时');
  }, TEST_TIMEOUT_MS);

  bunTest.test('审核发现离谱：flagged 停下，⚠ 告诉用户哪里离谱、做到哪了', async () => {
    const h = await setup();
    const { bus } = await limitDeps(h, { answers: JUDGE_EXTEND, judgeModel: true, reviewText: REVIEW_ABSURD });
    /** 登记表。 */
    const progress = builders.progressOf(h.deps, 10);
    /** 用户原话：带一句好认的话，证明审核看的是全文。 */
    const asked = '把年度报告写完，别漏了华南区的数据';
    /** 一批话。 */
    const rows = [addRow(h, '小测', asked)];
    /** 正在跑的会话。 */
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    await untilStopped(bus, '审核发现离谱，停下');
    /** 停下那条事件。 */
    const stopped = stoppedEvent(bus);
    /** 审核那几次 chat。 */
    const reviews = h.chatCalls.filter((item) => item.purpose === 'limit-review');
    bunTest.expect(stopped.data.review).toBe('absurd');
    bunTest.expect(reviews).toHaveLength(1);
    bunTest.expect(reviews[0]!.model).toBe(MODEL_ID);
    bunTest.expect(reviews[0]!.thinking).toBe('high');
    bunTest.expect(reviews[0]!.tools).toEqual([]);
    bunTest.expect(JSON.stringify(reviews[0]!.messages)).toContain(asked);
    //M 老会话读到 interrupt 停下来：收尾时把哪里离谱一起说。
    progress.ended(session.id, 'interrupted', '');
    await until(() => h.sent.some((item) => item.text.startsWith('⚠')), '发出 ⚠ 那句话');
    /** 发给用户的话。 */
    const words = h.sent.find((item) => item.text.startsWith('⚠'))!.text;
    bunTest.expect(progress.list()[0]!.stage).toBe('flagged');
    bunTest.expect(words).toContain('同一条命令失败了三次');
    bunTest.expect(words).toContain(WRAPUP_TEXT);
    bunTest.expect(h.store.getMessage(rows.at(-1)!.id)!.replies.some((item) => item.text === words)).toBe(true);
  }, TEST_TIMEOUT_MS);

  bunTest.test('审核建议转新会话：老会话停下后才 handOff，老卡 handed', async () => {
    const h = await setup();
    const { bus } = await limitDeps(h, { answers: JUDGE_EXTEND, judgeModel: true, reviewText: REVIEW_HANDOFF });
    /** 假的机器人循环。 */
    const fake = fakeBotLoop(h);
    /** 登记表。 */
    const progress = builders.progressOf(h.deps, 10);
    progress.attachBotLoop(fake.loop);
    /** 长过 80 字的用户原话：卡片上会截短，交接要用全文。 */
    const rows = [addRow(h, '小测', LONG_TEXT)];
    /** 正在跑的会话。 */
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    await untilStopped(bus, '审核建议转，先叫老会话停');
    bunTest.expect(stoppedEvent(bus).data.review).toBe('handoff');
    bunTest.expect(h.store.getSession(session.id)!.interrupt).toBe(rows.at(-1)!.id);
    bunTest.expect(fake.calls).toHaveLength(0);
    //M 老会话读到 interrupt 停下来，Progress 才去开新会话。
    progress.ended(session.id, 'interrupted', '');
    await until(
      () => fake.calls.length === 1 && h.sent.some((item) => item.text.startsWith('↪')),
      '转到新会话并告诉用户',
    );
    /** handOff 收到的参数。 */
    const args = fake.calls[0]!;
    bunTest.expect(args.fromSession).toBe(session.id);
    bunTest.expect(args.text).toContain(LONG_TEXT);
    bunTest.expect(args.text).toContain(HANDOFF_NOTE);
    bunTest.expect(args.channel).toBe(rows[0]!.channel);
    bunTest.expect(args.address).toEqual(rows[0]!.address);
    bunTest.expect(progress.list()[0]!.stage).toBe('handed');
    /** 发给用户的话。 */
    const words = h.sent.find((item) => item.text.startsWith('↪'))!.text;
    bunTest.expect(words).toContain('一件事（接着做）');
    bunTest.expect(words).toContain(HANDOFF_NOTE);
    bunTest.expect(h.chatCalls.filter((item) => item.purpose === 'wrapup')).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  bunTest.test('要转时老会话正好 done：按完成算，不转新会话', async () => {
    const h = await setup();
    const { bus } = await limitDeps(h, { answers: JUDGE_EXTEND, judgeModel: true, reviewText: REVIEW_HANDOFF });
    /** 假的机器人循环。 */
    const fake = fakeBotLoop(h);
    /** 登记表。 */
    const progress = builders.progressOf(h.deps, 10);
    progress.attachBotLoop(fake.loop);
    /** 一批话。 */
    const rows = [addRow(h, '小测', '干活')];
    /** 正在跑的会话。 */
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    await untilStopped(bus, '先叫老会话停');
    //M 老会话正好做完了：按完成算，不开新会话。
    progress.ended(session.id, 'done', '做完了');
    bunTest.expect(progress.list()[0]!.stage).toBe('done');
    bunTest.expect(fake.calls).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  bunTest.test('转新会话没成：timeout 停下，⏱ 写明原因并写收尾总结', async () => {
    const h = await setup();
    const { bus } = await limitDeps(h, { answers: JUDGE_EXTEND, judgeModel: true, reviewText: REVIEW_HANDOFF });
    /** 假的机器人循环：handOff 回错。 */
    const fake = fakeBotLoop(h, new Error('开不了'));
    /** 登记表。 */
    const progress = builders.progressOf(h.deps, 10);
    progress.attachBotLoop(fake.loop);
    /** 一批话。 */
    const rows = [addRow(h, '小测', '干活')];
    /** 正在跑的会话。 */
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    await untilStopped(bus, '先叫老会话停');
    progress.ended(session.id, 'interrupted', '');
    await until(() => h.sent.some((item) => item.text.startsWith('⏱')), '转不成，发出 ⏱ 那句话');
    /** 发给用户的话。 */
    const words = h.sent.find((item) => item.text.startsWith('⏱'))!.text;
    bunTest.expect(progress.list()[0]!.stage).toBe('timeout');
    bunTest.expect(words).toContain('没成');
    bunTest.expect(words).toContain('开不了');
    bunTest.expect(h.chatCalls.filter((item) => item.purpose === 'wrapup')).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  bunTest.test('转过一次的不再审核：延两次后直接停，限时从头算', async () => {
    const h = await setup();
    const { bus } = await limitDeps(h, { answers: JUDGE_EXTEND, judgeModel: true });
    /** 登记表。 */
    const progress = builders.progressOf(h.deps, 10);
    /** 一批话。 */
    const rows = [addRow(h, '小测', '干活')];
    /** 正在跑的会话。 */
    const session = openSession(h);
    //M 卡片用 handedOver 建，不走 received + dispatched。
    progress.handedOver(rows, session.id, '老会话');
    /** 刚建好的卡。 */
    const fresh = progress.list()[0]!;
    bunTest.expect(fresh.sessionId).toBe(session.id);
    bunTest.expect(fresh.limitMinutes).toBe(20);
    bunTest.expect(fresh.extended).toBe(0);
    await untilStopped(bus, '延两次后直接停');
    bunTest.expect(stoppedEvent(bus).data.why).toContain('不再转');
    bunTest.expect(h.chatCalls.filter((item) => item.purpose === 'limit-review')).toHaveLength(0);
    //G 取消还没到点的定时器。
    bunTest.expect(progress.act(1, 'limit')).toBe('不限时，一直做，也不报时');
  }, TEST_TIMEOUT_MS);

  bunTest.test('审核没给出能用的结论：四种情况都停下收尾', async () => {
    /** 四种情况：审核回答、期望的 review 标记。 */
    const cases: { name: string; reviewText?: string; review: string }[] = [
      { name: '回答不是 JSON', review: 'stop' },
      { name: '建议转却没写交接说明', reviewText: REVIEW_NO_NOTE, review: 'stop' },
      { name: 'absurd 不是 true/false', reviewText: REVIEW_BAD_ABSURD, review: 'stop' },
      { name: '建议转但没接机器人循环', reviewText: REVIEW_HANDOFF, review: 'handoff' },
    ];
    for (const item of cases) {
      const h = await setup();
      const { bus } = await limitDeps(h, { answers: JUDGE_EXTEND, judgeModel: true, reviewText: item.reviewText });
      /** 登记表。 */
      const progress = builders.progressOf(h.deps, 10);
      /** 一批话。 */
      const rows = [addRow(h, '小测', '干活')];
      /** 正在跑的会话。 */
      const session = openSession(h);
      progress.received(rows);
      progress.dispatched(rows, session.id, recordOf(50));
      await untilStopped(bus, `${item.name}：停下`);
      bunTest.expect(stoppedEvent(bus).data.review).toBe(item.review);
      progress.ended(session.id, 'interrupted', '');
      await until(() => h.sent.some((one) => one.text.startsWith('⏱')), `${item.name}：收尾发出`);
      bunTest.expect(progress.list()[0]!.stage).toBe('timeout');
    }
  }, TEST_TIMEOUT_MS);

  bunTest.test('limit_review_model 生效：审核用配的模型和最强思考档', async () => {
    const h = await setup();
    /** 额外给 listModels 的审核模型：最强档是 xhigh。 */
    const reviewModel: model.ModelSummary = {
      id: 'fake/review',
      name: 'review',
      kind: 'chat',
      contextWindow: 100_000,
      thinking: ['off', 'low', 'xhigh'],
      vision: true,
      price: { input: 0, output: 0 },
    };
    const { bus } = await limitDeps(h, {
      answers: JUDGE_EXTEND,
      judgeModel: true,
      reviewText: REVIEW_STOP,
      engineLines: '  limit_review_model: fake/review\n',
      extraModel: reviewModel,
    });
    /** 登记表。 */
    const progress = builders.progressOf(h.deps, 10);
    /** 一批话。 */
    const rows = [addRow(h, '小测', '干活')];
    /** 正在跑的会话。 */
    const session = openSession(h);
    progress.received(rows);
    progress.dispatched(rows, session.id, recordOf(50));
    await untilStopped(bus, '审核后停下');
    /** 审核那几次 chat。 */
    const reviews = h.chatCalls.filter((item) => item.purpose === 'limit-review');
    bunTest.expect(reviews).toHaveLength(1);
    bunTest.expect(reviews[0]!.model).toBe('fake/review');
    bunTest.expect(reviews[0]!.thinking).toBe('xhigh');
    //G 取消还没到点的定时器。
    bunTest.expect(progress.act(1, 'limit')).toBe('不限时，一直做，也不报时');
  }, TEST_TIMEOUT_MS);
});
