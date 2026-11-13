/**
 * 网页要的后端接口（src/channels/HttpUi.ts，docs/界面/01_界面设计.md 第 12 节）的离线测试：
 *   /api/bots 的状态字段、/api/messages 的翻页/取变化/origin 筛选/附件 url、上传后随消息发出、
 *   文件接口的范围和 Range、/files 静态地址、设置明文（只取具体字段断言）、换版本中的 apply 409、
 *   转发给本地壳子、几个纯函数（认附件、Range、改配置）。
 * 用临时运行时目录和内存数据库，不调模型、不起机器人循环。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import type * as modelModule from '../src/capabilities/Model.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as http from '../src/channels/Http.ts';
import * as httpUi from '../src/channels/HttpUi.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import * as builders from './Builders.ts';


/** 测试用的假密钥（不是任何真密钥）。 */
const FAKE_KEY = 'sk-test-fake-0000';


/**
 * 建依赖：临时运行时目录、一个机器人“小测”、内存数据库；模型一律回“收到”。
 * @param extraConfig 追加进 config.yaml 的内容。
 * @returns 依赖和运行时目录。
 */
async function setup(extraConfig = ''): Promise<{ deps: builders.TestDeps; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-ui-'));
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    `providers:\n  fake:\n    base_url: http://127.0.0.1:9/v1\n    api_key: ${FAKE_KEY}\n    compat: { maxTokensField: max_tokens }\ndefault_model: fake/test\nbots:\n  - name: 小测\n    language: zh\nhttp:\n  port: 1\n  token: tk-fake\n${extraConfig}`,
  );
  const resources = await resourcesModule.Resources.load(dir);
  const files = new filesModule.Files(resources);
  await files.ensureBot('小测');
  const ai = builders.fakeAi({
    chat: (input) => {
      const message = { role: 'assistant', content: [{ type: 'text', text: '收到' }], api: 'openai-completions', provider: 'fake', model: 'test', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } as piAi.AssistantMessage;
      return Promise.resolve({ message, text: '收到', thinking: '', toolCalls: [], ms: 1, request: { model: input.model, thinkingAsked: 'off', thinking: 'off', system: '', tools: [], messages: [] } });
    },
    decide: () => Promise.reject(new Error('没有')),
    hasDecision: () => false,
    listModels: () => [{ id: 'fake/test', name: 'test', kind: 'chat', contextWindow: 100_000, thinking: ['off'], vision: true, price: { input: 0, output: 0 } }],
  });
  const out: depsModule.Outlet = {
    send: () => Promise.resolve(),
    sendApproval: () => Promise.resolve([]),
    publishDoc: () => Promise.reject(new Error('无')),
    deleteDoc: () => Promise.reject(new Error('无')),
  };
  return { deps: { resources, files, ai, store: new storeModule.Store(':memory:'), secrets: new secretsModule.Secrets([]), approvals: new approvalsModule.Approvals(), out }, dir };
}


/**
 * 建 HTTP 服务（不监听端口，用 inject 发请求）。
 * @param deps 依赖。
 */
function appOf(deps: builders.TestDeps): ReturnType<http.HttpApp['build']> {
  return new http.HttpApp(builders.httpPartsOf(deps)).build();
}


bunTest.describe('纯函数', () => {
  bunTest.test('认附件：引号、结尾标点、Windows 路径；@某人不算', () => {
    const found = httpUi.parseAttachments('看图 @F:\\a\\1.png，还有 @"F:/a b/2_报告.pdf" 和 @/tmp/3.opus。@张三 你好 @F:\\a\\1.png');
    bunTest.expect(found).toEqual([
      { path: 'F:\\a\\1.png', name: '1.png', kind: 'image' },
      { path: 'F:/a b/2_报告.pdf', name: '2_报告.pdf', kind: 'file' },
      { path: '/tmp/3.opus', name: '3.opus', kind: 'audio' },
    ]);
    bunTest.expect(httpUi.attachmentKind('x.MP4')).toBe('video');
  });

  bunTest.test('Range：整段、开头起、最后几个字节、超出', () => {
    bunTest.expect(httpUi.parseRange(undefined, 100)).toBeUndefined();
    bunTest.expect(httpUi.parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    bunTest.expect(httpUi.parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    bunTest.expect(httpUi.parseRange('bytes=-5', 100)).toEqual({ start: 95, end: 99 });
    bunTest.expect(httpUi.parseRange('bytes=0-999', 100)).toEqual({ start: 0, end: 99 });
    bunTest.expect(httpUi.parseRange('bytes=100-', 100)).toBe('invalid');
    bunTest.expect(httpUi.parseRange('items=1-2', 100)).toBeUndefined();
  });
});


bunTest.describe('接口', () => {
  bunTest.test('/api/bots：闲着 → 有消息排队 → 有会话在跑 → 有待确认', async () => {
    const { deps } = await setup();
    const app = appOf(deps);
    const status = async (): Promise<Record<string, unknown>> => ((await app.inject({ method: 'GET', url: '/api/bots' })).json<Record<string, unknown>[]>())[0]!;
    bunTest.expect(await status()).toMatchObject({ name: '小测', status: 'idle', running: 0, queued: 0, approvals: 0 });
    await app.inject({ method: 'POST', url: '/api/message', payload: { text: '你好' } });
    bunTest.expect(await status()).toMatchObject({ status: 'waiting', queued: 1 });
    const session = deps.store.createSession({ bot: '小测', workspace: '日常', title: '测试', model: 'fake/test', thinking: null });
    deps.store.beginRun(session.id);
    bunTest.expect(await status()).toMatchObject({ status: 'working', running: 1 });
    deps.approvals.ask({ bot: '小测', sessionId: session.id, command: 'rm -rf dist', workDir: 'F:/x', review: { what: '删目录', risk: '删错', advice: '看清楚' } });
    bunTest.expect(await status()).toMatchObject({ status: 'waiting', approvals: 1 });
    await app.close();
  });

  bunTest.test('/api/messages：最新几条、往前翻、取变化、附件、直接指定会话的分派简要', async () => {
    const { deps, dir } = await setup();
    const app = appOf(deps);
    for (const text of ['一', '二', '三']) {
      await app.inject({ method: 'POST', url: '/api/message', payload: { text } });
    }
    const latest = (await app.inject({ method: 'GET', url: '/api/messages?limit=2' })).json<{ messages: httpUi.MessageView[]; hasMore: boolean; cursor: number }>();
    bunTest.expect(latest.messages.map((item) => item.text)).toEqual(['二', '三']);
    bunTest.expect(latest.hasMore).toBe(true);
    const older = (await app.inject({ method: 'GET', url: `/api/messages?limit=2&before=${latest.messages[0]!.id}` })).json<{ messages: httpUi.MessageView[]; hasMore: boolean }>();
    bunTest.expect(older.messages.map((item) => item.text)).toEqual(['一']);
    bunTest.expect(older.hasMore).toBe(false);
    //M 指定会话发一条带图的：分派简要是 direct，附件认得出、带大小。
    const session = deps.store.createSession({ bot: '小测', workspace: '日常', title: '看图', model: 'fake/test', thinking: null });
    await app.inject({ method: 'POST', url: '/api/message', payload: { text: '看这张', session: session.id, images: [{ name: 'a.png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') }] } });
    const changed = (await app.inject({ method: 'GET', url: `/api/messages?after=${latest.cursor}` })).json<{ messages: httpUi.MessageView[]; cursor: number }>();
    const last = changed.messages.at(-1)!;
    bunTest.expect(last.text.startsWith('看这张 @')).toBe(true);
    bunTest.expect(last.attachments).toHaveLength(1);
    bunTest.expect(last.attachments[0]).toMatchObject({ kind: 'image', size: 8 });
    //M 附件带静态地址：/files/ 开头，指回运行时目录里的那个文件。
    const attachment = last.attachments[0]!;
    bunTest.expect(attachment.url?.startsWith('/files/')).toBe(true);
    const fromUrl = path.resolve(dir, decodeURIComponent(attachment.url!.slice('/files/'.length)));
    bunTest.expect(fromUrl).toBe(path.resolve(attachment.path));
    bunTest.expect(path.relative(dir, fromUrl).startsWith('..')).toBe(false);
    bunTest.expect(last.dispatch).toMatchObject({ sessionId: session.id, title: '看图', by: 'direct', action: 'append' });
    bunTest.expect(changed.cursor).toBeGreaterThanOrEqual(latest.cursor);
    const bad = await app.inject({ method: 'GET', url: '/api/messages?before=abc' });
    bunTest.expect(bad.statusCode).toBe(400);
    await app.close();
  });

  bunTest.test('/api/messages?origin=：web 只要网页发的、other 只要别的渠道的、乱写 400', async () => {
    const { deps } = await setup();
    const app = appOf(deps);
    await app.inject({ method: 'POST', url: '/api/message', payload: { text: '网页来', from: 'web' } });
    await app.inject({ method: 'POST', url: '/api/message', payload: { text: '命令行来', from: 'cli' } });
    const web = (await app.inject({ method: 'GET', url: '/api/messages?origin=web' })).json<{ messages: httpUi.MessageView[] }>();
    bunTest.expect(web.messages.map((item) => item.text)).toEqual(['网页来']);
    bunTest.expect(web.messages.map((item) => item.source)).toEqual(['web']);
    const other = (await app.inject({ method: 'GET', url: '/api/messages?origin=other' })).json<{ messages: httpUi.MessageView[] }>();
    bunTest.expect(other.messages.map((item) => item.text)).toEqual(['命令行来']);
    bunTest.expect(other.messages.map((item) => item.source)).toEqual(['cli']);
    const bad = await app.inject({ method: 'GET', url: `/api/messages?origin=${encodeURIComponent('乱写')}` });
    bunTest.expect(bad.statusCode).toBe(400);
    await app.close();
  });

  bunTest.test('上传：PUT 原始字节 → 随消息发出，进消息文件夹；暂存删掉，同一个号不能再用', async () => {
    const { deps, dir } = await setup();
    const app = appOf(deps);
    const bytes = Buffer.from('音频内容');
    const uploaded = (await app.inject({ method: 'PUT', url: `/api/uploads/${encodeURIComponent('语音 1.opus')}`, payload: bytes, headers: { 'content-type': 'application/octet-stream' } })).json<{ id: string; name: string; size: number; kind: string }>();
    bunTest.expect(uploaded).toMatchObject({ name: '语音_1.opus', size: bytes.length, kind: 'audio' });
    const sent = await app.inject({ method: 'POST', url: '/api/message', payload: { text: '听听', uploads: [uploaded.id] } });
    bunTest.expect(sent.statusCode).toBe(200);
    const row = deps.store.getMessage((sent.json<{ id: number }>()).id)!;
    const saved = httpUi.parseAttachments(row.text);
    bunTest.expect(saved).toHaveLength(1);
    bunTest.expect(fs.readFileSync(saved[0]!.path, 'utf8')).toBe('音频内容');
    bunTest.expect(fs.readdirSync(path.join(dir, 'data', 'tmp', 'uploads'))).toEqual([]);
    const again = await app.inject({ method: 'POST', url: '/api/message', payload: { text: '再发', uploads: [uploaded.id] } });
    bunTest.expect(again.statusCode).toBe(400);
    await app.close();
  });

  bunTest.test('文件接口：消息文件夹里的能读、能按 Range 取；范围外、config.yaml、相对路径不给', async () => {
    const { deps, dir } = await setup();
    const app = appOf(deps);
    const file = path.join(deps.files.paths('小测').memoryDir, '笔记.md');
    fs.writeFileSync(file, '0123456789');
    const whole = await app.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(file)}` });
    bunTest.expect(whole.statusCode).toBe(200);
    bunTest.expect(whole.headers['content-type']).toContain('text/markdown');
    bunTest.expect(whole.body).toBe('0123456789');
    const part = await app.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(file)}`, headers: { range: 'bytes=2-4' } });
    bunTest.expect(part.statusCode).toBe(206);
    bunTest.expect(part.body).toBe('234');
    bunTest.expect(part.headers['content-range']).toBe('bytes 2-4/10');
    bunTest.expect((await app.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(path.join(dir, 'config.yaml'))}` })).statusCode).toBe(403);
    bunTest.expect((await app.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(os.tmpdir())}` })).statusCode).toBe(403);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/files?path=bots/a.md' })).statusCode).toBe(400);
    bunTest.expect((await app.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(path.join(path.dirname(file), '没有.md'))}` })).statusCode).toBe(404);
    const list = (await app.inject({ method: 'GET', url: `/api/files/list?path=${encodeURIComponent(deps.files.paths('小测').botDir)}` })).json<{ name: string; dir: boolean }[]>();
    const info = (await app.inject({ method: 'GET', url: `/api/ui/bots/${encodeURIComponent('小测')}` })).json<{ paths: { botDir: string }; workspaces: { name: string }[]; memoryIndex: string }>();
    bunTest.expect(info.paths.botDir).toBe(deps.files.paths('小测').botDir);
    bunTest.expect(info.workspaces.map((item) => item.name)).toContain('日常');
    bunTest.expect(info.memoryIndex).toContain('小测');
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/ui/bots/nobody' })).statusCode).toBe(404);
    bunTest.expect(list.filter((item) => item.dir).map((item) => item.name).sort()).toEqual(['memory', 'message', 'workspace']);
    await app.close();
  });

  bunTest.test('/files/<相对路径>：消息附件的地址能取、支持 Range；config.yaml 不给', async () => {
    const { deps, dir } = await setup();
    const app = appOf(deps);
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const sent = await app.inject({ method: 'POST', url: '/api/message', payload: { text: '看图', images: [{ name: '图 1.png', data: bytes.toString('base64') }] } });
    bunTest.expect(sent.statusCode).toBe(200);
    const messages = (await app.inject({ method: 'GET', url: '/api/messages' })).json<{ messages: httpUi.MessageView[] }>();
    const attachment = messages.messages.at(-1)!.attachments[0]!;
    bunTest.expect(attachment.url?.startsWith('/files/')).toBe(true);
    const fromUrl = path.resolve(dir, decodeURIComponent(attachment.url!.slice('/files/'.length)));
    bunTest.expect(fromUrl).toBe(path.resolve(attachment.path));
    const whole = await app.inject({ method: 'GET', url: attachment.url! });
    bunTest.expect(whole.statusCode).toBe(200);
    bunTest.expect(whole.headers['content-type']).toContain('image/png');
    bunTest.expect(Buffer.from(whole.rawPayload)).toEqual(bytes);
    const part = await app.inject({ method: 'GET', url: attachment.url!, headers: { range: 'bytes=2-5' } });
    bunTest.expect(part.statusCode).toBe(206);
    bunTest.expect(part.headers['content-range']).toBe(`bytes 2-5/${bytes.length}`);
    bunTest.expect(Buffer.from(part.rawPayload)).toEqual(bytes.subarray(2, 6));
    bunTest.expect((await app.inject({ method: 'GET', url: '/files/config.yaml' })).statusCode).toBe(403);
    await app.close();
  });

  bunTest.test('设置：GET /api/settings 回明文密钥（只取具体字段断言，不打印整个响应）', async () => {
    const { deps } = await setup();
    const app = appOf(deps);
    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    bunTest.expect(response.statusCode).toBe(200);
    const config = response.json<{ config: { providers: { fake: { api_key: string; compat: { maxTokensField: string } } }; bots: { name: string }[] } }>().config;
    bunTest.expect(config.providers.fake.api_key).toBe(FAKE_KEY);
    bunTest.expect(config.providers.fake.compat.maxTokensField).toBe('max_tokens');
    bunTest.expect(config.bots[0]!.name).toBe('小测');
    await app.close();
  });

  bunTest.test('/api/settings/apply：刚开始换版本（data/swap.lock 是现在）回 409', async () => {
    const { deps, dir } = await setup();
    const app = appOf(deps);
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'swap.lock'), String(Date.now()));
    const response = await app.inject({ method: 'POST', url: '/api/settings/apply' });
    bunTest.expect(response.statusCode).toBe(409);
    bunTest.expect(response.json<{ error: string }>().error).toContain('换版本');
    await app.close();
  });

  bunTest.test('转发给本地壳子：没配 index_url 回 503；配了原样转发查询和状态码；/api 下写错的接口回 404', async () => {
    const fake = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => Response.json({ got: new URL(request.url).pathname + new URL(request.url).search }, { status: 200 }) });
    try {
      const none = await setup();
      const noneApp = appOf(none.deps);
      bunTest.expect((await noneApp.inject({ method: 'GET', url: '/api/memory/search?q=x' })).statusCode).toBe(503);
      await noneApp.close();
      const { deps } = await setup(`engine:\n  index_url: http://127.0.0.1:${fake.port}/\n`);
      const app = appOf(deps);
      const searched = await app.inject({ method: 'GET', url: `/api/memory/search?q=${encodeURIComponent('记忆')}&lib=a` });
      bunTest.expect(searched.json<unknown>()).toEqual({ got: `/search?q=${encodeURIComponent('记忆')}&lib=a` });
      bunTest.expect((await app.inject({ method: 'GET', url: '/api/rag/search?q=x' })).json<unknown>()).toEqual({ got: '/rag/search?q=x' });
      bunTest.expect((await app.inject({ method: 'GET', url: '/api/没有这个' })).statusCode).toBe(404);
      await app.close();
    } finally {
      await fake.stop(true);
    }
  });
});


bunTest.describe('改配置', () => {
  bunTest.test('照顺序改：注释和没见过的键留着；****** 照原样写；能删', () => {
    const before = '# 头上的注释\nengine:\n  merge_ms: 2000   # 合批等多久\n  unknown_key: 留着\nchannels:\n  feishu:\n    - app_id: cli_a\n      app_secret: real-secret-aaaa\n      bot: 小测\nold: 1\n';
    const after = httpUi.applySettingEdits(before, [
      { path: ['engine', 'merge_ms'], value: 3000 },
      { path: ['channels', 'feishu'], value: [{ app_id: 'cli_a', app_secret: '******', bot: '小测' }, { app_id: 'cli_b', app_secret: 'new-secret-bbbb', bot: '小测' }] },
      { path: ['http', 'port'], value: 31000 },
      { path: ['old'], delete: true },
      { path: ['engine', 'poll_ms'], value: '******' },
    ]);
    bunTest.expect(after).toContain('# 头上的注释');
    bunTest.expect(after).toContain('merge_ms: 3000 # 合批等多久');
    bunTest.expect(after).toContain('unknown_key: 留着');
    //M ****** 不是特殊值：照原样写，不换回旧密钥。
    bunTest.expect(after).toContain('app_secret: "******"');
    bunTest.expect(after).not.toContain('app_secret: real-secret-aaaa');
    bunTest.expect(after).toContain('app_secret: new-secret-bbbb');
    bunTest.expect(after).toContain('port: 31000');
    bunTest.expect(after).not.toContain('old: 1');
    bunTest.expect(after).toContain('poll_ms: "******"');
    bunTest.expect(() => httpUi.applySettingEdits('a: [坏的', [])).toThrow();
    bunTest.expect(() => httpUi.applySettingEdits('a: 1', [{ path: [], value: 1 }])).toThrow();
  });

  bunTest.test('PUT /api/settings 写进 config.yaml，不留临时文件；****** 照原样写；没改的假密钥原样保留；/api/ui/info 有起来的时间', async () => {
    const { deps, dir } = await setup();
    const app = appOf(deps);
    const put = await app.inject({ method: 'PUT', url: '/api/settings', payload: [{ path: ['engine', 'max_rounds'], value: 123 }] });
    bunTest.expect(put.statusCode).toBe(200);
    const text = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
    bunTest.expect(text).toContain('max_rounds: 123');
    //M 没改的假密钥原样保留。
    bunTest.expect(text).toContain(FAKE_KEY);
    bunTest.expect(fs.existsSync(path.join(dir, 'config.yaml.tmp'))).toBe(false);
    //M 写 ******：照原样写进 config.yaml，不是特殊值。
    const maskedPut = await app.inject({ method: 'PUT', url: '/api/settings', payload: [{ path: ['providers', 'fake', 'api_key'], value: '******' }] });
    bunTest.expect(maskedPut.statusCode).toBe(200);
    const maskedText = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
    bunTest.expect(maskedText).toContain('api_key: "******"');
    bunTest.expect(maskedText).not.toContain(FAKE_KEY);
    const maskedConfig = (await app.inject({ method: 'GET', url: '/api/settings' })).json<{ config: { providers: { fake: { api_key: string } } } }>().config;
    bunTest.expect(maskedConfig.providers.fake.api_key).toBe('******');
    bunTest.expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { not: 'a list' } })).statusCode).toBe(400);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/ui/info' })).json<{ startedAt: number }>().startedAt).toBeGreaterThan(0);
    await app.close();
  });
});


bunTest.describe('重连：重新测试模型连接、重启服务', () => {
  bunTest.test('/api/models/reconnect：给了供应商只重连那家、结果原样交回；不给就每家都重连；配置里没有的回 400', async () => {
    const { deps } = await setup();
    /** 假的重连问过哪几家（undefined 是没给，要每家都重连）。 */
    const asked: (string | undefined)[] = [];
    /** 假的重连：记下问了谁，回一条“连上了”。 */
    const reconnect = (provider?: string): Promise<modelModule.ReconnectResult[]> => {
      asked.push(provider);
      return Promise.resolve([{ provider: provider ?? 'fake', ok: true, models: 3 }]);
    };
    Object.assign(deps.ai, { reconnect });
    const app = appOf(deps);
    /** 只重连 fake。 */
    const one = await app.inject({ method: 'POST', url: '/api/models/reconnect', payload: { provider: 'fake' } });
    bunTest.expect(one.statusCode).toBe(200);
    /** 交回来的结果。 */
    const body = one.json<{ results: modelModule.ReconnectResult[] }>();
    bunTest.expect(body).toEqual({ results: [{ provider: 'fake', ok: true, models: 3 }] });
    /** 不给供应商。 */
    const all = await app.inject({ method: 'POST', url: '/api/models/reconnect', payload: {} });
    bunTest.expect(all.statusCode).toBe(200);
    bunTest.expect(asked).toEqual(['fake', undefined]);
    /** 配置里没有的那家：400，不调重连。 */
    const missing = await app.inject({ method: 'POST', url: '/api/models/reconnect', payload: { provider: 'nobody' } });
    bunTest.expect(missing.statusCode).toBe(400);
    bunTest.expect(asked).toHaveLength(2);
    await app.close();
  });

  bunTest.test('/api/service/restart：源码模式不找基地，和“立即重启”一样（刚开始换版本时回 409，不起换版本脚本）', async () => {
    //M 配了基地地址也不找它：源码模式的后端不是基地拉起来的。地址指到一个不存在的端口，找了就会是 502。
    const { deps, dir } = await setup('engine:\n  index_url: http://127.0.0.1:1/\n');
    const app = appOf(deps);
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'swap.lock'), String(Date.now()));
    /** 重启服务。 */
    const response = await app.inject({ method: 'POST', url: '/api/service/restart' });
    bunTest.expect(response.statusCode).toBe(409);
    bunTest.expect(response.json<{ error: string }>().error).toContain('换版本');
    await app.close();
  });
});
