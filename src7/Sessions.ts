/**
 * 会话：最重要的一个文件。
 * Sessions 管表；Session 是一个对象管一场对话的全部：
 *   记录（属于谁、状态、第几轮第几步、对话、总结），和跑这场对话的循环（run）。
 * 六个事件都由会话发，声明在这个文件里。调模型不走事件，直接调 Chat.ts 的 chat()。
 *
 * 事件只有两种发法：
 *   挨个问：照插件挂上去的先后一个个 await，每个插件都会被问到，后面的看得到前面改的。
 *           要东西、请人干活的五个事件都这样发（prompt、tools、context、before-calls、calls）。
 *           实现用 ctx.serial，所以监听的函数不许有返回值：有了返回值，Cordis 就不再问后面的人了。
 *   通知：  ctx.parallel，同时叫所有人，等大家办完。只有 session/change 这样发。
 */
import { Database } from 'bun:sqlite';
import type * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as chatModule from './Chat.ts';
import type { Thinking } from './Resources.ts';


declare module 'cordis' {
  interface Context {
    /** 会话服务，实现在 src7/Sessions.ts。 */
    sessions: Sessions;
  }
  interface Events {
    /** 每一步：要系统提示词。响应的人往 event.parts 里加段落，不返回。 */
    'session/prompt'(event: PromptEvent): void | Promise<void>;
    /** 每一步：要工具清单。响应的人看 event.tools 里有没有自己的工具，没有就加，不返回。 */
    'session/tools'(event: ToolsEvent): void | Promise<void>;
    /** 每一步，发请求之前：这是要发给模型的对话。压缩、检索、拼最近往来的人改 event.messages，不返回。 */
    'session/context'(event: ContextEvent): void | Promise<void>;
    /**
     * 模型要了工具，还没执行：整批调用先给把关的人看一遍。
     * 把关的人可以给某一项直接填上 result（不让执行，理由写在里面），或者把会话改成 wait_user（要用户点头），不返回。
     */
    'session/before-calls'(event: CallsEvent): void | Promise<void>;
    /** 执行这批工具调用。执行的人给还没有 result 的那些填上，不返回。执行完了的结果，听 session/change 能看到。 */
    'session/calls'(event: CallsEvent): void | Promise<void>;
    /** 会话变了（状态、步数、新消息）。只是通知。 */
    'session/change'(event: ChangeEvent): void | Promise<void>;
  }
}


/** 会话的种类。default 默认对话；work 干活的会话；compress 这类嵌在别的会话里的小会话。 */
export type SessionKind = 'default' | 'work' | 'compress';


/** 会话的状态。 */
export type SessionState =
  | 'running'        // 执行中：在准备上下文，或者在等模型回答
  | 'wait_tools'     // 等工具执行
  | 'wait_compress'  // 等压缩
  | 'wait_user'      // 等用户决定（比如一条命令要用户点头）
  | 'done'           // 做完了
  | 'stopped'        // 停下了（有人喊停，或者到了最多几步）
  | 'failed';        // 出错了


/** 往对话后面接的是什么。 */
export type AddKind = 'user' | 'assistant' | 'tool';


/** 会话表的一行。 */
export interface SessionRow {
  /** 会话号。 */
  id: string;
  /** 属于哪个机器人。 */
  bot: string;
  /** 属于哪个工作区。 */
  workspace: string;
  /** 种类。 */
  kind: SessionKind;
  /** 嵌在哪场会话里；只有小会话有。 */
  parent?: string;
  /** 回话往哪个渠道送：这一轮最后一条用户消息从哪个渠道来。小会话没有。 */
  channel?: string;
  /** 用哪个模型，供应商名/模型 ID。 */
  model: string;
  /** 思考档。默认对话是 low。 */
  thinking: Thinking;
  /** 状态。 */
  state: SessionState;
  /** 状态的原因：谁喊的停、出了什么错、在等用户定什么。 */
  reason?: string;
  /** 第几轮，从 1 数。 */
  round: number;
  /** 这一轮走到第几步。 */
  step: number;
  /** 这一轮是从对话的第几条开始的。 */
  roundStart: number;
  /** 整场对话。 */
  messages: piAi.Message[];
  /** 这一轮要回给用户的话：模型第一次说“我做完了”时的那句。 */
  reply?: string;
  /** 这场对话的一句总结，由它自己调 summary 工具写。 */
  summary?: string;
  /** 这一轮写过总结没有；没写过、模型又说做完了，循环会催一次。 */
  summarized: boolean;
  /** 毫秒时间戳。 */
  createdAt: number;
  /** 毫秒时间戳。 */
  updatedAt: number;
}


/** 新开会话要给的东西。 */
export interface NewSession {
  bot: string;
  kind: SessionKind;
  /** 回话往哪送；小会话不给。 */
  channel?: string;
  /** 嵌在哪场里；小会话才给。 */
  parent?: string;
  /** 不给就用默认模型。 */
  model?: string;
}


/** 工具执行者交回来的结果。 */
export interface ToolOutcome {
  /** 给模型看的文字。 */
  text: string;
  /** 是不是出错了。 */
  isError: boolean;
}


/** session/prompt 的数据。 */
export interface PromptEvent {
  session: Session;
  /** 系统提示词的段落，按先后；会话最后用空行拼起来。 */
  parts: string[];
}

/** session/tools 的数据。 */
export interface ToolsEvent {
  session: Session;
  /** 这一步给模型看的工具定义。 */
  tools: piAi.Tool[];
}

/** session/context 的数据。 */
export interface ContextEvent {
  session: Session;
  /** 这一步要发给模型的对话。改它不会改库里存的原文。 */
  messages: piAi.Message[];
}

/** session/calls 里的一项。 */
export interface CallItem {
  /** 模型的这次调用：工具名、参数、调用号。 */
  call: piAi.ToolCall;
  /** 结果；谁执行谁填。已经有了的，后面的人不要再执行。 */
  result?: ToolOutcome;
}

/** session/calls 的数据。 */
export interface CallsEvent {
  session: Session;
  /** 整批调用，照模型给的先后。 */
  calls: CallItem[];
}

/** session/change 的数据。 */
export interface ChangeEvent {
  session: Session;
  /** 变化之后的那一行。 */
  row: SessionRow;
  /** 这次新接进对话的消息；只是改状态时是空的。 */
  added: piAi.Message[];
}


/** 会话服务：管表。 */
export class Sessions extends cordis.Service {
  /** 用到的服务。 */
  static inject = ['resources'];

  /** 活着的会话对象：会话号 → 对象。保证谁打开同一场拿到的都是同一个对象（喊停要按到正在跑的那个）。 */
  private readonly live = new Map<string, Session>();

  /**
   * 登记成 ctx.sessions，没有表就建。
   * @param ctx Cordis 给的 ctx。
   */
  constructor(ctx: cordis.Context) {
    super(ctx, 'sessions');
    //M 没有 sessions 表就建：列和 SessionRow 一一对应，messages 存成 JSON。
    ensureTable(this.ctx.resources.db);
  }

  /**
   * 新开一场。
   * @param input 机器人、种类、渠道、嵌在哪场里、模型。
   * @returns 新会话，状态 done（还没有轮），round 0。
   * 副作用：写库，发 session/change。
   */
  create(input: NewSession): Session {
    //M 默认对话的思考档定成 low；别的用配置里的。
    const thinking: Thinking = input.kind === 'default' ? 'low' : 'medium';
    //M 工作区：先都用 resources.botDir(bot).workspace。
    const workspace = this.ctx.resources.botDir(input.bot).workspace;
    const now = Date.now();
    const row: SessionRow = {
      id: newId(this.ctx.resources.db),
      bot: input.bot,
      workspace,
      kind: input.kind,
      parent: input.parent,
      channel: input.channel,
      model: input.model ?? this.ctx.resources.getDefaultModel(),
      thinking,
      state: 'done',
      round: 0,
      step: 0,
      roundStart: 0,
      messages: [],
      summarized: false,
      createdAt: now,
      updatedAt: now,
    };
    insertRow(this.ctx.resources.db, row);
    const session = new Session(row.id, this.ctx);
    this.live.set(row.id, session);
    void this.ctx.parallel('session/change', { session, row: cloneRow(row), added: [] });
    return session;
  }

  /**
   * 打开一场。
   * @param id 会话号。
   * @returns 会话对象；没有这场是 undefined。同一场永远交回同一个对象。
   */
  open(id: string): Session | undefined {
    const existing = this.live.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const row = loadRow(this.ctx.resources.db, id);
    if (row === undefined) {
      return undefined;
    }
    const session = new Session(id, this.ctx);
    this.live.set(id, session);
    return session;
  }

  /**
   * 这个机器人的默认对话，没有就建。每个机器人只有一场。
   * @param bot 机器人名。
   */
  defaultOf(bot: string): Session {
    const found = this.ctx.resources.db.query(
      'SELECT id FROM sessions WHERE bot = ? AND kind = ? LIMIT 1',
    ).get(bot, 'default') as { id: string } | null;
    if (found !== null) {
      const opened = this.open(found.id);
      if (opened !== undefined) {
        return opened;
      }
    }
    return this.create({ bot, kind: 'default' });
  }

  /**
   * 这个机器人的全部会话，新的在前。
   * @param bot 机器人名。
   */
  listOf(bot: string): SessionRow[] {
    const rows = this.ctx.resources.db.query(
      'SELECT * FROM sessions WHERE bot = ? ORDER BY updatedAt DESC',
    ).all(bot) as Record<string, unknown>[];
    return rows.map((item) => fromSql(item));
  }

  /** @returns 上一轮没走完的那些（状态是 running 或 wait_*）。重启时用。 */
  unfinished(): Session[] {
    const rows = this.ctx.resources.db.query(
      "SELECT id FROM sessions WHERE state IN ('running', 'wait_tools', 'wait_compress', 'wait_user')",
    ).all() as { id: string }[];
    /** 打开后的对象。 */
    const sessions: Session[] = [];
    for (const item of rows) {
      const opened = this.open(item.id);
      if (opened !== undefined) {
        sessions.push(opened);
      }
    }
    return sessions;
  }
}


/** 一场对话。只由 Sessions.create、Sessions.open 来建。 */
export class Session {
  /** 会话号。 */
  readonly id: string;

  /** 是不是正在转；防止同一场同时转两个循环。 */
  private turning = false;

  /** 正在等的那次模型请求的取消开关；没在等时是 undefined。 */
  private aborter?: AbortController;

  /** 这一轮是不是已经催过写总结。只记在内存里，这一轮有效。 */
  private nudged = false;

  /**
   * @param id 会话号。
   * @param ctx 发事件、取 resources 用。
   */
  constructor(id: string, private readonly ctx: cordis.Context) {
    this.id = id;
  }

  /** 现读库。要对话、状态、模型都从这里拿。 */
  get row(): SessionRow {
    const row = loadRow(this.ctx.resources.db, this.id);
    if (row === undefined) {
      throw new Error(`找不到会话 ${this.id}`);
    }
    return row;
  }

  /**
   * 推这场对话往下走。谁都可以调它来推一下：机器人收到消息、重启、用户定了一件事。
   * 走到做完、停下、出错，或者要等用户为止。自己不往外抛。
   * 副作用：发事件、调模型、写库。
   */
  async run(): Promise<void> {
    //G 这场正在转 → return。
    if (this.turning) {
      return;
    }
    this.turning = true;
    try {
      await this.turn();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        this.changeState('failed', reason);
      } catch {
        // 写库也失败时不再往外抛。
      }
    } finally {
      this.turning = false;
    }
  }

  /**
   * 循环本身。run 把它包在 try 里。
   */
  private async turn(): Promise<void> {
    const ended: SessionState[] = ['done', 'stopped', 'failed'];
    //M 上一轮已经结束了（done、stopped、failed）→ begin() 开新一轮。
    /** 是新开一轮还是接着走，给跟踪点用。 */
    let fresh = false;
    if (ended.includes(this.row.state)) {
      this.begin();
      this.nudged = false;
      fresh = true;
    } else {
      //M 上一轮没走完（重启了，或者刚等到用户的决定）→ 接着走：
      //M   对话最后有没结果的工具调用 → 先去做下面“等工具”那一段，再进循环。
      const pending = pendingCalls(this.row.messages);
      if (pending.length > 0) {
        const cont = await this.runTools(pending);
        if (!cont) {
          return;
        }
      }
    }
    //T 跟踪：『开始推这场对话』 变量 { 会话号, 种类, 第几轮, 是新开一轮还是接着走 }
    this.trace('run', '开始推这场对话', undefined, () => ({
      会话号: this.id,
      种类: this.row.kind,
      第几轮: this.row.round,
      是新开一轮还是接着走: fresh ? '新开一轮' : '接着走',
    }));

    //M 一直转：
    /** 连续模型出错的次数；成功一次就清零。 */
    let errors = 0;
    for (;;) {
      const row = this.row;
      //G   状态不是 running → return（有人喊停了）。
      if (row.state !== 'running') {
        return;
      }
      //G   step 到了 resources.getMaxSteps() → changeState('stopped', '到 N 步了')；return。
      const max = this.ctx.resources.getMaxSteps();
      if (row.step >= max) {
        this.changeState('stopped', `到 ${String(max)} 步了`);
        return;
      }

      //M   提示词：event = { session: this, parts: [] }；await 挨个问 'session/prompt'；用空行拼起来。
      const promptEvent: PromptEvent = { session: this, parts: [] };
      await this.ctx.serial('session/prompt', promptEvent);
      const system = promptEvent.parts.filter((part) => part !== '').join('\n\n');

      //M   工具：  event = { session: this, tools: [] }；await 挨个问 'session/tools'。
      const toolsEvent: ToolsEvent = { session: this, tools: [] };
      await this.ctx.serial('session/tools', toolsEvent);

      //M   对话：  event = { session: this, messages: 这场对话的副本 }；await 挨个问 'session/context'；用改过的。
      //M           （压缩、检索是别人看、别人做；会话只等。）
      const contextEvent: ContextEvent = { session: this, messages: [...this.row.messages] };
      await this.ctx.serial('session/context', contextEvent);

      //T 跟踪：『第 N 步：调模型』 代码 chat(request) 变量 { step, 模型, 提示词几段, 对话几条, 工具几个 }
      this.trace('run', `第 ${String(this.row.step + 1)} 步：调模型`, 'chat(request)', () => ({
        step: this.row.step + 1,
        模型: this.row.model,
        提示词几段: promptEvent.parts.length,
        对话几条: contextEvent.messages.length,
        工具几个: toolsEvent.tools.length,
      }));

      //M   this.aborter = new AbortController()。
      this.aborter = new AbortController();
      const retry = this.ctx.resources.getRetry();
      //M   回答 = await chat({ model: resources.modelOf(row.model), system, messages, tools, thinking, signal, timeoutMs })。
      const answer = await chatModule.chat({
        model: this.ctx.resources.modelOf(this.row.model),
        system,
        messages: contextEvent.messages,
        tools: toolsEvent.tools,
        thinking: this.row.thinking,
        signal: this.aborter.signal,
        timeoutMs: retry.timeoutMs,
      });
      this.aborter = undefined;

      //G   状态不是 running → return（等模型的时候被喊停了，这次回答不要了）。
      if (this.row.state !== 'running') {
        return;
      }
      //G   回答.error →
      if (answer.error !== undefined) {
        errors += 1;
        //G     连续出错不到 getRetry().times 次 → 等 getRetry().waitMs，回到“一直转”的开头（步数不加）；
        if (errors < retry.times) {
          await sleep(retry.waitMs);
          continue;
        }
        //G     到了 → changeState('failed', 原因)；return。
        this.changeState('failed', answer.error);
        return;
      }
      if (answer.message === undefined) {
        this.changeState('failed', '模型没有返回');
        return;
      }
      //M   add('assistant', 回答.message)。连续出错次数清零。
      this.add('assistant', answer.message);
      errors = 0;
      const message = answer.message;
      const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
      const calls = message.content.filter((block): block is piAi.ToolCall => block.type === 'toolCall');
      //T 跟踪：『模型回了』 变量 { step, 文字多少字, 要了哪几个工具 }
      this.trace('run', '模型回了', undefined, () => ({
        step: this.row.step,
        文字多少字: text.length,
        要了哪几个工具: calls.map((item) => item.name),
      }));

      //M   模型没要工具（它认为做完了）：
      if (calls.length === 0) {
        //M     row.reply 还没有 → 这句就是要回给用户的话，记下来。
        if (this.row.reply === undefined || this.row.reply === '') {
          this.save((current) => {
            current.reply = text;
          }, []);
        }
        //G     这是 work 会话、这一轮没写过总结、也还没催过 →
        //G       add('user', '请调用 summary 工具，用一两句话写下这场对话做了什么、结果在哪。')；记下“催过了”；继续转。只催这一次。
        if (this.row.kind === 'work' && !this.row.summarized && !this.nudged) {
          this.add('user', '请调用 summary 工具，用一两句话写下这场对话做了什么、结果在哪。');
          this.nudged = true;
          continue;
        }
        //M     changeState('done')；return。
        this.changeState('done');
        return;
      }

      //M   等工具：见 runTools。
      const cont = await this.runTools(calls);
      if (!cont) {
        return;
      }
    }
  }

  /**
   * 把关并执行这一批工具调用。
   * @param calls 还没有结果的那些调用。
   * @returns 还要继续转（状态回到 running）就是 true；要等用户或被喊停就是 false。
   */
  private async runTools(calls: piAi.ToolCall[]): Promise<boolean> {
    //M     changeState('wait_tools')。
    if (this.row.state !== 'wait_tools') {
      this.changeState('wait_tools');
    }
    //M     event = { session: this, calls: 对话最后还没有结果的每个工具调用一项 }。
    const event: CallsEvent = { session: this, calls: calls.map((call) => ({ call })) };
    //M     把关：await 挨个问 'session/before-calls'。把关的人可以给某一项填上“未执行：理由”，或者把会话改成 wait_user。
    await this.ctx.serial('session/before-calls', event);
    //G     状态变成了 wait_user → return。整批都先不执行；用户定了以后，管这件事的插件调 run()，会回到这里再问一遍。
    if (this.row.state === 'wait_user') {
      return false;
    }
    if (this.row.state !== 'wait_tools') {
      return false;
    }
    //M     执行：await 挨个问 'session/calls'。执行的人给还没有结果的那些填上。
    await this.ctx.serial('session/calls', event);
    //M     每一项包成一条 toolResult，还是没有结果的记“没有执行者”；add('tool', 它们)。
    const results: piAi.Message[] = event.calls.map((item) => ({
      role: 'toolResult',
      toolCallId: item.call.id,
      toolName: item.call.name,
      content: [{ type: 'text', text: item.result?.text ?? '没有执行者' }],
      isError: item.result?.isError ?? true,
      timestamp: Date.now(),
    }));
    this.add('tool', results);
    //M     状态还是 wait_tools → changeState('running')。被喊停了就不改回去，下一圈开头退出。
    const state = this.row.state;
    if (state === 'wait_tools') {
      this.changeState('running');
      return true;
    }
    return state === 'running';
  }

  /**
   * 喊停。
   * @param by 谁喊的：界面、默认对话、哪个用户。
   * 副作用：状态改成 stopped；正在等的那次模型请求马上掐掉。
   */
  stop(by: string): void {
    //T 跟踪：『喊停』 变量 { 会话号, 谁喊的, 喊停前的状态 }
    this.trace('stop', '喊停', undefined, () => ({
      会话号: this.id,
      谁喊的: by,
      喊停前的状态: this.row.state,
    }));
    //M changeState('stopped', by)。
    this.changeState('stopped', by);
    //M this.aborter?.abort()。
    this.aborter?.abort();
  }

  /**
   * 开一轮：轮数加一，步数清零，记下这一轮从第几条开始，清掉上一轮的 reply，状态改成 running。
   * 副作用：写库，发 session/change。
   */
  begin(): void {
    //G 上一轮留下了没有结果的工具调用（等用户点头的时候被喊停了）→ 各补一条“未执行：停下来了”，对话才是完整的。
    const leftover = pendingCalls(this.row.messages);
    if (leftover.length > 0) {
      const results: piAi.Message[] = leftover.map((call) => ({
        role: 'toolResult' as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text' as const, text: '未执行：停下来了' }],
        isError: true,
        timestamp: Date.now(),
      }));
      this.add('tool', results);
    }
    this.save((current) => {
      current.round += 1;
      current.step = 0;
      current.roundStart = current.messages.length;
      current.reply = undefined;
      current.summarized = false;
      current.reason = undefined;
      current.state = 'running';
    }, []);
    this.nudged = false;
  }

  /**
   * 往对话后面接。
   * @param kind 接的是什么：user 用户说的话；assistant 模型的回答（步数加一）；tool 工具的结果。
   * @param content user 给文字；assistant 给模型回的整条；tool 给一组 toolResult。
   * @param channel 只有 user 用：这句话从哪个渠道来，记成这场的回话渠道。
   * 副作用：写库，发 session/change。
   */
  add(kind: AddKind, content: string | piAi.AssistantMessage | piAi.Message[], channel?: string): void {
    /** 这次接进去的消息。 */
    const added: piAi.Message[] = [];
    if (kind === 'user') {
      const text = typeof content === 'string' ? content : '';
      added.push({ role: 'user', content: text, timestamp: Date.now() });
    } else if (kind === 'assistant' && isAssistant(content)) {
      added.push(content);
    } else if (kind === 'tool' && Array.isArray(content)) {
      added.push(...content);
    }
    this.save((current) => {
      current.messages = [...current.messages, ...added];
      if (kind === 'assistant') {
        current.step += 1;
      }
      if (kind === 'user' && channel !== undefined) {
        current.channel = channel;
      }
    }, added);
  }

  /**
   * 改状态。
   * @param state 新状态。
   * @param reason 原因：谁喊的停、出了什么错、在等用户定什么。
   * 副作用：写库，发 session/change。
   */
  changeState(state: SessionState, reason?: string): void {
    this.save((current) => {
      current.state = state;
      current.reason = reason;
    }, []);
  }

  /**
   * 写这场对话的总结。summary 工具调它。
   * @param text 一两句话。
   * 副作用：写库（summary、summarized），发 session/change。
   */
  summarize(text: string): void {
    this.save((current) => {
      current.summary = text;
      current.summarized = true;
    }, []);
  }

  /**
   * 上面几个写入共用：一个事务里读出这一行、改、写回、更新 updatedAt，然后发 session/change。
   * @param change 怎么改这一行。
   * @param added 这次新接进对话的消息。
   */
  private save(change: (row: SessionRow) => void, added: piAi.Message[]): void {
    const db = this.ctx.resources.db;
    let row: SessionRow | undefined;
    db.transaction(() => {
      const current = loadRow(db, this.id);
      if (current === undefined) {
        throw new Error(`找不到会话 ${this.id}`);
      }
      change(current);
      current.updatedAt = Date.now();
      writeRow(db, current);
      row = current;
    })();
    if (row !== undefined) {
      void this.ctx.parallel('session/change', { session: this, row: cloneRow(row), added });
    }
  }

  /**
   * 发一个跟踪点。没挂打印插件时没人听。
   * @param fn 哪个函数。
   * @param text 人话。
   * @param code 对应的那句代码。
   * @param vars 关键变量。
   */
  private trace(fn: string, text: string, code: string | undefined, vars: () => Record<string, unknown>): void {
    this.ctx.emit('trace', {
      module: 'Sessions',
      fn,
      session: this.id,
      text,
      code,
      vars,
    });
  }
}


/** 结束状态，用来判断要不要开新一轮。 */
const ENDED: SessionState[] = ['done', 'stopped', 'failed'];
void ENDED;


/**
 * 建 sessions 表。
 * @param db 数据库。
 */
function ensureTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      bot TEXT NOT NULL,
      workspace TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent TEXT,
      channel TEXT,
      model TEXT NOT NULL,
      thinking TEXT NOT NULL,
      state TEXT NOT NULL,
      reason TEXT,
      round INTEGER NOT NULL,
      step INTEGER NOT NULL,
      roundStart INTEGER NOT NULL,
      messages TEXT NOT NULL,
      reply TEXT,
      summary TEXT,
      summarized INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )
  `);
}


/**
 * 生成一个不重复的 8 位会话号。
 * @param db 用来查重。
 */
function newId(db: Database): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let id = '';
    for (let i = 0; i < 8; i += 1) {
      const index = Math.floor(Math.random() * alphabet.length);
      id += alphabet[index] ?? 'x';
    }
    const exists = db.query('SELECT 1 FROM sessions WHERE id = ?').get(id);
    if (exists === null) {
      return id;
    }
  }
  return `s${String(Date.now())}`;
}


/**
 * 从库里读一行。
 * @param db 数据库。
 * @param id 会话号。
 */
function loadRow(db: Database, id: string): SessionRow | undefined {
  const raw = db.query('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | null;
  if (raw === null) {
    return undefined;
  }
  return fromSql(raw);
}


/**
 * 插入一行。
 * @param db 数据库。
 * @param row 会话行。
 */
function insertRow(db: Database, row: SessionRow): void {
  db.query(`
    INSERT INTO sessions (
      id, bot, workspace, kind, parent, channel, model, thinking, state, reason,
      round, step, roundStart, messages, reply, summary, summarized, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...sqlValues(row));
}


/**
 * 整行写回。
 * @param db 数据库。
 * @param row 会话行。
 */
function writeRow(db: Database, row: SessionRow): void {
  db.query(`
    UPDATE sessions SET
      bot=?, workspace=?, kind=?, parent=?, channel=?, model=?, thinking=?, state=?, reason=?,
      round=?, step=?, roundStart=?, messages=?, reply=?, summary=?, summarized=?, updatedAt=?
    WHERE id=?
  `).run(
    row.bot, row.workspace, row.kind, row.parent ?? null, row.channel ?? null,
    row.model, row.thinking, row.state, row.reason ?? null,
    row.round, row.step, row.roundStart, JSON.stringify(row.messages),
    row.reply ?? null, row.summary ?? null, row.summarized ? 1 : 0, row.updatedAt,
    row.id,
  );
}


/**
 * 把一行变成 SQL 参数，按 insert 的列顺序。
 * @param row 会话行。
 */
function sqlValues(row: SessionRow): (string | number | null)[] {
  return [
    row.id, row.bot, row.workspace, row.kind, row.parent ?? null, row.channel ?? null,
    row.model, row.thinking, row.state, row.reason ?? null,
    row.round, row.step, row.roundStart, JSON.stringify(row.messages),
    row.reply ?? null, row.summary ?? null, row.summarized ? 1 : 0,
    row.createdAt, row.updatedAt,
  ];
}


/**
 * 把 SQL 行还原成 SessionRow。
 * @param raw 查询结果。
 */
function fromSql(raw: Record<string, unknown>): SessionRow {
  return {
    id: String(raw['id']),
    bot: String(raw['bot']),
    workspace: String(raw['workspace']),
    kind: raw['kind'] as SessionKind,
    parent: raw['parent'] === null || raw['parent'] === undefined ? undefined : String(raw['parent']),
    channel: raw['channel'] === null || raw['channel'] === undefined ? undefined : String(raw['channel']),
    model: String(raw['model']),
    thinking: raw['thinking'] as Thinking,
    state: raw['state'] as SessionState,
    reason: raw['reason'] === null || raw['reason'] === undefined ? undefined : String(raw['reason']),
    round: Number(raw['round']),
    step: Number(raw['step']),
    roundStart: Number(raw['roundStart']),
    messages: JSON.parse(String(raw['messages'])) as piAi.Message[],
    reply: raw['reply'] === null || raw['reply'] === undefined ? undefined : String(raw['reply']),
    summary: raw['summary'] === null || raw['summary'] === undefined ? undefined : String(raw['summary']),
    summarized: Number(raw['summarized']) === 1,
    createdAt: Number(raw['createdAt']),
    updatedAt: Number(raw['updatedAt']),
  };
}


/**
 * 拷一份行，发给 session/change 的人，避免后面再改影响到他们。
 * @param row 原行。
 */
function cloneRow(row: SessionRow): SessionRow {
  return { ...row, messages: [...row.messages] };
}


/**
 * 对话里还没有结果的工具调用：从最后一条助手消息里取出，去掉已经有 toolResult 的。
 * @param messages 整场对话。
 */
function pendingCalls(messages: piAi.Message[]): piAi.ToolCall[] {
  let assistant: piAi.AssistantMessage | undefined;
  const done = new Set<string>();
  for (const item of messages) {
    if (item.role === 'assistant') {
      assistant = item;
    } else if (item.role === 'toolResult') {
      done.add(item.toolCallId);
    }
  }
  if (assistant === undefined) {
    return [];
  }
  return assistant.content.filter((block): block is piAi.ToolCall => {
    return block.type === 'toolCall' && !done.has(block.id);
  });
}


/**
 * 是不是助手消息。
 * @param value add 的内容。
 */
function isAssistant(value: string | piAi.AssistantMessage | piAi.Message[]): value is piAi.AssistantMessage {
  return typeof value !== 'string' && !Array.isArray(value) && value.role === 'assistant';
}


/**
 * 等一段时间。
 * @param ms 毫秒。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
