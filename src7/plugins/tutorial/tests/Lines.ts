/**
 * 测试用的一条请求的跟踪行：Trail.test.ts、Lanes.test.ts 共用。放在 tests/ 下，编译版不嵌、找“谁调它”也不扫。
 * 消息 7，会话 s1：web-api 收下 → bots 分给会话 → 调模型要了工具 time → 执行（出错）→ 再调一次模型 → 做完 → 回话写回。
 * 中间夹着别的会话的一行、定时的 web-api/status、回话写回之后的一行，都不该算进来。
 */
import type { TrailLine } from '../Trail.ts';


let id = 0;
/**
 * 一行跟踪行。
 * @param at 时刻。
 * @param kind 函数还是事件。
 * @param name 跟踪点名或事件名。
 * @param site 文件:行号。
 * @param extra 别的字段。
 */
function line(at: number, kind: string, name: string, site: string, extra: Partial<TrailLine> = {}): TrailLine {
  id += 1;
  return { id, at, kind, name, listeners: [], text: '', site, sessionId: null, messageId: null, vars: {}, ...extra };
}


/** 这条请求的会话。 */
export const SESSION = 's1';

/** 这条请求的行，按先后。 */
export const LINES: TrailLine[] = [
  line(0, '事件', 'web-api/received', 'src7/plugins/web-api/Timeline.ts:242', { messageId: 7 }),
  line(3, '函数', 'WebApi.accept', 'src7/plugins/web-api/index.ts:297', { messageId: 7, text: '收下一条消息', vars: { 消息号: 7, 机器人: '助手' } }),
  line(5, '函数', 'Bots.receive', 'src7/plugins/bots/index.ts:193', { text: '渠道收到一句话', vars: { 渠道: 'http' } }),
  line(6, '事件', 'web-api/status', 'src7/plugins/web-api/index.ts:165', { listeners: ['feishu'] }),
  line(8, '函数', 'Bot.receive', 'src7/plugins/bots/index.ts:355', { sessionId: SESSION, text: '交给会话' }),
  line(9, '事件', 'session/message', 'src7/Sessions.ts:354', { sessionId: SESSION, listeners: ['journal', 'bot-front-desk'], vars: { 角色: 'user', 说了: '私人内容' } }),
  line(10, '函数', 'Session.loop', 'src7/Sessions.ts:281', { sessionId: 'other', text: '别人的会话' }),
  line(11, '事件', 'session/request', 'src7/Sessions.ts:270', { sessionId: SESSION, listeners: ['prompt'] }),
  line(12, '函数', 'Session.loop', 'src7/Sessions.ts:281', { sessionId: SESSION, text: '调模型', vars: { 第几步: 1 } }),
  line(2012, '事件', 'session/message', 'src7/Sessions.ts:354', { sessionId: SESSION, vars: { 角色: 'assistant', 要了工具: 'time' } }),
  line(2015, '函数', 'Tools.execute', 'src7/Tools.ts:140', { sessionId: SESSION, text: '执行工具', vars: { 工具: 'time' } }),
  line(2020, '事件', 'session/message', 'src7/Sessions.ts:354', { sessionId: SESSION, vars: { 角色: 'toolResult', 工具: 'time', 出错: true } }),
  line(2021, '事件', 'session/request', 'src7/Sessions.ts:270', { sessionId: SESSION, listeners: ['prompt'] }),
  line(2025, '事件', 'session/message', 'src7/Sessions.ts:354', { sessionId: SESSION, vars: { 角色: 'assistant' } }),
  line(2030, '事件', 'session/change', 'src7/Sessions.ts:366', { sessionId: SESSION, vars: { 状态: 'done' } }),
  line(2032, '函数', 'Timeline.reply', 'src7/plugins/web-api/Timeline.ts:304', { sessionId: SESSION, messageId: 7, vars: { 消息号: 7 } }),
  line(2033, '事件', 'web-api/replied', 'src7/plugins/web-api/Timeline.ts:305', { sessionId: SESSION }),
  line(2040, '函数', 'Session.loop', 'src7/Sessions.ts:281', { sessionId: SESSION, text: '下一轮，不算' }),
];
