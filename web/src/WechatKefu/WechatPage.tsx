/**
 * 积木客服页（/wechat-kefu/，web 插件托管 dist/web/wechat-kefu.html）。照积木客服（source/jimukefu/src/web）的样子：
 * 左栏筛选会话并管理监听，中间查看消息，右栏复制 AI 建议。
 * 通过 wechat-kefu 接口读取会话、消息和草稿，支持手动起草和更改监听。
 * 演示打码开启时隐藏账号、会话内容和建议原文。
 */
import { type ReactNode, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import * as virtuoso from 'react-virtuoso';
import { Guide } from '../Guide/Guide.tsx';
import { WECHAT_STEPS } from '../Guide/steps-wechat-kefu.ts';
import * as privacy from '../Privacy/Mask.tsx';
import { TOKEN, withToken } from '../Token.ts';
import * as voice from './WechatVoice.tsx';
import * as entries from '../Programs/Entries.ts';
import * as i18n from '../I18n.ts';

type Kind = 'group' | 'private' | 'official' | 'work' | 'system';
const KINDS: Record<Kind, string> = { group: '群聊', private: '私聊', official: '公众号', work: '企业微信', system: '系统会话' };
const KIND_ORDER: Kind[] = ['group', 'private', 'official', 'work', 'system'];
/** 微信自带的系统会话（文件传输助手、微信团队等）。 */
const SYSTEM = new Set([
  'filehelper', 'weixin', 'notifymessage', 'fmessage', 'floatbottle', 'medianote', 'newsapp',
  'qqmail', 'brandsessionholder', 'brandservicesessionholder', 'qmessage', 'tmessage', 'qqsync',
]);
interface Status {
  lastRunAt: number;
  lastError: string;
  interval: number;
  chats?: number;
  synced?: number;
  accounts: { id: string; nickname: string }[];
}
interface Chat {
  username: string;
  chat: string;
  is_group: boolean;
  unread: number;
  last_message: string;
  timestamp: number;
  watch: boolean;
}
interface Message {
  /** 记录所属的账号及聊天，用于定位原语音。 */
  account: string;
  chat: string;
  local_id: number;
  source: string;
  at: number;
  from_self: number | null;
  kind: string;
  sender: string;
  text: string;
  view?: string | null;
}
/** 气泡视图（后端存的 JSON，jimukefu msgview）：图片、语音、卡片用。 */
interface View { kind?: string; text?: string; title?: string; desc?: string; seconds?: number; amount?: string }
/** 原版积木客服的筛选一排（jimukefu src/web/src/format.ts FILTERS）。 */
type Filter = Kind | 'all' | 'watch' | 'unread' | 'fresh';
const FILTERS: [Filter, string][] = [
  ['all', '全部'], ['group', '群聊'], ['private', '私聊'], ['official', '公众号'],
  ['work', '企业微信'], ['system', '系统'], ['unread', '有未读'], ['fresh', '有新消息'], ['watch', '已监听'],
];
const LOADED_AT = Date.now();
interface Out { id: number; name: string; text: string; state: string; at: number }

function getKind(chat: Chat): Kind {
  const id = chat.username;
  if (id.endsWith('@chatroom') || chat.is_group) return 'group';
  if (id.startsWith('gh_')) return 'official';
  if (id.endsWith('@openim')) return 'work';
  if (SYSTEM.has(id) || id.startsWith('@')) return 'system';
  return 'private';
}

/** 判断会话是否符合分类或状态筛选。 */
function matches(chat: Chat, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'watch') return chat.watch;
  if (filter === 'unread') return chat.unread > 0;
  if (filter === 'fresh') return chat.timestamp * 1000 > LOADED_AT;

  //M 其余筛选项是会话分类。
  const kind = getKind(chat);
  return kind === filter;
}

/** 请求客服接口，保留原始响应供轮询比较，失败时抛接口给的原因。 */
async function getResponse(path: string, init?: RequestInit): Promise<Response> {
  let requestInit: RequestInit | undefined;
  if (init) {
    requestInit = { ...init, headers: { 'Content-Type': 'application/json' } };
  }

  //M 沿用主网页的访问令牌。
  const address = withToken(path, TOKEN);
  const response = await fetch(address, requestInit);
  if (response.ok) return response;

  //G 失败时沿用后端的可读错误。
  const body = await response.json().catch(() => ({})) as { error?: string };
  throw new Error(body.error ?? String(response.status));
}

/** 读取一次客服接口的 JSON，供主动操作使用。 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  //M 手动操作完成后立即读取结果。
  const response = await getResponse(path, init);
  return await response.json().catch(() => ({})) as T;
}

/** 按间隔获取 JSON，内容变化时才解码；结束时取消当前请求和下次刷新。 */
function pollJson<T>(
  path: string,
  interval: number,
  update: (value: T) => void,
  onError?: (error: Error) => void,
  firstPath = path,
): () => void {
  const controller = new AbortController();
  const signal = controller.signal;
  const options = { signal };
  let previous: string | undefined;
  let timer: number | undefined;

  async function refresh(address: string): Promise<void> {
    try {
      //M 对比响应原文，避免重复解析并提交同样的列表。
      const response = await getResponse(address, options);
      const body = await response.text();
      if (signal.aborted || previous === body) return;

      const value = JSON.parse(body) as T;
      previous = body;
      //M 把有变化的数据交给本轮轮询的页面状态。
      update(value);
    } catch (error) {
      //G 成功恢复时重新交付数据，便于清掉上次轮询错误。
      previous = undefined;
      if (!signal.aborted) onError?.(error as Error);
    } finally {
      //M 等本轮结束才排下一次，避免慢请求重叠或倒序覆盖。
      if (!signal.aborted) timer = window.setTimeout(() => { void refresh(path); }, interval);
    }
  }

  //M 首轮允许显式刷新，后续走普通轮询地址。
  void refresh(firstPath);
  return () => {
    //M 离开当前账号或会话时，不再接收旧请求的内容。
    controller.abort();
    window.clearTimeout(timer);
  };
}

/** 微信正式渠道或已用于隔离运行的微信渠道。 */
function isWechatTrialChannel(name: unknown): boolean {
  return name === 'wechat' || name === 'wechat-external';
}

/** 旧页只给正在运行且登记微信渠道的程序显示试用入口。 */
function ExternalKefuLink() {
  const [href, setHref] = useState('');
  const [language] = useState(() => {
    //M 沿用客服演示引导的语言选择，地址覆盖本机偏好。
    const query = new URLSearchParams(window.location.search);
    const requested = query.get('lang');
    const explicit = i18n.matchLanguage(requested);
    if (explicit !== undefined) return explicit;

    //G 读不到语言偏好时继续渲染旧页。
    try {
      return i18n.loadLanguage(window.localStorage);
    } catch {
      return 'zh-CN';
    }
  });
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function poll(): Promise<void> {
      const path = '/api/programs';
      const deadline = AbortSignal.timeout(5_000);
      const signals = [controller.signal, deadline];
      const signal = AbortSignal.any(signals);
      const options = { signal, cache: 'no-store' as const };
      try {
        //M 复用客服访问令牌与主站 programs 的同源链接校验。
        type Programs = { programs?: { name: string; paused?: boolean; channels?: unknown }[] };
        const data = await call<Programs>(path, options);
        if (controller.signal.aborted) return;

        const rows = data.programs ?? [];
        const programs = rows.filter((row) => row.paused !== true);
        //M 用公共程序入口筛掉无法打开的试用页。
        const available = entries.getEntries({ programs });
        const matches = await Promise.all(available.map(async (entry) => {
          const row = programs.find((program) => program.name === entry.name);
          if (Array.isArray(row?.channels)) return row.channels.some(isWechatTrialChannel);

          //M 旧版 programs 状态不带渠道名，通过同源外置客服接口核对本程序实际登记的渠道。
          const name = encodeURIComponent(entry.name);
          const capability = `/programs/${name}/api/wechat-kefu/capabilities`;
          try {
            const details = await call<{ channel?: string }>(capability, options);
            return isWechatTrialChannel(details.channel);
          } catch {
            return false;
          }
        }));
        if (controller.signal.aborted) return;

        const entry = available.find((_entry, index) => matches[index]);
        setHref(entry?.ui ?? '');
      } catch {
        //G 状态接口不可用时清掉旧入口，保留原客服页。
        if (!controller.signal.aborted) setHref('');
      } finally {
        //M 状态变更后自动更新；每轮只保留一个请求。
        if (!controller.signal.aborted) timer = window.setTimeout(() => { void poll(); }, 5_000);
      }
    }
    //M 挂载后立即查一次外置试用入口。
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);
  if (href === '') return null;

  //M 用当前界面语言显示入口，原文字面量交给语言包提取。
  const t = (text: string): string => i18n.translate(language, text);
  const label = t('外置客服页（试用）');

  //M 使用和旧页面相同的访问令牌，直接进入当前就绪程序的客服页。
  const address = withToken(href, TOKEN);
  return <a className="wk-top-link" href={address}>{label}</a>;
}

/** 消息列表看得见的上下各多画多少像素：图片、卡片高度不定，多画一点，快速滚动时不露白。 */
const MSG_OVERSCAN_PX = 600;

/** 消息列表顶上留 12px（原来 .wk-msgs 的上边距），由 react-virtuoso 当 Header 画。 */
function MsgHead() {
  return <div className="wk-msgs-head" />;
}

/** 消息列表交给 react-virtuoso 的部件；放在组件外面，每次渲染是同一个对象，列表不重建。 */
const MSG_PARTS: virtuoso.Components<Message> = { Header: MsgHead };

/** 缩略图加载失败时由 React 切换占位内容，滚动或切换打码仍能正常卸载气泡。 */
function MessageImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>［图片］</>;

  return <img src={src} alt="图片" loading="lazy" onError={() => setFailed(true)} />;
}

//M 共用消息时钟的格式化器，快速滚动时无需为每个气泡重建。
const CLOCK = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** 把旧库的秒或毫秒时间转换为页面显示的本地时刻。 */
function getClock(ms: number): string {
  if (!ms) return '—';

  let epochMs = ms * 1000;
  if (ms > 1e12) {
    epochMs = ms;
  }
  const d = new Date(epochMs);
  //G 保留旧 UI 对无效时间戳的显示。
  if (Number.isNaN(d.getTime())) return 'Invalid Date';

  //M 格式化可见行的时间。
  return CLOCK.format(d);
}

/** 判断轮询状态是否会改变当前页面显示的内容。 */
function sameVisibleStatus(previous: Status | null, next: Status): boolean {
  if (previous === null) return false;
  if (previous.interval !== next.interval || previous.lastError !== next.lastError) return false;
  if (previous.synced !== next.synced || previous.chats !== next.chats) return false;
  if (Math.floor(previous.lastRunAt / 60_000) !== Math.floor(next.lastRunAt / 60_000)) return false;
  if (previous.accounts.length !== next.accounts.length) return false;

  //M 下拉只展示账号顺序和昵称，轮询忙闲、累计轮数等字段无需触发重绘。
  return previous.accounts.every((entry, index) => {
    const account = next.accounts[index];
    return account?.id === entry.id && account.nickname === entry.nickname;
  });
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
 * 积木客服主页面，按账号查看会话、管理监听、查看消息和复制 AI 建议。
 * 副作用：轮询状态、会话、消息与草稿，用户操作时保存监听或请求起草。
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
  const [selection, setSelection] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [outbox, setOutbox] = useState<Out[]>([]);
  const [outboxRevision, setOutboxRevision] = useState(0);
  const [manualScan, setManualScan] = useState<{ account: string } | null>(null);
  const [drafting, setDrafting] = useState(false);
  //M 演示打码默认关；开着时顶部有提示条，下面 paddingTop/top 才让位
  const mask = privacy.useMask();
  const [pollOpen, setPollOpen] = useState(false);

  //G 演示打码：整段换成＊，只留字数，联系人名和内容一个字都不露（投屏、截图用）。
  //G 上述旧规则现统一为共用模块：正文整段隐藏；姓名只留首字。所有页面读同一个持久化开关。
  const hide = useCallback((value: string) => privacy.text(value, mask), [mask]);
  const hideName = useCallback((value: string) => privacy.name(value, mask), [mask]);
  const current = useMemo(() => {
    if (selection === null) return null;

    //M 保留被打开的会话，同时使用最新的会话名称与监听状态。
    const latest = chats.find((chat) => chat.username === selection.username);
    return latest ?? selection;
  }, [chats, selection]);
  const currentId = current?.username;
  const currentName = current?.chat ?? '';

  //M 轮询通用状态，只在界面字段有变时更新，首次自动选中已连接的账号。
  useEffect(() => {
    const path = '/api/wechat-kefu/status';
    const update = (next: Status): void => {
      setStatus((previous) => {
        if (sameVisibleStatus(previous, next)) return previous;

        return next;
      });
      setOffline('');
      const firstAccount = next.accounts[0]?.id ?? '';
      setAccount((old) => old || firstAccount);
    };
    const onError = (error: Error): void => setOffline(error.message);

    //M 状态请求失败时在顶栏提示。
    return pollJson(path, 3_000, update, onError);
  }, []);

  useEffect(() => {
    const path = '/api/wechat-kefu/outbox';
    const update = (rows: Out[]): void => {
      //M 发件记录也可能来自人工发送，右栏只展示尚待处理的建议。
      const suggestions = rows.filter((row) => row.state === 'draft' || row.state === 'waiting');
      setOutbox(suggestions);
    };

    //M 起草完成后重新启动草稿轮询，立即取到刚生成的建议。
    return pollJson(path, 3_000, update);
  }, [outboxRevision]);

  useEffect(() => {
    if (!account) return;

    const accountQuery = encodeURIComponent(account);
    const path = `/api/wechat-kefu/chats?account=${accountQuery}`;
    let firstPath = path;
    if (manualScan?.account === account) {
      firstPath = `${path}&fresh=1`;
    }
    let initial = true;
    setScanning(true);
    setScanNote('正在读本机微信的最近会话…');

    //M 首次加载与手动扫描显示结果，自动刷新只更新列表。
    const finishScan = (note: string): void => {
      if (!initial) return;

      initial = false;
      setScanNote(note);
      setScanning(false);
    };
    const update = (rows: Chat[]): void => {
      setChats(rows);
      const note = `读到 ${String(rows.length)} 个会话`;
      //M 初次加载完成时结束扫描提示。
      finishScan(note);
    };
    const onError = (error: Error): void => {
      const note = `扫描失败：${error.message}`;
      //G 第一次加载失败也需要恢复扫描按钮。
      finishScan(note);
    };

    //M 每个账号只开一条会话轮询，手动扫描让首个请求跳过缓存。
    return pollJson(path, 8_000, update, onError, firstPath);
  }, [account, manualScan]);

  useEffect(() => {
    if (currentId === undefined) return;

    //M 每次切换会话取消上一会话的请求，保留原来的千条历史窗口。
    const query = new URLSearchParams({ account, chat: currentId, name: currentName, limit: '1000' });
    const path = `/api/wechat-kefu/messages?${query.toString()}`;
    return pollJson<Message[]>(path, 3_000, setMessages);
  }, [account, currentId, currentName]);

  const selectChat = (chat: Chat): void => {
    if (chat.username === currentId) return;

    //M 切换时立即清掉旧列表，避免上一会话的内容贴在新标题下。
    setMessages([]);
    setSelection(chat);
  };

  const toggle = async (chat: Chat, watch: boolean): Promise<void> => {
    const path = '/api/wechat-kefu/watch';
    const watchRequest = { account, chat: chat.username, name: chat.chat, watch };
    const body = JSON.stringify(watchRequest);
    const request = { method: 'PUT', body };

    //M 保存监听标记，成功后更新左栏与当前会话的起草权限。
    await call(path, request);
    setChats((list) => list.map((item) => {
      if (item.username !== chat.username) return item;

      return { ...item, watch };
    }));
  };
  const askAi = async (): Promise<void> => {
    if (!current?.watch) return;

    setDrafting(true);
    setScanNote('正在让 AI 起草建议…');
    try {
      const path = '/api/wechat-kefu/draft';
      const draftRequest = { account, chat: current.username };
      const body = JSON.stringify(draftRequest);
      const request = { method: 'POST', body };

      //M 调原有起草入口，完成后立即刷新建议。
      await call(path, request);
      setOutboxRevision((revision) => revision + 1);
      setScanNote('已在右侧添加一条 AI 建议');
    } catch (error) {
      setScanNote(`起草失败：${(error as Error).message}`);
    } finally {
      setDrafting(false);
    }
  };

  const copySuggestion = async (suggestion: Out): Promise<void> => {
    //G 演示打码时防止从按钮或旧事件处理器复制原文。
    if (privacy.getMask()) return;

    try {
      //M 剪贴板只包含使用者选中的建议原文。
      await navigator.clipboard.writeText(suggestion.text);
      setScanNote('已复制 AI 建议');
    } catch {
      setScanNote('复制失败，请手动选择建议文字');
    }
  };

  const sorted = useMemo(() => {
    //M 按类型和排序条件准备列表，搜索输入变化时直接复用排序结果。
    const list = chats.filter((chat) => matches(chat, filter));
    const comparators: Record<string, (a: Chat, b: Chat) => number> = {
      unread: (a, b) => b.unread - a.unread,
      watched: (a, b) => Number(b.watch) - Number(a.watch),
      name: (a, b) => (a.chat || '').localeCompare(b.chat || '', 'zh-CN'),
    };
    const compare = comparators[sort] ?? ((a: Chat, b: Chat) => b.timestamp - a.timestamp);
    return list.sort(compare);
  }, [chats, filter, sort]);
  const deferredSearch = useDeferredValue(search);
  const shown = useMemo(() => {
    if (deferredSearch === '') return sorted;

    //M 让输入框先响应按键，稍后对排好序的会话过滤一次。
    return sorted.filter((chat) => chat.chat.includes(deferredSearch)
      || chat.username.includes(deferredSearch)
      || chat.last_message.includes(deferredSearch));
  }, [sorted, deferredSearch]);
  const pickAll = async (watch: boolean): Promise<void> => {
    if (search !== deferredSearch) return;

    //M 搜索结果稳定后才批量修改，避免把上一次搜索的会话也改掉。
    for (const chat of shown) {
      if (chat.watch !== watch) await toggle(chat, watch);
    }
  };

  const stats = useMemo(() => {
    //M 顶部卡片和筛选按钮共用一份计数，只在会话数据变化时遍历列表。
    const counts = {
      all: chats.length,
      group: 0, private: 0, official: 0, work: 0, system: 0,
      watch: 0, unread: 0, fresh: 0,
    };
    const watchedByKind = { group: 0, private: 0, official: 0, work: 0, system: 0 };
    for (const chat of chats) {
      const kind = getKind(chat);
      counts[kind] += 1;
      if (chat.watch) {
        counts.watch += 1;
        watchedByKind[kind] += 1;
      }
      if (chat.unread > 0) counts.unread += 1;
      if (chat.timestamp * 1000 > LOADED_AT) counts.fresh += 1;
    }
    return { counts, watchedByKind };
  }, [chats]);

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

      //M 加载失败由气泡组件显示占位，保留 React 对真实节点的管理。
      const query = new URLSearchParams({
        account,
        chat: currentId ?? '',
        source: m.source,
        local_id: String(m.local_id),
      });
      const path = `/api/wechat-kefu/image?${query.toString()}`;
      //M 缩略图与其他客服资源共用访问令牌。
      const src = withToken(path, TOKEN);
      return <div className="wk-bubble wk-media"><MessageImage key={src} src={src} /></div>;
    }
    if (m.kind === 'voice') {
      const chat = current?.username ?? '';
      //G 切换会话时旧列表可能尚未刷新，暂不显示可播放的上一会话语音。
      if (m.account !== account || m.chat !== chat) return <div className="wk-bubble">语音（正在切换会话）</div>;
      const key = JSON.stringify([m.account, m.chat, m.source, m.local_id, mask]);
      return (
        <voice.WechatVoice
          key={key}
          account={m.account}
          chat={m.chat}
          source={m.source}
          localId={m.local_id}
          seconds={view.seconds}
          mask={mask}
        />
      );
    }
    if (view.title !== undefined && !['location', 'card', 'transfer'].includes(m.kind)) {
      let typeLabel = '链接 / 公众号文章';
      if (m.kind === 'file') {
        typeLabel = '文件';
      }

      //M 渲染链接/公众号文章或文件卡片气泡，标题与摘要按演示打码状态脱敏。
      return (
        <div className="wk-bubble wk-card">
          <b>{hide(view.title)}</b>
          {view.desc && <span>{hide(view.desc)}</span>}
          <i>{typeLabel}</i>
        </div>
      );
    }

    //M 普通文本或兜底消息类型：对正文应用打码，空文本时回退展示消息类型标记。
    return <div className="wk-bubble">{hide(m.text) || `[${m.kind}]`}</div>;
  };

  //M 计算顶栏轮询状态灯颜色与文字。
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
  if (current?.watch) {
    aiTitle = '根据这个会话起草一条建议';
  }
  let aiButtonText = '让 AI 起草建议';
  if (drafting) {
    aiButtonText = '正在起草…';
  }

  const changeAccount = (index: number): void => {
    //M 整体换账号时清掉旧账号的会话与消息，等待新账号轮询。
    const next = status?.accounts[index]?.id ?? '';
    setAccount(next);
    setManualScan(null);
    setChats([]);
    setSelection(null);
    setMessages([]);
  };
  const scan = (): void => {
    if (!account) return;

    //M 手动扫描重启本账号的轮询并指示服务端强制读取。
    setManualScan({ account });
  };
  const batchDisabled = shown.length === 0 || search !== deferredSearch;

  //M 显示账号与轮询状态、分类统计卡，以及会话、消息和建议三栏。
  return (
    <div className="wk-page" style={{ paddingTop: pageTop }}>
      <privacy.MaskBanner />
      <header className="wk-top">
        <h1>积木客服</h1>
        <select value={status?.accounts.findIndex((a) => a.id === account) ?? -1}
          onChange={(e) => changeAccount(Number(e.target.value))} title="微信账号">
          {accountOptions}
        </select>
        <div className="wk-poll-wrap" data-guide="poll">
          <button type="button" className={`wk-poll ${level}`} onClick={() => setPollOpen(!pollOpen)}>
            <i />{pollText}
          </button>
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
        <ExternalKefuLink />
        <label className="wk-mask" data-guide="mask">
          <input type="checkbox" checked={mask} onChange={(e) => privacy.setMask(e.target.checked)} />演示打码
        </label>
        <a className="wk-top-link" href={withToken('/', TOKEN)}>聊天</a>
        <button type="button" data-guide="scan" className="wk-btn" disabled={scanning || !account} onClick={scan}>
          {scanLabel}
        </button>
        <Guide steps={WECHAT_STEPS} className="wk-guide" />
      </header>

      <section className="wk-stats" data-guide="stats">
        {
          //M 渲染顶部统计与快捷筛选卡片：总会话、各会话分类计数（调用 getKind 与 toggleFilter）。
        /**/}
        <div className={`wk-stat ${getFilterClass('all')}`} onClick={() => setFilter('all')}>
          <div className="k">会话总数</div>
          <div className="v">{chats.length}</div>
          <div className="s">{stats.counts.unread} 个有未读</div>
        </div>
        {KIND_ORDER.map((kind) => {
          //M 统计当前分类下的会话数量与监听数，生成分类筛选卡片。
          const watchedCount = stats.watchedByKind[kind];
          let watchText = ' ';
          if (watchedCount > 0) {
            watchText = `监听 ${String(watchedCount)}`;
          }

          //M 渲染该会话分类统计卡片，点击切换筛选高亮样式。
          return (
            <div key={kind} className={`wk-stat ${getFilterClass(kind)}`} data-kind={kind}
              onClick={() => toggleFilter(kind)}>
              <div className="k">{KINDS[kind]}</div><div className="v">{stats.counts[kind]}</div>
              <div className="s">{watchText}</div>
            </div>
          );
        })}
        {
          //M 渲染重点监听汇总卡片，点击可快捷筛选 AI 起草覆盖的会话。
        /**/}
        <div className={`wk-stat accent ${getFilterClass('watch')}`} onClick={() => toggleFilter('watch')}>
          <div className="k">重点监听</div>
          <div className="v">{stats.counts.watch}</div>
          <div className="s">只有这些会话可起草 AI 建议</div>
        </div>
      </section>
      {scanNote && <div className="wk-note">{hide(scanNote)}</div>}

      <main className="wk-main">
        <aside className="wk-list" data-guide="list">
          {
            //M 左侧会话栏头部、脱敏搜索框、状态/类型筛选胶囊与批量勾选当前列表工具条。
          /**/}
          <div className="wk-head">最近会话 <span>勾选「监听」后可让 AI 起草建议</span></div>
          <input className="wk-search" placeholder="搜索名称或最后消息" value={hide(search)} readOnly={mask}
            onChange={(e) => setSearch(e.target.value)} />
          {/* 2026-11-14 23:20 EST：照原版积木客服的筛选（SessionList.tsx 的 chips），恢复「只看监听」快速定位。 */}
          <div className="wk-chips">
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" className={`wk-chip ${getFilterClass(key)}`}
                onClick={() => toggleFilter(key)}>
                {label}<b>{stats.counts[key]}</b>
              </button>
            ))}
          </div>
          <div className="wk-tools">
            排序
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="recent">最近消息</option>
              <option value="unread">未读多的在前</option>
              <option value="watched">已监听在前</option>
              <option value="name">按名称</option>
            </select>
            <span className="wk-grow" />
            <button type="button" className="wk-link" disabled={batchDisabled} onClick={() => void pickAll(true)}>
              全部勾选当前列表
            </button>
            <button type="button" className="wk-link" disabled={batchDisabled} onClick={() => void pickAll(false)}>
              取消当前列表
            </button>
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
                const kind = getKind(chat);
                const name = chat.chat || chat.username;
                const displayName = hideName(name);
                const avatar = Array.from(displayName)[0];
                return (
                  <div className={itemClass} onClick={() => selectChat(chat)}>
                    <div className="wk-avatar" data-kind={kind}>{avatar}</div>
                    <div className="wk-item-main">
                      <div className="wk-item-top">
                        <span className="wk-name">{displayName}</span>
                        {kind !== 'private' && <span className="wk-badge">{KINDS[kind]}</span>}
                        {chat.unread > 0 && <span className="wk-unread">{chat.unread}</span>}
                      </div>
                      <div className="wk-last">{hide(chat.last_message)}</div>
                      <div className="wk-switches" onClick={(e) => e.stopPropagation()}>
                        <label>
                          <input type="checkbox" checked={chat.watch}
                            onChange={(e) => void toggle(chat, e.target.checked)} />
                          监听
                        </label>
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
            //M 显示当前会话标题及监听会话的起草入口。
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
                const sender = m.sender || current?.chat || '?';
                const displaySender = hideName(sender);
                const avatar = Array.from(displaySender)[0];

                //M 渲染单条消息行：对方消息附首字头像与昵称，调用 bubble 绘制内容并格式化发送时间。
                return (
                  <div className="wk-msg-row">
                  <div className={rowClass}>
                    {/* 2026-11-14 23:35 EST：像真微信——对方在左（头像 + 昵称），自己在右（绿色气泡）。 */}
                    {m.from_self !== 1 && (
                      <div className="wk-avatar wk-msg-avatar">{avatar}</div>
                    )}
                    <div className="wk-msg-body">
                      {m.sender && m.from_self !== 1 && <div className="wk-sender">{displaySender}</div>}
                      {bubble(m)}
                      <div className="wk-time">{getClock(m.at)}</div>
                    </div>
                  </div>
                  </div>
                );
              }}
            />
          )}
        </section>

        <aside className="wk-out" data-guide="outbox">
          <div className="wk-head">AI 建议 <span>{outbox.length} 条</span></div>
          {outbox.length === 0 && (
            <div className="wk-scroll">
              <div className="wk-empty">暂无 AI 建议</div>
            </div>
          )}
          {outbox.length > 0 && (
            <virtuoso.Virtuoso
              className="wk-scroll"
              data={outbox}
              computeItemKey={(_index, o) => o.id}
              itemContent={(_index, o) => {
                //M 建议卡片提供复制入口，演示打码时禁用。
                return (
                  <div className="wk-outitem">
                    <div className="wk-item-top"><span className="wk-name">{hideName(o.name)}</span></div>
                    <div className="wk-outtext">{hide(o.text)}</div>
                    <div className="wk-time">{getClock(o.at)}</div>
                    <button type="button" className="wk-btn small" disabled={mask}
                      onClick={() => void copySuggestion(o)}>复制</button>
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
