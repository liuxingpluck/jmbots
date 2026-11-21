/**
 * 跟踪点：骨架和插件走到关键的地方各发一个，说清“现在走到哪个模块的哪个函数、在干什么”。
 * 骨架只管发，不管打印；打印是 plugins/tutorial（Print.ts，配置 trace_console）的事。没挂它时没人听，发了等于没发。
 * 写法（变量、代码先放进有名字的局部变量，//T 开头的注释标出来）：
 *   const vars = { session: session.id, channel: message.channel };
 *   const code = 'session.queueUserMessage(); session.run()';
 *   this.ctx.emit('trace', 'Bot.receive', 'trace.bots.receiveIntoSession', code, vars);
 * 会话发的三个事件（session/before-model、session/new-message、session/change）不用另发跟踪点：
 * Cordis 每发一个事件都会自己报一声，打印插件顺带打出来。
 *
 * 下面几个函数是 trace（打到控制台）和 journal（记进库给网页看）共用的：两边记的是同一种行，
 *   函数行：时间、模块.函数、人话、代码、变量、文件:行号；
 *   事件行：时间、事件名、发法（挨个问 / 通知）、听的人、会话、文件:行号。
 */
import * as path from 'node:path';
import * as process from 'node:process';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import * as textModule from './Text.ts';

declare module 'cordis' {
  interface Events {
    /**
     * 一个跟踪点。只是通知，谁也不许靠它改流程。
     * 谁发：
     *   src7/Sessions.ts 的 Session.getStepAnswer
     *   src7/Tools.ts 的 Tools.execute
     *   src7/plugins/approval/Grants.ts 的 Grants.add、Grants.remove、Grants.trace
     *   src7/plugins/approval/index.ts 的 Approval.answer、Approval.ask、Approval.onRequest、Approval.settle、Approval.traced
     *   src7/plugins/assist/Reminders.ts 的 Reminders.arm、Reminders.closeCard、Reminders.start
     *   src7/plugins/assist/index.ts 的 Assist.add
     *   src7/plugins/base-bridge/Notify.ts 的 mountNotify
     *   src7/plugins/base-bridge/UpdateWatch.ts 的 UpdateWatch.check、UpdateWatch.clearUncertainSwap、UpdateWatch.onDecided、UpdateWatch.tell
     *   src7/plugins/base-bridge/index.ts 的 Base.onRequest
     *   src7/plugins/bots/DispatchResults.ts 的 DispatchResults.acceptResult、DispatchResults.drain、DispatchResults.finishFront、DispatchResults.hold、DispatchResults.sendLastWords
     *   src7/plugins/bots/FrontDesk.ts 的 FrontDesk.onRequest、FrontDesk.record
     *   src7/plugins/bots/GroupBatch.ts 的 GroupBatch.judge
     *   src7/plugins/bots/ReplyTool.ts 的 registerReplyTool
     *   src7/plugins/bots/index.ts 的 Bot.receive、Bots.onChange、Bots.onRequest、Bots.receive、Bots.say
     *   src7/plugins/cli/index.ts 的 Cli.submitLine
     *   src7/plugins/context-fit/Compress.ts 的 Compress.compress
     *   src7/plugins/context-fit/Summary.ts 的 Summary.onChange
     *   src7/plugins/context-fit/index.ts 的 apply
     *   src7/plugins/decision/index.ts 的 Decision.judge
     *   src7/plugins/exec/index.ts 的 Exec.onDecided、Exec.onTool、Exec.run
     *   src7/plugins/feishu/Inbound.ts 的 FeishuInbound.handleInboundMessage、FeishuInbound.onCard、FeishuInbound.onMessage、FeishuInbound.onRecall
     *   src7/plugins/feishu/doc/Doc.ts 的 publish
     *   src7/plugins/feishu/index.ts 的 Feishu.mark、Feishu.start
     *   src7/plugins/feishu/outbox/Outbox.ts 的 setup
     *   src7/plugins/file-tools/BaseTools.ts 的 BaseTools.attachImages
     *   src7/plugins/file-tools/index.ts 的 FileTools.edit、FileTools.find
     *   src7/plugins/http/Files.ts 的 FilesApi.upload
     *   src7/plugins/http/index.ts 的 Http.listen
     *   src7/plugins/http/Static.ts 的 registerStatic
     *   src7/plugins/image-gen/index.ts 的 ImageGen.generate
     *   src7/plugins/journal/index.ts 的 Journal.record
     *   src7/plugins/memory/index.ts 的 Memory.onRequest
     *   src7/plugins/model-catalog/Fallback.ts 的 ModelFallback.noteLimit
     *   src7/plugins/model-catalog/Fallback.ts 的 ModelFallback.onRequest
     *   src7/plugins/model-catalog/Notes.ts 的 ModelNotes.rate
     *   src7/plugins/model-catalog/index.ts 的 ModelCatalog.pull、apply
     *   src7/plugins/people/index.ts 的 People.resolve
     *   src7/plugins/programs/ChannelBridge.ts 的 ChannelBridge.dispatch
     *   src7/plugins/progress/Review.ts 的 Review.check、Review.constructor、Review.skip
     *   src7/plugins/progress/index.ts 的 Progress.close、Progress.onDeadline、Progress.onDecided、Progress.sendCard、Progress.setLimit
     *   src7/plugins/relay/AgentTasks.ts 的 AgentTasks.finishTask、AgentTasks.send、AgentTasks.take
     *   src7/plugins/relay/index.ts 的 Relay.accept、Relay.checkLate、Relay.onRequest、Relay.push、Relay.queueReply、Relay.register、Relay.sendFile
     *   src7/plugins/settings/index.ts 的 Settings.constructor、Settings.createBot、Settings.exitSoon、Settings.restart
     *   src7/plugins/voice/index.ts 的 VoiceConnection.reportRoute
     *   src7/plugins/web-api/Timeline.ts 的 Timeline.bindSession、Timeline.insert、Timeline.reply
     *   src7/plugins/web-api/Views.ts 的 Views.setModel
     *   src7/plugins/web-api/index.ts 的 WebApi.accept
     *   src7/plugins/web-search/index.ts 的 WebSearch.trace
     *   src7/plugins/wechat/index.ts 的 Wechat.deliver、Wechat.store
     *   src7/plugins/workspaces/index.ts 的 Workspaces.emitChanged、Workspaces.getResolved
     * 谁接：
     *   src7/plugins/journal/index.ts 的 Journal.listen
     *   src7/plugins/tutorial/Boot.ts 的 BootTrail.constructor
     *   src7/plugins/tutorial/Print.ts 的 Printer.constructor
     *   src7/plugins/tutorial/State.ts 的 Shots.constructor
     * @param where 哪个模块的哪个函数，比如 Bot.receive。
     * @param text 文案编号。旧发出方仍可传原文。
     * @param code 一句代码：对应的那行调用，比如 chat(resources, request)。
     * @param vars 关键变量，使用稳定英文键。
     */
    'trace'(where: string, text: string, code: string, vars: Record<string, unknown>): void;
  }
}



/** 一个事件行：发了哪个事件、怎么发的、谁在听、归哪场会话，和几个认得的关键值。 */
export interface DispatchLine {
  /** 事件名，如 session/new-message。 */
  name: string;
  /** Cordis 发法，例如 serial、emit。 */
  mode: string;
  /** 听的人：登记监听的插件名。 */
  listeners: string[];
  /** 哪场会话；事件里找不到是 undefined。 */
  session?: string;
  /** 哪个机器人。 */
  bot?: string;
  /** web-api 收件表的消息号。 */
  messageId?: number;
  /** 标准消息号（渠道发来的 JSON.stringify([渠道, 账号, 平台原消息号])）；事件参数里的 messageId 或 sourceId，或参数里 message 的这两项。 */
  sourceId?: string;
  /** channel/reply、channel/replied 带的回复请求号：把一次回复的请求和回执配成一对。 */
  replyRequestId?: string;
  /** 参数本身是会话或带着会话时，会话这一刻的状态（running、done 等）。 */
  sessionState?: string;
  /** 认得的关键值（状态、角色、说了什么、要了什么工具）。 */
  vars: Record<string, unknown>;
}


/** 旁听者拿到的事件行：事件行本身，加上是哪一行代码发的这个事件。 */
export type SharedLine = DispatchLine & {
  /** 发这个事件的那一行代码，“文件:行号”（getCallSite 取的）。 */
  site: string;
};


/**
 * 共用事件行里一个值最多几个字：journal 的 VAR_MAX、tutorial 默认的 trace_var_limit 都是 200。
 * State、Payload 不看正文，多截少截不影响；trace_var_limit 配得比 200 大时，Print 的事件行最多也只到 200 字。
 */
const SHARED_VAR_MAX = 200;

/** 旁听者自己的文件夹：取调用栈时跳过，取到的就是业务代码发事件的那一行。 */
const OBSERVER_DIRS = ['plugins/journal/', 'plugins/tutorial/'];

/** 一次派发只拼一次事件行。键是 Cordis 交给每个 internal/dispatch 监听的同一个 args 数组，派发完自然释放。 */
const sharedLines = new WeakMap<unknown[], SharedLine>();


/**
 * 旁听 Cordis 的每次派发：journal 记库、tutorial 打印、拍快照、录载荷都从这里挂。
 * 跟踪点自己（trace）、Cordis 内部的事件（internal/ 开头）不交过来。
 * 同一次派发，第一个旁听者拼事件行、取调用栈，后面的旁听者拿同一份（同一个引用）。
 * 旁听者跑在发事件的那一行里，Cordis 的 emit 不接异常：这里出错只打一行日志、不往外抛，业务监听照常收到事件。
 * @param ctx 旁听插件的 ctx（用来查这个事件登记着哪些监听）。
 * @param who 旁听者的名字，写进出错日志。
 * @param handler 拿到共用的事件行和原始参数。
 * 副作用：在 ctx 上登记一个 internal/dispatch 监听，插件拔掉时 Cordis 自己撤掉。
 */
export function onDispatch(
  ctx: cordis.Context,
  who: string,
  handler: (line: SharedLine, args: unknown[]) => void,
): void {
  ctx.on('internal/dispatch', (mode, event, args: unknown[]) => {
    //G 跟踪点自己、Cordis 内部的事件不算。
    if (typeof event !== 'string') return;
    if (event === 'trace') return;
    if (event.startsWith('internal/')) return;

    //M 旁听者出错只记一行：调试插件坏了，不能把这条消息一起拦下。
    try {
      //M 同一次派发，第一个旁听者拼事件行、取调用栈，后面的直接拿。
      let line = sharedLines.get(args);
      if (line === undefined) {
        const built = buildDispatchLine(ctx, mode, event, args, SHARED_VAR_MAX);
        const site = getCallSite(OBSERVER_DIRS);
        line = { ...built, site };
        sharedLines.set(args, line);
      }

      handler(line, args);
    } catch (error) {
      const reason = textModule.getErrorMessage(error);
      console.error(`[旁听异常:${who}] 事件 ${event} 出错，已跳过：${reason}`);
    }
  });
}


/**
 * 旁听跟踪点：和 onDispatch 一样，旁听者出错只打一行日志，不冒到发跟踪点的业务代码里。
 * @param ctx 旁听插件的 ctx。
 * @param who 旁听者的名字，写进出错日志。
 * @param handler 拿到跟踪点的四个参数（见上面 Events 里 trace 的说明）。
 * 副作用：在 ctx 上登记一个 trace 监听，插件拔掉时 Cordis 自己撤掉。
 */
export function onTrace(
  ctx: cordis.Context,
  who: string,
  handler: (where: string, text: string, code: string, vars: Record<string, unknown>) => void,
): void {
  ctx.on('trace', (where, text, code, vars) => {
    //M 旁听者出错只记一行：跟踪点只是通知，不能拦住发它的业务代码。
    try {
      handler(where, text, code, vars);
    } catch (error) {
      const reason = textModule.getErrorMessage(error);
      console.error(`[旁听异常:${who}] 跟踪点 ${where} 出错，已跳过：${reason}`);
    }
  });
}


/**
 * 一句话截短、压成一行。
 * @param value 值。
 * @param max 最多几个字。
 */
export function formatTraceValue(value: unknown, max: number): string {
  let full = '';
  if (typeof value === 'string') {
    full = value;
  }
  if (typeof value !== 'string') {
    full = String(JSON.stringify(value));
  }
  const line = full.replace(/\s+/gu, ' ');
  if (line.length > max) return `${line.slice(0, max)}…`;

  return line;
}


function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as Record<string, unknown>;
}


/**
 * 像会话的东西：有 id 和 row（Session）。
 * @param value 事件的一个参数，或参数里的 session。
 * @returns 是会话就原样交回；不是是 undefined。
 */
function sessionLike(value: unknown): { id: string; row: Record<string, unknown> } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;

  const item = value as Record<string, unknown>;
  const hasId = typeof item['id'] === 'string';
  const hasRow = typeof item['row'] === 'object' && item['row'] !== null;
  if (hasId && hasRow) return item as { id: string; row: Record<string, unknown> };

  return undefined;
}


/**
 * 认标准消息号：渠道的标准消息号是 JSON.stringify([渠道, 账号, 平台原消息号])，一定以 [" 开头；
 * 平台原消息号（om_xxx）、提醒号（reminder:xxx）不是，不认。
 * @param value 跟踪点变量或事件参数里的某一项。
 * @returns 是标准消息号就原样交回；不是是 undefined。
 */
export function getSourceId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('["')) return undefined;

  return value;
}


/**
 * 取对象里的一个正整数（web-api 收件表的消息号）。
 * @param record 对象；不是对象传 undefined。
 * @param key 字段名。
 * @returns 是正整数就原样交回；不是是 undefined。
 */
function getPositiveInt(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const raw = record?.[key];
  if (typeof raw !== 'number') return undefined;
  if (!Number.isSafeInteger(raw) || raw <= 0) return undefined;

  return raw;
}


/**
 * 补认“这个事件属于哪条消息”：buildDispatchLine 的参数循环认不出的几个位置，在这里一处认。
 * journal 记流水、Print 打印、State 拍快照、Payload 录载荷都用这一份，流水页和载荷页对得上。
 * 只补还空着的：参数循环已经认出的不改。
 * @param line 正在拼的事件行，原地补 messageId、sourceId、session、bot、replyRequestId、sessionState。
 * @param event 事件名。
 * @param first 事件的第一个参数；不是对象传 undefined。
 */
function addMessageRefs(line: DispatchLine, event: string, first: Record<string, unknown> | undefined): void {
  if (first === undefined) return;

  /** 补认出来的几项，最后只填 line 上还空着的。 */
  let messageId: number | undefined;
  let sourceId: string | undefined;
  let session: string | undefined;
  let bot: string | undefined;

  //M 1. 渠道消息（channel/direct 等）、bot/receive：origin.address 或 message.address 里的收件号，message.bot。
  const origin = asRecord(first['origin']);
  const inner = asRecord(first['message']);
  messageId = getPositiveInt(asRecord(origin?.['address']), 'messageId');
  messageId ??= getPositiveInt(asRecord(inner?.['address']), 'messageId');
  if (typeof inner?.['bot'] === 'string') {
    bot = inner['bot'];
  }

  //M 2. 参数本身是会话或带着会话：row.state、row.address 里的收件号、row.activeSourceSnapshot 的标准消息号。
  const sessionObj = asRecord(first['session']) ?? first;
  const row = asRecord(sessionObj['row']);
  if (row !== undefined) {
    if (typeof row['state'] === 'string') {
      line.sessionState = row['state'];
    }
    messageId ??= getPositiveInt(asRecord(row['address']), 'messageId');
    const active = asRecord(row['activeSourceSnapshot']);
    sourceId = getSourceId(active?.['messageId']);
  }

  //M 3. channel/reply、channel/replied：回复请求（channel/replied 的在 request 里）带的 requestId、sessionId、bot。
  const request = asRecord(first['request']) ?? first;
  const isReply = event === 'channel/reply' || event === 'channel/replied';
  if (isReply && typeof request['requestId'] === 'string') {
    line.replyRequestId = request['requestId'];
  }
  if (isReply && typeof request['sessionId'] === 'string' && request['sessionId'] !== '') {
    session = request['sessionId'];
  }
  if (isReply && bot === undefined && typeof request['bot'] === 'string') {
    bot = request['bot'];
  }

  //M 4. 回复、收尾（channel/reply、channel/replied、bot/settled）带的来源快照：标准消息号、机器人、origin.address 的收件号。
  const snapshot = asRecord(request['sourceSnapshot']) ?? asRecord(first['sourceSnapshot']);
  if (snapshot !== undefined) {
    sourceId ??= getSourceId(snapshot['messageId']);
    if (bot === undefined && typeof snapshot['botName'] === 'string') {
      bot = snapshot['botName'];
    }
    const snapshotOrigin = asRecord(snapshot['origin']);
    messageId ??= getPositiveInt(asRecord(snapshotOrigin?.['address']), 'messageId');
  }

  //M 5. 回复目标 target.address 的收件号。
  const target = asRecord(request['target']);
  messageId ??= getPositiveInt(asRecord(target?.['address']), 'messageId');

  //M 只填还空着的：参数循环认出的优先。
  if (line.messageId === undefined && messageId !== undefined) line.messageId = messageId;
  if (line.sourceId === undefined && sourceId !== undefined) line.sourceId = sourceId;
  if (line.session === undefined && session !== undefined) line.session = session;
  if (line.bot === undefined && bot !== undefined) line.bot = bot;
}


/**
 * 拼一个事件行：Cordis 每发一个事件先发 internal/dispatch（发法、事件名、参数），trace、journal 都听它。
 * 会话从参数里找：参数本身是会话、带 session（ChatRequest、session/model-failed 的 info）、带 sessionId 或 session 号（待确认、进度）。
 * 参数循环认不出的渠道地址、会话快照、回复请求，由 addMessageRefs 补认（“属于哪条消息”只在这一处认）。
 * @param ctx 听的那个插件的 ctx（用来查这个事件登记着哪些监听）。
 * @param mode Cordis 的发法。
 * @param event 事件名。
 * @param args 事件带的参数。
 * @param max 一个值最多几个字。
 */
export function buildDispatchLine(
  ctx: cordis.Context,
  mode: string,
  event: string,
  args: unknown[],
  max: number,
): DispatchLine {
  //M 听的人：这个事件现在登记着的监听，各取登记它的那个插件的名字。
  const hooks = ctx.events._hooks[event] ?? [];
  const pluginNames = hooks.map((hook) => hook.ctx.fiber.name);
  const line: DispatchLine = {
    name: event,
    mode,
    listeners: [...new Set(pluginNames)],
    vars: {},
  };

  //M 会话、机器人、消息号：从参数里挨个找，找到会话就停。
  for (const arg of args) {
    /** 这个参数是对象才往里看；不是对象是 undefined。 */
    let item: Record<string, unknown> | undefined;
    if (typeof arg === 'object' && arg !== null) {
      item = arg as Record<string, unknown>;
    }

    //M 消息号先认：web-api/replied 带着会话对象（{ messageId, session }），下面认出会话就停了，放后面读不到。
    //M   web-api/received 的参数本身就是收件行，消息号是它的 id。
    let receivedId: unknown;
    if (event === 'web-api/received') {
      receivedId = item?.['id'];
    }
    const messageId = item?.['messageId'] ?? receivedId;
    if (typeof messageId === 'number') line.messageId = messageId;

    //M 标准消息号：参数本身带（channel/direct 等进来的事件的 messageId），或参数里的 message 带（bot/receive 的 message.sourceId）。
    const inner = item?.['message'];
    let nested: Record<string, unknown> | undefined;
    if (typeof inner === 'object' && inner !== null) {
      nested = inner as Record<string, unknown>;
    }
    const sourceId = getSourceId(item?.['messageId'])
      ?? getSourceId(item?.['sourceId'])
      ?? getSourceId(nested?.['messageId'])
      ?? getSourceId(nested?.['sourceId']);
    if (sourceId !== undefined && line.sourceId === undefined) line.sourceId = sourceId;

    //M 参数本身是会话，或带着会话对象（session）：会话号、机器人都从它取，找到就停。
    const found = sessionLike(arg) ?? sessionLike(item?.['session']);
    if (found !== undefined) {
      line.session = found.id;
      if (typeof found.row['bot'] === 'string') line.bot = found.row['bot'];
      break;
    }

    //M 参数只带着会话号（sessionId 或 session）、机器人名：取到哪个算哪个，取到了就停。
    if (item !== undefined) {
      const id = item['sessionId'] ?? item['session'];
      if (typeof id === 'string' && id !== '') line.session = id;
      if (typeof item['bot'] === 'string') line.bot = item['bot'];
      if (line.session !== undefined || line.bot !== undefined) break;
    }
  }

  //M 参数循环认不出的几个位置（渠道地址、会话快照、回复请求）再补认一遍：journal、Print、State、Payload 都用这一份。
  const firstObj = asRecord(args[0]);
  addMessageRefs(line, event, firstObj);

  //M 会话的几个核心事件带着什么，这里认得，顺带记下结构化数值与状态（不记隐私正文或密钥）。
  //M session/before-model：记录进入关口一时的模型、思考档、初始 system 段数、初始工具数与历史条数。
  if (event === 'session/before-model' && firstObj !== undefined) {
    const ses = sessionLike(firstObj['session']);
    if (ses !== undefined) {
      if (typeof ses.row['kind'] === 'string') line.vars['sessionKind'] = ses.row['kind'];
      if (typeof ses.row['steps'] === 'number') line.vars['step'] = ses.row['steps'];
    }
    if (typeof firstObj['model'] === 'string') line.vars['model'] = firstObj['model'];
    if (typeof firstObj['thinking'] === 'string') line.vars['thinking'] = firstObj['thinking'];
    if (Array.isArray(firstObj['system'])) line.vars['systemBefore'] = firstObj['system'].length;
    if (Array.isArray(firstObj['tools'])) line.vars['toolsCount'] = firstObj['tools'].length;
    if (Array.isArray(firstObj['messages'])) line.vars['messageCount'] = firstObj['messages'].length;
  }

  //M session/after-model：记录关口二时加工后的提示词段数、工具数及回答模型来源。
  if (event === 'session/after-model' && firstObj !== undefined) {
    if (typeof firstObj['model'] === 'string') line.vars['model'] = firstObj['model'];
    if (Array.isArray(firstObj['system'])) line.vars['systemAfter'] = firstObj['system'].length;
    if (Array.isArray(firstObj['tools'])) line.vars['toolsCount'] = firstObj['tools'].length;
    if (Array.isArray(firstObj['messages'])) line.vars['messageCount'] = firstObj['messages'].length;
    const answer = firstObj['answer'] as piAi.AssistantMessage | undefined;
    if (answer !== undefined && typeof answer.provider === 'string' && typeof answer.model === 'string') {
      line.vars['answeredBy'] = `${answer.provider}/${answer.model}`;
    }
  }

  //M session/before-tool 与 session/after-tool：记录工具名与执行成败。
  if ((event === 'session/before-tool' || event === 'session/after-tool') && firstObj !== undefined) {
    const call = asRecord(firstObj['call']);
    if (call !== undefined && typeof call['name'] === 'string') {
      line.vars['tool'] = call['name'];
    }
    const outcome = asRecord(firstObj['outcome']);
    if (outcome !== undefined && typeof outcome['isError'] === 'boolean') {
      line.vars['failed'] = outcome['isError'];
    }
  }

  //M session/change：记前后状态、会话种类、消息条数、回话字数及截短回话。
  if (event === 'session/change') {
    const session = sessionLike(args[0]);
    if (typeof args[1] === 'string') {
      line.vars['stateBefore'] = args[1];
    }
    if (session !== undefined) {
      line.vars['state'] = session.row['state'];
      if (typeof session.row['kind'] === 'string') line.vars['sessionKind'] = session.row['kind'];
      if (typeof session.row['steps'] === 'number') line.vars['step'] = session.row['steps'];
      if (Array.isArray(session.row['messages'])) line.vars['messageCount'] = session.row['messages'].length;
      if (typeof session.row['reply'] === 'string') line.vars['replyLength'] = session.row['reply'].length;
      line.vars['reply'] = formatTraceValue(session.row['reply'], max);
    }
  }

  //M session/new-message：记角色、说了什么；模型的回答再记要了哪些工具、哪个模型；工具结果记工具名、有没有出错。
  if (event === 'session/new-message') {
    const message = args[1] as piAi.Message | undefined;
    if (message !== undefined) {
      line.vars['role'] = message.role;
      let said = '';
      if (typeof message.content === 'string') {
        said = message.content;
      }
      if (typeof message.content !== 'string') {
        said = piAi.contentText(message.content);
      }
      //M 截短说话正文记进关键变量，供控制台和流日志一行展示。
      line.vars['content'] = formatTraceValue(said, max);

      if (message.role === 'assistant') {
        const calls = message.content.filter((block): block is piAi.ToolCall => {
          return block.type === 'toolCall';
        });
        const callNames = calls.map((call) => call.name);
        if (callNames.length > 0) {
          line.vars['toolCalls'] = callNames.join(', ');
        }
        line.vars['model'] = `${message.provider}/${message.model}`;
      }

      if (message.role === 'toolResult') {
        line.vars['tool'] = message.toolName;
        line.vars['failed'] = message.isError;
      }
    }
  }
  return line;
}


/**
 * 从调用栈的一行里取出文件和行号。一行长这样：“at 函数名 (文件:行:列)”。
 * @param frame 调用栈里的一行。
 * @returns 文件和行号；这一行里没有（比如“at unknown”）是 undefined。
 */
function parseFrame(frame: string): { file: string; line: string } | undefined {
  const found = /^\s*at (?:.*\()?(.+?):(\d+):\d+\)?$/u.exec(frame);
  if (found === null) return undefined;
  return { file: found[1] ?? '', line: found[2] ?? '' };
}


/**
 * 是哪一行代码走到这里的：调用栈里第一处不在本文件、不在 node_modules（Cordis 自己）、也不在 skip 里那几个文件夹的。
 * 跟踪点和 Cordis 报事件都是当场、同步调到监听里的，所以发它们的那一行还在调用栈里。
 * @param skip 听的那个插件自己的文件夹（如 'plugins/tutorial/'），跳过。
 * @returns “文件:行号”，相对当前目录；找不到是“位置不明”。
 */
export function getCallSite(skip: string[]): string {
  //M 现场拿一份调用栈，一行一行往外找。
  const stack = new Error().stack ?? '';
  for (const frame of stack.split('\n')) {
    const at = parseFrame(frame);
    if (at === undefined) continue;

    //G Cordis 自己、本文件、听的插件自己的文件夹 → 跳过，接着往外找。
    const file = at.file.replaceAll('\\', '/');
    const inCordis = file.includes('node_modules');
    const inThisFile = file.endsWith('utils/Trace.ts');
    const inSkipped = skip.some((part) => file.includes(part));
    if (inCordis || inThisFile || inSkipped) continue;

    //M 找到了：写成相对当前目录的“文件:行号”，斜杠统一成正斜杠。
    const relative = path.relative(process.cwd(), at.file).replaceAll('\\', '/');
    return `${relative}:${at.line}`;
  }
  return '位置不明';
}
