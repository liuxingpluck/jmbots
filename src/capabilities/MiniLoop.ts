/**
 * 小循环（docs/10 6.8）：常规模型带只读工具跑几步，最后只回一个 JSON；程序核对，不过就在后面追加
 * “哪里不对”重跑，最多 2 次。分派的第 2 档（src/dispatch/Dispatch.ts）、exec 审核的第 2 档
 * （src/executors/ExecReview.ts）都用它。
 * 从不抛错：模型出错、步数用完、核对一直不过，都写进 error；每一步做了什么都在 steps 里，
 * 分派记录和审核记录照它写。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as checks from '../utils/Checks.ts';
import * as utils from '../utils/Utils.ts';
import type * as model from './Model.ts';
import type * as secretsModule from './Secrets.ts';
import type * as toolsModule from './tools/Tools.ts';


/** 一次小循环要给的东西。 */
export interface MiniLoopRequest {
  /** 用哪个模型（供应商/模型 ID）。 */
  model: string;
  /** 思考档；不写用 config 里这个模型那一项的。 */
  thinking?: string;
  /** 系统提示词全文。 */
  system: string;
  /** 第一条输入（分派的现状、审核的命令说明）。 */
  input: string;
  /** 能用的工具定义；空数组就是一次调用。 */
  tools: piAi.Tool[];
  /** 执行工具的执行环境（工具库的 ToolContext）。 */
  toolContext: toolsModule.ToolContext;
  /**
   * 工具库：模型调的工具都交给它的 run 执行
   * （src/capabilities/tools/Tools.ts 的 ToolBox，入口 src/entries/App.ts 建的）。
   */
  toolBox: toolsModule.ToolBox;
  /** 最多调几步工具（docs/10：6 步）。 */
  maxSteps: number;
  /**
   * 核对模型回的 JSON：输出哪里不对，对了返回 undefined。
   * 分派传的写在 src/dispatch/Dispatch.ts（Dispatcher 的 askModel、forceDispatch 里，调同类的 `check`）；
   * 审核传的写在 src/executors/ExecReview.ts 的 askLlm 里。
   */
  check: (value: Record<string, unknown>) => string | undefined;
  /** 程序追加的那几句话用哪种语言。 */
  language: 'zh' | 'en';
  /** 用量表里记成谁调的（docs/15_用量表.md）：分派写 dispatch，命令审核写 exec-review；不写记 other。 */
  purpose?: string;
  /** 只读事件关联；调用方准备快照，不改变小循环的执行与模型选择。 */
  trace?: model.CallTrace;
}


/** 小循环的一步。 */
export interface MiniStep {
  /** 开始时间，毫秒。 */
  at: number;
  /** 用时，毫秒。 */
  ms: number;
  /** 这一步实际用的思考强度。 */
  effort: string;
  /** 模型回的文字。 */
  text: string;
  /** 模型的思考。 */
  thinking: string;
  /** 调了哪些工具：名字、参数、结果（过了密钥替身）、是不是出错。 */
  calls: { name: string; args: unknown; result: string; isError: boolean }[];
  /** 这一步出的错：模型出错，或者核对不过的原因。 */
  error?: string;
}


/** 小循环的结果。 */
export interface MiniLoopResult {
  /** 核对通过的 JSON；没通过时没有。 */
  value?: Record<string, unknown>;
  /** 每一步。 */
  steps: MiniStep[];
  /** 重跑了几次（核对不过追加“哪里不对”再问）。 */
  reruns: number;
  /** 发出去的请求（给记录看）：模型、思考档、系统提示词、第一条输入、工具名。 */
  request: {
    model: string;
    thinking?: string;
    system: string;
    input: string;
    tools: string[];
  };
  /** 最后没成的原因；成了没有。 */
  error?: string;
}


/** 核对不过最多重跑几次。 */
const MAX_RERUNS = 2;


/** 程序写进对话的几句话（docs/10 7.4）。 */
const WORDS = {
  zh: {
    rerun: (problem: string) => `（程序）你的回答没通过核对：${problem}。只回一个改好的 JSON。`,
    notJson: '没有回一个 JSON 对象',
    noMoreTools: '未执行：工具步数用完了，不能再调工具，直接回 JSON。',
  },
  en: {
    rerun: (problem: string) =>
      `(program) Your answer failed the check: ${problem}. Reply with one corrected JSON object only.`,
    notJson: 'the reply is not one JSON object',
    noMoreTools: 'Not executed: no tool steps left; reply with the JSON now.',
  },
};


/** 小循环：一个进程建一个就够（没有自己的状态），分派和审核拿着同一个用。 */
export class MiniLoop {
  /**
   * @param ai 调模型（src/capabilities/Model.ts 的 Ai，入口 src/entries/App.ts 建的那一个）。
   * @param secrets 工具结果进对话前抹掉密钥（src/capabilities/Secrets.ts）。
   */
  constructor(
    private readonly ai: model.Ai,
    private readonly secrets: secretsModule.Secrets,
  ) {}


  /**
   * 跑一次小循环。
   * @param request 要给的东西。
   * @returns 结果；从不抛错。
   * 副作用：调模型；执行 request.toolBox 的工具（分派只读，审核可读文件）。
   */
  async askJson(request: MiniLoopRequest): Promise<MiniLoopResult> {
    /** 记录：每一步、重跑了几次、发出去的请求。 */
    const result: MiniLoopResult = {
      steps: [],
      reruns: 0,
      request: {
        model: request.model,
        thinking: request.thinking,
        system: request.system,
        input: request.input,
        tools: request.tools.map((tool) => tool.name),
      },
    };
    /** 程序写进对话的话，用这次的语言。 */
    const words = WORDS[request.language];
    /** 对话（不含系统提示词），第一条是输入。 */
    const messages: piAi.Message[] = [
      { role: 'user', content: request.input, timestamp: Date.now() },
    ];
    /** 已经调了几步工具。 */
    let toolSteps = 0;

    try {
      //M 一步一步：调模型 → 有工具就执行再来 → 没工具就取 JSON 核对，不过就追加“哪里不对”重跑。
      for (;;) {
        /** 这一步开始的时间。 */
        const at = Date.now();
        /** 调模型的入参。 */
        const chatArgs = {
          model: request.model,
          thinking: request.thinking,
          system: { prompt: request.system },
          messages,
          tools: request.tools,
          purpose: request.purpose,
          bot: request.toolContext.bot,
          sessionId: request.toolContext.sessionId,
          trace: request.trace,
        };

        /** 模型的回复。 */
        const output = await this.ai.chat(chatArgs);
        /** 这一步的记录。 */
        const step: MiniStep = {
          at,
          ms: output.ms,
          effort: output.request.thinking,
          text: output.text,
          thinking: output.thinking,
          calls: [],
        };
        result.steps.push(step);
        if (output.error) {
          step.error = output.error;
          result.error = `模型出错：${output.error}`;
          return result;
        }
        messages.push(output.message);

        //M 1. 要调工具：步数没用完就一个个执行；用完了就告诉它直接回 JSON。
        if (output.toolCalls.length > 0) {
          /** 这一步还能不能调工具。 */
          const allowed = toolSteps < request.maxSteps;
          toolSteps += 1;
          await this.runTools(request, output.toolCalls, allowed, step, messages);
          if (!allowed && toolSteps > request.maxSteps + 1) {
            result.error = `走了 ${request.maxSteps} 步工具还在调工具，没回 JSON`;
            return result;
          }
          continue;
        }

        //M 2. 不调工具了：取 JSON 核对，过了就交回去。
        /** 回的 JSON。 */
        const value = checks.extractJson(output.text);
        /** 哪里不对；对了是 undefined。 */
        const problem = value ? request.check(value) : words.notJson;
        if (!problem && value) {
          result.value = value;
          return result;
        }

        //M 3. 没过：重跑次数用完就算了；没用完就追加“哪里不对”再问一次。
        step.error = problem;
        if (result.reruns >= MAX_RERUNS) {
          result.error = `重跑 ${MAX_RERUNS} 次还没通过核对：${problem ?? words.notJson}`;
          return result;
        }
        result.reruns += 1;
        /** 追加的那句话。 */
        const rerunText = words.rerun(problem ?? words.notJson);
        messages.push({ role: 'user', content: rerunText, timestamp: Date.now() });
      }
    } catch (error) {
      //G 模型 ID 不在清单里等会抛错：也记下来，不往外抛。
      result.error = utils.errorText(error);
      return result;
    }
  }


  /**
   * 执行模型这一步要调的工具：结果抹掉密钥，记进这一步，接到对话后面。
   * @param request 这次小循环的请求（toolBox、toolContext 从这里拿）。
   * @param calls 模型要调的工具。
   * @param allowed 步数还没用完。用完了就不执行，回一句“步数用完了，直接回 JSON”。
   * @param step 这一步的记录（往 calls 里加）。
   * @param messages 对话（往后面接工具结果）。
   * 副作用：执行工具；改 step 和 messages。
   */
  private async runTools(
    request: MiniLoopRequest,
    calls: piAi.ToolCall[],
    allowed: boolean,
    step: MiniStep,
    messages: piAi.Message[],
  ): Promise<void> {
    /** 程序写进对话的话，用这次的语言。 */
    const words = WORDS[request.language];
    for (const call of calls) {
      /** 工具的结果；步数用完时是那句提示。 */
      let done = { text: words.noMoreTools, isError: true };
      if (allowed) {
        done = await request.toolBox
          .run(call.name, call.arguments, request.toolContext)
          .catch((error: unknown) => ({ text: utils.errorText(error), isError: true }));
      }

      /** 抹过密钥的结果。 */
      const text = this.secrets.mask(done.text);
      step.calls.push({
        name: call.name,
        args: call.arguments,
        result: text,
        isError: done.isError,
      });
      messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text }],
        isError: done.isError,
        timestamp: Date.now(),
      });
    }
  }
}
