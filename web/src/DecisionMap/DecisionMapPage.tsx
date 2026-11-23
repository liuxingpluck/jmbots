/** 工作决策工作台：PC 三栏总览与专题双视图 + 手机竖屏 48px 单行顶栏/底栏原生级极简体验。 */
import * as react from 'react';
import type * as types from '../../../src7/plugins/work-decision/Types.ts';
import * as authGate from '../components/AuthGate.tsx';
import * as token from '../Token.ts';
import * as api from './DecisionMapApi.ts';
import * as composer from './Composer.tsx';
import type { PendingCameraRequest } from './DecisionFlowCanvas.tsx';
import * as drafts from './Drafts.ts';
import * as drawer from './Drawer.tsx';
import * as scopeMod from './Scope.ts';
import * as topicView from './TopicView.tsx';
import * as words from './Words.ts';

/** 按需懒加载非首屏重型视图（ReactFlow 导图/放射/日期、AntD 虚拟表、虚拟清单、四象限）。 */
const LazyFlowCanvas = react.lazy(async () => {
  const mod = await import('./DecisionFlowCanvas.tsx');
  return { default: mod.DecisionFlowCanvas };
});
const LazyQuadrantView = react.lazy(async () => {
  const mod = await import('./QuadrantView.tsx');
  return { default: mod.QuadrantView };
});
const LazyTableView = react.lazy(async () => {
  const mod = await import('./Views.tsx');
  return { default: mod.TableView };
});
const LazyListView = react.lazy(async () => {
  const mod = await import('./Views.tsx');
  return { default: mod.ListView };
});
const LazyControlPlaneView = react.lazy(async () => {
  const mod = await import('./ControlPlaneView.tsx');
  return { default: mod.ControlPlaneView };
});
const LazyTickWorkspace = react.lazy(async () => {
  const mod = await import('./TickWorkspace.tsx');
  return { default: mod.TickWorkspace };
});

/** 新加的界面字过语言包；写成 t('原文')，提取脚本 scripts/I18n_Extract.ts 才认得出。 */
const t = words.t;

/** 顶栏主工作区页签：决策导图（默认）、多 AI 任务控制面（?tab=tasks）、积木AI工作台（?tab=tick / ?tab=workbench）。 */
type MainTab = 'map' | 'tasks' | 'tick';

/** 七种看法：专题目录、四象限、思维导图、按日期、放射图、表格、清单。 */
type Look = 'topic' | 'quadrant' | 'mind' | 'date' | 'radial' | 'table' | 'list';

/** 每 30 秒发一次轻量 GET /api/work-decision/version（严禁使用 SSE 或 WebSocket）。 */
const VERSION_POLL_MS = 30_000;
const MOBILE_BREAKPOINT = 800;
/** 浏览器里记看法和思维导图方向的键。 */
const LOOK_KEY = 'jmbots.decision-map.look';
const DIRECTION_KEY = 'jmbots.decision-map.direction';
/** 看法切换按钮，顺序即显示顺序。 */
const LOOKS: { key: Look; label: string }[] = [
  { key: 'topic', label: t('专题目录') },
  { key: 'quadrant', label: t('四象限') },
  { key: 'mind', label: t('思维导图') },
  { key: 'list', label: t('清单') },
  { key: 'table', label: t('表格') },
  { key: 'date', label: t('按日期') },
  { key: 'radial', label: t('放射') },
];

/** 读浏览器里记着的一项；隐私模式等读不了时是 null。 */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 记下一项；写不了就算了，下次打开用默认看法。 */
function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

/** 打开时进入哪个主页签：?tab=tasks 进控制面，?tab=tick 或 ?tab=workbench 进 AI 工作台，其余进决策导图。 */
function getStartMainTab(): MainTab {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  const look = params.get('look');
  if (tab === 'tasks' || look === 'tasks') return 'tasks';
  if (tab === 'tick' || tab === 'workbench' || look === 'tick' || look === 'workbench') return 'tick';

  return 'map';
}

/** 同步顶栏主页签到地址栏 ?tab=tasks / ?tab=tick（兼容已传 ?tab=workbench 别名），便于收藏或直达链接。 */
function syncMainTabUrl(nextTab: MainTab): void {
  try {
    const url = new URL(window.location.href);
    if (nextTab === 'map') {
      url.searchParams.delete('tab');
    }
    if (nextTab === 'tasks') {
      url.searchParams.set('tab', 'tasks');
    }
    if (nextTab === 'tick') {
      const curTab = url.searchParams.get('tab');
      if (curTab !== 'workbench') {
        url.searchParams.set('tab', 'tick');
      }
    }
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    return;
  }
}

/** 打开时用哪种看法：网址 ?look= 优先，其次浏览器记着的，首次打开默认进专题目录。 */
function getStartLook(): Look {
  const fromUrl = new URLSearchParams(window.location.search).get('look');
  const matchedUrl = LOOKS.find((item) => item.key === fromUrl);
  if (matchedUrl !== undefined) return matchedUrl.key;

  //M 手机竖屏未显式传 ?look= 时默认进最适合单手阅读拍板的专题目录。
  if (window.innerWidth < MOBILE_BREAKPOINT) return 'topic';

  const stored = readStored(LOOK_KEY);
  const known = LOOKS.find((item) => item.key === stored);
  if (known !== undefined) return known.key;

  return 'topic';
}

/** 思维导图方向：记着“上下”就上下，默认左右。 */
function getStartDirection(): scopeMod.MindDirection {
  const stored = readStored(DIRECTION_KEY);
  if (stored === 'down') return 'down';

  return 'sides';
}

/** 判断用户是否正在输入框内打字或持有任何未发送草稿（用于避免自动刷新打断输入）。 */
function isUserBusyWithInput(): boolean {
  if (drafts.hasAnyDraft()) return true;

  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) return true;
  if (active instanceof HTMLInputElement) return true;
  if (active instanceof HTMLSelectElement) return true;

  return false;
}

/** 工作台主入口。专题目录与总览画布共用同一份服务端快照与中控留言通道。 */
export function DecisionMapPage() {
  const webAuth = authGate.useWebAuth();
  const [graph, setGraph] = react.useState<types.DecisionGraph>();
  const [loadingError, setLoadingError] = react.useState<string>();
  const focusLink = new URLSearchParams(window.location.search).get('focus') ?? undefined;
  const [nodeId, setNodeId] = react.useState<string | undefined>(focusLink);
  const [projectRoot, setProjectRoot] = react.useState<string>();
  const [topicId, setTopicId] = react.useState<string>();
  const [lastNormalTopicId, setLastNormalTopicId] = react.useState<string>();
  const [savingKey, setSavingKey] = react.useState<string>();
  const [chooseError, setChooseError] = react.useState<string>();
  const [mode, setMode] = react.useState<scopeMod.ViewMode>('main');
  const [mainTab, setMainTab] = react.useState<MainTab>(getStartMainTab);
  const [tasksRev, setTasksRev] = react.useState<number | undefined>(undefined);
  const [tasksBoard, setTasksBoard] = react.useState<api.ControlTaskListResponse | undefined>(undefined);
  const [tasksLoading, setTasksLoading] = react.useState(false);
  const lastTasksRevRef = react.useRef<number | undefined>(undefined);
  const tasksLoadedOnceRef = react.useRef(false);
  const [look, setLook] = react.useState<Look>(getStartLook);
  const [direction, setDirection] = react.useState<scopeMod.MindDirection>(getStartDirection);
  const [onlyAsk, setOnlyAsk] = react.useState(false);
  const [sending, setSending] = react.useState(false);
  const [noteError, setNoteError] = react.useState<string>();
  const [folds, setFolds] = react.useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [focused, setFocused] = react.useState<string>();
  const [newVersionReady, setNewVersionReady] = react.useState(false);
  const [refreshing, setRefreshing] = react.useState(false);
  const [needToken, setNeedToken] = react.useState(false);
  const [tokenInput, setTokenInput] = react.useState('');
  const [isMobile, setIsMobile] = react.useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  const [mobileDrawerOpen, setMobileDrawerOpen] = react.useState(false);
  const [mobileSwitcherOpen, setMobileSwitcherOpen] = react.useState(false);
  const [cameraRequest, setCameraRequest] = react.useState<PendingCameraRequest | null>(null);

  const canvas = react.useRef<HTMLElement>(null);
  const lastPending = react.useRef<string | undefined>(undefined);
  const cameraSeqRef = react.useRef(0);
  const appStartedAtRef = react.useRef<number | undefined>(undefined);
  const dataRevRef = react.useRef<number | undefined>(undefined);
  /** 正在跑的那次版本检查的代次，0 表示没有在跑；只有自己那一代结束才清，手动刷新和自动探针不互相清标记。 */
  const checkingRef = react.useRef(0);
  /** 版本检查的代次计数，每次检查加一。 */
  const checkSeqRef = react.useRef(0);
  const graphAbortRef = react.useRef<AbortController | null>(null);
  const graphSeqRef = react.useRef(0);
  const [size, setSize] = react.useState(() => ({
    width: Math.max(360, window.innerWidth - 220),
    height: Math.max(320, window.innerHeight - 110),
  }));
  const [visitedTasks, setVisitedTasks] = react.useState(() => mainTab === 'tasks');
  const [visitedTick, setVisitedTick] = react.useState(() => mainTab === 'tick');
  const [visitedTopic, setVisitedTopic] = react.useState(() => mainTab === 'map' && look === 'topic');
  const [visitedQuadrant, setVisitedQuadrant] = react.useState(() => mainTab === 'map' && look === 'quadrant');
  const [visitedFlow, setVisitedFlow] = react.useState(
    () => mainTab === 'map' && (look === 'mind' || look === 'date' || look === 'radial'),
  );
  const [lastCanvasLook, setLastCanvasLook] = react.useState<'mind' | 'date' | 'radial'>(() => {
    if (look === 'date' || look === 'radial') return look;
    return 'mind';
  });
  const portrait = size.width <= 670 || isMobile;

  //M 首屏空闲时预热导图、四象限、控制面、滴答工作台与表格/清单懒加载分包，首次切换秒开。
  react.useEffect(() => {
    const timer = window.setTimeout(() => {
      void import('./DecisionFlowCanvas.tsx');
      void import('./QuadrantView.tsx');
      void import('./ControlPlaneView.tsx');
      void import('./TickWorkspace.tsx');
      void import('./Views.tsx');
    }, 60);
    return () => window.clearTimeout(timer);
  }, []);

  //M 记录已访问过的视图并记住最近一次图形画布模式，支持在各工作区之间保活秒切。
  react.useEffect(() => {
    if (mainTab === 'tasks') {
      setVisitedTasks(true);
      return;
    }
    if (mainTab === 'tick') {
      setVisitedTick(true);
      return;
    }
    if (look === 'topic') {
      setVisitedTopic(true);
      return;
    }
    if (look === 'quadrant') {
      setVisitedQuadrant(true);
      return;
    }
    if (look === 'mind' || look === 'date' || look === 'radial') {
      setVisitedFlow(true);
      setLastCanvasLook(look);
    }
  }, [look, mainTab]);

  /** 拉取 AI 任务控制面与滴答工作台共用的任务与清单快照。 */
  const loadTasksBoard = react.useCallback(async (silent = false) => {
    if (!silent) {
      setTasksLoading(true);
    }
    try {
      const data = await api.getControlTasks();
      lastTasksRevRef.current = data.revision;
      tasksLoadedOnceRef.current = true;
      setTasksBoard(data);
    } catch {
      return;
    } finally {
      if (!silent) {
        setTasksLoading(false);
      }
    }
  }, []);

  //M 首次进入「AI 任务控制面」或「滴答清单」时自动拉取共享任务底座。
  react.useEffect(() => {
    if (!visitedTasks && !visitedTick) return;
    if (tasksLoadedOnceRef.current) return;

    void loadTasksBoard(false);
  }, [visitedTasks, visitedTick, loadTasksBoard]);

  //M 30 秒轻量版本探针发现 tasksRev 变化时，静默同步共享任务与清单数据。
  react.useEffect(() => {
    if (tasksRev === undefined) return;
    if (!tasksLoadedOnceRef.current) return;
    if (lastTasksRevRef.current === tasksRev) return;

    void loadTasksBoard(true);
  }, [tasksRev, loadTasksBoard]);

  react.useEffect(() => {
    const onResize = (): void => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  react.useEffect(() => {
    const onUnauthorized = (): void => {
      setNeedToken(true);
    };
    window.addEventListener('jmbots:unauthorized', onUnauthorized);
    return () => window.removeEventListener('jmbots:unauthorized', onUnauthorized);
  }, []);

  react.useLayoutEffect(() => {
    const element = canvas.current;
    if (element === null) return;

    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width === 0 || height === 0) return;

      setSize((current) => {
        if (current.width === width && current.height === height) return current;

        return { width, height };
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [look, mainTab]);

  /**
   * 静默拉取最新节点图并在本地合并：带代次号防乱序覆盖，版本一致时保持原引用零多余重绘。
   * @param externalSignal 外部中止信号。
   * @param restarted 后端刚重启过：不再拿旧的 revision 比大小，直接用新图（云端 26 次要 #2）。
   */
  const refresh = react.useCallback(async (externalSignal?: AbortSignal, restarted = false) => {
    graphAbortRef.current?.abort();
    const controller = new AbortController();
    graphAbortRef.current = controller;
    graphSeqRef.current += 1;
    const seq = graphSeqRef.current;
    const onExternalAbort = (): void => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const next = await api.getGraph(controller.signal);
      if (controller.signal.aborted || seq !== graphSeqRef.current) return;
      if (!restarted && dataRevRef.current !== undefined && next.revision < dataRevRef.current) return;

      dataRevRef.current = next.revision;
      setGraph((current) => {
        if (current === undefined || restarted) return next;
        if (next.revision < current.revision) return current;
        if (next.revision !== current.revision) return next;
        if (JSON.stringify(next.projects) !== JSON.stringify(current.projects)) {
          return { ...current, projects: next.projects };
        }
        return current;
      });
      setLoadingError((prev) => {
        if (prev === undefined) return prev;
        return undefined;
      });
    } catch (error) {
      if (controller.signal.aborted || externalSignal?.aborted === true) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;

      let message = String(error);
      if (error instanceof Error) message = error.message;
      setLoadingError(message);
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }, []);

  /** 检查 30 秒轻量版本探针：dataRev 未变时绝不拉整图、绝不触发任何 setState 重绘。 */
  const checkVersion = react.useCallback(async (manual = false, signal?: AbortSignal) => {
    if (checkingRef.current !== 0 && !manual) return;

    //M 记下这一次的代次，结束时只清自己那一代
    checkSeqRef.current += 1;
    const checkSeq = checkSeqRef.current;
    checkingRef.current = checkSeq;
    if (manual) setRefreshing(true);
    try {
      const ver = await api.getVersion(signal);
      if (signal?.aborted === true) return;

      const prevStarted = appStartedAtRef.current;
      if (prevStarted === undefined) {
        appStartedAtRef.current = ver.appStartedAt;
      }
      const restarted = prevStarted !== undefined && ver.appStartedAt !== prevStarted;
      if (restarted) {
        if (!isUserBusyWithInput()) {
          window.location.reload();
          return;
        }
        //M 用户正忙不整页刷新：亮出新版提示，记下新的启动时刻，数据照样换成后端现在的
        setNewVersionReady((prev) => prev || true);
        appStartedAtRef.current = ver.appStartedAt;

        //M 重启后 revision 从头数，旧的作废：这次拉图失败或被新一轮顶掉，下一轮探针照样拉新图，不会被旧 revision 卡住。
        dataRevRef.current = undefined;
        await refresh(signal, true);
        return;
      }

      //G 空闲自动探针在本地已有快照且 dataRev 完全相同时直接返回，零 /graph 请求、零重绘。
      if (ver.tasksRev !== undefined) {
        setTasksRev((prev) => {
          if (prev === ver.tasksRev) return prev;

          return ver.tasksRev;
        });
      }
      const isUnchanged = dataRevRef.current !== undefined && ver.dataRev === dataRevRef.current;
      if (manual && tasksLoadedOnceRef.current) {
        void loadTasksBoard(true);
      }
      if (!manual && isUnchanged) return;

      await refresh(signal);
    } catch (error) {
      if (signal?.aborted === true) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;

      if (dataRevRef.current === undefined || manual) {
        let message = String(error);
        if (error instanceof Error) message = error.message;
        setLoadingError(message);
      }
    } finally {
      if (checkingRef.current === checkSeq) {
        checkingRef.current = 0;
      }
      if (manual) setRefreshing(false);
    }
  }, [refresh, loadTasksBoard]);

  react.useEffect(() => {
    const control = new AbortController();

    //M 首屏并发发起版本探针与快照读取（1 RTT 呈现内容），其后每 30 秒只发 ~50B 版本探针。
    void refresh(control.signal);
    void api.getVersion(control.signal).then((ver) => {
      if (control.signal.aborted) return;
      if (appStartedAtRef.current === undefined) {
        appStartedAtRef.current = ver.appStartedAt;
      }
      if (ver.tasksRev !== undefined) {
        setTasksRev((prev) => {
          if (prev === ver.tasksRev) return prev;

          return ver.tasksRev;
        });
      }
    }, () => undefined);

    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void checkVersion(false, control.signal);
      }
    }, VERSION_POLL_MS);
    const onVisibility = (): void => {
      if (!document.hidden) {
        void checkVersion(false, control.signal);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      control.abort();
      graphAbortRef.current?.abort();
    };
  }, [checkVersion, refresh]);

  const open = react.useCallback((id: string, expand?: boolean) => {
    if (expand !== undefined) {
      setFolds((current) => new Map(current).set(id, expand));
      return;
    }
    setChooseError(undefined);
    setNoteError(undefined);
    setNodeId(id);
  }, []);

  const close = react.useCallback(() => {
    setChooseError(undefined);
    setNoteError(undefined);
    setNodeId(undefined);
  }, []);

  react.useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMobileDrawerOpen(false);
        setMobileSwitcherOpen(false);
        close();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [close]);

  const projects = graph?.projects ?? [];
  const linkedNode = graph?.nodes.find((node) => node.id === focusLink);
  let root = projectRoot ?? projects[0]?.root;
  if (projectRoot === undefined && linkedNode !== undefined) {
    const linkedRoot = graph?.nodes.find((node) => {
      return node.parent === null && node.bot === linkedNode.bot && node.workspaceId === linkedNode.workspaceId;
    });
    root = linkedRoot?.id ?? root;
  }

  const projectScope = react.useMemo(() => {
    const entries = graph?.nodes ?? [];
    return scopeMod.getScope(entries, root);
  }, [graph, root]);

  const scope = react.useMemo(() => {
    return scopeMod.getScope(projectScope.nodes, focused);
  }, [projectScope.nodes, focused]);

  const projectById = react.useMemo(
    () => new Map(projectScope.nodes.map((entry) => [entry.id, entry])),
    [projectScope.nodes],
  );

  const topicSummaries = react.useMemo(
    () => topicView.getTopicSummaryItems(projectScope.nodes),
    [projectScope.nodes],
  );
  const resolvedTopicId = topicView.resolveActiveTopicId(topicSummaries, topicId, isMobile);

  react.useEffect(() => {
    if (topicId !== undefined || focusLink === undefined || root === undefined) return;
    if (projectScope.nodes.length === 0) return;

    const matched = topicView.findTopicIdForNode(projectScope.nodes, root, focusLink);
    setTopicId(matched);
  }, [topicId, focusLink, root, projectScope.nodes]);

  function selectTopic(nextId: string): void {
    setMobileSwitcherOpen(false);
    setMobileDrawerOpen(false);
    if (nextId !== topicView.ALL_PENDING_TOPIC) {
      setLastNormalTopicId(nextId);
    }
    setTopicId(nextId);
  }

  function focusTree(id?: string): void {
    close();
    setFocused(id);
    if (id !== undefined) open(id, true);
  }

  function selectProject(id: string): void {
    if (id === root) return;

    focusTree();
    setTopicId(undefined);
    setProjectRoot(id);
    setMobileDrawerOpen(false);
    setMobileSwitcherOpen(false);
  }

  const isCanvas = look === 'date' || look === 'mind' || look === 'radial';
  const totalProjectPending = projectScope.nodes.filter(
    (node) => node.kind === 'pending' && node.status === 'open',
  );
  let activePendingSource = scope.nodes;
  if (look === 'topic' || look === 'quadrant') {
    activePendingSource = projectScope.nodes;
  }
  const pending = activePendingSource.filter((node) => node.kind === 'pending' && node.status === 'open');
  const selected = projectScope.nodes.find((node) => node.id === nodeId);
  const overviewRoot = scope.nodes.find((node) => node.parent === null);

  function switchMainTab(nextTab: MainTab): void {
    setMobileDrawerOpen(false);
    setMobileSwitcherOpen(false);
    setMainTab(nextTab);
    syncMainTabUrl(nextTab);
  }

  function changeMode(next: scopeMod.ViewMode): void {
    if (mode === next) return;

    close();
    setMode(next);
  }

  function changeLook(next: Look): void {
    setMobileDrawerOpen(false);
    setMobileSwitcherOpen(false);
    if (mainTab !== 'map') {
      setMainTab('map');
      syncMainTabUrl('map');
    }
    if (look === next) return;

    writeStored(LOOK_KEY, next);
    setLook(next);
  }

  function openNodeTopic(targetId: string): void {
    if (root !== undefined) {
      const belongTopic = topicView.findTopicIdForNode(projectScope.nodes, root, targetId);
      selectTopic(belongTopic);
    }
    setNodeId(targetId);
    changeLook('topic');
  }

  function openTopicInMind(targetId: string): void {
    if (targetId === root) {
      focusTree(undefined);
    }
    if (targetId !== root) {
      focusTree(targetId);
    }
    changeLook('mind');
  }

  function changeDirection(next: scopeMod.MindDirection): void {
    if (direction === next) return;

    writeStored(DIRECTION_KEY, next);
    setDirection(next);
  }

  /** 手机顶栏点击暖色「★ N」胶囊：一键只看全部待拍板卡片，再点回到专题方块总览。 */
  function toggleMobileAllPending(): void {
    setMobileDrawerOpen(false);
    setMobileSwitcherOpen(false);
    if (mainTab !== 'map') {
      setMainTab('map');
      syncMainTabUrl('map');
    }
    if (mainTab === 'map' && look === 'topic' && resolvedTopicId === topicView.ALL_PENDING_TOPIC) {
      const fallback = lastNormalTopicId ?? root;
      if (fallback !== undefined) {
        setTopicId(fallback);
      }
      return;
    }
    if (resolvedTopicId !== topicView.ALL_PENDING_TOPIC && resolvedTopicId !== '') {
      setLastNormalTopicId(resolvedTopicId);
    }
    setTopicId(topicView.ALL_PENDING_TOPIC);
    setNodeId(undefined);
    if (look !== 'topic') {
      changeLook('topic');
    }
  }

  /** 手机顶栏点击视图快切胶囊：开关半透明视图快切弹层，与左侧抽屉互斥。 */
  function toggleMobileSwitcher(): void {
    setMobileDrawerOpen(false);
    setMobileSwitcherOpen((prev) => !prev);
  }

  /** 手机视图快切：一键回到 2 列专题方块总览网格。 */
  function switchMobileToTileGrid(): void {
    if (mainTab !== 'map') {
      setMainTab('map');
      syncMainTabUrl('map');
    }
    if (root !== undefined) {
      selectTopic(root);
    }
    setNodeId(undefined);
    changeLook('topic');
    setMobileSwitcherOpen(false);
  }

  function openPending(): void {
    if (pending.length === 0) return;

    if (mainTab !== 'map') {
      setMainTab('map');
      syncMainTabUrl('map');
    }

    const current = pending.findIndex((node) => node.id === lastPending.current);
    const next = pending[(current + 1) % pending.length]!;
    lastPending.current = next.id;
    open(next.id);

    if (look === 'topic' && root !== undefined) {
      const belong = topicView.findTopicIdForNode(projectScope.nodes, root, next.id);
      selectTopic(belong);
      window.requestAnimationFrame(() => {
        const selector = `.decision-canvas--topic [data-node-id="${CSS.escape(next.id)}"]`;
        document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return;
    }

    //M 在导图/日期/放射画布中通过递增序号通知懒加载画布将镜头聚焦到目标待定卡片。
    cameraSeqRef.current += 1;
    setCameraRequest({ nodeId: next.id, seq: cameraSeqRef.current });
  }

  async function chooseOptionForNode(targetId: string, option: string): Promise<void> {
    if (savingKey !== undefined) return;

    setSavingKey(`${targetId}:${option}`);
    setChooseError(undefined);
    try {
      const chosen = await api.choose(targetId, option);
      setGraph((current) => {
        if (current === undefined) return current;

        const entries = current.nodes.map((node) => {
          if (node.id === chosen.node.id && node.chosen === undefined) return chosen.node;

          return node;
        });
        return { ...current, nodes: entries };
      });
      await refresh();
    } catch (error) {
      let message = String(error);
      if (error instanceof Error) message = error.message;
      setChooseError(message);
      await refresh();
    } finally {
      setSavingKey(undefined);
    }
  }

  async function sendNoteForNode(targetId: string, text: string, option?: string): Promise<boolean> {
    if (sending) return false;

    setSending(true);
    setNoteError(undefined);
    try {
      await api.addNote(targetId, text, option);
      await refresh();
      return true;
    } catch (error) {
      let message = String(error);
      if (error instanceof Error) message = error.message;
      setNoteError(message);
      await refresh();
      return false;
    } finally {
      setSending(false);
    }
  }

  const saveToken = (event: react.FormEvent): void => {
    event.preventDefault();
    const cleaned = tokenInput.trim();
    if (cleaned === '') return;

    writeStored(token.TOKEN_KEY, cleaned);
    window.location.reload();
  };

  let drawerSaving: string | undefined;
  if (selected !== undefined && savingKey !== undefined && savingKey.startsWith(`${selected.id}:`)) {
    drawerSaving = savingKey.slice(selected.id.length + 1);
  }

  let empty = '还没有决策节点';
  if (graph === undefined) empty = '正在读取决策图';
  if (loadingError !== undefined) empty = loadingError;

  const canvasLabel = t('AI工作台');

  let tasksStyle: react.CSSProperties = { display: 'none' };
  if (mainTab === 'tasks') {
    tasksStyle = { display: 'flex', flex: 1, minWidth: 0, minHeight: 0 };
  }
  let tickStyle: react.CSSProperties = { display: 'none' };
  if (mainTab === 'tick') {
    tickStyle = { display: 'flex', flex: 1, minWidth: 0, minHeight: 0 };
  }
  let topicStyle: react.CSSProperties | undefined = { display: 'none' };
  if (mainTab === 'map' && look === 'topic') {
    topicStyle = undefined;
  }
  let quadrantStyle: react.CSSProperties | undefined = { display: 'none' };
  if (mainTab === 'map' && look === 'quadrant') {
    quadrantStyle = undefined;
  }
  let canvasStyle: react.CSSProperties | undefined = { display: 'none' };
  if (mainTab === 'map' && look !== 'topic' && look !== 'quadrant') {
    canvasStyle = undefined;
  }
  let activeCanvasLook = lastCanvasLook;
  if (look === 'mind' || look === 'date' || look === 'radial') {
    activeCanvasLook = look;
  }

  const isAllPendingActive = look === 'topic' && resolvedTopicId === topicView.ALL_PENDING_TOPIC;
  const activeSummary = topicSummaries.find((item) => item.node.id === resolvedTopicId);
  const isTileGridActive = look === 'topic' && !isAllPendingActive && activeSummary?.isOverview === true;
  const topTopicCount = Math.max(0, topicSummaries.length - 1);
  const activeProject = projects.find((project) => project.root === root);

  //M 计算手机 48px 单行顶栏中央显示的短标题与视图快切胶囊标签。
  let mobileHeaderTitle = canvasLabel;
  let mobileSwitcherLabel = t('专题方块');
  if (look === 'topic') {
    if (isAllPendingActive) {
      mobileHeaderTitle = t('全部待拍板');
      mobileSwitcherLabel = t('待拍板');
    }
    if (!isAllPendingActive && activeSummary !== undefined) {
      mobileHeaderTitle = activeSummary.node.title;
      mobileSwitcherLabel = t('专题');
      if (activeSummary.isOverview) {
        mobileHeaderTitle = canvasLabel;
        mobileSwitcherLabel = t('专题方块');
      }
    }
  }
  if (look === 'quadrant') {
    mobileHeaderTitle = t('四象限');
    mobileSwitcherLabel = t('四象限');
  }
  if (look === 'mind') {
    mobileHeaderTitle = t('思维导图');
    mobileSwitcherLabel = t('思维导图');
  }
  if (look === 'list') {
    mobileHeaderTitle = t('极简清单');
    mobileSwitcherLabel = t('极简清单');
  }
  if (look !== 'topic' && look !== 'quadrant' && look !== 'mind' && look !== 'list') {
    const foundLook = LOOKS.find((item) => item.key === look);
    if (foundLook !== undefined) {
      mobileHeaderTitle = foundLook.label;
      mobileSwitcherLabel = foundLook.label;
    }
  }
  if (mainTab === 'tasks') {
    mobileHeaderTitle = t('AI 任务控制面');
    mobileSwitcherLabel = t('任务台');
  }
  if (mainTab === 'tick') {
    mobileHeaderTitle = t('AI工作台');
    mobileSwitcherLabel = t('AI工作台');
  }

  return (
    <main className="decision-page">
      {/* PC 宽屏（>= 800px）完整顶栏 */}
      {!isMobile && (
        <header className="decision-bar">
          <div className="decision-bar__title">
            <a
              href={token.withToken('/', token.TOKEN)}
              className="decision-back"
              aria-label="返回 jmbots"
              title="返回 jmbots"
            >
              ‹
            </a>
            <h1>{canvasLabel}</h1>
            <div className="decision-main-tabs" role="tablist" aria-label={t('主工作区')}>
              <button
                type="button"
                role="tab"
                data-main-tab="map"
                aria-selected={mainTab === 'map'}
                aria-pressed={mainTab === 'map'}
                onClick={() => switchMainTab('map')}
              >
                🗺️ {t('决策导图')}
              </button>
              <button
                type="button"
                role="tab"
                data-main-tab="tasks"
                aria-selected={mainTab === 'tasks'}
                aria-pressed={mainTab === 'tasks'}
                onClick={() => switchMainTab('tasks')}
              >
                🎛️ {t('AI 任务控制面')}
              </button>
              <button
                type="button"
                role="tab"
                data-main-tab="tick"
                aria-selected={mainTab === 'tick'}
                aria-pressed={mainTab === 'tick'}
                onClick={() => switchMainTab('tick')}
              >
                🧩 {t('AI工作台')}
              </button>
            </div>
          </div>
          {mainTab === 'map' && (look === 'mind' || look === 'radial') && scope.path.length === 0 && (
            <div className="decision-filters" role="group" aria-label="画布显示范围">
              <button type="button" aria-pressed={mode === 'main'} onClick={() => changeMode('main')}>
                当前进展
              </button>
              <button type="button" aria-pressed={mode === 'pending'} onClick={() => changeMode('pending')}>
                只看待定
              </button>
              <button type="button" aria-pressed={mode === 'all'} onClick={() => changeMode('all')}>
                全部分支
              </button>
            </div>
          )}
          {mainTab === 'map' && look === 'date' && (
            <div className="decision-filters" role="group" aria-label={t('筛选')}>
              <button type="button" data-only-ask aria-pressed={onlyAsk} onClick={() => setOnlyAsk(!onlyAsk)}>
                {t('只看等用户定')}
              </button>
            </div>
          )}
          {mainTab === 'map' && (
            <div className="decision-looks">
              <div className="decision-filters" role="group" aria-label={t('看法')}>
                <span className="decision-looks__label">{t('看法')}</span>
                {LOOKS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    data-look={item.key}
                    aria-pressed={look === item.key}
                    onClick={() => changeLook(item.key)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {look === 'mind' && (
                <div className="decision-filters" role="group" aria-label={t('思维导图方向')}>
                  <button
                    type="button"
                    data-dir="lr"
                    aria-pressed={direction === 'sides'}
                    onClick={() => changeDirection('sides')}
                  >
                    {t('左右')}
                  </button>
                  <button
                    type="button"
                    data-dir="tb"
                    aria-pressed={direction === 'down'}
                    onClick={() => changeDirection('down')}
                  >
                    {t('上下')}
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="decision-bar__right">
            {newVersionReady && (
              <button
                type="button"
                className="decision-upgrade-banner"
                onClick={() => window.location.reload()}
              >
                {t('有新版本，发完点此刷新')}
              </button>
            )}
            {pending.length > 0 && (
              <button type="button" className="decision-pending" onClick={openPending}>
                <span aria-hidden="true">★</span> {pending.length} 件待你决定
              </button>
            )}
            {pending.length === 0 && graph !== undefined && (
              <span className="decision-all-clear">当前无待定项</span>
            )}
            <button
              type="button"
              className="decision-refresh"
              disabled={refreshing}
              onClick={() => void checkVersion(true)}
            >
              {refreshing && t('刷新中')}
              {!refreshing && t('刷新')}
            </button>
          </div>
        </header>
      )}

      {/* 手机竖屏（< 800px）唯一 1 行 48px 原生极简顶栏 + 视图快切触发胶囊 */}
      {isMobile && (
        <header className="decision-m-header">
          <button
            type="button"
            className="decision-m-icon-btn"
            data-wd-drawer
            aria-label={t('打开菜单')}
            aria-expanded={mobileDrawerOpen}
            onClick={() => {
              setMobileSwitcherOpen(false);
              setMobileDrawerOpen((prev) => !prev);
            }}
          >
            ☰
          </button>
          <div className="decision-m-header__center">
            <h1 className="decision-m-header__title" title={mobileHeaderTitle}>{mobileHeaderTitle}</h1>
          </div>
          {totalProjectPending.length > 0 && !isAllPendingActive && (
            <button
              type="button"
              className="decision-m-pending-pill"
              data-wd-pending-pill
              aria-pressed={isAllPendingActive}
              onClick={toggleMobileAllPending}
            >
              ★ {String(totalProjectPending.length)}
            </button>
          )}
          <button
            type="button"
            className="decision-m-switcher-trigger"
            data-wd-switcher
            aria-expanded={mobileSwitcherOpen}
            onClick={toggleMobileSwitcher}
          >
            <span>{mobileSwitcherLabel}</span>
            <span className="decision-m-switcher-trigger__chev" aria-hidden="true">▾</span>
          </button>
          {newVersionReady && (
            <button
              type="button"
              className="decision-m-upgrade-pill"
              onClick={() => window.location.reload()}
            >
              {t('新版')} ↻
            </button>
          )}
          {!newVersionReady && (
            <button
              type="button"
              className="decision-m-icon-btn"
              data-spinning={refreshing}
              disabled={refreshing}
              aria-label={t('刷新')}
              onClick={() => void checkVersion(true)}
            >
              ↻
            </button>
          )}
        </header>
      )}

      {/* 手机端顶栏一键快切下拉弹层：专题方块 / 思维导图 / 全部待拍板 / 极简清单 */}
      {isMobile && mobileSwitcherOpen && (
        <>
          <div
            className="decision-m-switcher-mask"
            aria-hidden="true"
            onClick={() => setMobileSwitcherOpen(false)}
          />
          <section className="decision-m-switcher-pop" role="dialog" aria-label={t('快速切换视图')}>
            <div className="decision-m-switcher-pop__head">
              <strong>{t('切换视图')}</strong>
              <span>{t('一键秒切')}</span>
            </div>
            <div className="decision-m-switcher-grid">
              <button
                type="button"
                className="decision-m-switcher-card"
                data-switch-view="tiles"
                aria-pressed={isTileGridActive}
                onClick={switchMobileToTileGrid}
              >
                <span className="decision-m-switcher-card__top">
                  <span className="decision-m-switcher-card__icon">⊞</span>
                  <strong>{t('专题方块')}</strong>
                </span>
                <span className="decision-m-switcher-card__sub">
                  {String(topTopicCount)} {t('个专题 · 一屏两列')}
                </span>
              </button>
              <button
                type="button"
                className="decision-m-switcher-card"
                data-switch-view="quadrant"
                aria-pressed={look === 'quadrant'}
                onClick={() => changeLook('quadrant')}
              >
                <span className="decision-m-switcher-card__top">
                  <span className="decision-m-switcher-card__icon">◫</span>
                  <strong>{t('四象限')}</strong>
                </span>
                <span className="decision-m-switcher-card__sub">
                  {t('轻重缓急 · 点块放大拍板')}
                </span>
              </button>
              <button
                type="button"
                className="decision-m-switcher-card"
                data-switch-view="mind"
                aria-pressed={look === 'mind'}
                onClick={() => {
                  focusTree(undefined);
                  changeLook('mind');
                }}
              >
                <span className="decision-m-switcher-card__top">
                  <span className="decision-m-switcher-card__icon">◈</span>
                  <strong>{t('思维导图')}</strong>
                </span>
                <span className="decision-m-switcher-card__sub">
                  {t('单指拖动 · 点节点看详情')}
                </span>
              </button>
              <button
                type="button"
                className="decision-m-switcher-card decision-m-switcher-card--amber"
                data-switch-view="pending"
                aria-pressed={isAllPendingActive}
                onClick={() => {
                  selectTopic(topicView.ALL_PENDING_TOPIC);
                  setNodeId(undefined);
                  changeLook('topic');
                }}
              >
                <span className="decision-m-switcher-card__top">
                  <span className="decision-m-switcher-card__icon">★</span>
                  <strong>{t('全部待拍板')}</strong>
                  {totalProjectPending.length > 0 && (
                    <span className="decision-m-switcher-card__badge">
                      {String(totalProjectPending.length)}
                    </span>
                  )}
                </span>
                <span className="decision-m-switcher-card__sub">
                  {t('集中单手拍板待定项')}
                </span>
              </button>
            </div>
            <div className="decision-m-switcher-more">
              <span className="decision-m-switcher-more__label">{t('更多看法')}</span>
              <div className="decision-m-switcher-more__pills">
                <button
                  type="button"
                  aria-pressed={look === 'list'}
                  onClick={() => changeLook('list')}
                >
                  {t('极简清单')}
                </button>
                <button
                  type="button"
                  aria-pressed={look === 'date'}
                  onClick={() => changeLook('date')}
                >
                  {t('按日期')}
                </button>
                <button
                  type="button"
                  aria-pressed={look === 'radial'}
                  onClick={() => changeLook('radial')}
                >
                  {t('放射')}
                </button>
                <button
                  type="button"
                  aria-pressed={mainTab === 'map' && look === 'table'}
                  onClick={() => changeLook('table')}
                >
                  {t('表格')}
                </button>
                <button
                  type="button"
                  data-switch-view="tasks"
                  aria-pressed={mainTab === 'tasks'}
                  onClick={() => switchMainTab('tasks')}
                >
                  🎛️ {t('AI 任务控制面')}
                </button>
                <button
                  type="button"
                  data-switch-view="tick"
                  aria-pressed={mainTab === 'tick'}
                  onClick={() => switchMainTab('tick')}
                >
                  🧩 {t('AI工作台')}
                </button>
              </div>
            </div>
          </section>
        </>
      )}

      {/* 手机端 ☰ 侧滑菜单抽屉 */}
      {isMobile && mobileDrawerOpen && (
        <>
          <div
            className="decision-m-drawer-mask"
            aria-hidden="true"
            onClick={() => setMobileDrawerOpen(false)}
          />
          <aside className="decision-m-drawer" aria-label={t('工作台导航')}>
            <div className="decision-m-drawer__head">
              <div>
                <strong>{canvasLabel}</strong>
                {activeProject !== undefined && (
                  <p className="decision-m-drawer__goal">{activeProject.name}</p>
                )}
              </div>
              <button
                type="button"
                className="decision-m-icon-btn"
                aria-label={t('关闭菜单')}
                onClick={() => setMobileDrawerOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="decision-m-drawer__body">
              <button
                type="button"
                className="decision-m-drawer__cp-hero"
                aria-pressed={mainTab === 'tasks'}
                onClick={() => {
                  if (mainTab === 'tasks') {
                    switchMainTab('map');
                    return;
                  }
                  switchMainTab('tasks');
                }}
              >
                <span>🎛️ {t('AI 任务控制面')}</span>
                <span className="decision-m-drawer__cp-tag">
                  {mainTab === 'tasks' && t('切回决策图')}
                  {mainTab !== 'tasks' && t('进入任务台')}
                </span>
              </button>
              <button
                type="button"
                className="decision-m-drawer__cp-hero"
                aria-pressed={mainTab === 'tick'}
                onClick={() => {
                  if (mainTab === 'tick') {
                    switchMainTab('map');
                    return;
                  }
                  switchMainTab('tick');
                }}
              >
                <span>🧩 {t('积木AI工作台')}</span>
                <span className="decision-m-drawer__cp-tag">
                  {mainTab === 'tick' && t('切回决策图')}
                  {mainTab !== 'tick' && t('多视图工作台')}
                </span>
              </button>

              {totalProjectPending.length > 0 && (
                <button
                  type="button"
                  className="decision-m-drawer__pending-hero"
                  aria-pressed={isAllPendingActive}
                  onClick={() => {
                    selectTopic(topicView.ALL_PENDING_TOPIC);
                    setNodeId(undefined);
                    changeLook('topic');
                  }}
                >
                  <span>★ {t('只看全部待拍板')}</span>
                  <span className="decision-m-pending-pill">{String(totalProjectPending.length)}</span>
                </button>
              )}

              <div className="decision-m-drawer__group">
                <span className="decision-m-drawer__label">{t('专题目录')}</span>
                <div className="decision-m-drawer__topics">
                  {topicSummaries.map((item) => {
                    const active = look === 'topic' && !isAllPendingActive && item.node.id === resolvedTopicId;
                    let titleText = item.node.title;
                    if (item.isOverview && topicSummaries.length > 1) {
                      titleText = t('全部专题方块');
                    }
                    return (
                      <button
                        key={item.node.id}
                        type="button"
                        className="decision-topic-nav-btn"
                        aria-pressed={active}
                        onClick={() => {
                          selectTopic(item.node.id);
                          setNodeId(undefined);
                          changeLook('topic');
                        }}
                      >
                        <span className="decision-topic-nav-btn__row">
                          <span className="decision-topic-nav-btn__dot" data-state={item.state.key} />
                          <span className="decision-topic-nav-btn__title">{titleText}</span>
                        </span>
                        <span className="decision-topic-nav-btn__badges">
                          {item.pendingCount > 0 && (
                            <span className="decision-topic-badge decision-topic-badge--pending">
                              {String(item.pendingCount)}
                            </span>
                          )}
                          {item.taskCount > 0 && (
                            <span className="decision-topic-badge">
                              {String(item.doneCount)}/{String(item.taskCount)}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="decision-m-drawer__group">
                <span className="decision-m-drawer__label">{t('切换视图')}</span>
                <div className="decision-m-drawer__looks">
                  {LOOKS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      data-look={item.key}
                      aria-pressed={look === item.key}
                      onClick={() => changeLook(item.key)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {look === 'mind' && (
                  <div className="decision-m-drawer__looks">
                    <button
                      type="button"
                      data-dir="lr"
                      aria-pressed={direction === 'sides'}
                      onClick={() => {
                        changeDirection('sides');
                        setMobileDrawerOpen(false);
                      }}
                    >
                      {t('左右展开')}
                    </button>
                    <button
                      type="button"
                      data-dir="tb"
                      aria-pressed={direction === 'down'}
                      onClick={() => {
                        changeDirection('down');
                        setMobileDrawerOpen(false);
                      }}
                    >
                      {t('上下展开')}
                    </button>
                  </div>
                )}
              </div>

              {projects.length > 1 && (
                <div className="decision-m-drawer__group">
                  <span className="decision-m-drawer__label">{t('切换项目')}</span>
                  <div className="decision-m-drawer__topics">
                    {projects.map((project) => (
                      <button
                        key={project.root}
                        type="button"
                        className="decision-topic-nav-btn"
                        aria-pressed={project.root === root}
                        onClick={() => selectProject(project.root)}
                      >
                        <span className="decision-topic-nav-btn__title">{project.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="decision-m-drawer__foot">
              <a href={token.withToken('/tutorial/', token.TOKEN)}>📖 {t('去教程页')}</a>
              <a href={token.withToken('/', token.TOKEN)}>💬 {t('返回聊天')}</a>
              {webAuth.required && (
                <button
                  type="button"
                  onClick={() => {
                    setMobileDrawerOpen(false);
                    void webAuth.logout();
                  }}
                >
                  {webAuth.username !== '' && `${webAuth.username} · `}{t('退出')}
                </button>
              )}
            </div>
          </aside>
        </>
      )}

      {needToken && (
        <form className="decision-token-bar" onSubmit={saveToken}>
          <span>{t('请填写访问令牌（server.token）：')}</span>
          <input
            type="password"
            value={tokenInput}
            placeholder={t('粘贴访问令牌')}
            onChange={(event) => setTokenInput(event.target.value)}
          />
          <button type="submit" disabled={tokenInput.trim() === ''}>{t('保存并进入')}</button>
        </form>
      )}

      {mainTab === 'map' && look !== 'topic' && look !== 'quadrant' && scope.path.length > 0 && (
        <nav className="decision-breadcrumb" aria-label={t('任务树路径')}>
          <button type="button" data-tree-root onClick={() => focusTree()}>{t('全部节点')}</button>
          {scope.path.map((entry) => {
            if (entry.id === focused) return <span key={entry.id} aria-current="location">{entry.title}</span>;

            return (
              <button type="button" key={entry.id} data-tree-ancestor={entry.id} onClick={() => focusTree(entry.id)}>
                {entry.title}
              </button>
            );
          })}
        </nav>
      )}

      <div className="decision-content">
        {(mainTab === 'tasks' || visitedTasks) && (
          <div className="decision-cp-keepalive" style={tasksStyle}>
            <react.Suspense
              fallback={<div className="decision-empty" role="status">{t('正在加载 AI 任务控制面…')}</div>}
            >
              <LazyControlPlaneView
                externalTasksRev={tasksRev}
                isMobile={isMobile}
                sharedBoard={tasksBoard}
                sharedLoading={tasksLoading}
                onRefreshBoard={loadTasksBoard}
              />
            </react.Suspense>
          </div>
        )}

        {(mainTab === 'tick' || visitedTick) && (
          <div className="decision-cp-keepalive" style={tickStyle}>
            <react.Suspense
              fallback={<div className="decision-empty" role="status">{t('正在加载积木AI工作台…')}</div>}
            >
              <LazyTickWorkspace
                board={tasksBoard}
                loading={tasksLoading}
                onRefresh={loadTasksBoard}
                active={mainTab === 'tick'}
              />
            </react.Suspense>
          </div>
        )}

        {mainTab === 'map' && !isMobile && projects.length > 0 && (
          <nav className="decision-projects" aria-label={t('项目')}>
            {projects.map((project) => (
              <button
                key={project.root}
                type="button"
                aria-pressed={project.root === root}
                onClick={() => selectProject(project.root)}
              >
                {project.name}
              </button>
            ))}
          </nav>
        )}

        {((mainTab === 'map' && look === 'topic') || visitedTopic) && (
          <section
            className="decision-canvas decision-canvas--topic"
            aria-label={canvasLabel}
            data-look="topic"
            style={topicStyle}
          >
            {graph === undefined && <div className="decision-empty" role="status">{empty}</div>}
            {graph !== undefined && (
              <topicView.TopicView
                nodes={projectScope.nodes}
                isMobile={isMobile}
                topicId={topicId}
                onSelectTopic={selectTopic}
                selectedNodeId={nodeId}
                onSelectNode={setNodeId}
                onChooseOption={chooseOptionForNode}
                onSendNote={sendNoteForNode}
                savingKey={savingKey}
                actionError={chooseError}
                sending={sending}
                noteError={noteError}
                onRefresh={() => refresh()}
                onExpand={(id) => open(id, true)}
                onOpenInMind={openTopicInMind}
              />
            )}
          </section>
        )}

        {((mainTab === 'map' && look === 'quadrant') || visitedQuadrant) && (
          <section
            className="decision-canvas decision-canvas--quadrant"
            aria-label={canvasLabel}
            data-look="quadrant"
            style={quadrantStyle}
          >
            {graph === undefined && <div className="decision-empty" role="status">{empty}</div>}
            {graph !== undefined && (
              <react.Suspense fallback={<div className="decision-empty" role="status">{t('正在加载四象限矩阵…')}</div>}>
                <LazyQuadrantView
                  nodes={projectScope.nodes}
                  isMobile={isMobile}
                  selectedNodeId={nodeId}
                  onSelectNode={setNodeId}
                  onChooseOption={chooseOptionForNode}
                  onSendNote={sendNoteForNode}
                  savingKey={savingKey}
                  actionError={chooseError}
                  sending={sending}
                  noteError={noteError}
                  onRefresh={() => refresh()}
                  onExpand={(id) => open(id, true)}
                  onFocusTree={(id) => {
                    focusTree(id);
                    changeLook('mind');
                  }}
                  onOpenNodeTopic={openNodeTopic}
                />
              </react.Suspense>
            )}
          </section>
        )}

        {((mainTab === 'map' && look !== 'topic' && look !== 'quadrant') || visitedFlow) && (
          <section
            className="decision-canvas"
            aria-label={canvasLabel}
            ref={canvas}
            data-look={activeCanvasLook}
            style={canvasStyle}
          >
            {isCanvas && graph === undefined && (
              <div className="decision-empty" role="status">{empty}</div>
            )}
            {(isCanvas || visitedFlow) && look !== 'table' && look !== 'list' && graph !== undefined && (
              <react.Suspense fallback={<div className="decision-empty" role="status">{t('正在准备导图画布…')}</div>}>
                <LazyFlowCanvas
                  active={mainTab === 'map' && isCanvas}
                  root={root}
                  focused={focused}
                  look={activeCanvasLook}
                  mode={mode}
                  direction={direction}
                  onlyAsk={onlyAsk}
                  isMobile={isMobile}
                  portrait={portrait}
                  size={size}
                  scopeNodes={scope.nodes}
                  hasScopePath={scope.path.length > 0}
                  folds={folds}
                  emptyText={empty}
                  cameraRequest={cameraRequest}
                  onOpen={open}
                  onClose={close}
                  onChangeDirection={changeDirection}
                  onChangeMode={changeMode}
                />
              </react.Suspense>
            )}
            {!isCanvas && graph === undefined && <div className="decision-empty" role="status">{empty}</div>}
            {look === 'table' && graph !== undefined && (
              <react.Suspense fallback={<div className="decision-empty" role="status">{t('正在加载表格…')}</div>}>
                <LazyTableView nodes={scope.nodes} selected={nodeId} open={open} />
              </react.Suspense>
            )}
            {look === 'list' && graph !== undefined && (
              <react.Suspense fallback={<div className="decision-empty" role="status">{t('正在加载清单…')}</div>}>
                <LazyListView nodes={scope.nodes} selected={nodeId} open={open} folds={folds} toggle={open} />
              </react.Suspense>
            )}
            {mainTab === 'map' && look !== 'topic' && look !== 'quadrant' && selected !== undefined && (
              <drawer.Drawer
                key={selected.id}
                node={selected}
                byId={projectById}
                saving={drawerSaving}
                error={chooseError}
                close={close}
                choose={(opt) => void chooseOptionForNode(selected.id, opt)}
                sending={sending}
                noteError={noteError}
                send={(text, opt) => sendNoteForNode(selected.id, text, opt)}
                focus={() => focusTree(selected.id)}
                openTopic={() => openNodeTopic(selected.id)}
                refresh={() => refresh()}
                expand={(id) => open(id, true)}
              />
            )}
            {mainTab === 'map'
              && look !== 'topic'
              && look !== 'quadrant'
              && selected === undefined
              && overviewRoot !== undefined && (
              <div className="decision-overview-dock">
                <composer.CentralDock
                  targetNode={overviewRoot}
                  defaultNode={overviewRoot}
                  scopeNodes={scope.nodes}
                  onResetTarget={close}
                  onSelectNode={open}
                  onSendNote={(id, text) => sendNoteForNode(id, text)}
                  sending={sending}
                  noteError={noteError}
                />
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
