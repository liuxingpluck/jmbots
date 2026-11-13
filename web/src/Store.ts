/**
 * 网页的状态（zustand）：连没连上、机器人、当前和谁聊、待确认、右栏、设置、主题。
 * 只放几栏共用的东西；一栏自己的（比如输入框里的字）放在那个组件里。
 */
import * as zustand from 'zustand';
import type * as i18n from './I18n.ts';
import * as theme from './Theme.ts';
import type * as types from './Types.ts';
import * as historyModule from './Panel/History.ts';
import * as replyLinkModule from './Chat/ReplyLink.ts';


/** 右栏的标签；事件目标和文件预览目标分别保存。 */
export type PanelTab = 'preview' | 'workspace' | 'session' | 'messages' | 'approvals' | 'memory' | 'details' | 'usage' | 'events';


/** 右栏要看的东西。 */
export interface PanelTarget {
  /** 文件的绝对路径。 */
  path: string;
  /** 显示的名字。 */
  name: string;
}


/** 正在查看哪一条回复的事件；回复下标来自收件中的 replies 数组。 */
export interface TraceTarget {
  /** 消息所属机器人，用于切换机器人时清除旧目标。 */
  bot: string;
  /** 收件表的消息号。 */
  messageId: number;
  /** 这条消息的第几条回复，从 0 开始；不按正文或时间猜测。 */
  replyIndex: number;
}


/** 只保存关联和生成元信息，不把事件响应或消息正文缓存到 UI 仓库。 */
export interface ReplySelection {
  /** 明确的回答目标。 */
  target: TraceTarget;
  /** 这句文本的生成依据。 */
  generation: types.ReplyGeneration;
  /** 这句文本的来源集合及历史范围。 */
  association: types.ReplyAssociation;
}


/** 当前视图完成补取后的轻量结论，真正消息正文仍由 useMessages 管理。 */
export interface SourceResolution {
  /** 来源在另一聊天视图中，并非缺失。 */
  foreignIds: number[];
  /** 后端明确未返回的消息号。 */
  missingIds: number[];
  /** 补取失败的原因；成功为空。 */
  error: string | null;
}


/** 一次明确定位请求；序号让异步旧请求不能覆盖新操作。 */
export interface ChatLocation {
  /** 此网页内递增的定位操作号。 */
  serial: number;
  /** 当前机器人归属。 */
  bot: string;
  /** 目标在中栏网页对话还是外部消息页。 */
  origin: types.MessageOrigin;
  /** 明确的收件号。 */
  messageId: number;
  /** null 定位原消息；数字定位 replies 的真实下标。 */
  replyIndex: number | null;
  /** 补取与定位状态；失败必须留出提示。 */
  status: 'pending' | 'located' | 'missing' | 'failed';
  /** 当前定位结果的短说明。 */
  error: string | null;
}


/** 预览最多开多少个标签，再多就丢掉最早的。 */
const MAX_PREVIEW_TABS = 30;


/** 网页的状态。 */
export interface UiState {
  /** 连得上后端吗；还没问过时是 null。 */
  online: boolean | null;
  /** 机器人。 */
  bots: types.BotView[];
  /** 现在和谁聊；还没选时用第一个。 */
  currentBot: string | null;
  /** 还在等用户点的命令。 */
  approvals: types.ApprovalView[];
  /** 右栏展开没有。 */
  panelOpen: boolean;
  /** 右栏在哪个标签。 */
  panelTab: PanelTab;
  /** 右栏预览的东西。 */
  panelTarget: PanelTarget | null;
  /** 预览打开过的那些，一个文件一个标签页，新开的在最后（用户 11-06：像 Codex、DSH 右边那样同时开好几个）。 */
  previewTabs: PanelTarget[];
  /** 事件追踪选中的回复；与 panelTarget 独立，切回预览不会丢文件标签。 */
  traceTarget: TraceTarget | null;
  /** 输入框上方的工作区标签；发送时拼成 @绝对路径（G批设计 7.3）。 */
  workspaceTags: types.WorkspaceTag[];
  /** 会话页要看的会话号；从工作区的会话行点进来时设。 */
  panelSessionId: string | null;
  /** 与 traceTarget 对应的轻量证据；历史恢复后可以重新只读加载。 */
  replySelection: ReplySelection | null;
  /** 当前选中回复的证据读取失败；不以配置补齐未知。 */
  replySelectionError: string | null;
  /** 两个来源视图分别报告补取结论。 */
  sourceResolutions: Partial<Record<types.MessageOrigin, SourceResolution>>;
  /** 单次定位操作，不属于后端执行流程。 */
  chatLocation: ChatLocation | null;
  /** 右栏统一查看历史，独立于文件多标签。 */
  panelHistory: historyModule.PanelHistoryEntry[];
  /** 当前查看条目下标，空历史是 -1。 */
  panelHistoryIndex: number;
  /** 当前条目的稳定身份，异步保存必须带它。 */
  panelEntryId: string | null;
  /** 当前条目的轻量阅读状态，不包含正文或响应。 */
  panelReading: historyModule.PanelReadingState;
  /** 设置页开着没有。 */
  settingsOpen: boolean;
  /** 搜聊天的框开着没有（Ctrl+K、左上角的搜索按钮，docs/界面/01_界面设计.md 6.1）。 */
  searchOpen: boolean;
  /** 新建机器人的弹窗开着没有（左上角 ＋，6.2）。 */
  newBotOpen: boolean;
  /** 设置页在哪一类。 */
  settingsCategory: string;
  /** 主题。 */
  themeName: theme.ThemeName;
  /** 界面语言。 */
  language: i18n.Language;
  /** 记下一次轮询的结果。 */
  setPolled: (result: { online: boolean; bots?: types.BotView[]; approvals?: types.ApprovalView[] }) => void;
  /** 这条待确认决定了：不等下一次轮询，马上拿掉。 */
  dropApproval: (id: number) => void;
  /** 换个机器人聊。 */
  selectBot: (name: string) => void;
  /** 打开右栏的某个标签（可以带上要预览的东西）。 */
  openPanel: (tab: PanelTab, target?: PanelTarget) => void;
  /** 打开右栏的“会话”页并选中一个会话。 */
  openSession: (id: string) => void;
  /** 加一个工作区标签；同一个绝对路径只留一个。 */
  addWorkspaceTag: (tag: types.WorkspaceTag) => void;
  /** 按路径去掉一个工作区标签。 */
  removeWorkspaceTag: (path: string) => void;
  /** 清空工作区标签（发送成功、清空输入、换机器人时）。 */
  clearWorkspaceTags: () => void;
  /** 选中具体回复并打开事件标签，不增加预览标签，不触发执行。 */
  openTrace: (target: TraceTarget, evidence?: Pick<types.ReplyView, 'generation' | 'association'>) => void;
  /** 仅接受当前 traceTarget 的结果，丢弃快速切换后的旧响应。 */
  setReplyEvidence: (
    target: TraceTarget,
    evidence: Pick<types.ReplyView, 'generation' | 'association'> | null,
    error?: string,
  ) => void;
  /** 当前视图报告明确来源的缺失、跨视图或读取错误。 */
  setSourceResolution: (target: TraceTarget, origin: types.MessageOrigin, result: SourceResolution) => void;
  /** 定位明确的回答或原消息；外部来源切到现有“消息”页。 */
  locateMessage: (target: Omit<ChatLocation, 'serial' | 'status' | 'error'>) => void;
  /** 只更新同一定位序号的结果，不覆盖后来的定位动作。 */
  finishLocation: (serial: number, status: ChatLocation['status'], error?: string) => void;
  /** 收起右栏。 */
  closePanel: () => void;
  /** 切到一个预览标签。 */
  showPreview: (path: string) => void;
  /** 关掉一个预览标签；关的是正在看的就看旁边那个。 */
  closePreview: (path: string) => void;
  /** 回到上一个右栏查看目标，不执行任务。 */
  panelBack: () => void;
  /** 前进到下一个已查看目标，不执行任务。 */
  panelForward: () => void;
  /** 保存指定条目的阅读状态；旧组件卸载不能写进新目标。 */
  savePanelReading: (id: string, patch: Partial<historyModule.PanelReadingState>) => void;
  /** 开关设置页。 */
  setSettingsOpen: (open: boolean) => void;
  /** 开关搜聊天的框。 */
  setSearchOpen: (open: boolean) => void;
  /** 开关新建机器人的弹窗。 */
  setNewBotOpen: (open: boolean) => void;
  /** 设置页换一类。 */
  setSettingsCategory: (category: string) => void;
  /** 换主题。 */
  setThemeName: (name: theme.ThemeName) => void;
  /** 换语言。 */
  setLanguage: (language: i18n.Language) => void;
}


/**
 * 建一个状态仓库。
 * @param initialTheme 开始用的主题（从浏览器本地存储读出来的）。
 * @param initialLanguage 开始用的语言；不写是简体中文。
 */
export function createUiStore(initialTheme: theme.ThemeName, initialLanguage: i18n.Language = 'zh-CN'): zustand.UseBoundStore<zustand.StoreApi<UiState>> {
  /** 一个网页仓库一份历史；业务状态由 class 管理，不与其他仓库共享。 */
  const history = new historyModule.PanelHistory();
  /** 只给本地只读定位编号，不与任何后端运行号混用。 */
  let locationSerial = 0;
  return zustand.create<UiState>((set) => {
    /** 恢复已有条目时只切本地查看，保留原有文件多标签。 */
    const moveHistory = (delta: -1 | 1): void => {
      set((state) => {
        const snapshot = history.move(delta);
        const entry = snapshot.entries[snapshot.index];
        if (!entry) {
          return {};
        }
        return {
          ...historyState(snapshot),
          panelOpen: true,
          currentBot: entry.bot,
          panelTab: entry.tab,
          panelTarget: entry.target,
          traceTarget: entry.traceTarget,
          replySelection: replyLinkModule.ReplyLink.sameTarget(entry.traceTarget, state.traceTarget)
            ? state.replySelection
            : null,
          replySelectionError: null,
          sourceResolutions: replyLinkModule.ReplyLink.sameTarget(entry.traceTarget, state.traceTarget)
            ? state.sourceResolutions
            : {},
          chatLocation: null,
        };
      });
    };
    return {
    online: null,
    bots: [],
    currentBot: null,
    approvals: [],
    panelOpen: false,
    panelTab: 'preview',
    panelTarget: null,
    previewTabs: [],
    traceTarget: null,
    workspaceTags: [],
    panelSessionId: null,
    replySelection: null,
    replySelectionError: null,
    sourceResolutions: {},
    chatLocation: null,
    panelHistory: [],
    panelHistoryIndex: -1,
    panelEntryId: null,
    panelReading: historyModule.emptyReading(),
    settingsOpen: false,
    searchOpen: false,
    newBotOpen: false,
    settingsCategory: 'providers',
    themeName: initialTheme,
    language: initialLanguage,
    setPolled: (result) =>
      set((state) => {
        /** 新的机器人列表；这次没拿到就留着旧的。 */
        const bots = result.bots ?? state.bots;
        /** 现在和谁聊：选过的还在就留着，不在了就换成第一个。 */
        const currentBot = state.currentBot && bots.some((bot) => bot.name === state.currentBot) ? state.currentBot : (bots[0]?.name ?? null);
        /** 机器人被移除时，不能让新机器人的事件页显示旧目标。 */
        const traceTarget = state.traceTarget?.bot === currentBot
          ? state.traceTarget
          : null;
        /** 选中机器人消失时，旧条目和旧预览位置不能附到新的机器人。 */
        const changedBot = currentBot !== state.currentBot;
        const navigation = changedBot ? historyState(history.isolate(currentBot)) : {};
        return {
          ...navigation,
          online: result.online,
          bots,
          currentBot,
          approvals: result.approvals ?? state.approvals,
          traceTarget,
          panelTarget: changedBot ? null : state.panelTarget,
          replySelection: changedBot ? null : state.replySelection,
          replySelectionError: changedBot ? null : state.replySelectionError,
          sourceResolutions: changedBot ? {} : state.sourceResolutions,
          chatLocation: changedBot ? null : state.chatLocation,
          workspaceTags: changedBot ? [] : state.workspaceTags,
          panelSessionId: changedBot ? null : state.panelSessionId,
        };
      }),
    dropApproval: (id) => set((state) => ({ approvals: state.approvals.filter((item) => item.id !== id) })),
    selectBot: (name) => set((state) => {
      const changedBot = name !== state.currentBot;
      const navigation = changedBot ? historyState(history.isolate(name)) : {};
      return {
        ...navigation,
        currentBot: name,
        traceTarget: state.traceTarget?.bot === name ? state.traceTarget : null,
        panelTarget: changedBot ? null : state.panelTarget,
        replySelection: changedBot ? null : state.replySelection,
        replySelectionError: changedBot ? null : state.replySelectionError,
        sourceResolutions: changedBot ? {} : state.sourceResolutions,
        chatLocation: changedBot ? null : state.chatLocation,
        workspaceTags: changedBot ? [] : state.workspaceTags,
        panelSessionId: changedBot ? null : state.panelSessionId,
      };
    }),
    openPanel: (tab, target) =>
      set((state) => {
        const panelTarget = target ?? state.panelTarget;
        const snapshot = history.visit({
          bot: state.currentBot,
          tab,
          target: panelTarget,
          traceTarget: state.traceTarget,
        });
        const alreadyOpened = target && state.previewTabs.some((item) => {
          return historyModule.fileIdentity(item.path) === historyModule.fileIdentity(target.path);
        });
        const previewTabs = target && !alreadyOpened
          ? [...state.previewTabs, target].slice(-MAX_PREVIEW_TABS)
          : state.previewTabs;
        return {
          ...historyState(snapshot),
          panelOpen: true,
          panelTab: tab,
          panelTarget,
          previewTabs,
        };
      }),
    openSession: (id) =>
      set((state) => {
        //M 会话页是现场面板：历史只记“看过会话页”，不记具体是哪个会话（G批设计 8.1）。
        const snapshot = history.visit({
          bot: state.currentBot,
          tab: 'session',
          target: state.panelTarget,
          traceTarget: state.traceTarget,
        });
        return {
          ...historyState(snapshot),
          panelSessionId: id,
          panelOpen: true,
          panelTab: 'session',
        };
      }),
    addWorkspaceTag: (tag) =>
      set((state) => {
        //G 同一个绝对路径只留一个，重复点不加。
        if (state.workspaceTags.some((item) => item.path === tag.path)) {
          return {};
        }
        return { workspaceTags: [...state.workspaceTags, tag] };
      }),
    removeWorkspaceTag: (path) =>
      set((state) => ({ workspaceTags: state.workspaceTags.filter((item) => item.path !== path) })),
    clearWorkspaceTags: () => set({ workspaceTags: [] }),
    openTrace: (target, evidence) => set((state) => {
      if (state.currentBot !== target.bot) {
        history.isolate(target.bot);
      }
      const snapshot = history.visit({
        bot: target.bot,
        tab: 'events',
        target: state.panelTarget,
        traceTarget: target,
      });
      const sameTarget = replyLinkModule.ReplyLink.sameTarget(state.traceTarget, target);
      let selection = sameTarget ? state.replySelection : null;
      if (evidence) {
        selection = {
          target,
          generation: evidence.generation,
          association: evidence.association,
        };
      }
      return {
        ...historyState(snapshot),
        currentBot: target.bot,
        traceTarget: target,
        replySelection: selection,
        replySelectionError: null,
        sourceResolutions: sameTarget ? state.sourceResolutions : {},
        chatLocation: null,
        panelOpen: true,
        panelTab: 'events',
      };
    }),
    setReplyEvidence: (target, evidence, error) => set((state) => {
      if (!replyLinkModule.ReplyLink.sameTarget(state.traceTarget, target)) {
        return {};
      }
      return {
        replySelection: evidence ? {
          target,
          generation: evidence.generation,
          association: evidence.association,
        } : state.replySelection,
        replySelectionError: error ?? null,
      };
    }),
    setSourceResolution: (target, origin, result) => set((state) => {
      if (!replyLinkModule.ReplyLink.sameTarget(state.traceTarget, target)) {
        return {};
      }
      return { sourceResolutions: { ...state.sourceResolutions, [origin]: result } };
    }),
    locateMessage: (target) => set((state) => {
      if (target.bot !== state.currentBot) {
        return {};
      }
      locationSerial += 1;
      const location: ChatLocation = {
        ...target,
        serial: locationSerial,
        status: 'pending',
        error: null,
      };
      if (target.origin === 'web') {
        return { chatLocation: location };
      }
      const snapshot = history.visit({
        bot: target.bot,
        tab: 'messages',
        target: state.panelTarget,
        traceTarget: state.traceTarget,
      });
      return {
        ...historyState(snapshot),
        panelOpen: true,
        panelTab: 'messages',
        chatLocation: location,
      };
    }),
    finishLocation: (serial, status, error) => set((state) => {
      if (state.chatLocation?.serial !== serial) {
        return {};
      }
      return { chatLocation: { ...state.chatLocation, status, error: error ?? null } };
    }),
    closePanel: () => set({ panelOpen: false }),
    showPreview: (path) => set((state) => {
      const target = state.previewTabs.find((item) => {
        return historyModule.fileIdentity(item.path) === historyModule.fileIdentity(path);
      });
      if (!target) {
        return {};
      }
      const snapshot = history.visit({
        bot: state.currentBot,
        tab: 'preview',
        target,
        traceTarget: state.traceTarget,
      });
      return {
        ...historyState(snapshot),
        panelOpen: true,
        panelTab: 'preview',
        panelTarget: target,
      };
    }),
    closePreview: (path) =>
      set((state) => {
        /** 关的是第几个。 */
        const index = state.previewTabs.findIndex((item) => item.path === path);
        /** 剩下的。 */
        const rest = state.previewTabs.filter((item) => item.path !== path);
        if (state.panelTarget?.path !== path) {
          return { previewTabs: rest };
        }
        const panelTarget = rest[Math.min(index, rest.length - 1)] ?? null;
        const snapshot = history.visit({
          bot: state.currentBot,
          tab: state.panelTab,
          target: panelTarget,
          traceTarget: state.traceTarget,
        });
        return { ...historyState(snapshot), previewTabs: rest, panelTarget };
      }),
    panelBack: () => moveHistory(-1),
    panelForward: () => moveHistory(1),
    savePanelReading: (id, patch) => set(() => historyState(history.save(id, patch))),
    setSettingsOpen: (open) => set({ settingsOpen: open }),
    setSearchOpen: (open) => set({ searchOpen: open }),
    setNewBotOpen: (open) => set({ newBotOpen: open }),
    setSettingsCategory: (category) => set({ settingsCategory: category }),
    setThemeName: (name) => set({ themeName: name }),
    setLanguage: (language) => set({ language }),
    };
  });
}


/** 从轻量历史快照投影当前阅读状态，不复制正文或触发任何后端动作。 */
function historyState(snapshot: historyModule.PanelHistorySnapshot): Pick<UiState,
  'panelHistory' | 'panelHistoryIndex' | 'panelEntryId' | 'panelReading'> {
  const entry = snapshot.entries[snapshot.index];
  return {
    panelHistory: snapshot.entries,
    panelHistoryIndex: snapshot.index,
    panelEntryId: entry?.id ?? null,
    panelReading: entry?.reading ?? historyModule.emptyReading(),
  };
}
