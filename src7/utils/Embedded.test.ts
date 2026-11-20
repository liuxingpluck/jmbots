/** 编译版网页文件只接受由打包工具登记的 web/ 资产。 */
import { expect, test } from 'bun:test';


test('编译版读取 web/ 登记项，裸键只能通过通用查询看见', async () => {
  //M 用独立模块实例模拟编译版，普通源码模式的其他测试仍能从磁盘读取资源。
  const moduleName = './Embedded.ts?compiled-asset-test';
  const embedded = await import(moduleName) as typeof import('./Embedded.ts');
  const path = import.meta.path;
  const entries = { 'web/codex2-index.html': path, 'codex2-bare.html': path };
  embedded.registerEmbeddedFiles(entries, 1);

  expect(await embedded.readAsset('codex2-index.html')).toBeInstanceOf(Buffer);
  expect(await embedded.readAsset('codex2-bare.html')).toBeUndefined();
  expect(embedded.findEmbeddedFilePath('codex2-bare.html')).toBe(path);

  const regular = await import('./Embedded.ts');
  expect(regular.isCompiled()).toBe(false);
});
