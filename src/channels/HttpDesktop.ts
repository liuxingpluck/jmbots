/** 窗口操控接口：通过管道调用独立 AOBW 能力，不启动其业务窗口或常驻服务。 */
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as fastify from 'fastify';

/** 原生能力的一次请求；target 中的身份字段原样保留。 */
export interface DesktopAction {
  /** 仅开放定位、观察、预览和滚动。 */
  op: 'pick' | 'inspect' | 'capture' | 'scroll';
  /** 选中窗口的原生身份。 */
  target?: Record<string, unknown>;
  /** 滚动方向。 */
  direction?: 'up' | 'down';
  /** 滚轮刻度，1～10。 */
  steps?: number;
  /** 客户区归一化横坐标。 */
  x?: number;
  /** 客户区归一化纵坐标。 */
  y?: number;
}

/** 校验浏览器输入；不允许把任意命令或路径传给系统。 */
export function parseDesktopAction(input: unknown): DesktopAction {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('窗口操作必须是对象');
  }
  const body = input as Record<string, unknown>;
  const op = body.op;
  if (op !== 'pick' && op !== 'inspect' && op !== 'capture' && op !== 'scroll') {
    throw new Error('不支持这个窗口操作');
  }
  if (op === 'pick') {
    return { op };
  }
  if (!body.target || typeof body.target !== 'object' || Array.isArray(body.target)) {
    throw new Error('请先定位目标窗口');
  }
  const target = body.target as Record<string, unknown>;
  if (typeof target.handle !== 'string' || !/^(?:0x)?[0-9a-f]{1,16}$/i.test(target.handle)
    || !Number.isSafeInteger(target.pid) || Number(target.pid) <= 0
    || !Number.isSafeInteger(target.threadId) || Number(target.threadId) <= 0
    || typeof target.rootHandle !== 'string' || !/^(?:0x)?[0-9a-f]{1,16}$/i.test(target.rootHandle)
    || typeof target.className !== 'string' || !target.className
    || typeof target.processStartedAt !== 'string' || !/^\d+$/.test(target.processStartedAt)) {
    throw new Error('窗口身份不完整，请重新定位');
  }
  if (op !== 'scroll') {
    return { op, target };
  }
  if (body.direction !== 'up' && body.direction !== 'down') {
    throw new Error('滚动方向必须是 up 或 down');
  }
  const steps = body.steps ?? 1;
  const x = body.x ?? 0.5;
  const y = body.y ?? 0.5;
  if (typeof steps !== 'number' || !Number.isInteger(steps) || steps < 1 || steps > 10) {
    throw new Error('滚动刻度必须是 1～10 的整数');
  }
  if (typeof x !== 'number' || typeof y !== 'number'
    || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new Error('滚动位置必须在预览范围内');
  }
  return { op, target, direction: body.direction, steps, x, y };
}

/** 一次请求一个隐藏进程；超时只终止本次子进程，不影响用户程序。 */
export class DesktopProcess {
  /** 能力程序的确定路径，不从 HTTP 请求接受路径。 */
  constructor(private readonly executable: string) {}

  /** 只检查安装状态，不启动程序或访问桌面。 */
  status(): { available: boolean; reason?: string } {
    if (process.platform !== 'win32') {
      return { available: false, reason: '窗口操控目前只支持 Windows' };
    }
    if (!fs.existsSync(this.executable)) {
      return { available: false, reason: '尚未安装 AOBW 窗口能力程序' };
    }
    return { available: true };
  }

  /** 请求写入 stdin，接收单个 JSON 结果；截图只在内存与响应中传递。 */
  run(action: DesktopAction, signal: AbortSignal): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const options = {
        windowsHide: true,
        timeout: action.op === 'pick' ? 35_000 : 8_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8' as const,
        signal,
      };
      const child = childProcess.execFile(this.executable, [], options, (error, stdout) => {
        try {
          const result: unknown = JSON.parse(stdout.trim());
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            throw new Error('窗口能力返回格式不正确');
          }
          const response = result as Record<string, unknown>;
          if (response.ok !== true) {
            throw new Error(typeof response.error === 'string' ? response.error : '窗口操作失败');
          }
          if (error) {
            throw new Error('窗口能力进程未正常结束');
          }
          resolve(response);
        } catch (failure) {
          if (signal.aborted) {
            reject(new Error('窗口操作已取消'));
          } else if (error && !stdout.trim()) {
            reject(new Error('窗口能力超时或无法启动，请重新定位后重试'));
          } else {
            reject(failure instanceof Error ? failure : new Error(String(failure)));
          }
        }
      });
      //G 子进程提前退出可能关闭管道；execFile 回调统一报告结果。
      child.stdin?.on('error', () => {});
      child.stdin?.end(`${JSON.stringify(action)}\n`);
    });
  }
}

/** 复用现有 HTTP 认证和 program 根目录，仅增加两个能力接口。 */
export class DesktopRoutes {
  /** 定位器同时只能有一个，避免多页争抢同一个鼠标。 */
  private picking = false;

  /** 输入为固定执行器，便于离线协议验证而不操作用户桌面。 */
  constructor(private readonly runner: DesktopProcess) {}

  /** 根据配置的 program 根目录找到独立能力程序。 */
  static fromProgram(program: string): DesktopRoutes {
    const executable = path.join(program, 'AOBW', 'aobw-capability.exe');
    return new DesktopRoutes(new DesktopProcess(executable));
  }

  /** 注册时不创建进程；由用户按下定位或操作按钮时触发。 */
  register(app: fastify.FastifyInstance): void {
    app.get('/api/desktop/status', () => this.runner.status());
    app.post('/api/desktop/action', { bodyLimit: 16 * 1024 }, async (request, reply) => {
      let action: DesktopAction;
      try {
        action = parseDesktopAction(request.body);
      } catch (error) {
        return reply.code(400).send({ error: String((error as Error).message) });
      }
      const status = this.runner.status();
      if (!status.available) {
        return reply.code(503).send({ error: status.reason });
      }
      if (this.picking) {
        return reply.code(409).send({ error: '正在定位，请先松开鼠标或按 Esc' });
      }
      if (action.op === 'pick') {
        this.picking = true;
      }
      const controller = new AbortController();
      const disconnect = (): void => { controller.abort(); };
      reply.raw.once('close', disconnect);
      try {
        return await this.runner.run(action, controller.signal);
      } catch (error) {
        return reply.code(502).send({ error: (error as Error).message });
      } finally {
        reply.raw.off('close', disconnect);
        if (action.op === 'pick') {
          this.picking = false;
        }
      }
    });
  }
}
