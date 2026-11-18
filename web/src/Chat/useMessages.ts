/**
 * 时间线的数据（docs/界面/01_界面设计.md 第 7.1 节）：先取最新的一页；每 1.5 秒按游标取变化（新消息、新回复、状态变了）；
 * 往上翻时按最小的消息号取更早的。换机器人时清空重来。一轮问完才排下一轮，网络慢时不会叠起来。
 */
import * as react from 'react';
import * as api from '../Api.ts';
import * as poll from '../Poll.ts';
import * as timeline from './Timeline.ts';
import * as replyLinkModule from './ReplyLink.ts';
import type * as types from '../Types.ts';


/** 一页取多少条。 */
const PAGE_SIZE = 40;


/**
 * 按渠道与聊天过滤条件直接请求后端 /api/messages。
 * @param bot 机器人名。
 * @param query 分页与过滤参数。
 */
async function fetchMessagesPage(
  bot: string,
  query: { before?: number; after?: number; limit?: number; origin?: types.MessageOrigin; channel?: string; chat?: string },
): Promise<types.MessagePage> {
  const params = new URLSearchParams({ bot });
  if (query.before !== undefined) {
    params.set('before', String(query.before));
  }
  if (query.after !== undefined) {
    params.set('after', String(query.after));
  }
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }
  if (query.origin !== undefined) {
    params.set('origin', query.origin);
  }
  if (query.channel !== undefined && query.channel !== '') {
    params.set('channel', query.channel);
  }
  if (query.chat !== undefined && query.chat !== '') {
    params.set('chat', query.chat);
  }
  //M 直接按机器人、分页游标与渠道聊天参数请求后端 /api/messages。
  return api.getJson<types.MessagePage>(`/api/messages?${params.toString()}`);
}


/** 时间线的数据和动作。 */
export interface MessagesState {
  /** 该列表所属视图，显式补取不能悄悄把另一渠道混进来。 */
  origin: types.MessageOrigin;
  /** 号 → 消息。 */
  messages: ReadonlyMap<number, types.MessageView>;
  /** 往前还有没有更早的。 */
  hasMore: boolean;
  /** 第一页拿到了没有。 */
  loaded: boolean;
  /** 正在取更早的。 */
  loadingOlder: boolean;
  /** 取更早的一页。 */
  loadOlder: () => Promise<void>;
  /** 马上取一次变化（刚发完消息时用）。 */
  refresh: () => void;
  /** 按明确号只读补取，跨视图和缺失单独返回，不改正常分页边界。 */
  ensureMessages: (ids: number[]) => Promise<replyLinkModule.ResolvedSources>;
}


/**
 * 时间线的数据。
 * @param bot 正在聊的机器人；还没有时是 null。
 * @param origin 取哪些：web 只要网页发的（中栏时间线），other 只要别的渠道的（右栏“消息”）。
 * @param filter 可选的渠道与聊天过滤条件（unified 为 true 时中栏不向后端传 origin）。
 * @returns 当前时间线消息表、分页状态以及翻页、刷新与按号补取控制动作。
 * 副作用：周期性轮询 /api/messages 拉取首屏与增量变化，切换机器人或过滤条件时重置状态并重建定时器。
 */
export function useMessages(
  bot: string | null,
  origin: types.MessageOrigin,
  filter?: { channel: string; chat?: string; unified: boolean },
): MessagesState {
  /** 中栏统一查询不发送旧 origin；右栏保留原查询语义。 */
  const unified = filter?.unified === true;
  const channel = filter?.channel || undefined;
  const chat = filter?.chat || undefined;
  let queryOrigin: types.MessageOrigin | undefined = origin;
  if (unified) {
    queryOrigin = undefined;
  }
  /** 号 → 消息。 */
  const [messages, setMessages] = react.useState<ReadonlyMap<number, types.MessageView>>(new Map());
  /** 显式补取和定位只读最新消息缓存，不让回调随每次轮询重新注册。 */
  const messagesRef = react.useRef(messages);
  messagesRef.current = messages;
  /** 正常分页的最早号独立保存；跳转补入很老的消息不能跳过中间未加载的页。 */
  const oldestPageId = react.useRef<number | null>(null);
  /** 还有没有更早的。 */
  const [hasMore, setHasMore] = react.useState(false);
  /** 第一页拿到了没有。 */
  const [loaded, setLoaded] = react.useState(false);
  /** 正在取更早的。 */
  const [loadingOlder, setLoadingOlder] = react.useState(false);
  /** 取变化的游标；ref 里放着，定时器里读得到最新的。 */
  const cursor = react.useRef(0);
  /** 现在这一轮属于哪个机器人：换了机器人以后，旧的回答丢掉。 */
  const generation = react.useRef(0);
  /** 马上再问一次的开关。 */
  const kick = react.useRef<() => void>(() => undefined);

  react.useEffect(() => {
    generation.current += 1;
    /** 这一轮的编号。 */
    const mine = generation.current;
    setMessages(new Map());
    setHasMore(false);
    setLoaded(false);
    setLoadingOlder(false);
    cursor.current = 0;
    oldestPageId.current = null;
    if (!bot) return undefined;

    /** 停了没有。 */
    let stopped = false;
    /** 下一次的定时器。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 拉一轮：首次取最新一页，之后按游标增量拉取。 */
    const fetchStep = async (): Promise<void> => {
      if (cursor.current === 0) {
        /** 最新一页。 */
        //M 首次拉取最新一页消息；若期间机器人或筛选视图已切换则立刻丢弃。
        const page = await fetchMessagesPage(bot, { limit: PAGE_SIZE, origin: queryOrigin, channel, chat });
        if (generation.current !== mine) return;

        //M 后端已按 channel + chat 精确过滤，直接写入首屏消息与分页边界。
        setMessages((old) => timeline.mergeMessages(old, page.messages));
        oldestPageId.current = page.messages[0]?.id ?? null;
        setHasMore(page.hasMore);
        setLoaded(true);
        cursor.current = Math.max(page.cursor, 1);
        return;
      }
      /** 变化。 */
      //M 按上次游标增量拉取新消息或回复变动，若请求期间切换了目标则忽略结果。
      const page = await fetchMessagesPage(bot, { after: cursor.current, origin: queryOrigin, channel, chat });
      if (generation.current !== mine) return;

      //M 有新增或更新时直接合并到时间线并推进增量游标。
      if (page.messages.length > 0) {
        setMessages((old) => timeline.mergeMessages(old, page.messages));
      }
      cursor.current = Math.max(cursor.current, page.cursor);
    };
    /** 问一次：还没拿到第一页就取最新一页，拿到了就取变化。 */
    const tick = async (): Promise<void> => {
      try {
        //M 执行一轮首屏或增量拉取，失败时交给下一次轮询重试。
        await fetchStep();
      } catch {
        //M 连不上：左栏的轮询会显示休假中，这里下一轮再试。
      }
      if (!stopped) {
        let delay = poll.POLL_MS;
        if (document.hidden) {
          delay = poll.HIDDEN_POLL_MS;
        }
        //M 本轮结束后再调度下一轮，防止慢网下请求堆叠；标签页不可见时放慢轮询。
        timer = setTimeout(() => void tick(), delay);
      }
    };
    kick.current = () => {
      //M 发完消息等需要立刻刷新的场景取消待跑定时器并马上拉取一次。
      clearTimeout(timer);
      void tick();
    };
    //M 挂载或切换机器人与筛选条件后立即发起首轮拉取。
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      kick.current = () => undefined;
    };
  }, [bot, origin, queryOrigin, channel, chat, unified]);

  /** 取更早的一页。 */
  const loadOlder = react.useCallback(async (): Promise<void> => {
    if (!bot || loadingOlder || !hasMore || oldestPageId.current === null) return;

    /** 这一轮的编号。 */
    const mine = generation.current;
    setLoadingOlder(true);
    try {
      /** 更早的一页。 */
      //M 沿当前最早锚点拉取更早一页；若期间未切换机器人或视图则直接合入时间线并更新翻页边界。
      const before = oldestPageId.current;
      const query = { before, limit: PAGE_SIZE, origin: queryOrigin, channel, chat };
      const page = await fetchMessagesPage(bot, query);
      if (generation.current === mine) {
        setMessages((old) => timeline.mergeMessages(old, page.messages));
        oldestPageId.current = page.messages[0]?.id ?? before;
        setHasMore(page.hasMore);
      }
    } catch {
      //M 下次往上翻再试。
    } finally {
      if (generation.current === mine) {
        setLoadingOlder(false);
      }
    }
  }, [bot, queryOrigin, channel, chat, loadingOlder, hasMore]);

  /** 只按明确号查来源；不把跨渠道的消息作为缺失，也不推进 before/after 游标。 */
  const ensureMessages = react.useCallback(async (ids: number[]): Promise<replyLinkModule.ResolvedSources> => {
    if (!bot) {
      throw new Error('尚未选择机器人，无法定位消息');
    }
    const mine = generation.current;
    const known: types.MessageView[] = [];
    const needed: number[] = [];
    for (const id of new Set(ids)) {
      //M 先查本地已缓存的消息表，已经存在的消息直接收集不再发网络补取。
      const message = messagesRef.current.get(id);
      if (message) {
        known.push(message);
        continue;
      }
      needed.push(id);
    }
    if (needed.length === 0) return { visible: known, foreignIds: [], missingIds: [] };

    //M 只读补取本地尚缺的来源消息，按当前视图条件拆出可见与跨视图结果。
    const resolved = await replyLinkModule.ReplyLink.resolve(bot, needed, queryOrigin, channel, chat);
    if (generation.current !== mine) {
      throw new Error('查看目标已切换，本次补取结果未应用');
    }
    if (resolved.visible.length > 0) {
      //M 仅把属于当前视图的补取消息合入本地缓存，避免污染正常分页边界。
      setMessages((old) => timeline.mergeMessages(old, resolved.visible));
    }
    return { ...resolved, visible: [...known, ...resolved.visible] };
  }, [bot, origin, queryOrigin, channel, chat, unified]);

  /** 马上取一次变化。 */
  const refresh = react.useCallback(() => kick.current(), []);

  return { origin, messages, hasMore, loaded, loadingOlder, loadOlder, refresh, ensureMessages };
}
