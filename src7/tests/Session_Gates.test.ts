/**
 * 会话的四个关口（src7/Sessions.ts、src7/Tools.ts）：session/request、session/after-model、session/before-tool、
 * session/after-tool 上写 stop 就停下；after-tool 能改结果；不数步数，工具连着要几十轮也走到底。
 * 真实 Cordis + 骨架 Sessions、Tools；模型是假回答（session/request 里填 answer），库是内存库。
 * 跑法：bun test ./src7/tests/Session_Gates.test.ts
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as sessionsModule from '../Sessions.ts';
import * as toolsModule from '../Tools.ts';


//M 每个用例收拾自己的 Cordis。
const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


//M 假资源：会话只用到内存库和 config 里的默认模型、思考档。
class FakeResources extends cordis.Service {
  readonly db = new Database(':memory:');
  readonly config = {
    defaultModel: 'fake/fake',
    thinking: 'low',
    retry: { times: 0, waitMs: 0, timeoutMs: 1000 },
    providers: {},
  };

  constructor(ctx: cordis.Context) {
    super(ctx, 'resources');
  }
}


/** world() 交回的东西。 */
interface World {
  /** 挂好骨架的 Cordis。 */
  ctx: cordis.Context;
  /** 一场新会话，已经说了一句“开始”，还没 run。 */
  session: sessionsModule.Session;
  /** 工具 echo 真正执行了几次。 */
  ran: { count: number };
  /** 每次 session/change 时的状态，照先后。 */
  states: string[];
}


/**
 * 挂上骨架，登记工具 echo（会话种类 t 能用），挂上假模型。
 * 假模型：对话里的工具结果不到 rounds × calls 条，就再要 calls 个 echo；够了就回“做完了”。
 * @param rounds 要几轮工具。
 * @param calls 每轮一次要几个 echo。
 */
async function world(rounds: number, calls: number): Promise<World> {
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  await ctx.plugin(FakeResources);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);

  //M 工具 echo：回 ok，执行一次记一次。
  const ran = { count: 0 };
  ctx.tools.register({
    definition: { name: 'echo', description: '回 ok', parameters: piAi.Type.Object({}) },
    kinds: ['t'],
    run: () => {
      ran.count += 1;
      return 'ok';
    },
  });

  //M 假模型。
  ctx.on('session/request', (request) => {
    const results = request.messages.filter((item) => item.role === 'toolResult');
    if (results.length >= rounds * calls) {
      request.answer = piAi.fauxAssistantMessage('做完了');
      return;
    }

    const blocks = Array.from({ length: calls }, () => piAi.fauxToolCall('echo', {}));
    request.answer = piAi.fauxAssistantMessage(blocks, { stopReason: 'toolUse' });
  });

  //M 记下每次状态变化，看停下的通知只发一次。
  const states: string[] = [];
  ctx.on('session/change', (session) => {
    states.push(session.row.state);
  });

  const session = ctx.sessions.create({ kind: 't', bot: '测试' });
  session.add('开始');
  return { ctx, session, ran, states };
}


/**
 * 对话里每条的角色，照先后。
 * @param session 哪场会话。
 */
function getRoles(session: sessionsModule.Session): string[] {
  return session.row.messages.map((item) => item.role);
}


/**
 * 对话里每条工具结果的文字，照先后。
 * @param session 哪场会话。
 */
function getResultTexts(session: sessionsModule.Session): string[] {
  const results = session.row.messages.filter((item): item is piAi.ToolResultMessage => {
    return item.role === 'toolResult';
  });
  return results.map((item) => piAi.contentText(item.content));
}


test('不数步数：工具连着要 40 轮（原来默认 30 步就停）也走到做完', async () => {
  const { session, ran } = await world(40, 1);
  await session.run();

  expect(session.row.state).toBe('done');
  expect(session.row.reply).toBe('做完了');
  expect(ran.count).toBe(40);
});


test('关口一 session/request 写 stop：不调模型，停下，理由写进 reply', async () => {
  const { ctx, session, states } = await world(1, 1);
  ctx.on('session/request', (request) => {
    request.stop = '先别调';
  });
  await session.run();

  expect(session.row.state).toBe('stopped');
  expect(session.row.reply).toBe('已停止（先别调）');
  expect(getRoles(session)).toEqual(['user']);
  expect(states).toEqual(['running', 'stopped']);
});


test('关口二 session/after-model 能换回答；写 stop 这次回答不要了，工具也不执行', async () => {
  //M 换回答：把要工具的回答换成一句话，会话就做完了，工具没执行。
  const first = await world(1, 1);
  first.ctx.on('session/after-model', (request) => {
    request.answer = piAi.fauxAssistantMessage('换过的回答');
  });
  await first.session.run();
  expect(first.session.row.state).toBe('done');
  expect(first.session.row.reply).toBe('换过的回答');
  expect(first.ran.count).toBe(0);

  //M 喊停：回答不接进对话。
  const second = await world(1, 1);
  second.ctx.on('session/after-model', (request) => {
    request.stop = '回答不对';
  });
  await second.session.run();
  expect(second.session.row.state).toBe('stopped');
  expect(second.session.row.reply).toBe('已停止（回答不对）');
  expect(getRoles(second.session)).toEqual(['user']);
  expect(second.ran.count).toBe(0);
});


test('关口三 session/before-tool 写 stop：这个工具不执行，后面的也不执行，会话停下', async () => {
  const { ctx, session, ran, states } = await world(1, 2);
  ctx.on('session/before-tool', (gate) => {
    gate.stop = '不许再调';
  });
  await session.run();

  expect(session.row.state).toBe('stopped');
  expect(session.row.reply).toBe('已停止（不许再调）');
  expect(ran.count).toBe(0);
  expect(getResultTexts(session)).toEqual(['未执行：不许再调', '未执行：停下来了']);
  expect(states).toEqual(['running', 'stopped']);
});


test('关口四 session/after-tool 能改结果；写 stop 结果照样接进对话，后面的工具不执行，停下只通知一次', async () => {
  //M 改结果：接进对话的是改过的文字。
  const first = await world(1, 1);
  first.ctx.on('session/after-tool', (done) => {
    done.outcome = { text: `改过：${done.outcome.text}`, isError: false };
  });
  await first.session.run();
  expect(first.session.row.state).toBe('done');
  expect(getResultTexts(first.session)).toEqual(['改过：ok']);

  //M 喊停：一次要两个工具，第一个做完就喊停；第二个不执行，结果写“未执行”，它的 after-tool 再喊也不再停一次。
  const second = await world(1, 2);
  second.ctx.on('session/after-tool', (done) => {
    done.stop = '够了';
  });
  await second.session.run();
  expect(second.session.row.state).toBe('stopped');
  expect(second.session.row.reply).toBe('已停止（够了）');
  expect(second.ran.count).toBe(1);
  expect(getResultTexts(second.session)).toEqual(['ok', '未执行：停下来了']);
  expect(second.states).toEqual(['running', 'stopped']);
});
