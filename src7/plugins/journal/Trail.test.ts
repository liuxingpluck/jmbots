/**
 * Trail.ts：一条请求按消息号收成按插件走的步骤；别的会话的行、web-api/status 不混进来；出错标红；不带对话内容；
 * 跑法：bun test ./src7/plugins/journal
 */
import { describe, expect, test } from 'bun:test';
import { LINES, SESSION as S } from './tests/Lines.ts';
import { getNode, getTrail, type TrailLine } from './Trail.ts';
import * as traceText from '../../../web/src/locales/Trace.ts';


describe('Trail', () => {
  test('文件归到泳道图的道', () => {
    expect(getNode('src7/plugins/wechat/index.ts:1')).toBe('wechat-kefu');
    expect(getNode('src7/plugins/memory/index.ts:1')).toBe('memory');
    expect(getNode('src7/Tools.ts:129')).toBe('tools');
    expect(getNode('src7/Sessions.ts:348')).toBe('sessions');
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
});
