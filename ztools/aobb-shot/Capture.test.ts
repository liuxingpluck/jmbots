/** AOBB 多开舱截图执行层与 CLI 入口纯单测（mock fetch，无需真实浏览器）。 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as test from 'bun:test';
import * as cli from './Aobb_Shot.ts';
import * as capture from './Capture.ts';
import * as options from './Options.ts';

/** 最小合法 PNG 字节样本（1x1 透明像素头字节）。 */
const SAMPLE_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** 记录每次 mock fetch 调用的请求摘要。 */
interface RecordedCall {
  /** HTTP 方法。 */
  method: string;
  /** 请求完整 URL。 */
  url: string;
  /** JSON 请求体（GET 请求为 undefined）。 */
  body?: Record<string, unknown>;
}

/** 构造返回 JSON 的模拟 Response 对象。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 从 fetch 首参提取规范 URL 字符串。 */
function getRequestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;

  return input.url;
}

/** 从 JSON 记录中安全读取字符串字段。 */
function getStringField(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  if (typeof value === 'string') return value;

  return '';
}

/** 断言异步调用抛出包含指定子串的异常。 */
async function expectReject(task: Promise<unknown>, snippet: string): Promise<void> {
  let caught: unknown;
  try {
    await task;
  } catch (error: unknown) {
    caught = error;
  }
  test.expect(caught).toBeInstanceOf(Error);
  let message = '';
  if (caught instanceof Error) {
    message = caught.message;
  }
  test.expect(message).toContain(snippet);
}

/** 创建带真实路径的临时工程根并在测试结束后清理。 */
async function withTempProject(run: (projectRoot: string) => Promise<void>): Promise<void> {
  const rawDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aobb-shot-test-'));
  const dir = await fs.realpath(rawDir);
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 无延时 sleep，避免单测等待真实定时器。 */
const noSleep = async (): Promise<void> => {
  await Promise.resolve();
};

test.test('DockClient 正确拼装接口 URL 并在连接失败或非 JSON 时输出清晰中文报错', async () => {
  const failingFetch = ((): Promise<Response> => {
    return Promise.reject(new Error('ECONNREFUSED'));
  }) as unknown as typeof fetch;
  const client = new capture.DockClient('http://127.0.0.1:30198', failingFetch, 5000);
  test.expect(client.buildUrl('/api/v1/ai/instances')).toBe('http://127.0.0.1:30198/api/v1/ai/instances');
  await expectReject(client.listInstances(), '无法连接 AOBB 多开舱（http://127.0.0.1:30198）');

  const htmlFetch = ((): Promise<Response> => {
    return Promise.resolve(new Response('<html>502</html>', { status: 502 }));
  }) as unknown as typeof fetch;
  const badClient = new capture.DockClient('http://127.0.0.1:30198', htmlFetch, 5000);
  await expectReject(badClient.listInstances(), '非 JSON 响应（HTTP 502');
});

test.test('selectRunningInstance 按运行状态与 --profile 精准解析，不擅自拉起未运行配置', () => {
  const instances: capture.AiInstanceView[] = [
    { id: 'ins-1', name: 'INS 美妆 1 号', running: false, cdpPort: 19301 },
    { id: 'changyong155', name: '常用 155', running: true, cdpPort: 19280 },
    { id: 'dev-146', name: '开发调试 146', running: true, cdpPort: 19302 },
  ];

  //M 省略 --profile 时自动跳过未运行的外部账号，选用第一个已运行配置。
  const auto = capture.selectRunningInstance(instances, undefined, 'http://127.0.0.1:30098');
  test.expect(auto.id).toBe('changyong155');

  //M 支持按精确 id、完整名称及唯一子串解析已运行配置。
  test.expect(capture.selectRunningInstance(instances, 'dev-146', 'http://127.0.0.1:30098').id).toBe('dev-146');
  test.expect(capture.selectRunningInstance(instances, '常用 155', 'http://127.0.0.1:30098').id).toBe('changyong155');
  test.expect(capture.selectRunningInstance(instances, '开发调试', 'http://127.0.0.1:30098').id).toBe('dev-146');

  //G 指定未运行配置、所有配置均未运行、找不到配置、模糊匹配均须明确报错。
  test.expect(() => capture.selectRunningInstance(instances, 'ins-1', 'http://127.0.0.1:30098'))
    .toThrow('当前未运行');
  test.expect(() => capture.selectRunningInstance(
    [{ id: 'ins-1', name: 'INS 美妆 1 号', running: false }],
    undefined,
    'http://127.0.0.1:30098',
  )).toThrow('当前没有运行中的浏览器配置');
  test.expect(() => capture.selectRunningInstance(instances, '不存在', 'http://127.0.0.1:30098'))
    .toThrow('找不到匹配');
  test.expect(() => capture.selectRunningInstance(
    [
      { id: 'p1', name: '测试 A', running: true },
      { id: 'p2', name: '测试 B', running: true },
    ],
    '测试',
    'http://127.0.0.1:30098',
  )).toThrow('匹配到多个浏览器配置');
});

test.test('takeShot 通过多开舱单标签完成导航、动作、耗时、遮罩、落盘与同名可见文字保存', async () => {
  await withTempProject(async (projectRoot) => {
    const calls: RecordedCall[] = [];
    const mockFetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = getRequestUrl(input);
      const method = init?.method ?? 'GET';
      let body: Record<string, unknown> | undefined;
      if (typeof init?.body === 'string') {
        body = JSON.parse(init.body) as Record<string, unknown>;
      }
      calls.push({ method, url, body });

      if (url.endsWith('/api/v1/ai/instances')) {
        return Promise.resolve(jsonResponse({
          ok: true,
          dockPort: 30098,
          instances: [
            { id: 'stopped-ext', name: '外部账号', running: false },
            { id: 'local dev', name: '常用 155', running: true },
          ],
        }));
      }
      if (url.endsWith('/navigate')) {
        return Promise.resolve(jsonResponse({
          ok: true,
          pageId: 'tab-ai-1',
          url: 'http://127.0.0.1:30086/decision-map/',
          title: '决策图',
          reused: true,
        }));
      }
      if (url.endsWith('/act')) {
        const action = getStringField(body, 'action');
        const expr = getStringField(body, 'expression');
        if (action === 'eval' && expr.includes('requestAnimationFrame')) {
          return Promise.resolve(jsonResponse({ ok: true, pageId: 'tab-ai-1', action: 'eval', value: 16.44 }));
        }
        if (action === 'eval' && expr.includes('scrollHeight')) {
          return Promise.resolve(jsonResponse({ ok: true, pageId: 'tab-ai-1', action: 'eval', value: 1200 }));
        }
        if (action === 'eval' && expr.includes('performance.getEntriesByType')) {
          return Promise.resolve(jsonResponse({
            ok: true,
            pageId: 'tab-ai-1',
            action: 'eval',
            value: {
              url: 'http://127.0.0.1:30086/decision-map/',
              title: '决策图 - 已加载',
              status: 200,
              text: '页面可见文字内容',
            },
          }));
        }
        return Promise.resolve(jsonResponse({ ok: true, pageId: 'tab-ai-1', action, detail: 'ok', value: true }));
      }
      if (url.endsWith('/screenshot')) {
        return Promise.resolve(jsonResponse({
          ok: true,
          pageId: 'tab-ai-1',
          mimeType: 'image/png',
          base64: SAMPLE_PNG.toString('base64'),
        }));
      }
      return Promise.resolve(jsonResponse({ ok: false, error: `unexpected ${url}` }, 404));
    }) as unknown as typeof fetch;

    const args = [
      '--base-url', 'http://127.0.0.1:30198',
      '--url', 'http://127.0.0.1:30086/decision-map/',
      '--out', 'docs/开发进度/决策图.png',
      '--width', '390',
      '--click', '.decision-pending',
      '--type-enter', '[data-testid=search]', '关键词',
      '--scroll', 'page', 'bottom',
      '--wait-ms', '0',
      '--timing',
      '--text',
    ];
    const shot = options.getShotOptions(args, projectRoot, {});
    const result = await capture.takeShot(shot, { fetchFn: mockFetch, sleepFn: noSleep });

    test.expect(result.profileId).toBe('local dev');
    test.expect(result.pageId).toBe('tab-ai-1');
    test.expect(result.title).toBe('决策图 - 已加载');
    test.expect(result.status).toBe(200);
    test.expect(result.timings).toEqual([
      { action: 'click', ms: 16.4 },
      { action: 'type', ms: 16.4 },
      { action: 'scroll', ms: 16.4 },
    ]);

    //M 核对 PNG 与同名 .txt 均准确落盘。
    const savedPng = await fs.readFile(result.out);
    test.expect(savedPng.equals(SAMPLE_PNG)).toBe(true);
    test.expect(result.text).toBe(result.out.slice(0, -4) + '.txt');
    const savedText = await fs.readFile(result.text ?? '', 'utf8');
    test.expect(savedText).toBe('页面可见文字内容');

    //M 核对 profileId URL 编码、单标签复用及不触发 /ai/ensure。
    test.expect(calls.some((call) => call.url.includes('/ai/ensure'))).toBe(false);
    const navCall = calls.find((call) => call.url.endsWith('/navigate'));
    test.expect(navCall?.url).toBe('http://127.0.0.1:30198/api/v1/ai/instances/local%20dev/navigate');
    test.expect(navCall?.body).toEqual({ url: 'http://127.0.0.1:30086/decision-map/', reuseOwnTab: true });

    //M 核对收尾移除了临时宽度与遮罩样式节点。
    const lastExpr = getStringField(calls.at(-1)?.body, 'expression');
    test.expect(lastExpr).toContain('__aobb_shot_mask__');
    test.expect(lastExpr).toContain('__aobb_shot_width__');

    //G 再次写入同一文件名时应独占报错，绝不静默覆盖。
    await expectReject(capture.takeShot(shot, { fetchFn: mockFetch, sleepFn: noSleep }), '截图文件已存在');
  });
});

test.test('页面重定向到外部域名或服务端报错时，runCli 返回明确 JSON 错误与退出码 1', async () => {
  await withTempProject(async (projectRoot) => {
    const redirectFetch = ((input: string | URL | Request): Promise<Response> => {
      const url = getRequestUrl(input);
      if (url.endsWith('/api/v1/ai/instances')) {
        return Promise.resolve(jsonResponse({
          ok: true,
          instances: [{ id: 'p1', name: '常用', running: true }],
        }));
      }
      if (url.endsWith('/navigate')) {
        return Promise.resolve(jsonResponse({
          ok: true,
          pageId: 'tab-1',
          url: 'https://evil.example.com/phish',
          title: '外站',
        }));
      }
      return Promise.resolve(jsonResponse({ ok: false, error: 'unexpected' }, 500));
    }) as unknown as typeof fetch;

    const outcome = await cli.runCli(
      ['--url', 'http://127.0.0.1:30086/', '--out', 'docs/开发进度/重定向.png'],
      projectRoot,
      {},
      { fetchFn: redirectFetch, sleepFn: noSleep },
    );
    test.expect(outcome.exitCode).toBe(1);
    test.expect(outcome.reply['ok']).toBe(false);
    test.expect(getStringField(outcome.reply, 'error')).toContain('http://127.0.0.1');

    //G 多开舱业务错误消息应透传到 CLI JSON 的 error 字段。
    const errorFetch = ((): Promise<Response> => {
      return Promise.resolve(jsonResponse({ ok: false, error: '配置未运行' }, 409));
    }) as unknown as typeof fetch;
    const dockErr = await cli.runCli(
      ['--url', 'http://127.0.0.1:30086/', '--out', 'docs/开发进度/报错.png'],
      projectRoot,
      { AOBB_DOCK_URL: 'http://127.0.0.1:30098' },
      { fetchFn: errorFetch, sleepFn: noSleep },
    );
    test.expect(dockErr.exitCode).toBe(1);
    test.expect(dockErr.reply['ok']).toBe(false);
    test.expect(getStringField(dockErr.reply, 'error')).toContain('配置未运行');
  });
});
