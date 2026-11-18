/**
 * 积木客服页（/wechat-kefu/，web 插件托管 dist/web/wechat-kefu.html）。照积木客服（source/jimukefu/src/web）的样子：
 * 顶栏（账号、轮询状态、演示打码、一键扫描、演示引导）、统计卡片、左边会话列表带「监听 / 自动发」开关、中间消息、右边待发回复。
 * 数据都走 wechat-kefu 插件的接口（src7/plugins/wechat/page/Routes.ts）：/api/wechat-kefu/status、chats、watch、messages、outbox、send、outbox/send。
 * 隐私：「演示打码」默认开，会话名和消息全换成＊（只留字数）；账号只显示“账号 1、2”，不显示微信号。2026-11-14 jm开发。
 */
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import * as virtuoso from 'react-virtuoso';
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

function getKind(chat: Chat): Kind {
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
  let requestInit: RequestInit | undefined;
  if (init) {
    requestInit = { ...init, headers: { 'Content-Type': 'application/json' } };
  }

  //M 给客服接口地址附带统一访问令牌并携带请求配置发起请求，统一解析后端 JSON 与错因。
  const response = await fetch(withToken(path, TOKEN), requestInit);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? String(response.status));
  return body;
}

/** 消息列表看得见的上下各多画多少像素：图片、卡片高度不定，多画一点，快速滚动时不露白。 */
const MSG_OVERSCAN_PX = 600;

/** 消息列表顶上留 12px（原来 .wk-msgs 的上边距），由 react-virtuoso 当 Header 画。 */
function MsgHead() {
  return <div className="wk-msgs-head" />;
}

/** 消息列表交给 react-virtuoso 的部件；放在组件外面，每次渲染是同一个对象，列表不重建。 */
const MSG_PARTS: virtuoso.Components<Message> = { Header: MsgHead };

function getClock(ms: number): string {
  if (!ms) return '—';

  let epochMs = ms * 1000;
  if (ms > 1e12) {
    epochMs = ms;
  }
  const d = new Date(epochMs);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}


/** 整理轮询条的颜色档和说明文字。 */
function getPollSummary(offline: string, status: Status | null): { level: string; text: string } {
  if (offline) return { level: 'off', text: '服务未连接' };

  if (!status) return { level: 'off', text: '读取中…' };

  if (status.lastError) return { level: 'err', text: '轮询出错' };

  if (status.interval === 0) return { level: 'paused', text: '轮询已暂停' };

  return { level: 'on', text: `后台在听 · 已同步 ${String(status.synced ?? 0)}/${String(status.chats ?? 0)} 个会话` };
}

/**
 * 积木客服页面主组件：轮询微信客服轮询状态与待发队列、切换账号与拉取最近会话、
 * 按分类/状态筛选与排序、开关会话监听、用虚拟列表查看消息并支持人工发送或让 AI 起草不自动发送的回复。
 * @returns 客服页顶栏、分类统计卡及左会话/中消息/右待发三栏工作区 JSX 元素。
 * 副作用：启动 3 秒（状态/草稿箱/当前会话消息）与 8 秒（会话列表）定时轮询，调用 `/api/wechat-kefu/*` 各读写接口，
 * 并按演示打码开关订阅与更新全局隐藏状态。
 */
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
      //M 拉取后端轮询状态与已连微信账号，首个账号未选定时默认选中第一项。
      void call<Status>('/api/wechat-kefu/status').then((s) => {
        setStatus(s); setOffline('');
        setAccount((old) => old || s.accounts[0]?.id || '');
      }).catch((error: Error) => setOffline(error.message));

      //M 同步拉取 AI 已起草与待发送队列，刷新右侧回复栏。
      void call<Out[]>('/api/wechat-kefu/outbox').then(setOutbox).catch(() => undefined);
    };

    //M 开页立即拉取一次状态与待发队列，随后每 3 秒定时轮询刷新。
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, []);

  const scan = useCallback(async () => {
    if (!account) { setScanNote('还没有连上的微信账号（program/wechat/runtime/data/accounts.yaml）'); return; }
    setScanning(true); setScanNote('正在读本机微信的最近会话…');
    try {
      //M 请求当前选中微信账号的最近会话列表，用于刷新左侧列表与顶部统计卡。
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
    //M 把单个会话的监听/自动发送开关写入后端持久化，再同步更新本地会话列表。
    await call('/api/wechat-kefu/watch', { method: 'PUT', body: JSON.stringify({ account, chat: chat.username, name: chat.chat, watch, auto }) });
    setChats((list) =>
      list.map((c) => {
        if (c.username !== chat.username) return c;

        return { ...c, watch, auto: watch && auto };
      }),
    );
  };
  const send = async () => {
    if (!current || draft.trim() === '') return;
    try {
      //M 人工向当前选中且已监听的会话发送输入框草稿文本，成功后清空输入框。
      await call('/api/wechat-kefu/send', { method: 'POST', body: JSON.stringify({ account, chat: current.username, text: draft }) });
      setDraft('');
    } catch (error) { setScanNote(`发送失败：${(error as Error).message}`); }
  };
  const resend = async (id: number) => {
    //M 对右侧草稿或失败列表里的指定待发回复发起正式发送请求，失败时提示错误信息。
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
  const matches = (c: Chat, key: Filter): boolean => {
    if (key === 'all') return true;

    if (key === 'watch') return c.watch;

    if (key === 'unread') return c.unread > 0;

    if (key === 'fresh') return c.timestamp * 1000 > LOADED_AT;

    //M 其余筛选键按会话分类（群聊/私聊/公众号/企业微信/系统）归类匹配。
    return getKind(c) === key;
  };
  const shown = useMemo(() => {
    //M 先按当前筛选条件（调用 matches）和搜索关键词过滤会话，再按选定排序规则排列。
    const list = chats.filter((c) => matches(c, filter) && (search === '' || c.chat.includes(search) || c.username.includes(search) || c.last_message.includes(search)));
    const comparators: Record<string, (a: Chat, b: Chat) => number> = {
      unread: (a, b) => b.unread - a.unread,
      watched: (a, b) => Number(b.watch) - Number(a.watch),
      name: (a, b) => (a.chat || '').localeCompare(b.chat || '', 'zh-CN'),
    };
    const compare = comparators[sort] ?? ((a: Chat, b: Chat) => b.timestamp - a.timestamp);
    list.sort(compare);
    return list;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, filter, search, sort]);
  const pickAll = async (watch: boolean) => {
    //M 仅对当前展示列表中监听状态与目标不一致的会话逐个调用 toggle 更新，减少重复接口请求。
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
    try {
      if (m.view) {
        view = JSON.parse(m.view) as View;
      }
    } catch { view = {}; }
    if (m.kind === 'image') {
      //G 打码开启时不请求原图；否则给图片拉取接口拼上访问令牌作为 img 地址。
      if (mask) return <div className="wk-bubble wk-media">［图片］</div>;
      const src = withToken(`/api/wechat-kefu/image?account=${encodeURIComponent(account)}&chat=${encodeURIComponent(current?.username ?? '')}&source=${encodeURIComponent(m.source)}&local_id=${String(m.local_id)}`, TOKEN);
      return <div className="wk-bubble wk-media"><img src={src} alt="图片" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).replaceWith(document.createTextNode('［图片］')); }} /></div>;
    }
    if (m.kind === 'voice') return <div className="wk-bubble wk-voice">🔊 {String(view.seconds ?? 0)}″</div>;
    if (view.title !== undefined && !['location', 'card', 'transfer'].includes(m.kind)) {
      let typeLabel = '链接 / 公众号文章';
      if (m.kind === 'file') {
        typeLabel = '文件';
      }

      //M 渲染链接/公众号文章或文件卡片气泡，标题与摘要按演示打码状态脱敏。
      return <div className="wk-bubble wk-card"><b>{hide(view.title)}</b>{Boolean(view.desc) && <span>{hide(view.desc!)}</span>}<i>{typeLabel}</i></div>;
    }

    //M 普通文本或兜底消息类型：对正文应用打码，空文本时回退展示消息类型标记。
    return <div className="wk-bubble">{hide(m.text) || `[${m.kind}]`}</div>;
  };

  //M 汇总监听/未读数及轮询状态灯颜色与文案，供顶栏按钮与统计卡展示。
  const watched = chats.filter((c) => c.watch).length;
  const unread = chats.filter((c) => c.unread > 0);
  const { level, text: pollText } = getPollSummary(offline, status);
  const toggleFilter = (key: Filter): void => {
    if (filter === key) {
      setFilter('all');
      return;
    }
    setFilter(key);
  };
  const getFilterClass = (key: Filter): string => {
    if (filter === key) return 'on';

    return '';
  };
  let pageTop = 0;
  if (mask) {
    pageTop = 42;
  }
  let accountOptions: ReactNode = <option value={-1}>没有连上的账号</option>;
  if (status?.accounts.length) {
    accountOptions = status.accounts.map((a, i) => {
      let label = a.nickname || `账号 ${String(i + 1)}`;
      if (mask) {
        label = `账号 ${String(i + 1)}`;
      }
      return <option key={i} value={i}>{label}</option>;
    });
  }
  let intervalText = '—';
  let lastText = '—';
  let intervalSeconds = '3';
  if (status) {
    //M 格式化后端轮询间隔和上次同步时间戳，供轮询详情浮层展示。
    intervalText = `${String(status.interval)} 毫秒`;
    lastText = getClock(status.lastRunAt);
    intervalSeconds = String(status.interval / 1000);
  }
  let scanLabel = '一键扫描';
  if (scanning) {
    scanLabel = '扫描中…';
  }
  let emptyListText = '还没有连上的微信账号';
  if (account) {
    emptyListText = '没有会话，点「一键扫描」';
  }
  let currentTitle = '选一个会话';
  if (current) {
    //M 选中会话后对聊天栏标题名称按演示打码规则只留首字。
    currentTitle = hideName(current.chat || current.username);
  }
  let aiTitle = '请先勾选监听';
  let composePlaceholder = '只能发给监听中的会话';
  if (current?.watch) {
    aiTitle = '根据这个会话起草一条回复，只生成不发送';
    composePlaceholder = '人手发一句';
  }
  let aiButtonText = '让 AI 回复';
  if (drafting) {
    aiButtonText = '正在起草…';
  }

  //M 渲染积木客服主界面：顶栏账号与轮询状态、分类统计卡，以及左会话/中消息/右待发三栏工作区。
  return (
    <div className="wk-page" style={{ paddingTop: pageTop }}>
      <privacy.MaskBanner />
      <header className="wk-top">
        <h1>积木客服</h1>
        <select value={status?.accounts.findIndex((a) => a.id === account) ?? -1}
          onChange={(e) => { setAccount(status?.accounts[Number(e.target.value)]?.id ?? ''); setCurrent(null); }} title="微信账号">
          {accountOptions}
        </select>
        <div className="wk-poll-wrap" data-guide="poll">
          <button type="button" className={`wk-poll ${level}`} onClick={() => setPollOpen(!pollOpen)}><i />{pollText}</button>
          {pollOpen && (
            <div className="wk-poll-panel">
              {
                //M 渲染轮询详情浮层：显示轮询间隔、上次同步时间与经打码处理的错误信息。
              /**/}
              <div>间隔：{intervalText}（config.yaml → wechat-kefu.interval_ms）</div>
              <div>上次：{lastText}</div>
              <div>错误：{hide(offline || status?.lastError || '') || '无'}</div>
              <button type="button" onClick={() => setPollOpen(false)}>关闭</button>
            </div>
          )}
        </div>
        <span className="wk-grow" />
        <label className="wk-mask" data-guide="mask"><input type="checkbox" checked={mask} onChange={(e) => privacy.setMask(e.target.checked)} />演示打码</label>
        <a className="wk-top-link" href={withToken('/', TOKEN)}>聊天</a>
        <button type="button" data-guide="scan" className="wk-btn" disabled={scanning} onClick={() => void scan()}>{scanLabel}</button>
        <Guide steps={WECHAT_STEPS} className="wk-guide" />
      </header>

      <section className="wk-stats" data-guide="stats">
        {
          //M 渲染顶部统计与快捷筛选卡片：总会话、各会话分类计数（调用 getKind 与 toggleFilter）。
        /**/}
        <div className={`wk-stat ${getFilterClass('all')}`} onClick={() => setFilter('all')}>
          <div className="k">会话总数</div><div className="v">{chats.length}</div><div className="s">{unread.length} 个有未读</div>
        </div>
        {KIND_ORDER.map((kind) => {
          //M 统计当前分类下的会话数量与监听数，生成分类筛选卡片。
          const list = chats.filter((c) => getKind(c) === kind);
          const watchedCount = list.filter((c) => c.watch).length;
          let watchText = ' ';
          if (watchedCount > 0) {
            watchText = `监听 ${String(watchedCount)}`;
          }

          //M 渲染该会话分类统计卡片，点击切换筛选高亮样式。
          return (
            <div key={kind} className={`wk-stat ${getFilterClass(kind)}`} data-kind={kind} onClick={() => toggleFilter(kind)}>
              <div className="k">{KINDS[kind]}</div><div className="v">{list.length}</div>
              <div className="s">{watchText}</div>
            </div>
          );
        })}
        {
          //M 渲染重点监听汇总卡片，点击可快捷筛选 AI 起草覆盖的会话。
        /**/}
        <div className={`wk-stat accent ${getFilterClass('watch')}`} onClick={() => toggleFilter('watch')}>
          <div className="k">重点监听</div><div className="v">{watched}</div><div className="s">只有这些会话 AI 起草回复</div>
        </div>
      </section>
      {scanNote && <div className="wk-note">{hide(scanNote)}</div>}

      <main className="wk-main">
        <aside className="wk-list" data-guide="list">
          {
            //M 左侧会话栏头部、脱敏搜索框、状态/类型筛选胶囊与批量勾选当前列表工具条。
          /**/}
          <div className="wk-head">最近会话 <span>后台全部会话都在抓取；只有勾了「监听」的才让 AI 起草回复，不发送</span></div>
          <input className="wk-search" placeholder="搜索名称或最后消息" value={hide(search)} readOnly={mask} onChange={(e) => setSearch(e.target.value)} />
          {/* 2026-11-14 23:20 EST：照原版积木客服的筛选（SessionList.tsx 的 chips），恢复「只看监听」快速定位。 */}
          <div className="wk-chips">
            {([['all', '全部'], ['group', '群聊'], ['private', '私聊'], ['official', '公众号'], ['work', '企业微信'], ['system', '系统'], ['unread', '有未读'], ['fresh', '有新消息'], ['watch', '已监听']] as [Filter, string][]).map(([key, label]) => (
              <button key={key} type="button" className={`wk-chip ${getFilterClass(key)}`} onClick={() => toggleFilter(key)}>{label}<b>{chats.filter((c) => matches(c, key)).length}</b></button>
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
          {shown.length === 0 && (
            <div className="wk-scroll">
              <div className="wk-empty">{emptyListText}</div>
            </div>
          )}
          {/* 2026-11-17 EST：会话可上千个，用 react-virtuoso 虚拟滚动，只画看得见的那几行（用户 11-17）。 */}
          {shown.length > 0 && (
            <virtuoso.Virtuoso
              className="wk-scroll"
              data={shown}
              computeItemKey={(_index, chat) => chat.username}
              itemContent={(_index, chat) => {
                //M 判断当前会话是否处于选中高亮状态，准备列表行样式。
                let itemClass = 'wk-item ';
                if (current?.username === chat.username) {
                  itemClass = 'wk-item on';
                }

                //M 渲染单条会话行：脱敏头像首字与名称、分类徽章、未读数及阻止冒泡的监听复选框。
                return (
                  <div className={itemClass} onClick={() => setCurrent(chat)}>
                    <div className="wk-avatar" data-kind={getKind(chat)}>{[...hideName(chat.chat || chat.username)][0]}</div>
                    <div className="wk-item-main">
                      <div className="wk-item-top">
                        <span className="wk-name">{hideName(chat.chat || chat.username)}</span>
                        {getKind(chat) !== 'private' && <span className="wk-badge">{KINDS[getKind(chat)]}</span>}
                        {chat.unread > 0 && <span className="wk-unread">{chat.unread}</span>}
                      </div>
                      <div className="wk-last">{hide(chat.last_message)}</div>
                      <div className="wk-switches" onClick={(e) => e.stopPropagation()}>
                        <label><input type="checkbox" checked={chat.watch} onChange={(e) => void toggle(chat, e.target.checked, chat.auto)} />监听</label>
                        {/* 2026-11-14 23:35 EST：只听不发，「自动发」开关不再显示（后端 send 没开，开了也不会发）。 */}
                      </div>
                    </div>
                  </div>
                );
              }}
            />
          )}
        </aside>

        <section className="wk-chat" data-guide="messages">
          {
            //M 中间消息窗口头部：显示脱敏会话标题与仅在已监听时允许触发的「让 AI 回复」按钮。
          /**/}
          <div className="wk-head">
            <span>{currentTitle}</span>
            {current && (
              <button type="button" className="wk-btn small" disabled={!current.watch || drafting}
                title={aiTitle}
                onClick={() => void askAi()}>{aiButtonText}</button>
            )}
          </div>
          {messages.length === 0 && (
            <div className="wk-scroll">
              {current && <div className="wk-empty">正在读这个会话的消息…（后台每 {intervalSeconds} 秒同步一次）</div>}
            </div>
          )}
          {/* 2026-11-17 EST：一个会话最多取 1000 条，用 react-virtuoso 虚拟滚动；照旧停在最早的一条，不自动到底。 */}
          {messages.length > 0 && (
            <virtuoso.Virtuoso
              className="wk-scroll"
              data={messages}
              components={MSG_PARTS}
              computeItemKey={(_index, m) => `${m.source}-${String(m.local_id)}`}
              increaseViewportBy={MSG_OVERSCAN_PX}
              itemContent={(_index, m) => {
                //M 区分己方发出与对方来信的气泡方向样式。
                let rowClass = 'wk-msg ';
                if (m.from_self === 1) {
                  rowClass = 'wk-msg me';
                }

                //M 渲染单条消息行：对方消息附首字头像与昵称，调用 bubble 绘制内容并格式化发送时间。
                return (
                  <div className="wk-msg-row">
                  <div className={rowClass}>
                    {/* 2026-11-14 23:35 EST：像真微信——对方在左（头像 + 昵称），自己在右（绿色气泡）。 */}
                    {m.from_self !== 1 && <div className="wk-avatar wk-msg-avatar">{[...hideName(m.sender || current?.chat || '?')][0]}</div>}
                    <div className="wk-msg-body">
                      {m.sender && m.from_self !== 1 && <div className="wk-sender">{hideName(m.sender)}</div>}
                      {bubble(m)}
                      <div className="wk-time">{getClock(m.at)}</div>
                    </div>
                  </div>
                  </div>
                );
              }}
            />
          )}
          {
            //M 底部人工输入发送区：打码状态脱敏并锁定只读，仅已监听会话可用 Ctrl+Enter 或点击发送。
          /**/}
          <div className="wk-compose">
            <textarea value={hide(draft)} readOnly={mask} rows={2} placeholder={composePlaceholder} disabled={!current?.watch}
              onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) void send(); }} />
            <button type="button" className="wk-btn" disabled={!current?.watch || draft.trim() === ''} onClick={() => void send()}>发送</button>
          </div>
        </section>

        <aside className="wk-out" data-guide="outbox">
          {
            //M 右侧 AI 回复队列栏：统计待处理条数并渲染各草稿/已发/失败卡片。
          /**/}
          <div className="wk-head">AI 回复（只生成，不发送） <span>{outbox.filter((o) => o.state === 'draft' || o.state === 'waiting').length} 条待处理</span></div>
          {outbox.length === 0 && (
            <div className="wk-scroll">
              <div className="wk-empty">监听的会话还没有新消息需要回复</div>
            </div>
          )}
          {outbox.length > 0 && (
            <virtuoso.Virtuoso
              className="wk-scroll"
              data={outbox}
              computeItemKey={(_index, o) => o.id}
              itemContent={(_index, o) => {
                //M 拼接该条待发回复的可选说明备注，并按演示打码状态脱敏。
                let outNote = '';
                if (o.note) {
                  outNote = ` · ${hide(o.note)}`;
                }

                //M 渲染待发卡片：脱敏会话名与正文、格式化时间，并为草稿/失败/被拒状态提供发送按钮。
                return (
                  <div className={`wk-outitem ${o.state}`}>
                    <div className="wk-item-top"><span className="wk-name">{hideName(o.name)}</span><span className={`wk-state ${o.state}`}>{STATES[o.state] ?? o.state}</span></div>
                    <div className="wk-outtext">{hide(o.text)}</div>
                    <div className="wk-time">{getClock(o.at)}{outNote}</div>
                    {['draft', 'failed', 'rejected'].includes(o.state) && <button type="button" className="wk-btn small" onClick={() => void resend(o.id)}>发送</button>}
                  </div>
                );
              }}
            />
          )}
        </aside>
      </main>
    </div>
  );
}
