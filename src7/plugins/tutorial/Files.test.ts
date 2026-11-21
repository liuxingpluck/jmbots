/**
 * tutorial/Files.ts 离线测试：快照落盘是原子写（先写临时文件再改名），写完不留临时文件，覆盖旧文件也是整份新内容。
 * 跑法：bun test ./src7/plugins/tutorial
 */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as filesModule from './Files.ts';


/** 每个测试自己的临时运行时根目录，测完删掉。 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


/** FlowFiles 私有的 write，测试直接调它（writeBoot、writeMessage 只是把它推到下一拍）。 */
type Writer = { write(file: string, build: () => Promise<filesModule.FlowFile>): Promise<void> };


/**
 * 建一份写到临时目录的 FlowFiles。
 * @returns files 是 FlowFiles，dir 是它写的 data/flow/ 目录。
 */
function makeFiles(): { files: filesModule.FlowFiles; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-tutorial-files-'));
  roots.push(root);

  //M FlowFiles 只用 ctx.resources.root 算目录，测试给一个最小的 ctx。
  const ctx = { resources: { root } } as unknown as cordis.Context;
  const files = new filesModule.FlowFiles(ctx, 3);
  return { files, dir: files.dir };
}


test('快照原子写：目录没有就建，写完是完整 JSON、不留临时文件，再写整份覆盖', async () => {
  const { files, dir } = makeFiles();
  const writer = files as unknown as Writer;

  //M 第一次写：data/flow/ 还不在，写完文件在、能解析，目录里只有它。
  const first = { trail: { message: 0, steps: [] }, shots: [] } as unknown as filesModule.FlowFile;
  await writer.write('boot.json', async () => first);
  const full = path.join(dir, 'boot.json');
  expect(JSON.parse(fs.readFileSync(full, 'utf8'))).toEqual(first);
  expect(fs.readdirSync(dir)).toEqual(['boot.json']);

  //M 再写一次：内容整份换成新的，还是不留 .tmp。
  const second = { trail: { message: 0, steps: [{ node: 'main' }] }, shots: [] } as unknown as filesModule.FlowFile;
  await writer.write('boot.json', async () => second);
  expect(JSON.parse(fs.readFileSync(full, 'utf8'))).toEqual(second);
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  expect(leftovers).toEqual([]);
});
