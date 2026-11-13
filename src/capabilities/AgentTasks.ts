/**
 * 外部 AI 的任务通道（docs/界面/05_外部AI任务通道.md；用户 11-06 原话第 63 节：别的 AI 不由 jmbots 去操控，打通通道，让它自己来领任务）。
 * 外部 AI（如 grokbots）先打招呼登记自己会做什么；机器人用 agent_task 工具把活放进它的队列；它隔一会儿来领、下载附件，
 * 做完把结果（文字和文件）交回来，结果作为一条消息送回派活的会话，机器人接着干。
 * 都是文件，放在运行时 integrations/agents/<名字>/：agent.json 是登记；tasks/<任务号>/ 里 task.json 是任务，附件和它放一起，交回的文件在 result/。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as utils from '../utils/Utils.ts';
import type * as eventsModule from './Events.ts';
import type * as storeModule from './Store.ts';


/** 外部 AI 的名字：字母、数字、- 和 _，一到四十个字（要当文件夹名、放进网址）。 */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/** 列任务时最多给几条（新的在前）。 */
const LIST_LIMIT = 50;


/** 登记过的外部 AI。 */
export interface AgentInfo {
  /** 名字。 */
  name: string;
  /** 它会做什么（它打招呼时自己说的）。 */
  description: string;
  /** 最近一次打招呼，毫秒。 */
  hello: number;
  /** 最近一次来领活（列任务），毫秒；还没来过是 0。 */
  seen: number;
}


/** 任务到哪了。 */
export type AgentTaskStatus = 'new' | 'taken' | 'done' | 'failed';


/** 一件交给外部 AI 的活。 */
export interface AgentTask {
  /** 任务号（时间戳，也是文件夹名）。 */
  id: string;
  /** 交给谁。 */
  agent: string;
  /** 哪个机器人派的。 */
  bot: string;
  /** 从哪个会话派的；结果送回这里。没有就作为一条新消息给这个机器人。 */
  sessionId?: string;
  /** 一句话标题。 */
  title: string;
  /** 要做什么，写清楚要交回什么。 */
  text: string;
  /** 附件的文件名（在任务文件夹里）。 */
  files: string[];
  /** 到哪了。 */
  status: AgentTaskStatus;
  /** 派的时间，毫秒。 */
  createdAt: number;
  /** 领走的时间，毫秒。 */
  takenAt?: number;
  /** 交回的时间，毫秒。 */
  doneAt?: number;
  /** 交回的东西：一段话，加上 result/ 里的文件名。 */
  result?: { text: string; files: string[] };
  /** 派活时的观察关联快照；旧任务没有，不影响领活/交回。 */
  trace?: Omit<storeModule.ReplyTrace, 'eventId'>;
}


/** 接入说明（GET /api/agents/guide 原样给外部 AI 看；改接口时一起改）。 */
export const GUIDE = `# jmbots 接入说明（给别的 AI 看）

<地址> 是 jmbots 后端，局域网里是 http://<那台电脑的局域网 IP>:30086 这类（问用户）。
**每个请求都带 token**：网址后面加 ?token=<token>，或请求头 Authorization: Bearer <token>。token 问用户要，用户在 jmbots 设置页“访问令牌”里给你建一个（可能是临时的，过期了再要）。只有 jmbots 本机来的请求不用带；这份说明不用带也能读。

## 一、领 jmbots 派给你的活（你是干活的）

<名字> 是你在这里的名字，只用字母、数字、- 和 _（比如 grokbots）。

1. 打招呼（启动时一次，之后每天一次就行）：POST <地址>/api/agents/<名字>/hello，JSON {"description": "一句话说你会做什么，比如：会用 Grok 生短视频（图生视频）、生图"}。机器人派活前会看这句话。
2. 领活：每 30 秒 GET <地址>/api/agents/<名字>/tasks?status=new。回一个数组，每件有 id、title、text（要做什么、要交回什么）、files（附件：name 和下载用的 url，url 是相对 <地址> 的路径）、bot（谁派的）。
3. 认领：POST <地址>/api/agents/<名字>/tasks/<id>/take。回 409 就是已经被领了，跳过。
4. 下载附件：GET <地址><files 里的 url>（也要带 token）。
5. 做完交回：
   - 先传文件，一个文件一次：PUT <地址>/api/uploads/<文件名>，请求体就是文件的原始字节，回 {"id": ...}。
   - 再交结果：POST <地址>/api/agents/<名字>/tasks/<id>/result，JSON {"ok": true, "text": "做了什么、文件是什么", "uploads": ["上一步的 id", ...]}。没做成就 "ok": false，text 写原因。
   结果会作为一条消息送回派活的那个会话，机器人接着往下做。
6. 有事要问用户：用你自己的渠道（比如你的飞书机器人）直接问，不要卡着任务不交。

## 二、给 jmbots 的机器人派活（你是派活的）

1. 发一句话：POST <地址>/api/message，JSON {"text": "要它做什么", "bot": "机器人名，不写给第一个", "from": "你的名字", "session": "接着某个会话时写会话号，不写由它自己分派"}。回 {"id": 消息号}。
2. 看结果：GET <地址>/api/messages/<消息号>，看 status、sessionId 和 replies（机器人的回复）。机器人一般几十秒到几分钟做完；status 是 taken、会话不在跑了就是做完了。
3. 看它怎么做的：GET <地址>/api/sessions/<会话号>，md 是给人看的全过程。
4. 有哪些机器人：GET <地址>/api/bots。
`;


/**
 * 外部 AI 的名字对不对。
 * @param name 名字。
 * @returns 名字本身。
 * @throws 不对时抛错。
 */
function checkName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`外部 AI 的名字只能用字母、数字、- 和 _（1～40 个字），现在是 ${JSON.stringify(name)}`);
  }
  return name;
}


/**
 * 先写临时文件再改名，读的人不会读到半截。
 * @param file 文件。
 * @param value 要写的 JSON。
 */
async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(`${file}.tmp`, file);
}


/**
 * 外部 AI 的任务通道：登记、派活、领活、交回，都是 runtimeDir/integrations/agents/ 下的文件。
 * 谁建：入口 src/entries/App.ts 建一个，传给 /api/agents/* 路由（channels/Http.ts）
 * 和 agent_task 工具（ToolBox）；没有别的状态，各处共用一个或各建一个效果一样。
 */
export class AgentTaskChannel {
  /**
   * @param runtimeDir 运行时目录（Resources 的 dir，即 jmbotsData）。
   */
  constructor(
    private readonly runtimeDir: string,
    private readonly events?: eventsModule.EventBus,
  ) {}

  /**
   * 外部 AI 打招呼：登记它会做什么。
   * @param agent 名字。
   * @param description 它会做什么。
   * @returns 登记好的样子。
   * 副作用：写 integrations/agents/<名字>/agent.json。
   */
  async hello(agent: string, description: string): Promise<AgentInfo> {
    /** 原来的登记。 */
    const old = await this.readAgent(agent);
    /** 新的。 */
    const info: AgentInfo = {
      name: checkName(agent),
      description: description.trim() || old?.description || '',
      hello: Date.now(),
      seen: old?.seen ?? 0,
    };
    await writeJson(path.join(this.agentDir(agent), 'agent.json'), info);
    return info;
  }

  /**
   * 登记过的外部 AI。
   * @returns 按名字排。
   */
  async listAgents(): Promise<AgentInfo[]> {
    //M 1. 列文件夹名，只认名字合法的。
    /** 放各个外部 AI 的文件夹。 */
    const root = path.join(this.runtimeDir, 'integrations', 'agents');
    /** 文件夹名。 */
    const names = await fs.readdir(root).catch(() => [] as string[]);
    /** 合法的名字，按字母排。 */
    const valid = names.filter((name) => NAME_PATTERN.test(name)).sort();

    //M 2. 读各自的登记，没登记的丢掉。
    /** 读到的。 */
    const infos = await Promise.all(valid.map((name) => this.readAgent(name)));
    return infos.filter((info): info is AgentInfo => info !== undefined);
  }

  /**
   * 读一件任务。
   * @param agent 名字。
   * @param id 任务号。
   * @returns 没有是 undefined。
   */
  async getTask(agent: string, id: string): Promise<AgentTask | undefined> {
    /** 原文。 */
    const text = await fs.readFile(path.join(this.taskDir(agent, id), 'task.json'), 'utf8')
      .catch(() => '');
    return text ? (JSON.parse(text) as AgentTask) : undefined;
  }

  /**
   * 派一件活：建任务文件夹，把附件复制进去。
   * @param input 交给谁、哪个机器人哪个会话派的、标题、要做什么、附件的绝对路径。
   * @returns 任务。
   * @throws 外部 AI 没登记过、附件不存在时抛错。
   * 副作用：写任务文件夹。
   */
  async createTask(input: {
    agent: string;
    bot: string;
    sessionId?: string;
    title: string;
    text: string;
    files: string[];
    /** 原会话在派活时实际读取的消息与运行号，只用于追踪。 */
    trace?: Omit<storeModule.ReplyTrace, 'eventId'>;
  }): Promise<AgentTask> {
    if (!(await this.readAgent(input.agent))) {
      throw new Error(`${input.agent} 还没来打过招呼（没接上通道），交不了；用 list 看有哪些`);
    }
    /** 任务号。 */
    const id = utils.createSessionId();
    /** 任务文件夹。 */
    const dir = this.taskDir(input.agent, id);
    await fs.mkdir(dir, { recursive: true });
    /** 附件的文件名（重名的加序号）。 */
    const names: string[] = [];
    for (const file of input.files) {
      /** 文件名。 */
      let name = path.basename(file);
      if (names.includes(name)) {
        name = `${String(names.length + 1)}_${name}`;
      }
      await fs.copyFile(file, path.join(dir, name));
      names.push(name);
    }
    /** 任务。 */
    const task: AgentTask = {
      id,
      agent: input.agent,
      bot: input.bot,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      title: input.title,
      text: input.text,
      files: names,
      status: 'new',
      createdAt: Date.now(),
      ...(input.trace ? { trace: {
        ...input.trace,
        messageIds: [...input.trace.messageIds],
      } } : {}),
    };
    await writeJson(path.join(dir, 'task.json'), task);
    this.report('agent.queued', task, {
      queuedAt: task.createdAt,
      files: names.length,
      chars: task.text.length,
    });
    return task;
  }

  /**
   * 列一个外部 AI 的任务，新的在前；顺便记下它来过。
   * @param agent 名字。
   * @param status 只要这种状态的；不写是全部。
   * @param touch 是外部 AI 自己来列的（记“最近来领活”）。
   * @returns 最多 50 件。
   */
  async listTasks(agent: string, status?: AgentTaskStatus, touch = false): Promise<AgentTask[]> {
    if (touch) {
      /** 登记。 */
      const info = await this.readAgent(agent);
      if (info) {
        /** 记下来过的登记。 */
        const touched = { ...info, seen: Date.now() };
        await writeJson(path.join(this.agentDir(agent), 'agent.json'), touched);
      }
    }
    /** 任务文件夹里的名字。 */
    const entries = await fs.readdir(path.join(this.agentDir(agent), 'tasks'))
      .catch(() => [] as string[]);
    /** 任务号，新的在前。 */
    const ids = entries.filter((name) => /^\d{14,}$/.test(name)).sort().reverse();
    /** 结果。 */
    const tasks: AgentTask[] = [];
    for (const id of ids) {
      /** 这一件。 */
      const task = await this.getTask(agent, id);
      if (task && (!status || task.status === status)) {
        tasks.push(task);
      }
      if (tasks.length >= LIST_LIMIT) {
        break;
      }
    }
    return tasks;
  }

  /**
   * 认领一件活。
   * @param agent 名字。
   * @param id 任务号。
   * @returns 认领后的任务。
   * @throws 没有这件、已经被领了（消息里带“已经”）时抛错。
   * 副作用：改 task.json。
   */
  async takeTask(agent: string, id: string): Promise<AgentTask> {
    /** 任务。 */
    const task = await this.getTask(agent, id);
    if (!task) {
      throw new Error(`没有任务 ${id}`);
    }
    if (task.status !== 'new') {
      throw new Error(`任务 ${id} 已经是 ${task.status} 了`);
    }
    /** 领走以后。 */
    const takenAt = Date.now();
    const taken: AgentTask = { ...task, status: 'taken', takenAt };
    await writeJson(path.join(this.taskDir(agent, id), 'task.json'), taken);
    this.report('agent.taken', taken, {
      takenAt,
      //M 外部 AI 认领只证明领走，不假称它已经开始执行。
      executionStartedAt: null,
      queuedAt: task.createdAt,
      queuedToClaimMs: takenAt - task.createdAt,
    });
    return taken;
  }

  /**
   * 交回结果：文件存进任务的 result/，任务记成做完或没做成。
   * @param agent 名字。
   * @param id 任务号。
   * @param result 做成没有、一段话、文件。
   * @returns 交回以后的任务。
   * @throws 没有这件、已经交过时抛错。
   * 副作用：写 result/ 和 task.json。
   */
  async finishTask(
    agent: string,
    id: string,
    result: { ok: boolean; text: string; files: { name: string; data: Uint8Array }[] },
  ): Promise<AgentTask> {
    /** 任务。 */
    const task = await this.getTask(agent, id);
    if (!task) {
      throw new Error(`没有任务 ${id}`);
    }
    if (task.status === 'done' || task.status === 'failed') {
      throw new Error(`任务 ${id} 已经交过了（${task.status}）`);
    }
    /** 放结果的文件夹。 */
    const dir = path.join(this.taskDir(agent, id), 'result');
    await fs.mkdir(dir, { recursive: true });
    /** 存下的文件名。 */
    const names: string[] = [];
    for (const file of result.files) {
      /** 文件名（去掉路径，防越界）。 */
      const name = utils.safeFolderName(path.basename(file.name))
        || `file${String(names.length + 1)}`;
      await fs.writeFile(path.join(dir, name), file.data);
      names.push(name);
    }
    /** 交回以后。 */
    const doneAt = Date.now();
    const done: AgentTask = {
      ...task,
      status: result.ok ? 'done' : 'failed',
      doneAt,
      result: { text: result.text, files: names },
    };
    await writeJson(path.join(this.taskDir(agent, id), 'task.json'), done);
    this.report('agent.result', done, {
      ok: result.ok,
      takenAt: task.takenAt ?? null,
      receivedAt: doneAt,
      executionStartedAt: null,
      claimedToResultMs: task.takenAt === undefined ? null : doneAt - task.takenAt,
      chars: result.text.length,
      files: names.length,
      bytes: result.files.reduce((total, file) => total + file.data.byteLength, 0),
    });
    return done;
  }

  /** 任务持久状态改变以后只报事实；外部实际开工时刻没有协议字段，就留空。 */
  private report(type: string, task: AgentTask, facts: Record<string, unknown>): void {
    const data = {
      ...task.trace,
      taskId: task.id,
      agent: task.agent,
      targetSession: task.sessionId ?? null,
      status: task.status,
      title: task.title,
      ...facts,
    };
    this.events?.emit(type, data, {
      source: 'AgentTasks',
      bot: task.bot,
      sessionId: task.sessionId,
      messageId: task.trace?.messageIds.at(-1),
    });
  }

  /**
   * 任务里一个文件的绝对路径（附件或 result/ 里的），不许越出任务文件夹。
   * @param agent 名字。
   * @param id 任务号。
   * @param name 文件名，result/ 里的写 result/<文件名>。
   * @returns 绝对路径。
   * @throws 越界时抛错。
   */
  taskFile(agent: string, id: string, name: string): string {
    /** 任务文件夹。 */
    const dir = this.taskDir(agent, id);
    /** 文件。 */
    const file = path.resolve(dir, name);
    if (!file.startsWith(dir + path.sep) || path.basename(file) === 'task.json') {
      throw new Error(`不能拿 ${name}`);
    }
    return file;
  }

  /**
   * 一个外部 AI 的文件夹。
   * @param agent 名字。
   * @returns 文件夹。
   * @throws 名字不对时抛错。
   */
  private agentDir(agent: string): string {
    return path.join(this.runtimeDir, 'integrations', 'agents', checkName(agent));
  }

  /**
   * 一件任务的文件夹。
   * @param agent 名字。
   * @param id 任务号。
   * @returns 文件夹。
   * @throws 任务号不对时抛错。
   */
  private taskDir(agent: string, id: string): string {
    if (!/^\d{14,}$/.test(id)) {
      throw new Error(`任务号不对：${JSON.stringify(id)}`);
    }
    return path.join(this.agentDir(agent), 'tasks', id);
  }

  /**
   * 读一个外部 AI 的登记。
   * @param agent 名字。
   * @returns 没登记过是 undefined。
   */
  private async readAgent(agent: string): Promise<AgentInfo | undefined> {
    /** 原文。 */
    const text = await fs.readFile(path.join(this.agentDir(agent), 'agent.json'), 'utf8')
      .catch(() => '');
    return text ? (JSON.parse(text) as AgentInfo) : undefined;
  }
}


/**
 * 交回的结果写成送回会话的那条消息。
 * @param task 交回以后的任务。
 * @returns 消息正文（附件另外带）。
 */
export function resultMessage(task: AgentTask): string {
  /** 结论。 */
  const verdict = task.status === 'done' ? '做完了' : '没做成';
  return `【${task.agent} 交回任务 #${task.id}「${task.title}」：${verdict}】\n${task.result?.text ?? ''}\n\n（任务文件夹：integrations/agents/${task.agent}/tasks/${task.id}/，交回的文件在 result/ 里，也作为附件带在这条消息上）`;
}


/**
 * 一件任务写成给机器人看的一行。
 * @param task 任务。
 */
export function describeTask(task: AgentTask): string {
  /** 状态。 */
  const status = { new: '等它来领', taken: '它在做', done: '做完了', failed: '没做成' }[task.status];
  return `#${task.id} → ${task.agent}「${task.title}」${status}（派于 ${utils.formatTime(task.createdAt)}${task.doneAt ? `，交回于 ${utils.formatTime(task.doneAt)}` : ''}）`;
}
