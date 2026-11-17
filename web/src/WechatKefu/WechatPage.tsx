/**
 * 积木客服页（/wechat-kefu/，web 插件托管 dist/web/wechat-kefu.html）。照积木客服（source/jimukefu/src/web）的样子：
 * 顶栏（账号、轮询状态、演示打码、一键扫描、演示引导）、统计卡片、左边会话列表带「监听 / 自动发」开关、中间消息、右边待发回复。
 * 数据都走 wechat-kefu 插件的接口（src7/plugins/wechat/page/Routes.ts）：/api/wechat-kefu/status、chats、watch、messages、outbox、send、outbox/send。
 * 隐私：「演示打码」默认开，会话名和消息全换成＊（只留字数）；账号只显示“账号 1、2”，不显示微信号。2026-11-14 jm开发。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Guide } from '../Guide/Guide.tsx';
import { WECHAT_STEPS } from '../Guide/steps-wechat-kefu.ts';
import * as privacy from '../Privacy/Mask.tsx';
import { TOKEN, withToken } from '../Token.ts';

type Kind = 'group' | 'private' | 'official' | 'work' | 'system';
const KINDS: Record<Kind, string> = { group: '群聊', private: '私聊', official: '公众号', work: '企业微信', system: '系统会话' };
const KIND_ORDER: Kind[] = ['group', 'private', 'official', 'work', 'system'];
/** 微信自带的系统会话（文件传输助手、微信团队等）。 */
const SYSTEM = new Set(['filehelper', 'weixin', 'notifymessage', 'fmessage', 'floatbottle', 'medianote', 'newsapp', 'qqmail', 'brandsessionholder', 'brandservicesessionholder', 'qmessage', 'tmessage', 'qqsync']);
const STATES: Record<string, string> = { draft: '草稿', waiting: '等确认', sending: '发送中', sent: '已发出', unconfirmed: '未确认', failed: '失败', rejected: '被拒' };

interface Status { rounds: number; lastRunAt: number; lastError: string; busy: boolean; interval: number; chats?: number; synced?: number; pending?: number; accounts: { id: string; nickname: string; wxid: string }[] }
interface Chat { username: string; chat: string; is_group: boolean; unread: number; last_message: string; timestamp: number; watch: boolean; auto: boolean }
interface Message { local_id: number; source: string; at: number; from_self: number | null; kind: string; sender: string; text: string; view?: string | null }
/** 气泡视图（后端存的 JSON，jimukefu msgview）：图片、语音、卡片用。 */
interface View { kind?: string; text?: string; title?: string; desc?: string; seconds?: number; amount?: string }
/** 原版积木客服的筛选一排（jimukefu src/web/src/format.ts FILTERS）。 */
type Filter = Kind | 'all' | 'watch' | 'unread' | 'fresh';
const LOADED_AT = Date.now();
interface Out { id: number; chat: string; name: string; text: string; state: string; note: string; at: number }

function kindOf(chat: Chat): Kind {
  const id = chat.username;
  if (id.endsWith('@chatroom') || chat.is_group) return 'group';
  if (id.startsWith('gh_')) return 'official';
  if (id.endsWith('@openim')) return 'work';
  if (SYSTEM.has(id) || id.startsWith('@')) return 'system';
  return 'private';
}

/** 带令牌（Token.ts，和主网页同一份）调接口，出错抛接口给的 error。 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  //M 2026-11-14 22:50 EST：原来只读浏览器里记着的，直接打开 /wechat-kefu/?token=… 认不到；改用 Token.ts（会记下并从地址栏去掉）。
  const response = await fetch(withToken(path, TOKEN), init ? { ...init, headers: { 'Content-Type': 'application/json' } } : undefined);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? String(response.status));
  return body;
}

function clock(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms > 1e12 ? ms : ms * 1000);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function WechatPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [offline, setOffline] = useState('');
  const [account, setAccount] = useState('');
  const [chats, setChats] = useState<Chat[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState('recent');
  const [search, setSearch] = useState('');
  const [current, setCurrent] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [outbox, setOutbox] = useState<Out[]>([]);
  const [draft, setDraft] = useState('');
  const [drafting, setDrafting] = useState(false);
  //M 演示打码默认关；开着时顶部有提示条，下面 paddingTop/top 才让位
  const mask = privacy.useMask();
  const [pollOpen, setPollOpen] = useState(false);

  //G 演示打码：整段换成＊，只留字数，联系人名和内容一个字都不露（投屏、截图用）。
  //G 上述旧规则现统一为共用模块：正文整段隐藏；姓名只留首字。所有页面读同一个持久化开关。
  const hide = (value: string) => privacy.text(value, mask);
  const hideName = (value: string) => privacy.name(value, mask);

  //M 状态和发件：每 3 秒一次。
  useEffect(() => {
    const load = () => {
      void call<Status>('/api/wechat-kefu/status').then((s) => {
        setStatus(s); setOffline('');
        setAccount((old) => old || s.accounts[0]?.id || '');
      }).catch((error: Error) => setOffline(error.message));
      void call<Out[]>('/api/wechat-kefu/outbox').then(setOutbox).catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, []);

  const scan = useCallback(async () => {
    if (!account) { setScanNote('还没有连上的微信账号（program/wechat/runtime/data/accounts.yaml）'); return; }
    setScanning(true); setScanNote('正在读本机微信的最近会话…');
    try {
      const list = await call<Chat[]>(`/api/wechat-kefu/chats?account=${encodeURIComponent(account)}`);
      setChats(list); setScanNote(`读到 ${String(list.length)} 个会话`);
    } catch (error) {
      setScanNote(`扫描失败：${(error as Error).message}`);
    } finally {
      setScanning(false);
    }
  }, [account]);
  useEffect(() => { if (account) void scan(); }, [account, scan]);

  //M 选中的会话：每 3 秒取一次消息。
  useEffect(() => {
    if (!current) { setMessages([]); return undefined; }
    const load = () => void call<Message[]>(`/api/wechat-kefu/messages?account=${encodeURIComponent(account)}&chat=${encodeURIComponent(current.username)}&name=${encodeURIComponent(current.chat)}&limit=1000`).then(setMessages).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [current, account]);

  const toggle = async (chat: Chat, watch: boolean, auto: boolean) => {
    await call('/api/wechat-kefu/watch', { method: 'PUT', body: JSON.stringify({ account, chat: chat.username, name: chat.chat, watch, auto }) });
    setChats((list) => list.map((c) => (c.username === chat.username ? { ...c, watch, auto: watch && auto } : c)));
  };
  const send = async () => {
    if (!current || draft.trim() === '') return;
    try {
      await call('/api/wechat-kefu/send', { method: 'POST', body: JSON.stringify({ account, chat: current.username, text: draft }) });
      setDraft('');
    } catch (error) { setScanNote(`发送失败：${(error as Error).message}`); }
  };
  const resend = async (id: number) => {
    try { await call('/api/wechat-kefu/outbox/send', { method: 'POST', body: JSON.stringify({ id }) }); } catch (error) { setScanNote(`发送失败：${(error as Error).message}`); }
  };
  //M 2026-11-15 00:17 EST：人手点“让 AI 回复”——只对已监听会话起草，结果进右侧草稿栏，绝不发送。
  const askAi = async () => {
    if (!current?.watch) { setScanNote('请先勾选监听，才能让 AI 起草回复'); return; }
    setDrafting(true);
    setScanNote('正在让 AI 根据这个会话起草回复（只生成，不发送）…');
    try {
      await call('/api/wechat-kefu/draft', { method: 'POST', body: JSON.stringify({ account, chat: current.username }) });
      setOutbox(await call<Out[]>('/api/wechat-kefu/outbox'));
      setScanNote('已起草一条回复，在右侧草稿栏，不会发送');
    } catch (error) { setScanNote(`起草失败：${(error as Error).message}`); } finally { setDrafting(false); }
  };

  //M 2026-11-14 23:35 EST：筛选、排序照原版（SessionList.tsx matches / sort）；「有新消息」= 打开页面之后来过消息的会话。
  const matches = (c: Chat, key: Filter) => key === 'all' || (key === 'watch' ? c.watch : key === 'unread' ? c.unread > 0 : key === 'fresh' ? c.timestamp * 1000 > LOADED_AT : kindOf(c) === key);
  const shown = useMemo(() => {
    const list = chats.filter((c) => matches(c, filter) && (search === '' || c.chat.includes(search) || c.username.includes(search) || c.last_message.includes(search)));
    if (sort === 'unread') list.sort((a, b) => b.unread - a.unread);
    else if (sort === 'watched') list.sort((a, b) => Number(b.watch) - Number(a.watch));
    else if (sort === 'name') list.sort((a, b) => (a.chat || '').localeCompare(b.chat || '', 'zh-CN'));
    else list.sort((a, b) => b.timestamp - a.timestamp);
    return list;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, filter, search, sort]);
  const pickAll = async (watch: boolean) => {
    for (const chat of shown) if (chat.watch !== watch) await toggle(chat, watch, false);
  };
  //M 后台在全量听：会话列表跟着轮询刷新（默认按最近消息排序，有新消息的排在最前）。
  useEffect(() => {
    if (!account) return undefined;
    const timer = window.setInterval(() => { void call<Chat[]>(`/api/wechat-kefu/chats?account=${encodeURIComponent(account)}`).then(setChats).catch(() => undefined); }, 8_000);
    return () => window.clearInterval(timer);
  }, [account]);
  //M 一条消息怎么画：图片缩略图（打码时不显示图）、语音条、链接/文章卡片，其余用后端写好的文字。
  const bubble = (m: Message) => {
    let view: View = {};
    try { view = m.view ? JSON.parse(m.view) as View : {}; } catch { view = {}; }
    if (m.kind === 'image') {
      if (mask) return <div className="wk-bubble wk-media">［图片］</div>;
      const src = withToken(`/api/wechat-kefu/image?account=${encodeURIComponent(account)}&chat=${encodeURIComponent(current?.username ?? '')}&source=${encodeURIComponent(m.source)}&local_id=${String(m.local_id)}`, TOKEN);
      return <div className="wk-bubble wk-media"><img src={src} alt="图片" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).replaceWith(document.createTextNode('［图片］')); }} /></div>;
    }
    if (m.kind === 'voice') return <div className="wk-bubble wk-voice">🔊 {String(view.seconds ?? 0)}″</div>;
    if (view.title !== undefined && !['location', 'card', 'transfer'].includes(m.kind)) {
      return <div className="wk-bubble wk-card"><b>{hide(view.title)}</b>{view.desc ? <span>{hide(view.desc)}</span> : null}<i>{m.kind === 'file' ? '文件' : '链接 / 公众号文章'}</i></div>;
    }
    return <div className="wk-bubble">{hide(m.text) || `[${m.kind}]`}</div>;
  };
  const watched = chats.filter((c) => c.watch).length;
  const unread = chats.filter((c) => c.unread > 0);
  const level = offline ? 'off' : !status ? 'off' : status.lastError ? 'err' : status.interval === 0 ? 'paused' : 'on';
  const pollText = offline ? '服务未连接' : !status ? '读取中…' : status.lastError ? '轮询出错' : status.interval === 0 ? '轮询已暂停' : `后台在听 · 已同步 ${String(status.synced ?? 0)}/${String(status.chats ?? 0)} 个会话`;

  return (
    <div className="wk-page" style={{ paddingTop: mask ? 42 : 0 }}>
      <privacy.MaskBanner />
      <header className="wk-top">
        <h1>积木客服</h1>
        <select value={status?.accounts.findIndex((a) => a.id === account) ?? -1}
          onChange={(e) => { setAccount(status?.accounts[Number(e.target.value)]?.id ?? ''); setCurrent(null); }} title="微信账号">
          {status?.accounts.length ? status.accounts.map((a, i) => <option key={i} value={i}>{mask ? `账号 ${String(i + 1)}` : a.nickname || `账号 ${String(i + 1)}`}</option>) : <option value={-1}>没有连上的账号</option>}
        </select>
        <div className="wk-poll-wrap" data-guide="poll">
          <button type="button" className={`wk-poll ${level}`} onClick={() => setPollOpen(!pollOpen)}><i />{pollText}</button>
          {pollOpen && (
            <div className="wk-poll-panel">
              <div>间隔：{status ? `${String(status.interval)} 毫秒` : '—'}（config.yaml → wechat-kefu.interval_ms）</div>
              <div>上次：{status ? clock(status.lastRunAt) : '—'}</div>
              <div>错误：{hide(offline || status?.lastError || '') || '无'}</div>
              <button type="button" onClick={() => setPollOpen(false)}>关闭</button>
            </div>
          )}
        </div>
        <span className="wk-grow" />
        <label className="wk-mask" data-guide="mask"><input type="checkbox" checked={mask} onChange={(e) => privacy.setMask(e.target.checked)} />演示打码</label>
        <button type="button" data-guide="scan" className="wk-btn" disabled={scanning} onClick={() => void scan()}>{scanning ? '扫描中…' : '一键扫描'}</button>
        <Guide steps={WECHAT_STEPS} className="wk-guide" />
      </header>

      <section className="wk-stats" data-guide="stats">
        <div className={`wk-stat ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
          <div className="k">会话总数</div><div className="v">{chats.length}</div><div className="s">{unread.length} 个有未读</div>
        </div>
        {KIND_ORDER.map((kind) => {
          const list = chats.filter((c) => kindOf(c) === kind);
          return (
            <div key={kind} className={`wk-stat ${filter === kind ? 'on' : ''}`} data-kind={kind} onClick={() => setFilter(filter === kind ? 'all' : kind)}>
              <div className="k">{KINDS[kind]}</div><div className="v">{list.length}</div>
              <div className="s">{list.filter((c) => c.watch).length ? `监听 ${String(list.filter((c) => c.watch).length)}` : ' '}</div>
            </div>
          );
        })}
        <div className={`wk-stat accent ${filter === 'watch' ? 'on' : ''}`} onClick={() => setFilter(filter === 'watch' ? 'all' : 'watch')}>
          <div className="k">重点监听</div><div className="v">{watched}</div><div className="s">只有这些会话 AI 起草回复</div>
        </div>
      </section>
      {scanNote && <div className="wk-note">{hide(scanNote)}</div>}

      <main className="wk-main">
        <aside className="wk-list" data-guide="list">
          <div className="wk-head">最近会话 <span>后台全部会话都在抓取；只有勾了「监听」的才让 AI 起草回复，不发送</span></div>
          <input className="wk-search" placeholder="搜索名称或最后消息" value={hide(search)} readOnly={mask} onChange={(e) => setSearch(e.target.value)} />
          {/* 2026-11-14 23:20 EST：照原版积木客服的筛选（SessionList.tsx 的 chips），恢复「只看监听」快速定位。 */}
          <div className="wk-chips">
            {([['all', '全部'], ['group', '群聊'], ['private', '私聊'], ['official', '公众号'], ['work', '企业微信'], ['system', '系统'], ['unread', '有未读'], ['fresh', '有新消息'], ['watch', '已监听']] as [Filter, string][]).map(([key, label]) => (
              <button key={key} type="button" className={`wk-chip ${filter === key ? 'on' : ''}`} onClick={() => setFilter(filter === key ? 'all' : key)}>{label}<b>{chats.filter((c) => matches(c, key)).length}</b></button>
            ))}
          </div>
          <div className="wk-tools">
            排序
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="recent">最近消息</option><option value="unread">未读多的在前</option><option value="watched">已监听在前</option><option value="name">按名称</option>
            </select>
            <span className="wk-grow" />
            <button type="button" className="wk-link" disabled={shown.length === 0} onClick={() => void pickAll(true)}>全部勾选当前列表</button>
            <button type="button" className="wk-link" disabled={shown.length === 0} onClick={() => void pickAll(false)}>取消当前列表</button>
            <span>显示 {shown.length} / {chats.length}</span>
          </div>
          <div className="wk-scroll">
            {shown.length === 0 && <div className="wk-empty">{account ? '没有会话，点「一键扫描」' : '还没有连上的微信账号'}</div>}
            {shown.map((chat) => (
              <div key={chat.username} className={`wk-item ${current?.username === chat.username ? 'on' : ''}`} onClick={() => setCurrent(chat)}>
                <div className="wk-avatar" data-kind={kindOf(chat)}>{[...hideName(chat.chat || chat.username)][0]}</div>
                <div className="wk-item-main">
                  <div className="wk-item-top">
                    <span className="wk-name">{hideName(chat.chat || chat.username)}</span>
                    {kindOf(chat) !== 'private' && <span className="wk-badge">{KINDS[kindOf(chat)]}</span>}
                    {chat.unread > 0 && <span className="wk-unread">{chat.unread}</span>}
                  </div>
                  <div className="wk-last">{hide(chat.last_message)}</div>
                  <div className="wk-switches" onClick={(e) => e.stopPropagation()}>
                    <label><input type="checkbox" checked={chat.watch} onChange={(e) => void toggle(chat, e.target.checked, chat.auto)} />监听</label>
                    {/* 2026-11-14 23:35 EST：只听不发，「自动发」开关不再显示（后端 send 没开，开了也不会发）。 */}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </aside>

        <section className="wk-chat" data-guide="messages">
          <div className="wk-head">
            <span>{current ? hideName(current.chat || current.username) : '选一个会话'}</span>
            {current && (
              <button type="button" className="wk-btn small" disabled={!current.watch || drafting}
                title={current.watch ? '根据这个会话起草一条回复，只生成不发送' : '请先勾选监听'}
                onClick={() => void askAi()}>{drafting ? '正在起草…' : '让 AI 回复'}</button>
            )}
          </div>
          <div className="wk-scroll wk-msgs">
            {current && messages.length === 0 && <div className="wk-empty">正在读这个会话的消息…（后台每 {status ? String(status.interval / 1000) : '3'} 秒同步一次）</div>}
            {messages.map((m) => (
              <div key={`${m.source}-${String(m.local_id)}`} className={`wk-msg ${m.from_self === 1 ? 'me' : ''}`}>
                {/* 2026-11-14 23:35 EST：像真微信——对方在左（头像 + 昵称），自己在右（绿色气泡）。 */}
                {m.from_self !== 1 && <div className="wk-avatar wk-msg-avatar">{[...hideName(m.sender || current?.chat || '?')][0]}</div>}
                <div className="wk-msg-body">
                  {m.sender && m.from_self !== 1 && <div className="wk-sender">{hideName(m.sender)}</div>}
                  {bubble(m)}
                  <div className="wk-time">{clock(m.at)}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="wk-compose">
            <textarea value={hide(draft)} readOnly={mask} rows={2} placeholder={current?.watch ? '人手发一句' : '只能发给监听中的会话'} disabled={!current?.watch}
              onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) void send(); }} />
            <button type="button" className="wk-btn" disabled={!current?.watch || draft.trim() === ''} onClick={() => void send()}>发送</button>
          </div>
        </section>

        <aside className="wk-out" data-guide="outbox">
          <div className="wk-head">AI 回复（只生成，不发送） <span>{outbox.filter((o) => o.state === 'draft' || o.state === 'waiting').length} 条待处理</span></div>
          <div className="wk-scroll">
            {outbox.length === 0 && <div className="wk-empty">监听的会话还没有新消息需要回复</div>}
            {outbox.map((o) => (
              <div key={o.id} className={`wk-outitem ${o.state}`}>
                <div className="wk-item-top"><span className="wk-name">{hideName(o.name)}</span><span className={`wk-state ${o.state}`}>{STATES[o.state] ?? o.state}</span></div>
                <div className="wk-outtext">{hide(o.text)}</div>
                <div className="wk-time">{clock(o.at)}{o.note ? ` · ${hide(o.note)}` : ''}</div>
                {['draft', 'failed', 'rejected'].includes(o.state) && <button type="button" className="wk-btn small" onClick={() => void resend(o.id)}>发送</button>}
              </div>
            ))}
          </div>
        </aside>
      </main>
    </div>
  );
}
