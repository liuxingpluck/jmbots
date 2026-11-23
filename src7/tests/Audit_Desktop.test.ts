/**
 * desktop 插件防回归与安全边界离线单元测试：
 *   1. parse() 入口强校验：拒绝非对象/数组/非法 op，放行 pick 最小载荷；
 *   2. 非 pick 操作的 target 窗口身份校验：十六进制句柄、正整数 pid/threadId、非空 className、数字启动时间戳；
 *   3. scroll 操作的方向、步长（1~10 整数）、坐标归一化（0~1 有限数）与默认值补齐；
 *   4. HTTP 路由边界：GET /api/desktop/status、POST /api/desktop/action 的 400 校验、503 不可用拦截、16KB bodyLimit。
 * 全程隔离临时目录，不依赖真实 aobw-capability.exe，不打开任何端口，Windows/Linux 双平台确定通过。
 * 跑法：bun test ./src7/tests/Audit_Desktop.test.ts --timeout 60000
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as desktopPlugin from '../plugins/desktop/index.ts';


/** 每个用例结束后按逆序释放的清理函数队列。 */
const closers: Array<() => Promise<unknown> | void> = [];

bunTest.afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 合法的桌面窗口身份样本。 */
function makeValidTarget(): Record<string, unknown> {
  return {
    handle: '0x001a2B3c',
    pid: 4321,
    threadId: 8765,
    rootHandle: '0x001a0000',
    className: 'Chrome_WidgetWin_1',
    processStartedAt: '1700000000000',
  };
}


/** 假资源服务配置。 */
interface FakeResourcesOptions {
  /** 隔离临时根目录。 */
  root: string;
  /** 可选自定义 paths.program。 */
  programPath?: unknown;
}

/** 假资源服务，仅提供隔离临时根目录与自定义 paths.program 配置。 */
class FakeResources extends cordis.Service {
  readonly root: string;
  readonly raw: Record<string, unknown>;

  constructor(ctx: cordis.Context, options: FakeResourcesOptions) {
    super(ctx, 'resources');
    this.root = options.root;
    this.raw = {};
    if (options.programPath !== undefined) {
      this.raw = { paths: { program: options.programPath } };
    }
  }
}


/** 内存 Fastify 测试替身，不监听网络端口。 */
class FakeHttp extends cordis.Service {
  constructor(ctx: cordis.Context, readonly app: fastify.FastifyInstance) {
    super(ctx, 'http');
  }
}


/**
 * 构建挂好 desktop 插件的离线 Fastify 测试上下文。
 * @param programPath 可选 paths.program 配置项。
 */
async function setupDesktop(programPath?: unknown): Promise<{ app: fastify.FastifyInstance; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-desktop-'));
  const app = fastify.default();
  const ctx = new cordis.Context();
  closers.push(async () => {
    await ctx.fiber.dispose();
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await ctx.plugin(FakeResources, { root, programPath });
  await ctx.plugin(FakeHttp, app);
  await ctx.plugin(desktopPlugin);
  await app.ready();
  return { app, root };
}


bunTest.describe('Audit_Desktop：桌面操控插件入参校验与路由防线', () => {
  bunTest.test('1. parse() 拒绝非对象、null、数组与不支持的 op', () => {
    const badInputs: unknown[] = [null, undefined, 'pick', 42, [], { op: 'exec' }, { op: '' }, {}];
    for (const bad of badInputs) {
      bunTest.expect(() => desktopPlugin.parse(bad)).toThrow();
    }
  });

  bunTest.test('2. parse() 对 pick 操作仅保留 op，不要求且不透传多余字段', () => {
    const parsed = desktopPlugin.parse({ op: 'pick', extra: 'ignored', target: 'bad' });
    bunTest.expect(parsed).toEqual({ op: 'pick' });
  });

  bunTest.test('3. parse() 允许 inspect 与 capture 携带完整合法窗口身份（支持无 0x 前缀十六进制）', () => {
    const target = { ...makeValidTarget(), handle: 'deadbeef', rootHandle: '1234abcd' };
    const inspected = desktopPlugin.parse({ op: 'inspect', target });
    const captured = desktopPlugin.parse({ op: 'capture', target });

    bunTest.expect(inspected).toEqual({ op: 'inspect', target });
    bunTest.expect(captured).toEqual({ op: 'capture', target });
  });

  bunTest.test('4. parse() 拦截缺失或非法 target（句柄注入、非正整数 pid/threadId、空类名、非法时间戳）', () => {
    const valid = makeValidTarget();
    const badTargets: unknown[] = [
      undefined,
      null,
      [],
      { ...valid, handle: '0x1234; calc.exe' },
      { ...valid, handle: '0x1234567890abcdef1' },
      { ...valid, handle: '' },
      { ...valid, rootHandle: 'not-hex' },
      { ...valid, pid: 0 },
      { ...valid, pid: -1 },
      { ...valid, pid: 1.5 },
      { ...valid, threadId: '8765' },
      { ...valid, className: '' },
      { ...valid, processStartedAt: '1700abc' },
      { ...valid, processStartedAt: 1700000 },
    ];

    for (const target of badTargets) {
      bunTest.expect(() => desktopPlugin.parse({ op: 'capture', target })).toThrow();
    }
  });

  bunTest.test('5. parse() 对 scroll 自动补齐默认 steps=1 与中心点 (0.5, 0.5)，并接受合法边界值', () => {
    const target = makeValidTarget();
    const defaulted = desktopPlugin.parse({ op: 'scroll', target, direction: 'down' });
    bunTest.expect(defaulted).toEqual({ op: 'scroll', target, direction: 'down', steps: 1, x: 0.5, y: 0.5 });

    const edge = desktopPlugin.parse({ op: 'scroll', target, direction: 'up', steps: 10, x: 0, y: 1 });
    bunTest.expect(edge).toEqual({ op: 'scroll', target, direction: 'up', steps: 10, x: 0, y: 1 });
  });

  bunTest.test('6. parse() 拦截 scroll 非法方向、越界步长与越界/非有限坐标', () => {
    const target = makeValidTarget();
    const badScrolls: Record<string, unknown>[] = [
      { op: 'scroll', target, direction: 'left' },
      { op: 'scroll', target, direction: 'down', steps: 0 },
      { op: 'scroll', target, direction: 'down', steps: 11 },
      { op: 'scroll', target, direction: 'down', steps: 2.5 },
      { op: 'scroll', target, direction: 'down', steps: '3' },
      { op: 'scroll', target, direction: 'up', x: -0.01, y: 0.5 },
      { op: 'scroll', target, direction: 'up', x: 1.01, y: 0.5 },
      { op: 'scroll', target, direction: 'up', x: 0.5, y: Number.NaN },
      { op: 'scroll', target, direction: 'up', x: Number.POSITIVE_INFINITY, y: 0.5 },
    ];

    for (const body of badScrolls) {
      bunTest.expect(() => desktopPlugin.parse(body)).toThrow();
    }
  });

  bunTest.test('7. GET /api/desktop/status 在非 Windows 或未安装可执行程序时返回 available=false 及原因', async () => {
    const { app } = await setupDesktop();
    const res = await app.inject({ method: 'GET', url: '/api/desktop/status' });
    bunTest.expect(res.statusCode).toBe(200);

    const data = res.json<{ available: boolean; reason?: string }>();
    bunTest.expect(data.available).toBe(false);
    bunTest.expect(typeof data.reason).toBe('string');
    bunTest.expect((data.reason ?? '').length).toBeGreaterThan(0);
  });

  bunTest.test('8. POST /api/desktop/action 优先执行参数校验，非法请求始终返回 400（不落入 503）', async () => {
    const { app } = await setupDesktop();
    const res = await app.inject({
      method: 'POST',
      url: '/api/desktop/action',
      payload: { op: 'scroll', target: makeValidTarget(), direction: 'diagonal' },
    });

    bunTest.expect(res.statusCode).toBe(400);
    bunTest.expect(res.json<{ error: string }>().error).toContain('up 或 down');
  });

  bunTest.test('9. POST /api/desktop/action 合法载荷在不可用环境返回 503，绝不盲目拉起子进程', async () => {
    const { app } = await setupDesktop('custom-empty-program');
    const res = await app.inject({
      method: 'POST',
      url: '/api/desktop/action',
      payload: { op: 'pick' },
    });

    bunTest.expect(res.statusCode).toBe(503);
    bunTest.expect(res.json<{ error: string }>().error.length).toBeGreaterThan(0);
  });

  bunTest.test('10. POST /api/desktop/action 强制 16KB bodyLimit，超限畸形载荷返回 413 防止内存滥用', async () => {
    const { app } = await setupDesktop();
    const hugeClassName = 'A'.repeat(20 * 1024);
    const res = await app.inject({
      method: 'POST',
      url: '/api/desktop/action',
      payload: { op: 'inspect', target: { ...makeValidTarget(), className: hugeClassName } },
    });

    bunTest.expect(res.statusCode).toBe(413);
  });
});
