/**
 * 界面状态（zustand）：网址里的选中状态、搜索词、目录树收起了哪些目录。
 * 选中状态以网址为准：store 跟着网址变（手改 hash、浏览器前进后退），应用内跳转也先写网址再更新 store，
 * 所以刷新页面、浏览器后退都能回到原来的位置。网址的写法见 Route.ts。
 * 浏览器监听在本文件加载时装一次。PC 和手机布局读的是同一份，切换布局时搜索词和目录收起状态都还在。
 */
import * as zustand from 'zustand';
import * as route from './Route.ts';


/** 应用内跳转时写进历史记录的标记；返回键据此判断上一条记录是不是自己跳过来的。 */
const APP_ENTRY = { jmaiRoute: true };


/** 界面状态和改它的动作。 */
interface ViewState {
  /** 网址里的选中状态：哪个目录、哪篇文档。 */
  route: route.Route;
  /** 搜索框里的文字；文档列表按它过滤标题，空字符串表示不过滤。 */
  query: string;
  /** 用户在目录树上手动收起的目录 key；默认全部展开，之后新加载的目录也是展开的。 */
  collapsedKeys: string[];
  /** 跳到新的选中状态：新开一条历史记录，所以浏览器后退能回到上一个位置。 */
  goTo: (next: route.Route) => void;
  /**
   * 返回上一层（手机布局左上角的返回键）。
   * 当前记录是应用内跳进来的，就直接后退，和系统的返回手势效果一样；
   * 直接打开深层网址时没有上一条可退，就把当前记录原地换成 parent，不会退出网页。
   */
  goUp: (parent: route.Route) => void;
  /** 改搜索词。 */
  setQuery: (query: string) => void;
  /** 改目录树上收起的目录。 */
  setCollapsedKeys: (keys: string[]) => void;
}


/** 界面状态的 store；组件用 `useViewStore((state) => state.xxx)` 取一块。 */
export const useViewStore = zustand.create<ViewState>()((set) => ({
  route: route.parseRoute(window.location.hash),
  query: '',
  collapsedKeys: [],
  goTo: (next) => {
    // m: 记录上带“应用内跳转”的标记；pushState 不会触发 hashchange，所以这里自己同步。
    window.history.pushState(APP_ENTRY, '', route.formatRoute(next));
    syncRoute();
  },
  goUp: (parent) => {
    // m: 后退会触发 popstate，由监听去同步。
    if (isAppEntry(window.history.state)) {
      window.history.back();
      return;
    }
    window.history.replaceState(null, '', route.formatRoute(parent));
    syncRoute();
  },
  setQuery: (query) => set({ query }),
  setCollapsedKeys: (collapsedKeys) => set({ collapsedKeys }),
}));


// m: 手改 hash、浏览器前进后退时，把 store 同步到网址。
window.addEventListener('hashchange', syncRoute);
window.addEventListener('popstate', syncRoute);


/** 按当前网址更新选中状态；没变就不更新，免得后退时 popstate 和 hashchange 各触发一次重新渲染。 */
function syncRoute(): void {
  /** 当前网址解析出的选中状态。 */
  const next = route.parseRoute(window.location.hash);
  /** store 里原来的选中状态。 */
  const previous = useViewStore.getState().route;
  if (next.baseId === previous.baseId && next.documentId === previous.documentId) {
    return;
  }
  useViewStore.setState({ route: next });
}


/** 历史记录上的数据是不是 goTo 写的标记。 */
function isAppEntry(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'jmaiRoute' in state;
}
