/**
 * 每走完一步的判断（照旧版 JMAI 的做法）：看任务和这一步的结果，决定下一步怎么走。
 * 用户原话：“每次在一步执行完后，根据结果判断是否继续执行，又或者走新的智能体执行；判断可以是分类模型，也可以是其他智能体判断。”
 *
 * 机器人、智能体的 config.yaml 里 judge 写哪种就用哪种：
 *   rule      简单规则：这一步调了工具就接着做（模型还没看到结果），没调就算做完。默认就是它。
 *   decision  决策模型（config.yaml 的 models.decision）回答 decision.questions.next_step 这道选择题，再加上“转交给某某”的选项。
 *   别的名字   交给那个智能体判断，它回一个 JSON。
 * 下一步有五种：continue 接着做、route 转交给别人接着做、done 做完了、ask_user 先问用户、block 停下。
 * 判断不出来（出错、回答不对）时按简单规则走，原因写进理由。
 *
 * 来源：旧 zbots 模块的 Judge（2026-11-04 已删，要看去 git 历史），改成用 jmbots 的角色和模型调用。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as checks from '../utils/Checks.ts';
import * as utils from '../utils/Utils.ts';
import type * as modelModule from '../capabilities/Model.ts';
import type * as resourcesModule from '../resources/Resources.ts';


/** 下一步的五种走法。 */
const ACTIONS = ['continue', 'route', 'done', 'ask_user', 'block'] as const;


/** 下一步怎么走。 */
export type Action = (typeof ACTIONS)[number];


/** 一次判断的结论。 */
export interface Judgment {
  /** 下一步怎么走。 */
  action: Action;

  /** 理由；决策模型给的是各选项的概率。 */
  reason: string;

  /** 给执行者的话：接着做时的提醒、转交时给新执行者的任务、问用户时的问题。可以没有。 */
  message?: string;

  /** 转交给谁（action 是 route 时有）：机器人或智能体的名字。 */
  target?: string;

  /** 谁判断的：rule、decision 或判断智能体的名字。 */
  by: string;
}


/** 一步的工具调用摘要，给判断者看。 */
export interface ToolSummary {
  /** 工具名。 */
  name: string;

  /** 参数。 */
  arguments: unknown;

  /** 结果（转成文字、截短）。 */
  result: string;

  /** 出错或被拒绝。 */
  isError: boolean;
}


/** 判断要看的东西。 */
export interface JudgeInput {
  /** 模型。 */
  ai: modelModule.Ai;

  /** 资源。 */
  resources: resourcesModule.Resources;

  /** 执行者；只给模型时是 undefined（只能按简单规则判断）。 */
  role?: resourcesModule.RoleInfo;

  /** 执行者的名字（机器人、智能体的名字或模型 ID），写进给判断者看的情况。 */
  actorName: string;

  /** 这次执行的任务原文。 */
  task: string;

  /** 这一步模型回复的文字。 */
  text: string;

  /** 这一步模型的思考（没有时是空字符串）。 */
  thinking: string;

  /** 这一步的工具调用。 */
  tools: ToolSummary[];
}


/** 判断的结果：结论，加上判断时调模型的原样输出（记进数据库）。 */
export interface JudgeOutput {
  /** 结论。 */
  judgment: Judgment;

  /** 决策模型的输出（用决策模型判断时有）。 */
  decision?: modelModule.DecideOutput;

  /** 判断智能体的输出（用智能体判断时有）。 */
  chat?: modelModule.ChatOutput;
}


/**
 * 判断下一步怎么走。
 * @param input 模型、资源、执行者、任务、这一步。
 */
export async function judge(input: JudgeInput): Promise<JudgeOutput> {
  /** 判断方式；只给模型时用简单规则。 */
  const by = input.role?.judge ?? 'rule';
  /** 判断出来的结果。 */
  let output: JudgeOutput;

  //M 1. 按判断方式问。
  if (by === 'rule') {
    output = { judgment: byRule(input, '简单规则') };
  } else if (by === 'decision') {
    output = await byDecision(input);
  } else {
    output = await byAgent(input, by);
  }

  //G 2. 这一步调了工具，模型还没看到结果，不能算做完：改成接着做。
  if (input.tools.length > 0 && (output.judgment.action === 'done' || output.judgment.action === 'ask_user')) {
    output.judgment = { ...output.judgment, action: 'continue', reason: `${output.judgment.reason}（这一步调了工具，模型还没看到结果，接着做）` };
  }
  return output;
}


/**
 * 简单规则：调了工具就接着做，没调就算做完。
 * @param input 这一步。
 * @param reason 理由。
 */
function byRule(input: JudgeInput, reason: string): Judgment {
  if (input.tools.length > 0) {
    return { action: 'continue', reason, by: 'rule' };
  }
  return { action: 'done', reason, by: 'rule' };
}


/**
 * 能转交的对象：执行者 config.yaml 里 routes 写的名字，先找机器人，再找智能体。
 * @param input 资源和执行者。
 */
function routeTargets(input: JudgeInput): resourcesModule.RoleInfo[] {
  /** 结果。 */
  const targets: resourcesModule.RoleInfo[] = [];
  for (const name of input.role?.routes ?? []) {
    /** 同名的机器人或智能体。 */
    const found = input.resources.listRoles('bot').find((bot) => bot.name === name) ?? input.resources.listRoles('agent').find((agent) => agent.name === name);
    if (found) {
      targets.push(found);
    }
  }
  return targets;
}


/**
 * 把任务和这一步写成给判断者看的情况；都截短，越短越快、越便宜。
 * @param input 任务和这一步。
 */
function describeStep(input: JudgeInput): piAi.JsonObject {
  return {
    任务: utils.truncate(input.task, 2000),
    执行者: input.actorName,
    这一步的回复: utils.truncate(input.text, 2000),
    这一步的思考摘录: utils.truncate(input.thinking, 800),
    这一步调的工具: input.tools.map((tool) => ({
      工具: tool.name,
      参数: utils.truncate(JSON.stringify(tool.arguments), 500),
      结果: utils.truncate(tool.result, 1000),
      出错或被拒绝: tool.isError,
    })),
  };
}


/**
 * 用决策模型判断：config.yaml 的 next_step 选择题，加上每个能转交的对象一项（route:名字），选概率最大的。
 * @param input 判断要看的东西。
 */
async function byDecision(input: JudgeInput): Promise<JudgeOutput> {
  /** next_step 的问法。 */
  const question = input.resources.getQuestion('next_step') as piAi.ClassifierQuestion | undefined;
  //G 没配决策模型、没写 next_step 或不是选择题，就按简单规则。
  if (!input.ai.hasDecision() || !question || question.type !== 'choice') {
    return { judgment: byRule(input, '没配决策模型或 decision.questions.next_step（要写成选择题），按简单规则') };
  }

  //M 选项 = config 里的走法 + 每个能转交的对象。
  /** 全部选项：名字 → 什么情况选它。 */
  const criteria: Record<string, string> = { ...question.criteria };
  for (const target of routeTargets(input)) {
    criteria[`route:${target.name}`] = `该交给 ${target.name} 接着做：${target.description}`;
  }
  /** 决策模型的输出。 */
  const decision = await input.ai.decide({ state: describeStep(input), questions: { next_step: { ...question, criteria } } });
  /** 回答。 */
  const answer = decision.answers.next_step;
  if (decision.error || answer?.type !== 'choice') {
    return { judgment: byRule(input, `决策模型没给出回答（${decision.error ?? '回答不是选择题'}），按简单规则`), decision };
  }

  //M 选中的选项换成结论；理由写各选项的概率，从高到低。
  /** 理由。 */
  const reason = Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([choice, probability]) => `${choice} ${probability.toFixed(2)}`)
    .join('，');
  if (answer.choice.startsWith('route:')) {
    return { judgment: { action: 'route', reason, target: answer.choice.slice('route:'.length), by: 'decision' }, decision };
  }
  if ((ACTIONS as readonly string[]).includes(answer.choice) && answer.choice !== 'route') {
    return { judgment: { action: answer.choice as Action, reason, by: 'decision' }, decision };
  }
  return { judgment: byRule(input, `决策模型选了不认识的选项 ${answer.choice}，按简单规则`), decision };
}


/**
 * 用另一个智能体判断：把情况和能转交的对象交给它，它只回一个 JSON。
 * @param input 判断要看的东西。
 * @param judgeName 判断智能体的名字。
 */
async function byAgent(input: JudgeInput, judgeName: string): Promise<JudgeOutput> {
  /** 判断智能体。 */
  const judgeRole = input.resources.listRoles('agent').find((agent) => agent.name === judgeName);
  if (!judgeRole) {
    return { judgment: byRule(input, `没有判断智能体 ${judgeName}，按简单规则`) };
  }
  /** 能转交的对象。 */
  const targets = routeTargets(input);
  /** 交给判断智能体的话。 */
  const request = [
    '执行者刚走完一步，请判断下一步怎么走。情况如下：',
    JSON.stringify(describeStep(input), null, 2),
    targets.length > 0 ? `可以转交的对象：\n${targets.map((target) => `- ${target.name}：${target.description}`).join('\n')}` : '没有可以转交的对象。',
    '只回一个 JSON 对象，不要别的文字：{"action": "continue、route、done、ask_user、block 之一", "reason": "理由", "message": "给执行者的话，可以不写", "target": "action 是 route 时写转交给谁"}',
  ].join('\n\n');
  /** 判断智能体的回复。 */
  const chat = await input.ai.chat({
    model: judgeRole.model ?? input.resources.getModelChoice('dispatch')?.model ?? input.resources.getDefaultModel() ?? '',
    thinking: judgeRole.thinking,
    system: judgeRole.system,
    messages: [{ role: 'user', content: request, timestamp: Date.now() }],
    tools: [],
  });
  if (chat.error) {
    return { judgment: byRule(input, `判断智能体出错（${chat.error}），按简单规则`), chat };
  }

  //M 读 JSON，逐项核对。
  /** 回答。 */
  const answer = checks.extractJson(chat.text);
  /** 走法。 */
  const action = answer?.action;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return { judgment: byRule(input, '判断智能体的回答读不出走法，按简单规则'), chat };
  }
  /** 理由。 */
  const reason = typeof answer?.reason === 'string' ? answer.reason : '';
  /** 给执行者的话。 */
  const message = typeof answer?.message === 'string' && answer.message.trim() ? answer.message : undefined;
  /** 转交给谁。 */
  const target = typeof answer?.target === 'string' ? answer.target : undefined;
  //G 转交对象必须在 routes 里。
  if (action === 'route' && !targets.some((item) => item.name === target)) {
    return { judgment: byRule(input, `判断智能体要转交给不能转交的 ${String(target)}，按简单规则`), chat };
  }
  return { judgment: { action: action as Action, reason, message, target, by: judgeName }, chat };
}
