/**
 * 把状态仓库交给各个组件：Main.tsx 建好仓库放进 UiContext，组件用 useUi(选择函数) 取。
 */
import * as react from 'react';
import type * as zustand from 'zustand';
import type * as storeModule from './Store.ts';


/** 状态仓库（zustand 建的）。 */
export type UiStore = zustand.UseBoundStore<zustand.StoreApi<storeModule.UiState>>;


/** 放仓库的上下文。 */
export const UiContext = react.createContext<UiStore | null>(null);


/**
 * 取仓库。
 * @throws 没有放进 UiContext 时抛错（说明 Main.tsx 没包上）。
 */
export function useUiStore(): UiStore {
  /** 仓库。 */
  const store = react.useContext(UiContext);
  if (!store) {
    throw new Error('UiContext 里没有状态仓库：Main.tsx 要用 UiContext.Provider 包住 App');
  }
  return store;
}


/**
 * 取状态的一部分；这部分变了组件才重画。
 * @param selector 选择函数。
 */
export function useUi<T>(selector: (state: storeModule.UiState) => T): T {
  //M 从 Context 取到状态仓库并立刻订阅 selector 切片，只在选中字段变化时触发组件重渲染。
  return useUiStore()(selector);
}
