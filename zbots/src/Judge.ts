/**
 * zbots 的“下一步判断”（照旧版 JMAI 的做法）：执行的 bot 每走完一步，由它的判断者看任务和这一步的结果，决定下一步怎么走。
 * 判断者有两种，bot 的 YAML 里 judge 写哪个就用哪个：
 * - decision：分类模型（config.yaml 的 models.decision，Jev）回答 next_step 这道选择题，选概率最大的；
 * - 别的 bot 的名字：把任务和这一步的结果交给那个 bot，它回一个 JSON。
 * 下一步有五种：continue 接着做，route 转交给别的 bot 接着做，done 做完了，ask_user 先问用户，block 停下。
 * 判断不出来（出错、回答不对）时按默认规则：这一步调了工具就接着做，没调就算做完。
 */
import type * as piAi from '@earendil-works/pi-ai';
import type * as bot from './Bot.ts';
import type * as log from './Log.ts';
import type * as model from './Model.ts';
import * as utils from './Utils.ts';


/** 下一步的五种走法。 */
const actions = ['continue', 'route', 'done', 'ask_user', 'block'] as const;


/** 下一步怎么走。 */
export type Action = (typeof actions)[number];


/** 一次判断的结论。 */
export interface Judgment {
  /** 下一步怎么走。 */
  action: Action;

  /** 理由；分类模型给的是各选项的概率。 */
  reason: string;

  /** 给执行 bot 的话：接着做时的提醒、转交时给新 bot 的任务、问用户时的问题。分类模型不写。 */
  message?: string;

  /** 转交给哪个 bot（action 是 route 时有）。 */
  agent?: string;
}


/** 判断要看的东西。 */
export interface JudgeInput {
  /** 模型调用入口。 */
  ai: model.Ai;

  /** 这一轮的任务。 */
  task: string;

  /** 刚走完的这一步：模型的回应和工具结果。 */
  step: log.StepRecord;

  /** 可以转交的 bot。 */
  routes: bot.BotDefinition[];
}


/**
 * 用分类模型判断下一步：config.yaml 的 next_step 选择题，再加上“转交给某个 bot”的选项（route:名字），选概率最大的。
 * @param input 任务、这一步、可以转交的 bot。
 * @param question next_step 的问法。
 * @returns 结论，以及要写进这一步记录的决策记录。
 * @throws next_step 不是选择题时抛错。
 */
export async function judgeByDecision(input: JudgeInput, question: piAi.ClassifierQuestion): Promise<{ judgment: Judgment; record: log.DecisionRecord }> {
  // g: next_step 得是选择题。
  if (question.type !== 'choice') {
    throw new Error('config.yaml 的 decision.questions.next_step 要写成 choice（选择题）。');
  }

  // m: 选项 = config 里的走法，加上每个能转交的 bot 一项。
  /** 全部选项：名字 → 什么情况选它。 */
  const criteria: Record<string, string> = { ...question.criteria };
  for (const route of input.routes) {
    criteria[`route:${route.name}`] = `该交给 ${route.name} 接着做：${route.description}`;
  }
  const output = await input.ai.decide({ state: describeStep(input), questions: { next_step: { ...question, criteria } } });

  // m: 选中的选项换成结论；出错或回答不对就按默认规则。
  /** 分类模型的回答。 */
  const answer = output.answers.next_step;
  /** 结论。 */
  let judgment = fallback(input.step, `决策模型没给出回答（${output.error ?? '回答不是选择题'}）`);
  if (!output.error && answer?.type === 'choice') {
    judgment = fromChoice(input, answer);
  }
  return { judgment, record: { about: '下一步怎么走', output, verdict: describeJudgment(judgment) } };
}


/**
 * 用另一个 bot 判断下一步：把任务、这一步和能转交的 bot 交给它，它只回一个 JSON。
 * 判断用 models.dispatch（快模型）。
 * @param input 任务、这一步、可以转交的 bot。
 * @param judge 判断的 bot。
 * @returns 结论，以及判断 bot 这次调模型的输出（由调用方单独记一步）。
 */
export async function judgeByBot(input: JudgeInput, judge: bot.BotDefinition): Promise<{ judgment: Judgment; chat: model.ChatOutput }> {
  /** 能转交的 bot，一行一个。 */
  const routeLines = input.routes.map((route) => `- ${route.name}：${route.description}`);
  /** 交给判断 bot 的话：情况、能转交的 bot、回复格式。 */
  const request = [
    '执行的智能体刚走完一步，请判断下一步怎么走。情况如下：',
    JSON.stringify(describeStep(input), null, 2),
    routeLines.length > 0 ? `可以转交的智能体：\n${routeLines.join('\n')}` : '没有可以转交的智能体。',
    '只回一个 JSON 对象，不要别的文字：{"action": "continue、route、done、ask_user、block 之一", "reason": "理由", "message": "给执行智能体的话，可以不写", "agent": "action 是 route 时写转交给谁"}',
  ].join('\n\n');
  const chat = await input.ai.chat({ role: 'dispatch', system: judge.system, messages: [{ role: 'user', content: request, timestamp: Date.now() }] });
  return { judgment: parseJudgment(input, chat), chat };
}


/**
 * 一次判断写成一句话，记进日志，如“route → 资料员：continue 0.20，route:资料员 0.75”。
 * @param judgment 结论。
 */
export function describeJudgment(judgment: Judgment): string {
  /** 转交给谁。 */
  const target = judgment.agent ? ` → ${judgment.agent}` : '';
  return `${judgment.action}${target}：${judgment.reason}`;
}


/**
 * 把任务和这一步写成给判断者看的情况；都截短，越短越快、越便宜。
 * @param input 任务和这一步。
 */
function describeStep(input: JudgeInput): piAi.JsonObject {
  /** 这一步的模型回应。 */
  const chat = input.step.chat;
  return {
    任务: utils.truncate(input.task, 2000),
    执行的智能体: input.step.kind,
    这一步的回复: utils.truncate(chat.text, 2000),
    这一步的思考摘录: utils.truncate(chat.thinking, 800),
    这一步调的工具: input.step.tools.map((tool) => ({
      工具: tool.call.name,
      参数: utils.truncate(JSON.stringify(tool.call.arguments), 500),
      结果: utils.truncate(tool.result, 1000),
      出错或被拦: tool.isError,
    })),
  };
}


/**
 * 把分类模型选的选项换成结论。
 * @param input 用来查能转交的 bot、按默认规则走。
 * @param answer 选择题的回答：选了哪个、各选项的概率。
 */
function fromChoice(input: JudgeInput, answer: piAi.ClassifierChoiceAnswer): Judgment {
  /** 各选项的概率，从高到低，写进理由。 */
  const reason = Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([choice, probability]) => `${choice} ${probability.toFixed(2)}`)
    .join('，');
  if (answer.choice.startsWith('route:')) {
    return { action: 'route', reason, agent: answer.choice.slice('route:'.length) };
  }
  if (isAction(answer.choice) && answer.choice !== 'route') {
    return { action: answer.choice, reason };
  }
  return fallback(input.step, `决策模型选了不认识的选项 ${answer.choice}`);
}


/**
 * 从判断 bot 的回复里读出结论。
 * @param input 用来查能转交的 bot、按默认规则走。
 * @param chat 判断 bot 的回复。
 * @returns 结论；出错、不是 JSON、动作不认识、要转交给不能转交的 bot 时按默认规则走。
 */
function parseJudgment(input: JudgeInput, chat: model.ChatOutput): Judgment {
  if (chat.error) {
    return fallback(input.step, `判断的智能体出错（${chat.error}）`);
  }
  // m: 取回复里第一个 { 到最后一个 } 之间的部分：模型有时会在 JSON 前后多说几句。
  /** JSON 正文。 */
  const jsonText = chat.text.slice(chat.text.indexOf('{'), chat.text.lastIndexOf('}') + 1);
  /** 读出的 JSON；字段在下面逐个检查。 */
  let parsed: Partial<Record<'action' | 'reason' | 'message' | 'agent', unknown>>;
  try {
    parsed = JSON.parse(jsonText) as typeof parsed;
  } catch {
    return fallback(input.step, '判断的智能体回的不是 JSON');
  }

  // g: 动作要认识；转交要转给能转交的 bot。
  /** 动作。 */
  const action = typeof parsed.action === 'string' ? parsed.action : '';
  if (!isAction(action)) {
    return fallback(input.step, `判断的智能体回的动作不认识：${action}`);
  }
  /** 转交给谁。 */
  const agent = typeof parsed.agent === 'string' ? parsed.agent : undefined;
  if (action === 'route' && !input.routes.some((route) => route.name === agent)) {
    return fallback(input.step, `判断的智能体要转交给 ${agent ?? '（没写）'}，但不能转交给它`);
  }
  return {
    action,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    message: typeof parsed.message === 'string' && parsed.message ? parsed.message : undefined,
    agent: action === 'route' ? agent : undefined,
  };
}


/**
 * 判断不出来时的默认走法：这一步调了工具就接着做（结果模型还没看），没调就算做完。
 * @param step 这一步。
 * @param why 为什么判断不出来，写进理由。
 */
function fallback(step: log.StepRecord, why: string): Judgment {
  return { action: step.tools.length > 0 ? 'continue' : 'done', reason: `${why}，按默认规则走` };
}


/**
 * 是不是五种走法之一。
 * @param value 要看的字符串。
 */
function isAction(value: string): value is Action {
  return (actions as readonly string[]).includes(value);
}
