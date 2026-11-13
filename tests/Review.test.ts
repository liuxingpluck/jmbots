/**
 * 复盘（src/capabilities/Review.ts）的离线测试（docs/界面/任务书/发0.2.9_DSH.md 第 1 步）：
 * 有会话在跑、已有复盘卡片在等时不动；空闲时挑最早一行没复盘的，调一次模型（不带工具）、发一张待确认；
 * 用户同意才写进公共记忆 memory/复盘/，拒绝不写；都复盘过不动；模型出错也把这一行记成看过。
 * 全部用临时运行时和假模型，不读真实配置、不联网。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import type * as model from '../src/capabilities/Model.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import * as builders from './Builders.ts';


/** 测试用的机器人名。 */
const BOT = '小测';

/** 模型的固定建议。 */
const ADVICE = '建议：同类事先看记忆和索引，再去读文件。预计快一半。';


/** 一套测试用的临时运行时和依赖。 */
interface Harness {
  /** 临时运行时目录。 */
  dir: string;
  /** 资源。 */
  resources: resourcesModule.Resources;
  /** 依赖。 */
  deps: builders.TestDeps;
  /** chat 被调了几次。 */
  chats: number;
  /** chat 收到的请求。 */
  requests: model.ChatInput[];
  /** 发出去的审核卡片。 */
  sent: { channel: string; address: Record<string, unknown>; pending: approvalsModule.PendingApproval }[];
  /** 这次 chat 回什么。 */
  reply: string;
  /** 这次 chat 是不是报错。 */
  fail: boolean;
}


/**
 * 建依赖：临时运行时里写最小 config.yaml，真的资源、文件库、内存数据库、待确认登记表，假的模型和渠道。
 * @returns 临时运行时和依赖。
 */
async function setup(): Promise<Harness> {
  /** 临时运行时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-review-'));
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    ['providers: {}', 'default_model: fake/model', 'bots:', `  - name: ${BOT}`, '    language: zh', 'engine:', '  wrapup_model: fake/model'].join('\n'),
  );
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  /** 资源。 */
  const resources = await resourcesModule.Resources.load(dir);
  /** 文件库。 */
  const files = new filesModule.Files(resources);
  await files.ensureBot(BOT);
  /** 测试记录。 */
  const harness: Harness = {
    dir,
    resources,
    deps: undefined as unknown as builders.TestDeps,
    chats: 0,
    requests: [],
    sent: [],
    reply: ADVICE,
    fail: false,
  };
  /** 假模型：chat 按 reply/fail 回，decide 用不到。 */
  const ai = builders.fakeAi({
    chat: (input) => {
      harness.chats += 1;
      harness.requests.push(input);
      if (harness.fail) {
        return Promise.resolve({ message: {} as piAi.AssistantMessage, text: '', thinking: '', toolCalls: [], error: '模型爆了', ms: 1, request: { model: input.model, thinkingAsked: 'off', thinking: 'off', system: '', tools: [], messages: [] } });
      }
      /** 假回复。 */
      const message = { role: 'assistant', content: [{ type: 'text', text: harness.reply }], api: 'openai-completions', provider: 'fake', model: 'fake/model', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } as piAi.AssistantMessage;
      return Promise.resolve({ message, text: harness.reply, thinking: '', toolCalls: [], ms: 1, request: { model: input.model, thinkingAsked: 'off', thinking: 'off', system: '', tools: [], messages: [] } });
    },
    decide: () => Promise.reject(new Error('复盘测试不该调决策模型')),
    hasDecision: () => false,
    listModels: () => [{ id: 'fake/model', name: 'fake', kind: 'chat', contextWindow: 100_000, thinking: ['off', 'high'], price: { input: 0, output: 0 } }],
  });
  /** 假渠道：记下审核卡片。 */
  const out: depsModule.Outlet = {
    send: () => Promise.resolve(),
    sendApproval: (channel, address, pending) => {
      harness.sent.push({ channel, address, pending });
      return Promise.resolve([]);
    },
    publishDoc: () => Promise.reject(new Error('无')),
    deleteDoc: () => Promise.reject(new Error('无')),
  };
  harness.deps = { resources, files, ai, store: new storeModule.Store(':memory:'), secrets: new secretsModule.Secrets([]), approvals: new approvalsModule.Approvals(), out };
  return harness;
}


/**
 * 往 data/overtime.jsonl 写一行。
 * @param harness 测试环境。
 * @param index 第几条（从 1 数，用来造不同的文字和时间）。
 */
function writeOvertime(harness: Harness, index: number): void {
  /** 一行。 */
  const line = {
    at: Date.UTC(2026, 10, 6, 8, index),
    bot: BOT,
    sessionTitle: `任务${index}`,
    text: `第${index}件事：做太久了`,
    stage: 'done',
    usedMs: 600_000,
    timings: { dispatchMs: 1000, modelMs: 500_000, steps: 20, tools: [{ name: 'read', count: 2, ms: 10_000 }] },
  };
  fs.appendFileSync(path.join(harness.dir, 'data', 'overtime.jsonl'), `${JSON.stringify(line)}\n`);
}


/**
 * 读复盘进度文件里的行数。
 * @param harness 测试环境。
 */
function reviewedLines(harness: Harness): number {
  /** 正文。 */
  const text = fs.existsSync(path.join(harness.dir, 'data', 'overtime_reviewed.json')) ? fs.readFileSync(path.join(harness.dir, 'data', 'overtime_reviewed.json'), 'utf8') : '{}';
  return Number(text.match(/\d+/)?.[0] ?? 0);
}


/**
 * 等到条件成立（最多 5 秒）；等不到就报错。
 * @param condition 条件。
 * @param what 在等什么。
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let index = 0; index < 500; index += 1) {
    if (condition()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`等不到：${what}`);
}


bunTest.describe('复盘 checkReview', () => {
  bunTest.test('有会话在跑时什么也不做', async () => {
    /** 测试环境。 */
    const harness = await setup();
    writeOvertime(harness, 1);
    /** 一个在跑的会话。 */
    const session = harness.deps.store.createSession({ bot: BOT, workspace: '日常', title: '在跑的事', model: 'fake/model', thinking: 'off' });
    harness.deps.store.beginRun(session.id);
    await builders.runReviewOf(harness.deps).check();
    bunTest.expect(harness.chats).toBe(0);
    bunTest.expect(harness.sent.length).toBe(0);
    bunTest.expect(reviewedLines(harness)).toBe(0);
  });

  bunTest.test('空闲时挑最早一行没复盘的：调一次模型（tools 是空的），发一张复盘建议卡，记到下一行', async () => {
    /** 测试环境。 */
    const harness = await setup();
    writeOvertime(harness, 1);
    writeOvertime(harness, 2);
    /** 同一个进程里记着的。 */
    const review = builders.runReviewOf(harness.deps);
    await review.check();
    //M 只调一次模型，且不带工具。
    bunTest.expect(harness.chats).toBe(1);
    bunTest.expect(harness.requests[0]!.tools.length).toBe(0);
    //M 发了一张卡片：sessionId 是空，标题以“复盘建议”开头，内容是建议。
    bunTest.expect(harness.sent.length).toBe(1);
    bunTest.expect(harness.sent[0]!.channel).toBe('http');
    bunTest.expect(harness.sent[0]!.pending.sessionId).toBe('');
    bunTest.expect(harness.sent[0]!.pending.title?.startsWith('复盘建议')).toBe(true);
    bunTest.expect(harness.sent[0]!.pending.command).toBe(ADVICE);
    bunTest.expect(harness.deps.approvals.list().length).toBe(1);
    //M 选的是第一行，记到第 1 行；再调一次不重复发。
    bunTest.expect(reviewedLines(harness)).toBe(1);
    await review.check();
    bunTest.expect(harness.chats).toBe(1);
    bunTest.expect(harness.sent.length).toBe(1);
  });

  bunTest.test('有复盘卡片在等时不出新的', async () => {
    /** 测试环境。 */
    const harness = await setup();
    writeOvertime(harness, 1);
    writeOvertime(harness, 2);
    /** 同一个进程里记着的。 */
    const review = builders.runReviewOf(harness.deps);
    await review.check();
    bunTest.expect(harness.sent.length).toBe(1);
    //M 卡片还在等，第二次调用不再出新的。
    await review.check();
    bunTest.expect(harness.chats).toBe(1);
    bunTest.expect(harness.sent.length).toBe(1);
    bunTest.expect(harness.deps.approvals.list().length).toBe(1);
  });

  bunTest.test('用户同意：memory/复盘/ 下多一个文件，里面有建议、耗时和“效果”一节', async () => {
    /** 测试环境。 */
    const harness = await setup();
    writeOvertime(harness, 1);
    /** 同一个进程里记着的。 */
    const review = builders.runReviewOf(harness.deps);
    await review.check();
    /** 那条待确认。 */
    const pending = harness.deps.approvals.list()[0]!;
    harness.deps.approvals.decide(pending.id, true, '测试');
    /** 复盘目录。 */
    const reviewDir = path.join(harness.dir, 'memory', '复盘');
    await until(() => fs.existsSync(reviewDir) && fs.readdirSync(reviewDir).length === 1, '复盘文件写出来');
    /** 文件。 */
    const file = path.join(reviewDir, fs.readdirSync(reviewDir)[0]!);
    /** 正文。 */
    const text = fs.readFileSync(file, 'utf8');
    bunTest.expect(text).toContain(ADVICE);
    bunTest.expect(text).toContain('用了 10 分 0 秒');
    bunTest.expect(text).toContain('## 效果');
  });

  bunTest.test('用户拒绝：不写', async () => {
    /** 测试环境。 */
    const harness = await setup();
    writeOvertime(harness, 1);
    /** 同一个进程里记着的。 */
    const review = builders.runReviewOf(harness.deps);
    await review.check();
    /** 那条待确认。 */
    const pending = harness.deps.approvals.list()[0]!;
    harness.deps.approvals.decide(pending.id, false, '测试');
    await Bun.sleep(50);
    bunTest.expect(fs.existsSync(path.join(harness.dir, 'memory', '复盘'))).toBe(false);
    bunTest.expect(reviewedLines(harness)).toBe(1);
  });

  bunTest.test('都复盘过了什么也不做', async () => {
    /** 测试环境。 */
    const harness = await setup();
    writeOvertime(harness, 1);
    writeOvertime(harness, 2);
    fs.writeFileSync(path.join(harness.dir, 'data', 'overtime_reviewed.json'), JSON.stringify({ lines: 2 }));
    await builders.runReviewOf(harness.deps).check();
    bunTest.expect(harness.chats).toBe(0);
    bunTest.expect(harness.sent.length).toBe(0);
    bunTest.expect(reviewedLines(harness)).toBe(2);
  });

  bunTest.test('模型出错：不发卡片，但这一行也算看过（不会反复问）', async () => {
    /** 测试环境。 */
    const harness = await setup();
    writeOvertime(harness, 1);
    harness.fail = true;
    /** 同一个进程里记着的。 */
    const review = builders.runReviewOf(harness.deps);
    await review.check();
    bunTest.expect(harness.chats).toBe(1);
    bunTest.expect(harness.sent.length).toBe(0);
    bunTest.expect(harness.deps.approvals.list().length).toBe(0);
    bunTest.expect(reviewedLines(harness)).toBe(1);
    //M 再调一次也不会回到这一行；只有一行，所以什么也不做。
    await review.check();
    bunTest.expect(harness.chats).toBe(1);
    bunTest.expect(harness.sent.length).toBe(0);
  });
});
