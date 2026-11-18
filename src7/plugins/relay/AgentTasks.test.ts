/**
 * 外部任务通道（AgentTasks）的新协议 v1：派活取次高档、写任务单；领取键同键重领回原样、别人领了 409；
 * 交回查领取键和产物，同内容重交回原样、不同内容 result_conflict；定时扫 result.json 时坏文件不算完成；旧任务照旧格式收。
 * ctx 是假的：内存库、临时目录、记下 acceptResult 的假前台；不起 Cordis、不起 HTTP。
 * 11-17 随 agent-tasks 并进 relay 挪到这里。
 * 跑法：bun test ./src7/plugins/relay
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import type * as toolsModule from '../../Tools.ts';
import * as checksModule from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';
import type * as dispatchModule from '../bots/Dispatch.ts';
import { AgentTasks, type SendInput } from './AgentTasks.ts';


/** 一个用例的摆设。 */
interface Bench {
  /** 被测的任务通道。 */
  tasks: AgentTasks;
  /** 假前台收到的结果（acceptResult 的 input），按收到的先后。 */
  accepted: dispatchModule.ResultInput[];
  /** 派活的前台会话。 */
  session: Session;
  /** 内存库。 */
  db: Database;
  /** 登记的工具 agent_task：照骨架的样子调它的 run(参数, 会话, 停止信号, callId)。 */
  tool: toolsModule.ToolSpec;
}


/** Claude 打招呼报的能力：一个模型 opus，档位从低到高，次高是 xhigh；能开子代理；http 交回。 */
const CLAUDE_HELLO: checksModule.AgentHello = {
  description: '会写代码',
  abilities: { models: [{ id: 'opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }], subagents: true, returnMode: 'http' },
};

/** 交给 Claude 的一件活：开一个子代理，模型和档都不写（取登记的）。 */
const CLAUDE_TASK: SendInput = {
  agent: 'claude',
  title: '修 bug',
  text: '把登录修好',
  files: [],
  deliverables: ['补丁'],
  subagents: [{ name: '读码', responsibility: '读代码找原因' }],
  requestKey: 'front-1/call-1',
};


//M 每个用例收拾自己的临时目录。
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


/** 摆一个用例：内存库、临时数据根、假前台（acceptResult 先调 commitSource 再记下，和真的一样在“事务”里改任务状态）。 */
function makeBench(): Bench {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tasks-'));
  roots.push(root);
  const db = new Database(':memory:');
  const accepted: dispatchModule.ResultInput[] = [];

  const resources = {
    db,
    dir: (...parts: string[]): string => {
      const full = path.join(root, ...parts);
      fs.mkdirSync(full, { recursive: true });
      return full;
    },
  };
  const frontDesk = {
    acceptResult: (input: dispatchModule.ResultInput, commitSource: () => void): dispatchModule.AcceptReceipt => {
      commitSource();
      accepted.push(input);
      return { status: 'queued', key: input.key };
    },
  };
  //M 假工具服务：记下登记的工具，用例自己调它。
  const registered: toolsModule.ToolSpec[] = [];
  const tools = {
    register: (spec: toolsModule.ToolSpec) => {
      registered.push(spec);
    },
  };
  const ctx = {
    resources,
    frontDesk,
    tools,
    emit: () => undefined,
  } as unknown as cordis.Context;

  const tasks = new AgentTasks(ctx);
  const row = { id: 'front-1', bot: '助手', kind: 'front', channel: 'web', address: { user: 'me' } };
  const session = { row } as unknown as Session;
  return { tasks, accepted, session, db, tool: registered[0]! };
}


/**
 * 一份合规矩的结果（还没过 checkTaskResult）。
 * @param taskId 任务号。
 * @param claimKey 领取键。
 * @param more 要改的项。
 */
function getRawResult(taskId: string, claimKey: string, more: Record<string, unknown> = {}): Record<string, unknown> {
  const actualExecution = {
    host: 'Claude Code',
    sessionId: 'main-1',
    requestedModel: 'opus',
    requestedThinking: 'xhigh',
    actualModel: 'opus',
    actualThinking: 'xhigh',
    subagents: [{ id: 'sub-1', responsibility: '读代码找原因', model: 'opus', thinking: 'xhigh' }],
  };
  return { version: 1, kind: 'result', taskId, claimKey, status: 'completed', summary: '修好了', actualExecution, ...more };
}


/**
 * 交回时状态码是几：抛 Failure 交回它的状态码，没抛是 0。
 * @param run 要跑的。
 */
function getStatus(run: () => unknown): number {
  try {
    run();
    return 0;
  } catch (error) {
    if (error instanceof failureModule.Failure) return error.status;

    throw error;
  }
}


test('派活：照登记的能力取次高档，写 task.json、task.md；没登记的模型不收', () => {
  const bench = makeBench();
  bench.tasks.hello('claude', CLAUDE_HELLO);

  const task = bench.tasks.send(bench.session, CLAUDE_TASK);

  //M 执行配置：opus、次高档 xhigh，子代理同样。
  const spec = task.protocol!.spec;
  expect(spec.execution.model).toBe('opus');
  expect(spec.execution.thinking).toBe('xhigh');
  expect(spec.execution.effortPolicy).toBe('second-highest');
  expect(spec.execution.subagents[0]?.thinking).toBe('xhigh');
  expect(spec.source.frontSessionId).toBe('front-1');

  //M 任务单落盘；回话地址留在库里，不进 task.json。
  const folder = bench.tasks.dir('claude', task.id);
  const written = JSON.parse(fs.readFileSync(path.join(folder, 'task.json'), 'utf8')) as Record<string, unknown>;
  expect(written['taskId']).toBe(task.id);
  expect(written['origin']).toBeUndefined();
  expect(fs.readFileSync(path.join(folder, 'task.md'), 'utf8')).toContain('xhigh');
  expect(task.protocol!.origin.channel).toBe('web');

  //M 它没登记的模型：model_unavailable，不换别的（另一次调用，调用键不同）。
  const wrong = { ...CLAUDE_TASK, model: 'gpt', requestKey: 'front-1/call-2' };
  expect(() => bench.tasks.send(bench.session, wrong)).toThrow('model_unavailable');
});


test('派活防重复：同一个调用键再调 send 回原来那件；经工具调，同一个 callId 回同一句回执，不同 callId 派新的', async () => {
  const bench = makeBench();
  bench.tasks.hello('claude', CLAUDE_HELLO);

  //M 直接调 send：同一个 requestKey 两次，同一件，表里只有一行。
  const first = bench.tasks.send(bench.session, CLAUDE_TASK);
  const again = bench.tasks.send(bench.session, CLAUDE_TASK);
  expect(again.id).toBe(first.id);
  expect(again.protocol?.requestKey).toBe('front-1/call-1');
  const count = bench.db.query('SELECT COUNT(*) AS n FROM agent_tasks').get() as { n: number };
  expect(count.n).toBe(1);

  //M 经工具调（照骨架 Tools.execute 的样子传 callId）：同一个 callId 回同一句，不再派。
  const signal = new AbortController().signal;
  const args = { action: 'send', agent: 'claude', title: '写测试', text: '补测试', deliverables: ['测试文件'] };
  const toolFirst = await bench.tool.run(args, bench.session, signal, 'call-7');
  const toolAgain = await bench.tool.run(args, bench.session, signal, 'call-7');
  expect(toolAgain).toBe(toolFirst);
  expect((bench.db.query('SELECT COUNT(*) AS n FROM agent_tasks').get() as { n: number }).n).toBe(2);

  //M 换一个 callId：是新的一次调用，派新的一件。
  await bench.tool.run(args, bench.session, signal, 'call-8');
  expect((bench.db.query('SELECT COUNT(*) AS n FROM agent_tasks').get() as { n: number }).n).toBe(3);
});


test('领取键：同一个键重领回原样，别的键 409', () => {
  const bench = makeBench();
  bench.tasks.hello('claude', CLAUDE_HELLO);
  const task = bench.tasks.send(bench.session, CLAUDE_TASK);
  const id = Number(task.id);

  const first = bench.tasks.take('claude', id, 'k1');
  const again = bench.tasks.take('claude', id, 'k1');

  expect(first.status).toBe('taken');
  expect(first.protocol?.claimKey).toBe('k1');
  expect(again.takenAt).toBe(first.takenAt!);
  expect(getStatus(() => bench.tasks.take('claude', id, 'k2'))).toBe(409);
});


test('交回：领取键对不上 409；对上了排进前台；同内容重交回原样，不同内容 result_conflict', () => {
  const bench = makeBench();
  bench.tasks.hello('claude', CLAUDE_HELLO);
  const task = bench.tasks.send(bench.session, CLAUDE_TASK);
  const id = Number(task.id);
  bench.tasks.take('claude', id, 'k1');

  //M 产物先放进 result/artifacts/，清单里带 SHA-256。
  const artifacts = bench.tasks.dir('claude', id, 'result', 'artifacts');
  fs.writeFileSync(path.join(artifacts, 'patch.diff'), '+ 修好');
  const sha256 = crypto.createHash('sha256').update('+ 修好').digest('hex');
  const listed = [{ path: 'patch.diff', sha256, description: '补丁' }];

  //M 领取键不对：不收。
  const wrongKey = checksModule.checkTaskResult(getRawResult(task.id, 'k2', { artifacts: listed }));
  expect(getStatus(() => bench.tasks.finish('claude', id, { uploads: [], result: wrongKey }))).toBe(409);
  expect(bench.accepted.length).toBe(0);

  //M 对上了：做完，结果带着产物排进派活的前台，回话地址是派活时的。
  const result = checksModule.checkTaskResult(getRawResult(task.id, 'k1', { artifacts: listed }));
  const done = bench.tasks.finish('claude', id, { uploads: [], result });
  expect(done.status).toBe('done');
  expect(bench.accepted.length).toBe(1);
  expect(bench.accepted[0]?.key).toBe(`agent:${task.id}:result`);
  expect(bench.accepted[0]?.sessionId).toBe('front-1');
  expect(bench.accepted[0]?.origin?.channel).toBe('web');
  expect(bench.accepted[0]?.payload.files).toEqual([path.join(artifacts, 'patch.diff')]);
  expect(bench.accepted[0]?.payload.text).toContain('sub-1');

  //M 同一份重交：回原样，不再排一次。
  const repeated = bench.tasks.finish('claude', id, { uploads: [], result });
  expect(repeated.status).toBe('done');
  expect(bench.accepted.length).toBe(1);

  //M 内容不一样：冲突，不覆盖。
  const changed = checksModule.checkTaskResult(getRawResult(task.id, 'k1', { artifacts: listed, summary: '换了说法' }));
  expect(getStatus(() => bench.tasks.finish('claude', id, { uploads: [], result: changed }))).toBe(409);
  expect(bench.tasks.get('claude', id)?.result?.text).toBe('修好了');
});


test('file 交回：坏的 result.json 不算完成，改好了再扫就收', () => {
  const bench = makeBench();
  const hello: checksModule.AgentHello = {
    description: '会生图',
    abilities: { models: [{ id: 'grok-5', efforts: ['low', 'high'] }], subagents: false, returnMode: 'file' },
  };
  bench.tasks.hello('grok', hello);
  const input: SendInput = { agent: 'grok', title: '画图', text: '画一只猫', files: [], deliverables: ['图'], subagents: [], requestKey: 'front-1/call-9' };
  const task = bench.tasks.send(bench.session, input);
  const id = Number(task.id);

  //M 没带领取键：替它生成一个。
  const taken = bench.tasks.take('grok', id, undefined);
  const claimKey = taken.protocol!.claimKey!;
  expect(claimKey.length).toBeGreaterThan(0);

  //M 写到一半的 result.json：不收，还是 taken。
  const file = path.join(bench.tasks.dir('grok', id, 'result'), 'result.json');
  fs.writeFileSync(file, '{"version": 1, ');
  bench.tasks.scan();
  expect(bench.tasks.get('grok', id)?.status).toBe('taken');
  expect(bench.accepted.length).toBe(0);

  //M 写好了：再扫就收。
  const raw = getRawResult(task.id, claimKey, { summary: '猫画好了' });
  fs.writeFileSync(file, JSON.stringify(raw));
  bench.tasks.scan();
  expect(bench.tasks.get('grok', id)?.status).toBe('done');
  expect(bench.accepted.length).toBe(1);
});


test('旧任务（protocol 是 NULL）：照旧格式收，交新协议的结果 400', () => {
  const bench = makeBench();
  const insert = "INSERT INTO agent_tasks (agent, bot, session, title, text, files, status, created_at) VALUES ('old', '助手', 'front-1', '旧活', '做旧活', '[]', 'new', 0)";
  const id = Number(bench.db.query(insert).run().lastInsertRowid);

  const taken = bench.tasks.take('old', id, undefined);
  expect(taken.status).toBe('taken');
  expect(taken.protocol).toBeUndefined();

  //M 交新协议的结果：不收。
  const result = checksModule.checkTaskResult(getRawResult(String(id), 'k1'));
  expect(getStatus(() => bench.tasks.finish('old', id, { uploads: [], result }))).toBe(400);

  //M 旧格式：收，话送回会话。
  const done = bench.tasks.finish('old', id, { ok: true, text: '旧活做完了', uploads: [] });
  expect(done.status).toBe('done');
  expect(bench.accepted[0]?.payload.text).toContain('旧活做完了');
});
