/**
 * zbots 的步骤记录。一步 = 调一次模型，加上它要的工具调用；对话里每走一步，在对话文件夹里写两个文件，
 * 文件名是“时间 ID_第几步”，如 20261102004012123abc_3。时间 ID 在前，按文件名排序就是按时间排序。
 * - .json：这一步的请求，AI 用到的部分全在里面：模型、思考强度、系统提示词、工具说明、上下文，加上决策门问了什么。不是原始报文。
 * - .md：给人看的这一步：模型的思考、回复和工具调用，决策门的回答和结论，工具结果，用时和用量。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as piAi from '@earendil-works/pi-ai';
import * as memory from './Memory.ts';
import type * as model from './Model.ts';
import * as utils from './Utils.ts';


/** 一次决策门的记录。 */
export interface DecisionRecord {
  /** 问的是什么，如“第一步：安全吗、思路对吗”“工具 2 shell：安全吗”“要不要压缩”。 */
  about: string;

  /** 决策模型的请求和回答。 */
  output: model.DecideOutput;

  /** 结论：放行、拦下、加提醒、压缩，带上原因。 */
  verdict: string;
}


/** 一次工具调用的记录。 */
export interface ToolRecord {
  /** 模型要的工具调用：名字和参数。 */
  call: piAi.ToolCall;

  /** 交给模型的结果文字；被拦下时是拦下的说明。 */
  result: string;

  /** 出错或被拦下时为 true。 */
  isError: boolean;

  /** 工具用时，毫秒；没执行时是 0。 */
  ms: number;
}


/** 一步的记录。 */
export interface StepRecord {
  /** 这一步干什么：分派、执行、压缩、评估。 */
  kind: string;

  /** 这次调模型的请求和回应。 */
  chat: model.ChatOutput;

  /** 这一步问过的决策门，按先后；没问时是空数组。 */
  decisions: DecisionRecord[];

  /** 这一步的工具调用，按模型给的顺序；没调工具时是空数组。 */
  tools: ToolRecord[];
}


/**
 * 写一步的记录：对话的步数加一，写 .json 和 .md，再保存对话信息（索引里的步数跟着变）。
 * @param conversation 对话。
 * @param step 这一步的记录。
 * @returns 这一步的文件名（不含扩展名），如 20261102004012123abc_3。
 * 副作用：改 conversation.info.steps；在对话文件夹里写两个文件；覆盖 对话.yaml，重写工作区索引。
 */
export async function writeStep(conversation: memory.Conversation, step: StepRecord): Promise<string> {
  conversation.info.steps += 1;
  /** 第几步。 */
  const stepNumber = conversation.info.steps;
  /** 两个文件共用的名字。 */
  const name = `${utils.createTimeId()}_${stepNumber}`;

  // m: .json 存请求：模型请求原样，加上每次决策门的请求。
  /** 这一步的请求。 */
  const request = {
    step: stepNumber,
    kind: step.kind,
    chat: step.chat.request,
    decisions: step.decisions.map((decision) => ({ about: decision.about, ...decision.output.request })),
  };
  await fs.writeFile(path.join(conversation.dir, `${name}.json`), JSON.stringify(request, null, 2));
  await fs.writeFile(path.join(conversation.dir, `${name}.md`), renderStep(stepNumber, name, step));
  await memory.saveConversation(conversation);
  return name;
}


/**
 * 把一步写成给人看的 Markdown。
 * @param stepNumber 第几步。
 * @param name 文件名（不含扩展名），用来指向同名的 .json。
 * @param step 这一步的记录。
 */
function renderStep(stepNumber: number, name: string, step: StepRecord): string {
  /** 这次调模型的请求和回应。 */
  const chat = step.chat;
  /** Pi 记下的用量。 */
  const usage = chat.message.usage;
  /** 全文的各段，最后用空行连起来。 */
  const parts = [
    `# 第 ${stepNumber} 步 · ${step.kind} · ${utils.formatTime()}`,
    [
      `- 模型：${chat.request.model}；思考强度：要 ${chat.request.thinkingAsked}，实际 ${chat.request.thinking}`,
      `- 用时 ${seconds(chat.ms)}；输入 ${usage.input} token（缓存命中 ${usage.cacheRead}），输出 ${usage.output} token；花费 ${usage.cost.total} 美元（没标价的模型记 0，不代表没花钱）`,
      `- 结束原因：${chat.message.stopReason}`,
      `- 请求全文（模型、思考强度、系统提示词、工具说明、上下文、决策门的问题）：${name}.json`,
      ...(chat.error ? [`- 出错：${chat.error}`] : []),
    ].join('\n'),
    '## 思考',
    chat.thinking ? quote(chat.thinking) : '（没有）',
    '## 回复',
    chat.text || '（没有文字）',
  ];
  for (const [index, decision] of step.decisions.entries()) {
    parts.push(
      `## 决策 ${index + 1}：${decision.about}`,
      [
        `- 结论：${decision.verdict}`,
        `- 回答：${formatAnswers(decision.output.answers)}`,
        `- 用时 ${seconds(decision.output.ms)}；输入 ${decision.output.usage?.input ?? 0} token，输出 ${decision.output.usage?.output ?? 0} token`,
        ...(decision.output.error ? [`- 出错：${decision.output.error}`] : []),
      ].join('\n'),
    );
  }
  for (const [index, tool] of step.tools.entries()) {
    parts.push(
      `## 工具 ${index + 1}：${tool.call.name}`,
      '参数：',
      fenced(JSON.stringify(tool.call.arguments, null, 2), 'json'),
      `结果（${tool.isError ? '出错或被拦下' : '正常'}，用时 ${seconds(tool.ms)}）：`,
      fenced(tool.result, 'text'),
    );
  }
  return `${parts.join('\n\n')}\n`;
}


/**
 * 毫秒写成秒，保留一位小数，如 3.2 秒。
 * @param ms 毫秒。
 */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} 秒`;
}


/**
 * 一段文字每行前面加“> ”，写成 Markdown 引用；模型的思考里有标题也不会打乱本文件的结构。
 * @param text 原文。
 */
function quote(text: string): string {
  return text.split('\n').map((line) => `> ${line}`).join('\n');
}


/**
 * 把一段文字包进 Markdown 代码块。文字里有连续的反引号时，围栏比最长的那串多一个，免得代码块提前结束。
 * @param text 原文。
 * @param language 代码块的语言标记，如 json、text。
 */
function fenced(text: string, language: string): string {
  /** 文字里最长的一串反引号有几个。 */
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  /** 围栏：至少 3 个反引号。 */
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}


/**
 * 决策模型的回答写成一行，如“tool_safe 0.97，on_track 0.88”。
 * @param answers 问题名 → 回答。
 */
function formatAnswers(answers: Record<string, piAi.ClassifierAnswer>): string {
  /** 每个问题一段。 */
  const items = Object.entries(answers).map(([questionName, answer]) => {
    if (answer.type === 'bool') {
      return `${questionName} ${answer.probability.toFixed(2)}`;
    }
    if (answer.type === 'score') {
      return `${questionName} ${answer.score.toFixed(2)}（把握 ${answer.confidence.toFixed(2)}）`;
    }
    return `${questionName} ${answer.choice}（把握 ${answer.confidence.toFixed(2)}）`;
  });
  return items.join('，') || '（没有回答）';
}
