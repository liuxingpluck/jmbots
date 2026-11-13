/**
 * 访问令牌与 HTTP 认证的离线测试（docs/界面/05_外部AI任务通道.md 第 3 节）：
 *   访问令牌存取（永久/临时、过期、刷新、删除、hasAny、写盘）、
 *   0.3.5 认证（只有本机不用带；局域网、外网都要带，健康检查与接入说明、网页不用带；/api/tokens 只许本机）、
 *   401 之后不再跑路由（0.3.5 修了 onRequest hook 没有 return reply 的问题）、
 *   listenWithRetry（端口被占等一会儿再试、不是端口被占的错误马上抛）。
 * 临时目录根用 JMBOTS_TEST_TMP，没设就用系统临时目录（Linux 上也能跑）；用完删；内存数据库、假模型假渠道、不调模型。
 * 端口重试用 15000 以上、不带 4 的随机端口，绝不碰正在跑的 30086。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as tokensModule from '../src/capabilities/Tokens.ts';
import * as http from '../src/channels/Http.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import type * as botLoopModule from '../src/bots/BotLoop.ts';
import * as builders from './Builders.ts';


/** 假的机器人循环：只测 HTTP 渠道的监听，不收消息。 */
const NO_BOT_LOOP: Pick<botLoopModule.BotLoop, 'receive' | 'start'> = {
  receive: () => Promise.reject(new Error('本用例不收消息')),
  start: () => () => undefined,
};


/** 临时目录的根：JMBOTS_TEST_TMP 优先，没设就用系统临时目录（Linux 也能跑；Windows 跑测试时照 jmbots-dev 技能设成 F 盘目录）。 */
const TMP_ROOT = process.env.JMBOTS_TEST_TMP ?? os.tmpdir();
/** 测试用的机器人。 */
const BOT = '小测';
/** 本机、局域网、外网三个来源。 */
const LOOPBACK = '127.0.0.1';
/** 局域网。 */
const LAN = '192.168.200.5';
/** 外网。 */
const WAN = '8.8.8.8';
/** 建过的临时目录，收尾删掉。 */
const dirs: string[] = [];
/** 测试进程原本有没有 JMBOTS_TOKEN（收尾恢复，免得影响别的测试）。 */
const savedEnvToken = process.env.JMBOTS_TOKEN;




/**
 * 建一个临时运行时目录。
 * @returns 绝对路径。
 */
function tmpDir(): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  /** 新建的目录。 */
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'jmbots-tokens-'));
  dirs.push(dir);
  return dir;
}


/** 一套测试用的临时运行时和依赖。 */
interface Harness {
  /** 临时运行时目录。 */
  dir: string;
  /** 依赖。 */
  deps: builders.TestDeps;
}


/**
 * 建依赖：最小 config.yaml、真资源和文件库、内存数据库、假模型与渠道（照 Ui_Http.test.ts 的写法）。
 * @param configToken config 的 http.token（当成永久的 legacy 令牌）；空串就是一个令牌都没有。
 * @returns 临时运行时和依赖。
 */
async function setup(configToken = ''): Promise<Harness> {
  //M legacy 只由 config 控制：环境变量有值会让“没有令牌”的用例不成立。
  delete process.env.JMBOTS_TOKEN;
  /** 临时运行时目录。 */
  const dir = tmpDir();
  /** config 里的 token 行。 */
  const tokenLine = configToken ? `  token: ${configToken}\n` : '';
  fs.writeFileSync(path.join(dir, 'config.yaml'), `providers: {}\ndefault_model: magpie/test\nbots:\n  - name: ${BOT}\n    language: zh\nhttp:\n  port: 1\n${tokenLine}`);
  /** 资源。 */
  const resources = await resourcesModule.Resources.load(dir);
  /** 文件库。 */
  const files = new filesModule.Files(resources);
  await files.ensureBot(BOT);
  /** 假模型：这些用例不会调到。 */
  const ai = builders.fakeAi({
    chat: (input) => {
      /** 假回复。 */
      const message = { role: 'assistant', content: [{ type: 'text', text: '收到' }], api: 'openai-completions', provider: 'magpie', model: 'test', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } as piAi.AssistantMessage;
      return Promise.resolve({ message, text: '收到', thinking: '', toolCalls: [], ms: 1, request: { model: input.model, thinkingAsked: 'off', thinking: 'off', system: '', tools: [], messages: [] } });
    },
    decide: () => Promise.reject(new Error('没有')),
    hasDecision: () => false,
    listModels: () => [{ id: 'magpie/test', name: 'test', kind: 'chat', contextWindow: 100_000, thinking: ['off'], vision: true, price: { input: 0, output: 0 } }],
  });
  /** 假渠道。 */
  const out: depsModule.Outlet = {
    send: () => Promise.resolve(),
    sendApproval: () => Promise.resolve([]),
    publishDoc: () => Promise.reject(new Error('无')),
    deleteDoc: () => Promise.reject(new Error('无')),
  };
  return { dir, deps: { resources, files, ai, store: new storeModule.Store(':memory:'), secrets: new secretsModule.Secrets([]), approvals: new approvalsModule.Approvals(), out } };
}


/** 一套测试用的 HTTP 服务和假 receive 记录。 */
interface AppHarness {
  /** 服务（用 inject 发请求，带 remoteAddress 模拟来源）。 */
  app: ReturnType<http.HttpApp['build']>;
  /** 假 receive 记下的输入。 */
  received: unknown[];
}


/**
 * 建 HTTP 服务：假 receive 只记下输入，不进机器人循环（免得校验会话、起模型）。
 * @param deps 依赖。
 * @returns 服务和收到的话。
 */
function appOf(deps: builders.TestDeps): AppHarness {
  /** 收到的话。 */
  const received: unknown[] = [];
  /** 服务。 */
  const app = new http.HttpApp(builders.httpPartsOf(deps, {
    botLoop: {
      receive: (input) => {
        received.push(input);
        return Promise.resolve({ id: 1 } as unknown as storeModule.MessageRow);
      },
      start: () => () => undefined,
    },
  })).build();
  return { app, received };
}


/**
 * 跑一个该抛错的同步操作，把报错文字拿出来；没抛错回空串。
 * @param action 操作。
 * @returns 报错文字。
 */
function throwOf(action: () => unknown): string {
  try {
    action();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : '未知错误';
  }
}


/**
 * 跑一个该抛错的异步操作，把报错文字拿出来；没抛错回空串。
 * @param action 操作。
 * @returns 报错文字。
 */
async function errorOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : '未知错误';
  }
}


/**
 * 随机找一个 15000 以上、不带 4、当前空闲的端口，并用 net 服务占住它。
 * @returns 端口和占着它的服务。
 */
async function occupyPort(): Promise<{ port: number; server: net.Server }> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    /** 候选端口。 */
    const candidate = 15_000 + Math.floor(Math.random() * 45_000);
    if (String(candidate).includes('4')) {
      continue;
    }
    /** 占端口的服务。 */
    const server = net.createServer();
    /** 绑上了没有。 */
    const bound = await new Promise<boolean>((resolve) => {
      /** 绑不上就换一个。 */
      const onError = (): void => {
        server.removeListener('listening', onListening);
        resolve(false);
      };
      /** 绑上了就用它。 */
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: '0.0.0.0', port: candidate });
    });
    if (bound) {
      return { port: candidate, server };
    }
    try {
      server.close();
    } catch {
      //G 没监听成功，不用关。
    }
  }
  throw new Error('找不到空闲端口');
}


bunTest.afterAll(() => {
  if (savedEnvToken === undefined) {
    delete process.env.JMBOTS_TOKEN;
  } else {
    process.env.JMBOTS_TOKEN = savedEnvToken;
  }
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      //G Windows 上偶尔被占着，留在临时目录里，不影响断言。
    }
  }
});


bunTest.describe('Tokens 存取', () => {
  bunTest.test('新建永久的、临时的；名字空、minutes 是 0 或负数报错；list 新的在前', async () => {
    /** 令牌存取。 */
    const store = new tokensModule.TokenStore(tmpDir(), []);
    /** 永久的。 */
    const permanent = store.create('  grokbots  ');
    bunTest.expect(permanent.name).toBe('grokbots');
    bunTest.expect(permanent.value.startsWith('jmb_')).toBe(true);
    bunTest.expect(permanent.minutes).toBeUndefined();
    bunTest.expect(permanent.expiresAt).toBeUndefined();
    await Bun.sleep(2);
    /** 临时 10 分钟的。 */
    const temp = store.create('手机', 10);
    bunTest.expect(temp.minutes).toBe(10);
    bunTest.expect(temp.expiresAt).toBeGreaterThan(temp.createdAt);
    bunTest.expect(store.list().map((item) => item.id)).toEqual([temp.id, permanent.id]);
    bunTest.expect(throwOf(() => store.create('   '))).toMatch(/要写名字/);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      bunTest.expect(throwOf(() => store.create('x', bad))).toMatch(/分钟数要大于 0/);
    }
    bunTest.expect(store.list()).toHaveLength(2);
  });

  bunTest.test('check：legacy 与新建的值通过、空值和错的不通过、用过的记下 usedAt', () => {
    /** 令牌存取（config 的 http.token 当成永久的）。 */
    const store = new tokensModule.TokenStore(tmpDir(), ['tk-legacy', '']);
    bunTest.expect(store.check('tk-legacy')).toBe(true);
    bunTest.expect(store.check('')).toBe(false);
    bunTest.expect(store.check('tk-legacy-x')).toBe(false);
    /** 新建的一个。 */
    const created = store.create('grokbots');
    bunTest.expect(store.check(created.value)).toBe(true);
    bunTest.expect(store.check(`${created.value}x`)).toBe(false);
    /** 最近用过的时间。 */
    const listed = store.list().find((item) => item.id === created.id);
    bunTest.expect(typeof listed?.usedAt).toBe('number');
    bunTest.expect(store.list()).toHaveLength(1);
  });

  bunTest.test('临时过期以后不通过；写的 data/tokens.json 重新打开还在', () => {
    /** 临时运行时。 */
    const dir = tmpDir();
    /** 第一次打开。 */
    const store = new tokensModule.TokenStore(dir, []);
    /** 临时 1 分钟。 */
    const temp = store.create('临时', 1);
    /** 盘上的文件。 */
    const file = path.join(dir, 'data', 'tokens.json');
    bunTest.expect(fs.existsSync(file)).toBe(true);
    /** 重新打开：值还在、还能用。 */
    const reopened = new tokensModule.TokenStore(dir, []);
    bunTest.expect(reopened.list()[0]?.value).toBe(temp.value);
    bunTest.expect(reopened.check(temp.value)).toBe(true);
    /** 改文件把到期时间挪到过去。 */
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as tokensModule.TokenInfo[];
    /** 改那一条。 */
    const row = rows.find((item) => item.id === temp.id);
    bunTest.expect(row).toBeDefined();
    row!.expiresAt = Date.now() - 1_000;
    fs.writeFileSync(file, JSON.stringify(rows), 'utf8');
    /** 再打开：过期的不能用了，也没有任何能用的令牌。 */
    const expired = new tokensModule.TokenStore(dir, []);
    bunTest.expect(expired.check(temp.value)).toBe(false);
    bunTest.expect(expired.hasAny()).toBe(false);
  });

  bunTest.test('刷新以后旧值不通过、新值通过（临时的重新计时）；删除以后不通过；hasAny', async () => {
    /** 没有令牌时 hasAny 是 false。 */
    const store = new tokensModule.TokenStore(tmpDir(), []);
    bunTest.expect(store.hasAny()).toBe(false);
    /** 永久的。 */
    const permanent = store.create('grokbots');
    bunTest.expect(store.hasAny()).toBe(true);
    /** 刷新换值。 */
    const refreshed = store.refresh(permanent.id);
    bunTest.expect(refreshed.value).not.toBe(permanent.value);
    bunTest.expect(store.check(permanent.value)).toBe(false);
    bunTest.expect(store.check(refreshed.value)).toBe(true);
    /** 临时的刷新后从现在重新计时。 */
    const temp = store.create('手机', 1);
    await Bun.sleep(2);
    /** 刷新后的临时。 */
    const tempRefreshed = store.refresh(temp.id);
    bunTest.expect(tempRefreshed.value).not.toBe(temp.value);
    bunTest.expect(tempRefreshed.expiresAt).toBeGreaterThan(temp.expiresAt ?? 0);
    /** 删掉以后不能用。 */
    store.remove(refreshed.id);
    bunTest.expect(store.check(refreshed.value)).toBe(false);
    bunTest.expect(store.hasAny()).toBe(true);
    store.remove(temp.id);
    bunTest.expect(store.check(tempRefreshed.value)).toBe(false);
    bunTest.expect(store.hasAny()).toBe(false);
    bunTest.expect(throwOf(() => store.remove(refreshed.id))).toMatch(/没有令牌/);
    bunTest.expect(throwOf(() => store.refresh('不存在'))).toMatch(/没有令牌/);
  });

  bunTest.test('legacy 有值时 hasAny 是 true（没建过 tokens.json）', () => {
    bunTest.expect(new tokensModule.TokenStore(tmpDir(), []).hasAny()).toBe(false);
    bunTest.expect(new tokensModule.TokenStore(tmpDir(), ['tk-legacy']).hasAny()).toBe(true);
  });
});


bunTest.describe('Http 认证与 /api/tokens', () => {
  bunTest.test('有令牌时：只有本机不用带；局域网、外网不带 401，带对了通过；guide、health、网页不用带', async () => {
    /** 依赖（config 里有一个 legacy 令牌）。 */
    const { deps } = await setup('tk-fake');
    /** 服务。 */
    const { app } = appOf(deps);
    //M 0.3.5：isFree = isLoopback，局域网也要带；只有本机不用带。
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/bots', remoteAddress: WAN })).statusCode).toBe(401);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/bots?token=tk-fake', remoteAddress: WAN })).statusCode).toBe(200);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/bots', remoteAddress: WAN, headers: { authorization: 'Bearer tk-fake' } })).statusCode).toBe(200);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/bots?token=wrong', remoteAddress: WAN })).statusCode).toBe(401);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/bots', remoteAddress: LAN })).statusCode).toBe(401);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/bots?token=tk-fake', remoteAddress: LAN })).statusCode).toBe(200);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/bots', remoteAddress: LAN, headers: { authorization: 'Bearer tk-fake' } })).statusCode).toBe(200);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/bots', remoteAddress: LOOPBACK })).statusCode).toBe(200);
    /** 接入说明：外网不带也能读，内容是 Markdown。 */
    const guide = await app.inject({ method: 'GET', url: '/api/agents/guide', remoteAddress: WAN });
    bunTest.expect(guide.statusCode).toBe(200);
    bunTest.expect(guide.body.length).toBeGreaterThan(0);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/health', remoteAddress: WAN })).statusCode).toBe(200);
    /** 网页本身也不用带（静态资源可能没有，只断言没被认证拦下）。 */
    const page = await app.inject({ method: 'GET', url: '/', remoteAddress: WAN });
    bunTest.expect(page.statusCode).not.toBe(401);
    await app.close();
  });

  bunTest.test('没带对 token 的 POST /api/message 回 401，receive 一次都没被调用；带对了才收到', async () => {
    /** 依赖（config 里有 legacy 令牌）。 */
    const { deps } = await setup('tk-fake');
    /** 服务和假 receive 记录。 */
    const { app, received } = appOf(deps);
    //M 这就是 0.3.5 修的漏洞：401 之后必须 return reply，不能再往下跑路由、把话送进机器人循环。
    const wan = await app.inject({ method: 'POST', url: '/api/message', remoteAddress: WAN, payload: { text: '外网没带' } });
    bunTest.expect(wan.statusCode).toBe(401);
    bunTest.expect(received).toHaveLength(0);
    const wrong = await app.inject({ method: 'POST', url: '/api/message?token=wrong', remoteAddress: WAN, payload: { text: '带错了' } });
    bunTest.expect(wrong.statusCode).toBe(401);
    bunTest.expect(received).toHaveLength(0);
    const lan = await app.inject({ method: 'POST', url: '/api/message', remoteAddress: LAN, payload: { text: '局域网没带' } });
    bunTest.expect(lan.statusCode).toBe(401);
    bunTest.expect(received).toHaveLength(0);
    const ok = await app.inject({ method: 'POST', url: '/api/message?token=tk-fake', remoteAddress: WAN, payload: { text: '带对了' } });
    bunTest.expect(ok.statusCode).toBe(200);
    bunTest.expect(received).toHaveLength(1);
    await app.close();
  });

  bunTest.test('没有任何令牌时外网不带也通过（和原来一样）', async () => {
    /** 依赖（config 没写 token，环境变量也清掉了）。 */
    const { deps } = await setup();
    /** 服务。 */
    const { app } = appOf(deps);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/bots', remoteAddress: WAN })).statusCode).toBe(200);
    /** 列表是空的。 */
    const list = await app.inject({ method: 'GET', url: '/api/tokens', remoteAddress: LOOPBACK });
    bunTest.expect(list.statusCode).toBe(200);
    bunTest.expect(list.json<tokensModule.TokenInfo[]>()).toEqual([]);
    await app.close();
  });

  bunTest.test('/api/tokens：本机能建、能列、能刷新、能删；局域网和外网都不许管', async () => {
    /** 依赖。 */
    const { deps } = await setup();
    /** 服务。 */
    const { app } = appOf(deps);
    /** 建一个永久的。 */
    const created = await app.inject({ method: 'POST', url: '/api/tokens', remoteAddress: LOOPBACK, payload: { name: 'grokbots' } });
    bunTest.expect(created.statusCode).toBe(200);
    /** 建出来的令牌。 */
    const info = created.json<tokensModule.TokenInfo>();
    bunTest.expect(info.name).toBe('grokbots');
    bunTest.expect(info.value.startsWith('jmb_')).toBe(true);
    /** 建一个临时的。 */
    const temp = await app.inject({ method: 'POST', url: '/api/tokens', remoteAddress: LOOPBACK, payload: { name: '手机', minutes: 10 } });
    bunTest.expect(temp.statusCode).toBe(200);
    bunTest.expect(temp.json<tokensModule.TokenInfo>().expiresAt).toBeGreaterThan(Date.now());
    /** 列出来两个。 */
    const listed = await app.inject({ method: 'GET', url: '/api/tokens', remoteAddress: LOOPBACK });
    bunTest.expect(listed.json<tokensModule.TokenInfo[]>()).toHaveLength(2);
    /** 刷新换值。 */
    const refreshed = await app.inject({ method: 'POST', url: `/api/tokens/${info.id}/refresh`, remoteAddress: LOOPBACK });
    bunTest.expect(refreshed.statusCode).toBe(200);
    bunTest.expect(refreshed.json<tokensModule.TokenInfo>().value).not.toBe(info.value);
    /** 删掉。 */
    const removed = await app.inject({ method: 'DELETE', url: `/api/tokens/${info.id}`, remoteAddress: LOOPBACK });
    bunTest.expect(removed.statusCode).toBe(200);
    bunTest.expect(removed.json<{ ok: boolean }>().ok).toBe(true);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/tokens', remoteAddress: LOOPBACK })).json<tokensModule.TokenInfo[]>()).toHaveLength(1);
    /** 局域网：带着对的令牌也 403（只有本机能管）；不带会先被认证拦成 401。 */
    /** 还有效的那个临时令牌（info 已经刷新、删掉了）。 */
    const live = temp.json<tokensModule.TokenInfo>().value;
    bunTest.expect((await app.inject({ method: 'GET', url: `/api/tokens?token=${live}`, remoteAddress: LAN })).statusCode).toBe(403);
    bunTest.expect((await app.inject({ method: 'POST', url: `/api/tokens?token=${live}`, remoteAddress: LAN, payload: { name: 'x' } })).statusCode).toBe(403);
    bunTest.expect((await app.inject({ method: 'POST', url: `/api/tokens/${info.id}/refresh?token=${live}`, remoteAddress: LAN })).statusCode).toBe(403);
    bunTest.expect((await app.inject({ method: 'DELETE', url: `/api/tokens/${info.id}?token=${live}`, remoteAddress: LAN })).statusCode).toBe(403);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/tokens', remoteAddress: LAN })).statusCode).toBe(401);
    /** 外网：不带令牌 401，带着令牌也 403（只有本机能管）。 */
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/tokens', remoteAddress: WAN })).statusCode).toBe(401);
    bunTest.expect((await app.inject({ method: 'GET', url: `/api/tokens?token=${temp.json<tokensModule.TokenInfo>().value}`, remoteAddress: WAN })).statusCode).toBe(403);
    /** 名字空、分钟数负数回 400；删不存在的回 404。 */
    bunTest.expect((await app.inject({ method: 'POST', url: '/api/tokens', remoteAddress: LOOPBACK, payload: { name: '' } })).statusCode).toBe(400);
    bunTest.expect((await app.inject({ method: 'POST', url: '/api/tokens', remoteAddress: LOOPBACK, payload: { name: 'x', minutes: -5 } })).statusCode).toBe(400);
    bunTest.expect((await app.inject({ method: 'DELETE', url: '/api/tokens/不存在', remoteAddress: LOOPBACK })).statusCode).toBe(404);
    await app.close();
  });

  bunTest.test('设置页建的令牌外网能用；刷新后旧值 401、新值 200；删光以后又不查了', async () => {
    /** 依赖（一个令牌都没有）。 */
    const { deps } = await setup();
    /** 服务。 */
    const { app } = appOf(deps);
    /** 本机建一个。 */
    const created = await app.inject({ method: 'POST', url: '/api/tokens', remoteAddress: LOOPBACK, payload: { name: 'grokbots' } });
    /** 令牌值。 */
    const oldValue = created.json<tokensModule.TokenInfo>().value;
    /** 令牌号。 */
    const id = created.json<tokensModule.TokenInfo>().id;
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/bots', remoteAddress: WAN })).statusCode).toBe(401);
    bunTest.expect((await app.inject({ method: 'GET', url: `/api/bots?token=${oldValue}`, remoteAddress: WAN })).statusCode).toBe(200);
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/bots', remoteAddress: WAN, headers: { authorization: `Bearer ${oldValue}` } })).statusCode).toBe(200);
    /** 刷新。 */
    const refreshed = await app.inject({ method: 'POST', url: `/api/tokens/${id}/refresh`, remoteAddress: LOOPBACK });
    /** 新值。 */
    const newValue = refreshed.json<tokensModule.TokenInfo>().value;
    bunTest.expect((await app.inject({ method: 'GET', url: `/api/bots?token=${oldValue}`, remoteAddress: WAN })).statusCode).toBe(401);
    bunTest.expect((await app.inject({ method: 'GET', url: `/api/bots?token=${newValue}`, remoteAddress: WAN })).statusCode).toBe(200);
    /** 删光。 */
    await app.inject({ method: 'DELETE', url: `/api/tokens/${id}`, remoteAddress: LOOPBACK });
    bunTest.expect((await app.inject({ method: 'GET', url: '/api/bots', remoteAddress: WAN })).statusCode).toBe(200);
    await app.close();
  });
});


bunTest.describe('listenWithRetry', () => {
  bunTest.test('端口被占：2.5 秒后放开，HTTP 渠道等一会儿再试就能起来', async () => {
    /** 占着一个随机端口的服务。 */
    const { port, server } = await occupyPort();
    bunTest.expect(port).toBeGreaterThan(15_000);
    bunTest.expect(String(port).includes('4')).toBe(false);
    /** 依赖。 */
    const { deps } = await setup();
    /** 渠道。 */
    const channel = new http.HttpChannel(builders.httpPartsOf(deps, { botLoop: NO_BOT_LOOP }), port);
    /** 收下重试日志。 */
    const logSpy = bunTest.spyOn(console, 'error').mockImplementation(() => {});
    /** 放开端口的定时器。 */
    const timer = setTimeout(() => {
      server.close();
    }, 2_500);
    /** 关服务用的函数。 */
    let stop: (() => Promise<void>) | undefined;
    /** 开始时间。 */
    const startedAt = Date.now();
    try {
      stop = await channel.start();
      /** 至少等过一轮 2 秒的重试。 */
      bunTest.expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
      bunTest.expect(logSpy.mock.calls.length).toBeGreaterThan(0);
      /** 真的能接请求。 */
      const health = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
      bunTest.expect(health.status).toBe(200);
      bunTest.expect(await health.text()).toContain('ok');
    } finally {
      clearTimeout(timer);
      try {
        server.close();
      } catch {
        //G 已经关过了。
      }
      if (stop) {
        await stop();
      }
      logSpy.mockRestore();
    }
  }, 30_000);

  bunTest.test('不是端口被占的错误马上抛，不等 2 秒重试', async () => {
    //M Bun 对非法端口一律当成随机端口监听成功，造不出别真错误；用 valueOf 抛错的对象让 app.listen 抛普通 Error。
    /** 一转成数字就抛错的“端口”。 */
    const badPort = { valueOf: (): never => { throw new Error('坏端口：不是端口被占'); } } as unknown as number;
    /** 依赖。 */
    const { deps } = await setup();
    /** 渠道。 */
    const channel = new http.HttpChannel(builders.httpPartsOf(deps, { botLoop: NO_BOT_LOOP }), badPort);
    /** 开始时间。 */
    const startedAt = Date.now();
    /** 报错文字。 */
    const message = await errorOf(() => channel.start());
    bunTest.expect(message).toContain('坏端口');
    bunTest.expect(Date.now() - startedAt).toBeLessThan(1_500);
  }, 10_000);
});
