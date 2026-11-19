/**
 * 工具：自己不带任何工具，只管一张登记表。
 * 自带的、别的插件的工具都调 register 登记进来；
 * 会话每一步调 listToolsForSessionKind 要清单，模型要了工具就调 execute 一个个执行。
 */
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { Session, SessionGate } from './Sessions.ts';
import * as textModule from './utils/Text.ts';


declare module 'cordis' {
  interface Context {
    /** 工具服务，实现在 src7/Tools.ts。 */
    tools: Tools;
  }
  interface Events {
    /**
     * 关口三，要执行一个工具了，先给把关的人看：照插件挂上去的先后一个个 await。
     * 只不让执行这一个的，在 gate.deny 里写上理由（理由会当成工具结果给模型看，会话接着走）；
     * 要整场这一轮停下的，在 gate.stop 里写理由。监听的函数不许有返回值。
     * 关口四 session/after-tool 由会话循环发，声明在 Sessions.ts，数据是下面的 ToolDone。
     * 谁发：src7/Tools.ts 的 Tools.execute
     * 谁接：
     *   src7/plugins/approval/index.ts 的 Approval.constructor
     *   src7/plugins/bots/ChannelTools.ts 的 ChannelTools.constructor
     *   src7/plugins/progress/GroupDaily.ts 的 bindReportTools
     */
    'session/before-tool'(gate: ToolGate): void | Promise<void>;
  }
}


/** 登记一个工具要给的东西。 */
export interface ToolSpec {
  /**
   * 给模型看的 pi-ai `Tool` 定义。
   * - `name` 是工具名，用来登记和匹配模型的调用。
   * - `description` 告诉模型工具能做什么。
   * - `parameters` 是 TypeBox 的参数 schema，用来校验模型传来的参数。
   * - `constrainedSampling` 可选，取 `false` 或 `ConstrainedSamplingConfig`。
   * 全部字段见 node_modules/@earendil-works/pi-ai/dist/types.d.ts:528。
   */
  definition: piAi.Tool;
  /** 哪几种会话能用这个工具（会话的 kind：front 前台对话 / work 后台干活 / relay 转话）。只写 ['work'] 时前台对话拿不到它。 */
  sessionKinds: string[];
  /**
   * 执行。
   * @param args 模型给的参数，已经照 definition.parameters 校验过，直接用。
   * @param session 是哪场会话要执行。
   * @param signal 停止信号：网页、飞书点了停止就触发。要等很久的工具（搜索、生图、跑命令、子任务）把它传给 fetch、子进程，
   *   或者听它的 abort 事件，收到就断开、抛错；写文件这类快的不用管它，照常做完。老工具不写这个参数也行。
   * @param callId 模型这次调用的 `id`（`ToolCall` 见本文件 L100）。同一次调用重来还是它。要防重复执行的工具（agent_task 派活）拿它当键；
   *   别的工具不写这个参数也行。
   * @returns 给模型看的文字。抛错就算出错，原因给模型看。
   */
  run(args: Record<string, unknown>, session: Session, signal: AbortSignal, callId: string): Promise<ToolResult> | ToolResult;
}


/**
 * 工具 run 交回一段文字或文字、图片块数组。支持看图的模型可以接收图片块。
 * pi-ai 的 `TextContent` 是一块文字。
 * - `type: 'text'` 用来认出文字块。
 * - `text` 是正文。
 * - `textSignature` 可选，记录文字块的签名。
 * 全部字段见 node_modules/@earendil-works/pi-ai/dist/types.d.ts:252。
 * pi-ai 的 `ImageContent` 是一张图片。
 * - `type: 'image'` 用来认出图片块。
 * - `data` 是以 Base64 表示的图片数据。
 * - `mimeType` 表示图片格式，例如 `image/png`。
 * 全部字段见 node_modules/@earendil-works/pi-ai/dist/types.d.ts:266。
 */
export type ToolResult = string | (piAi.TextContent | piAi.ImageContent)[];


/** 一次工具调用的结果。 */
export interface ToolOutcome {
  /** 给模型看的文字。 */
  text: string;
  /** 给模型看的图片，没有时省略。`ImageContent` 的字段见本文件 L74。 */
  images?: piAi.ImageContent[];
  /** 是不是出错了。 */
  isError: boolean;
}


/** 事件 session/before-tool 的数据：关口共有的 session、stop，加上这次调用。 */
export interface ToolGate extends SessionGate {
  /**
   * pi-ai 的 `ToolCall` 是模型要求执行的一次调用。
   * - `type: 'toolCall'` 用来从回答的其他内容块里认出调用。
   * - `id` 是配对工具结果的调用号。
   * - `name` 是登记的工具名。
   * - `arguments` 是待校验的 `JsonObject`。
   * - `argumentsError` 可选，记录原始参数文本及解析问题。此时 `arguments` 为 `{}`。
   * - `namespace` 可选，是 OpenAI Responses 接口的工具命名空间。
   * 全部字段见 node_modules/@earendil-works/pi-ai/dist/types.d.ts:271。
   */
  call: piAi.ToolCall;
  /** 不让执行这一个的理由；谁不让执行谁写。没人写就放行。和 stop 不同：会话接着走。 */
  deny?: string;
}


/** 事件 session/after-tool 的数据：和 before-tool 同一份（已经执行过了，不再有 deny），多了执行的结果。 */
export type ToolDone = Omit<ToolGate, 'deny'> & {
  /** 执行的结果（没执行、被拦下、出错的也在这）。插件可以改它、换掉它，接进对话的是最后这一份。 */
  outcome: ToolOutcome;
};


/** 工具服务。 */
export class Tools extends cordis.Service {
  /** 登记表：工具名 → 工具，按登记的先后。 */
  private readonly specs = new Map<string, ToolSpec>();

  /**
   * 登记 tools 插件：把 Tools 作为服务挂到 Cordis 上，名字叫 tools（super(ctx, 'tools') 做的；以后用 ctx.tools 取）。
   * @param ctx Cordis 给的 ctx。
   */
  constructor(ctx: cordis.Context) {
    super(ctx, 'tools');
  }

  /**
   * 登记一个工具。登记它的那个插件被拔掉，这个工具自动撤掉。
   * @param spec 定义、给哪几种会话用、执行函数。
   * @throws 同名的登记第二次抛错。
   */
  register(spec: ToolSpec): void {
    const name = spec.definition.name;

    //G 同名的已经登记过 → 抛错，不悄悄盖掉。
    if (this.specs.has(name)) {
      throw new Error(`工具 ${name} 已经登记过了`);
    }

    //M 在服务的方法里，this.ctx 是调用方（登记工具的那个插件）的 ctx，所以这个清理挂在那个插件身上。
    const specs = this.specs;
    this.ctx.effect(() => {
      specs.set(name, spec);
      return () => {
        specs.delete(name);
      };
    });
  }

  /**
   * 这种会话能用的工具清单。
   * @param kind 会话的种类。
   * @returns 给模型看的 `Tool` 定义，按登记的先后。字段见本文件 L44。
   */
  listToolsForSessionKind(kind: string): piAi.Tool[] {
    //M 登记表里挑出这种会话能用的，只交出给模型看的定义。
    const all = [...this.specs.values()];
    const usable = all.filter((spec) => spec.sessionKinds.includes(kind));
    return usable.map((spec) => spec.definition);
  }

  /**
   * 执行模型要的一个工具。
   * @param call 模型要求的这次 `ToolCall`，字段见本文件 L100。
   * @param session 是哪场会话要执行。
   * @param signal 这一轮的停止信号（就是掐模型请求的那个），原样交给工具。
   * @returns 结果。不抛错：没执行、出错、被停止，都写在结果里给模型看。
   * 副作用：执行工具。
   */
  async execute(call: piAi.ToolCall, session: Session, signal: AbortSignal): Promise<ToolOutcome> {
    //==========================================================
    //M 关口三 检查会话和插件是否允许执行工具
    //==========================================================
    //G 会话被喊停了 → 这一批里后面的工具都不执行。
    if (session.row.state !== 'running') return { text: '未执行：停下来了', isError: true };

    //M 关口三，执行之前：挨个问 session/before-tool。不让执行这一个的写 gate.deny，要整场停下的写 gate.stop。没人管就放行。
    const gate: ToolGate = { session, call };
    await this.ctx.serial('session/before-tool', gate);

    //G 有插件喊停 → 这个工具不执行，会话停下；这一批后面的工具碰到开头那条守卫，也不执行。
    if (gate.stop !== undefined) {
      session.stop(gate.stop);
      return { text: `未执行：${gate.stop}`, isError: true };
    }

    //G 有插件不让执行这一个 → 理由给模型看，会话接着走。
    if (gate.deny !== undefined) return { text: `未执行：${gate.deny}`, isError: true };

    //G 没登记这个名字，或者这种会话不能用它。
    const spec = this.specs.get(call.name);
    if (spec === undefined || !spec.sessionKinds.includes(session.row.kind)) {
      return { text: `没有这个工具：${call.name}`, isError: true };
    }

    //==========================================================
    //M 校验参数并执行已放行的工具
    //==========================================================
    //T 跟踪：执行工具。结果接进对话时，打印插件会再打一行。
    const vars = {
      session: session.id,
      tool: call.name,
      args: call.arguments,
    };
    this.ctx.emit('trace', 'Tools.execute', 'trace.tools.execute', 'spec.run(args, session, signal, call.id)', vars);
    try {
      //M 模型给的参数是外面进来的，在这里照工具的定义校验一次；工具里面直接用。调用号原样交给工具。
      const args = piAi.validateToolArguments(spec.definition, call) as Record<string, unknown>;
      const result = await spec.run(args, session, signal, call.id);

      //==========================================================
      //M 整理工具输出，交给会话循环的关口四
      //==========================================================
      //M 工具交回一段文字：原样给模型。
      if (typeof result === 'string') return { text: result, isError: false };

      //M 工具交回几块：文字拼起来，图片单独挑出来。
      const text = piAi.contentText(result);
      /** 从工具结果里分出图片块。`ImageContent` 的字段见本文件 L74。 */
      const images = result.filter((block): block is piAi.ImageContent => {
        return block.type === 'image';
      });
      return { text, images, isError: false };
    } catch (error) {
      //G 点了停止、工具收到信号断开抛的错 → 记成“已停止”，不算工具出错。已经做了的不回滚。
      if (signal.aborted) return { text: '已停止：点了停止，工具没做完', isError: false };

      //M 参数不对、工具抛错，都不往外抛：原因当成结果给模型看，它自己决定怎么办。
      const reason = textModule.getErrorMessage(error);
      return { text: `出错：${reason}`, isError: true };
    }
  }
}
