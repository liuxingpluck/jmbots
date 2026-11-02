/**
 * 消息分派：渠道（飞书……）收到用户一句话，先开一个“分派对话”，由机器人自己决定这句话属于哪件事，再照做。
 * 和 Dispatcher.ts 不同：Dispatcher 只在新会话里定“交给谁做”；这里定“这句话属于哪件事”。
 *
 * 用户 11-02 的原话：
 *   “每次的飞书对话都会触发对应的分派分析，然后周小灵她自己去决定沿用之前的对话还是用新的对话，
 *    因为我可能同时发 n 个消息，对应的任务可能是 n 个也可能是 n-x 个……”
 *   “周小灵这个 bot 应该能够去调用并查看对应的历史对话信息……如果是别人的对话，现在先不管权限，留一个口子让它能够看到所有对话。”
 *   “看到飞书上的一个消息，我至少要能看到两份日志：分派型日志（时间ID_分派xxx）……执行型日志。”
 *
 * 分派对话就是一次普通的执行（Engine 跑，日志照常生成），只是：种类 route、标题以“分派_”开头、
 * 系统提示词多了这里的 RULES 和现状、只给 taskdbsearch 和 taskdbread 两个查历史的工具、用简单规则判断。
 * 它最后回一个 JSON，parseAnswer 读出动作：
 *   continue  接着某个已有的执行对话（同一件事的补充、追问、纠正）
 *   new       开新的执行对话（一件新的事），带 AI 起的标题
 *   approve   放行某条待确认命令（用户在常规对话里说了同意）
 *   reject    拒绝某条待确认命令
 *   ask_user  先问用户一句（比如拿不准用哪个模型，推荐几个请用户选），这次不开执行对话
 * new 可以带 model、thinking：按“模型能力评价”给这件事挑模型和思考强度（用户 11-02：要让 AI 判断哪个模型质量最好、速度均衡；
 * 初期评价不全，没有合适的模型时要向用户推荐或让用户选，通过对话或卡片）。
 * 读不出来时用 fallbackRoute 退回老办法：同一来源最近的执行对话就接着，否则开新的。
 * 这里不知道消息来自哪个渠道，也不执行动作；执行在 Engine.handleMessage。
 *
 * 提速（11-02 晚，用户的“分派模型”设想，对照 DeepSeek Super-agent 原型的 Gate 准入和 Thread 直通）：
 *   threadRoute  用户引用回复了某个执行对话发出的消息，直接接着那个会话，不问模型；
 *   gate         程序能定的先定：只有一条待确认命令时的“放行”“拒绝”，单纯的“收到”“好的”；
 *   两者都定不了才开分派对话问模型（分派对话用最快的模型，见 Runtime.engine.routeModel）。
 */
import * as checks from '../utils/Checks.ts';
import * as utils from '../utils/Utils.ts';
import type * as eventsModule from '../store/Events.ts';
import type * as modelModule from './Model.ts';


/** 一个动作。 */
export type RouteAction =
  | { type: 'continue'; sessionId: string; input: string }
  | { type: 'new'; input: string; title: string; model?: string; thinking?: string }
  | { type: 'approve' | 'reject'; approvalId: number; note: string }
  | { type: 'ask_user'; text: string };


/** 分派结论。 */
export interface RouteResult {
  /** 要做的动作，至少一个。 */
  actions: RouteAction[];

  /** 理由（给人看的日志）。 */
  reason: string;

  /** 分派对话的标题（不含“分派_”）：AI 对这句话的概括。 */
  title: string;

  /** 是不是退回了老办法（模型出错、回答读不出来）。 */
  fallback: boolean;
}


/** 现状里最多列几个会话。 */
const MAX_SESSIONS = 8;


/** 分派规矩（固定写法；机器人可以在自己 config.yaml 的 system 里加“分派”积木补充）。 */
export const RULES = `你现在在“分派对话”里：用户刚发来一句话，你先不做事，只决定这句话该怎么处理。下面“现状”列出了这个聊天最近的执行对话和所有等用户确认的命令。
需要时可以用 taskdbsearch 查别的会话（所有会话都能查），用 taskdbread 读一个会话的完整内容，弄清楚这句话接的是哪件事。
- 这句话是某个会话那件事的补充、追问、纠正或催促，就接着那个会话（continue），哪怕它正在执行；
- 是一件新的事，就开新会话（new），title 写一个简短的标题（十个字左右，概括这件事）；一句话里有几件互不相干的事，可以拆成几个动作，input 写各自那部分；
- 用户的话表明同意执行某条等确认的命令（比如“可以”“执行吧”“那个命令放行”），就 approve；明确不同意就 reject；
  只有等确认的命令只有一条、或者用户说清了是哪条时才这么判，note 写用户的原话；放行之外还有别的要求，再加 continue 或 new 动作。
- 开新会话时，按“模型能力评价”给这件事挑质量最好、速度也合适的模型（model 写“可用模型”里的完整 ID）和思考强度（thinking 写那个模型支持的档位）；
  简单聊天、问候可以不写 model（用你自己的默认模型）。评价里没有可参考的、或者拿不准时，不要硬选：用 ask_user 向用户推荐两三个模型和理由，请用户选，这次不开新会话；
  用户回了选择（下一句话），再按他选的开新会话。“你最近问用户的话”里有你上次问的内容。
- 用户连着发了几条时，会合成一条、标上序号交给你：可能是几件事，也可能是同一件事分几句说，按意思拆或合。
最后只回一个 JSON 对象，不要别的文字：
{"title": "这句话的简短概括", "actions": [{"type": "continue", "session_id": "会话 ID", "input": "交给这个会话的话"}, {"type": "new", "title": "标题", "input": "...", "model": "可空", "thinking": "可空"}, {"type": "approve 或 reject", "approval_id": 1, "note": "..."}, {"type": "ask_user", "text": "要问用户的话"}], "reason": "一句话理由"}`;


/**
 * 同一来源最近的执行对话，新的在前；隔太久的不算。
 * @param store 数据库。
 * @param source 来源。
 * @param idleHours 多久没说话的不算，小时。
 */
function recentSessions(store: eventsModule.EventStore, source: string, idleHours: number): eventsModule.SessionRow[] {
  /** 列得出来的最早时间。 */
  const since = Date.now() - idleHours * 3_600_000;
  return store.listSessions({ source, kind: 'task', limit: MAX_SESSIONS }).filter((session) => session.updatedAt >= since);
}


/**
 * 拼“现状”积木：这个聊天最近的执行对话、所有等确认的命令、最近问过用户的话、可用模型和模型能力评价。
 * @param store 数据库。
 * @param source 来源，如“飞书私聊 oc_xxx”。
 * @param idleHours 多久没说话的会话不列，小时。
 * @param models 可用的常规模型（ID、档位、价格）。
 * @param review 模型能力评价（知识库/模型评价.md）；还没有时是空字符串。
 */
export function situation(store: eventsModule.EventStore, source: string, idleHours: number, models: modelModule.ModelSummary[], review: string): string {
  /** 最近的执行对话。 */
  const sessions = recentSessions(store, source, idleHours);
  /** 所有等确认的命令（用户只有一个人，别的渠道起的命令也可以在这里放行）。 */
  const approvals = store.listPendingApprovals();
  return [
    `这个聊天（${source}）最近 ${idleHours} 小时的执行对话（新的在前）：`,
    ...(sessions.length > 0
      ? sessions.map((session) => {
          /** 最后一次执行的输入。 */
          const lastInput = (store.listEvents(session.id, 'execution').at(-1)?.payload as { input?: string } | undefined)?.input ?? '';
          return [
            `- 会话 ${session.id}「${session.title}」，${session.status}，最后活动 ${utils.formatTime(session.updatedAt)}`,
            `  最后的输入：${utils.truncate(lastInput, 200)}`,
            `  最后的回复：${utils.truncate(session.lastReply ?? '', 200)}`,
          ].join('\n');
        })
      : ['- 无']),
    '等用户确认的命令：',
    ...(approvals.length > 0
      ? approvals.map((approval) => `- 待确认 ${approval.id}（会话 ${approval.sessionId}）：${utils.truncate(approval.command, 300)}，目录 ${approval.workDir}`)
      : ['- 无']),
    '你最近问用户的话（一小时内）：',
    ...recentAsks(store, source),
    '可用模型（ID：思考档位，价格 输入/输出 美元每百万 token；多数是订阅，价格只作参考）：',
    ...models.filter((item) => item.kind === 'chat').map((item) => `- ${item.id}：${item.thinking.join('、')}，${item.price.input}/${item.price.output}`),
    '模型能力评价：',
    review.trim() || '（还没有评价，挑模型拿不准时问用户）',
  ].join('\n');
}


/**
 * 这个聊天一小时内分派对话里问过用户的话（ask_user），让下一次分派接得上用户的回答。
 * @param store 数据库。
 * @param source 来源。
 */
function recentAsks(store: eventsModule.EventStore, source: string): string[] {
  /** 结果。 */
  const asks: string[] = [];
  for (const session of store.listSessions({ source, kind: 'route', limit: 5 })) {
    if (Date.now() - session.updatedAt > 3_600_000) {
      continue;
    }
    for (const event of store.listEvents(session.id, 'route_result')) {
      /** 这次分派的动作。 */
      const actions = ((event.payload as { actions?: RouteAction[] }).actions ?? []).filter((action) => action.type === 'ask_user');
      /** 用户那句话。 */
      const userText = (store.listEvents(session.id, 'execution')[0]?.payload as { input?: string } | undefined)?.input ?? '';
      for (const action of actions) {
        asks.push(`- ${utils.formatTime(event.createdAt)} 用户说“${utils.truncate(userText, 100)}”，你问：${utils.truncate(action.text, 300)}`);
      }
    }
  }
  return asks.length > 0 ? asks : ['- 无'];
}


/** 程序直接认的“放行”说法（只在待确认命令只有一条时用）。 */
const APPROVE_WORDS = /^(放行|通过|同意|批准|可以执行|执行吧|执行|放行吧|ok|yes)[!！。.~～]*$/i;

/** 程序直接认的“拒绝”说法（只在待确认命令只有一条时用）。 */
const REJECT_WORDS = /^(拒绝|不行|不要执行|别执行|不同意|取消)[!！。.~～]*$/;

/** 单纯的回应，不用开任务（没有待确认命令、一小时内也没问过用户时才这么认）。 */
const ACK_WORDS = /^(收到|好的?|好滴|嗯+|哦+|ok|谢谢|多谢|辛苦了?|👍|👌)[!！。.~～]*$/i;


/**
 * 引用回复直通：用户引用回复了某个执行对话发出的消息，就接着那个会话，不用分派。
 * @param store 数据库（按消息 ID 找会话）。
 * @param replyTo 用户引用的那条消息在渠道里的 ID；没引用时是 undefined。
 * @param text 用户的话。
 * @returns 结论；没引用、找不到会话时是 undefined。
 */
export function threadRoute(store: eventsModule.EventStore, replyTo: string | undefined, text: string): RouteResult | undefined {
  /** 发出那条消息的会话。 */
  const session = replyTo ? store.findSessionBySent(replyTo) : undefined;
  //G 没引用，或引用的不是执行对话发出的消息。
  if (!session || session.kind !== 'task') {
    return undefined;
  }
  return {
    actions: [{ type: 'continue', sessionId: session.id, input: text }],
    reason: `用户引用回复了会话 ${session.id}「${session.title}」发出的消息，直接接着它（没问模型）`,
    title: text.replace(/\s+/g, ' ').trim().slice(0, 20),
    fallback: false,
  };
}


/**
 * 程序先过的一道门：不用问模型就能定的直接定。
 * @param store 数据库（看待确认命令、最近问过用户的话）。
 * @param text 用户的话。
 * @param source 来源。
 * @returns 结论（动作可以是空的：只是回应，什么都不用做）；定不了时是 undefined。
 */
export function gate(store: eventsModule.EventStore, text: string, source: string): RouteResult | undefined {
  /** 去掉首尾空白的原话。 */
  const said = text.trim();
  /** 等确认的命令。 */
  const approvals = store.listPendingApprovals();
  /** 唯一一条待确认命令。 */
  const only = approvals.length === 1 ? approvals[0] : undefined;
  if (only && (APPROVE_WORDS.test(said) || REJECT_WORDS.test(said))) {
    /** 放行还是拒绝。 */
    const type = APPROVE_WORDS.test(said) ? 'approve' : 'reject';
    return {
      actions: [{ type, approvalId: only.id, note: said }],
      reason: `只有一条待确认命令（${only.id}），用户说“${said}”，程序直接${type === 'approve' ? '放行' : '拒绝'}（没问模型）`,
      title: type === 'approve' ? '放行命令' : '拒绝命令',
      fallback: false,
    };
  }
  if (approvals.length === 0 && ACK_WORDS.test(said) && recentAsks(store, source)[0] === '- 无') {
    return { actions: [], reason: `用户只是回应“${said}”，不用开任务（没问模型）`, title: '回应', fallback: false };
  }
  return undefined;
}


/**
 * 老办法：同一来源最近的执行对话就接着，否则开新的。
 * @param store 数据库。
 * @param text 用户的话。
 * @param source 来源。
 * @param idleHours 多久没说话的不算，小时。
 * @param reason 为什么退回老办法。
 */
export function fallbackRoute(store: eventsModule.EventStore, text: string, source: string, idleHours: number, reason: string): RouteResult {
  /** 最近一个执行对话。 */
  const latest = recentSessions(store, source, idleHours)[0];
  /** 用户的话的开头，当标题。 */
  const title = text.replace(/\s+/g, ' ').trim().slice(0, 20);
  if (latest) {
    return { actions: [{ type: 'continue', sessionId: latest.id, input: text }], reason, title, fallback: true };
  }
  return { actions: [{ type: 'new', input: text, title }], reason, title, fallback: true };
}


/**
 * 读分派对话最后的 JSON 回答，逐个核对；对不上的动作丢掉，不认识的模型、档位去掉（用默认的）。
 * @param store 数据库（核对会话、待确认存不存在）。
 * @param reply 分派对话最后的回复。
 * @param text 用户的原话（动作没写 input 时用它）。
 * @param models 可用模型（核对 model、thinking）；不给就不核对。
 * @returns 结论；一个可用的动作都没有时是 undefined（调用方退回老办法）。
 */
export function parseAnswer(store: eventsModule.EventStore, reply: string, text: string, models?: modelModule.ModelSummary[]): RouteResult | undefined {
  /** 回答。 */
  const answer = checks.extractJson(reply);
  /** 原始动作。 */
  const rawActions = Array.isArray(answer?.actions) ? (answer.actions as unknown[]) : [];
  /** 等确认的命令。 */
  const approvals = store.listPendingApprovals();
  /** 核对过的动作。 */
  const actions: RouteAction[] = [];
  for (const item of rawActions) {
    /** 一个动作。 */
    const raw = (item ?? {}) as Record<string, unknown>;
    /** 交给会话的话；没写就用整句。 */
    const input = typeof raw.input === 'string' && raw.input.trim() ? raw.input.trim() : text;
    /** 要接着的执行对话（分派对话不能接着）。 */
    const session = typeof raw.session_id === 'string' ? store.getSession(raw.session_id) : undefined;
    if (raw.type === 'continue' && session?.kind === 'task') {
      actions.push({ type: 'continue', sessionId: session.id, input });
    } else if (raw.type === 'new') {
      /** 标题；没写用输入的开头。 */
      const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : input.slice(0, 20);
      /** 挑的模型（只认可用模型里的）。 */
      const chosen = pickModel(raw.model, models);
      /** 挑的档位（只认那个模型支持的）。 */
      const thinking = typeof raw.thinking === 'string' && chosen && (!models || chosen.thinking.includes(raw.thinking)) ? raw.thinking : undefined;
      actions.push({ type: 'new', input, title, ...(chosen ? { model: chosen.id } : {}), ...(thinking ? { thinking } : {}) });
    } else if (raw.type === 'ask_user' && typeof raw.text === 'string' && raw.text.trim()) {
      actions.push({ type: 'ask_user', text: raw.text.trim() });
    } else if ((raw.type === 'approve' || raw.type === 'reject') && approvals.some((approval) => approval.id === Number(raw.approval_id))) {
      actions.push({ type: raw.type, approvalId: Number(raw.approval_id), note: typeof raw.note === 'string' && raw.note ? raw.note : text });
    }
  }
  if (actions.length === 0) {
    return undefined;
  }
  return {
    actions,
    reason: typeof answer?.reason === 'string' ? answer.reason : '',
    title: typeof answer?.title === 'string' && answer.title.trim() ? answer.title.trim() : text.slice(0, 20),
    fallback: false,
  };
}


/**
 * 核对分派挑的模型：只认可用模型里的；不给模型清单时照收。
 * @param value 回答里的 model。
 * @param models 可用模型。
 * @returns 模型 ID 和它支持的档位；没挑或不认识时是 undefined。
 */
function pickModel(value: unknown, models: modelModule.ModelSummary[] | undefined): { id: string; thinking: string[] } | undefined {
  //G 没挑。
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  if (!models) {
    return { id: value.trim(), thinking: [] };
  }
  return models.find((item) => item.id === value.trim());
}


/**
 * 动作写成一句话（打印、记日志用）。
 * @param action 动作。
 */
export function describeAction(action: RouteAction): string {
  if (action.type === 'continue') {
    return `接着会话 ${action.sessionId}`;
  }
  if (action.type === 'new') {
    return `开新会话「${action.title}」${action.model ? `（${action.model}${action.thinking ? ` ${action.thinking}` : ''}）` : ''}`;
  }
  if (action.type === 'ask_user') {
    return `问用户：${utils.truncate(action.text, 60)}`;
  }
  return `${action.type === 'approve' ? '放行' : '拒绝'}待确认 ${action.approvalId}`;
}
