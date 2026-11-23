/**
 * 积木知识库与记忆一体化工作台（/knowledge/）：
 * 顶栏提供清晰三态视图切换：「📄 文档」 | 「🕸️ 关系图谱」 | 「🧠 记忆与 VGR」（同步到网址 ?view=）。
 * - 「📄 文档」：桌面 >=800px 三栏（目录与标签 / 文档列表 / 编辑器），手机 <800px 单栏三屏；
 * - 「🕸️ 关系图谱」：主内容区全幅 Obsidian 级交互力导向画布 + 右侧节点轻预览抽屉；
 * - 「🧠 记忆与 VGR」：混合检索（keyword / vector / graph 徽章）、长期记忆条管理与本地嵌入模型配置（memory.yaml）。
 * 全站交互均采用应用内模态框（KbDialogs.tsx）与轻量 Toast，仅保留关页未保存的浏览器 beforeunload 守卫。
 */
import * as react from 'react';
import * as token from '../Token.ts';
import * as dirTree from './DirTree.tsx';
import * as docList from './DocList.tsx';
import * as folderSync from './FolderSyncPanel.tsx';
import * as dialogs from './KbDialogs.tsx';
import * as api from './KnowledgeApi.ts';
import type * as editorModule from './KnowledgeEditor.tsx';
import * as wiki from './WikiLinks.ts';

/** 编辑器连同 Markdown 渲染按需加载，首屏轻快。 */
const LazyEditor = react.lazy(async () => {
  const mod = await import('./KnowledgeEditor.tsx');
  return { default: mod.KnowledgeEditor };
});

/** 全幅关系图谱画布按需加载。 */
const LazyGraph = react.lazy(async () => {
  const mod = await import('./GraphView.tsx');
  return { default: mod.GraphView };
});

/** 记忆与 VGR 视图按需加载。 */
const LazyMemoryVgr = react.lazy(async () => {
  const mod = await import('./MemoryVgrView.tsx');
  return { default: mod.MemoryVgrView };
});

/** 顶栏三大主视图模式。 */
export type KnowledgeMainView = 'docs' | 'graph' | 'memory';

/** 窄于这个宽度按手机排（和 /work-decision/ 同一个断点）。 */
const MOBILE_BREAKPOINT = 800;
/** 搜索框停手多久才发搜索。 */
const SEARCH_DELAY_MS = 300;
/** 提示条显示多久。 */
const NOTICE_MS = 5000;
/** 这个页面在网址里用的参数；写网址时先全删再按现状写，别的参数（令牌）不动。 */
const URL_KEYS = ['view', 'dir', 'tag', 'tagMode', 'rule', 'q', 'doc', 'topic', 'new', 'title'];

/** 右栏打开的东西：一篇已有文档（可能还在加载），或一个新建表单。 */
interface Opened {
  /** 编辑器的 key：换文档、新建出来后换 key，编辑器重挂。 */
  key: string;
  /** 文档号；新建是 undefined。 */
  id: string | undefined;
  /** 拉到的文档；还在拉、或新建时是 undefined。 */
  doc: api.KnowledgeDoc | undefined;
  /** 新建预填。 */
  preset: editorModule.Preset;
}

/** 网址里读出的初始状态。 */
interface UrlState {
  /** 当前顶栏视图。 */
  view: KnowledgeMainView;
  /** 目录筛选。 */
  dir: string | undefined;
  /** 标签筛选；网址里写成 ?tag=a,b。 */
  tags: string[];
  /** 多个标签怎么组合；网址里 ?tagMode=any 是任一满足，不写是全部满足。 */
  tagMode: api.KnowledgeTagMode;
  /** 只看硬性系统规则；网址里 ?rule=1。 */
  ruleOnly: boolean;
  /** 专题筛选。 */
  topic: string | undefined;
  /** 搜索词。 */
  q: string;
  /** 打开的文档号。 */
  doc: string | undefined;
  /** ?new=1 时的新建预填。 */
  preset: editorModule.Preset | undefined;
}

/** 已有文档用不到预填，给个空的。 */
const EMPTY_PRESET: editorModule.Preset = { title: '', topicId: null, dirId: null };


/** 读网址参数。 */
function readUrl(): UrlState {
  const params = new URLSearchParams(window.location.search);

  /** 取一个参数，空的当没有。 */
  const getOne = (name: string): string | undefined => {
    const value = params.get(name);
    if (value === null || value === '') return undefined;

    return value;
  };

  let view: KnowledgeMainView = 'docs';
  const rawView = params.get('view');
  if (rawView === 'graph' || rawView === 'memory') {
    view = rawView;
  }

  //M ?new=1 带专题和标题：工作决策节点“记一篇”跳过来的。
  let preset: editorModule.Preset | undefined;
  if (params.get('new') === '1') {
    preset = { title: params.get('title') ?? '', topicId: getOne('topic') ?? null, dirId: null };
    view = 'docs';
  }
  let tagMode: api.KnowledgeTagMode = 'all';
  if (params.get('tagMode') === 'any') {
    tagMode = 'any';
  }
  return {
    view,
    dir: getOne('dir'),
    tags: (getOne('tag') ?? '').split(',').filter((one) => one !== ''),
    tagMode,
    ruleOnly: params.get('rule') === '1',
    topic: getOne('topic'),
    q: params.get('q') ?? '',
    doc: getOne('doc'),
    preset,
  };
}


/**
 * 把现状写回网址（replaceState，不加历史；手机返回键那一层的 history.state 保留）。
 * @param values 参数名到值，空的不写。
 */
function writeUrl(values: Record<string, string | undefined>): void {
  const params = new URLSearchParams(window.location.search);
  for (const key of URL_KEYS) {
    params.delete(key);
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === '') {
      continue;
    }

    params.set(key, value);
  }
  let search = params.toString();
  if (search !== '') {
    search = `?${search}`;
  }
  const next = `${window.location.pathname}${search}`;
  window.history.replaceState(window.history.state, '', next);
}


/** 一个错误给人看的一句话。 */
function getMessage(error: unknown): string {
  if (error instanceof Error) return error.message;

  return String(error);
}


/** 现在是不是手机窄屏，跟着窗口宽度变。 */
function useIsMobile(): boolean {
  const query = `(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`;
  const [isMobile, setIsMobile] = react.useState(() => window.matchMedia(query).matches);
  react.useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = (): void => setIsMobile(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return isMobile;
}


/** 知识库页面。 */
export function KnowledgePage(): react.JSX.Element {
  const [initial] = react.useState(readUrl);
  const isMobile = useIsMobile();
  const kbDialog = dialogs.useKbDialog();

  //M 顶栏主视图（文档 / 关系图谱 / 记忆与 VGR）与图谱初始聚焦节点。
  const [view, setView] = react.useState<KnowledgeMainView>(initial.view);
  const [graphFocusId, setGraphFocusId] = react.useState<string | undefined>(initial.doc);

  //M 筛选：目录、标签、专题；搜索框的字（qInput）停手 300ms 才变成真正生效的 q。
  const [dir, setDir] = react.useState(initial.dir);
  const [tags, setTags] = react.useState(initial.tags);
  const [tagMode, setTagMode] = react.useState(initial.tagMode);
  const [ruleOnly, setRuleOnly] = react.useState(initial.ruleOnly);
  const [topic, setTopic] = react.useState(initial.topic);
  const [qInput, setQInput] = react.useState(initial.q);
  const [q, setQ] = react.useState(initial.q.trim());

  //M 左栏数据、中栏列表或搜索结果。
  const [tree, setTree] = react.useState<api.KnowledgeTreeResponse>();
  //M 整库双链图谱：全幅图谱画布的数据源，也是 [[ 联想的标题索引。
  const [graph, setGraph] = react.useState<api.KnowledgeGraphResponse>();
  const [syncOpen, setSyncOpen] = react.useState(false);
  const [items, setItems] = react.useState<api.KnowledgeDocSummary[]>([]);
  /** 现在列表里显示了几条：切回页面刷新时按它拉（visibilitychange 的监听里读）。 */
  const itemCountRef = react.useRef(0);
  itemCountRef.current = items.length;
  const [total, setTotal] = react.useState(0);
  const [hits, setHits] = react.useState<api.KnowledgeSearchHit[]>();
  const [memoryHits, setMemoryHits] = react.useState<api.KnowledgeMemoryHit[]>([]);
  const [memoryWarning, setMemoryWarning] = react.useState<string>();
  const [loading, setLoading] = react.useState(true);
  const [listError, setListError] = react.useState<string>();

  //M 右栏、只读、提示、手机目录抽屉。
  const [opened, setOpened] = react.useState<Opened | undefined>(() => {
    if (initial.preset === undefined) return undefined;

    return { key: 'new:0', id: undefined, doc: undefined, preset: initial.preset };
  });
  const [readOnly, setReadOnly] = react.useState(false);
  //M 左栏改名、删了标签后，开着那篇的最新一份，交给编辑器换底稿（见 syncOpenedTag）。
  const [tagChange, setTagChange] = react.useState<editorModule.TagChange>();
  const [notice, setNotice] = react.useState<string>();
  const [drawerOpen, setDrawerOpen] = react.useState(false);

  //M 两路请求各自的中止器和序号；编辑器有没有没保存的改动；手机上压了一层返回历史没有。
  const listAbortRef = react.useRef<AbortController | null>(null);
  const listSeqRef = react.useRef(0);
  const docAbortRef = react.useRef<AbortController | null>(null);
  const docSeqRef = react.useRef(0);
  const treeSeqRef = react.useRef(0);
  const newSeqRef = react.useRef(1);
  const dirtyRef = react.useRef(false);
  const pushedRef = react.useRef(false);
  const openedKeyRef = react.useRef<string | undefined>(undefined);
  const noticeTimerRef = react.useRef<number | undefined>(undefined);

  /** 显示一句提示，几秒后自动收起。 */
  const showNotice = react.useCallback((text: string) => {
    window.clearTimeout(noticeTimerRef.current);
    setNotice(text);
    noticeTimerRef.current = window.setTimeout(() => setNotice(undefined), NOTICE_MS);
  }, []);

  /** 接口出错统一处理：403 切只读，其余提示原因。 */
  const handleError = react.useCallback((error: unknown) => {
    if (error instanceof api.KnowledgeError && error.status === 403) {
      setReadOnly(true);
    }
    showNotice(getMessage(error));
  }, [showNotice]);

  //==========================================================
  //M 拉数据：左栏树；中栏列表或搜索（一路，带中止和序号）
  //==========================================================
  const loadTree = react.useCallback(async () => {
    treeSeqRef.current += 1;
    const seq = treeSeqRef.current;
    try {
      //M 图谱拿不到（老后端）不挡目录树，标题索引空着就是了。
      const graphLoad = api.fetchGraph().catch(() => undefined);
      const [next, nextGraph] = await Promise.all([api.getTree(), graphLoad]);
      if (seq !== treeSeqRef.current) return;

      setTree(next);
      setGraph(nextGraph);
    } catch (error) {
      showNotice(getMessage(error));
    }
  }, [showNotice]);

  const loadList = react.useCallback(async (offset: number, limit = api.PAGE_SIZE) => {
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    listSeqRef.current += 1;
    const seq = listSeqRef.current;
    const query: api.DocQuery = { dirId: dir, tags, tagMode, systemRule: ruleOnly, topicId: topic };
    setLoading(true);
    try {
      //M 有搜索词：走混合搜索，本地命中加相关记忆。
      if (q !== '') {
        const found = await api.search(q, query, controller.signal);
        if (seq !== listSeqRef.current) return;

        setHits(found.hits);
        setMemoryHits(found.memoryHits);
        setMemoryWarning(found.memoryWarning);
        setListError(undefined);
        return;
      }

      //M 没搜索词：分页列表；offset 为 0 是重拉，大于 0 是接在后面。
      const page = await api.listDocs({ ...query, offset, limit }, controller.signal);
      if (seq !== listSeqRef.current) return;

      setHits(undefined);
      setTotal(page.total);
      setListError(undefined);
      if (offset === 0) {
        setItems(page.items);
        return;
      }
      setItems((current) => [...current, ...page.items]);
    } catch (error) {
      if (controller.signal.aborted) return;

      setListError(getMessage(error));
    } finally {
      if (seq === listSeqRef.current) {
        setLoading(false);
      }
    }
  }, [dir, tags, tagMode, ruleOnly, topic, q]);

  //M 首屏拉树；筛选一变就重拉列表。
  react.useEffect(() => {
    void loadTree();
  }, [loadTree]);
  react.useEffect(() => {
    void loadList(0);
  }, [loadList]);

  //M 搜索框停手 300ms 才生效。
  react.useEffect(() => {
    const timer = window.setTimeout(() => setQ(qInput.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [qInput]);

  //M 切回这个标签页时轻刷新树和列表（不动正在编辑的文档）。
  react.useEffect(() => {
    const onVisibility = (): void => {
      if (document.hidden) return;

      void loadTree();

      let limit = api.PAGE_SIZE;
      if (itemCountRef.current > api.PAGE_SIZE) {
        limit = Math.min(200, itemCountRef.current);
      }
      void loadList(0, limit);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [loadTree, loadList]);

  //M 现状写回网址；?new、?title 只在第一次用，写回时就去掉了。
  react.useEffect(() => {
    const tag = tags.join(',');
    let modeParam: string | undefined;
    if (tagMode === 'any') {
      modeParam = 'any';
    }
    let rule: string | undefined;
    if (ruleOnly) {
      rule = '1';
    }
    let viewParam: string | undefined;
    if (view !== 'docs') {
      viewParam = view;
    }
    writeUrl({ view: viewParam, dir, tag, tagMode: modeParam, rule, topic, q, doc: opened?.id });
  }, [view, dir, tags, tagMode, ruleOnly, topic, q, opened?.id]);

  //==========================================================
  //M 右栏：打开、新建、关掉文档；全程应用内确认框，不弹原生 confirm
  //==========================================================

  /** 有没保存的改动时用应用内弹窗确认离开（草稿已存，离开也能找回）。 */
  const confirmLeave = react.useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;

    return kbDialog.confirm({
      title: '未保存改动提示',
      message: '当前文档有尚未保存的改动（已自动暂存为草稿），确定离开吗？',
      confirmText: '离开当前文档',
    });
  }, [kbDialog]);

  /** 手机上打开文档时压一层历史。 */
  const pushMobile = react.useCallback(() => {
    if (!isMobile || pushedRef.current) return;

    window.history.pushState({ kb: 'doc' }, '', window.location.href);
    pushedRef.current = true;
  }, [isMobile]);

  const openDoc = react.useCallback(async (id: string, force = false) => {
    if (!force && !(await confirmLeave())) return;

    setView('docs');
    docAbortRef.current?.abort();
    const controller = new AbortController();
    docAbortRef.current = controller;
    docSeqRef.current += 1;
    const seq = docSeqRef.current;
    dirtyRef.current = false;
    setOpened({ key: `doc:${id}:${String(seq)}`, id, doc: undefined, preset: EMPTY_PRESET });
    pushMobile();
    try {
      const doc = await api.getDoc(id, controller.signal);
      if (seq !== docSeqRef.current) return;

      setOpened({ key: `doc:${id}:${String(seq)}`, id, doc, preset: EMPTY_PRESET });
    } catch (error) {
      if (controller.signal.aborted) return;

      setOpened(undefined);
      if (pushedRef.current) {
        pushedRef.current = false;
        window.history.back();
      }
      showNotice(getMessage(error));
    }
  }, [confirmLeave, pushMobile, showNotice]);

  //M 网址里带了 ?doc= 就打开它（只在首屏做一次）。
  const firstDocRef = react.useRef(initial.doc);
  react.useEffect(() => {
    const id = firstDocRef.current;
    if (id === undefined || initial.preset !== undefined) return;

    firstDocRef.current = undefined;
    if (initial.view === 'docs') {
      void openDoc(id, true);
    }
  }, [initial.preset, initial.view, openDoc]);

  /**
   * 新建：预填当前所在的目录和专题；点了还没创建的双链时顺带预填标题。
   * @param title 预填的标题；顶栏「新建」是空串。
   */
  const newDoc = react.useCallback(async (title: string) => {
    if (!(await confirmLeave())) return;

    setView('docs');
    docAbortRef.current?.abort();
    docSeqRef.current += 1;
    newSeqRef.current += 1;
    dirtyRef.current = false;
    let dirId: string | null = null;
    if (dir !== undefined && dir !== api.UNASSIGNED) {
      dirId = dir;
    }
    const preset = { title, topicId: topic ?? null, dirId };
    setOpened({ key: `new:${String(newSeqRef.current)}`, id: undefined, doc: undefined, preset });
    pushMobile();
  }, [confirmLeave, dir, topic, pushMobile]);

  /** 关掉右栏；手机上把压的那层历史退掉。 */
  const closeDoc = react.useCallback(async (force = false) => {
    if (!force && !(await confirmLeave())) return;

    dirtyRef.current = false;
    docAbortRef.current?.abort();
    setOpened(undefined);
    if (pushedRef.current) {
      pushedRef.current = false;
      window.history.back();
    }
  }, [confirmLeave]);

  //M 安卓返回键：退回列表；若有未保存改动，先保持在文档里并用应用内弹窗询问。
  react.useEffect(() => {
    const onPopState = (): void => {
      if (!pushedRef.current) return;

      pushedRef.current = false;
      if (!dirtyRef.current) {
        setOpened(undefined);
        return;
      }

      //M 先把历史压回原位，等用户确认离开后再真正关闭。
      window.history.pushState({ kb: 'doc' }, '', window.location.href);
      pushedRef.current = true;
      void confirmLeave().then((ok) => {
        if (ok) {
          dirtyRef.current = false;
          setOpened(undefined);
          if (pushedRef.current) {
            pushedRef.current = false;
            window.history.back();
          }
        }
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [confirmLeave]);

  //M 关页、刷新前有没保存的改动：保留浏览器 beforeunload 提示。
  react.useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return;

      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  /** 切换到关系图谱视图（若有未保存编辑先确认，以免切换视图卸载编辑器丢失内存状态）。 */
  const switchView = react.useCallback(async (nextView: KnowledgeMainView, focusDocId?: string) => {
    if (nextView === view) {
      if (nextView === 'graph' && focusDocId !== undefined) {
        setGraphFocusId(focusDocId);
      }
      return;
    }
    if (view === 'docs' && !(await confirmLeave())) {
      return;
    }
    if (view === 'docs') {
      dirtyRef.current = false;
    }
    if (nextView === 'graph') {
      setGraphFocusId(focusDocId ?? opened?.id);
    }
    setView(nextView);
  }, [view, confirmLeave, opened?.id]);

  /** 编辑器报告改动状态。 */
  const onDirty = react.useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  /**
   * 存好了：新建的换成那篇（换 key 重挂），刷新树和列表。
   */
  const onSaved = react.useCallback((doc: api.KnowledgeDoc, created: boolean, editKey: string) => {
    const isCurrent = openedKeyRef.current === editKey;
    if (isCurrent) {
      dirtyRef.current = false;
    }
    if (created && isCurrent) {
      docSeqRef.current += 1;
      const key = `doc:${doc.id}:${String(docSeqRef.current)}`;
      setOpened({ key, id: doc.id, doc, preset: EMPTY_PRESET });
    }
    showNotice('已保存');
    void loadTree();
    void loadList(0);
  }, [loadList, loadTree, showNotice]);

  /** 删掉了：关右栏，刷新。 */
  const onDeleted = react.useCallback(() => {
    dirtyRef.current = false;
    void closeDoc(true);
    showNotice('已删除');
    void loadTree();
    void loadList(0);
  }, [closeDoc, loadList, loadTree, showNotice]);

  //==========================================================
  //M 左栏的操作：选目录和标签、目录增删改、拖拽移动
  //==========================================================

  const pickDir = react.useCallback((next: string | undefined) => {
    setDir(next);
    setDrawerOpen(false);
  }, []);

  const pickTag = react.useCallback((name: string) => {
    setTags((current) => {
      if (current.includes(name)) return current.filter((one) => one !== name);

      return [...current, name];
    });
  }, []);

  const clearTags = react.useCallback(() => setTags([]), []);

  const toggleRuleOnly = react.useCallback(() => {
    setRuleOnly((current) => !current);
    setDrawerOpen(false);
  }, []);

  const runWrite = react.useCallback(async (action: () => Promise<unknown>, refreshList: boolean) => {
    try {
      await action();
      void loadTree();
      if (refreshList) {
        void loadList(0);
      }
    } catch (error) {
      handleError(error);
    }
  }, [handleError, loadList, loadTree]);

  const refreshAfterSync = react.useCallback(() => {
    void loadTree();
    void loadList(0);
  }, [loadList, loadTree]);

  const syncOpenedTag = react.useCallback(async (from: string, to: string | null) => {
    if (opened?.id === undefined || opened.doc === undefined) return;

    const editKey = opened.key;
    const doc = await api.getDoc(opened.id);
    setTagChange({ editKey, from, to, doc });
  }, [opened]);

  const renameTag = react.useCallback((name: string, newName: string) => {
    void runWrite(async () => {
      const result = await api.renameOrMergeTag(name, newName);
      await syncOpenedTag(name, result.newName ?? newName);
      setTags((current) => {
        if (!current.includes(name)) return current;

        const replaced = current.map((one) => {
          if (one === name) return newName;

          return one;
        });
        return [...new Set(replaced)];
      });
      let word = '改名';
      if (result.merged === true) {
        word = '合并';
      }
      showNotice(`标签「${name}」已${word}为「${newName}」，动到 ${String(result.affectedDocs)} 篇`);
    }, true);
  }, [runWrite, showNotice, syncOpenedTag]);

  const removeTag = react.useCallback((name: string) => {
    void runWrite(async () => {
      const result = await api.deleteTag(name);
      await syncOpenedTag(name, null);
      setTags((current) => current.filter((one) => one !== name));
      showNotice(`标签「${name}」已删除，从 ${String(result.affectedDocs)} 篇文档上摘掉`);
    }, true);
  }, [runWrite, showNotice, syncOpenedTag]);

  const createDir = react.useCallback((parentId: string | null) => {
    void kbDialog.prompt({
      title: '新建虚拟目录',
      placeholder: '输入新目录名称…',
      confirmText: '创建目录',
    }).then((name) => {
      if (name === null || name.trim() === '') return;

      void runWrite(() => api.createDir(name.trim(), parentId), false);
    });
  }, [kbDialog, runWrite]);

  const renameDir = react.useCallback((target: api.KnowledgeDir) => {
    void kbDialog.prompt({
      title: '修改目录名称',
      initialValue: target.name,
      placeholder: '输入新的目录名称…',
      confirmText: '保存',
    }).then((name) => {
      if (name === null || name.trim() === '' || name.trim() === target.name) return;

      void runWrite(() => api.updateDir(target.id, { name: name.trim() }), true);
    });
  }, [kbDialog, runWrite]);

  const removeDir = react.useCallback((target: api.KnowledgeDir) => {
    void kbDialog.confirm({
      title: `删除目录「${target.name}」`,
      message: '里面的文档不会被删除，会转为「未归类」，子目录自动上提一层。',
      confirmText: '删除目录',
      danger: true,
    }).then((ok) => {
      if (!ok) return;

      if (dir === target.id) {
        setDir(undefined);
      }
      void runWrite(() => api.deleteDir(target.id), true);
    });
  }, [dir, kbDialog, runWrite]);

  const moveDoc = react.useCallback((docId: string, dirId: string | null) => {
    if (opened?.id === docId && dirtyRef.current) {
      showNotice('这篇有未保存改动，请先保存再移动');
      return;
    }

    const move = async (): Promise<void> => {
      await api.updateDoc(docId, { dirId });
      if (opened?.id === docId && !dirtyRef.current) {
        void openDoc(docId, true);
      }
    };
    void runWrite(move, true);
  }, [opened?.id, openDoc, runWrite, showNotice]);

  const moveDir = react.useCallback((dirId: string, parentId: string | null) => {
    void runWrite(() => api.updateDir(dirId, { parentId }), false);
  }, [runWrite]);

  //==========================================================
  //M 算显示用的东西：目录名、图谱补充元数据、筛选胶囊、手机屏态
  //==========================================================

  const flatDirs = tree?.flatDirs ?? [];
  const dirNames = react.useMemo(() => new Map(flatDirs.map((item) => [item.id, item.name])), [flatDirs]);
  const titles = react.useMemo(() => wiki.getTitleIndex(graph?.nodes ?? []), [graph]);

  //M 汇总前端已知文档的目录与摘要，供图谱节点在旧后端未重启时兜底配色与预览。
  const docMetaById = react.useMemo(() => {
    const map = new Map<string, { dirId: string | null; summary: string }>();
    for (const item of items) {
      map.set(item.id, { dirId: item.dirId, summary: item.summary });
    }
    if (opened?.doc !== undefined) {
      map.set(opened.doc.id, { dirId: opened.doc.dirId, summary: opened.doc.summary });
    }
    return map;
  }, [items, opened?.doc]);

  const chips: docList.FilterChip[] = [];
  if (dir === api.UNASSIGNED) {
    chips.push({ key: 'dir', label: '未归类' });
  }
  if (dir !== undefined && dir !== api.UNASSIGNED) {
    chips.push({ key: 'dir', label: `目录：${dirNames.get(dir) ?? dir}` });
  }
  let tagJoin = '';
  if (tags.length > 1 && tagMode === 'any') {
    tagJoin = '（或）';
  }
  for (const one of tags) {
    chips.push({ key: 'tag', label: `#${one}${tagJoin}`, value: one });
  }
  if (ruleOnly) {
    chips.push({ key: 'rule', label: '🔒 只看系统规则' });
  }
  if (topic !== undefined) {
    chips.push({ key: 'topic', label: `专题：${topic}` });
  }
  if (q !== '') {
    chips.push({ key: 'q', label: `搜：${q}` });
  }

  const clearChip = react.useCallback((key: docList.FilterChip['key'], value?: string) => {
    if (key === 'dir') {
      setDir(undefined);
    }
    if (key === 'tag') {
      setTags((current) => current.filter((one) => one !== value));
    }
    if (key === 'topic') {
      setTopic(undefined);
    }
    if (key === 'q') {
      setQInput('');
      setQ('');
    }
    if (key === 'rule') {
      setRuleOnly(false);
    }
  }, []);

  openedKeyRef.current = opened?.key;

  let screen = 'list';
  if (opened !== undefined) {
    screen = 'doc';
  }
  const dragEnabled = !isMobile && !readOnly;
  const isLoadingDoc = opened !== undefined && opened.id !== undefined && opened.doc === undefined;
  const homeHref = token.withToken('/', token.TOKEN);
  const decisionHref = token.withToken('/work-decision/', token.TOKEN);

  return (
    <div className="kb-app" data-mobile={isMobile} data-screen={screen} data-view={view}>
      <header className="kb-top">
        {isMobile && view === 'docs' && (
          <button type="button" className="kb-icon-btn" onClick={() => setDrawerOpen(true)} aria-label="目录与标签">
            ☰
          </button>
        )}
        <span className="kb-brand">知识库</span>

        {/* 三态核心视图切换器 */}
        <nav className="kb-view-tabs" role="tablist" aria-label="知识与记忆主视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'docs'}
            data-active={view === 'docs'}
            onClick={() => void switchView('docs')}
          >
            <span>📄 文档</span>
            {tree !== undefined && <span className="kb-tab-badge">{tree.totalDocs}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'graph'}
            data-active={view === 'graph'}
            onClick={() => void switchView('graph')}
          >
            <span>🕸️ 关系图谱</span>
            {graph !== undefined && <span className="kb-tab-badge">{graph.edges.length}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'memory'}
            data-active={view === 'memory'}
            onClick={() => void switchView('memory')}
          >
            <span>🧠 记忆与 VGR</span>
          </button>
        </nav>

        {view === 'docs' ? (
          <input
            className="kb-search"
            type="search"
            value={qInput}
            placeholder="搜标题、摘要、正文、标签"
            onChange={(event) => setQInput(event.target.value)}
          />
        ) : (
          <span className="kb-grow" />
        )}

        {!isMobile && !readOnly && view === 'docs' && (
          <button
            type="button"
            className="kb-link-btn"
            onClick={() => setSyncOpen(true)}
            title="只读导入本机目录里的 .md、.txt"
          >
            同步本地目录
          </button>
        )}
        {!isMobile && !readOnly && (
          <button type="button" className="kb-primary-btn" onClick={() => void newDoc('')}>＋ 新建</button>
        )}
        {!isMobile && <a className="kb-nav" href={homeHref}>主页</a>}
        {!isMobile && <a className="kb-nav" href={decisionHref}>AI工作台</a>}
      </header>

      {notice !== undefined && <div className="kb-toast" role="status">{notice}</div>}

      {syncOpen && (
        <folderSync.FolderSyncPanel
          onSynced={refreshAfterSync}
          onError={handleError}
          onClose={() => setSyncOpen(false)}
        />
      )}

      {/* 视图 1：三栏知识文档工作区 */}
      {view === 'docs' && (
        <div className="kb-main">
          <aside className="kb-side" data-open={drawerOpen}>
            <dirTree.DirTree
              tree={tree}
              dir={dir}
              tags={tags}
              tagMode={tagMode}
              ruleOnly={ruleOnly}
              readOnly={readOnly}
              dragEnabled={dragEnabled}
              pickDir={pickDir}
              pickTag={pickTag}
              setTagMode={setTagMode}
              clearTags={clearTags}
              toggleRuleOnly={toggleRuleOnly}
              createDir={createDir}
              renameDir={renameDir}
              removeDir={removeDir}
              moveDoc={moveDoc}
              moveDir={moveDir}
              renameTag={renameTag}
              removeTag={removeTag}
            />
          </aside>
          {isMobile && drawerOpen && <div className="kb-scrim" onClick={() => setDrawerOpen(false)} />}
          <docList.DocList
            items={items}
            total={total}
            hits={hits}
            memoryHits={memoryHits}
            memoryWarning={memoryWarning}
            loading={loading}
            error={listError}
            chips={chips}
            clearChip={clearChip}
            activeId={opened?.id}
            dragEnabled={dragEnabled}
            dirNames={dirNames}
            open={(id) => void openDoc(id)}
            more={() => void loadList(items.length)}
          />
          <main className="kb-pane">
            {opened === undefined && <p className="kb-empty kb-center">在左边选一篇，或者新建一篇</p>}
            {isLoadingDoc && (
              <div className="kb-pane-loading">
                {isMobile && (
                  <button type="button" className="kb-icon-btn" onClick={() => void closeDoc()} aria-label="返回">←</button>
                )}
                <span className="kb-muted">正在打开…</span>
              </div>
            )}
            {opened !== undefined && !isLoadingDoc && (
              <react.Suspense fallback={<p className="kb-muted kb-center">正在加载编辑器…</p>}>
                <LazyEditor
                  key={opened.key}
                  editKey={opened.key}
                  doc={opened.doc}
                  preset={opened.preset}
                  dirs={flatDirs}
                  readOnly={readOnly}
                  isMobile={isMobile}
                  onSaved={onSaved}
                  onDeleted={onDeleted}
                  onClose={() => void closeDoc()}
                  onDirty={onDirty}
                  onError={handleError}
                  onNotice={showNotice}
                  onOpenDoc={(id) => void openDoc(id)}
                  onCreateDoc={(title) => void newDoc(title)}
                  onShowGraph={() => void switchView('graph', opened.id)}
                  titles={titles}
                  tagChange={tagChange}
                />
              </react.Suspense>
            )}
          </main>
        </div>
      )}

      {/* 视图 2：全幅关系图谱交互画布 */}
      {view === 'graph' && (
        <div className="kb-stage-full">
          <react.Suspense fallback={<p className="kb-muted kb-center">正在加载关系图谱画布…</p>}>
            <LazyGraph
              fullGraph={graph}
              dirs={flatDirs}
              docMetaById={docMetaById}
              initialFocusId={graphFocusId}
              readOnly={readOnly}
              onOpenEditor={(id) => void openDoc(id)}
              onCreateDoc={(title) => void newDoc(title)}
            />
          </react.Suspense>
        </div>
      )}

      {/* 视图 3：记忆与 VGR 融合管理中心 */}
      {view === 'memory' && (
        <div className="kb-stage-full">
          <react.Suspense fallback={<p className="kb-muted kb-center">正在加载记忆与 VGR 工作台…</p>}>
            <LazyMemoryVgr
              readOnly={readOnly}
              onNotice={showNotice}
              onError={handleError}
              onSavedToKnowledge={(docId) => {
                void loadTree();
                void loadList(0);
                void openDoc(docId, true);
              }}
            />
          </react.Suspense>
        </div>
      )}

      {isMobile && view === 'docs' && screen === 'list' && !readOnly && (
        <button type="button" className="kb-fab" onClick={() => void newDoc('')} aria-label="新建">＋</button>
      )}

      {kbDialog.modalElement}
    </div>
  );
}
