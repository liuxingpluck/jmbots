/**
 * 通用请求-回执事件工具 RequestEvent.ts 单元测试：
 *   1. 有人答：异步与同步监听回执均可精确配对，且结束后自动撤监听；
 *   2. 没人答秒退：无监听者或 filter 放过时当场返回 'unhandled'，不等长超时；
 *   3. 超时：接单但不回执时按 timeoutMs 返回 'timeout'；
 *   4. abort：等待中途中止与传入已中止信号均立即返回 'aborted'。
 * 跑法：bun test ./src7/utils/RequestEvent.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import { onRequestEvent, requestEvent, type RequestEnvelope, type ResultEnvelope } from './RequestEvent.ts';


declare module 'cordis' {
  interface Events {
    /**
     * 谁发：src7/utils/RequestEvent.test.ts 的 模块顶层
     * 谁接：src7/utils/RequestEvent.test.ts 的 模块顶层
     */
    'test/req'(request: TestRequest): void | Promise<void>;
    /**
     * 谁发：src7/utils/RequestEvent.test.ts 的 模块顶层
     * 谁接：src7/utils/RequestEvent.test.ts 的 模块顶层
     */
    'test/res'(result: TestResult): void;
  }
}

interface TestRequest extends RequestEnvelope {
  value: string;
}

interface TestResult extends ResultEnvelope {
  ok: boolean;
  answer: string;
  reason?: string;
}


const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 构建挂好真实 Cordis 上下文的测试环境。 */
function createWorld(): cordis.Context {
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  return ctx;
}


describe('RequestEvent 通用请求-回执', () => {
  test('有人答：支持异步处理、并发多请求不串台，且完成后撤回临时监听', async () => {
    const ctx = createWorld();
    onRequestEvent(ctx, 'test/req', 'test/res', async (req) => {
      await Promise.resolve();
      return { ok: true, answer: `echo:${req.value}` };
    });

    const before = ctx.events._hooks['test/res']?.length ?? 0;
    const [r1, r2] = await Promise.all([
      requestEvent(ctx, 'test/req', 'test/res', { value: 'one' }, {
        prefix: 't',
        timeoutMs: 1000,
        onFallback: (reason) => ({ requestId: '', ok: false, answer: reason }),
      }),
      requestEvent(ctx, 'test/req', 'test/res', { value: 'two' }, {
        prefix: 't',
        timeoutMs: 1000,
        onFallback: (reason) => ({ requestId: '', ok: false, answer: reason }),
      }),
    ]);

    expect(r1.ok).toBe(true);
    expect(r1.answer).toBe('echo:one');
    expect(r1.requestId.startsWith('t_')).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.answer).toBe('echo:two');
    expect(r2.requestId).not.toBe(r1.requestId);
    expect(ctx.events._hooks['test/res']?.length ?? 0).toBe(before);
  });

  test('没人答秒退：无监听者或 filter 返回 false 时立刻返回 unhandled，不等待 timeoutMs', async () => {
    const ctx = createWorld();
    const start1 = Date.now();
    const miss = await requestEvent(ctx, 'test/req', 'test/res', { value: 'none' }, {
      timeoutMs: 5_000,
      onFallback: (reason) => ({ requestId: '', ok: false, answer: 'fallback', reason }),
    });
    expect(Date.now() - start1).toBeLessThan(200);
    expect(miss).toEqual({ requestId: '', ok: false, answer: 'fallback', reason: 'unhandled' });

    onRequestEvent(
      ctx,
      'test/req',
      'test/res',
      (req) => ({ ok: true, answer: req.value }),
      { filter: (req) => req.value === 'wanted' },
    );
    const start2 = Date.now();
    const skipped = await requestEvent(ctx, 'test/req', 'test/res', { value: 'other' }, {
      timeoutMs: 5_000,
      onFallback: (reason) => ({ requestId: '', ok: false, answer: 'fallback', reason }),
    });
    expect(Date.now() - start2).toBeLessThan(200);
    expect(skipped.reason).toBe('unhandled');
  });

  test('超时与异常转回执：接单后超期返回 timeout，onError 可转成结构化失败', async () => {
    const ctx = createWorld();
    const stopSlow = ctx.on('test/req', async (req) => {
      req.handled = true;
      await Bun.sleep(200);
    });
    const timedOut = await requestEvent(ctx, 'test/req', 'test/res', { value: 'slow' }, {
      timeoutMs: 25,
      onFallback: (reason) => ({ requestId: '', ok: false, answer: '', reason }),
    });
    expect(timedOut.reason).toBe('timeout');
    stopSlow();

    onRequestEvent(
      ctx,
      'test/req',
      'test/res',
      () => {
        throw new Error('处理炸了');
      },
      {
        onError: (error) => ({ ok: false, answer: '', reason: error instanceof Error ? error.message : String(error) }),
      },
    );
    const failed = await requestEvent(ctx, 'test/req', 'test/res', { value: 'boom' }, {
      timeoutMs: 5_000,
      onFallback: (reason) => ({ requestId: '', ok: false, answer: '', reason }),
    });
    expect(failed.ok).toBe(false);
    expect(failed.reason).toBe('处理炸了');
  });

  test('AbortSignal 中止：提前 aborted 与等待中途 abort 都立刻返回 aborted', async () => {
    const ctx = createWorld();
    const pre = new AbortController();
    pre.abort();
    const immediate = await requestEvent(ctx, 'test/req', 'test/res', { value: 'pre' }, {
      timeoutMs: 5_000,
      signal: pre.signal,
      onFallback: (reason) => ({ requestId: '', ok: false, answer: '', reason }),
    });
    expect(immediate.reason).toBe('aborted');

    ctx.on('test/req', async (req) => {
      req.handled = true;
      await Bun.sleep(5_000);
    });
    const during = new AbortController();
    setTimeout(() => during.abort(), 15);
    const start = Date.now();
    const aborted = await requestEvent(ctx, 'test/req', 'test/res', { value: 'wait' }, {
      timeoutMs: 5_000,
      signal: during.signal,
      onFallback: (reason) => ({ requestId: '', ok: false, answer: '', reason }),
    });
    expect(Date.now() - start).toBeLessThan(300);
    expect(aborted.reason).toBe('aborted');
  });
});
