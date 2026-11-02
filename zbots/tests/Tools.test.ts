/** 项目只读工具验收：正常读/找/搜及路径、敏感文件、链接和限量边界。全部夹具限定在 jmai 内，不读真实配置。 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as agent from '../src/Agent.ts';
import * as tools from '../src/Tools.ts';


/** 项目内专用临时目录，避免清理系统临时目录中的数据。 */
const testBase = path.resolve(import.meta.dir, '..', '..', 'runtime', 'scratch', 'readonly-tests');


/** 当前用例的夹具根及被工具开放的项目子目录。 */
let fixture = '';
let root = '';


/** 当前用例中的三个真实只读执行器。 */
let registered: agent.AgentTool[];


test.beforeEach(async () => {
  await fs.mkdir(testBase, { recursive: true });
  fixture = await fs.mkdtemp(path.join(testBase, 'case-'));
  root = path.join(fixture, 'project');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(path.join(root, 'zbots', 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'Alpha.ts'), 'first line\nNeedle alpha\nthird line\n');
  await fs.writeFile(path.join(root, 'src', 'Beta.ts'), 'needle beta\n');
  await fs.writeFile(path.join(root, 'zbots', 'src', 'Nested.ts'), 'Nested\n');
  await fs.writeFile(path.join(root, 'docs', '说明.md'), '说明\nNeedle in docs\n');
  registered = await tools.createReadOnlyTools(root);
});


test.afterEach(async () => {
  // g: 清理前核对绝对目标，所有文件和链接目标均在本用例夹具内。
  assert.equal(path.dirname(fixture), testBase);
  await fs.rm(fixture, { recursive: true, force: true });
});


/** 按工具名取执行器，遗漏注册时直接使测试失败。 */
function tool(name: string): agent.AgentTool {
  const found = registered.find((item) => item.definition.name === name);
  assert.ok(found);
  return found;
}


test.test('注册：仅 read/find/grep，无 edit 或执行命令入口', () => {
  assert.deepEqual(registered.map((item) => item.definition.name), ['read', 'find', 'grep']);
  assert.ok(tool('grep').definition.description.includes('不是正则'));
});


test.test('read：指定相对或项目内绝对路径，返回行号和分页信息，文件不变', async () => {
  const file = path.join(root, 'src', 'Alpha.ts');
  const before = await fs.readFile(file, 'utf8');
  const result = await tool('read').execute({ path: 'src/Alpha.ts', offset: 2, limit: 1 });
  assert.ok(result.includes('2: Needle alpha'));
  assert.ok(result.includes('下一页起始行：3'));
  assert.ok(!result.includes('1: first line'));
  assert.ok((await tool('read').execute({ path: file })).includes('1: first line'));
  assert.equal(await fs.readFile(file, 'utf8'), before);
});


test.test('find：按文件名 glob 递归，也支持项目相对路径 glob，不返回正文', async () => {
  const result = await tool('find').execute({ pattern: '*.ts' });
  assert.ok(result.includes('src/Alpha.ts') && result.includes('zbots/src/Nested.ts'));
  assert.ok(!result.includes('Needle alpha'));
  const nested = await tool('find').execute({ pattern: 'zbots/src/**/*.ts' });
  assert.ok(nested.includes('zbots/src/Nested.ts'));
  assert.ok(!nested.includes('src/Alpha.ts'));
});


test.test('grep：字面内容匹配、行号、文件筛选与大小写可控', async () => {
  const result = await tool('grep').execute({ query: 'Needle', path: 'src', include: '*.ts' });
  assert.ok(result.includes('src/Alpha.ts:2: Needle alpha'));
  assert.ok(!result.includes('Beta.ts') && !result.includes('说明.md'));
  const insensitive = await tool('grep').execute({ query: 'NEEDLE', path: 'src', ignore_case: true });
  assert.ok(insensitive.includes('Beta.ts:1: needle beta'));
  assert.ok((await tool('grep').execute({ query: '.*', path: 'src' })).includes('0 项'));
});


test.test('三个工具都拒绝目录越界、兄弟同前缀路径和外部绝对路径', async () => {
  const outside = path.join(fixture, 'project-other', 'src');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'External.ts'), 'external\n');
  for (const unsafe of ['../project-other/src/External.ts', path.join(outside, 'External.ts'), 'src/../../outside.md']) {
    await assert.rejects(tool('read').execute({ path: unsafe }), /拒绝访问/);
    await assert.rejects(tool('find').execute({ path: unsafe, pattern: '*' }), /拒绝访问/);
    await assert.rejects(tool('grep').execute({ path: unsafe, query: 'external' }), /拒绝访问/);
  }
});


test.test('拒绝 UNC、设备路径、NTFS 数据流和非规范路径', async () => {
  for (const unsafe of ['\\\\server\\share\\file.md', '\\\\?\\C:\\file.md', 'src/Alpha.ts:hidden', 'C:relative.md', 'src/Alpha.ts.']) {
    await assert.rejects(tool('read').execute({ path: unsafe }), /拒绝访问/);
  }
});


test.test('敏感文件及运行目录：直接读取拒绝，find/grep 不列出或泄露内容', async () => {
  const denied = ['src/config.yaml', 'src/config.yaml.bak', 'src/.env', 'src/my-secret.txt', 'src/user.local.json', 'src/runtime/data.md', 'src/node_modules/lib.ts', 'src/.git/info.md', 'src/archive/old.md'];
  for (const relative of denied) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), 'TEST_PRIVATE_MARKER');
    await assert.rejects(tool('read').execute({ path: relative }), /拒绝访问/);
  }
  const names = await tool('find').execute({ pattern: '*' });
  for (const relative of denied) {
    assert.ok(!names.includes(relative));
  }
  const content = await tool('grep').execute({ query: 'TEST_PRIVATE_MARKER' });
  assert.ok(!content.includes('TEST_PRIVATE_MARKER'));
});


test.test('未开放目录即使位于项目内部也不允许读取，包括 ztools 控制目录', async () => {
  await assert.rejects(tool('read').execute({ path: 'ztools/dsh-control/.env' }), /拒绝访问/);
  await assert.rejects(tool('find').execute({ path: 'runtime', pattern: '*' }), /拒绝访问/);
  await assert.rejects(tool('grep').execute({ path: 'src_bak', query: 'anything' }), /拒绝访问/);
});


test.test('目录链接：不跟随外部 junction，直接及递归访问都不泄露', async () => {
  const external = path.join(fixture, 'external');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'Outside.ts'), 'OUTSIDE_MARKER');
  await fs.symlink(external, path.join(root, 'src', 'link'), 'junction');
  await assert.rejects(tool('read').execute({ path: 'src/link/Outside.ts' }), /拒绝访问/);
  await assert.rejects(tool('find').execute({ path: 'src/link', pattern: '*' }), /拒绝访问/);
  assert.ok(!(await tool('grep').execute({ query: 'OUTSIDE_MARKER' })).includes('OUTSIDE_MARKER'));
});


test.test('硬链接：不允许通过开放文件名读取别处文件', async () => {
  const external = path.join(fixture, 'external.txt');
  await fs.writeFile(external, 'HARDLINK_MARKER');
  await fs.link(external, path.join(root, 'src', 'Hardlink.ts'));
  await assert.rejects(tool('read').execute({ path: 'src/Hardlink.ts' }), /硬链接/);
  assert.ok(!(await tool('grep').execute({ query: 'HARDLINK_MARKER' })).includes('HARDLINK_MARKER'));
});


test.test('Windows 短名及保留设备名：在访问文件系统前拒绝，不依赖机器启用8.3', async () => {
  for (const unsafe of ['src/SECRET~1.TXT', 'src/NODE_M~1/test.ts', 'src/NUL.txt', 'src/COM1.md']) {
    await assert.rejects(tool('read').execute({ path: unsafe }), /拒绝访问/);
    await assert.rejects(tool('grep').execute({ path: unsafe, query: 'test' }), /拒绝访问/);
  }
});


test.test('只读范围不能由调用参数扩展；文件不存在时报错', async () => {
  await assert.rejects(tool('read').execute({ path: '../config.yaml', root }), /拒绝访问/);
  await assert.rejects(tool('read').execute({ path: 'src/Missing.ts' }));
});


test.test('输入校验：空值、非整数、过大页、错误布尔及过长查询都拒绝', async () => {
  await assert.rejects(tool('read').execute({ path: ' ' }), /非空/);
  await assert.rejects(tool('read').execute({ path: 'src/Alpha.ts', offset: -1 }), /整数/);
  await assert.rejects(tool('read').execute({ path: 'src/Alpha.ts', limit: 201 }), /整数/);
  await assert.rejects(tool('find').execute({ pattern: '*', limit: 0.5 }), /整数/);
  await assert.rejects(tool('grep').execute({ query: 'abc', ignore_case: 'yes' }), /布尔/);
  await assert.rejects(tool('grep').execute({ query: 'x'.repeat(257) }), /256/);
});


test.test('大文件、二进制、非法 UTF-8 不作为正常文本返回', async () => {
  await fs.writeFile(path.join(root, 'src', 'Large.ts'), Buffer.alloc(1024 * 1024 + 1, 65));
  await fs.writeFile(path.join(root, 'src', 'Binary.ts'), Buffer.from([65, 0, 66]));
  await fs.writeFile(path.join(root, 'src', 'Invalid.ts'), Buffer.from([255, 254, 253]));
  await assert.rejects(tool('read').execute({ path: 'src/Large.ts' }), /1 MiB/);
  await assert.rejects(tool('read').execute({ path: 'src/Binary.ts' }), /二进制/);
  await assert.rejects(tool('read').execute({ path: 'src/Invalid.ts' }));
});


test.test('限量：find/grep 达到上限明确提示不完整，长行截断且输出有界', async () => {
  assert.ok((await tool('find').execute({ pattern: '*.ts', limit: 1 })).includes('是否不完整：是'));
  assert.ok((await tool('grep').execute({ query: 'Needle', limit: 1 })).includes('是否不完整：是'));
  await fs.writeFile(path.join(root, 'src', 'Long.ts'), 'A'.repeat(30_000));
  const result = await tool('read').execute({ path: 'src/Long.ts' });
  assert.ok(result.includes('本行截断') && result.length < 20_500);
});
