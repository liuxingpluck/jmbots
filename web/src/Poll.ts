/**
 * 轮询（docs/界面/01_界面设计.md 第 5 节）：每 1.5 秒问一次机器人、待确认和进度卡片；页面在后台时放慢到 5 秒。后端换了版本就刷新网页。
 * 一轮问完才排下一轮，网络慢时不会叠起来。连不上（或后端 5xx）就记成离线，左栏显示休假中。
 * 界面语言跟 config.yaml 的 ui.language 走（/api/ui/info 带回来），浏览器也记一份，下次打开不闪。
 */
import type * as zustand from 'zustand';
import * as api from './Api.ts';
import * as i18n from './I18n.ts';
import type * as storeModule from './Store.ts';
import type * as types from './Types.ts';


/** 页面在前台时多久问一次，毫秒。 */
export const POLL_MS = 1500;

/** 页面在后台时多久问一次，毫秒。 */
export const HIDDEN_POLL_MS = 5000;


/**
 * 问一轮：机器人、待确认和进度卡片。
 * @param store 状态仓库。
 * 副作用：发三个请求（插件没挂的那项不发），结果写进仓库。
 */
export async function pollOnce(store: zustand.StoreApi<storeModule.UiState>): Promise<void> {
  try {
    /** 首次轮询并行查询已挂载插件与机器人列表，避免首轮因插件状态未就绪而误打 404。 */
    let pluginsPromise: Promise<api.MountedPlugins | undefined> = Promise.resolve(undefined);
    if (store.getState().mountedPlugins === 'loading') {
      //M 仅在尚未探测插件名单时并发查询一次已挂载插件，结果存入仓库避免后续反复打 404。
      pluginsPromise = api.mountedPlugins().catch(() => undefined);
    }

    //M 并行等待插件探测与机器人列表请求，随后统一更新在线态和左栏机器人数据。
    const [plugins, bots] = await Promise.all([pluginsPromise, api.bots()]);
    if (plugins !== undefined) {
      store.getState().setMountedPlugins(plugins);
    }

    /** 没挂 approval 插件时不去打 /api/approvals 的 404。 */
    //G 先检查后端是否挂载了 approval 插件，确认挂载才去拉待确认列表。
    const askApprovals = api.isPluginMounted(store.getState().mountedPlugins, 'approval', false);
    let approvals: types.ApprovalView[] = [];
    if (askApprovals) {
      //M 拉取当前待人工确认的命令审批卡片，供审批弹窗与右栏待审核页展示。
      approvals = await api.approvals().catch(() => []);
    }

    /** 没挂 progress 插件时不去打 /api/progress 的 404。 */
    //G 先检查后端是否挂载了 progress 插件，确认挂载才去拉进度卡片。
    const askProgress = api.isPluginMounted(store.getState().mountedPlugins, 'progress', false);
    let progress: types.ProgressView[] | undefined = [];
    if (askProgress) {
      //M 拉取全部机器人的进度卡片：左栏、聊天区进度条、鲸鱼娘都读这一份，不再各自轮询。
      //G 单次取数失败时交给仓库保留上一份；只有未挂载或成功读到空列表才清空。
      progress = await api.progress().catch(() => undefined);
    }
    store.getState().setPolled({ online: true, bots, approvals, progress });
  } catch (error) {
    //M 连不上或后端出错 → 离线；别的错（4xx）说明后端在，只是这次没问对，不算离线。
    /** 是不是后端不在。 */
    const offline = !(error instanceof api.ApiError) || error.status === 0 || error.status >= 500;
    store.getState().setPolled({ online: !offline });
  }
}


/**
 * 能不能现在刷新网页：输入框里有字、设置页开着（可能有没保存的改动）时都不刷，等用户弄完。
 * @param store 状态仓库。
 */
function canReload(store: zustand.StoreApi<storeModule.UiState>): boolean {
  return !store.getState().settingsOpen && !document.querySelector('.jm-editor')?.textContent?.trim();
}


/**
 * 后端换了版本（起来的时间变了）：网页也可能是新的，刷新一下，用户不用关开窗口。
 * 顺带把界面语言换成 config.yaml 的 ui.language（网址带 ?lang 时以网址为准，截图核对用）。
 * @param store 状态仓库。
 * @param seen 上一次看到的起来时间。
 * @returns 这一次看到的；问不到时还是原来的。
 * 副作用：发一个请求；可能刷新网页；语言变了写进仓库和浏览器。
 */
async function checkBackendChanged(
  store: zustand.StoreApi<storeModule.UiState>,
  seen: number | undefined,
): Promise<number | undefined> {
  /** 后端进程信息（起来的时间、界面语言）。 */
  //M 拉取后端进程启动时间与界面语言配置，用来识别后端重启换版并同步本地语言。
  const info = await api.uiInfo().catch(() => undefined);
  /** 后端起来的时间。 */
  const startedAt = info?.startedAt;
  /** 网址指定的语言；有它就不跟配置。 */
  //M 解析地址栏 ?lang= 参数并归一化，存在时优先生效以支持截图等临时切语言场景。
  const urlLanguage = i18n.matchLanguage(new URLSearchParams(window.location.search).get('lang'));
  /** 配置里的语言。 */
  //M 把后端返回的 ui.language 归一化为受支持语言代码，供下面与仓库当前语言比对同步。
  const configLanguage = i18n.matchLanguage(info?.language);
  //M 配置写了语言就跟配置：浏览器记的旧语言（比如 en）要让位，记一份新的下次打开不闪。
  if (urlLanguage === undefined && configLanguage !== undefined && store.getState().language !== configLanguage) {
    store.getState().setLanguage(configLanguage);
    i18n.saveLanguage(window.localStorage, configLanguage);
  }

  //G 确认后端启动时间变了且当前不在输入消息或设置页里，才整页刷新以装载新前端，以免打断编辑。
  if (seen !== undefined && startedAt !== undefined && startedAt !== seen && canReload(store)) {
    window.location.reload();
  }
  //G 现在不能刷新：记着旧的，下一轮再看。
  return seen ?? startedAt;
}


/**
 * 开始轮询。
 * @param store 状态仓库。
 * @returns 停下来的函数。
 * 副作用：定时发请求。
 */
export function startPolling(store: zustand.StoreApi<storeModule.UiState>): () => void {
  /** 停了没有。 */
  let stopped = false;
  /** 下一轮的定时器。 */
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 后端起来的时间（换了版本会变）。 */
  let seenStartedAt: number | undefined;
  /** 问一轮，再排下一轮。 */
  const tick = async (): Promise<void> => {
    //M 执行本轮轮询以拉取机器人状态和待确认清单并写进仓库。
    await pollOnce(store);
    //M 轮询完顺带检查后端是否换了新进程或改了界面语言，按需同步语言或触发刷新。
    seenStartedAt = await checkBackendChanged(store, seenStartedAt);
    if (!stopped) {
      //M 页面隐藏时放慢轮询频率，减少后台请求。
      let delay = POLL_MS;
      if (document.hidden) {
        delay = HIDDEN_POLL_MS;
      }

      //M 等上一轮请求彻底结束后再排下一轮定时器，避免网络卡顿时请求堆积并发。
      timer = setTimeout(() => void tick(), delay);
    }
  };

  //M 启动轮询时立刻打第一轮，让网页首屏尽快显示最新机器人与连接状态。
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
