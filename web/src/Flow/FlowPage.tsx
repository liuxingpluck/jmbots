/**
 * 插件预览页（/flow/，flow 插件托管）：默认看 CLI、骨架、各插件和它们的依赖/监听关系；点一个插件看它干什么、声明了哪些事件。
 * 「看启动」：/api/flow/boot（boot-trail 插件记的这次启动），和请求轨迹同一个格式，同一张画布；右栏每步列代码位置、关键变量、代码自己的注释。
 * 2026-11-16 加「请求轨迹」：右栏列最近的真实请求（也可以点「发一条测试请求」现发一条），选中一条，
 * 图上按先后给经过的插件标号、把一步步的线点亮，右栏按顺序列出每一步干了什么、用了多久、哪一行代码；出错的标红。
 * 不露对话内容：只显示事件名、听的人、代码位置、工具名、模型、状态。
 * 画布铺满标题栏以下，左右两栏浮在上面（SidePane）：拖内侧边框改宽度、能收起成窄边（useSides），宽度和收起状态记在浏览器本地。
 * 右栏（SideShell）上面固定（标题、第几步、标签页），下面单独滚动；标签页「这一步」和「运行时变量」（RuntimeState：没点中步时每 3 秒读 /api/flow/state；
 * 点中轨迹的一步时读 /api/flow/snapshot，看那一步当时的快照，和上一步比变了的标黄，能切回现在），选中哪个也记在本地。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import JsonView from '@uiw/react-json-view';
import { darkTheme } from '@uiw/react-json-view/dark';
import { FlowCanvas } from './FlowCanvas.tsx';
import { Guide } from '../Guide/Guide.tsx';
import { FLOW_STEPS } from '../Guide/steps-flow.ts';
import { get, post, type FlowDetail, type DetailLine, type CodeDoc, type FlowGraph, type FunctionSource, type GraphEdge, type GraphNode, type RequestItem, type Snapshot, type StateGroup, type Trail, type TrailStep } from './FlowApi.ts';


const EMPTY: FlowGraph = { nodes: [], edges: [], problems: [] };

const STATE_LABEL: Record<string, string> = {
  ok: '已挂上',
  failed: '没挂上',
  waiting: '没开工',
  idle: '未配置',
};

const TRAIL_STATE: Record<string, string> = {
  done: '已回完',
  running: '还在跑',
  failed: '出错',
  stopped: '停了',
  unknown: '没找到收尾',
};


/** 毫秒写成人看的：不到 1 秒写毫秒，否则写秒。 */
export function duration(ms: number): string {
  return ms < 1000 ? `${String(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hourCycle: 'h23' });
}

/** 启动轨迹的消息号是 0（/api/flow/boot 交回的），按它认出是“看启动”。 */
function isBoot(trail: Trail): boolean {
  return trail.message === 0;
}

/** 读地址栏里的 boot / session / message / step / lanes，刷新以后还能回到同一条轨迹。右栏的标签页记在浏览器本地（Sides.tab），不进地址栏。 */
export function paramsOf(search: string): { boot: boolean; session: string; message: number; step: number; lanes: boolean; showHeard: boolean } {
  const query = new URLSearchParams(search);
  const message = Number.parseInt(query.get('message') ?? '', 10);
  const step = Number.parseInt(query.get('step') ?? '', 10);
  return {
    boot: query.get('boot') === '1',
    session: (query.get('session') ?? '').trim(),
    message: Number.isSafeInteger(message) && message > 0 ? message : 0,
    step: Number.isSafeInteger(step) && step > 0 ? step : 0,
    lanes: query.get('lanes') !== '0',
    showHeard: query.get('heard') !== '0',
  };
}

/** 把当前轨迹写回地址栏（不刷新，也不把 token 写回去）。trail 是 null 时清掉轨迹那几项。 */
function writeParams(trail: Trail | null, step: number | null, lanes: boolean, showHeard: boolean): void {
  const url = new URL(window.location.href);
  const session = trail?.session ?? '';
  const message = trail?.message ?? 0;
  if (trail !== null && isBoot(trail)) url.searchParams.set('boot', '1');
  else url.searchParams.delete('boot');
  if (session !== '') url.searchParams.set('session', session);
  else url.searchParams.delete('session');
  if (message > 0) url.searchParams.set('message', String(message));
  else url.searchParams.delete('message');
  if (step !== null && step > 0) url.searchParams.set('step', String(step));
  else url.searchParams.delete('step');
  if (!lanes) url.searchParams.set('lanes', '0');
  else url.searchParams.delete('lanes');
  //G 0.7.9 以前标签页记在地址栏，旧链接里的 tab 清掉。
  url.searchParams.delete('tab');
  if (!showHeard) url.searchParams.set('heard', '0');
  else url.searchParams.delete('heard');
  window.history.replaceState(window.history.state, '', url.toString());
}

/** 代码位置只留相对的那截（插件目录或文件名:行号），不把整段磁盘路径画到页面上。 */
export function shortSite(site: string): string {
  const norm = site.replaceAll('\\', '/');
  const markers = ['/src7/', '/plugins/', '/web/src/'];
  for (const mark of markers) {
    const at = norm.lastIndexOf(mark);
    if (at >= 0) return norm.slice(at + (mark === '/plugins/' ? 1 : mark.length));
  }
  const parts = norm.split('/');
  return parts.slice(-2).join('/');
}

/**
 * 把 journal 记下的“文件:行号”拼成 vscode://file/绝对路径:行。
 * 工作区是源码根；找不到根、位置不明时不给链接。源码里不写死盘符路径。
 * @param workspace 源码根目录。
 * @param site journal 的位置（可能是相对运行时目录的路径）。
 */
export function vscodeHref(workspace: string, site: string): string | null {
  const norm = site.trim().replaceAll('\\', '/');
  if (norm === '' || norm === '位置不明') return null;
  const match = /^(.+):(\d+)$/.exec(norm);
  if (match === null) return null;
  const file = match[1] ?? '';
  const line = match[2] ?? '';
  if (file === '' || line === '') return null;
  if (/^[A-Za-z]:\//.test(file) || file.startsWith('/')) return `vscode://file/${file}:${line}`;
  const root = workspace.replaceAll('\\', '/').replace(/\/+$/u, '');
  if (root === '') return null;
  let rel = file;
  const prefixed = rel.startsWith('/') ? rel : `/${rel}`;
  for (const mark of ['/src7/', '/web/', '/local/', '/scripts/']) {
    const at = prefixed.lastIndexOf(mark);
    if (at >= 0) {
      rel = prefixed.slice(at + 1);
      break;
    }
  }
  if (!rel.includes('/') && /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(rel)) rel = `src7/${rel}`;
  if (rel.startsWith('plugins/')) rel = `src7/${rel}`;
  if (/^(?:Flow|Panel|Bots|Guide|Chat)\//u.test(rel)) rel = `web/src/${rel}`;
  return `vscode://file/${root}/${rel}:${line}`;
}

/** 这一步里的关键函数：同名同位置合并计数，事件行不算。 */
export function keyFunctionsOf(step: TrailStep): { name: string; site: string; raw: string; count: number }[] {
  const map = new Map<string, { name: string; site: string; raw: string; count: number }>();
  for (const row of step.rows) {
    if (row.kind !== '函数' || row.name === '') continue;
    const site = shortSite(row.site);
    const key = `${row.name}\0${site}`;
    const prev = map.get(key);
    if (prev !== undefined) prev.count += 1;
    else map.set(key, { name: row.name, site, raw: row.site, count: 1 });
  }
  return [...map.values()];
}

/** 小号 VS Code 图标，给打开源码用。 */
function VsCodeIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path fill="currentColor" d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 19.61V4.39a1.5 1.5 0 0 0-.85-1.803zm-2.226 15.012-8.784-6.35v-.01l8.784-6.35z" />
    </svg>
  );
}

function VsCodeOpen(props: { workspace: string; site: string }): JSX.Element | null {
  const href = vscodeHref(props.workspace, props.site);
  if (href === null) return null;
  return (
    <a className="fl-vscode" href={href} title="在 VS Code 里打开" aria-label="在 VS Code 里打开">
      <VsCodeIcon />
    </a>
  );
}


/** 右栏的标签页：这一步（没开轨迹时是概览或插件详情）、变量 / 详情（debug 插件的，只有请求轨迹有）、运行时变量。 */
type SideTab = 'steps' | 'vars' | 'state';

/** 左右两栏的宽度（像素，收起后展开回到这个宽）、展开没有、右栏选中的标签页。两栏浮在画布上面，画布铺满。 */
interface Sides {
  left: number;
  right: number;
  leftOpen: boolean;
  rightOpen: boolean;
  tab: SideTab;
}

/** 每栏最窄多少像素（用户 11-16 定）。 */
const MIN_SIDE = 200;
/** 每栏最宽占窗口多少。 */
const MAX_SIDE = 0.45;
/** 收起后那条窄边多宽，像素。 */
const FOLDED_SIDE = 28;
const DEFAULT_SIDES: Sides = { left: 228, right: 340, leftOpen: true, rightOpen: true, tab: 'steps' };
/** 浏览器本地存宽度、收起状态、标签页用的键。 */
const SIDES_KEY = 'jmbots.flow.sides';


/**
 * 把两栏宽度各自收进 MIN_SIDE 到窗口的 MAX_SIDE。画布在底下铺满，两栏不用互相让。
 * @param total 窗口宽度。
 * @param wanted 想要的宽度和展开状态。
 */
export function clampSides(total: number, wanted: Sides): Sides {
  const fit = (value: number): number => Math.round(Math.max(MIN_SIDE, Math.min(total * MAX_SIDE, value)));
  return { ...wanted, left: fit(wanted.left), right: fit(wanted.right) };
}


/** 读记下的两栏宽度、收起状态、标签页；没记过、坏了、读不了都用默认（旧版没存的项按展开、「这一步」算）。 */
function loadSides(): Sides {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SIDES_KEY) ?? 'null') as Partial<Sides> | null;
    if (typeof saved?.left === 'number' && typeof saved.right === 'number') {
      const tab = saved.tab === 'vars' || saved.tab === 'state' ? saved.tab : 'steps';
      return { left: saved.left, right: saved.right, leftOpen: saved.leftOpen !== false, rightOpen: saved.rightOpen !== false, tab };
    }
  } catch {
    //G 浏览器不让读本地存储（隐私模式等）：用默认。
  }
  return { ...DEFAULT_SIDES };
}


/** 记下两栏宽度和收起状态；存不了就不存，下次用默认。 */
function saveSides(sides: Sides): void {
  try {
    window.localStorage.setItem(SIDES_KEY, JSON.stringify(sides));
  } catch {
    //G 浏览器不让写本地存储：不存。
  }
}


/**
 * 左右两栏的宽度、拖边框、收起展开、右栏标签页，两栏共用。拖动写法照 web/src/Layout/Columns.tsx 的 startDrag。
 * @returns sides 现在用的；startDrag(哪栏) 给边框的 onPointerDown，松手时记下；update(改哪几项) 收起展开、换标签页，当场记下。
 */
function useSides(): {
  sides: Sides;
  startDrag: (which: 'left' | 'right') => (event: ReactPointerEvent<HTMLDivElement>) => void;
  update: (patch: Partial<Sides>) => void;
} {
  const [total, setTotal] = useState(() => window.innerWidth);
  const [wanted, setWanted] = useState(loadSides);
  const sides = clampSides(total, wanted);

  useEffect(() => {
    const onResize = (): void => setTotal(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  //M 左边框往右拖左栏变宽；右边框往右拖右栏变窄。
  const startDrag = (which: 'left' | 'right') => (event: ReactPointerEvent<HTMLDivElement>): void => {
    const startX = event.clientX;
    const start = sides;
    let last = sides;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('fl-dragging');
    const onMove = (move: PointerEvent): void => {
      const delta = move.clientX - startX;
      const next = which === 'left' ? { ...start, left: start.left + delta } : { ...start, right: start.right - delta };
      last = clampSides(window.innerWidth, next);
      setWanted(last);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('fl-dragging');
      saveSides(last);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const update = (patch: Partial<Sides>): void => {
    const next = { ...sides, ...patch };
    setWanted(next);
    saveSides(next);
  };

  return { sides, startDrag, update };
}


/**
 * 浮在画布上的一栏，左右共用：展开时是内容加内侧的拖动边框和“收起”小把手；收起时是一条 FOLDED_SIDE 宽的窄边，上面展开按钮和竖排的栏名。
 * @param props.which 左栏还是右栏。
 * @param props.title 收起后竖排显示的栏名。
 * @param props.width 展开时的宽度。
 * @param props.open 展开没有。
 * @param props.onDrag 边框的 onPointerDown（useSides 的 startDrag）。
 * @param props.onToggle 收起、展开（useSides 的 toggle）。
 */
function SidePane(props: {
  which: 'left' | 'right';
  title: string;
  width: number;
  open: boolean;
  onDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggle: () => void;
  children: ReactNode;
}): JSX.Element {
  const { which, title, width, open, onDrag, onToggle, children } = props;
  //M 左栏收起往左指，右栏收起往右指。
  const foldMark = which === 'left' ? '‹' : '›';
  const openMark = which === 'left' ? '›' : '‹';
  if (!open) {
    return (
      <div className={`fl-pane fl-pane-${which} folded`} style={{ width: FOLDED_SIDE }}>
        <button type="button" className="fl-pane-open" onClick={onToggle} title={`展开${title}`}>{openMark}</button>
        <span className="fl-pane-title">{title}</span>
      </div>
    );
  }

  return (
    <div className={`fl-pane fl-pane-${which}`} style={{ width }}>
      {children}
      <div className="fl-splitter" role="separator" aria-orientation="vertical" aria-label={`拖动改${title}宽度`} onPointerDown={onDrag} />
      <button type="button" className="fl-pane-fold" onClick={onToggle} title={`收起${title}`}>{foldMark}</button>
    </div>
  );
}


/**
 * 右栏的壳子：上面一块固定不滚（标题、第几步、上一步/下一步、标签页），下面内容区单独滚动。
 * 启动轨迹、请求轨迹、概览、插件详情共用。
 * @param props.head 固定区里标签页上面的东西；没有就只有标签页。
 * @param props.tabs 有哪几个标签页：[键, 显示的字]。
 * @param props.tab 选中的。
 * @param props.onTab 点了哪个（useSides 的 update 记下）。
 */
function SideShell(props: {
  head?: ReactNode;
  tabs: [SideTab, string][];
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <aside className="fl-side">
      <div className="fl-side-head">
        {props.head}
        <div className="fl-tabs">
          {props.tabs.map(([key, label]) => (
            <button key={key} type="button" className={key === props.tab ? 'on' : ''} onClick={() => props.onTab(key)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="fl-side-body">{props.children}</div>
    </aside>
  );
}


export function FlowPage(): JSX.Element {
  const { sides, startDrag, update } = useSides();
  //M 两栏盖住画布左右多宽：React Flow 的控制按钮、小地图往里让这么多（Flow.css 的 --fl-left、--fl-right），镜头起点也让开左栏。
  const leftInset = sides.leftOpen ? sides.left : FOLDED_SIDE;
  const rightInset = sides.rightOpen ? sides.right : FOLDED_SIDE;
  const [graph, setGraph] = useState<FlowGraph>(EMPTY);
  const [banner, setBanner] = useState('正在读取插件图…');
  const [selected, setSelected] = useState<string | null>(null);
  const [focusSeq, setFocusSeq] = useState(0);
  const [showAllEdges, setShowAllEdges] = useState(false);
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [trail, setTrail] = useState<Trail | null>(null);
  const [activeStep, setActiveStep] = useState<number | null>(null);
  const [lanes, setLanes] = useState(true);
  const [showHeard, setShowHeard] = useState(true);
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [notice, setNotice] = useState('');
  const [bots, setBots] = useState<string[]>([]);
  const [bot, setBot] = useState('');
  const [sending, setSending] = useState(false);
  /** 运行时变量的组名；读到 /api/flow/state 之前先用骨架那几组。 */
  const [stateNames, setStateNames] = useState(['main', 'resources', 'tools', 'sessions', 'bots']);
  /** 左栏点了哪一组（seq 每点一次加一，同一组再点也会重新展开、滚过去）。 */
  const [stateFocus, setStateFocus] = useState({ name: '', seq: 0 });

  const load = async () => {
    setBanner('正在读取插件图…');
    try {
      const next = await get<FlowGraph>('/api/flow/graph');
      setGraph(next);
      setBanner(next.problems.length > 0 ? next.problems.join('；') : '');
    } catch (error) {
      setBanner(`读取失败：${(error as Error).message}`);
    }
  };

  const loadRequests = useCallback(async () => {
    try {
      //M 列表里已经带着用户那句话（flow 的 /api/flow/requests）。
      const result = await get<{ list: RequestItem[] }>('/api/flow/requests?limit=12');
      setRequests(result.list);
    } catch (error) {
      setNotice(`读不到最近的请求：${(error as Error).message}`);
    }
  }, []);

  //M boot 为 true 时看这次启动（/api/flow/boot），不然看一条请求（/api/flow/trail）。两种轨迹同一个格式。
  const openTrail = useCallback(async (opts: { boot?: boolean; message?: number; session?: string; step?: number }): Promise<Trail | null> => {
    try {
      const query = new URLSearchParams();
      if (opts.message !== undefined && opts.message > 0) query.set('message', String(opts.message));
      if (opts.session !== undefined && opts.session !== '') query.set('session', opts.session);
      if (opts.boot !== true && query.toString() === '') {
        setNotice('先给会话 id 或消息号');
        return null;
      }
      const result = opts.boot === true
        ? await get<Trail>('/api/flow/boot')
        : await get<Trail>(`/api/flow/trail?${query.toString()}`);
      const step = opts.step !== undefined && opts.step > 0 && result.steps.some((item) => item.no === opts.step)
        ? opts.step
        : (result.steps[0]?.no ?? null);
      setTrail(result);
      setActiveStep(step);
      setSelected(null);
      //G 启动轨迹没有消息号，没有「变量 / 详情」。
      if (isBoot(result)) {
        setDetail(null);
        return result;
      }
      void get<FlowDetail>(`/api/flow/detail?message=${String(result.message)}`).then(setDetail, () => setDetail(null));
      return result;
    } catch (error) {
      setNotice((error as Error).message);
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
    void loadRequests();
    void get<{ name: string }[]>('/api/bots').then((list) => {
      const names = list.map((item) => item.name);
      setBots(names);
      setBot(names.includes('助手') ? '助手' : names[0] ?? '');
    }).catch(() => undefined);
    //M 运行时变量有哪几组：点左栏时认得哪些该切过去，标签上也显示组数。插件在启动时登记，进页读一次够了。
    void get<{ groups: StateGroup[] }>('/api/flow/state').then((result) => {
      setStateNames(result.groups.map((item) => item.name));
    }, () => undefined);
  }, [loadRequests]);

  //M 网址带 ?session= / ?message= / ?step= 时直接打开那条请求，刷新也不会丢。
  useEffect(() => {
    const params = paramsOf(window.location.search);
    setLanes(params.lanes);
    setShowHeard(params.showHeard);
    if (params.boot || params.message > 0 || params.session !== '') {
      void openTrail({ boot: params.boot, message: params.message, session: params.session, step: params.step });
    }
    // 只在进页时读一次地址栏；之后由 writeParams 同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  //M 还在跑的请求每 1.5 秒刷新一次，直到回完。
  useEffect(() => {
    if (trail === null || trail.state !== 'running') return undefined;
    const timer = window.setTimeout(() => {
      void openTrail({ boot: isBoot(trail), message: trail.message, session: trail.session ?? '', step: activeStep ?? 0 }).then(() => loadRequests());
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [trail, activeStep, openTrail, loadRequests]);

  //M 轨迹、当前步、按步骤/结构图，随时写回地址栏，刷新还能回来。
  useEffect(() => {
    if (trail === null) return;
    writeParams(trail, activeStep, lanes, showHeard);
  }, [trail, activeStep, lanes, showHeard]);

  const probe = async () => {
    setSending(true);
    setNotice('');
    try {
      const sent = await post<{ message: number; text: string }>('/api/flow/probe', { bot });
      setNotice(`已发给「${bot}」：${sent.text}（消息 #${String(sent.message)}），图上会跟着它一步步亮起来。`);
      await openTrail({ message: sent.message });
      await loadRequests();
    } catch (error) {
      setNotice(`没发出去：${(error as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  const node = useMemo(
    () => graph.nodes.find((item) => item.id === selected) ?? null,
    [graph, selected],
  );

  const focusNode = (id: string) => {
    setSelected(id);
    setFocusSeq((value) => value + 1);
    //M 点的在运行时变量里有一组（骨架、bots、露了变量的插件）→ 右栏切到「运行时变量」，只展开它并滚过去；别的插件从运行时变量切回第一页看详情。
    if (stateNames.includes(id)) {
      update({ tab: 'state' });
      setStateFocus((prev) => ({ name: id, seq: prev.seq + 1 }));
    } else if (sides.tab === 'state') {
      update({ tab: 'steps' });
    }
  };

  const pickStep = (step: TrailStep) => {
    const next = step.no === activeStep ? null : step.no;
    setActiveStep(next);
    if (trail !== null) writeParams(trail, next, lanes, showHeard);
  };

  const gotoStep = (no: number) => {
    if (trail === null) return;
    const exists = trail.steps.some((item) => item.no === no);
    if (!exists) return;
    setActiveStep(no);
    setSelected(null);
    writeParams(trail, no, lanes, showHeard);
  };

  const toggleLanes = () => {
    const next = !lanes;
    setLanes(next);
    if (trail !== null) writeParams(trail, activeStep, next, showHeard);
  };

  const exitTrail = () => {
    setTrail(null);
    setActiveStep(null);
    setDetail(null);
    writeParams(null, null, true, true);
    setLanes(true);
  };

  const toggleHeard = () => setShowHeard((value) => !value);

  //M 右栏：第一个标签页随情况叫「这一步」「插件」「概览」；变量 / 详情只有请求轨迹才有；运行时变量一直有。
  const onTrail = node === null && trail !== null;
  let firstTab = '概览';
  if (onTrail) firstTab = '这一步';
  else if (node !== null) firstTab = '插件';
  const tabs: [SideTab, string][] = [['steps', firstTab]];
  if (onTrail && !isBoot(trail)) tabs.push(['vars', '变量 / 详情']);
  tabs.push(['state', `运行时变量 · ${String(stateNames.length)}`]);
  //G 记下的标签页这时没有（比如记的是变量 / 详情，现在看的是启动）→ 显示第一个，记下的不改。
  const tab = tabs.some(([key]) => key === sides.tab) ? sides.tab : 'steps';
  const sideHead = onTrail
    ? <TrailHead trail={trail} active={activeStep} onPrev={() => gotoStep((activeStep ?? 1) - 1)} onNext={() => gotoStep((activeStep ?? 0) + 1)} />
    : undefined;
  let sideBody: ReactNode;
  if (tab === 'state') {
    //M 轨迹里点中了一步：运行时变量默认看那一步时的快照。
    const pick = { message: trail?.message ?? 0, step: trail === null ? 0 : activeStep ?? 0 };
    sideBody = <RuntimeState focus={stateFocus} pick={pick} keyword={graph.snapshotKeyword ?? ''} />;
  } else if (node !== null) {
    sideBody = <Detail node={node} edges={graph.edges} trail={trail} onBack={() => setSelected(null)} />;
  } else if (trail === null) {
    sideBody = <Overview graph={graph} requests={requests} onOpen={(message) => { void openTrail({ message }); }} onRefresh={() => { void loadRequests(); }} />;
  } else if (tab === 'vars') {
    sideBody = <VarsView trail={trail} active={activeStep} detail={detail} />;
  } else {
    sideBody = <TrailView trail={trail} active={activeStep} workspace={graph.workspace ?? ''} onPick={pickStep} />;
  }

  return (
    <div className="fl-page">
      <header className="fl-bar">
        <div className="fl-title">
          <h1>插件预览</h1>
          <p>平时看 jmbots 的结构：CLI → 骨架三个服务 → 按分类分组的插件。右边选一条请求，中间按步骤排开：每个插件一条横道，第几步、干了什么、用了多久，出错标红。</p>
        </div>
        <div className="fl-tools">
          <div className="fl-probe" data-guide="probe">
            <select value={bot} onChange={(event) => setBot(event.target.value)} aria-label="发给哪个机器人">
              {bots.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <button type="button" onClick={() => { void probe(); }} disabled={sending || bot === ''}>
              {sending ? '发送中…' : '发一条测试请求'}
            </button>
          </div>
          <button type="button" className="fl-toggle" onClick={() => { void openTrail({ boot: true }); }}>
            看启动
          </button>
          <button
            type="button"
            className={`fl-toggle${showAllEdges ? ' on' : ''}`}
            onClick={() => setShowAllEdges((value) => !value)}
          >
            {showAllEdges ? '只看相关连线' : '显示全部连线'}
          </button>
          {trail !== null && (
            <button type="button" className="fl-toggle on" data-guide="lanes" onClick={toggleLanes}>
              {lanes ? '在结构图上看' : '按步骤看'}
            </button>
          )}
          {trail !== null && !lanes && (
            <button type="button" className={`fl-toggle${showHeard ? ' on' : ''}`} onClick={toggleHeard}>
              {showHeard ? '隐藏未动作的插件' : '显示未动作的插件'}
            </button>
          )}
          {trail !== null && <button type="button" className="fl-toggle" onClick={exitTrail}>退出轨迹</button>}
          <Guide steps={FLOW_STEPS} className="fl-guide" />
        </div>
      </header>
      {banner !== '' && <div className={`fl-banner${graph.problems.length > 0 ? ' warn' : ''}`}>{banner}</div>}
      {notice !== '' && <div className="fl-banner">{notice}</div>}
      <div className="fl-body" style={{ '--fl-left': `${String(leftInset)}px`, '--fl-right': `${String(rightInset)}px` } as CSSProperties}>
        <FlowCanvas
          graph={graph}
          trail={trail}
          activeStep={activeStep}
          lanes={lanes}
          onPickStep={(no) => {
            setSelected(null);
            if (trail === null) return;
            const next = no === activeStep ? null : no;
            setActiveStep(next);
            writeParams(trail, next, lanes, showHeard);
          }}
          selected={selected}
          focusSeq={focusSeq}
          showAllEdges={showAllEdges}
          showHeard={showHeard}
          onSelect={setSelected}
          inset={leftInset}
        />
        <SidePane which="left" title="插件" width={sides.left} open={sides.leftOpen} onDrag={startDrag('left')} onToggle={() => update({ leftOpen: !sides.leftOpen })}>
          <Nav graph={graph} selected={selected} onFocus={focusNode} />
        </SidePane>
        <SidePane which="right" title="详情" width={sides.right} open={sides.rightOpen} onDrag={startDrag('right')} onToggle={() => update({ rightOpen: !sides.rightOpen })}>
          <SideShell head={sideHead} tabs={tabs} tab={tab} onTab={(next) => update({ tab: next })}>
            {sideBody}
          </SideShell>
        </SidePane>
      </div>
    </div>
  );
}


function Nav(props: { graph: FlowGraph; selected: string | null; onFocus: (id: string) => void }): JSX.Element {
  const roots = props.graph.nodes.filter((node) => node.kind === 'cli' || node.kind === 'skeleton');
  const groups = new Map<string, GraphNode[]>();
  for (const node of props.graph.nodes) {
    if (node.kind !== 'plugin') continue;
    const list = groups.get(node.category) ?? [];
    list.push(node);
    groups.set(node.category, list);
  }
  return (
    <aside className="fl-nav">
      <div className="fl-nav-label">骨架</div>
      {roots.map((node) => (
        <NavItem key={node.id} node={node} selected={props.selected} onFocus={props.onFocus} />
      ))}
      {[...groups.entries()].map(([category, list]) => (
        <div key={category} className="fl-nav-group">
          <div className="fl-nav-label">{category} · {list.length}</div>
          {list.map((node) => (
            <NavItem key={node.id} node={node} selected={props.selected} onFocus={props.onFocus} />
          ))}
        </div>
      ))}
    </aside>
  );
}

function NavItem(props: { node: GraphNode; selected: string | null; onFocus: (id: string) => void }): JSX.Element {
  const { node } = props;
  const classes = [
    'fl-nav-item',
    `fl-node-${node.kind}`,
    `fl-state-${node.state}`,
    props.selected === node.id ? 'on' : '',
  ].filter(Boolean).join(' ');
  return (
    <button type="button" className={classes} onClick={() => props.onFocus(node.id)}>
      <span className="fl-dot" />
      <span className="fl-nav-name">{node.id}</span>
    </button>
  );
}


function Overview(props: { graph: FlowGraph; requests: RequestItem[]; onOpen: (message: number) => void; onRefresh: () => void }): JSX.Element {
  const counts = { ok: 0, failed: 0, waiting: 0, idle: 0 };
  for (const node of props.graph.nodes) {
    if (node.kind === 'skeleton' || node.kind === 'cli') continue;
    counts[node.state] += 1;
  }
  return (
    <div>
      <div className="fl-head-row">
        <h2>最近的请求</h2>
        <button type="button" className="fl-link" onClick={props.onRefresh}>刷新</button>
      </div>
      <p className="fl-muted">点一条，看它先后经过了哪些插件。下面是用户那句话的原文。</p>
      <ul className="fl-requests" data-guide="requests">
        {props.requests.length === 0 && <li className="fl-muted">还没有记录。点上面「发一条测试请求」发一条。</li>}
        {props.requests.map((item) => (
          <li key={item.message}>
            <button type="button" className={item.error ? 'error' : ''} onClick={() => props.onOpen(item.message)}>
              <span className="fl-req-top">
                <strong>#{item.message} {item.bot}</strong>
                <span>{clock(item.at)}</span>
              </span>
              {item.preview !== undefined && item.preview !== '' && <span className="fl-preview">{item.preview}</span>}
              <span className="fl-muted">
                {item.channel || '—'} · {item.steps} 步 · {duration(item.ms)} · {TRAIL_STATE[item.state] ?? item.state}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <h2 className="fl-gap">插件状态</h2>
      <ul className="fl-counts">
        <li>已挂上 {counts.ok}</li>
        <li>没挂上 {counts.failed}</li>
        <li>没开工 {counts.waiting}</li>
        <li>未配置 {counts.idle}</li>
      </ul>
      <p className="fl-muted">实线是谁听谁的事件，虚线是 inject 依赖；平时只画选中节点的线。红色是没挂上，橙色是缺服务没开工，灰色是配置里没挂。</p>
    </div>
  );
}


/** 轨迹在右栏固定区的部分：哪条轨迹、共几步、上一步/下一步。启动和请求轨迹共用，切到哪个标签页都在。 */
function TrailHead(props: { trail: Trail; active: number | null; onPrev: () => void; onNext: () => void }): JSX.Element {
  const { trail, active, onPrev, onNext } = props;
  const total = trail.steps.length;
  return (
    <div data-guide="trail">
      {isBoot(trail)
        ? (
          <>
            <p className="fl-kicker">这次启动 · {clock(trail.at)}</p>
            <h2>从 Main.ts 到开始收消息</h2>
            <p className={trail.error ? 'fl-error' : 'fl-muted'}>
              {trail.steps.length} 步 · 共 {duration(trail.ms)} · 每步的说明取自代码自己的注释
            </p>
          </>
        )
        : (
          <>
            <p className="fl-kicker">请求轨迹 · {clock(trail.at)}</p>
            <h2>#{trail.message} 发给 {trail.bot || '（未知）'}</h2>
            <p className={trail.error ? 'fl-error' : 'fl-muted'}>
              渠道 {trail.channel || '—'} · {trail.steps.length} 步 · 共 {duration(trail.ms)} · {TRAIL_STATE[trail.state] ?? trail.state}
            </p>
          </>
        )}
      <div className="fl-step-nav">
        <button type="button" disabled={active === null || active <= 1} onClick={onPrev}>上一步</button>
        <span>第 {active ?? '—'} / {total} 步</span>
        <button type="button" disabled={active === null || active >= total} onClick={onNext}>下一步</button>
      </div>
    </div>
  );
}


/** 轨迹「这一步」标签页：点中那步的代码、变量、函数，下面列全部步骤。 */
function TrailView(props: { trail: Trail; active: number | null; workspace: string; onPick: (step: TrailStep) => void }): JSX.Element {
  const { trail, active, workspace, onPick } = props;
  const current = trail.steps.find((item) => item.no === active) ?? null;
  return (
    <div>
      {current !== null && isBoot(trail) && <StepDocs step={current} workspace={workspace} notes={trail.notes} />}
      {current !== null && !isBoot(trail) && <StepVars key={current.no} step={current} notes={trail.notes} />}
      {current !== null && !isBoot(trail) && <KeyFunctions step={current} workspace={workspace} />}
      {current !== null && !isBoot(trail) && <ListenerList step={current} />}
      <ol className="fl-trail">
        {trail.steps.map((step) => (
          <li key={step.no} className={`${step.error ? 'error' : ''}${active === step.no ? ' on' : ''}`}>
            <button type="button" onClick={() => onPick(step)}>
              <span className="fl-no">{step.no}</span>
              <span className="fl-step-main">
                <span className="fl-step-top"><strong>{step.node}</strong><span className="fl-ms">{duration(step.ms)}</span></span>
                <span className="fl-step-title">{step.title}</span>
              </span>
            </button>
            {active === step.no && step.notified.length > 0 && (
              <p className="fl-muted fl-rows">收到通知、没留下动作：{step.notified.join('、')}</p>
            )}
          </li>
        ))}
      </ol>
      <p className="fl-muted">用上一步 / 下一步，或点列表里的一步。右边列出这一步的关键函数和代码位置。时间是这一步到下一步开始用了多久。</p>
    </div>
  );
}


function KeyFunctions(props: { step: TrailStep; workspace: string }): JSX.Element {
  const items = keyFunctionsOf(props.step);
  if (items.length === 0) {
    return <p className="fl-muted">这一步没有记下函数调用（多半只是事件通知）。</p>;
  }
  return (
    <div className="fl-fns">
      <h3>这一步的关键函数</h3>
      <ul>
        {items.map((item) => (
          <li key={`${item.name}-${item.site}`}>
            <code className="fl-fn-name">{item.name}</code>
            {item.count > 1 && <span className="fl-muted"> ×{item.count}</span>}
            {item.site !== '' && (
              <div className="fl-site">
                <span>{item.site}</span>
                <VsCodeOpen workspace={props.workspace} site={item.raw} />
              </div>
            )}
            <SourceToggle site={item.raw} />
            <CallerList site={item.raw} />
          </li>
        ))}
      </ul>
    </div>
  );
}



/**
 * 启动轨迹的一步：代码在哪、关键变量、这段代码自己的注释。
 * 重要的函数展开（干什么、输入、改了什么、输出、出错），不重要的只一句；取不到注释的标出原因，方便以后补。
 */
function StepDocs(props: { step: TrailStep; workspace: string; notes?: Record<string, string> }): JSX.Element {
  const { step, workspace, notes } = props;
  //M 这一步自己的函数原型已经在关键变量上面显示过，列表里不再重复；别的函数照常显示。
  const own = ownDoc(step);
  return (
    <div className="fl-fns">
      <h3>代码在哪</h3>
      {step.rows.map((row) => (
        <div key={`${row.name}-${row.site}`} className="fl-site">
          <code className="fl-fn-name">{row.name}</code>
          <span>{row.site}</span>
          <VsCodeOpen workspace={workspace} site={row.site} />
        </div>
      ))}
      <StepVars key={step.no} step={step} notes={notes} />
      <h3>用到的函数（注释取自代码）</h3>
      <ul>
        {(step.docs ?? []).map((doc) => (
          <li key={`${doc.name}-${doc.site}`}>
            <code className="fl-fn-name">{doc.name}</code>
            {doc.signature !== '' && doc !== own && <code className="fl-signature">{doc.signature}</code>}
            {doc.missing !== '' && <span className="fl-error"> {doc.missing}</span>}
            <div className="fl-site">
              <span>{doc.site}</span>
              <VsCodeOpen workspace={workspace} site={doc.site} />
            </div>
            {doc.summary !== '' && <p className="fl-muted">{doc.important ? doc.summary : doc.summary.split('\n')[0]}</p>}
            {doc.important && doc.params.length > 0 && (
              <p>输入：{doc.params.map((param) => `${param.name} ${param.text}`).join('；')}</p>
            )}
            {doc.important && doc.effects !== '' && <p>改了什么：{doc.effects}</p>}
            {doc.important && doc.returns !== '' && <p>输出：{doc.returns}</p>}
            {doc.important && doc.throws !== '' && <p>出错：{doc.throws}</p>}
            {doc.signature !== '' && <SourceToggle site={doc.site} />}
            {doc.signature !== '' && <CallerList site={doc.site} />}
          </li>
        ))}
      </ul>
    </div>
  );
}


/**
 * 一步的关键变量：只有一行带变量就是那行的 facts；几行都带就每行一项，标上函数名或事件名。
 * facts 是后端挑过的（boot-trail 记的那几项，请求轨迹只留 FACT_KEYS），这里不再挑。
 * @returns 没有变量是 undefined。
 */
function varsOfStep(step: TrailStep): unknown {
  const rows = step.rows.filter((row) => Object.keys(row.facts).length > 0);
  if (rows.length <= 1) return rows[0]?.facts;

  return rows.map((row) => ({ name: row.name, ...row.facts }));
}

/**
 * “看实现”：默认收起，点开才向后端要这个函数的完整源码（SourceView）。
 * @param props.site 文件:行号：启动轨迹给定义那一行，请求轨迹给跟踪点那一行（后端往上找它所在的函数）；没有行号不显示。
 */
function SourceToggle(props: { site: string; label?: string }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const match = /^(.+):(\d+)$/u.exec(props.site.trim().replaceAll('\\', '/'));
  if (match === null) return null;

  //M 按钮上的字：给了 label（“谁调它”里的调用处位置）就用它，不然是看实现 / 收起实现。
  const closed = props.label ?? '看实现';
  const word = open ? `收起 ${props.label ?? '实现'}` : closed;
  return (
    <div className="fl-src">
      <button type="button" className="fl-link" onClick={() => setOpen(!open)}>{word}</button>
      {open && <SourceView file={match[1] ?? ''} line={Number(match[2])} />}
    </div>
  );
}


/**
 * “谁调它”：向 /api/flow/source 要这个函数的 callers，每处调用列出位置（点开看那一段）、为什么调、那一行代码。
 * 调用处上方没写 //M 的标“调用处没写注释”，缺注释一眼看得出。
 * @param props.site 文件:行号，和“看实现”给的一样；没有行号不显示。
 */
function CallerList(props: { site: string }): JSX.Element | null {
  const [source, setSource] = useState<FunctionSource | null>(null);
  const [error, setError] = useState('');
  const match = /^(.+):(\d+)$/u.exec(props.site.trim().replaceAll('\\', '/'));
  const file = match?.[1] ?? '';
  const line = Number(match?.[2]);

  useEffect(() => {
    if (file === '') return;

    const query = `file=${encodeURIComponent(file)}&line=${String(line)}`;
    get<FunctionSource>(`/api/flow/source?${query}`).then(setSource, (err: unknown) => setError(String(err)));
  }, [file, line]);

  if (match === null) return null;
  if (error !== '') return <p className="fl-error">取不到谁调它：{error}</p>;
  if (source === null) return <p className="fl-muted">正在找谁调它…</p>;
  if (source.name === '') return null;
  if (source.callers.length === 0) return <p className="fl-muted">谁调它：src7 里没找到调用处（可能是事件回调、Cordis 调的）。</p>;

  return (
    <div className="fl-callers">
      <p className="fl-muted">谁调它（{source.callers.length} 处）：</p>
      <ul>
        {source.callers.map((caller) => (
          <li key={caller.site}>
            <SourceToggle site={caller.site} label={caller.site} />
            {caller.why === ''
              ? <span className="fl-error">调用处没写注释</span>
              : <span>为什么：{caller.why}</span>}
            <code className="fl-signature">{caller.code}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}


/**
 * 一个函数的源码：读 /api/flow/source，等宽、带源文件里的真实行号（行号不进复制），顶上“复制”复制整段。
 * 里面调到的、后端找得到定义的函数名做成能点的，点了在下面再展开那个函数（再套一层 SourceView），再点收起。
 * @param props.file 文件（后端会从最后一个 src7/ 截起）。
 * @param props.line 第几行。
 */
function SourceView(props: { file: string; line: number }): JSX.Element {
  const { file, line } = props;
  const [source, setSource] = useState<FunctionSource | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('复制');
  /** 点开的被调函数：名字和“文件:行号”，照点开的先后。 */
  const [opened, setOpened] = useState<{ name: string; site: string }[]>([]);

  useEffect(() => {
    const query = `file=${encodeURIComponent(file)}&line=${String(line)}`;
    get<FunctionSource>(`/api/flow/source?${query}`).then(setSource, (err: unknown) => setError(String(err)));
  }, [file, line]);

  if (error !== '') return <p className="fl-error">取不到源码：{error}</p>;
  if (source === null) return <p className="fl-muted">正在取源码…</p>;

  //M 被调函数名：拼成一个正则把每行切开，切出来的名字（奇数下标）做成按钮。
  const sites = new Map(source.calls.map((call) => [call.name, call.site]));
  const names = source.calls.map((call) => call.name.replaceAll('$', '\\$'));
  const pattern = names.length === 0 ? null : new RegExp(`(?<![\\w$])(${names.join('|')})(?=\\s*(?:<[^<>()]*>)?\\()`, 'u');
  const toggle = (name: string, site: string) => {
    const has = opened.some((item) => item.site === site);
    setOpened(has ? opened.filter((item) => item.site !== site) : [...opened, { name, site }]);
  };
  const lineView = (text: string): ReactNode => {
    if (pattern === null) return text;

    return text.split(pattern).map((part, index) => {
      const site = sites.get(part);
      if (index % 2 === 0 || site === undefined) return part;
      return <button key={index} type="button" className="fl-code-call" title={site} onClick={() => toggle(part, site)}>{part}</button>;
    });
  };

  return (
    <div className="fl-code-box">
      <div className="fl-head-row">
        <span className="fl-muted">
          {source.file}:{source.start}–{source.end}
          {source.cut && '（没找到函数结尾，只给了这几行）'}
        </span>
        <button type="button" className="fl-link" onClick={() => copyText(source.lines.join('\n'), setCopied)}>{copied}</button>
      </div>
      <pre className="fl-code">
        {source.lines.map((text, index) => (
          <div key={index} className="fl-code-line">
            <span className="fl-code-no">{source.start + index}</span>
            <span>{lineView(text)}</span>
          </div>
        ))}
      </pre>
      {opened.map((item) => {
        const match = /^(.+):(\d+)$/u.exec(item.site);
        return (
          <div key={item.site} className="fl-code-nested">
            <div className="fl-head-row">
              <code className="fl-fn-name">{item.name}</code>
              <button type="button" className="fl-link" onClick={() => toggle(item.name, item.site)}>收起</button>
            </div>
            <SourceView file={match?.[1] ?? ''} line={Number(match?.[2])} />
          </div>
        );
      })}
    </div>
  );
}


/**
 * 复制到剪贴板，结果用一句话交回按钮。JsonBlock 和 SourceView 共用。
 * 不是 https 也不是本机时浏览器不给用剪贴板，提示手动选中。
 * @param text 要复制的。
 * @param said 按钮上换成的那句话（已复制、复制失败……）。
 */
function copyText(text: string, said: (word: string) => void): void {
  if (!window.isSecureContext) {
    said('浏览器不让复制，请手动选中');
    return;
  }
  void navigator.clipboard.writeText(text).then(() => said('已复制'), () => said('复制失败，请手动选中'));
}


/** 这一步自己的函数：第一个有原型的（插件那步是 apply，文件开头的注释没有原型）。请求轨迹没有。 */
function ownDoc(step: TrailStep): CodeDoc | undefined {
  return (step.docs ?? []).find((doc) => doc.signature !== '');
}

/**
 * 一步的函数原型和关键变量：右栏点中一步后显示，启动和请求轨迹共用。原型是 ownDoc 的，变量交给 JsonBlock。
 * @param props.notes 整条轨迹的说明表（Trail.notes）。
 */
function StepVars(props: { step: TrailStep; notes?: Record<string, string> }): JSX.Element {
  const { step, notes } = props;
  const signature = ownDoc(step)?.signature ?? '';
  return (
    <div className="fl-stepvars">
      {signature !== '' && <code className="fl-signature">{signature}</code>}
      <JsonBlock head={<h3>关键变量</h3>} value={varsOfStep(step)} empty="这一步没有记下变量。" notes={notes} />
    </div>
  );
}


/** 变了的地方拼成一个键：一串键名用这个字连起来（键名里不会有它）。 */
const PATH_SEP = '\u001f';

/** JSON 显示的样式：库自带的暗色主题，底色透明（用外面 .fl-json-view 的底），字号跟 /flow/ 一致。 */
const JSON_STYLE = {
  ...darkTheme,
  '--w-rjv-background-color': 'transparent',
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12,
} as CSSProperties;

/**
 * 一个键在整个值里的路径（和后端 diffOf 给的一样，一串键名）。
 * @param keys 库给的路径：有的版本含这个键自己，有的只到上一层，最后一个不是它就补上。
 * @param keyName 这个键。
 */
function pathOf(keys: readonly unknown[] | undefined, keyName: unknown): string[] {
  const path = (keys ?? []).map(String);
  if (keyName !== undefined && path.at(-1) !== String(keyName)) path.push(String(keyName));
  return path;
}

/**
 * 显示一块 JSON（@uiw/react-json-view）：默认展开前两层，更深的收起，节点能点着开合；每个节点自带复制（复制那个节点的纯 JSON），
 * 顶上“复制全部”复制整块。一步的关键变量、运行时变量的每一组共用。
 * 键名用库的 JsonView.KeyName 自定义渲染：有中文解释的后面灰字跟 // 解释（只是显示，复制的还是纯 JSON）；变了的键标黄。
 * @param props.head 复制按钮左边的标题。
 * @param props.value 要显示的值；undefined 显示 empty；不是对象、数组的直接显示。
 * @param props.empty 没有值时的一句话。
 * @param props.marks 变了的路径（一串键名用 PATH_SEP 连起来），这些键标黄；不给就不标。
 * @param props.notes 键的中文解释（后端随数据给的说明表）。
 */
function JsonBlock(props: { head: ReactNode; value: unknown; empty: string; marks?: Set<string>; notes?: Record<string, string> }): JSX.Element {
  const { value } = props;
  const [copied, setCopied] = useState('复制全部');
  const json = value === undefined ? '' : JSON.stringify(value, null, 2);
  const marks = props.marks ?? new Set<string>();
  //M 用 Map 查：JSON 里有叫 constructor、toString 的键时，不会查到对象原型上的东西。
  const notes = new Map(Object.entries(props.notes ?? {}));

  let body: ReactNode = <p className="fl-muted">{props.empty}</p>;
  if (typeof value === 'object' && value !== null) {
    body = (
      <div className="fl-json-view">
        <JsonView value={value} style={JSON_STYLE} collapsed={2} displayDataTypes={false} shortenTextAfterLength={0}>
          {/* 键名不带引号：解释跟在键名后面，带引号会夹在引号里。 */}
          <JsonView.Quote render={() => <span />} />
          {/* 键名：有解释或变了才自己画，别的返回 undefined 交回库默认的。参数类型照库的来。 */}
          <JsonView.KeyName
            render={(attrs, result) => {
              const keys = (result as { keys?: unknown[] }).keys;
              const name = result.keyName === undefined ? '' : String(result.keyName);
              const mark = marks.has(pathOf(keys, result.keyName).join(PATH_SEP));
              const note = notes.get(name);
              if (!mark && note === undefined) return undefined;

              const className = mark ? `${attrs.className ?? ''} fl-changed` : attrs.className;
              return (
                <>
                  <span {...attrs} className={className}>{name}</span>
                  {note !== undefined && <span className="fl-json-note">{` // ${note}`}</span>}
                </>
              );
            }}
          />
        </JsonView>
      </div>
    );
  } else if (value !== undefined) {
    body = <pre className="fl-json">{json}</pre>;
  }

  return (
    <>
      <div className="fl-head-row">
        {props.head}
        {json !== '' && <button type="button" className="fl-link" onClick={() => copyText(json, setCopied)}>{copied}</button>}
      </div>
      {body}
    </>
  );
}


/** 运行时变量多久刷新一次，毫秒。 */
const STATE_MS = 3000;

/**
 * 右栏「运行时变量」。两种看法：
 *   现在：每 STATE_MS 读一次 /api/flow/state（flow 插件自动读每个服务对象，加插件登记的，全量原样），能暂停；
 *   某一步时：轨迹里点中了一步，读一次 /api/flow/snapshot，显示那一步当时的快照，和上一步比变了的行标上颜色，变了的组默认展开。
 * 点中别的步就看那一步的；按“切回现在”看现在，再点一步又回到看那一步。
 * 按组折叠，默认只展开 resources；左栏点了某一组就只展开那组并滚过去。切走标签页就不再读。
 * @param props.focus 左栏点的组（FlowPage 的 focusNode）；name 是空串时没点过。
 * @param props.pick 轨迹里点中的哪一步：message 是消息号（0 是启动），step 是 0 时没点中。
 * @param props.keyword 快照关键词（/api/flow/graph 给的 snapshotKeyword）：请求轨迹的这一步没快照时，提示里说没带它。
 */
function RuntimeState(props: { focus: { name: string; seq: number }; pick: { message: number; step: number }; keyword: string }): JSX.Element {
  const { focus } = props;
  const { message, step } = props.pick;
  const [now, setNow] = useState<StateGroup[]>([]);
  const [at, setAt] = useState(0);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  /** 点中的这一步，键是“消息号-第几步”；没点中是 ''。 */
  const pickKey = step === 0 ? '' : `${String(message)}-${String(step)}`;
  /** 按了“切回现在”时点中的是哪一步：点中别的步就又看那一步的。 */
  const [liveFor, setLiveFor] = useState('');
  const live = pickKey === '' || liveFor === pickKey;
  /** 读到的快照（或读不到的原因），带着是哪一步的：不是现在点中的这步就当还没读到。 */
  const [loadedShot, setLoadedShot] = useState({ key: '', data: null as Snapshot | null, error: '' });
  const shot = loadedShot.key === pickKey ? loadedShot.data : null;
  //M 请求轨迹里这一步没快照（消息没带关键词，后端 404 说“没有快照”）：改看现在的值，顶上写明。
  const noShot = !live && message > 0 && loadedShot.key === pickKey && loadedShot.error.includes('没有快照');
  const showNow = live || noShot;

  //M 看某一步：读一次那一步的快照。
  useEffect(() => {
    if (live) return undefined;

    let alive = true;
    void get<Snapshot>(`/api/flow/snapshot?message=${String(message)}&step=${String(step)}`).then((result) => {
      if (alive) setLoadedShot({ key: pickKey, data: result, error: '' });
    }, (failed: unknown) => {
      if (alive) setLoadedShot({ key: pickKey, data: null, error: (failed as Error).message });
    });
    return () => {
      alive = false;
    };
  }, [live, message, step, pickKey]);

  const groups = showNow ? now : shot?.groups ?? [];
  const loaded = groups.length > 0;
  let failed = error;
  if (!showNow) failed = loadedShot.key === pickKey ? loadedShot.error : '';

  //M 变了的地方按组分开：组名去掉，剩下的路径连成一个键给 JsonBlock。
  const marks = new Map<string, Set<string>>();
  for (const path of showNow ? [] : shot?.changed ?? []) {
    const [name = '', ...rest] = path;
    const set = marks.get(name) ?? new Set<string>();
    set.add(rest.join(PATH_SEP));
    marks.set(name, set);
  }

  //M 点了一组：等组读到了再滚过去（刚切过来时还没读到）。
  useEffect(() => {
    if (!loaded || focus.name === '') return;

    document.getElementById(`fl-group-${focus.name}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focus, loaded]);

  useEffect(() => {
    if (paused || !showNow) return undefined;

    let alive = true;
    const load = (): void => {
      void get<{ at: number; groups: StateGroup[] }>('/api/flow/state').then((result) => {
        if (!alive) return;

        setNow(result.groups);
        setAt(result.at);
        setError('');
      }, (failed: unknown) => {
        if (alive) setError((failed as Error).message);
      });
    };
    load();
    const timer = window.setInterval(load, STATE_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [paused, showNow]);

  //M 顶上一行：看的是现在还是第几步时的，和切换按钮；这一步没快照时写明原因。
  const refresh = `${at > 0 ? `${clock(at)} 读的` : '正在读…'} · ${paused ? '已暂停' : `每 ${String(STATE_MS / 1000)} 秒刷新`}`;
  let said: ReactNode;
  if (noShot) {
    said = (
      <>
        <strong className="fl-shot-title">这条消息没带 {props.keyword}，没拍快照，显示的是现在的值</strong>
        <span className="fl-muted fl-shot-diff">{refresh}</span>
      </>
    );
  } else if (live) {
    said = (
      <>
        <span className="fl-muted">现在 · {refresh}</span>
        <button type="button" className="fl-link" onClick={() => setPaused((value) => !value)}>{paused ? '继续刷新' : '暂停'}</button>
        {step > 0 && <button type="button" className="fl-link" onClick={() => setLiveFor('')}>看第 {step} 步时的</button>}
      </>
    );
  } else {
    let diff = '正在读…';
    if (shot !== null) diff = shot.changed === null ? '第一步，没有上一步可比' : `比上一步变了 ${String(shot.changed.length)} 处（标黄）`;
    if (shot !== null) diff = `${shot.node} · ${clock(shot.at)} · ${diff}`;
    //M 快照拍在事件发出、还没人处理的那一刻（State.ts），这一步造成的变化要到下一步的快照里才看得到。
    said = (
      <>
        <strong className="fl-shot-title">第 {step} 步（事件发出时）的快照，这一步造成的变化在下一步里</strong>
        <button type="button" className="fl-link" onClick={() => setLiveFor(pickKey)}>切回现在</button>
        <span className="fl-muted fl-shot-diff">{diff}</span>
      </>
    );
  }

  return (
    <div className="fl-state">
      <div className="fl-head-row fl-shot-head">{said}</div>
      {failed !== '' && <p className="fl-error">读不到：{failed}</p>}
      {groups.map((item) => {
        const changed = marks.get(item.name);
        //M 默认展开：左栏点了的那组；看某一步时是变了的组；都没有是 resources。
        let open = item.name === 'resources';
        if (focus.name !== '') open = item.name === focus.name;
        else if (!showNow && marks.size > 0) open = changed !== undefined;
        return (
          //M key 带 seq 和看的是哪份：每点一次、每换一步重建，展开哪组按这次的来，不受之前手动开合影响。
          <details
            key={`${item.name}-${String(focus.seq)}-${showNow ? 'now' : `${String(message)}-${String(step)}`}`}
            id={`fl-group-${item.name}`}
            className={`fl-state-group${changed !== undefined ? ' changed' : ''}`}
            open={open}
          >
            <summary>{item.name}{changed !== undefined ? ` · 变了 ${String(changed.size)} 处` : ''}</summary>
            <JsonBlock head={<span className="fl-muted">{item.note}</span>} value={item.value} empty="（空）" marks={changed} notes={item.notes} />
          </details>
        );
      })}
    </div>
  );
}


const PASSIVE_LISTENERS = new Set(['journal', 'trace', 'usage']);

function ListenerList(props: { step: TrailStep }): JSX.Element {
  const acted = props.step.node;
  const heard = [...new Set([...props.step.rows.flatMap((row) => row.listeners), ...props.step.notified, acted])]
    .filter((name) => name !== '' && !PASSIVE_LISTENERS.has(name));
  const idle = heard.filter((name) => name !== acted);
  return (
    <div className="fl-listeners">
      <h3>听的人</h3>
      <p className="fl-muted">听 {heard.length} 个，有动作 1，未动作 {idle.length}。</p>
      <ul>
        <li className="used">{acted}<span className="fl-muted"> 有动作</span></li>
        {idle.map((name) => <li key={name} className="idle">{name}<span className="fl-muted"> 未动作</span></li>)}
      </ul>
    </div>
  );
}


/**
 * 「变量 / 详情」：/api/flow/detail 交的跟踪行（按这一步的时间和行挑）、对话、用量、对话.md。
 * 跟踪行的变量是 journal 记的（每个值截到 200 字），更长的正文看对话.md；要某一刻的全部运行时变量，消息里带快照关键词，看「运行时变量」。
 */
function VarsView(props: { trail: Trail; active: number | null; detail: FlowDetail | null }): JSX.Element {
  const { trail, active, detail } = props;
  const step = trail.steps.find((item) => item.no === active) ?? null;
  const lines = linesForStep(trail, step, detail);
  const vars = varsOf(lines);
  const messages = messagesFor(lines);
  return (
    <div className="fl-vars" data-guide="vars">
      <p className="fl-kicker">{step !== null ? `第 ${String(step.no)} 步 · ${step.node}` : '整条请求'}</p>
      <p className="fl-muted">列的是跟踪行记下的关键数据（长的截短过）和这场会话的对话.md。要某一刻的全部运行时变量，发消息时带上快照关键词，再看「运行时变量」。</p>
      {messages.length > 0 && (
        <section>
          <h3>这一步的对话</h3>
          <ul className="fl-msgs">
            {messages.map((item, index) => (
              <li key={`${item.role}-${String(index)}`}>
                <span className="fl-role">{roleLabel(item.role)}</span>
                {item.model !== undefined && <span className="fl-muted"> {item.model}</span>}
                {item.tool !== undefined && <span className="fl-muted"> {item.tool}</span>}
                <pre>{item.text || '（没有正文）'}</pre>
              </li>
            ))}
          </ul>
        </section>
      )}
      {vars.length > 0 && (
        <section>
          <h3>关键变量</h3>
          <table className="fl-vartable">
            <tbody>
              {vars.map((item) => (
                <tr key={item.name}>
                  <th>{item.name}</th>
                  <td><pre>{item.value}</pre></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {step !== null && <ListenerList step={step} />}
      {detail !== null && detail.usage.length > 0 && (
        <section>
          <h3>用量</h3>
          <ul className="fl-usage">
            {detail.usage.map((item, index) => (
              <li key={`${item.model}-${String(index)}`}>
                {item.model} · 入 {item.input} / 出 {item.output} · {duration(item.ms)} · {item.ok ? '成功' : '失败'}
                {item.cost > 0 ? ` · $${item.cost.toFixed(4)}` : ''}
                {item.error !== undefined && item.error !== '' ? ` · ${item.error}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
      {detail !== null && detail.conversation !== '' && (
        <section>
          <h3>对话.md</h3>
          <pre className="fl-doc">{detail.conversation}</pre>
        </section>
      )}
      {detail === null && <p className="fl-muted">还没有详情。确认挂着 journal 插件，并且这条请求还在跟踪行里。</p>}
    </div>
  );
}


function linesForStep(trail: Trail, step: TrailStep | null, detail: FlowDetail | null): DetailLine[] {
  if (detail === null) return [];
  if (step === null) return detail.lines;
  const from = trail.at + step.t;
  const to = from + Math.max(step.ms, 1) + 80;
  const names = new Set(step.rows.map((row) => row.name));
  const sites = new Set(step.rows.map((row) => row.site));
  return detail.lines.filter((line) => {
    if (line.at >= from - 5 && line.at <= to) return true;
    return names.has(line.name) && (sites.has(line.site) || line.site === '');
  });
}


function messagesFor(lines: DetailLine[]): { role: string; text: string; model?: string; tool?: string }[] {
  const fromLines: { role: string; text: string; model?: string; tool?: string }[] = [];
  for (const line of lines) {
    if (line.name === 'session/change' && typeof line.vars['回话'] === 'string' && line.vars['回话'] !== '') {
      fromLines.push({ role: 'assistant', text: String(line.vars['回话']) });
      continue;
    }
    if (line.name !== 'session/message' && line.name !== 'web-api/received') continue;
    const role = typeof line.vars['角色'] === 'string' ? line.vars['角色'] : (line.name === 'web-api/received' ? 'user' : '');
    const text = typeof line.vars['说了'] === 'string' ? line.vars['说了'] : '';
    if (role === '' && text === '') continue;
    const item: { role: string; text: string; model?: string; tool?: string } = { role: role || 'unknown', text };
    if (typeof line.vars['模型'] === 'string') item.model = line.vars['模型'];
    if (typeof line.vars['工具'] === 'string') item.tool = line.vars['工具'];
    fromLines.push(item);
  }
  return fromLines;
}


function varsOf(lines: DetailLine[]): { name: string; value: string }[] {
  const map = new Map<string, string>();
  for (const line of lines) {
    for (const [name, raw] of Object.entries(line.vars)) {
      const value = stringifyVar(raw);
      if (value === '') continue;
      const prev = map.get(name);
      if (prev === undefined || value.length > prev.length) map.set(name, value);
    }
    if (line.sessionId !== null && !map.has('会话')) map.set('会话', line.sessionId);
    if (line.bot !== null && line.bot !== '' && !map.has('机器人')) map.set('机器人', line.bot);
    if (line.messageId !== null && !map.has('消息号')) map.set('消息号', String(line.messageId));
  }
  return [...map.entries()].map(([name, value]) => ({ name, value }));
}


function stringifyVar(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}


function roleLabel(role: string): string {
  if (role === 'user') return '用户';
  if (role === 'assistant') return '助手';
  if (role === 'toolResult' || role === 'tool') return '工具';
  if (role === 'toolCall') return '调用工具';
  return role;
}


function Detail(props: { node: GraphNode; edges: GraphEdge[]; trail: Trail | null; onBack: () => void }): JSX.Element {
  const { node, edges, trail } = props;
  const related = (trail?.steps ?? []).filter((step) => step.node === node.id);
  const incoming = unique(edges.filter((edge) => edge.target === node.id).map((edge) => edge.source));
  const outgoing = unique(edges.filter((edge) => edge.source === node.id).map((edge) => edge.target));
  return (
    <div>
      <button type="button" className="fl-link" onClick={props.onBack}>← 返回{trail !== null ? '轨迹' : '列表'}</button>
      <p className="fl-kicker">{node.category} · {STATE_LABEL[node.state] ?? node.state}</p>
      <h2>{node.id}</h2>
      <p>{node.summary}</p>
      {node.error !== '' && <p className="fl-error">{node.error}</p>}
      {node.missing.length > 0 && <p className="fl-error">缺服务：{node.missing.join('、')}</p>}
      {related.length > 0 && (
        <>
          <h3>这条请求在这里的步骤</h3>
          <ul className="fl-steps">
            {related.map((step) => (
              <li key={step.no} className={step.error ? 'error' : ''}>第 {step.no} 步 · {duration(step.ms)} · {step.title}</li>
            ))}
          </ul>
        </>
      )}
      <Field label="要用" items={node.inject} />
      <Field label="提供" items={node.provides} />
      <Field label="发出" items={node.emits} />
      <Field label="监听" items={node.listens} />
      <Field label="谁连过来" items={incoming} />
      <Field label="它连出去" items={outgoing} />
      {node.http !== '' && <p><span className="fl-label">HTTP</span> {node.http}</p>}
    </div>
  );
}


function Field(props: { label: string; items: string[] }): JSX.Element | null {
  if (props.items.length === 0) return null;
  return <p><span className="fl-label">{props.label}</span> {props.items.join('、')}</p>;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
