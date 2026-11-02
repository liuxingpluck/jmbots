/** ask_dsh 的离线契约：全部通过工具 execute 接线，控制器用替身，不读真实配置、不联网。 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as relay from '../src/Relay.ts';
import * as dsh from '../src/DshSession.ts';
import type * as bounded from '../src/BoundedProcess.ts';
import type * as runtime from '../src/Runtime.ts';


/** 所有夹具都在项目内，清理时按父目录和前缀确认。 */
const testRoot = path.resolve(import.meta.dir, '../../runtime/scratch/dsh-tests');
const first = 'session-11111111-1111-4111-8111-111111111111';
const second = 'session-22222222-2222-4222-8222-222222222222';
let fixture = '';
let calls: string[][] = [];


test.beforeEach(async () => {
  await fs.mkdir(testRoot, { recursive: true });
  fixture = await fs.mkdtemp(path.join(testRoot, 'case-'));
  calls = [];
});


test.afterEach(async () => {
  assert.equal(path.dirname(path.resolve(fixture)), testRoot);
  assert.ok(path.basename(fixture).startsWith('case-'));
  await fs.rm(fixture, { recursive: true, force: true });
});


/** 构造控制器成功退出，stdout 中仍必须检查业务 accepted 和关联 ID。 */
function output(value: unknown): bounded.ProcessResult {
  return { status: 'exited', exitCode: 0, stdout: JSON.stringify(value), pid: 1, reaped: true };
}


/** 正常替身同时检查 exe/argv，参数里的任务永不拼进 shell。 */
function fakeRun(change?: (command: string, value: Record<string, unknown>) => bounded.ProcessResult): typeof bounded.runBounded {
  return (exe, args, limits) => {
    assert.equal(exe, 'node');
    assert.ok(limits.timeoutMs > 0 && limits.timeoutMs <= (args[1] === 'create' ? 60_000 : 15_000));
    calls.push([...args]);
    const command = args[1] ?? '';
    const sessionId = args[args.indexOf('--session') + 1];
    let value: Record<string, unknown>;
    if (command === 'create') {
      assert.equal(args[args.indexOf('--model') + 1], 'astra');
      assert.equal(args[args.indexOf('--effort') + 1], 'max');
      value = { sessionId: second, workspace: 'jmai' };
    } else if (command === 'status') {
      value = { sessionId, workspace: 'jmai', belongs: true, running: false, questions: 0, approvals: 0 };
    } else {
      assert.equal(command, 'send');
      assert.ok(args.includes('--text-file') && !args.includes('--wait'));
      value = { sessionId, requestId: args[args.indexOf('--request-id') + 1], accepted: true, mode: 'queue', afterTurn: 3 };
    }
    return Promise.resolve(change ? change(command, value) : output(value));
  };
}


/** 构造只含临时目录的运行时，经实际注册入口调用工具。 */
async function ask(args: Record<string, string>, defaultSession: string | undefined = first, run = fakeRun()): Promise<dsh.SubmissionReceipt> {
  const zbots: runtime.Runtime = { configFile: '', config: { runtime_dir: fixture, providers: {}, models: {}, workspaces: {} }, dir: fixture,
    sharedDir: fixture, rolesDir: fixture, workspacesDir: fixture, evaluationsDir: fixture };
  const tool = relay.createRelayTools(zbots, defaultSession, { run }).find((item) => item.definition.name === 'ask_dsh');
  assert.ok(tool);
  return JSON.parse(await tool.execute(args)) as dsh.SubmissionReceipt;
}


for (const mode of [undefined, 'current', 'specified', 'new']) {
  test.test(`三模式和 task-only：${mode ?? 'task-only'} 返回实际 ID、只确认排队受理`, async () => {
    const args: Record<string, string> = { task: '任务包含 & | $(echo) 不作 shell 展开' };
    if (mode) { args.session_mode = mode; }
    if (mode === 'specified') { args.session_id = second; }
    const result = await ask(args);
    assert.equal(result.status, 'accepted');
    assert.equal(result.completed, false);
    assert.equal(result.sessionId, mode === 'new' || mode === 'specified' ? second : first);
    assert.equal(result.mode, 'queue');
    assert.match(result.requestId, /^[0-9a-f-]+$/);
    assert.match(result.message, /仅确认提交/);
    assert.ok(result.taskFile && result.receiptFile);
    assert.match(path.basename(result.taskFile), /^task_\d{17}\.md$/);
    assert.match(await fs.readFile(result.taskFile, 'utf8'), /任务包含 & \|/);
    assert.deepEqual(JSON.parse(await fs.readFile(result.receiptFile, 'utf8')) as unknown, result);
    assert.deepEqual(calls.map((args) => args[1]), mode === 'new' ? ['create', 'status', 'send'] : ['status', 'send']);
  });
}


test.test('new 不依赖默认会话，之后 current 仍然指向配置默认而不是新建会话', async () => {
  assert.equal((await ask({ task: '新建', session_mode: 'new' }, '')).sessionId, second);
  assert.equal((await ask({ task: '当前' })).sessionId, first);
});


/** 明确给出统一字典类型，避免联合推断为带 undefined 的可选字段。 */
const invalidCases: Record<string, string>[] = [
  { task: '' }, { task: 'x', session_mode: 'other' }, { task: 'x', session_mode: 'specified' },
  { task: 'x', session_mode: 'specified', session_id: 'session-x;echo' },
  { task: 'x', session_mode: 'new', session_id: first }, { task: 'x', session_id: first },
  { task: 'x', request_id: '../bad-path' }, { task: 'x'.repeat(65537) },
];
for (const args of invalidCases) {
  test.test(`参数错误不产生副作用：${Object.keys(args).join(',')} ${String(args.session_mode ?? '')}`, async () => {
    await assert.rejects(ask(args));
    assert.deepEqual(calls, []);
    assert.deepEqual(await fs.readdir(fixture), []);
  });
}


test.test('无默认或默认格式错误不启动控制器', async () => {
  for (const configured of ['', 'not-a-session']) {
    assert.equal((await ask({ task: 'x' }, configured)).status, 'invalid');
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(await fs.readdir(fixture), []);
});


for (const stateChange of [{ belongs: false }, { workspace: 'other' }, { sessionId: second }]) {
  test.test(`归属检查失败不发送：${JSON.stringify(stateChange)}`, async () => {
    const result = await ask({ task: 'x' }, first, fakeRun((command, value) => output(command === 'status' ? { ...value, ...stateChange } : value)));
    assert.equal(result.code, 'session_not_owned');
    assert.equal(calls.length, 1);
  });
}


for (const stateChange of [{ running: true }, { questions: 1 }, { approvals: 1 }]) {
  test.test(`忙或等待交互不排队，不自动新建：${JSON.stringify(stateChange)}`, async () => {
    const result = await ask({ task: 'x' }, first, fakeRun((command, value) => output(command === 'status' ? { ...value, ...stateChange } : value)));
    assert.equal(result.status, 'busy');
    assert.equal(calls.length, 1);
    assert.match(result.message, /忙不等于卡死/);
  });
}


test.test('退出 0 但 accepted=false 不是成功', async () => {
  const result = await ask({ task: 'x' }, first, fakeRun((command, value) => output(command === 'send' ? { ...value, accepted: false } : value)));
  assert.equal(result.status, 'rejected');
  assert.equal(result.accepted, false);
});


for (const mismatch of [{ sessionId: second }, { requestId: 'different-id' }, { mode: 'steer' }, { accepted: null }, { afterTurn: -1 }]) {
  test.test(`提交回执不可靠必须 unknown：${JSON.stringify(mismatch)}`, async () => {
    const result = await ask({ task: 'x' }, first, fakeRun((command, value) => output(command === 'send' ? { ...value, ...mismatch } : value)));
    assert.equal(result.status, 'submission_unknown');
    assert.equal(result.accepted, false);
    assert.equal(calls.length, 2);
  });
}


for (const phase of ['create', 'status', 'send']) {
  for (const failure of ['timeout', 'output_limit', 'spawn_error', 'cleanup_failed', 'control_exit', 'bad_json']) {
    test.test(`${phase} ${failure} 有界失败且不泄露输出、不重试`, async () => {
      const result = await ask({ task: 'x', session_mode: 'new' }, first, fakeRun((command, value) => {
        if (command !== phase) { return output(value); }
        if (failure === 'control_exit') { return { ...output({ secret: 'DO_NOT_LEAK' }), exitCode: 1 }; }
        if (failure === 'bad_json') { return { ...output(null), stdout: 'DO_NOT_LEAK' }; }
        return { ...output(null), status: failure as bounded.ProcessResult['status'], stdout: 'DO_NOT_LEAK' };
      }));
      const expected = { create: 'creation_unknown', status: 'control_error', send: 'submission_unknown' }[phase];
      assert.equal(result.status, expected);
      assert.ok(!JSON.stringify(result).includes('DO_NOT_LEAK'));
      assert.equal(calls.filter((args) => args[1] === phase).length, 1);
      if (phase === 'create') { assert.equal(calls.length, 1); }
    });
  }
}


test.test('新建缺失或错误 sessionId 不继续发送', async () => {
  for (const sessionId of [null, 'invalid']) {
    const result = await ask({ task: 'x', session_mode: 'new' }, first, fakeRun((command, value) => output(command === 'create' ? { ...value, sessionId } : value)));
    assert.equal(result.status, 'creation_unknown');
  }
  assert.deepEqual(calls.map((args) => args[1]), ['create', 'create']);
});


for (const kind of ['accepted', 'busy', 'unknown']) {
  test.test(`${kind} 同 ID 重试只读原记录，换任务/会话冲突不重发`, async () => {
    const run = fakeRun((command, value) => {
      if (kind === 'busy' && command === 'status') { return output({ ...value, running: true }); }
      if (kind === 'unknown' && command === 'send') { return { ...output(null), status: 'timeout' }; }
      return output(value);
    });
    const args = { task: 'x', request_id: 'retry-same-123' };
    const one = await ask(args, first, run);
    const count = calls.length;
    assert.deepEqual(await ask(args, first, run), one);
    assert.equal((await ask({ ...args, task: '不同任务' }, first, run)).code, 'request_conflict');
    assert.equal((await ask({ ...args, session_mode: 'specified', session_id: second }, first, run)).code, 'request_conflict');
    assert.equal(calls.length, count);
  });
}


test.test('同请求并发至多提交一次，不同请求并发不串会话', async () => {
  const args = { task: 'x', request_id: 'concurrent-123' };
  const results = await Promise.all([ask(args), ask(args)]);
  assert.equal(results.filter((item) => item.accepted).length >= 1, true);
  assert.equal(calls.filter((args) => args[1] === 'send').length, 1);
  calls = [];
  const independent = await Promise.all([ask({ task: '默认' }), ask({ task: '指定', session_mode: 'specified', session_id: second })]);
  assert.deepEqual(independent.map((item) => item.sessionId), [first, second]);
  assert.notEqual(independent[0]?.requestId, independent[1]?.requestId);
});


test.test('总预算用完不启动下个控制进程；已建立的 ID 仍留在失败回执', async () => {
  const result = await dsh.submitTask(fixture, first, { task: 'x', session_mode: 'new' }, {
    timeoutMs: 100,
    run: async () => {
      await Bun.sleep(150);
      return output({ sessionId: second, workspace: 'jmai' });
    },
  });
  assert.equal(result.code, 'timeout');
  assert.equal(result.sessionId, second);
  assert.equal(result.accepted, false);
});


test.test('create 中断时只恢复本请求阶段证据的真实 ID，不猜测或重发', async () => {
  const result = await dsh.submitTask(fixture, first, { task: 'x', session_mode: 'new' }, {
    run: async (_exe, args) => {
      const traceFile = args[args.indexOf('--trace-file') + 1];
      assert.ok(traceFile);
      await fs.writeFile(traceFile, `${JSON.stringify({ phase: 'create', time: 1 })}\n${JSON.stringify({ phase: 'model', sessionId: second, time: 2 })}\n`);
      return { ...output(null), status: 'timeout' };
    },
  });
  assert.equal(result.status, 'creation_unknown');
  assert.equal(result.createPhase, 'model');
  assert.equal(result.sessionId, second);
  assert.equal(result.accepted, false);
});


test.test('北京时间毫秒格式不受宿主时区影响', () => {
  assert.equal(dsh.beijingStamp(new Date('2026-11-01T20:00:01.234Z')), '20261102040001234');
});
