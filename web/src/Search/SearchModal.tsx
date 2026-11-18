/**
 * 搜聊天内容（docs/界面/01_界面设计.md 6.1）：Ctrl+K 或左上角的搜索按钮打开，搜所有机器人的消息原话和回复、会话标题和摘要。
 * 打字停 300 毫秒搜一次；上下键选，Enter 或点击打开：切到那个机器人，右栏打开消息文件或会话 md。Esc 关。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as virtuoso from 'react-virtuoso';
import * as api from '../Api.ts';
import * as timeline from '../Chat/Timeline.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import type * as types from '../Types.ts';
import * as privacy from '../Privacy/Mask.tsx';
import * as vscodeLink from '../VscodeLink.tsx';


/** 打字停多久再搜，毫秒。 */
const DEBOUNCE_MS = 300;


/** 一项结果：消息和会话排成一列，上下键在里面走。 */
type Item = { kind: 'message'; hit: types.MessageHit } | { kind: 'session'; hit: types.SessionHit };

/** 拍平给虚拟滚动用的每一行：分组标题或一条结果。 */
type FlatSearchRow =
  | { kind: 'group'; id: string; title: string }
  | { kind: 'item'; id: string; item: Item; itemIndex: number };


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
  //M 读取多语言翻译函数，用于格式化来源渠道标签和回复标识。
  const t = i18n.useT();
  const { item } = props;
  //M 订阅演示打码状态；会话命中项和微信渠道消息命中项必须遮罩，避免投屏露出隐私。
  const enabled = privacy.useMask();
  const masked = enabled && (item.kind === 'session' || privacy.wechat(item.hit));
  let rowClass = 'jm-search-item';
  if (props.active) {
    rowClass = 'jm-search-item jm-search-active';
  }
  let metaContent: react.ReactNode;
  if (item.kind === 'message') {
    //M 消息命中项展示归属渠道、是否命中回复及发送时间，便于用户分辨跨渠道对话来源。
    metaContent = (
      <>
        <span>{timeline.getChannelLabel(item.hit.channel, item.hit.source, t)}</span>
        {item.hit.hit === 'reply' && <span className="jm-search-tag">{t('回复')}</span>}
        <span>{timeline.formatTime(item.hit.createdAt)}</span>
      </>
    );
  }
  if (item.kind !== 'message') {
    //M 会话命中项在演示打码下遮罩工作区路径与会话标题，并格式化更新时间供辨识。
    metaContent = (
      <>
        <span>{privacy.text(item.hit.workspace, masked)}</span>
        <span className="jm-search-title">
          <Highlight text={privacy.name(item.hit.title, masked)} keyword={props.keyword} />
        </span>
        <span>{timeline.formatTime(item.hit.updatedAt)}</span>
      </>
    );
  }

  //M 渲染单条可点击结果行；演示打码开启时隐藏直达源码链接并对正文摘要遮罩后高亮关键字。
  return (
    <div
      id={`jm-search-${String(props.index)}`}
      role="option"
      aria-selected={props.active}
      tabIndex={-1}
      className={rowClass}
      onClick={props.onPick}
      onMouseEnter={props.onHover}
    >
      <div className="jm-search-meta">
        <span className="jm-search-bot">{item.hit.bot}</span>
        {metaContent}
        {!masked && item.hit.file !== '' && <vscodeLink.VsCodeOpen site={item.hit.file} />}
      </div>
      {item.hit.snippet && (
        <div className="jm-search-snippet">
          <Highlight text={privacy.text(item.hit.snippet, masked)} keyword={props.keyword} />
        </div>
      )}
    </div>
  );
}


/**
 * 搜索框：开没开由状态仓库的 searchOpen 管（Ctrl+K 和左上角的按钮都改它）。
 * @returns 全局聊天搜索弹窗元素。
 * 副作用：按输入防抖请求 /api/search，并在打开结果时更新状态仓库中的当前机器人、右栏预览与弹窗开关。
 */
export function SearchModal(): react.JSX.Element {
  //M 获取多语言翻译函数、演示打码开关以及状态仓库中的弹窗开关、切机器人和开右栏方法。
  const t = i18n.useT();
  const masked = privacy.useMask();
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
              let message = String(reason);
              if (reason instanceof Error) {
                message = reason.message;
              }
              setError(message);
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
  const items = react.useMemo<Item[]>(() => {
    if (!result) return [];

    return [
      ...result.messages.map((hit) => ({ kind: 'message' as const, hit })),
      ...result.sessions.map((hit) => ({ kind: 'session' as const, hit })),
    ];
  }, [result]);

  /** 消息有几条（“会话”的小标题插在这个位置）。 */
  const messageCount = result?.messages.length ?? 0;

  /** 分组标题 + 结果行拍平交给 react-virtuoso 渲染。 */
  const flatRows = react.useMemo<FlatSearchRow[]>(() => {
    const rows: FlatSearchRow[] = [];
    if (messageCount > 0) {
      rows.push({ kind: 'group', id: 'group:msg', title: t('消息') });
    }
    items.forEach((item, index) => {
      if (index === messageCount && items.length > messageCount) {
        rows.push({ kind: 'group', id: 'group:sess', title: t('会话') });
      }
      let itemKey = `s${item.hit.id}`;
      if (item.kind === 'message') {
        itemKey = `m${String(item.hit.id)}`;
      }
      rows.push({ kind: 'item', id: itemKey, item, itemIndex: index });
    });
    return rows;
  }, [items, messageCount, t]);

  const virtuosoRef = react.useRef<virtuoso.VirtuosoHandle>(null);

  //M 上下键选到看不见的地方时通过虚拟列表滚过去。
  react.useEffect(() => {
    const flatIdx = flatRows.findIndex((row) => row.kind === 'item' && row.itemIndex === active);
    if (flatIdx >= 0) {
      virtuosoRef.current?.scrollIntoView({ index: flatIdx, behavior: 'auto' });
    }
  }, [active, flatRows]);

  /**
   * 打开一项：切到那个机器人，右栏打开消息文件或会话 md。
   * @param item 这一项。
   */
  const pick = (item: Item): void => {
    selectBot(item.hit.bot);
    let targetName = '';
    if (item.kind === 'message') {
      targetName = `#${String(item.hit.id)}`;
    }
    if (item.kind === 'session') {
      targetName = item.hit.title;
    }
    openPanel('preview', { path: item.hit.file, name: targetName });
    setSearchOpen(false);
  };

  /** 上下键选、Enter 打开。 */
  const onKeyDown = (event: react.KeyboardEvent<HTMLInputElement>): void => {
    /** 选中的那项。 */
    const chosen = items[active];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      /** 往哪走。 */
      let step = -1;
      if (event.key === 'ArrowDown') {
        step = 1;
      }
      setActive((index) => Math.max(0, Math.min(items.length - 1, index + step)));
      return;
    }
    if (event.key === 'Enter' && chosen) {
      event.preventDefault();
      //M 按回车确认当前选中的结果项，切换过去并在右栏打开对应文件或会话。
      pick(chosen);
    }
  };

  const listHeight = Math.min(420, Math.max(60, flatRows.length * 60));

  //M 渲染全局搜索弹窗：包含防抖输入框、状态与错误提示以及虚拟滚动结果列表。
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
      {
        //M 搜索输入框：打开弹窗时自动聚焦；演示打码开启时遮罩输入词并设为只读以防露词。
      /**/}
      <antd.Input ref={input} size="large" allowClear prefix={<icons.SearchOutlined />} placeholder={t('搜消息、回复、会话标题和摘要')} value={privacy.text(keyword, masked)} readOnly={masked} onChange={(event) => setKeyword(event.target.value)} onKeyDown={onKeyDown} />
      <div className="jm-search-list" role="listbox" aria-label={t('搜索结果')}>
        {loading && <div className="jm-search-note">{t('正在搜…')}</div>}
        {
          //M 检索请求出错时展示错误提示；开启演示打码时一并遮罩错误文本避免透出内部信息。
        /**/}
        {error && <antd.Alert type="error" showIcon message={privacy.text(error, masked)} />}
        {!loading && !error && query && result && items.length === 0 && <div className="jm-search-note">{t('没搜到')}</div>}
        {flatRows.length > 0 && (
          <virtuoso.Virtuoso
            ref={virtuosoRef}
            style={{ height: listHeight }}
            data={flatRows}
            computeItemKey={(_index, row) => row.id}
            itemContent={(_index, row) => {
              if (row.kind === 'group') {
                return <div className="jm-search-group">{row.title}</div>;
              }

              //M 渲染单条命中结果行，点击后交由 pick 切到对应机器人并打开右栏预览。
              return (
                <Row
                  item={row.item}
                  index={row.itemIndex}
                  keyword={query}
                  active={row.itemIndex === active}
                  onPick={() => pick(row.item)}
                  onHover={() => setActive(row.itemIndex)}
                />
              );
            }}
          />
        )}
      </div>
      <div className="jm-search-hint">{t('↑↓ 选，Enter 打开，Esc 关')}</div>
    </antd.Modal>
  );
}
