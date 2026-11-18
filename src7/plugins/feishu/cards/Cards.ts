/**
 * 飞书卡片：待确认卡片（approval 挂着时）、进度卡片（progress 挂着时）。听事件、定发给谁、发卡改卡、认按钮、回小提示。
 * 待确认卡片在 approval 服务就绪时开工；进度卡片订阅更新通知，按钮通过请求事件提交操作。
 * 卡片号存表 feishu_cards，按钮值只放动作，号从表里查：重启后点旧卡片也认得。
 * 飞书群里不发卡片（群里谁都能点，绕过用户拍板）：待确认卡片改发本人私聊，群里只说一句“要本人确认”；进度卡片群里不发。
 * 点卡片只认本人（people 里 role 是 owner 的），别人点回一句“只有本人能处理”（2026-11-17，0.7.18）。
 */
import type * as cordis from 'cordis';
import type { SessionMeta } from '../../../Sessions.ts';
import * as requestEventModule from '../../../utils/RequestEvent.ts';
import * as textModule from '../../../utils/Text.ts';
import * as workspaceModule from '../../../utils/Workspace.ts';
import { feishuCustomer } from '../index.ts';
import type { FeishuAddress, Feishu, FeishuPerson, Toast } from '../index.ts';
import * as render from './Render.ts';


/** approval 服务里卡片用到的方法（approval.md 第 2 节）。 */
export interface ApprovalLike {
  /** 定一件事：交回定好的那件，或者一句原因（找不到、已经定过）。 */
  decide(id: number, approve: boolean, by: string): render.PendingLike | string;
}


/** 进度卡片按钮最多等五秒。 */
const PROGRESS_TIMEOUT_MS = 5000;

declare module 'cordis' {
  interface Events {
    /** approval 存完一件待确认的事（approval.md 第 2 节）。 */
    'approval/asked'(pending: render.PendingLike): void;
    /** approval 定完一件事。 */
    'approval/decided'(pending: render.PendingLike): void;
    /** progress 的一项有变化（progress.md 第 2 节）。 */
    'progress/update'(item: render.ProgressItemLike): void;
  }
}


/** 表 feishu_cards 的一行。 */
interface CardRow {
  card_id: string;
  kind: string;
  ref: string;
  ended: number;
}


/**
 * approval 在时开工：听 asked、decided，记下 approval 服务给 onAction 用。
 * @param feishu 飞书渠道。
 * @param ctx 小插件的 ctx（approval 已经在了）；approval 被拔掉时这个小插件跟着拔，监听自动撤。
 */
export function setupApproval(feishu: Feishu, ctx: cordis.Context): void {
  //M ctx.get 现取服务：approval 的类型由它自己的插件声明，这里只认用到的 decide。
  feishu.approval = ctx.get('approval') as ApprovalLike;
  ctx.effect(() => {
    return () => {
      feishu.approval = undefined;
    };
  });
  ctx.on('approval/asked', (pending) => {
    //M 收到待确认请求时异步群发通知与交互卡片。
    void onAsked(feishu, ctx, pending);
  });
  ctx.on('approval/decided', (pending) => {
    //M 审批状态落定后异步把发出过的相关卡片更新为灰底终态。
    void onDecided(feishu, pending);
  });
}


/**
 * 监听更新通知并发出或刷新进度卡片。
 * @param feishu 飞书渠道。
 * @param ctx 飞书插件的 ctx。
 */
export function setupProgress(feishu: Feishu, ctx: cordis.Context): void {
  //M 进度更新通过事件发送，随飞书插件一起撤销监听。
  ctx.on('progress/update', (item) => {
    //M 长任务进度更新时异步发送或原地刷新对应私聊进度卡片。
    void onProgress(feishu, ctx, item);
  });
}


/**
 * 会话的飞书回话地址。
 * @param ctx 取 sessions。
 * @param sessionId 会话号；没有就没有地址。
 * @returns 飞书来的会话交回地址，别的是 undefined。
 */
export function getAddress(ctx: cordis.Context, sessionId?: string): FeishuAddress | undefined {
  if (sessionId === undefined || sessionId === '') return undefined;
  //M 按会话号查库确认渠道属于 feishu 后取出其回话地址结构。
  const row = ctx.sessions.find({ id: sessionId })[0];
  if (row?.channel !== 'feishu') return undefined;
  return row.address as FeishuAddress;
}


/** 本人在 people 里没写名字时（旧写法 owner_open_ids）怎么称呼。 */
const OWNER_FALLBACK = '用户本人';


/**
 * 本人叫什么：people 里第一个 role 是 owner 且写了名字的；都没写是“用户本人”。点卡片的提示用。
 * @param feishu 飞书渠道。
 */
export function ownerName(feishu: Feishu): string {
  //M people 里登记成本人、写了名字的第一个。
  const named = [...feishu.config.people.values()].find((person) => person.role === 'owner' && person.name !== '');
  return named?.name ?? OWNER_FALLBACK;
}


/**
 * 本人的私聊：people 里 role 是 owner 的人在这个应用下私聊过的那场会话；找不到退回这个应用最近私聊的人（feishu.lastPrivate）。
 * @param feishu 飞书渠道。
 * @param ctx 取 sessions。
 * @param appId 哪个应用。
 * @returns name 本人的名字；address 私聊地址，谁都没私聊过是 undefined。
 */
export function ownerChat(feishu: Feishu, ctx: cordis.Context, appId: string): { name: string; address: FeishuAddress | undefined } {
  //M 登记成本人的人。
  const owners = [...feishu.config.people.values()].filter((person) => person.role === 'owner');

  //M 本人在这个应用下的私聊会话：回话地址是私聊、open_id 是本人。Sessions.find 按 json 路径比，嵌套的也能找。
  for (const person of owners) {
    const where = { channel: 'feishu', 'address.appId': appId, 'address.openId': person.openId, 'address.chatType': 'p2p' };
    const row = ctx.sessions.find(where as unknown as Partial<SessionMeta>)[0];
    if (row === undefined) continue;

    const found = row.address as FeishuAddress;
    const address: FeishuAddress = { appId, chatId: found.chatId, messageId: found.messageId, openId: person.openId, chatType: 'p2p' };
    //M 按统一规则补齐客户唯一标识，方便后续会话复用与记忆索引。
    address.customer = feishuCustomer('p2p', found.chatId, person.openId);
    return { name: person.name || OWNER_FALLBACK, address };
  }

  //M 找不到：退回这个应用最近私聊的人；名字照那个人（是本人的话），不然照 people 里的本人。
  const last = feishu.lastPrivate(appId);
  let person: FeishuPerson | undefined;
  if (last !== undefined) {
    person = feishu.config.people.get(last.openId);
  }
  let name = '';
  if (person?.role === 'owner' && person.name !== '') {
    name = person.name;
  }
  if (name === '') {
    //M 最近私聊人不是已填名字的本人，回退取 people 里登记的本人名称。
    name = ownerName(feishu);
  }
  return { name, address: last };
}


/**
 * 待确认卡片发给谁（照 0.4 src/channels/index.ts:145-174）：飞书私聊来的会话发到会话的聊天；
 * 飞书群里来的会话不发进群（群里谁都能点），改发本人私聊（ownerChat）；
 * 这个机器人别的飞书应用发给各自最近私聊的人；没会话的（命令窗口、更新提醒）、网页来的，都走最近私聊的人。
 * @param feishu 飞书渠道。
 * @param ctx 取 sessions。
 * @param pending 那件事。
 * @returns 地址清单；可能是空的。
 */
export function targets(feishu: Feishu, ctx: cordis.Context, pending: render.PendingLike): FeishuAddress[] {
  //M 读取发起会话的原始飞书地址，决定卡片首站投递到当前私聊还是转投本人私聊。
  const own = getAddress(ctx, pending.session);
  //G 群里的会话：卡片换成发本人私聊。
  let first = own;
  if (own !== undefined && workspaceModule.isGroup(own)) {
    //M 群会话改查本人在同一应用下的私聊回话地址。
    first = ownerChat(feishu, ctx, own.appId).address;
  }
  const list: FeishuAddress[] = [];
  if (first !== undefined) {
    list.push(first);
  }
  //M 补充收集该机器人名下其他飞书应用的最近私聊地址。
  for (const appId of feishu.getApps(pending.bot)) {
    if (appId === own?.appId) continue;
    const last = feishu.lastPrivate(appId);
    if (last !== undefined) {
      list.push(last);
    }
  }
  if (list.length === 0) {
    //M 无任何可用私聊投递目标时取时间戳打印提示日志。
    const logTime = textModule.getClock(Date.now(), 'date');
    console.error(`${logTime} 飞书：机器人 ${pending.bot} 在飞书上还没人私聊过，待确认 #${String(pending.id)} 没推`);
  }
  return list;
}


/**
 * 有一件待确认：每个地址发一张卡片，记表；卡片发不出去改发一句文字。
 * 群里的会话：卡片发本人私聊（targets），群里只说一句“这一步要 某某 确认，已发到他私聊”（groupNote）。
 * @param feishu 飞书渠道。
 * @param ctx 取 sessions。
 * @param pending 那件事。
 */
async function onAsked(feishu: Feishu, ctx: cordis.Context, pending: render.PendingLike): Promise<void> {
  //M 群里只说一句，不发卡片、不写细节。
  await groupNote(feishu, ctx, pending);
  for (const address of targets(feishu, ctx, pending)) {
    try {
      const cardId = await feishu.sendCard(address, render.approval(pending));
      const sql = 'INSERT OR REPLACE INTO feishu_cards (card_id, kind, ref, ended, at) VALUES (?, ?, ?, 0, ?)';
      feishu.db.query(sql).run(cardId, 'approval', String(pending.id), Date.now());
    } catch (error) {
      const logTime = textModule.getClock(Date.now(), 'date');
      console.error(`${logTime} 飞书：待确认 #${String(pending.id)} 的卡片没发出去，改发文字：${textModule.getMessage(error)}`);
      const id = String(pending.id);
      const text = `待确认 #${id}：${pending.title}\n${pending.detail}\n回复“同意 ${id}”或“拒绝 ${id}”。`;
      try {
        await feishu.sendText(address, text);
      } catch (again) {
        const againTime = textModule.getClock(Date.now(), 'date');
        console.error(`${againTime} 飞书：待确认 #${id} 的文字也没发出去：${textModule.getMessage(again)}`);
      }
    }
  }
}


/**
 * 群里来的会话有待确认：群里只发一句文字说要本人确认；不是群就什么也不做。发不出去只打日志。
 * @param feishu 飞书渠道。
 * @param ctx 取 sessions。
 * @param pending 那件事。
 */
async function groupNote(feishu: Feishu, ctx: cordis.Context, pending: render.PendingLike): Promise<void> {
  //M 取该会话所属的飞书回话地址，仅当请求确实源自群聊时才在群里发文字提醒。
  const own = getAddress(ctx, pending.session);
  if (own === undefined || !workspaceModule.isGroup(own)) return;

  //M 本人的私聊找到了说“已发到他私聊”，没人私聊过就说发不过去。
  const owner = ownerChat(feishu, ctx, own.appId);
  let text = `这一步要 ${owner.name} 确认，已发到他私聊`;
  if (owner.address === undefined) {
    text = `这一步要 ${owner.name} 确认，他还没私聊过机器人，卡片发不过去`;
  }
  try {
    await feishu.sendText(own, text);
  } catch (error) {
    const logTime = textModule.getClock(Date.now(), 'date');
    console.error(`${logTime} 飞书：待确认 #${String(pending.id)} 群里那句没发出去：${textModule.getMessage(error)}`);
  }
}


/**
 * 一件事定了：这件事发过的每张卡片都改成灰色写结果（不管在哪定的）。
 * @param feishu 飞书渠道。
 * @param pending 定好的那件。
 */
async function onDecided(feishu: Feishu, pending: render.PendingLike): Promise<void> {
  const sql = "SELECT card_id, kind, ref, ended FROM feishu_cards WHERE kind = 'approval' AND ref = ?";
  //M 查出该审批编号曾发出过的全部卡片 ID，逐张更新成终态样式。
  const rows = feishu.db.query(sql).all(String(pending.id)) as CardRow[];
  for (const row of rows) {
    try {
      //M 按最新审批结果重新渲染卡片并调用飞书接口原地更新内容。
      await feishu.updateCard(row.card_id, render.approval(pending));
      feishu.db.query('UPDATE feishu_cards SET ended = 1 WHERE card_id = ?').run(row.card_id);
    } catch (error) {
      //M 取格式化日期前缀用于记录更新卡片失败的错误日志。
      const logTime = textModule.getClock(Date.now(), 'date');
      console.error(`${logTime} 飞书：待确认 #${String(pending.id)} 的卡片没改成：${textModule.getMessage(error)}`);
    }
  }
}


/**
 * 进度有变化：飞书私聊来的会话第一次发卡片，之后原地改；结束了标 ended。发、改出错只打日志。
 * 群里来的会话不发进度卡片（群里谁都能点“终止”“限时”），要说进度机器人在群里用文字回。
 * @param feishu 飞书渠道。
 * @param ctx 取 sessions。
 * @param item 一项进度。
 */
async function onProgress(feishu: Feishu, ctx: cordis.Context, item: render.ProgressItemLike): Promise<void> {
  //M 按会话号查飞书回话地址，非飞书会话或群聊会话直接跳过不发进度卡片。
  const address = getAddress(ctx, item.sessionId);
  if (address === undefined) return;

  //G 群里的会话不发进度卡片。
  if (workspaceModule.isGroup(address)) return;
  try {
    const sql = "SELECT card_id, kind, ref, ended FROM feishu_cards WHERE kind = 'progress' AND ref = ? AND ended = 0";
    const row = feishu.db.query(sql).get(item.sessionId) as CardRow | null;
    let cardId = row?.card_id ?? '';
    if (row === null) {
      //M 尚无未结束卡片：渲染进度卡片结构并发送到私聊记录 feishu_cards。
      const payload = render.progress(item);
      //M 发送首次进度卡片到当前飞书私聊并保存返回的 card_id。
      cardId = await feishu.sendCard(address, payload);
      const insert = 'INSERT OR REPLACE INTO feishu_cards (card_id, kind, ref, ended, at) VALUES (?, ?, ?, 0, ?)';
      feishu.db.query(insert).run(cardId, 'progress', item.sessionId, Date.now());
    }
    if (row !== null) {
      //M 已有未结束的进度卡片：按最新进展渲染卡片结构并原地刷新。
      const payload = render.progress(item);
      //M 调飞书更新卡片接口将原进度卡片刷新到最新状态。
      await feishu.updateCard(cardId, payload);
    }
    if (item.endedAt !== undefined) {
      feishu.db.query('UPDATE feishu_cards SET ended = 1 WHERE card_id = ?').run(cardId);
    }
  } catch (error) {
    //M 取格式化日期前缀用于记录进度卡片发送或刷新失败的错误日志。
    const logTime = textModule.getClock(Date.now(), 'date');
    console.error(`${logTime} 飞书：会话 ${item.sessionId} 的进度卡片没发成：${textModule.getMessage(error)}`);
  }
}


/**
 * 点了卡片按钮。先认人：只有本人（回话地址的 role 是 owner，飞书照 people 写）点的才算，
 * 别人点（还留在群里的旧卡片）回一句“只有 某某 能处理”，不定、不终止、不限时。
 * @param feishu 飞书渠道。
 * @param ctx 飞书插件的事件上下文。
 * @param address 点的人、卡片所在的聊天。
 * @param cardId 卡片号。
 * @param value 按钮值：{ action, minutes? }。
 * @returns 给用户的小提示。找不到卡片或缺少审批服务时由调用方提示。
 */
export async function onAction(
  feishu: Feishu,
  ctx: cordis.Context,
  address: FeishuAddress,
  cardId: string,
  value: Record<string, unknown>,
): Promise<Toast | undefined> {
  //G 不是本人点的：只回提示，什么都不动。
  if (workspaceModule.getRole(address) !== 'owner') return { type: 'warning', content: `只有 ${ownerName(feishu)} 能处理` };

  //M 反查该卡片对应的业务类型与审批/会话编号，库里找不到则忽略。
  const row = feishu.db.query('SELECT card_id, kind, ref, ended FROM feishu_cards WHERE card_id = ?').get(cardId) as CardRow | null;
  if (row === null) return undefined;

  if (row.kind === 'approval' && feishu.approval !== undefined) {
    const approve = value['action'] === 'approve';
    //M 调用 approval 服务提交审批结果，已处理过的则交回原有结论给用户提示。
    const result = feishu.approval.decide(Number(row.ref), approve, `飞书卡片 ${address.openId}`);
    if (typeof result === 'string') {
      return { type: 'info', content: `待确认 #${row.ref} 已经处理过了：${result}` };
    }
    //M 卡片由随后的 approval/decided 改成灰色。
    let toastText = '已拒绝';
    if (approve) {
      toastText = '已同意执行';
    }
    return { type: 'success', content: toastText };
  }
  if (row.kind === 'progress') {
    let action: 'stop' | 'limit' = 'limit';
    if (value['action'] === 'stop') {
      action = 'stop';
    }
    let minutes: number | undefined;
    if (action === 'limit') {
      minutes = Number(value['minutes'] ?? 0);
    }
    const input = { action: 'act', sessionId: row.ref, op: action, minutes } as const;
    const options = {
      timeoutMs: PROGRESS_TIMEOUT_MS,
      onFallback: (reason: requestEventModule.FallbackReason, detail?: string) => ({
        requestId: '',
        ok: false,
        text: detail ?? `进度控制暂不可用或超时（${reason}）`,
      }),
    };

    //M 把终止或限时交给进度插件，用回执生成卡片提示。
    const result = await requestEventModule.requestEvent(ctx, 'progress/request', 'progress/result', input, options);
    if (result.ok !== true) return { type: 'warning', content: result.text ?? '进度控制失败' };

    return { type: 'info', content: result.text ?? '已处理' };
  }
  return undefined;
}
