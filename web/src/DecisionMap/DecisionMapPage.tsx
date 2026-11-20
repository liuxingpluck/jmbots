/** 工作决策工作台：专题目录与总览导图双视图、常驻直达中控输入框、每 30 秒轻量版本自动刷新。 */
import * as react from 'react';
import * as xyflow from '@xyflow/react';
import type * as types from '../../../src7/plugins/work-decision/Types.ts';
import * as token from '../Token.ts';
import * as api from './DecisionMapApi.ts';
import * as composer from './Composer.tsx';
import * as dateMap from './DateMap.ts';
import * as drafts from './Drafts.ts';
import * as drawer from './Drawer.tsx';
import * as layout from './Layout.ts';
import * as nodes from './Nodes.tsx';
import * as topicView from './TopicView.tsx';
import * as views from './Views.tsx';
import * as words from './Words.ts';

/** 新加的界面字过语言包；写成 t('原文')，提取脚本 scripts/I18n_Extract.ts 才认得出。 */
const t = words.t;

/** 六种看法：专题目录、思维导图、按日期、放射图、表格、清单。 */
type Look = 'topic' | 'mind' | 'date' | 'radial' | 'table' | 'list';

const NODE_TYPES = { decision: nodes.DecisionNode, day: nodes.DayNode };
const ORIGIN: xyflow.NodeOrigin = [0.5, 0.5];
const FIT: xyflow.FitViewOptions = {
  padding: { top: '24px', bottom: '48px', left: '24px', right: '24px' },
  maxZoom: 1,
};
const FIT_MOBILE: xyflow.FitViewOptions = {
  padding: { top: '12px', bottom: '44px', left: '8px', right: '8px' },
  maxZoom: 1,
};
/** 每 30 秒发一次轻量 GET /api/work-decision/version（严禁使用 SSE 或 WebSocket）。 */
const VERSION_POLL_MS = 30_000;
const MOBILE_WIDTH = 670;
/** 浏览器里记看法和思维导图方向的键。 */
const LOOK_KEY = 'jmbots.decision-map.look';
const DIRECTION_KEY = 'jmbots.decision-map.direction';
/** 看法切换按钮，顺序即显示顺序。 */
const LOOKS: { key: Look; label: string }[] = [
  //M 专题目录与思维导图排在最前，手机与桌面都可一键切换。
  { key: 'topic', label: t('专题目录') },
  { key: 'mind', label: t('思维导图') },
  { key: 'date', label: t('按日期') },
  { key: 'radial', label: t('放射') },
  { key: 'table', label: t('表格') },
  { key: 'list', label: t('清单') },
];

/** 读浏览器里记着的一项；隐私模式等读不了时是 null。 */
function readStored(key: string): string | null {
  //G 本地存储可能被浏览器禁用，读不到就当没记过。
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 记下一项；写不了就算了，下次打开用默认看法。 */
function writeStored(key: string, value: string): void {
  //G 本地存储写满或被禁用时不影响切换本身。
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

/** 打开时用哪种看法：网址 ?look= 优先，其次浏览器记着的，首次打开默认进专题目录。 */
function getStartLook(): Look {
  const fromUrl = new URLSearchParams(window.location.search).get('look');
  const matchedUrl = LOOKS.find((item) => item.key === fromUrl);
  if (matchedUrl !== undefined) return matchedUrl.key;

  //M 再看浏览器记着的看法，认得出才用。
  const stored = readStored(LOOK_KEY);
  const known = LOOKS.find((item) => item.key === stored);
  if (known !== undefined) return known.key;

  return 'topic';
}

/** 思维导图方向：记着“上下”就上下，默认左右。 */
function getStartDirection(): layout.MindDirection {
  //M 只有记着“上下”时才竖排。
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
  const [graph, setGraph] = react.useState<types.DecisionGraph>();
  const [loadingError, setLoadingError] = react.useState<string>();
  const focusLink = new URLSearchParams(window.location.search).get('focus') ?? undefined;
  const [nodeId, setNodeId] = react.useState<string | undefined>(focusLink);
  const [projectRoot, setProjectRoot] = react.useState<string>();
  const [topicId, setTopicId] = react.useState<string>();
  const [savingKey, setSavingKey] = react.useState<string>();
  const [chooseError, setChooseError] = react.useState<string>();
  const [mode, setMode] = react.useState<layout.ViewMode>('main');
  const [look, setLook] = react.useState<Look>(getStartLook);
  const [direction, setDirection] = react.useState<layout.MindDirection>(getStartDirection);
  const [onlyAsk, setOnlyAsk] = react.useState(false);
  const [sending, setSending] = react.useState(false);
  const [noteError, setNoteError] = react.useState<string>();
  const [folds, setFolds] = react.useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [focused, setFocused] = react.useState<string>();
  const [newVersionReady, setNewVersionReady] = react.useState(false);
  const [refreshing, setRefreshing] = react.useState(false);
  const [needToken, setNeedToken] = react.useState(false);
  const [tokenInput, setTokenInput] = react.useState('');

  const canvas = react.useRef<HTMLElement>(null);
  const flow = react.useRef<xyflow.ReactFlowInstance<layout.FlowNode> | undefined>(undefined);
  const lastPending = react.useRef<string | undefined>(undefined);
  const appStartedAtRef = react.useRef<number | undefined>(undefined);
  const dataRevRef = react.useRef<number | undefined>(undefined);
  const checkingRef = react.useRef(false);
  const [size, setSize] = react.useState({ width: 0, height: 0 });
  const portrait = size.width <= MOBILE_WIDTH;

  react.useEffect(() => {
    //M 外网或手机未带令牌回 401 时显示轻量令牌输入条，保存后刷新即可进入。
    const onUnauthorized = (): void => {
      setNeedToken(true);
    };
    window.addEventListener('jmbots:unauthorized', onUnauthorized);
    return () => window.removeEventListener('jmbots:unauthorized', onUnauthorized);
  }, []);

  react.useLayoutEffect(() => {
    const element = canvas.current;
    if (element === null) return;

    //M 用画布的实际尺寸排图，顶栏换行和手机竖屏都计入可用空间。
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((current) => {
        if (current.width === width && current.height === height) return current;

        return { width, height };
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [look]);

  /** 静默拉取最新节点图并在本地合并，绝不整页刷新、不清空草稿、不抢输入框焦点。 */
  const refresh = react.useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api.getGraph(signal);
      dataRevRef.current = next.revision;
      setGraph((current) => {
        if (current === undefined || next.revision !== current.revision) return next;
        if (JSON.stringify(next.projects) !== JSON.stringify(current.projects)) {
          return { ...current, projects: next.projects };
        }
        return current;
      });
      setLoadingError(undefined);
    } catch (error) {
      if (signal?.aborted === true) return;

      let message = String(error);
      if (error instanceof Error) message = error.message;
      setLoadingError(message);
    }
  }, []);

  /** 检查轻量版本探针：仅 dataRev 变化时静默拉图；appStartedAt 变化时按空闲/草稿状态安全处理。 */
  const checkVersion = react.useCallback(async (manual = false, signal?: AbortSignal) => {
    if (checkingRef.current && !manual) return;

    checkingRef.current = true;
    if (manual) setRefreshing(true);
    try {
      const ver = await api.getVersion(signal);
      const prevStarted = appStartedAtRef.current;
      if (prevStarted === undefined) {
        appStartedAtRef.current = ver.appStartedAt;
      }
      if (prevStarted !== undefined && ver.appStartedAt !== prevStarted) {
        //G 后端换了新版本：空闲且无草稿时直接刷新；正在输入或有草稿时只挂温和横幅，绝不丢字。
        if (!isUserBusyWithInput()) {
          window.location.reload();
          return;
        }
        setNewVersionReady(true);
      }
      if (manual || dataRevRef.current === undefined || ver.dataRev !== dataRevRef.current) {
        await refresh(signal);
      }
    } catch (error) {
      if (signal?.aborted === true) return;

      //G 首次还没拉到图时把错误透出到空状态，后续静默轮询偶发断网不打断正在看的内容。
      if (dataRevRef.current === undefined || manual) {
        let message = String(error);
        if (error instanceof Error) message = error.message;
        setLoadingError(message);
      }
    } finally {
      checkingRef.current = false;
      if (manual) setRefreshing(false);
    }
  }, [refresh]);

  react.useEffect(() => {
    const control = new AbortController();

    //M 首次进入拉一次版本与全图，随后每 30 秒及切回前台时做轻量 GET 检查。
    void checkVersion(true, control.signal);
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
    };
  }, [checkVersion]);

  const open = react.useCallback((id: string, expand?: boolean) => {
    if (expand !== undefined) {
      //M 按节点编号保存开关，切换视图和轮询后仍可继续读同一分支。
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
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [close]);

  const projects = graph?.projects ?? [];
  const linkedNode = graph?.nodes.find((node) => node.id === focusLink);
  let root = projectRoot ?? projects[0]?.root;
  if (projectRoot === undefined && linkedNode !== undefined) {
    //M 分享的链接直接打开对应项目，未指定节点时使用第一个项目。
    const linkedRoot = graph?.nodes.find((node) => {
      return node.parent === null && node.bot === linkedNode.bot && node.workspaceId === linkedNode.workspaceId;
    });
    root = linkedRoot?.id ?? root;
  }

  //M 当前项目完整树供专题目录使用，子树聚焦供导图/表格/清单使用。
  const projectScope = react.useMemo(() => {
    const entries = graph?.nodes ?? [];
    return views.getScope(entries, root);
  }, [graph, root]);

  const scope = react.useMemo(() => {
    return views.getScope(projectScope.nodes, focused);
  }, [projectScope.nodes, focused]);

  //M 带着 ?focus= 打开时，把专题自动对齐到该节点所属的顶层子主题。
  react.useEffect(() => {
    if (topicId !== undefined || focusLink === undefined || root === undefined) return;
    if (projectScope.nodes.length === 0) return;

    const matched = topicView.findTopicIdForNode(projectScope.nodes, root, focusLink);
    setTopicId(matched);
  }, [topicId, focusLink, root, projectScope.nodes]);

  /** 进子树或回上层。聚焦根至少展开一层。 */
  function focusTree(id?: string): void {
    close();
    setFocused(id);
    if (id !== undefined) open(id, true);
  }

  /** 选择项目后关闭上一个项目的详情、子树焦点和旧专题编号。 */
  function selectProject(id: string): void {
    if (id === root) return;

    focusTree();
    setTopicId(undefined);
    setProjectRoot(id);
  }

  //M 视图变化后重新布置节点，静默轮询维持画布位置。
  const diagram = react.useMemo(() => {
    if (size.width === 0 || size.height === 0) return { nodes: [], edges: [] };

    const view = { mode, folds, portrait, ...size };
    if (scope.path.length > 0) view.mode = 'all';
    if (look === 'date') return dateMap.getDateLayout(scope.nodes, folds, open, onlyAsk);
    if (look === 'mind') return layout.getMindLayout(scope.nodes, view, open, direction);
    if (look === 'radial') return layout.getLayout(scope.nodes, view, open);

    return { nodes: [], edges: [] };
  }, [scope, mode, folds, portrait, size, open, look, direction, onlyAsk]);

  const isCanvas = look === 'date' || look === 'mind' || look === 'radial';
  let activePendingSource = scope.nodes;
  if (look === 'topic') {
    activePendingSource = projectScope.nodes;
  }
  const pending = activePendingSource.filter((node) => node.kind === 'pending' && node.status === 'open');
  const selected = projectScope.nodes.find((node) => node.id === nodeId);
  const overviewRoot = scope.nodes.find((node) => node.parent === null);
  let fit = FIT;
  if (portrait) {
    fit = FIT_MOBILE;
  }

  /** 切换到明确选中的画布过滤范围。 */
  function changeMode(next: layout.ViewMode): void {
    if (mode === next) return;

    close();
    setMode(next);
  }

  /** 切换看法并记在浏览器里，下次打开还是这个。 */
  function changeLook(next: Look): void {
    if (look === next) return;

    writeStored(LOOK_KEY, next);
    setLook(next);
  }

  /** 从任意节点切进它所属的专题目录。 */
  function openNodeTopic(targetId: string): void {
    if (root !== undefined) {
      const belongTopic = topicView.findTopicIdForNode(projectScope.nodes, root, targetId);
      setTopicId(belongTopic);
    }
    setNodeId(targetId);
    changeLook('topic');
  }

  /** 从专题切到思维导图并聚焦该专题子树。 */
  function openTopicInMind(targetId: string): void {
    if (targetId === root) {
      focusTree(undefined);
    }
    if (targetId !== root) {
      focusTree(targetId);
    }
    changeLook('mind');
  }

  /** 思维导图在左右和上下之间切换，同样记在浏览器里。 */
  function changeDirection(next: layout.MindDirection): void {
    if (direction === next) return;

    writeStored(DIRECTION_KEY, next);
    setDirection(next);
  }

  /** 从顶栏依次定位下一件待拍板事项（专题目录跳对应专题，画布飞到对应卡片）。 */
  function openPending(): void {
    if (pending.length === 0) return;

    const current = pending.findIndex((node) => node.id === lastPending.current);
    const next = pending[(current + 1) % pending.length]!;
    lastPending.current = next.id;
    open(next.id);

    if (look === 'topic' && root !== undefined) {
      const belong = topicView.findTopicIdForNode(projectScope.nodes, root, next.id);
      setTopicId(belong);
      window.requestAnimationFrame(() => {
        const selector = `[data-node-id="${CSS.escape(next.id)}"]`;
        document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return;
    }

    const map = flow.current;
    const target = diagram.nodes.find((node) => node.id === next.id);
    if (map === undefined || target === undefined) return;

    const zoom = Math.max(1.08, map.getZoom());
    let y = target.position.y;
    if (portrait) y += size.height * 0.28 / zoom;
    let duration = 480;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) duration = 0;
    const camera = { zoom, duration };
    void map.setCenter(target.position.x, y, camera);
  }

  const connect = react.useCallback((map: xyflow.ReactFlowInstance<layout.FlowNode>) => {
    flow.current = map;
  }, []);

  /** 把指定节点的选项持久化，成功后用回执立刻更新这个节点。 */
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

  /** 把用户写的话发给中控（POST /api/work-decision/note），可一并带上选项。 */
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

  /** 保存访问令牌到浏览器并刷新。 */
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

  const canvasLabel = t('工作决策');

  return (
    <main className="decision-page">
      <header className="decision-bar">
        <div className="decision-bar__title">
          <a href={token.withToken('/', token.TOKEN)} className="decision-back" aria-label="返回 jmbots" title="返回 jmbots">‹</a>
          <h1>{canvasLabel}</h1>
        </div>
        {(look === 'mind' || look === 'radial') && scope.path.length === 0 && (
          <div className="decision-filters" role="group" aria-label="画布显示范围">
            <button type="button" aria-pressed={mode === 'main'} onClick={() => changeMode('main')}>当前进展</button>
            <button type="button" aria-pressed={mode === 'pending'} onClick={() => changeMode('pending')}>只看待定</button>
            <button type="button" aria-pressed={mode === 'all'} onClick={() => changeMode('all')}>全部分支</button>
          </div>
        )}
        {look === 'date' && (
          <div className="decision-filters" role="group" aria-label={t('筛选')}>
            <button type="button" data-only-ask aria-pressed={onlyAsk} onClick={() => setOnlyAsk(!onlyAsk)}>
              {t('只看等用户定')}
            </button>
          </div>
        )}
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

      {needToken && (
        <form className="decision-token-bar" onSubmit={saveToken}>
          <span>{t('外网或手机访问需填一次访问令牌（server.token）：')}</span>
          <input
            type="password"
            value={tokenInput}
            placeholder={t('粘贴访问令牌')}
            onChange={(event) => setTokenInput(event.target.value)}
          />
          <button type="submit" disabled={tokenInput.trim() === ''}>{t('保存并进入')}</button>
        </form>
      )}

      {look !== 'topic' && scope.path.length > 0 && (
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
        {projects.length > 0 && (
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

        {look === 'topic' && (
          <section className="decision-canvas decision-canvas--topic" aria-label={canvasLabel} data-look={look}>
            {graph === undefined && <div className="decision-empty" role="status">{empty}</div>}
            {graph !== undefined && (
              <topicView.TopicView
                nodes={projectScope.nodes}
                topicId={topicId}
                onSelectTopic={setTopicId}
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

        {look !== 'topic' && (
          <section className="decision-canvas" aria-label={canvasLabel} ref={canvas} data-look={look}>
            {isCanvas && diagram.nodes.length > 0 && (
              <xyflow.ReactFlow<layout.FlowNode>
                key={`${root ?? ''}-${look}-${direction}-${mode}-${onlyAsk}-${size.width}x${size.height}-${focused ?? ''}`}
                nodes={diagram.nodes}
                edges={diagram.edges}
                nodeTypes={NODE_TYPES}
                nodeOrigin={ORIGIN}
                nodesDraggable={false}
                nodesConnectable={false}
                edgesFocusable={false}
                fitView
                fitViewOptions={fit}
                minZoom={0.08}
                maxZoom={2}
                className="dark"
                onInit={connect}
                onPaneClick={close}
              >
                <xyflow.Background gap={26} size={1.2} color="#303a50" />
                <xyflow.Controls position="bottom-right" showInteractive={false} fitViewOptions={fit} />
              </xyflow.ReactFlow>
            )}
            {isCanvas && diagram.nodes.length === 0 && <div className="decision-empty" role="status">{empty}</div>}
            {!isCanvas && graph === undefined && <div className="decision-empty" role="status">{empty}</div>}
            {look === 'table' && graph !== undefined && (
              <views.TableView nodes={scope.nodes} selected={nodeId} open={open} />
            )}
            {look === 'list' && graph !== undefined && (
              <views.ListView nodes={scope.nodes} selected={nodeId} open={open} folds={folds} toggle={open} />
            )}
            {look === 'date' && diagram.nodes.length > 0 && (
              <ul className="decision-legend" aria-label="图例">
                <li><i data-tone="pending" />{t('等用户定')}</li>
                <li><i data-tone="confirmed" />{t('中控已定')}</li>
                <li><i data-tone="chosen" />{t('用户已定')}</li>
                <li><i data-tone="done" />{t('做完')}</li>
              </ul>
            )}
            {(look === 'mind' || look === 'radial') && diagram.nodes.length > 0 && (
              <ul className="decision-legend" aria-label="图例">
                <li><i data-tone="main" />主线</li>
                <li><i data-tone="pending" />待定</li>
                <li><i data-tone="working" />进行中</li>
                <li><i data-tone="confirmed" />中控已定</li>
                <li><i data-tone="chosen" />用户已定</li>
              </ul>
            )}
            {selected !== undefined && (
              <drawer.Drawer
                key={selected.id}
                node={selected}
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
            {selected === undefined && overviewRoot !== undefined && (
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
