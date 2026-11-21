/**
 * 旁听工具 Trace.ts 的 onDispatch、onTrace 单元测试：
 *   1. 第一个 onDispatch 旁听者抛错，第二个旁听者和后面的业务监听照常收到事件，emit 不往外抛；
 *   2. 同一次派发交给几个 onDispatch 旁听者的是同一个 SharedLine 引用（只拼一次）；跟踪点、Cordis 内部事件不交过来；
 *   3. onTrace 旁听者抛错，不拦发跟踪点那一行后面的业务代码。
 * 跑法：bun test ./src7/utils/Trace.test.ts
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as cordis from 'cordis';
import * as traceUtils from './Trace.ts';


declare module 'cordis' {
  interface Events {
    /**
     * 谁发：src7/utils/Trace.test.ts 的 模块顶层
     * 谁接：src7/utils/Trace.test.ts 的 模块顶层
     */
    'test/observed'(payload: { sessionId: string }): void;
  }
}


/** 每个用例开的 ctx，用完拔掉。 */
const contexts: cordis.Context[] = [];

afterEach(() => {
  for (const ctx of contexts.splice(0)) {
    ctx.fiber.dispose();
  }
});

/** 开一个干净的 Cordis ctx，用完由 afterEach 拔掉。 */
function makeContext(): cordis.Context {
  const ctx = new cordis.Context();
  contexts.push(ctx);
  return ctx;
}


describe('Trace 旁听隔离', () => {
  test('第一个旁听者抛错：第二个旁听者和业务监听照常收到，emit 不抛', () => {
    const ctx = makeContext();
    const logged = spyOn(console, 'error').mockImplementation(() => undefined);

    //M 第一个旁听者故意抛错，第二个旁听者记下拿到的事件行。
    traceUtils.onDispatch(ctx, 'boom-observer', () => {
      throw new Error('boom');
    });
    const seen: traceUtils.SharedLine[] = [];
    traceUtils.onDispatch(ctx, 'quiet-observer', (line) => {
      seen.push(line);
    });

    //M 业务监听：记下收到的参数。
    const received: string[] = [];
    ctx.on('test/observed', (payload) => {
      received.push(payload.sessionId);
    });

    //M 发事件：不该抛，三方都该走到。
    const payload = { sessionId: 's_1' };
    expect(() => ctx.emit('test/observed', payload)).not.toThrow();

    expect(received).toEqual(['s_1']);
    expect(seen.length).toBe(1);
    expect(seen[0]?.name).toBe('test/observed');
    expect(seen[0]?.session).toBe('s_1');
    expect(typeof seen[0]?.site).toBe('string');

    //M 出错只记一行日志，写明是谁。
    const messages = logged.mock.calls.map((call) => String(call[0]));
    logged.mockRestore();
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain('[旁听异常:boom-observer]');
    expect(messages[0]).toContain('boom');
  });

  test('同一次派发交给几个旁听者的是同一个 SharedLine；跟踪点、内部事件不交过来', () => {
    const ctx = makeContext();

    const first: traceUtils.SharedLine[] = [];
    const second: traceUtils.SharedLine[] = [];
    traceUtils.onDispatch(ctx, 'first', (line) => {
      first.push(line);
    });
    traceUtils.onDispatch(ctx, 'second', (line) => {
      second.push(line);
    });

    //M 发两次业务事件，再发一个跟踪点。
    ctx.emit('test/observed', { sessionId: 's_a' });
    ctx.emit('test/observed', { sessionId: 's_b' });
    ctx.emit('trace', 'Test.point', '一个跟踪点', 'emit()', {});

    //M 每次派发两个旁听者拿到同一个引用；两次派发各算一份；trace 不交过来。
    expect(first.length).toBe(2);
    expect(second.length).toBe(2);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(first[0]).not.toBe(first[1]);
    expect(first[1]?.session).toBe('s_b');
  });

  test('onTrace 旁听者抛错：发跟踪点后面的业务代码照常往下走', () => {
    const ctx = makeContext();
    const logged = spyOn(console, 'error').mockImplementation(() => undefined);

    traceUtils.onTrace(ctx, 'trace-boom', () => {
      throw new Error('boom');
    });
    const points: string[] = [];
    traceUtils.onTrace(ctx, 'trace-quiet', (where) => {
      points.push(where);
    });

    //M 模拟业务代码：发一个跟踪点，再接着干活。
    const steps: string[] = [];
    const business = (): void => {
      ctx.emit('trace', 'Bot.receive', '交给会话', 'session.run()', { session: 's_1' });
      steps.push('after-trace');
    };
    expect(business).not.toThrow();

    expect(steps).toEqual(['after-trace']);
    expect(points).toEqual(['Bot.receive']);
    const messages = logged.mock.calls.map((call) => String(call[0]));
    logged.mockRestore();
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain('[旁听异常:trace-boom]');
  });
});
