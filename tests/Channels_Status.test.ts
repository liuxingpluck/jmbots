/**
 * 渠道状态（src/channels/Feishu.ts、src/channels/index.ts、src/channels/HttpUi.ts）的离线测试（docs/界面/任务书/发0.2.10_DSH.md 第 1 步）：
 * 飞书 status() 没启动是“还没连”，start 成功后真，长连接状态回调后跟着变；
 * channelStatus() 只列有 status 的渠道；GET /api/ui/status 回 { channels: [...] }。
 * 全部用假 transport、假渠道和临时运行时，不连真飞书、不读真实配置。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as channelModule from '../src/channels/Channel.ts';
import * as feishuModule from '../src/channels/Feishu.ts';
import * as http from '../src/channels/Http.ts';
import * as channelsIndex from '../src/channels/index.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import * as builders from './Builders.ts';


/** 测试用的机器人名。 */
const BOT = '小测';


/**
 * 建一套最小依赖：临时运行时、一个机器人、内存数据库、不调模型的假模型库和空渠道。
 * @param channels 写进 config.yaml 的 channels 配置。
 * @returns 依赖。
 */
async function setup(channels: Record<string, unknown> = {}): Promise<builders.TestDeps> {
  /** 临时运行时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-status-'));
  /** 临时 config（JSON 也是 YAML）。 */
  const config = { providers: {}, default_model: 'fake/test', bots: [{ name: BOT, language: 'zh' }], channels };
  fs.writeFileSync(path.join(dir, 'config.yaml'), `${JSON.stringify(config, null, 2)}\n`);
  /** 资源。 */
  const resources = await resourcesModule.Resources.load(dir);
  /** 文件库。 */
  const files = new filesModule.Files(resources);
  await files.ensureBot(BOT);
  /** 假模型库：这个测试不调模型。 */
  const ai = builders.fakeAi({
    chat: () => Promise.reject(new Error('状态测试不调模型')),
    decide: () => Promise.reject(new Error('状态测试不调模型')),
    hasDecision: () => false,
    listModels: () => [],
  });
  /** 空渠道：ChannelHub 自己就是 out。 */
  const out: depsModule.Outlet = {
    send: () => Promise.resolve(),
    sendApproval: () => Promise.resolve([]),
    publishDoc: () => Promise.reject(new Error('状态测试不发文档')),
    deleteDoc: () => Promise.reject(new Error('状态测试不删文档')),
  };
  return { resources, files, ai, store: new storeModule.Store(':memory:'), secrets: new secretsModule.Secrets([]), approvals: new approvalsModule.Approvals(), out };
}


/** 下一个假渠道的编号（registerChannel 同名只能登记一次）。 */
let nextFake = 0;


/**
 * 注册两个假渠道：一个有 status，一个没有；用来核对 channelStatus() 只列有 status 的。
 * @returns 写进 config 的 channels 和两个渠道名。
 */
function registerStatusFakes(): { config: Record<string, unknown>; withStatus: string; withoutStatus: string } {
  nextFake += 1;
  /** 有 status 的渠道名。 */
  const withStatus = `status_fake_${nextFake}_yes`;
  /** 没 status 的渠道名。 */
  const withoutStatus = `status_fake_${nextFake}_no`;
  channelModule.registerChannel(withStatus, () => ({
    name: withStatus,
    bot: BOT,
    start: () => Promise.resolve(() => Promise.resolve()),
    send: () => Promise.resolve(),
    status: () => ({ connected: true, detail: '已连上（测试）' }),
  }));
  channelModule.registerChannel(withoutStatus, () => ({
    name: withoutStatus,
    bot: BOT,
    start: () => Promise.resolve(() => Promise.resolve()),
    send: () => Promise.resolve(),
  }));
  return { config: { [withStatus]: [{ bot: BOT }], [withoutStatus]: [{ bot: BOT }] }, withStatus, withoutStatus };
}


bunTest.describe('飞书 status()', () => {
  bunTest.test('没启动是“还没连”且 connected 假；start 成功后真；断线重连中假，已重连真', async () => {
    /** 依赖。 */
    const deps = await setup();
    /** 长连接状态回调。 */
    let onConnection: ((state: string, detail?: string) => void) | undefined;
    /** 假 transport。 */
    const transport: feishuModule.FeishuTransport = {
      listen: (_onEvent, _onCardAction, callback) => {
        onConnection = callback;
        return Promise.resolve();
      },
      sendText: () => Promise.resolve('msg-1'),
      close: () => undefined,
    };
    /** 飞书渠道。 */
    const channel = feishuModule.createFeishuChannel({ app_id: 'cli_test', app_secret: 'secret_xxxxxxxx', bot: BOT }, deps, transport);
    //M 没启动。
    bunTest.expect(channel.status().connected).toBe(false);
    bunTest.expect(channel.status().detail).toContain('还没连');
    //M start 成功。
    /** 停下的函数。 */
    const stop = await channel.start(() => Promise.resolve({}));
    bunTest.expect(channel.status().connected).toBe(true);
    bunTest.expect(channel.status().detail).toContain('已连上');
    bunTest.expect(onConnection).toBeDefined();
    //M 长连接回调：断线重连中变假，已重连变真。
    onConnection!('断线重连中');
    bunTest.expect(channel.status().connected).toBe(false);
    bunTest.expect(channel.status().detail).toContain('断线重连中');
    onConnection!('已重连');
    bunTest.expect(channel.status().connected).toBe(true);
    bunTest.expect(channel.status().detail).toContain('已重连');
    await stop();
  });
});


bunTest.describe('渠道状态列表', () => {
  bunTest.test('channelStatus() 只列有 status 的渠道', async () => {
    /** 两个假渠道。 */
    const fakes = registerStatusFakes();
    /** 依赖。 */
    const deps = await setup(fakes.config);
    /** 开着的渠道。 */
    const hub = new channelsIndex.ChannelHub({ port: 0, candidate: false });
    await hub.start({ http: builders.httpPartsOf(deps), channels: deps });
    try {
      /** 状态列表。 */
      const statuses = hub.channelStatus?.() ?? [];
      bunTest.expect(statuses).toEqual([{ name: fakes.withStatus, bot: BOT, connected: true, detail: '已连上（测试）' }]);
    } finally {
      await hub.stop();
    }
  });

  bunTest.test('GET /api/ui/status 回 { channels: [...] }', async () => {
    /** 依赖。 */
    const deps = await setup();
    /** 假的状态来源。 */
    deps.out.channelStatus = () => [
      { name: 'http', connected: true, detail: '一直在' },
      { name: 'feishu:cli_test', bot: BOT, connected: false, detail: '断线重连中（测试）' },
    ];
    /** 网页服务。 */
    const app = new http.HttpApp(builders.httpPartsOf(deps)).build();
    try {
      /** 回答。 */
      const response = await app.inject({ method: 'GET', url: '/api/ui/status' });
      bunTest.expect(response.statusCode).toBe(200);
      bunTest.expect(response.json<{ channels: { name: string; bot?: string; connected: boolean; detail: string }[] }>()).toEqual({
        channels: [
          { name: 'http', connected: true, detail: '一直在' },
          { name: 'feishu:cli_test', bot: BOT, connected: false, detail: '断线重连中（测试）' },
        ],
      });
    } finally {
      await app.close();
    }
  });
});
