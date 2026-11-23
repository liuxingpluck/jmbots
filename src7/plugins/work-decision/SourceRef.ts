/**
 * 控制面任务的来源引用（sourceRef）：校验规范化、推去重键、补齐缺的子字段、按来源筛选。
 * 各渠道（relay、飞书、微信、网页）入池时带上 sourceRef，ControlPlane.ts 靠它去重和筛选；
 * 类型定义在 Types.ts（本文件只用类型，免得和 ControlPlane.ts 互相引用）。
 */
import * as checksModule from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as types from './Types.ts';

export type { TaskSourceRef } from './Types.ts';


/** 按来源筛任务的条件（GET /api/work-decision/tasks 的 6 个来源查询参数）。 */
export type SourceRefFilter = types.ControlTaskSourceFilter;

/** GET /api/work-decision/tasks 里和来源有关的原始查询参数。 */
export interface SourceRefQuery {
  /** 来源渠道。 */
  channel?: string;
  /** 来源机器人。 */
  bot?: string;
  /** 来源群号或会话号。 */
  chatId?: string;
  /** 来源 jmbots 会话 ID。 */
  sessionId?: string;
  /** 来源 relay 收件编号（正整数的字）。 */
  relayId?: string;
  /** 'true' 或 'false'。 */
  hasSource?: string;
}


/** sourceRef 里可选的文字子字段。 */
const TEXT_KEYS = ['bot', 'chatId', 'chatName', 'sessionId', 'messageId', 'sender', 'dedupeKey'] as const;

/** 筛选时按相等比较的维度（hasSource 另算）。 */
const FILTER_KEYS = ['channel', 'bot', 'chatId', 'sessionId', 'relayId'] as const;

/** 按文字比较的查询参数。 */
const QUERY_TEXT_KEYS = ['channel', 'bot', 'chatId', 'sessionId'] as const;

/** 来源子字段最长多少字。 */
const MAX_FIELD_CHARS = 200;

/** relayId 查询参数要是正整数的字。 */
const POSITIVE_DIGITS = /^[1-9]\d*$/u;


/** 来源引用的校验、去重键、合并与筛选（无状态，ControlPlane.ts 建一个共用）。 */
export class SourceRefHelper {
  /**
   * 校验并规范化外部传来的 sourceRef。
   * @param raw 请求体里的 sourceRef。
   * @returns 规范化后的来源：文字去首尾空白，空串的可选字段不写。
   * @throws Failure(400)：不是对象、channel 没写或空、chatType 不是 p2p/group、relayId 不是正整数、字段超长。
   */
  normalize(raw: unknown): types.TaskSourceRef {
    //G 要是一组“名字: 值”，channel 要有字。
    const record = checksModule.checkRecord(raw, 'sourceRef');
    const channel = this.readText(record['channel'], 'sourceRef.channel');
    if (channel === undefined) {
      throw new failureModule.Failure(400, 'sourceRef.channel 要写成非空字符串');
    }

    //M 可选的文字字段：去首尾空白，空串不写。
    const ref: types.TaskSourceRef = { channel };
    for (const key of TEXT_KEYS) {
      const value = this.readText(record[key], `sourceRef.${key}`);
      if (value !== undefined) {
        ref[key] = value;
      }
    }

    //G chatType 只认 p2p、group。
    if (record['chatType'] !== undefined) {
      ref.chatType = checksModule.checkAllowedValue(record['chatType'], types.SOURCE_CHAT_TYPES, 'sourceRef.chatType');
    }

    //G relayId 要是安全正整数（防超大数值失精度）。
    const relayId = record['relayId'];
    if (relayId !== undefined) {
      if (typeof relayId !== 'number' || !Number.isSafeInteger(relayId) || relayId <= 0) {
        throw new failureModule.Failure(400, 'sourceRef.relayId 要写成大于 0 的安全整数');
      }
      ref.relayId = relayId;
    }
    return ref;
  }

  /**
   * 推出去重键：显式 dedupeKey（去空白后非空）优先，其次 relay:<channel>:<relayId>，再次 msg:<channel>:<messageId>。
   * @param ref 已规范化的来源。
   * @returns 去重键；都没有时是 undefined（这样的来源不去重）。
   */
  deriveDedupeKey(ref: types.TaskSourceRef): string | undefined {
    //M 显式 dedupeKey 去首尾空白后非空才采用，纯空白降级走 relayId 或 messageId。
    const explicitKey = ref.dedupeKey?.trim() ?? '';
    if (explicitKey !== '') return explicitKey;

    if (ref.relayId !== undefined) return `relay:${ref.channel}:${String(ref.relayId)}`;

    const messageId = ref.messageId?.trim() ?? '';
    if (messageId !== '') return `msg:${ref.channel}:${messageId}`;

    return undefined;
  }

  /**
   * 复制一份来源（子字段都是标量，展开一层就是深拷贝）。
   * @param ref 来源；没有时回 undefined。
   */
  clone(ref?: types.TaskSourceRef): types.TaskSourceRef | undefined {
    if (ref === undefined) return undefined;

    return { ...ref };
  }

  /**
   * 用新来的来源补齐已有来源里没写的子字段，已有的一个都不改。
   * 补完后推出的去重键要是变了（比如原来只有 messageId、新来的带了 relayId），把原来的键写成 dedupeKey 钉住，
   * 免得同一件事以后按原来的键找不到它。
   * @param existing 任务上已有的来源。
   * @param incoming 这次来的来源。
   * @returns 合并后的新来源（不改两个入参）。
   */
  mergeMissing(existing: types.TaskSourceRef, incoming: types.TaskSourceRef): types.TaskSourceRef {
    const before = this.deriveDedupeKey(existing);
    const merged: types.TaskSourceRef = { ...existing };
    const target = merged as unknown as Record<string, unknown>;
    const source = incoming as unknown as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      //M 只补已有来源里没写的子字段。
      if (target[key] === undefined) {
        target[key] = source[key];
      }
    }

    //M 去重键变了就钉回原来的键。
    if (before !== undefined && this.deriveDedupeKey(merged) !== before) {
      merged.dedupeKey = before;
    }
    return merged;
  }

  /**
   * 是不是同一条消息：同一渠道，relayId 一样或 messageId 一样（去重键对不上时的退路）。
   * @param existing 任务上已有的来源。
   * @param incoming 这次来的来源。
   */
  isSameMessage(existing: types.TaskSourceRef, incoming: types.TaskSourceRef): boolean {
    if (existing.channel !== incoming.channel) return false;

    if (incoming.relayId !== undefined && existing.relayId === incoming.relayId) return true;

    return incoming.messageId !== undefined && existing.messageId === incoming.messageId;
  }

  /**
   * 任务的来源是否符合筛选条件（channel、bot、chatId、sessionId、relayId 按相等比，hasSource 看有没有来源）。
   * @param ref 任务的来源；没有来源时是 undefined。
   * @param filter 筛选条件；不写的维度不筛。
   */
  matchesFilter(ref: types.TaskSourceRef | undefined, filter: SourceRefFilter): boolean {
    if (filter.hasSource === true && ref === undefined) return false;

    if (filter.hasSource === false && ref !== undefined) return false;

    //M 只比写了的维度；一个都没写就算符合。
    const wanted = FILTER_KEYS.filter((key) => filter[key] !== undefined);
    if (wanted.length === 0) return true;

    if (ref === undefined) return false;

    return wanted.every((key) => ref[key] === filter[key]);
  }

  /**
   * 解析 GET /api/work-decision/tasks 的来源查询参数。
   * @param query 原始查询参数。
   * @returns 筛选条件；一个来源参数都没写时是 undefined。
   * @throws Failure(400)：relayId 不是正整数、hasSource 不是 true/false。
   */
  parseQuery(query: SourceRefQuery): SourceRefFilter | undefined {
    const filter: SourceRefFilter = {};
    for (const key of QUERY_TEXT_KEYS) {
      //M 文字维度去首尾空白，空串不筛。
      const value = query[key]?.trim() ?? '';
      if (value !== '') {
        filter[key] = value;
      }
    }

    //G relayId 要是安全正整数（防超长数字串变 Infinity 或失精度）。
    const relayText = query.relayId?.trim() ?? '';
    if (relayText !== '') {
      if (!POSITIVE_DIGITS.test(relayText)) {
        throw new failureModule.Failure(400, 'relayId 要写成大于 0 的安全整数');
      }
      const relayId = Number(relayText);
      if (!Number.isSafeInteger(relayId) || relayId <= 0) {
        throw new failureModule.Failure(400, 'relayId 要写成大于 0 的安全整数');
      }
      filter.relayId = relayId;
    }

    //G hasSource 只认 true、false。
    const hasText = query.hasSource?.trim() ?? '';
    if (hasText !== '') {
      const flag = checksModule.checkAllowedValue(hasText, ['true', 'false'], 'hasSource');
      filter.hasSource = flag === 'true';
    }

    if (Object.keys(filter).length === 0) return undefined;

    return filter;
  }

  /**
   * 一句话说清来源（写进时间线和默认标题）：渠道 / 机器人 / 群名或群号。
   * @param ref 来源。
   */
  describe(ref: types.TaskSourceRef): string {
    const parts = [ref.channel];
    if (ref.bot !== undefined) {
      parts.push(ref.bot);
    }
    const chat = ref.chatName ?? ref.chatId;
    if (chat !== undefined) {
      parts.push(chat);
    }
    return parts.join(' / ');
  }

  /**
   * 读一个可选文字子字段：没写、null、空串都算没写。
   * @param raw 原始值。
   * @param label 报错时说的字段名。
   * @throws Failure(400)：不是字符串或超长。
   */
  private readText(raw: unknown, label: string): string | undefined {
    if (raw === undefined || raw === null) return undefined;

    if (typeof raw !== 'string') {
      throw new failureModule.Failure(400, `${label} 要写成字符串`);
    }

    //G 去首尾空白后超长的拒收。
    const text = raw.trim();
    if (text.length > MAX_FIELD_CHARS) {
      throw new failureModule.Failure(400, `${label} 不能超过 ${String(MAX_FIELD_CHARS)} 字`);
    }
    if (text === '') return undefined;

    return text;
  }
}
