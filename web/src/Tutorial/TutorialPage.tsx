/**
 * 教程页（/tutorial/，tutorial 插件；/flow/ 跳过来）：
 *   1. 最底层是铺满视口的泳道图画布，按住空白拖动平移、滚轮按鼠标位置缩放、附「适应窗口」「100%」和角落操作提示，
 *      选中某一步时自动把被左右栏遮住的步平移回中间可见区；
 *   2. 有画布的页面三栏：左栏 | 画布 | 右侧详情。左栏拖宽 220~45% 视口；右侧默认占去掉左栏后剩余宽度的一半，
 *      拖动改窄、最大也是一半，拖过的宽度记在 localStorage（包 try/catch）。两栏都能收起成边缘窄条；< 800px 窄屏退化为上下排布；
 *      没有画布的页面（左栏点开的插件说明、进程插件、组块阅读、Cordis 用法文档、骨架工具）两栏：左栏 | 内容，地址带 page=doc；
 *   3. 左栏顺序：骨架（第一行是项目结构，点模块进骨架逐行）→ 骨架工具（utils）→ Cordis 用法（第一行动态图进骨架逐行，其余两栏读文档）→ 启动流程 → 最近消息（点了看这条消息走过的路）
 *      → 组块阅读 → 插件 → 进程插件；原来画布顶上的树切换挪进左栏，左右/上下展开是画布右上角的小切换。
 *      右栏顶设「这一步」「插件」「组块阅读」页签，右栏独立滚动，画布停在原地不动；骨架逐行的块详情也显示在「这一步」；
 *   4. 所有“文件:行号”与依赖表位置列均通过 TutorialWorkspaceContext 直接复用 Code.tsx 的 getVscodeHref 在 VS Code 打开；
 *   5. 浏览器前进/后退/刷新通过 history.pushState + popstate 保持原地（canvas / step / plugin / ptab / event / rtab / util / page）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import * as antd from 'antd';
import zhCN from 'antd/locale/zh_CN';
import * as virtuoso from 'react-virtuoso';
import * as i18n from '../I18n.ts';
import * as theme from '../Theme.ts';
import { TOKEN, withToken } from '../Token.ts';
import { JsonBlock, TutorialScrollContext, TutorialWorkspaceContext, VIRTUAL_THRESHOLD } from './Code.tsx';
import { SeqChart, RouteStopItem, FEISHU_ROUTE, getSeqLayout } from './SeqChart.tsx';
import { LaneChart, StepDetail, getCanvasLayout, type CanvasLayout } from './LaneChart.tsx';
import { CodeTab, TryTab } from './PluginTabs.tsx';
import { buildReadmeTabItems, MarkdownContent } from './ReadmeTabs.tsx';
import * as mind from './MindMap.tsx';
import * as programView from './ProgramView.tsx';
import type * as mindData from './MindData.ts';
import { TutorialApi, type Canvas, type CanvasList, type MessageCanvasItem, type PluginItem, type PluginList, type ProgramItem, type StateGroup, type Trail } from './TutorialApi.ts';


/** 地址栏里记住的当前位置。 */
interface RouteState {
  /** 画布：'' 无画布，'__AUTO__' 首次自动选最新消息或 boot，'boot' 启动，或数字消息号。 */
  canvas: string;
  /** 泳道图选中的第几步；0 是没选。 */
  step: number;
  /** 右栏「插件」页签选中的插件名；'' 未选，'__FIRST__' 旧 ?tab=plugins 默认取第一个插件。 */
  plugin: string;
  /** 插件分栏内部选中的标签 key（overview / events / ... / state / code / try）。 */
  ptab: string;
  /** 当前画布高亮的事件名；'' 不高亮。 */
  event: string;
  /** 右栏选中的组块文件名，空串表示未选。 */
  reading: string;
  /** 右侧悬浮栏的页签：步骤详情、插件说明、组块阅读或骨架工具说明。 */
  rtab: 'step' | 'plugin' | 'reading' | 'util';
  /** 左栏选中的骨架工具文件名（如 Checks.ts），空串表示未选。 */
  util: string;
  /** 没有画布的页面（左栏点开的插件说明、进程插件）：两栏，内容占满左栏右边。 */
  doc: boolean;
}

/** 左栏各组折叠状态（骨架、骨架工具、启动流程、最近消息、组块阅读、插件、进程插件）。 */
interface GroupOpenState {
  skeleton: boolean;
  utils: boolean;
  cordis: boolean;
  programs: boolean;
  reading: boolean;
  plugins: boolean;
  boot: boolean;
  messages: boolean;
  route: boolean;
}

/** 左栏单一虚拟列表的行结构：分组标题、分割细线、骨架/插件条目、启动流程、消息条目或空提示。 */
type LeftNavRow =
  | { key: string; kind: 'group-head'; groupKey: keyof GroupOpenState; title: string; count: number; expanded: boolean }
  | { key: string; kind: 'divider' }
  | { key: string; kind: 'plugin'; plugin: PluginItem }
  | { key: string; kind: 'reading'; name: string }
  | { key: string; kind: 'util'; name: string }
  | { key: string; kind: 'project' }
  | { key: string; kind: 'program'; program: ProgramItem }
  | { key: string; kind: 'handshake' }
  | { key: string; kind: 'cordis-map' }
  | { key: string; kind: 'boot' }
  | { key: string; kind: 'message'; message: MessageCanvasItem }
  | { key: string; kind: 'route'; index: number }
  | { key: string; kind: 'empty'; text: string };


/** 左栏虚拟列表顶部留白（防止首行紧贴搜索栏边框）。 */
function LeftListHeader(): JSX.Element {
  return <div className="tu-side-pad-top" />;
}


/** 左栏虚拟列表底部留白（滚到最底保留呼吸感）。 */
function LeftListFooter(): JSX.Element {
  return <div className="tu-side-pad-bottom" />;
}


/** 左栏虚拟列表组件映射（模块级常量，避免每次渲染重建组件引用）。 */
const LEFT_LIST_COMPONENTS = {
  Header: LeftListHeader,
  Footer: LeftListFooter,
};

/** 底层画布平移缩放状态（桌面模式用 CSS transform）。 */
interface CanvasTransform {
  tx: number;
  ty: number;
  scale: number;
}

/** 画布中间未被左右浮栏遮挡的安全可视区域，单位像素。 */
interface SafeViewport {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}


/** 默认和极值常量。 */
const STATE_MS = 3000;
/** 三栏时右侧详情拖过的宽度；没拖过不存，默认取去掉左栏后剩余宽度的一半。 */
const DETAIL_WIDTH_KEY = 'jm.tutorial.detailWidth';
const LEFT_WIDTH_KEY = 'jm.tutorial.leftWidth';
const LEFT_COLLAPSED_KEY = 'jm.tutorial.leftCollapsed';
const RIGHT_COLLAPSED_KEY = 'jm.tutorial.rightCollapsed';
/** 右侧详情最多占去掉左栏后剩余宽度的这一比例。 */
const DETAIL_RATIO = 0.5;
const DEFAULT_LEFT_WIDTH = 264;
const MIN_LEFT_WIDTH = 220;
const MIN_PANE_WIDTH = 300;
const MAX_SIDE_RATIO = 0.45;
const NARROW_BREAKPOINT = 800;
const MIN_SCALE = 0.2;
const MAX_SCALE = 2.5;
const SENTINEL_AUTO = '__AUTO__';
const SENTINEL_FIRST = '__FIRST__';

/** 插件状态 → 一句话说明。 */
const STATE_WORDS: Record<string, string> = {
  ok: '挂上了',
  failed: '没挂上',
  waiting: '挂了但缺服务，没开工',
  idle: '配置里没挂',
};

/** 渠道英文代号 → 左栏显示中文短标签。 */
const CHANNEL_LABELS: Record<string, string> = {
  feishu: '飞书',
  http: '网页',
  wechat: '微信',
  cli: '命令行',
};


/**
 * 把数值夹在 [min, max] 之间。
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}


/**
 * 计算左栏允许的最大宽度（视口宽度的 45%，保底不小于最小宽）；右侧详情另按剩余宽度算。
 * @param minWidth 对应栏位的最小宽度。
 */
function getMaxSideWidth(minWidth: number): number {
  const byRatio = Math.floor(window.innerWidth * MAX_SIDE_RATIO);
  return Math.max(minWidth, byRatio);
}


/**
 * 安全读取 localStorage 整数并夹在合法区间内（隐私模式或禁用存储时不抛错）。
 * @param key 存储键。
 * @param fallback 默认值。
 * @param min 允许最小宽。
 */
function getStoredWidth(key: string, fallback: number, min: number): number {
  //M 按当前视口比例计算允许最大宽度，防止本地记忆宽度把中间画布挤没。
  const max = getMaxSideWidth(min);
  try {
    const raw = window.localStorage.getItem(key) ?? '';
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed) && parsed >= min) {
      return Math.min(parsed, max);
    }
  } catch {
    return Math.min(fallback, max);
  }
  return Math.min(fallback, max);
}


/**
 * 右侧详情最大宽：去掉左栏后剩余宽度的一半，保底不小于最小宽。
 * @param viewport 当前视口宽。
 * @param leftSpace 左栏连同间距占掉的宽度，收起或窄屏时是 0。
 */
function getMaxDetailWidth(viewport: number, leftSpace: number): number {
  const byRatio = Math.floor((viewport - leftSpace - 24) * DETAIL_RATIO);
  return Math.max(MIN_PANE_WIDTH, byRatio);
}


/**
 * 读拖过的右侧详情宽度（包 try/catch）；没拖过或读不到是 0，表示用默认的一半。
 */
function getStoredDetailWidth(): number {
  try {
    const raw = window.localStorage.getItem(DETAIL_WIDTH_KEY) ?? '';
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed) && parsed >= MIN_PANE_WIDTH) return parsed;
  } catch {
    return 0;
  }
  return 0;
}


/**
 * 安全读取 localStorage 布尔开关（包 try/catch）。
 * @param key 存储键。
 * @param fallback 默认值。
 */
function getStoredCollapsed(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    return fallback;
  }
  return fallback;
}


/**
 * 安全写入 localStorage（包 try/catch）。
 * @param key 存储键。
 * @param value 字符串值。
 */
function saveStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    //G 无痕或存储满时忽略，不影响页面交互。
  }
}


/**
 * 算出当前画布中间未被左右浮栏遮挡的安全区域边界。
 * @param stageW 画布舞台宽。
 * @param stageH 画布舞台高。
 * @param leftOpen 左栏是否展开。
 * @param leftW 左栏当前宽。
 * @param rightOpen 右栏是否展开。
 * @param rightW 右栏当前宽。
 */
function getSafeViewport(
  stageW: number,
  stageH: number,
  leftOpen: boolean,
  leftW: number,
  rightOpen: boolean,
  rightW: number,
): SafeViewport {
  let left = 92;
  if (leftOpen) {
    left = leftW + 24;
  }
  let right = stageW - 92;
  if (rightOpen) {
    right = stageW - rightW - 24;
  }
  const safeRight = Math.max(left + 180, right);
  const top = 56;
  const bottom = Math.max(top + 120, stageH - 54);
  return {
    left,
    top,
    right: safeRight,
    bottom,
    width: Math.max(180, safeRight - left),
    height: Math.max(120, bottom - top),
  };
}


/**
 * 算出让整张泳道图自适应放进中间安全可视区的平移与缩放。
 * @param layout 泳道图总尺寸。
 * @param safe 中间不被遮挡的矩形区域。
 */
function getFitTransform(layout: CanvasLayout, safe: SafeViewport): CanvasTransform {
  const pad = 16;
  const availW = Math.max(120, safe.width - pad * 2);
  const availH = Math.max(100, safe.height - pad * 2);
  const scaleX = availW / Math.max(1, layout.width);
  const scaleY = availH / Math.max(1, layout.total);
  //M 用宽高里能容纳全图的一项，并允许小图在正常缩放范围内放大。
  const fitted = Math.min(scaleX, scaleY);
  const scale = clamp(fitted, MIN_SCALE, MAX_SCALE);
  const drawnW = layout.width * scale;
  const drawnH = layout.total * scale;
  const tx = Math.round(safe.left + Math.max(pad, (safe.width - drawnW) / 2));
  const ty = Math.round(safe.top + Math.max(8, (safe.height - drawnH) / 2));
  return { tx, ty, scale };
}


/**
 * 渠道代号转短中文徽标文本（未知代号原样显示）。
 * @param channel 渠道英文代号。
 */
function getChannelLabel(channel?: string): string {
  if (channel === undefined || channel === '') return '';

  return CHANNEL_LABELS[channel] ?? channel;
}


/**
 * 从地址栏解析路由状态，同时兼容旧的 ?plugin=、?canvas=、?message=、?boot=1、?tab= 链接。
 * @param search location.search。
 */
function getRouteFromUrl(search: string): RouteState {
  const params = new URLSearchParams(search);
  //M 从查询串解析当前选中的步骤编号，非法值回落到 0（未选中）。
  const rawStep = Number.parseInt(params.get('step') ?? '', 10);
  let step = 0;
  if (Number.isSafeInteger(rawStep) && rawStep > 0) {
    step = rawStep;
  }

  //M 提取插件子页签、事件高亮、插件名、画布标识与书签兼容参数 ?tab= / ?rtab=。
  const ptab = params.get('ptab') ?? 'overview';
  const event = params.get('event') ?? '';
  const plugin = params.get('plugin') ?? '';
  const rawCanvas = params.get('canvas') ?? params.get('message') ?? '';
  const tab = params.get('tab') ?? '';
  const rawRtab = params.get('rtab') ?? '';
  const reading = params.get('reading') ?? '';
  const util = params.get('util') ?? '';
  //M page=doc 是左栏点开的没有画布的页面，刷新后仍是两栏。
  const doc = params.get('page') === 'doc';

  //M 右栏页签优先认 URL 里的 rtab；没给时：无画布/只带 plugin 落到「插件」，其余默认看「这一步」。
  let rtab: RouteState['rtab'] = 'step';
  if (rawRtab === 'plugin') {
    rtab = 'plugin';
  }
  if (rawRtab !== 'step' && rawRtab !== 'plugin' && step === 0 && (plugin !== '' || tab === 'plugins')) {
    rtab = 'plugin';
  }

  //M 直接打开组块链接时显示文档，显式点过的其他右栏页签随地址保留。
  if (rawRtab === 'reading' || (rawRtab === '' && reading !== '')) {
    rtab = 'reading';
  }
  if (rawRtab === 'util' || (rawRtab === '' && util !== '')) {
    rtab = 'util';
  }

  //M 显式给了画布参数：canvas=boot / 数字消息号 / boot=1 / 旧 tab=boot。
  let canvas = '';
  if (rawCanvas === 'boot' || params.get('boot') === '1' || tab === 'boot') {
    canvas = 'boot';
  }
  if (/^\d+$/u.test(rawCanvas)) {
    canvas = rawCanvas;
  }

  //M Cordis 动态图不是插件说明，直达地址、刷新和前进后退都还原三栏画布。
  if (plugin === 'cordis') {
    return { canvas: canvas || SENTINEL_AUTO, step: 0, plugin, ptab, event, reading, rtab: 'step', util, doc: false };
  }

  //M 旧只看插件的链接（?plugin=xxx 且没有画布参数，或 ?tab=plugins）：保持无画布直达插件。
  if (canvas === '' && (plugin !== '' || tab === 'plugins')) {
    let targetPlugin = plugin;
    if (targetPlugin === '') {
      targetPlugin = SENTINEL_FIRST;
    }
    if (rtab !== 'reading' && rtab !== 'util') {
      rtab = 'plugin';
    }
    //M 只看插件的旧链接没有画布，按两栏打开。
    return { canvas: '', step: 0, plugin: targetPlugin, ptab, event, reading, rtab, util, doc: true };
  }

  //M 裸 /tutorial/ 或旧 ?tab=session 但未指定消息号：待消息列表到达后自动落最新一条（无消息落 boot）。
  if (canvas === '') {
    canvas = SENTINEL_AUTO;
  }
  return { canvas, step, plugin, ptab, event, reading, rtab, util, doc };
}


/**
 * 把当前 RouteState 序列化成完整 URL（保留与本页无关的 token 等参数）。
 * @param route 当前状态。
 */
function buildRouteUrl(route: RouteState): string {
  const url = new URL(window.location.href);
  const routeKeys = [
    'tab', 'plugin', 'canvas', 'step', 'message', 'session', 'boot', 'ptab', 'event', 'full', 'reading', 'rtab',
    'util', 'page',
  ];
  for (const key of routeKeys) {
    url.searchParams.delete(key);
  }
  if (route.canvas !== '' && route.canvas !== SENTINEL_AUTO) {
    url.searchParams.set('canvas', route.canvas);
    if (route.step > 0) {
      url.searchParams.set('step', String(route.step));
    }
  }
  if (route.plugin !== '' && route.plugin !== SENTINEL_FIRST) {
    url.searchParams.set('plugin', route.plugin);
    if (route.ptab !== '' && route.ptab !== 'overview') {
      url.searchParams.set('ptab', route.ptab);
    }
  }
  if (route.event !== '') {
    url.searchParams.set('event', route.event);
  }
  if (route.reading !== '') {
    url.searchParams.set('reading', route.reading);
  }
  if (route.util !== '') {
    url.searchParams.set('util', route.util);
  }
  if (route.rtab !== 'step' || route.reading !== '') {
    url.searchParams.set('rtab', route.rtab);
  }
  if (route.doc) {
    url.searchParams.set('page', 'doc');
  }
  return url.toString();
}


/**
 * 算出某个事件在当前轨迹里出现的全部步骤号（去重升序）。
 * @param trail 当前画布轨迹。
 * @param eventName 事件名。
 */
function getMatchedSteps(trail: Trail | null, eventName: string): number[] {
  if (trail === null || eventName === '') return [];

  const matched: number[] = [];
  for (const step of trail.steps) {
    if (step.rows.some((row) => row.name === eventName)) {
      matched.push(step.no);
    }
  }
  return matched;
}


/**
 * 毫秒时间戳 → 月-日 时:分。
 * @param at 毫秒时间戳。
 */
function getClock(at: number): string {
  if (at <= 0) return '';

  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}


/**
 * 消息在左栏显示的名字：“#消息号 用户那句话”。
 * @param item 消息项。
 */
function getMessageTitle(item: MessageCanvasItem): string {
  if (item.preview === '') return `#${item.name}`;

  return `#${item.name} ${item.preview}`;
}


/**
 * 读某个插件的 说明.md 原文。
 * @param name 插件名。
 */
function usePluginReadme(name: string): { text: string | null; error: string } {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setText(null);
    setError('');
    //M 按插件名即时抓取 说明.md 原文用于右栏分栏渲染。
    const loading = TutorialApi.get<{ text: string }>(`/api/tutorial/readme?name=${encodeURIComponent(name)}`);
    loading.then((result) => setText(result.text), (failed: unknown) => setError((failed as Error).message));
  }, [name]);

  return { text, error };
}


/** 读取并展示一篇组块或骨架工具说明，切换时由文件名重建组件。 */
function ReadingView(props: {
  name: string; loadingLabel: string; errorLabel: string; util?: boolean; onHashLink?: (href: string) => void;
}): JSX.Element {
  const { name } = props;
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    //M 右栏只读所选文档，跳走后忽略未完成的请求。
    let load = TutorialApi.getReading;
    if (props.util) load = TutorialApi.getUtilReadme;
    let file = name;
    if (name.startsWith('cordis/')) {
      load = TutorialApi.getCordisReading;
      file = name.slice('cordis/'.length);
    }
    //M 文档名已选好，按所属目录读取。
    const loading = load(file);
    void loading.then((result) => {
      if (!active) return;

      setText(result.text);
    }, () => {
      if (!active) return;

      setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [name, props.util]);

  if (failed) return <p className="tu-error" role="alert">{props.errorLabel}</p>;

  if (text === null) return <antd.Spin aria-label={props.loadingLabel} />;

  //G 只有 Cordis 用法接管站内链接；组块阅读保持原来的链接行为。
  let onHashLink: ((href: string) => void) | undefined;
  if (name.startsWith('cordis/')) onHashLink = props.onHashLink;

  //M 复用插件说明页签的 Markdown、代码和表格渲染。
  return <article className="tu-doc"><MarkdownContent body={text} onHashLink={onHashLink} /></article>;
}


/**
 * 一组运行时状态的折叠块，PluginState 在常规和虚拟滚动模式下共用。
 * @param props.group 状态组。
 */
function PluginStateGroup(props: { group: StateGroup }): JSX.Element {
  const { group } = props;
  return (
    <details className="tu-state-group" open>
      <summary>{group.name}</summary>
      <JsonBlock head={<span className="tu-muted">{group.note}</span>} value={group.value} empty="（空）" notes={group.notes} />
    </details>
  );
}


/**
 * 插件的「状态」：它提供的服务对象、它用 ctx.flow.state 登记的，全量原样；每 STATE_MS 刷新一次，能暂停；组数 >= 30 时开启虚拟滚动。
 * @param props.name 插件名。
 */
function PluginState(props: { name: string }): JSX.Element {
  const [groups, setGroups] = useState<StateGroup[] | null>(null);
  const [at, setAt] = useState(0);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);

  //M 换了插件：清掉上一个的。
  useEffect(() => {
    setGroups(null);
    setAt(0);
  }, [props.name]);

  //M 没暂停就定时读。
  useEffect(() => {
    if (paused) return undefined;

    let alive = true;
    const load = (): void => {
      //M 现拉该插件服务对象及登记状态变量快照，实现状态面板实时刷新。
      const loading = TutorialApi.get<{ at: number; groups: StateGroup[] }>(`/api/tutorial/state?name=${encodeURIComponent(props.name)}`);
      loading.then((result) => {
        if (!alive) return;

        setGroups(result.groups);
        setAt(result.at);
        setError('');
      }, (failed: unknown) => {
        if (alive) {
          setError((failed as Error).message);
        }
      });
    };
    //M 组件挂载后立即首刷一次状态，再由定时器按固定频率周期轮询。
    load();
    const timer = window.setInterval(load, STATE_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [paused, props.name]);

  //M 顶上一行：什么时候读的、刷新还是暂停。
  let said = '正在读…';
  if (at > 0) {
    said = `${new Date(at).toLocaleTimeString()} 读的`;
  }
  let refresh = `每 ${String(STATE_MS / 1000)} 秒刷新`;
  if (paused) {
    refresh = '已暂停';
  }
  let button = '暂停';
  if (paused) {
    button = '继续刷新';
  }

  return (
    <TutorialScrollContext.Consumer>
      {(ctxScrollParent) => {
        if (ctxScrollParent !== scrollParent) {
          queueMicrotask(() => setScrollParent(ctxScrollParent));
        }
        const list = groups ?? [];
        const useVirtual = list.length >= VIRTUAL_THRESHOLD && ctxScrollParent !== null;
        return (
          <div className="tu-state">
            <div className="tu-head-row">
              <span className="tu-muted">{said} · {refresh}</span>
              <button type="button" className="tu-link" onClick={() => setPaused(!paused)}>{button}</button>
            </div>
            {error !== '' && <p className="tu-error">读不到：{error}</p>}
            {groups !== null && groups.length === 0 && (
              <antd.Empty description="这个插件没有提供服务，也没登记运行时变量（用 ctx.flow.state 登记）" />
            )}
            {useVirtual && (
              <virtuoso.Virtuoso
                customScrollParent={ctxScrollParent}
                data={list}
                computeItemKey={(_index, group) => group.name}
                itemContent={(_index, group) => <PluginStateGroup group={group} />}
              />
            )}
            {!useVirtual && list.map((group) => (
              <PluginStateGroup key={group.name} group={group} />
            ))}
          </div>
        );
      }}
    </TutorialScrollContext.Consumer>
  );
}


/**
 * 插件详情面板：拆标签说明 + 状态 + 代码 + 试一试；支持可控当前标签、就地展开源码和点击事件高亮画布。
 * @param props.plugin 当前插件。
 * @param props.pluginNames 所有已知插件名。
 * @param props.activeTab 当前选中的插件内子标签 key。
 * @param props.onTabChange 切换子标签（同步地址栏）。
 * @param props.activeEvent 当前画布高亮的事件名。
 * @param props.onSelectEvent 点击事件名高亮画布对应步骤。
 * @param props.onSelectPlugin 点击依赖跳转到另一个插件。
 */
function PluginView(props: {
  plugin: PluginItem;
  pluginNames: Set<string>;
  activeTab: string;
  onTabChange: (key: string) => void;
  activeEvent: string;
  onSelectEvent: (eventName: string) => void;
  onSelectPlugin: (name: string) => void;
}): JSX.Element {
  const { plugin } = props;
  //M 读取选中插件的 说明.md Markdown 文本准备拆分多页签展示。
  const readme = usePluginReadme(plugin.name);
  let version = '还没写版本号';
  if (plugin.version !== '') {
    version = `v${plugin.version}`;
  }
  let inject = '不用别的服务';
  if (plugin.inject.length > 0) {
    inject = `要用：${plugin.inject.join('、')}`;
  }

  //M 说明按 ## 拆成多个标签，再接原来的 状态 / 代码 / 试一试。
  const readmeTabs = buildReadmeTabItems({
    plugin,
    text: readme.text,
    error: readme.error,
    pluginNames: props.pluginNames,
    onSelectPlugin: props.onSelectPlugin,
    activeEvent: props.activeEvent,
    onSelectEvent: props.onSelectEvent,
  });
  const tabs: NonNullable<antd.TabsProps['items']> = [
    ...readmeTabs,
    { key: 'state', label: '状态', children: <PluginState name={plugin.name} /> },
    { key: 'code', label: '代码', children: <CodeTab name={plugin.name} /> },
    { key: 'try', label: '试一试', children: <TryTab name={plugin.name} /> },
  ];

  //M 当 URL 里的子标签在这个插件被禁用或不存在时，安全回退到「概要」。
  let resolvedTab = props.activeTab;
  const matched = tabs.find((item) => item.key === resolvedTab && item.disabled !== true);
  if (matched === undefined) {
    resolvedTab = 'overview';
  }

  let stateText = STATE_WORDS[plugin.state] ?? plugin.state;
  if (plugin.kind === 'skeleton') {
    stateText = '骨架常驻';
  }

  return (
    <div className="tu-doc tu-plugin-doc">
      <div className="tu-plugin-meta">
        <span className="tu-pane-plugin-name">{plugin.name}</span>
        {plugin.kind === 'skeleton' && <antd.Tag>骨架</antd.Tag>}
        <antd.Tag className="tu-version">{version}</antd.Tag>
        <span className="tu-muted">
          <span className={`tu-dot ${plugin.state}`} /> {stateText} · {inject}
        </span>
      </div>
      {plugin.error !== '' && <antd.Alert type="error" showIcon title={plugin.error} />}
      <antd.Tabs key={plugin.name} activeKey={resolvedTab} items={tabs} onChange={props.onTabChange} />
    </div>
  );
}


/**
 * 底层全视口泳道图舞台：桌面模式下铺满底部、支持拖拽平移与滚轮缩放、自带左上角单行 HUD 与左下角「适应窗口 / 100%」，
 * 窄屏（< 800px）自动退化成自然流排布。
 * @param props.name 画布名：boot 或消息号。
 * @param props.step 选中的第几步；0 是没选。
 * @param props.onPick 点了一步。
 * @param props.keyword 快照关键词。
 * @param props.hasSnapshot 会话消息有没有运行时变量快照。
 * @param props.pluginNames 全部已知插件名。
 * @param props.activePlugin 右侧正展示的插件名。
 * @param props.highlightEvent 当前高亮的事件名。
 * @param props.onSelectPlugin 打开指定插件并切右栏页签。
 * @param props.onClearEvent 清除事件高亮。
 * @param props.onTrailLoaded 画布加载完交回轨迹供右栏步骤详情使用。
 * @param props.leftOpen 左浮栏是否展开。
 * @param props.leftWidth 左浮栏宽度。
 * @param props.rightOpen 右浮栏是否展开。
 * @param props.rightWidth 右浮栏宽度。
 * @param props.isNarrow 是否窄屏退化模式。
 */
function CanvasStage(props: {
  name: string;
  step: number;
  onPick: (step: number) => void;
  onPickArrow: (step: number, event: string) => void;
  keyword: string;
  hasSnapshot?: boolean;
  pluginNames: Set<string>;
  activePlugin: string;
  highlightEvent: string;
  onSelectPlugin: (name: string, ptab?: string) => void;
  onClearEvent: () => void;
  onTrailLoaded: (canvasName: string, trail: Trail | null) => void;
  leftOpen: boolean;
  leftWidth: number;
  rightOpen: boolean;
  rightWidth: number;
  isNarrow: boolean;
}): JSX.Element {
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  //M 画布两种看法：表格（泳道）、顺序图。
  const [look, setLook] = useState<'table' | 'seq'>('table');
  const tr = i18n.useT();
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [transform, setTransform] = useState<CanvasTransform>({ tx: 296, ty: 68, scale: 1 });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const autoFittedForRef = useRef('');
  const lastCenteredStepRef = useRef('');
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const { onTrailLoaded } = props;

  //M 拉取当前画布的数据。
  useEffect(() => {
    setCanvas(null);
    setError('');
    onTrailLoaded(props.name, null);
    let alive = true;
    const loading = TutorialApi.get<Canvas>(`/api/tutorial/canvas?name=${encodeURIComponent(props.name)}`);
    loading.then((loaded) => {
      if (!alive) return;

      setCanvas(loaded);
      //M 画布轨迹加载成功后通知顶层页面保存当前活动轨迹并联动步骤详情与事件筛选。
      onTrailLoaded(props.name, loaded.trail);
    }, (failed: unknown) => {
      if (alive) {
        setError((failed as Error).message);
      }
    });
    return () => {
      alive = false;
    };
  }, [props.name, onTrailLoaded]);

  const seqLayout = useMemo(() => {
    if (canvas === null) return null;

    //M 顺序图的摆法：道、方块、箭头。
    return getSeqLayout(canvas.trail, tr);
  }, [canvas, tr]);

  const layout = useMemo(() => {
    if (canvas === null) return null;

    //M 预计算当前看法的尺寸及每步包围盒缓存，供视图居中与 HUD 对齐复用。
    if (look === 'seq') return seqLayout;

    return getCanvasLayout(canvas.lanes);
  }, [canvas, look, seqLayout]);

  //M 计算此刻不被左右两浮栏挡住的中间区域。
  const getLiveSafe = useCallback((): SafeViewport => {
    const stageW = stageRef.current?.clientWidth || window.innerWidth;
    const stageH = stageRef.current?.clientHeight || Math.max(400, window.innerHeight - 52);
    return getSafeViewport(stageW, stageH, props.leftOpen, props.leftWidth, props.rightOpen, props.rightWidth);
  }, [props.leftOpen, props.leftWidth, props.rightOpen, props.rightWidth]);

  //M 适应窗口：把整张泳道图缩放并居中摆进中间可见区域。
  const fitToWindow = useCallback((): void => {
    if (layout === null) return;

    //M 基于当前安全可视区反算全图自适应变换并应用到画布。
    const safe = getLiveSafe();
    setTransform(getFitTransform(layout, safe));
  }, [getLiveSafe, layout]);

  //M 100% 原比例：停在中间安全区左上角。
  const resetToHundred = useCallback((): void => {
    const safe = getLiveSafe();
    setTransform({ tx: safe.left + 8, ty: safe.top + 8, scale: 1 });
  }, [getLiveSafe]);

  //M 每次切换到一张新画布加载完毕时，自动适应一次窗口，开页就一眼看得全。
  useEffect(() => {
    if (props.isNarrow || layout === null) return;

    const fitKey = `${props.name}:${String(layout.width)}:${String(layout.total)}`;
    if (autoFittedForRef.current === fitKey) return;

    autoFittedForRef.current = fitKey;
    lastCenteredStepRef.current = '';
    //M 初次展现该画布时重置缩放平移矩阵使整张泳道图恰好居中可见。
    setTransform(getFitTransform(layout, getLiveSafe()));
  }, [getLiveSafe, layout, props.isNarrow, props.name]);

  //M 选中某一步时：若它落在左右两浮栏下面或屏幕外（尤其被右栏遮住），自动把画布平移到中间安全区看得见的地方。
  useEffect(() => {
    if (props.isNarrow || layout === null || props.step <= 0) {
      lastCenteredStepRef.current = '';
      return;
    }
    const stepKey = `${props.name}#${String(props.step)}:${String(props.rightOpen)}:${String(props.leftOpen)}`;
    if (lastCenteredStepRef.current === stepKey) return;

    lastCenteredStepRef.current = stepKey;
    //M 查表获得当前选中步所在的像素包围盒，找不到则保持视口不动。
    const box = layout.stepBoxes.get(props.step);
    if (box === undefined) return;

    const safe = getLiveSafe();
    setTransform((prev) => {
      const pad = 20;
      const stepLeft = prev.tx + box.x * prev.scale;
      const stepRight = stepLeft + box.w * prev.scale;
      const stepTop = prev.ty + box.y * prev.scale;
      const stepBottom = stepTop + box.h * prev.scale;

      let nextTx = prev.tx;
      let nextTy = prev.ty;
      if (stepRight > safe.right - pad) {
        nextTx -= stepRight - (safe.right - pad);
      }
      const adjustedLeft = nextTx + box.x * prev.scale;
      if (adjustedLeft < safe.left + pad) {
        nextTx += safe.left + pad - adjustedLeft;
      }
      if (stepBottom > safe.bottom - pad) {
        nextTy -= stepBottom - (safe.bottom - pad);
      }
      const adjustedTop = nextTy + box.y * prev.scale;
      if (adjustedTop < safe.top + pad) {
        nextTy += safe.top + pad - adjustedTop;
      }
      if (nextTx === prev.tx && nextTy === prev.ty) return prev;

      return { ...prev, tx: Math.round(nextTx), ty: Math.round(nextTy) };
    });
  }, [getLiveSafe, layout, props.isNarrow, props.leftOpen, props.name, props.rightOpen, props.step]);

  //M 滚轮以鼠标所在位置为中心缩放（必须用 passive: false 拦住浏览器默认页面滚动）。
  useEffect(() => {
    if (props.isNarrow) return undefined;

    const el = stageRef.current;
    if (el === null) return undefined;

    const onWheel = (event: WheelEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('.tu-stage-hud, .tu-stage-tools') !== null) return;

      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;
      let factor = 0.9;
      if (event.deltaY < 0) {
        factor = 1.12;
      }
      const prev = transformRef.current;
      //M 将滚轮缩放倍率的步进结果夹在合法缩限以内，避免无限放大或缩小失踪。
      const nextScale = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE);
      if (nextScale === prev.scale) return;

      const worldX = (mouseX - prev.tx) / prev.scale;
      const worldY = (mouseY - prev.ty) / prev.scale;
      setTransform({
        tx: Math.round(mouseX - worldX * nextScale),
        ty: Math.round(mouseY - worldY * nextScale),
        scale: nextScale,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [props.isNarrow]);

  //M 按住空白区域拖动平移画布（按钮、链接、输入控件上的点击照常响应）。
  const onStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (props.isNarrow || event.button !== 0) return;

    const target = event.target;
    if (target instanceof Element && target.closest('button, a, input, textarea, select, .tu-stage-hud, .tu-stage-tools') !== null) {
      return;
    }

    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startTx = transformRef.current.tx;
    const startTy = transformRef.current.ty;
    setDragging(true);

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      setTransform((prev) => ({
        ...prev,
        tx: Math.round(startTx + dx),
        ty: Math.round(startTy + dy),
      }));
    };
    const onUp = (): void => {
      setDragging(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  let stageClass = 'tu-stage';
  if (dragging) {
    stageClass = 'tu-stage dragging';
  }
  if (props.isNarrow) {
    stageClass = 'tu-stage narrow';
  }

  const liveSafe = getLiveSafe();
  let hudLeft = 16;
  let hudMaxWidth: number | undefined;
  if (!props.isNarrow) {
    hudLeft = liveSafe.left;
    hudMaxWidth = Math.max(240, liveSafe.right - liveSafe.left);
  }

  let title = '启动流程';
  if (props.name !== 'boot') {
    title = `消息 #${props.name}`;
  }

  const trail = canvas?.trail ?? null;
  //M 若选中事件高亮，找出当前轨迹里所有触发过该事件的步骤号供画布加亮及 HUD 快速跳转。
  const matchedList = getMatchedSteps(trail, props.highlightEvent);
  const matchedSet = new Set(matchedList);

  const metaParts: string[] = [];
  if (trail !== null) {
    if (trail.bot !== '') {
      metaParts.push(trail.bot);
    }
    if (trail.channel !== '') {
      //M 把英文渠道代号映射为中文短标签拼入画布摘要条。
      metaParts.push(getChannelLabel(trail.channel));
    }
    metaParts.push(trail.state);
    metaParts.push(`${String(trail.steps.length)} 步 · ${String(trail.ms)}ms`);
  }

  let hudTitleTip = title;
  if (trail !== null && trail.preview !== '') {
    hudTitleTip = `${title}：${trail.preview}`;
  }
  if (props.name !== 'boot' && props.hasSnapshot === false) {
    hudTitleTip += `（未带 ${props.keyword}，无运行时变量快照；泳道与源码照常可看）`;
  }

  const zoomPercent = String(Math.round(transform.scale * 100));

  return (
    <div ref={stageRef} className={stageClass} onPointerDown={onStagePointerDown}>
      {/* 右栏之外贴靠在左栏右边的一行摘要 HUD，不吃大片垂直空间。 */}
      <div
        className="tu-stage-hud"
        style={{ left: hudLeft, maxWidth: hudMaxWidth }}
        title={hudTitleTip}
      >
        <span className="tu-hud-title">{title}</span>
        {trail !== null && trail.preview !== '' && (
          <span className="tu-hud-preview">{trail.preview}</span>
        )}
        {metaParts.length > 0 && (
          <span className="tu-hud-meta">{metaParts.join(' · ')}</span>
        )}
        {trail !== null && trail.error && (
          <span className="tu-hud-err">有出错步</span>
        )}
        {props.name !== 'boot' && props.hasSnapshot === true && (
          <span className="tu-shot-badge">含快照</span>
        )}
        {props.name !== 'boot' && props.hasSnapshot === false && (
          <span className="tu-hud-tag">无快照</span>
        )}
        {props.highlightEvent !== '' && matchedList.length > 0 && (
          <span className="tu-hud-events">
            <span className="tu-hud-ev-name">{props.highlightEvent}</span>
            {matchedList.map((no) => {
              let hitClass = 'tu-event-hit-btn';
              if (props.step === no) {
                hitClass = 'tu-event-hit-btn active';
              }
              return (
                <button
                  key={no}
                  type="button"
                  className={hitClass}
                  onClick={
                    //M 点击事件命中步骤徽章直接跳转到画布对应步骤。
                    () => props.onPick(no)
                  }
                >
                  #{String(no)}
                </button>
              );
            })}
            <button type="button" className="tu-link" onClick={props.onClearEvent}>清除</button>
          </span>
        )}
      </div>

      {/* 加载态或报错居中提示（躲在浮栏中间可见区）。 */}
      {error !== '' && (
        <div className="tu-stage-center" style={{ left: hudLeft, maxWidth: hudMaxWidth }}>
          <antd.Alert type="error" showIcon title={error} />
        </div>
      )}
      {error === '' && canvas === null && (
        <div className="tu-stage-center" style={{ left: hudLeft, maxWidth: hudMaxWidth }}>
          <antd.Spin />
        </div>
      )}

      {/* 泳道图本体：桌面模式下包在平移缩放层内铺满整个视口；窄屏自动退化为普通横滚框。 */}
      {canvas !== null && !props.isNarrow && (
        <div
          className="tu-stage-world"
          style={{
            transform: `translate(${String(transform.tx)}px, ${String(transform.ty)}px) scale(${String(transform.scale)})`,
            transformOrigin: '0 0',
          }}
        >
          {look === 'table' && (
            <LaneChart
              canvas={canvas}
              picked={props.step}
              onPick={props.onPick}
              pluginNames={props.pluginNames}
              activePlugin={props.activePlugin}
              matchedSteps={matchedSet}
              onSelectPlugin={props.onSelectPlugin}
              panZoom
            />
          )}
          {look === 'seq' && seqLayout !== null && (
            <SeqChart
              canvas={canvas}
              layout={seqLayout}
              picked={props.step}
              event={props.highlightEvent}
              onPick={props.onPick}
              onPickArrow={props.onPickArrow}
              pluginNames={props.pluginNames}
              activePlugin={props.activePlugin}
              onSelectPlugin={props.onSelectPlugin}
            />
          )}
        </div>
      )}
      {canvas !== null && props.isNarrow && look === 'table' && (
        <LaneChart
          canvas={canvas}
          picked={props.step}
          onPick={props.onPick}
          pluginNames={props.pluginNames}
          activePlugin={props.activePlugin}
          matchedSteps={matchedSet}
          onSelectPlugin={props.onSelectPlugin}
          panZoom={false}
        />
      )}

      {/* 画布左下角控件：适应窗口、100%、当前比例、交互说明。 */}
      {!props.isNarrow && canvas !== null && (
        <div className="tu-stage-tools" style={{ left: hudLeft }}>
          <button type="button" className="tu-tool-btn" aria-pressed={look === 'table'} onClick={() => setLook('table')}>表格</button>
          <button type="button" className="tu-tool-btn" aria-pressed={look === 'seq'} onClick={() => setLook('seq')}>顺序图</button>
          <button type="button" className="tu-tool-btn" onClick={fitToWindow}>适应窗口</button>
          <button type="button" className="tu-tool-btn" onClick={resetToHundred}>100%</button>
          <span className="tu-tool-zoom">{zoomPercent}%</span>
          <span className="tu-tool-hint">滚轮缩放 · 按住空白拖动 · 点步看详情</span>
        </div>
      )}
    </div>
  );
}


/** 教程页。 */
export function TutorialPage(): JSX.Element {
  //M 读主网页保存的主题（默认深色），别的标签页切换主题时跟着变。
  const [themeName, setThemeName] = useState<theme.ThemeName>(() => theme.loadThemeName(window.localStorage));
  const themeSpec = theme.THEMES[themeName];
  const [plugins, setPlugins] = useState<PluginList | null>(null);
  //M 独立程序不是普通插件，清单直接来自 programs 的状态接口。
  const programs = programView.usePrograms();
  const [readingFiles, setReadingFiles] = useState<string[] | null>(null);
  const [readingListFailed, setReadingListFailed] = useState(false);
  const [cordisFiles, setCordisFiles] = useState<string[] | null>(null);
  const [cordisListFailed, setCordisListFailed] = useState(false);
  const [utilFiles, setUtilFiles] = useState<string[] | null>(null);
  const [utilListFailed, setUtilListFailed] = useState(false);
  const [messages, setMessages] = useState<MessageCanvasItem[]>([]);
  const [canvasesLoaded, setCanvasesLoaded] = useState(false);
  const [error, setError] = useState('');
  const [route, setRoute] = useState<RouteState>(() => getRouteFromUrl(window.location.search));
  const [searchText, setSearchText] = useState('');
  const [openGroups, setOpenGroups] = useState<GroupOpenState>({
    skeleton: true,
    utils: true,
    cordis: true,
    programs: true,
    reading: true,
    plugins: true,
    boot: true,
    messages: true,
    route: true,
  });

  //M 左右悬浮栏宽度与收起状态，读写 localStorage 均包 try/catch。
  const [leftWidth, setLeftWidth] = useState<number>(() => getStoredWidth(LEFT_WIDTH_KEY, DEFAULT_LEFT_WIDTH, MIN_LEFT_WIDTH));
  const [paneWidth, setPaneWidth] = useState<number>(getStoredDetailWidth);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(() => getStoredCollapsed(LEFT_COLLAPSED_KEY, false));
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(() => getStoredCollapsed(RIGHT_COLLAPSED_KEY, false));
  const [lineDetailHost, setLineDetailHost] = useState<HTMLDivElement | null>(null);
  const [resizing, setResizing] = useState(false);
  const [isNarrow, setIsNarrow] = useState<boolean>(() => window.innerWidth < NARROW_BREAKPOINT);

  //M 右栏详情/代码/状态列表共用的外层滚动容器 state。
  const [rightScrollParent, setRightScrollParent] = useState<HTMLDivElement | null>(null);

  const [activeTrail, setActiveTrail] = useState<Trail | null>(null);
  const [loadedCanvasName, setLoadedCanvasName] = useState('');
  const [messageApi, contextHolder] = antd.message.useMessage();
  //M 读回教程上次选的视图，并将新控件按当前语言显示。
  const tutorialView = mind.useTutorialView();
  //M 顶上的三种树改成左栏入口，画布只留下方向小切换。
  const mindTree = mind.useMindTree();
  const t = mind.useMindWords();
  const viewLabel = t('教程视图');
  const canvasLabel = t('画布');
  const mindLabel = t('思维导图');
  const utilsLabel = t('骨架工具（utils）');
  const utilsLoadingLabel = t('正在读取工具说明…');
  const utilsErrorLabel = t('读不到工具说明');
  const readingLabel = t('组块阅读');
  const readingLoadingLabel = t('正在读取组块…');
  const readingErrorLabel = t('读不到组块');
  const showMind = tutorialView.view === 'mind';

  const attachRightScroll = useCallback((el: HTMLDivElement | null): void => {
    setRightScrollParent(el);
  }, []);

  useEffect(() => {
    //M 首次挂载及主题切换后将最新 CSS 变量应用到 html 根节点，保持全页色调同步。
    theme.applyTheme(document.documentElement, themeSpec);
  }, [themeSpec]);

  //M 视口大小改变时刷新窄屏开关，并把两栏宽度夹回当前 45% 安全上限。
  useEffect(() => {
    const onResize = (): void => {
      setIsNarrow(window.innerWidth < NARROW_BREAKPOINT);
      setLeftWidth((prev) => Math.min(prev, getMaxSideWidth(MIN_LEFT_WIDTH)));
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  //M 画布加载完成时记下已就绪的画布名与轨迹。
  const handleTrailLoaded = useCallback((canvasName: string, trail: Trail | null) => {
    let nextLoaded = canvasName;
    if (trail === null) {
      nextLoaded = '';
    }
    setLoadedCanvasName(nextLoaded);
    setActiveTrail(trail);
  }, []);

  useEffect(() => {
    const onStorage = (): void => {
      //M 其他标签页修改 localStorage 主题后，本页实时重新读取并重绘配色。
      const next = theme.loadThemeName(window.localStorage);
      setThemeName(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  //M 浏览器后退 / 前进时同步恢复路由状态。
  useEffect(() => {
    const onPopState = (): void => {
      setRoute(getRouteFromUrl(window.location.search));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  //M 写入新浏览历史并切换界面状态（保证后退键可用）。
  const navigate = useCallback((next: RouteState) => {
    setRoute(next);
    const nextUrl = buildRouteUrl(next);
    if (nextUrl !== window.location.href) {
      window.history.pushState(null, '', nextUrl);
    }
  }, []);

  //M 切到新画布后，若上一画布高亮的事件在这里没出现，就清掉事件高亮。
  useEffect(() => {
    if (activeTrail === null || route.event === '' || loadedCanvasName !== route.canvas) return;

    //M 当前画布轨迹依然出现过该事件时继续保留高亮状态。
    if (getMatchedSteps(activeTrail, route.event).length > 0) return;

    const cleared = { ...route, event: '' };
    setRoute(cleared);
    //M 无匹配步骤时无痕替换地址栏参数去掉失效的 event，不污染浏览器历史栈。
    window.history.replaceState(window.history.state, '', buildRouteUrl(cleared));
  }, [activeTrail, loadedCanvasName, route]);

  //M 切换组块时从新文档开头读，不沿用上一篇的滚动位置。
  useEffect(() => {
    if (route.rtab !== 'reading' || rightScrollParent === null) return;

    rightScrollParent.scrollTop = 0;
  }, [rightScrollParent, route.reading, route.rtab]);

  //M 地址里直接带三方握手图时，打开骨架逐行那棵树。
  useEffect(() => {
    if (route.plugin !== programView.HANDSHAKE && route.plugin !== 'cordis') return;

    //M 切到骨架逐行，由它按模块名打开 进程插件.json。
    mindTree.select('lines');
  }, [route.plugin, mindTree.select]);

  //M 拉插件、组块和最近消息画布列表。
  const load = useCallback(() => {
    const pluginLoading = TutorialApi.get<PluginList>('/api/tutorial/plugins');
    pluginLoading.then(setPlugins, (failed: unknown) => setError((failed as Error).message));
    //M 把组块清单的失败留在组块分组，插件和画布仍可使用。
    //M Cordis 文档一组，清单取新目录，避免在网页硬编码 00–04 的文件名。
    const cordisLoading = TutorialApi.getCordisDocs();
    void cordisLoading.then((result) => setCordisFiles(result.files), () => setCordisListFailed(true));
    const readingLoading = TutorialApi.getReadings();
    void readingLoading.then((result) => setReadingFiles(result.files), () => setReadingListFailed(true));
    //M 工具清单是动态的，新增 src7/utils/index.ts 后不用改网页。
    const utilsLoading = TutorialApi.getUtils();
    void utilsLoading.then((result) => setUtilFiles(result.files), () => setUtilListFailed(true));
    const canvasLoading = TutorialApi.get<CanvasList>('/api/tutorial/canvases');
    canvasLoading.then((result) => {
      if (Array.isArray(result.messages)) {
        setMessages(result.messages);
        setCanvasesLoaded(true);
        return;
      }
      const fallback = result.list
        .filter((item) => item.name !== 'boot')
        .map((item) => ({ name: item.name, at: item.at, preview: item.preview, hasSnapshot: true }));
      setMessages(fallback);
      setCanvasesLoaded(true);
    }, (failed: unknown) => setError((failed as Error).message));
  }, []);

  useEffect(() => {
    //M 教程页首次挂载后并发请求左栏清单。
    load();
  }, [load]);

  //M 初次加载完成时替换 URL 中的哨兵占位。
  useEffect(() => {
    if (route.canvas === SENTINEL_AUTO && canvasesLoaded) {
      let targetCanvas = 'boot';
      if (messages.length > 0 && messages[0] !== undefined) {
        targetCanvas = messages[0].name;
      }
      const settled = { ...route, canvas: targetCanvas };
      setRoute(settled);
      //M 将初次默认选中的 __AUTO__ 哨兵静态替换为真实画布号写回地址栏（不产生额外历史记录）。
      window.history.replaceState(window.history.state, '', buildRouteUrl(settled));
      return;
    }
    if (route.plugin === SENTINEL_FIRST && plugins !== null) {
      const firstPlugin = plugins.list[0]?.name ?? '';
      const settled = { ...route, plugin: firstPlugin };
      setRoute(settled);
      //M 将 ?tab=plugins 对应的 __FIRST__ 标记换成首个插件名并同步到地址栏。
      window.history.replaceState(window.history.state, '', buildRouteUrl(settled));
    }
  }, [canvasesLoaded, messages, plugins, route]);

  //M 拖动调整左侧悬浮栏宽度并持久化。
  const startLeftResize = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setResizing(true);
    const maxWidth = getMaxSideWidth(MIN_LEFT_WIDTH);
    let latestWidth = clamp(leftWidth, MIN_LEFT_WIDTH, maxWidth);

    const onMove = (moveEvent: MouseEvent): void => {
      const candidate = Math.round(moveEvent.clientX - 12);
      //M 拖动中实时把左栏宽限制在最小宽到 45% 视口之间再刷新尺寸。
      latestWidth = clamp(candidate, MIN_LEFT_WIDTH, maxWidth);
      setLeftWidth(latestWidth);
    };
    const onUp = (): void => {
      setResizing(false);
      //M 松手后把最终左栏宽记忆进 localStorage 供下次打开沿用。
      saveStored(LEFT_WIDTH_KEY, String(latestWidth));
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  //M 拖动调整右侧悬浮栏宽度并持久化。
  const startRightResize = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setResizing(true);
    const maxWidth = maxDetailWidth;
    let latestWidth = clampedRightWidth;

    const onMove = (moveEvent: MouseEvent): void => {
      const candidate = Math.round(window.innerWidth - moveEvent.clientX - 12);
      //M 右栏最大只能占去掉左栏后剩余空间的一半。
      latestWidth = clamp(candidate, MIN_PANE_WIDTH, maxWidth);
      setPaneWidth(latestWidth);
    };
    const onUp = (): void => {
      setResizing(false);
      //M 松手后把最终右栏宽记忆进 localStorage 持久化。
      saveStored(DETAIL_WIDTH_KEY, String(latestWidth));
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  //M 收起 / 展开左右浮栏并记住开关。
  const toggleLeftCollapsed = (collapsed: boolean): void => {
    setLeftCollapsed(collapsed);
    let flag = '0';
    if (collapsed) {
      flag = '1';
    }
    //M 将左栏折叠布尔状态持久化到本地存储。
    saveStored(LEFT_COLLAPSED_KEY, flag);
  };

  const toggleRightCollapsed = (collapsed: boolean): void => {
    setRightCollapsed(collapsed);
    let flag = '0';
    if (collapsed) {
      flag = '1';
    }
    //M 将右栏折叠布尔状态持久化到本地存储。
    saveStored(RIGHT_COLLAPSED_KEY, flag);
  };

  const keyword = plugins?.keyword ?? '#调试';
  const pluginList = plugins?.list ?? [];
  const pluginNames = useMemo(() => new Set(pluginList.map((item) => item.name)), [pluginList]);
  const workspace = plugins?.workspace ?? '';

  //M 各组沿用左栏搜索；组块匹配文件名或本组名称。
  const query = searchText.trim().toLowerCase();
  const hasSearch = query !== '';
  const showBoot = !hasSearch || '启动流程boot'.includes(query);
  const filteredReadings = useMemo(() => {
    const files = readingFiles ?? [];
    if (!hasSearch || readingLabel.toLowerCase().includes(query)) return files;

    return files.filter((name) => name.toLowerCase().includes(query));
  }, [hasSearch, query, readingFiles, readingLabel]);
  //M Cordis 组和其他左栏组共用搜索，文档仍按编号顺序。
  const filteredCordis = useMemo(() => {
    const files = cordisFiles ?? [];
    if (!hasSearch || 'cordis用法'.includes(query)) return files;

    return files.filter((name) => name.toLowerCase().includes(query));
  }, [cordisFiles, hasSearch, query]);
  let cordisStatus = '正在读取 Cordis 文档…';
  if (cordisFiles !== null) cordisStatus = '没有匹配的 Cordis 文档';
  if (cordisListFailed) cordisStatus = '读不到 Cordis 文档';

  //M 骨架工具按文件名搜索，清单顺序由接口给。
  const filteredUtils = useMemo(() => {
    const files = utilFiles ?? [];
    if (!hasSearch || utilsLabel.toLowerCase().includes(query)) return files;

    return files.filter((name) => name.toLowerCase().includes(query));
  }, [hasSearch, query, utilFiles, utilsLabel]);
  let utilStatus = utilsLoadingLabel;
  //M 清单到了还是空就是没匹配上，读失败另说。
  if (utilFiles !== null) utilStatus = t('没有匹配的工具');
  if (utilListFailed) utilStatus = utilsErrorLabel;
  let readingStatus = readingLoadingLabel;
  if (readingFiles !== null) {
    readingStatus = t('没有匹配的组块');
  }
  if (readingListFailed) {
    readingStatus = readingErrorLabel;
  }
  const filteredMessages = useMemo(() => {
    return messages.filter((item) => {
      if (!hasSearch) return true;

      //M 提取中文渠道标签、原始渠道名、机器人名及标题共同参与左栏搜索匹配。
      const chLabel = getChannelLabel(item.channel).toLowerCase();
      const chRaw = (item.channel ?? '').toLowerCase();
      const bot = (item.bot ?? '').toLowerCase();
      const title = getMessageTitle(item).toLowerCase();
      return title.includes(query) || chLabel.includes(query) || chRaw.includes(query) || bot.includes(query);
    });
  }, [hasSearch, messages, query]);

  const filteredSkeletons = useMemo(() => {
    return pluginList.filter((item) => {
      if (item.kind !== 'skeleton') return false;
      if (!hasSearch) return true;

      const stateWord = (STATE_WORDS[item.state] ?? item.state).toLowerCase();
      return item.name.toLowerCase().includes(query) || stateWord.includes(query) || '骨架模块'.includes(query) || query === 'skeleton';
    });
  }, [hasSearch, pluginList, query]);

  const filteredRegularPlugins = useMemo(() => {
    return pluginList.filter((item) => {
      if (item.kind === 'skeleton') return false;
      if (!hasSearch) return true;

      const stateWord = (STATE_WORDS[item.state] ?? item.state).toLowerCase();
      return item.name.toLowerCase().includes(query) || stateWord.includes(query);
    });
  }, [hasSearch, pluginList, query]);

  const toggleGroup = (key: keyof GroupOpenState): void => {
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  //M 点左栏「启动流程」或「最近消息」：切画布、清无效步号；当前若在「这一步」页签留在原地看新画布。
  const onSelectCanvas = (canvasName: string): void => {
    //M 思维导图里看这条消息（或这次启动）走过的路，泳道画布照旧；右侧详情展开。
    toggleRightCollapsed(false);
    mindTree.select('trace');
    let rtab = route.rtab;
    if (rtab === 'reading' || rtab === 'util') rtab = 'step';
    navigate({ ...route, canvas: canvasName, step: 0, rtab, doc: false });
  };

  //M 点左栏组块时展开右栏，并把完整文件名写入地址以便刷新恢复。
  const onSelectReading = (name: string): void => {
    toggleRightCollapsed(false);
    navigate({ ...route, reading: name, rtab: 'reading', doc: true });
  };

  const onSelectUtil = (name: string): void => {
    //M 工具说明没有思维导图，左栏之外整个区域都是正文。
    toggleRightCollapsed(false);
    navigate({ ...route, util: name, rtab: 'util', doc: true });
  };

  //M 点左栏插件、画布道名、步骤详情“查看 xxx 插件”或监听标签：展开右栏并切到「插件」页签。
  const onSelectPlugin = (pluginName: string, nextPtab?: string, keepCanvas = false): void => {
    if (pluginName === '') return;

    let resolvedPtab = nextPtab ?? 'overview';
    if (nextPtab === undefined && route.plugin === pluginName) {
      resolvedPtab = route.ptab;
    }
    //M 选择插件后自动展开右栏并跳转至「插件」页签。
    toggleRightCollapsed(false);
    const item = pluginList.find((plugin) => plugin.name === pluginName);
    let doc = !keepCanvas;
    let rtab: RouteState['rtab'] = 'plugin';
    //M 左栏骨架模块和三方握手直接进骨架逐行，右侧显示点中的块。
    const toLines = item?.kind === 'skeleton' || pluginName === programView.HANDSHAKE || pluginName === 'cordis';
    if (toLines && !keepCanvas) {
      mindTree.select('lines');
      tutorialView.select('mind');
      doc = false;
      rtab = 'step';
    }
    navigate({ ...route, plugin: pluginName, ptab: resolvedPtab, rtab, doc });
  };

  //M 点画布中某一步：自动展开右栏并切到「这一步」；若这一步落在已知插件上，也同步记下方便用户点「插件」标签。
  const onPickStep = (stepNo: number): void => {
    toggleRightCollapsed(false);
    const pickedStep = activeTrail?.steps.find((item) => item.no === stepNo);
    let nextPlugin = route.plugin;
    let nextPtab = route.ptab;
    if (pickedStep !== undefined && pluginNames.has(pickedStep.node)) {
      if (route.plugin !== pickedStep.node) {
        nextPtab = 'overview';
      }
      nextPlugin = pickedStep.node;
    }
    navigate({ ...route, step: stepNo, plugin: nextPlugin, ptab: nextPtab, rtab: 'step', doc: false });
  };

  //M 点顺序图的箭头：选中这一步、高亮这个事件，右栏「这一步」顶上看事件详情。
  const onPickArrow = (stepNo: number, eventName: string): void => {
    toggleRightCollapsed(false);
    navigate({ ...route, step: stepNo, event: eventName, rtab: 'step', doc: false });
  };

  //M 点事件名：高亮命中步，选中第一处并展开右栏「这一步」。
  const onSelectEvent = (eventName: string): void => {
    const hasRealCanvas = route.canvas !== '' && route.canvas !== SENTINEL_AUTO;
    if (!hasRealCanvas) {
      void messageApi.info('当前未打开画布：请先在左栏选一条「最近消息」或「启动流程」，即可高亮该事件在流程中的每一步');
      return;
    }

    if (route.event === eventName) {
      navigate({ ...route, event: '' });
      return;
    }

    //M 检索当前激活画布内发出过该事件的所有步骤索引。
    const hits = getMatchedSteps(activeTrail, eventName);
    if (hits.length === 0) {
      void messageApi.info(`当前画布未出现事件 ${eventName}，可点击左栏其他消息查看`);
      return;
    }

    let nextStep = route.step;
    if (!hits.includes(nextStep)) {
      nextStep = hits[0] ?? 0;
    }
    //M 自动展开右栏以便查看命中该事件的第一步详情。
    toggleRightCollapsed(false);
    navigate({ ...route, event: eventName, step: nextStep, rtab: 'step', doc: false });
  };

  const hasRealCanvas = route.canvas !== '' && route.canvas !== SENTINEL_AUTO;
  const resolvedPluginName = route.plugin;
  const hasPluginName = resolvedPluginName !== '' && resolvedPluginName !== SENTINEL_FIRST;
  const activePlugin = pluginList.find((item) => item.name === resolvedPluginName);
  //M 进程插件用 program: 前缀，不和普通插件重名，右栏走专门的状态、接口、说明。
  const programName = programView.getProgramName(resolvedPluginName);
  const isProcess = programName !== undefined || resolvedPluginName === programView.HANDSHAKE;
  const activeMessage = messages.find((item) => item.name === route.canvas);
  const pickedStep = activeTrail?.steps.find((item) => item.no === route.step);

  const skeletonExpanded = openGroups.skeleton || hasSearch;
  const readingsExpanded = openGroups.reading || hasSearch;
  const pluginsExpanded = openGroups.plugins || hasSearch;
  const bootExpanded = openGroups.boot || hasSearch;
  const messagesExpanded = openGroups.messages || hasSearch;
  const utilsExpanded = openGroups.utils || hasSearch;

  //M 没有画布的说明页是两栏，画布页是三栏；从画布点的插件仍留在三栏详情里。
  const contentOnly = route.doc || route.rtab === 'reading' || route.rtab === 'util';
  //M 左栏保留旧的宽度记忆，右栏默认取剩余空间一半；拖过才用本地记住的宽。
  const clampedLeftWidth = clamp(leftWidth, MIN_LEFT_WIDTH, getMaxSideWidth(MIN_LEFT_WIDTH));
  let detailLeftSpace = clampedLeftWidth + 24;
  if (leftCollapsed || isNarrow) detailLeftSpace = 0;
  const maxDetailWidth = getMaxDetailWidth(viewportWidth, detailLeftSpace);
  let clampedRightWidth = maxDetailWidth;
  if (paneWidth > 0) clampedRightWidth = clamp(paneWidth, MIN_PANE_WIDTH, maxDetailWidth);

  let bodyClass = 'tu-body';
  if (resizing) bodyClass += ' resizing';
  if (showMind && !contentOnly) bodyClass += ' tu-mind-active';
  if (contentOnly) bodyClass += ' tu-content-only';

  let mindLeft = 12;
  let mindRight = 12;
  if (!isNarrow && !leftCollapsed) mindLeft += clampedLeftWidth + 12;
  if (!isNarrow && !rightCollapsed) mindRight += clampedRightWidth + 12;
  let mindTrail: Trail | null = null;
  if (loadedCanvasName === route.canvas) mindTrail = activeTrail;

  /** 导图点击与画布、左栏点击走同一套详情和路由。 */
  function onMindPick(target: mindData.Pick): void {
    if (target.kind === 'step') {
      //M 轨迹节点通过原画布入口读取步骤和变量。
      onPickStep(target.no);
      return;
    }
    if (target.kind !== 'plugin') return;

    if (target.name === programView.HANDSHAKE) {
      //M 三方握手图节点切到骨架逐行，程序节点仍然打开右栏。
      tutorialView.select('mind');
    }
    //M 插件节点打开已有的说明或对外函数页签。
    onSelectPlugin(target.name, target.tab, target.name !== programView.HANDSHAKE);
  }
  const onOpenHandshake = (): void => {
    //M 左栏和详情里的三方握手入口共用一个模块名，导图看到它后自动切骨架逐行。
    tutorialView.select('mind');
    onSelectPlugin(programView.HANDSHAKE);
  };
  const onOpenCordis = (): void => {
    //M 示意图沿用骨架逐行画布（Cordis.json），不是本次运行录下来的轨迹。
    onSelectPlugin('cordis');
  };
  const onReadingHash = (href: string): void => {
    //M Cordis 组块正文可跳同组文档、动态图、骨架和插件。
    const params = new URLSearchParams(href.slice(1));
    const doc = params.get('cordis');
    if (doc !== null) {
      onSelectReading(`cordis/${doc}`);
      return;
    }
    //M #lines=Cordis.json（可带 :行号）→ 打开那张逐行图；行号定位留给图里自己点。
    const file = params.get('lines');
    if (file !== null) {
      onLinesPlugin(file.replace(/(\.json)?(:\d+)?$/u, '').toLowerCase());
      return;
    }
    //M #plugin=名字 → 插件说明。
    const name = params.get('plugin');
    if (name !== null) onSelectPlugin(name);
  };
  const onOpenProject = (): void => {
    //M 左栏「项目结构」恢复三栏画布，不沿用旧页签上的组块或工具说明。
    tutorialView.select('mind');
    mindTree.select('project');
    toggleRightCollapsed(false);
    navigate({ ...route, rtab: 'step', doc: false });
  };
  const onLineDetail = (): void => {
    //M 点逐行图里的块后自动展开右侧，已在「这一步」就不动。
    toggleRightCollapsed(false);
    if (route.rtab === 'step') return;

    const next: RouteState = { ...route, rtab: 'step' };
    setRoute(next);
    //M 只换掉当前地址，不增加浏览历史。
    window.history.replaceState(window.history.state, '', buildRouteUrl(next));
  };
  const onLinesPlugin = (name: string): void => {
    const item = pluginList.find((plugin) => plugin.name === name);
    if (item?.kind === 'skeleton' || name === programView.HANDSHAKE || name === 'cordis') {
      //M 逐行图下拉换文件：仍在骨架逐行，右侧看块详情。
      onSelectPlugin(name);
      return;
    }
    //M 逐行图里链到普通插件：留在三栏，右侧看插件说明。
    onSelectPlugin(name, undefined, true);
  };
  const onSelectProgram = (name: string): void => {
    //M config 里登记的程序走专用右栏，地址带前缀与普通插件隔开。
    const target = programView.PROGRAM_PREFIX + name;
    onSelectPlugin(target);
  };

  let showBootGroupCount = 1;
  if (hasSearch && !showBoot) {
    showBootGroupCount = 0;
  }
  let bootItemClass = 'tu-nav-item';
  if (route.canvas === 'boot') {
    bootItemClass = 'tu-nav-item active';
  }

  //M 左栏顺序：骨架（含项目结构）→ 骨架工具 → 启动流程 → 最近消息 → 组块阅读 → 插件 → 进程插件，共用一个虚拟列表。
  const leftRows = useMemo<LeftNavRow[]>(() => {
    const rows: LeftNavRow[] = [
      {
        key: 'head:skeleton', kind: 'group-head', groupKey: 'skeleton', title: '骨架',
        count: filteredSkeletons.length + 1, expanded: skeletonExpanded,
      },
    ];
    if (skeletonExpanded) {
      //M 原来顶上的「项目结构」放在骨架组第一行。
      rows.push({ key: 'skeleton:project', kind: 'project' });
      for (const item of filteredSkeletons) {
        rows.push({ key: `skeleton:${item.name}`, kind: 'plugin', plugin: item });
      }
    }
    //M 骨架工具紧跟骨架，一个 src7/utils/ 文件一行。
    rows.push({ key: 'div:skeleton-utils', kind: 'divider' });
    //M 组头数量是现有工具文件数，搜索时强制展开。
    rows.push({
      key: 'head:utils', kind: 'group-head', groupKey: 'utils', title: utilsLabel,
      count: filteredUtils.length, expanded: utilsExpanded,
    });
    if (utilsExpanded) {
      if (filteredUtils.length === 0) rows.push({ key: 'empty:utils', kind: 'empty', text: utilStatus });
      for (const name of filteredUtils) {
        rows.push({ key: `util:${name}`, kind: 'util', name });
      }
    }
    //M Cordis 放在骨架工具后：五份文档两栏阅读，动态图进三栏画布。
    rows.push({ key: 'div:utils-cordis', kind: 'divider' });
    rows.push({
      key: 'head:cordis', kind: 'group-head', groupKey: 'cordis', title: 'Cordis 用法',
      count: filteredCordis.length + 1, expanded: openGroups.cordis || hasSearch,
    });
    if (openGroups.cordis || hasSearch) {
      //M 图在组内第一行，文档按文件名排序。
      rows.push({ key: 'cordis:map', kind: 'cordis-map' });
      if (filteredCordis.length === 0) rows.push({ key: 'empty:cordis', kind: 'empty', text: cordisStatus });
      for (const name of filteredCordis) {
        //M 复用组块文档路由，前缀区分文档目录。
        rows.push({ key: `cordis:${name}`, kind: 'reading', name: `cordis/${name}` });
      }
    }
    //M Cordis 组和启动流程之间的分隔线。
    rows.push({ key: 'div:cordis-boot', kind: 'divider' });

    rows.push({ key: 'head:boot', kind: 'group-head', groupKey: 'boot', title: '启动流程', count: showBootGroupCount, expanded: bootExpanded });
    if (bootExpanded && showBoot) {
      rows.push({ key: 'item:boot', kind: 'boot' });
    }
    rows.push({ key: 'div:boot-messages', kind: 'divider' });

    //M 静态的“一条飞书消息”路线，没跑过消息也能看，搜索时不参与。
    rows.push({ key: 'head:route', kind: 'group-head', groupKey: 'route', title: '一条飞书消息的路线', count: FEISHU_ROUTE.length, expanded: openGroups.route });
    if (openGroups.route) {
      FEISHU_ROUTE.forEach((_stop, index) => rows.push({ key: `route:${String(index)}`, kind: 'route', index }));
    }
    rows.push({ key: 'div:route-messages', kind: 'divider' });

    rows.push({ key: 'head:messages', kind: 'group-head', groupKey: 'messages', title: '最近消息', count: filteredMessages.length, expanded: messagesExpanded });
    if (messagesExpanded) {
      if (filteredMessages.length === 0) {
        rows.push({ key: 'empty:messages', kind: 'empty', text: '没有匹配的消息' });
      }
      for (const item of filteredMessages) {
        rows.push({ key: `msg:${item.name}`, kind: 'message', message: item });
      }
    }
    rows.push({ key: 'div:messages-reading', kind: 'divider' });

    rows.push({
      key: 'head:reading',
      kind: 'group-head',
      groupKey: 'reading',
      title: readingLabel,
      count: filteredReadings.length,
      expanded: readingsExpanded,
    });
    if (readingsExpanded) {
      if (filteredReadings.length === 0) {
        rows.push({ key: 'empty:reading', kind: 'empty', text: readingStatus });
      }
      for (const name of filteredReadings) {
        rows.push({ key: `reading:${name}`, kind: 'reading', name });
      }
    }
    rows.push({ key: 'div:reading-plugins', kind: 'divider' });

    rows.push({ key: 'head:plugins', kind: 'group-head', groupKey: 'plugins', title: '插件', count: filteredRegularPlugins.length, expanded: pluginsExpanded });
    if (pluginsExpanded) {
      if (filteredRegularPlugins.length === 0) {
        rows.push({ key: 'empty:plugins', kind: 'empty', text: '没有匹配的插件' });
      }
      for (const item of filteredRegularPlugins) {
        rows.push({ key: `plugin:${item.name}`, kind: 'plugin', plugin: item });
      }
    }
    //M 进程插件也是插件，排在插件组后面：先三方握手图，再 config 里登记的每个程序。
    rows.push({ key: 'div:plugins-programs', kind: 'divider' });
    rows.push({
      key: 'head:programs', kind: 'group-head', groupKey: 'programs', title: '进程插件',
      count: programs.length + 1, expanded: openGroups.programs || hasSearch,
    });
    if (openGroups.programs || hasSearch) {
      //M 握手图固定第一行，不参与搜索过滤。
      rows.push({ key: 'programs:handshake', kind: 'handshake' });
      for (const program of programs) {
        if (hasSearch && !`${program.name} ${program.title}`.toLowerCase().includes(query)) continue;

        //M 一个程序一行，状态和版本取自 /api/programs。
        rows.push({ key: `program:${program.name}`, kind: 'program', program });
      }
    }
    return rows;
  }, [
    bootExpanded,
    filteredMessages,
    filteredReadings,
    filteredRegularPlugins,
    filteredSkeletons,
    filteredUtils,
    messagesExpanded,
    pluginsExpanded,
    readingLabel,
    readingsExpanded,
    readingStatus,
    showBoot,
    showBootGroupCount,
    skeletonExpanded,
    utilsExpanded,
    utilsLabel,
    utilStatus,
    programs,
    openGroups.programs,
    openGroups.cordis,
    filteredCordis,
    cordisStatus,
    hasSearch,
    query,
  ]);

  let stepTabClass = 'tu-rtab';
  if (route.rtab === 'step') {
    stepTabClass = 'tu-rtab active';
  }
  let pluginTabClass = 'tu-rtab';
  if (route.rtab === 'plugin') {
    pluginTabClass = 'tu-rtab active';
  }

  let readingTabClass = 'tu-rtab';
  if (route.rtab === 'reading') {
    readingTabClass = 'tu-rtab active';
  }

  //M 顶栏简洁摘要。
  let topSummary = '';
  if (route.canvas === 'boot') {
    topSummary = '启动流程';
  }
  if (route.canvas !== '' && route.canvas !== SENTINEL_AUTO && route.canvas !== 'boot') {
    topSummary = `消息 #${route.canvas}`;
  }
  if (pickedStep !== undefined) {
    topSummary += `  ·  第 ${String(pickedStep.no)} 步`;
  }
  if (hasPluginName) {
    let labelPrefix = '插件';
    if (activePlugin?.kind === 'skeleton') {
      labelPrefix = '骨架';
    }
    topSummary += `  ·  ${labelPrefix} ${resolvedPluginName}`;
  }

  //M 渲染左栏一条消息或插件。
  const renderMessageNav = (item: MessageCanvasItem): JSX.Element => {
    const title = getMessageTitle(item);
    const chLabel = getChannelLabel(item.channel);
    let itemClass = 'tu-nav-item';
    if (route.canvas === item.name) {
      itemClass = 'tu-nav-item active';
    }
    return (
      <button
        type="button"
        className={itemClass}
        title={title}
        onClick={
          //M 点击左栏最近消息条目切换当前展示的泳道图画布。
          () => onSelectCanvas(item.name)
        }
      >
        <span className="tu-menu-item">
          {chLabel !== '' && <span className={`tu-ch-badge ${item.channel ?? ''}`}>{chLabel}</span>}
          <span className="tu-menu-name">{title}</span>
          {item.hasSnapshot && <span className="tu-shot-badge" title={`带 ${keyword} 的消息，点开步骤可看运行时变量`}>快照</span>}
          <span className="tu-menu-version">{getClock(item.at)}</span>
        </span>
      </button>
    );
  };

  const renderPluginNav = (plugin: PluginItem): JSX.Element => {
    let version = '';
    if (plugin.version !== '') {
      version = `v${plugin.version}`;
    }
    let itemClass = 'tu-nav-item';
    if (resolvedPluginName === plugin.name) {
      itemClass = 'tu-nav-item active';
    }
    let tip = STATE_WORDS[plugin.state] ?? plugin.state;
    if (plugin.kind === 'skeleton') {
      tip = `系统骨架（${plugin.name}）`;
    }
    return (
      <button
        type="button"
        className={itemClass}
        title={tip}
        onClick={
          //M 点击左栏骨架或插件项切到右侧「插件」分栏看说明与代码。
          () => onSelectPlugin(plugin.name)
        }
      >
        <span className="tu-menu-item">
          <span className={`tu-dot ${plugin.state}`} />
          <span className="tu-menu-name">{plugin.name}</span>
          <span className="tu-menu-version">{version}</span>
        </span>
      </button>
    );
  };

  const renderLeftRow = (row: LeftNavRow): JSX.Element => {
    if (row.kind === 'group-head') {
      let arrow = '▸';
      if (row.expanded) {
        arrow = '▾';
      }
      return (
        <div className="tu-side-row tu-side-row-head">
          <button
            type="button"
            className="tu-group-head"
            aria-expanded={row.expanded}
            onClick={
              //M 点击左栏分组标题时切换该组的展开或折叠状态。
              () => toggleGroup(row.groupKey)
            }
          >
            <span className="tu-group-arrow">{arrow}</span>
            <span className="tu-group-title">{row.title}</span>
            <span className="tu-group-count">{row.count}</span>
          </button>
        </div>
      );
    }
    if (row.kind === 'divider') {
      return <div className="tu-group-divider" role="separator" />;
    }
    if (row.kind === 'plugin') {
      return (
        <div className="tu-side-row">
          {
            //M 交由插件与骨架统一条目渲染函数输出状态点、名称与版本号。
            renderPluginNav(row.plugin)
          }
        </div>
      );
    }
    if (row.kind === 'program') {
      const program = row.program;
      const target = programView.PROGRAM_PREFIX + program.name;
      let itemClass = 'tu-nav-item';
      if (route.plugin === target) itemClass = 'tu-nav-item active';
      //M 点了右栏打开这个程序的状态、接口和说明。
      const onClick = (): void => onSelectProgram(program.name);
      return (
        <div className="tu-side-row">
          <button type="button" className={itemClass} onClick={onClick}>
            <span className="tu-menu-item">
              <span className={`tu-dot ${programView.getStateDot(program.state)}`} />
              <span className="tu-menu-name">{program.title}</span>
              <span className="tu-menu-version">{program.version}</span>
            </span>
          </button>
        </div>
      );
    }
    if (row.kind === 'cordis-map') {
      let itemClass = 'tu-nav-item';
      if (!contentOnly && route.plugin === 'cordis') itemClass += ' active';
      return (
        <div className="tu-side-row">
          <button type="button" className={itemClass} onClick={onOpenCordis}>动态图：挂上到卸下</button>
        </div>
      );
    }
    if (row.kind === 'handshake') {
      return (
        <div className="tu-side-row">
          <button type="button" className="tu-nav-item" onClick={onOpenHandshake}>三方握手图</button>
        </div>
      );
    }
    if (row.kind === 'project') {
      let itemClass = 'tu-nav-item';
      if (!contentOnly && showMind && mindTree.mode === 'project') itemClass = 'tu-nav-item active';
      return (
        <div className="tu-side-row">
          <button type="button" className={itemClass} onClick={onOpenProject}>{t('项目结构')}</button>
        </div>
      );
    }
    if (row.kind === 'util') {
      const name = row.name;
      const active = route.rtab === 'util' && route.util === name;
      let itemClass = 'tu-nav-item';
      if (active) itemClass = 'tu-nav-item active';
      //M 点了显示这个工具文件的说明，两栏。
      const onClick = (): void => onSelectUtil(name);
      return (
        <div className="tu-side-row">
          <button type="button" className={itemClass} aria-current={active} title={name} onClick={onClick}>
            <span className="tu-menu-item"><span className="tu-menu-name">{name.replace(/\.ts$/u, '')}</span></span>
          </button>
        </div>
      );
    }
    if (row.kind === 'reading') {
      const name = row.name;
      //M 去掉扩展名显示文件名，选择时仍使用带扩展名的完整名称。
      const label = name.replace(/^cordis\//u, '').slice(0, -3) || name;
      const active = route.rtab === 'reading' && route.reading === name;
      let itemClass = 'tu-nav-item';
      if (active) {
        itemClass = 'tu-nav-item active';
      }
      return (
        <div className="tu-side-row">
          <button
            type="button"
            className={itemClass}
            aria-current={active}
            title={label}
            onClick={
              //M 选择对应的文档并展开右栏。
              () => onSelectReading(name)
            }
          >
            <span className="tu-menu-item"><span className="tu-menu-name">{label}</span></span>
          </button>
        </div>
      );
    }
    if (row.kind === 'boot') {
      return (
        <div className="tu-side-row">
          <button
            type="button"
            className={bootItemClass}
            onClick={
              //M 选中「启动流程」画布展示当次启动轨迹与泳道图。
              () => onSelectCanvas('boot')
            }
          >
            <span className="tu-menu-item">
              <span className="tu-menu-name">启动流程 (boot)</span>
            </span>
          </button>
        </div>
      );
    }
    if (row.kind === 'route') {
      return (
        <div className="tu-side-row">
          <RouteStopItem
            index={row.index}
            stop={FEISHU_ROUTE[row.index]!}
            pluginNames={pluginNames}
            onSelectPlugin={
              //M 点路线上的插件标签，右栏看这个插件的事件。
              (name, ptab) => onSelectPlugin(name, ptab, !route.doc)
            }
          />
        </div>
      );
    }
    if (row.kind === 'message') {
      return (
        <div className="tu-side-row">
          {
            //M 交由最近消息条目渲染函数输出渠道标签、摘要与时钟。
            renderMessageNav(row.message)
          }
        </div>
      );
    }
    return <p className="tu-muted tu-side-empty">{row.text}</p>;
  };

  let leftStyle: { width?: number } = {};
  let rightStyle: { width?: number | string; left?: number; maxWidth?: number | string } = {};
  if (!isNarrow) {
    leftStyle = { width: clampedLeftWidth };
    rightStyle = { width: clampedRightWidth };
    if (contentOnly) rightStyle = { left: mindLeft, width: 'auto', maxWidth: 'none' };
  }

  return (
    <antd.ConfigProvider
      theme={
        //M 将页面当前选中的主题色板注入 Ant Design 容器（如空状态、表格、标签）。
        theme.antdTheme(themeSpec)
      }
      locale={zhCN}
    >
      <TutorialWorkspaceContext.Provider value={workspace}>
        {contextHolder}
        <div className="tu-page">
          <header className="tu-top">
            <div className="tu-top-left">
              <span className="tu-brand">jmbots 教程</span>
              {topSummary !== '' && <span className="tu-top-summary">{topSummary}</span>}
            </div>
            <div className="tu-top-right">
              <div className="tu-view-choice" role="group" aria-label={viewLabel}>
                <button type="button" data-look="lane" aria-pressed={!showMind}
                  onClick={() => tutorialView.select('canvas')}>{canvasLabel}</button>
                <button type="button" data-look="mind" aria-pressed={showMind}
                  onClick={() => tutorialView.select('mind')}>{mindLabel}</button>
              </div>
              {route.event !== '' && (
                <button
                  type="button"
                  className="tu-event-pill active"
                  title="点击清除画布事件高亮"
                  onClick={() => navigate({ ...route, event: '' })}
                >
                  高亮：{route.event} ×
                </button>
              )}
              <a
                className="tu-link"
                href={
                  //M 为返回聊天主页的链接附带统一鉴权令牌。
                  withToken('/', TOKEN)
                }
                style={{ textDecoration: 'none' }}
              >
                返回聊天
              </a>
              <button type="button" className="tu-link" onClick={load}>刷新</button>
            </div>
          </header>

          <div className={bodyClass}>
            {/* 最底层：全视口泳道画布舞台，在左右两浮栏后面全幅铺开。 */}
            {!contentOnly && !canvasesLoaded && route.canvas === SENTINEL_AUTO && (
              <div className="tu-stage">
                <div className="tu-stage-center"><antd.Spin /></div>
              </div>
            )}
            {!contentOnly && hasRealCanvas && (
              <CanvasStage
                name={route.canvas}
                step={route.step}
                onPick={onPickStep}
                onPickArrow={onPickArrow}
                keyword={keyword}
                hasSnapshot={activeMessage?.hasSnapshot}
                pluginNames={pluginNames}
                activePlugin={resolvedPluginName}
                highlightEvent={route.event}
                onSelectPlugin={
                  //M 泳道上点插件名留在三栏，右侧看说明。
                  (name) => onSelectPlugin(name, undefined, true)
                }
                onClearEvent={() => navigate({ ...route, event: '' })}
                onTrailLoaded={handleTrailLoaded}
                leftOpen={!leftCollapsed}
                leftWidth={clampedLeftWidth}
                rightOpen={!rightCollapsed}
                rightWidth={clampedRightWidth}
                isNarrow={isNarrow}
              />
            )}
            {!contentOnly && !hasRealCanvas && canvasesLoaded && route.canvas !== SENTINEL_AUTO && (
              <div className="tu-stage">
                <div className="tu-stage-center">
                  <p className="tu-muted">请在左栏选择「启动流程」或任意一条「最近消息」查看实时流程画布</p>
                </div>
              </div>
            )}

            {!contentOnly && showMind && (
              <mind.TutorialMindMap
                plugins={pluginList}
                trail={mindTrail}
                canvas={route.canvas}
                left={mindLeft}
                right={mindRight}
                t={t}
                onPick={onMindPick}
                plugin={route.plugin}
                onSelectPlugin={onLinesPlugin}
                programs={programs}
                mode={mindTree.mode}
                detailHost={lineDetailHost}
                onLineDetail={onLineDetail}
              />
            )}

            {/* 悬浮左栏：展开时是带阴影的卡片，收起时退成边缘一条按钮。 */}
            {!isNarrow && leftCollapsed && (
              <button
                type="button"
                className="tu-edge-toggle tu-edge-left"
                title="展开左侧导航"
                onClick={
                  //M 点击边缘窄条按钮展开左侧导航浮栏。
                  () => toggleLeftCollapsed(false)
                }
              >
                ▶ 导航
              </button>
            )}
            {(isNarrow || !leftCollapsed) && (
              <aside className="tu-side tu-float-left" style={leftStyle}>
                <div className="tu-side-top">
                  <div className="tu-side-search">
                    <antd.Input
                      size="small"
                      allowClear
                      placeholder="搜索插件、消息、飞书/网页…"
                      value={searchText}
                      onChange={(event) => setSearchText(event.target.value)}
                    />
                  </div>
                  {!isNarrow && (
                    <button
                      type="button"
                      className="tu-collapse-btn"
                      title="收起左栏，让画布更大"
                      onClick={
                        //M 收起左侧浮栏并记住开关，腾出更多画布浏览视野。
                        () => toggleLeftCollapsed(true)
                      }
                    >
                      ◀
                    </button>
                  )}
                </div>

                {error !== '' && <p className="tu-error tu-side-err">{error}</p>}

                <virtuoso.Virtuoso
                  className="tu-side-virt"
                  style={{ flex: 1, minHeight: 0 }}
                  data={leftRows}
                  computeItemKey={(_index, row) => row.key}
                  components={LEFT_LIST_COMPONENTS}
                  itemContent={
                    //M 使用左栏唯一自带滚条的虚拟列表逐行渲染分组头、细线、骨架、插件与消息。
                    (_index, row) => renderLeftRow(row)
                  }
                />

                {!isNarrow && (
                  <div
                    className="tu-resizer tu-resizer-right"
                    role="separator"
                    aria-orientation="vertical"
                    title="拖动调整左栏宽度（220px ~ 视口 45%）"
                    onMouseDown={startLeftResize}
                  />
                )}
              </aside>
            )}

            {/* 悬浮右栏：顶上「这一步」「插件」两页签；展开带左边缘拖宽，收起退成窄条。 */}
            {!isNarrow && !contentOnly && rightCollapsed && (
              <button
                type="button"
                className="tu-edge-toggle tu-edge-right"
                title="展开右侧详情与插件栏"
                onClick={
                  //M 点击右侧边缘按钮重新展开详情与插件浮栏。
                  () => toggleRightCollapsed(false)
                }
              >
                ◀ 详情
              </button>
            )}
            {(isNarrow || contentOnly || !rightCollapsed) && (
              <aside className="tu-plugin-pane tu-float-right" style={rightStyle}>
                {!isNarrow && !contentOnly && (
                  <div
                    className="tu-resizer tu-resizer-left"
                    role="separator"
                    aria-orientation="vertical"
                    title="拖动调整右栏宽度（不超过剩余空间的一半）"
                    onMouseDown={startRightResize}
                  />
                )}
                <div className="tu-pane-inner">
                  <div className="tu-pane-bar">
                    <div className="tu-rtabs" role="tablist">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={route.rtab === 'step'}
                        className={stepTabClass}
                        onClick={() => navigate({ ...route, rtab: 'step', doc: false })}
                      >
                        这一步
                        {route.step > 0 && <span className="tu-rtab-badge">#{String(route.step)}</span>}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={route.rtab === 'plugin'}
                        className={pluginTabClass}
                        onClick={() => navigate({ ...route, rtab: 'plugin' })}
                      >
                        插件
                        {hasPluginName && <span className="tu-rtab-badge">{resolvedPluginName}</span>}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={route.rtab === 'reading'}
                        className={readingTabClass}
                        onClick={
                          //M 回到先前在右栏阅读的组块。
                          () => navigate({ ...route, rtab: 'reading' })
                        }
                      >
                        {readingLabel}
                      </button>
                    </div>
                    <div className="tu-pane-bar-actions">
                      {!isNarrow && !contentOnly && (
                        <button
                          type="button"
                          className="tu-collapse-btn"
                          title="收起右栏，让画布更大"
                          onClick={
                            //M 收起右侧浮栏并记住开关，腾出更多画布空间。
                            () => toggleRightCollapsed(true)
                          }
                        >
                          收起 ▶
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="tu-pane-body" ref={attachRightScroll}>
                    <TutorialScrollContext.Provider value={rightScrollParent}>
                      {route.rtab === 'step' && showMind && mindTree.mode === 'lines' && !contentOnly && (
                        <div className="tu-line-detail-host" ref={setLineDetailHost} />
                      )}
                      {route.rtab === 'step' && (!showMind || mindTree.mode !== 'lines' || contentOnly) && (
                        <>
                          {pickedStep !== undefined && activeTrail !== null && hasRealCanvas && (
                            <StepDetail
                              canvas={route.canvas}
                              trail={activeTrail}
                              step={pickedStep}
                              workspace={workspace}
                              keyword={keyword}
                              pluginNames={pluginNames}
                              highlightEvent={route.event}
                              onSelectPlugin={
                                //M 步骤详情里点插件名留在三栏。
                                (name) => onSelectPlugin(name, undefined, true)
                              }
                              onSelectEvent={onSelectEvent}
                            />
                          )}
                          {(pickedStep === undefined || activeTrail === null || !hasRealCanvas) && (
                            <div className="tu-pane-empty">
                              <p>在左侧选画布，或在画布点任意一步</p>
                              <p className="tu-muted">
                                选中某一步后，这里会列出这一步走到的函数（支持直开 VS Code）、发出的事件、谁调它以及运行时变量快照；在这里滚动到底时，画布始终稳稳停在底层原地。
                              </p>
                              {hasPluginName && (
                                <button
                                  type="button"
                                  className="tu-step-plugin-btn"
                                  onClick={() => navigate({ ...route, rtab: 'plugin' })}
                                >
                                  去看 {resolvedPluginName} 插件说明与代码 →
                                </button>
                              )}
                            </div>
                          )}
                        </>
                      )}

                      {route.rtab === 'reading' && route.reading === '' && (
                        <p className="tu-muted">{t('在左栏选择一篇组块')}</p>
                      )}
                      {route.rtab === 'reading' && route.reading !== '' && (
                        <ReadingView
                          key={route.reading}
                          name={route.reading}
                          loadingLabel={readingLoadingLabel}
                          errorLabel={readingErrorLabel}
                          onHashLink={onReadingHash}
                        />
                      )}

                      {route.rtab === 'util' && route.util !== '' && (
                        <ReadingView
                          key={`util:${route.util}`}
                          name={route.util}
                          util
                          loadingLabel={utilsLoadingLabel}
                          errorLabel={utilsErrorLabel}
                        />
                      )}

                      {route.rtab === 'plugin' && isProcess && (
                        <programView.ProgramView
                          key={resolvedPluginName}
                          name={programName ?? ''}
                          programs={programs}
                          onOpenHandshake={onOpenHandshake}
                          onSelectProgram={onSelectProgram}
                        />
                      )}
                      {route.rtab === 'plugin' && !isProcess && (
                        <>
                          {plugins === null && error === '' && <antd.Spin />}
                          {plugins !== null && !hasPluginName && (
                            <div className="tu-pane-empty">
                              <p>在左栏「骨架」或「插件」列选一项，或点画布泳道名字</p>
                              <p className="tu-muted">可以看到每个骨架模块与插件的拆标签说明、状态、源码与 HTTP 接口调试，列表中的源码位置全部可点开 VS Code。</p>
                            </div>
                          )}
                          {plugins !== null && hasPluginName && activePlugin === undefined && (
                            <antd.Empty description={`没有找到插件 ${resolvedPluginName}`} />
                          )}
                          {activePlugin !== undefined && (
                            <PluginView
                              plugin={activePlugin}
                              pluginNames={pluginNames}
                              activeTab={route.ptab}
                              onTabChange={(nextKey) => navigate({ ...route, ptab: nextKey })}
                              activeEvent={route.event}
                              onSelectEvent={onSelectEvent}
                              onSelectPlugin={
                                //M 从插件详情内部的依赖/路由跳转到目标插件说明视图。
                                (name) => onSelectPlugin(name, undefined, !route.doc)
                              }
                            />
                          )}
                        </>
                      )}
                    </TutorialScrollContext.Provider>
                  </div>
                </div>
              </aside>
            )}
          </div>
        </div>
      </TutorialWorkspaceContext.Provider>
    </antd.ConfigProvider>
  );
}
