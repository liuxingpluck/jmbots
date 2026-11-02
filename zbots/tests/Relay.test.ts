/** Relay.ts 的离线测试：核对工具定义、临时目录里的留言及未配置会话的提示，不读真实配置、不启动 DSH。 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as relay from '../src/Relay.ts';
import type * as runtime from '../src/Runtime.ts';


/** 每个用例自己的临时目录，测试命令把 TEMP/TMP 限在 jmai 内。 */
let tempDir = '';


/** 不含真实配置的运行时，工具只使用其中的目录。 */
let zbots: runtime.Runtime;


test.beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zbots-relay-'));
  zbots = {
    configFile: '',
    config: { runtime_dir: tempDir, providers: {}, models: {}, workspaces: {} },
    dir: tempDir,
    sharedDir: path.join(tempDir, 'shared'),
    rolesDir: path.join(tempDir, 'roles'),
    workspacesDir: path.join(tempDir, 'workspaces'),
    evaluationsDir: path.join(tempDir, 'evaluations'),
  };
});


test.afterEach(async () => {
  // g: 清理前确认是本命令指定的项目内临时目录，不允许删除其他位置。
  assert.ok(path.resolve(os.tmpdir()).replaceAll('\\', '/').toLowerCase().startsWith('f:/aidata/source/jmai/runtime/'));
  assert.equal(path.dirname(path.resolve(tempDir)), path.resolve(os.tmpdir()));
  await fs.rm(tempDir, { recursive: true, force: true });
});


test.test('开发助手工具：英文名字，分别要求 task 和 message 字符串参数', () => {
  const tools = relay.createRelayTools(zbots, undefined);
  assert.deepEqual(tools.map((tool) => tool.definition.name), ['ask_dsh', 'note_for_claude']);
  test.expect(tools[0]?.definition.parameters).toMatchObject({ type: 'object', required: ['task'], properties: { task: { type: 'string', minLength: 1 } } });
  test.expect(tools[1]?.definition.parameters).toMatchObject({ type: 'object', required: ['message'], properties: { message: { type: 'string', minLength: 1 } } });
});


test.test('Claude 留言：建运行时 feishu 目录，每次追加一行，保留已有留言', async () => {
  const note = relay.createRelayTools(zbots, undefined).find((tool) => tool.definition.name === 'note_for_claude');
  assert.ok(note);
  assert.equal(await note.execute({ message: '第一条留言' }), '已记下给 Claude 的留言。Claude 的 VSCode 会话开着时会看到。');
  await note.execute({ message: '第二条\n继续说明' });
  const lines = (await fs.readFile(path.join(tempDir, 'feishu', '给Claude.md'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? '', /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 第一条留言$/);
  assert.match(lines[1] ?? '', / 第二条 ⏎ 继续说明$/);
});


for (const session of [undefined, '']) {
  test.test(`ask_dsh：会话${session === undefined ? '未配置' : '为空字符串'}时返回还没配，不写任务文件`, async () => {
    const ask = relay.createRelayTools(zbots, session).find((tool) => tool.definition.name === 'ask_dsh');
    assert.ok(ask);
    test.expect(JSON.parse(await ask.execute({ task: '转发测试' })) as unknown).toMatchObject({ status: 'invalid', code: 'missing_default', accepted: false, sessionId: null });
    assert.deepEqual(await fs.readdir(tempDir), []);
  });
}


test.test('工具参数无效：不写留言、不转发', async () => {
  const [ask, note] = relay.createRelayTools(zbots, undefined);
  assert.ok(ask && note);
  await assert.rejects(ask.execute({ task: 123 }), /task 要写非空文字/);
  await assert.rejects(note.execute({ message: '  ' }), /message 要写非空文字/);
  assert.deepEqual(await fs.readdir(tempDir), []);
});
