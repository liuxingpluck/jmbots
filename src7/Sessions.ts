/**
 * 会话：最重要的一个文件。骨架只管这一件事：一场会话怎么跑。
 * Sessions 管表；Session 是一场对话：一份记录（row），加上推它往下走的循环（run）。
 * 谁开的会话、话从哪来、回话往哪送，骨架都不知道，那是插件的事（机器人是 plugins/bots）。
 *
 * 主线全是直接调用，按 F12 能跳到实现：工具清单和执行工具调 ctx.tools，发请求调 Chat.ts 的 chat()。
 * 事件只留给插件接进来，会话发三个，都声明在这个文件里：
 *   session/request  每一步调模型之前，请求交给插件挨个改；
 *   session/message  对话里新接了一条，只是通知；
 *   session/change   状态变了，只是通知。
 */
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as chatModule from './Chat.ts';
import type { ChatRequest, Thinking } from './Chat.ts';
import { stampId } from './utils/Names.ts';
import * as textModule from './utils/Text.ts';


declare module 'cordis' {
  interface Context {
    /** 会话服务，实现在 src7/Sessions.ts。 */
    sessions: Sessions;
  }
  interface Events {
    /**
     * 每一步调模型之前：这一步的请求交给插件挨个改，照插件挂上去的先后一个个 await。
     * 加提示词就往 request.system 里 push；压缩、检索、拼最近往来就改 request.messages；
     * 直接给回答的（假模型）填 request.answer。
     * 监听的函数不许有返回值：有了返回值，Cordis 就不再问后面的人了。
     */
    'session/request'(request: ChatRequest): void | Promise<void>;
    /** 对话里新接了一条（用户的话、模型的回答、工具的结果）。只是通知。 */
    'session/message'(session: Session, message: piAi.Message): void;
    /** 状态变了：开始转了，或者这一轮结束了（session.row.reply 是要回给用户的话）。只是通知。 */
    'session/change'(session: Session): void;
  }
}


/**
 * 会话的状态。
 *   running  正在转：在等模型回答，或者在执行工具
 *   done     做完了。新开的、还没用过的会话也是它
 *   stopped  停下了：有人喊停，或者到了最多几步
 *   failed   出错了
 */
export type SessionState = 'running' | 'done' | 'stopped' | 'failed';


/**
 * 一场对话的记录。骨架只管下面这几项，都是循环要用的。
 * 插件要往上面记自己的东西（属于哪个机器人、回话的渠道、总结……），在自己的文件里用
 * declare module '../../Sessions.ts' 给这个 interface 加项（看 plugins/bots/index.ts），存库时会一起存。
 */
export interface SessionRow {
  /** 会话号。 */
  id: string;
  /** 种类。骨架不解释它，只拿它去对工具登记时写的 kinds；有哪几种由开会话的插件定。 */
  kind: string;
  /** 嵌在哪场会话里；只有小会话有。 */
  parent?: string;
  /** 用哪个模型，供应商名/模型 ID。 */
  model: string;
  /** 思考档。 */
  thinking: Thinking;
  /** 状态。 */
  state: SessionState;
  /** 这一轮的结果，就是要回给用户的话：做完了是模型最后那句，出错、停下是原因。正在转时是空的。 */
  reply: string;
  /** 整场对话。 */
  messages: piAi.Message[];
  /** 最后一次存库的时间，毫秒时间戳。 */
  updatedAt: number;
}


/** 会话记录去掉对话那一大块。find 交回的是它：列清单用，不用把整场对话读出来。 */
export type SessionMeta = Omit<SessionRow, 'messages'>;


/**
 * 新开会话要给的东西：种类必须给；模型、思考档不给就用配置里的（default_model、engine.thinking）；
 * 插件给记录加的必填项（比如 bot）也要给。
 */
export type NewSession =
  Omit<SessionRow, 'id' | 'model' | 'thinking' | 'state' | 'reply' | 'messages' | 'updatedAt'>
  & Partial<Pick<SessionRow, 'model' | 'thinking'>>;


/** 开一场小会话问一次要给的东西：开会话的那些项，加上要问的话和停止信号。 */
export type AskInput = NewSession & {
  /** 要问的话，整段交给小会话。 */
  text: string;
  /** 提问方的停止信号（提问的会话停了、超时）：断了小会话也停。不给就跑到底。 */
  signal?: AbortSignal;
};


/** 小会话问一次的结果。 */
export interface AskResult {
  /** 小会话做完了（done）才是 true；出错、停下是 false。 */
  ok: boolean;
  /** 小会话的 reply：做完了是回答，没做完是原因。 */
  reply: string;
}


/** 会话服务：管表。 */
export class Sessions extends cordis.Service {
  /** 用到的服务。 */
  static inject = ['resources', 'tools'];

  /** 打开过的会话：会话号 → 对象。同一场永远是同一个对象，喊停才能按到正在转的那个。 */
  private readonly live = new Map<string, Session>();

  /**
   * 登记 sessions 插件：把 Sessions 作为服务挂到 Cordis 上，名字叫 sessions（以后用 ctx.sessions 取）；数据库里没有 sessions 表就建。
   * @param ctx Cordis 给的 ctx。
   */
  constructor(ctx: cordis.Context) {
    super(ctx, 'sessions');

    //M 一场会话一行，分两块存：meta 是记录去掉对话以后的 JSON，find 照它里面的项找；messages 是整场对话的 JSON。
    const sql = 'CREATE TABLE IF NOT EXISTS sessions'
      + ' (id TEXT PRIMARY KEY, meta TEXT NOT NULL, messages TEXT NOT NULL)';
    this.ctx.resources.db.exec(sql);
  }

  /**
   * 新开一场。
   * 会话号由 stampId() 生成：本机本地时间的年月日时分秒毫秒（17 位）加 3 位随机数字，共 20 位纯数字，
   * 和 0.4 src/utils/Utils.ts 的 createSessionId 一样（用 getHours 等本地时区，不用 UTC）。
   * 所有新会话（前台、后台、小会话）都走这里，不另写一套号。
   * 旧的 8 位十六进制会话号仍能打开、继续用，不迁移已有数据。
   * @param input 种类、嵌在哪场里、模型、思考档，加上插件给记录加的那些项；原样带进记录。
   * @returns 新会话，状态 done，对话是空的。
   * 副作用：写库。
   */
  create(input: NewSession): Session {
    const config = this.ctx.resources.config;
    const existsQuery = this.ctx.resources.db.query('SELECT 1 FROM sessions WHERE id = ?');

    //M 同一毫秒撞上时换一个再试（主键拦下）。save() 是 INSERT OR REPLACE，创建时先查重，免得把旧会话盖掉。
    for (let attempt = 0; ; attempt += 1) {
      const id = stampId();
      const exists = existsQuery.get(id);
      if (exists !== null) {
        //G 连撞好几次 → 不再试，抛错。
        if (attempt >= 5) {
          throw new Error('生成会话号连续撞上已有记录');
        }
        continue;
      }

      //M 号没人用：拼一份新记录（模型、思考档没给就用配置里的），存库，记进 live。
      const row: SessionRow = {
        ...input,
        id,
        model: input.model ?? config.defaultModel,
        thinking: input.thinking ?? config.thinking,
        state: 'done',
        reply: '',
        messages: [],
        updatedAt: Date.now(),
      };
      const session = new Session(row, this.ctx);
      session.save();
      this.live.set(row.id, session);
      return session;
    }
  }

  /**
   * 打开一场。
   * @param id 会话号。
   * @returns 会话对象。同一场永远交回同一个对象。
   * @throws 没有这场时抛错。
   */
  open(id: string): Session {
    const opened = this.live.get(id);
    if (opened !== undefined) return opened;

    //M 库里的两块读出来，拼回一份记录。
    const sql = 'SELECT meta, messages FROM sessions WHERE id = ?';
    const query = this.ctx.resources.db.query(sql);
    const stored = query.get(id) as { meta: string; messages: string } | null;

    //G 库里没有 → 抛错。
    if (stored === null) {
      throw new Error(`没有这场会话：${id}`);
    }

    const meta = JSON.parse(stored.meta) as SessionMeta;
    const messages = JSON.parse(stored.messages) as piAi.Message[];
    const session = new Session({ ...meta, messages }, this.ctx);
    this.live.set(id, session);
    return session;
  }

  /**
   * 找会话：给的几项都相等的那些。只读记录（不带对话），不打开。
   * @param where 照哪几项找，比如 { state: 'running' }；插件给记录加的项也能用，比如 { bot: '助手', kind: 'work' }。
   * @returns 记录，最近动过的在前。
   */
  find(where: Partial<SessionMeta>): SessionMeta[] {
    //M 每一项都用 json_extract 从 meta 里取出来比，所以插件加的项不用改表也能拿来找。
    let sql = 'SELECT meta FROM sessions WHERE 1 = 1';
    /** 填进 SQL 里问号的值：每一项两个，先是 JSON 路径（$.state），再是要等于的值。 */
    const values: (string | number)[] = [];
    textModule.eachEntry(where, (key, value) => {
      sql += ' AND json_extract(meta, ?) = ?';
      values.push(`$.${key}`, value as string | number);
    });
    sql += " ORDER BY json_extract(meta, '$.updatedAt') DESC";

    //M 查出来的每行只有 meta 一列，解析回记录。
    const query = this.ctx.resources.db.query(sql);
    const found = query.all(...values) as { meta: string }[];
    return found.map((item) => JSON.parse(item.meta) as SessionMeta);
  }

  /**
   * 开一场小会话问一次：开会话、说一句、跑到底、交回结果。审批、压缩、总结、复盘、进度收尾、判断都用它。
   * 只是 create → add → run 连起来，run 本身不动。
   * @param input 开会话的那些项（种类、嵌在哪场里、模型、思考档、bot……），加上要问的话和停止信号。
   * @returns 做没做完，和小会话的 reply。
   * 副作用：开会话、调模型、写库。
   */
  async ask(input: AskInput): Promise<AskResult> {
    //M 要问的话和停止信号不进记录，其余原样拿去开会话。
    const { text, signal, ...fields } = input;
    const child = this.create(fields);
    child.add(text);

    //M 提问方的信号断了 → 小会话也停，不再等模型。不管怎么结束都把监听摘掉。
    const stop = (): void => {
      child.stop('提问方停了');
    };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      await child.run();
    } finally {
      signal?.removeEventListener('abort', stop);
    }

    //M 做完了才算问成；没做完 reply 是原因。
    const ok = child.row.state === 'done';
    return { ok, reply: child.row.reply };
  }
}


/** 一场对话。只由 Sessions.create、Sessions.open 来建。 */
export class Session {
  /** 会话号。 */
  readonly id: string;

  /** 正在转的这一轮的取消开关；没在转是 undefined。喊停时用它掐断正在等的模型请求，它的信号也交给工具。 */
  private aborter?: AbortController;

  /** 用户说了、还没接进对话的话。循环每一步开头才接进去，这样不会插在模型的回答和它要的工具结果中间。 */
  private readonly inbox: piAi.Message[] = [];

  /**
   * @param row 这场对话的记录。改了以后调 save() 存库。
   * @param ctx 发事件、取 resources 和 tools 用。
   */
  constructor(readonly row: SessionRow, private readonly ctx: cordis.Context) {
    this.id = row.id;
  }

  /**
   * 对这场会话说一句话。说完要它往下走，再调 run()。
   * @param text 用户说的话（渠道来的、别的会话交办的、插件要它做的）。
   */
  add(text: string): void {
    this.inbox.push({ role: 'user', content: text, timestamp: Date.now() });
  }

  /**
   * 推这场对话往下走，走到做完、停下或者出错为止。自己不往外抛。
   * 谁都可以调：插件把话交给它以后、重启后接着跑。已经在转就直接返回，刚说的话下一步会带上。
   * 副作用：发事件、调模型、执行工具、写库。
   */
  async run(): Promise<void> {
    //G 已经在转 → return。
    if (this.aborter !== undefined) return;

    //M 备好这一轮的取消开关，状态改成 running，跑循环；不管怎么结束都把开关收掉。
    const aborter = new AbortController();
    this.aborter = aborter;
    this.change('running', '');
    try {
      await this.loop(aborter.signal);
    } catch (error) {
      //G 被喊停时请求是被掐断的，状态已经是 stopped；还是 running 才算出错。
      if (this.row.state === 'running') {
        const reason = textModule.messageOf(error);
        this.change('failed', `出错了：${reason}`);
      }
    } finally {
      this.aborter = undefined;
    }

    //G 收尾的那一下又有人说话 → 再转一轮。喊停后慢工具还在收尾时来的话也在这里转，不然要等下一句话才处理。
    if (this.inbox.length > 0) {
      void this.run();
    }
  }

  /**
   * 循环本身：一步 = 调一次模型，加上执行它要的工具。
   * @param signal 这一轮的取消信号。
   */
  private async loop(signal: AbortSignal): Promise<void> {
    /** 一轮最多走几步。 */
    const max = this.ctx.resources.config.maxSteps;
    for (let step = 1; step <= max; step += 1) {
      //G 被喊停了 → 不往下走。
      if (this.row.state !== 'running') return;

      //M 用户说了、还没接进对话的话，这时候接进去。
      for (const waiting of this.inbox.splice(0)) {
        this.append(waiting);
      }

      //M 备好这一步的请求，交给插件挨个改（session/request）。
      const request: ChatRequest = {
        session: this,
        model: this.row.model,
        thinking: this.row.thinking,
        system: [],
        tools: this.ctx.tools.list(this.row.kind),
        messages: [...this.row.messages],
        signal,
      };
      await this.ctx.serial('session/request', request);

      //T 跟踪：调模型；插件已经给了回答（假模型）就写明没有调。
      const vars = {
        会话: this.id,
        第几步: step,
        模型: request.model,
        对话几条: request.messages.length,
      };
      let doing = '调模型';
      if (request.answer !== undefined) {
        doing = '插件已经给了回答，不调模型';
      }
      this.ctx.emit('trace', 'Session.loop', doing, 'chat(ctx, request)', vars);

      //M 调模型。插件已经给了回答（假模型）就不发请求。
      let answer = request.answer;
      if (answer === undefined) {
        answer = await chatModule.chat(this.ctx, request);
      }

      //G 等模型的时候被喊停了 → 这次回答不要了。
      if (this.row.state !== 'running') return;

      //M 模型的回答接进对话。
      this.append(answer);

      //M 从回答里挑出工具调用。
      const calls = answer.content.filter((block): block is piAi.ToolCall => {
        return block.type === 'toolCall';
      });

      //M 模型没要工具 → 这一轮做完了，它说的就是回给用户的话。
      if (calls.length === 0) {
        const reply = piAi.contentText(answer.content);
        this.change('done', reply);
        return;
      }

      //M 模型要了工具 → 一个个执行，结果接进对话，回到开头走下一步。
      for (const call of calls) {
        const outcome = await this.ctx.tools.execute(call, this, signal);

        //M 结果写成一条 toolResult：先是文字，后面跟着图片（有的话）。
        const textBlock: piAi.TextContent = { type: 'text', text: outcome.text };
        const images = outcome.images ?? [];
        const result: piAi.Message = {
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [textBlock, ...images],
          isError: outcome.isError,
          timestamp: Date.now(),
        };
        this.append(result);
      }
    }

    //G 走满了步数，模型还在要工具 → 停下。
    this.change('stopped', `到 ${String(max)} 步了，先停在这里`);
  }

  /**
   * 喊停。前台的 stop_session 工具、将来的界面按钮都调它。
   * @param by 谁喊的。
   * 副作用：状态改成 stopped；正在等的模型请求马上掐掉；正在跑的那个工具拿到同一个停止信号，
   *   慢的马上断开（快的照常做完），后面的不再执行。
   */
  stop(by: string): void {
    const aborter = this.aborter;

    //G 没在转 → 没有要停的。
    if (aborter === undefined) return;

    this.change('stopped', `已停止（${by}）`);
    aborter.abort();
  }

  /**
   * 把记录存进库：对话一块，别的项（连同插件加的）一块。
   * 副作用：写库。
   */
  save(): void {
    this.row.updatedAt = Date.now();

    //M 记录拆成两块：对话一块，别的项（连同插件加的）一块，各自转成 JSON。
    const { messages, ...meta } = this.row;
    const metaJson = JSON.stringify(meta);
    const messagesJson = JSON.stringify(messages);

    const sql = 'INSERT OR REPLACE INTO sessions (id, meta, messages) VALUES (?, ?, ?)';
    const query = this.ctx.resources.db.query(sql);
    query.run(meta.id, metaJson, messagesJson);
  }

  /**
   * 往对话后面接一条：存库，通知大家。
   * @param message 用户的话、模型的回答，或者工具的结果。
   */
  private append(message: piAi.Message): void {
    this.row.messages.push(message);
    this.save();
    this.ctx.emit('session/message', this, message);
  }

  /**
   * 改状态：存库，通知大家。
   * @param state 新状态。
   * @param reply 这一轮的结果，要回给用户的话；刚开始转时是空的。
   */
  private change(state: SessionState, reply: string): void {
    this.row.state = state;
    this.row.reply = reply;
    this.save();
    this.ctx.emit('session/change', this);
  }
}
