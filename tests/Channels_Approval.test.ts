/**
 * 渠道发审核卡片（src/channels/index.ts 的 out.sendApproval）的离线测试：
 * 两个能发卡片的渠道都发（消息来的渠道用回复地址，别的用空地址）、一个抛错不挡另一个、onlyHere 只发一个、HTTP 没有 sendApproval 也不报错。
 * 用 registerChannel 注册假渠道 + 临时运行时 config 的 channels 配置，真的 ChannelHub.start（HTTP 监听 0 端口）；每个用例最后都 stop。
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
import * as channelsIndex from '../src/channels/index.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import * as builders from './Builders.ts';


/** 一个假渠道收到的一次发卡片调用。 */
interface SentCard {
  /** 渠道名。 */
  channel: string;
  /** 地址。 */
  address: Record<string, unknown>;
  /** 待确认。 */
  pending: approvalsModule.PendingApproval;
}

/** 一个假渠道的定义。 */
interface FakeSpec {
  /** 用例里用的短名，用来取真的渠道名。 */
  key: string;
  /** 发卡片时抛错。 */
  fail?: boolean;
}

/** 注册假渠道的结果。 */
interface FakeSetup {
  /** 写进临时 config 的 channels 配置。 */
  config: Record<string, unknown>;
  /** 短名 → 渠道名。 */
  names: Record<string, string>;
  /** 收到的发卡片调用。 */
  sent: SentCard[];
}

/** 下一个假渠道的编号（registerChannel 同名只能登记一次）。 */
let nextFake = 0;


/**
 * 注册一组能发卡片的假渠道。
 * @param specs 假渠道的定义。
 * @returns config 里的 channels 配置、短名到渠道名的映射、收到的调用。
 * 副作用：写渠道登记表。
 */
function registerFakes(specs: FakeSpec[]): FakeSetup {
  /** 收到的调用。 */
  const sent: SentCard[] = [];
  /** channels 配置。 */
  const config: Record<string, unknown> = {};
  /** 短名 → 渠道名。 */
  const names: Record<string, string> = {};
  for (const spec of specs) {
    nextFake += 1;
    /** 渠道名，也是 config 里的键。 */
    const name = `fake_${nextFake}`;
    /** 这个渠道发卡片要不要抛错。 */
    const fail = spec.fail === true;
    channelModule.registerChannel(name, () => ({
      name,
      bot: '周小灵',
      start: () => Promise.resolve(() => Promise.resolve()),
      send: () => Promise.resolve(),
      sendApproval: (address, pending) => {
        sent.push({ channel: name, address, pending });
        return fail ? Promise.reject(new Error('卡片没发出去')) : Promise.resolve(true);
      },
    }));
    config[name] = [{ bot: '周小灵' }];
    names[spec.key] = name;
  }
  return { config, names, sent };
}


/**
 * 建一套依赖：临时运行时目录、内存数据库、不调模型的假模型库、空的 out。
 * @param channels 写进 config.yaml 的 channels 配置（不含 HTTP）。
 * @returns 依赖。
 */
async function setup(channels: Record<string, unknown>): Promise<builders.TestDeps> {
  /** 临时运行时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-channels-'));
  /** 临时 config：JSON 也是合法的 YAML。 */
  const config = { providers: {}, default_model: 'magpie/test', bots: [{ name: '周小灵', language: 'zh' }], channels };
  fs.writeFileSync(path.join(dir, 'config.yaml'), `${JSON.stringify(config, null, 2)}\n`);
  /** 资源。 */
  const resources = await resourcesModule.Resources.load(dir);
  /** 文件库。 */
  const files = new filesModule.Files(resources);
  await files.ensureBot('周小灵');
  /** 假模型库：这个测试不调模型。 */
  const ai = builders.fakeAi({
    chat: () => Promise.reject(new Error('这个测试不调常规模型')),
    decide: () => Promise.reject(new Error('这个测试不调决策模型')),
    hasDecision: () => false,
    listModels: () => [],
  });
  /** 空的 out：ChannelHub 自己就是 out。 */
  const out: depsModule.Outlet = {
    send: () => Promise.resolve(),
    sendApproval: () => Promise.resolve([]),
    publishDoc: () => Promise.reject(new Error('这个测试不发云文档')),
    deleteDoc: () => Promise.reject(new Error('这个测试不删云文档')),
  };
  return { resources, files, ai, store: new storeModule.Store(':memory:'), secrets: new secretsModule.Secrets([]), approvals: new approvalsModule.Approvals(), out };
}


/**
 * 一条待确认。
 * @param id 号。
 */
function pendingApproval(id = 7): approvalsModule.PendingApproval {
  return { id, bot: '周小灵', sessionId: 'session-1', command: 'echo hi', workDir: 'C:\\work', review: { what: '打印一句话', risk: '无', advice: '同意' }, createdAt: Date.now() };
}


bunTest.describe('channels/index.ts 的 out.sendApproval', () => {
  bunTest.test('两个能发卡片的渠道都发；一个抛错不挡另一个', async () => {
    /** 假渠道（a、b 能发，c 抛错）。 */
    const fakes = registerFakes([{ key: 'a' }, { key: 'b' }, { key: 'c', fail: true }]);
    /** 依赖。 */
    const deps = await setup(fakes.config);
    /** 开着的渠道。 */
    const hub = new channelsIndex.ChannelHub({ port: 0, candidate: false });
    await hub.start({ http: builders.httpPartsOf(deps), channels: deps });
    /** console.error 收到的。 */
    const errors: unknown[][] = [];
    /** 原来的 console.error。 */
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      /** 待确认。 */
      const pending = pendingApproval();
      /** 发到了哪些渠道。 */
      const sentTo = await hub.sendApproval('http', {}, pending);
      bunTest.expect(sentTo).toEqual([fakes.names.a!, fakes.names.b!]);
      bunTest.expect(fakes.sent.map((item) => item.channel)).toEqual([fakes.names.a!, fakes.names.b!, fakes.names.c!]);
      bunTest.expect(fakes.sent.map((item) => item.address)).toEqual([{}, {}, {}]);
      bunTest.expect(fakes.sent.every((item) => item.pending === pending)).toBe(true);
      bunTest.expect(errors).toHaveLength(1);
      bunTest.expect(String(errors[0]![0])).toContain('审核卡片没发出去');
    } finally {
      console.error = originalError;
      await hub.stop();
    }
  });

  bunTest.test('消息来的渠道用回复地址，别的用空地址；onlyHere 只发一个', async () => {
    /** 假渠道（两个都能发）。 */
    const fakes = registerFakes([{ key: 'a' }, { key: 'b' }]);
    /** 依赖。 */
    const deps = await setup(fakes.config);
    /** 开着的渠道。 */
    const hub = new channelsIndex.ChannelHub({ port: 0, candidate: false });
    await hub.start({ http: builders.httpPartsOf(deps), channels: deps });
    try {
      /** 待确认。 */
      const pending = pendingApproval();
      /** 回复地址。 */
      const address = { chat_id: 'oc_1' };
      bunTest.expect(await hub.sendApproval(fakes.names.a!, address, pending)).toEqual([fakes.names.a!, fakes.names.b!]);
      bunTest.expect(fakes.sent).toHaveLength(2);
      bunTest.expect(fakes.sent[0]).toEqual({ channel: fakes.names.a!, address, pending });
      bunTest.expect(fakes.sent[1]!.address).toEqual({});
      fakes.sent.length = 0;
      bunTest.expect(await hub.sendApproval(fakes.names.a!, address, pending, true)).toEqual([fakes.names.a!]);
      bunTest.expect(fakes.sent).toHaveLength(1);
      bunTest.expect(fakes.sent[0]).toEqual({ channel: fakes.names.a!, address, pending });
    } finally {
      await hub.stop();
    }
  });

  bunTest.test('只有 HTTP：没有 sendApproval 也不报错，返回空数组', async () => {
    /** 依赖（config 里没有别的渠道）。 */
    const deps = await setup({});
    /** 开着的渠道。 */
    const hub = new channelsIndex.ChannelHub({ port: 0, candidate: false });
    await hub.start({ http: builders.httpPartsOf(deps), channels: deps });
    try {
      bunTest.expect(await hub.sendApproval('http', {}, pendingApproval())).toEqual([]);
    } finally {
      await hub.stop();
    }
  });
});
