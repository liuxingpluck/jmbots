/**
 * decision v1.0.2 事件接口单元测试（只用假会话问答，不调真实模型或分类器）：
 *   1. 验证仅配置 chat 模型（无 classifier）时构造阶段仍正确挂载 `decision/judge` 监听；
 *   2. 验证 `allow`（>= allowAt）、`deny`（< denyAt）与 `unsure`（中间分/答不上来）回执结构完整配对。
 * 跑法：bun test ./src7/plugins/decision
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import { requestEvent } from '../../utils/RequestEvent.ts';
import * as decisionPlugin from './index.ts';


const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 启动挂好假资源、假机器人与可编程假 sessions.ask 的决策测试环境。 */
async function createDecisionWorld(
  onAsk: (text: string) => { ok: boolean; reply: string },
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
    ask(input: { text: string }): Promise<{ ok: boolean; reply: string }> {
      return Promise.resolve(onAsk(input.text));
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
      {
        prefix: 'dec',
        timeoutMs: 1000,
        onFallback: (_reason, detail) => ({ requestId: '', verdict: 'unsure', reason: detail ?? '未响应' }),
      },
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
      {
        prefix: 'dec',
        timeoutMs: 1000,
        onFallback: (_reason, detail) => ({ requestId: '', verdict: 'unsure', reason: detail ?? '未响应' }),
      },
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
      {
        prefix: 'dec',
        timeoutMs: 1000,
        onFallback: (_reason, detail) => ({ requestId: '', verdict: 'unsure', reason: detail ?? '未响应' }),
      },
    );
    expect(unsure.verdict).toBe('unsure');
    expect(unsure.score).toBeUndefined();
  });
});
