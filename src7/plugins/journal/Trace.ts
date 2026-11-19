/**
 * 回话追溯用的事件：把流水行换成网页 ReplyTraceView 里 TraceEvent 的外壳（web/src/Types.ts）。
 * 原来在 web-api/Trace.ts 里，web-api 要靠 import Trail.ts 才能取事件人话；现在由 journal 自己做，
 * web-api 发 journal/request（reply-lines）拿现成的事件。
 * 本文件只 import type 同目录的 index.ts，免得绕成一圈。
 */
import * as traceText from '../../../web/src/locales/Trace.ts';
import type { JournalEvent } from './index.ts';
import * as trailModule from './Trail.ts';


/** 网页追溯里的一条事件。 */
export interface TraceEvent {
  id: number;
  /** 事件名或“模块.函数”。 */
  type: string;
  at: number;
  /** 事件行是听的人，函数行是发它的“文件:行号”。 */
  source: string;
  bot: string | null;
  sessionId: string | null;
  messageId: number | null;
  key: null;
  parent: null;
  depth: number;
  /** 流水行本身（kind、发法、听的人、人话、代码、位置、变量），网页按 data.kind 认出新格式。 */
  data: Record<string, unknown>;
}


/**
 * 一条流水行换成网页的 TraceEvent。
 * @param event 流水行。
 * @returns 网页追溯里的一条事件。
 */
export function getTraceEvent(event: JournalEvent): TraceEvent {
  let source = event.site;
  const data: Record<string, unknown> = { kind: event.kind };
  if (event.mode !== '') {
    data['mode'] = event.mode;
  }
  if (event.kind === '事件') {
    source = event.listeners.join('、');
    data['listeners'] = event.listeners;
    if (traceText.getTraceModeId(event.mode) !== event.mode) {
      const text = trailModule.getEventTextId(event, event.name);
      if (text !== '') {
        data['text'] = text;
      }
    }
  }
  if (event.text !== '') {
    data['text'] = event.text;
  }
  if (event.code !== '') {
    data['code'] = event.code;
  }
  return {
    id: event.id,
    type: event.name,
    at: event.at,
    source,
    bot: event.bot,
    sessionId: event.sessionId,
    messageId: event.messageId,
    key: null,
    parent: null,
    depth: 0,
    data: { ...data, site: event.site, ...event.vars },
  };
}
