/**
 * DataFlow.ts 单元测试：
 * 1. 复现真实 9 步网页消息轨迹（兼容历史精简 facts 与新增强实测 facts）；
 * 2. 复现带工具调用（Tools.execute + 关口三/四 + 下一轮关口一）的多轮消息轨迹；
 * 3. 验证启动画布（boot）的数据流转生成不崩、无空引用。
 */
import { describe, expect, test } from 'bun:test';
import * as journalTrail from '../journal/Trail.ts';
import { LINES } from '../journal/tests/Lines.ts';
import type { Trail, TrailLine } from '../../utils/Trail.ts';
import * as dataFlowModule from './DataFlow.ts';


/** 构造一条测试跟踪行。 */
function makeLine(
  id: number,
  at: number,
  kind: '函数' | '事件',
  name: string,
  site: string,
  extra: Partial<TrailLine> = {},
): TrailLine {
  return {
    id,
    at,
    kind,
    name,
    listeners: [],
    text: '',
    site,
    sessionId: null,
    messageId: null,
    vars: {},
    ...extra,
  };
}


describe('buildTrailDataFlow 数据流转构建', () => {
  test('真实 9 步网页消息（兼容历史轨迹与新增强实测字段）完整串起 #1 → #9 与前后状态变化', () => {
    const sid = '20261117140757919963';
    const rawLines: TrailLine[] = [
      makeLine(1, 0, '事件', 'web-api/received', 'src7/plugins/web-api/Timeline.ts:308', { messageId: 596 }),
      makeLine(2, 5, '函数', 'WebApi.accept', 'src7/plugins/web-api/index.ts:506', {
        messageId: 596,
        text: 'trace.webApi.accept',
        vars: { messageId: 596, bot: '周小灵', table: 'web_messages', autoFinal: true, attachmentCount: 0 },
      }),
      makeLine(3, 54, '事件', 'session/change', 'src7/Sessions.ts:925', {
        sessionId: sid,
        listeners: ['bots', 'relay', 'context-fit', 'voice'],
        vars: { stateBefore: 'done', state: 'running', sessionKind: 'front', step: 12, messageCount: 1 },
      }),
      makeLine(4, 60, '事件', 'session/new-message', 'src7/Sessions.ts:912', {
        sessionId: sid,
        listeners: ['bots', 'model-catalog'],
        vars: { role: 'user', content: '8+9等于几？' },
      }),
      makeLine(5, 89, '事件', 'memory/front-message', 'src7/plugins/bots/FrontDesk.ts:587', {
        sessionId: sid,
        listeners: ['memory'],
      }),
      makeLine(6, 96, '事件', 'session/before-model', 'src7/Sessions.ts:814', {
        sessionId: sid,
        listeners: ['bots', 'relay', 'memory', 'file-tools', 'context-fit', 'assist', 'approval', 'model-catalog'],
        vars: { sessionKind: 'front', step: 13, model: 'magpie/deepseek', thinking: 'low', systemBefore: 0, toolsCount: 6, messageCount: 2 },
      }),
      makeLine(7, 119, '函数', 'FrontDesk.onRequest', 'src7/plugins/bots/FrontDesk.ts:360', {
        sessionId: sid,
        text: 'trace.bots.addRecentContext',
        vars: { turnMessages: 1, contextMessages: 50 },
      }),
      makeLine(8, 127, '函数', 'Timeline.bindSession', 'src7/plugins/web-api/Timeline.ts:375', {
        sessionId: sid,
        messageId: 596,
        text: 'trace.timeline.bindSession',
        vars: { messageId: 596, table: 'web_messages' },
      }),
      makeLine(9, 3453, '函数', 'Session.loop', 'src7/Sessions.ts:838', {
        sessionId: sid,
        text: 'trace.sessions.answerProvided',
        vars: {
          sessionKind: 'front', step: 13, model: 'magpie/deepseek', thinking: 'low',
          systemBefore: 0, systemAfter: 4, toolsCount: 6, messageCount: 2,
          answeredByPlugin: true, answeredBy: 'magpie/deepseek',
        },
      }),
      makeLine(10, 3460, '事件', 'session/after-model', 'src7/Sessions.ts:849', {
        sessionId: sid,
        vars: { model: 'magpie/deepseek', systemAfter: 4, toolsCount: 6, answeredBy: 'magpie/deepseek' },
      }),
      makeLine(11, 3470, '事件', 'session/new-message', 'src7/Sessions.ts:912', {
        sessionId: sid,
        listeners: ['bots', 'model-catalog'],
        vars: { role: 'assistant', model: 'magpie/deepseek' },
      }),
      makeLine(12, 3485, '事件', 'session/change', 'src7/Sessions.ts:925', {
        sessionId: sid,
        listeners: ['bots', 'relay'],
        vars: { stateBefore: 'running', state: 'done', replyLength: 2 },
      }),
      makeLine(13, 3495, '函数', 'Dispatch.sendLastWords', 'src7/plugins/bots/DispatchResults.ts:716', {
        sessionId: sid,
        text: 'trace.bots.sendLastWords',
        vars: { channel: 'http', autoFinal: true, replyLength: 2, length: 2 },
      }),
      makeLine(14, 3511, '函数', 'Timeline.reply', 'src7/plugins/web-api/Timeline.ts:435', {
        sessionId: sid,
        messageId: 596,
        text: 'trace.timeline.reply',
        vars: { messageId: 596, table: 'web_messages', status: 'replied', replyCount: 1, replyLength: 2, length: 2, state: 'replied' },
      }),
      makeLine(15, 3514, '事件', 'web-api/replied', 'src7/plugins/web-api/Timeline.ts:439', { sessionId: sid }),
    ];

    const trail = journalTrail.getTrail(596, rawLines);
    expect(trail.steps).toHaveLength(9);
    //G 确保用户原话没有混进任何步骤的 facts。
    expect(JSON.stringify(trail.steps)).not.toContain('8+9等于几');

    const flow = dataFlowModule.buildTrailDataFlow(trail);
    expect(flow.steps).toHaveLength(9);

    //M 验证骨架与插件分层，以及骨架逐行文件名映射。
    expect(flow.steps.map((s) => s.layer)).toEqual([
      'plugin', 'skeleton', 'plugin', 'skeleton', 'plugin', 'plugin', 'skeleton', 'plugin', 'plugin',
    ]);
    expect(flow.steps[1]?.skeletonFile).toBe('Sessions');
    expect(flow.steps[3]?.skeletonFile).toBe('Sessions');
    expect(flow.steps[6]?.skeletonFile).toBe('Sessions');
    expect(flow.steps[0]?.skeletonFile).toBe('');

    //M 验证每步都有非空主函数名、源码位置、摘要与至少一条前后变化，且步骤接力指针严丝合缝。
    for (let i = 0; i < flow.steps.length; i += 1) {
      const step = flow.steps[i]!;
      expect(step.step).toBe(i + 1);
      expect(step.fnName).not.toBe('');
      expect(step.fnSite).toContain(':');
      expect(step.summary).not.toBe('');
      expect(step.changes.length).toBeGreaterThan(0);
      expect(step.incoming.fromStep).toBe(i === 0 ? null : i);
      expect(step.outgoing.toStep).toBe(i === flow.steps.length - 1 ? null : i + 2);
    }

    //M 验证关键实测数据变化：#1 收件表新建、#2 会话 running、#4 关口一 6 个工具、#7 代答 + 4 段提示词 + done、#8 autoFinal、#9 写回 replied。
    expect(flow.steps[0]?.changes[0]).toMatchObject({ target: 'web_messages #596', field: 'status', source: 'real' });
    expect(flow.steps[1]?.changes[0]).toMatchObject({ target: 'Session.row', field: 'state', before: 'done', after: 'running', source: 'real' });
    expect(flow.steps[3]?.changes[0]).toMatchObject({ target: 'ChatRequest', field: 'tools', after: '6 个可用工具', source: 'real' });
    expect(flow.steps[6]?.changes.some((c) => c.field === 'system[]' && c.after.includes('4 段提示词'))).toBe(true);
    expect(flow.steps[6]?.changes.some((c) => c.field === 'answer' && c.after.includes('插件已代调'))).toBe(true);
    expect(flow.steps[6]?.changes.some((c) => c.field === 'state' && c.after === 'done')).toBe(true);
    expect(flow.steps[7]?.stage).toBe('自动兜底回话');
    expect(flow.steps[8]?.changes[1]).toMatchObject({ target: 'web_messages #596', field: 'status', after: 'replied', source: 'real' });

    const objectNames = flow.objects.map((o) => o.name);
    expect(objectNames).toContain('web_messages');
    expect(objectNames).toContain('sessions / Session.row');
    expect(objectNames).toContain('ChatRequest');
  });

  test('兼容带工具调用（Tools.execute + 报错 toolResult + 第二轮模型收尾）的历史轨迹', () => {
    const trail = journalTrail.getTrail(7, LINES);
    const flow = dataFlowModule.buildTrailDataFlow(trail);
    expect(flow.steps).toHaveLength(trail.steps.length);

    const toolsStep = flow.steps.find((s) => s.node === 'tools');
    expect(toolsStep).toBeDefined();
    expect(toolsStep?.layer).toBe('skeleton');
    expect(toolsStep?.skeletonFile).toBe('Tools');
    expect(toolsStep?.fnName).toBe('Tools.execute');
    expect(toolsStep?.changes.some((c) => c.target === 'ToolOutcome')).toBe(true);

    const secondSessionStep = flow.steps[4];
    expect(secondSessionStep?.node).toBe('sessions');
    expect(secondSessionStep?.changes.some((c) => c.after.includes('toolResult'))).toBe(true);
    expect(flow.objects.map((o) => o.name)).toContain('Tools / ToolOutcome');
  });

  test('启动画布（boot）生成清晰的骨架与插件初始化流转，不抛错无空引用', () => {
    const bootLines: TrailLine[] = [
      makeLine(1, 10, '函数', 'main', 'src7/Main.ts:45', { node: 'main', text: '校验参数' }),
      makeLine(2, 15, '函数', 'Resources', 'src7/Resources.ts:210', {
        node: 'resources',
        text: '打开主库',
        facts: { newServices: 'resources', state: '挂好了' },
      }),
      makeLine(3, 20, '函数', 'Tools', 'src7/Tools.ts:90', {
        node: 'tools',
        text: '工具登记表就绪',
        facts: { newServices: 'tools', state: '挂好了' },
      }),
      makeLine(4, 30, '函数', 'exec', 'src7/plugins/exec/index.ts:412', {
        node: 'exec',
        text: '挂载命令插件',
        facts: { newTools: 'exec', newServices: 'exec', state: '挂好了' },
      }),
      makeLine(5, 50, '事件', 'ready', 'src7/Main.ts:225', { node: 'main', text: 'ready' }),
      makeLine(6, 60, '函数', 'Http.listen', 'src7/plugins/http/index.ts:487', { node: 'http', text: '开始监听' }),
    ];
    const bootTrail: Trail = journalTrail.getBootTrail(bootLines);
    const flow = dataFlowModule.buildTrailDataFlow(bootTrail);

    expect(flow.steps).toHaveLength(6);
    expect(flow.steps[0]?.layer).toBe('skeleton');
    expect(flow.steps[0]?.skeletonFile).toBe('Main');
    expect(flow.steps[1]?.skeletonFile).toBe('Resources');
    expect(flow.steps[2]?.skeletonFile).toBe('Tools');
    expect(flow.steps[3]?.layer).toBe('plugin');
    expect(flow.steps[3]?.changes.some((c) => c.after.includes('+exec'))).toBe(true);
    expect(flow.steps[5]?.stage).toBe('HTTP 监听就绪');
    expect(flow.objects.length).toBeGreaterThan(0);
  });
});
