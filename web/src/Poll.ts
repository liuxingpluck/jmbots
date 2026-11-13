/**
 * 轮询（docs/界面/01_界面设计.md 第 5 节）：每 1.5 秒问一次机器人和待确认；页面在后台时放慢到 5 秒。后端换了版本就刷新网页。
 * 一轮问完才排下一轮，网络慢时不会叠起来。连不上（或后端 5xx）就记成离线，左栏显示休假中。
 * 界面语言跟 config.yaml 的 ui.language 走（/api/ui/info 带回来），浏览器也记一份，下次打开不闪。
 */
import type * as zustand from 'zustand';
import * as api from './Api.ts';
import * as i18n from './I18n.ts';
import type * as storeModule from './Store.ts';


/** 页面在前台时多久问一次，毫秒。 */
export const POLL_MS = 1500;

/** 页面在后台时多久问一次，毫秒。 */
export const HIDDEN_POLL_MS = 5000;


/**
 * 问一轮：机器人和待确认。
 * @param store 状态仓库。
 * 副作用：发两个请求，结果写进仓库。
 */
export async function pollOnce(store: zustand.StoreApi<storeModule.UiState>): Promise<void> {
  try {
    /** 机器人和待确认。 */
    const [bots, approvals] = await Promise.all([api.bots(), api.approvals()]);
    store.getState().setPolled({ online: true, bots, approvals });
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
async function checkBackendChanged(store: zustand.StoreApi<storeModule.UiState>, seen: number | undefined): Promise<number | undefined> {
  /** 后端进程信息（起来的时间、界面语言）。 */
  const info = await api.uiInfo().catch(() => undefined);
  /** 后端起来的时间。 */
  const startedAt = info?.startedAt;
  /** 网址指定的语言；有它就不跟配置。 */
  const urlLanguage = i18n.matchLanguage(new URLSearchParams(window.location.search).get('lang'));
  /** 配置里的语言。 */
  const configLanguage = i18n.matchLanguage(info?.language);
  //M 配置写了语言就跟配置：浏览器记的旧语言（比如 en）要让位，记一份新的下次打开不闪。
  if (urlLanguage === undefined && configLanguage !== undefined && store.getState().language !== configLanguage) {
    store.getState().setLanguage(configLanguage);
    i18n.saveLanguage(window.localStorage, configLanguage);
  }
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
    await pollOnce(store);
    seenStartedAt = await checkBackendChanged(store, seenStartedAt);
    if (!stopped) {
      timer = setTimeout(() => void tick(), document.hidden ? HIDDEN_POLL_MS : POLL_MS);
    }
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
