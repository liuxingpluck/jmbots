/**
 * 积木知识库页面（/knowledge/）：桌面 >=800px 三栏（目录与标签 / 文档列表 / 编辑器），手机 <800px 单栏三屏
 * （列表、左侧滑出的目录抽屉、全屏文档，安卓返回键回到列表）。
 * 筛选和打开的文档写在网址里（?dir、tag、tagMode、rule、q、doc、topic），刷新不丢、能分享；
 * ?new=1&topic=<节点号>&title=<标题> 是工作决策“记一篇”跳过来的，直接打开预填好的新建表单。
 * 列表（或搜索）和单篇正文各走一路请求，各有 AbortController 和序号，迟到的回包不会盖掉新的。
 * 整库双链图谱和目录树一起拉：既给「🕸️ 图谱」抽屉用，也当标题索引给编辑器的 [[ 联想和双链芯片用。
 */
import * as react from 'react';
import { TOKEN, withToken } from '../Token.ts';
import * as dirTree from './DirTree.tsx';
import * as docList from './DocList.tsx';
import * as api from './KnowledgeApi.ts';
import type * as editorModule from './KnowledgeEditor.tsx';
import * as wiki from './WikiLinks.ts';

/** 编辑器连同 Markdown 渲染按需加载，首屏只有顶栏、目录和列表。 */
const LazyEditor = react.lazy(async () => {
  const mod = await import('./KnowledgeEditor.tsx');
  return { default: mod.KnowledgeEditor };
});

/** 双链图谱抽屉按需加载：点了「🕸️ 图谱」才拉。 */
const LazyGraph = react.lazy(async () => {
  const mod = await import('./GraphView.tsx');
  return { default: mod.GraphView };
});

/** 窄于这个宽度按手机排（和 /work-decision/ 同一个断点）。 */
const MOBILE_BREAKPOINT = 800;
/** 搜索框停手多久才发搜索。 */
const SEARCH_DELAY_MS = 300;
/** 提示条显示多久。 */
const NOTICE_MS = 5000;
/** 这个页面在网址里用的参数；写网址时先全删再按现状写，别的参数（令牌）不动。 */
const URL_KEYS = ['dir', 'tag', 'tagMode', 'rule', 'q', 'doc', 'topic', 'new', 'title'];

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

  //M ?new=1 带专题和标题：工作决策节点“记一篇”跳过来的。
  let preset: editorModule.Preset | undefined;
  if (params.get('new') === '1') {
    preset = { title: params.get('title') ?? '', topicId: getOne('topic') ?? null, dirId: null };
  }
  let tagMode: api.KnowledgeTagMode = 'all';
  if (params.get('tagMode') === 'any') {
    tagMode = 'any';
  }
  return {
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
    if (value === undefined || value === '') continue;

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
  //M 整库双链图谱：图谱抽屉的全库视图，也是 [[ 联想的标题索引；后端还没 1.1.0 时是 undefined。
  const [graph, setGraph] = react.useState<api.KnowledgeGraphResponse>();
  const [graphOpen, setGraphOpen] = react.useState(false);
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

      //M 已经往下翻过不止一页：按现在显示的条数刷新（最多 200），不把翻到一半的列表硬重置回第一页。
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
    writeUrl({ dir, tag, tagMode: modeParam, rule, topic, q, doc: opened?.id });
  }, [dir, tags, tagMode, ruleOnly, topic, q, opened?.id]);

  //==========================================================
  //M 右栏：打开、新建、关掉文档；手机上打开时压一层历史，返回键回列表
  //==========================================================

  /** 有没保存的改动时先问一句（草稿已经存着，离开也能找回）。 */
  const confirmLeave = react.useCallback((): boolean => {
    if (!dirtyRef.current) return true;

    return window.confirm('有没保存的改动（已存成草稿），确定离开？');
  }, []);

  /** 手机上打开文档时压一层历史。 */
  const pushMobile = react.useCallback(() => {
    if (!isMobile || pushedRef.current) return;

    window.history.pushState({ kb: 'doc' }, '', window.location.href);
    pushedRef.current = true;
  }, [isMobile]);

  const openDoc = react.useCallback(async (id: string, force = false) => {
    if (!force && !confirmLeave()) return;

    //M 正文这一路：中止上一篇，记序号，先显示“正在打开”。
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

      //M 打开失败：关右栏，手机上压的那层历史也退掉，免得要多按一次返回（云端 29 #9）。
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
    void openDoc(id, true);
  }, [initial.preset, openDoc]);

  /**
   * 新建：预填当前所在的目录和专题；点了还没创建的双链时顺带预填标题。
   * @param title 预填的标题；顶栏「新建」是空串。
   */
  const newDoc = react.useCallback((title: string) => {
    if (!confirmLeave()) return;

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
  const closeDoc = react.useCallback(() => {
    if (!confirmLeave()) return;

    dirtyRef.current = false;
    docAbortRef.current?.abort();
    setOpened(undefined);
    if (pushedRef.current) {
      pushedRef.current = false;
      window.history.back();
    }
  }, [confirmLeave]);

  //M 安卓返回键：退回列表；有没保存的改动又不想走，就再压一层留在文档里。
  react.useEffect(() => {
    const onPopState = (): void => {
      if (!pushedRef.current) return;

      pushedRef.current = false;
      if (!confirmLeave()) {
        window.history.pushState({ kb: 'doc' }, '', window.location.href);
        pushedRef.current = true;
        return;
      }
      dirtyRef.current = false;
      setOpened(undefined);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [confirmLeave]);

  //M 关页、刷新前有没保存的改动：浏览器自己问一句。
  react.useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return;

      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  /** 编辑器报告改动状态。 */
  const onDirty = react.useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  /**
   * 存好了：新建的换成那篇（换 key 重挂），刷新树和列表。
   * editKey 是发起保存的那个编辑器；回包时用户已经切到别的文档，就只刷新，不顶掉现在开着的（云端 29 #3）。
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
    closeDoc();
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

  //M 标签多选：没选的加上、选了的去掉，按 tagMode 取交集或并集。
  //M 不关手机抽屉，方便连续选几个标签（点目录照旧关，见 pickDir）。
  const pickTag = react.useCallback((name: string) => {
    setTags((current) => {
      if (current.includes(name)) return current.filter((one) => one !== name);

      return [...current, name];
    });
  }, []);

  /** 清空选中的标签。 */
  const clearTags = react.useCallback(() => setTags([]), []);

  /** 开关「只看系统规则」。 */
  const toggleRuleOnly = react.useCallback(() => {
    setRuleOnly((current) => !current);
    setDrawerOpen(false);
  }, []);

  /** 跑一个写操作，成功后刷新树（和列表），出错统一处理。 */
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

  /**
   * 左栏改名、删了标签：后端会刷新挂着它的文档的 updatedAt，开着的那篇重新拿一份交给编辑器换底稿，
   * 免得下次保存误报 409（0.7.90 审计 P1-1）。编辑器按 editKey 认、按 updatedAt 判断这篇到底变没变。
   * @param from 原标签名。
   * @param to 新标签名；删除是 null。
   */
  const syncOpenedTag = react.useCallback(async (from: string, to: string | null) => {
    //G 没开文档、新建的、还在打开中：不用管。
    if (opened?.id === undefined || opened.doc === undefined) return;

    const editKey = opened.key;
    const doc = await api.getDoc(opened.id);
    setTagChange({ editKey, from, to, doc });
  }, [opened]);

  //M 标签改名（新名字已有就合并）：成功后刷新树和列表；已选着这个标签的，换成新名字（合并时去掉重复）。
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

  //M 删标签：成功后刷新树和列表，并从已选标签里去掉它。
  const removeTag = react.useCallback((name: string) => {
    void runWrite(async () => {
      const result = await api.deleteTag(name);
      await syncOpenedTag(name, null);
      setTags((current) => current.filter((one) => one !== name));
      showNotice(`标签「${name}」已删除，从 ${String(result.affectedDocs)} 篇文档上摘掉`);
    }, true);
  }, [runWrite, showNotice, syncOpenedTag]);

  const createDir = react.useCallback((parentId: string | null) => {
    const name = window.prompt('新目录的名字')?.trim() ?? '';
    if (name === '') return;

    void runWrite(() => api.createDir(name, parentId), false);
  }, [runWrite]);

  const renameDir = react.useCallback((target: api.KnowledgeDir) => {
    const name = window.prompt('目录改名为', target.name)?.trim() ?? '';
    if (name === '' || name === target.name) return;

    void runWrite(() => api.updateDir(target.id, { name }), true);
  }, [runWrite]);

  const removeDir = react.useCallback((target: api.KnowledgeDir) => {
    const ok = window.confirm(`删除目录「${target.name}」？里面的文档不会删，会变成未归类，子目录上提一层。`);
    if (!ok) return;

    if (dir === target.id) {
      setDir(undefined);
    }
    void runWrite(() => api.deleteDir(target.id), true);
  }, [dir, runWrite]);

  const moveDoc = react.useCallback((docId: string, dirId: string | null) => {
    //G 拖的正是开着又改过的那篇：先保存再移，免得移完再存撞 409（云端 29 #7）。
    if (opened?.id === docId && dirtyRef.current) {
      showNotice('这篇有未保存改动，请先保存再移动');
      return;
    }

    const move = async (): Promise<void> => {
      await api.updateDoc(docId, { dirId });

      //M 移的正是开着的那篇、又没改过：重新打开，免得之后保存撞上 409。
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
  //M 算显示用的东西：目录名、筛选胶囊、手机现在在哪一屏
  //==========================================================

  const flatDirs = tree?.flatDirs ?? [];
  const dirNames = react.useMemo(() => new Map(flatDirs.map((item) => [item.id, item.name])), [flatDirs]);
  const titles = react.useMemo(() => wiki.getTitleIndex(graph?.nodes ?? []), [graph]);

  const chips: docList.FilterChip[] = [];
  if (dir === api.UNASSIGNED) {
    chips.push({ key: 'dir', label: '未归类' });
  }
  if (dir !== undefined && dir !== api.UNASSIGNED) {
    chips.push({ key: 'dir', label: `目录：${dirNames.get(dir) ?? dir}` });
  }
  //M 选中的标签每个一个胶囊，点 × 只去掉那一个；选了多个且是任一满足时，胶囊上标个“或”。
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
    //M 标签胶囊每个带着自己的标签名，只去掉那一个。
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

  //M 记下现在开着的是哪个编辑器，onSaved 据此判断回包时用户切没切走。
  openedKeyRef.current = opened?.key;

  let screen = 'list';
  if (opened !== undefined) {
    screen = 'doc';
  }
  const dragEnabled = !isMobile && !readOnly;
  const isLoadingDoc = opened !== undefined && opened.id !== undefined && opened.doc === undefined;
  const homeHref = withToken('/', TOKEN);
  const decisionHref = withToken('/work-decision/', TOKEN);

  return (
    <div className="kb-app" data-mobile={isMobile} data-screen={screen}>
      <header className="kb-top">
        {isMobile && (
          <button type="button" className="kb-icon-btn" onClick={() => setDrawerOpen(true)} aria-label="目录与标签">
            ☰
          </button>
        )}
        <span className="kb-brand">知识库</span>
        <input
          className="kb-search"
          type="search"
          value={qInput}
          placeholder="搜标题、摘要、正文、标签"
          onChange={(event) => setQInput(event.target.value)}
        />
        <button type="button" className="kb-link-btn" onClick={() => setGraphOpen(true)} title="整个知识库的双链图谱">
          🕸️{!isMobile && ' 图谱'}
        </button>
        {!isMobile && !readOnly && (
          <button type="button" className="kb-primary-btn" onClick={() => newDoc('')}>＋ 新建</button>
        )}
        {!isMobile && <a className="kb-nav" href={homeHref}>主页</a>}
        {!isMobile && <a className="kb-nav" href={decisionHref}>工作决策</a>}
      </header>
      {notice !== undefined && <div className="kb-toast" role="status">{notice}</div>}
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
              {isMobile && <button type="button" className="kb-icon-btn" onClick={closeDoc} aria-label="返回">←</button>}
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
                onClose={closeDoc}
                onDirty={onDirty}
                onError={handleError}
                onNotice={showNotice}
                onOpenDoc={(id) => void openDoc(id)}
                onCreateDoc={newDoc}
                onShowGraph={() => setGraphOpen(true)}
                titles={titles}
                tagChange={tagChange}
              />
            </react.Suspense>
          )}
        </main>
      </div>
      {graphOpen && (
        <react.Suspense fallback={null}>
          <LazyGraph
            fullGraph={graph}
            centerId={opened?.id}
            open={(id) => void openDoc(id)}
            onClose={() => setGraphOpen(false)}
          />
        </react.Suspense>
      )}
      {isMobile && screen === 'list' && !readOnly && (
        <button type="button" className="kb-fab" onClick={() => newDoc('')} aria-label="新建">＋</button>
      )}
    </div>
  );
}
