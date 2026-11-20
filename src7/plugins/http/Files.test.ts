/** http 并入网页与文件接口（Static.ts、Files.ts）后的离线回归：路由、流式上传、范围读取、敏感路径与配置边界。 */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as staticModule from './Static.ts';


/** 每项清理都只作用于该测试自建上下文、Fastify与临时目录。 */
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 离线测试环境，不监听端口、不读写项目运行时数据。 */
interface World {
  /** 测试专用目录。 */
  root: string;
  /** 内存 HTTP 请求入口。 */
  app: fastify.FastifyInstance;
}


/**
 * 挂真实 registerStatic，文件接口必须自动出现，不再单挂files-api。
 * @returns 测试自己的目录与内存HTTP实例。
 * 副作用：创建临时目录与未监听的Fastify，并登记清理。
 */
async function setup(): Promise<World> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-files-'));
  const app = fastify.default();
  const ctx = new cordis.Context();
  //M 即使挂载失败也只清理本次测试自建资源，不碰运行中的服务或数据。
  closers.push(async () => {
    await ctx.fiber.dispose();
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** 只给文件接口与网页提供必须的目录和空插件表。 */
  class TestResources extends cordis.Service {
    /** 临时根目录。 */
    readonly root = root;
    /** 不加载其它插件页面。 */
    readonly config = { plugins: [] };

    /** @param sub 测试上下文；副作用：提供resources服务。 */
    constructor(sub: cordis.Context) {
      super(sub, 'resources');
    }

    /** @param parts 临时根内子路径；返回目录并创建该测试用目录。 */
    ensureRuntimeDir(...parts: string[]): string {
      const full = path.join(root, ...parts);
      fs.mkdirSync(full, { recursive: true });
      return full;
    }
  }

  /** HTTP只注入请求，不开端口。 */
  class TestHttp extends cordis.Service {
    /** 该测试自己的HTTP实例。 */
    readonly app = app;

    /** @param sub 测试上下文；副作用：提供http服务。 */
    constructor(sub: cordis.Context) {
      super(sub, 'http');
    }
  }

  //M 原文件接口只在自身作用域换解析器，不能破坏其它JSON接口。
  app.post('/api/json-probe', (request) => request.body);
  await ctx.plugin(TestResources);
  await ctx.plugin(TestHttp);
  await staticModule.registerStatic(ctx, app);
  await app.ready();
  return { root, app };
}


test('http默认挂文件接口，原路径完整读取、Range与目录过滤保持一致', async () => {
  const { root, app } = await setup();
  const workspace = path.join(root, 'bots', '测试', 'workspace');
  fs.mkdirSync(path.join(workspace, 'folder'), { recursive: true });
  const file = path.join(workspace, 'sample.txt');
  fs.writeFileSync(file, 'abcdef');
  fs.writeFileSync(path.join(workspace, '.env'), '测试密钥');
  fs.writeFileSync(path.join(workspace, 'config.yaml'), '测试配置');
  const url = '/api/files?path=' + encodeURIComponent(file);
  const full = await app.inject({ method: 'GET', url });
  expect(full.statusCode).toBe(200);
  expect(full.body).toBe('abcdef');
  expect(full.headers['accept-ranges']).toBe('bytes');

  const relative = await app.inject({ method: 'GET', url: '/files/bots/测试/workspace/sample.txt' });
  expect(relative.statusCode).toBe(200);
  expect(relative.body).toBe('abcdef');
  const part = await app.inject({ method: 'GET', url, headers: { range: 'bytes=1-3' } });
  expect(part.statusCode).toBe(206);
  expect(part.body).toBe('bcd');
  expect(part.headers['content-range']).toBe('bytes 1-3/6');
  const suffix = await app.inject({ method: 'GET', url, headers: { range: 'bytes=-2' } });
  expect(suffix.statusCode).toBe(206);
  expect(suffix.body).toBe('ef');
  const invalid = await app.inject({ method: 'GET', url, headers: { range: 'bytes=99-' } });
  expect(invalid.statusCode).toBe(416);
  expect(invalid.headers['content-range']).toBe('bytes */6');

  const listUrl = '/api/files/list?path=' + encodeURIComponent(workspace);
  const listed = await app.inject({ method: 'GET', url: listUrl });
  expect(listed.statusCode).toBe(200);
  expect(listed.json().map((item: { name: string }) => item.name)).toEqual(['folder', 'sample.txt']);
  const missingUrl = '/api/files?path=' + encodeURIComponent(path.join(workspace, 'missing.txt'));
  const missing = await app.inject({ method: 'GET', url: missingUrl });
  expect(missing.statusCode).toBe(404);
});


test('流式上传保持原样，上传解析器不污染JSON接口', async () => {
  const { root, app } = await setup();
  const uploaded = await app.inject({
    method: 'PUT',
    url: '/api/uploads/demo.txt',
    headers: { 'content-type': 'application/json' },
    payload: 'not-json',
  });
  expect(uploaded.statusCode).toBe(200);
  const data = uploaded.json();
  expect(data).toMatchObject({ name: 'demo.txt', size: 8 });
  expect(data.id).toMatch(/^\d{20}$/u);
  const target = path.join(root, 'data', 'tmp', 'uploads', `${data.id}_${data.name}`);
  expect(fs.readFileSync(target, 'utf8')).toBe('not-json');
  const json = await app.inject({ method: 'POST', url: '/api/json-probe', payload: { valid: true } });
  expect(json.statusCode).toBe(200);
  const jsonBody = json.json<{ valid: boolean }>();
  expect(jsonBody).toEqual({ valid: true });
});


test('文件接口仍拒绝敏感文件、相对path与越界路径，未知API不回网页', async () => {
  //M 读权限仍由原文件接口边界处理，不因合入静态托管而绕过。
  const { root, app } = await setup();
  const secrets = ['config.yaml', 'secrets.yaml', '.env', '.env.local'];
  for (const name of secrets) {
    const target = path.join(root, 'bots', '测试', name);
    const url = '/api/files?path=' + encodeURIComponent(target);
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(403);
  }
  const target = path.join(root, 'private', 'not-readable.txt');
  const outside = await app.inject({ method: 'GET', url: '/api/files?path=' + encodeURIComponent(target) });
  expect(outside.statusCode).toBe(403);
  const relative = await app.inject({ method: 'GET', url: '/api/files?path=relative.txt' });
  expect(relative.statusCode).toBe(400);
  const unknown = await app.inject({ method: 'GET', url: '/api/not-a-file-api' });
  expect(unknown.statusCode).toBe(404);
  expect(unknown.json()).toHaveProperty('error');
});

