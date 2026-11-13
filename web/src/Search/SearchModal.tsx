/**
 * 搜聊天内容（docs/界面/01_界面设计.md 6.1）：Ctrl+K 或左上角的搜索按钮打开，搜所有机器人的消息原话和回复、会话标题和摘要。
 * 打字停 300 毫秒搜一次；上下键选，Enter 或点击打开：切到那个机器人，右栏打开消息文件或会话 md。Esc 关。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as timeline from '../Chat/Timeline.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import type * as types from '../Types.ts';


/** 打字停多久再搜，毫秒。 */
const DEBOUNCE_MS = 300;


/** 一项结果：消息和会话排成一列，上下键在里面走。 */
type Item = { kind: 'message'; hit: types.MessageHit } | { kind: 'session'; hit: types.SessionHit };


/**
 * 片段里把关键字标出来（不分大小写）。
 * @param props text 片段；keyword 关键字。
 */
function Highlight(props: { text: string; keyword: string }): react.JSX.Element {
  /** 小写的片段（找位置用）。 */
  const lower = props.text.toLowerCase();
  /** 小写的关键字。 */
  const key = props.keyword.toLowerCase();
  /** 拼出来的几段。 */
  const parts: react.ReactNode[] = [];
  /** 从哪接着找。 */
  let from = 0;
  if (key) {
    for (let at = lower.indexOf(key); at >= 0; at = lower.indexOf(key, from)) {
      parts.push(props.text.slice(from, at), <mark key={at}>{props.text.slice(at, at + key.length)}</mark>);
      from = at + key.length;
    }
  }
  parts.push(props.text.slice(from));
  return <>{parts}</>;
}


/**
 * 一项结果。
 * @param props item 这一项；index 第几项（滚动定位用）；keyword 关键字；active 是不是选中的；onPick 打开；onHover 鼠标移上来。
 */
function Row(props: { item: Item; index: number; keyword: string; active: boolean; onPick: () => void; onHover: () => void }): react.JSX.Element {
  const t = i18n.useT();
  const { item } = props;
  return (
    <button type="button" id={`jm-search-${String(props.index)}`} className={`jm-search-item${props.active ? ' jm-search-active' : ''}`} onClick={props.onPick} onMouseEnter={props.onHover}>
      <div className="jm-search-meta">
        <span className="jm-search-bot">{item.hit.bot}</span>
        {item.kind === 'message' ? (
          <>
            <span>{timeline.channelLabel(item.hit.channel, item.hit.source, t)}</span>
            {item.hit.hit === 'reply' && <span className="jm-search-tag">{t('回复')}</span>}
            <span>{timeline.formatTime(item.hit.createdAt)}</span>
          </>
        ) : (
          <>
            <span>{item.hit.workspace}</span>
            <span className="jm-search-title">
              <Highlight text={item.hit.title} keyword={props.keyword} />
            </span>
            <span>{timeline.formatTime(item.hit.updatedAt)}</span>
          </>
        )}
      </div>
      {item.hit.snippet && (
        <div className="jm-search-snippet">
          <Highlight text={item.hit.snippet} keyword={props.keyword} />
        </div>
      )}
    </button>
  );
}


/** 搜索框：开没开由状态仓库的 searchOpen 管（Ctrl+K 和左上角的按钮都改它）。 */
export function SearchModal(): react.JSX.Element {
  const t = i18n.useT();
  const open = context.useUi((state) => state.searchOpen);
  const setSearchOpen = context.useUi((state) => state.setSearchOpen);
  const selectBot = context.useUi((state) => state.selectBot);
  const openPanel = context.useUi((state) => state.openPanel);
  /** 输入框（打开时聚焦）。 */
  const input = react.useRef<antd.InputRef>(null);
  /** 输入的字。 */
  const [keyword, setKeyword] = react.useState('');
  /** 搜到的；还没搜是 null。 */
  const [result, setResult] = react.useState<types.SearchResult | null>(null);
  /** 正在搜。 */
  const [loading, setLoading] = react.useState(false);
  /** 出错的原因。 */
  const [error, setError] = react.useState('');
  /** 选中第几项。 */
  const [active, setActive] = react.useState(0);
  /** 去掉首尾空白的关键字。 */
  const query = keyword.trim();

  //M 每次打开都从空的开始。
  react.useEffect(() => {
    if (open) {
      setKeyword('');
      setResult(null);
      setError('');
    }
  }, [open]);

  //M 打字停一会儿再搜；后发的覆盖先发的（先发的回来晚了不用）。
  react.useEffect(() => {
    if (!open || !query) {
      setResult(null);
      setLoading(false);
      return undefined;
    }
    /** 这次的结果作废了没有。 */
    let stale = false;
    /** 定时器。 */
    const timer = setTimeout(() => {
      setLoading(true);
      void api
        .searchChat(query)
        .then(
          (found) => {
            if (!stale) {
              setResult(found);
              setActive(0);
              setError('');
            }
          },
          (reason: unknown) => {
            if (!stale) {
              setError(reason instanceof Error ? reason.message : String(reason));
            }
          },
        )
        .finally(() => {
          if (!stale) {
            setLoading(false);
          }
        });
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, query]);

  /** 排成一列的结果：消息在前，会话在后。 */
  const items = react.useMemo<Item[]>(() => (result ? [...result.messages.map((hit) => ({ kind: 'message' as const, hit })), ...result.sessions.map((hit) => ({ kind: 'session' as const, hit }))] : []), [result]);

  //M 上下键选到看不见的地方时滚过去。
  react.useEffect(() => {
    document.getElementById(`jm-search-${String(active)}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  /**
   * 打开一项：切到那个机器人，右栏打开消息文件或会话 md。
   * @param item 这一项。
   */
  const pick = (item: Item): void => {
    selectBot(item.hit.bot);
    openPanel('preview', { path: item.hit.file, name: item.kind === 'message' ? `#${String(item.hit.id)}` : item.hit.title });
    setSearchOpen(false);
  };

  /** 上下键选、Enter 打开。 */
  const onKeyDown = (event: react.KeyboardEvent<HTMLInputElement>): void => {
    /** 选中的那项。 */
    const chosen = items[active];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      /** 往哪走。 */
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index) => Math.max(0, Math.min(items.length - 1, index + step)));
    } else if (event.key === 'Enter' && chosen) {
      event.preventDefault();
      pick(chosen);
    }
  };

  /** 消息有几条（“会话”的小标题插在这个位置）。 */
  const messageCount = result?.messages.length ?? 0;
  return (
    <antd.Modal
      open={open}
      onCancel={() => setSearchOpen(false)}
      footer={null}
      closable={false}
      width={640}
      className="jm-search-modal"
      afterOpenChange={(visible) => {
        if (visible) {
          input.current?.focus();
        }
      }}
    >
      <antd.Input ref={input} size="large" allowClear prefix={<icons.SearchOutlined />} placeholder={t('搜消息、回复、会话标题和摘要')} value={keyword} onChange={(event) => setKeyword(event.target.value)} onKeyDown={onKeyDown} />
      <div className="jm-search-list">
        {loading && <div className="jm-search-note">{t('正在搜…')}</div>}
        {error && <antd.Alert type="error" showIcon message={error} />}
        {!loading && !error && query && result && items.length === 0 && <div className="jm-search-note">{t('没搜到')}</div>}
        {messageCount > 0 && <div className="jm-search-group">{t('消息')}</div>}
        {items.map((item, index) => (
          <react.Fragment key={item.kind === 'message' ? `m${String(item.hit.id)}` : `s${item.hit.id}`}>
            {index === messageCount && <div className="jm-search-group">{t('会话')}</div>}
            <Row item={item} index={index} keyword={query} active={index === active} onPick={() => pick(item)} onHover={() => setActive(index)} />
          </react.Fragment>
        ))}
      </div>
      <div className="jm-search-hint">{t('↑↓ 选，Enter 打开，Esc 关')}</div>
    </antd.Modal>
  );
}
