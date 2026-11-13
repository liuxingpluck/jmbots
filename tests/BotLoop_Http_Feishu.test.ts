/**
 * 机器人循环、HTTP 渠道、飞书渠道的离线测试：
 *   HTTP 发两条（同一来源）→ 机器人循环合成一批 → 分派（程序兜底）→ 会话跑完回复；PUT /api/bots 改合批；指定会话的消息不分派
 *   飞书（假传输层）：收图文 → 交给机器人循环（带图）；发文字里的 @路径 → 文字 + 图片；审核卡片点了按钮 → 待确认兑现
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as botLoopModule from '../src/bots/BotLoop.ts';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as feishu from '../src/channels/Feishu.ts';
import * as http from '../src/channels/Http.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import * as builders from './Builders.ts';


/**
 * 建依赖：一个机器人周小灵，常规模型一律回“收到”。
 * @param sent 发出去的回复记在这里。
 * @returns 依赖。
 */
async function setup(sent: string[]): Promise<builders.TestDeps> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-botloop-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'providers: {}\ndefault_model: magpie/test\nbots:\n  - name: 周小灵\n    language: zh\nengine:\n  poll_ms: 20\n  merge_ms: 150\n');
  const resources = await resourcesModule.Resources.load(dir);
  const files = new filesModule.Files(resources);
  await files.ensureBot('周小灵');
  const ai = builders.fakeAi({
    chat: (input) => {
      const message = { role: 'assistant', content: [{ type: 'text', text: '收到' }], api: 'openai-completions', provider: 'magpie', model: 'test', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } as piAi.AssistantMessage;
      return Promise.resolve({ message, text: '收到', thinking: '', toolCalls: [], ms: 1, request: { model: input.model, thinkingAsked: 'off', thinking: 'off', system: '', tools: [], messages: [] } });
    },
    decide: () => Promise.reject(new Error('没有')),
    hasDecision: () => false,
    listModels: () => [{ id: 'magpie/test', name: 'test', kind: 'chat', contextWindow: 100_000, thinking: ['off'], vision: true, price: { input: 0, output: 0 } }],
  });
  const out: depsModule.Outlet = {
    send: (_channel, _address, text) => {
      sent.push(text);
      return Promise.resolve();
    },
    sendApproval: () => Promise.resolve([]),
    publishDoc: () => Promise.reject(new Error('无')),
    deleteDoc: () => Promise.reject(new Error('无')),
  };
  return { resources, files, ai, store: new storeModule.Store(':memory:'), secrets: new secretsModule.Secrets([]), approvals: new approvalsModule.Approvals(), out };
}


/**
 * 等到条件成立（最多 5 秒）。
 * @param condition 条件。
 */
async function until(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 250 && !condition(); index += 1) {
    await Bun.sleep(20);
  }
}


/**
 * 造一条飞书接收事件，省得每个用例都把固定字段写一遍。
 * @param messageType 消息类型。
 * @param content 消息内容（JSON 字符串，也可以是坏掉的 JSON）。
 * @param extra 额外字段（如 parent_id、mentions），同名字段覆盖默认值。
 * @returns 一条接收事件。
 */
function feishuEvent(messageType: string, content: string, extra: Partial<feishu.ReceiveEvent['message']> = {}): feishu.ReceiveEvent {
  return {
    sender: { sender_id: { open_id: 'ou_1' } },
    message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: messageType, content, ...extra },
  };
}


/**
 * 起一个用假传输层的飞书渠道：listen 捕获回调，默认下载写一张假 PNG，收到的消息和下载用的 messageId 都记下来。
 * @param deps 依赖。
 * @param options 覆盖 getMessageItems、downloadResource；不传 downloadResource 就用默认下载。
 * @returns onEvent 触发一条事件、received 交给机器人循环的消息、downloads 下载时的 messageId、stop 停渠道。
 */
async function startFakeFeishu(deps: builders.TestDeps, options: {
  getMessageItems?: feishu.FeishuTransport['getMessageItems'];
  downloadResource?: feishu.FeishuTransport['downloadResource'];
} = {}): Promise<{
  onEvent: (event: feishu.ReceiveEvent) => void;
  received: botLoopModule.IncomingInput[];
  downloads: string[];
  stop: () => Promise<void>;
}> {
  /** listen 捕获到的收消息回调。 */
  let handler: (event: feishu.ReceiveEvent) => void = () => undefined;
  /** 下载过的 messageId。 */
  const downloads: string[] = [];
  /** 交给机器人循环的。 */
  const received: botLoopModule.IncomingInput[] = [];
  /** 默认下载：记下 messageId，写一个假 PNG，让 onMessage 读得到。 */
  const defaultDownload: NonNullable<feishu.FeishuTransport['downloadResource']> = (messageId, _resource, destination) => {
    downloads.push(messageId);
    fs.writeFileSync(destination, Buffer.from([137, 80, 78, 71]));
    return Promise.resolve();
  };
  const transport: feishu.FeishuTransport = {
    listen: (event) => {
      handler = event;
      return Promise.resolve();
    },
    sendText: () => Promise.resolve('m1'),
    downloadResource: options.downloadResource ?? defaultDownload,
    getMessageItems: options.getMessageItems,
    close: () => undefined,
  };
  const channel = feishu.createFeishuChannel({ app_id: 'cli_test', app_secret: 'secret_xxxxxxxx', bot: '周小灵' }, deps, transport);
  const stop = await channel.start((input) => {
    received.push(input);
    return Promise.resolve();
  });
  /** 触发一条事件：读的是 listen 捕获到的回调。 */
  function onEvent(event: feishu.ReceiveEvent): void {
    handler(event);
  }
  return { onEvent, received, downloads, stop };
}


bunTest.describe('HTTP + 机器人循环', () => {
  bunTest.test('仅转接保留收件和文件，强制执行也不调用模型；合批更新保留设置', async () => {
    const sent: string[] = [];
    const deps = await setup(sent);
    let calls = 0;
    deps.ai = builders.fakeAi({
      chat: () => { calls += 1; return Promise.reject(new Error('不应调用模型')); },
      decide: () => { calls += 1; return Promise.reject(new Error('不应分派')); },
      hasDecision: () => false,
      listModels: () => [],
    });
    await deps.files.writeBotSettings('周小灵', { relayOnly: true });
    const loop = builders.botLoopOf(deps);
    const stop = loop.start('周小灵');
    const app = new http.HttpApp(builders.httpPartsOf(deps)).build();
    try {
      for (const text of ['我在了', 'force run 帮我做视频']) {
        const row = await loop.receive({
          bot: '周小灵', channel: 'http', source: '甲', address: {}, text, images: [],
        });
        bunTest.expect(row.status).toBe('held');
        bunTest.expect(fs.readFileSync(row.file, 'utf8')).toContain(text);
      }
      const result = await app.inject({
        method: 'PUT', url: '/api/bots/' + encodeURIComponent('周小灵'), payload: { merge_ms: 0 },
      });
      bunTest.expect(result.statusCode).toBe(200);
      bunTest.expect(deps.files.readBotSettings('周小灵')).toEqual({ mergeMs: 0, relayOnly: true });
      deps.store.recover();
      await Bun.sleep(250);
      bunTest.expect(calls).toBe(0);
      bunTest.expect(sent).toEqual([]);
    } finally {
      stop();
      await app.close();
    }
  });
  bunTest.test('工作区建不出来、分派记录写不成：话不丢，放进“日常”，会话照样跑', async () => {
    const sent: string[] = [];
    const deps = await setup(sent);
    const ai = deps.ai;
    /** 调了几次模型。 */
    let chats = 0;
    deps.ai = builders.fakeAi({
      decide: (input) => ai.decide(input),
      hasDecision: () => ai.hasDecision(),
      listModels: () => ai.listModels(),
      chat: async (input) => {
        const output = await ai.chat(input);
        chats += 1;
        if (chats > 1) {
          return output;
        }
        //M 第一次是分派：回一个名字合法、但这台机器建不出来的工作区（Windows 的 CON 之类）。
        const text = '{"interrupt": [], "workspace": "CON", "session": "new", "title": "干活", "model": "magpie/test", "reason": "新的事"}';
        return { ...output, text, message: { ...output.message, content: [{ type: 'text', text }] } };
      },
    });
    const files = deps.files;
    //M Files 是 class，{ ...files } 拿不到原型上的方法：用 Object.create 继承原对象，只覆盖这两个。
    /** 只改两个方法的文件库。 */
    const overrides = {
      ensureWorkspace: (bot: string, name: string, description: string) =>
        (name === 'CON' ? Promise.reject(new Error('建不出来')) : files.ensureWorkspace(bot, name, description)),
      writeDispatch: () => Promise.reject(new Error('磁盘满了')),
    };
    deps.files = Object.assign(Object.create(files) as filesModule.Files, overrides);
    const row = await builders.botLoopOf(deps).receive({ bot: '周小灵', channel: 'http', source: '甲', address: {}, text: '干活', images: [] });
    const stop = builders.botLoopOf(deps).start('周小灵');
    await until(() => sent.length > 0);
    stop();
    bunTest.expect(sent).toEqual(['收到']);
    const message = deps.store.getMessage(row.id)!;
    bunTest.expect(message.status).toBe('taken');
    bunTest.expect(deps.store.getSession(message.sessionId!)?.workspace).toBe('日常');
    bunTest.expect(JSON.stringify(message.dispatch)).toContain('工作区「CON」建不出来');
  });

  bunTest.test('同一来源连发两条：合成一批分派、进同一个会话；会话跑完回复；消息文件写上分派和结果', async () => {
    const sent: string[] = [];
    const deps = await setup(sent);
    const app = new http.HttpApp(builders.httpPartsOf(deps)).build();
    const first = await app.inject({ method: 'POST', url: '/api/message', payload: { text: '第一句', from: '甲' } });
    const second = await app.inject({ method: 'POST', url: '/api/message', payload: { text: '第二句', from: '甲' } });
    const ids = [first.json<{ id: number }>().id, second.json<{ id: number }>().id];
    const stop = builders.botLoopOf(deps).start('周小灵');
    await until(() => sent.length > 0);
    stop();
    bunTest.expect(sent).toEqual(['收到']);
    const rows = ids.map((id) => deps.store.getMessage(id)!);
    bunTest.expect(rows.every((row) => row.status === 'taken')).toBe(true);
    bunTest.expect(rows[0]!.sessionId).toBe(rows[1]!.sessionId);
    const view = (await app.inject({ method: 'GET', url: `/api/messages/${ids[0]}` })).json<{ dispatch: { messageIds: number[]; result: { by: string } }; replies: unknown[] }>();
    bunTest.expect(view.dispatch.messageIds).toEqual(ids);
    bunTest.expect(view.replies).toHaveLength(0);
    bunTest.expect((await app.inject({ method: 'GET', url: `/api/messages/${ids[1]}` })).json<{ replies: unknown[] }>().replies).toHaveLength(1);
    bunTest.expect(fs.readFileSync(rows[0]!.file, 'utf8')).toContain('合成一批分派');
    const session = (await app.inject({ method: 'GET', url: `/api/sessions/${rows[0]!.sessionId}` })).json<{ md: string; status: string }>();
    bunTest.expect(session.md).toContain('第一句');
    bunTest.expect(session.md).toContain('第二句');
    await app.close();
  });

  bunTest.test('GET/PUT /api/bots：改合批等待，写进机器人.yaml；健康检查', async () => {
    const deps = await setup([]);
    const app = new http.HttpApp(builders.httpPartsOf(deps)).build();
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/bots' })).json<unknown>()).toEqual([{ name: '周小灵', language: 'zh', mergeMs: null, effectiveMergeMs: 150, status: 'idle', running: 0, queued: 0, approvals: 0 }]);
    bunTest.expect((await app.inject({ method: 'PUT', url: `/api/bots/${encodeURIComponent('周小灵')}`, payload: { merge_ms: 0 } })).statusCode).toBe(200);
    bunTest.expect(deps.files.readBotSettings('周小灵')).toEqual({ mergeMs: 0 });
    bunTest.expect((await app.inject({ method: 'PUT', url: `/api/bots/${encodeURIComponent('周小灵')}`, payload: { merge_ms: -1 } })).statusCode).toBe(400);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/health' })).json<{ ok: boolean }>().ok).toBe(true);
    await app.close();
  });

  bunTest.test('指定会话的消息不分派，直接排给那个会话', async () => {
    const sent: string[] = [];
    const deps = await setup(sent);
    const session = deps.store.createSession({ bot: '周小灵', workspace: '日常', title: '换版本', model: 'magpie/test', thinking: null });
    const app = new http.HttpApp(builders.httpPartsOf(deps)).build();
    const posted = await app.inject({ method: 'POST', url: '/api/message', payload: { text: '（系统）换版本的结果：成了', session: session.id, from: '换版本' } });
    bunTest.expect(posted.statusCode).toBe(200);
    await until(() => sent.length > 0);
    bunTest.expect(deps.store.getMessage(posted.json<{ id: number }>().id)?.sessionId).toBe(session.id);
    bunTest.expect(deps.store.getMessage(posted.json<{ id: number }>().id)?.dispatch).toBeNull();
    await app.close();
  });
});


bunTest.describe('飞书渠道（假传输层）', () => {
  bunTest.test('收图文：下载图片交给机器人循环；发 @路径：文字 + 图片；审核卡片点了同意', async () => {
    const deps = await setup([]);
    /** 假传输层收到的调用。 */
    const calls: string[] = [];
    /** 收消息的回调。 */
    let onEvent: (event: feishu.ReceiveEvent) => void = () => undefined;
    /** 点卡片的回调。 */
    let onCard: ((action: feishu.CardAction) => Promise<unknown>) | undefined;
    const transport: feishu.FeishuTransport = {
      listen: (event, card) => {
        onEvent = event;
        onCard = card;
        return Promise.resolve();
      },
      sendText: (_to, text) => {
        calls.push(`文字：${text}`);
        return Promise.resolve('m1');
      },
      sendMedia: (_to, request) => {
        calls.push(`${request.type}：${path.basename(request.path ?? '')}`);
        return Promise.resolve('m2');
      },
      sendCard: () => {
        calls.push('卡片');
        return Promise.resolve('card1');
      },
      updateCard: () => {
        calls.push('更新卡片');
        return Promise.resolve();
      },
      downloadResource: (_messageId, _resource, destination) => {
        fs.writeFileSync(destination, Buffer.from([137, 80, 78, 71]));
        return Promise.resolve();
      },
      close: () => undefined,
    };
    const channel = feishu.createFeishuChannel({ app_id: 'cli_test', app_secret: 'secret_xxxxxxxx', bot: '周小灵' }, deps, transport);
    /** 交给机器人循环的。 */
    const received: botLoopModule.IncomingInput[] = [];
    const stop = await channel.start((input) => {
      received.push(input);
      return Promise.resolve();
    });
    onEvent({ sender: { sender_id: { open_id: 'ou_1' } }, message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content: JSON.stringify({ text: '看图', image_key: 'img_1' }) } });
    await until(() => received.length > 0);
    bunTest.expect(received[0]).toMatchObject({ bot: '周小灵', channel: 'feishu:cli_test', source: 'cli_test|oc_1|ou_1', text: '看图' });
    bunTest.expect(received[0]!.images).toHaveLength(1);

    const image = path.join(deps.resources.dir, 'a.png');
    fs.writeFileSync(image, 'x');
    await channel.send({ chatId: 'oc_1' }, `看这张 @${image}`);
    bunTest.expect(calls).toEqual(['文字：看这张 「a.png」', 'image：a.png']);

    const asked = deps.approvals.ask({ bot: '周小灵', sessionId: 's', command: 'del x', workDir: 'F:/w', review: { what: '删文件', risk: '删了', advice: '拒绝' } });
    bunTest.expect(await channel.sendApproval({}, deps.approvals.list()[0]!)).toBe(true);
    bunTest.expect(await onCard!({ openId: 'ou_1', messageId: 'card1', chatId: 'oc_1', value: { kind: 'approval', approval_id: asked.id, approve: true } })).toEqual({ toast: { type: 'success', content: '已同意执行' } });
    bunTest.expect((await asked.wait).approve).toBe(true);
    bunTest.expect(calls.slice(-2)).toEqual(['卡片', '更新卡片']);
    await stop();
  });

  bunTest.test('收消息挂「正在输入」：回应 ID 进回复地址；stopTyping 撤回应；地址没回应 ID 就不撤', async () => {
    const deps = await setup([]);
    /** addReaction 的调用记录（消息 ID、表情类型）。 */
    const addCalls: [string, string][] = [];
    /** removeReaction 的调用记录（消息 ID、回应 ID）。 */
    const removeCalls: [string, string][] = [];
    /** 收消息的回调。 */
    let onEvent: (event: feishu.ReceiveEvent) => void = () => undefined;
    const transport: feishu.FeishuTransport = {
      listen: (event) => {
        onEvent = event;
        return Promise.resolve();
      },
      sendText: () => Promise.resolve('m1'),
      addReaction: (messageId, emojiType) => {
        addCalls.push([messageId, emojiType]);
        return Promise.resolve('reac_1');
      },
      removeReaction: (messageId, reactionId) => {
        removeCalls.push([messageId, reactionId]);
        return Promise.resolve();
      },
      close: () => undefined,
    };
    const channel = feishu.createFeishuChannel({ app_id: 'cli_test', app_secret: 'secret_xxxxxxxx', bot: '周小灵' }, deps, transport);
    /** 交给机器人循环的。 */
    const received: botLoopModule.IncomingInput[] = [];
    const stop = await channel.start((input) => {
      received.push(input);
      return Promise.resolve();
    });
    //M 文字消息，原话非空，不会在 onMessage 的「没字又没图就返回」判断里提前退出。
    onEvent({ sender: { sender_id: { open_id: 'ou_1' } }, message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '你好' }) } });
    await until(() => received.length > 0);
    //G 挂「正在输入」：按（消息 ID, 'Typing'）调了 addReaction，回应 ID 进了回复地址。
    bunTest.expect(addCalls).toEqual([['om_1', 'Typing']]);
    bunTest.expect(received[0]!.address.typingReaction).toBe('reac_1');
    //M stopTyping：按（消息 ID, 回应 ID）撤掉回应。
    await channel.stopTyping(received[0]!.address);
    bunTest.expect(removeCalls).toEqual([['om_1', 'reac_1']]);
    //G 地址里没有 typingReaction 时不调 removeReaction（记录长度不变）。
    await channel.stopTyping({ messageId: 'om_1' });
    bunTest.expect(removeCalls).toHaveLength(1);
    await stop();
  });

  bunTest.test('addReaction 挂不上：消息照常进来，回复地址里没有 typingReaction', async () => {
    const deps = await setup([]);
    /** addReaction 的调用记录（消息 ID、表情类型）。 */
    const addCalls: [string, string][] = [];
    /** 收消息的回调。 */
    let onEvent: (event: feishu.ReceiveEvent) => void = () => undefined;
    const transport: feishu.FeishuTransport = {
      listen: (event) => {
        onEvent = event;
        return Promise.resolve();
      },
      sendText: () => Promise.resolve('m1'),
      addReaction: (messageId, emojiType) => {
        addCalls.push([messageId, emojiType]);
        return Promise.reject(new Error('挂不上'));
      },
      close: () => undefined,
    };
    const channel = feishu.createFeishuChannel({ app_id: 'cli_test', app_secret: 'secret_xxxxxxxx', bot: '周小灵' }, deps, transport);
    /** 交给机器人循环的。 */
    const received: botLoopModule.IncomingInput[] = [];
    const stop = await channel.start((input) => {
      received.push(input);
      return Promise.resolve();
    });
    onEvent({ sender: { sender_id: { open_id: 'ou_1' } }, message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '你好' }) } });
    await until(() => received.length > 0);
    //G 挂「正在输入」抛错被 onMessage 兜住：addReaction 调过，但 receive 照常被调到、地址里不带 typingReaction。
    bunTest.expect(addCalls).toEqual([['om_1', 'Typing']]);
    bunTest.expect(received).toHaveLength(1);
    bunTest.expect(received[0]!.text).toBe('你好');
    bunTest.expect('typingReaction' in received[0]!.address).toBe(false);
    await stop();
  });

  bunTest.test('post 真实结构：标题+每段文字、img 写 [图片]、递归收 image_key 资源；text/image/file/audio/media 按类型取文字和资源', () => {
    //M post 顶层没有 text 字段，走 FeishuSdk.postText 按两层数组取标题和每段。
    const post = feishu.toMessage(feishuEvent('post', JSON.stringify({
      title: '周报',
      content: [
        [{ tag: 'text', text: '正文' }, { tag: 'a', text: '链接', href: 'https://x' }, { tag: 'at', user_name: '张三' }, { tag: 'img', image_key: 'img_1' }],
        [{ tag: 'text', text: '第二段' }],
      ],
    })));
    bunTest.expect(post.text).toContain('周报');
    bunTest.expect(post.text).toContain('正文');
    bunTest.expect(post.text).toContain('链接');
    bunTest.expect(post.text).toContain('@张三');
    bunTest.expect(post.text).toContain('[图片]');
    bunTest.expect(post.text).toContain('第二段');
    bunTest.expect(post.resources).toEqual([{ key: 'img_1', type: 'image', name: 'image.png' }]);

    //M text：只取文字，没有资源。
    const text = feishu.toMessage(feishuEvent('text', JSON.stringify({ text: '你好' })));
    bunTest.expect(text.text).toBe('你好');
    bunTest.expect(text.resources ?? []).toHaveLength(0);

    //M image：文字空，收一个 image_key 资源。
    const image = feishu.toMessage(feishuEvent('image', JSON.stringify({ image_key: 'img_1' })));
    bunTest.expect(image.text).toBe('');
    bunTest.expect(image.resources).toEqual([{ key: 'img_1', type: 'image', name: 'image.png' }]);

    //M file：文件名进文字和资源。
    const file = feishu.toMessage(feishuEvent('file', JSON.stringify({ file_key: 'f', file_name: '报告.pdf' })));
    bunTest.expect(file.text).toBe('[文件] 报告.pdf');
    bunTest.expect(file.resources).toEqual([{ key: 'f', type: 'file', name: '报告.pdf' }]);

    //M audio：毫秒换秒，没文件名时用默认名 audio.opus。
    const audio = feishu.toMessage(feishuEvent('audio', JSON.stringify({ file_key: 'f', duration: 5000 })));
    bunTest.expect(audio.text).toBe('[语音 5 秒]');
    bunTest.expect(audio.resources).toEqual([{ key: 'f', type: 'file', name: 'audio.opus' }]);

    //M media：毫秒换秒，文件名进文字和资源。
    const video = feishu.toMessage(feishuEvent('media', JSON.stringify({ file_key: 'f', file_name: 'v.mp4', duration: 3000 })));
    bunTest.expect(video.text).toBe('[视频 3 秒] v.mp4');
    bunTest.expect(video.resources).toEqual([{ key: 'f', type: 'file', name: 'v.mp4' }]);
  });

  bunTest.test('sticker/location/share_chat/share_user：一句话带关键信息，sticker 即使带 image_key 也不收资源', () => {
    //M sticker 不在能下载资源的类型里，content 里放 image_key 也不会 collect。
    const sticker = feishu.toMessage(feishuEvent('sticker', JSON.stringify({ image_key: 'img_sticker' })));
    bunTest.expect(sticker.text).toBe('[表情包]');
    bunTest.expect(sticker.resources ?? []).toHaveLength(0);

    const location = feishu.toMessage(feishuEvent('location', JSON.stringify({ name: '公司', longitude: '116.4', latitude: '39.9' })));
    bunTest.expect(location.text).toBe('[位置] 公司（经度 116.4，纬度 39.9）');

    const shareChat = feishu.toMessage(feishuEvent('share_chat', JSON.stringify({ chat_id: 'oc_9' })));
    bunTest.expect(shareChat.text).toBe('[群名片] oc_9');

    const shareUser = feishu.toMessage(feishuEvent('share_user', JSON.stringify({ user_id: 'ou_9' })));
    bunTest.expect(shareUser.text).toBe('[个人名片] ou_9');
  });

  bunTest.test('interactive/todo/vote/system/未知类型 + 坏 JSON：带类型名、原始内容不丢', () => {
    /** 消息类型、期望写在方括号里的类型名、原始内容里的一个字段值。 */
    const cases: [string, string, string][] = [
      ['interactive', '卡片', '卡片字段值'],
      ['todo', '任务', '任务字段值'],
      ['vote', '投票', '投票字段值'],
      ['system', '系统消息', '系统字段值'],
      ['weird_type', 'weird_type', '未知字段值'],
    ];
    for (const [messageType, typeName, marker] of cases) {
      const message = feishu.toMessage(feishuEvent(messageType, JSON.stringify({ marker })));
      bunTest.expect(message.text).toContain(`[${typeName}]`);
      bunTest.expect(message.text).toContain(marker);
    }
    //M content 不是合法 JSON：describeContent 的 catch 原样返回，不抛错。
    const broken = feishu.toMessage(feishuEvent('text', '这不是 JSON'));
    bunTest.expect(broken.text).toBe('这不是 JSON');
    bunTest.expect(broken.resources ?? []).toHaveLength(0);
  });

  bunTest.test('合并转发：子消息带序号和文字/图片，子消息的图按子消息 ID 下载', async () => {
    const deps = await setup([]);
    const { onEvent, received, downloads, stop } = await startFakeFeishu(deps, {
      getMessageItems: () => Promise.resolve<feishu.MessageItem[]>([
        { message_id: 'om_1', msg_type: 'merge_forward', body: { content: '{}' } },
        { message_id: 'sub_1', msg_type: 'text', upper_message_id: 'om_1', create_time: '1730000000000', body: { content: JSON.stringify({ text: '第一条' }) } },
        { message_id: 'sub_2', msg_type: 'image', upper_message_id: 'om_1', body: { content: JSON.stringify({ image_key: 'img_sub' }) } },
      ]),
    });
    onEvent(feishuEvent('merge_forward', '{}'));
    await until(() => received.length > 0);
    bunTest.expect(received[0]!.text).toContain('1.');
    bunTest.expect(received[0]!.text).toContain('第一条');
    bunTest.expect(received[0]!.text).toContain('2.');
    bunTest.expect(received[0]!.text).toContain('[图片]');
    bunTest.expect(downloads).toContain('sub_2');
    bunTest.expect(received[0]!.images).toHaveLength(1);
    await stop();
  });

  bunTest.test('合并转发子消息取不到：写明原因，消息照常进来', async () => {
    const deps = await setup([]);
    const { onEvent, received, stop } = await startFakeFeishu(deps, {
      getMessageItems: () => Promise.reject(new Error('接口挂了')),
    });
    onEvent(feishuEvent('merge_forward', '{}'));
    await until(() => received.length > 0);
    bunTest.expect(received).toHaveLength(1);
    bunTest.expect(received[0]!.text).toContain('[合并转发的内容没取到：');
    bunTest.expect(received[0]!.text).toContain('接口挂了');
    await stop();
  });

  bunTest.test('引用回复：被引用的是文字，原话以 [引用] 开头且含被引用内容', async () => {
    const deps = await setup([]);
    const { onEvent, received, stop } = await startFakeFeishu(deps, {
      getMessageItems: () => Promise.resolve<feishu.MessageItem[]>([
        { message_id: 'om_parent', msg_type: 'text', body: { content: JSON.stringify({ text: '被引用内容' }) } },
      ]),
    });
    onEvent(feishuEvent('text', JSON.stringify({ text: '我的回复' }), { parent_id: 'om_parent' }));
    await until(() => received.length > 0);
    bunTest.expect(received).toHaveLength(1);
    bunTest.expect(received[0]!.text.startsWith('[引用]')).toBe(true);
    bunTest.expect(received[0]!.text).toContain('被引用内容');
    await stop();
  });

  bunTest.test('引用回复：被引用的是图片，按 om_parent 下载且带出图', async () => {
    const deps = await setup([]);
    const { onEvent, received, downloads, stop } = await startFakeFeishu(deps, {
      getMessageItems: () => Promise.resolve<feishu.MessageItem[]>([
        { message_id: 'om_parent', msg_type: 'image', body: { content: JSON.stringify({ image_key: 'img_parent' }) } },
      ]),
    });
    onEvent(feishuEvent('text', JSON.stringify({ text: '我的回复' }), { parent_id: 'om_parent' }));
    await until(() => received.length > 0);
    bunTest.expect(received).toHaveLength(1);
    bunTest.expect(downloads).toEqual(['om_parent']);
    bunTest.expect(received[0]!.images).toHaveLength(1);
    await stop();
  });

  bunTest.test('引用回复取不到：写明原因，消息照常进来', async () => {
    const deps = await setup([]);
    const { onEvent, received, stop } = await startFakeFeishu(deps, {
      getMessageItems: () => Promise.reject(new Error('取引用失败')),
    });
    onEvent(feishuEvent('text', JSON.stringify({ text: '我的回复' }), { parent_id: 'om_parent' }));
    await until(() => received.length > 0);
    bunTest.expect(received).toHaveLength(1);
    bunTest.expect(received[0]!.text).toContain('[引用的消息没取到：');
    bunTest.expect(received[0]!.text).toContain('取引用失败');
    await stop();
  });

  bunTest.test('附件下载失败：写明没下载下来的原因，消息照常进来、不带图', async () => {
    const deps = await setup([]);
    const { onEvent, received, stop } = await startFakeFeishu(deps, {
      downloadResource: () => Promise.reject(new Error('下载失败')),
    });
    onEvent(feishuEvent('image', JSON.stringify({ image_key: 'img_fail' })));
    await until(() => received.length > 0);
    bunTest.expect(received).toHaveLength(1);
    bunTest.expect(received[0]!.text).toContain('[image.png 没下载下来：下载失败]');
    bunTest.expect(received[0]!.images).toHaveLength(0);
    await stop();
  });

  bunTest.test('空内容：没字又没图时写 [空消息]，消息不丢', async () => {
    const deps = await setup([]);
    const { onEvent, received, stop } = await startFakeFeishu(deps);
    onEvent(feishuEvent('text', '{"text":""}'));
    await until(() => received.length > 0);
    bunTest.expect(received).toHaveLength(1);
    bunTest.expect(received[0]!.text).toBe('[空消息]');
    await stop();
  });

  bunTest.test('发 @路径：mp4 发视频、opus 发语音、png 发图片、pdf 发附件', async () => {
    const deps = await setup([]);
    /** 临时目录：跑测试时可以把 JMBOTS_TEST_TMP 设成自己的缓存目录；没设就用系统临时目录（Linux 上也能跑）。 */
    const root = process.env.JMBOTS_TEST_TMP ?? os.tmpdir();
    fs.mkdirSync(root, { recursive: true });
    /** 四个真实存在的文件，用完删。 */
    const dir = fs.mkdtempSync(path.join(root, 'jmbots-feishu-media-'));
    /** 四种扩展名各一个。 */
    const files = [path.join(dir, 'a.mp4'), path.join(dir, 'b.opus'), path.join(dir, 'c.png'), path.join(dir, 'd.pdf')];
    try {
      for (const file of files) {
        fs.writeFileSync(file, 'x');
      }
      /** 假传输层记下每次 sendMedia 的种类和路径。 */
      const sent: { type: string; path: string }[] = [];
      const transport: feishu.FeishuTransport = {
        listen: () => Promise.resolve(),
        sendText: () => Promise.resolve('m1'),
        sendMedia: (_to, request) => {
          sent.push({ type: request.type, path: request.path ?? '' });
          return Promise.resolve('m2');
        },
        close: () => undefined,
      };
      const channel = feishu.createFeishuChannel({ app_id: 'cli_media', app_secret: 'secret_xxxxxxxx', bot: '周小灵' }, deps, transport);
      await channel.send({ chatId: 'oc_1' }, `看这些 @${files[0]!} @${files[1]!} @${files[2]!} @${files[3]!}`);
      bunTest.expect(sent.map((item) => item.type)).toEqual(['media', 'audio', 'image', 'file']);
      bunTest.expect(sent.map((item) => item.path)).toEqual(files);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  bunTest.test('视频发不成：同一个文件紧接着按附件再发一次', async () => {
    const deps = await setup([]);
    /** 临时目录。 */
    const root = process.env.JMBOTS_TEST_TMP ?? os.tmpdir();
    fs.mkdirSync(root, { recursive: true });
    /** 临时目录（用完删）。 */
    const dir = fs.mkdtempSync(path.join(root, 'jmbots-feishu-media-'));
    /** 一个真实的 mp4 文件。 */
    const mp4 = path.join(dir, 'a.mp4');
    try {
      fs.writeFileSync(mp4, 'x');
      /** 假传输层：视频消息发不成，其余照常。 */
      const sent: { type: string; path: string }[] = [];
      const transport: feishu.FeishuTransport = {
        listen: () => Promise.resolve(),
        sendText: () => Promise.resolve('m1'),
        sendMedia: (_to, request) => {
          sent.push({ type: request.type, path: request.path ?? '' });
          return request.type === 'media' ? Promise.reject(new Error('飞书不收这个视频')) : Promise.resolve('m2');
        },
        close: () => undefined,
      };
      const channel = feishu.createFeishuChannel({ app_id: 'cli_media_fail', app_secret: 'secret_xxxxxxxx', bot: '周小灵' }, deps, transport);
      await channel.send({ chatId: 'oc_1' }, `看视频 @${mp4}`);
      bunTest.expect(sent).toEqual([{ type: 'media', path: mp4 }, { type: 'file', path: mp4 }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


bunTest.describe('BotLoop.handOff：限时第 5 条转新会话', () => {
  bunTest.test('照老会话开新会话、交接说明存成收件、挂卡片、跑起来；老会话不存在就抛错', async () => {
    /** 发出去的回复。 */
    const sent: string[] = [];
    const deps = await setup(sent);
    /** 进度登记表：先建好，机器人循环才拿得到。 */
    const progress = builders.progressOf(deps);
    deps.progress = progress;
    /** 机器人循环。 */
    const loop = builders.botLoopOf(deps);
    /** 老会话。 */
    const from = deps.store.createSession({
      bot: '周小灵',
      workspace: '日常',
      title: '老会话',
      model: 'magpie/test',
      thinking: 'off',
    });
    /** 交接参数。 */
    const args: botLoopModule.HandOffInput = {
      fromSession: from.id,
      text: '交接说明全文',
      channel: 'http',
      address: {},
    };
    /** 新会话。 */
    const session = await loop.handOff(args);
    bunTest.expect(session.bot).toBe(from.bot);
    bunTest.expect(session.workspace).toBe(from.workspace);
    bunTest.expect(session.model).toBe(from.model);
    bunTest.expect(session.thinking).toBe(from.thinking);
    bunTest.expect(session.title).toBe('老会话（接着做）');
    /** 挂在新会话上的那张卡。 */
    const card = progress.list().find((item) => item.sessionId === session.id);
    bunTest.expect(card).toBeDefined();
    /** 交接说明那条收件。 */
    const row = deps.store.getMessage(card!.messageIds.at(-1)!)!;
    bunTest.expect(row.source).toBe('handoff');
    bunTest.expect(row.text).toContain('交接说明全文');
    bunTest.expect(row.text).toContain('老会话的记录在：');
    bunTest.expect(row.sessionId).toBe(session.id);
    //M 会话真的跑了：假模型回“收到”。
    await until(() => sent.includes('收到'));
    bunTest.expect(sent).toContain('收到');
    /** 老会话不存在时记下的错。 */
    let errorText = '';
    try {
      await loop.handOff({ ...args, fromSession: '不存在的会话' });
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    }
    bunTest.expect(errorText).toContain('不存在');
    //G 取消还没到点的报时、到点定时器。
    progress.act(card!.id, 'limit');
  });
});
