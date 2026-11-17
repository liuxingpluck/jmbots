/**
 * Trail.ts：一条请求按消息号收成按插件走的步骤；别的会话的行、web-api/status 不混进来；出错标红；不带对话内容。
 */
import { describe, expect, test } from 'bun:test';
import { nodeOf, trailOf, type TrailLine } from './Trail.ts';

let id = 0;
function line(at: number, kind: string, name: string, site: string, extra: Partial<TrailLine> = {}): TrailLine {
  id += 1;
  return { id, at, kind, name, listeners: [], text: '', site, sessionId: null, messageId: null, vars: {}, ...extra };
}

const S = 's1';
const lines: TrailLine[] = [
  line(0, '事件', 'web-api/received', 'src7/plugins/web-api/Timeline.ts:242', { messageId: 7 }),
  line(3, '函数', 'WebApi.accept', 'src7/plugins/web-api/index.ts:297', { messageId: 7, text: '收下一条消息', vars: { 消息号: 7, 机器人: '助手' } }),
  line(5, '函数', 'Bots.receive', 'src7/plugins/bots/index.ts:193', { text: '渠道收到一句话', vars: { 渠道: 'http' } }),
  line(6, '事件', 'web-api/status', 'src7/plugins/web-api/index.ts:165', { listeners: ['feishu'] }),
  line(8, '函数', 'Bot.receive', 'src7/plugins/bots/index.ts:355', { sessionId: S, text: '交给会话' }),
  line(9, '事件', 'session/message', 'src7/Sessions.ts:354', { sessionId: S, listeners: ['journal', 'bot-front-desk'], vars: { 角色: 'user', 说了: '私人内容' } }),
  line(10, '函数', 'Session.loop', 'src7/Sessions.ts:281', { sessionId: 'other', text: '别人的会话' }),
  line(12, '函数', 'Session.loop', 'src7/Sessions.ts:281', { sessionId: S, text: '调模型', vars: { 第几步: 1 } }),
  line(2012, '事件', 'session/message', 'src7/Sessions.ts:354', { sessionId: S, vars: { 角色: 'assistant', 要了工具: 'time' } }),
  line(2015, '函数', 'Tools.execute', 'src7/Tools.ts:140', { sessionId: S, text: '执行工具', vars: { 工具: 'time' } }),
  line(2020, '事件', 'session/message', 'src7/Sessions.ts:354', { sessionId: S, vars: { 角色: 'toolResult', 工具: 'time', 出错: true } }),
  line(2030, '事件', 'session/change', 'src7/Sessions.ts:366', { sessionId: S, vars: { 状态: 'done' } }),
  line(2032, '函数', 'Timeline.reply', 'src7/plugins/web-api/Timeline.ts:304', { sessionId: S, messageId: 7, vars: { 消息号: 7 } }),
  line(2033, '事件', 'web-api/replied', 'src7/plugins/web-api/Timeline.ts:305', { sessionId: S }),
  line(2040, '函数', 'Session.loop', 'src7/Sessions.ts:281', { sessionId: S, text: '下一轮，不算' }),
];

describe('Trail', () => {
  test('文件归到图上的点', () => {
    expect(nodeOf('src7/plugins/wechat/index.ts:1')).toBe('wechat-kefu');
    expect(nodeOf('src7/Tools.ts:129')).toBe('tools');
    expect(nodeOf('src7/Chat.ts:91')).toBe('sessions');
  });

  test('按先后收成步骤，不混别的会话和定时事件', () => {
    const trail = trailOf(7, lines);
    expect(trail.session).toBe(S);
    expect(trail.bot).toBe('助手');
    expect(trail.channel).toBe('http');
    expect(trail.state).toBe('done');
    expect(trail.steps.map((step) => step.node)).toEqual(['web-api', 'bots', 'sessions', 'tools', 'sessions', 'web-api']);
    const names = trail.steps.flatMap((step) => step.rows.map((row) => row.name));
    expect(names).not.toContain('web-api/status');
    expect(names.filter((name) => name === 'Session.loop')).toHaveLength(1);
    expect(trail.ms).toBe(2033);
    expect(trail.steps[2]?.title).toContain('调模型（等了 2.0 秒）');
  });

  test('关键变量的键换成英文，说明表里是原来的中文名', () => {
    const trail = trailOf(7, lines);
    const facts = trail.steps.flatMap((step) => step.rows.map((row) => row.facts));
    expect(facts).toContainEqual({ role: 'toolResult', tool: 'time', failed: true });
    expect(facts.flatMap((item) => Object.keys(item)).filter((key) => /\p{Script=Han}/u.test(key))).toEqual([]);
    expect(trail.notes).toMatchObject({ role: '角色', tool: '工具', failed: '出错', name: '这一行是哪个函数或事件' });
  });

  test('出错标红；每步不带对话内容，用户原话只在 preview', () => {
    const trail = trailOf(7, lines);
    expect(trail.error).toBe(true);
    expect(trail.steps[4]?.error).toBe(true);
    expect(JSON.stringify(trail.steps)).not.toContain('私人内容');
    expect(trail.preview).toBe('私人内容');
    expect(trail.steps[2]?.rows[0]?.listeners).toEqual(['bot-front-desk']);
  });
});
