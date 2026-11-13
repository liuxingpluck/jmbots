/**
 * 工具：自己不带任何工具，只管一张登记表。
 * 系统自带的、别的插件的工具都调 register 登记进来；
 * 会话问“有哪些工具”时报清单，会话说“执行这批工具”时一个个执行。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { CallsEvent, Session, SessionKind, ToolsEvent } from './Sessions.ts';


declare module 'cordis' {
  interface Context {
    /** 工具服务，实现在 src7/Tools.ts。 */
    tools: Tools;
  }
}


/** 登记一个工具要给的东西。 */
export interface ToolSpec {
  /** 给模型看的：名字、说明、参数形状。 */
  definition: piAi.Tool;
  /** 给哪几种会话用。默认对话只拿得到写了 default 的。 */
  kinds: SessionKind[];
  /**
   * 执行。
   * @param call 模型的这次调用：名字、参数、调用号。
   * @param session 是哪场会话要执行。
   * @returns 给模型看的文字。抛错就是出错。
   */
  run(call: piAi.ToolCall, session: Session): Promise<string> | string;
}


/** 工具服务。 */
export class Tools extends cordis.Service {
  /** 登记表：工具名 → 工具，按登记的先后。 */
  private readonly specs = new Map<string, ToolSpec>();

  /**
   * 登记成 ctx.tools，挂上两个监听。
   * @param ctx Cordis 给的 ctx。
   */
  constructor(ctx: cordis.Context) {
    super(ctx, 'tools');
    //M ctx.on('session/tools', (event) => this.onTools(event))。
    this.ctx.on('session/tools', (event) => {
      this.onTools(event);
    });
    //M ctx.on('session/calls', (event) => this.onCalls(event))。
    this.ctx.on('session/calls', (event) => this.onCalls(event));
  }

  /**
   * 登记一个工具。登记它的那个插件被拔掉，这个工具自动撤掉。
   * @param spec 定义、给哪几种会话用、执行函数。
   * @throws 同名的登记第二次抛错。
   */
  register(spec: ToolSpec): void {
    const name = spec.definition.name;
    //G 名字已经在表里 → 抛错。
    if (this.specs.has(name)) {
      throw new Error(`工具 ${name} 已经登记过了`);
    }
    //M this.ctx.effect(() => { 加进表; return () => 从表里拿掉; })。
    //M   在服务的方法里 this.ctx 是调用方的 ctx，所以这个清理挂在登记它的插件身上（读 Cordis 源码得出的，没真跑）。
    const specs = this.specs;
    this.ctx.effect(() => {
      specs.set(name, spec);
      return () => {
        specs.delete(name);
      };
    });
  }

  /**
   * 响应 session/tools：往清单里加工具。数组操作。
   * @param event 会话和工具数组。
   */
  private onTools(event: ToolsEvent): void {
    const kind = event.session.row.kind;
    const have = new Set(event.tools.map((item) => item.name));
    //M 登记表里每一个：kinds 里有这场会话的种类、而且清单里还没有这个名字 → event.tools.push(definition)。
    for (const spec of this.specs.values()) {
      if (spec.kinds.includes(kind) && !have.has(spec.definition.name)) {
        event.tools.push(spec.definition);
        have.add(spec.definition.name);
      }
    }
  }

  /**
   * 响应 session/calls：这批调用一个个执行（批量发过来，执行是串行的）。
   * @param event 会话和这批调用；结果填进每一项的 result。
   * 副作用：执行工具。
   */
  private async onCalls(event: CallsEvent): Promise<void> {
    //M 一个个 item：
    for (const item of event.calls) {
      //G   item.result 已经有了（把关的人没让执行，或者别的插件执行过了）→ 跳过。
      if (item.result !== undefined) {
        continue;
      }
      //G   每个工具之前都查一次：event.session.row.state 不是 wait_tools → item.result = “未执行：停下来了”，算出错。
      if (event.session.row.state !== 'wait_tools') {
        item.result = { text: '未执行：停下来了', isError: true };
        continue;
      }
      const spec = this.specs.get(item.call.name);
      //G   表里没有这个名字 → 不管（最后会话给它记“没有执行者”）。
      if (spec === undefined) {
        continue;
      }
      //T   跟踪：『执行工具』 代码 spec.run(call, session) 变量 { 会话号, 工具名, 参数 }
      this.ctx.emit('trace', {
        module: 'Tools',
        fn: 'onCalls',
        event: 'session/calls',
        session: event.session.id,
        text: '执行工具',
        code: 'spec.run(call, session)',
        vars: () => ({
          会话号: event.session.id,
          工具名: item.call.name,
          参数: item.call.arguments,
        }),
      });
      const started = Date.now();
      try {
        //M   执行 spec.run(item.call, event.session)：成了 item.result = { text, isError: false }；
        const text = await spec.run(item.call, event.session);
        item.result = { text, isError: false };
      } catch (error) {
        //M   抛错 → item.result = { text: “出错：原因”, isError: true }，不往外抛。
        const reason = error instanceof Error ? error.message : String(error);
        item.result = { text: `出错：${reason}`, isError: true };
      }
      //T   跟踪：『工具有结果了』 变量 { 工具名, 是不是出错, 结果多少字, 用了多久 }
      const outcome = item.result;
      this.ctx.emit('trace', {
        module: 'Tools',
        fn: 'onCalls',
        event: 'session/calls',
        session: event.session.id,
        text: '工具有结果了',
        vars: () => ({
          工具名: item.call.name,
          是不是出错: outcome.isError,
          结果多少字: outcome.text.length,
          用了多久: Date.now() - started,
        }),
      });
    }
  }
}
