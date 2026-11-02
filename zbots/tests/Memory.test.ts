/** Memory.ts 的离线测试：配置和运行时目录都放在临时目录里，不调模型。 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as piAi from '@earendil-works/pi-ai';
import * as memory from '../src/Memory.ts';
import * as runtime from '../src/Runtime.ts';
import * as utils from '../src/Utils.ts';


/** 每个用例自己的临时目录；用例结束后删除。 */
let tempDir = '';


/** 每个用例自己的运行时，配置里有“日常”“项目”两个工作区。 */
let zbots: runtime.Runtime;


test.beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zbots-memory-'));
  /** 配置文件路径。 */
  const configFile = path.join(tempDir, 'config.yaml');
  await utils.writeYaml(configFile, {
    providers: { magpie: { base_url: 'http://127.0.0.1:3425/v1', api_key: 'magpie-test' } },
    models: {
      dispatch: { model: 'magpie/auto/deepseek-v4.1-flash' },
      work: { model: 'magpie/auto/deepseek-v4.1-flash' },
      evaluate: { model: 'magpie/auto/deepseek-v4.1-flash' },
      decision: { model: 'magpie/openrouter/typesafe/jev-1.14' },
    },
    workspaces: { 日常: { description: '日常问答、查资料' }, 项目: { description: '某个项目' } },
  });
  zbots = await runtime.loadRuntime(['--config', configFile]);
});


test.afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});


test.test('新建对话：写 对话.yaml，记进 bot 的 对话.md，重写工作区索引', async () => {
  // 标题故意用像数字的“111”和带竖线、换行的文字：YAML 读回来要还是字符串，索引表格不能被弄乱。
  const first = await memory.createConversation(zbots, { title: '111', bot: '周小灵', workspace: '日常', from: '飞书私聊' });
  const second = await memory.createConversation(zbots, { title: '查 a|b\n两个文件', bot: '周小灵', workspace: '日常', from: '命令行' });

  assert.match(first.info.id, /^\d{17}[a-z]{3}$/);
  assert.equal(first.dir, path.join(zbots.workspacesDir, '日常', first.info.id));
  /** 从文件读回来的第一个对话。 */
  const saved = (await utils.readYaml(path.join(first.dir, '对话.yaml'))) as memory.ConversationInfo;
  assert.deepEqual(saved, first.info);
  assert.equal(typeof saved.title, 'string');
  assert.equal(typeof saved.created, 'string');
  assert.equal(saved.status, '进行中');
  assert.equal(saved.steps, 0);

  /** 周小灵的 对话.md。 */
  const roleText = await fs.readFile(path.join(zbots.rolesDir, '周小灵', '对话.md'), 'utf8');
  assert.ok(roleText.startsWith('# 周小灵 的对话\n'));
  assert.ok(roleText.endsWith(`- ${first.dir}\n- ${second.dir}\n`));

  /** 工作区索引。 */
  const indexText = await fs.readFile(path.join(zbots.workspacesDir, '日常', '索引.md'), 'utf8');
  assert.ok(indexText.includes('# 工作区：日常\n\n日常问答、查资料\n'));
  assert.ok(indexText.includes('共 2 个对话'));
  assert.ok(indexText.includes(`| ${first.info.id} | 111 | 周小灵 | 进行中 | 飞书私聊 | 0 | ${first.info.updated} |`));
  assert.ok(indexText.includes(`| ${second.info.id} | 查 a\\|b 两个文件 | 周小灵 | 进行中 | 命令行 | 0 |`));
});


test.test('列对话：只认对话文件夹，最近活动的在前；保存后排到最前', async () => {
  const older = await memory.createConversation(zbots, { title: '旧的', bot: '周小灵', workspace: '日常', from: '命令行' });
  const newer = await memory.createConversation(zbots, { title: '新的', bot: '周小灵', workspace: '日常', from: '命令行' });
  /** 日常工作区。 */
  const workspace = memory.findWorkspace(zbots, '日常');
  await fs.mkdir(path.join(workspace.dir, 'files'), { recursive: true });
  await fs.mkdir(path.join(workspace.dir, '20261101000000000xyz'));

  assert.deepEqual((await memory.listConversations(workspace)).map((item) => item.id), [newer.info.id, older.info.id]);

  // 新对话的最近活动改到 2000 年（像是很久没动）；旧对话改成“完成”、走了 3 步再保存，最近活动变成现在，排到最前。
  newer.info.updated = '2000-01-01 00:00:00';
  await utils.writeYaml(path.join(newer.dir, '对话.yaml'), newer.info);
  older.info.status = '完成';
  older.info.steps = 3;
  await memory.saveConversation(older);

  /** 保存后的列表。 */
  const list = await memory.listConversations(workspace);
  assert.deepEqual(list.map((item) => item.id), [older.info.id, newer.info.id]);
  assert.equal(list[0]?.status, '完成');
  assert.equal(list[0]?.steps, 3);
  assert.ok((await fs.readFile(path.join(workspace.dir, '索引.md'), 'utf8')).includes('| 旧的 | 周小灵 | 完成 | 命令行 | 3 |'));
  assert.deepEqual(await memory.listConversations(memory.findWorkspace(zbots, '项目')), []);
});


test.test('打开对话：按工作区和 ID 找；ID 写错、没有这个对话、没有这个工作区都报错', async () => {
  const created = await memory.createConversation(zbots, { title: '查天气', bot: '周小灵', workspace: '项目', from: '命令行' });

  /** 重新打开的对话。 */
  const opened = await memory.openConversation(zbots, '项目', created.info.id);
  assert.deepEqual(opened.info, created.info);
  assert.equal(opened.dir, created.dir);
  assert.equal(opened.workspace.name, '项目');

  await assert.rejects(memory.openConversation(zbots, '项目', '../日常'), /对话 ID 写错了/);
  await assert.rejects(memory.openConversation(zbots, '日常', created.info.id), /工作区 日常 里没有对话/);
  await assert.rejects(memory.openConversation(zbots, '不存在', created.info.id), /没有工作区 不存在/);
  await assert.rejects(memory.createConversation(zbots, { title: 'x', bot: '../周小灵', workspace: '日常', from: '命令行' }), /不能带路径/);
});


test.test('上下文：一行一条消息，追加后按先后读回', async () => {
  const conversation = await memory.createConversation(zbots, { title: '聊天', bot: '周小灵', workspace: '日常', from: '命令行' });
  assert.deepEqual(await memory.loadContext(conversation), []);

  /** 第一轮：用户的话。 */
  const userMessage: piAi.Message = { role: 'user', content: '你好\n第二行', timestamp: 1 };
  await memory.appendContext(conversation, [userMessage]);
  /** 第二轮：两条用户消息一起追加。 */
  const more: piAi.Message[] = [
    { role: 'user', content: '再问一句', timestamp: 2 },
    { role: 'user', content: [{ type: 'text', text: '第三句' }], timestamp: 3 },
  ];
  await memory.appendContext(conversation, more);

  assert.deepEqual(await memory.loadContext(conversation), [userMessage, ...more]);
  assert.equal((await fs.readFile(path.join(conversation.dir, 'context.jsonl'), 'utf8')).split('\n').length, 4);
});
