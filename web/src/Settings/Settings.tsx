/**
 * 全站统一设置中心（Phase 1）：
 * 保留主站宽屏居中浮层（含最大化与 `#settings=<id>` 双向深链接），
 * 采用轻量声明式注册表（Registry.ts）组织 6 大一级分组与 17 个二级设置节点：
 *   - 顶部固定秒搜（`/` 或 `Ctrl/Cmd+F` 聚焦、80ms 防抖、中英文/键名/`@modified`）；
 *   - 左侧可折叠二级分层树（命中计数 + 未保存红点）；
 *   - 右侧连续长滚容器 + IntersectionObserver Scroll-Spy（600ms 编程滚动锁 + 触底兜底）；
 *   - 混合分层保存：主题/语言/演示打码/目录授权即时生效，`config.yaml` 改动底部浮出深色毛玻璃脏态保存栏。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as desktop from '../Desktop/Desktop.tsx';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';
import * as theme from '../Theme.ts';
import * as editsModule from './Edits.ts';
import * as fields from './Fields.tsx';
import * as grantsModule from './Grants.tsx';
import * as overviewCards from './OverviewCards.tsx';
import * as reconnect from './Reconnect.tsx';
import * as registry from './Registry.ts';
import * as sections from './Sections.tsx';
import * as webAuthField from './WebAuthField.tsx';
import './Settings.css';


/** 重启到哪一步了。 */
type RestartState =
  | { kind: 'idle' }
  | { kind: 'saved' }
  | { kind: 'restarting' }
  | { kind: 'done' }
  | { kind: 'failed'; reason: string };


/** 仅影响当前浏览器的面板尺寸，不写入服务配置。 */
const MAXIMIZED_KEY = 'jmbots.settings.maximized';

/** 点击左侧目录触发平滑滚动期间屏蔽 Scroll-Spy 回写的锁定时长（毫秒）。 */
const PROGRAMMATIC_SCROLL_LOCK_MS = 600;

/** 搜索输入防抖延迟（毫秒）。 */
const SEARCH_DEBOUNCE_MS = 80;


/** 把异常整理成可读文本。 */
function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;

  return String(error);
}


/** 判定键盘事件目标是否处于可输入控件中。 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  if (target.isContentEditable) return true;

  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}


/** 从本地存储安全读取最大化状态。 */
function loadMaximized(): boolean {
  try {
    return window.localStorage.getItem(MAXIMIZED_KEY) === 'true';
  } catch {
    return false;
  }
}


/** 把当前激活二级节点同步写入地址栏 `#settings=<id>`，不产生多余历史栈。 */
function syncSettingsHash(sectionId: string): void {
  const nextHash = `#settings=${encodeURIComponent(sectionId)}`;
  if (window.location.hash === nextHash) return;

  const base = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(window.history.state, '', `${base}${nextHash}`);
}


/** 关闭设置中心时清理地址栏遗留的 `#settings=...` 深链接。 */
function clearSettingsHash(): void {
  if (!window.location.hash.startsWith('#settings')) return;

  const base = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(window.history.state, '', base);
}


/** 构造正则表达式转义字符串。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}


/** 按搜索词高亮标题中命中的片段。 */
function HighlightText(props: { text: string; terms: readonly string[] }): react.JSX.Element {
  const cleanTerms = props.terms.filter((item) => item.trim() !== '');
  if (cleanTerms.length === 0) return <>{props.text}</>;

  const pattern = cleanTerms.map(escapeRegExp).join('|');
  const regex = new RegExp(`(${pattern})`, 'giu');
  const parts = props.text.split(regex);
  return (
    <>
      {parts.map((part, index) => {
        const hit = cleanTerms.some((term) => part.toLowerCase() === term.toLowerCase());
        if (hit) {
          return (
            <mark key={`${part}-${String(index)}`} className="jm-sc-mark">
              {part}
            </mark>
          );
        }
        return <react.Fragment key={`${part}-${String(index)}`}>{part}</react.Fragment>;
      })}
    </>
  );
}


/** 按一级分组标识渲染对应图标（显式枚举以便打包期精确摇树）。 */
function GroupIcon(props: { groupId: registry.SettingsGroupId }): react.JSX.Element {
  if (props.groupId === 'console') return <icons.DashboardOutlined />;
  if (props.groupId === 'models') return <icons.ApiOutlined />;
  if (props.groupId === 'bots') return <icons.RobotOutlined />;
  if (props.groupId === 'knowledge') return <icons.BookOutlined />;
  if (props.groupId === 'security') return <icons.SafetyOutlined />;
  return <icons.DesktopOutlined />;
}


/**
 * 6.2 界面主题、语言与演示打码（全部即时生效）。
 * @returns 语言选择、主题切换与演示隐私打码开关界面。
 */
function UiThemeSection(): react.JSX.Element {
  const t = i18n.useT();
  const language = context.useUi((state) => state.language);
  const setLanguage = context.useUi((state) => state.setLanguage);
  const themeName = context.useUi((state) => state.themeName);
  const setThemeName = context.useUi((state) => state.setThemeName);
  const masked = privacy.useMask();

  let maskStatusText = t('已关闭（显示真实内容）');
  if (masked) {
    maskStatusText = t('已开启演示打码（客户名与正文已脱敏）');
  }

  return (
    <div className="jm-section">
      <fields.Row
        label={t('界面语言')}
        hint={t('界面的文字；机器人说什么语言在“机器人”里设。切了马上生效，存进 config.yaml 的 ui.language')}
      >
        <antd.Select
          className="jm-field-select"
          value={language}
          options={i18n.LANGUAGES.map((item) => ({ value: item.code, label: item.label }))}
          onChange={(next: i18n.Language) => {
            setLanguage(next);
            //M 写入浏览器存储并立即异步持久化到 config.yaml 的 ui.language，刷新保持一致。
            i18n.saveLanguage(window.localStorage, next);
            void api.saveSettings([{ path: ['ui', 'language'], value: next }]);
          }}
        />
      </fields.Row>

      <fields.Row
        label={t('界面主题')}
        hint={t('存在当前浏览器里，马上生效；默认深色极客主题')}
      >
        <antd.Radio.Group
          value={themeName}
          onChange={(event) => {
            const name = event.target.value as theme.ThemeName;
            setThemeName(name);
            theme.saveThemeName(window.localStorage, name);
          }}
        >
          {Object.values(theme.THEMES).map((spec) => {
            let previewSuffix = '';
            if (!spec.ready) {
              previewSuffix = t('（预览）');
            }
            return (
              <antd.Radio.Button key={spec.name} value={spec.name}>
                {t(spec.label)}
                {previewSuffix}
              </antd.Radio.Button>
            );
          })}
        </antd.Radio.Group>
      </fields.Row>

      <fields.Row
        label={t('演示打码')}
        hint={t('默认关闭。投屏或录制演示时开启，立即遮罩客户名称与对话正文；也可点页面顶部红色横幅关闭')}
      >
        <div className="jm-sc-inline-row">
          <antd.Switch checked={masked} onChange={(next) => privacy.setMask(next)} />
          <span className="jm-muted">{maskStatusText}</span>
        </div>
      </fields.Row>
    </div>
  );
}


/** 需要读取 `config.yaml` 草稿的表单区块包装，统一处理加载态与报错。 */
function DraftSectionWrap(props: {
  loadError: string;
  draft: unknown;
  render: (draft: unknown) => react.ReactNode;
}): react.JSX.Element {
  const t = i18n.useT();
  if (props.loadError !== '') {
    return (
      <antd.Alert
        type="error"
        showIcon
        message={t('取不到配置：{reason}', { reason: props.loadError })}
      />
    );
  }
  if (props.draft === null) {
    return <antd.Spin />;
  }
  return <>{props.render(props.draft)}</>;
}


/** 渲染单个二级节点的业务体内容。 */
function renderSectionBody(params: {
  sectionId: string;
  draft: unknown;
  loadError: string;
  formKey: number;
  models: api.ModelInfo[];
  snapshot: overviewCards.RuntimeSnapshot;
  onRefreshSnapshot: () => void;
  onEdit: (edit: editsModule.Edit) => void;
  onReloadConfig: () => void;
  onNavigate: (sectionId: string) => void;
}): react.ReactNode {
  const { sectionId, draft, loadError, formKey, models, snapshot } = params;
  const withDraft = (
    Component: (sectionProps: sections.SectionProps) => react.JSX.Element,
  ): react.ReactNode => (
    <DraftSectionWrap
      loadError={loadError}
      draft={draft}
      render={(loadedDraft) => (
        <Component
          key={`${sectionId}-${String(formKey)}`}
          draft={loadedDraft}
          onEdit={params.onEdit}
          models={models}
        />
      )}
    />
  );

  if (sectionId === 'console-overview') {
    return (
      <overviewCards.ConsoleOverview
        snapshot={snapshot}
        onRefresh={params.onRefreshSnapshot}
        onNavigate={params.onNavigate}
      />
    );
  }
  if (sectionId === 'reconnect') {
    return <reconnect.Reconnect draft={draft} onReload={params.onReloadConfig} />;
  }
  if (sectionId === 'providers') return withDraft(sections.Providers);
  if (sectionId === 'model-routing') return withDraft(sections.Models);
  if (sectionId === 'concurrency') return withDraft(sections.Concurrency);
  if (sectionId === 'engine') return withDraft(sections.Engine);
  if (sectionId === 'bots-list') return withDraft(sections.Bots);
  if (sectionId === 'channels-entry') {
    return (
      <overviewCards.ChannelsEntry
        draft={draft}
        snapshot={snapshot}
        onNavigate={params.onNavigate}
      />
    );
  }
  if (sectionId === 'channel-policy') return withDraft(sections.ChannelPolicy);
  if (sectionId === 'search') return withDraft(sections.Search);
  //M 入口节点：上面是即时的状态卡片或授权表，下面是写进 config.yaml 的插件配置表单。
  if (sectionId === 'knowledge-entry') {
    return (
      <>
        <overviewCards.KnowledgeEntry snapshot={snapshot} />
        {withDraft(sections.MemoryConfig)}
      </>
    );
  }
  if (sectionId === 'server-http') return withDraft(sections.Http);
  if (sectionId === 'frpc-entry') {
    return (
      <>
        <overviewCards.FrpcEntry snapshot={snapshot} onRefresh={params.onRefreshSnapshot} />
        {withDraft(sections.FrpcConfig)}
      </>
    );
  }
  if (sectionId === 'grants') {
    return (
      <>
        <grantsModule.Grants />
        {withDraft(sections.TrustedDirs)}
      </>
    );
  }
  if (sectionId === 'shell-local') return withDraft(sections.Local);
  if (sectionId === 'ui-theme') return <UiThemeSection />;
  if (sectionId === 'desktop-window') return <desktop.Desktop />;
  return null;
}


/**
 * 设置中心主入口组件：宽屏居中浮层，集成顶部秒搜、左侧二级树、右侧连续长滚与底部浮动脏态保存栏。
 */
export function Settings(): react.JSX.Element {
  const t = i18n.useT();
  const mountedPlugins = context.useUi((state) => state.mountedPlugins);
  const category = context.useUi((state) => state.settingsCategory);
  const setCategory = context.useUi((state) => state.setSettingsCategory);
  const setSettingsOpen = context.useUi((state) => state.setSettingsOpen);

  /** 窗口最大化状态。 */
  const [maximized, setMaximized] = react.useState(loadMaximized);
  const toggleMaximized = (): void => {
    const next = !maximized;
    setMaximized(next);
    try {
      window.localStorage.setItem(MAXIMIZED_KEY, String(next));
    } catch {
      //M 存储不可用时仅在当前会话生效。
    }
  };

  /** 后端配置、模型目录与加载错误。 */
  const [config, setConfig] = react.useState<Record<string, unknown> | null>(null);
  const [models, setModels] = react.useState<api.ModelInfo[]>([]);
  const [loadError, setLoadError] = react.useState('');
  /** 未保存配置变更步进数组。 */
  const [edits, setEdits] = react.useState<editsModule.Edit[]>([]);
  const [saving, setSaving] = react.useState(false);
  const [restart, setRestart] = react.useState<RestartState>({ kind: 'idle' });
  const [notice, setNotice] = react.useState('');
  const [formKey, setFormKey] = react.useState(0);

  /** 统一拉取控制台运行态快照，供总览、渠道、知识库与 FRPC 卡片共享。 */
  const { snapshot, refresh: refreshSnapshot } = overviewCards.useRuntimeSnapshot(mountedPlugins);

  /** 顶部搜索词（即时输入与 80ms 防抖结果）。 */
  const [searchText, setSearchText] = react.useState('');
  const [debouncedQuery, setDebouncedQuery] = react.useState('');
  const searchInputRef = react.useRef<antd.InputRef>(null);

  react.useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(searchText);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  const clearSearch = react.useCallback((): void => {
    setSearchText('');
    setDebouncedQuery('');
  }, []);

  /** 当前可见的二级设置节点列表（按挂载插件过滤）。 */
  const visibleSections = react.useMemo(() => {
    return registry.SETTINGS_SECTIONS.filter((sec) => {
      if (sec.requiresPlugin === undefined) return true;

      return api.isPluginMounted(mountedPlugins, sec.requiresPlugin, false);
    });
  }, [mountedPlugins]);

  /** 拉取配置与模型清单。 */
  const load = react.useCallback(() => {
    setLoadError('');
    void api.settings().then(
      (result) => setConfig(result.config),
      (error: unknown) => setLoadError(getErrorText(error)),
    );
    void api.models().then(setModels, () => setModels([]));
  }, []);

  react.useEffect(load, [load]);

  /** 实时叠加改动后的配置草稿。 */
  const draft = react.useMemo(() => {
    if (config === null) return null;

    return editsModule.getDraft(config, edits);
  }, [config, edits]);

  /** 记录单步改动；若所有改动均已退回原值则自动清空脏状态。 */
  const onEdit = react.useCallback((edit: editsModule.Edit) => {
    setEdits((old) => {
      const next = editsModule.addEdit(old, edit);
      if (config === null) return next;

      const nextDraft = editsModule.getDraft(config, next);
      const hasDiff = next.some((step) => editsModule.changedAt(config, nextDraft, step.path));
      if (!hasDiff) return [];

      return next;
    });
  }, [config]);

  const isChanged = react.useCallback(
    (path: editsModule.Path) => editsModule.changedAt(config, draft, path),
    [config, draft],
  );

  /** 统计各个二级节点是否存在未保存改动。 */
  const modifiedSectionIds = react.useMemo(() => {
    const dirty = new Set<string>();
    for (const sec of visibleSections) {
      if (registry.isSectionModified(config, draft, sec)) {
        dirty.add(sec.id);
      }
    }
    return dirty;
  }, [config, draft, visibleSections]);

  /** 解析当前防抖后的搜索条件并过滤可见节点。 */
  const parsedSearch = react.useMemo(
    () => registry.parseSearchQuery(debouncedQuery),
    [debouncedQuery],
  );
  const immediateParsedSearch = react.useMemo(
    () => registry.parseSearchQuery(searchText),
    [searchText],
  );
  const searchActive = debouncedQuery.trim() !== '';

  const matchedSections = react.useMemo(() => {
    return visibleSections.filter((sec) => {
      if (parsedSearch.onlyModified && !modifiedSectionIds.has(sec.id)) return false;

      const group = registry.findGroup(sec.groupId);
      return registry.matchesSearchTerms(sec, group, parsedSearch.terms, t);
    });
  }, [visibleSections, parsedSearch, modifiedSectionIds, t]);

  /** 初次挂载判定初始目标：仅当来自 `#settings=` 深链接或非默认 Store 分类时才定位到指定节点。 */
  const [initialTargetId] = react.useState<string>(() => {
    const openedByHash = typeof window !== 'undefined' && window.location.hash.startsWith('#settings');
    let startCategory = category;
    if (!openedByHash && startCategory === 'providers') {
      startCategory = '';
    }
    return registry.resolveSectionId(startCategory, visibleSections);
  });

  /** 左侧目录树展开态（默认展开全部 6 个一级组）。 */
  const [expandedGroups, setExpandedGroups] = react.useState<Set<registry.SettingsGroupId>>(
    () => new Set(registry.SETTINGS_GROUPS.map((item) => item.id)),
  );
  const [activeId, setActiveId] = react.useState<string>(initialTargetId);

  /** DOM 引用与 Scroll-Spy 编程滚动锁定控制。 */
  const scrollContainerRef = react.useRef<HTMLDivElement>(null);
  const sectionRefs = react.useRef<Map<string, HTMLElement>>(new Map());
  const treeItemRefs = react.useRef<Map<string, HTMLButtonElement>>(new Map());
  let initialLockUntil = 0;
  if (initialTargetId !== visibleSections[0]?.id) {
    initialLockUntil = Date.now() + 1200;
  }
  const programmaticLockUntilRef = react.useRef(initialLockUntil);
  const lockTimerRef = react.useRef<number | null>(null);
  const userInteractedRef = react.useRef(false);
  const initialMountedRef = react.useRef(false);
  const initialDraftSnappedRef = react.useRef(false);
  const desktopSnappedRef = react.useRef(false);
  const lastAppliedStoreCategoryRef = react.useRef(category);

  const registerSectionRef = react.useCallback(
    (id: string, element: HTMLElement | null): void => {
      if (element === null) {
        sectionRefs.current.delete(id);
        return;
      }
      sectionRefs.current.set(id, element);
    },
    [],
  );

  const registerTreeItemRef = react.useCallback(
    (id: string, element: HTMLButtonElement | null): void => {
      if (element === null) {
        treeItemRefs.current.delete(id);
        return;
      }
      treeItemRefs.current.set(id, element);
    },
    [],
  );

  /** 将指定二级节点设为激活状态并同步左侧展开与 `#settings=` 哈希。 */
  const activateSection = react.useCallback((sectionId: string): void => {
    setActiveId(sectionId);
    const meta = visibleSections.find((item) => item.id === sectionId);
    if (meta !== undefined) {
      setExpandedGroups((prev) => {
        if (prev.has(meta.groupId)) return prev;

        const next = new Set(prev);
        next.add(meta.groupId);
        return next;
      });
    }
    syncSettingsHash(sectionId);
    treeItemRefs.current.get(sectionId)?.scrollIntoView({ block: 'nearest' });
  }, [visibleSections]);

  /**
   * 编程跳转并平滑滚动到指定二级节点；加 600ms Scroll-Spy 锁防止高亮闪烁。
   * 若目标正被搜索过滤隐藏，先自动清空搜索再定位。
   */
  const scrollToSection = react.useCallback((
    rawId: string,
    behavior: ScrollBehavior = 'smooth',
  ): void => {
    const targetId = registry.resolveSectionId(rawId, visibleSections);
    const isCurrentlyVisible = matchedSections.some((item) => item.id === targetId);
    if (!isCurrentlyVisible && searchText !== '') {
      clearSearch();
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const el = sectionRefs.current.get(targetId);
          if (el !== undefined) {
            programmaticLockUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_LOCK_MS;
            el.scrollIntoView({ behavior, block: 'start' });
          }
          activateSection(targetId);
        });
      });
      return;
    }

    programmaticLockUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_LOCK_MS;
    if (lockTimerRef.current !== null) {
      window.clearTimeout(lockTimerRef.current);
    }
    lockTimerRef.current = window.setTimeout(() => {
      programmaticLockUntilRef.current = 0;
      lockTimerRef.current = null;
    }, PROGRAMMATIC_SCROLL_LOCK_MS);

    activateSection(targetId);
    const el = sectionRefs.current.get(targetId);
    if (el !== undefined) {
      el.scrollIntoView({ behavior, block: 'start' });
    }
  }, [visibleSections, matchedSections, searchText, clearSearch, activateSection]);

  react.useEffect(() => {
    return () => {
      if (lockTimerRef.current !== null) {
        window.clearTimeout(lockTimerRef.current);
      }
    };
  }, []);

  /** 首次挂载、深链接与配置加载后定位，以及运行期外部 `#settings=` 变化时平滑滚动。 */
  react.useEffect(() => {
    if (!initialMountedRef.current) {
      initialMountedRef.current = true;
      syncSettingsHash(initialTargetId);
      if (initialTargetId !== visibleSections[0]?.id) {
        scrollToSection(initialTargetId, 'auto');
      }
      return;
    }

    if (category !== lastAppliedStoreCategoryRef.current) {
      lastAppliedStoreCategoryRef.current = category;
      if (category.trim() !== '') {
        const resolved = registry.resolveSectionId(category, visibleSections);
        scrollToSection(resolved, 'smooth');
      }
      return;
    }

    //M 若初始深链接为桌面插件窗口操控，等 mountedPlugins 加载放行该节点后再定位一次。
    const wantsDesktop = category === 'desktop' || category === 'desktop-window';
    const hasDesktop = visibleSections.some((item) => item.id === 'desktop-window');
    if (wantsDesktop && hasDesktop && !desktopSnappedRef.current && !userInteractedRef.current) {
      desktopSnappedRef.current = true;
      scrollToSection('desktop-window', 'auto');
      return;
    }

    //M 初始带深链接进入时，等配置草稿落地展开高度后再精准定位一次（若用户已主动滚走则不打扰）。
    if (!initialDraftSnappedRef.current && draft !== null && !userInteractedRef.current) {
      initialDraftSnappedRef.current = true;
      if (initialTargetId !== visibleSections[0]?.id) {
        scrollToSection(initialTargetId, 'auto');
      }
    }
  }, [category, visibleSections, draft, initialTargetId, scrollToSection]);

  /** 右侧连续长滚容器 IntersectionObserver + 顶部/触底兜底 Scroll-Spy。 */
  const matchedKey = matchedSections.map((item) => item.id).join('|');
  react.useEffect(() => {
    const container = scrollContainerRef.current;
    if (container === null || matchedSections.length === 0) return;

    const intersecting = new Set<string>();
    const pickVisibleActive = (): void => {
      if (Date.now() < programmaticLockUntilRef.current) return;

      if (container.scrollTop <= 14) {
        const firstId = matchedSections[0]?.id;
        if (firstId !== undefined) {
          activateSection(firstId);
        }
        return;
      }

      const nearBottom =
        container.scrollTop + container.clientHeight >= container.scrollHeight - 20;
      if (nearBottom) {
        const lastId = matchedSections[matchedSections.length - 1]?.id;
        if (lastId !== undefined) {
          activateSection(lastId);
        }
        return;
      }

      //M 优先从焦点观察带命中的节点里挑最靠上的一个；若跨跃过快未命中则按距顶部焦点线最近者兜底。
      for (const sec of matchedSections) {
        if (intersecting.has(sec.id)) {
          activateSection(sec.id);
          return;
        }
      }

      const containerTop = container.getBoundingClientRect().top;
      const focusY = containerTop + container.clientHeight * 0.24;
      let bestId = matchedSections[0]?.id;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const sec of matchedSections) {
        const el = sectionRefs.current.get(sec.id);
        if (el === undefined) {
          continue;
        }
        const rect = el.getBoundingClientRect();
        const dist = Math.abs(rect.top - focusY);
        if (dist < bestDist) {
          bestDist = dist;
          bestId = sec.id;
        }
      }
      if (bestId !== undefined) {
        activateSection(bestId);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const secId = (entry.target as HTMLElement).dataset['sectionId'];
          if (secId === undefined) {
            continue;
          }
          if (entry.isIntersecting) {
            intersecting.add(secId);
          }
          if (!entry.isIntersecting) {
            intersecting.delete(secId);
          }
        }
        pickVisibleActive();
      },
      {
        root: container,
        rootMargin: '-10% 0px -65% 0px',
        threshold: [0, 0.1],
      },
    );

    for (const sec of matchedSections) {
      const el = sectionRefs.current.get(sec.id);
      if (el !== undefined) {
        observer.observe(el);
      }
    }

    const onScroll = (): void => {
      pickVisibleActive();
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      container.removeEventListener('scroll', onScroll);
    };
  }, [matchedKey, matchedSections, activateSection]);

  /** 关闭设置弹窗：右上角按钮强制关闭；按 Esc 或点击遮罩需先确认无未保存改动。 */
  const close = react.useCallback((): void => {
    clearSettingsHash();
    setCategory('');
    setSettingsOpen(false);
  }, [setCategory, setSettingsOpen]);

  const closeIfClean = react.useCallback((): void => {
    if (edits.length > 0) {
      void antd.message.warning(
        t('有 {count} 处改动还没保存：先保存或撤销，或者点右上角的关闭放弃改动', {
          count: edits.length,
        }),
      );
      return;
    }
    clearSettingsHash();
    setCategory('');
    setSettingsOpen(false);
  }, [edits.length, setCategory, setSettingsOpen, t]);

  /** 快捷键：`/` 或 `Ctrl/Cmd+F` 聚焦搜索；`Esc` 优先清搜索，空搜索时安全关闭。 */
  react.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (!isTypingTarget(event.target)) {
          event.preventDefault();
          searchInputRef.current?.focus();
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        const inSearch =
          document.activeElement instanceof HTMLElement
          && document.activeElement.closest('.jm-sc-search-wrap') !== null;
        if (inSearch && searchText !== '') {
          clearSearch();
          return;
        }
        closeIfClean();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeIfClean, clearSearch, searchText]);

  /** 重启后端并轮询 `/api/ui/status` 确认新进程接管。 */
  const restartNow = async (): Promise<void> => {
    setRestart({ kind: 'restarting' });
    try {
      const { startedAt } = await api.applySettings();
      const restarted = await api.waitNewProcess(startedAt);
      if (restarted) {
        setRestart({ kind: 'done' });
        load();
        refreshSnapshot();
        return;
      }
      setRestart({
        kind: 'failed',
        reason: t('等了 3 分钟还没换好：看运行时 data 里最新的 swap_*.log'),
      });
    } catch (error) {
      setRestart({ kind: 'failed', reason: getErrorText(error) });
    }
  };

  /** 提交配置增量改动，可选保存后立即重启生效。 */
  const save = (applyAfterSave: boolean): void => {
    const webAuthError = webAuthField.validateWebAuthDraft(draft, t);
    if (webAuthError !== '') {
      setNotice(webAuthError);
      scrollToSection('server-http');
      return;
    }

    setSaving(true);
    setNotice('');
    void api.saveSettings(edits).then(
      () => {
        setSaving(false);
        setEdits([]);
        setFormKey((key) => key + 1);
        load();
        if (applyAfterSave) {
          void restartNow();
          return;
        }
        setRestart({ kind: 'saved' });
      },
      (error: unknown) => {
        setSaving(false);
        setNotice(t('没保存成：{reason}', { reason: getErrorText(error) }));
      },
    );
  };

  /** 放弃全部未保存配置改动并重绘表单控件。 */
  const discardEdits = (): void => {
    setEdits([]);
    setNotice('');
    setFormKey((key) => key + 1);
  };

  /** 切换 `@modified` 特殊过滤词（在保留已有搜索词的前提下增删）。 */
  const toggleModifiedFilter = (): void => {
    if (immediateParsedSearch.onlyModified) {
      const next = immediateParsedSearch.terms.join(' ');
      setSearchText(next);
      setDebouncedQuery(next);
      return;
    }
    const parts = ['@modified', ...immediateParsedSearch.terms];
    const next = parts.join(' ');
    setSearchText(next);
    setDebouncedQuery(next);
  };

  /** 切换左侧一级分组折叠态。 */
  const toggleGroup = (groupId: registry.SettingsGroupId): void => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
        return next;
      }
      next.add(groupId);
      return next;
    });
  };

  let dialogClass = 'jm-settings jm-sc-shell';
  if (maximized) {
    dialogClass = 'jm-settings jm-sc-shell jm-settings-maximized';
  }
  let maxIcon = <icons.FullscreenOutlined />;
  let maxLabel = t('最大化设置面板');
  if (maximized) {
    maxIcon = <icons.FullscreenExitOutlined />;
    maxLabel = t('还原设置面板');
  }

  let modifiedChipClass = 'jm-sc-mod-chip';
  if (immediateParsedSearch.onlyModified) {
    modifiedChipClass = 'jm-sc-mod-chip jm-active';
  }

  let emptyMessage = t('没有找到与“{query}”匹配的设置项', { query: debouncedQuery.trim() });
  if (parsedSearch.onlyModified && parsedSearch.terms.length === 0) {
    emptyMessage = t('当前没有尚未保存的配置改动');
  }

  const showFloatingBar = edits.length > 0 || restart.kind !== 'idle' || notice !== '';

  let failedReason = '';
  if (restart.kind === 'failed') {
    failedReason = restart.reason;
  }

  let searchSuffix: react.ReactNode = undefined;
  if (searchText === '') {
    searchSuffix = <kbd className="jm-sc-kbd">/</kbd>;
  }

  return (
    <div
      className="jm-settings-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeIfClean();
        }
      }}
    >
      <div className={dialogClass} role="dialog" aria-label={t('设置中心')}>
        <header className="jm-sc-topbar">
          <div className="jm-sc-brand">
            <icons.SettingOutlined className="jm-sc-brand-icon" />
            <span className="jm-sc-brand-title">{t('设置中心')}</span>
            {edits.length > 0 && (
              <span className="jm-sc-pill jm-sc-pill-warn">
                {t('{count} 项待保存', { count: edits.length })}
              </span>
            )}
          </div>

          <div className="jm-sc-search-wrap">
            <antd.Input
              ref={searchInputRef}
              allowClear
              value={searchText}
              prefix={<icons.SearchOutlined className="jm-muted" />}
              suffix={searchSuffix}
              placeholder={t('搜设置、配置键名（port / web_auth / frpc）或 @modified…')}
              onChange={(event) => setSearchText(event.target.value)}
            />
            <button
              type="button"
              className={modifiedChipClass}
              title={t('只看有未保存改动的设置项（@modified）')}
              onClick={toggleModifiedFilter}
            >
              <span>@modified</span>
              {modifiedSectionIds.size > 0 && (
                <span className="jm-sc-chip-count">{modifiedSectionIds.size}</span>
              )}
            </button>
          </div>

          <div className="jm-sc-top-actions">
            <antd.Button
              type="text"
              icon={<icons.ReloadOutlined />}
              aria-label={t('刷新设置与运行态')}
              title={t('刷新设置与运行态')}
              onClick={() => {
                load();
                refreshSnapshot();
              }}
            />
            <antd.Button
              type="text"
              icon={maxIcon}
              aria-label={maxLabel}
              title={maxLabel}
              aria-pressed={maximized}
              onClick={toggleMaximized}
            />
            <antd.Button
              type="text"
              icon={<icons.CloseOutlined />}
              aria-label={t('关闭设置（Esc）')}
              title={t('关闭设置（Esc）')}
              onClick={close}
            />
          </div>
        </header>

        <div className="jm-sc-main">
          <nav className="jm-sc-sidebar" aria-label={t('设置分组导航')}>
            {registry.SETTINGS_GROUPS.map((group) => {
              const items = matchedSections.filter((sec) => sec.groupId === group.id);
              if (searchActive && items.length === 0) return null;

              const groupVisible = visibleSections.filter((sec) => sec.groupId === group.id);
              if (!searchActive && groupVisible.length === 0) return null;

              const expanded = searchActive || expandedGroups.has(group.id);
              const groupDirty = groupVisible.some((sec) => modifiedSectionIds.has(sec.id));
              let chevron = <icons.RightOutlined className="jm-sc-chevron" />;
              if (expanded) {
                chevron = <icons.DownOutlined className="jm-sc-chevron" />;
              }

              return (
                <div key={group.id} className="jm-sc-group">
                  <button
                    type="button"
                    className="jm-sc-group-btn"
                    aria-expanded={expanded}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <span className="jm-sc-group-left">
                      {chevron}
                      <GroupIcon groupId={group.id} />
                      <span>{t(group.title)}</span>
                    </span>
                    <span className="jm-sc-group-right">
                      {searchActive && <span className="jm-sc-hit-count">{items.length}</span>}
                      {!searchActive && groupDirty && !expanded && (
                        <span className="jm-settings-dot" title={t('组内有未保存改动')} />
                      )}
                    </span>
                  </button>

                  {expanded && (
                    <div className="jm-sc-tree-list">
                      {items.map((sec) => {
                        let itemClass = 'jm-sc-tree-item';
                        if (sec.id === activeId) {
                          itemClass = 'jm-sc-tree-item jm-active';
                        }
                        const secDirty = modifiedSectionIds.has(sec.id);
                        return (
                          <button
                            key={sec.id}
                            ref={(el) => registerTreeItemRef(sec.id, el)}
                            type="button"
                            className={itemClass}
                            onClick={() => {
                              userInteractedRef.current = true;
                              scrollToSection(sec.id, 'smooth');
                            }}
                          >
                            <span className="jm-sc-tree-title">
                              <HighlightText text={t(sec.title)} terms={parsedSearch.terms} />
                            </span>
                            {secDirty && (
                              <span className="jm-settings-dot" title={t('改过，还没保存')} />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>

          <section className="jm-sc-body">
            <div
              className="jm-sc-scroll"
              ref={scrollContainerRef}
              onWheel={() => { userInteractedRef.current = true; }}
              onTouchStart={() => { userInteractedRef.current = true; }}
              onMouseDown={() => { userInteractedRef.current = true; }}
            >
              <fields.ChangedContext.Provider value={isChanged}>
                <fields.NavigateSectionContext.Provider value={(targetId) => scrollToSection(targetId)}>
                  {matchedSections.length === 0 && (
                    <div className="jm-sc-empty">
                      <icons.SearchOutlined className="jm-sc-empty-icon" />
                      <div className="jm-sc-empty-text">{emptyMessage}</div>
                      <antd.Button type="primary" onClick={clearSearch}>
                        {t('清空搜索')}
                      </antd.Button>
                    </div>
                  )}

                  {matchedSections.map((sec) => {
                    const group = registry.findGroup(sec.groupId);
                    const secDirty = modifiedSectionIds.has(sec.id);
                    let groupLabel = '';
                    if (group !== undefined) {
                      groupLabel = t(group.title);
                    }
                    let secClass = 'jm-sc-section';
                    if (sec.id === activeId) {
                      secClass = 'jm-sc-section jm-sc-section-active';
                    }

                    return (
                      <article
                        key={sec.id}
                        id={`jm-sc-section-${sec.id}`}
                        data-section-id={sec.id}
                        ref={(el) => registerSectionRef(sec.id, el)}
                        className={secClass}
                      >
                        <header className="jm-sc-section-head">
                          <div className="jm-sc-section-titles">
                            <div className="jm-sc-eyebrow">{groupLabel}</div>
                            <h3 className="jm-sc-section-title">
                              <HighlightText text={t(sec.title)} terms={parsedSearch.terms} />
                            </h3>
                            <p className="jm-sc-section-sub">{t(sec.subtitle)}</p>
                          </div>
                          <div className="jm-sc-section-badges">
                            {secDirty && (
                              <span className="jm-sc-badge jm-sc-badge-dirty">{t('未保存')}</span>
                            )}
                            {sec.immediate && (
                              <span className="jm-sc-badge jm-sc-badge-immediate">
                                {t('即时生效')}
                              </span>
                            )}
                            {(!sec.immediate || sec.configPaths.length > 0) && (
                              <span className="jm-sc-badge jm-sc-badge-config">config.yaml</span>
                            )}
                          </div>
                        </header>
                        <div className="jm-sc-section-body">
                          {renderSectionBody({
                            sectionId: sec.id,
                            draft,
                            loadError,
                            formKey,
                            models,
                            snapshot,
                            onRefreshSnapshot: refreshSnapshot,
                            onEdit,
                            onReloadConfig: load,
                            onNavigate: (targetId) => scrollToSection(targetId, 'smooth'),
                          })}
                        </div>
                      </article>
                    );
                  })}
                </fields.NavigateSectionContext.Provider>
              </fields.ChangedContext.Provider>
            </div>

            {showFloatingBar && (
              <footer className="jm-sc-floating-bar" role="region" aria-label={t('配置保存栏')}>
                {edits.length > 0 && (
                  <div className="jm-sc-bar-row">
                    <div className="jm-sc-bar-info">
                      <button
                        type="button"
                        className="jm-sc-dirty-trigger"
                        onClick={toggleModifiedFilter}
                        title={t('点击切换 @modified 筛选定位改动项')}
                      >
                        <span className="jm-sc-pulse-dot" />
                        <span>{t('有 {count} 处配置待保存', { count: edits.length })}</span>
                      </button>
                      {notice !== '' && <span className="jm-field-error">{notice}</span>}
                    </div>
                    <div className="jm-sc-bar-actions">
                      <antd.Button onClick={discardEdits} disabled={saving}>
                        {t('放弃改动')}
                      </antd.Button>
                      <antd.Button onClick={() => save(false)} loading={saving}>
                        {t('保存配置')}
                      </antd.Button>
                      <antd.Button
                        type="primary"
                        onClick={() => save(true)}
                        loading={saving}
                      >
                        {t('保存并应用')}
                      </antd.Button>
                    </div>
                  </div>
                )}

                {edits.length === 0 && notice !== '' && (
                  <div className="jm-sc-bar-row">
                    <span className="jm-field-error">{notice}</span>
                    <antd.Button size="small" onClick={() => setNotice('')}>
                      {t('知道了')}
                    </antd.Button>
                  </div>
                )}

                {edits.length === 0 && restart.kind !== 'idle' && (
                  <div className="jm-sc-bar-row">
                    <div className="jm-sc-bar-info">
                      {restart.kind === 'saved' && (
                        <span>{t('已保存：供应商与默认模型自动重读，端口/插件/机器人需重启生效')}</span>
                      )}
                      {restart.kind === 'restarting' && (
                        <span className="jm-sc-inline-row">
                          <antd.Spin size="small" />
                          <span>{t('正在重启：先试运行新进程，没问题再换掉正在跑的……')}</span>
                        </span>
                      )}
                      {restart.kind === 'done' && (
                        <span className="jm-sc-text-ok">{t('重启好了，新的设置已经生效')}</span>
                      )}
                      {restart.kind === 'failed' && (
                        <span className="jm-field-error">
                          {t('没重启成：{reason}', { reason: failedReason })}
                        </span>
                      )}
                    </div>
                    <div className="jm-sc-bar-actions">
                      {restart.kind === 'saved' && (
                        <antd.Button
                          size="small"
                          type="primary"
                          onClick={() => { void restartNow(); }}
                        >
                          {t('立即重启')}
                        </antd.Button>
                      )}
                      {restart.kind === 'failed' && (
                        <antd.Button
                          size="small"
                          type="primary"
                          onClick={() => { void restartNow(); }}
                        >
                          {t('重试重启')}
                        </antd.Button>
                      )}
                      {restart.kind !== 'restarting' && (
                        <antd.Button
                          size="small"
                          onClick={() => setRestart({ kind: 'idle' })}
                        >
                          {t('收起')}
                        </antd.Button>
                      )}
                    </div>
                  </div>
                )}
              </footer>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
