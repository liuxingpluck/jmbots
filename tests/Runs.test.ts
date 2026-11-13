/**
 * 命令窗口的离线测试（docs/界面/08_命令窗口.md 第 1 节）：审核（规矩、决策模型、问用户）、跑、等、看输出、停下、超时、程序重启。
 * 临时目录根用 JMBOTS_TEST_TMP，没设就用系统临时目录（Linux 上也能跑）；用完删掉。假的决策模型和渠道，不联网、不调模型。
 * 真跑的命令只有 echo 和等几秒的（Windows 上 ping 本机，别的系统 sleep），不碰别的东西。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import type * as runsModule from '../src/executors/Runs.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import * as builders from './Builders.ts';


/** 临时目录的根：JMBOTS_TEST_TMP 优先，没设就用系统临时目录。 */
const TMP_ROOT = process.env.JMBOTS_TEST_TMP ?? os.tmpdir();

/** 一条要等十几秒的命令（停下、超时用）。 */
const SLOW_COMMAND = process.platform === 'win32' ? 'ping -n 20 127.0.0.1 >nul' : 'sleep 20';


/** 一次测试的东西。 */
interface Harness {
  /** 依赖。 */
  deps: builders.TestDeps;
  /** 临时运行时目录。 */
  dir: string;
  /** 发出去的审核卡片。 */
  cards: approvalsModule.PendingApproval[];
}


/**
 * 建依赖：一个机器人周小灵；决策模型给的“安全”概率由参数定（undefined 是没配决策模型）。
 * @param probability 决策模型给的概率。
 * @returns 依赖、目录、发出去的卡片。
 */
async function setup(probability: number | undefined): Promise<Harness> {
  /** 临时运行时目录。 */
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'jmbots-runs-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'providers: {}\ndefault_model: magpie/test\nbots:\n  - name: 周小灵\n    language: zh\n');
  /** 资源。 */
  const resources = await resourcesModule.Resources.load(dir);
  /** 发出去的卡片。 */
  const cards: approvalsModule.PendingApproval[] = [];
  /** 假模型：只有决策模型有用。 */
  const ai = builders.fakeAi({
    chat: () => Promise.reject(new Error('命令窗口不该调常规模型')),
    decide: (input) => Promise.resolve({ answers: { safe: { type: 'bool', probability: probability ?? 0 } }, ms: 1, request: { model: 'magpie/decision', state: input.state, questions: input.questions } }),
    hasDecision: () => probability !== undefined,
    listModels: () => [],
  });
  /** 渠道：只记卡片。 */
  const out: depsModule.Outlet = {
    send: () => Promise.resolve(),
    sendApproval: (_channel, _address, pending) => {
      cards.push(pending);
      return Promise.resolve(['http']);
    },
    publishDoc: () => Promise.reject(new Error('无')),
    deleteDoc: () => Promise.reject(new Error('无')),
  };
  /** 依赖。 */
  const deps: builders.TestDeps = { resources, files: new filesModule.Files(resources), ai, store: new storeModule.Store(':memory:'), secrets: new secretsModule.Secrets([]), approvals: new approvalsModule.Approvals(), out };
  return { deps, dir, cards };
}


/**
 * 收拾临时目录（Windows 上进程刚结束时文件可能还占着，多试几次）。
 * @param dir 目录。
 */
function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}


bunTest.test('审核：jmbots 自己的检查规矩直接放行；碰密钥文件的直接拒，都不问决策模型', async () => {
  /** 依赖（决策模型说有风险，但轮不到它）。 */
  const harness = await setup(0);
  try {
    /** 命令审核。 */
    const deps = harness.deps;
    const reviewer = builders.reviewerOf(deps);
    /** 发版。 */
    const release = await reviewer.reviewCommand({
      command: 'cd /d F:\\src\\jmbots && bun run release',
      workDir: harness.dir,
      task: '发版',
      askUser: false,
    });
    bunTest.expect(release.record.verdict).toBe('run');
    bunTest.expect(release.record.by).toBe('rule');
    bunTest.expect(release.record.decision).toBeUndefined();
    /** 读密钥。 */
    const secret = await reviewer.reviewCommand({
      command: 'type config.yaml',
      workDir: harness.dir,
      task: '看配置',
      askUser: true,
    });
    bunTest.expect(secret.record.verdict).toBe('reject');
    bunTest.expect(secret.record.rule).toContain('config.yaml');
    bunTest.expect(harness.cards).toHaveLength(0);
  } finally {
    cleanup(harness.dir);
  }
});


bunTest.test('决策模型认为安全：跑起来，等到 done，输出写进文件，tail 能看到', async () => {
  /** 依赖。 */
  const harness = await setup(0.9);
  try {
    /** 命令窗口。 */
    const runs = builders.runsOf(harness.deps);
    /** 发出去时的记录。 */
    const started = await runs.start(runInput(harness.dir, { command: 'echo hello-runs', why: '测试', from: 'claude' }));
    bunTest.expect(started.review.by).toBe('decision');
    bunTest.expect(['running', 'done']).toContain(started.status);
    /** 跑完的记录。 */
    const ended = await runs.wait(started.id, 10_000);
    bunTest.expect(ended?.status).toBe('done');
    bunTest.expect(ended?.code).toBe(0);
    bunTest.expect(ended?.from).toBe('claude');
    bunTest.expect(runs.tail(started.id)).toContain('hello-runs');
    bunTest.expect(fs.readFileSync(runs.logFile(started.id)!, 'utf8')).toContain('hello-runs');
    bunTest.expect(runs.list(5).map((item) => item.id)).toEqual([started.id]);
  } finally {
    cleanup(harness.dir);
  }
});


bunTest.test('决策模型认为有风险、没要问用户：不跑，记成 rejected，理由交回去，不发卡片', async () => {
  /** 依赖。 */
  const harness = await setup(0.05);
  try {
    /** 命令窗口。 */
    const runs = builders.runsOf(harness.deps);
    /** 记录。 */
    const record = await runs.start(runInput(harness.dir, { command: 'echo should-not-run' }));
    bunTest.expect(record.status).toBe('rejected');
    bunTest.expect(record.review.reason).toContain('有风险');
    bunTest.expect(record.review.reason).toContain('ask_user');
    bunTest.expect(runs.logFile(record.id)).toBeUndefined();
    bunTest.expect(harness.cards).toHaveLength(0);
  } finally {
    cleanup(harness.dir);
  }
});


bunTest.test('没配决策模型：不跑，说清是没配', async () => {
  /** 依赖。 */
  const harness = await setup(undefined);
  try {
    /** 记录。 */
    const record = await builders.runsOf(harness.deps).start(runInput(harness.dir, { command: 'echo x' }));
    bunTest.expect(record.status).toBe('rejected');
    bunTest.expect(record.review.reason).toContain('没配决策模型');
  } finally {
    cleanup(harness.dir);
  }
});


bunTest.test('ask_user：决策模型拿不准就发卡片（不挂会话），用户同意了才跑；拒绝就 rejected', async () => {
  /** 依赖。 */
  const harness = await setup(0.05);
  try {
    /** 命令窗口。 */
    const runs = builders.runsOf(harness.deps);
    /** 要用户同意的。 */
    const asked = await runs.start(runInput(harness.dir, { command: 'echo approved-run', askUser: true }));
    bunTest.expect(asked.status).toBe('pending');
    bunTest.expect(harness.cards).toHaveLength(1);
    bunTest.expect(harness.cards[0]?.sessionId).toBe('');
    bunTest.expect(harness.cards[0]?.command).toBe('echo approved-run');
    harness.deps.approvals.decide(asked.approvalId!, true, '测试');
    /** 同意后跑完。 */
    const ended = await runs.wait(asked.id, 10_000);
    bunTest.expect(ended?.status).toBe('done');
    bunTest.expect(ended?.review.by).toBe('user');
    bunTest.expect(runs.tail(asked.id)).toContain('approved-run');
    /** 要拒绝的。 */
    const refused = await runs.start(runInput(harness.dir, { command: 'echo refused-run', askUser: true }));
    harness.deps.approvals.decide(refused.approvalId!, false, '测试');
    bunTest.expect((await runs.wait(refused.id, 5000))?.status).toBe('rejected');
    bunTest.expect(runs.logFile(refused.id)).toBeUndefined();
  } finally {
    cleanup(harness.dir);
  }
});


bunTest.test('停下：在跑的连子进程一起杀，记成 stopped', async () => {
  /** 依赖。 */
  const harness = await setup(0.9);
  try {
    /** 命令窗口。 */
    const runs = builders.runsOf(harness.deps);
    /** 在跑的。 */
    const slow = await runs.start(runInput(harness.dir, { command: SLOW_COMMAND }));
    bunTest.expect(runs.stop(slow.id)?.status).toBe('stopped');
    /** 停下后结束的。 */
    const ended = await runs.wait(slow.id, 10_000);
    bunTest.expect(ended?.status).toBe('stopped');
    bunTest.expect(ended?.endedAt).toBeDefined();
  } finally {
    cleanup(harness.dir);
  }
}, 20_000);


bunTest.test('停下：在等用户的作废卡片，用户之后再点也不跑', async () => {
  /** 依赖。 */
  const harness = await setup(0.05);
  try {
    /** 命令窗口。 */
    const runs = builders.runsOf(harness.deps);
    /** 在等用户的。 */
    const asked = await runs.start(runInput(harness.dir, { command: 'echo never', askUser: true }));
    bunTest.expect(runs.stop(asked.id)?.status).toBe('stopped');
    bunTest.expect(harness.deps.approvals.list()).toHaveLength(0);
    bunTest.expect(harness.deps.approvals.decide(asked.approvalId!, true, '测试')).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 300));
    bunTest.expect(runs.get(asked.id)?.status).toBe('stopped');
    bunTest.expect(runs.logFile(asked.id)).toBeUndefined();
  } finally {
    cleanup(harness.dir);
  }
});


bunTest.test('超时：超过 timeoutSec 连子进程一起杀，记成 failed、timedOut', async () => {
  /** 依赖。 */
  const harness = await setup(0.9);
  try {
    /** 命令窗口。 */
    const runs = builders.runsOf(harness.deps);
    /** 一秒超时。 */
    const started = await runs.start(runInput(harness.dir, { command: SLOW_COMMAND, timeoutSec: 1 }));
    /** 结束的。 */
    const ended = await runs.wait(started.id, 15_000);
    bunTest.expect(ended?.status).toBe('failed');
    bunTest.expect(ended?.timedOut).toBe(true);
    bunTest.expect(ended?.error).toContain('超过 1 秒');
  } finally {
    cleanup(harness.dir);
  }
}, 20_000);


bunTest.test('目录不存在：不跑，说清楚', async () => {
  /** 依赖。 */
  const harness = await setup(0.9);
  try {
    /** 记录。 */
    const record = await builders.runsOf(harness.deps).start(runInput(harness.dir, { command: 'echo x', cwd: path.join(harness.dir, '没有这个目录') }));
    bunTest.expect(record.status).toBe('failed');
    bunTest.expect(record.error).toContain('目录不存在');
  } finally {
    cleanup(harness.dir);
  }
});


bunTest.test('程序重启：以前没跑完的记成 failed，跑完的原样留着', async () => {
  /** 依赖。 */
  const harness = await setup(0.9);
  try {
    /** 记录放哪。 */
    const dir = path.join(harness.dir, 'data', 'runs');
    fs.mkdirSync(dir, { recursive: true });
    /** 一条以前的记录。 */
    const base: runsModule.RunRecord = { id: '20261106080000000001', command: 'x', cwd: harness.dir, why: '', from: 'api', timeoutSec: 600, status: 'running', review: { by: 'rule', reason: '', ms: 0 }, createdAt: 1, log: path.join(dir, 'a.log') };
    fs.writeFileSync(path.join(dir, `${base.id}.json`), JSON.stringify(base));
    fs.writeFileSync(path.join(dir, '20261106080000000002.json'), JSON.stringify({ ...base, id: '20261106080000000002', status: 'done', code: 0 }));
    /** 重启后的命令窗口。 */
    const runs = builders.runsOf(harness.deps);
    bunTest.expect(runs.get(base.id)?.status).toBe('failed');
    bunTest.expect(runs.get(base.id)?.error).toContain('程序重启');
    bunTest.expect(runs.get('20261106080000000002')?.status).toBe('done');
    bunTest.expect(runs.list(10).map((item) => item.id)).toEqual(['20261106080000000002', base.id]);
  } finally {
    cleanup(harness.dir);
  }
});


/** 测试明确提供完整内部合同；省略字段仅是测试夹具的书写便利。 */
function runInput(
  cwd: string,
  patch: Partial<runsModule.RunInput>,
): runsModule.RunInput {
  return {
    command: 'echo test',
    cwd,
    timeoutSec: 600,
    why: '',
    from: 'api',
    askUser: false,
    ...patch,
  };
}
