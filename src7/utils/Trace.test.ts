/**
 * 旁听工具 Trace.ts 的 onDispatch、onTrace 单元测试：
 *   1. 第一个 onDispatch 旁听者抛错，第二个旁听者和后面的业务监听照常收到事件，emit 不往外抛；
 *   2. 同一次派发交给几个 onDispatch 旁听者的是同一个 SharedLine 引用（只拼一次）；跟踪点、Cordis 内部事件不交过来；
 *   3. onTrace 旁听者抛错，不拦发跟踪点那一行后面的业务代码；
 *   4. buildDispatchLine 一处认“属于哪条消息”：回复请求的来源快照、目标地址，会话的地址和状态，渠道消息的 origin.address。
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

  test('派发和跟踪点都从同一个计数器拿号：同一次共用一个号，先后越来越大（云端 36 号第 2 条）', () => {
    const ctx = makeContext();

    //M 两个旁听者各自记下派发和跟踪点拿到的号。
    const dispatched: number[][] = [[], []];
    const traced: number[][] = [[], []];
    for (const slot of [0, 1]) {
      traceUtils.onDispatch(ctx, `d${String(slot)}`, (line) => {
        dispatched[slot]?.push(line.seq);
      });
      traceUtils.onTrace(ctx, `t${String(slot)}`, (_where, _text, _code, _vars, seq) => {
        traced[slot]?.push(seq);
      });
    }

    //M 同名事件 1 毫秒内连发两次，中间夹一个跟踪点。
    ctx.emit('test/observed', { sessionId: 's_a' });
    ctx.emit('trace', 'Test.point', '一个跟踪点', 'emit()', {});
    ctx.emit('test/observed', { sessionId: 's_a' });

    //M 两个旁听者拿到的号一样；两次同名派发的号不同，跟踪点的号夹在中间。
    expect(dispatched[1]).toEqual(dispatched[0] ?? []);
    expect(traced[1]).toEqual(traced[0] ?? []);
    const [firstSeq, secondSeq] = dispatched[0] ?? [];
    const [traceSeq] = traced[0] ?? [];
    expect(firstSeq).toBeLessThan(traceSeq ?? 0);
    expect(traceSeq).toBeLessThan(secondSeq ?? 0);
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

describe('buildDispatchLine 一处认属于哪条消息', () => {
  test('channel/reply、channel/replied、bot/settled、web-api/replied、渠道消息都认得出消息号', () => {
    const ctx = makeContext();
    const sourceId = JSON.stringify(['http', 'local', '42']);
    const snapshot = {
      messageId: sourceId,
      botName: '周小灵',
      origin: { channel: 'http', address: { messageId: 42 } },
    };
    const reply = { requestId: 'req-42', channel: 'http', sessionId: 's_42', sourceSnapshot: snapshot };

    //M channel/reply：requestId、sessionId 从请求取，标准消息号、机器人、收件号从来源快照取。
    const replyLine = traceUtils.buildDispatchLine(ctx, 'serial', 'channel/reply', [reply], 200);
    expect(replyLine.replyRequestId).toBe('req-42');
    expect(replyLine.session).toBe('s_42');
    expect(replyLine.sourceId).toBe(sourceId);
    expect(replyLine.bot).toBe('周小灵');
    expect(replyLine.messageId).toBe(42);

    //M channel/replied：请求包在 request 里。
    const repliedArgs = [{ requestId: 'req-42', request: reply, receipt: { ok: true } }];
    const repliedLine = traceUtils.buildDispatchLine(ctx, 'emit', 'channel/replied', repliedArgs, 200);
    expect(repliedLine.replyRequestId).toBe('req-42');
    expect(repliedLine.messageId).toBe(42);
    expect(repliedLine.sourceId).toBe(sourceId);

    //M bot/settled：只带来源快照，不认 requestId。
    const settledArgs = [{ sourceSnapshot: snapshot, stage: 'sent' }];
    const settledLine = traceUtils.buildDispatchLine(ctx, 'emit', 'bot/settled', settledArgs, 200);
    expect(settledLine.replyRequestId).toBeUndefined();
    expect(settledLine.messageId).toBe(42);
    expect(settledLine.bot).toBe('周小灵');

    //M 回复目标 target.address 的收件号。
    const targetArgs = [{ requestId: 'req-43', target: { address: { messageId: 43 } } }];
    const targetLine = traceUtils.buildDispatchLine(ctx, 'serial', 'channel/reply', targetArgs, 200);
    expect(targetLine.messageId).toBe(43);

    //M 会话：row.state、row.address 的收件号、row.activeSourceSnapshot 的标准消息号；参数里已带的消息号优先。
    const session = {
      id: 's_42',
      row: {
        bot: '周小灵',
        state: 'done',
        address: { messageId: 41 },
        activeSourceSnapshot: { messageId: sourceId },
        messages: [],
      },
    };
    const changeLine = traceUtils.buildDispatchLine(ctx, 'emit', 'session/change', [session, 'running'], 200);
    expect(changeLine.sessionState).toBe('done');
    expect(changeLine.messageId).toBe(41);
    expect(changeLine.sourceId).toBe(sourceId);
    const webArgs = [{ messageId: 42, session }];
    const webLine = traceUtils.buildDispatchLine(ctx, 'emit', 'web-api/replied', webArgs, 200);
    expect(webLine.messageId).toBe(42);
    expect(webLine.sessionState).toBe('done');

    //M 渠道消息：origin.address 的收件号；平台原消息号不当标准消息号。
    const channelArgs = [{ messageId: sourceId, origin: { address: { messageId: 44 } } }, { claims: [] }];
    const channelLine = traceUtils.buildDispatchLine(ctx, 'serial', 'channel/direct', channelArgs, 200);
    expect(channelLine.messageId).toBe(44);
    expect(channelLine.sourceId).toBe(sourceId);
    const rawArgs = [{ messageId: 'om_x', origin: { address: { messageId: 'om_x' } } }];
    const rawLine = traceUtils.buildDispatchLine(ctx, 'serial', 'channel/direct', rawArgs, 200);
    expect(rawLine.messageId).toBeUndefined();
    expect(rawLine.sourceId).toBeUndefined();
  });
});
