/**
 * zbots 的存放位置和索引：工作区里的对话、每个 bot 的角色工作区。全是文件，不用数据库，找东西靠扫文件夹。
 *
 * - 工作区：一个汇总，装 N 个对话；每个对话一个文件夹（名字是对话 ID），里面的 对话.yaml 写着它在做什么。
 *   工作区的 索引.md 由代码扫描各对话后整篇重写，给人和 AI 看“这个工作区都有哪些对话、各在做什么”。
 * - 角色工作区（roles/<bot>/）：对话.md 一行一个对话，写对话文件夹的完整路径；经历.md、记忆/ 以后由执行流程写。
 * - 上下文：每个对话的 context.jsonl，Pi 的消息一行一条，下一条消息接着用。
 * 公共共享区（shared/）由 loadRuntime 建好，这里还没用到。每一步的记录文件由 Log.ts 写。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as piAi from '@earendil-works/pi-ai';
import * as runtime from './Runtime.ts';
import * as utils from './Utils.ts';


/** 一个对话的信息，存在对话文件夹的 对话.yaml 里。 */
export interface ConversationInfo {
  /** 对话 ID：时间 ID，也是文件夹名。 */
  id: string;

  /** 一句话：这个对话在做什么。 */
  title: string;

  /** 哪个 bot（角色）在做。 */
  bot: string;

  /** 在哪个工作区。 */
  workspace: string;

  /** 状态：进行中、完成、出错。 */
  status: string;

  /** 消息从哪来：飞书私聊、命令行、HTTP 等。 */
  from: string;

  /** 建立时间，如 2026-11-01 21:30:05。 */
  created: string;

  /** 最近活动时间。 */
  updated: string;

  /** 一共走了几步；新步骤的编号是它加一。 */
  steps: number;
}


/** 打开的一个对话：信息、文件夹和它所在的工作区。 */
export interface Conversation {
  /** 对话信息。 */
  info: ConversationInfo;

  /** 对话文件夹。 */
  dir: string;

  /** 所在的工作区。 */
  workspace: runtime.WorkspaceInfo;
}


/** 新建对话时要给的信息；其余字段由代码填。 */
export interface NewConversation {
  /** 一句话：这个对话在做什么。 */
  title: string;

  /** 哪个 bot（角色）来做。 */
  bot: string;

  /** 放进哪个工作区。 */
  workspace: string;

  /** 消息从哪来：飞书私聊、命令行、HTTP 等。 */
  from: string;
}


/** 对话 ID 的样子：17 位数字的本地时间加 3 个小写字母（见 utils.createTimeId）。 */
const conversationIdPattern = /^\d{17}[a-z]{3}$/;


/**
 * 按名字找工作区。
 * @param zbots 运行时。
 * @param name 工作区名字。
 * @throws config.yaml 里没有这个工作区时抛错。
 */
export function findWorkspace(zbots: runtime.Runtime, name: string): runtime.WorkspaceInfo {
  /** 配置里的这个工作区。 */
  const workspace = runtime.listWorkspaces(zbots).find((item) => item.name === name);
  if (!workspace) {
    throw new Error(`config.yaml 的 workspaces 里没有工作区 ${name}。`);
  }
  return workspace;
}


/**
 * 新建一个对话：建文件夹写 对话.yaml，记进 bot 的 对话.md，重写工作区索引。
 * @param zbots 运行时。
 * @param input 标题、bot、工作区、来源。
 * @returns 新对话，状态“进行中”，0 步。
 * @throws 工作区不存在、bot 名字为空或带路径时抛错。
 * 副作用：建 <工作区>/<对话 ID>/对话.yaml；在 roles/<bot>/对话.md 末尾加一行；重写 <工作区>/索引.md。
 */
export async function createConversation(zbots: runtime.Runtime, input: NewConversation): Promise<Conversation> {
  // g: bot 名字要当文件夹名用，不能为空，不能带路径。
  if (!input.bot || path.basename(input.bot) !== input.bot) {
    throw new Error(`bot 名字不能为空，也不能带路径：${input.bot}`);
  }
  const workspace = findWorkspace(zbots, input.workspace);

  // m: 建对话文件夹，写 对话.yaml。
  /** 现在的时间，建立时间和最近活动都用它。 */
  const now = utils.formatTime();
  /** 新对话的信息。 */
  const info: ConversationInfo = {
    id: utils.createTimeId(),
    title: input.title,
    bot: input.bot,
    workspace: workspace.name,
    status: '进行中',
    from: input.from,
    created: now,
    updated: now,
    steps: 0,
  };
  const conversation: Conversation = { info, dir: path.join(workspace.dir, info.id), workspace };
  await utils.writeYaml(path.join(conversation.dir, '对话.yaml'), info);

  // m: 记进 bot 的角色工作区：对话.md 一行一个对话文件夹的完整路径，第一次写时先加标题。
  /** bot 的 对话.md。 */
  const roleFile = path.join(zbots.rolesDir, input.bot, '对话.md');
  if (!(await Bun.file(roleFile).exists())) {
    await fs.mkdir(path.dirname(roleFile), { recursive: true });
    await fs.writeFile(roleFile, `# ${input.bot} 的对话\n\n一行一个对话文件夹，新的在后面。\n\n`);
  }
  await fs.appendFile(roleFile, `- ${conversation.dir}\n`);

  await rebuildIndex(workspace);
  return conversation;
}


/**
 * 打开一个已有的对话。
 * @param zbots 运行时。
 * @param workspaceName 工作区名字。
 * @param id 对话 ID。
 * @throws 工作区不存在、ID 写错、对话不存在时抛错。
 */
export async function openConversation(zbots: runtime.Runtime, workspaceName: string, id: string): Promise<Conversation> {
  // g: ID 要拼进路径，只认时间 ID 的样子，免得拼出别的路径。
  if (!conversationIdPattern.test(id)) {
    throw new Error(`对话 ID 写错了：${id}`);
  }
  const workspace = findWorkspace(zbots, workspaceName);
  /** 对话文件夹。 */
  const dir = path.join(workspace.dir, id);
  /** 对话信息文件。 */
  const infoFile = path.join(dir, '对话.yaml');
  if (!(await Bun.file(infoFile).exists())) {
    throw new Error(`工作区 ${workspaceName} 里没有对话 ${id}。`);
  }
  return { info: (await utils.readYaml(infoFile)) as ConversationInfo, dir, workspace };
}


/**
 * 扫描工作区，列出里面的全部对话。
 * @param workspace 工作区。
 * @returns 对话信息，最近活动的在前；工作区文件夹还没建时是空数组。
 */
export async function listConversations(workspace: runtime.WorkspaceInfo): Promise<ConversationInfo[]> {
  /** 工作区里的文件和文件夹；文件夹还没建就当没有对话。 */
  const entries = await fs.readdir(workspace.dir, { withFileTypes: true }).catch(() => []);
  /** 扫到的对话。 */
  const conversations: ConversationInfo[] = [];
  for (const entry of entries) {
    // g: 只看名字是对话 ID、里面有 对话.yaml 的文件夹；files/、索引.md 等跳过。
    /** 这个文件夹里的对话信息文件。 */
    const infoFile = path.join(workspace.dir, entry.name, '对话.yaml');
    if (!entry.isDirectory() || !conversationIdPattern.test(entry.name) || !(await Bun.file(infoFile).exists())) {
      continue;
    }
    conversations.push((await utils.readYaml(infoFile)) as ConversationInfo);
  }
  // m: 最近活动的在前。时间写法长度固定，“最近活动 + ID”按字符串比，就是先比最近活动、再比建立先后。
  return conversations.sort((a, b) => (`${b.updated}${b.id}` > `${a.updated}${a.id}` ? 1 : -1));
}


/**
 * 保存对话信息：最近活动改成现在，写回 对话.yaml，再重写工作区索引。
 * 调用方先改好 conversation.info 里要改的字段（标题、状态、步数），再调这个。
 * @param conversation 对话。
 * 副作用：改 conversation.info.updated；覆盖 对话.yaml；重写 索引.md。
 */
export async function saveConversation(conversation: Conversation): Promise<void> {
  conversation.info.updated = utils.formatTime();
  await utils.writeYaml(path.join(conversation.dir, '对话.yaml'), conversation.info);
  await rebuildIndex(conversation.workspace);
}


/**
 * 重写工作区的 索引.md：扫一遍各对话，列成表，最近活动的在前。
 * 索引全是从各对话的 对话.yaml 算出来的，删了也能再生成；两个对话同时保存时以后写的为准，下次保存会补齐。
 * @param workspace 工作区。
 * 副作用：整篇覆盖 <工作区>/索引.md，工作区文件夹没有就建。
 */
export async function rebuildIndex(workspace: runtime.WorkspaceInfo): Promise<void> {
  const conversations = await listConversations(workspace);
  /** 表格的行，一个对话一行。 */
  const rows = conversations.map((item) => {
    /** 这一行的各格。 */
    const cells = [item.id, cell(item.title), cell(item.bot), cell(item.status), cell(item.from), String(item.steps), item.updated];
    return `| ${cells.join(' | ')} |`;
  });
  /** 索引全文。 */
  const text = [
    `# 工作区：${workspace.name}`,
    '',
    workspace.description,
    '',
    `zbots 扫描各对话后自动重写，不要手改。共 ${conversations.length} 个对话，最近活动的在前；对话文件夹在本文件旁边，文件夹名就是对话 ID。`,
    '',
    '| 对话 ID | 在做什么 | 角色 | 状态 | 来源 | 步数 | 最近活动 |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
  await fs.mkdir(workspace.dir, { recursive: true });
  await fs.writeFile(path.join(workspace.dir, '索引.md'), text);
}


/**
 * 文字放进 Markdown 表格的一格：竖线转义，换行换成空格。
 * @param text 原文。
 */
function cell(text: string): string {
  return text.replaceAll('|', '\\|').replace(/\s*\n\s*/g, ' ');
}


/**
 * 读对话的上下文（context.jsonl，一行一条 Pi 消息）。
 * @param conversation 对话。
 * @returns 消息，按先后；还没有上下文时是空数组。
 */
export async function loadContext(conversation: Conversation): Promise<piAi.Message[]> {
  /** 上下文文件。 */
  const file = Bun.file(path.join(conversation.dir, 'context.jsonl'));
  if (!(await file.exists())) {
    return [];
  }
  return (await file.text())
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as piAi.Message);
}


/**
 * 往对话的上下文末尾加消息。
 * @param conversation 对话。
 * @param messages 新消息（用户的、模型的、工具结果），按先后。
 * 副作用：追加到 context.jsonl，文件没有就建。
 */
export async function appendContext(conversation: Conversation, messages: readonly piAi.Message[]): Promise<void> {
  /** 要追加的行，一条消息一行。 */
  const lines = messages.map((message) => `${JSON.stringify(message)}\n`).join('');
  await fs.appendFile(path.join(conversation.dir, 'context.jsonl'), lines);
}
