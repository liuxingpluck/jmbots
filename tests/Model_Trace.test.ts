/**
 * 模型观察的离线行为检查：真实队列边界、关联快照、回退依据、重试与脱敏。
 * 只用临时假配置、内存数据库与假的 Pi 模型，不联网、不读取生产运行时。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as piAi from '@earendil-works/pi-ai';
import * as eventsModule from '../src/capabilities/Events.ts';
import * as modelModule from '../src/capabilities/Model.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as resourcesModule from '../src/resources/Resources.ts';


/** 测试里的密钥和提示词标记；不能出现在事件 JSON 中。 */
const FAKE_SECRET = 'trace-fake-secret-123456';
const SYSTEM_MARKER = 'private-system-prompt-content';

/** 假的供应商用量，事件与原用量监听必须一致。 */
const USAGE = {
  input: 31,
  output: 7,
  cacheRead: 11,
  cacheWrite: 3,
  totalTokens: 52,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};


/** 假模型下一次返回什么；不影响正式模型库的判断规则。 */
interface Plan {
  /** 返回的 SDK 错误；省略表示成功。 */
  error?: string;
  /** 等测试主动放行；用于确认真实并发队列没有提前开始调用。 */
  wait?: Promise<void>;
  /** SDK 直接抛出的异常；省略则按正常格式返回。 */
  thrown?: string;
  /** true 表示供应商没报告 token；观察不能用零填充。 */
  noUsage?: boolean;
}


/** 一次测试持有的全部对象。 */
interface Harness {
  /** 假配置的独占临时目录，和生产运行时无关。 */
  dir: string;
  /** 被测模型库，已接上事件总线。 */
  ai: modelModule.Ai;
  /** 内存事件数据库。 */
  store: storeModule.Store;
  /** 每次真正进入假 SDK 的模型 ID。 */
  called: string[];
  /** 既有用量监听收到的行。 */
  usage: modelModule.UsageRecord[];
}


/**
 * 创建假的 Pi 集合；清单固定，回复计划按调用顺序消耗。
 * @param plans 模型裸 ID 到每次回复计划。
 * @param called 真正执行调用时追加 ID，供测试核对调用次数与顺序。
 * @returns Pi 替身，不包含任何网络请求。
 */
function fakeModels(plans: Record<string, Plan[]>, called: string[]): piAi.MutableModels {
  /** base 与 backup 的窗口大小不同，支持检查现有上下文超长分支。 */
  const known = [
    { id: 'base', contextWindow: 8000 },
    { id: 'backup', contextWindow: 32000 },
  ].map((model) => ({
    ...model,
    name: model.id,
    provider: 'test',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0 },
  }));

  const collection = {
    getModel: (_provider: string, id: string) => known.find((model) => model.id === id),
    getModels: () => known,
    getModelsOfType: () => [],
    getModelOfType: () => ({ id: 'decision', provider: 'test' }),
    completeSimple: async (model: { id: string }) => {
      called.push(model.id);
      /** 这个模型的本次计划；未指定时正常成功。 */
      const plan = plans[model.id]?.shift() ?? {};
      if (plan.wait) {
        await plan.wait;
      }
      if (plan.thrown) {
        throw new Error(plan.thrown);
      }
      return {
        role: 'assistant',
        content: plan.error ? [] : [{ type: 'text', text: '测试回复' }],
        stopReason: plan.error ? 'error' : 'stop',
        errorMessage: plan.error,
        usage: plan.noUsage ? undefined : USAGE,
      };
    },
    classify: () => {
      called.push('decision');
      return Promise.resolve({
        stopReason: 'stop',
        answers: { keep: { type: 'bool', probability: 0.9 } },
      });
    },
  };
  return collection as unknown as piAi.MutableModels;
}


/**
 * 建独占假运行时与内存事件库，绝不碰生产配置。
 * @param plans 假模型回复顺序。
 * @param engine 覆盖测试用引擎规则的 YAML 行。
 * @returns 测试对象；调用方在 finally 清理 dir。
 */
async function setup(plans: Record<string, Plan[]> = {}, engine: string[] = []): Promise<Harness> {
  const tempRoot = process.env.JMBOTS_TEST_TMP ?? os.tmpdir();
  const dir = fs.mkdtempSync(path.join(tempRoot, 'jmbots-model-trace-'));
  /** 本测试亲自生成的假配置，不读取任何现有配置或真实凭据。 */
  const config = [
    'providers:',
    '  test:',
    '    base_url: http://127.0.0.1:1/v1',
    `    api_key: ${FAKE_SECRET}`,
    'default_model: test/base',
    'concurrency:',
    '  default: 1',
    'engine:',
    '  fallback_chain: [test/backup]',
    '  fallback_include_siblings: false',
    '  retry_delays_ms: []',
    ...engine.map((line) => `  ${line}`),
  ];
  fs.writeFileSync(path.join(dir, 'config.yaml'), config.join('\n'));

  const resources = await resourcesModule.Resources.load(dir);
  const store = new storeModule.Store(':memory:');
  const secrets = new secretsModule.Secrets([FAKE_SECRET]);
  const events = new eventsModule.EventBus(store, resources, secrets);
  const called: string[] = [];
  const usage: modelModule.UsageRecord[] = [];
  const models = fakeModels(plans, called);
  const ai = new modelModule.Ai(resources, models);

  ai.setEvents(events);
  ai.onUsage((row) => usage.push(row));
  return { dir, ai, store, called, usage };
}


/**
 * 一次普通会话请求；不把系统正文复制到事件。
 * @param trace 本次观察关联。
 * @returns 调用参数。
 */
function input(trace: modelModule.CallTrace = { run: 2, step: 3, messageIds: [11, 12] }): modelModule.ChatInput {
  return {
    model: 'test/base',
    system: { prompt: SYSTEM_MARKER },
    messages: [],
    tools: [],
    purpose: 'session',
    bot: '测试机器人',
    sessionId: 'session-trace',
    trace,
  };
}


/** 读这次测试全部模型观察，保持持久 ID 顺序。 */
function recorded(h: Harness): storeModule.EventRow[] {
  return h.store.listEvents({ type: 'model.*', limit: 1000 });
}


bunTest.test('并发队列：排队、取得名额、调用结束分开；关联快照和实测等待准确', async () => {
  /** 第一次调用不放行时，第二次必须留在原有并发队列中。 */
  let releaseFirst = (): void => undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const h = await setup({ base: [{ wait: firstBlocked }, {}] });
  try {
    const first = h.ai.chat(input({ run: 1, step: 1, messageIds: [10] }));
    await Bun.sleep(1);

    /** 排队期间修改调用方对象，不能改变第二次请求已快照的归属。 */
    const trace = { run: 2, step: 3, messageIds: [11, 12] };
    const second = h.ai.chat(input(trace));
    trace.run = 9;
    trace.step = 9;
    trace.messageIds.push(99);
    await Bun.sleep(1);

    const waiting = recorded(h);
    bunTest.expect(h.called).toEqual(['base']);
    bunTest.expect(waiting.map((event) => event.type)).toEqual([
      'model.queued',
      'model.started',
      'model.queued',
    ]);

    releaseFirst();
    await Promise.all([first, second]);

    const events = recorded(h);
    const secondQueued = events[2]!;
    const secondEvents = events.filter((event) => event.data.requestId === secondQueued.data.requestId);
    bunTest.expect(secondEvents.map((event) => event.type)).toEqual([
      'model.queued',
      'model.started',
      'model.completed',
    ]);
    const started = secondEvents[1]!.data;
    const completed = secondEvents[2]!.data;
    bunTest.expect(completed.messageIds).toEqual([11, 12]);
    bunTest.expect(completed.run).toBe(2);
    bunTest.expect(completed.step).toBe(3);
    bunTest.expect(started.waitMs).toBe(Number(started.startedAt) - Number(started.queuedAt));
    bunTest.expect(Number(started.waitMs)).toBeGreaterThan(0);
    bunTest.expect(completed.ms).toBe(Number(completed.endedAt) - Number(completed.startedAt));
    bunTest.expect(completed.input).toBe(h.usage[1]!.input);
    bunTest.expect(completed.cacheRead).toBe(h.usage[1]!.cacheRead);
    bunTest.expect(completed.outputBytes).toBe(Buffer.byteLength('测试回复', 'utf8'));
    bunTest.expect(completed.thinkingRequested).toBe('off');
    bunTest.expect(completed.thinkingSent).toBe('off');
    bunTest.expect(completed.thinkingReported).toBeNull();
    bunTest.expect(h.called).toEqual(['base', 'base']);
  } finally {
    releaseFirst();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});


bunTest.test('请求/发送档位来自本次调用设置，供应商执行档位保持未知', async () => {
  const h = await setup();
  try {
    const output = await h.ai.chat({ ...input(), thinking: 'high' });
    const events = recorded(h);
    const queued = events.find((event) => event.type === 'model.queued')!;
    const completed = events.find((event) => event.type === 'model.completed')!;
    bunTest.expect(queued.data.thinkingRequested).toBe('high');
    bunTest.expect(queued.data.thinkingSent).toBeNull();
    bunTest.expect(completed.data.thinkingRequested).toBe(output.request.thinkingAsked);
    bunTest.expect(completed.data.thinkingSent).toBe(output.request.thinking);
    bunTest.expect(completed.data.thinkingReported).toBeNull();
    bunTest.expect(completed.data.thinkingSource).toBe('caller');
    bunTest.expect(h.called).toEqual(['base']);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});


bunTest.test('429 回退：保留原错误但只称限流；同一请求跨两次尝试且不含提示词或密钥', async () => {
  const failure = `429 Too Many Requests ${FAKE_SECRET}`;
  const h = await setup({ base: [{ error: failure }] });
  try {
    const output = await h.ai.chat(input());
    const events = recorded(h);
    const completed = events.filter((event) => event.type === 'model.completed');
    const fallback = events.find((event) => event.type === 'model.fallback')!;

    bunTest.expect(h.called).toEqual(['base', 'backup']);
    bunTest.expect(output.request.model).toBe('test/backup');
    bunTest.expect(completed.map((event) => event.data.model)).toEqual(['test/base', 'test/backup']);
    bunTest.expect(new Set(completed.map((event) => event.data.requestId)).size).toBe(1);
    bunTest.expect(new Set(completed.map((event) => event.data.attemptId)).size).toBe(2);
    bunTest.expect(fallback.data.askedModel).toBe('test/base');
    bunTest.expect(fallback.data.to).toBe('test/backup');
    bunTest.expect(fallback.data.errorKind).toBe('rate-limit');
    bunTest.expect(fallback.data.error).toContain('429 Too Many Requests');
    bunTest.expect(completed[0]!.data.ok).toBe(false);
    bunTest.expect(completed[1]!.data.ok).toBe(true);

    const json = JSON.stringify(events);
    bunTest.expect(json).not.toContain(FAKE_SECRET);
    bunTest.expect(json).not.toContain(SYSTEM_MARKER);
    bunTest.expect(json).toContain('{{secret:1}}');
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});


bunTest.test('明确 quota 错误才标额度；后一次因冷却跳过时携带此前真实依据', async () => {
  const h = await setup({ base: [{ error: '429 insufficient_quota: quota exhausted' }] });
  try {
    await h.ai.chat(input());
    const firstEvents = recorded(h);
    const firstRequest = firstEvents[0]!.data.requestId;
    await h.ai.chat(input({ run: 2, step: 4, messageIds: [13] }));

    const secondEvents = recorded(h).filter((event) => event.data.requestId !== firstRequest);
    const skipped = secondEvents.find((event) => event.type === 'model.skipped')!;
    bunTest.expect(h.called).toEqual(['base', 'backup', 'backup']);
    bunTest.expect(skipped.data.reason).toBe('cooldown');
    bunTest.expect(skipped.data.errorKind).toBe('quota');
    bunTest.expect(skipped.data.error).toContain('insufficient_quota');
    bunTest.expect(Number(skipped.data.coolingUntil)).toBeGreaterThan(skipped.at);
    bunTest.expect(secondEvents.filter((event) => event.type === 'model.queued')).toHaveLength(1);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});


bunTest.test('瞬时故障按原退避重试：等待起止实测、规则间隔单列、不产生备用调用', async () => {
  const h = await setup({ base: [{ error: 'Connection error' }, {}] }, ['retry_delays_ms: [2]']);
  try {
    await h.ai.chat(input());
    const events = recorded(h);
    const retry = events.find((event) => event.type === 'model.retry')!;
    const ready = events.find((event) => event.type === 'model.retry.done')!;

    bunTest.expect(h.called).toEqual(['base', 'base']);
    bunTest.expect(events.some((event) => event.type === 'model.fallback')).toBe(false);
    bunTest.expect(retry.data.errorKind).toBe('transient');
    bunTest.expect(ready.data.startedAt).toBe(retry.data.startedAt);
    bunTest.expect(ready.data.delayMs).toBe(2);
    bunTest.expect(ready.data.ms).toBe(Number(ready.data.endedAt) - Number(ready.data.startedAt));
    bunTest.expect(events.filter((event) => event.type === 'model.completed')).toHaveLength(2);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});


bunTest.test('超时只记录真实错误：没有新的回退策略或额外请求', async () => {
  const h = await setup({ base: [{ error: 'request timed out' }] });
  try {
    const output = await h.ai.chat(input());
    const events = recorded(h);
    const completed = events.find((event) => event.type === 'model.completed')!;

    bunTest.expect(output.error).toContain('timed out');
    bunTest.expect(h.called).toEqual(['base']);
    bunTest.expect(completed.data.errorKind).toBe('timeout');
    bunTest.expect(events.some((event) => event.type === 'model.fallback')).toBe(false);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});


bunTest.test('上下文超长按原候选选择备用，记录依据而不误称额度', async () => {
  const h = await setup({ base: [{ error: 'maximum context length exceeded' }] });
  try {
    await h.ai.chat(input());
    const fallback = recorded(h).find((event) => event.type === 'model.fallback')!;

    bunTest.expect(h.called).toEqual(['base', 'backup']);
    bunTest.expect(fallback.data.reason).toBe('context-overflow');
    bunTest.expect(fallback.data.errorKind).toBe('context-overflow');
    bunTest.expect(fallback.data.error).toContain('maximum context length');
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});


bunTest.test('模型不存在与 SDK 异常仍抛错：失败有回执，未知用量留空', async () => {
  const h = await setup({ base: [{ thrown: 'SDK exploded' }, { noUsage: true }] });
  try {
    const missing = { ...input(), model: 'test/missing' };
    const missingError = await h.ai.chat(missing).catch((error: unknown) => error);
    const sdkError = await h.ai.chat(input()).catch((error: unknown) => error);
    bunTest.expect(String(missingError)).toContain('模型清单里没有');
    bunTest.expect(String(sdkError)).toContain('SDK exploded');
    await h.ai.chat(input());

    const completed = recorded(h).filter((event) => event.type === 'model.completed');
    bunTest.expect(completed).toHaveLength(3);
    bunTest.expect(completed[0]!.data.ok).toBe(false);
    bunTest.expect(completed[1]!.data.error).toBe('SDK exploded');
    bunTest.expect(completed[2]!.data.ok).toBe(true);
    bunTest.expect(completed.every((event) => event.data.input === undefined)).toBe(true);
    bunTest.expect(h.usage).toHaveLength(1);
    bunTest.expect(h.called).toEqual(['base', 'base']);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});


bunTest.test('决策调用有独立请求与队列边界，事件不包含 state 或题面全文', async () => {
  const h = await setup();
  try {
    const request: modelModule.DecideInput = {
      model: 'test/decision',
      state: { private: SYSTEM_MARKER },
      questions: {},
      purpose: 'dispatch',
      bot: '测试机器人',
      trace: { messageIds: [15] },
    };
    const output = await h.ai.decide(request);
    const events = recorded(h);
    const completed = events.at(-1)!;

    bunTest.expect(h.called).toEqual(['decision']);
    bunTest.expect(output.answers.keep?.type).toBe('bool');
    bunTest.expect(events.map((event) => event.type)).toEqual([
      'model.queued',
      'model.started',
      'model.completed',
    ]);
    bunTest.expect(completed.data.kind).toBe('decide');
    bunTest.expect(completed.data.messageIds).toEqual([15]);
    bunTest.expect(completed.data.answers).toBe(1);
    bunTest.expect(completed.data.input).toBeUndefined();
    bunTest.expect(JSON.stringify(events)).not.toContain(SYSTEM_MARKER);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});
