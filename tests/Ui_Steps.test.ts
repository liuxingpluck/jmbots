/**
 * 会话步骤展示规则（web/src/Panel/Steps.ts）的离线测试：items、dispatches。
 * 假数据照 src6/channels/HttpSessions.ts 返回的 steps 形状和 src6/services/Dispatch.ts 的
 * DispatchRecord 写；后端在补的键（calls/result/model/thinking/ending）按“有就显示、没有不崩”测。
 */
import * as bunTest from 'bun:test';
import * as stepsModule from '../web/src/Panel/Steps.ts';
import type * as types from '../web/src/Types.ts';


/**
 * 造一步。
 * @param patch 要改的字段。
 */
function stepOf(patch: Partial<types.SessionStep> = {}): types.SessionStep {
  return {
    seq: 1,
    at: 1_700_000_000_000,
    row: 'E1',
    eventType: 'session.started',
    event: {},
    stateBefore: 'idle',
    stateAfter: 'wait_response',
    stored: {},
    triggered: {},
    ...patch,
  };
}


/** 一份完整的分派记录（分派步的 stored，形状照 src6/services/DispatchTypes.ts 的 DispatchRecord）。 */
const DISPATCH_STORED = {
  messageIds: [7],
  startedAt: 1_700_000_000_000,
  ms: 12,
  by: 'fallback',
  from: { channel: 'http', source: 'web' },
  situation: {
    bot: '小测',
    text: '读一下这个文件',
    message: { id: 7, channel: 'http', source: 'web', at: 1_700_000_000_000, textChars: 8, images: 0 },
    sessions: [{ id: 's-9', title: '旧会话', workspace: '日常', state: 'idle', summary: '', lastUser: '', updatedAt: 1_699_999_000_000 }],
    workspaces: [{ name: '日常', description: '' }, { name: '开发', description: '' }],
  },
  result: {
    session: 's-1',
    workspace: '日常',
    title: '读文件',
    model: 'magpie/deepseek',
    thinking: 'high',
    reason: '沿用最近的会话',
  },
  checks: [],
};


bunTest.describe('会话步骤展示', () => {
  bunTest.test('items：顺序不变，分派步 dispatch=true，摘要和事实从 event 里取', () => {
    /** 展示器：不传 t，用中文原文。 */
    const presenter = new stepsModule.StepsPresenter();
    /** 假步骤：分派 + E2（带 calls）+ E3（带 result）+ E5 + E7（缺键）。 */
    const steps: types.SessionStep[] = [
      stepOf({ seq: 1, row: '分派', eventType: 'message.dispatched', stored: DISPATCH_STORED }),
      stepOf({
        seq: 2,
        row: 'E2',
        eventType: 'session.step',
        stateBefore: 'wait_response',
        stateAfter: 'run_tools',
        event: {
          model: 'magpie/deepseek',
          thinking: 'high',
          calls: [{ id: 'c1', name: 'read', args: '{"path":"F:/a/b.md"}' }],
        },
      }),
      stepOf({
        seq: 3,
        row: 'E3',
        eventType: 'session.tool',
        stateBefore: 'run_tools',
        stateAfter: 'wait_response',
        event: { name: 'read', callId: 'c1', ok: true, resultChars: 120, result: '文件内容' },
      }),
      stepOf({ seq: 4, row: 'E5', eventType: 'session.reply', event: { ending: 'done', model: 'magpie/deepseek' } }),
      stepOf({ seq: 5, row: 'E7', eventType: 'session.ended', stateAfter: 'idle', event: {} }),
    ];
    /** 界面条目。 */
    const items = presenter.items(steps);
    bunTest.expect(items).toHaveLength(5);
    bunTest.expect(items.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
    //M 分派步。
    bunTest.expect(items[0]!.dispatch).toBe(true);
    bunTest.expect(items[0]!.summary).toBe('分派到会话 s-1 · 模型 magpie/deepseek');
    bunTest.expect(items[1]!.dispatch).toBe(false);
    //M E2：摘要列工具名；calls 的 name+args 整理进 facts（验收在这看 read 的 path）。
    bunTest.expect(items[1]!.summary).toBe('模型返回 · 调用 read');
    bunTest.expect(items[1]!.state).toBe('wait_response → run_tools');
    bunTest.expect(items[1]!.time).toMatch(/^\d{2}:\d{2}:\d{2}$/u);
    /** read 那条调用。 */
    const call = items[1]!.facts.find((fact) => fact.key === 'call:c1');
    bunTest.expect(call?.label).toBe('调用 read');
    bunTest.expect(call?.value).toContain('F:/a/b.md');
    //M E3：结果片段进 facts，摘要带结果字数。
    bunTest.expect(items[2]!.summary).toBe('工具 read 完成 · 结果 120 字');
    bunTest.expect(items[2]!.facts.some((fact) => fact.key === 'result' && fact.value === '文件内容')).toBe(true);
    //M E5 有 ending；E7 什么键都没有也不崩，退回“未记录”。
    bunTest.expect(items[3]!.summary).toBe('回复已发出 · 结局 done');
    bunTest.expect(items[4]!.summary).toBe('运行结束 · 未记录');
  });

  bunTest.test('dispatches：只取分派行，卡片给出谁分的、什么情况、模型+思考档、为什么、谁定的、去向', () => {
    /** 展示器。 */
    const presenter = new stepsModule.StepsPresenter();
    /** 卡片：夹一步 E1，确认它不进卡片。 */
    const cards = presenter.dispatches([
      stepOf({ row: '分派', eventType: 'message.dispatched', stored: DISPATCH_STORED }),
      stepOf({ seq: 2 }),
    ]);
    bunTest.expect(cards).toHaveLength(1);
    /** 第一张卡。 */
    const card = cards[0]!;
    bunTest.expect(card.from).toBe('http · web');
    bunTest.expect(card.situation).toContain('机器人 小测');
    bunTest.expect(card.situation).toContain('原话「读一下这个文件」');
    bunTest.expect(card.situation).toContain('候选会话 1 个');
    bunTest.expect(card.situation).toContain('当时的工作区 日常、开发');
    bunTest.expect(card.model).toBe('magpie/deepseek · 思考档 high');
    bunTest.expect(card.reason).toBe('沿用最近的会话');
    bunTest.expect(card.by).toBe('程序兜底');
    bunTest.expect(card.target).toBe('会话 s-1 · 工作区 日常');
    /** 决策模型定的。 */
    const decision = presenter.dispatches([stepOf({ row: '分派', stored: { ...DISPATCH_STORED, by: 'decision' } })])[0]!;
    bunTest.expect(decision.by).toBe('决策模型');
  });

  bunTest.test('0.6.0 旧记录不崩：workspaces 是字符串数组、by=llm 也认', () => {
    /** 展示器。 */
    const presenter = new stepsModule.StepsPresenter();
    /** 旧形状：字符串工作区、lastSession、by=llm。 */
    const old = presenter.dispatches([stepOf({
      row: '分派',
      stored: {
        by: 'llm',
        from: { channel: 'http', source: 'web' },
        situation: { bot: '小测', text: '旧记录', lastSession: { id: 's-9', title: '旧会话' }, workspaces: ['日常'] },
        result: { session: 's-1', workspace: '日常', title: '旧', model: 'magpie/deepseek', thinking: 'high', reason: '旧理由' },
      },
    })])[0]!;
    bunTest.expect(old.by).toBe('常规模型');
    bunTest.expect(old.situation).toContain('当时的工作区 日常');
    bunTest.expect(old.situation).toContain('候选会话 0 个');
    bunTest.expect(old.reason).toBe('旧理由');
  });

  bunTest.test('分派记录缺键不崩：没有的字段退回“未记录”；by=direct 是“调用方指定”', () => {
    /** 展示器。 */
    const presenter = new stepsModule.StepsPresenter();
    /** stored 是空表的一张卡。 */
    const empty = presenter.dispatches([stepOf({ row: '分派', stored: {} })])[0]!;
    bunTest.expect(empty.from).toBe('未记录');
    bunTest.expect(empty.situation).toContain('未记录');
    bunTest.expect(empty.situation).toContain('候选会话 0 个');
    bunTest.expect(empty.model).toBe('未记录 · 思考档 默认（最高档）');
    bunTest.expect(empty.reason).toBe('当时的分派理由未记录。');
    bunTest.expect(empty.by).toBe('程序兜底');
    bunTest.expect(empty.target).toBe('会话 未记录 · 工作区 未记录');
    /** 调用方指定了会话。 */
    const direct = presenter.dispatches([stepOf({ row: '分派', stored: { by: 'direct' } })])[0]!;
    bunTest.expect(direct.by).toBe('调用方指定');
  });

  bunTest.test('calls 的 args 是对象也能读（后端截断前是 JSON 字符串，缺了按对象兜底）；坏项跳过', () => {
    /** 展示器。 */
    const presenter = new stepsModule.StepsPresenter();
    /** E2：args 是对象、还夹一个坏项。 */
    const items = presenter.items([
      stepOf({
        row: 'E2',
        event: { calls: [{ id: 'c2', name: 'exec', args: { command: 'bun test' } }, '坏的', null] },
      }),
    ]);
    /** exec 那条调用。 */
    const call = items[0]!.facts.find((fact) => fact.key === 'call:c2');
    bunTest.expect(call?.label).toBe('调用 exec');
    bunTest.expect(call?.value).toContain('bun test');
    bunTest.expect(items[0]!.summary).toBe('模型返回 · 调用 exec');
  });
});
