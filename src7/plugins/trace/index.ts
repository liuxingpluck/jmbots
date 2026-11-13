/**
 * 打印：看一条消息从头到尾走过哪个模块、哪个函数、哪个事件。
 * 骨架和插件只管发跟踪点；这个插件只管打。它只看不改。拔掉它，骨架照常跑。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type { TracePoint } from '../../utils/Trace.ts';


/** 插件名。 */
export const name = 'trace';

/** 用到的服务。 */
export const inject = ['resources'];


/** 给打印插件的配置：config.yaml 的 plugins.trace。 */
export interface TraceConfig {
  /** 打到控制台。不写是 true。 */
  console?: boolean;
  /** 同时写到运行时目录 trace/ 下当天的文件。不写是 false。 */
  file?: boolean;
  /** 打不打关键变量。不写是 true。 */
  vars?: boolean;
  /** 一个变量最多打多少字。不写是 200。 */
  varLimit?: number;
}


/** 校验后的配置。 */
interface Resolved {
  console: boolean;
  file: boolean;
  vars: boolean;
  varLimit: number;
}


/** 打印。 */
class Trace {
  /** 校验后的配置。 */
  private readonly config: Resolved;

  /**
   * 挂上两个监听。
   * @param ctx Cordis 给的 ctx。
   * @param config 见 TraceConfig。
   */
  constructor(private readonly ctx: cordis.Context, config: TraceConfig) {
    //M 校验一次：没写的项用默认值。
    this.config = {
      console: config.console !== false,
      file: config.file === true,
      vars: config.vars !== false,
      varLimit: typeof config.varLimit === 'number' && config.varLimit > 0 ? config.varLimit : 200,
    };
    //M ctx.on('trace', (point) => this.onPoint(point))。
    this.ctx.on('trace', (point) => {
      this.onPoint(point);
    });
    //M ctx.on('internal/dispatch', (mode, name) => this.onDispatch(mode, name))。Cordis 每发一个事件都会先发它。
    //  类型里不一定有这个事件，取不到就不打事件行，跟踪点照常打。
    const events = this.ctx as cordis.Context & {
      on(name: string, listener: (mode: string, event: string | symbol) => void): () => void;
    };
    try {
      events.on('internal/dispatch', (mode, eventName) => {
        this.onDispatch(String(mode), eventName);
      });
    } catch {
      // 这个版本的 Cordis 没有这个事件，就算了。
    }
  }

  /**
   * 响应一个跟踪点：打一行。
   * @param point 骨架或插件发来的跟踪点。
   */
  private onPoint(point: TracePoint): void {
    try {
      //M 一行的样子（各段用竖线隔开，没有的段不打）：
      //M   时间 [会话号后 6 位] 模块.函数 ⟵ 事件 │ 人话 │ 代码 │ 变量名=值 变量名=值
      //M   例：13:05:02.123 [482913] Sessions.run │ 第 2 步：调模型 │ chat(request) │ step=2 消息=7 工具=4
      const time = formatTime(Date.now());
      const sid = point.session !== undefined && point.session !== '' ? point.session.slice(-6) : '      ';
      const who = `${point.module}.${point.fn}`;
      const ev = point.event !== undefined ? ` ⟵ ${point.event}` : '';
      /** 各段。 */
      const parts = [`${time} [${sid}] ${who}${ev}`, point.text];
      if (point.code !== undefined && point.code !== '') {
        parts.push(point.code);
      }
      //M config.vars 开着才调 point.vars()；每个值转成字符串，超过 config.varLimit 截断。
      if (this.config.vars && point.vars !== undefined) {
        const rendered = renderVars(point.vars(), this.config.varLimit);
        if (rendered !== '') {
          parts.push(rendered);
        }
      }
      //M this.write(这一行)。
      this.write(parts.join(' │ '));
    } catch (error) {
      //G 整个函数包在 try 里：打印出错只在控制台说一句，绝不往外抛（它是被同步调用的，抛错会打断发跟踪点的人）。
      const text = error instanceof Error ? error.message : String(error);
      console.error(`打印跟踪点出错：${text}`);
    }
  }

  /**
   * 响应 internal/dispatch：打一行“发了哪个事件、谁在听”。
   * @param mode Cordis 的发法：emit、parallel、serial……
   * @param name 事件名。
   */
  private onDispatch(mode: string, name: string | symbol): void {
    try {
      //G trace 自己、internal/ 开头的 → 不打。
      if (typeof name !== 'string' || name === 'trace' || name.startsWith('internal/')) {
        return;
      }
      //M 听的人 = 这个事件现在登记着的监听，各取所属插件的名字，照登记的先后。
      //M   取法写实现时核实（Cordis 的监听表 ctx.events._hooks[name]，每项带着登记它的 ctx）；取不到就只打事件名。
      const listeners = listenerNames(this.ctx, name);
      const who = listeners.length > 0 ? `听的人：${listeners.join('、')}` : '';
      //M 一行的样子：时间 ⟶ session/tools（parallel）听的人：tools、default-dialog
      //G 同样包在 try 里，不往外抛，不做慢事。
      const tail = who === '' ? `${name}（${mode}）` : `${name}（${mode}）${who}`;
      //M this.write(这一行)。
      this.write(`${formatTime(Date.now())} ⟶ ${tail}`);
    } catch {
      // 不往外抛。
    }
  }

  /**
   * 把一行打出去。
   * @param line 拼好的一行。
   * 副作用：打控制台；config.file 开着时追加到当天的文件。
   */
  private write(line: string): void {
    if (this.config.console) {
      console.log(line);
    }
    if (this.config.file) {
      const dir = path.join(this.ctx.resources.paths.root, 'trace');
      fs.mkdirSync(dir, { recursive: true });
      const now = new Date();
      const name = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`;
      fs.appendFileSync(path.join(dir, name), `${line}\n`, 'utf8');
    }
  }
}


/**
 * 把变量打成“名=值 名=值”，太长的截断。
 * @param vars 关键变量。
 * @param limit 一个值最多多少字。
 */
function renderVars(vars: Record<string, unknown>, limit: number): string {
  return Object.entries(vars).map(([key, value]) => {
    let text = '';
    try {
      text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
    if (text.length > limit) {
      text = `${text.slice(0, limit)}…`;
    }
    return `${key}=${text}`;
  }).join(' ');
}


/**
 * 试着取出一个事件现在有哪些监听（所属插件名）。取不到就空数组。
 * @param ctx Cordis 的 ctx。
 * @param name 事件名。
 */
function listenerNames(ctx: cordis.Context, name: string): string[] {
  try {
    const events = (ctx as unknown as { events?: { _hooks?: Record<string, { ctx?: { name?: string; [k: string]: unknown } }[]> } }).events;
    const hooks = events?._hooks?.[name];
    if (!Array.isArray(hooks)) {
      return [];
    }
    const names: string[] = [];
    for (const hook of hooks) {
      const plugin = hook.ctx !== undefined && 'plugin' in hook.ctx ? hook.ctx['plugin'] : undefined;
      const pluginName = plugin !== null && typeof plugin === 'object' && 'name' in plugin ? String((plugin as { name?: unknown }).name ?? '') : '';
      const label = hook.ctx?.name ?? (pluginName !== '' ? pluginName : undefined);
      if (typeof label === 'string' && label !== '' && !names.includes(label)) {
        names.push(label);
      }
    }
    return names;
  } catch {
    return [];
  }
}


/**
 * 时间打成 13:05:02.123。
 * @param ms 毫秒时间戳。
 */
function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}


/**
 * 两位数补零。
 * @param value 数字。
 */
function pad(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}


/**
 * 挂上打印。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config 见 TraceConfig。
 */
export function apply(ctx: cordis.Context, config: TraceConfig): void {
  //M 校验一次：没写的项用默认值。
  new Trace(ctx, config ?? {});
}
