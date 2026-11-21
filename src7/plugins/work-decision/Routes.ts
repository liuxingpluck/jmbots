/** 决策图 HTTP 接口、插件指令和中控收件投递。 */
import * as crypto from 'node:crypto';
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as checksModule from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as events from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import type * as dispatch from '../bots/Dispatch.ts';
import * as notifications from './Notify.ts';
import * as storeModule from './Store.ts';
import type * as types from './Types.ts';

/** 新节点提供必填字段，更新只给节点号及待改内容。 */
type NodePatch = Pick<types.DecisionNode, 'id'> & Partial<types.DecisionNode>;

/** 插件批量发布工作决策的入口。 */
interface AskRequest extends events.RequestEnvelope {
  /** 一批新节点或已有节点的局部更新。 */
  nodes: readonly NodePatch[];
}

/** 批量保存后的节点号，出错时给原因。 */
interface AskResult extends events.ResultEnvelope {
  /** 已完成整批写入。 */
  ok: boolean;
  /** 成功时受影响的节点。 */
  ids?: string[];
  /** 失败时给调用方显示的原因。 */
  error?: string;
}

/** 只给中控收件用的请求，不向机器人会话投递。 */
export interface DecisionRelayRequest extends events.RequestEnvelope {
  /** 新选择进收件箱，或者确认收到后清理收件状态。 */
  action: 'deliver' | 'ack';
  /** relay 配置中的中控助手名。 */
  helper: string;
  /** 收件稳定键，选择按节点，留言按留言号，任务变化按提交序号。 */
  node: string;
  /** 投递时记录实际节点和留言，方便回信时定位。 */
  target?: storeModule.ReplyTarget;
  /** 只在投递时提供的收件文字。 */
  text?: string;
}

/** relay 处理收件或确认后的回执。 */
interface DecisionRelayResult extends events.ResultEnvelope {
  /** 是否已处理请求。 */
  ok: boolean;
  /** 投递成功的收件号。 */
  id?: number;
  /** 没能处理的原因。 */
  error?: string;
}

/** relay 请求把已收下的回信写进节点。 */
interface RelayReplyRequest extends events.RequestEnvelope {
  /** 外部助手通过 relay 交给工作决策的回话。 */
  action: 'reply';
  /** relay 回信的持久编号，重复投递按它对账。 */
  id: number;
  /** 收件记录的精确节点及留言，可省略留言号。 */
  target: storeModule.ReplyTarget;
  /** 中控已交给 relay 的回信原文。 */
  text: string;
}

/** 已保存的选择和它的收件方，同一个投递键可以补投。 */
interface ChosenNotice extends events.RequestEnvelope {
  /** 节点号。 */
  node: string;
  /** 选项号。 */
  option: string;
  /** 画布上的节点标题。 */
  title: string;
  /** 已确定的提问方。 */
  asker: types.DecisionAsker;
  /** 投递去重键。正常选择为节点号，随留言点选时可用留言收件键。 */
  key: string;
  /** 发送给提问方的文本，含选项和备注。 */
  text: string;
  /** 随选择一起投给助手的留言号。 */
  note?: string;
}

/** 唯一接收方处理已定通知后交回的状态。 */
interface DecisionDelivery extends events.ResultEnvelope {
  /** 接收方已确认收下。 */
  ok: boolean;
  /** 外部助手的收件编号。 */
  id?: number;
  /** 提问会话的结果已入队。 */
  queued?: boolean;
  /** 是否还无法确认写入。 */
  uncertain?: boolean;
}

declare module 'cordis' {
  interface Events {
    /**
     * 插件注册或局部更新一批节点，保存后通知中控。
     * 谁发：暂无
     * 谁接：src7/plugins/work-decision/Routes.ts 的 mount
     */
    'work-decision/ask'(request: AskRequest): void | Promise<void>;
    /**
     * 批量写入完成后的节点号或校验失败原因。
     * 谁发：src7/plugins/work-decision/Routes.ts 的 mount
     * 谁接：暂无
     */
    'work-decision/ask-result'(result: AskResult): void;
    /**
     * 用户的选择已保存，按提问人交给原会话或外部助手。
     * 谁发：src7/plugins/work-decision/Routes.ts 的 deliverDecision
     * 谁接：
     *   src7/plugins/work-decision/Routes.ts 的 mount
     *   src7/plugins/relay/index.ts 的 Relay.constructor
     */
    'work-decision/decided'(notice: ChosenNotice): void | Promise<void>;
    /**
     * 原会话或外部助手回送选择的投递结果，按 requestId 配对。
     * 谁发：
     *   src7/plugins/work-decision/Routes.ts 的 mount
     *   src7/plugins/relay/index.ts 的 Relay.constructor
     * 谁接：src7/plugins/work-decision/Routes.ts 的 deliverDecision
     */
    'work-decision/decided-result'(result: DecisionDelivery): void;
    /**
     * 留言或任务通知交给 relay，或者把 relay 已收的回话写回工作决策。
     * 谁发：
     *   src7/plugins/work-decision/Routes.ts 的 requestRelay
     *   src7/plugins/relay/index.ts 的 Relay.queueDecisionReply
     * 谁接：
     *   src7/plugins/work-decision/Routes.ts 的 mount
     *   src7/plugins/relay/index.ts 的 Relay.constructor
     */
    'work-decision/note'(request: DecisionRelayRequest | RelayReplyRequest): void | Promise<void>;
    /**
     * 接收留言的一方回送是否写入以及可能的收件编号。
     * 谁发：
     *   src7/plugins/work-decision/Routes.ts 的 mount
     *   src7/plugins/relay/index.ts 的 Relay.constructor
     * 谁接：
     *   src7/plugins/work-decision/Routes.ts 的 requestRelay
     *   src7/plugins/relay/index.ts 的 Relay.queueDecisionReply
     */
    'work-decision/note-result'(result: DecisionRelayResult): void;
  }
}

const PREFIX = '/api/work-decision';
const RETRY = { method: 'GET', path: `${PREFIX}/changes` };
const RELAY_UNCERTAIN = '中控收件操作结果不确定';
/** 一条留言或回话最多多少字，防止误贴整份文件进收件箱。 */
const NOTE_MAX = 2000;

/** 入口读留言文字：非空、不超过 NOTE_MAX 字。 */
function readNoteText(value: unknown): string {
  //G 先按普通文本校验非空并去掉首尾空白。
  const text = storeModule.readText(value, 'text');

  //G 超长的话不存也不投，提示用户分几次写。
  if (text.length > NOTE_MAX) throw new failureModule.Failure(400, `text 最多 ${String(NOTE_MAX)} 字`);

  return text;
}

/**
 * 注册读图、批量写入、点选、写话、回话、轮询和确认入口。
 * @param ctx 插件的 Cordis 上下文。
 * @param store 运行时决策图。
 * @param helper 配置的中控 relay 助手，省略时通过变化接口收结果。
 */
export function mount(
  ctx: cordis.Context,
  store: storeModule.Store,
  helper: string | undefined,
  ownerNotice: notifications.OwnerNotice | undefined,
): void {
  const app = ctx.http.app;
  const onError = (error: unknown) => ({ ok: false, error: textModule.getErrorMessage(error) });
  const replyOptions = {
    filter: (request: DecisionRelayRequest | RelayReplyRequest) => request.action === 'reply',
    onError,
  };

  //M relay 确认写图完成后才结清自己的回信，失败时留待重试。
  events.onRequestEvent(ctx, 'work-decision/note', 'work-decision/note-result', (request) => {
    if (request.action !== 'reply') return { ok: false };

    const { text, id, target } = request;
    //M 和直达 HTTP 回话共用存储，保留和用户留言的关联。
    store.reply(target.node, target.note, text, id);
    return { ok: true };
  }, replyOptions);

  const sessionDecisionOptions = {
    filter: (decision: ChosenNotice) => decision.asker.kind === 'session',
  };
  events.onRequestEvent(ctx, 'work-decision/decided', 'work-decision/decided-result', async (decision) => {
    if (decision.asker.kind !== 'session') return { ok: false };

    //M 已定选项按稳定键排回原会话，重复入队沿用机器人结果队列的去重。
    const input: dispatch.ResultInput = {
      key: `work-decision:${decision.node}`,
      sessionId: decision.asker.sessionId,
      source: { type: 'work-decision', id: decision.node },
      payload: { text: decision.text, files: [] },
    };
    const request = { action: 'accept-result', input } as const;
    const options = { warnAfterMs: 5000 };
    //M 同一份选择排给原会话，等本机机器人确认入队。
    const result = await events.requestEvent(ctx, 'bot/request', 'bot/result', request, options);
    //G 回执未确认时保留补投机会。
    if (result.why !== undefined) return { ok: false, uncertain: events.isUncertain(result) };
    if (!result.reply.ok || result.reply.receipt === undefined) return { ok: false };

    //M 记住已入队，后续再点也不会重复唤醒已处理的会话。
    store.ack(decision.node);
    return { ok: true, queued: true };
  }, sessionDecisionOptions);

  //M 插件和网页用同一份存储。投递发生在快照和历史提交以后。
  const deliverTasks = async (tasks: readonly types.DecisionTaskChange[], revision: number) => {
    if (helper === undefined) return tasks.map(() => RETRY);

    const requests = tasks.map(async (task) => {
      let change = `新建，状态 ${task.status}`;
      if (task.previousStatus !== undefined) {
        change = `状态从 ${task.previousStatus} 改为 ${task.status}`;
      }
      const text = `任务树「${task.title}」\n节点 ${task.node}，${change}。`;
      const node = `${task.node}#change:${String(revision)}`;
      const target = { node: task.node };
      const relay = { action: 'deliver', node, helper, text, target } as const;

      //M 收件按提交序号去重，回话地址仍是实际任务节点。
      const result = await requestRelay(ctx, relay);
      return getDelivery(result);
    });
    return Promise.all(requests);
  };

  //M 登记插件批量提问入口，与网页共用存储。
  events.onRequestEvent(ctx, 'work-decision/ask', 'work-decision/ask-result', async (request) => {
    //M 局部更新和新事项共用父链校验与事务提交。
    const { graph, tasks } = store.put(request.nodes, 'plugin');
    notifications.notifyNew(ctx, ownerNotice, graph, tasks);
    await deliverTasks(tasks, graph.revision);
    return { ok: true, ids: request.nodes.map((node) => node.id) };
  }, { onError });

  //M 决策图接口沿用 HTTP 插件的鉴权和错误处理。
  void app.register(async (scope) => {
    const redirect = (request: fastify.FastifyRequest, reply: fastify.FastifyReply) => {
      const query = request.url.indexOf('?');
      let suffix = '';
      if (query >= 0) {
        suffix = request.url.slice(query);
      }

      //M 旧书签里的节点定位和语言参数继续交给新页面。
      return reply.redirect(`${notifications.PAGE}${suffix}`, 301);
    };
    //M 旧书签带不带末尾斜杠都可进入新页面。
    scope.get('/decision-map', redirect);
    //M 保留早期直接分享带末尾斜杠的地址。
    scope.get('/decision-map/', redirect);
    //M 页面读当前快照，中控的批量修改统一进入同一快照。
    scope.get(`${PREFIX}/graph`, () => store.getPublicGraph());
    scope.put<{ Body: unknown }>(`${PREFIX}/nodes`, (request) => {
      let nodes = request.body;
      if (!Array.isArray(nodes)) {
        //M 批量入口同时接收节点列表和带 nodes 的包装对象。
        const body = checksModule.checkRecord(nodes, '请求体');
        nodes = body['nodes'];
      }
      //M 成批保存节点，失败时不会新增提醒。
      const saved = store.put(nodes, 'central');
      //M 批次若打开了待定项，按当前图通知主人。
      notifications.notifyNew(ctx, ownerNotice, saved.graph, saved.tasks);
      //M 写入回执与读图使用同样的项目结构。
      return store.getPublicGraph();
    });

    scope.post<{ Body: unknown }>(`${PREFIX}/ask`, (request) => {
      //G 外部发起提问时提供稳定编号、归属和回信的助手。
      const body = checksModule.checkRecord(request.body, '请求体');
      const id = storeModule.readText(body['id'], 'id');
      const bot = storeModule.readText(body['bot'], 'bot');
      const name = storeModule.readText(body['helper'], 'helper');
      //G 简述不能为空，主人在决定前需要看到背景。
      const summary = storeModule.readText(body['summary'], 'summary');
      let workspaceId: string | undefined;
      if (body['workspaceId'] !== undefined) {
        workspaceId = storeModule.readText(body['workspaceId'], 'workspaceId');
      }
      const input = {
        id, bot, workspaceId, asker: { kind: 'helper', name },
        title: body['title'], summary, options: body['options'], body: body['body'],
      } as types.DecisionAsk;
      //M 新项目按工作区归组，发起方由已校验的助手名称确定。
      const saved = store.ask(input);
      //M 上一条重复提交已返回原节点，只有新事项计入提醒。
      notifications.notifyNew(ctx, ownerNotice, saved.graph, saved.tasks);
      const query = new URLSearchParams({ focus: id });
      const url = `${notifications.PAGE}?${query.toString()}`;
      return { id, url };
    });
    scope.post(`${PREFIX}/notify`, () => {
      //G 主动提醒需要配置明确的私聊目标。
      if (ownerNotice === undefined) throw new failureModule.Failure(400, '请配置 owner_target 和 public_url');

      //M 中控手动提醒沿用同一渠道请求，不另写飞书发件箱。
      const graph = store.getGraph();
      const manualKey = crypto.randomUUID();
      return notifications.notify(ctx, ownerNotice, graph, manualKey);
    });
    scope.post<{ Body: unknown }>(`${PREFIX}/child`, async (request) => {
      const body = checksModule.checkRecord(request.body, '请求体');
      const parent = storeModule.readText(body['parent'], 'parent');
      const title = storeModule.readText(body['title'], 'title');
      const id = crypto.randomUUID();
      const child = { id, parent, title, kind: 'work', status: 'open' };

      //M 父节点验证随提交完成，失败不改变历史也不通知中控。
      const { graph, tasks } = store.put([child], 'user');
      const delivery = await deliverTasks(tasks, graph.revision);
      return { id, graph, delivery };
    });
    //M 网页和中控都可改任务状态，只有网页提交需要通知中控。
    scope.route<{ Body: unknown }>({
      method: ['POST', 'PUT'],
      url: `${PREFIX}/status`,
      async handler(request) {
        const body = checksModule.checkRecord(request.body, '请求体');
        const id = storeModule.readText(body['id'], 'id');
        const status = storeModule.readStatus(body['status']);
        if (request.method === 'PUT') return store.setStatus(id, status, 'central');

        //M 网页改状态进中控收件；中控走 PUT 更新自己的图。
        const changed = store.setStatus(id, status, 'user');
        const { revision } = store.getGraph();
        const delivery = await deliverTasks(changed.tasks, revision);
        return { node: changed.node, delivery };
      },
    });
    //M 网页和中控均可调整节点的四象限归类（传 null 恢复默认自动归类）。
    scope.route<{ Body: unknown }>({
      method: ['POST', 'PUT'],
      url: `${PREFIX}/quadrant`,
      handler(request) {
        const body = checksModule.checkRecord(request.body, '请求体');
        const id = storeModule.readText(body['id'], 'id');
        const quadrant = storeModule.readQuadrant(body['quadrant']);
        if (quadrant === undefined) {
          throw new failureModule.Failure(400, 'quadrant 必填（q1~q4 或 null）');
        }
        if (request.method === 'PUT') return store.setQuadrant(id, quadrant, 'central');

        //M 网页点击象限胶囊即时落库并返回最新节点。
        return store.setQuadrant(id, quadrant, 'user');
      },
    });
    //M 允许中控按版本只提取尚未处理的变化。
    scope.get<{ Querystring: { since?: string } }>(`${PREFIX}/changes`, (request) => {
      const since = checksModule.checkCount(request.query.since, 'since') ?? 0;

      //M 根据序号取变化，中控轮询时不会重复处理旧决定。
      return store.getChanges(since);
    });
    scope.post<{ Body: unknown }>(`${PREFIX}/choose`, async (request) => {
      const body = checksModule.checkRecord(request.body, '请求体');
      const id = storeModule.readText(body['node'], 'node');
      const optionId = storeModule.readText(body['option'], 'option');

      //M 选择先入图和历史，再通过事件通知中控。
      const picked = store.choose(id, optionId);
      const note = picked.node.notes?.find((item) => item.option === optionId);
      const delivery = await deliverDecision(ctx, picked.node, picked.option, helper, note);
      const node = store.getGraph().nodes.find((item) => item.id === id) ?? picked.node;
      return { node, delivery };
    });
    scope.post<{ Body: unknown }>(`${PREFIX}/note`, async (request) => {
      //G 入口校验一次：节点号、文字非空且不超长，选项可省略。
      const body = checksModule.checkRecord(request.body, '请求体');
      const id = storeModule.readText(body['node'], 'node');
      const text = readNoteText(body['text']);
      let optionId: string | undefined;
      if (body['option'] !== undefined) optionId = storeModule.readText(body['option'], 'option');

      //M 带了选项先照点选落盘，和直接点选项走同一条路。
      let option: types.DecisionOption | undefined;
      let changed = false;
      if (optionId !== undefined) {
        const picked = store.choose(id, optionId);
        option = picked.option;
        changed = picked.changed;
      }

      //M 再记下这句话；节点不存在时这里报 404。
      const added = store.addNote(id, text, optionId);
      if (option !== undefined && changed) {
        const delivery = await deliverDecision(ctx, added.node, option, helper, added.note);
        const node = store.getGraph().nodes.find((item) => item.id === id) ?? added.node;
        return { node, note: added.note, delivery };
      }
      //M 用户留言交给原提问的助手，未指定时用旧图默认助手。
      const recipient = getAsker(added.node, helper);
      if (recipient?.kind !== 'helper') return { node: added.node, note: added.note, delivery: RETRY };

      //M 收件正文写清哪张图、哪个节点、用户写了什么，选了选项的一并写上。
      const lines = [`工作决策「${added.node.title}」节点 ${id}：用户写了：${text}`];
      if (option !== undefined) lines.push(`同时选了「${option.text}」（选项 ${option.id}）。`);
      if (option === undefined) lines.push('节点状态没改，处理完用 Decision_Map.mjs add 更新节点。');
      const command = `Decision_Map.mjs reply ${JSON.stringify(id)} ${added.note.id} "<回话>"`;
      lines.push(`回话请运行 ${command}`);
      const key = `${id}#${added.note.id}`;
      const relayText = lines.join('\n');
      const target = { node: id, note: added.note.id };
      const relay = { action: 'deliver', node: key, helper: recipient.name, text: relayText, target } as const;

      //M 每条留言单独进中控收件，relay 按「节点号#留言号」去重。
      const result = await requestRelay(ctx, relay);
      return { node: added.node, note: added.note, delivery: getDelivery(result) };
    });
    scope.post<{ Body: unknown }>(`${PREFIX}/reply`, async (request) => {
      //G 中控回话入口同样只校验一次：节点号、留言号、文字。
      const body = checksModule.checkRecord(request.body, '请求体');
      const id = storeModule.readText(body['node'], 'node');
      const replyTo = storeModule.readText(body['note'], 'note');
      const text = readNoteText(body['text']);

      //M 回话落盘，网页下次轮询就能看到。
      const replied = store.reply(id, replyTo, text);
      const recipient = getAsker(replied.node, helper);
      if (recipient?.kind !== 'helper') return { node: replied.node, note: replied.note };

      const key = `${id}#${replyTo}`;
      const relay = { action: 'ack', node: key, helper: recipient.name } as const;

      //M 归档这条留言的收件，Wait_Relay 下次只唤醒新的话。
      const asked = await requestRelay(ctx, relay);

      //G relay 处理时抛错：归档结果不确定。
      if (events.isUncertain(asked)) {
        return { node: replied.node, note: replied.note, notification: RELAY_UNCERTAIN };
      }

      //M 没挂 relay 算没通知到。
      const notified = asked.reply?.ok === true;
      return { node: replied.node, note: replied.note, notified };
    });
    scope.post<{ Body: unknown }>(`${PREFIX}/ack`, async (request) => {
      //G 确认入口只取节点号与可选附言。
      const body = checksModule.checkRecord(request.body, '请求体');
      const id = storeModule.readText(body['node'], 'node');
      let note: string | undefined;

      //G 中控附言作为文字展示，不接受其他数据类型。
      if (body['note'] !== undefined) note = storeModule.readText(body['note'], 'note');

      //M 中控确认独立落盘，页面据此把已定节点变绿。
      const node = store.ack(id, note);
      const recipient = getAsker(node, helper);
      if (recipient?.kind !== 'helper') return { node };

      const relay = { action: 'ack', node: id, helper: recipient.name } as const;

      //M 归档对应收件，让 Wait_Relay 下次只唤醒新的决定。
      const asked = await requestRelay(ctx, relay);

      //G relay 处理时抛错：归档结果不确定。
      if (events.isUncertain(asked)) return { node, notification: RELAY_UNCERTAIN };

      //M 没挂 relay 算没通知到。
      const notified = asked.reply?.ok === true;
      return { node, notified };
    });

    const appStartedAt = Date.now();
    //M 30 秒轻量探针只回启动时刻和数据序号，无变化时不拉完整图。
    scope.get(`${PREFIX}/version`, () => ({ appStartedAt, dataRev: store.getRevision() }));
  });
}

/** 优先回到明确登记的提问方，旧图由配置中的助手接收。 */
function getAsker(node: types.DecisionNode, helper?: string): types.DecisionAsker | undefined {
  if (node.asker !== undefined) return node.asker;
  if (helper === undefined) return;

  return { kind: 'helper', name: helper };
}

/** 把已入库的选择通知唯一提问方，失败时仍可从变化接口读出。 */
async function deliverDecision(
  ctx: cordis.Context,
  node: types.DecisionNode,
  option: types.DecisionOption,
  helper: string | undefined,
  note: types.DecisionNote | undefined,
) {
  //M 从节点确定选完应该通知哪一方。
  const asker = getAsker(node, helper);
  if (asker === undefined) return RETRY;
  if (node.acknowledgedAt !== undefined && asker.kind === 'session') return { queued: true };
  if (node.acknowledgedAt !== undefined) return RETRY;

  let text = `工作决策「${node.title}」中，主人选了「${option.text}」（${option.id}）。`;
  if (note !== undefined) {
    text = `${text}\n备注：${note.text}`;
  }
  let key = node.id;
  if (asker.kind === 'helper') {
    text = `${text}\n节点 ${node.id}。\n确认收到请运行 Decision_Map.mjs done ${JSON.stringify(node.id)}`;
    if (note !== undefined) {
      key = `${key}#${note.id}`;
      text = `${text}\n回话请运行 Decision_Map.mjs reply ${JSON.stringify(node.id)} ${note.id} "<回话>"`;
    }
  }
  const decision = { node: node.id, option: option.id, title: node.title, asker, key, text, note: note?.id };

  //M 只有符合提问方的监听者接管本次通知，重复请求沿用同一投递键。
  const asked = await events.requestEvent(ctx, 'work-decision/decided', 'work-decision/decided-result', decision);
  if (asked.why === 'unhandled') return RETRY;
  if (asked.why !== undefined) {
    //M 记录回送异常并交回变化接口供查询。
    const message = asked.detail ?? asked.why;
    console.error(`work-decision：选择回送失败，${message}`);
    return { ...RETRY, error: RELAY_UNCERTAIN };
  }

  const result = asked.reply;
  if (result.ok && result.id !== undefined) return { relayId: result.id };
  if (result.ok && result.queued === true) return { queued: true };
  if (result.uncertain === true) return { ...RETRY, error: RELAY_UNCERTAIN };

  return RETRY;
}

/** 只在收到确切收件号时标为投递成功。未确认时可从变化接口只读查询。 */
function getDelivery(asked: events.Asked<DecisionRelayResult>) {
  //G 没挂 relay：留给中控轮询。
  if (asked.why === 'unhandled') return RETRY;

  //G relay 处理时抛错，无法确定是否已送时向页面保留这个状态。
  if (asked.why !== undefined) return { ...RETRY, error: RELAY_UNCERTAIN };

  if (asked.reply.ok && asked.reply.id !== undefined) return { relayId: asked.reply.id };

  return RETRY;
}

/** 向 relay 发并等待一次配对回执，无监听时保留轮询路径。 */
function requestRelay(ctx: cordis.Context, request: events.StripEnvelope<DecisionRelayRequest>) {
  //M 检查 relay 是否确认了对应的收件，缺席时 RequestEvent 会立即返回。relay 在本进程里写收件表，不掐表。
  return events.requestEvent(ctx, 'work-decision/note', 'work-decision/note-result', request);
}
