/**
 * 教程页整屏「插件 X 光」（?view=plugins）：系统现在跑着哪些插件、每个插件听哪些事件、一个事件按什么先后流过哪些插件。
 * 数据来自 GET /api/tutorial/plugin-map（131 写的 src7/plugins/tutorial/PluginMap.ts）；后端没升级（404）时显示一句提示，不白屏。
 * 两种看法：按插件看（每个插件一张卡片）、按事件看（每个事件一条横向管道 插件A → 插件B）；点事件胶囊、插件胶囊互相跳转并高亮。
 * TutorialPage.tsx 用 react.lazy 按需加载，不拉高 /tutorial/ 首屏。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { TOKEN, withToken } from '../Token.ts';
import { CopySiteButton } from './PayloadDiff.tsx';
import './PluginMapView.css';


/** 一个插件（字段同后端 PluginMap.ts 的 PluginNode）。 */
export interface PluginNode {
  /** 插件名。 */
  name: string;
  /** 版本号。 */
  version: string;
  /** 依赖的服务。 */
  inject: string[];
  /** 听的事件（除 Cordis 的 internal/* 以外的全部）。 */
  events: string[];
  /** 听的 Cordis 内部事件（internal/*，如 internal/dispatch）。 */
  internalEvents: string[];
  /** 入口文件，如 src7/plugins/bots/index.ts。 */
  entryFile: string;
  /** 说明文件，如 src7/plugins/bots/说明.md。 */
  docFile: string;
  /** 一句话简介。 */
  summary: string;
}

/** GET /api/tutorial/plugin-map 的回包。 */
export interface PluginMapResponse {
  /** 成功。 */
  ok: true;
  /** 什么时候生成的。 */
  generatedAt: string;
  /** 插件总数。 */
  totalPlugins: number;
  /** 全部插件。 */
  plugins: PluginNode[];
  /** 事件名 → 照真实先后排好的监听插件名。 */
  eventIndex: Record<string, string[]>;
  /** 已登记的模型工具名。 */
  toolNames: string[];
}

/** 这一页的数据状态：还在拿、后端没升级、出错、拿到了。 */
type LoadState =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: PluginMapResponse };

/** 两种看法。 */
type Mode = 'plugins' | 'events';

/** 置顶并加标签的核心关口事件：一条消息一定会走过它们。 */
const CORE_EVENTS = [
  'channel/direct',
  'channel/mention',
  'channel/listen',
  'bot/receive',
  'session/before-model',
  'session/after-model',
  'session/before-tool',
  'session/after-tool',
  'channel/reply',
  'channel/replied',
];


/**
 * 拿插件地图。
 * @returns 拿到了是数据；404（后端没升级）是 missing；别的错是 error 和原因。
 */
async function loadPluginMap(): Promise<LoadState> {
  const address = withToken('/api/tutorial/plugin-map', TOKEN);

  //G 网络不通：当出错，给“刷新”重试。
  let response: Response;
  try {
    response = await fetch(address);
  } catch (error) {
    return { phase: 'error', message: String(error) };
  }

  //G 后端还没有这个接口：温和提示，不白屏。
  if (response.status === 404) return { phase: 'missing' };

  //G 外网或手机没令牌：和别的页面一样广播，AuthGate 弹出登录。
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent('jmbots:unauthorized'));
  }

  if (!response.ok) return { phase: 'error', message: `请求失败（${String(response.status)}）` };

  //M 回包要是 { ok: true, plugins: [...] }，别的样子都当后端没升级。
  const body = await response.json().catch(() => undefined) as Partial<PluginMapResponse> | undefined;
  if (body?.ok !== true || !Array.isArray(body.plugins)) return { phase: 'missing' };

  const data: PluginMapResponse = {
    ok: true,
    generatedAt: body.generatedAt ?? '',
    totalPlugins: body.totalPlugins ?? body.plugins.length,
    plugins: body.plugins,
    eventIndex: body.eventIndex ?? {},
    toolNames: body.toolNames ?? [],
  };
  return { phase: 'ready', data };
}


/**
 * 一个插件合不合搜索词：名字、简介、听的事件、依赖，有一样包含就算。
 * @param plugin 插件。
 * @param query 小写的搜索词；空的都算合。
 */
function isPluginMatch(plugin: PluginNode, query: string): boolean {
  if (query === '') return true;

  const fields = [plugin.name, plugin.summary, ...plugin.events, ...plugin.internalEvents, ...plugin.inject];
  return fields.some((field) => field.toLowerCase().includes(query));
}


/**
 * 事件排序：核心关口事件按 CORE_EVENTS 的先后排在最前，其余按名字。
 * @param names 事件名。
 */
function getSortedEvents(names: string[]): string[] {
  const core = CORE_EVENTS.filter((name) => names.includes(name));
  const rest = names.filter((name) => !CORE_EVENTS.includes(name)).sort((a, b) => a.localeCompare(b));
  return [...core, ...rest];
}


/**
 * 滚到并高亮某个元素：等这一帧画完再找（刚切换看法时元素还没挂上）。
 * @param selector CSS 选择器。
 */
function scrollToSelector(selector: string): void {
  window.requestAnimationFrame(() => {
    const element = document.querySelector(selector);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}


/**
 * 一个插件卡片。
 * @param props 插件、是否高亮、点事件胶囊的跳转。
 */
function PluginCard(props: { plugin: PluginNode; focused: boolean; openEvent: (event: string) => void }) {
  const plugin = props.plugin;
  const site = `${plugin.entryFile}:1`;
  return (
    <article className="tu-pm-card" data-plugin-name={plugin.name} data-focused={props.focused}>
      <header className="tu-pm-card-head">
        <strong>{plugin.name}</strong>
        {plugin.version !== '' && <span className="tu-pm-version">v{plugin.version}</span>}
      </header>
      {plugin.summary !== '' && <p className="tu-pm-summary">{plugin.summary}</p>}
      {plugin.inject.length > 0 && (
        <div className="tu-pm-row">
          <span className="tu-pm-label">依赖</span>
          {plugin.inject.map((name) => <span key={name} className="tu-pm-chip" data-kind="inject">{name}</span>)}
        </div>
      )}
      {plugin.events.length > 0 && (
        <div className="tu-pm-row">
          <span className="tu-pm-label">听</span>
          {plugin.events.map((event) => (
            <button
              key={event}
              type="button"
              className="tu-pm-chip"
              data-kind="event"
              data-core={CORE_EVENTS.includes(event)}
              title="点开看这个事件流过哪些插件"
              onClick={() => props.openEvent(event)}
            >
              {event}
            </button>
          ))}
        </div>
      )}
      {plugin.internalEvents.length > 0 && (
        <details className="tu-pm-internal">
          <summary>Cordis 内部事件 {plugin.internalEvents.length}</summary>
          <div className="tu-pm-row">
            {plugin.internalEvents.map((event) => (
              <span key={event} className="tu-pm-chip" data-kind="internal">{event}</span>
            ))}
          </div>
        </details>
      )}
      {plugin.entryFile !== '' && (
        <footer className="tu-pm-card-foot">
          <code className="tu-pm-path" title={plugin.entryFile}>{plugin.entryFile}</code>
          <CopySiteButton site={site} />
        </footer>
      )}
    </article>
  );
}


/**
 * 一个事件的横向管道：插件A → 插件B → …（照后端给的真实监听先后）。
 * @param props 事件名、监听插件、是否高亮、点插件胶囊的跳转。
 */
function EventPipe(props: {
  event: string;
  listeners: string[];
  focused: boolean;
  openPlugin: (name: string) => void;
}) {
  const isCore = CORE_EVENTS.includes(props.event);
  return (
    <div className="tu-pm-pipe" data-event-name={props.event} data-focused={props.focused} data-core={isCore}>
      <div className="tu-pm-pipe-head">
        <code>{props.event}</code>
        {isCore && <span className="tu-pm-core">核心关口</span>}
        <span className="tu-pm-count">{props.listeners.length} 个插件</span>
      </div>
      <div className="tu-pm-pipe-flow">
        {props.listeners.map((name, index) => (
          <span key={`${name}-${String(index)}`} className="tu-pm-step">
            {index > 0 && <span className="tu-pm-arrow" aria-hidden="true">→</span>}
            <button type="button" className="tu-pm-chip" data-kind="plugin" onClick={() => props.openPlugin(name)}>
              {name}
            </button>
          </span>
        ))}
        {props.listeners.length === 0 && <span className="tu-pm-muted">现在没有插件听它</span>}
      </div>
    </div>
  );
}


/**
 * 整屏「插件 X 光」。
 * @param props onClose：关掉整屏（TutorialPage 的 togglePlugins(false)，同步去掉 ?view=plugins）。
 */
export function PluginMapView(props: { onClose: () => void }): JSX.Element {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [mode, setMode] = useState<Mode>('plugins');
  const [query, setQuery] = useState('');
  const [focusEvent, setFocusEvent] = useState('');
  const [focusPlugin, setFocusPlugin] = useState('');

  //M 拿数据；「刷新」按钮也调它。连点时只认最后一次，先发的晚到不覆盖。
  const seqRef = useRef(0);
  const reload = useCallback(() => {
    seqRef.current += 1;
    const seq = seqRef.current;
    setState({ phase: 'loading' });
    void loadPluginMap().then((next) => {
      if (seq !== seqRef.current) return;

      setState(next);
    });
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  const lower = query.trim().toLowerCase();
  //M 拿到了才有数据，别的阶段都是 undefined。
  let data: PluginMapResponse | undefined;
  if (state.phase === 'ready') {
    data = state.data;
  }

  //M 按搜索词筛插件、事件、工具。
  const plugins = useMemo(() => {
    if (data === undefined) return [];

    return data.plugins.filter((plugin) => isPluginMatch(plugin, lower));
  }, [data, lower]);
  const events = useMemo(() => {
    if (data === undefined) return [];

    const names = Object.keys(data.eventIndex).filter((name) => {
      if (lower === '') return true;

      const listeners = data.eventIndex[name] ?? [];
      return name.toLowerCase().includes(lower) || listeners.some((one) => one.toLowerCase().includes(lower));
    });
    return getSortedEvents(names);
  }, [data, lower]);
  const tools = useMemo(() => {
    if (data === undefined) return [];

    return data.toolNames.filter((name) => lower === '' || name.toLowerCase().includes(lower));
  }, [data, lower]);

  //M 点事件胶囊：切到按事件看、高亮并滚到那一条。
  const openEvent = (event: string): void => {
    //G 搜索词会把这个事件筛掉：先清空搜索框，不然切过去滚不到（0.7.90 审计）。
    if (!events.includes(event)) {
      setQuery('');
    }
    setMode('events');
    setFocusEvent(event);
    scrollToSelector(`[data-event-name="${CSS.escape(event)}"]`);
  };

  //M 点插件胶囊：切回按插件看、高亮并滚到那张卡片。
  const openPlugin = (name: string): void => {
    //G 同上：搜索词把这个插件筛掉了就先清空。
    if (!plugins.some((plugin) => plugin.name === name)) {
      setQuery('');
    }
    setMode('plugins');
    setFocusPlugin(name);
    scrollToSelector(`[data-plugin-name="${CSS.escape(name)}"]`);
  };

  return (
    <div className="tu-pm" data-tutorial-plugins>
      <header className="tu-pm-top">
        <span className="tu-pm-brand">插件 X 光</span>
        {data !== undefined && (
          <span className="tu-pm-stats">
            插件 {data.totalPlugins} · 事件 {Object.keys(data.eventIndex).length} · 工具 {data.toolNames.length}
          </span>
        )}
        <span className="tu-pm-grow" />
        <button type="button" className="tu-pm-btn" onClick={reload}>刷新</button>
        <button type="button" className="tu-pm-btn" onClick={props.onClose}>关闭 ×</button>
      </header>
      <div className="tu-pm-bar">
        <input
          className="tu-pm-search"
          data-plugin-search
          value={query}
          placeholder="搜插件名、简介、事件名、依赖"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="tu-pm-modes" role="group" aria-label="看法">
          <button
            type="button"
            data-plugin-view="plugins"
            aria-pressed={mode === 'plugins'}
            onClick={() => setMode('plugins')}
          >
            按插件看
          </button>
          <button
            type="button"
            data-plugin-view="events"
            aria-pressed={mode === 'events'}
            onClick={() => setMode('events')}
          >
            按事件看
          </button>
        </div>
      </div>
      <main className="tu-pm-body">
        {state.phase === 'loading' && <p className="tu-pm-muted">正在读插件地图…</p>}
        {state.phase === 'missing' && (
          <p className="tu-pm-notice">当前服务端尚未升级至支持插件 X 光的版本（v0.7.90+ 可用）。</p>
        )}
        {state.phase === 'error' && <p className="tu-pm-notice">读不到插件地图：{state.message}。点「刷新」再试。</p>}
        {data !== undefined && mode === 'plugins' && (
          <div className="tu-pm-grid">
            {plugins.map((plugin) => (
              <PluginCard
                key={plugin.name}
                plugin={plugin}
                focused={focusPlugin === plugin.name}
                openEvent={openEvent}
              />
            ))}
            {plugins.length === 0 && <p className="tu-pm-muted">没有合搜索词的插件</p>}
          </div>
        )}
        {data !== undefined && mode === 'events' && (
          <div className="tu-pm-pipes">
            {events.map((event) => (
              <EventPipe
                key={event}
                event={event}
                listeners={data.eventIndex[event] ?? []}
                focused={focusEvent === event}
                openPlugin={openPlugin}
              />
            ))}
            {events.length === 0 && <p className="tu-pm-muted">没有合搜索词的事件</p>}
          </div>
        )}
        {data !== undefined && (
          <details className="tu-pm-tools">
            <summary>已登记的模型工具 {tools.length}</summary>
            <div className="tu-pm-row">
              {tools.map((name) => <span key={name} className="tu-pm-chip" data-kind="tool">{name}</span>)}
            </div>
          </details>
        )}
      </main>
    </div>
  );
}
