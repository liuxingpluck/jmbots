/**
 * 网页状态仓库里预览标签的离线测试：开标签去重、30 个上限丢最早的、
 * 关标签时切到旁边、showPreview 切换与找不到时保持原样。
 * 只碰 web/src/Store.ts 的纯逻辑，不起浏览器、不连后端。
 */
import * as bunTest from 'bun:test';
import * as storeModule from '../web/src/Store.ts';


/**
 * 造一个预览目标，路径和名字都由编号（或字母）拼出来，方便断言。
 * @param key 文件的编号或字母，例如 '1'、'a'。
 * @returns 带绝对路径和显示名字的预览目标。
 */
function targetOf(key: string): storeModule.PanelTarget {
  const name = `${key}.md`;
  return { path: `F:/x/${name}`, name };
}


bunTest.describe('状态仓库·预览标签', () => {
  bunTest.test('打开预览加标签、同一个文件不重复、不带 target 只切标签', () => {
    //M 造一个深色主题的仓库，打开第一个文件。
    const first = targetOf('1');
    const store = storeModule.createUiStore('dark');
    store.getState().openPanel('preview', first);
    bunTest.expect(store.getState().previewTabs).toHaveLength(1);
    bunTest.expect(store.getState().panelTarget).toEqual(first);
    bunTest.expect(store.getState().panelOpen).toBe(true);
    bunTest.expect(store.getState().panelTab).toBe('preview');
    //G 同一个 path 再开一次：不重复加标签。
    store.getState().openPanel('preview', targetOf('1'));
    bunTest.expect(store.getState().previewTabs).toHaveLength(1);
    //M 换一个文件：变成两个标签，且当前预览是新的这个。
    const second = targetOf('2');
    store.getState().openPanel('preview', second);
    bunTest.expect(store.getState().previewTabs).toHaveLength(2);
    bunTest.expect(store.getState().panelTarget).toEqual(second);
    //G 不带 target 打开 workspace：只切 panelTab，不新增标签，panelTarget 不变。
    const before = store.getState().panelTarget;
    store.getState().openPanel('workspace');
    bunTest.expect(store.getState().panelTab).toBe('workspace');
    bunTest.expect(store.getState().previewTabs).toHaveLength(2);
    bunTest.expect(store.getState().panelTarget).toBe(before);
  });

  bunTest.test('超过 30 个丢掉最早的，重开已有的不重复', () => {
    //M 从头依次打开 31 个不同文件。
    const store = storeModule.createUiStore('dark');
    for (let n = 1; n <= 31; n += 1) {
      store.getState().openPanel('preview', targetOf(String(n)));
    }
    //G 最多留 30 个：最早开的第 1 个被丢，队首是第 2 个，队尾是第 31 个。
    bunTest.expect(store.getState().previewTabs).toHaveLength(30);
    bunTest.expect(store.getState().previewTabs[0]!.path).toBe(targetOf('2').path);
    bunTest.expect(store.getState().previewTabs.at(-1)!.path).toBe(targetOf('31').path);
    //G 重开一个已经存在的（第 2 个）：仍 30 个，且这个 path 不重复。
    store.getState().openPanel('preview', targetOf('2'));
    bunTest.expect(store.getState().previewTabs).toHaveLength(30);
    bunTest.expect(store.getState().previewTabs.filter((item) => item.path === targetOf('2').path)).toHaveLength(1);
  });

  bunTest.test('closePreview 关正在看的切到旁边，关完是 null', () => {
    //M 开 a、b、c，把当前切到中间的 b。
    const a = targetOf('a');
    const b = targetOf('b');
    const c = targetOf('c');
    const store = storeModule.createUiStore('dark');
    store.getState().openPanel('preview', a);
    store.getState().openPanel('preview', b);
    store.getState().openPanel('preview', c);
    store.getState().showPreview(b.path);
    bunTest.expect(store.getState().panelTarget?.path).toBe(b.path);
    //M 关掉正在看的 b：剩下 [a,c]，切到旁边的下一个 c。
    store.getState().closePreview(b.path);
    bunTest.expect(store.getState().previewTabs.map((item) => item.path)).toEqual([a.path, c.path]);
    bunTest.expect(store.getState().panelTarget?.path).toBe(c.path);
    //G 关到最后一个 c 时切前一个 a。
    store.getState().closePreview(c.path);
    bunTest.expect(store.getState().panelTarget?.path).toBe(a.path);
    //G 把最后一个 a 也关掉：标签空了，当前预览是 null。
    store.getState().closePreview(a.path);
    bunTest.expect(store.getState().previewTabs).toEqual([]);
    bunTest.expect(store.getState().panelTarget).toBeNull();
  });

  bunTest.test('closePreview 关的不是正在看的，panelTarget 不变', () => {
    //M 开 a、b、c，当前预览停在新开的 c。
    const a = targetOf('a');
    const b = targetOf('b');
    const c = targetOf('c');
    const store = storeModule.createUiStore('dark');
    store.getState().openPanel('preview', a);
    store.getState().openPanel('preview', b);
    store.getState().openPanel('preview', c);
    bunTest.expect(store.getState().panelTarget?.path).toBe(c.path);
    //G 关的是没在看的 a：只从标签里拿掉，panelTarget 仍是 c。
    store.getState().closePreview(a.path);
    bunTest.expect(store.getState().previewTabs.map((item) => item.path)).toEqual([b.path, c.path]);
    bunTest.expect(store.getState().panelTarget?.path).toBe(c.path);
  });

  bunTest.test('showPreview 切换；找不到的路径保持原样', () => {
    //M 开 a、b、c，切到 b，再切到 c。
    const a = targetOf('a');
    const b = targetOf('b');
    const c = targetOf('c');
    const store = storeModule.createUiStore('dark');
    store.getState().openPanel('preview', a);
    store.getState().openPanel('preview', b);
    store.getState().openPanel('preview', c);
    store.getState().showPreview(b.path);
    bunTest.expect(store.getState().panelTarget?.path).toBe(b.path);
    store.getState().showPreview(c.path);
    bunTest.expect(store.getState().panelTarget?.path).toBe(c.path);
    //G 切一个不存在的路径：find 不到就保持原来的 panelTarget（仍是 c）。
    store.getState().showPreview('F:/x/不存在.md');
    bunTest.expect(store.getState().panelTarget?.path).toBe(c.path);
  });
});
