/**
 * 右栏组件共用的轻量阅读状态：保存闭包绑定历史条目，卸载不能污染新目标。
 * 事件、文档和工作区各自提供独立滚动容器，内容就绪后才恢复位置。
 */
import * as react from 'react';
import * as context from '../Context.ts';
import type * as historyModule from './History.ts';


/** 组件当前条目的阅读状态和只保存该条目的动作。 */
export interface ReadingState {
  /** 当前历史条目的状态；没有历史时为默认值。 */
  reading: historyModule.PanelReadingState;
  /** 闭包已绑定条目号，可以用于异步回调和卸载收尾。 */
  saveReading: (patch: Partial<historyModule.PanelReadingState>) => void;
}


/** 取得当前查看条目的轻量状态；不读取或缓存任何响应正文。 */
export function useReadingState(): ReadingState {
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
 */
export function useReadingScroll(
  ref: react.RefObject<HTMLElement | null>,
  ready = true,
): void {
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

    const savePosition = (): void => {
      if (!stillSamePage()) {
        return;
      }
      lastTop = element.scrollTop;
      saveReading({ scrollTop: lastTop });
    };
    element.addEventListener('scroll', savePosition, { passive: true });
    return () => {
      element.removeEventListener('scroll', savePosition);
      if (stillSamePage()) {
        saveReading({ scrollTop: lastTop });
      }
    };
    //M scrollTop 的保存不应重新恢复；目标变化或内容由未就绪转为就绪才运行。
  }, [entryId, pageOffset, ready, ref, saveReading, store]);
}
