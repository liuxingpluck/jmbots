/**
 * 积木AI工作台 · 无状态反方红军角色机制（Personas.ts）离线单元测试：
 * 覆盖 GET /personas 与 defaultModel 降级、空 prompt 一键拍砖（kind: 'redteam'、不刷 lastHeartbeatAt、零 relay）、
 * 带 prompt 先记 boss 追问再记 redteam、超长输出 <=3800 字裁剪、并发防连点 429、
 * 模型抛错/非 stop/空文本回 502 且零脏写，以及非法 personaId 400 / 任务不存在 404 / 自定义 personas 配置。
 * 跑法：bun test src7/plugins/work-decision/Personas.test.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sqlite from 'bun:sqlite';
import * as piAi from '@earendil-works/pi-ai';
import * as bunTest from 'bun:test';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import type { ToolSpec } from '../../Tools.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as textModule from '../../utils/Text.ts';
import * as dbModule from '../db/index.ts';
import * as plugin from './index.ts';
import type * as types from './Types.ts';


const { afterEach, describe, expect, test } = bunTest;
const PREFIX = '/api/work-decision';
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});


/** 单次模拟模型调用捕获到的完整入参。 */
interface CapturedModelCall {
  /** 解析出的模型对象。 */
  model: piAi.Model<piAi.Api>;
  /** 传入 completeSimple 的无状态 Context。 */
  context: piAi.Context;
  /** 传入 completeSimple 的超时与 Token 限制选项。 */
  options: Record<string, unknown>;
}


/** 创建模拟 piAi.Model 对象。 */
function makeFakeModel(fullRef: string): piAi.Model<piAi.Api> {
  const slash = fullRef.indexOf('/');
  const provider = fullRef.slice(0, slash);
  const id = fullRef.slice(slash + 1);
  return {
    id,
    name: id,
    provider,
    baseUrl: 'http://127.0.0.1:59999/v1',
    api: 'openai-completions',
    input: ['text'],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as piAi.Model<piAi.Api>;
}


/** 构造标准模拟 AssistantMessage 返回。 */
function makeAssistantReply(
  text: string,
  stopReason: piAi.StopReason = 'stop',
): piAi.AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'mock',
    model: 'mock-model',
    usage: {
      input: 100,
      output: 80,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 180,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}


/** 搭建带可编程 mock resources（getModel + models.completeSimple）的测试底座。 */
async function createPersonaHarness(options?: {
  availableProviders?: readonly string[];
  defaultModel?: string;
  completeImpl?: (
    model: piAi.Model<piAi.Api>,
    context: piAi.Context,
    opts: Record<string, unknown>,
  ) => Promise<piAi.AssistantMessage>;
  pluginConfig?: Record<string, unknown>;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-personas-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

  const providers = new Set(options?.availableProviders ?? ['magpie', 'fallback']);
  const defaultModel = options?.defaultModel ?? 'fallback/default-judge-v1';
  const calls: CapturedModelCall[] = [];
  const relayEvents: unknown[] = [];
  const channelReplies: unknown[] = [];

  const ctx = new cordis.Context();
  ctx.on('work-decision/note', (payload) => {
    relayEvents.push(payload);
  });
  ctx.on('channel/reply', (payload) => {
    channelReplies.push(payload);
  });

  const app = fastify.default({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    let status = 500;
    if (error instanceof failureModule.Failure) {
      status = error.status;
    }
    const fastifyCode = (error as { statusCode?: number }).statusCode;
    if (status === 500 && typeof fastifyCode === 'number' && fastifyCode >= 400 && fastifyCode < 500) {
      status = fastifyCode;
    }
    return reply.code(status).send({ error: textModule.getErrorMessage(error) });
  });

  const db = new sqlite.Database(':memory:');
  const tools = new Map<string, ToolSpec>();
  cleanups.push(() => db.close());
  cleanups.push(async () => {
    await app.close();
  });
  cleanups.push(async () => {
    await ctx.fiber.dispose();
  });

  const mockResources = {
    db,
    root,
    raw: {},
    config: {
      defaultModel,
    },
    getModel(modelRef: string): piAi.Model<piAi.Api> {
      const slash = modelRef.indexOf('/');
      const providerName = modelRef.slice(0, slash);
      if (slash <= 0 || !providers.has(providerName)) {
        throw new Error(`供应商未配置：${providerName}`);
      }
      return makeFakeModel(modelRef);
    },
    models: {
      async completeSimple(
        model: piAi.Model<piAi.Api>,
        context: piAi.Context,
        callOpts: Record<string, unknown>,
      ): Promise<piAi.AssistantMessage> {
        calls.push({ model, context, options: callOpts });
        if (options?.completeImpl !== undefined) {
          return options.completeImpl(model, context, callOpts);
        }
        return makeAssistantReply(
          [
            '### 1. 核心反方立场（我不同意哪一点）',
            '依据卡片摘要「先交付完整源码再谈二期尾款」，源码一旦脱手客户零违约成本。',
            '### 2. 最坏情况与代价量化（钱 / 时间 / 不可逆风险）',
            '损失 100% 尾款及约 3 周研发工时，核心底座外泄不可逆。',
            '### 3. 必须逼问老板的 3 个底线硬问题',
            '1. 首付款未到账 60% 前是否坚决不交付源码？（Yes/No）',
            '2. 尾款逾期超过几天触发停服止损？（明确天数）',
            '3. 本次交付是否剥离通用核心引擎仓库？（Yes/No）',
          ].join('\n'),
        );
      },
    },
  };

  ctx.provide('http', { app });
  ctx.provide('resources', mockResources as unknown as cordis.Context['resources']);
  ctx.provide('tools', { register: (tool: ToolSpec) => tools.set(tool.definition.name, tool) });
  ctx.provide('db', new dbModule.Db(new cordis.Context(), db));
  await ctx.plugin(plugin, options?.pluginConfig ?? {});
  await app.ready();

  return { root, app, ctx, calls, relayEvents, channelReplies };
}


describe('Personas：积木AI工作台无状态反方红军角色机制', () => {
  test('① GET /personas 返回内置 3 异构角色，供应商缺失时自动降级到 defaultModel', async () => {
    //M 仅开放 fallback 供应商，验证 3 个内置异构角色全部优雅降级到 defaultModel
    const h = await createPersonaHarness({
      availableProviders: ['fallback'],
      defaultModel: 'fallback/qwen-max-backup',
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `${PREFIX}/personas`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; personas: types.PersonaSummary[] };
    expect(body.ok).toBe(true);
    expect(body.personas.map((item) => item.id)).toEqual([
      'biz-redteam',
      'arch-critic',
      'legal-guard',
    ]);
    expect(body.personas[0]?.preferredModel).toBe('magpie/workbuddy/deepseek-v4.1-flash');
    expect(body.personas[0]?.resolvedModel).toBe('fallback/qwen-max-backup');
    expect(body.personas[1]?.preferredModel).toBe('magpie/workbuddy/hy4free');
    expect(body.personas[1]?.resolvedModel).toBe('fallback/qwen-max-backup');
    expect(body.personas[2]?.preferredModel).toBe('magpie/xiaomi/mimo-v2.6-flash');
    expect(body.personas[2]?.resolvedModel).toBe('fallback/qwen-max-backup');
  });

  test('② 空 prompt 一键拍砖：单轮无状态调用、落盘 kind=redteam、不刷 lastHeartbeatAt、零 relay 唤醒', async () => {
    const h = await createPersonaHarness();

    //M 先创建一张带执行中心跳时间戳的任务卡
    const createRes = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: {
        id: 'task-deal-01',
        title: '某外部客户定制私有化部署报价单',
        summary: '计划先交付完整源码供客户内部测试，验收后再收剩余 70% 尾款。',
        status: 'running',
        priority: 'P0',
        owner: 'Claude',
        tags: ['商业沟通', '报价'],
        doneCriteria: '合同盖章且首款到账',
      },
    });
    expect(createRes.statusCode).toBe(200);

    const hbRes = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/task-deal-01/events`,
      payload: { kind: 'heartbeat', by: 'Claude', text: '已起草初版报价框架' },
    });
    expect(hbRes.statusCode).toBe(200);
    const beforeTask = (hbRes.json() as { task: types.ControlTask }).task;
    const heartbeatBefore = beforeTask.lastHeartbeatAt;
    expect(typeof heartbeatBefore).toBe('number');

    await new Promise((resolve) => setTimeout(resolve, 15));

    //M 留空 prompt 直接召唤冷血商业红军一键拍砖
    const reviewRes = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/task-deal-01/persona-review`,
      payload: { personaId: 'biz-redteam' },
    });
    expect(reviewRes.statusCode).toBe(200);
    const result = reviewRes.json() as types.PersonaReviewResult;
    expect(result.ok).toBe(true);
    expect(result.personaId).toBe('biz-redteam');
    expect(result.model).toBe('magpie/workbuddy/deepseek-v4.1-flash');
    expect(result.event.kind).toBe('redteam');
    expect(result.event.by).toBe('🔪 冷血商业红军 · deepseek-v4.1-flash');
    expect(result.event.text).toContain('核心反方立场');

    //M 核心断言：不刷新中控 lastHeartbeatAt，不写 boss note，零 relay / 零群播报
    expect(result.task.lastHeartbeatAt).toBe(heartbeatBefore);
    expect(result.task.events.length).toBe(beforeTask.events.length + 1);
    expect(h.relayEvents.length).toBe(0);
    expect(h.channelReplies.length).toBe(0);

    //M 校验传给 completeSimple 的是纯单轮无工具 Context 且包含双铁律 System Prompt
    expect(h.calls.length).toBe(1);
    const call = h.calls[0]!;
    expect(call.context.tools).toEqual([]);
    expect(call.context.messages.length).toBe(1);
    expect(call.context.systemPrompt).toContain('证据锚定铁律');
    expect(call.context.systemPrompt).toContain('必须逼问老板的 3 个底线硬问题');
    const userMsg = call.context.messages[0] as { role: string; content: string };
    expect(userMsg.role).toBe('user');
    expect(userMsg.content).toContain('某外部客户定制私有化部署报价单');
    expect(userMsg.content).not.toContain('【老板本轮重点追问】');
    expect(call.options['maxTokens']).toBe(1200);
    expect(call.options['maxRetries']).toBe(0);
  });

  test('③ 带 prompt 重点追问：先记 boss 的 note 事件，再记 redteam 事件，且均不刷 lastHeartbeatAt', async () => {
    const h = await createPersonaHarness();

    await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: {
        id: 'task-arch-02',
        title: '引入三层消息总线重构本地状态',
        summary: '准备新建独立微服务与 Redis 队列同步本地 JSON。',
      },
    });

    const reviewRes = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/task-arch-02/persona-review`,
      payload: {
        personaId: 'arch-critic',
        prompt: '单机单进程场景引入 Redis 队列是不是纯伪需求？',
      },
    });
    expect(reviewRes.statusCode).toBe(200);
    const body = reviewRes.json() as types.PersonaReviewResult;
    expect(body.task.lastHeartbeatAt).toBeNull();
    expect(body.task.events.length).toBe(3);

    const bossNote = body.task.events[1]!;
    const redteamEv = body.task.events[2]!;
    expect(bossNote.by).toBe('boss');
    expect(bossNote.kind).toBe('note');
    expect(bossNote.text).toBe('向 🧊 第一性架构审官 追问：单机单进程场景引入 Redis 队列是不是纯伪需求？');
    expect(redteamEv.kind).toBe('redteam');
    expect(redteamEv.by).toBe('🧊 第一性架构审官 · hy4free');

    const sentContent = (h.calls[0]?.context.messages[0] as { content: string }).content;
    expect(sentContent).toContain('【老板本轮重点追问】');
    expect(sentContent).toContain('单机单进程场景引入 Redis 队列是不是纯伪需求？');

    //M 直接走 POST /tasks/:id/events 写入 kind='redteam' 同样不刷新 lastHeartbeatAt
    const directRedteam = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/task-arch-02/events`,
      payload: {
        kind: 'redteam',
        by: '⚖️ 合同法务底线官 · manual',
        text: '补充法务底线核查记录',
      },
    });
    expect(directRedteam.statusCode).toBe(200);
    expect((directRedteam.json() as { task: types.ControlTask }).task.lastHeartbeatAt).toBeNull();
  });

  test('④ 超长模型输出自动安全裁剪至 <=3800 字，不撞 MAX_TEXT_CHARS=4000', async () => {
    const hugeReply = `### 1. 核心反方立场\n${'风险量化分析与条款漏洞拆解。'.repeat(350)}`;
    expect(hugeReply.length).toBeGreaterThan(4200);

    const h = await createPersonaHarness({
      completeImpl: async () => makeAssistantReply(hugeReply),
    });

    await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: { id: 'task-long-04', title: '长文本裁剪验证卡' },
    });

    const res = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/task-long-04/persona-review`,
      payload: { personaId: 'legal-guard' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as types.PersonaReviewResult;
    expect(body.event.text.length).toBeLessThanOrEqual(3800);
    expect(body.event.text.endsWith('…（已截断）')).toBe(true);
  });

  test('⑤ 同一任务同一角色并发连点返回 429，不同角色可并行，完成后锁自动释放', async () => {
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const h = await createPersonaHarness({
      completeImpl: async (model) => {
        if (model.id.includes('deepseek')) {
          await gate;
        }
        return makeAssistantReply(`来自 ${model.id} 的独立反方拍砖结论`);
      },
    });

    await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: { id: 'task-race-05', title: '并发防连点互斥测试' },
    });

    //M 发起第 1 个 biz-redteam 请求并挂起在模型推理中
    const firstPending = h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/task-race-05/persona-review`,
      payload: { personaId: 'biz-redteam' },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    //M 同一任务 + 同一角色连点立即撞重回 429
    const duplicateRes = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/task-race-05/persona-review`,
      payload: { personaId: 'biz-redteam' },
    });
    expect(duplicateRes.statusCode).toBe(429);

    //M 同一任务 + 另一个角色（legal-guard）互不阻塞，正常返回 200
    const otherPersonaRes = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/task-race-05/persona-review`,
      payload: { personaId: 'legal-guard' },
    });
    expect(otherPersonaRes.statusCode).toBe(200);

    //M 放行第 1 个请求后，再次调用同一角色恢复正常 200
    releaseFirst?.();
    const firstDone = await firstPending;
    expect(firstDone.statusCode).toBe(200);

    const retryAfterDone = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/task-race-05/persona-review`,
      payload: { personaId: 'biz-redteam' },
    });
    expect(retryAfterDone.statusCode).toBe(200);
  });

  test('⑥ 模型抛错 / stopReason!==stop / 空文本 / 模型全不可用均回 502 且绝不污染 task.events', async () => {
    let mode: 'throw' | 'max_tokens' | 'empty' = 'throw';
    const h = await createPersonaHarness({
      completeImpl: async () => {
        if (mode === 'throw') {
          throw new Error('upstream gateway 504 timeout');
        }
        if (mode === 'max_tokens') {
          return makeAssistantReply('半截断掉的句子', 'length');
        }
        return makeAssistantReply('   \n  ', 'stop');
      },
    });

    const created = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: { id: 'task-err-06', title: '模型异常零脏写守卫' },
    });
    const initialRev = (created.json() as { revision: number }).revision;

    for (const nextMode of ['throw', 'max_tokens', 'empty'] as const) {
      mode = nextMode;
      const failRes = await h.app.inject({
        method: 'POST',
        url: `${PREFIX}/tasks/task-err-06/persona-review`,
        payload: { personaId: 'biz-redteam', prompt: '哪怕带了追问失败也不能脏写 boss note！' },
      });
      expect(failRes.statusCode).toBe(502);
    }

    //M 核对账本：revision 未涨，events 仍只有最初 1 条 created，零 boss note 残留！
    const listRes = await h.app.inject({ method: 'GET', url: `${PREFIX}/tasks` });
    const snapshot = listRes.json() as types.ControlPlaneSnapshot;
    expect(snapshot.revision).toBe(initialRev);
    const task = snapshot.tasks.find((item) => item.id === 'task-err-06')!;
    expect(task.events.length).toBe(1);
    expect(task.events[0]?.kind).toBe('created');

    //M 当 preferredModel 与 defaultModel 均不可用时也回 502
    const noModelHarness = await createPersonaHarness({
      availableProviders: [],
      defaultModel: 'missing/model',
    });
    await noModelHarness.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: { id: 'task-nomodel', title: '无可用模型测试' },
    });
    const noModelRes = await noModelHarness.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/task-nomodel/persona-review`,
      payload: { personaId: 'biz-redteam' },
    });
    expect(noModelRes.statusCode).toBe(502);
  });

  test('⑦ 非法 personaId / 非法参数回 400、不存在 taskId 回 404，并支持自定义 personas 配置覆盖', async () => {
    const h = await createPersonaHarness({
      pluginConfig: {
        personas: [
          {
            id: 'sec-auditor',
            name: '安全红队审计官',
            shortName: '安全红队',
            icon: '🛡️',
            tagline: '专查鉴权绕过与命令注入风险',
            preferredModel: 'magpie/workbuddy/deepseek-v4.1-flash',
            systemPrompt: '你是安全红队审计官，按三段式输出安全漏洞与硬问题。',
          },
          {
            id: 'disabled-bot',
            name: '已停用角色',
            icon: '💤',
            tagline: '不展示也不可调用',
            preferredModel: 'magpie/workbuddy/hy4free',
            systemPrompt: '停用测试',
            enabled: false,
          },
        ],
      },
    });

    const listPersonas = await h.app.inject({ method: 'GET', url: `${PREFIX}/personas` });
    expect(listPersonas.statusCode).toBe(200);
    const personas = (listPersonas.json() as { personas: types.PersonaSummary[] }).personas;
    expect(personas.map((item) => item.id)).toEqual(['sec-auditor']);

    await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: { id: 'task-custom-07', title: '鉴权中间件改造' },
    });

    //M 未知或已禁用 personaId -> 400
    const unknownPersona = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/task-custom-07/persona-review`,
      payload: { personaId: 'disabled-bot' },
    });
    expect(unknownPersona.statusCode).toBe(400);

    //M 非法 model 格式 -> 400
    const badModel = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/task-custom-07/persona-review`,
      payload: { personaId: 'sec-auditor', model: 'invalid_no_slash' },
    });
    expect(badModel.statusCode).toBe(400);

    //M 不存在的 taskId -> 404
    const missingTask = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/task-not-exists/persona-review`,
      payload: { personaId: 'sec-auditor' },
    });
    expect(missingTask.statusCode).toBe(404);

    //M 自定义启用角色正常拍砖 -> 200
    const okCustom = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks/task-custom-07/persona-review`,
      payload: { personaId: 'sec-auditor' },
    });
    expect(okCustom.statusCode).toBe(200);
    expect((okCustom.json() as types.PersonaReviewResult).event.by).toBe(
      '🛡️ 安全红队审计官 · deepseek-v4.1-flash',
    );
  });
});
