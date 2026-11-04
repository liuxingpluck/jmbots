/**
 * 一次 run 一步要用的纯函数：步号、步数上限、上限回复，以及把判断的结论翻译成 StepResult。
 *
 * 为什么单独拿出来（docs/05_框架设计.md 6.1、6.5）：Engine 里原来是一个 for 循环一路跑到底，
 * 现在改成"一次 run 只做一步，下一步写成新的 execution 事件"。中间这几段只算一个数、拼一句话、
 * 把结论翻译成 StepResult，不碰数据库、不联网、没有副作用，所以单独放这里，干活执行器直接拿去用。
 *
 * 11-03 的事故在这里从类型上堵死：判断的理由（决策模型那串概率，像"block 0.54，done 0.30…"）
 * 只进 judge 事件和日志，绝不能发给用户。所以 nextFromJudgment 的入参里根本没有 reason 这个字段。
 */
import type * as executorModule from './Executor.ts';
import type * as judgeModule from './Judge.ts';


/** 流水里写谁做的：这几步都是干活执行器.run() 里得出的结论。 */
const TIMELINE_WHO = '干活执行器.run()';


/** block 时判断者没给话、模型也没回文字，回给用户的一句兜底。 */
const BLOCK_FALLBACK_REPLY = '（这件事我先停在这里）';


/**
 * 下一步的步号：原来的 for 循环计数器，改成从已走的步数算。
 * @param doneSteps 已经走了几步（事件表.countSteps(会话 ID) 数出来的）。
 * @returns 下一步的步号，从 1 数；一步没走时是 1。
 * 无副作用。
 */
export function nextStepNumber(doneSteps: number): number {
  return doneSteps + 1;
}


/**
 * 是不是已经走够了步数、该收尾：到了 maxSteps 就不再产生新的 execution 事件。
 * @param doneSteps 已经走了几步。
 * @param maxSteps 上限（config.yaml 的 engine.max_steps）。
 * @returns 走够了是 true；刚好走到上限也算走够。
 * 无副作用。
 */
export function overBudget(doneSteps: number, maxSteps: number): boolean {
  return doneSteps >= maxSteps;
}


/**
 * 走够步数时回给用户的话，原文照 Engine 里 for 循环结束后那句。
 * @param maxSteps 上限（config.yaml 的 engine.max_steps）。
 * @returns 一句中文：先停下，回"继续"能接着做。
 * 无副作用。
 */
export function budgetReply(maxSteps: number): string {
  return `走了 ${maxSteps} 步还没做完，先停下（config.yaml 的 engine.max_steps）。回一句“继续”就接着做。`;
}


/** 新 execution 事件里放的东西：下一步在这个会话里做、第几步、交给谁、上一步留下的话。 */
export interface ExecutionPayload {
  /** 会话 ID：下一步还在这个会话里做。 */
  sessionId: string;

  /** 下一步的步号，从 1 数。 */
  step: number;

  /** 转交给谁：只有 route 的结论才写，别的结论没有。 */
  target?: string;

  /** 上一步留给下一步的话：判断者的提醒、转交时的交代；没有就不写。 */
  note?: string;
}


/** nextFromJudgment 的入参：一次判断的结论，加上拼回复、拼新事件要用的上下文。 */
export interface NextFromJudgmentInput {
  /** 判断的结论：continue 接着做、route 转交、done 做完、ask_user 问用户、block 停下。 */
  action: judgeModule.Action;

  /** 转交给谁（action 是 route 时有）：机器人或智能体的名字。 */
  target?: string;

  /** 判断者给的话：接着做时的提醒、问用户时的问题、做完或叫停时回给用户的话；可以没有。 */
  message?: string;

  /** 模型这一步本身的回复；判断者没给话时拿它回用户。 */
  replyText: string;

  /** 会话 ID，写进新 execution 事件的 payload。 */
  sessionId: string;

  /** 已经走了几步：用来算下一步的步号，也用来判到了步数上限没有。 */
  doneSteps: number;

  /** 步数上限（config.yaml 的 engine.max_steps）。 */
  maxSteps: number;

  /** 留给下一步的话，写进新 execution 事件的 payload；没有就不写。 */
  note?: string;
}


/**
 * 把判断的结论翻译成一次 run 的结果（StepResult），规则照 docs/05_框架设计.md 6.2 的干活执行器那一行：
 * continue 写下一条 execution；route 写一条带 target 的 execution；done / ask_user / block 不产生事件，只回话。
 * @param input 判断结论和上下文。
 * @returns 状态、要发回去的话、下一步的新事件、要写进流水的行。
 * @throws action 是 route 却没有 target 时抛错：不知道该转交给谁，不能写一条没人认的事件。
 * 无副作用：不碰数据库、不联网、不读文件，只算结果。
 */
export function nextFromJudgment(input: NextFromJudgmentInput): executorModule.StepResult {
  //M 五种走法各翻译成一步的结果：一条一条写，不用嵌套三元。
  switch (input.action) {
    case 'continue': {
      //G 已经走满步数：不再写新事件，回一句让用户说“继续”的话收尾（6.1 节的步数上限）。
      if (overBudget(input.doneSteps, input.maxSteps)) {
        return {
          status: 'completed',
          reply: budgetReply(input.maxSteps),
          next: [],
          timeline: [{ who: TIMELINE_WHO, what: `判断 → 接着做，但已经走满 ${input.maxSteps} 步，不再写新事件，先收尾` }],
        };
      }
      /** 下一步的步号。 */
      const step = nextStepNumber(input.doneSteps);
      //M 接着做：写下一条 execution 事件，把留给下一步的话和步号带过去。
      return {
        status: 'completed',
        next: [{ type: 'execution', payload: { sessionId: input.sessionId, step, note: input.note } }],
        timeline: [{ who: TIMELINE_WHO, what: `判断 → 接着做，写下第 ${step} 步 execution 事件` }],
      };
    }
    case 'route': {
      //G 没有转交对象就不知道把事件交给谁，早点报错，别写一条没人认的事件。
      if (!input.target?.trim()) {
        throw new Error('route 没有 target：不知道要转交给谁');
      }
      /** 下一步的步号。 */
      const step = nextStepNumber(input.doneSteps);
      //M 转交：写下一条换了执行者的 execution 事件，payload 里带上 target。
      return {
        status: 'completed',
        next: [{ type: 'execution', payload: { sessionId: input.sessionId, step, note: input.note, target: input.target } }],
        timeline: [{ who: TIMELINE_WHO, what: `判断 → 转交给 ${input.target}，写下第 ${step} 步 execution 事件` }],
      };
    }
    case 'done':
      //M 做完：不产生事件，把话放进回复。
      return { status: 'completed', reply: replyFor(input), next: [], timeline: [{ who: TIMELINE_WHO, what: '判断 → 做完了，不写新事件，把话回给用户' }] };
    case 'ask_user':
      //M 要问用户：不产生事件，把问题放进回复，等用户下一句话。
      return { status: 'completed', reply: replyFor(input), next: [], timeline: [{ who: TIMELINE_WHO, what: '判断 → 要先问用户，不写新事件，把问题回给用户' }] };
    case 'block': {
      //M 叫停：不产生事件，把话放进回复。
      //G 判断的理由（那串概率）只在 judge 事件和日志里；入参里根本没有 reason，这里拿不到，也就发不出去。
      /** 回给用户的话：判断者的、模型的，再没有就用兜底。 */
      const reply = replyFor(input);
      return {
        status: 'completed',
        reply: reply.trim() === '' ? BLOCK_FALLBACK_REPLY : reply,
        next: [],
        timeline: [{ who: TIMELINE_WHO, what: '判断 → 叫停，不写新事件，把话回给用户' }],
      };
    }
  }
}


/**
 * 回给用户的话：判断者给了话就用它，否则用模型这一步的回复。
 * @param input 判断结论和上下文。
 * @returns 一句话；两边都没给时可能是空字符串，要兜底的调用方自己再判。
 * 无副作用。
 */
function replyFor(input: NextFromJudgmentInput): string {
  //G 判断者的话是空串或只有空白，算没给。
  if (input.message !== undefined && input.message.trim() !== '') {
    return input.message;
  }
  return input.replyText;
}
