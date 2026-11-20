/**
 * 审批卡片“要做什么”用决策模型顺带写的执行结果（decision/judge 的 want: ['what']）。
 * 跑法：bun test ./src7/plugins/approval/DecisionWhat.test.ts
 * 真的 Cordis + 真的 approval 插件；resources、bots、sessions 是只够它挂上的假服务，审核小会话的回答由假 sessions.ask 给；
 * 决策模型是测试里挂的假 decision/judge 监听，照 fakeDecision 回，不调任何模型。命令只审不跑。
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as requestEvents from '../../utils/RequestEvent.ts';
import { requestReview } from '../exec/Runs.ts';
import * as approvalModule from './index.ts';


/** 临时目录：数据目录、配置的可信目录、外面的目录。 */
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-decision-what-'));
const DATA = path.join(base, 'jmbotsData');
const TRUSTED = path.join(base, 'outwork');
const OUTSIDE = path.join(base, 'elsewhere');
for (const dir of [DATA, TRUSTED, OUTSIDE]) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 审核小会话回什么（假 sessions.ask 交回），和问了几次。 */
type FakeAnswer = { ok: boolean; reply: string };
const model: { reply: string; asked: number; wait?: () => Promise<FakeAnswer> } = {
  reply: '{"safe": false}',
  asked: 0,
};

/** 假决策模型回什么：结论和顺带写的执行结果（空串当没写）；wants 记下每次请求带的 want；fail 为 true 时接单后抛错。 */
const fakeDecision = {
  verdict: 'unsure' as 'allow' | 'deny' | 'unsure',
  what: '',
  wants: [] as unknown[],
  fail: false,
};


/** 假的 resources：approval 建表、算数据目录用到的几项。 */
class FakeResources extends cordis.Service {
  db = new Database(':memory:');
  root = DATA;
  raw = {};
  config = { providers: {} };
  constructor(ctx: cordis.Context) {
    super(ctx, 'resources');
  }
}

/** 假的 bots：一个机器人。 */
class FakeBots extends cordis.Service {
  constructor(ctx: cordis.Context) {
    super(ctx, 'bots');
  }
  list(): { name: string }[] {
    return [{ name: '周小灵' }];
  }
}

/** 假的 sessions：找不到会话；ask 照 model.reply 回。 */
class FakeSessions extends cordis.Service {
  constructor(ctx: cordis.Context) {
    super(ctx, 'sessions');
  }
  find(): { id: string; address: unknown }[] {
    return [];
  }
  ask(): Promise<{ ok: boolean; reply: string }> {
    model.asked += 1;
    if (model.wait !== undefined) return model.wait();

    return Promise.resolve({ ok: true, reply: model.reply });
  }
}


/** approval/result 回执。 */
type ApprovalReply = requestEvents.EventArg<'approval/result'>;

/** decision/judge-result 回执去掉 requestId（假决策模型交回的样子）。 */
type JudgeBody = Omit<requestEvents.EventArg<'decision/judge-result'>, 'requestId'>;

/**
 * 没人答时的退回：测试里不该走到，走到了就带个原因让断言看得出。
 * @param reason requestEvent 给的退回原因。
 */
function getMissing(reason: requestEvents.FallbackReason): ApprovalReply {
  return { requestId: '', error: `没人答：${reason}` };
}

/** 等待设置。 */
const options = { prefix: 'apr', timeoutMs: 5000, onFallback: getMissing };


/**
 * 假决策模型：记下请求带的 want，照 fakeDecision 回结论；what 非空才带。
 * @param request decision/judge 请求。
 * @returns 不带 requestId 的回执正文。
 */
function answerJudge(request: requestEvents.EventArg<'decision/judge'>): JudgeBody {
  fakeDecision.wants.push(request.want);
  if (fakeDecision.fail) throw new Error('假决策模型挂了');

  const body: JudgeBody = { verdict: fakeDecision.verdict, reason: '假决策模型' };
  if (fakeDecision.what !== '') {
    body.what = fakeDecision.what;
  }
  return body;
}


let app: cordis.Context;

beforeAll(async () => {
  app = new cordis.Context();
  await app.plugin(FakeResources);
  await app.plugin(FakeBots);
  await app.plugin(FakeSessions);
  //M 挂假决策模型：decision/judge 照 answerJudge 回，不挂真的 decision 插件。
  requestEvents.onRequestEvent(app, 'decision/judge', 'decision/judge-result', answerJudge);
  await app.plugin(approvalModule, { trusted_dirs: [TRUSTED] });
});

afterAll(async () => {
  await app.fiber.dispose();
  fs.rmSync(base, { recursive: true, force: true });
});


/**
 * 审一条写到可信目录外面的命令（执行目录在可信目录里），交回审的结论。
 * @param name 写到外面的文件名，每个测试一个，免得混。
 * @returns 审的结论。
 */
async function review(name: string): Promise<ApprovalReply['verdict']> {
  const target = path.join(OUTSIDE, name);
  const input = { kind: 'exec', payload: null, command: `copy a.txt "${target}"`, cwd: TRUSTED };
  const request = { action: 'review', input } as const;
  const result = await requestEvents.requestEvent(app, 'approval/request', 'approval/result', request, options);
  return result.verdict;
}

/**
 * 审一条要问用户的命令，取它登记的待确认卡片正文第一行（“要做什么”）。
 * @param name 写到外面的文件名。
 * @returns 卡片正文第一行。
 */
async function getWhatLine(name: string): Promise<string> {
  const verdict = await review(name);
  if (verdict?.result !== 'asked') throw new Error(`应该去问用户，实际是 ${JSON.stringify(verdict)}`);

  //M 照号找到刚登记的那件，取卡片正文第一行。
  const pending = app.approval.list().find((item) => item.id === verdict.id);
  if (pending === undefined) throw new Error('没找到刚登记的待确认');

  const lines = pending.card.reason.split('\n');
  return lines[0] ?? '';
}


describe('卡片“要做什么”：审核小会话 → 决策模型 → 说不清', () => {
  test('审核小会话没写、决策模型拿不准但写了：用决策模型的；请求带了 want: [what]', async () => {
    fakeDecision.verdict = 'unsure';
    fakeDecision.what = '把 a.txt 复制到外面的 a1.txt';
    fakeDecision.wants = [];
    model.reply = '{"safe": false, "risk": "出了目录"}';

    const line = await getWhatLine('a1.txt');
    expect(line).toBe('要做什么：把 a.txt 复制到外面的 a1.txt');
    expect(fakeDecision.wants).toEqual([['what']]);
  });

  test('两个都写了：审核小会话的优先', async () => {
    fakeDecision.what = '决策模型写的';
    model.reply = '{"safe": false, "what": "审核写的：把 a.txt 复制成 a2.txt", "risk": "出了目录"}';

    const line = await getWhatLine('a2.txt');
    expect(line).toBe('要做什么：审核写的：把 a.txt 复制成 a2.txt');
  });

  test('两个都没写：写“说不清会做成什么”带上命令', async () => {
    fakeDecision.what = '';
    model.reply = '{"safe": false, "risk": "出了目录"}';

    const line = await getWhatLine('a3.txt');
    expect(line).toContain('要做什么：说不清会做成什么（命令：copy a.txt');
  });

  test('决策模型接单后出错：当没问过，不用它的 what、不记成这一档的原因，照常问审核小会话', async () => {
    fakeDecision.verdict = 'unsure';
    fakeDecision.what = '不该用上';
    fakeDecision.fail = true;
    model.reply = '{"safe": false, "risk": "出了目录"}';
    model.asked = 0;

    try {
      const verdict = await review('a3b.txt');
      if (verdict?.result !== 'asked') throw new Error(`应该去问用户，实际是 ${JSON.stringify(verdict)}`);

      const pending = app.approval.list().find((item) => item.id === verdict.id);
      expect(pending?.card.reason).toContain('要做什么：说不清会做成什么');
      expect(pending?.card.reason).not.toContain('决策模型拿不准');
      expect(model.asked).toBe(1);
    } finally {
      fakeDecision.fail = false;
    }
  });
});


describe('放行规则不变', () => {
  test('决策模型放行时带了 what 也照旧放行，不问审核小会话、不弹卡片', async () => {
    fakeDecision.verdict = 'allow';
    fakeDecision.what = '把 a.txt 复制到外面';
    model.asked = 0;

    const verdict = await review('a4.txt');
    expect(verdict).toEqual({ result: 'pass', by: 'decision', reason: '决策模型认为安全：假决策模型' });
    expect(model.asked).toBe(0);
  });

  test('决策模型拒绝时带了 what 也照旧拒绝', async () => {
    fakeDecision.verdict = 'deny';
    fakeDecision.what = '把 a.txt 复制到外面';

    const verdict = await review('a5.txt');
    expect(verdict).toEqual({ result: 'reject', by: 'decision', reason: '假决策模型' });
  });
});


/** 按 exec 的真实入口审一条合成记录，测试环境未挂命令执行器。 */
function reviewFixture() {
  fakeDecision.verdict = 'unsure';
  fakeDecision.what = '';
  model.reply = '{"safe": false}';
  const input = { kind: 'test-review', command: '合成审核记录', cwd: OUTSIDE, payload: null };
  return input;
}


test('审核等候超时后，迟到的审核结果不能登记待确认', async () => {
  const input = reviewFixture();
  const began = Promise.withResolvers<void>();
  const modelReply = Promise.withResolvers<FakeAnswer>();
  const answered = Promise.withResolvers<void>();
  const waitingBefore = app.approval.list().map((item) => item.id);
  const dispose = app.on('approval/result', () => answered.resolve());
  model.wait = () => {
    began.resolve();
    return modelReply.promise;
  };

  vi.useFakeTimers();
  try {
    //M 暂停审核小会话，在虚拟时钟上走完 exec 的等待期限。
    const review = requestReview(app, input);
    await began.promise;
    vi.advanceTimersByTime(65_000);
    const verdict = await review;
    expect(verdict).toMatchObject({ result: 'reject', reason: '命令审核已超时' });

    //M 即便审核随后仍回了结果，也不能增加一张可同意的卡片。
    modelReply.resolve({ ok: true, reply: '{"safe": false}' });
    await answered.promise;
    expect(app.approval.list().map((item) => item.id)).toEqual(waitingBefore);
  } finally {
    modelReply.resolve({ ok: false, reply: '' });
    model.wait = undefined;
    dispose();
    vi.useRealTimers();
  }
});


test('审核截止时已登记的卡片作废，确认入口返回已超时', async () => {
  const input = reviewFixture();
  const notified = Promise.withResolvers<number>();
  const answered = Promise.withResolvers<void>();
  const disposeResult = app.on('approval/result', () => answered.resolve());
  vi.useFakeTimers();
  const disposeCard = app.on('approval/asked', (pending) => {
    //M 在登记通知与审核回执之间模拟截止，验证同一张卡片的作废状态。
    if (pending.kind !== input.kind) return;

    vi.advanceTimersByTime(65_000);
    notified.resolve(pending.id);
  });
  try {
    const verdict = await requestReview(app, input);
    expect(verdict.result).toBe('reject');
    const id = await notified.promise;
    await answered.promise;
    const decision = app.approval.decide(id, true, '合成测试');
    expect(decision).toBe(`待确认 #${String(id)} 命令审核已超时`);
    expect(app.approval.list().some((item) => item.id === id)).toBe(false);
  } finally {
    disposeCard();
    disposeResult();
    vi.useRealTimers();
  }
});
