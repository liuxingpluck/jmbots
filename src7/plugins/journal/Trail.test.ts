/**
 * Trail.ts：一条请求按消息号收成按插件走的步骤；别的会话的行、web-api/status 不混进来；出错标红；不带对话内容；
 * 跑法：bun test ./src7/plugins/journal
 */
import { describe, expect, test } from 'bun:test';
import { LINES, SESSION as S } from './tests/Lines.ts';
import type { TrailLine } from '../../utils/Trail.ts';
import { getNode, getPickedTrail, getSteps, getTrail, pick } from './Trail.ts';
import * as traceText from '../../../web/src/locales/Trace.ts';


describe('Trail', () => {
  test('旧流水的模型失败事件用新名字显示并仍标为错误', () => {
    const original = LINES[0]!;
    const failure: TrailLine = { ...original, kind: '事件', name: 'model/failed', vars: {} };
    const { steps } = getSteps([failure]);
    expect(steps[0]?.error).toBe(true);
    expect(steps[0]?.rows[0]).toMatchObject({ name: 'session/model-failed', error: true });
  });

  test('文件归到泳道图的道', () => {
    expect(getNode('src7/plugins/wechat/index.ts:1')).toBe('wechat-kefu');
    expect(getNode('src7/plugins/memory/index.ts:1')).toBe('memory');
    expect(getNode('src7/Tools.ts:129')).toBe('tools');
    expect(getNode('src7/Sessions.ts:348')).toBe('sessions');
  });

  test('getPickedTrail 只挑一遍：轨迹和挑中的行跟分开调 pick、getTrail 完全一样', () => {
    const both = getPickedTrail(7, LINES);
    expect(both.trail).toEqual(getTrail(7, LINES));
    expect(both.picked).toEqual(pick(7, LINES).picked);
  });

  test('按先后收成步骤，不混别的会话和定时事件', () => {
    const trail = getTrail(7, LINES);
    expect(trail.session).toBe(S);
    expect(trail.bot).toBe('助手');
    expect(trail.channel).toBe('http');
    expect(trail.state).toBe('done');
    expect(trail.steps.map((step) => step.node)).toEqual(['web-api', 'bots', 'sessions', 'tools', 'sessions', 'web-api']);
    const names = trail.steps.flatMap((step) => step.rows.map((row) => row.name));
    expect(names).not.toContain('web-api/status');
    expect(names.filter((name) => name === 'Session.loop')).toHaveLength(1);
    expect(names.filter((name) => name === 'session/before-model')).toHaveLength(2);
    expect(names.filter((name) => name === 'session/new-message')).toHaveLength(4);
    expect(trail.ms).toBe(2033);
    expect(trail.steps[2]?.title).toContain('调模型（等了 2.0 秒）');
  });

  test('渠道来的消息：只带标准消息号的行排在收件行前面也算，别的收件号的行不算', () => {
    const sourceId = '["feishu","cli_a","om_1"]';
    const make = (id: number, name: string, site: string, extra: Partial<TrailLine>): TrailLine => {
      return { id, at: id, kind: '函数', name, listeners: [], text: name, site, sessionId: null, messageId: null, vars: {}, ...extra };
    };
    const lines = [
      make(1, 'Feishu.start', 'src7/plugins/feishu/index.ts:600', { sourceId, vars: { messageId: sourceId } }),
      make(2, 'Feishu.onMessage', 'src7/plugins/feishu/Inbound.ts:236', { sourceId, vars: { messageId: sourceId } }),
      make(3, 'Timeline.insert', 'src7/plugins/web-api/Timeline.ts:304', { messageId: 8, sourceId, vars: { messageId: 8, sourceId } }),
      make(4, 'Timeline.insert', 'src7/plugins/web-api/Timeline.ts:304', { messageId: 9, sourceId, vars: { messageId: 9, sourceId } }),
      make(5, 'Bot.receive', 'src7/plugins/bots/index.ts:355', { sessionId: 's8', messageId: 8, vars: { messageId: 8 } }),
      make(6, 'Feishu.onMessage', 'src7/plugins/feishu/Inbound.ts:236', { sourceId: '["feishu","cli_a","om_2"]', vars: { messageId: 'x' } }),
    ];
    const trail = getTrail(8, lines);
    const names = trail.steps.flatMap((step) => step.rows.map((row) => row.name));
    expect(names).toEqual(['Feishu.start', 'Feishu.onMessage', 'Timeline.insert', 'Bot.receive']);
    expect(trail.steps[0]?.node).toBe('feishu');
    expect(trail.session).toBe('s8');
  });

  test('关键变量的键换成英文，说明表里是原来的中文名', () => {
    const trail = getTrail(7, LINES);
    const facts = trail.steps.flatMap((step) => step.rows.map((row) => row.facts));
    expect(facts).toContainEqual({ role: 'toolResult', tool: 'time', failed: true });
    expect(facts.flatMap((item) => Object.keys(item)).filter((key) => /\p{Script=Han}/u.test(key))).toEqual([]);
    expect(trail.notes).toMatchObject({ role: '角色', tool: '工具', failed: '出错', name: '这一行是哪个函数或事件' });
  });

  test('出错标红；每步不带对话内容，用户原话只在 preview；事件行配人话', () => {
    const trail = getTrail(7, LINES);
    expect(trail.error).toBe(true);
    expect(trail.steps[4]?.error).toBe(true);
    expect(JSON.stringify(trail.steps)).not.toContain('私人内容');
    expect(trail.preview).toBe('私人内容');
    expect(trail.steps[2]?.rows[0]?.listeners).toEqual(['bot-front-desk']);

    //M 事件行的人话（原来 switch 那段改成 if 后照旧）。
    const texts = trail.steps.flatMap((step) => step.rows.map((row) => row.text));
    expect(texts).toContain('收件表记下这条消息');
    expect(texts).toContain('模型要用工具：time');
    expect(texts).toContain('工具 time 给了结果');
    expect(texts).toContain('会话做完了');
  });

  test('同一轨迹兼容新旧流水，步骤保留文案编号和所需插值', () => {
    const mixed = LINES.map((line) => {
      if (line.name !== 'Tools.execute') return line;

      return { ...line, text: 'trace.relay.accept', vars: { helper: 'reviewer', session: S, privateText: '只给流水' } };
    });
    const trail = getTrail(7, mixed);
    const rows = trail.steps.flatMap((step) => step.rows);
    const added = rows.find((row) => row.text === 'trace.relay.accept');
    expect(added?.params).toEqual({ helper: 'reviewer' });
    expect(traceText.getTraceText('en', added!.text, added!.params)).toBe('Received a reply from reviewer');
    expect(rows.map((row) => row.text)).toContain('收件表记下这条消息');
    expect(JSON.stringify(trail.steps)).not.toContain('只给流水');
  });

  test('FACT_KEYS 放宽飞书、说话人、裁剪、审批与记忆数值，People.resolve 的 role 映射为 speakerRole 且不收 args', () => {
    const base = LINES[0]!;
    const sample: TrailLine[] = [
      { ...base, id: 1, at: 10, kind: '事件', name: 'web-api/received', messageId: 12, vars: {} },
      {
        ...base, id: 2, at: 12, kind: '函数', name: 'Feishu.onMessage',
        site: 'src7/plugins/feishu/Inbound.ts:233', messageId: 12,
        vars: { type: 'text', chat: 'group', called: true },
      },
      {
        ...base, id: 3, at: 14, kind: '函数', name: 'People.resolve',
        site: 'src7/plugins/people/index.ts:213', sessionId: 's12', messageId: 12,
        vars: { personName: '张三', role: 'owner', channel: 'feishu' },
      },
      {
        ...base, id: 4, at: 16, kind: '函数', name: 'ContextFit.fit',
        site: 'src7/plugins/context-fit/index.ts:349', sessionId: 's12',
        vars: { tokensBefore: 9000, tokensAfter: 4200, trimmedCount: 3, droppedCount: 2 },
      },
      {
        ...base, id: 5, at: 18, kind: '函数', name: 'Approval.review',
        site: 'src7/plugins/approval/index.ts:836', sessionId: 's12',
        vars: { verdict: 'allow', decidedBy: 'rule', args: '{"cmd":"ls"}' },
      },
      {
        ...base, id: 6, at: 20, kind: '函数', name: 'Memory.recall',
        site: 'src7/plugins/memory/index.ts:262', sessionId: 's12',
        vars: { skillCount: 2, citationCount: 5 },
      },
    ];
    const trail = getTrail(12, sample);
    const byName = new Map(trail.steps.flatMap((step) => step.rows.map((row) => [row.name, row.facts])));
    expect(byName.get('Feishu.onMessage')).toEqual({ type: 'text', chat: 'group', called: true });
    expect(byName.get('People.resolve')).toEqual({ channel: 'feishu', personName: '张三', speakerRole: 'owner' });
    expect(byName.get('ContextFit.fit')).toEqual({
      tokensBefore: 9000, tokensAfter: 4200, trimmedCount: 3, droppedCount: 2,
    });
    expect(byName.get('Approval.review')).toEqual({ verdict: 'allow', decidedBy: 'rule' });
    expect(byName.get('Memory.recall')).toEqual({ skillCount: 2, citationCount: 5 });
    expect(trail.notes['speakerRole']).toBe('说话人身份');
  });
});
