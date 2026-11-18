/**
 * 网页的状态（zustand）：连没连上、机器人、当前和谁聊、待确认、右栏、设置、主题。
 * 只放几栏共用的东西；一栏自己的（比如输入框里的字）放在那个组件里。
 */
import * as zustand from 'zustand';
import type * as api from './Api.ts';
import type * as i18n from './I18n.ts';
import * as theme from './Theme.ts';
import type * as types from './Types.ts';
import * as historyModule from './Panel/History.ts';
import * as replyLinkModule from './Chat/ReplyLink.ts';


/** 右栏的标签；事件目标和文件预览目标分别保存。 */
export type PanelTab = 'preview' | 'workspace' | 'session' | 'messages' | 'approvals' | 'memory' | 'details' | 'usage' | 'events' | 'todo';


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
  /** 后端当前真正挂载了哪些插件（loading 还没问；unknown 没有接口，按全部可见；数组是 state==='ok' 的插件名）。 */
  mountedPlugins: api.MountedPlugins;
  /** 主题。 */
  themeName: theme.ThemeName;
  /** 界面语言。 */
  language: i18n.Language;
  /** 记下后端已挂载的插件名单。 */
  setMountedPlugins: (plugins: api.MountedPlugins) => void;
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
  /** 记下右栏当前看着的会话（不换标签），待办的清除和展示用它。 */
  selectSession: (id: string | null) => void;
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
  //M 为当前网页状态仓库创建独立的右栏查看历史栈，防止多个页面实例或单测之间共享状态。
  const history = new historyModule.PanelHistory();
  /** 只给本地只读定位编号，不与任何后端运行号混用。 */
  let locationSerial = 0;
  return zustand.create<UiState>((set) => {
    /** 恢复已有条目时只切本地查看，保留原有文件多标签。 */
    /** 切换机器人时清空旧机器人专属的面板定位和工作区标签，并切到新机器人的历史栈。 */
    const getBotSwitchPatch = (changedBot: boolean, nextBot: string | null): Partial<UiState> => {
      if (!changedBot) return {};

      return {
        ...getHistoryState(history.isolate(nextBot)),
        panelTarget: null,
        replySelection: null,
        replySelectionError: null,
        sourceResolutions: {},
        chatLocation: null,
        workspaceTags: [],
        panelSessionId: null,
      };
    };
    const moveHistory = (delta: -1 | 1): void => {
      set((state) => {
        const snapshot = history.move(delta);
        const entry = snapshot.entries[snapshot.index];
        if (!entry) return {};

        let replySelection: ReplySelection | null = null;
        let sourceResolutions: Partial<Record<types.MessageOrigin, SourceResolution>> = {};
        //G 仅当历史条目仍对应当前正在查看的回复时保留已拉取的生成证据与补取结论，切换后不复用旧结果。
        if (replyLinkModule.ReplyLink.sameTarget(entry.traceTarget, state.traceTarget)) {
          replySelection = state.replySelection;
          sourceResolutions = state.sourceResolutions;
        }
        return {
          ...getHistoryState(snapshot),
          panelOpen: true,
          currentBot: entry.bot,
          panelTab: entry.tab,
          panelTarget: entry.target,
          traceTarget: entry.traceTarget,
          replySelection,
          replySelectionError: null,
          sourceResolutions,
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
      //M 为初始空历史生成全新的默认阅读位置对象，确保各属性不与后续条目共享引用。
      panelReading: historyModule.getEmptyReading(),
      settingsOpen: false,
      searchOpen: false,
      newBotOpen: false,
      settingsCategory: 'providers',
      mountedPlugins: 'loading',
      themeName: initialTheme,
      language: initialLanguage,
      setMountedPlugins: (mountedPlugins) => set({ mountedPlugins }),
      setPolled: (result) =>
        set((state) => {
          /** 新的机器人列表；这次没拿到就留着旧的。 */
          const bots = result.bots ?? state.bots;
          /** 现在和谁聊：选过的还在就留着，不在了就换成第一个。 */
          let currentBot: string | null = bots[0]?.name ?? null;
          if (state.currentBot && bots.some((bot) => bot.name === state.currentBot)) {
            currentBot = state.currentBot;
          }
          /** 机器人被移除时，不能让新机器人的事件页显示旧目标。 */
          let traceTarget: TraceTarget | null = null;
          if (state.traceTarget?.bot === currentBot) {
            traceTarget = state.traceTarget;
          }
          /** 选中机器人消失或切换机器人时，旧条目和旧预览位置不能附到新机器人；首次从空定出默认机器人不算换掉。 */
          const changedBot = state.currentBot !== null && currentBot !== state.currentBot;
          return {
            ...getBotSwitchPatch(changedBot, currentBot),
            online: result.online,
            bots,
            currentBot,
            approvals: result.approvals ?? state.approvals,
            traceTarget,
          };
        }),
      dropApproval: (id) => set((state) => ({ approvals: state.approvals.filter((item) => item.id !== id) })),
      selectBot: (name) => set((state) => {
        const changedBot = name !== state.currentBot;
        let traceTarget: TraceTarget | null = null;
        if (state.traceTarget?.bot === name) {
          traceTarget = state.traceTarget;
        }
        return {
          ...getBotSwitchPatch(changedBot, name),
          currentBot: name,
          traceTarget,
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
            //G 按平台路径大小写规则归一化后比对文件身份，防止同一文件在 Windows 下开出重复预览标签。
            return historyModule.getFileIdentity(item.path) === historyModule.getFileIdentity(target.path);
          });
          let previewTabs = state.previewTabs;
          if (target && !alreadyOpened) {
            previewTabs = [...state.previewTabs, target].slice(-MAX_PREVIEW_TABS);
          }
          return {
            ...getHistoryState(snapshot),
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
            ...getHistoryState(snapshot),
            panelSessionId: id,
            panelOpen: true,
            panelTab: 'session',
          };
        }),
      selectSession: (id) => set({ panelSessionId: id }),
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
        //G 判断是否重新点开同一条回复：是则保留现有证据与跨视图补取结果，换了回复就清空等重拉。
        const sameTarget = replyLinkModule.ReplyLink.sameTarget(state.traceTarget, target);
        let selection: ReplySelection | null = null;
        let sourceResolutions: Partial<Record<types.MessageOrigin, SourceResolution>> = {};
        if (sameTarget) {
          selection = state.replySelection;
          sourceResolutions = state.sourceResolutions;
        }
        if (evidence) {
          selection = {
            target,
            generation: evidence.generation,
            association: evidence.association,
          };
        }
        return {
          ...getHistoryState(snapshot),
          currentBot: target.bot,
          traceTarget: target,
          replySelection: selection,
          replySelectionError: null,
          sourceResolutions,
          chatLocation: null,
          panelOpen: true,
          panelTab: 'events',
        };
      }),
      setReplyEvidence: (target, evidence, error) => set((state) => {
        //G 核对异步返回的追溯目标是否仍是当前选中回复，丢弃快速切换后才回来的过期结果。
        if (!replyLinkModule.ReplyLink.sameTarget(state.traceTarget, target)) return {};

        let replySelection = state.replySelection;
        if (evidence) {
          replySelection = {
            target,
            generation: evidence.generation,
            association: evidence.association,
          };
        }
        return {
          replySelection,
          replySelectionError: error ?? null,
        };
      }),
      setSourceResolution: (target, origin, result) => set((state) => {
        //G 只接受归属当前 traceTarget 的来源补取结果，防止旧请求回写覆盖新目标的状态。
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
          ...getHistoryState(snapshot),
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
          //G 用归一化后的文件身份匹配已打开标签，兼容 Windows 路径分隔符和盘符大小写差异。
          return historyModule.getFileIdentity(item.path) === historyModule.getFileIdentity(path);
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
          ...getHistoryState(snapshot),
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
          return { ...getHistoryState(snapshot), previewTabs: rest, panelTarget };
        }),
      //M 沿当前机器人的右栏历史栈后退一步，恢复上一条目标及阅读位置。
      panelBack: () => moveHistory(-1),
      //M 沿当前机器人的右栏历史栈前进一步，恢复下一条目标及阅读位置。
      panelForward: () => moveHistory(1),
      //M 按稳定条目 id 把滚动位置等轻量状态写回历史栈，再投影同步到仓库字段。
      savePanelReading: (id, patch) => set(() => getHistoryState(history.save(id, patch))),
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
function getHistoryState(snapshot: historyModule.PanelHistorySnapshot): Pick<UiState,
  'panelHistory' | 'panelHistoryIndex' | 'panelEntryId' | 'panelReading'> {
  const entry = snapshot.entries[snapshot.index];
  return {
    panelHistory: snapshot.entries,
    panelHistoryIndex: snapshot.index,
    panelEntryId: entry?.id ?? null,
    //M 没有当前历史条目（如初始态或刚切机器人）时回退到全新的空阅读状态，防止沿用旧阅读位置。
    panelReading: entry?.reading ?? historyModule.getEmptyReading(),
  };
}
