/**
 * 微信后台控制插件：复用 WxLocate 抓取窗口与布局，独立 Python worker 复用 PP-OCRv6。
 * 固定动作由代码执行；只有明确获准的云定位请求才调用决策模型。正文只在 worker 内核对。
 * 依赖：ctx.paths、ctx.watch、ctx.wxlocate；不订阅消息，不自动发送。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cordis from 'cordis';
import type * as wxLocate from './WxLocate.ts';

declare module 'cordis' {
  interface Context {
    /** 显式调用的微信定位、核对和后台动作服务。 */
    wxcontrol: WxControl;
  }
}

/** 由账号/会话接口核实过的目标，只允许监听名单里的会话。 */
export interface WxTarget {
  /** 账号标识。 */
  account: string;
  /** 会话 username。 */
  chat: string;
  /** 完整显示名。 */
  name: string;
}

/** 一个明确的后台操作；只有 send 会按发送回车。 */
export interface WxOperation {
  /** 操作名称。 */
  operation: 'locate' | 'open' | 'verify' | 'paste-probe' | 'send';
  /** 定位方式，默认 paddle；cloud 另需图像外发授权。 */
  backend?: 'paddle' | 'cloud';
  /** 用户已经针对具体云端目的地批准本次打码图外发。 */
  cloudAllowed?: boolean;
  /** 需要搜索时允许后台输入。 */
  allowSearch?: boolean;
  /** 显式验证搜索路线。 */
  forceSearch?: boolean;
  /** 本次测试文字。 */
  text?: string;
  /** 经过 paste-probe 验证的粘贴方式。 */
  pasteMethod?: string;
}

/** 后台控制插件的实例设置。 */
export interface WxControlConfig {
  /** 当前 AOBW 实际地址。 */
  aobwUrl: string;
}

/** 只在显式 run 时启动 worker，退出时回收；同一实例串行处理。 */
export class WxControl extends cordis.Service {
  static inject = ['paths', 'watch', 'wxlocate'];

  /** 固定住依赖，避免 Cordis 方法调用方上下文变化。 */
  private readonly paths: cordis.Context['paths'];
  private readonly watch: cordis.Context['watch'];
  private readonly locator: cordis.Context['wxlocate'];
  private readonly aobwUrl: string;
  /** worker 和 stdout 流只属于本实例。 */
  private child: Bun.Subprocess<'pipe', 'pipe', 'ignore'> | undefined;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private tail: Promise<unknown> = Promise.resolve();

  /** 保存依赖并登记退出清理；构造不启动进程或操作微信。 */
  constructor(ctx: cordis.Context, config: WxControlConfig) {
    super(ctx, 'wxcontrol');
    this.paths = ctx.paths;
    this.watch = ctx.watch;
    this.locator = ctx.wxlocate;
    this.aobwUrl = config.aobwUrl;
    ctx.effect(() => () => {
      this.child?.kill();
      this.child = undefined;
    }, 'wxcontrol.worker');
  }

  /**
   * 在唯一监听目标上执行一步操作，返回不含原始 OCR 或聊天的结果。
   * @throws 非监听目标、worker 失败或核对不通过时抛中文前缀和固定错误码。
   */
  run(target: WxTarget, operation: WxOperation): Promise<Record<string, unknown>> {
    const task = this.tail.then(async () => {
      if (!this.watch.get(target.account).includes(target.chat)) {
        throw new Error('目标会话不在监听名单，已拒绝操作');
      }
      const frame = await this.locator.capture();
      return this.exchange({
        ...operation,
        frame,
        target,
        aobwUrl: this.aobwUrl,
        lockFile: path.resolve(this.paths.root, '../../../../cache/jmk/wx-bind.lock'),
      });
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  /** 懒启动独立 OCR 运行时；现有模型和临时环境全部位于项目内。 */
  private ensureWorker(): void {
    if (this.child !== undefined) {
      return;
    }
    const temp = this.paths.managed('var/tmp');
    fs.mkdirSync(temp, { recursive: true });
    this.child = Bun.spawn([
      this.paths.managed('third_party/runtimes/ocr/python/python.exe'), '-B', '-m', 'wxcontrol.worker',
    ], {
      cwd: this.paths.root,
      env: {
        ...process.env,
        PYTHONPATH: this.paths.managed('python'),
        PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1',
        TEMP: temp, TMP: temp,
      },
      stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', windowsHide: true,
    });
    this.reader = this.child.stdout.getReader();
  }

  /** 写入一条请求，等待对应结果；超时后停止 worker，不重放有副作用请求。 */
  private async exchange(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.ensureWorker();
    this.child!.stdin.write(JSON.stringify(request) + '\n');
    await this.child!.stdin.flush();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const line = await Promise.race([
        this.readLine(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.child?.kill();
            reject(new Error('微信后台任务超时；不自动重试')); 
          }, 180_000);
        }),
      ]);
      const reply = JSON.parse(line) as { ok: boolean; result?: Record<string, unknown>; error?: string };
      if (!reply.ok || reply.result === undefined) {
        throw new Error('微信后台操作未通过：' + (reply.error ?? 'worker_error'));
      }
      return reply.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 按行消费同一 worker 的协议流；不向日志写原始协议数据。 */
  private async readLine(): Promise<string> {
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        return line;
      }
      const next = await this.reader!.read();
      if (next.done) {
        throw new Error('微信后台 worker 已退出');
      }
      this.buffer += this.decoder.decode(next.value, { stream: true });
    }
  }
}
