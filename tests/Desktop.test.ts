/** 窗口能力的 HTTP 边界：用替身执行器，不读取或操作真实桌面。 */
import * as bunTest from 'bun:test';
import * as fastify from 'fastify';
import * as desktop from '../src/channels/HttpDesktop.ts';

/** 由原生定位结果提供的窗口身份。 */
const target = {
  handle: '0x1234', pid: 123, threadId: 456, className: 'Fixture',
  processStartedAt: '123456789012345678', rootHandle: '0x1234',
};

/** 不创建子进程，记录真正到达执行层的请求。 */
class FixtureProcess extends desktop.DesktopProcess {
  /** 用于断言非法输入没有到达执行层。 */
  readonly calls: desktop.DesktopAction[] = [];
  /** 可模拟未安装和平台不支持。 */
  available = true;
  /** 可模拟原生窗口已关闭。 */
  failure = '';

  constructor() { super('unused'); }

  override status(): { available: boolean; reason?: string } {
    return { available: this.available, reason: '未安装' };
  }

  override run(action: desktop.DesktopAction): Promise<Record<string, unknown>> {
    this.calls.push(action);
    if (this.failure) {
      return Promise.reject(new Error(this.failure));
    }
    return Promise.resolve({ ok: true, target, delivered: true, verified: false });
  }
}

bunTest.test('非法操作、失效身份与越界滚动位置不能到达原生进程', async () => {
  const runner = new FixtureProcess();
  const app = fastify.default();
  new desktop.DesktopRoutes(runner).register(app);
  try {
    const invalid = [
      { op: 'exec', command: 'anything' },
      { op: 'capture', target: { ...target, processStartedAt: undefined } },
      { op: 'scroll', target, direction: 'down', steps: 11 },
      { op: 'scroll', target, direction: 'down', x: 1.1 },
      { op: 'capture', target: { ...target, handle: '../file' } },
    ];
    for (const payload of invalid) {
      const response = await app.inject({ method: 'POST', url: '/api/desktop/action', payload });
      bunTest.expect(response.statusCode).toBe(400);
    }
    bunTest.expect(runner.calls).toHaveLength(0);
  } finally {
    await app.close();
  }
});

bunTest.test('有效请求保留窗口身份，滚动只承诺投递', async () => {
  const runner = new FixtureProcess();
  const app = fastify.default();
  new desktop.DesktopRoutes(runner).register(app);
  try {
    const payload = { op: 'scroll', target, direction: 'down', command: 'ignored' };
    const response = await app.inject({ method: 'POST', url: '/api/desktop/action', payload });
    bunTest.expect(response.statusCode).toBe(200);
    bunTest.expect(response.json()).toMatchObject({ delivered: true, verified: false });
    bunTest.expect(runner.calls[0]).toEqual({
      op: 'scroll', target, direction: 'down', steps: 1, x: 0.5, y: 0.5,
    });
  } finally {
    await app.close();
  }
});

bunTest.test('未安装与原生失败明确返回，不伪装成成功', async () => {
  const runner = new FixtureProcess();
  const app = fastify.default();
  new desktop.DesktopRoutes(runner).register(app);
  try {
    runner.available = false;
    const missing = await app.inject({ method: 'POST', url: '/api/desktop/action', payload: { op: 'pick' } });
    bunTest.expect(missing.statusCode).toBe(503);
    bunTest.expect(runner.calls).toHaveLength(0);
    runner.available = true;
    runner.failure = '目标窗口已关闭';
    const failed = await app.inject({ method: 'POST', url: '/api/desktop/action', payload: { op: 'inspect', target } });
    bunTest.expect(failed.statusCode).toBe(502);
    bunTest.expect(failed.json<{ error: string }>()).toEqual({ error: runner.failure });
  } finally {
    await app.close();
  }
});
