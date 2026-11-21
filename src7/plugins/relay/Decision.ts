/**
 * relay 与工作决策台（work-decision）的选择、留言收件归档辅助模块。
 */
import * as botUtils from '../../utils/Bots.ts';
import type * as requestEventModule from '../../utils/RequestEvent.ts';
import * as utils from '../../utils/index.ts';
import type { Helper } from './index.ts';


/** 决策图收件的来源，不代表机器人渠道或会话。 */
export const DECISION_CHANNEL = 'work-decision';
export const LEGACY_DECISION_CHANNEL = 'decision-map';


/** 数据库轻量查询执行器回调。 */
export interface RelayDbOps {
  query<T>(sql: string, values: (string | number | null)[]): T[];
  run(sql: string, values: (string | number | null)[]): { lastInsertRowid: number | bigint };
}


/**
 * 将工作决策留言或用户选项写入 relay_items 收件箱，或对已确认节点归档。
 */
export function handleDecisionNote(
  rawConfig: Record<string, unknown>,
  helpers: readonly Helper[],
  dbOps: RelayDbOps,
  request: requestEventModule.EventArg<'work-decision/note'>,
): { ok: boolean; id?: number; error?: string } {
  if (request.action === 'reply') return { ok: false };

  const helper = helpers.find((item) => item.name === request.helper);
  if (helper === undefined) return { ok: false, error: 'relay 没有该外部助手' };

  const key = `${DECISION_CHANNEL}:${request.node}`;
  const oldKey = `${LEGACY_DECISION_CHANNEL}:${request.node}`;
  const params = [helper.name, DECISION_CHANNEL, LEGACY_DECISION_CHANNEL, key, oldKey];
  const condition = 'helper = ? AND channel IN (?, ?) AND session_id IN (?, ?)';
  if (request.action === 'ack') {
    const sql = `UPDATE relay_items SET state = 'replied', replied_at = ? WHERE ${condition} AND state = 'pending'`;
    dbOps.run(sql, [Date.now(), ...params]);
    return { ok: true };
  }

  const sql = `SELECT id FROM relay_items WHERE ${condition} ORDER BY id LIMIT 1`;
  const [previous] = dbOps.query<{ id: number }>(sql, params);
  if (previous !== undefined) return { ok: true, id: previous.id };

  const bot = botUtils.getDefaultBot(rawConfig);
  if (bot === undefined || request.text === undefined) {
    return { ok: false, error: '缺少收件内容或机器人' };
  }

  const sender = '工作决策';
  const address = { owner: true, role: 'owner', senderName: sender, decisionTarget: request.target };
  const insert = 'INSERT INTO relay_items (bot, helper, session_id, channel, address, owner, sender, chat,'
    + " chat_name, text, at, reminded) VALUES (?, ?, ?, ?, ?, 1, ?, 'p2p', '', ?, ?, 1)";
  const values = [bot, helper.name, key, DECISION_CHANNEL, JSON.stringify(address), sender, request.text, Date.now()];
  const created = dbOps.run(insert, values);
  return { ok: true, id: Number(created.lastInsertRowid) };
}


/**
 * 从收件保存的地址里提取精确工作决策目标节点与可选留言号。
 */
export function extractDecisionTarget(address: unknown): { node: string; note?: string } | undefined {
  const stored = utils.getField(address, 'decisionTarget');
  const node = utils.getStringField(stored, 'node');
  if (node === '') return undefined;

  const note = utils.getStringField(stored, 'note') || undefined;
  return { node, note };
}
