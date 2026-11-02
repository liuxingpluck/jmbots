/** Bot.ts 的离线测试：角色设定放临时运行时的 roles/<名字>/设定.yaml；真实角色目录存在时另做只读检查，不读真实 config.yaml。 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as bot from '../src/Bot.ts';
import * as runtime from '../src/Runtime.ts';
import * as utils from '../src/Utils.ts';


/** 每个用例自己的临时目录；用例结束后删除。 */
let tempDir = '';


/** 用户指定的真实角色目录，只读设定文件，不读主配置。 */
const realRolesDir = 'F:/aidata/AIZbots/roles';


/** 没有本机运行时时跳过真实角色检查。 */
const hasRealRoles = await fs.stat(realRolesDir).then((stat) => stat.isDirectory()).catch(() => false);


test.beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zbots-bot-'));
});


test.afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});


/**
 * 在临时目录写一份无密钥的假配置，读出运行时；省略 runtime_dir 就使用配置所在目录。
 * @returns 临时运行时，不访问真实配置。
 */
async function loadTestRuntime(): Promise<runtime.Runtime> {
  /** 配置文件路径。 */
  const configFile = path.join(tempDir, 'config.yaml');
  await utils.writeYaml(configFile, {
    providers: { magpie: { base_url: 'http://127.0.0.1:3425/v1', api_key: 'magpie-test' } },
    models: {
      dispatch: { model: 'magpie/workbuddy/deepseek-v4.1-flash' },
      work: { model: 'magpie/workbuddy/deepseek-v4.1-flash' },
      evaluate: { model: 'magpie/workbuddy/deepseek-v4.1-flash' },
      decision: { model: 'magpie/openrouter/typesafe/jev-1.14' },
    },
    workspaces: { 日常: { description: '日常问答' } },
  });
  return runtime.loadRuntime(['--config', configFile]);
}


test.test('读角色：补默认值，空积木变空字符串，忽略普通文件和没有设定的目录', async () => {
  await utils.writeYaml(path.join(tempDir, 'roles', '甲', '设定.yaml'), {
    description: '聊天',
    system: { 身份: '你是甲。', 空块: null },
    tools: ['read'],
    routes: ['乙'],
  });
  await utils.writeYaml(path.join(tempDir, 'roles', '乙', '设定.yaml'), { system: { 身份: '你是乙。' }, judge: '甲' });
  await fs.writeFile(path.join(tempDir, 'roles', '说明.md'), '不是角色\n');
  await fs.mkdir(path.join(tempDir, 'roles', '只有历史记录'));

  const bots = await bot.loadBots(await loadTestRuntime());

  assert.deepEqual(Object.keys(bots).sort(), ['乙', '甲']);
  assert.deepEqual(bots.甲, { name: '甲', description: '聊天', system: { 身份: '你是甲。', 空块: '' }, tools: ['read'], judge: 'decision', routes: ['乙'] });
  assert.deepEqual(bots.乙, { name: '乙', description: '', system: { 身份: '你是乙。' }, tools: [], judge: '甲', routes: [] });
});


test.test('读角色：没写 system、判断者或转交对象不存在都报错', async () => {
  const zbots = await loadTestRuntime();
  const settingsFile = path.join(tempDir, 'roles', '甲', '设定.yaml');
  await utils.writeYaml(settingsFile, { description: '没写积木' });
  await assert.rejects(bot.loadBots(zbots), /甲[/\\]设定\.yaml 里没有 system/);

  await utils.writeYaml(settingsFile, { system: { 身份: '你是甲。' }, judge: '不存在' });
  await assert.rejects(bot.loadBots(zbots), /bot 甲 的 judge 写的是 不存在/);

  await utils.writeYaml(settingsFile, { system: { 身份: '你是甲。' }, routes: ['不存在'] });
  await assert.rejects(bot.loadBots(zbots), /bot 甲 的 routes 里有 不存在/);
});


test.test.skipIf(!hasRealRoles)('真实角色设定都能读：周小灵用分类模型判断，能调开发助手工具', async () => {
  const localRuntime = await loadTestRuntime();
  const bots = await bot.loadBots({ ...localRuntime, rolesDir: realRolesDir });

  assert.ok(bots.周小灵 && bots.工作助手 && bots.判断员);
  assert.equal(bots.周小灵.judge, 'decision');
  assert.ok(bots.周小灵.system.身份?.includes('周小灵'));
  assert.ok(bots.周小灵.tools.includes('ask_dsh') && bots.周小灵.tools.includes('note_for_claude'));
  for (const name of ['read', 'find', 'grep']) {
    assert.ok(bots.周小灵.tools.includes(name));
  }
  assert.ok(!bots.周小灵.tools.includes('edit') && !bots.周小灵.tools.includes('shell'));
  assert.ok(bots.周小灵.system.分工?.includes('拿不准该不该转，先问用户一句。'));
});
