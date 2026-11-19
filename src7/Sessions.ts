/**
 * 会话：最重要的一个文件。骨架只管这一件事：一场会话怎么跑。
 * Sessions 管表；Session 是一场对话：一份记录（row），加上推它往下走的循环（run）。
 * 谁开的会话、话从哪来、回话往哪送，骨架都不知道，那是插件的事（机器人是 plugins/bots）。
 *
 * 主线全是直接调用，按 F12 能跳到实现：工具清单和执行工具调 ctx.tools，发模型请求调 Sessions.chat()。
 * 发模型请求只依赖 pi（PI agent SDK，@earendil-works/pi-ai）。
 * 一轮不数步数：模型不再要工具就做完了，有人喊停就停下。
 *
 * 事件只留给插件接进来。每一步有四个关口，插件挨个看，谁写了 stop 这一轮就停在那里（类型见 SessionGate）：
 *   session/request      调模型之前，请求交给插件挨个改（本文件）；
 *   session/after-model  模型回来之后、回答接进对话之前（本文件）；
 *   session/before-tool  执行一个工具之前，还能用 deny 只拦这一个（声明和发都在 Tools.ts）；
 *   session/after-tool   一个工具执行完、结果接进对话之前（本文件）。
 * 另外三个只是通知，也声明在本文件：
 *   session/message  对话里新接了一条；
 *   session/change   状态变了；
 *   model/failed     模型调用失败了一次。
 */
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { ToolDone } from './Tools.ts';
import { stampId } from './utils/Names.ts';
import * as textModule from './utils/Text.ts';
import * as utils from './utils/index.ts';


declare module 'cordis' {
  interface Context {
    /** 会话服务，实现在 src7/Sessions.ts。 */
    sessions: Sessions;
  }
  interface Events {
    /**
     * 关口一，每一步调模型之前：这一步的请求交给插件挨个改，照插件挂上去的先后一个个 await。
     * 加提示词就往 request.system 里 push；压缩、检索、拼最近往来就改 request.messages；
     * 直接给回答的（假模型）填 request.answer；要这一轮停在这里、不调模型，就在 request.stop 写理由。
     * 监听的函数不许有返回值：有了返回值，Cordis 就不再问后面的人了（下面三个关口也一样）。
     * 谁发：src7/Sessions.ts 的 Session.loop
     * 谁接：
     *   src7/plugins/approval/index.ts 的 Approval.constructor
     *   src7/plugins/assist/index.ts 的 Assist.constructor
     *   src7/plugins/bots/ChannelTools.ts 的 ChannelTools.constructor
     *   src7/plugins/bots/DispatchTools.ts 的 DispatchTools.constructor
     *   src7/plugins/bots/FrontDesk.ts 的 FrontDesk.constructor
     *   src7/plugins/bots/Prompt.ts 的 Prompt.constructor
     *   src7/plugins/context-fit/Compress.ts 的 Compress.constructor
     *   src7/plugins/context-fit/index.ts 的 apply
     *   src7/plugins/fake-model/index.ts 的 apply
     *   src7/plugins/file-tools/BaseTools.ts 的 BaseTools.constructor
     *   src7/plugins/memory/GraphRoutes.ts 的 GraphRoutes.constructor
     *   src7/plugins/memory/index.ts 的 Memory.constructor
     *   src7/plugins/model-catalog/Fallback.ts 的 ModelFallback.constructor
     *   src7/plugins/progress/GroupDaily.ts 的 bindReportTools
     *   src7/plugins/progress/index.ts 的 Progress.constructor
     *   src7/plugins/relay/index.ts 的 Relay.constructor
     *   src7/plugins/skills/index.ts 的 apply
     *   src7/plugins/wechat/index.ts 的 Wechat.constructor
     */
    'session/request'(request: ChatRequest): void | Promise<void>;
    /**
     * 关口二，模型回来之后、回答接进对话之前：照先后一个个 await。
     * 能看能改 request.answer（换掉也行，以最后的为准）；在 request.stop 写理由，这次回答就不要了
     * （里面要的工具也不执行），这一轮停在这里。
     * 谁发：src7/Sessions.ts 的 Session.loop
     * 谁接：暂无
     */
    'session/after-model'(request: AnsweredRequest): void | Promise<void>;
    /**
     * 关口四，一个工具执行完、结果接进对话之前：照先后一个个 await。没执行、被 deny 拦下的也走这里。
     * 能改 done.outcome（文字、图片、是否出错）；在 done.stop 写理由，结果照样接进对话（要和工具调用配对），
     * 这一轮停在这里，这一批后面的工具不再执行。
     * 谁发：src7/Sessions.ts 的 Session.loop
     * 谁接：src7/plugins/bots/ChannelTools.ts 的 ChannelTools.constructor
     */
    'session/after-tool'(done: ToolDone): void | Promise<void>;
    /**
     * 对话里新接了一条（用户的话、模型的回答、工具的结果）。只是通知。
     * 谁发：src7/Sessions.ts 的 Session.append
     * 谁接：
     *   src7/plugins/bots/FrontDesk.ts 的 FrontDesk.constructor
     *   src7/plugins/journal/FilesMirror.ts 的 FilesMirror.constructor
     *   src7/plugins/journal/index.ts 的 Journal.listen
     *   src7/plugins/memory/index.ts 的 Memory.constructor
     *   src7/plugins/model-catalog/Usage.ts 的 Usage.constructor
     *   src7/plugins/progress/index.ts 的 Progress.constructor
     */
    'session/message'(session: Session, message: piAi.Message): void;
    /**
     * 状态变了：开始转了，或者这一轮结束了（session.row.reply 是要回给用户的话）。只是通知。
     * 谁发：src7/Sessions.ts 的 Session.change
     * 谁接：
     *   src7/plugins/bots/DispatchResults.ts 的 DispatchResults.listen
     *   src7/plugins/bots/FrontDesk.ts 的 FrontDesk.constructor
     *   src7/plugins/bots/index.ts 的 Bots.constructor
     *   src7/plugins/cli/index.ts 的 Cli.constructor
     *   src7/plugins/context-fit/Summary.ts 的 Summary.constructor
     *   src7/plugins/journal/FilesMirror.ts 的 FilesMirror.constructor
     *   src7/plugins/journal/index.ts 的 Journal.listen
     *   src7/plugins/progress/index.ts 的 Progress.constructor
     *   src7/plugins/relay/index.ts 的 Relay.constructor
     *   src7/plugins/voice/index.ts 的 apply
     *   src7/plugins/web-api/index.ts 的 WebApi.constructor
     */
    'session/change'(session: Session): void;
    /**
     * 模型调用失败了一次（含会重试的那几次；被喊停的不算）。通知，用量、追溯这类插件听它。
     * 谁发：src7/Sessions.ts 的 Sessions.chat
     * 谁接：
     *   src7/plugins/model-catalog/Fallback.ts 的 ModelFallback.attempt
     *   src7/plugins/model-catalog/Usage.ts 的 Usage.constructor
     */
    'model/failed'(info: ModelFailed): void;
  }
}


/** 事件 model/failed 带的东西。 */
export interface ModelFailed {
  /** 是哪场会话的请求。 */
  session: Session;
  /** 哪个模型，供应商名/模型 ID。 */
  model: string;
  /** pi 给的错误文字。 */
  error: string;
  /** 这一次从发出到失败用了多少毫秒。 */
  ms: number;
}


/**
 * 思考档：直接用 pi 的 ModelThinkingLevel，不再另列一份类型。
 * - off：不思考；请求怎么关、模型能不能真关，要看接口（见下面的说明）。
 * - minimal：最少思考，尽量快答。
 * - low：轻量思考，适合简单任务。
 * - medium：中等思考，在速度和推敲之间折中。
 * - high：深入思考，给复杂问题多一点推敲。
 * - xhigh：比 high 更深，只在模型明确支持时可用。
 * - max：最深一档，只在模型明确支持时可用，不等于无限 token。
 * 模型不支持的档位，pi 自动换成最近的可用档（先往更深找，找不到再往浅找）。
 * pi 模型的 thinkingLevelMap 把通用档位映射成接口值；null 表示不支持，缺项走供应商默认。
 * 同一档不保证不同模型花一样多时间或 token；我们的 thinking 清单也不等于这个映射表。
 * 各模型支持哪些档、实际发什么，见 [model-catalog「思考档位」](plugins/model-catalog/说明.md#思考档位)。
 */
export type Thinking = piAi.ModelThinkingLevel;


/**
 * 四个关口事件（session/request、session/after-model、session/before-tool、session/after-tool）共有的两项。
 * 各关口的数据都在它上面加自己的东西：两个模型关口用 ChatRequest，两个工具关口用 Tools.ts 的 ToolGate。
 */
export interface SessionGate {
  /** 是哪场会话的。插件靠它知道种类、机器人、整场对话。 */
  session: Session;
  /**
   * 喊停的理由。谁要这一轮停在这个关口就写上；写了会话就停下（Session.stop），不往下走，
   * 理由写进 session.row.reply。没人写就接着走。
   */
  stop?: string;
}


/**
 * 一步的请求。会话备好，先交给插件挨个改（事件 session/request），再交给 Sessions.chat() 发出去；
 * 回答回来以后，带着回答再交给插件看一遍（事件 session/after-model，数据是 AnsweredRequest）。
 * chat() 只看模型、思考档、提示词、工具、对话、取消信号，不看 session、stop、answer。
 */
export interface ChatRequest extends SessionGate {
  /** 用哪个模型，供应商名/模型 ID。 */
  model: string;
  /** 思考档。 */
  thinking: Thinking;
  /** 系统提示词的段落；发请求时用空行拼起来。 */
  system: string[];
  /** 这一步给模型看的工具定义。 */
  tools: piAi.Tool[];
  /** 这一步要发给模型的对话，是副本：改它不会改库里存的原文。 */
  messages: piAi.Message[];
  /** 取消信号：喊停时触发，正在等的请求马上断开。 */
  signal: AbortSignal;
  /** 插件直接给的回答（比如假模型）。有了它，会话就不调 chat()。 */
  answer?: piAi.AssistantMessage;
}


/** 事件 session/after-model 的数据：就是这一步的请求，回答已经有了（模型回的，或者插件给的）。 */
export type AnsweredRequest = ChatRequest & {
  /** 这一步的回答。插件可以改它、换掉它，接进对话的是最后这一份。 */
  answer: piAi.AssistantMessage;
};


/**
 * 会话的状态。
 *   running  正在转：在等模型回答，或者在执行工具
 *   done     做完了。新开的、还没用过的会话也是它
 *   stopped  停下了：有人喊停（stop_session、界面按钮），或者某个关口上有插件写了 stop
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
  /** 上级会话号。后台指回派活的前台，小会话指回发起提问的会话。 */
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
 * 新开会话要给的东西：种类必须给；模型、思考档不给就用配置里的（default_model、models.thinking）；
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

  /** 打开过的会话：会话号 → 对象。启动以来新开或从库里读出来的都留在这，跑完也不删（不是“正在跑的会话”）；同一场永远是同一个对象，喊停才能按到正在转的那个。 */
  private readonly openedSessions = new Map<string, Session>();

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
    //M 读取全局默认配置并预编译查重语句，避免高并发同毫秒生成会话号时撞号覆盖。
    const config = this.ctx.resources.config;
    const existsQuery = this.ctx.resources.db.query('SELECT 1 FROM sessions WHERE id = ?');

    //M 同一毫秒撞上时换一个再试（主键拦下）。save() 是 INSERT OR REPLACE，创建时先查重，免得把旧会话盖掉。
    for (let attempt = 0; ; attempt += 1) {
      const id = stampId();
      const exists = existsQuery.get(id);

      //G 号被占了：连撞 5 次就不再试、抛错；没到 5 次就换一个号再来一轮。
      if (exists !== null && attempt >= 5) throw new Error('生成会话号连续撞上已有记录');
      if (exists !== null) continue;

      //M 号没人用：拼一份新记录（模型、思考档没给就用配置里的），存库，记进 openedSessions。
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
      //M 按配置补齐模型与思考档并创建新会话实例，随后写入持久化列表。
      const session = new Session(row, this.ctx);
      //M 立即落库持久化并缓存到 openedSessions，确保后续消息与停止动作能命中同一实例。
      session.save();
      this.openedSessions.set(row.id, session);
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
    //M 先查内存里已打开的会话对象，直接复用以保持运行开关和未入队消息一致。
    const opened = this.openedSessions.get(id);
    if (opened !== undefined) return opened;

    //M 库里的两块读出来，拼回一份记录。
    const sql = 'SELECT meta, messages FROM sessions WHERE id = ?';
    const query = this.ctx.resources.db.query(sql);
    const stored = query.get(id) as { meta: string; messages: string } | null;

    //G 库里没有 → 抛错。
    if (stored === null) {
      throw new Error(`没有这场会话：${id}`);
    }

    //M 解析磁盘元信息与对话历史重建会话实例，并放入 openedSessions 供同一场对话复用。
    const meta = JSON.parse(stored.meta) as SessionMeta;
    const messages = JSON.parse(stored.messages) as piAi.Message[];
    const session = new Session({ ...meta, messages }, this.ctx);
    this.openedSessions.set(id, session);
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
    //M 逐条追加过滤键到 WHERE 子句与绑定参数，最后按更新时间倒序返回。
    utils.eachEntry(where, (key, value) => {
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

  /**
   * 用 pi 发一次模型请求。不管会话怎么走，也不存状态：给它什么请求它发什么。
   * 会话循环每一步调它（Session.loop）；model-fallback 换模型再试时也调它（ctx.sessions.chat）。
   * @param request 模型、思考档、提示词、对话、工具、取消信号。
   * @returns 模型回的整条（文字、工具调用都在里面）。
   * @throws 试够了次数还是不成、或者被喊停掐断时抛错；Session.run 接住。
   * 副作用：发 HTTP 请求；每失败一次发一次 model/failed。
   */
  async chat(request: ChatRequest): Promise<piAi.AssistantMessage> {
    /** 建好的供应商、模型和重试的配置，都在 resources 里（src7/Resources.ts）。 */
    const resources = this.ctx.resources;
    const retry = resources.config.retry;
    //M 按“供应商/模型”名查出配置好的 pi 模型定义与参数，供下面构建上下文和重连使用。
    const model = resources.getModel(request.model);

    //M 拼 pi 要的上下文：提示词的段落用空行连成一段。
    const systemPrompt = request.system.join('\n\n');
    const context: piAi.Context = {
      systemPrompt,
      messages: request.messages,
      tools: request.tools,
    };

    //M 请求选项：pi 自己不重试（maxRetries 0），重试交给下面的 retryAssistantCall。
    const options: piAi.SimpleStreamOptions = {
      signal: request.signal,
      timeoutMs: retry.timeoutMs,
      maxRetries: 0,
    };

    //M 思考档不是 off 才传 reasoning；off 就不传，模型不思考。
    if (request.thinking !== 'off') {
      options.reasoning = request.thinking;
    }

    //M 重试的规矩：临时的错（断网、限流、超时）隔一会儿再试，最多再试 retry.times 次；喊停了不再试。
    //M   重试、判断哪种错值得再试，都是 pi 的 retryAssistantCall 做的。
    const policy: piAi.RetryPolicy = {
      enabled: true,
      maxRetries: retry.times,
      baseDelayMs: retry.waitMs,
    };

    //M 发一次：每次失败（stopReason 是 error）发一次通知 model/failed，重试的那几次插件也看得到；被喊停的 aborted 不发。
    const send = async (): Promise<piAi.AssistantMessage> => {
      const start = Date.now();
      const answer = await resources.models.completeSimple(model, context, options);
      if (answer.stopReason !== 'error') return answer;

      const failed: ModelFailed = {
        session: request.session,
        model: request.model,
        error: answer.errorMessage ?? '',
        ms: Date.now() - start,
      };
      this.ctx.emit('model/failed', failed);
      return answer;
    };

    //M 发请求，失败了照上面的规矩再试。
    const answer = await piAi.retryAssistantCall(send, policy, request.signal);

    //G pi 把失败写在回答的 stopReason 里，不抛错。出错、被喊停都在这里统一抛出去。
    if (answer.stopReason === 'error' || answer.stopReason === 'aborted') {
      const reason = answer.errorMessage ?? `模型请求没成（${answer.stopReason}）`;
      throw new Error(reason);
    }
    return answer;
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
        const reason = textModule.getMessage(error);
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
   * 循环本身：一步 = 调一次模型，加上执行它要的工具。不数步数，一直走到下面三种情况之一：
   * 模型不再要工具（做完了）；有人喊停（stop()）；某个关口上有插件写了 stop。
   * @param signal 这一轮的取消信号。
   */
  private async loop(signal: AbortSignal): Promise<void> {
    //M step 只用来记这是第几步（给跟踪看），不拿它限制会话。
    for (let step = 1; ; step += 1) {
      //G 被喊停了 → 不往下走。
      if (this.row.state !== 'running') return;

      //M 用户说了、还没接进对话的话，这时候接进去。
      for (const waiting of this.inbox.splice(0)) {
        this.append(waiting);
      }

      //M 关口一，调模型之前：备好这一步的请求，交给插件挨个改（session/request）。
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

      //G 有插件喊停 → 不调模型，这一轮停在这里，理由写进 reply。
      if (request.stop !== undefined) {
        this.stop(request.stop);
        return;
      }

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
      this.ctx.emit('trace', 'Session.loop', doing, 'ctx.sessions.chat(request)', vars);

      //M 调模型（Sessions.chat，就在本文件上面）。插件已经给了回答（假模型）就不发请求。
      let answer = request.answer;
      if (answer === undefined) {
        answer = await this.ctx.sessions.chat(request);
      }

      //G 等模型的时候被喊停了 → 这次回答不要了。
      if (this.row.state !== 'running') return;

      //M 关口二，模型回来之后：回答接进对话之前，带着回答交给插件挨个看（session/after-model）。
      const answered: AnsweredRequest = { ...request, answer };
      await this.ctx.serial('session/after-model', answered);

      //G 有插件喊停 → 这次回答不要了（里面要的工具也不执行），这一轮停在这里。
      if (answered.stop !== undefined) {
        this.stop(answered.stop);
        return;
      }

      //M 插件可能改了、换了回答，以最后这一份为准，接进对话。
      answer = answered.answer;
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

      //M 模型要了工具 → 一个个执行（关口三 session/before-tool 在 Tools.execute 里），结果接进对话，回到开头走下一步。
      for (const call of calls) {
        const executed = await this.ctx.tools.execute(call, this, signal);

        //M 关口四，工具执行之后：结果接进对话之前，交给插件挨个看（session/after-tool）。
        const done: ToolDone = { session: this, call, outcome: executed };
        await this.ctx.serial('session/after-tool', done);

        //M 插件可能改了结果，以改过的为准。
        const outcome = done.outcome;

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
        //M 把打包好的工具结果追加到对话历史并落库广播，供下一步继续喂给模型。
        this.append(result);

        //G 有插件喊停 → 这一轮停在这里。结果已经接进对话（要和工具调用配对）；
        //G   这一批后面的工具，Tools.execute 看到停了就不执行，只交回“未执行”接进对话。
        if (done.stop !== undefined) {
          this.stop(done.stop);
        }
      }
    }
  }

  /**
   * 喊停。前台的 stop_session 工具、将来的界面按钮都调它；四个关口上有插件写了 stop，会话循环也调它。
   * @param by 谁喊的，或者为什么停（关口上插件写的 stop）。写进 reply：已停止（by）。
   * 副作用：状态改成 stopped；正在等的模型请求马上掐掉；正在跑的那个工具拿到同一个停止信号，
   *   慢的马上断开（快的照常做完），后面的不再执行。
   */
  stop(by: string): void {
    const aborter = this.aborter;

    //G 没在转 → 没有要停的。
    if (aborter === undefined) return;

    //G 这一轮已经停了、还在收尾（后面的工具交回“未执行”）→ 不再停一次。
    //G   再停一次会再发一次 session/change，bots 就会把停下的话再发给用户一遍。
    if (this.row.state !== 'running') return;

    //M 改写停止状态并落库广播，同时触发 abort 掐断等待中的模型请求与工具。
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

    //M 按主键覆盖持久化这一场会话的元信息与完整对话数组。
    const sql = 'INSERT OR REPLACE INTO sessions (id, meta, messages) VALUES (?, ?, ?)';
    const query = this.ctx.resources.db.query(sql);
    query.run(meta.id, metaJson, messagesJson);
  }

  /**
   * 往对话后面接一条：存库，通知大家。
   * @param message 用户的话、模型的回答，或者工具的结果。
   */
  private append(message: piAi.Message): void {
    //M 先写进内存与库中保证不丢消息，再通知订阅该会话新消息的插件。
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
    //M 同步更新状态与结果正文并落库，再通知监听状态变更的插件。
    this.row.state = state;
    this.row.reply = reply;
    this.save();
    this.ctx.emit('session/change', this);
  }
}
