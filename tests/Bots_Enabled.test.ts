/**
 * 显式启用名单的离线回归：空名单/缺名单不读历史目录启用机器人，
 * HTTP 仍可用，停用渠道不换绑，历史复盘不会替停用机器人调用模型。
 * 只使用临时运行时、内存数据库和假模型，不读真实配置、不连外部渠道。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as channelModule from '../src/channels/Channel.ts';
import * as http from '../src/channels/Http.ts';
import * as channelsIndex from '../src/channels/index.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import * as builders from './Builders.ts';


/**
 * 创建临时运行时；历史目录里的资料不代表启用。
 * @param config 临时配置；undefined 表示首次启动，不预写配置。
 * @returns 目录和已加载资源。
 */
async function runtimeOf(config?: Record<string, unknown>) {
  /** 测试目录集中放到 F 盘；可由测试环境指定。 */
  const base = process.env.JMBOTS_TEST_TMP ?? 'F:/aidata/cache/jmbots-tests';
  fs.mkdirSync(base, { recursive: true });
  /** 本例的唯一目录。 */
  const dir = fs.mkdtempSync(path.join(base, 'enabled-'));
  fs.mkdirSync(path.join(dir, 'bots', '旧机器人'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bots', '旧机器人', '历史.md'), '历史内容');
  if (config) {
    fs.writeFileSync(path.join(dir, 'config.yaml'), JSON.stringify(config));
  }
  return { dir, resources: await resourcesModule.Resources.load(dir) };
}


/**
 * 从临时资源搭最小 HTTP/渠道依赖；调用模型会明确失败。
 * @param resources 临时资源。
 * @returns 最小依赖。
 */
function depsOf(resources: resourcesModule.Resources): builders.TestDeps {
  return {
    resources,
    store: new storeModule.Store(':memory:'),
    files: new filesModule.Files(resources),
    secrets: new secretsModule.Secrets([]),
    approvals: new approvalsModule.Approvals(),
    ai: builders.fakeAi({
      chat: () => Promise.reject(new Error('启用名单测试不能调模型')),
      decide: () => Promise.reject(new Error('启用名单测试不能调模型')),
      hasDecision: () => false,
      listModels: () => [],
    }),
    out: {
      send: () => Promise.resolve(),
      sendApproval: () => Promise.resolve([]),
      publishDoc: () => Promise.reject(new Error('不能发文档')),
      deleteDoc: () => Promise.reject(new Error('不能删文档')),
    },
  };
}


bunTest.test('空名单、缺名单和 null 都不隐式启用历史目录或助手', async () => {
  for (const config of [{ bots: [] }, {}, { bots: null }]) {
    /** 本次临时运行时。 */
    const { dir, resources } = await runtimeOf(config);
    try {
      bunTest.expect(resources.listBots()).toEqual([]);
      bunTest.expect(resources.problems().join('\n')).toContain('bots 没有启用机器人');
      bunTest.expect(() => resources.getBot('旧机器人')).toThrow('未启用');
      bunTest.expect(fs.readFileSync(path.join(dir, 'bots', '旧机器人', '历史.md'), 'utf8')).toBe('历史内容');
      /** 补默认设置不能偷偷补 bots。 */
      const saved = Bun.YAML.parse(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')) as Record<string, unknown>;
      bunTest.expect(saved.bots).toEqual('bots' in config ? config.bots : undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});


bunTest.test('首次模板显式启用助手，已有历史目录不加入名单', async () => {
  /** 没有配置文件时生成模板。 */
  const { dir, resources } = await runtimeOf();
  try {
    bunTest.expect(resources.listBots()).toEqual([{ name: '助手', language: 'zh' }]);
    bunTest.expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toContain('- name: 助手');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test('停用渠道明确拒绝，其他启用机器人不会被自动换绑', async () => {
  /** 停用渠道与原有启用名单。 */
  const { dir, resources } = await runtimeOf({ bots: [{ name: '启用者' }], channels: { feishu: [{ bot: '旧机器人' }] } });
  try {
    bunTest.expect(resources.listChannels()[0]?.settings.bot).toBe('旧机器人');
    bunTest.expect(resources.problems().join('\n')).toContain('旧机器人 未启用');
    bunTest.expect(() => channelModule.buildChannel('feishu', { bot: '旧机器人' }, depsOf(resources))).toThrow('未启用');
    bunTest.expect(channelModule.buildChannels(depsOf(resources))).toEqual([]);
    bunTest.expect(resources.listBots()).toEqual([{ name: '启用者', language: 'zh' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test('空名单和缺默认目标的渠道不挡 HTTP，读取为空，收话返回清楚错误', async () => {
  /** 空名单还留着一个旧渠道配置。 */
  const { dir, resources } = await runtimeOf({ bots: [], channels: { feishu: { enabled: true } } });
  /** 假依赖和不监听端口的 HTTP 应用。 */
  const deps = depsOf(resources);
  const app = new http.HttpApp(builders.httpPartsOf(deps)).build();
  /** 用随机空端口核对 ChannelHub 真正能启动 HTTP。 */
  const hub = new channelsIndex.ChannelHub({ port: 0, candidate: false });
  try {
    await hub.start({ http: builders.httpPartsOf(deps), channels: deps });
    bunTest.expect((await app.inject('/api/bots')).json<unknown[]>()).toEqual([]);
    bunTest.expect((await app.inject('/api/sessions')).json<unknown[]>()).toEqual([]);
    bunTest.expect((await app.inject('/api/ui/sessions')).json<unknown[]>()).toEqual([]);
    bunTest.expect((await app.inject('/api/messages')).json<{ messages: unknown[] }>().messages).toEqual([]);
    bunTest.expect((await app.inject('/api/health')).statusCode).toBe(200);
    /** 无默认机器人不能访问不存在的 name，也不能悄悄创建助手。 */
    const missing = await app.inject({ method: 'POST', url: '/api/message', payload: { text: '不能投递' } });
    bunTest.expect(missing.statusCode).toBe(400);
    bunTest.expect(missing.json<{ error: string }>().error).toContain('尚未启用机器人');
    /** 显式指定停用机器人同样拒绝。 */
    const disabled = await app.inject({ method: 'POST', url: '/api/message', payload: { bot: '旧机器人', text: '不能投递' } });
    bunTest.expect(disabled.statusCode).toBe(400);
    bunTest.expect(disabled.json<{ error: string }>().error).toContain('未启用');
    bunTest.expect(resources.listBots()).toEqual([]);
  } finally {
    await hub.stop();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test('停用机器人的历史超时登记保留，不再调用模型复盘或发卡片', async () => {
  /** 空启用名单及历史复盘记录。 */
  const { dir, resources } = await runtimeOf({ bots: [] });
  /** 依赖。 */
  const deps = depsOf(resources);
  /** 历史登记文件。 */
  const file = path.join(dir, 'data', 'overtime.jsonl');
  const text = `${JSON.stringify({ bot: '旧机器人', text: '旧任务', stage: 'done', usedMs: 100, timings: {} })}\n`;
  fs.writeFileSync(file, text);
  try {
    await builders.runReviewOf(deps).check();
    bunTest.expect(deps.approvals.list()).toEqual([]);
    bunTest.expect(fs.readFileSync(file, 'utf8')).toBe(text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
