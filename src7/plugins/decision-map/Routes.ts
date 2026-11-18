/** 决策图 HTTP 接口和选择通知。 */
import type * as cordis from 'cordis';
import * as failureModule from '../../utils/Failure.ts';
import * as events from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as storeModule from './Store.ts';

/** 只给中控收件用的请求，不向机器人会话投递。 */
export interface DecisionRelayRequest extends events.RequestEnvelope {
  /** 新选择进收件箱，或者确认收到后清理收件状态。 */
  action: 'deliver' | 'ack';
  /** relay 配置中的中控助手名。 */
  helper: string;
  /** 决策图节点号，作为同一条收件的稳定键。 */
  node: string;
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
    /** 用户的选择已保存。 */
    'decision-map/chosen'(notice: ChosenNotice): void;
    /** 决策图向 relay 投递或确认属于中控的一条收件。 */
    'decision-map/relay'(request: DecisionRelayRequest): void | Promise<void>;
    /** relay 回送中控收件号或失败原因。 */
    'decision-map/relay-result'(result: DecisionRelayResult): void;
  }
}

const PREFIX = '/api/decision-map';
const RETRY = { method: 'GET', path: `${PREFIX}/changes` };

/**
 * 注册读图、批量写入、点选、轮询和确认入口。
 * @param ctx 插件的 Cordis 上下文。
 * @param store 运行时决策图。
 * @param helper 配置的中控 relay 助手，省略时通过变化接口收结果。
 */
export function mount(ctx: cordis.Context, store: storeModule.Store, helper?: string): void {
  const app = ctx.http.app;

  //M 用独立作用域统一处理节点校验和持久化错误，沿用 HTTP 插件鉴权。
  void app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      let status = (error as { statusCode?: number }).statusCode ?? 500;
      if (error instanceof failureModule.Failure) status = error.status;

      //M 统一回复调用端可以展示的错误文字。
      const message = textModule.getMessage(error);
      return reply.code(status).send({ error: message });
    });

    //M 页面读当前快照，中控的批量修改统一进入同一快照。
    scope.get(`${PREFIX}/graph`, () => store.getGraph());
    scope.put<{ Body: unknown }>(`${PREFIX}/nodes`, (request) => {
      if (Array.isArray(request.body)) return store.put(request.body);

      //M 包装对象里取出 nodes，也支持直接提交节点列表。
      const body = storeModule.readObject(request.body);
      return store.put(body['nodes']);
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
      const relay = { action: 'deliver', node: id, helper, text } as const;

      //M 同一选择重试也可以补投，relay 按节点号去重。
      const result = await requestRelay(ctx, relay);
      if (!result.ok || result.id === undefined) return { node: picked.node, delivery: RETRY };

      return { node: picked.node, delivery: { relayId: result.id } };
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
      return { node, notified: result.ok };
    });
  });
}

/** 向 relay 发并等待一次配对回执，无监听时保留轮询路径。 */
function requestRelay(ctx: cordis.Context, request: events.StripEnvelope<DecisionRelayRequest>) {
  const options = { timeoutMs: 3000, onFallback: () => ({ requestId: '', ok: false }) };

  //M 检查 relay 是否确认了对应的收件，缺席时 RequestEvent 会立即返回。
  return events.requestEvent(ctx, 'decision-map/relay', 'decision-map/relay-result', request, options);
}
