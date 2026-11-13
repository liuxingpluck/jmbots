/**
 * image_generate 工具（src/capabilities/tools/Tools.ts）的离线测试（docs/界面/任务书/发0.2.8_DSH.md 第 1 步）：
 * 用本机假生图服务核对请求体、请求头、图存进工作目录、@路径和文件内容；b64_json、url 两种回法；
 * 非 200、空 data、没配 engine.image_model、供应商找不到都要报清楚。
 * 全部用临时运行时和假配置，不读真实配置、不联网。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as toolsModule from '../src/capabilities/tools/Tools.ts';
import * as builders from './Builders.ts';
import * as resourcesModule from '../src/resources/Resources.ts';


/** 测试用的机器人名。 */
const BOT = '小测';

/** 一张很小的 PNG（1x1，透明）；服务回 b64_json 和落盘都拿它核对。 */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n2kAAAAASUVORK5CYII=';

/** PNG 的真实字节。 */
const PNG = Buffer.from(PNG_BASE64, 'base64');


/** 假生图服务的回法。 */
type ResponseMode = 'b64' | 'url' | 'error' | 'empty';


/** 假生图服务。 */
interface FakeImageServer {
  /** Bun 服务。 */
  server: ReturnType<typeof Bun.serve>;
  /** 服务地址（不带 /v1）。 */
  baseUrl: string;
  /** 收到的生图请求。 */
  requests: { authorization: string | null; body: string }[];
  /** 改这次回什么。 */
  setMode: (mode: ResponseMode) => void;
}


/**
 * 起一个假生图服务：/v1/images/generations 按 mode 回 b64、url、500 或空 data；/image.png 回那张 PNG。
 */
function startFakeImageServer(): FakeImageServer {
  /** 这次怎么回。 */
  let mode: ResponseMode = 'b64';
  /** 收到的请求。 */
  const requests: { authorization: string | null; body: string }[] = [];
  /** 服务。 */
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      /** 地址。 */
      const url = new URL(request.url);
      if (url.pathname === '/image.png') {
        return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      }
      if (url.pathname !== '/v1/images/generations') {
        return new Response('not found', { status: 404 });
      }
      requests.push({ authorization: request.headers.get('authorization'), body: await request.text() });
      if (mode === 'error') {
        return new Response('服务坏了 BOOM', { status: 500 });
      }
      if (mode === 'empty') {
        return Response.json({ data: [] });
      }
      if (mode === 'url') {
        return Response.json({ data: [{ url: `${url.origin}/image.png` }] });
      }
      return Response.json({ data: [{ b64_json: PNG_BASE64 }] });
    },
  });
  return { server, baseUrl: `http://127.0.0.1:${server.port}`, requests, setMode: (next) => { mode = next; } };
}


/** 一套测试用的临时运行时和依赖。 */
interface Harness {
  /** 临时运行时目录。 */
  dir: string;
  /** 工作目录。 */
  workDir: string;
  /** 资源。 */
  resources: resourcesModule.Resources;
  /** 依赖。 */
  deps: builders.TestDeps;
}


/**
 * 建一套依赖：临时运行时里写最小 config.yaml，真的资源、文件库、内存数据库，假的模型和渠道。
 * @param baseUrl 假生图服务地址。
 * @param imageModel engine.image_model；不写或 null 就不配。
 */
async function setup(baseUrl: string, imageModel: string | null = 'fakeimg/codex/gpt-image-2'): Promise<Harness> {
  /** 临时运行时目录。 */
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jmbots-image-'));
  /** 工作目录。 */
  const workDir = path.join(dir, 'workspace');
  /** config.yaml 的行。 */
  const lines = [
    'providers:',
    '  fakeimg:',
    `    base_url: ${JSON.stringify(`${baseUrl}/v1`)}`,
    '    api_key: fake-image-key',
    'default_model: fakeimg/text',
    'bots:',
    `  - name: ${BOT}`,
    '    language: zh',
    'engine:',
    '  merge_ms: 0',
  ];
  if (imageModel !== null) {
    lines.push(`  image_model: ${JSON.stringify(imageModel)}`);
  }
  await fs.writeFile(path.join(dir, 'config.yaml'), `${lines.join('\n')}\n`);
  /** 资源。 */
  const resources = await resourcesModule.Resources.load(dir);
  /** 文件库。 */
  const files = new filesModule.Files(resources);
  await files.ensureBot(BOT);
  /** 假模型：image_generate 用不到，被调到就说明测试写错了。 */
  const ai = builders.fakeAi({
    chat: () => Promise.reject(new Error('生图测试不该调模型')),
    decide: () => Promise.reject(new Error('生图测试不该调模型')),
    hasDecision: () => false,
    listModels: () => [],
  });
  /** 假渠道：image_generate 用不到。 */
  const out: depsModule.Outlet = {
    send: () => Promise.resolve(),
    sendApproval: () => Promise.resolve([]),
    publishDoc: () => Promise.reject(new Error('无')),
    deleteDoc: () => Promise.reject(new Error('无')),
  };
  /** 依赖。 */
  const deps: builders.TestDeps = { resources, files, ai, store: new storeModule.Store(':memory:'), secrets: new secretsModule.Secrets([]), approvals: new approvalsModule.Approvals(), out };
  return { dir, workDir, resources, deps };
}


/**
 * 执行一次 image_generate。
 * @param harness 测试环境。
 * @param args 工具参数。
 */
function generate(harness: Harness, args: Record<string, unknown>): Promise<toolsModule.ToolResult> {
  /** 工具执行环境。 */
  const context: toolsModule.ToolContext = { bot: BOT, workDir: harness.workDir, readOnly: false, vision: false };
  return builders.toolBoxOf(harness.deps).run('image_generate', args, context);
}


/**
 * 从结果里的 @路径 取出文件路径。
 * @param text 工具结果文字。
 */
function fileFromText(text: string): string {
  /** @ 的位置。 */
  const start = text.indexOf('@');
  /** 后括号的位置。 */
  const end = text.indexOf('（', start);
  return text.slice(start + 1, end);
}


bunTest.describe('image_generate', () => {
  /** 假生图服务。 */
  let fake: FakeImageServer;

  bunTest.beforeAll(() => {
    fake = startFakeImageServer();
  });

  bunTest.afterAll(async () => {
    await fake.server.stop(true);
  });

  bunTest.test('默认参数：model、size、background、n 和 authorization 都对；b64_json 存进工作目录，文件内容就是那张 PNG', async () => {
    /** 测试环境。 */
    const harness = await setup(fake.baseUrl);
    fake.setMode('b64');
    fake.requests.length = 0;
    /** 工具结果。 */
    const result = await generate(harness, { prompt: '画一只蓝色的鲸鱼' });
    //M 请求体。
    bunTest.expect(fake.requests.length).toBe(1);
    /** 请求体。 */
    const body = JSON.parse(fake.requests[0]!.body) as { model?: string; prompt?: string; n?: number; size?: string; background?: string; output_format?: string };
    bunTest.expect(body.model).toBe('codex/gpt-image-2');
    bunTest.expect(body.prompt).toBe('画一只蓝色的鲸鱼');
    bunTest.expect(body.n).toBe(1);
    bunTest.expect(body.size).toBe('1024x1024');
    bunTest.expect(body.background).toBe('auto');
    bunTest.expect(body.output_format).toBe('png');
    bunTest.expect(fake.requests[0]!.authorization).toBe('Bearer fake-image-key');
    //M 返回 @路径，文件在工作目录里，内容一模一样。
    bunTest.expect(result.isError).toBe(false);
    bunTest.expect(result.text).toContain('已生成：@');
    /** 文件路径。 */
    const file = fileFromText(result.text);
    bunTest.expect(path.dirname(file)).toBe(harness.workDir);
    bunTest.expect(file.endsWith('.png')).toBe(true);
    bunTest.expect((await fs.readFile(file)).equals(PNG)).toBe(true);
  });

  bunTest.test('接口回 url 不回 b64_json：会去下载，存下来的还是那张 PNG', async () => {
    /** 测试环境。 */
    const harness = await setup(fake.baseUrl);
    fake.setMode('url');
    /** 工具结果。 */
    const result = await generate(harness, { prompt: '画一只红色的鲸鱼' });
    bunTest.expect(result.isError).toBe(false);
    /** 文件路径。 */
    const file = fileFromText(result.text);
    bunTest.expect((await fs.readFile(file)).equals(PNG)).toBe(true);
  });

  bunTest.test('接口回非 200：报错里有状态码', async () => {
    /** 测试环境。 */
    const harness = await setup(fake.baseUrl);
    fake.setMode('error');
    /** 工具结果。 */
    const result = await generate(harness, { prompt: '画一只鲸鱼' });
    bunTest.expect(result.isError).toBe(true);
    bunTest.expect(result.text).toContain('HTTP 500');
    bunTest.expect(result.text).toContain('BOOM');
  });

  bunTest.test('data 是空的：报错说没有图', async () => {
    /** 测试环境。 */
    const harness = await setup(fake.baseUrl);
    fake.setMode('empty');
    /** 工具结果。 */
    const result = await generate(harness, { prompt: '画一只鲸鱼' });
    bunTest.expect(result.isError).toBe(true);
    bunTest.expect(result.text).toContain('没有图');
  });

  bunTest.test('没配 engine.image_model：报错说要配什么', async () => {
    /** 测试环境。 */
    const harness = await setup(fake.baseUrl, null);
    /** 工具结果。 */
    const result = await generate(harness, { prompt: '画一只鲸鱼' });
    bunTest.expect(result.isError).toBe(true);
    bunTest.expect(result.text).toContain('engine.image_model');
    bunTest.expect(result.text).toContain('生不了图');
  });

  bunTest.test('供应商找不到：报错说供应商和 providers', async () => {
    /** 测试环境。 */
    const harness = await setup(fake.baseUrl, 'missing/codex/gpt-image-2');
    /** 工具结果。 */
    const result = await generate(harness, { prompt: '画一只鲸鱼' });
    bunTest.expect(result.isError).toBe(true);
    bunTest.expect(result.text).toContain('missing');
    bunTest.expect(result.text).toContain('providers');
  });
});
