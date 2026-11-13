/**
 * 分派（src/dispatch/Dispatch.ts）的离线测试：假的决策模型和常规模型，真的数据库和文件库。
 * 决策模型有把握就直接用（连打断一起）；拿不准交给常规模型；常规模型核对不过重跑；都不行程序兜底；带图只认能看图的模型。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import * as builders from './Builders.ts';


/** 假模型怎么回。 */
interface Fake {
  /** 常规模型每次回的文字，按顺序。 */
  replies: string[];
  /** 决策模型的回答；不写就是没配决策模型。 */
  decide?: (questions: Record<string, piAi.ClassifierQuestion>) => Record<string, piAi.ClassifierAnswer>;
}


/**
 * 建依赖：一个机器人周小灵，两个模型（一个能看图）。
 * @param fake 假模型怎么回。
 * @returns 依赖和常规模型被调的次数。
 */
async function setup(fake: Fake): Promise<{ deps: builders.TestDeps; store: storeModule.Store; chats: () => number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-dispatch-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'providers: {}\ndefault_model: magpie/flash\nbots:\n  - name: 周小灵\n    language: zh\n');
  const resources = await resourcesModule.Resources.load(dir);
  const files = new filesModule.Files(resources);
  await files.ensureBot('周小灵');
  const store = new storeModule.Store(':memory:');
  /** 常规模型调了几次。 */
  let chats = 0;
  const ai = builders.fakeAi({
    chat: (input) => {
      const text = fake.replies[chats] ?? '不是 JSON';
      chats += 1;
      const message = { role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'magpie', model: 'flash', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } as piAi.AssistantMessage;
      return Promise.resolve({ message, text, thinking: '', toolCalls: [], ms: 1, request: { model: input.model, thinkingAsked: 'low', thinking: 'low', system: '', tools: [], messages: [] } });
    },
    decide: (input) => Promise.resolve({ answers: fake.decide?.(input.questions) ?? {}, ms: 5, request: { model: 'magpie/jev', state: input.state, questions: input.questions } }),
    hasDecision: () => fake.decide !== undefined,
    listModels: () => [
      { id: 'magpie/flash', name: 'flash', kind: 'chat', contextWindow: 128_000, thinking: ['off', 'low', 'high'], vision: false, price: { input: 0, output: 0 } },
      { id: 'magpie/hy3', name: 'hy3', kind: 'chat', contextWindow: 192_000, thinking: ['low', 'high'], vision: true, price: { input: 0, output: 0 } },
    ],
  });
  const out: depsModule.Outlet = { send: () => Promise.resolve(), sendApproval: () => Promise.resolve([]), publishDoc: () => Promise.reject(new Error('无')), deleteDoc: () => Promise.reject(new Error('无')) };
  return { deps: { resources, store, files, ai, secrets: new secretsModule.Secrets([]), approvals: new approvalsModule.Approvals(), out }, store, chats: () => chats };
}


/**
 * 记一条收件。
 * @param store 数据库。
 * @param text 原话。
 */
function add(store: storeModule.Store, text: string): storeModule.MessageRow {
  return store.addMessage({ bot: '周小灵', channel: 'http', source: '测试', address: {}, file: 'F:/x/m.md', text });
}


bunTest.describe('分派', () => {
  bunTest.test('工作区名建不成文件夹：核对不过，重跑', async () => {
    const good = '{"interrupt": [], "workspace": "视频", "session": "new", "title": "剪片", "model": "magpie/flash", "reason": "新的事"}';
    const { deps, store } = await setup({ replies: [good.replace('视频', '视频: 剪辑'), good.replace('视频', '..'), good] });
    const record = await builders.dispatcherOf(deps).dispatch('周小灵', [add(store, '剪个片')]);
    bunTest.expect(record.result.by).toBe('llm');
    bunTest.expect(record.result.workspace).toBe('视频');
    bunTest.expect(record.checks).toHaveLength(2);
  });

  bunTest.test('常规模型卡住：不等了，程序兜底', async () => {
    const { deps, store } = await setup({ replies: [] });
    /** 原来的假模型库。 */
    const old = deps.ai;
    deps.ai = builders.fakeAi({
      decide: (input) => old.decide(input),
      hasDecision: () => old.hasDecision(),
      listModels: () => old.listModels(),
      chat: () => new Promise(() => undefined),
    });
    const record = await builders.dispatcherOf(deps).dispatch('周小灵', [add(store, '干活')], 30);
    bunTest.expect(record.result.by).toBe('fallback');
    bunTest.expect(record.checks.join('\n')).toContain('还没定下来');
  });

  bunTest.test('没配决策模型：常规模型定，新开会话', async () => {
    const { deps, store } = await setup({ replies: ['{"interrupt": [], "workspace": "代码", "workspace_description": "改代码", "session": "new", "title": "改登录页", "model": "magpie/flash", "thinking": "", "reason": "新的事"}'] });
    const record = await builders.dispatcherOf(deps).dispatch('周小灵', [add(store, '把登录页改一下')]);
    bunTest.expect(record.result).toMatchObject({ by: 'llm', session: 'new', workspace: '代码', title: '改登录页', model: 'magpie/flash', workspaceDescription: '改代码' });
    bunTest.expect(record.llm?.request.input).toContain('# 新消息');
    bunTest.expect(record.llm?.request.input.indexOf('# 可用的模型')).toBe(0);
    bunTest.expect(record.decisionModel).toBeUndefined();
  });

  bunTest.test('核对不过就重跑：会话不是这个机器人的，第二次改对', async () => {
    const { deps, store, chats } = await setup({
      replies: ['{"session": "123", "workspace": "日常", "model": ""}', '{"interrupt": [], "workspace": "日常", "session": "new", "title": "问天气", "model": "magpie/flash", "reason": "新的事"}'],
    });
    const record = await builders.dispatcherOf(deps).dispatch('周小灵', [add(store, '今天天气')]);
    bunTest.expect(chats()).toBe(2);
    bunTest.expect(record.llm?.reruns).toBe(1);
    bunTest.expect(record.checks).toEqual(['会话 123 不是这个机器人的']);
    bunTest.expect(record.result.by).toBe('llm');
  });

  bunTest.test('常规模型一直不合格：程序兜底新开「（未命名）」，用默认模型', async () => {
    const { deps, store } = await setup({ replies: ['随便说说', '还是不是 JSON', '{}'] });
    const record = await builders.dispatcherOf(deps).dispatch('周小灵', [add(store, '你好')]);
    bunTest.expect(record.result).toMatchObject({ by: 'fallback', session: 'new', title: '（未命名）', model: 'magpie/flash', workspace: '日常', interrupt: [] });
    bunTest.expect(record.llm?.error).toContain('重跑 2 次还没通过核对');
  });

  bunTest.test('带图：挑了看不了图的模型会被拦下；兜底换成能看图的', async () => {
    const { deps, store } = await setup({ replies: ['{"workspace": "日常", "session": "new", "title": "看图", "model": "magpie/flash"}', '{"workspace": "日常", "session": "new", "title": "看图", "model": "magpie/flash"}', '{"workspace": "日常", "session": "new", "title": "看图", "model": "magpie/flash"}'] });
    const record = await builders.dispatcherOf(deps).dispatch('周小灵', [add(store, '看看 @F:/x/m_1.png')]);
    bunTest.expect(record.checks[0]).toContain('看不了图');
    bunTest.expect(record.result).toMatchObject({ by: 'fallback', model: 'magpie/hy3' });
  });

  bunTest.test('决策模型有把握：直接追加到那个会话并打断它，不调常规模型', async () => {
    /** 运行中的会话。 */
    let running = '';
    const { deps, store, chats } = await setup({
      replies: [],
      decide: (questions) => {
        const route = questions.route as piAi.ClassifierChoiceQuestion;
        const key = Object.keys(route.criteria).find((item) => item !== 'new')!;
        return { route: { type: 'choice', choice: key, probabilities: { [key]: 0.95, new: 0.05 }, confidence: 0.95 }, interrupt: { type: 'bool', probability: 0.91 } };
      },
    });
    const session = store.createSession({ bot: '周小灵', workspace: '代码', title: '改写旧文档', model: 'magpie/flash', thinking: null });
    store.beginRun(session.id);
    running = session.id;
    const record = await builders.dispatcherOf(deps).dispatch('周小灵', [add(store, '等一下，先别改了')]);
    bunTest.expect(chats()).toBe(0);
    bunTest.expect(record.result).toMatchObject({ by: 'decision', session: running, interrupt: [running], workspace: '代码', model: '' });
    bunTest.expect(record.decisionModel?.used).toBe(true);
    bunTest.expect(record.decisionModel?.options.find((option) => option.session === running)?.probability).toBe(0.95);
  });

  bunTest.test('决策模型拿不准：交给常规模型，记下为什么没用', async () => {
    const { deps, store } = await setup({
      replies: ['{"interrupt": [], "workspace": "日常", "session": "new", "title": "别的事", "model": "magpie/flash", "reason": "新的事"}'],
      decide: (questions) => {
        const route = questions.route as piAi.ClassifierChoiceQuestion;
        const key = Object.keys(route.criteria).find((item) => item !== 'new')!;
        return { route: { type: 'choice', choice: key, probabilities: { [key]: 0.55, new: 0.45 }, confidence: 0.55 } };
      },
    });
    store.createSession({ bot: '周小灵', workspace: '日常', title: '旧的', model: 'magpie/flash', thinking: null });
    const record = await builders.dispatcherOf(deps).dispatch('周小灵', [add(store, '另一件事')]);
    bunTest.expect(record.decisionModel?.used).toBe(false);
    bunTest.expect(record.decisionModel?.why).toContain('拿不准');
    bunTest.expect(record.result.by).toBe('llm');
  });
});


bunTest.describe('分派：待审核的命令', () => {
  bunTest.test('有待审核：现状列出待审核、跳过决策模型，常规模型照走', async () => {
    //M 配了决策模型也不该走：待审核要由常规模型判断“新消息是不是依赖它”，决策模型的题里没有这一问。
    /** 决策模型被调了几次。 */
    let decisions = 0;
    const { deps, store } = await setup({
      replies: ['{"interrupt": [], "workspace": "日常", "session": "new", "title": "别的活", "model": "magpie/flash", "reason": "新的事"}'],
      decide: () => {
        decisions += 1;
        return {};
      },
    });
    store.createSession({ bot: '周小灵', workspace: '日常', title: '旧会话', model: 'magpie/flash', thinking: null });
    /** 待确认。 */
    const asked = deps.approvals.ask({ bot: '周小灵', sessionId: 's1', command: 'del dist', workDir: 'F:/w', review: { what: '删目录', risk: '删了', advice: '别删' } });
    const record = await builders.dispatcherOf(deps).dispatch('周小灵', [add(store, '别的活')]);
    bunTest.expect(decisions).toBe(0);
    bunTest.expect(record.decisionModel).toBeUndefined();
    bunTest.expect(record.llm?.request.input).toContain('# 待审核的命令');
    bunTest.expect(record.llm?.request.input).toContain(`#${asked.id}`);
    bunTest.expect(record.result.by).toBe('llm');
    bunTest.expect(deps.approvals.list()).toHaveLength(1);
  });

  bunTest.test('wait_for 指向存在的待确认：结论带 waitFor', async () => {
    const fake: Fake = { replies: [] };
    const { deps, store } = await setup(fake);
    /** 待确认。 */
    const asked = deps.approvals.ask({ bot: '周小灵', sessionId: 's1', command: 'bun run build', workDir: 'F:/w', review: { what: '构建', risk: '慢', advice: '等' } });
    fake.replies.push(`{"interrupt": [], "workspace": "日常", "session": "new", "title": "等审核", "model": "magpie/flash", "wait_for": ${asked.id}, "reason": "等构建审核"}`);
    const record = await builders.dispatcherOf(deps).dispatch('周小灵', [add(store, '构建完再接着做')]);
    bunTest.expect(record.result.waitFor).toBe(asked.id);
    bunTest.expect(record.result.by).toBe('llm');
    bunTest.expect(record.llm?.value?.wait_for).toBe(asked.id);
  });

  bunTest.test('wait_for 指向不存在的待确认：核对不过，重跑后合法新开', async () => {
    const { deps, store, chats } = await setup({
      replies: [
        '{"interrupt": [], "workspace": "日常", "session": "new", "title": "等审核", "model": "magpie/flash", "wait_for": 99, "reason": "等"}',
        '{"interrupt": [], "workspace": "日常", "session": "new", "title": "别的事", "model": "magpie/flash", "reason": "新的事"}',
      ],
    });
    //M 先有一条真的待确认 #1，99 肯定不在里面。
    deps.approvals.ask({ bot: '周小灵', sessionId: 's1', command: 'del a', workDir: 'F:/w', review: { what: '删文件', risk: '删了', advice: '别删' } });
    const record = await builders.dispatcherOf(deps).dispatch('周小灵', [add(store, '做事')]);
    bunTest.expect(chats()).toBe(2);
    bunTest.expect(record.checks.join('\n')).toContain('wait_for 写的 #99 不在待审核的命令里');
    bunTest.expect(record.llm?.reruns).toBe(1);
    bunTest.expect(record.result.waitFor).toBeUndefined();
    bunTest.expect(record.result).toMatchObject({ by: 'llm', session: 'new', title: '别的事' });
  });
});
