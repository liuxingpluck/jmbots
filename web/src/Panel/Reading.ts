/**
 * 右栏组件共用的轻量阅读状态：保存闭包绑定历史条目，卸载不能污染新目标。
 * 事件、文档和工作区各自提供独立滚动容器，内容就绪后才恢复位置。
 */
import * as react from 'react';
import * as context from '../Context.ts';
import type * as historyModule from './History.ts';


/** 恢复位置最多补设几帧：里面有虚拟列表（react-virtuoso）时，高度要晚一两帧才撑出来。 */
const RESTORE_FRAMES = 20;

/** 右栏外层共享滚动容器 Context，让内部列表（如记忆命中）直接复用，不另套滚动框。 */
export const PanelScrollContext = react.createContext<HTMLElement | null>(null);


/** 组件当前条目的阅读状态和只保存该条目的动作。 */
export interface ReadingState {
  /** 当前历史条目的状态；没有历史时为默认值。 */
  reading: historyModule.PanelReadingState;
  /** 闭包已绑定条目号，可以用于异步回调和卸载收尾。 */
  saveReading: (patch: Partial<historyModule.PanelReadingState>) => void;
}


/**
 * 取得当前查看条目的轻量状态及绑定到当前条目的保存回调；不读取或缓存任何响应正文。
 * @returns 包含当前阅读状态 `reading` 与异步安全更新函数 `saveReading` 的对象。
 * 副作用：订阅全局 UI 状态中的 `panelReading`、`panelEntryId` 与 `savePanelReading`；调用 `saveReading` 会更新历史条目。
 */
export function useReadingState(): ReadingState {
  //M 从全局 UI 状态订阅当前历史条目的轻量阅读状态、条目号与保存回调，供读写当前目标的阅读进度。
  const reading = context.useUi((state) => state.panelReading);
  const entryId = context.useUi((state) => state.panelEntryId);
  const savePanelReading = context.useUi((state) => state.savePanelReading);
  /** 条目号必须在渲染时捕获，不能在卸载时再询问“当前条目”。 */
  const saveReading = react.useCallback((patch: Partial<historyModule.PanelReadingState>): void => {
    if (entryId !== null) {
      savePanelReading(entryId, patch);
    }
  }, [entryId, savePanelReading]);

  return { reading, saveReading };
}


/**
 * 为指定滚动容器恢复和保存位置；不是 document 或浏览器全局滚动。
 * @param ref 组件自己的可滚动元素，卸载时保留捕获的旧元素。
 * @param ready 当前目标的数据已加载；false 时不把加载占位位置覆盖到历史。
 * @returns 无；仅更新 DOM 的 scrollTop 和本地轻量阅读状态。
 * 副作用：内容就绪后设置容器 `scrollTop`（高度未撑开时逐帧补设），并监听 `scroll` 事件在滚动及卸载时回写当前条目的 `scrollTop`。
 */
export function useReadingScroll(
  ref: react.RefObject<HTMLElement | null>,
  ready = true,
): void {
  //M 订阅当前条目号、store 实例与阅读状态读写方法，供恢复位置及判断分段是否变化使用。
  const entryId = context.useUi((state) => state.panelEntryId);
  const store = context.useUiStore();
  const { reading, saveReading } = useReadingState();
  /** 每个目标的恢复值由此次 effect 捕获，滚动保存不重新触发位置恢复。 */
  const restoreTop = reading.scrollTop;
  const pageOffset = reading.pageOffset;

  react.useLayoutEffect(() => {
    const element = ref.current;
    if (!ready || !element) {
      return undefined;
    }
    element.scrollTop = restoreTop;
    /** 占位或卸载可能先压缩 DOM 高度；收尾只保存最后一次有效滚动值。 */
    let lastTop = restoreTop;
    /** 同条目切到新文件段时，旧段卸载不能把旧滚动写回新段。 */
    const stillSamePage = (): boolean => {
      const entry = store.getState().panelHistory.find((item) => item.id === entryId);
      return entry?.reading.pageOffset === pageOffset;
    };

    //M 内容还没撑到那么高（虚拟列表晚一两帧才有高度），scrollTop 被截短了：逐帧补设，到位或补满 RESTORE_FRAMES 帧为止。
    /** 还在补设：这期间的滚动是自己设的，不保存，免得把截短的值写回历史。 */
    let restoring = element.scrollTop < restoreTop - 1;
    /** 已补了几帧。 */
    let frames = 0;
    /** 下一帧的请求号，卸载时取消。 */
    let frame = 0;
    const restoreAgain = (): void => {
      element.scrollTop = restoreTop;
      frames += 1;
      const reached = element.scrollTop >= restoreTop - 1;
      if (reached || frames >= RESTORE_FRAMES) {
        restoring = false;
        return;
      }
      frame = requestAnimationFrame(restoreAgain);
    };
    if (restoring) {
      frame = requestAnimationFrame(restoreAgain);
    }

    const savePosition = (): void => {
      if (restoring) return;

      //G 同条目已切换到其他分段时忽略本次滚动，避免旧页面位置覆盖新页面。
      if (!stillSamePage()) {
        return;
      }
      //M 记录当前有效滚动位置并保存回该历史条目，供切走返回后恢复。
      lastTop = element.scrollTop;
      saveReading({ scrollTop: lastTop });
    };
    element.addEventListener('scroll', savePosition, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('scroll', savePosition);
      //G 卸载时仅当仍停留在同一文件分段，才将最后一次有效滚动位置写回历史。
      if (stillSamePage()) {
        saveReading({ scrollTop: lastTop });
      }
    };
    //M scrollTop 的保存不应重新恢复；目标变化或内容由未就绪转为就绪才运行。
  }, [entryId, pageOffset, ready, ref, saveReading, store]);
}
