import * as fs from 'node:fs';
import * as path from 'node:path';
import * as test from 'bun:test';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as yaml from 'yaml';
import * as resourcesModule from '../Resources.ts';
import * as filesModule from '../utils/Files.ts';

const cleanups: (() => void | Promise<unknown>)[] = [];

test.afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** 在项目内的独立临时目录启动资源服务，创建一个无付费调用的协议替身。 */
async function start() {
  const prefix = path.join(import.meta.dir, '.resources-test-');
  const root = fs.mkdtempSync(prefix);
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests: { url: string; authorization: string | undefined }[] = [];
  const app = fastify.default();
  cleanups.push(() => app.close());
  app.post('/:endpoint/chat/completions', (request, reply) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    const chunk = JSON.stringify({
      id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });
    const stream = `data: ${chunk}\n\ndata: [DONE]\n\n`;
    return reply.type('text/event-stream').send(stream);
  });
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const config = {
    default_model: 'first/test-model',
    providers: {
      first: { base_url: `${endpoint}/first`, api_key: 'fixture-old-key' },
      spare: { base_url: `${endpoint}/spare`, api_key: '' },
    },
    plugins: [],
  };
  const file = path.join(root, 'config.yaml');
  const source = yaml.stringify(config);
  fs.writeFileSync(file, source);
  const ctx = new cordis.Context();
  cleanups.push(() => ctx.fiber.dispose());
  const args = { dir: root };
  await ctx.plugin(resourcesModule.Resources, args);
  return { ctx, config, file, endpoint, requests };
}

/** 在原子保存之前登记通知，等新快照实际生效。 */
function nextChange(ctx: cordis.Context): Promise<string[]> {
  return new Promise((resolve) => {
    ctx.once('config/changed', resolve);
  });
}

test.test('原子保存密钥后，下一次 pi 请求使用新密钥且保留现有供应商', async () => {
  const { ctx, config, file, requests } = await start();
  const resources = ctx.resources;
  const model = resources.getModel('first/test-model');
  const provider = resources.models.getProvider('first');
  const input = { messages: [] };
  const before = await resources.models.completeSimple(model, input);
  test.expect(before.stopReason).toBe('stop');

  const changed = nextChange(ctx);
  config.providers.first.api_key = 'fixture-new-key';
  const updated = yaml.stringify(config);
  filesModule.writeTextAtomic(file, updated);
  test.expect(await changed).toEqual(['providers']);
  test.expect(resources.models.getProvider('first')).toBe(provider);

  const after = await resources.models.completeSimple(model, input);
  test.expect(after.stopReason).toBe('stop');
  test.expect(requests.map((request) => request.authorization)).toEqual([
    'Bearer fixture-old-key', 'Bearer fixture-new-key',
  ]);
});

test.test('非法配置打印原因且保留旧快照，之后仍能应用修正的配置', async () => {
  const { ctx, config, file } = await start();
  const resources = ctx.resources;
  const original = resources.config;
  const raw = resources.raw;
  const logged = Promise.withResolvers<string>();
  const fail = test.spyOn(console, 'error').mockImplementation((message: unknown) => {
    if (typeof message !== 'string' || !message.startsWith('config.yaml 重读失败')) return;
    logged.resolve(message);
  });
  cleanups.push(() => fail.mockRestore());
  const changes: string[][] = [];
  ctx.on('config/changed', (keys) => { changes.push(keys); });
  const invalid = { ...config, default_model: 'missing/test-model' };
  const written = yaml.stringify(invalid);
  fs.writeFileSync(file, written);

  test.expect(await logged.promise).toContain('default_model');
  test.expect(resources.config).toBe(original);
  test.expect(resources.raw).toBe(raw);
  test.expect(changes).toEqual([]);
  const stillConfigured = await resources.models.getAuth('first');
  test.expect(stillConfigured?.auth.apiKey).toBe(config.providers.first.api_key);

  const changed = nextChange(ctx);
  const valid = { ...config, models: { thinking: 'off' } };
  const repaired = yaml.stringify(valid);
  filesModule.writeTextAtomic(file, repaired);
  test.expect(await changed).toEqual(['models']);
  test.expect(resources.config.thinking).toBe('off');
});

test.test('供应商新增、删除及换地址后，pi 使用最新登记和凭据', async () => {
  const { ctx, config, file, endpoint, requests } = await start();
  const resources = ctx.resources;
  const cached = resources.getModel('first/test-model');
  const before = resources.models.getProvider('first');
  const added = {
    ...config,
    providers: {
      first: { base_url: `${endpoint}/relocated`, api_key: 'fixture-relocated-key' },
      next: { base_url: `${endpoint}/next`, api_key: 'fixture-added-key' },
    },
  };
  const changed = nextChange(ctx);
  const updated = yaml.stringify(added);
  filesModule.writeTextAtomic(file, updated);
  test.expect(await changed).toEqual(['providers']);
  test.expect(resources.models.getProvider('first')).not.toBe(before);
  test.expect(resources.models.getProvider('spare')).toBeUndefined();
  const first = resources.models.getProvider('first');
  test.expect(first?.baseUrl).toBe(added.providers.first.base_url);

  const input = { messages: [] };
  const moved = await resources.models.completeSimple(cached, input);
  test.expect(moved.stopReason).toBe('stop');
  const next = resources.getModel('next/test-model');
  const addedAnswer = await resources.models.completeSimple(next, input);
  test.expect(addedAnswer.stopReason).toBe('stop');
  test.expect(requests).toEqual([
    { url: '/relocated/chat/completions', authorization: 'Bearer fixture-relocated-key' },
    { url: '/next/chat/completions', authorization: 'Bearer fixture-added-key' },
  ]);
});
