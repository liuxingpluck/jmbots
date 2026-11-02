/**
 * zbots 的执行：一轮 = 处理一条消息的全过程；一步 = 调一次执行模型，加上它要的工具调用。照旧版 JMAI 的做法：
 * 每走完一步，由执行 bot 的判断者（分类模型或别的 bot，见 Judge.ts）看结果决定下一步：
 * 接着做；转交给别的 bot 接着做（上下文共用）；或者停下回复（做完、要问用户、判断者叫停）。
 * 调 config.yaml 的 decision.check_tools 里的工具（shell、edit）之前，先问决策模型“安全吗”，不安全就不执行。
 * 上下文边走边存进对话的 context.jsonl，下一条消息接着用；每一步写记录（Log.ts）。压缩还没接上。
 */
import type * as piAi from '@earendil-works/pi-ai';
import type * as bot from './Bot.ts';
import * as judge from './Judge.ts';
import * as log from './Log.ts';
import * as memory from './Memory.ts';
import type * as model from './Model.ts';
import type * as runtime from './Runtime.ts';
import * as utils from './Utils.ts';


/** 一个工具：给模型看的说明，加上真正执行的函数。 */
export interface AgentTool {
  /** 给模型看的名字、说明、参数格式。 */
  definition: piAi.Tool;

  /**
   * 执行工具。
   * @param args 模型给的参数。
   * @returns 交给模型的结果文字。
   * @throws 出错就抛，错误信息原样交给模型。
   */
  execute(args: piAi.JsonObject): Promise<string>;
}


/** 执行要用的设置，由 readSettings 从 config.yaml 的 agent、decision 读出来。 */
export interface AgentSettings {
  /** 一轮最多调几次执行模型，到了就停下。 */
  maxSteps: number;

  /** 调这些工具之前问“安全吗”。 */
  checkTools: string[];

  /** “安全”的概率低于这个数，这次工具调用就不执行。 */
  passProbability: number;

  /** 一轮里被拦超过这么多次，就停下把情况回给用户。 */
  maxBlocks: number;

  /** “安全吗”的问法（tool_safe）。 */
  toolSafe: piAi.ClassifierQuestion;

  /** “下一步怎么走”的问法（next_step）。 */
  nextStep: piAi.ClassifierQuestion;
}


/** 跑一轮要的东西。 */
export interface RoundInput {
  /** 模型调用入口。 */
  ai: model.Ai;

  /** 在哪个对话里跑：上下文从它读、往它存，每一步的记录也写进它的文件夹。 */
  conversation: memory.Conversation;

  /** 全部 bot（Bot.ts 的 loadBots）；转交和判断时按名字找。 */
  bots: Record<string, bot.BotDefinition>;

  /** 先由哪个 bot 执行。 */
  botName: string;

  /** 这一轮的任务：用户说的话。 */
  task: string;

  /** 全部工具；每个 bot 只用它 YAML 里 tools 列出的。 */
  tools: AgentTool[];

  /** 执行设置。 */
  settings: AgentSettings;
}


/** 一轮的结果。 */
export interface RoundResult {
  /** 回给用户的话。 */
  reply: string;

  /** 怎么停下的：done、ask_user、block，或者 error（模型出错、被拦太多次、走到步数上限）。 */
  ending: string;

  /** 这一轮执行模型走了几步（判断 bot 的不算）。 */
  steps: number;
}


/**
 * 从配置里读出执行设置，缺了就停下说清楚。
 * @param config config.yaml 的内容。
 * @throws 缺 agent、decision 段，或 decision.questions 里缺 tool_safe、next_step 时抛错。
 */
export function readSettings(config: runtime.Config): AgentSettings {
  if (!config.agent || !config.decision) {
    throw new Error('config.yaml 缺 agent 或 decision 段，照 config.example.yaml 补上。');
  }
  /** 决策问题；YAML 里可能整段没写。 */
  const questions = config.decision.questions as runtime.DecisionConfig['questions'] | undefined;
  /** 安全门的问法。 */
  const toolSafe = questions?.tool_safe;
  /** 每步判断的问法。 */
  const nextStep = questions?.next_step;
  if (!toolSafe || !nextStep) {
    throw new Error('config.yaml 的 decision.questions 里要有 tool_safe 和 next_step，照 config.example.yaml 补上。');
  }
  return {
    maxSteps: config.agent.max_steps,
    checkTools: config.decision.check_tools,
    passProbability: config.decision.pass_probability,
    maxBlocks: config.decision.max_blocks,
    toolSafe,
    nextStep,
  };
}


/**
 * 跑一轮：接着对话的上下文，把任务交给执行 bot，每走完一步由判断者决定下一步，直到停下。
 * @param input 模型、对话、bot、任务、工具、设置。
 * @returns 回复、怎么停下的、走了几步。模型出错等情况不抛错，ending 是 error，reply 是给用户看的说明。
 * @throws 找不到要用的 bot 时抛错。
 * 副作用：往 context.jsonl 追加这一轮的消息；每一步写记录文件，更新 对话.yaml 和工作区索引。
 */
export async function runRound(input: RoundInput): Promise<RoundResult> {
  // m: 接着上次的上下文，加上这次的任务。
  /** 发给执行模型的上下文，一轮里越走越长。 */
  const context = await memory.loadContext(input.conversation);
  await addMessages(input.conversation, context, [userMessage(input.task)]);

  /** 现在由哪个 bot 执行；判断说转交就换。 */
  let current = findBot(input.bots, input.botName);
  /** 这一轮被安全门拦下的工具调用次数。 */
  let blocks = 0;
  for (let step = 1; step <= input.settings.maxSteps; step++) {
    // m: 调执行模型，只给这个 bot 能用的工具。
    /** 这个 bot 能用的工具。 */
    const tools = input.tools.filter((tool) => current.tools.includes(tool.definition.name));
    const chat = await input.ai.chat({ role: 'work', system: current.system, messages: context, tools: tools.map((tool) => tool.definition) });
    /** 这一步的记录。 */
    const record: log.StepRecord = { kind: `执行（${current.name}）`, chat, decisions: [], tools: [] };
    if (chat.error) {
      await log.writeStep(input.conversation, record);
      return { reply: `出错了，这一轮先停下：${chat.error}`, ending: 'error', steps: step };
    }

    // m: 执行工具：调 check_tools 里的工具之前先问“安全吗”，不安全就不执行，告诉模型被拦了。
    /** 交回模型的工具结果。 */
    const results: piAi.Message[] = [];
    for (const call of chat.toolCalls) {
      /** 这次调用安不安全；不用检查的工具算安全。 */
      const safe = await checkSafety(input, current, call, record);
      if (!safe) {
        blocks += 1;
      }
      /** 这次调用的记录。 */
      const toolRecord = await runTool(tools, call, safe);
      record.tools.push(toolRecord);
      results.push(toolResult(toolRecord));
    }

    // m: 判断下一步，写下这一步，把模型的回应和工具结果接进上下文。
    const judgment = await judgeStep(input, current, record);
    await addMessages(input.conversation, context, [chat.message, ...results]);

    // g: 一轮里被拦太多次就停下，把情况回给用户。
    if (blocks > input.settings.maxBlocks) {
      return { reply: `这一轮有 ${blocks} 个操作被决策模型判为不安全，先停下来。\n${chat.text}`, ending: 'error', steps: step };
    }

    // m: 按判断走。这一步调了工具时，判断说 done 也接着走：工具结果模型还没看，这时的文字不是最终回复。
    /** 实际的走法。 */
    const action = judgment.action === 'done' && chat.toolCalls.length > 0 ? 'continue' : judgment.action;
    if (action === 'done') {
      return { reply: chat.text || '（模型没有给出文字回复）', ending: 'done', steps: step };
    }
    if (action === 'ask_user') {
      return { reply: judgment.message ?? (chat.text || '（需要你补充信息）'), ending: 'ask_user', steps: step };
    }
    if (action === 'block') {
      return { reply: `判断者叫停了：${judgment.reason}\n${chat.text}`, ending: 'block', steps: step };
    }
    if (action === 'route' && judgment.agent) {
      // m: 转交：下一步换成新 bot 执行，上下文共用；交接的话接进上下文。
      /** 转交前的 bot。 */
      const previous = current.name;
      current = findBot(input.bots, judgment.agent);
      await addMessages(input.conversation, context, [userMessage(`（${previous} 把任务转交给 ${current.name}。${judgment.message ?? '请接着完成上面的任务。'}）`)]);
      continue;
    }
    // m: 接着做：判断者有提醒就接进上下文；这一步没调工具时要催一句，不然模型看到的上下文没有新东西。
    if (judgment.message || chat.toolCalls.length === 0) {
      await addMessages(input.conversation, context, [userMessage(`（${judgment.message ?? '还没做完，请接着做。'}）`)]);
    }
  }
  return { reply: `走了 ${input.settings.maxSteps} 步还没做完，先停下。`, ending: 'error', steps: input.settings.maxSteps };
}


/**
 * 判断下一步，并写下这一步的记录。
 * 分类模型的问答记在这一步里，所以先判断再写；判断 bot 调了一次模型，单独记一步，写在这一步后面。
 * @param input 这一轮的输入。
 * @param current 执行这一步的 bot。
 * @param record 这一步的记录。
 * @returns 判断的结论。
 */
async function judgeStep(input: RoundInput, current: bot.BotDefinition, record: log.StepRecord): Promise<judge.Judgment> {
  /** 判断要看的东西。 */
  const judgeInput: judge.JudgeInput = {
    ai: input.ai,
    task: input.task,
    step: record,
    routes: current.routes.map((name) => findBot(input.bots, name)),
  };
  if (current.judge === 'decision') {
    const decided = await judge.judgeByDecision(judgeInput, input.settings.nextStep);
    record.decisions.push(decided.record);
    await log.writeStep(input.conversation, record);
    return decided.judgment;
  }
  await log.writeStep(input.conversation, record);
  /** 判断的 bot。 */
  const judgeBot = findBot(input.bots, current.judge);
  const judged = await judge.judgeByBot(judgeInput, judgeBot);
  /** 判断 bot 这一步的记录：它回的 JSON 就在“回复”里。 */
  const judgeRecord: log.StepRecord = { kind: `判断（${judgeBot.name}）`, chat: judged.chat, decisions: [], tools: [] };
  await log.writeStep(input.conversation, judgeRecord);
  return judged.judgment;
}


/**
 * 调 check_tools 里的工具之前问决策模型“安全吗”，问答写进这一步的记录。
 * @param input 这一轮的输入。
 * @param current 执行的 bot。
 * @param call 要调的工具。
 * @param record 这一步的记录。
 * @returns 安全为 true；不用检查的工具直接是 true。决策模型出错或没回答算不安全，宁可拦下。
 */
async function checkSafety(input: RoundInput, current: bot.BotDefinition, call: piAi.ToolCall, record: log.StepRecord): Promise<boolean> {
  if (!input.settings.checkTools.includes(call.name)) {
    return true;
  }
  /** 给决策模型看的情况，都截短。 */
  const state: piAi.JsonObject = {
    任务: utils.truncate(input.task, 1000),
    执行的智能体: current.name,
    这一步的思考摘录: utils.truncate(record.chat.thinking, 800),
    工具: call.name,
    参数: utils.truncate(JSON.stringify(call.arguments), 1500),
  };
  const output = await input.ai.decide({ state, questions: { tool_safe: input.settings.toolSafe } });
  /** 决策模型的回答。 */
  const answer = output.answers.tool_safe;
  /** “安全”的概率；出错或没回答当作 0。 */
  const probability = !output.error && answer?.type === 'bool' ? answer.probability : 0;
  /** 过没过。 */
  const safe = probability >= input.settings.passProbability;
  record.decisions.push({
    about: `${call.name} 安全吗`,
    output,
    verdict: safe ? `放行（安全 ${probability.toFixed(2)}）` : `拦下（安全 ${probability.toFixed(2)}，低于 ${input.settings.passProbability}）`,
  });
  return safe;
}


/**
 * 执行一个工具调用。
 * @param tools 这个 bot 能用的工具。
 * @param call 模型要的调用。
 * @param safe 安全门的结论；不安全就不执行。
 * @returns 这次调用的记录。出错不抛：错误信息写进结果交给模型。
 */
async function runTool(tools: AgentTool[], call: piAi.ToolCall, safe: boolean): Promise<log.ToolRecord> {
  // g: 被拦下、参数不是 JSON、没有这个工具，都不执行，说明交给模型。
  if (!safe) {
    return { call, result: '被决策模型拦下了，没有执行：它判断这个操作可能造成难以挽回的损失。请换个更稳妥的做法，或者先向用户说明理由。', isError: true, ms: 0 };
  }
  if (call.argumentsError) {
    return { call, result: `参数不是合法的 JSON：${call.argumentsError}`, isError: true, ms: 0 };
  }
  /** 模型要的工具。 */
  const tool = tools.find((item) => item.definition.name === call.name);
  if (!tool) {
    return { call, result: `没有叫 ${call.name} 的工具。`, isError: true, ms: 0 };
  }

  // m: 执行，量用时；出错把原因交给模型。
  /** 开始时间。 */
  const startedAt = performance.now();
  try {
    const result = await tool.execute(call.arguments);
    return { call, result, isError: false, ms: Math.round(performance.now() - startedAt) };
  } catch (error) {
    /** 出错原因。 */
    const message = error instanceof Error ? error.message : String(error);
    return { call, result: `出错：${message}`, isError: true, ms: Math.round(performance.now() - startedAt) };
  }
}


/**
 * 工具调用的记录换成交回模型的工具结果消息。
 * @param record 工具调用的记录。
 */
function toolResult(record: log.ToolRecord): piAi.Message {
  return {
    role: 'toolResult',
    toolCallId: record.call.id,
    toolName: record.call.name,
    content: [{ type: 'text', text: record.result }],
    isError: record.isError,
    timestamp: Date.now(),
  };
}


/**
 * 一条用户消息。
 * @param text 正文。
 */
function userMessage(text: string): piAi.Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}


/**
 * 把消息接到上下文末尾，同时存进对话的 context.jsonl。
 * @param conversation 对话。
 * @param context 内存里的上下文。
 * @param messages 新消息。
 */
async function addMessages(conversation: memory.Conversation, context: piAi.Message[], messages: piAi.Message[]): Promise<void> {
  context.push(...messages);
  await memory.appendContext(conversation, messages);
}


/**
 * 按名字找 bot。
 * @param bots 全部 bot。
 * @param name 名字。
 * @throws 没有这个 bot 时抛错。
 */
function findBot(bots: Record<string, bot.BotDefinition>, name: string): bot.BotDefinition {
  /** 找到的 bot。 */
  const found = bots[name];
  if (!found) {
    throw new Error(`没有 bot ${name}（bots 文件夹里没有 ${name}.yaml）。`);
  }
  return found;
}
