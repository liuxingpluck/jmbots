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
 */
export function useMessages(bot: string | null, origin: types.MessageOrigin): MessagesState {
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
    cursor.current = 0;
    oldestPageId.current = null;
    if (!bot) {
      return undefined;
    }
    /** 停了没有。 */
    let stopped = false;
    /** 下一次的定时器。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 问一次：还没拿到第一页就取最新一页，拿到了就取变化。 */
    const tick = async (): Promise<void> => {
      try {
        if (cursor.current === 0) {
          /** 最新一页。 */
          const page = await api.messages(bot, { limit: PAGE_SIZE, origin });
          if (generation.current !== mine) {
            return;
          }
          setMessages((old) => timeline.mergeMessages(old, page.messages));
          oldestPageId.current = page.messages[0]?.id ?? null;
          setHasMore(page.hasMore);
          setLoaded(true);
          cursor.current = Math.max(page.cursor, 1);
        } else {
          /** 变化。 */
          const page = await api.messages(bot, { after: cursor.current, origin });
          if (generation.current !== mine) {
            return;
          }
          if (page.messages.length > 0) {
            setMessages((old) => timeline.mergeMessages(old, page.messages));
          }
          cursor.current = Math.max(cursor.current, page.cursor);
        }
      } catch {
        //M 连不上：左栏的轮询会显示休假中，这里下一轮再试。
      }
      if (!stopped) {
        timer = setTimeout(() => void tick(), document.hidden ? poll.HIDDEN_POLL_MS : poll.POLL_MS);
      }
    };
    kick.current = () => {
      clearTimeout(timer);
      void tick();
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      kick.current = () => undefined;
    };
  }, [bot, origin]);

  /** 取更早的一页。 */
  const loadOlder = react.useCallback(async (): Promise<void> => {
    if (!bot || loadingOlder || !hasMore || oldestPageId.current === null) {
      return;
    }
    /** 这一轮的编号。 */
    const mine = generation.current;
    setLoadingOlder(true);
    try {
      /** 更早的一页。 */
      const before = oldestPageId.current;
      const query = { before, limit: PAGE_SIZE, origin };
      const page = await api.messages(bot, query);
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
  }, [bot, origin, loadingOlder, hasMore]);

  /** 只按明确号查来源；不把跨渠道的消息作为缺失，也不推进 before/after 游标。 */
  const ensureMessages = react.useCallback(async (ids: number[]): Promise<replyLinkModule.ResolvedSources> => {
    if (!bot) {
      throw new Error('尚未选择机器人，无法定位消息');
    }
    const mine = generation.current;
    const known: types.MessageView[] = [];
    const needed: number[] = [];
    for (const id of new Set(ids)) {
      const message = messagesRef.current.get(id);
      if (message) {
        known.push(message);
      } else {
        needed.push(id);
      }
    }
    if (needed.length === 0) {
      return { visible: known, foreignIds: [], missingIds: [] };
    }
    const resolved = await replyLinkModule.ReplyLink.resolve(bot, needed, origin);
    if (generation.current !== mine) {
      throw new Error('查看目标已切换，本次补取结果未应用');
    }
    if (resolved.visible.length > 0) {
      setMessages((old) => timeline.mergeMessages(old, resolved.visible));
    }
    return { ...resolved, visible: [...known, ...resolved.visible] };
  }, [bot, origin]);

  /** 马上取一次变化。 */
  const refresh = react.useCallback(() => kick.current(), []);

  return { origin, messages, hasMore, loaded, loadingOlder, loadOlder, refresh, ensureMessages };
}
