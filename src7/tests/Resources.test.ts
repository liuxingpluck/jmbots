import * as fs from 'node:fs';
import * as path from 'node:path';
import * as test from 'bun:test';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as yaml from 'yaml';
import * as resourcesModule from '../Resources.ts';
import * as checks from '../utils/Checks.ts';
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
  const reasoningEfforts: unknown[] = [];
  const app = fastify.default();
  cleanups.push(() => app.close());
  app.post('/:endpoint/chat/completions', (request, reply) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    const body = request.body as Record<string, unknown>;
    reasoningEfforts.push(body['reasoning_effort']);
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
  return { ctx, config, file, endpoint, requests, reasoningEfforts };
}

/** 用资源服务公开的快照核对热更新，保留文件监听的真实路径。 */
async function waitForReload(resources: resourcesModule.Resources, previous: resourcesModule.JmbotsConfig): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (resources.config !== previous) return;

    await Bun.sleep(10);
  }
  throw new Error('等不到新的资源配置快照');
}

test.test('手写档位映射把 max 原样发给接口，缺少配置的模型没有映射', async () => {
  const { ctx, config, file, reasoningEfforts } = await start();
  const first = {
    ...config.providers.first,
    models: { 'test-model': { thinking: ['off', 'low', 'high', 'max'] } },
  };
  const updated = { ...config, providers: { ...config.providers, first } };
  const previous = ctx.resources.config;
  const source = yaml.stringify(updated);
  filesModule.writeTextAtomic(file, source);
  await waitForReload(ctx.resources, previous);

  const resources = ctx.resources;
  const model = resources.getModel('first/test-model');
  test.expect(model.thinkingLevelMap).toMatchObject({ off: 'off', low: 'low', high: 'high', xhigh: null, max: 'max' });
  test.expect(resources.getModel('spare/unlisted').thinkingLevelMap).toBeUndefined();

  //M 走本地协议替身，校验配置在真实适配器里进入请求正文。
  const input = { messages: [] };
  const options = { reasoning: 'max' as const };
  const answer = await resources.models.completeSimple(model, input, options);
  test.expect(answer.stopReason).toBe('stop');
  test.expect(reasoningEfforts).toEqual(['max']);
});

test.test('对象配置覆盖供应商值，省略配置时保留 pi 内置模型映射', async () => {
  const { ctx, config, file } = await start();
  const qwen = {
    ...config.providers.first,
    models: {
      'qwen3.8-flash': { thinking: { off: null, high: 'deep', max: 'very-deep' } },
      'qwen3.8-max': {},
    },
  };
  const providers = { ...config.providers, 'qwen-token-plan': qwen };
  const previous = ctx.resources.config;
  const updated = { ...config, providers };
  //M 两个千问模型共用同一供应商，分别覆盖映射和沿用 pi 的内置映射。
  const source = yaml.stringify(updated);
  filesModule.writeTextAtomic(file, source);
  await waitForReload(ctx.resources, previous);

  const mapped = ctx.resources.getModel('qwen-token-plan/qwen3.8-flash');
  test.expect(mapped.thinkingLevelMap).toMatchObject({ off: null, high: 'deep', xhigh: null, max: 'very-deep' });
  const native = ctx.resources.getModel('qwen-token-plan/qwen3.8-max');
  test.expect(native.reasoning).toBe(true);
  test.expect(native.thinkingLevelMap).toMatchObject({ low: 'low', medium: 'medium', high: null, xhigh: 'xhigh' });
});

test.test('思考档列表和对象在读配置时拒绝未知档位与非字符串映射', () => {
  const invalidThinking = [['ultra'], { ultra: 'deep' }, { high: 3 }];
  for (const thinking of invalidThinking) {
    const config = {
      default_model: 'first/test-model',
      providers: {
        first: { base_url: 'http://127.0.0.1', models: { 'test-model': { thinking } } },
      },
    };
    test.expect(() => checks.checkConfig(config)).toThrow('providers.first.models.test-model.thinking');
  }
});

test.test('原子保存密钥后，下一次 pi 请求使用新密钥且保留现有供应商', async () => {
  const { ctx, config, file, requests } = await start();
  const resources = ctx.resources;
  const model = resources.getModel('first/test-model');
  const provider = resources.models.getProvider('first');
  const input = { messages: [] };
  const before = await resources.models.completeSimple(model, input);
  test.expect(before.stopReason).toBe('stop');

  const previous = resources.config;
  config.providers.first.api_key = 'fixture-new-key';
  const updated = yaml.stringify(config);
  filesModule.writeTextAtomic(file, updated);
  await waitForReload(resources, previous);
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
  const invalid = { ...config, default_model: 'missing/test-model' };
  const written = yaml.stringify(invalid);
  fs.writeFileSync(file, written);

  test.expect(await logged.promise).toContain('default_model');
  test.expect(resources.config).toBe(original);
  test.expect(resources.raw).toBe(raw);
  const stillConfigured = await resources.models.getAuth('first');
  test.expect(stillConfigured?.auth.apiKey).toBe(config.providers.first.api_key);

  const valid = { ...config, models: { thinking: 'off' } };
  const repaired = yaml.stringify(valid);
  filesModule.writeTextAtomic(file, repaired);
  await waitForReload(resources, original);
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
  const previous = resources.config;
  const updated = yaml.stringify(added);
  filesModule.writeTextAtomic(file, updated);
  await waitForReload(resources, previous);
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
