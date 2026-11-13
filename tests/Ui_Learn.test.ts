/**
 * 学习界面「回放真实消息」的离线测试（docs/界面/07_消息流转学习界面.md 第 9 节）：
 *   buildTrace 把一条收件、分派记录、会话消息拼成场景：每步格式齐全、ref 都在 trace-anchors.json 里、
 *   审核/回复/收尾的子步骤、密钥一律换成替身；没进会话、会话里找不到、一次运行超过 60 步、
 *   没这条消息（含空 app 的 400/404）；以及每个锚点都还指着真实源码。
 * 只用假的 store（getMessage/getSession）和 secretsModule.Secrets，不建运行时、不调模型、不起服务。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as bunTest from 'bun:test';
import * as fastify from 'fastify';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import type * as storeModule from '../src/capabilities/Store.ts';
import type * as dispatchModule from '../src/dispatch/Dispatch.ts';
import * as httpLearn from '../src/channels/HttpLearn.ts';
import type * as learnTypes from '../src/channels/LearnTypes.ts';


/** 仓库根（本文件在 tests/ 下）。 */
const ROOT = path.join(import.meta.dir, '..');

/** 回放用的锚点表。 */
const ANCHORS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'trace-anchors.json'), 'utf8')) as Record<string, { file: string; find: string }>;

/** 测试用的假密钥（不是任何真密钥；长度够 8 才会被 mask）。 */
const FAKE_KEY = 'FAKE_SECRET_0123456789_abcdefgh';

/** 固定的时间点，省得场景里到处出现不同的时间。 */
const NOW = 1793963427418;


/**
 * 假的依赖：只要 getMessage、getSession 和密钥替身表。
 * @param message 有这条消息时给。
 * @param session 有这个会话时给。
 * @returns 依赖（buildTrace 用得着的部分）。
 */
function depsOf(message: storeModule.MessageRow | undefined, session: storeModule.SessionRow | undefined): httpLearn.TraceDeps {
  /** 假的 store：只有 buildTrace 用的两个读方法。 */
  const store = {
    getMessage: (id: number): storeModule.MessageRow | undefined => (message?.id === id ? message : undefined),
    getSession: (id: string): storeModule.SessionRow | undefined => (session?.id === id ? session : undefined),
  };
  return { store, secrets: new secretsModule.Secrets([FAKE_KEY]) };
}


/**
 * 造一条收件行。
 * @param input 要覆盖的字段。
 * @returns 收件行。
 */
function makeMessage(input: { id: number; text: string; dispatch: unknown; sessionId: string | null; replies: storeModule.Reply[] }): storeModule.MessageRow {
  return {
    id: input.id,
    bot: '周小灵',
    channel: 'http',
    source: '甲',
    address: {},
    file: `F:/message/${String(input.id)}.md`,
    text: input.text,
    status: input.sessionId ? 'taken' : 'queued',
    sessionId: input.sessionId,
    dispatch: input.dispatch,
    replies: input.replies,
    createdAt: NOW,
    updatedAt: NOW,
  };
}


/**
 * 造一条回复。
 * @param text 回了什么。
 * @returns 回复。
 */
function reply(text: string): storeModule.Reply {
  return { at: NOW + 1000, session: { id: 's1', title: '一件事', file: 'F:/sessions/s1.md' }, text };
}


/**
 * 造一个完整的分派记录：决策模型、常规模型小循环、核对、结论都带。
 * @param id 消息号。
 * @returns 分派记录。
 */
function makeDispatch(id: number): dispatchModule.DispatchRecord {
  return {
    messageIds: [id],
    startedAt: NOW,
    ms: 12,
    decisionModel: {
      model: 'magpie/test',
      ms: 3,
      question: `要不要新开会话？密钥 ${FAKE_KEY}`,
      options: [{ label: '新开', session: 'new', probability: 0.9 }],
      used: true,
      why: '够确定',
      state: '',
    },
    llm: {
      steps: [{
        at: NOW,
        ms: 5,
        effort: 'off',
        text: `小循环文字 ${FAKE_KEY}`,
        thinking: '',
        calls: [{ name: 'session_list', args: { keyword: FAKE_KEY }, result: `结果 ${FAKE_KEY}`, isError: false }],
      }],
      reruns: 0,
      request: { model: 'magpie/test', system: '', input: `输入 ${FAKE_KEY}`, tools: ['session_list'] },
    },
    checks: [`核对没过 ${FAKE_KEY}`],
    result: {
      interrupt: [],
      workspace: '日常',
      workspaceDescription: '',
      session: 'new',
      title: `会话标题 ${FAKE_KEY}`,
      model: 'magpie/test',
      thinking: '',
      reason: `理由 ${FAKE_KEY}`,
      by: 'decision',
    },
  };
}


/**
 * 造一次工具调用。
 * @param id 调用号。
 * @param name 工具名。
 * @param args 参数（把假密钥塞进去，验证会被换掉）。
 * @returns Pi 格式的工具调用。
 */
function toolCall(id: string, name: string, args: Record<string, unknown>): piAi.ToolCall {
  return { type: 'toolCall', id, name, arguments: args } as piAi.ToolCall;
}


/**
 * 造一条助手消息（一个工具调用，带用量）。
 * @param call 工具调用。
 * @returns 会话里存的一条消息。
 */
function assistant(call: piAi.ToolCall): storeModule.StoredMessage {
  /** Pi 格式的助手消息。 */
  const message = {
    role: 'assistant',
    content: [call],
    api: 'openai-completions',
    provider: 'magpie',
    model: 'test',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: NOW,
  } as unknown as piAi.Message;
  return { message, run: 1 };
}


/**
 * 造一条工具结果。
 * @param callId 对应的调用号。
 * @param name 工具名。
 * @param text 结果文字。
 * @param details 额外的记录（exec 的审核记录放这里）。
 * @returns 会话里存的一条消息。
 */
function toolResult(callId: string, name: string, text: string, details?: unknown): storeModule.StoredMessage {
  /** Pi 格式的工具结果。 */
  const message = {
    role: 'toolResult',
    toolCallId: callId,
    toolName: name,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: NOW,
    ...(details === undefined ? {} : { details }),
  } as unknown as piAi.Message;
  return { message, run: 1 };
}


/**
 * 造一个会话行。
 * @param input 会话标题、消息、运行记录。
 * @returns 会话行。
 */
function makeSession(input: { title: string; messages: storeModule.StoredMessage[]; runs?: storeModule.RunInfo[] }): storeModule.SessionRow {
  return {
    id: 's1',
    bot: '周小灵',
    workspace: '日常',
    title: input.title,
    summary: '',
    model: 'magpie/test',
    thinking: null,
    status: 'idle',
    messages: input.messages,
    tokens: 0,
    interrupt: null,
    replyTo: 1,
    runs: input.runs ?? [{ n: 1, startedAt: NOW, steps: 2 }],
    sensedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}


/**
 * 把一层层子步骤摊平，方便递归检查每一步。
 * @param steps 步骤。
 * @returns 所有步骤（含子步骤）。
 */
function allSteps(steps: learnTypes.Step[]): learnTypes.Step[] {
  return steps.flatMap((step) => [step, ...allSteps(step.children ?? [])]);
}


bunTest.describe('学习界面：回放真实消息（HttpLearn）', () => {
  bunTest.test('完整一条消息：每步格式齐全、ref 都在锚点表里、审核/回复/收尾、密钥不漏', () => {
    /** 消息号。 */
    const id = 12;
    /** 原话、工具参数、工具结果、会话标题里都塞了假密钥。 */
    const message = makeMessage({
      id,
      text: `用户说 ${FAKE_KEY} 请帮个忙`,
      dispatch: makeDispatch(id),
      sessionId: 's1',
      replies: [reply('第一句回复'), reply('第二句回复')],
    });
    /** exec 的审核记录（工具结果的 details）。 */
    const review = { verdict: 'run', by: 'rule', reason: `按规矩执行 ${FAKE_KEY}`, ms: 3 };
    const session = makeSession({
      title: `会话标题 ${FAKE_KEY}`,
      messages: [
        { message: { role: 'user', content: `用户说 ${FAKE_KEY} 请帮个忙`, timestamp: NOW } as unknown as piAi.Message, run: 1, messageIds: [id] },
        assistant(toolCall('c1', 'exec', { command: `echo ${FAKE_KEY}` })),
        toolResult('c1', 'exec', `命令输出 ${FAKE_KEY}`, review),
        assistant(toolCall('c2', 'reply', { text: `回话 ${FAKE_KEY}` })),
        toolResult('c2', 'reply', '回复已发出'),
      ],
    });
    /** 拼出来的场景。 */
    const scene = httpLearn.buildTrace(depsOf(message, session), id)!;
    bunTest.expect(scene).toBeDefined();
    bunTest.expect(scene.id).toBe(`trace-${String(id)}`);
    bunTest.expect(scene.flows.length).toBeGreaterThan(0);

    //M 每一步（含所有子步骤，递归）title、phase、func 都得是字符串。
    /** 摊平后的全部步骤。 */
    const steps = allSteps(scene.steps);
    bunTest.expect(steps.length).toBeGreaterThan(10);
    for (const step of steps) {
      bunTest.expect(typeof step.title).toBe('string');
      bunTest.expect(typeof step.phase).toBe('string');
      bunTest.expect(typeof step.func).toBe('string');
    }
    //M 每个出现的 ref 都是 trace-anchors.json 的键；没 ref 的步骤跳过（中途排进来的消息那种）。
    /** 锚点键。 */
    const keys = new Set(Object.keys(ANCHORS));
    for (const step of steps) {
      if (step.ref !== undefined) {
        bunTest.expect(keys.has(step.ref), `ref ${step.ref} 不在 tests/trace-anchors.json 里`).toBe(true);
      }
    }
    //M 审核是 exec 那步的子步骤；reply 工具那步的 ref 是 reply；最后两步是两条回复（addReply）。
    /** 所有子步骤（不含顶层）。 */
    const childSteps = scene.steps.flatMap((step) => allSteps(step.children ?? []));
    bunTest.expect(childSteps.some((step) => step.ref === 'review')).toBe(true);
    /** reply 工具那一步。 */
    const replyStep = childSteps.find((step) => step.func === "ToolBox.run('reply')");
    bunTest.expect(replyStep?.ref).toBe('reply');
    bunTest.expect(scene.steps.slice(-2).map((step) => step.ref)).toEqual(['addReply', 'addReply']);
    //G 原话、工具参数、工具结果、会话标题里的密钥都得换成替身：整个场景序列化后找不到真值。
    bunTest.expect(JSON.stringify(scene).includes(FAKE_KEY)).toBe(false);
    bunTest.expect(JSON.stringify(scene)).toContain('{{secret:1}}');
  });

  bunTest.test('没进会话的消息：只有「收到」「分派」两步', () => {
    /** 消息号。 */
    const id = 13;
    const message = makeMessage({ id, text: '还没分好', dispatch: makeDispatch(id), sessionId: null, replies: [] });
    /** 场景。 */
    const scene = httpLearn.buildTrace(depsOf(message, undefined), id)!;
    bunTest.expect(scene.steps).toHaveLength(2);
    bunTest.expect(scene.steps[0]!.title).toContain('收到');
    bunTest.expect(scene.steps[1]!.title).toContain('分派');
  });

  bunTest.test('会话里找不到这条消息号：有一步说明找不到', () => {
    /** 消息号。 */
    const id = 14;
    const message = makeMessage({ id, text: '被压成摘要了', dispatch: makeDispatch(id), sessionId: 's1', replies: [] });
    const session = makeSession({
      title: '一件事',
      messages: [
        { message: { role: 'user', content: '别的消息', timestamp: NOW } as unknown as piAi.Message, run: 1, messageIds: [999] },
        { message: { role: 'assistant', content: [{ type: 'text', text: '收到' }], timestamp: NOW } as unknown as piAi.Message, run: 1 },
      ],
    });
    /** 场景。 */
    const scene = httpLearn.buildTrace(depsOf(message, session), id)!;
    bunTest.expect(allSteps(scene.steps).some((step) => step.title.includes('找不到'))).toBe(true);
  });

  bunTest.test('一次运行 61 条 assistant：最后一步说后面还有', () => {
    /** 消息号。 */
    const id = 15;
    const message = makeMessage({ id, text: '跑了很多步', dispatch: makeDispatch(id), sessionId: 's1', replies: [] });
    /** 61 条助手消息，都算同一次运行。 */
    const messages: storeModule.StoredMessage[] = [
      { message: { role: 'user', content: '跑了很多步', timestamp: NOW } as unknown as piAi.Message, run: 1, messageIds: [id] },
    ];
    for (let index = 0; index < 61; index += 1) {
      messages.push({ message: { role: 'assistant', content: [{ type: 'text', text: `第 ${String(index + 1)} 步` }], usage: { totalTokens: index + 1 }, model: 'magpie/test', timestamp: NOW } as unknown as piAi.Message, run: 1 });
    }
    const session = makeSession({ title: '长运行', messages, runs: [{ n: 1, startedAt: NOW, steps: 61 }] });
    /** 场景。 */
    const scene = httpLearn.buildTrace(depsOf(message, session), id)!;
    bunTest.expect(scene.steps.at(-1)!.title).toContain('后面还有');
    //M 前 60 步列出来，第 61 步只说还有 1 步。
    bunTest.expect(scene.steps.at(-1)!.title).toContain('1');
  });

  bunTest.test('没这条消息：buildTrace 是 undefined；空 app 的 400 / 404', async () => {
    /** 没有消息的依赖。 */
    const deps = depsOf(undefined, undefined);
    bunTest.expect(httpLearn.buildTrace(deps, 99999)).toBeUndefined();
    /** 空的 Fastify 实例（不监听端口，用 inject）。 */
    const app = fastify.default({ logger: false });
    new httpLearn.LearnRoutes(deps).register(app);
    /** 不是正整数：400。 */
    const bad = await app.inject({ method: 'GET', url: '/api/learn/trace/abc' });
    bunTest.expect(bad.statusCode).toBe(400);
    /** 没有这条消息：404。 */
    const missing = await app.inject({ method: 'GET', url: '/api/learn/trace/99999' });
    bunTest.expect(missing.statusCode).toBe(404);
    await app.close();
  });

  bunTest.test('trace-anchors.json 每个锚点：文件存在，文件里能找到 find 这段字', () => {
    /** 锚点键。 */
    const entries = Object.entries(ANCHORS);
    bunTest.expect(entries.length).toBeGreaterThan(0);
    for (const [key, anchor] of entries) {
      /** 锚点指向的源码文件。 */
      const file = path.join(ROOT, anchor.file);
      bunTest.expect(fs.existsSync(file), `${key} 指向的文件不存在：${anchor.file}`).toBe(true);
      bunTest.expect(fs.readFileSync(file, 'utf8').includes(anchor.find), `${key} 的 find 在 ${anchor.file} 里找不到了：${anchor.find}`).toBe(true);
    }
  });
});
