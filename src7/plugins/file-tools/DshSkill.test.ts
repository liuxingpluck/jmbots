/**
 * dsh-control 技能的脚本（dsh-control/scripts/dsh.mjs）：用假的 DSH 客户端跑，不连真 DSH。
 * 查这几样：只认登记的工作区；头一回取次高档、建会话、发；发出错说不清时重发沿用 requestId；
 * 建会话说不清时不再建，客户端记下了会话号就找回来；做完从回复里取 dsh-result 和实际模型；接着发不能换模型。
 * 跑法：bun test ./src7/plugins/file-tools/DshSkill.test.ts
 */
import { afterEach, expect, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';


/** 被测的脚本：用例把它复制进临时的技能目录，settings.json 写在那边，不碰源码目录。 */
const SCRIPT = path.join(import.meta.dir, 'dsh-control', 'scripts', 'dsh.mjs');

/**
 * 假客户端：照 FAKE_PLAN 文件里每个命令写的回（退出码、标准输出的 JSON、标准错误）；每次调用记一行进 FAKE_LOG。
 * create 带 --trace-file、计划里写了 trace 时，照真客户端的样子记下会话号。
 */
const FAKE_CLIENT = `import * as fs from 'node:fs';
const [command, ...rest] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_PLAN, 'utf8'));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify([command, ...rest]) + '\\n');
const step = plan[command] ?? {};
const traceAt = rest.indexOf('--trace-file');
if (traceAt >= 0 && step.trace !== undefined) {
  fs.appendFileSync(rest[traceAt + 1], JSON.stringify({ phase: 'rename', sessionId: step.trace }) + '\\n');
}
if (step.out !== undefined) process.stdout.write(JSON.stringify(step.out));
if (step.err !== undefined) process.stderr.write(step.err);
process.exitCode = step.code ?? 0;
`;

/** DSH 模型目录：一个模型 prov/m1，档位 off、low、high、max（次高是 high）。 */
const CATALOG = {
  groups: [{ id: 'prov', models: [{ id: 'm1', reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } }] }],
};

/** 发消息收下了：发之前已有 0 轮。 */
const SEND_OK = { out: { accepted: true, mode: 'queue', requestId: 'r', sessionId: 'session-1', afterTurn: 0 } };


/** 假客户端对一个命令的回法。 */
interface Step {
  /** 退出码，不写是 0。 */
  code?: number;
  /** 标准输出的 JSON。 */
  out?: unknown;
  /** 标准错误。 */
  err?: string;
  /** create 时记进 --trace-file 的会话号。 */
  trace?: string;
}


/** 一个用例的摆设：临时目录、工作区、改计划、跑脚本、看客户端被怎么调了。 */
interface Bench {
  /** 登记过的工作区。 */
  workspace: string;
  /** 没登记的目录。 */
  other: string;
  /** 换假客户端的回法。 */
  setPlan(plan: Record<string, Step>): void;
  /** 在 cwd（默认登记过的工作区）跑一次脚本，交回它打的 JSON。 */
  run(args: string[], cwd?: string): Record<string, unknown>;
  /** 假客户端被调过的每一次：[命令, ...参数]。 */
  calls(): string[][];
}


//M 每个用例收拾自己的临时目录。
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


/**
 * 摆一个用例：临时技能目录（复制脚本、写 settings.json）、假客户端、工作区和一个没登记的目录。
 * @param plan 假客户端一开始的回法。
 */
function makeBench(plan: Record<string, Step>): Bench {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-'));
  roots.push(root);

  //M 技能目录：脚本放 scripts/，settings.json 指向假客户端、登记工作区 ws。
  const skill = path.join(root, 'skill');
  fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(skill, 'scripts', 'dsh.mjs'));
  const client = path.join(root, 'fake-client.mjs');
  fs.writeFileSync(client, FAKE_CLIENT);
  const workspace = path.join(root, 'ws');
  const other = path.join(root, 'other');
  fs.mkdirSync(workspace);
  fs.mkdirSync(other);
  const settings = { client, workspaces: [{ dir: workspace, dsh: 'dsh-ws' }], waitMs: 0 };
  fs.writeFileSync(path.join(skill, 'settings.json'), JSON.stringify(settings));

  //M 计划和调用记录：假客户端从环境变量找到它们。
  const planFile = path.join(root, 'plan.json');
  const logFile = path.join(root, 'calls.log');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  fs.writeFileSync(logFile, '');

  return {
    workspace,
    other,
    setPlan: (next) => fs.writeFileSync(planFile, JSON.stringify(next)),
    run: (args, cwd = workspace) => {
      const env = { ...process.env, FAKE_PLAN: planFile, FAKE_LOG: logFile };
      const options = { cwd, env, encoding: 'utf8' as const };
      const child = childProcess.spawnSync(process.execPath, [path.join(skill, 'scripts', 'dsh.mjs'), ...args], options);
      return JSON.parse(child.stdout) as Record<string, unknown>;
    },
    calls: () => {
      const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter((line) => line !== '');
      return lines.map((line) => JSON.parse(line) as string[]);
    },
  };
}


/**
 * 一次调用里某个参数的值。
 * @param call [命令, ...参数]。
 * @param flag 参数名，比如 --request-id。
 */
function getFlag(call: string[], flag: string): string | undefined {
  const at = call.indexOf(flag);
  if (at < 0) return undefined;

  return call[at + 1];
}


/**
 * 在工作区写一份任务书，交回它的路径。
 * @param bench 用例的摆设。
 * @param text 任务书的话。
 */
function writeTask(bench: Bench, text: string): string {
  const file = path.join(bench.workspace, 'task.md');
  fs.writeFileSync(file, text);
  return file;
}


test('只认登记的工作区：别的目录跑回 workspace_mismatch，不调客户端', () => {
  const bench = makeBench({ models: { out: CATALOG } });

  const output = bench.run(['models'], bench.other);

  expect(output['state']).toBe('failed');
  expect((output['error'] as { code: string }).code).toBe('workspace_mismatch');
  expect(bench.calls()).toEqual([]);
});


test('头一回发：取次高档、建会话、发；接着发不能换模型', () => {
  const bench = makeBench({ models: { out: CATALOG }, create: { out: { sessionId: 'session-1' } }, send: SEND_OK });
  const task = writeTask(bench, '在 F 盘跑 typecheck');

  const output = bench.run(['send', '--task', 't1', '--text-file', task, '--model', 'prov/m1']);

  //M 交出去了：档是次高的 high，会话号记下了。
  expect(output['state']).toBe('accepted');
  expect(output['effort']).toBe('high');
  expect(output['sessionId']).toBe('session-1');
  const commands = bench.calls().map((call) => call[0]);
  expect(commands).toEqual(['models', 'create', 'send']);
  const create = bench.calls()[1]!;
  expect(getFlag(create, '--effort')).toBe('high');
  expect(getFlag(create, '--workspace')).toBe('dsh-ws');

  //M 发出去的正文带着交回要求。
  const sent = bench.calls()[2]!;
  const prompt = fs.readFileSync(getFlag(sent, '--text-file')!, 'utf8');
  expect(prompt).toContain('在 F 盘跑 typecheck');
  expect(prompt).toContain('dsh-result');

  //M 同一个任务号换模型：不让换。
  const changed = bench.run(['send', '--task', 't1', '--text-file', task, '--model', 'prov/m2']);
  expect((changed['error'] as { code: string }).code).toBe('model_conflict');
});


test('发出错说不清交没交上：回 unknown，原样重发沿用同一个 requestId，不再建会话', () => {
  const bench = makeBench({ models: { out: CATALOG }, create: { out: { sessionId: 'session-1' } }, send: { code: 1, err: '网络断了' } });
  const task = writeTask(bench, '编译');

  const first = bench.run(['send', '--task', 't2', '--text-file', task, '--model', 'prov/m1']);
  expect(first['state']).toBe('unknown');
  expect((first['error'] as { code: string }).code).toBe('send_unconfirmed');
  expect(first['sessionId']).toBe('session-1');

  //M 网络好了，原样重发：requestId 和上次一样，会话不再建。
  bench.setPlan({ send: SEND_OK });
  const second = bench.run(['send', '--task', 't2', '--text-file', task]);
  expect(second['state']).toBe('accepted');

  const sends = bench.calls().filter((call) => call[0] === 'send');
  expect(sends.length).toBe(2);
  expect(getFlag(sends[0]!, '--request-id')).toBe(getFlag(sends[1]!, '--request-id')!);
  expect(second['requestId']).toBe(getFlag(sends[0]!, '--request-id')!);
  expect(bench.calls().filter((call) => call[0] === 'create').length).toBe(1);
});


test('建会话说不清：没记下会话号就不再建；记下了就找回来、补设模型和权限再发', () => {
  //M 建到一半出错、客户端没记下会话号：两次都回 create_unconfirmed，只建过一次。
  const bench = makeBench({ models: { out: CATALOG }, create: { code: 1, err: '超时' } });
  const task = writeTask(bench, '编译');
  const first = bench.run(['send', '--task', 't3', '--text-file', task, '--model', 'prov/m1']);
  const again = bench.run(['send', '--task', 't3', '--text-file', task]);
  expect((first['error'] as { code: string }).code).toBe('create_unconfirmed');
  expect((again['error'] as { code: string }).code).toBe('create_unconfirmed');
  expect(bench.calls().filter((call) => call[0] === 'create').length).toBe(1);

  //M 另一件：建到一半出错，但客户端记下了会话号 session-9。
  bench.setPlan({ models: { out: CATALOG }, create: { code: 1, err: '超时', trace: 'session-9' }, send: SEND_OK });
  const broken = bench.run(['send', '--task', 't4', '--text-file', task, '--model', 'prov/m1']);
  expect(broken['state']).toBe('unknown');

  //M 再发：找回 session-9，补设模型和权限，再发；不再建。
  const adopted = bench.run(['send', '--task', 't4', '--text-file', task]);
  expect(adopted['state']).toBe('accepted');
  expect(adopted['sessionId']).toBe('session-9');
  const t4 = bench.calls().slice(-3);
  expect(t4.map((call) => call[0])).toEqual(['model', 'permission', 'send']);
  expect(getFlag(t4[0]!, '--effort')).toBe('high');
  expect(getFlag(t4[2]!, '--session')).toBe('session-9');
});


test('status：还在做回 running；做完取 dsh-result 和 DSH 记的实际模型', () => {
  const bench = makeBench({ models: { out: CATALOG }, create: { out: { sessionId: 'session-1' } }, send: SEND_OK, wait: { code: 3, out: { status: 'timeout' } } });
  const task = writeTask(bench, '编译');
  bench.run(['send', '--task', 't5', '--text-file', task, '--model', 'prov/m1']);

  //M 等到时候了还在做。
  const running = bench.run(['status', '--task', 't5']);
  expect(running['state']).toBe('running');
  const wait = bench.calls().at(-1)!;
  expect(getFlag(wait, '--after-turn')).toBe('0');

  //M 做完：回复最后带 dsh-result。
  const block = '```dsh-result\n{"status":"completed","summary":"编译过了","subagents":[{"id":"sub-1","responsibility":"跑测试","model":"prov/m1","thinking":"high"}]}\n```';
  const turn = { turn: 1, endReason: 'completed', model: 'prov / m1 / high', replies: ['好了', block] };
  bench.setPlan({ wait: { out: turn } });
  const done = bench.run(['status', '--task', 't5']);
  expect(done['state']).toBe('completed');
  expect(done['summary']).toBe('编译过了');
  expect(done['actualModel']).toBe('prov/m1');
  expect(done['actualThinking']).toBe('high');
  expect((done['subagents'] as { id: string }[])[0]?.id).toBe('sub-1');
  expect(fs.existsSync(done['replyFile'] as string)).toBe(true);
});
