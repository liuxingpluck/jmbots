/**
 * 提供本机窗口拾取、查看、截图与滚动接口。
 * GET /api/desktop/status 查可用性；POST /api/desktop/action 起隐藏 aobw-capability.exe 做 pick/inspect/capture/scroll，
 * 输入输出走 JSON，校验一次且不透传任意命令路径；同时只许一个 pick，网页断开结束本次子进程。
 * 设计见同目录 说明.md 的「设计要点」一节。
 */
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as textModule from '../../utils/Text.ts';


/** 插件名。 */
export const name = 'desktop';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
export const version = '1.0.1';

/** 用到的服务：resources 找 program 目录；http 登记接口。 */
export const inject = ['resources', 'http'];


/** 一次窗口操作。 */
export interface DesktopAction {
  op: 'pick' | 'inspect' | 'capture' | 'scroll';
  /** pick 以外必填；网页把上一次回的 target 原样带回来。 */
  target?: Record<string, unknown>;
  direction?: 'up' | 'down';
  steps?: number;
  x?: number;
  y?: number;
}

/** 能不能用。 */
interface Status { available: boolean; reason?: string }


/** 窗口句柄：1–16 位十六进制，可带 0x。 */
const HANDLE = /^(?:0x)?[0-9a-f]{1,16}$/iu;


/**
 * 校验网页给的操作。
 * @param input 请求体里的原始操作对象。
 * @returns 校验并补齐默认参数后的 DesktopAction。
 * @throws 不对就抛，处理函数回 400。
 */
export function parse(input: unknown): DesktopAction {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('窗口操作必须是对象');
  const body = input as Record<string, unknown>;
  const op = body['op'];
  if (op !== 'pick' && op !== 'inspect' && op !== 'capture' && op !== 'scroll') throw new Error('不支持这个窗口操作');
  if (op === 'pick') return { op };
  const target = body['target'];
  if (typeof target !== 'object' || target === null || Array.isArray(target)) throw new Error('请先定位目标窗口');
  const t = target as Record<string, unknown>;
  //G 校验非 pick 操作携带的 target 窗口身份字段（句柄、进程与线程号、根窗口句柄、类名与启动时间），防止残缺或非法目标。
  const positive = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) > 0;
  if (typeof t['handle'] !== 'string' || !HANDLE.test(t['handle']) || !positive(t['pid']) || !positive(t['threadId'])
    || typeof t['rootHandle'] !== 'string' || !HANDLE.test(t['rootHandle'])
    || typeof t['className'] !== 'string' || t['className'] === ''
    || typeof t['processStartedAt'] !== 'string' || !/^\d+$/u.test(t['processStartedAt'])) {
    throw new Error('窗口身份不完整，请重新定位');
  }
  if (op !== 'scroll') return { op, target: t };
  const direction = body['direction'];
  if (direction !== 'up' && direction !== 'down') throw new Error('滚动方向必须是 up 或 down');
  const steps = body['steps'] ?? 1;
  const x = body['x'] ?? 0.5;
  const y = body['y'] ?? 0.5;
  if (typeof steps !== 'number' || !Number.isInteger(steps) || steps < 1 || steps > 10) {
    throw new Error('滚动刻度必须是 1～10 的整数');
  }
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)
    || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new Error('滚动位置必须在预览范围内');
  }
  return { op, target: t, direction, steps, x, y };
}

/** 只看系统和程序在不在。 */
function status(exe: string): Status {
  if (process.platform !== 'win32') return { available: false, reason: '窗口操控目前只支持 Windows' };
  if (!fs.existsSync(exe)) return { available: false, reason: '尚未安装 AOBW 窗口能力程序' };
  return { available: true };
}

/** 起程序、写输入、读一个 JSON。 */
function run(exe: string, action: DesktopAction, signal: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let timeout = 8_000;
    if (action.op === 'pick') {
      timeout = 35_000;
    }
    const options = { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' as const, signal };
    const child = childProcess.execFile(exe, [], options, (error, stdout) => {
      try {
        const result: unknown = JSON.parse(stdout.trim());
        if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('窗口能力返回格式不正确');
        const response = result as Record<string, unknown>;
        if (response['ok'] !== true) {
          let message = '窗口操作失败';
          if (typeof response['error'] === 'string') {
            message = response['error'];
          }
          throw new Error(message);
        }
        if (error !== null) throw new Error('窗口能力进程未正常结束');
        resolve(response);
      } catch (failure) {
        if (signal.aborted) {
          reject(new Error('窗口操作已取消'));
          return;
        }
        if (error !== null && stdout.trim() === '') {
          reject(new Error('窗口能力超时或无法启动，请重新定位后重试'));
          return;
        }
        if (failure instanceof Error) {
          reject(failure);
          return;
        }
        reject(new Error(String(failure)));
      }
    });
    //G 子进程提前退出可能关掉管道；结果统一在回调里报。
    child.stdin?.on('error', () => {});
    child.stdin?.end(`${JSON.stringify(action)}\n`);
  });
}


/**
 * 登记两条接口。
 * apply 是 Cordis 插件的入口：inject 里的服务都就绪后调一次。程序在 <paths.program，默认 program>/AOBW/aobw-capability.exe。
 * @param ctx Cordis 给这个插件的 ctx。
 * 副作用：在 ctx.http.app 上登记 GET /api/desktop/status 与 POST /api/desktop/action 接口。
 */
export function apply(ctx: cordis.Context): void {
  const program = (ctx.resources.raw['paths'] as Record<string, unknown> | undefined)?.['program'];
  let programDir = 'program';
  if (typeof program === 'string' && program !== '') {
    programDir = program;
  }
  const root = path.resolve(ctx.resources.root, programDir);
  const exe = path.join(root, 'AOBW', 'aobw-capability.exe');
  /** 同时只许一个定位（抢同一个鼠标）。 */
  let picking = false;

  //M ctx.http.app 是 http 插件的 Fastify 实例；令牌照 http 的规矩（本机不查）。
  const app = ctx.http.app;
  app.get('/api/desktop/status', async () => status(exe));
  app.post('/api/desktop/action', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    let action: DesktopAction;
    try {
      action = parse(request.body);
    } catch (error) {
      return reply.code(400).send({ error: textModule.getErrorMessage(error) });
    }
    //G 先确认当前为 Windows 且 aobw-capability.exe 存在，并且没有进行中的定位操作，否则回 503 或 409。
    const now = status(exe);
    if (!now.available) return reply.code(503).send({ error: now.reason });
    if (picking) return reply.code(409).send({ error: '正在定位，请先松开鼠标或按 Esc' });
    if (action.op === 'pick') picking = true;
    //G 网页断开就取消这一次的子进程。
    const controller = new AbortController();
    const disconnect = (): void => controller.abort();
    reply.raw.once('close', disconnect);
    try {
      return await run(exe, action, controller.signal);
    } catch (error) {
      return reply.code(502).send({ error: textModule.getErrorMessage(error) });
    } finally {
      reply.raw.off('close', disconnect);
      if (action.op === 'pick') picking = false;
    }
  });
}
