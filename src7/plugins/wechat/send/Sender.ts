/**
 * 发微信：截一帧（Window.frame），交给积木客服的后台 worker（python -m wxcontrol.worker，常驻，一行 JSON 一个请求）。
 * worker 做的事（jimukefu python/wxcontrol/controller.py:418-640）：OCR 找会话（看不到就后台点搜索框搜）→ 核对标题和最近消息 →
 * 剪贴板后台粘贴 → 核对输入框文字 → 留一次性门禁文件后只按一次 Enter → 从数据库回读确认真的发出去了。失败不重发。
 * 一次只做一件：请求排队。
 */
import * as path from 'node:path';
import type { Window } from './Window.ts';


/** 发给谁。 */
export interface Target {
  /** 账号 id（account_xxx）。 */
  account: string;
  /** 会话 username（wxid_xxx、xxx@chatroom）。 */
  chat: string;
  /** 会话显示名：worker 拿它去列表、标题里找字。 */
  name: string;
  /** 自己的微信昵称：worker 存证据目录用。 */
  nickname: string;
}


/** 一次后台操作最长多久，毫秒（和 jimukefu WxControl.ts 一样三分钟）。 */
const TIMEOUT_MS = 180_000;


/** worker 的调用方。 */
export class Sender {
  /** 常驻的 worker；没起或者坏了是 undefined。 */
  private child: Bun.Subprocess<'pipe', 'pipe', 'ignore'> | undefined;

  /** 读 worker 输出用。 */
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  /** 没凑成一行的输出。 */
  private buffer = '';

  /** 排队：上一件做完才做下一件。 */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * @param root 引擎目录（里面有 python/wxcontrol、runtime/）。
   * @param python 带 OCR 依赖的 python.exe。
   * @param window 截帧用。
   */
  constructor(private readonly root: string, private readonly python: string, private readonly window: Window) {}

  /**
   * 发一句文字。
   * @param requestId 同一个号 worker 只发一次（门禁文件 runtime/data/send-once/）。
   * @returns worker 的结果：confirmed 是不是回读确认了，steps 走过哪几步。
   * @throws 截帧、核对、粘贴没过时抛错（这时没按 Enter）。
   */
  send(target: Target, text: string, requestId: string): Promise<Record<string, unknown>> {
    const task = this.tail.then(async () => {
      const frame = await this.window.frame();
      return this.exchange({ operation: 'send', text, requestId, target, frame, aobwUrl: this.window.url, lockFile: this.window.lockFile });
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  /** 插件拔掉时关 worker。 */
  close(): void {
    this.child?.kill();
    this.child = undefined;
  }

  /** 写一行请求，等一行回答；超时、worker 退出就丢掉这个 worker（下次重起），本次不重放。 */
  private async exchange(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.child === undefined) this.start();

    let timer: ReturnType<typeof setTimeout> | undefined;
    let line: string;
    try {
      void this.child!.stdin.write(`${JSON.stringify(request)}\n`);
      await this.child!.stdin.flush();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('微信后台操作超时；不自动重发')), TIMEOUT_MS);
      });
      line = await Promise.race([this.readLine(), timeout]);
    } catch (error) {
      this.close();
      this.buffer = '';
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const reply = JSON.parse(line) as { ok: boolean; result?: Record<string, unknown>; error?: string };
    if (!reply.ok || reply.result === undefined) throw new Error(`微信后台操作没过：${reply.error ?? 'worker_error'}`);

    return reply.result;
  }

  /** 起 worker（环境照 jimukefu WxControl.ts ensureWorker）。 */
  private start(): void {
    const tmp = path.join(this.root, 'runtime', 'tmp');
    this.child = Bun.spawn([this.python, '-B', '-m', 'wxcontrol.worker'], {
      cwd: this.root,
      env: {
        ...process.env, JIMUKEFU_RUNTIME_DIR: path.join(this.root, 'runtime'), PYTHONPATH: path.join(this.root, 'python'),
        PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', TEMP: tmp, TMP: tmp,
      },
      stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', windowsHide: true,
    });
    this.reader = this.child.stdout.getReader();
  }

  /** 读到下一个换行。 */
  private async readLine(): Promise<string> {
    const decoder = new TextDecoder();
    for (;;) {
      const at = this.buffer.indexOf('\n');
      if (at >= 0) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        return line;
      }
      const next = await this.reader!.read();
      if (next.done) throw new Error('微信后台 worker 退出了');

      this.buffer += decoder.decode(next.value, { stream: true });
    }
  }
}
