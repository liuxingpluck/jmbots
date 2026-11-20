/** 外置微信客服工作台，查看监听会话并生成、复制 AI 建议。 */
import * as react from 'react';
import * as dom from 'react-dom/client';
import * as virtuoso from 'react-virtuoso';
import * as locale from './KefuLocale.ts';
import * as privacy from './ui/Mask.ts';
import * as token from './ui/Token.ts';
import * as voice from './ui/WechatVoice.tsx';
import './Kefu.css';

type Labels = ReturnType<typeof locale.getLabels>;
type Availability = 'connecting' | 'connected' | 'offline' | 'connectionError';
interface Capabilities { watch: boolean }
interface Account { id: string; nickname: string }
interface Watch { account: string; chat: string; name: string }
interface Chat { username: string; chat: string; last_message: string; watch: boolean }
interface Draft extends Watch { id: number; text: string; state: string }
interface Message {
  account: string;
  chat: string;
  source: string;
  local_id: number;
  kind: string;
  sender: string;
  text: string;
  view: string | null;
  from_self: number | null;
}
interface Overview {
  caps: Capabilities;
  accounts: Account[];
  watches: Watch[];
  drafts: Draft[];
}
interface Rows<T> { key: string; items: T[]; error?: string }

const EMPTY_ROWS: never[] = [];
const CHAT_LIST_STYLE = { height: 'max(12rem, 43dvh)' };
const MESSAGE_LIST_STYLE = { height: 'max(14rem, 56dvh)' };
const ROW_STYLE = { paddingBlockEnd: '0.45rem' };
const MESSAGE_OVERSCAN = 600;

/** 消息顶部留空隙，部件身份固定避免虚拟列表重建。 */
function MessageHeader(): react.JSX.Element {
  return <div style={{ height: 8 }} />;
}

const MESSAGE_PARTS: virtuoso.Components<Message> = { Header: MessageHeader };
const watchKey = (_index: number, row: Watch): string => JSON.stringify([row.account, row.chat]);
const chatKey = (_index: number, row: Chat): string => row.username;
const messageKey = (_index: number, row: Message): string => JSON.stringify([row.source, row.local_id]);

/** 保留 HTTP 状态，区分连接异常和业务拒绝。 */
class RequestError extends Error {
  constructor(readonly status: number, detail: string) {
    super(detail);
  }
}

/** 给读取及媒体拼出当前挂载点的接口和访问令牌。 */
function getAddress(route: string, fields?: Record<string, string>): string {
  let address = `./api/wechat-kefu/${route}`;
  if (fields !== undefined) {
    const query = new URLSearchParams(fields);
    address += `?${query.toString()}`;
  }
  return token.withToken(address, token.TOKEN);
}

/** 请求外置程序，给 503 和网络离线保留可区分的状态。 */
async function request<T>(address: string, options: RequestInit): Promise<T> {
  const response = await fetch(address, options);
  if (response.ok) return await response.json() as T;

  //M 只有 JSON 接口给出的业务错误展示细节，代理的 HTML 错误页只展示状态码。
  let detail = String(response.status);
  const mime = response.headers.get('content-type');
  if (mime?.includes('application/json')) {
    const body = await response.json() as { error?: string };
    detail = body.error ?? detail;
  }
  throw new RequestError(response.status, detail);
}

/** 轮询同一查询，卸载或切换账号时取消旧请求。 */
function useRows<T>(key: string, address: string, revision: number, interval: number): Rows<T> {
  const [rows, setRows] = react.useState<Rows<T>>({ key: '', items: [] });
  const previous = react.useRef('');
  react.useEffect(() => {
    if (!key) return;

    const controller = new AbortController();
    const signal = controller.signal;
    let timer: number | undefined;
    async function load(): Promise<void> {
      try {
        const items = await request<T[]>(address, { signal });
        if (signal.aborted) return;

        //M 比较全部返回字段，消息撤回或视图变化仍会更新。
        const mark = JSON.stringify([key, items]);
        if (previous.current === mark) return;

        previous.current = mark;
        setRows({ key, items });
      } catch (error) {
        if (!signal.aborted) {
          const detail = String((error as Error).message);
          const mark = JSON.stringify([key, 'error', detail]);
          if (previous.current === mark) return;

          previous.current = mark;
          setRows({ key, items: EMPTY_ROWS, error: detail });
        }
      } finally {
        //M 上一轮结束才开始下一轮，避免积压会话同步。
        if (!signal.aborted) timer = window.setTimeout(() => { void load(); }, interval);
      }
    }
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [address, interval, key, revision]);

  if (rows.key !== key) return { key, items: EMPTY_ROWS };
  return rows;
}

/** 展示单条聊天消息，打码时不向微信引擎取图片和语音。 */
function MessageBody({ message, mask, t }: { message: Message; mask: boolean; t: Labels }): react.JSX.Element {
  const { account, chat, source, local_id: localId } = message;
  const [imageError, setImageError] = react.useState(false);
  if (message.kind === 'image') {
    if (mask) return <span>{t.image}</span>;
    if (imageError) return <span>{t.imageUnavailable}</span>;

    const params = { account, chat, source, local_id: String(localId) };
    //M 图片沿用账号、会话和来源定位，用当前页面访问令牌读取。
    const src = getAddress('image', params);
    return <img src={src} alt={t.image} loading="lazy" onError={() => setImageError(true)} />;
  }
  if (message.kind === 'voice') {
    let seconds: number | undefined;
    if (message.view !== null) {
      try {
        const view = JSON.parse(message.view) as { seconds?: number } | null;
        seconds = view?.seconds;
      } catch {
        //G 旧消息视图无法解析时，沿用播放器加载后的实测时长。
      }
    }
    return (
      <voice.WechatVoice
        account={account} chat={chat} source={source} localId={localId} seconds={seconds} mask={mask}
      />
    );
  }
  //M 打码时只渲染脱敏后的聊天文本。
  const text = privacy.text(message.text, mask);
  return <span>{text}</span>;
}

/** 局域网明文页面没有 Clipboard API 时，用当前用户点击触发的复制命令。 */
async function copyText(value: string): Promise<void> {
  if (navigator.clipboard !== undefined) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const focus = document.activeElement;
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand('copy')) throw new Error('复制不可用');
  } finally {
    //M 复制后清理临时选区并还回原焦点。
    input.remove();
    if (focus instanceof HTMLElement) focus.focus({ preventScroll: true });
  }
}

/** 读取客服工作台和摘要，只有能力允许时才生成写操作。 */
function KefuPage(): react.JSX.Element {
  const [t] = react.useState(locale.getLabels);
  const mask = privacy.useMask();
  const [availability, setAvailability] = react.useState<Availability>('connecting');
  const [overview, setOverview] = react.useState<Overview>();
  const [accountId, setAccountId] = react.useState('');
  const [selected, setSelected] = react.useState<Watch>();
  const [search, setSearch] = react.useState('');
  const [revision, setRevision] = react.useState(0);
  const [watchBusy, setWatchBusy] = react.useState(false);
  const [watchError, setWatchError] = react.useState('');
  const [draftBusy, setDraftBusy] = react.useState(false);
  const [draftError, setDraftError] = react.useState('');
  const [copied, setCopied] = react.useState<{ id: number; text: string }>();
  const overviewMark = react.useRef('');
  const seenAvailability = react.useRef<Availability>('connecting');

  react.useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal, cache: 'no-store' } as const;
    let timer: number | undefined;
    function report(value: Availability): void {
      if (seenAvailability.current === value) return;

      seenAvailability.current = value;
      setAvailability(value);
    }
    async function load(): Promise<void> {
      try {
        //M 先核对程序在线和当前身份，失败时禁止继续写。
        const address = getAddress('capabilities');
        const caps = await request<Capabilities>(address, options);
        if (options.signal.aborted) return;

        //M 能力接口成功后分别读账号、名单、草稿，读取错误与程序离线分别显示。
        const reads = [
          request<{ accounts: Account[] }>(getAddress('status'), options),
          request<Watch[]>(getAddress('watch'), options),
          request<Draft[]>(getAddress('drafts'), options),
        ] as const;
        const [status, watches, drafts] = await Promise.all(reads);
        if (options.signal.aborted) return;

        const snapshot = { caps: { watch: caps.watch }, accounts: status.accounts, watches, drafts };
        const mark = JSON.stringify(snapshot);
        //M 相同的轮询数据继续复用原始列表，不让虚拟列表重新渲染。
        if (overviewMark.current !== mark) {
          overviewMark.current = mark;
          setOverview(snapshot);
        }
        //M 成功读取后恢复在线状态，相同状态也不重画。
        report('connected');
      } catch (error) {
        if (options.signal.aborted) return;

        if (error instanceof TypeError || (error instanceof RequestError && error.status === 503)) {
          //G 请求不通时先锁定页面操作。
          report('offline');
          return;
        }
        //G 业务或数据错误与连接中断分开提示。
        report('connectionError');
      } finally {
        if (!options.signal.aborted) timer = window.setTimeout(() => { void load(); }, 5_000);
      }
    }
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [revision]);

  const accounts = overview?.accounts ?? EMPTY_ROWS;
  const list = overview?.watches ?? EMPTY_ROWS;
  const latestDrafts = overview?.drafts ?? EMPTY_ROWS;
  const drafts = react.useMemo(
    () => latestDrafts.filter((draft) => draft.state === 'draft'),
    [latestDrafts],
  );
  //M 首次打开默认选一个已连接账号，断线自动切走失效的选择。
  const currentAccount = accounts.find((item) => item.id === accountId);
  const account = currentAccount?.id ?? accounts[0]?.id ?? '';
  const online = availability === 'connected';
  const canWatch = online && overview?.caps.watch === true;
  const params = { account, chat: selected?.chat ?? '', name: selected?.name ?? '' };
  let currentKey = '';
  if (account && selected?.account === account) currentKey = JSON.stringify([account, selected.chat]);

  //M 用账号和会话分别绑定轮询，切换目标后不沿用上一个会话的消息。
  const chatAddress = getAddress('chats', { account });
  const messageAddress = getAddress('messages', params);
  const chats = useRows<Chat>(account, chatAddress, revision, 8_000);
  const messages = useRows<Message>(currentKey, messageAddress, revision, 5_000);
  const deferred = react.useDeferredValue(search);
  const visible = react.useMemo(() => {
    const query = deferred.trim().toLowerCase();
    if (query === '') return chats.items;

    return chats.items.filter((chat) => `${chat.chat} ${chat.last_message}`.toLowerCase().includes(query));
  }, [chats.items, deferred]);
  const watching = list.some((entry) => entry.account === account && entry.chat === selected?.chat);
  let watchLabel = t.startWatch;
  if (watching) watchLabel = t.stopWatch;

  //M 脱敏后的文本才进入搜索框和各栏提示。
  const searchText = privacy.text(search, mask);
  const chatError = privacy.text(chats.error ?? '', mask);
  const messageError = privacy.text(messages.error ?? '', mask);
  const shownWatchError = privacy.text(watchError, mask);
  const shownDraftError = privacy.text(draftError, mask);

  /** 重新读取当前读视图，供手动刷新和写操作完成后调用。 */
  function refresh(): void {
    setRevision((value) => value + 1);
  }

  /** 切换聊天选区，账号和消息始终以同一目标查询。 */
  const open = react.useCallback((chat: Watch): void => {
    setAccountId(chat.account);
    setSelected(chat);
    setWatchError('');
    setDraftError('');
  }, []);

  /** 更新当前会话的草稿监听。 */
  async function toggleWatch(): Promise<void> {
    if (!canWatch || selected === undefined || !currentKey || watchBusy) return;

    setWatchBusy(true);
    setWatchError('');
    //M 只有经主站认证的请求才能修改监听状态。
    const address = getAddress('watch');
    const body = JSON.stringify({ ...selected, watch: !watching });
    const options = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body };
    try {
      await request(address, options);
    } catch (error) {
      setWatchError(String((error as Error).message));
    } finally {
      setWatchBusy(false);
      refresh();
    }
  }

  /** 只对当前已监听的会话起草建议。 */
  async function makeDraft(): Promise<void> {
    if (!canWatch || !watching || mask || draftBusy || selected === undefined) return;

    setDraftBusy(true);
    setDraftError('');
    //M 用当前代理前缀和访问令牌找到起草入口。
    const address = getAddress('draft');
    const body = JSON.stringify({ account: selected.account, chat: selected.chat });
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
    try {
      //M 建议走外置无发送出口的起草接口。
      await request(address, options);
      refresh();
    } catch (error) {
      setDraftError(String((error as Error).message));
    } finally {
      setDraftBusy(false);
    }
  }

  /** 复制原建议，打码状态不把原文放上剪贴板。 */
  async function copySuggestion(draft: Draft): Promise<void> {
    if (mask) return;

    try {
      await copyText(draft.text);
      setCopied({ id: draft.id, text: t.copied });
    } catch {
      setCopied({ id: draft.id, text: t.copyFailed });
    }
  }

  //M itemContent 随必要输入更新，搜索框和无变化的轮询不会重建它们。
  const watchItem = react.useCallback((_index: number, row: Watch) => (
    <div style={ROW_STYLE}>
      <button type="button" onClick={() => open(row)}>{privacy.name(row.name || row.chat, mask)}</button>
    </div>
  ), [mask, open]);
  const chatItem = react.useCallback((_index: number, row: Chat) => {
    const target = { account, chat: row.username, name: row.chat };
    const pressed = selected?.account === account && selected.chat === row.username;
    const preview = privacy.text(row.last_message, mask);
    return (
      <div style={ROW_STYLE}>
        <button type="button" aria-pressed={pressed} onClick={() => open(target)}>
          <strong>{privacy.name(row.chat || row.username, mask)}</strong>
          {row.watch && <small>{t.watching}</small>}
          <span>{preview}</span>
        </button>
      </div>
    );
  }, [account, mask, open, selected, t]);
  const messageItem = react.useCallback((_index: number, message: Message) => (
    <div className="kf-messages" style={ROW_STYLE}>
      <article data-self={message.from_self === 1}>
        <small>{privacy.name(message.sender, mask)}</small>
        <div className="kf-bubble"><MessageBody message={message} mask={mask} t={t} /></div>
      </article>
    </div>
  ), [mask, t]);
  const count = list.length;
  const watchStyle = react.useMemo(() => ({ height: Math.min(180, count * 43) }), [count]);

  return (
    <main className="kf-page">
      <header className="kf-top">
        <h1>{t.title}</h1>
        <span role="status" className="kf-status" data-status={availability}>{t[availability]}</span>
        {window.location.pathname.startsWith('/programs/') && <a href="/wechat-kefu/">{t.legacy}</a>}
        <label>
          <input type="checkbox" checked={mask} onChange={(event) => privacy.setMask(event.currentTarget.checked)} />
          {' '}{t.mask}
        </label>
        <button type="button" onClick={refresh}>{t.refresh}</button>
      </header>
      <div className="kf-workspace">
        <aside className="kf-panel kf-list">
          <h2>{t.watch}</h2>
          {overview && list.length === 0 && <p>{t.noWatch}</p>}
          {list.length > 0 && (
            <virtuoso.Virtuoso
              data={list}
              style={watchStyle}
              computeItemKey={watchKey}
              itemContent={watchItem}
            />
          )}
          <h2>{t.chats}</h2>
          {accounts.length === 0 && overview && <p>{t.noAccount}</p>}
          {accounts.length > 0 && (
            <select
              value={account}
              aria-label={t.account}
              onChange={(event) => setAccountId(event.currentTarget.value)}
            >
              {accounts.map((item) => (
                <option key={item.id} value={item.id}>{privacy.name(item.nickname || item.id, mask)}</option>
              ))}
            </select>
          )}
          {accounts.length > 0 && (
            <input
              aria-label={t.search}
              placeholder={t.search}
              readOnly={mask}
              value={searchText}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          )}
          {chatError && <p role="alert">{t.loadFailed} · {chatError}</p>}
          {account && !chats.error && visible.length === 0 && <p>{t.noChats}</p>}
          {visible.length > 0 && (
            <virtuoso.Virtuoso
              key={account}
              data={visible}
              style={CHAT_LIST_STYLE}
              computeItemKey={chatKey}
              itemContent={chatItem}
            />
          )}
        </aside>
        <section className="kf-panel kf-chat">
          {!currentKey && <p>{t.chooseChat}</p>}
          {currentKey && selected && (
            <>
              <header className="kf-chat-header">
                <h2>{privacy.name(selected.name || selected.chat, mask)}</h2>
                {canWatch && !mask && (
                  <button type="button" disabled={watchBusy} onClick={() => { void toggleWatch(); }}>
                    {watchLabel}
                  </button>
                )}
                {canWatch && watching && !mask && (
                  <button type="button" disabled={draftBusy} onClick={() => { void makeDraft(); }}>
                    {draftBusy && t.drafting}
                    {!draftBusy && t.makeDraft}
                  </button>
                )}
              </header>
              {shownWatchError && <p role="alert">{t.watchFailed} · {shownWatchError}</p>}
              {shownDraftError && <p role="alert">{t.draftFailed} · {shownDraftError}</p>}
              {messageError && <p role="alert">{t.loadFailed} · {messageError}</p>}
              {messages.items.length === 0 && !messages.error && <p>{t.noMessages}</p>}
              {messages.items.length > 0 && (
                <virtuoso.Virtuoso
                  key={currentKey}
                  data={messages.items}
                  style={MESSAGE_LIST_STYLE}
                  components={MESSAGE_PARTS}
                  computeItemKey={messageKey}
                  increaseViewportBy={MESSAGE_OVERSCAN}
                  itemContent={messageItem}
                />
              )}
            </>
          )}
        </section>
        <aside className="kf-panel kf-out" aria-label={t.suggestions}>
          <h2>{t.suggestions}</h2>
          {overview && drafts.length === 0 && <p>{t.noSuggestions}</p>}
          {drafts.map((draft) => {
            const target = privacy.name(draft.name || draft.chat, mask);
            //M 会话重名时用原账号区分；正文统一遵守打码状态。
            const owner = accounts.find((item) => item.id === draft.account);
            const text = privacy.text(draft.text, mask);
            return (
              <article className="kf-draft" key={draft.id}>
                <div><strong>{target}</strong></div>
                <small>{privacy.name(owner?.nickname || draft.account, mask)}</small>
                <p>{text}</p>
                <button type="button" disabled={mask} onClick={() => { void copySuggestion(draft); }}>
                  {t.copy}
                </button>
                {copied?.id === draft.id && <span role="status">{copied.text}</span>}
              </article>
            );
          })}
        </aside>
      </div>
    </main>
  );
}

//M 外置程序通过同一个 HTML 入口挂载，访问程序的前缀不写死。
const root = document.getElementById('root')!;
dom.createRoot(root).render(<KefuPage />);
