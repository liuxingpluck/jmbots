/** 飞书媒体协议、附件保留、消息路由和失败处理测试；不连接真实飞书。 */
import * as test from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as media from '../src/channels/FeishuMedia.ts';
import * as feishu from '../src/channels/Feishu.ts';
import * as feishuSdk from '../src/channels/FeishuSdk.ts';
import * as events from '../src/events/Events.ts';
import * as tools from '../src/capabilities/tools/Tools.ts';

/** Bun 的 rejects 类型声明为 void；显式等待失败以保证检查完成。 */
async function expectFailure(promise: Promise<unknown>, text = ''): Promise<void> {
  let caught: unknown;
  try { await promise; } catch (error) { caught = error; }
  test.expect(caught).toBeInstanceOf(Error);
  test.expect((caught as Error).message).toContain(text);
}

test.test('429 限流时等一等重试，别的错误不重试', async () => {
  let calls = 0;
  const api = media.createOpenApi('app', 'secret', (url) => {
    if (url.includes('/auth/')) { return Promise.resolve(Response.json({ code: 0, tenant_access_token: 'tenant_test', expire: 7200 })); }
    calls++;
    if (calls === 1) { return Promise.resolve(new Response(null, { status: 429 })); }
    return Promise.resolve(Response.json({ code: 0, data: { message_id: 'om_retry' } }));
  });
  const data = await api.json('POST', '/im/v1/messages', { hi: 1 });
  test.expect(data).toEqual({ message_id: 'om_retry' });
  test.expect(calls).toBe(2);
});

test.test('令牌复用、multipart 不手写 boundary、JSON 附件不会被当作 API 错误', async () => {
  let tokens = 0;
  let denied = false;
  const api = media.createOpenApi('app', 'secret', (url, init) => {
    if (url.includes('/auth/')) {
      tokens++;
      return Promise.resolve(Response.json({ code: 0, tenant_access_token: 'tenant_test', expire: 7200 }));
    }
    test.expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tenant_test');
    if (init.body instanceof FormData) {
      test.expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    }
    if (denied) { return Promise.resolve(Response.json({ code: 99991672, msg: 'Access denied: missing scope' })); }
    if (url.includes('/resources/')) { return Promise.resolve(Response.json({ hello: 'world' })); }
    return Promise.resolve(Response.json({ code: 0, data: { image_key: 'img_test' } }));
  });
  await api.json('POST', '/im/v1/images', new FormData());
  await api.json('POST', '/im/v1/images', new FormData());
  const response = await api.download('/im/v1/messages/om/resources/key?type=file');
  test.expect(await response.json()).toEqual({ hello: 'world' });
  test.expect(tokens).toBe(1);
  denied = true;
  await expectFailure(api.json('POST', '/im/v1/images', new FormData()), 'im:resource');
});

let dir: string;
test.beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jmbots-feishu-')); });
test.afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

test.test('六种消息使用正确素材接口、类型和 JSON 内容，视频可上传封面', async () => {
  const calls: { route: string; body: unknown }[] = [];
  const api: media.OpenApi = {
    json: (_method, route, body) => {
      calls.push({ route, body });
      if (route === '/im/v1/images') { return Promise.resolve({ image_key: 'img_key' }); }
      if (route === '/im/v1/files') { return Promise.resolve({ file_key: 'file_key' }); }
      return Promise.resolve({ message_id: 'om_sent' });
    },
    download: () => Promise.reject(new Error('unexpected')),
  };
  const transport = media.createMediaTransport(api);
  for (const [type, ext] of [['image', '.png'], ['file', '.txt'], ['audio', '.opus'], ['media', '.mp4']] as const) {
    const file = path.join(dir, `test${ext}`);
    await fs.writeFile(file, 'fixture');
    calls.length = 0;
    await transport.sendMedia!({ chatId: 'oc_test' }, { type, path: file, duration: 1200 });
    test.expect(calls[0]?.route).toBe(type === 'image' ? '/im/v1/images' : '/im/v1/files');
    const form = calls[0]!.body as FormData;
    if (type === 'image') { test.expect(form.get('image_type')).toBe('message'); }
    else {
      const expected: Record<string, string> = { file: 'stream', audio: 'opus', media: 'mp4' };
      test.expect(form.get('file_type')).toBe(expected[type]!);
      test.expect(form.get('duration')).toBe('1200');
    }
    test.expect(calls[1]?.body).toEqual({ receive_id: 'oc_test', msg_type: type, content: JSON.stringify(type === 'image' ? { image_key: 'img_key' } : { file_key: 'file_key' }) });
  }
  calls.length = 0;
  await transport.sendMedia!({ openId: 'ou_test' }, { type: 'media', path: path.join(dir, 'test.mp4'), coverPath: path.join(dir, 'test.png') });
  test.expect(calls.map((call) => call.route)).toEqual(['/im/v1/files', '/im/v1/images', '/im/v1/messages?receive_id_type=open_id']);
  test.expect((calls[2]?.body as { content: string }).content).toBe('{"file_key":"file_key","image_key":"img_key"}');
  for (const type of ['post', 'interactive'] as const) {
    calls.length = 0;
    await transport.sendMedia!({ chatId: 'oc_test' }, { type, content: { title: 'test' } });
    test.expect(calls.length).toBe(1);
    test.expect((calls[0]?.body as { msg_type: string }).msg_type).toBe(type);
  }
});

test.test('空文件、超限、不支持的语音格式不会触发上传或发送', async () => {
  let count = 0;
  const transport = media.createMediaTransport({ json: () => { count++; return Promise.resolve({}); }, download: () => Promise.reject(new Error('unexpected')) });
  const file = path.join(dir, 'empty.opus');
  await fs.writeFile(file, '');
  await expectFailure(transport.sendMedia!({ chatId: 'oc_test' }, { type: 'audio', path: file }), '非空');
  await fs.writeFile(path.join(dir, 'test.mp3'), 'audio');
  await expectFailure(transport.sendMedia!({ chatId: 'oc_test' }, { type: 'audio', path: path.join(dir, 'test.mp3') }), '.opus');
  const large = path.join(dir, 'large.png');
  await fs.writeFile(large, 'x');
  const handle = await fs.open(large, 'r+');
  await handle.truncate(10 * 1024 * 1024 + 1);
  await handle.close();
  await expectFailure(transport.sendMedia!({ chatId: 'oc_test' }, { type: 'image', path: large }), '10MB');
  test.expect(count).toBe(0);
});

test.test('原始 SDK 事件保留素材，图文同时保留文字、图片和视频', () => {
  const event: feishu.ReceiveEvent = {
    sender: { sender_id: { open_id: 'ou_user' } },
    message: { message_id: 'om_in', chat_id: 'oc_test', chat_type: 'p2p', message_type: 'post', content: JSON.stringify({ zh_cn: { title: '标题', content: [[{ tag: 'text', text: '说明' }, { tag: 'img', image_key: 'img_1' }, { tag: 'media', file_key: 'file_1', image_key: 'img_1' }]] } }) },
  };
  test.expect(feishuSdk.toMessage(event).rawContent).toBe(event.message.content);
  const message = feishu.toMessage(event);
  test.expect(message.text).toContain('说明');
  test.expect(message.resources?.map((item) => item.key)).toEqual(['img_1', 'file_1']);
  event.message.message_type = 'file';
  event.message.content = JSON.stringify({ file_key: 'file_2', file_name: '../report.txt' });
  test.expect(feishu.toMessage(event).resources?.[0]?.key).toBe('file_2');
});

test.test('无文字的图片会交给 handler，同一事件只处理一次', async () => {
  let receive: ((event: feishu.ReceiveEvent) => void) | undefined;
  let handled = 0;
  let resolveHandled: (() => void) | undefined;
  const complete = new Promise<void>((resolve) => { resolveHandled = resolve; });
  const adapter = feishu.createFeishu({
    listen: (callback) => { receive = callback; return Promise.resolve(); },
    sendText: () => Promise.reject(new Error('不应发送拒绝提示')),
    close: () => undefined,
  }, () => { handled++; resolveHandled!(); return Promise.resolve(); });
  await adapter.listen();
  const event: feishu.ReceiveEvent = { sender: {}, message: { message_id: 'om_image', chat_id: 'oc_test', chat_type: 'p2p', message_type: 'image', content: '{"image_key":"img_test"}' } };
  receive!(event);
  receive!(event);
  await complete;
  test.expect(handled).toBe(1);
  adapter.close();
});

test.test('资源使用消息资源接口下载二进制；JSON 附件也可保存；不覆盖已有文件', async () => {
  let route = '';
  const transport = media.createMediaTransport({ json: () => Promise.resolve({}), download: (value) => { route = value; return Promise.resolve(new Response('payload')); } });
  const file = path.join(dir, 'in', 'file.txt');
  await transport.downloadResource!('om/a', { key: 'key/b', type: 'file', name: 'file.txt' }, file);
  test.expect(route).toBe('/im/v1/messages/om%2Fa/resources/key%2Fb?type=file');
  test.expect(await fs.readFile(file, 'utf8')).toBe('payload');
  await expectFailure(transport.downloadResource!('om/a', { key: 'key/b', type: 'file', name: 'file.txt' }, file));
});

test.test('媒体发送继承聊天路由，sent 事件保存消息类型和 ID', async () => {
  const store = events.openEventStore(':memory:');
  try {
    const session = store.createSession({ title: '媒体', kind: 'task', bot: null, agent: null, model: null, workspace: '', source: '飞书私聊 oc_test' });
    store.createEvent({ sessionId: session.id, type: 'execution', payload: { input: '发送图片' } });
    let target: feishu.FeishuTarget | undefined;
    await feishu.createMediaSender({ listen: () => Promise.resolve(), close: () => undefined, sendText: () => Promise.resolve(''), sendMedia: (to) => { target = to; return Promise.resolve('om_media'); } }, store)(session.id, { type: 'image', path: 'test.png' });
    test.expect(target).toEqual({ chatId: 'oc_test' });
    test.expect(store.listEvents(session.id, 'sent')[0]?.payload).toEqual({ channel: '飞书', messageId: 'om_media', messageType: 'image' });
    test.expect(tools.toolDefinitions(tools.CHAT_MEDIA_TOOLS).length).toBe(6);
  } finally { store.close(); }
});
