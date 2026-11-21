/**
 * tutorial/PluginMap.ts 离线单元测试：真 Cordis 挂三个假插件和工具服务，核对插件名单、版本、依赖、听的事件、
 * 事件倒排的先后、源码和说明的路径与简介、工具名，配置里的密钥不出现在图谱里，以及 pickPlugin 命中和不中。
 * 跑法：bun test ./src7/plugins/tutorial/PluginMap.test.ts
 */
import * as piAi from '@earendil-works/pi-ai';
import { afterEach, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as toolsModule from '../../Tools.ts';
import type * as channels from '../channels/index.ts';
import * as pluginMapModule from './PluginMap.ts';


/** 配置里的假密钥：图谱的 JSON 里不能出现它。 */
const SECRET = 'sk-secret-123';

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) {
    close();
  }
});


/**
 * 建一个假源码目录：alpha 有说明（开头是标题和改版记录），beta 只有带文件头的 index.ts，gamma 什么都没有。
 * @returns 源码根目录。
 */
function makeSourceRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-map-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));

  const alpha = path.join(root, 'src7', 'plugins', 'alpha');
  fs.mkdirSync(alpha, { recursive: true });
  fs.writeFileSync(path.join(alpha, 'index.ts'), 'export const version = \'1.0.0\';\n');
  fs.writeFileSync(path.join(alpha, '说明.md'), '# alpha\n\n1.0.0 第一版\n\nalpha 管测试用的前台。\n');

  const beta = path.join(root, 'src7', 'plugins', 'beta');
  fs.mkdirSync(beta, { recursive: true });
  fs.writeFileSync(path.join(beta, 'index.ts'), '/**\n * beta 登记一个工具。\n */\nexport {};\n');
  return root;
}


/**
 * 挂工具服务和三个假插件：alpha 先挂、beta 后挂，都听 session/before-model；beta 的配置带密钥。
 * @returns 根 ctx。
 */
async function mountPlugins(): Promise<cordis.Context> {
  const ctx = new cordis.Context();
  await ctx.plugin(toolsModule.Tools);

  const alpha = {
    name: 'alpha',
    apply(child: cordis.Context) {
      child.on('session/before-model', () => undefined);
      child.on('channel/direct', () => undefined);
      child.on('internal/dispatch', () => undefined);
    },
  };
  await ctx.plugin(alpha);

  const beta = {
    name: 'beta',
    inject: ['tools'],
    apply(child: cordis.Context, _config: { apiKey: string }) {
      child.on('session/before-model', () => undefined);
      const definition = { name: 'beta_tool', description: '测试工具', parameters: piAi.Type.Object({}) };
      child.tools.register({ definition, sessionKinds: ['work'], run: () => '' });
    },
  };
  await ctx.plugin(beta, { apiKey: SECRET });

  const gamma = {
    name: 'gamma',
    apply() {
      //M 什么都不听，只占一个名字。
    },
  };
  await ctx.plugin(gamma);
  return ctx;
}


test('图谱：版本、依赖、事件、倒排先后、源码说明、工具名，且不带配置密钥', async () => {
  const ctx = await mountPlugins();
  const root = makeSourceRoot();
  const modules = { alpha: { version: '1.0.0' } };

  const map = pluginMapModule.inspectPluginMap(ctx, root, modules);

  //T 名单按名字排序，三个假插件都在。
  const names = map.plugins.map((plugin) => plugin.name);
  expect(names).toContain('alpha');
  expect(names).toContain('beta');
  expect(names).toContain('gamma');
  expect(names).toEqual([...names].sort());
  expect(map.totalPlugins).toBe(map.plugins.length);

  //T alpha：名录给版本；业务事件和 internal 事件分开；说明跳过标题和改版记录取正文。
  const alpha = map.plugins.find((plugin) => plugin.name === 'alpha');
  expect(alpha).toMatchObject({
    version: '1.0.0',
    inject: [],
    events: ['channel/direct', 'session/before-model'],
    internalEvents: ['internal/dispatch'],
    entryFile: 'src7/plugins/alpha/index.ts',
    docFile: 'src7/plugins/alpha/说明.md',
    summary: 'alpha 管测试用的前台。',
  });

  //T beta：名录里没有，版本空、依赖照运行时；没有说明，简介取 index.ts 文件头。
  const beta = map.plugins.find((plugin) => plugin.name === 'beta');
  expect(beta).toMatchObject({
    version: '',
    inject: ['tools'],
    events: ['session/before-model'],
    internalEvents: [],
    entryFile: 'src7/plugins/beta/index.ts',
    docFile: '',
    summary: 'beta 登记一个工具。',
  });

  //T gamma：什么都没有，全是空。
  const gamma = map.plugins.find((plugin) => plugin.name === 'gamma');
  expect(gamma).toMatchObject({ events: [], internalEvents: [], entryFile: '', docFile: '', summary: '' });

  //T 倒排照挂上的先后：alpha 先于 beta。
  expect(map.eventIndex['session/before-model']).toEqual(['alpha', 'beta']);
  expect(map.eventIndex['channel/direct']).toEqual(['alpha']);
  expect(map.toolNames).toContain('beta_tool');

  //T 配置里的密钥不出现在图谱里。
  expect(JSON.stringify(map)).not.toContain(SECRET);
});


test('没有源码目录：路径和简介都给空', async () => {
  const ctx = await mountPlugins();

  const map = pluginMapModule.inspectPluginMap(ctx, '', {});

  const alpha = map.plugins.find((plugin) => plugin.name === 'alpha');
  expect(alpha).toMatchObject({ version: '', entryFile: '', docFile: '', summary: '' });
});


test('pickPlugin：命中只留它和它听的事件，不中给 undefined', async () => {
  const ctx = await mountPlugins();
  const map = pluginMapModule.inspectPluginMap(ctx, '', {});

  const one = pluginMapModule.pickPlugin(map, 'beta');
  expect(one?.totalPlugins).toBe(1);
  expect(one?.plugins.map((plugin) => plugin.name)).toEqual(['beta']);
  expect(one?.eventIndex).toEqual({ 'session/before-model': ['alpha', 'beta'] });

  const missing = pluginMapModule.pickPlugin(map, 'nobody');
  expect(missing).toBeUndefined();
});
