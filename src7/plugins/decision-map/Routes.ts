/** 决策图 HTTP 接口、插件指令和中控收件投递。 */
import * as crypto from 'node:crypto';
import type * as cordis from 'cordis';
import * as failureModule from '../../utils/Failure.ts';
import * as events from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as storeModule from './Store.ts';
import type * as types from './Types.ts';

/** 新节点提供必填字段，更新只给节点号及待改内容。 */
type NodePatch = Pick<types.DecisionNode, 'id'> & Partial<types.DecisionNode>;

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
  /** relay 回信的持久编号，重复投递按它对账。 */
  id: number;
  /** 旧收件键：节点或节点#留言号。 */
  key: string;
  /** 新收件记录的节点及留言，可省略留言号。 */
  target?: storeModule.ReplyTarget;
  /** 中控已交给 relay 的回信原文。 */
  text: string;
}

/** 回信写图后交回 relay 的回执。 */
interface RelayReplyResult extends events.ResultEnvelope {
  /** 节点上已有这条回信。 */
  ok: boolean;
  /** 节点暂未接收时的原因。 */
  error?: string;
}

/** 用户刚提交的一次选择。 */
interface ChosenNotice {
  /** 节点号。 */
  node: string;
  /** 选项号。 */
  option: string;
  /** 画布上的节点标题。 */
  title: string;
}

declare module 'cordis' {
  interface Events {
    /**
     * 插件注册或局部更新一批节点，保存后通知中控。
     * 谁发：暂无
     * 谁接：src7/plugins/decision-map/Routes.ts 的 mount
     */
    'decision-map/upsert'(nodes: NodePatch | readonly NodePatch[]): void | Promise<void>;
    /**
     * 插件修改单个任务的状态，保存后通知中控。
     * 谁发：暂无
     * 谁接：src7/plugins/decision-map/Routes.ts 的 mount
     */
    'decision-map/status'(change: { id: string; status: types.DecisionStatus }): void | Promise<void>;
    /**
     * 用户的选择已保存。
     * 谁发：src7/plugins/decision-map/Routes.ts 的 mount
     * 谁接：暂无
     */
    'decision-map/chosen'(notice: ChosenNotice): void;
    /**
     * 决策图向 relay 投递或确认属于中控的一条收件。
     * 谁发：src7/plugins/decision-map/Routes.ts 的 requestRelay
     * 谁接：src7/plugins/relay/index.ts 的 Relay.constructor
     */
    'decision-map/relay'(request: DecisionRelayRequest): void | Promise<void>;
    /**
     * relay 回送中控收件号或失败原因。
     * 谁发：src7/plugins/relay/index.ts 的 Relay.constructor
     * 谁接：src7/plugins/decision-map/Routes.ts 的 requestRelay
     */
    'decision-map/relay-result'(result: DecisionRelayResult): void;
    /**
     * relay 交回决策图来源的收件回复。
     * 谁发：src7/plugins/relay/index.ts 的 Relay.queueDecisionReply
     * 谁接：src7/plugins/decision-map/Routes.ts 的 mount
     */
    'decision-map/relay-reply'(request: RelayReplyRequest): void | Promise<void>;
    /**
     * 决策图确认回话已经落盘。
     * 谁发：src7/plugins/decision-map/Routes.ts 的 mount
     * 谁接：src7/plugins/relay/index.ts 的 Relay.queueDecisionReply
     */
    'decision-map/relay-replied'(result: RelayReplyResult): void;
  }
}

const PREFIX = '/api/decision-map';
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
export function mount(ctx: cordis.Context, store: storeModule.Store, helper?: string): void {
  const app = ctx.http.app;
  const replyEvent = 'decision-map/relay-reply';
  const receiptEvent = 'decision-map/relay-replied';
  const onError = (error: unknown) => ({ ok: false, error: textModule.getErrorMessage(error) });
  const replyOptions = { onError };

  //M relay 确认写图完成后才结清自己的回信，失败时留待重试。
  events.onRequestEvent(ctx, replyEvent, receiptEvent, (request) => {
    const { key, text, id, target } = request;
    //M 和直达 HTTP 回话共用存储，保留和用户留言的关联。
    store.replyFromRelay(key, text, id, target);
    return { ok: true };
  }, replyOptions);

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

  ctx.on('decision-map/upsert', async (input) => {
    let nodes: unknown = input;
    if (!Array.isArray(input)) nodes = [input];

    //M 单节点和批量共用父链校验、原子保存与通知。
    const { graph, tasks } = store.put(nodes, 'plugin');
    await deliverTasks(tasks, graph.revision);
  });
  ctx.on('decision-map/status', async (input) => {
    const body = storeModule.readObject(input);
    const id = storeModule.readText(body['id'], 'id');
    const status = storeModule.readStatus(body['status']);

    //M 保留既有决定与对话；重复设置同一状态不会通知。
    const { tasks } = store.setStatus(id, status, 'plugin');
    const { revision } = store.getGraph();
    await deliverTasks(tasks, revision);
  });

  //M 决策图接口沿用 HTTP 插件的鉴权和错误处理。
  void app.register(async (scope) => {
    //M 页面读当前快照，中控的批量修改统一进入同一快照。
    scope.get(`${PREFIX}/graph`, () => store.getGraph());
    scope.put<{ Body: unknown }>(`${PREFIX}/nodes`, (request) => {
      if (Array.isArray(request.body)) return store.put(request.body, 'central').graph;

      //M 包装对象里取出 nodes，也支持直接提交节点列表。
      const body = storeModule.readObject(request.body);
      return store.put(body['nodes'], 'central').graph;
    });
    scope.post<{ Body: unknown }>(`${PREFIX}/child`, async (request) => {
      const body = storeModule.readObject(request.body);
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
        const body = storeModule.readObject(request.body);
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
    //M 允许中控按版本只提取尚未处理的变化。
    scope.get<{ Querystring: { since?: string } }>(`${PREFIX}/changes`, (request) => {
      const raw = request.query.since ?? '0';
      const since = Number(raw);
      if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(since)) {
        throw new failureModule.Failure(400, 'since 要是不小于 0 的整数');
      }

      //M 根据序号取变化，中控轮询时不会重复处理旧决定。
      return store.getChanges(since);
    });
    scope.post<{ Body: unknown }>(`${PREFIX}/choose`, async (request) => {
      const body = storeModule.readObject(request.body);
      const id = storeModule.readText(body['node'], 'node');
      const optionId = storeModule.readText(body['option'], 'option');

      //M 选择先入图和历史，再通过事件通知中控。
      const picked = store.choose(id, optionId);
      const notice = { node: id, option: optionId, title: picked.node.title };
      if (picked.changed) ctx.emit('decision-map/chosen', notice);
      if (helper === undefined || picked.node.acknowledgedAt !== undefined) {
        return { node: picked.node, delivery: RETRY };
      }

      const text = `决策图「${notice.title}」已选「${picked.option.text}」\n节点 ${id}，选项 ${optionId}。`
        + `\n确认收到请运行 Decision_Map.mjs done ${JSON.stringify(id)}`;
      const target = { node: id };
      const relay = { action: 'deliver', node: id, helper, text, target } as const;

      //M 同一选择重试也可以补投，relay 按节点号去重。
      const result = await requestRelay(ctx, relay);
      return { node: picked.node, delivery: getDelivery(result) };
    });
    scope.post<{ Body: unknown }>(`${PREFIX}/note`, async (request) => {
      //G 入口校验一次：节点号、文字非空且不超长，选项可省略。
      const body = storeModule.readObject(request.body);
      const id = storeModule.readText(body['node'], 'node');
      const text = readNoteText(body['text']);
      let optionId: string | undefined;
      if (body['option'] !== undefined) optionId = storeModule.readText(body['option'], 'option');

      //M 带了选项先照点选落盘，和直接点选项走同一条路。
      let optionText: string | undefined;
      if (optionId !== undefined) {
        const picked = store.choose(id, optionId);
        const notice = { node: id, option: optionId, title: picked.node.title };
        if (picked.changed) ctx.emit('decision-map/chosen', notice);
        optionText = picked.option.text;
      }

      //M 再记下这句话；节点不存在时这里报 404。
      const added = store.addNote(id, text, optionId);
      if (helper === undefined) return { node: added.node, note: added.note, delivery: RETRY };

      //M 收件正文写清哪张图、哪个节点、用户写了什么，选了选项的一并写上。
      const lines = [`决策图「${added.node.title}」节点 ${id}：用户写了：${text}`];
      if (optionText !== undefined) lines.push(`同时选了「${optionText}」（选项 ${String(optionId)}）。`);
      if (optionText === undefined) lines.push('节点状态没改，处理完用 Decision_Map.mjs add 更新节点。');
      const command = `Decision_Map.mjs reply ${JSON.stringify(id)} ${added.note.id} "<回话>"`;
      lines.push(`回话请运行 ${command}`);
      const key = `${id}#${added.note.id}`;
      const relayText = lines.join('\n');
      const target = { node: id, note: added.note.id };
      const relay = { action: 'deliver', node: key, helper, text: relayText, target } as const;

      //M 每条留言单独进中控收件，relay 按「节点号#留言号」去重。
      const result = await requestRelay(ctx, relay);
      return { node: added.node, note: added.note, delivery: getDelivery(result) };
    });
    scope.post<{ Body: unknown }>(`${PREFIX}/reply`, async (request) => {
      //G 中控回话入口同样只校验一次：节点号、留言号、文字。
      const body = storeModule.readObject(request.body);
      const id = storeModule.readText(body['node'], 'node');
      const replyTo = storeModule.readText(body['note'], 'note');
      const text = readNoteText(body['text']);

      //M 回话落盘，网页下次轮询就能看到。
      const replied = store.reply(id, replyTo, text);
      if (helper === undefined) return { node: replied.node, note: replied.note };

      const key = `${id}#${replyTo}`;
      const relay = { action: 'ack', node: key, helper } as const;

      //M 归档这条留言的收件，Wait_Relay 下次只唤醒新的话。
      const result = await requestRelay(ctx, relay);
      if (events.isUnsure(result)) {
        return { node: replied.node, note: replied.note, notification: RELAY_UNCERTAIN };
      }
      return { node: replied.node, note: replied.note, notified: result.ok };
    });
    scope.post<{ Body: unknown }>(`${PREFIX}/ack`, async (request) => {
      //G 确认入口只取节点号与可选附言。
      const body = storeModule.readObject(request.body);
      const id = storeModule.readText(body['node'], 'node');
      let note: string | undefined;

      //G 中控附言作为文字展示，不接受其他数据类型。
      if (body['note'] !== undefined) note = storeModule.readText(body['note'], 'note');

      //M 中控确认独立落盘，页面据此把已定节点变绿。
      const node = store.ack(id, note);
      if (helper === undefined) return { node };

      const relay = { action: 'ack', node: id, helper } as const;

      //M 归档对应收件，让 Wait_Relay 下次只唤醒新的决定。
      const result = await requestRelay(ctx, relay);
      if (events.isUnsure(result)) return { node, notification: RELAY_UNCERTAIN };

      return { node, notified: result.ok };
    });
  });
}

/** 只在收到确切收件号时标为投递成功。未确认时可从变化接口只读查询。 */
function getDelivery(result: DecisionRelayResult & events.RequestFallback) {
  if (result.ok && result.id !== undefined) return { relayId: result.id };
  if (events.isUnsure(result)) return { ...RETRY, error: RELAY_UNCERTAIN };

  return RETRY;
}

/** 向 relay 发并等待一次配对回执，无监听时保留轮询路径。 */
function requestRelay(ctx: cordis.Context, request: events.StripEnvelope<DecisionRelayRequest>) {
  const onFallback = () => ({ requestId: '', ok: false });
  const options = { timeoutMs: 3000, onFallback };

  //M 检查 relay 是否确认了对应的收件，缺席时 RequestEvent 会立即返回。
  return events.requestEvent(ctx, 'decision-map/relay', 'decision-map/relay-result', request, options);
}
