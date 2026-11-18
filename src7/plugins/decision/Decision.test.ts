/**
 * decision 事件接口单元测试（只用假会话问答，不调真实模型或分类器）：
 *   1. 验证仅配置 chat 模型（无 classifier）时构造阶段仍正确挂载 `decision/judge` 监听；
 *   2. 验证 `allow`（>= allowAt）、`deny`（< denyAt）与 `unsure`（中间分/答不上来）回执结构完整配对；
 *   3. 没挂 decision 时 requestEvent 当场退回拿不准，不等超时；
 *   4. 带 want: ['what'] 同一次提问拿到执行结果；不带 want 的提示词和回执不变；几个模型按配置顺序取第一个写了的。
 * 跑法：bun test ./src7/plugins/decision
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import { requestEvent, type FallbackReason } from '../../utils/RequestEvent.ts';
import * as decisionPlugin from './index.ts';


/**
 * 三次问共用的退回：没人答、超时都当拿不准。
 * 写明返回类型，verdict 才是字面量 'unsure'，不被推成 string。
 * @param reason requestEvent 给的退回原因。
 * @param detail 出错时的原话。
 */
function getUnsure(reason: FallbackReason, detail?: string): decisionPlugin.DecisionJudgeResult {
  return { requestId: '', verdict: 'unsure', reason: detail ?? reason };
}

/** 三次问共用的等待设置。 */
const judgeOptions = { prefix: 'dec', timeoutMs: 1000, onFallback: getUnsure };


const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 启动挂好假资源、假机器人与可编程假 sessions.ask 的决策测试环境。 */
async function createDecisionWorld(
  onAsk: (text: string, model: string) => { ok: boolean; reply: string },
  extraConfig: Record<string, unknown> = {},
): Promise<cordis.Context> {
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  class FakeResources extends cordis.Service {
    readonly config = { providers: { fake: { baseUrl: 'http://localhost' } } };
    readonly raw = {
      decision: {
        models: ['fake/judge'],
        allow_at: 0.8,
        deny_at: 0.2,
        ...extraConfig,
      },
    };
    constructor(c: cordis.Context) { super(c, 'resources'); }
  }
  class FakeBots extends cordis.Service {
    list(): { name: string }[] { return [{ name: '测试机器人' }]; }
    constructor(c: cordis.Context) { super(c, 'bots'); }
  }
  class FakeSessions extends cordis.Service {
    ask(input: { text: string; model: string }): Promise<{ ok: boolean; reply: string }> {
      return Promise.resolve(onAsk(input.text, input.model));
    }
    constructor(c: cordis.Context) { super(c, 'sessions'); }
  }

  await ctx.plugin(FakeResources);
  await ctx.plugin(FakeBots);
  await ctx.plugin(FakeSessions);
  await ctx.plugin(decisionPlugin);
  return ctx;
}


describe('decision/judge 事件裁定', () => {
  test('正确返回 allow、deny 与 unsure，按 requestId 配对回执', async () => {
    let nextReply = '{"probability": 0.92, "reason": "只读安全"}';
    const ctx = await createDecisionWorld(() => ({ ok: true, reply: nextReply }));

    const allow = await requestEvent(
      ctx,
      'decision/judge',
      'decision/judge-result',
      {
        kind: 'exec',
        question: { instructions: '安全吗', yes: '安全', no: '有风险' },
        state: { 命令: 'ls' },
      },
      judgeOptions,
    );
    expect(allow.verdict).toBe('allow');
    expect(allow.score).toBe(0.92);
    expect(allow.reason).toContain('0.92');

    nextReply = '{"probability": 0.1, "reason": "危险命令"}';
    const deny = await requestEvent(
      ctx,
      'decision/judge',
      'decision/judge-result',
      {
        kind: 'exec',
        question: { instructions: '安全吗', yes: '安全', no: '有风险' },
        state: { 命令: 'rm' },
      },
      judgeOptions,
    );
    expect(deny.verdict).toBe('deny');
    expect(deny.score).toBe(0.1);

    nextReply = '看不出来';
    const unsure = await requestEvent(
      ctx,
      'decision/judge',
      'decision/judge-result',
      {
        kind: 'progress-limit',
        question: { instructions: '继续吗', yes: '继续', no: '停下' },
        state: { 进度: '50%' },
      },
      judgeOptions,
    );
    expect(unsure.verdict).toBe('unsure');
    expect(unsure.score).toBeUndefined();
  });

  test('没挂 decision：当场退回拿不准，不等超时', async () => {
    const ctx = new cordis.Context();
    closers.push(() => ctx.fiber.dispose());
    const question = { instructions: '安全吗', yes: '安全', no: '有风险' };
    const input = { kind: 'exec', question, state: { 命令: 'ls' } };
    const options = { ...judgeOptions, timeoutMs: 60_000 };

    //M 超时设成一分钟：秒回说明是“没人接单”退回的，不是等到点。
    const began = Date.now();
    const result = await requestEvent(ctx, 'decision/judge', 'decision/judge-result', input, options);
    expect(result).toEqual({ requestId: '', verdict: 'unsure', reason: 'unhandled' });
    expect(Date.now() - began).toBeLessThan(1000);
  });


  test('带 want: [what] 同一次提问拿到执行结果；不带 want 的提示词和回执不变', async () => {
    //M 记下每次提问的话：看提示词多没多要 what、一共问了几次。
    const asked: string[] = [];
    const reply = '{"probability": 0.5, "reason": "要看情况", "what": "把 a.txt 复制到 b 目录"}';
    const ctx = await createDecisionWorld((text) => {
      asked.push(text);
      return { ok: true, reply };
    });
    const question = { instructions: '安全吗', yes: '安全', no: '有风险' };
    const plainInput = { kind: 'exec', question, state: { 命令: 'copy a.txt b' } };

    //M 不带 want：模型回了 what 也不带；回执只有原来四样，提示词不提 what。
    const plain = await requestEvent(ctx, 'decision/judge', 'decision/judge-result', plainInput, judgeOptions);
    const plainKeys = Object.keys(plain).sort();
    expect(plainKeys).toEqual(['reason', 'requestId', 'score', 'verdict']);
    expect(asked[0]).not.toContain('what');

    //M 带 want：提示词多要 what，回执带回来；结论、分和不带时一样，模型只多问了这一次。
    const want = ['what'] as const;
    const wantInput = { ...plainInput, want };
    const wanted = await requestEvent(ctx, 'decision/judge', 'decision/judge-result', wantInput, judgeOptions);
    expect(wanted.what).toBe('把 a.txt 复制到 b 目录');
    expect(wanted.verdict).toBe(plain.verdict);
    expect(wanted.score).toBe(plain.score);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('"what"');
  });

  test('几个模型：按配置顺序取第一个写了的 what；都写空串就不带 what', async () => {
    //M 第一个模型的 what 只有空白（当没写），第二个照 secondWhat 写。
    let secondWhat = '复制 a.txt';
    const firstReply = '{"probability": 0.5, "reason": "一", "what": "  "}';
    const extraConfig = { models: ['fake/first', 'fake/second'] };
    const ctx = await createDecisionWorld((_text, model) => {
      if (model === 'fake/first') return { ok: true, reply: firstReply };

      const secondReply = `{"probability": 0.5, "reason": "二", "what": "${secondWhat}"}`;
      return { ok: true, reply: secondReply };
    }, extraConfig);
    const question = { instructions: '安全吗', yes: '安全', no: '有风险' };
    const want = ['what'] as const;
    const input = { kind: 'exec', question, state: { 命令: 'copy a.txt b' }, want };

    const found = await requestEvent(ctx, 'decision/judge', 'decision/judge-result', input, judgeOptions);
    expect(found.what).toBe('复制 a.txt');

    //M 两个都没写：回执里不出现 what 这个键。
    secondWhat = '';
    const empty = await requestEvent(ctx, 'decision/judge', 'decision/judge-result', input, judgeOptions);
    expect('what' in empty).toBe(false);
  });
});
