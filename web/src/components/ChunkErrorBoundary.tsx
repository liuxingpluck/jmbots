/**
 * 分块加载失败的兜底（云端 26 M1）：换版后旧页面去拿已删掉的懒加载分块会失败。
 * 第一次失败自动刷新拿新版；刚刷新过又失败就不再刷，显示一个刷新按钮，防止无限刷新。
 * 不是分块失败的错误照旧往外抛，不在这里吞掉。
 */
import * as react from 'react';

/** 上次因分块失败自动刷新的时刻，存在 sessionStorage，只在这个标签页里有效。 */
const RELOAD_KEY = 'jmbots:chunk-reload-at';
/** 距上次自动刷新不到这么久又失败，就当新版也拿不到，改成显示按钮。 */
const RELOAD_GAP_MS = 10_000;
/** Chrome、Safari 和 webpack 报动态导入失败的字样。 */
const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError/u;

/** 按钮样式：跟着主题变量走，变量没设时用深色。 */
const BUTTON_STYLE: react.CSSProperties = {
  margin: '40px auto',
  display: 'block',
  padding: '10px 20px',
  color: 'var(--jm-text, #e6e6e6)',
  background: 'var(--jm-panel, #1f1f1f)',
  border: '1px solid var(--jm-border, #424242)',
  borderRadius: 6,
  cursor: 'pointer',
};

/**
 * 判断是不是分块加载失败。
 * @param error 子组件抛出的错误。
 */
function isChunkError(error: Error): boolean {
  return CHUNK_ERROR.test(`${error.name} ${error.message}`);
}

/** 包在页面根组件外面，接住懒加载分块失败。 */
export class ChunkErrorBoundary extends react.Component<{ children: react.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error): void {
    //G 别的错误、刚自动刷新过又失败的，都不自动刷新
    if (!isChunkError(error)) return;

    const last = Number(window.sessionStorage.getItem(RELOAD_KEY));
    if (Date.now() - last < RELOAD_GAP_MS) return;

    //M 记下时刻再刷新，刷新后再失败就走按钮
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    window.location.reload();
  }

  render(): react.ReactNode {
    const error = this.state.error;
    if (error === null) return this.props.children;

    //G 不是分块失败，原样往外抛
    if (!isChunkError(error)) throw error;

    //M 自动刷新前的一瞬间、或二次失败时显示，点了就手动刷新
    return (
      <button type="button" style={BUTTON_STYLE} onClick={() => window.location.reload()}>
        页面已更新，点此刷新
      </button>
    );
  }
}
