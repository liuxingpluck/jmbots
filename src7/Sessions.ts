/**
 * 会话：最重要的一个文件。骨架只管这一件事：一场会话怎么跑。
 * Sessions 管表；Session 是一场对话：一份记录（row），加上推它往下走的循环（run）。
 * 谁开的会话、话从哪来、回话往哪送，骨架都不知道，那是插件的事（机器人是 plugins/bots）。
 *
 * 主线全是直接调用，按 F12 能跳到实现：工具清单和执行工具调 ctx.tools，发模型请求调 Sessions.chat()。
 * 发模型请求只依赖 pi（PI agent SDK，@earendil-works/pi-ai）。
 * 不按步数限制：模型不再要工具就做完了，有人喊停就停下。步数只记在 row.steps（跨 run 累计），给插件看。
 *
 * 事件只留给插件接进来。每一步有四个关口，插件挨个看，谁写了 stop 这一轮就停在那里（类型见 SessionGate）：
 *   session/before-model   调模型之前，请求交给插件挨个改（本文件）；
 *   session/after-model  模型回来之后、回答接进对话之前（本文件）；
 *   session/before-tool  执行一个工具之前，还能用 deny 只拦这一个（声明在 src7/Tools.ts:29，发出在 :178）；
 *   session/after-tool   一个工具执行完、结果接进对话之前（本文件）。
 * 另外三个只是通知，也声明在本文件：
 *   session/new-message  对话里新接了一条；
 *   session/change   状态变了；
 *   session/model-failed     模型调用失败了一次。
 */
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { ToolDone } from './Tools.ts';
import { createTimestampId } from './utils/Names.ts';
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
     * 谁发：src7/Sessions.ts 的 Session.getStepAnswer
     * 谁接：
     *   src7/plugins/approval/index.ts 的 Approval.constructor
     *   src7/plugins/assist/index.ts 的 Assist.constructor
     *   src7/plugins/bots/ChannelTools.ts 的 ChannelTools.constructor
     *   src7/plugins/bots/DispatchTools.ts 的 DispatchTools.constructor
     *   src7/plugins/bots/FrontDesk.ts 的 FrontDesk.constructor
     *   src7/plugins/bots/Prompt.ts 的 Prompt.constructor
     *   src7/plugins/context-fit/index.ts 的 apply
     *   src7/plugins/fake-model/index.ts 的 apply
     *   src7/plugins/file-tools/BaseTools.ts 的 BaseTools.constructor
     *   src7/plugins/file-tools/Skill.ts 的 applySkills
     *   src7/plugins/memory/GraphRoutes.ts 的 GraphRoutes.constructor
     *   src7/plugins/memory/index.ts 的 Memory.constructor
     *   src7/plugins/model-catalog/Fallback.ts 的 ModelFallback.constructor
     *   src7/plugins/progress/GroupDaily.ts 的 bindReportTools
     *   src7/plugins/progress/index.ts 的 Progress.constructor
     *   src7/plugins/relay/index.ts 的 Relay.constructor
     *   src7/plugins/wechat/index.ts 的 Wechat.constructor
     */
    'session/before-model'(request: ChatRequest): void | Promise<void>;
    /**
     * 关口二，模型回来之后、回答接进对话之前：照先后一个个 await。
     * 能看能改 request.answer（换掉也行，以最后的为准）；在 request.stop 写理由，这次回答就不要了
     * （里面要的工具也不执行），这一轮停在这里。
     * 谁发：src7/Sessions.ts 的 Session.getStepAnswer
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
     * 对话里新接了一条（用户的话、模型的回答、工具结果）。任意时刻都可能发，只是通知，不能拦。
     * @param session 收到新消息的会话。
     * @param message pi-ai 的 `Message` 是对话历史中的一条。按 `role` 区分四种形状。
     * - `role: 'system'` 是给模型的指令，`content` 是字符串或 `TextContent[]`。
     * - `role: 'user'` 是用户输入，`content` 是字符串或由 `TextContent`、`ImageContent` 组成的数组。
     * - `role: 'assistant'` 是模型回答，`content` 包含文字、思考或工具调用。
     * - `role: 'toolResult'` 是工具结果，`content` 包含文字和图片，`toolCallId` 将结果与调用配对。
     * - `timestamp` 是各类消息的 Unix 毫秒时间戳。
     * 全部字段见 node_modules/@earendil-works/pi-ai/dist/types.d.ts:346–436。
     * 谁发：src7/Sessions.ts 的 Session.append
     * 谁接：
     *   src7/plugins/bots/FrontDesk.ts 的 FrontDesk.constructor
     *   src7/plugins/journal/FilesMirror.ts 的 FilesMirror.constructor
     *   src7/plugins/journal/index.ts 的 Journal.listen
     *   src7/plugins/memory/index.ts 的 Memory.constructor
     *   src7/plugins/model-catalog/Usage.ts 的 Usage.constructor
     *   src7/plugins/progress/index.ts 的 Progress.constructor
     */
    'session/new-message'(session: Session, message: piAi.Message): void;
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
     */
    'session/change'(session: Session): void;
    /**
     * 模型调用失败了一次（含会重试的那几次；被喊停的不算）。通知，用量、追溯这类插件听它。
     * 谁发：src7/Sessions.ts 的 Sessions.chat
     * 谁接：
     *   src7/plugins/model-catalog/Fallback.ts 的 ModelFallback.attempt
     *   src7/plugins/model-catalog/Usage.ts 的 Usage.constructor
     */
    'session/model-failed'(info: ModelFailed): void;
  }
}


/** 事件 session/model-failed 带的东西。 */
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
 * 字面取值见 node_modules/@earendil-works/pi-ai/dist/providers/model-schema.d.ts:8、80。
 * 各模型支持哪些档、实际发什么，见 [model-catalog「思考档位」](plugins/model-catalog/说明.md#思考档位)。
 */
export type Thinking = piAi.ModelThinkingLevel;


/**
 * 四个关口事件（session/before-model、session/after-model、session/before-tool、session/after-tool）共有的两项。
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
 * 一步的请求。会话备好，先交给插件挨个改（事件 session/before-model），再交给 Sessions.chat() 发出去；
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
  /**
   * 这一步给模型看的 pi-ai `Tool` 定义。
   * - `name` 是模型调用时写的工具名。
   * - `description` 告诉模型工具能做什么。
   * - `parameters` 是 TypeBox 的参数 schema。
   * - `constrainedSampling` 可选，取 `false` 或 `ConstrainedSamplingConfig`。
   * 全部字段见 node_modules/@earendil-works/pi-ai/dist/types.d.ts:528。
   */
  tools: piAi.Tool[];
  /** 这一步要发给模型的对话副本。改它不会改库里存的原文。`Message` 的四种形状见本文件 L96。 */
  messages: piAi.Message[];
  /** 取消信号：喊停时触发，正在等的请求马上断开。 */
  signal: AbortSignal;
  /**
   * 插件可直接给出这一步的 pi-ai `AssistantMessage`，有了它会话就不调 chat()。
   * - `role: 'assistant'` 表示模型回答。
   * - `content` 是数组，`TextContent` 给可见文字，`ThinkingContent` 给思考，`ToolCall` 是待执行的工具调用。
   * - `stopReason` 取 `'pending'`、`'stop'`、`'length'`、`'toolUse'`、`'error'`、`'aborted'` 或 `'deferred'`。
   * - `usage` 是本次的 `Usage`，记录 token 和费用。
   * - `usage.input` 是输入 token 数。
   * - `usage.output` 是输出 token 数，已含供应商报告的 `reasoning`。
   * - `usage.cacheRead` 是命中缓存而读取的 token 数。
   * - `usage.cacheWrite` 是写进缓存的 token 数。
   * - `usage.totalTokens` 是供应商适配器记录的总 token 数。
   * - `usage.cost` 包含 `input`、`output`、`cacheRead`、`cacheWrite` 和 `total`。
   * - `api` 是接口适配器标识。
   * - `model` 是模型 ID。
   * - `provider` 是供应商标识。
   * - `errorMessage` 可选，记录失败原因。
   * - `timestamp` 是发起请求时的 Unix 毫秒时间戳。
   * 全部字段见 node_modules/@earendil-works/pi-ai/dist/types.d.ts:368，`Usage` 见同文件 285 行，`StopReason` 见 307 行。
   */
  answer?: piAi.AssistantMessage;
}


/** 事件 session/after-model 的数据：就是这一步的请求，回答已经有了（模型回的，或者插件给的）。 */
export type AnsweredRequest = ChatRequest & {
  /** 这一步的回答。插件可以改它、换掉它，接进对话的是最后这一份。`AssistantMessage` 见本文件 L216。 */
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
  /** 整场对话，随这场会话一起存库。`Message` 的四种形状见本文件 L96。 */
  messages: piAi.Message[];
  /**
   * 这场会话一共走了多少步，一步 = 调一次模型加执行它要的工具。跨 run 累计、存库，
   * 喊停、出错、重启后接着跑都不归零。骨架只记不限，要按步数限制的插件在关口事件里读它。
   */
  steps: number;
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
  Omit<SessionRow, 'id' | 'model' | 'thinking' | 'state' | 'reply' | 'messages' | 'steps' | 'updatedAt'>
  & Partial<Pick<SessionRow, 'model' | 'thinking'>>;


/**
 * 开小会话提问所需的会话属性、问题和停止信号。插件把单独的模型判断放在小会话里，
 * 让用户当前对话继续保留原来的消息。调用场景见 `Sessions.ask`。
 */
export type AskInput = NewSession & {
  /** 要问的话，整段交给小会话。 */
  text: string;
  /** 提问方的停止信号（提问的会话停了、超时）：断了小会话也停。不给就跑到底。 */
  signal?: AbortSignal;
};


/**
 * 小会话做完后交回提问插件的结果。插件凭 `ok` 和 `reply` 决定怎么处理，
 * 问答明细留在小会话自己的记录里。
 */
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

  /**
   * 打开过的会话：会话号 → 对象，照最近用过的先后排（Map 照放进去的先后，最旧的在前）。
   * 新开的、从库里读出来的都放这，跑完也不马上删（不是“正在跑的会话”）。
   * 同一场在内存里只有一个对象：run() 靠它防重入，stop() 要按到正在转的那个，inbox 里排着的话不能丢。
   * 有上限（config.yaml 的 session_cache_max），超了由 remember() 从最旧的挪出闲着的（Session.isIdle）：
   *   能挪，是因为库里有完整记录（append、change 每次都存库），再 open 从库里重建，不丢东西；
   *   忙的不挪（在转的、有话排着的）：stop 要按到同一个对象，inbox 不能丢；全都忙就暂时超着。
   * 已知限制：插件要是长期攥着一个已被挪出的旧对象，再去 add、run，会和重新打开的新对象分叉。
   */
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
   * 会话号由 createTimestampId() 生成：本机本地时间的年月日时分秒毫秒（17 位）加 3 位随机数字，共 20 位纯数字，
   * 时刻部分使用本机时区。
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
      const id = createTimestampId();
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
        steps: 0,
        updatedAt: Date.now(),
      };
      //M 按配置补齐模型与思考档并创建新会话实例，随后写入持久化列表。
      const session = new Session(row, this.ctx);
      //M 立即落库持久化并记进 openedSessions，确保后续消息与停止动作能命中同一实例。
      session.save();
      this.remember(session);
      return session;
    }
  }

  /**
   * 打开一场。
   * @param id 会话号。
   * @returns 会话对象。还在 openedSessions 里就交回同一个对象；闲着被挪出过的，从库里重建一个新的。
   * @throws 没有这场时抛错。
   */
  open(id: string): Session {
    //M 先查内存里已打开的会话对象，直接复用以保持运行开关和未入队消息一致；挪到最新。
    const opened = this.openedSessions.get(id);
    if (opened !== undefined) {
      this.remember(opened);
      return opened;
    }

    //M 库里的两块读出来，拼回一份记录。
    const sql = 'SELECT meta, messages FROM sessions WHERE id = ?';
    const query = this.ctx.resources.db.query(sql);
    const stored = query.get(id) as { meta: string; messages: string } | null;

    //G 库里没有 → 抛错。
    if (stored === null) {
      throw new Error(`没有这场会话：${id}`);
    }

    //M 解析磁盘元信息与对话历史重建会话实例，并记进 openedSessions 供同一场对话复用。
    const meta = this.parseMeta(stored.meta);
    //M 按保存时的 pi-ai Message[] 还原整场对话。Message 的四种形状见本文件 L96。
    const messages = JSON.parse(stored.messages) as piAi.Message[];
    const session = new Session({ ...meta, messages }, this.ctx);
    this.remember(session);
    return session;
  }

  /**
   * 把会话记进 openedSessions，挪到最新；超了上限，从最旧的往新挪出闲着的，挪到不超为止。
   * create、open 每次交出会话前调它。为什么能挪、忙的为什么不挪，见 openedSessions 的说明。
   * @param session 刚新开、刚从库里读出来或刚命中的会话。
   */
  private remember(session: Session): void {
    //M 先删再放，挪到最新（Map 照放进去的先后排）。
    this.openedSessions.delete(session.id);
    this.openedSessions.set(session.id, session);

    //M 从最旧的往新扫：不超上限了就停；忙的跳过；闲着的挪出内存。
    const max = this.ctx.resources.config.sessionCacheMax;
    for (const opened of this.openedSessions.values()) {
      if (this.openedSessions.size <= max) return;

      //G 扫到刚放进去的这场（最新那个）就停：它马上要交给调用方用，不能挪。
      if (opened === session) return;

      if (!opened.isIdle()) continue;

      this.openedSessions.delete(opened.id);
    }
  }

  /**
   * 把库里 meta 那一列解析回记录（不带对话）。open、find 读库都走这里。
   * @param json 库里 meta 列的原文。
   * @returns 记录。早先存的会话没有 steps（后加的一项），在这里补 0，往后内部直接用。
   */
  private parseMeta(json: string): SessionMeta {
    const meta = JSON.parse(json) as Omit<SessionMeta, 'steps'>
      & Partial<Pick<SessionMeta, 'steps'>>;
    const steps = meta.steps ?? 0;
    return { ...meta, steps };
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
    return found.map((item) => this.parseMeta(item.meta));
  }

  /**
   * 插件需要借模型做一项单独的判断或整理时，开一场小会话。问题和模型的回答存入小会话，
   * 提问插件拿回结果处理，用户正在聊的会话保留自己的消息。
   * 小会话用同样的 create → queueUserMessage → run 流程，照常经过关口事件和轨迹记录。提问方停了，小会话也停。
   * 审批插件判断操作风险，context-fit 的 Compress 压缩旧对话、Summary 写总结，
   * progress 的 Review 做复盘，decision 插件向模型提问辅助判断。
   * @param input 开会话的那些项（种类、嵌在哪场里、模型、思考档、bot……），加上要问的话和停止信号。
   * @returns 做没做完，和小会话的 reply。
   * 副作用：开会话、调模型、写库。
   */
  async ask(input: AskInput): Promise<AskResult> {
    //M 要问的话和停止信号不进记录，其余原样拿去开会话。
    const { text, signal, ...fields } = input;
    const child = this.create(fields);
    child.queueUserMessage(text);

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
   * Sessions 服务统一发出会话循环和换模型重发的请求。发送只依赖请求里的模型、对话、工具和取消信号。
   * 失败事件借请求里的 `session` 标识发起者。整个调用无需读取或修改这场会话的状态。
   * `Session.loop` 每一步经这里发出请求。model-catalog 的 `ModelFallback.attempt` 换模型后能把原请求
   * 交给 `ctx.sessions.chat()` 重发，两条路径共用鉴权、重试和失败通知。
   * @param request 模型、思考档、提示词、对话、工具、取消信号。
   * @returns 模型回的整条 `AssistantMessage`，字段见本文件 L216。
   * @throws 试够了次数还是不成、或者被喊停掐断时抛错；Session.run 接住。
   * 副作用：发 HTTP 请求；每失败一次发一次 session/model-failed。
   */
  async chat(request: ChatRequest): Promise<piAi.AssistantMessage> {
    //==========================================================
    //M 准备模型、对话上下文和调用选项
    //==========================================================
    /** 建好的供应商、模型和重试的配置，都在 resources 里（src7/Resources.ts）。 */
    const resources = this.ctx.resources;
    const retry = resources.config.retry;
    //M 按“供应商/模型”名查出配置好的 pi 模型定义与参数，供下面构建上下文和重连使用。
    const model = resources.getModel(request.model);

    //M 拼 pi 要的上下文：提示词的段落用空行连成一段。
    const systemPrompt = request.system.join('\n\n');
    /**
     * pi-ai `Context` 是发给模型前的提示词、历史和工具。
     * - `systemPrompt` 可选，是系统提示词。
     * - `messages` 是对话消息，`Message` 见本文件 L96。
     * - `tools` 可选，是工具定义数组，`Tool` 见本文件 L192。
     * 全部字段见 node_modules/@earendil-works/pi-ai/dist/types.d.ts:543。
     */
    const context: piAi.Context = {
      systemPrompt,
      messages: request.messages,
      tools: request.tools,
    };

    //M 请求选项：pi 自己不重试（maxRetries 0），重试交给下面的 retryAssistantCall。
    /**
     * pi-ai `SimpleStreamOptions` 是发起模型请求时的选项。
     * - `signal` 可选，用来取消请求。
     * - `timeoutMs` 可选，是接口支持时的毫秒超时。
     * - `maxRetries` 可选，是 SDK 支持时的内部重试上限。
     * - `reasoning` 可选，取 `'minimal'`、`'low'`、`'medium'`、`'high'`、`'xhigh'` 或 `'max'`。
     * - `toolChoice` 可选，取 `'auto'` 或 `'none'`。
     * 全部字段见 node_modules/@earendil-works/pi-ai/dist/types.d.ts:233，继承字段见同文件 48、107 行。
     */
    const options: piAi.SimpleStreamOptions = {
      signal: request.signal,
      timeoutMs: retry.timeoutMs,
      maxRetries: 0,
    };

    //M 思考档不是 off 才传 reasoning；off 就不传，模型不思考。
    if (request.thinking !== 'off') {
      options.reasoning = request.thinking;
    }

    //==========================================================
    //M 设定重试并记录单次请求的失败
    //==========================================================
    //M 重试的规矩：临时的错（断网、限流、超时）隔一会儿再试，最多再试 retry.times 次；喊停了不再试。
    //M   重试、判断哪种错值得再试，都是 pi 的 retryAssistantCall 做的。
    /**
     * pi-ai `RetryPolicy` 是整次调用失败后的重试策略。
     * - `enabled` 决定是否启用重试。
     * - `maxRetries` 是最多重试几次，首次调用单独计算。
     * - `baseDelayMs` 是指数退避的起始毫秒数，pi-ai 会加随机偏移。
     * - `maxAgentDelayMs` 可选，限制这层等待的最长毫秒数。
     * 全部字段见 node_modules/@earendil-works/pi-ai/dist/utils/retry.d.ts:9。
     */
    const policy: piAi.RetryPolicy = {
      enabled: true,
      maxRetries: retry.times,
      baseDelayMs: retry.waitMs,
    };

    //M 发一次：每次失败（stopReason 是 error）发一次通知 session/model-failed，重试的那几次插件也看得到；被喊停的 aborted 不发。
    /** @returns 单次请求的 `AssistantMessage`，见本文件 L216。 */
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
      this.ctx.emit('session/model-failed', failed);
      return answer;
    };

    //==========================================================
    //M 发请求并把失败或取消抛给调用方
    //==========================================================
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

  /** 当前模型步骤的取消开关；撤回只掐模型并阻止这一步尚未执行的工具。 */
  private stepAborter?: AbortController;

  /**
   * 用户说了、还没接进对话的话。每一步开头才接进去，避免插在模型的回答和工具结果之间。
   * `Message` 的四种形状见本文件 L96。
   */
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
  queueUserMessage(text: string): void {
    this.inbox.push({ role: 'user', content: text, timestamp: Date.now() });
  }

  /** 补一条会话系统消息，并让下一步模型根据更新后的历史判断。 */
  reconsider(text: string): void {
    //G 已经收尾的轮次不重新启动。
    if (this.row.state !== 'running') return;

    //M 到下一步才接入系统消息，让当前工具结果先跟调用配对。
    const message: piAi.Message = { role: 'system', content: text, timestamp: Date.now() };
    this.inbox.push(message);
    this.stepAborter?.abort();
  }

  /**
   * 闲着没有：没在转，也没有排着、还没接进对话的话。
   * Sessions.remember 只把闲着的挪出内存，忙的挪了 stop 按不到、inbox 会丢。
   */
  isIdle(): boolean {
    return this.aborter === undefined && this.inbox.length === 0;
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
        const reason = textModule.getErrorMessage(error);
        this.change('failed', `出错了：${reason}`);
      }
    } finally {
      this.stepAborter = undefined;
      this.aborter = undefined;
    }

    //G 收尾的那一下又有人说话 → 再转一轮。喊停后慢工具还在收尾时来的话也在这里转，不然要等下一句话才处理。
    if (this.inbox.length > 0) {
      void this.run();
    }
  }

  /**
   * 循环本身：一步 = 调一次模型，加上执行它要的工具。不按步数限制，一直走到下面三种情况之一：
   * 模型不再要工具（做完了）；有人喊停（stop()）；某个关口上有插件写了 stop。
   * @param signal 这一轮的取消信号。
   */
  private async loop(signal: AbortSignal): Promise<void> {
    for (;;) {
      //==========================================================
      //M 关口一 接入排队消息并让插件检查模型请求
      //==========================================================
      //G 被喊停了 → 不往下走。
      if (this.row.state !== 'running') return;

      //M 记一步：row.steps 跨 run 累计，跟着下面的 append、change 存库。
      //M   在关口一之前加，插件在 session/before-model 里读到的就是“这是第几步”；骨架只记，不拿它限制会话。
      this.row.steps += 1;

      //M 模型同时响应整轮停止与单步取消；工具执行仍只拿整轮停止信号。
      const stepAborter = new AbortController();
      this.stepAborter = stepAborter;
      const stepSignal = stepAborter.signal;
      const modelSignal = AbortSignal.any([signal, stepSignal]);

      //M 用户说了、还没接进对话的话，这时候接进去。
      for (const waiting of this.inbox.splice(0)) {
        this.append(waiting);
      }

      //M 关口一，调模型之前：备好这一步的请求，交给插件挨个改（session/before-model）。
      const request: ChatRequest = {
        session: this,
        model: this.row.model,
        thinking: this.row.thinking,
        system: [],
        tools: this.ctx.tools.listToolsForSessionKind(this.row.kind),
        messages: [...this.row.messages],
        signal: modelSignal,
      };
      //M 经过两个模型关口后接入回答；这一步被取消时，重新从队列取话。
      const answer = await this.getStepAnswer(request);
      if (answer === undefined || modelSignal.aborted) continue;

      //M 插件可能改了、换了回答，以最后这一份为准，接进对话。
      this.append(answer);

      //==========================================================
      //M 有工具就执行并经过关口三、四，没工具就结束本轮
      //==========================================================
      //M 从回答里挑出工具调用。
      /**
       * pi-ai `ToolCall` 是模型要求执行的一次调用。
       * - `type: 'toolCall'` 用来从回答的其他内容块里认出调用。
       * - `id` 用来配对调用与结果。
       * - `name` 是工具名。
       * - `arguments` 是要交给工具校验的 `JsonObject`。
       * 全部字段见 node_modules/@earendil-works/pi-ai/dist/types.d.ts:271。
       */
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
        const executed = await this.ctx.tools.execute(call, this, signal, stepSignal);

        //M 关口四，工具执行之后：结果接进对话之前，交给插件挨个看（session/after-tool）。
        const done: ToolDone = { session: this, call, outcome: executed };
        await this.ctx.serial('session/after-tool', done);

        //M 插件可能改了结果，以改过的为准。
        const outcome = done.outcome;

        //M 结果写成一条 toolResult：先是文字，后面跟着图片（有的话）。
        /**
         * pi-ai `TextContent` 是纯文字内容块。
         * - `type: 'text'` 用来区分文字与图片等内容块。
         * - `text` 是工具结果正文。
         * - `textSignature` 可选，留给带签名的内容块。
         * 全部字段见 node_modules/@earendil-works/pi-ai/dist/types.d.ts:252。
         */
        const textBlock: piAi.TextContent = { type: 'text', text: outcome.text };
        const images = outcome.images ?? [];
        /** 给模型看的工具结果，属于 `role: 'toolResult'` 的 `Message`，见本文件 L96。 */
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

  /** 走两个模型关口。收到取消信号时丢弃该步回答。 */
  private async getStepAnswer(request: ChatRequest): Promise<piAi.AssistantMessage | undefined> {
    const signal = request.signal;
    //G 接入队列时也可能触发取消，旧请求无需进入关口。
    if (signal.aborted) return;

    try {
      //M 关口一：插件在这里修改请求，也可以提供现成回答。
      await this.ctx.serial('session/before-model', request);
      if (signal.aborted) return;

      //G 有插件喊停 → 不调模型，理由写进 reply。
      if (request.stop !== undefined) {
        this.stop(request.stop);
        return;
      }

      //T 跟踪：调模型；插件已经给了回答就写明没有调。
      const vars = {
        session: this.id,
        step: this.row.steps,
        model: request.model,
        messageCount: request.messages.length,
      };
      let doing = 'trace.sessions.callModel';
      if (request.answer !== undefined) {
        doing = 'trace.sessions.answerProvided';
      }
      this.ctx.emit('trace', 'Session.loop', doing, 'ctx.sessions.chat(request)', vars);

      //M 采用插件给出的回答，或用本步的信号请求模型。
      let answer = request.answer;
      if (answer === undefined) {
        answer = await this.ctx.sessions.chat(request);
      }
      if (signal.aborted) return;

      //M 关口二：插件在回答进入历史前检查或替换回答。
      const answered: AnsweredRequest = { ...request, answer };
      await this.ctx.serial('session/after-model', answered);
      if (signal.aborted) return;

      //G 有插件喊停 → 这次回答和它要求的工具都不接入对话。
      if (answered.stop !== undefined) {
        this.stop(answered.stop);
        return;
      }
      return answered.answer;
    } catch (error) {
      //G 模型会在取消时抛错，让会话回到循环处理排队的说明。
      if (signal.aborted) return;
      throw error;
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
   * @param message 接进对话并通知插件的新消息。`Message` 的四种形状见本文件 L96。
   */
  private append(message: piAi.Message): void {
    //M 先写进内存与库中保证不丢消息，再通知订阅该会话新消息的插件。
    this.row.messages.push(message);
    this.save();
    this.ctx.emit('session/new-message', this, message);
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
