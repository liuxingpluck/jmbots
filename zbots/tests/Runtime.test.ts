/** Runtime.ts 和 Utils.ts 的离线测试：配置文件和运行时目录都放在临时目录里。 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as runtime from '../src/Runtime.ts';
import * as utils from '../src/Utils.ts';


/** 每个用例自己的临时目录；用例结束后删除。 */
let tempDir = '';


test.beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zbots-runtime-'));
});


test.afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});


/**
 * 在临时目录写一份 config.yaml。
 * @param decisionModel models.decision.model 的写法；默认是合法的。
 * @returns 配置文件路径。
 */
async function writeConfig(decisionModel = 'magpie/openrouter/typesafe/jev-1.14'): Promise<string> {
  /** 配置文件路径。 */
  const configFile = path.join(tempDir, 'config.yaml');
  await utils.writeYaml(configFile, {
    runtime_dir: './数据',
    providers: { magpie: { base_url: 'http://127.0.0.1:3425/v1', api_key: 'magpie-test' } },
    models: {
      dispatch: { model: 'magpie/auto/deepseek-v4.1-flash', thinking: 'low' },
      work: { model: 'magpie/auto/deepseek-v4.1-flash', thinking: 'high' },
      evaluate: { model: 'magpie/auto/deepseek-v4.1-flash', thinking: 'low' },
      decision: { model: decisionModel },
    },
    workspaces: {
      日常: { description: '杂事', work_dir: '' },
      项目: { description: '某个项目', work_dir: './项目代码' },
    },
  });
  return configFile;
}


test.test('读配置：相对路径以配置文件所在目录为准，建好目录骨架，列出工作区和 bot', async () => {
  const configFile = await writeConfig();
  const loaded = await runtime.loadRuntime(['--config', configFile]);
  await utils.writeYaml(path.join(loaded.rolesDir, '周小灵', '设定.yaml'), { system: { 身份: '周小灵' } });
  await utils.writeYaml(path.join(loaded.rolesDir, '工作助手', '设定.yaml'), { system: { 身份: '工作助手' } });
  await fs.writeFile(path.join(loaded.rolesDir, '说明.md'), '不是角色\n');
  await fs.mkdir(path.join(loaded.rolesDir, '只有记录'));
  await fs.mkdir(path.join(loaded.rolesDir, '设定是目录', '设定.yaml'), { recursive: true });

  assert.equal(loaded.dir, path.join(tempDir, '数据'));
  assert.equal(loaded.rolesDir, path.join(tempDir, '数据', 'roles'));
  assert.equal('botsDir' in loaded, false);
  for (const folder of ['shared', 'roles', 'workspaces', 'evaluations']) {
    assert.ok((await fs.stat(path.join(tempDir, '数据', folder))).isDirectory());
  }
  assert.deepEqual(runtime.listWorkspaces(loaded), [
    { name: '日常', description: '杂事', dir: path.join(tempDir, '数据', 'workspaces', '日常'), workDir: path.join(tempDir, '数据', 'workspaces', '日常', 'files') },
    { name: '项目', description: '某个项目', dir: path.join(tempDir, '数据', 'workspaces', '项目'), workDir: path.join(tempDir, '项目代码') },
  ]);
  assert.deepEqual(await runtime.listBots(loaded), ['周小灵', '工作助手']);
  assert.deepEqual(await runtime.listBots({ ...loaded, rolesDir: path.join(tempDir, '不存在') }), []);
});


test.test('省略 runtime_dir：使用配置所在文件夹，旧 bots_dir 不再影响角色路径', async () => {
  const configFile = await writeConfig();
  /** 仅改本用例生成的假配置，绝不读取真实主配置。 */
  const config = await utils.readYaml(configFile) as Record<string, unknown>;
  delete config.runtime_dir;
  config.bots_dir = './不再使用';
  await utils.writeYaml(configFile, config);
  const loaded = await runtime.loadRuntime(['--config', configFile]);
  assert.equal(loaded.dir, tempDir);
  assert.equal(loaded.config.runtime_dir, '.');
  assert.equal(loaded.rolesDir, path.join(tempDir, 'roles'));
  assert.equal('botsDir' in loaded, false);
});


test.test('配置缺了必需的段就报错，说清缺什么', async () => {
  const configFile = await writeConfig('jev-1.14');
  await assert.rejects(runtime.loadRuntime(['--config', configFile]), /models\.decision\.model 要写成“供应商\/模型 ID”/);
});


test.test('时间 ID：17 位本地时间加 3 个小写字母，按字符串排序就是按时间排序', () => {
  const id = utils.createTimeId(new Date(2026, 10, 1, 21, 30, 5, 123));
  assert.match(id, /^20261101213005123[a-z]{3}$/);
  assert.ok(utils.createTimeId(new Date(2026, 10, 1, 21, 30, 5, 124)) > id);
  assert.equal(utils.formatTime(new Date(2026, 10, 1, 21, 30, 5)), '2026-11-01 21:30:05');
});


test.test('长文本截短：超出部分省略，注明总字数', () => {
  assert.equal(utils.truncate('短文本', 10), '短文本');
  assert.equal(utils.truncate('一二三四五', 2), '一二\n……（共 5 字，后面 3 字省略）');
  assert.equal(utils.getArg(['run', '--config', 'a.yaml'], 'config'), 'a.yaml');
  assert.equal(utils.getArg(['run'], 'config'), undefined);
});
