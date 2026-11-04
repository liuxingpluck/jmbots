/**
 * 飞书入站全程的离线测试：用真的 startFeishu + 假的传输层，喂一条真实形状的飞书事件进去，
 * 验证它一路走到事件表、变成一条 message 事件、分派完之后回复发回原聊天。
 *
 * 为什么要有这条：2026-11-04 把收件表并进了事件表、渠道改成按配置装配、飞书的 readSettings
 * 改成了接一份设置——动的全是"飞书来的消息怎么进来"这条路。真实验证要人在飞书上发一句话，
 * 人不在时就用这条测试顶上：除了飞书自己的网络投递，整条路都真跑了一遍。
 *
 * 全部在临时目录和内存数据库里做，不联网、不碰真实运行时目录。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as feishu from '../src/channels/Feishu.ts';
import * as engineModule from '../src/events/Loop.ts';
import * as events from '../src/events/Events.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import type * as modelModule from '../src/capabilities/Model.ts';


/** 测试用的机器人名。 */
const BOT = '测试机器人';

/** 假 config.yaml：一个供应商、一个默认模型、开着飞书（设置是假的，不会真连）。 */
const CONFIG = [
  'providers:',
  '  fake:',
  '    base_url: http://127.0.0.1:1/v1',
  '    api_key: fake-key-abcdefgh',
  'default_model: fake/m1',
  'channels:',
  '  feishu:',
  '    enabled: true',
  '    app_id: cli_fake',
  '    app_secret: fake-secret-abcdefgh',
  `    bot: ${BOT}`,
].join('\n');


/**
 * 造一条飞书私聊文字消息事件（形状和真实回调一样）。
 * @param text 用户说了什么。
 * @returns 事件。
 */
function inboundEvent(text: string): Parameters<Parameters<feishu.FeishuTransport['listen']>[0]>[0] {
  return {
    sender: { sender_id: { open_id: 'ou_test_user' } },
    message: {
      message_id: 'om_test_1',
      chat_id: 'oc_test_chat',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
  };
}


bunTest.test('飞书入站全程：一条消息进来 → 事件表记成 message → 分派 → 回复发回原聊天', async () => {
  /** 临时运行时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-inbound-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.yaml'), CONFIG);
    fs.mkdirSync(path.join(dir, 'bots', BOT), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bots', BOT, 'config.yaml'), ['description: 测试用', 'judge: rule', 'tools: []'].join('\n'));
    /** 资源。 */
    const resources = await resourcesModule.Resources.load(dir);
    /** 数据库。 */
    const store = events.openEventStore(':memory:');

    /** 发出去的消息，用来验证回复走回了原聊天。 */
    const sent: { to: unknown; text: string }[] = [];
    /** 收到入站事件的回调，由假传输层在 listen 时存下来。 */
    let onEvent: ((event: ReturnType<typeof inboundEvent>) => void) | undefined;
    /** 假传输层：不联网，只把回调存下来，并记下发了什么。 */
    const transport = {
      listen: (handler: (event: ReturnType<typeof inboundEvent>) => void) => {
        onEvent = handler;
        return Promise.resolve();
      },
      sendText: (to: unknown, text: string) => {
        sent.push({ to, text });
        return Promise.resolve('om_reply_1');
      },
      reaction: () => Promise.resolve(),
    } as unknown as feishu.FeishuTransport;

    /** 假模型：直接回一句话，判断走程序规则（有文字就算做完）。 */
    const ai = {
      chat: () => Promise.resolve({
        message: { role: 'assistant', content: [{ type: 'text', text: '知道了' }] } as unknown as modelModule.ChatOutput['message'],
        text: '知道了', thinking: '', toolCalls: [], ms: 1,
        request: { model: 'fake/m1', thinkingAsked: 'off', thinking: 'off', system: '', tools: [], messages: [] },
      }),
      decide: () => Promise.reject(new Error('这个测试不该用决策模型')),
      hasDecision: () => false,
      listModels: () => [{ id: 'fake/m1', name: 'm1', kind: 'chat' as const, contextWindow: 8000, thinking: ['off'], price: { input: 0, output: 0 } }],
    } as unknown as modelModule.Ai;

    /** 引擎。 */
    const engine = engineModule.createEngine({ resources, store, ai, owner: 'test@1', channel: { send: feishu.createSender(transport, store) } });
    /** 读好的飞书设置（走的是新的"接一份设置"的写法）。 */
    const settings = feishu.readChannelSettings(resources.listChannels()[0]?.settings ?? {});
    bunTest.expect(settings?.bot).toBe(BOT);

    await feishu.startFeishu({ transport, settings: settings!, store, engine, resources });
    bunTest.expect(onEvent).toBeDefined();

    //M 用户在飞书说了一句话。
    onEvent?.(inboundEvent('帮我看看'));

    //M 等这句话被记成事件（渠道那边是先确认、后台再处理，所以要等一下）。
    for (let waited = 0; waited < 50 && store.listMessages({ limit: 5 }).length === 0; waited += 1) {
      await Bun.sleep(100);
    }
    /** 事件表里的这句话。 */
    const messages = store.listMessages({ limit: 5 });
    //G 第一站：进了事件表，类型是 message（收件表已经并进来了，不该再有单独的表）。
    bunTest.expect(messages).toHaveLength(1);
    bunTest.expect(messages[0]?.type).toBe('message');
    /** 这条话的内容。 */
    const payload = messages[0]?.payload as { source: string; text: string; bot?: string | null };
    bunTest.expect(payload.text).toBe('帮我看看');
    //G 来源要带上是哪个聊天：后面回复、合批、分派都靠它。
    bunTest.expect(payload.source).toContain('飞书');
    bunTest.expect(payload.bot).toBe(BOT);

    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
