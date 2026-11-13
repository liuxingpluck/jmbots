/**
 * 回复追踪的离线检查：回复目标不会串句，切机器人会清除目标，文件预览保持原样。
 * 展示器按持久号排序，实际耗时和规则阈值分开，未知类别与历史缺失不编造。
 * 只用内存数据和中文展示器，不起浏览器、不调用模型。
 */
import * as bunTest from 'bun:test';
import * as hashModule from '../web/src/Hash.ts';
import * as storeModule from '../web/src/Store.ts';
import * as timeline from '../web/src/Chat/Timeline.ts';
import * as traceModule from '../web/src/Panel/Trace.ts';
import * as react from 'react';
import * as reactDomServer from 'react-dom/server';
import * as context from '../web/src/Context.ts';
import type * as backendTrace from '../src6/channels/HttpTrace.ts';
import type * as types from '../web/src/Types.ts';
import * as replyEvidenceModule from '../src/capabilities/ReplyEvidence.ts';


/**
 * 测试工程不启用 JSX；Bun 负责加载网页组件，网页工程另行完整检查组件类型。
 * 动态边界只接受已知本地模块，下面渲染前再确认导出确为组件函数。
 */
const panelModulePath = '../web/src/Panel/Events.tsx';
const eventsPanel = await import(panelModulePath) as Record<string, unknown>;


/**
 * 构造完整的内存事件，默认没有会话/消息关联。
 * @param id 持久号，测试故意让时间与它不同序。
 * @param type 真实事件类型。
 * @param at 记录时间，Unix 毫秒。
 * @param data 已记录的证据字段。
 */
function eventOf(
  id: number,
  type: string,
  at: number,
  data: Record<string, unknown> = {},
): types.TraceEvent {
  return {
    id,
    type,
    at,
    source: 'test',
    bot: '小测',
    sessionId: null,
    messageId: null,
    key: null,
    data,
    parent: null,
    depth: 0,
  };
}


/** #164 的已保存字段形状；模型名称使用离线示例，耗时和未采用原因保持实际记录的含义。 */
function historicalTrace(): types.ReplyTraceView {
  const answer = '选中的回答内容。'.repeat(50);
  return {
    target: {
      messageId: 164,
      replyIndex: 0,
      bot: '周小灵',
      sessionId: 'saved-session',
      sessionTitle: '当时保存的会话标题',
      workspace: '当时工作区',
      messageFile: 'F:/example/message/164.md',
      at: 40000,
      text: answer,
      textChars: answer.length,
      generation: replyEvidenceModule.unknownGeneration(),
      association: replyEvidenceModule.association([164], 'batch', 'recorded-dispatch'),
      run: null,
      step: null,
    },
    scope: 'message-only',
    notes: ['旧回复没有事件关联。', '上下文清单未记录。'],
    sources: [{
      id: 164,
      channel: 'http',
      source: 'web',
      text: '请把这次任务放进一个独立会话。',
      textChars: 18,
      createdAt: 1000,
      file: 'F:/example/message/164.md',
    }],
    events: [],
    dispatches: [{
      messageIds: [164],
      startedAt: 1000,
      ms: 29562,
      defaultModel: null,
      actualModel: 'example/assistant',
      targetBot: '周小灵',
      targetSessionId: 'saved-session',
      workspace: '当时工作区',
      result: { title: '新话题', reason: '这是独立的新问题，另开会话处理。' },
      checks: [],
      decisionModel: { thinking: 'PRIVATE_THINKING' },
      stages: [{
        kind: 'decision',
        model: 'example/decision',
        startedAt: null,
        ms: 29562,
        msSource: 'stage',
        used: true,
        summary: '选「新开会话」概率 0.59，直接用。',
        error: null,
        options: [{ label: '新开会话', session: 'new', probability: 0.59 }],
      }],
    }],
    usage: [],
    usageScope: 'session-window',
    truncated: false,
    startedAt: 1000,
    endedAt: 40000,
    endSource: 'reply-record',
    elapsedMs: 39000,
  };
}


/** 在离线 React 渲染器检查可读层次和稳定展开 key，不启动浏览器。 */
function renderTrace(trace: types.ReplyTraceView, expanded: string[] = []): string {
  const store = storeModule.createUiStore('dark');
  const props = {
    trace,
    presenter: new traceModule.TracePresenter(),
    openPanel: () => undefined,
    disclosures: {
      expanded: new Set(expanded),
      change: () => undefined,
      replace: () => undefined,
    },
  };
  const candidate = eventsPanel.TraceBody;
  if (typeof candidate !== 'function') {
    throw new Error('本地事件阅读模块没有导出 TraceBody 组件');
  }
  /** 组件运行时出口已校验；具体属性由本测试数据和独立 Web 类型检查共同核对。 */
  const component = candidate as react.ComponentType<typeof props>;
  const body = react.createElement(component, props);
  const wrapped = react.createElement(context.UiContext.Provider, { value: store }, body);

  return reactDomServer.renderToStaticMarkup(wrapped);
}


bunTest.describe('回复追踪目标', () => {
  bunTest.test('看具体回复不污染预览；换一句只换追踪目标', () => {
    const store = storeModule.createUiStore('dark');
    const preview = { path: 'F:/example/报告.md', name: '报告.md' };
    const first = { bot: '小测', messageId: 7, replyIndex: 0 };
    const second = { bot: '小测', messageId: 7, replyIndex: 1 };

    store.getState().openPanel('preview', preview);
    store.getState().openTrace(first);

    bunTest.expect(store.getState().traceTarget).toEqual(first);
    bunTest.expect(store.getState().panelTab).toBe('events');
    bunTest.expect(store.getState().panelOpen).toBe(true);
    bunTest.expect(store.getState().panelTarget).toEqual(preview);
    bunTest.expect(store.getState().previewTabs).toEqual([preview]);

    store.getState().openTrace(second);
    store.getState().openPanel('workspace');

    bunTest.expect(store.getState().traceTarget).toEqual(second);
    bunTest.expect(store.getState().previewTabs).toEqual([preview]);
    store.getState().openPanel('events');
    bunTest.expect(store.getState().traceTarget?.replyIndex).toBe(1);
  });

  bunTest.test('换机器人或轮询发现机器人被移除后，清除旧回复目标', () => {
    const store = storeModule.createUiStore('dark');
    const target = { bot: '小测', messageId: 7, replyIndex: 0 };
    store.getState().openTrace(target);
    store.getState().selectBot('另一个');
    bunTest.expect(store.getState().traceTarget).toBeNull();

    store.getState().openTrace(target);
    store.getState().setPolled({ online: true, bots: [] });
    bunTest.expect(store.getState().traceTarget).toBeNull();
    bunTest.expect(store.getState().currentBot).toBeNull();
  });

  bunTest.test('相同正文、相同时间的两句回复仍保留不同的真实下标', () => {
    const reply: types.ReplyView = {
      at: 2000,
      session: { id: 'same-session', title: '同一件事', file: '' },
      text: '相同正文',
      attachments: [],
      generation: replyEvidenceModule.unknownGeneration(),
      association: replyEvidenceModule.association([7], 'target', 'test'),
    };
    const message: types.MessageView = {
      id: 7,
      bot: '小测',
      channel: 'http',
      source: 'web',
      text: '原消息',
      status: 'taken',
      sessionId: 'same-session',
      file: '',
      createdAt: 1000,
      updatedAt: 2000,
      attachments: [],
      replies: [reply, { ...reply }],
      dispatch: null,
    };
    const items = timeline.buildTimeline([message]);
    const replies = items.filter((item) => item.kind === 'reply');

    bunTest.expect(replies.map((item) => item.replyIndex)).toEqual([0, 1]);
    bunTest.expect(replies.map((item) => item.key)).toEqual(['r7_0', 'r7_1']);
    bunTest.expect(hashModule.parseHash('#tab=events')).toEqual({ kind: 'tab', tab: 'events' });
  });
});


bunTest.describe('事件证据展示', () => {
  bunTest.test('只按持久号排序，时钟回退明确提示，不修改原数组', () => {
    const presenter = new traceModule.TracePresenter();
    const events = [
      eventOf(3, 'run.ended', 2400),
      eventOf(1, 'run.started', 2500),
      eventOf(2, 'step.before', 2600),
    ];
    const items = presenter.items(events);

    bunTest.expect(items.map((item) => item.record.id)).toEqual([1, 2, 3]);
    bunTest.expect(events.map((event) => event.id)).toEqual([3, 1, 2]);
    bunTest.expect(items[0]?.delta).toBe('起点');
    bunTest.expect(items[1]?.delta).toBe('+0.1 秒');
    bunTest.expect(items[2]?.delta).toBe('时钟回退 200 毫秒');
  });

  bunTest.test('规则阈值与实际等待分别显示，未知时间不以零代替', () => {
    const presenter = new traceModule.TracePresenter();
    const record = eventOf(1, 'batch.taken', 9000, {
      mergeMs: 2000,
      maxWaitMs: 10000,
      ms: 6350,
      startedAt: 2650,
      endedAt: 9000,
    });
    const item = presenter.items([record])[0]!;
    const fields = new Map(item.facts.map((fact) => [fact.key, fact]));

    bunTest.expect(fields.get('mergeMs')?.label).toBe('合批静默规则（毫秒）');
    bunTest.expect(fields.get('mergeMs')?.value).toBe('2000');
    bunTest.expect(fields.get('ms')?.label).toBe('实际耗时');
    bunTest.expect(fields.get('ms')?.value).toBe('6.4 秒（6350 毫秒）');
    bunTest.expect(presenter.duration(null)).toBe('未记录');
    bunTest.expect(presenter.duration(-1)).toBe('未记录');
    bunTest.expect(presenter.duration(0)).toBe('0 秒');
    bunTest.expect(presenter.timestamp(null)).toBe('未记录');
  });

  bunTest.test('程序兜底和回退不是模型决策，笼统 429 不生成额度解释', () => {
    const presenter = new traceModule.TracePresenter();
    const events = [
      eventOf(1, 'dispatch.decided', 1000, { by: 'fallback' }),
      eventOf(2, 'dispatch.decided', 1001, { by: 'decision' }),
      eventOf(3, 'model.fallback', 1002, { error: 'HTTP 429 Too Many Requests' }),
      eventOf(4, 'model.completed', 1003, { model: 'example/backup', ok: true, apiMs: 12 }),
      eventOf(5, 'future.unknown', 1004),
      eventOf(6, 'model.completed', 1005, { ok: false, error: '本地模型校验失败' }),
    ];
    const items = presenter.items(events);

    bunTest.expect(items.map((item) => item.category)).toEqual([
      'program', 'model', 'program', 'receipt', 'record', 'program',
    ]);
    bunTest.expect(items[2]?.summary).toContain('429');
    bunTest.expect(items[2]?.summary).not.toContain('额度');
    bunTest.expect(items[4]?.title).toBe('future.unknown');
    bunTest.expect(items[5]?.failed).toBe(true);
  });

  bunTest.test('默认模型和本次模型分开，安全上下文清单保留多行结构', () => {
    const presenter = new traceModule.TracePresenter();
    const context = [{ role: 'user', messageIds: [7], chars: 20 }];
    const record = eventOf(1, 'context.built', 1000, {
      defaultModel: 'example/default',
      model: 'example/actual',
      messages: context,
    });
    const item = presenter.items([record])[0]!;
    const fields = new Map(item.facts.map((fact) => [fact.key, fact]));

    bunTest.expect(fields.get('defaultModel')?.value).toBe('example/default');
    bunTest.expect(fields.get('model')?.value).toBe('example/actual');
    bunTest.expect(fields.get('messages')?.value).toContain('\n');
    bunTest.expect(fields.get('messages')?.value).toContain('messageIds');
  });

  bunTest.test('实际队列等待按同一消息的最新入队时刻计算，缺失起点不补造', () => {
    const presenter = new traceModule.TracePresenter();
    const records = [
      eventOf(1, 'message.queued', 1000, { messageIds: [7], queuedAt: 1000 }),
      eventOf(2, 'message.queued', 3000, { messageIds: [7], queuedAt: 3000 }),
      eventOf(3, 'message.taken', 6000, { messageIds: [7, 8], takenAt: 6000 }),
    ];
    const items = presenter.items(records);
    const derived = items[2]?.facts.find((fact) => fact.key === 'derived.queueWait');

    bunTest.expect(derived?.value).toContain('消息 #7：3 秒（3000 毫秒）');
    bunTest.expect(derived?.value).toContain('#2.queuedAt');
    bunTest.expect(derived?.value).toContain('#3.takenAt');
    bunTest.expect(derived?.value).toContain('消息 #8：入队或收走时间未记录');
    bunTest.expect(derived?.value).toContain('不使用规则阈值');
    bunTest.expect(items[0]?.facts.some((fact) => fact.key === 'derived.queueWait')).toBe(false);
  });

  bunTest.test('网页镜像与后端追踪类型双向兼容', () => {
    /** 编译期检查两侧字段及可空性；不把后端数据库模块带入网页类型环境。 */
    const backendFits: backendTrace.ReplyTraceView extends types.ReplyTraceView ? true : false = true;
    const frontendFits: types.ReplyTraceView extends backendTrace.ReplyTraceView ? true : false = true;

    bunTest.expect(backendFits && frontendFits).toBe(true);
  });

  bunTest.test('外部认领不等于开工，只显示已知间隔，真实开始时间仍未记录', () => {
    const presenter = new traceModule.TracePresenter();
    const records = [
      eventOf(1, 'agent.queued', 1000, { queuedAt: 1000 }),
      eventOf(2, 'agent.taken', 3000, {
        queuedAt: 1000,
        takenAt: 3000,
        executionStartedAt: null,
        queuedToClaimMs: 2000,
      }),
      eventOf(3, 'agent.result', 9000, {
        takenAt: 3000,
        receivedAt: 9000,
        executionStartedAt: null,
        claimedToResultMs: 6000,
      }),
      eventOf(4, 'agent.delivered', 9200),
    ];
    const items = presenter.items(records);
    const taken = new Map(items[1]!.facts.map((fact) => [fact.key, fact]));
    const result = new Map(items[2]!.facts.map((fact) => [fact.key, fact]));

    bunTest.expect(items.map((item) => item.category)).toEqual([
      'program', 'receipt', 'receipt', 'program',
    ]);
    bunTest.expect(items.map((item) => item.title)).toEqual([
      '排入外部 AI 队列',
      '外部 AI 认领（不等于开工）',
      '收到外部结果',
      '结果送回会话',
    ]);
    bunTest.expect(taken.get('queuedToClaimMs')?.label).toBe('排队到认领间隔');
    bunTest.expect(taken.get('queuedToClaimMs')?.value).toBe('2 秒（2000 毫秒）');
    bunTest.expect(result.get('claimedToResultMs')?.label).toBe('认领到结果间隔');
    bunTest.expect(result.get('claimedToResultMs')?.value).toBe('6 秒（6000 毫秒）');
    bunTest.expect(taken.get('executionStartedAt')).toMatchObject({
      label: '实际开始执行',
      value: '未记录',
    });
    bunTest.expect(result.get('executionStartedAt')?.value).toBe('未记录');
    bunTest.expect(result.get('receivedAt')?.value).toBe(presenter.timestamp(9000, true, true));
    bunTest.expect(taken.get('takenAt')?.label).toBe('外部认领时刻');
  });

  bunTest.test('即使保存了精确关联，回执过期后概览只称回复记录间隔', () => {
    const presenter = new traceModule.TracePresenter();
    /** 关联字段仍在，成功回执已过期，不能只凭 exact 宣称有回执。 */
    const missingReceipt: Pick<types.ReplyTraceView, 'scope' | 'endSource'> = {
      scope: 'exact',
      endSource: 'reply-record',
    };
    const labels = presenter.timingLabels(missingReceipt);

    bunTest.expect(labels).toEqual({
      elapsedLabel: '接收到回复记录的间隔',
      endLabel: '回复记录',
    });
    bunTest.expect(presenter.timingLabels({ endSource: 'receipt' })).toEqual({
      elapsedLabel: '端到端实测',
      endLabel: '回复回执',
    });
  });
});


bunTest.describe('事件阅读层次', () => {
  bunTest.test('秒和分钟更易读，精确毫秒仍可核对；未知时间不补造', () => {
    const presenter = new traceModule.TracePresenter();
    bunTest.expect(presenter.duration(29562)).toBe('29.6 秒');
    bunTest.expect(presenter.duration(248800)).toBe('4 分 8.8 秒');
    bunTest.expect(presenter.exactDuration(29562)).toBe('29562 毫秒');
    bunTest.expect(presenter.duration(null)).toBe('未记录');

    const preview = presenter.textPreview('第一行。\n第二行。', 3000, 4);
    bunTest.expect(preview.summary).toBe('第一行。…');
    bunTest.expect(preview.expandable).toBe(true);
    bunTest.expect(preview.fragmentNotice).toContain('3000');
  });

  bunTest.test('分派阶段只有一档：决策模型或程序兜底，耗时是阶段实测', () => {
    const presenter = new traceModule.TracePresenter();
    const dispatch = historicalTrace().dispatches[0]!;
    const stages = presenter.stages(dispatch.stages);

    bunTest.expect(stages.map((view) => view.title)).toEqual(['决策模型阶段']);
    bunTest.expect(stages[0]).toMatchObject({
      used: '已采用', elapsed: '29.6 秒', exactElapsed: '29562 毫秒', elapsedLabel: '阶段实测',
    });
    bunTest.expect(stages[0]?.stage.startedAt).toBeNull();
    bunTest.expect(presenter.probability(0.59)).toBe('59%');
    bunTest.expect(dispatch.defaultModel).toBeNull();
  });

  bunTest.test('身份紧凑，回答仅有一份按需原文；旧分派明确无序号，敏感大字段不进入卡片', () => {
    const trace = historicalTrace();
    const html = renderTrace(trace);
    bunTest.expect(html).toContain('周小灵的回复');
    bunTest.expect(html).toContain('回答原文');
    bunTest.expect(html).toContain('当时保存的会话标题');
    bunTest.expect(html).toContain('当时工作区');
    bunTest.expect(html).toContain('发送方／来源：网页（web）');
    bunTest.expect(html).toContain('请把这次任务放进一个独立会话。');
    bunTest.expect(html).toContain('这是独立的新问题，另开会话处理。');
    bunTest.expect(html).toContain('29.6 秒');
    bunTest.expect(html).toContain('title="29562 毫秒"');
    bunTest.expect(html).toContain('<dt>配置默认模型</dt><dd>未记录</dd>');
    bunTest.expect(html).toContain('历史分派记录（无发送序号）');
    bunTest.expect(html.indexOf('历史分派记录（无发送序号）')).toBeGreaterThan(html.indexOf('已保存的事件'));
    const beforeEvents = html.slice(0, html.indexOf('jm-trace-records'));
    bunTest.expect(beforeEvents).not.toContain('jm-trace-visible-text');
    bunTest.expect(html.split(trace.target.text).length - 1).toBe(1);
    bunTest.expect(html).not.toContain('PRIVATE_THINKING');
    bunTest.expect(html).not.toContain('PRIVATE_SYSTEM');
    bunTest.expect(html).not.toContain('PRIVATE_STATE');

    const answer = /<details[^>]*data-reading-key="answer"[^>]*>/.exec(html)?.[0];
    bunTest.expect(answer).toBeDefined();
    bunTest.expect(answer).not.toContain('open=""');
    const source = /<article class="jm-trace-source-card">(.*?)<\/article>/.exec(html)?.[1];
    bunTest.expect(source).toContain('请把这次任务放进一个独立会话。');
  });

  bunTest.test('持久事件为主，分派安全记录只进入其真实dispatch.decided，不另造序号', () => {
    const trace = historicalTrace();
    trace.events = [
      eventOf(12, 'dispatch.decided', 30000, {
        messageIds: [164], startedAt: 1000, reason: '真实分派事件理由', model: 'example/assistant', by: 'llm',
      }),
      eventOf(10, 'message.received', 1000, { channel: 'http', source: 'web', chars: 18, bytes: 54 }),
      eventOf(11, 'turn.started', 2000, { messageIds: [164] }),
    ];
    const html = renderTrace(trace);
    bunTest.expect(html).not.toContain('历史分派记录（无发送序号）');
    bunTest.expect(html).toContain('data-reading-key="event-dispatch:12"');
    bunTest.expect(html.indexOf('<span>#10</span>')).toBeLessThan(html.indexOf('<span>#11</span>'));
    bunTest.expect(html.indexOf('<span>#11</span>')).toBeLessThan(html.indexOf('<span>#12</span>'));
    bunTest.expect(html).toContain('18 字符');
    bunTest.expect(html).toContain('54 字节');
    bunTest.expect(html).toContain('本轮开始读取 1 条输入：164');
    bunTest.expect(html).toContain('真实分派事件理由');
  });

  bunTest.test('exact仍有回执但上下文缺失时，首屏短提示不声称记录完整', () => {
    const presenter = new traceModule.TracePresenter();
    const trace = historicalTrace();
    trace.scope = 'exact';
    trace.endSource = 'receipt';
    trace.events = [eventOf(1, 'reply.sent', 40000, { ok: true })];
    trace.notes = ['只读历史记录。', '实际上下文清单已缺失。'];
    bunTest.expect(presenter.noteSummary(trace)).toBe('部分事件缺失，按现存记录查看。');
  });

  bunTest.test('恢复稳定展开 key 时，所选回答与分派阶段保持各自展开状态', () => {
    const stageKey = 'dispatch:164:1000:stage:0:decision';
    const html = renderTrace(historicalTrace(), ['answer', stageKey]);
    const answer = /<details[^>]*data-reading-key="answer"[^>]*>/.exec(html)?.[0];
    const stage = /<details[^>]*data-reading-key="dispatch:164:1000:stage:0:decision"[^>]*>/.exec(html)?.[0];

    bunTest.expect(answer).toContain('open=""');
    bunTest.expect(stage).toContain('open=""');
  });
});
