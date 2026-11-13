/** 桌面能力页的离线边界：延迟帧、失败停预览和目标身份不能污染下一次操作。 */
import * as bunTest from 'bun:test';
import * as desktop from '../web/src/Desktop/Session.ts';

/** 等待异步结果写回；回调只检查本文件创建的界面快照。 */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) { return; }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('桌面页异步结果未按预期返回');
}

/** 假后端只接管本用例的 fetch；关闭时恢复全局并停止所有预览定时器。 */
class DesktopFixture {
  readonly session = new desktop.DesktopSession();
  target = {
    handle: '0x123', pid: 7, className: 'TestWindow', title: '测试窗口',
    rootHandle: '0x123', processStartedAt: '123456789',
    rect: { x: 10, y: 20, width: 800, height: 600 },
    extraIdentity: '能力端未来增加的身份字段也必须原样保留',
  };

  /** 可人为推迟一帧，使旧请求在新目标选定后才完成。 */
  delayedFrame: Promise<Response> | null = null;
  /** 下一次捕获是否返回窗口失效。 */
  failCapture = false;
  /** 实际发送给后端的滚动参数。 */
  scrollBody: Record<string, unknown> | null = null;
  /** 原有全局请求函数，不能影响其他测试文件。 */
  private readonly originalFetch = globalThis.fetch;

  constructor() {
    globalThis.fetch = this.fetch as typeof globalThis.fetch;
  }

  /** 构造一帧，不运行桌面能力程序。 */
  frame(): desktop.Frame {
    return {
      ok: true, target: this.target,
      image: `data:image/png;base64,${this.target.handle}`,
      width: 800, height: 600, capturedAt: '2026-11-08T12:00:00Z',
    };
  }

  /** 初始化并等待首帧，供已选定窗口的用例使用。 */
  async select(): Promise<void> {
    await this.session.initialize();
    await this.session.pick();
    await waitFor(() => this.session.snapshot().frame !== null);
  }

  /** 必须在每个用例 finally 调用。 */
  close(): void {
    this.session.dispose();
    globalThis.fetch = this.originalFetch;
  }

  /** 假接口保留真实 JSON 编解码与响应状态，错误经 Api.getJson 解释。 */
  private readonly fetch = async (
    input: string | URL | Request,
    options?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith('/status')) {
      return Response.json({ available: true });
    }
    if (typeof options?.body !== 'string') {
      throw new Error('测试只接受 JSON 字符串正文');
    }
    const body = JSON.parse(options.body) as Record<string, unknown>;
    if (body.op === 'pick') {
      return Response.json({ ok: true, target: this.target, root: this.target, children: [] });
    }
    if (body.op === 'scroll') {
      this.scrollBody = body;
      return Response.json({ ok: true, delivered: true, verified: false });
    }
    if (body.op === 'capture') {
      if (this.delayedFrame) {
        const delayed = this.delayedFrame;
        this.delayedFrame = null;
        return delayed;
      }
      if (this.failCapture) {
        return Response.json({ error: '窗口已失效' }, { status: 409 });
      }
      return Response.json(this.frame());
    }
    throw new Error('测试遇到意外桌面操作');
  };
}

bunTest.test('旧窗口迟到的截图不能覆盖后来选定的新窗口', async () => {
  const fixture = new DesktopFixture();
  const delayed: { resolve?: (response: Response) => void } = {};
  fixture.delayedFrame = new Promise((resolve) => { delayed.resolve = resolve; });
  const oldFrame = fixture.frame();
  try {
    await fixture.session.initialize();
    await fixture.session.pick();
    await waitFor(() => fixture.delayedFrame === null);
    fixture.target = { ...fixture.target, handle: '0x456', rootHandle: '0x456' };
    await fixture.session.pick();
    await waitFor(() => fixture.session.snapshot().frame !== null);
    delayed.resolve!(Response.json(oldFrame));
    await new Promise((resolve) => setTimeout(resolve, 5));
    bunTest.expect(fixture.session.snapshot().target?.handle).toBe('0x456');
    bunTest.expect(fixture.session.snapshot().frame?.target.handle).toBe('0x456');
    bunTest.expect(fixture.session.snapshot().frame?.image).not.toBe(oldFrame.image);
  } finally {
    fixture.close();
  }
});

bunTest.test('目标捕获失败后停止预览并清除旧帧，不能继续展示为实时画面', async () => {
  const fixture = new DesktopFixture();
  try {
    await fixture.select();
    fixture.failCapture = true;
    fixture.session.preview(false);
    fixture.session.preview(true);
    await waitFor(() => fixture.session.snapshot().error !== '');
    bunTest.expect(fixture.session.snapshot().error).toBe('窗口已失效');
    bunTest.expect(fixture.session.snapshot().frame).toBeNull();
    bunTest.expect(fixture.session.snapshot().preview).toBe(false);
  } finally {
    fixture.close();
  }
});

bunTest.test('滚动保留完整窗口身份并使用反向框选区域的中心，不把投递说成已验证', async () => {
  const fixture = new DesktopFixture();
  try {
    await fixture.select();
    fixture.session.locate({ x: 0.8, y: 0.9 }, { x: 0.2, y: 0.3 });
    await fixture.session.scroll('down', 3);
    bunTest.expect(fixture.scrollBody?.target).toEqual(fixture.target);
    bunTest.expect(fixture.scrollBody?.x).toBeCloseTo(0.5);
    bunTest.expect(fixture.scrollBody?.y).toBeCloseTo(0.6);
    bunTest.expect(fixture.scrollBody?.direction).toBe('down');
    bunTest.expect(fixture.scrollBody?.steps).toBe(3);
    bunTest.expect(fixture.session.snapshot().notice).toContain('观察画面确认');
  } finally {
    fixture.close();
  }
});

bunTest.test('缩放图片上的点击用客户区比例表示，拖出图像边界仍落在图像内部', () => {
  const rect = { left: 100, top: 200, width: 400, height: 200 } as DOMRect;
  bunTest.expect(desktop.Geometry.point(300, 250, rect)).toEqual({ x: 0.5, y: 0.25 });
  bunTest.expect(desktop.Geometry.point(0, 500, rect)).toEqual({ x: 0, y: 1 });
});
