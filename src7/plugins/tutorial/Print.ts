/**
 * 打印执行路径：看一条消息从头到尾走过哪个模块、哪个函数、哪个事件、谁在听。原来的 trace 插件，11-17 并进 tutorial。
 * 打两种行，开头的字不一样，控制台上颜色也不一样：
 *   函数（青色）：代码一行行往下走到了哪。骨架和插件走到关键的地方发一个跟踪点（trace，声明在 utils/Trace.ts），这里打一行。
 *                 时间 函数 模块.函数 │ 人话 │ 代码 │ 变量名=值 变量名=值 │ 文件:行号
 *   事件（黄色）：发了哪个事件。Cordis 每发一个事件都会自己报一声（internal/dispatch），不用谁去发。
 *                 时间 事件 事件名（挨个问、通知）听的人：插件、插件 │ 这个事件带着什么 │ 文件:行号
 * 最后的“文件:行号”是从调用栈里自动找的：哪一行代码发的这个跟踪点、这个事件。在 VS Code 的终端里按住 Ctrl 点它，能跳到那一行。
 * 只看不改。控制台、文件都没开（tutorial 配置 trace_console、trace_file）时不挂监听。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as traceText from '../../../web/src/locales/Trace.ts';
import * as utils from '../../utils/index.ts';
import * as textModule from '../../utils/Text.ts';
import * as traceUtils from '../../utils/Trace.ts';


/** 打印的配置：tutorial 的 apply 从 config.yaml 读、校验过。 */
export interface PrintConfig {
  /** 打到控制台。 */
  console: boolean;
  /** 同时写到运行时目录 trace/ 下当天的文件。 */
  file: boolean;
  /** 一个变量、一段话最多打多少字。 */
  varLimit: number;
}


/** 两种行在控制台上的颜色（ANSI 颜色号）：函数青色，事件黄色。 */
const COLORS = { function: '36', event: '33' };


/** 打印。 */
export class Printer {
  /** 每次显示取当前配置语言，设置页保存后跟随最新配置。 */
  private get language(): traceText.TraceLanguage {
    const ui = this.ctx.resources.raw['ui'];
    //M 打印时读当前的界面语言，设置保存后随配置快照更新。
    const language = utils.getField(ui, 'language');
    return traceText.getTraceLanguage(language);
  }

  /**
   * 挂上两个监听：跟踪点、Cordis 报的每个事件。
   * @param ctx tutorial 的 ctx。
   * @param config 打到哪、一个值最多打多少字。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly config: PrintConfig,
  ) {
    //M 一个跟踪点：打一行函数行。
    this.ctx.on('trace', (where, text, code, vars) => {
      this.onPoint(where, text, code, vars);
    });

    //M Cordis 每发一个事件，都会先发一个 internal/dispatch：发法、事件名、带的参数。打一行事件行。
    this.ctx.on('internal/dispatch', (mode, event, args) => {
      this.onDispatch(mode, event, args);
    });
  }

  /**
   * 响应一个跟踪点：打一行。
   * @param where 哪个模块的哪个函数。
   * @param text 一句人话。
   * @param code 一句代码。
   * @param vars 关键变量。
   */
  private onPoint(where: string, text: string, code: string, vars: Record<string, unknown>): void {
    const shown: string[] = [];
    for (const [key, value] of Object.entries(vars)) {
      //M 按配置的字数上限裁剪变量值，避免控制台被大对象刷屏。
      const short = traceUtils.formatTraceValue(value, this.config.varLimit);
      const label = traceText.getTraceFieldLabel(this.language, key);
      shown.push(`${label}=${short}`);
    }
    //M 把跟踪点名、人话、源码句和裁剪后的变量拼成“函数”行写出。
    const caption = traceText.getTraceText(this.language, text, vars);
    this.write('function', [where, caption, code, shown.join(' ')]);
  }

  /**
   * 响应 internal/dispatch：打一行“发了哪个事件、谁在听、带着什么”。
   * @param mode Cordis 的发法：emit、parallel、serial……
   * @param event 事件名。
   * @param args 这个事件带的参数。
   */
  private onDispatch(mode: string, event: string | symbol, args: unknown[]): void {
    //G 跟踪点自己、Cordis 内部的事件不算。
    if (typeof event !== 'string') return;
    if (event === 'trace') return;
    if (event.startsWith('internal/')) return;

    //M 拼事件行（和 journal 记进库的是同一种行）：事件名、发法、听的人、会话、认得的关键值。
    const line = traceUtils.buildDispatchLine(this.ctx, mode, event, args, this.config.varLimit);
    const modeId = traceText.getTraceModeId(line.mode);
    const modeText = traceText.getTraceText(this.language, modeId);
    const listeners = line.listeners.join('、');
    const heading = { name: line.name, mode: modeText, listeners };
    const head = traceText.getTraceText(this.language, 'trace.event.heading', heading);

    //M 第二段：会话，再接认得的关键值。
    const values: string[] = [];
    if (line.session !== undefined) {
      const label = traceText.getTraceFieldLabel(this.language, 'session');
      values.push(`${label}=${line.session}`);
    }
    for (const [key, value] of Object.entries(line.vars)) {
      const short = traceUtils.formatTraceValue(value, this.config.varLimit);
      const label = traceText.getTraceFieldLabel(this.language, key);
      values.push(`${label}=${short}`);
    }
    //M 把事件头与关键参数拼成“事件”行输出到控制台和当日日志。
    this.write('event', [head, values.join(' ')]);
  }

  /**
   * 把一行打出去：前面加上时间和这是哪种行，后面加上是哪一行代码走到这里的。
   * @param kind 哪种行：函数是代码往下走到了哪，事件是发了哪个事件。
   * @param parts 这一行的几段；空的那几段不打。
   * 副作用：config.console 开着时打控制台；config.file 开着时追加到运行时目录 trace/ 下当天的文件。
   */
  private write(kind: 'function' | 'event', parts: string[]): void {
    //M 取精确到毫秒的本地时钟，作为每条输出行的统一时间前缀。
    const time = textModule.formatLocalTime(Date.now(), 'ms');
    const body = parts.filter((part) => part !== '').join(' │ ');
    const kindId = `trace.kind.${kind}`;
    const label = traceText.getTraceText(this.language, kindId);

    //M 是哪一行代码发的：从调用栈里自动找，不用发的人自己写。
    const at = traceUtils.getCallSite(['plugins/tutorial/']);

    //M 控制台上：开头那两个字带颜色，一眼分得开；位置用暗色。
    if (this.config.console) {
      console.log(`${time} \x1b[${COLORS[kind]}m${label}\x1b[0m ${body} \x1b[90m│ ${at}\x1b[0m`);
    }

    //M 文件：本地日期（2026-11-13 的样子）一天一个。
    if (this.config.file) {
      const day = new Date().toLocaleDateString('sv-SE');
      const file = path.join(this.ctx.resources.ensureRuntimeDir('trace'), `${day}.log`);
      fs.appendFileSync(file, `${time} ${label} ${body} │ ${at}\n`, 'utf8');
    }
  }
}
