/**
 * 全局分派：一条新任务没说交给谁时，由分派智能体（agents/分派）判断交给哪个机器人、哪个智能体，还是直接用默认模型做，
 * 以及放在哪个工作区（可以起一个新的）。
 *
 * 用户 11-02 的原话：“我们的系统会有一个默认的、完全全局的分派型智能体。它会判断你要执行什么任务：是用 boss 去执行，
 * 还是用具体的 Agent 去执行？还是说没有 Agent，仅仅只有模型 ID……现在有这么多东西，就拼到系统提示词里面。”
 *
 * 分派智能体的提示词在运行时目录的 agents/分派/config.yaml，用户和 AI 都能改；这里只负责把可选项拼进去、读它的 JSON 回答。
 * 回答读不出来时退回“默认模型 + 第一个工作区”，并把原因记下来，不让任务卡住。
 */
import * as checks from '../utils/Checks.ts';
import type * as modelModule from '../capabilities/Model.ts';
import type * as resourcesModule from '../resources/Resources.ts';


/** 分派结论。 */
export interface DispatchResult {
  /** bot 交给机器人，agent 交给智能体，model 直接用模型。 */
  kind: 'bot' | 'agent' | 'model';

  /** 机器人、智能体的名字，或模型 ID。 */
  name: string;

  /** 工作区名字（可以是新起的）。 */
  workspace: string;

  /** 新工作区的目录；不写就用默认的 workspaces/<名字>/files。 */
  workspaceDir?: string;

  /** 理由。 */
  reason: string;
}


/** 分派要用的东西。 */
export interface DispatchInput {
  /** 模型。 */
  ai: modelModule.Ai;

  /** 资源。 */
  resources: resourcesModule.Resources;

  /** 任务原文。 */
  text: string;
}


/**
 * 分派一条任务。
 * @param input 模型、资源、任务。
 * @returns 结论，以及分派智能体这次调模型的输出（没调模型时是 undefined），由调用方记进数据库。
 * @throws 没有默认模型时抛错（这时什么也做不了）。
 */
export async function dispatch(input: DispatchInput): Promise<{ result: DispatchResult; chat?: modelModule.ChatOutput }> {
  const { ai, resources } = input;
  /** 默认模型。 */
  const defaultModel = resources.getDefaultModel();
  if (!defaultModel) {
    throw new Error('没有默认模型（config.yaml 的 default_model），无法执行');
  }
  /** 分派智能体自己的名字（不把它列进可选项）。 */
  const dispatcherName = resources.getSetting('dispatcher');
  /** 可选的智能体。 */
  const agents = resources.listRoles('agent').filter((agent) => agent.name !== dispatcherName);
  /** 全部工作区。 */
  const workspaces = await resources.listWorkspaces();
  /** 兜底的结论：默认模型 + 第一个工作区（没有工作区就叫“默认”）。 */
  const fallback = (reason: string): DispatchResult => ({ kind: 'model', name: defaultModel, workspace: workspaces[0]?.name ?? '默认', reason });

  //G 没有机器人也没有智能体可选，就不用问了，直接用默认模型。
  if (resources.listRoles('bot').length === 0 && agents.length === 0) {
    return { result: fallback('没有可选的机器人和智能体，直接用默认模型') };
  }

  //M 1. 把可选项拼成一块积木，接在分派智能体的提示词后面。
  /** 分派智能体。 */
  const dispatcher = resources.getRole('agent', dispatcherName);
  /** 可选项。 */
  const options = [
    '可选的机器人（有记忆）：',
    ...(resources.listRoles('bot').length > 0 ? resources.listRoles('bot').map((bot) => `- ${bot.name}：${bot.description}`) : ['- 无']),
    '可选的智能体（专家角色）：',
    ...(agents.length > 0 ? agents.map((agent) => `- ${agent.name}：${agent.description}`) : ['- 无']),
    `默认模型：${defaultModel}`,
    '已有的工作区：',
    ...(workspaces.length > 0 ? workspaces.map((item) => `- ${item.name}：${item.description}（目录 ${item.dir}）`) : ['- 无']),
  ].join('\n');

  //M 2. 调模型：分派智能体自己写了模型就用它的，否则 models.dispatch，再否则默认模型。模型能力评价有的话一起给它看。
  /** 模型能力评价（知识库/模型评价.md）。 */
  const review = await resources.readModelReview();
  const chat = await ai.chat({
    model: dispatcher.model ?? resources.getModelChoice('dispatch')?.model ?? defaultModel,
    thinking: dispatcher.thinking ?? resources.getModelChoice('dispatch')?.thinking,
    system: { ...dispatcher.system, 可选: options, ...(review.trim() ? { 模型能力评价: review } : {}) },
    messages: [{ role: 'user', content: input.text, timestamp: Date.now() }],
    tools: [],
  });
  if (chat.error) {
    return { result: fallback(`分派智能体出错：${chat.error}`), chat };
  }

  //M 3. 读 JSON 回答，逐项核对；不对的地方退回兜底。
  /** 回答。 */
  const answer = checks.extractJson(chat.text);
  if (!answer) {
    return { result: fallback('分派智能体的回答不是 JSON'), chat };
  }
  /** 种类。 */
  const kind = answer.kind;
  /** 名字。 */
  const name = typeof answer.name === 'string' ? answer.name.trim() : '';
  /** 工作区。 */
  const workspace = typeof answer.workspace === 'string' && answer.workspace.trim() ? answer.workspace.trim() : (workspaces[0]?.name ?? '默认');
  /** 理由。 */
  const reason = typeof answer.reason === 'string' ? answer.reason : '';
  /** 新工作区的目录。 */
  const workspaceDir = typeof answer.workspace_dir === 'string' && answer.workspace_dir.trim() ? answer.workspace_dir.trim() : undefined;

  //G 机器人、智能体必须真的存在；模型 ID 留空就用默认模型。
  if (kind === 'bot' && resources.listRoles('bot').some((bot) => bot.name === name)) {
    return { result: { kind, name, workspace, workspaceDir, reason }, chat };
  }
  if (kind === 'agent' && agents.some((agent) => agent.name === name)) {
    return { result: { kind, name, workspace, workspaceDir, reason }, chat };
  }
  if (kind === 'model') {
    return { result: { kind, name: name.includes('/') ? name : defaultModel, workspace, workspaceDir, reason }, chat };
  }
  return { result: { ...fallback(`分派智能体选了不存在的 ${String(kind)} ${name}`), workspace, workspaceDir }, chat };
}
