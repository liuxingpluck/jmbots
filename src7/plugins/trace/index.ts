/**
 * 打印：看一条消息从头到尾走过哪个模块、哪个函数、哪个事件、谁在听。
 * 打两种行，开头的字不一样，控制台上颜色也不一样：
 *   函数（青色）：代码一行行往下走到了哪。骨架和插件走到关键的地方发一个跟踪点（trace），这里打一行。
 *                 时间 函数 模块.函数 │ 人话 │ 代码 │ 变量名=值 变量名=值 │ 文件:行号
 *   事件（黄色）：发了哪个事件。Cordis 每发一个事件都会自己报一声，不用谁去发。
 *                 时间 事件 事件名（挨个问、通知）听的人：插件、插件 │ 这个事件带着什么 │ 文件:行号
 * 最后的“文件:行号”是从调用栈里自动找的：哪一行代码发的这个跟踪点、这个事件。
 * 在 VS Code 的终端里按住 Ctrl 点它，能跳到那一行。
 * 它只看不改。拔掉它，骨架照常跑，只是不打印。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as traceUtils from '../../utils/Trace.ts';
import * as textModule from '../../utils/Text.ts';


/** 插件名。 */
export const name = 'trace';

/** 用到的服务。 */
export const inject = ['resources'];


/** 给打印插件的配置：config.yaml 的 plugins 段里它的 config。 */
export interface TraceConfig {
  /** 打到控制台。不写是 true。 */
  console: boolean;
  /** 同时写到运行时目录 trace/ 下当天的文件。不写是 false。 */
  file: boolean;
  /** 一个变量、一段话最多打多少字。不写是 200。 */
  varLimit: number;
}


/** 两种行在控制台上的颜色（ANSI 颜色号）：函数青色，事件黄色。 */
const COLORS = { 函数: '36', 事件: '33' };


/** 打印。 */
class Trace {
  /**
   * 挂上两个监听。
   * @param ctx Cordis 给的 ctx。
   * @param config 打到哪、一个值最多打多少字。
   */
  constructor(private readonly ctx: cordis.Context, private readonly config: TraceConfig) {
    this.ctx.on('trace', (where, text, code, vars) => {
      this.onPoint(where, text, code, vars);
    });

    //M Cordis 每发一个事件，都会先发一个 internal/dispatch：发法、事件名、带的参数。
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
    const shown = Object.entries(vars).map(([key, value]) => `${key}=${this.short(value)}`);
    this.write('函数', [where, text, code, shown.join(' ')]);
  }

  /**
   * 响应 internal/dispatch：打一行“发了哪个事件、谁在听、带着什么”。
   * @param mode Cordis 的发法：emit、parallel、serial……
   * @param event 事件名。
   * @param args 这个事件带的参数。
   */
  private onDispatch(mode: string, event: string | symbol, args: unknown[]): void {
    //G 跟踪点自己、Cordis 内部的事件不算。
    if (typeof event !== 'string' || event === 'trace' || event.startsWith('internal/')) return;

    //M 拼事件行（和 journal 记进库的是同一种行）：事件名、发法、听的人、会话、认得的关键值。
    const line = traceUtils.dispatchLine(this.ctx, mode, event, args, this.config.varLimit);
    const parts = [`${line.name}（${line.mode}）听的人：${line.listeners.join('、')}`];
    const vars = Object.entries(line.vars).map(([key, value]) => `${key}=${this.short(value)}`);
    parts.push([line.session === undefined ? '' : `会话=${line.session}`, ...vars].filter((part) => part !== '').join(' '));
    this.write('事件', parts);
  }

  /**
   * 把一个值打成一小段：不换行，太长的截断。
   * @param value 变量的值，或者一段话。
   */
  private short(value: unknown): string {
    return traceUtils.short(value, this.config.varLimit);
  }

  /**
   * 把一行打出去：前面加上时间和这是哪种行，后面加上是哪一行代码走到这里的。
   * @param kind 哪种行：函数是代码往下走到了哪，事件是发了哪个事件。
   * @param parts 这一行的几段；空的那几段不打。
   * 副作用：打控制台；config.file 开着时追加到运行时目录 trace/ 下当天的文件。
   */
  private write(kind: '函数' | '事件', parts: string[]): void {
    const time = textModule.clock(Date.now(), 'ms');
    const body = parts.filter((part) => part !== '').join(' │ ');

    //M 是哪一行代码发的：从调用栈里自动找，不用发的人自己写。
    const at = traceUtils.callSite(['plugins/trace/']);
    if (this.config.console) {
      //M 控制台上：开头那两个字带颜色，一眼分得开；位置用暗色。
      console.log(`${time} \x1b[${COLORS[kind]}m${kind}\x1b[0m ${body} \x1b[90m│ ${at}\x1b[0m`);
    }
    if (this.config.file) {
      /** 本地日期，2026-11-13 的样子。 */
      const day = new Date().toLocaleDateString('sv-SE');
      const file = path.join(this.ctx.resources.dir('trace'), `${day}.log`);
      fs.appendFileSync(file, `${time} ${kind} ${body} │ ${at}\n`, 'utf8');
    }
  }
}


/**
 * 挂上打印。
 * apply 是 Cordis 插件的入口函数：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 先等 inject 里写的服务都就绪，
 * 再调一次 apply(ctx, 配置)。插件在 apply 里通过 ctx 听事件、登记工具；插件被拔掉时，这些登记自动撤掉。
 * 详见 plugins/Index.ts 的 PluginModule。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config 见 TraceConfig；每一项都可以不写。
 */
export function apply(ctx: cordis.Context, config: Partial<TraceConfig>): void {
  //M 配置是外面进来的，在这里定一次：没写的、写得不对的用默认值。
  const varLimit = typeof config.varLimit === 'number' && config.varLimit > 0 ? config.varLimit : 200;
  new Trace(ctx, { console: config.console !== false, file: config.file === true, varLimit });
}
