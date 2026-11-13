/**
 * 0.3.3 的离线测试：外部 AI 任务通道（AgentTasks 文件通道、/api/agents/* 接口、agent_task 工具）
 * 和自带工具库（toolDirs、exec 只在子进程里排 PATH），见 docs/界面/05_外部AI任务通道.md。
 * 临时目录根用 JMBOTS_TEST_TMP，没设就用系统临时目录（Linux 上也能跑）；用完删掉；内存数据库、假模型假渠道，不联网、不调模型、不起服务。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as botLoopModule from '../src/bots/BotLoop.ts';
import * as agentTasks from '../src/capabilities/AgentTasks.ts';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as toolsModule from '../src/capabilities/tools/Tools.ts';
import * as builders from './Builders.ts';
import * as http from '../src/channels/Http.ts';
import * as resourcesModule from '../src/resources/Resources.ts';


/** 临时目录的根：JMBOTS_TEST_TMP 优先，没设就用系统临时目录（Linux 也能跑；Windows 跑测试时照 jmbots-dev 技能设成 F 盘目录）。 */
const TMP_ROOT = process.env.JMBOTS_TEST_TMP ?? os.tmpdir();
/** 测试用的机器人。 */
const BOT = '小测';
/** 建过的临时目录，收尾删掉。 */
const dirs: string[] = [];


/**
 * 建一个临时运行时目录。
 * @returns 绝对路径。
 */
function tmpDir(): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  /** 新建的目录。 */
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'jmbots-agent-'));
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
 * @returns 临时运行时和依赖。
 */
async function setup(): Promise<Harness> {
  /** 临时运行时目录。 */
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.yaml'), `providers: {}\ndefault_model: magpie/test\nbots:\n  - name: ${BOT}\n    language: zh\nhttp:\n  port: 1\n  token: tk-fake\n`);
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


/** HTTP 测试用的一套东西。 */
interface AppHarness extends Harness {
  /** HTTP 服务（不监听端口，用 inject 发请求）。 */
  app: ReturnType<http.HttpApp['build']>;
  /** 假 receive 记下的输入。 */
  received: botLoopModule.IncomingInput[];
}


/**
 * 建 HTTP 服务：假 receive 只记下输入，不进机器人循环（免得校验会话、起模型）。
 * @returns 服务、依赖、收到的输入。
 */
async function setupApp(): Promise<AppHarness> {
  /** 基础依赖。 */
  const base = await setup();
  /** 收到的话。 */
  const received: botLoopModule.IncomingInput[] = [];
  /** 服务。 */
  const app = new http.HttpApp(builders.httpPartsOf(base.deps, {
    botLoop: {
      receive: (input) => {
        received.push(input);
        return Promise.resolve({ id: 1 } as unknown as storeModule.MessageRow);
      },
      start: () => () => undefined,
    },
  })).build();
  return { ...base, app, received };
}


/**
 * 跑一次工具。
 * @param harness 依赖。
 * @param name 工具名。
 * @param args 参数。
 * @param options 覆盖执行环境（只读模式、会话号）。
 * @returns 工具结果。
 */
function runTool(harness: Harness, name: string, args: Record<string, unknown>, options: { readOnly?: boolean; sessionId?: string } = {}): Promise<toolsModule.ToolResult> {
  /** 工具执行环境。 */
  const context: toolsModule.ToolContext = { bot: BOT, workDir: harness.dir, readOnly: options.readOnly ?? false, vision: false, ...(options.sessionId ? { sessionId: options.sessionId } : {}) };
  return builders.toolBoxOf(harness.deps).run(name, args, context);
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


bunTest.afterAll(() => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      //G Windows 上偶尔被占着，留在临时目录里，不影响断言。
    }
  }
});


bunTest.describe('AgentTasks 文件通道', () => {
  bunTest.test('没打招呼不能派活；名字带 ../ 报错', async () => {
    /** 临时运行时。 */
    const dir = tmpDir();
    bunTest.expect(await errorOf(() => new agentTasks.AgentTaskChannel(dir).createTask({ agent: 'grokbots', bot: BOT, title: '生图', text: '要 PNG', files: [] }))).toMatch(/还没来打过招呼/);
    bunTest.expect(await errorOf(() => new agentTasks.AgentTaskChannel(dir).hello('../evil', '坏名字'))).toMatch(/名字只能/);
    bunTest.expect(await errorOf(() => new agentTasks.AgentTaskChannel(dir).createTask({ agent: '../evil', bot: BOT, title: 'x', text: 'y', files: [] }))).toMatch(/名字只能/);
  });

  bunTest.test('派活会把附件复制进任务文件夹', async () => {
    /** 临时运行时。 */
    const dir = tmpDir();
    await new agentTasks.AgentTaskChannel(dir).hello('grokbots', '会生图');
    /** 附件原文件。 */
    const src = path.join(dir, '素材.txt');
    fs.writeFileSync(src, '附件内容');
    /** 派出去的任务。 */
    const task = await new agentTasks.AgentTaskChannel(dir).createTask({ agent: 'grokbots', bot: BOT, sessionId: '20261106133000000001', title: '生一张图', text: '要 PNG', files: [src] });
    bunTest.expect(task.files).toEqual(['素材.txt']);
    bunTest.expect(task.status).toBe('new');
    /** 复制进去的附件。 */
    const copied = path.join(dir, 'integrations', 'agents', 'grokbots', 'tasks', task.id, '素材.txt');
    bunTest.expect(fs.readFileSync(copied, 'utf8')).toBe('附件内容');
    bunTest.expect((await new agentTasks.AgentTaskChannel(dir).getTask('grokbots', task.id))?.sessionId).toBe('20261106133000000001');
  });

  bunTest.test('外部 AI 来列（touch）会更新 seen', async () => {
    /** 临时运行时。 */
    const dir = tmpDir();
    /** 登记。 */
    const info = await new agentTasks.AgentTaskChannel(dir).hello('grokbots', '会生图');
    bunTest.expect(info.seen).toBe(0);
    await Bun.sleep(5);
    await new agentTasks.AgentTaskChannel(dir).listTasks('grokbots', undefined, true);
    /** 再看登记。 */
    const agents = await new agentTasks.AgentTaskChannel(dir).listAgents();
    bunTest.expect(agents).toHaveLength(1);
    bunTest.expect(agents[0]!.seen).toBeGreaterThan(0);
    bunTest.expect(agents[0]!.description).toBe('会生图');
  });

  bunTest.test('认领两次第二次报“已经”', async () => {
    /** 临时运行时。 */
    const dir = tmpDir();
    await new agentTasks.AgentTaskChannel(dir).hello('grokbots', '会生图');
    /** 任务。 */
    const task = await new agentTasks.AgentTaskChannel(dir).createTask({ agent: 'grokbots', bot: BOT, title: '生图', text: '要 PNG', files: [] });
    /** 第一次认领。 */
    const taken = await new agentTasks.AgentTaskChannel(dir).takeTask('grokbots', task.id);
    bunTest.expect(taken.status).toBe('taken');
    bunTest.expect(taken.takenAt).toBeGreaterThan(0);
    bunTest.expect(await errorOf(() => new agentTasks.AgentTaskChannel(dir).takeTask('grokbots', task.id))).toMatch(/已经/);
  });

  bunTest.test('交回：文件名去掉 ../、存进 result/、状态 done；交过再交报错', async () => {
    /** 临时运行时。 */
    const dir = tmpDir();
    await new agentTasks.AgentTaskChannel(dir).hello('grokbots', '会生图');
    /** 任务。 */
    const task = await new agentTasks.AgentTaskChannel(dir).createTask({ agent: 'grokbots', bot: BOT, title: '生图', text: '要 PNG', files: [] });
    /** 交回后的任务。 */
    const done = await new agentTasks.AgentTaskChannel(dir).finishTask('grokbots', task.id, { ok: true, text: '做好了', files: [{ name: '../../交回.txt', data: Buffer.from('结果内容') }] });
    bunTest.expect(done.status).toBe('done');
    bunTest.expect(done.result).toEqual({ text: '做好了', files: ['交回.txt'] });
    bunTest.expect(fs.readFileSync(path.join(dir, 'integrations', 'agents', 'grokbots', 'tasks', task.id, 'result', '交回.txt'), 'utf8')).toBe('结果内容');
    //M ../ 被去掉，没写到任务文件夹外面去。
    bunTest.expect(fs.existsSync(path.join(dir, 'integrations', 'agents', '交回.txt'))).toBe(false);
    bunTest.expect(await errorOf(() => new agentTasks.AgentTaskChannel(dir).finishTask('grokbots', task.id, { ok: true, text: '再交一次', files: [] }))).toMatch(/已经交过/);
  });

  bunTest.test('交回 ok:false 状态变 failed', async () => {
    /** 临时运行时。 */
    const dir = tmpDir();
    await new agentTasks.AgentTaskChannel(dir).hello('grokbots', '会生图');
    /** 任务。 */
    const task = await new agentTasks.AgentTaskChannel(dir).createTask({ agent: 'grokbots', bot: BOT, title: '生图', text: '要 PNG', files: [] });
    /** 交回后的任务。 */
    const failed = await new agentTasks.AgentTaskChannel(dir).finishTask('grokbots', task.id, { ok: false, text: '没做成', files: [] });
    bunTest.expect(failed.status).toBe('failed');
    bunTest.expect(failed.result?.text).toBe('没做成');
  });

  bunTest.test('taskFile 读 task.json 和越界都报错', async () => {
    /** 临时运行时。 */
    const dir = tmpDir();
    await new agentTasks.AgentTaskChannel(dir).hello('grokbots', '会生图');
    /** 附件原文件。 */
    const src = path.join(dir, 'a.txt');
    fs.writeFileSync(src, 'x');
    /** 任务。 */
    const task = await new agentTasks.AgentTaskChannel(dir).createTask({ agent: 'grokbots', bot: BOT, title: '生图', text: '要 PNG', files: [src] });
    bunTest.expect(throwOf(() => new agentTasks.AgentTaskChannel(dir).taskFile('grokbots', task.id, 'task.json'))).toMatch(/不能拿/);
    bunTest.expect(throwOf(() => new agentTasks.AgentTaskChannel(dir).taskFile('grokbots', task.id, '../agent.json'))).toMatch(/不能拿/);
    bunTest.expect(throwOf(() => new agentTasks.AgentTaskChannel(dir).taskFile('grokbots', task.id, 'result/../../agent.json'))).toMatch(/不能拿/);
    bunTest.expect(new agentTasks.AgentTaskChannel(dir).taskFile('grokbots', task.id, 'a.txt')).toBe(path.join(dir, 'integrations', 'agents', 'grokbots', 'tasks', task.id, 'a.txt'));
  });
});


bunTest.describe('/api/agents/* 接口', () => {
  bunTest.test('GET /api/agents/guide 回 Markdown；hello 后 GET /api/agents 有它', async () => {
    /** HTTP 服务。 */
    const h = await setupApp();
    /** 接入说明。 */
    const guide = await h.app.inject({ method: 'GET', url: '/api/agents/guide' });
    bunTest.expect(guide.statusCode).toBe(200);
    bunTest.expect(guide.headers['content-type']).toContain('text/markdown');
    //M 0.3.4 重写了接入说明：标题改成“接入说明（给别的 AI 看）”，并写明每个请求都要带 token。
    bunTest.expect(guide.body).toContain('# jmbots');
    bunTest.expect(guide.body).toContain('/api/agents/');
    bunTest.expect(guide.body).toContain('token');
    /** 打招呼。 */
    const hello = await h.app.inject({ method: 'POST', url: '/api/agents/grokbots/hello', payload: { description: '会生短视频' } });
    bunTest.expect(hello.statusCode).toBe(200);
    /** 登记列表。 */
    const agents = (await h.app.inject({ method: 'GET', url: '/api/agents' })).json<agentTasks.AgentInfo[]>();
    bunTest.expect(agents.map((item) => item.name)).toEqual(['grokbots']);
    bunTest.expect(agents[0]!.description).toBe('会生短视频');
    await h.app.close();
  });

  bunTest.test('GET tasks?status=new 的附件带 url，用这个 url 能下载到原文件', async () => {
    /** HTTP 服务。 */
    const h = await setupApp();
    await new agentTasks.AgentTaskChannel(h.dir).hello('grokbots', '会生图');
    /** 附件原文件。 */
    const src = path.join(h.dir, '附件.bin');
    /** 原始字节。 */
    const bytes = Buffer.from('原始附件字节');
    fs.writeFileSync(src, bytes);
    /** 任务。 */
    const task = await new agentTasks.AgentTaskChannel(h.dir).createTask({ agent: 'grokbots', bot: BOT, sessionId: '20261106133000000001', title: '生图', text: '要 PNG', files: [src] });
    /** 列新任务。 */
    const list = await h.app.inject({ method: 'GET', url: '/api/agents/grokbots/tasks?status=new' });
    bunTest.expect(list.statusCode).toBe(200);
    /** 列出来的任务（files 换成 {name,url}）。 */
    const tasks = list.json<{ id: string; files: { name: string; url: string }[] }[]>();
    bunTest.expect(tasks).toHaveLength(1);
    bunTest.expect(tasks[0]!.id).toBe(task.id);
    bunTest.expect(tasks[0]!.files[0]!.name).toBe('附件.bin');
    /** 下载地址。 */
    const url = tasks[0]!.files[0]!.url;
    bunTest.expect(url).toContain(`/api/agents/grokbots/tasks/${task.id}/files/`);
    /** 下载。 */
    const download = await h.app.inject({ method: 'GET', url });
    bunTest.expect(download.statusCode).toBe(200);
    bunTest.expect(Buffer.from(download.rawPayload)).toEqual(bytes);
    await h.app.close();
  });

  bunTest.test('take 第二次回 409', async () => {
    /** HTTP 服务。 */
    const h = await setupApp();
    await new agentTasks.AgentTaskChannel(h.dir).hello('grokbots', '会生图');
    /** 任务。 */
    const task = await new agentTasks.AgentTaskChannel(h.dir).createTask({ agent: 'grokbots', bot: BOT, title: '生图', text: '要 PNG', files: [] });
    /** 认领地址。 */
    const url = `/api/agents/grokbots/tasks/${task.id}/take`;
    /** 第一次认领。 */
    const first = await h.app.inject({ method: 'POST', url });
    bunTest.expect(first.statusCode).toBe(200);
    bunTest.expect(first.json<{ status: string }>().status).toBe('taken');
    /** 第二次认领。 */
    const second = await h.app.inject({ method: 'POST', url });
    bunTest.expect(second.statusCode).toBe(409);
    bunTest.expect(second.json<{ error: string }>().error).toContain('已经');
    await h.app.close();
  });

  bunTest.test('PUT 上传后 POST result：任务 done，receive 收到送回派活会话的消息', async () => {
    /** HTTP 服务。 */
    const h = await setupApp();
    /** 派活的会话。 */
    const session = '20261106133000000099';
    await new agentTasks.AgentTaskChannel(h.dir).hello('grokbots', '会生图');
    /** 任务。 */
    const task = await new agentTasks.AgentTaskChannel(h.dir).createTask({ agent: 'grokbots', bot: BOT, sessionId: session, title: '生图', text: '要 PNG', files: [] });
    /** 交回的文件内容。 */
    const bytes = Buffer.from('交回的文件内容');
    /** 先上传。 */
    const uploaded = await h.app.inject({ method: 'PUT', url: '/api/uploads/x.txt', payload: bytes, headers: { 'content-type': 'application/octet-stream' } });
    bunTest.expect(uploaded.statusCode).toBe(200);
    /** 上传号。 */
    const up = uploaded.json<{ id: string; name: string }>();
    bunTest.expect(up.name).toBe('x.txt');
    /** 再交结果。 */
    const res = await h.app.inject({ method: 'POST', url: `/api/agents/grokbots/tasks/${task.id}/result`, payload: { ok: true, text: '做好了', uploads: [up.id] } });
    bunTest.expect(res.statusCode).toBe(200);
    /** 交回以后的任务。 */
    const body = res.json<{ ok: boolean; task: agentTasks.AgentTask; message: number }>();
    bunTest.expect(body.ok).toBe(true);
    bunTest.expect(body.task.status).toBe('done');
    bunTest.expect(body.task.result?.files).toEqual(['x.txt']);
    bunTest.expect((await new agentTasks.AgentTaskChannel(h.dir).getTask('grokbots', task.id))?.status).toBe('done');
    bunTest.expect(h.received).toHaveLength(1);
    /** 收到的话。 */
    const input = h.received[0]!;
    bunTest.expect(input.bot).toBe(BOT);
    bunTest.expect(input.session).toBe(session);
    bunTest.expect(input.source).toBe('grokbots');
    bunTest.expect(input.text.startsWith('【grokbots 交回任务')).toBe(true);
    bunTest.expect(input.images).toHaveLength(1);
    bunTest.expect(input.images[0]!.name).toBe('x.txt');
    bunTest.expect(Buffer.from(input.images[0]!.data).toString('utf8')).toBe('交回的文件内容');
    await h.app.close();
  });
});


bunTest.describe('agent_task 工具', () => {
  bunTest.test('list 没有外部 AI 时说“还没有”；send 不写 agent 报错；只读模式 send 报错', async () => {
    /** 依赖。 */
    const h = await setup();
    /** 列。 */
    const list = await runTool(h, 'agent_task', { action: 'list' });
    bunTest.expect(list.isError).toBe(false);
    bunTest.expect(list.text).toContain('还没有');
    /** 不写 agent。 */
    const noAgent = await runTool(h, 'agent_task', { action: 'send', title: '生图', text: '要 PNG' });
    bunTest.expect(noAgent.isError).toBe(true);
    bunTest.expect(noAgent.text).toContain('agent');
    /** 分派只读模式。 */
    const readOnly = await runTool(h, 'agent_task', { action: 'send', agent: 'grokbots', title: '生图', text: '要 PNG' }, { readOnly: true });
    bunTest.expect(readOnly.isError).toBe(true);
    bunTest.expect(readOnly.text).toContain('分派只能 list、status');
  });

  bunTest.test('send 后 status 能看到', async () => {
    /** 依赖。 */
    const h = await setup();
    await new agentTasks.AgentTaskChannel(h.dir).hello('grokbots', '会生图');
    /** 派活。 */
    const sent = await runTool(h, 'agent_task', { action: 'send', agent: 'grokbots', title: '生图', text: '要一张 PNG' }, { sessionId: '20261106133000000001' });
    bunTest.expect(sent.isError).toBe(false);
    bunTest.expect(sent.text).toContain('已交给 grokbots');
    /** 任务号。 */
    const id = /#(\d{14,})/.exec(sent.text)?.[1] ?? '';
    bunTest.expect(id).not.toBe('');
    /** 看状态。 */
    const status = await runTool(h, 'agent_task', { action: 'status', agent: 'grokbots', id });
    bunTest.expect(status.isError).toBe(false);
    bunTest.expect(status.text).toContain('等它来领');
    bunTest.expect(status.text).toContain('生图');
  });
});


bunTest.describe('toolDirs 与 exec 的 PATH', () => {
  bunTest.test('program 下 a\\bin、b\\Scripts、c（没有 bin）三种都认对；目录不存在时是空的', async () => {
    /** 依赖。 */
    const h = await setup();
    /** 工具目录（config 没写 paths，用运行时下的默认值）。 */
    const paths = h.deps.resources.getPaths();
    fs.mkdirSync(path.join(paths.program, 'a', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(paths.program, 'b', 'Scripts'), { recursive: true });
    fs.mkdirSync(path.join(paths.program, 'c'), { recursive: true });
    bunTest.expect(toolsModule.toolDirs([paths.runtimes, paths.program])).toEqual([
      path.join(paths.program, 'a', 'bin'),
      path.join(paths.program, 'b', 'Scripts'),
      path.join(paths.program, 'c'),
    ]);
    bunTest.expect(toolsModule.toolDirs([path.join(h.dir, '没有这个目录')])).toEqual([]);
  });

  bunTest.test('exec 跑 echo %PATH% 最前面是这些目录，跑完系统 PATH 没变', async () => {
    /** 依赖。 */
    const h = await setup();
    /** 工具目录。 */
    const paths = h.deps.resources.getPaths();
    fs.mkdirSync(path.join(paths.program, 'a', 'bin'), { recursive: true });
    /** 该排在 PATH 最前面的目录。 */
    const expected = toolsModule.toolDirs([paths.runtimes, paths.program]);
    bunTest.expect(expected.length).toBeGreaterThan(0);
    /** 跑之前的系统 PATH。 */
    const before = process.env.PATH;
    /** Windows 用 %PATH%，别的平台用 $PATH。 */
    const command = process.platform === 'win32' ? 'echo %PATH%' : 'echo $PATH';
    /** 跑一次 exec。 */
    const result = await runTool(h, 'exec', { command }, { sessionId: '20261106133000000001' });
    bunTest.expect(result.isError).toBe(false);
    /** 打印出来的 PATH 那一行。 */
    const line = result.text.split('\n').find((item) => item.includes(expected[0]!)) ?? '';
    bunTest.expect(line.trimStart().startsWith(expected.join(path.delimiter))).toBe(true);
    bunTest.expect(process.env.PATH).toBe(before);
  });
});
