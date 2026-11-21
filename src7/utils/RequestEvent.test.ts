/**
 * 通用请求-回执事件工具 RequestEvent.ts 单元测试：
 *   1. 有人答：异步与同步监听回执均可精确配对，且结束后自动撤监听；
 *   2. 没人答秒退：无监听者或 filter 放过时当场返回 'unhandled'；
 *   3. 限时：调用方传 AbortSignal.timeout，接单但不回执时到点返回 'aborted'；
 *   4. abort：等待中途中止与传入已中止信号均立即返回 'aborted'；
 *   5. 出错：接单后抛错退回 'error' 带异常文字，onError 可转成结构化失败回执。
 * 跑法：bun test ./src7/utils/RequestEvent.test.ts
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as cordis from 'cordis';
import {
  isUncertain,
  onRequestEvent,
  requestEvent,
  type RequestEnvelope,
  type ResultEnvelope,
} from './RequestEvent.ts';


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
  test('回 reply 或 why，处理异常附上详情', async () => {
    const ctx = createWorld();
    const payload = { value: 'echo' };
    const missed = await requestEvent(ctx, 'test/req', 'test/res', payload);
    expect(missed).toEqual({ why: 'unhandled' });

    onRequestEvent(ctx, 'test/req', 'test/res', (req) => {
      if (req.value === 'error') throw new Error('处理失败');

      return { ok: true, answer: req.value };
    });

    const answered = await requestEvent(ctx, 'test/req', 'test/res', payload);
    expect(answered).toEqual({ reply: { ok: true, answer: 'echo', requestId: expect.any(String) } });
    const error = { value: 'error' };
    const failed = await requestEvent(ctx, 'test/req', 'test/res', error);
    expect(failed).toEqual({ why: 'error', detail: '处理失败' });
  });

  test('warnAfterMs 达到后只记一次警告，继续等待实际回执', async () => {
    const ctx = createWorld();
    const release = Promise.withResolvers<void>();
    const warnings = spyOn(console, 'warn').mockImplementation(() => {});
    closers.push(() => {
      release.resolve();
      warnings.mockRestore();
    });
    onRequestEvent(ctx, 'test/req', 'test/res', async (req) => {
      await release.promise;
      return { ok: true, answer: req.value };
    });
    const payload = { value: '后续回执' };
    const options = { warnAfterMs: 5 };
    const before = ctx.events._hooks['test/res']?.length ?? 0;
    const pending = requestEvent(ctx, 'test/req', 'test/res', payload, options);
    //M 报警定时器不保持进程存活，测试用自己的等待维持事件循环。
    await Bun.sleep(25);
    const warning = warnings.mock.calls[0]?.[0];
    expect(warning).toContain('test/req 回执已达 5 毫秒');
    expect(ctx.events._hooks['test/res']?.length).toBe(before + 1);
    expect(warnings).toHaveBeenCalledTimes(1);
    release.resolve();
    const answered = await pending;
    expect(answered.reply).toMatchObject({ answer: payload.value });
    expect(ctx.events._hooks['test/res']?.length ?? 0).toBe(before);
  });

  test('有人答：支持异步处理、并发多请求不串台，且完成后撤回临时监听', async () => {
    const ctx = createWorld();
    onRequestEvent(ctx, 'test/req', 'test/res', async (req) => {
      await Promise.resolve();
      return { ok: true, answer: `echo:${req.value}` };
    });

    const before = ctx.events._hooks['test/res']?.length ?? 0;
    const options = { prefix: 't' };
    const [r1, r2] = await Promise.all([
      requestEvent(ctx, 'test/req', 'test/res', { value: 'one' }, options),
      requestEvent(ctx, 'test/req', 'test/res', { value: 'two' }, options),
    ]);

    expect(r1.why).toBeUndefined();
    expect(r1.reply?.ok).toBe(true);
    expect(r1.reply?.answer).toBe('echo:one');
    expect(r1.reply?.requestId.startsWith('t_')).toBe(true);
    expect(r2.reply?.ok).toBe(true);
    expect(r2.reply?.answer).toBe('echo:two');
    expect(r2.reply?.requestId).not.toBe(r1.reply?.requestId);
    expect(ctx.events._hooks['test/res']?.length ?? 0).toBe(before);
  });

  test('没人答秒退：无监听者或 filter 返回 false 时立刻返回 unhandled', async () => {
    const ctx = createWorld();
    const start1 = Date.now();
    const miss = await requestEvent(ctx, 'test/req', 'test/res', { value: 'none' });
    expect(Date.now() - start1).toBeLessThan(200);
    expect(miss).toEqual({ why: 'unhandled' });

    onRequestEvent(
      ctx,
      'test/req',
      'test/res',
      (req) => ({ ok: true, answer: req.value }),
      { filter: (req) => req.value === 'wanted' },
    );
    const start2 = Date.now();
    const skipped = await requestEvent(ctx, 'test/req', 'test/res', { value: 'other' });
    expect(Date.now() - start2).toBeLessThan(200);
    expect(skipped.why).toBe('unhandled');
  });

  test('限时与异常转回执：接单后到了调用方的时限返回 aborted，onError 可转成结构化失败', async () => {
    const ctx = createWorld();
    const stopSlow = ctx.on('test/req', async (req) => {
      req.handled = true;
      await Bun.sleep(200);
    });
    //M 调用方要限时就传 AbortSignal.timeout，到点按中止退回。
    const limited = { signal: AbortSignal.timeout(25) };
    const timedOut = await requestEvent(ctx, 'test/req', 'test/res', { value: 'slow' }, limited);
    expect(timedOut).toEqual({ why: 'aborted' });
    stopSlow();

    onRequestEvent(
      ctx,
      'test/req',
      'test/res',
      () => {
        throw new Error('处理炸了');
      },
      {
        onError: (error) => ({ ok: false, answer: '', reason: (error as Error).message }),
      },
    );
    const failed = await requestEvent(ctx, 'test/req', 'test/res', { value: 'boom' });
    expect(failed.why).toBeUndefined();
    expect(failed.reply?.ok).toBe(false);
    expect(failed.reply?.reason).toBe('处理炸了');
  });

  test('接单后抛错且未回执时，退回 error 并带上异常文字', async () => {
    const ctx = createWorld();
    //M 构造可能已完成部分写入、但未返回业务回执的监听者。
    ctx.on('test/req', (request) => {
      request.handled = true;
      throw new Error('部分写入后出错');
    });
    const payload = { value: 'write' };

    //M 结果不确定由调用方按 why 判断：只有 unhandled 能确定对方没执行。
    const result = await requestEvent(ctx, 'test/req', 'test/res', payload);
    expect(result).toEqual({ why: 'error', detail: '部分写入后出错' });
  });

  test('AbortSignal 中止：提前 aborted 与等待中途 abort 都立刻返回 aborted', async () => {
    const ctx = createWorld();
    const pre = new AbortController();
    pre.abort();
    const preOptions = { signal: pre.signal };
    const immediate = await requestEvent(ctx, 'test/req', 'test/res', { value: 'pre' }, preOptions);
    expect(immediate).toEqual({ why: 'aborted' });

    ctx.on('test/req', async (req) => {
      req.handled = true;
      await Bun.sleep(5_000);
    });
    const during = new AbortController();
    setTimeout(() => during.abort(), 15);
    const start = Date.now();
    const duringOptions = { signal: during.signal };
    const aborted = await requestEvent(ctx, 'test/req', 'test/res', { value: 'wait' }, duringOptions);
    expect(Date.now() - start).toBeLessThan(300);
    expect(aborted).toEqual({ why: 'aborted' });
  });

  test('isUncertain：只把 aborted 与 error 判为结果不确定，reply 与 unhandled 均为 false', () => {
    expect(isUncertain({ reply: { ok: true, answer: 'done', requestId: 'r_1' } })).toBe(false);
    expect(isUncertain({ why: 'unhandled' })).toBe(false);
    expect(isUncertain({ why: 'aborted' })).toBe(true);
    expect(isUncertain({ why: 'error', detail: 'boom' })).toBe(true);
  });
});
