/**
 * 跑命令与命令窗口（由 exec 与原 runs 合并）：
 *   服务 exec.run：不经过模型、不审核，起一个 shell 跑一条命令，交回退出码和输出。
 *   工具 exec：先发 approval/request（action: review）请审核插件审，放行就跑；拒绝、去问用户了，都把一句话交给模型。
 *     没挂 approval、审核超时一律拒绝（Runs.ts 的 requestReview）。在这一轮的工作区里跑（飞书上 builder 说话时是他的目录，审核也照这个目录把关）。
 *   用户后来同意了（approval/decided，kind 是 exec）：跑命令，结果当一句新的话交回那场会话，推它往下走。
 *   命令窗口 Runs（Runs.ts，可选 config.runs 默认开启）：http 在时挂 /api/run、/api/runs* 五条 HTTP 接口。
 * 停止：工具拿到的停止信号（Tools.ts 给的 signal）一触发，连子进程整棵杀掉（Windows 用 taskkill /T /F），两秒内交回。
 * 设计见同目录 说明.md 的「设计要点」一节（含 runs）。
 */
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as cut from '../../utils/Cut.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import * as runsModule from './Runs.ts';


export { mountRunsRoutes, readRunsEnabled, Runs, type RunRecord } from './Runs.ts';


/** 插件名。 */
export const name = 'exec';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
export const version = '1.1.1';

/**
 * 用到的服务：resources、tools、bots、sessions。审核不写在这里，走 approval/request 事件：没挂 approval 时一律拒绝（没有审核就不让跑命令）；
 * http 为可选（存在时才挂载 /api/run* 命令窗口）。
 */
export const inject = ['resources', 'tools', 'bots', 'sessions'];


declare module 'cordis' {
  interface Context {
    /** 跑命令服务，实现在 src7/plugins/exec/index.ts。 */
    exec: Exec;
  }
}


/** exec.run 要给的。 */
export interface ExecInput {
  /** 原样交给 shell。 */
  command: string;
  /** 在哪个目录跑，绝对路径。 */
  cwd: string;
  /** 最多跑多久，毫秒；到点连子进程一起杀。 */
  timeoutMs: number;
  /** 触发就连子进程一起杀。 */
  signal?: AbortSignal;
  /** 哪场会话跑的，写进子进程的 JMBOTS_SESSION_ID。 */
  session?: string;
  /** 每来一段输出叫一次（runs 用它边跑边看）。 */
  onOutput?: (chunk: string) => void;
}

/** exec.run 交回的。 */
export interface ExecResult {
  /** 退出码；被杀、没起来是 null。 */
  code: number | null;
  /** 是不是到点杀的。 */
  timedOut: boolean;
  /** 是不是 signal 停的。 */
  stopped: boolean;
  /** 起不来、目录不存在。 */
  error?: string;
  /** stdout、stderr 合在一起的全部输出，不截。 */
  output: string;
  /** 用时，毫秒。 */
  ms: number;
}

/** 用户同意以后要跑的：工具登记待确认时自己放进 payload 的。 */
interface ExecPayload {
  command: string;
  cwd: string;
  timeoutMs: number;
}


/** 工具的超时默认几秒（0.4 也是常量：src/capabilities/tools/Tools.ts:126-127）。 */
const DEFAULT_TIMEOUT_SECONDS = 120;

/** 命令退出以后，最多再等几毫秒管道关上（后台子进程会一直拿着输出管道；0.4 卡过一个半小时）。 */
const CLOSE_GRACE_MS = 2000;

/** 是不是 Windows。 */
const WINDOWS = process.platform === 'win32';


/** 跑命令服务。 */
export class Exec extends cordis.Service {
  /**
   * 登记 exec 插件：把 Exec 作为服务挂到 Cordis 上（以后用 ctx.exec 取）；再登记工具 exec，听 approval/decided（通知，approval 声明的）。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param dirs 语言运行环境、程序两个目录（绝对路径），和放到 PATH 最前面的工具目录，apply 里算好的。
   */
  constructor(ctx: cordis.Context, private readonly dirs: { runtimes: string; program: string; tools: string[] }) {
    //M 先让 Cordis 把 Exec 登记成 ctx.exec 服务，别的插件以后用 ctx.exec.run 跑命令。
    super(ctx, 'exec');

    //M 登记工具 exec 给模型用。
    ctx.tools.register({
      definition: {
        name: 'exec',
        description: `在工作区执行一条命令（Windows 上是 cmd.exe，别的系统是 sh），stdout、stderr 合在一起，`
          + `超过 ${String(cut.MAX_LINES)} 行或 50KB 只留最后一段。执行前先审核，可能要等用户确认。`,
        parameters: piAi.Type.Object({
          command: piAi.Type.String({ description: '要执行的命令' }),
          timeout: piAi.Type.Optional(piAi.Type.Integer({ minimum: 1, description: `最多跑几秒，默认 ${String(DEFAULT_TIMEOUT_SECONDS)}` })),
        }),
      },
      kinds: ['work'],
      //M 模型调用 exec 时走 onTool：先审核，放行才跑。
      run: (args, session, signal) => this.onTool(args, session, signal),
    });

    //M 用户在审核那边定了待确认：onDecided 只管 kind 是 exec 的，同意就跑，结果交回会话。
    ctx.on('approval/decided', (pending) => {
      void this.onDecided(pending);
    });
  }

  /**
   * 起一个 shell 跑一条命令。不抛错，出错写在 error 里。
   * @param input 命令、目录、超时、停止信号、会话、边跑边看。
   * @returns 退出码、是不是超时、是不是停的、输出、用时。
   * 副作用：起子进程。
   */
  run(input: ExecInput): Promise<ExecResult> {
    const start = Date.now();
    if (!fs.existsSync(input.cwd)) {
      return Promise.resolve({ code: null, timedOut: false, stopped: false, error: `目录不存在：${input.cwd}`, output: '', ms: 0 });
    }

    //G 还没起就已经喊停了（审核那会儿点了停止）→ 不起了。
    if (input.signal?.aborted === true) return Promise.resolve({ code: null, timedOut: false, stopped: true, output: '', ms: 0 });

    //T 跟踪：起子进程。
    const vars = { 命令: input.command.slice(0, 120), 目录: input.cwd, 超时毫秒: input.timeoutMs };
    this.ctx.emit('trace', 'Exec.run', '起子进程跑一条命令', 'child_process.spawn(command, { shell: true, signal })', vars);

    return new Promise((resolve) => {
      let output = '';
      let timedOut = false;
      let stopped = false;
      let finished = false;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;

      //M 子进程整棵杀掉：Windows 上 shell 是 cmd.exe，真正干活的是它的子进程，只杀 cmd 杀不到；
      //M 所以用 taskkill /T /F（同步跑，杀完再往下）。别的系统子进程单开一个进程组，杀整个组。
      const killTree = (): void => {
        if (child.pid === undefined) return;

        if (WINDOWS) {
          childProcess.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
          return;
        }
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // 进程组已经没了。
        }
      };

      //M 只收一次尾：退出、管道关、出错，哪个先到用哪个。
      const finish = (code: number | null, error?: string): void => {
        if (finished) return;

        //M 标记已收尾，清掉两个定时器和停止监听，免得收尾以后还被触发。
        finished = true;
        clearTimeout(timer);
        clearTimeout(closeTimer);
        input.signal?.removeEventListener('abort', onAbort);
        const result: ExecResult = { code, timedOut, stopped, output, ms: Date.now() - start };
        if (error !== undefined) {
          result.error = error;
        }

        //M 把结果交回给 run 的调用方（Promise 到这里才完成）。
        resolve(result);
      };

      //M 停止信号：先自己把整棵杀掉，再交给 spawn 的 signal（它只杀 shell 那一个）。所以这个监听要在 spawn 之前挂上。
      const onAbort = (): void => {
        stopped = true;
        killTree();
      };

      //M 现在就挂上停止监听（只响应一次），喊停时 onAbort 先把整棵杀掉。
      input.signal?.addEventListener('abort', onAbort, { once: true });

      //M Windows 的 cmd 默认 GBK，先切成 UTF-8；工具目录放到 PATH 最前面，几个变量只给这个子进程。
      let command = input.command;
      let pathKey = 'PATH';
      if (WINDOWS) {
        command = `chcp 65001 >nul & ${input.command}`;
        pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'Path';
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        [pathKey]: [...this.dirs.tools, process.env[pathKey] ?? ''].join(path.delimiter),
        JMBOTS_SESSION_ID: input.session ?? '',
        JMBOTS_RUNTIMES: this.dirs.runtimes,
        JMBOTS_PROGRAM: this.dirs.program,
      };
      const child = childProcess.spawn(command, {
        cwd: input.cwd, shell: true, windowsHide: true, env, detached: !WINDOWS, signal: input.signal,
      });

      const take = (chunk: Buffer): void => {
        //M 每来一段输出：转成文字攒进总输出，再交给边跑边看的回调。
        const text = chunk.toString('utf8');
        output += text;
        input.onOutput?.(text);
      };

      //M stdout、stderr 都交给 take 攒起来，输出合在一起。
      child.stdout.on('data', take);
      child.stderr.on('data', take);

      //M 到点：记成超时，杀整棵。
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, input.timeoutMs);

      //M 退出了再等两秒管道关；后台子进程拿着管道不放，就不等了。
      child.on('exit', (code) => {
        closeTimer = setTimeout(() => {
          finish(code);
        }, CLOSE_GRACE_MS);
      });
      //M 管道关了：正常收尾，用这次的退出码。
      child.on('close', (code) => {
        finish(code);
      });

      //M 子进程起不来之类的错：下面带上错误信息收尾。
      child.on('error', (error) => {
        //G spawn 的 signal 触发时也会报一个 AbortError：那是停下，不算出错，等 exit/close 收尾。
        if (stopped) return;

        //M 真出错了（没有退出码）：把错误信息交给 finish。
        finish(null, error.message);
      });
    });
  }

  /**
   * 工具 exec：先审核，放行就跑。
   * @param args 模型给的参数（Tools.ts 照定义校验过）。
   * @param session 哪场会话。
   * @param signal 停止信号。
   * @returns 给模型看的话。
   */
  private async onTool(args: Record<string, unknown>, session: Session, signal: AbortSignal): Promise<string> {
    //M 取出命令，找到这场会话的机器人（工作区挂在它名下）。
    const command = args['command'] as string;
    const bot = this.ctx.bots.get(session.row.bot);
    if (bot === undefined) throw new Error(`没有这个机器人：${session.row.bot}`);

    //M 在这一轮的工作区里跑：飞书上 builder 说话时是他的目录，审核也照这个目录把关（confined）。
    const cwd = workspaceModule.getWorkspace(bot.workspace, session.row.address);
    let confined: string | undefined;
    if (cwd !== bot.workspace) {
      confined = cwd;
    }
    const timeoutMs = ((args['timeout'] as number | undefined) ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    const payload: ExecPayload = { command, cwd, timeoutMs };
    const reviewInput: runsModule.ReviewInput = {
      command,
      cwd,
      confined,
      bot: bot.name,
      session: session.id,
      kind: 'exec',
      payload,
      signal,
    };

    //M 发 approval/request 请审核插件审，最多等 65 秒；会话喊停（signal）就不等了。没挂、超时、停了都是拒绝。
    const verdict = await runsModule.requestReview(this.ctx, reviewInput);

    //T 跟踪：审核结论。
    const vars = { 会话: session.id, 结论: verdict.result, 原因: verdict.reason };
    this.ctx.emit('trace', 'Exec.onTool', '审核完了', "requestEvent('approval/request', review)", vars);
    if (verdict.result === 'reject') return `未执行：${verdict.reason}`;

    if (verdict.result === 'asked') {
      return `已提交给用户确认，还没执行（待确认 #${String(verdict.id)}）。用户决定后会有一条消息告诉你结果，不要重新调用这条命令。`
        + '依赖这条命令结果的事先别做，别的事照常做；没别的事就结束这一轮，不用再提醒用户确认。';
    }
    //M 放行了：真去跑（带上停止信号），结果写成给模型看的话交回。
    return report(await this.run({ command, cwd, timeoutMs, signal, session: session.id }));
  }

  /**
   * 用户定了一件 exec 的待确认：同意就跑，结果当一句新的话交回那场会话；拒绝就告诉它没跑。
   * @param pending 定好的待确认。
   * 副作用：可能起子进程；往会话里说一句话，推它往下走。
   */
  private async onDecided(pending: runsModule.Pending): Promise<void> {
    if (pending.kind !== 'exec' || pending.session === undefined) return;

    //M payload 是 onTool 自己放的，直接用。
    const { command, cwd, timeoutMs } = pending.payload as ExecPayload;

    //M 打开登记这件待确认的那场会话，后面要把结果交回给它。
    const session = this.ctx.sessions.open(pending.session);
    const id = String(pending.id);
    let text = `（系统）待确认 #${id}：用户拒绝了（${pending.by ?? ''}），命令没有执行。\n命令：${command}`;
    if (pending.state === 'approved') {
      //M 用户同意了：起子进程把命令真跑起来（这时没有停止信号），结果写进要交回的话。
      const result = await this.run({ command, cwd, timeoutMs, session: session.id });
      text = `（系统）待确认 #${id}：用户同意了（${pending.by ?? ''}），命令已经执行。\n命令：${command}\n结果：\n${report(result)}`;
    }

    //T 跟踪：结果交回会话。
    const vars = { 会话: session.id, 号: pending.id, 结果: pending.state };
    this.ctx.emit('trace', 'Exec.onDecided', '用户定了，结果交回会话', 'session.add(text); session.run()', vars);

    //M 正在转的话，下一步会带上这句；没在转就推它转一轮。
    session.add(text);
    void session.run();
  }
}


/**
 * 结果写成给模型看的话：头一行退出码、用时（照 src/capabilities/tools/Tools.ts:1163-1166），再接输出，太长只留结尾。
 * @param result exec.run 的结果。
 * @returns 给模型看的文字：头一行是退出码、用时，后面是输出（太长只留结尾）；没有输出就写“（没有输出）”。
 */
export function report(result: ExecResult): string {
  let codeText = '无';
  if (result.code !== null) {
    codeText = String(result.code);
  }
  let head = `退出码 ${codeText}`;
  if (result.timedOut) {
    head += '（超时，已结束）';
  }
  if (result.stopped) {
    head += '（被停下了）';
  }
  head += `，用时 ${(result.ms / 1000).toFixed(1)} 秒`;
  if (result.error !== undefined) {
    head += `，出错：${result.error}`;
  }

  //M 换行统一成 \n，去掉末尾那个换行；没有输出就只回头一行。
  const output = result.output.replace(/\r\n/g, '\n').replace(/\n$/u, '');
  if (output === '') return `${head}\n（没有输出）`;

  //M 输出太长就只留最后一段，截了的话在前面写明留了几行、共几行。
  const kept = cut.tail(output);
  let note = '';
  if (kept.cut) {
    note = `[输出太长，只留最后 ${String(kept.kept)} 行（共 ${String(kept.total)} 行）]\n`;
  }
  return `${head}\n${note}${kept.text}`;
}


/**
 * 工具目录：paths.runtimes、paths.program 下每个文件夹，有 bin/、Scripts/ 用它们，都没有用文件夹本身，按名字排。
 * @param dirs 两个目录，绝对路径。
 */
function getToolDirs(dirs: string[]): string[] {
  const found: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    //M 这个目录下的子文件夹，按名字排好，PATH 里的顺序就固定。
    const names = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    for (const item of names) {
      //M 有 bin、Scripts 就只用它们（语言环境的可执行文件在那里）。
      const subs = ['bin', 'Scripts'].map((sub) => path.join(dir, item, sub)).filter((sub) => fs.existsSync(sub));
      if (subs.length > 0) {
        found.push(...subs);
        continue;
      }
      //M 没有 bin、Scripts：文件夹本身放进 PATH。
      found.push(path.join(dir, item));
    }
  }
  return found;
}


/**
 * 挂上跑命令与可选的 HTTP 命令窗口。
 * apply 是 Cordis 插件的入口：inject 里的服务都就绪后 Cordis 调一次。approval 没挂也照常开工，只是审核请求没人答，命令一律拒绝。
 * 工具目录读顶层 paths 段；`config.runs` 默认开启，传 `false` 可关闭 `/api/run*` 路由。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param raw 插件配置（可不写）。
 * @throws paths.runtimes、paths.program 不是字符串或 `config.runs` 类型不合法时抛错。
 */
export function apply(ctx: cordis.Context, raw?: Record<string, unknown>): void {
  const paths = (ctx.resources.raw['paths'] ?? {}) as Record<string, unknown>;
  const runtimes = paths['runtimes'] ?? 'runtimes';
  const program = paths['program'] ?? 'program';
  if (typeof runtimes !== 'string' || typeof program !== 'string') {
    throw new Error('paths.runtimes、paths.program 要写成目录（相对运行时目录或绝对路径）');
  }
  //M 读配置里 runs 开没开（默认开），不合法的值在这里就抛错。
  const runsEnabled = runsModule.readRunsEnabled(raw?.['runs']);

  //M 两个目录算成绝对路径，建 Exec 服务，同时把各语言环境的 bin 目录算好，当 PATH 前缀。
  const dirs = { runtimes: path.resolve(ctx.resources.root, runtimes), program: path.resolve(ctx.resources.root, program) };
  const exec = new Exec(ctx, { ...dirs, tools: getToolDirs([dirs.runtimes, dirs.program]) });
  if (runsEnabled) {
    //M 建命令窗口（建表、收拾上次没跑完的），它跑命令还是交给 exec.run。
    const runs = new runsModule.Runs(ctx, exec);

    //M http 就绪后，把五条 /api/run* 路由挂上去。
    void ctx.inject(['http'], (sub) => {
      runsModule.mountRunsRoutes(sub.http.app, runs);
    });
  }
}
