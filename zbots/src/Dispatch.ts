/**
 * zbots 的分派：一条消息进来，决定进哪个工作区的哪个对话、交给哪个 bot，再跑一轮（Agent.ts）。
 * 现在用简单规则，分派模型以后再接：
 * - 写了对话 ID 就接着那个对话；
 * - 没写就找同一来源（如同一个飞书私聊）最近的对话接着聊；
 * - 消息以“新对话”开头，或者找不到，就在工作区里新建一个，标题取消息开头。
 * 同一时间只处理一条消息，后来的排队。
 */
import * as agent from './Agent.ts';
import type * as bot from './Bot.ts';
import * as memory from './Memory.ts';
import type * as model from './Model.ts';
import type * as runtime from './Runtime.ts';


/** 分派要用的东西，入口（Main.ts）建好一次传进来。 */
export interface DispatchDeps {
  /** 运行时。 */
  zbots: runtime.Runtime;

  /** 模型调用入口。 */
  ai: model.Ai;

  /** 全部 bot。 */
  bots: Record<string, bot.BotDefinition>;

  /** 全部工具。 */
  tools: agent.AgentTool[];

  /** 执行设置。 */
  settings: agent.AgentSettings;
}


/** 进来的一条消息。 */
export interface IncomingMessage {
  /** 说了什么。 */
  text: string;

  /** 从哪来，如“飞书私聊 oc_xxx”“命令行”；同一来源接着最近的对话聊。 */
  from: string;

  /** 交给哪个 bot。 */
  botName: string;

  /** 接着哪个对话；不写就按来源找。 */
  conversationId?: string;

  /** 放进哪个工作区；不写用 config.yaml 里写在最前面的。 */
  workspace?: string;
}


/** 处理完的结果。 */
export interface Handled {
  /** 回给用户的话。 */
  reply: string;

  /** 用的哪个对话。 */
  conversation: memory.Conversation;

  /** 这一轮怎么停下的：done、ask_user、block、error；只开了新对话、没跑时是 new。 */
  ending: string;

  /** 这一轮执行模型走了几步。 */
  steps: number;
}


/** 开新对话的口令：消息以它开头就新建对话。 */
const newConversationWord = '新对话';


/**
 * 建分派：返回处理消息的函数。消息排队，一条处理完再处理下一条。
 * @param deps 分派要用的东西。
 */
export function createDispatcher(deps: DispatchDeps): (message: IncomingMessage) => Promise<Handled> {
  /** 排队：上一条处理完（成功或出错）才处理下一条。 */
  let queue: Promise<unknown> = Promise.resolve();
  return (message) => {
    /** 这一条的结果。 */
    const handled = queue.then(() => handleMessage(deps, message));
    queue = handled.catch(() => undefined);
    return handled;
  };
}


/**
 * 处理一条消息：找对话或新建，跑一轮，记下对话状态。
 * @param deps 分派要用的东西。
 * @param message 进来的消息。
 * @returns 回复和用的对话。
 * @throws 工作区、对话、bot 不存在时抛错。
 */
async function handleMessage(deps: DispatchDeps, message: IncomingMessage): Promise<Handled> {
  /** 工作区名字。 */
  const workspaceName = message.workspace ?? Object.keys(deps.zbots.config.workspaces)[0] ?? '';
  /** 要不要新建对话。 */
  const wantsNew = message.text.trim().startsWith(newConversationWord);
  /** 去掉口令后的正文。 */
  const task = wantsNew ? message.text.trim().slice(newConversationWord.length).replace(/^[\s,，。:：]+/, '') : message.text;

  // m: 找对话：写了 ID 就用它；否则同一来源最近的；要新建或找不到就新建。
  /** 这条消息用的对话。 */
  let conversation = await findConversation(deps.zbots, workspaceName, message, wantsNew);
  if (!conversation) {
    /** 标题：消息开头，一行，最多 30 字。 */
    const title = task.replace(/\s+/g, ' ').trim().slice(0, 30) || '新对话';
    conversation = await memory.createConversation(deps.zbots, { title, bot: message.botName, workspace: workspaceName, from: message.from });
  }
  // g: 只说了“新对话”、没说别的，就不调模型。
  if (!task.trim()) {
    return { reply: '好，开了一个新对话，接着说吧。', conversation, ending: 'new', steps: 0 };
  }

  // m: 跑一轮，按结果记下对话状态。
  const result = await agent.runRound({
    ai: deps.ai,
    conversation,
    bots: deps.bots,
    botName: message.botName,
    task,
    tools: deps.tools,
    settings: deps.settings,
  });
  conversation.info.status = result.ending === 'error' ? '出错' : '进行中';
  await memory.saveConversation(conversation);
  return { reply: result.reply, conversation, ending: result.ending, steps: result.steps };
}


/**
 * 找这条消息该接着的对话。
 * @param zbots 运行时。
 * @param workspaceName 工作区名字。
 * @param message 进来的消息。
 * @param wantsNew 要新建时直接返回 undefined。
 * @returns 找到的对话；没有时是 undefined。
 * @throws 写了对话 ID 但打不开时抛错。
 */
async function findConversation(zbots: runtime.Runtime, workspaceName: string, message: IncomingMessage, wantsNew: boolean): Promise<memory.Conversation | undefined> {
  if (message.conversationId) {
    return memory.openConversation(zbots, workspaceName, message.conversationId);
  }
  if (wantsNew) {
    return undefined;
  }
  /** 同一来源最近的对话（列表里最近活动的在前）。 */
  const latest = (await memory.listConversations(memory.findWorkspace(zbots, workspaceName))).find((item) => item.from === message.from);
  return latest ? memory.openConversation(zbots, workspaceName, latest.id) : undefined;
}
