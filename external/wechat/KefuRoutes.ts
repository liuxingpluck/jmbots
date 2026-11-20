/** 外置客服页的能力、监听名单和本人逐条批准入口。 */
import type * as sqlite from 'bun:sqlite';
import type * as fastify from 'fastify';
import * as protocol from './Protocol.ts';

/** 当前外置程序的发送配置，不向浏览器返回宿主密钥。 */
interface Bridge {
  channel: string;
  key: string;
  /** 宿主提供的本进程回调前缀。 */
  callback?: string;
  send: { enabled: boolean };
}

/** 供客服页显示的草稿与发件结果。 */
interface Draft {
  id: number;
  account: string;
  chat: string;
  name: string;
  text: string;
  state: string;
  note: string;
}

const API = '/api/wechat-kefu';
const REQUEST_PREFIX = 'kefu-draft:';
const UNKNOWN = { status: 'uncertain', reason: '微信发送结果待核对，不自动重发' };

/**
 * 登记外置客服的读接口和确认操作。
 * @param app 已挂载 P2 的外置 HTTP 服务。
 * @param db 读取监听、草稿和原发件回执的数据库。
 * @param bridge 渠道启动配置，独立预览时省略。
 * 副作用：挂载路由，已核验的页面操作交回主站批准。
 */
export function mountKefu(app: fastify.FastifyInstance, db: sqlite.Database, bridge?: Bridge): void {
  const draftFields = 'o.id, o.account, o.chat, o.name, o.text';
  let draftSelect = `SELECT ${draftFields}, o.state, o.note FROM wechat_outbox o`;
  const queryArgs: string[] = [];
  if (bridge !== undefined) {
    //M 从 P2 的持久化回执读取状态，重启也能看到已发或不确定，不另外维护一份状态。
    draftSelect = `SELECT ${draftFields}, coalesce(s.state, o.state) AS state, coalesce(s.note, o.note) AS note`
      + ' FROM wechat_outbox o LEFT JOIN wechat_send_requests s ON s.channel = ?'
      + ` AND (s.request_id = '${REQUEST_PREFIX}' || o.id`
      + ` OR s.request_id GLOB '${REQUEST_PREFIX}' || o.id || ':*')`;
    queryArgs.push(bridge.channel);
  }
  const listSql = `${draftSelect} ORDER BY o.id DESC LIMIT 100`;
  //M 草稿列表继续读旧 P2 回执，历史在途记录保留待核。
  const listDrafts = db.query<Draft, string[]>(listSql);

  //M 能力只由启动配置和代理注入的密钥决定，浏览器无需接触密钥。
  app.get(`${API}/capabilities`, (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (bridge === undefined) return { watch: false, send: 'preview' };

    //G 只接受本次进程的宿主密钥。
    const given = request.headers[protocol.KEY_HEADER];
    const channel = bridge.channel;
    if (!protocol.isSameKey(bridge.key, given)) return { channel, watch: false, send: 'approval' };
    if (!bridge.send.enabled) return { channel, watch: true, send: 'draft' };
    return { channel, watch: true, send: 'ready' };
  });

  //M 直接查已保存的监听名单，账号断开或会话过多时依旧可以看到。
  app.get(`${API}/watch`, () => {
    const sql = 'SELECT account, chat, name FROM wechat_watch ORDER BY account, name, chat';
    return db.query(sql).all();
  });
  //M 草稿列表同时展示一次性发送入口的回执。
  app.get(`${API}/drafts`, () => {
    const drafts = listDrafts.all(...queryArgs);
    return drafts.map((draft) => {
      //G 重启前已占位的请求缺少最终回执，只能让本人核对。
      if (draft.state === 'sending') {
        return { ...draft, state: UNKNOWN.status, note: UNKNOWN.reason };
      }
      return draft;
    });
  });

  //G 直连外置的预览仍可读数据，修改监听要经过主站代理。
  app.addHook('preHandler', (request, reply, done) => {
    if (bridge === undefined || request.method !== 'PUT' || request.routeOptions.url !== `${API}/watch`) return done();

    //G 只接受本次进程的宿主密钥。
    const given = request.headers[protocol.KEY_HEADER];
    if (!protocol.isSameKey(bridge.key, given)) {
      //G 不带宿主密钥的直连不能改监听名单。
      void reply.code(401).send({ error: '等主站接上批准（P3）' });
      return;
    }
    done();
  });

  //M 单独接客服起草，不进入批准或发送接口。
  mountDraft(app, db, bridge);

  //M 只转交本人准备、确认与查询操作。原文、批准和发送由主站处理。
  app.post(`${API}/outbox/send`, async (request, reply) => {
    if (bridge === undefined) return reply.code(409).send({ error: '独立预览仅支持读取' });

    //G 只接受本次进程的宿主密钥。
    const given = request.headers[protocol.KEY_HEADER];
    if (!protocol.isSameKey(bridge.key, given)) return reply.code(401).send({ error: '等主站接上批准（P3）' });

    const posted = request.body as { action?: unknown } | null | undefined;
    const action = posted?.action;
    const sending = action === 'prepare' || action === 'confirm';
    //G 只存草稿的实例不收新确认。
    if (sending && !bridge.send.enabled) return reply.code(409).send({ error: '本实例只存草稿' });
    if (!sending && action !== 'status' && action !== 'reconcile') {
      //G 旧版单步请求只带草稿号，必须走主站预览加明确确认。
      return reply.code(409).send({ error: '请先由主站展示本次发件，再确认发送' });
    }
    //G 主站回调没配置时直接拒绝，不调用本地发送器。
    if (bridge.callback === undefined) return reply.code(503).send({ error: '主站发送确认不可用' });

    const headers = { [protocol.KEY_HEADER]: bridge.key, 'content-type': 'application/json' };
    const body = JSON.stringify(posted);
    const signal = AbortSignal.timeout(110_000);
    const options = { method: 'POST', headers, body, signal, redirect: 'error' as const };
    const endpoint = bridge.callback + '/channel/approval';
    try {
      //M 主站从存账取原值并提交 P2，本进程只显示回执。
      const response = await fetch(endpoint, options);
      const result: unknown = await response.json();
      return reply.code(response.status).send(result);
    } catch {
      //G 任何异常都保留原意图供人查询，不生成本地批准。
      return reply.code(503).send({ error: '主站发送确认无回执，请按原意图核对' });
    }
  });
}

/** 仅已核验的客服页可让主站对当前监听会话起草，结果只写本地建议表。 */
function mountDraft(app: fastify.FastifyInstance, db: sqlite.Database, bridge?: Bridge): void {
  const busy = new Set<string>();
  const watchSql = 'SELECT name FROM wechat_watch WHERE account = ? AND chat = ?';
  const messagesSql = 'SELECT text, from_self, sender FROM wechat_messages'
    + " WHERE account = ? AND chat = ? AND text <> '' ORDER BY at DESC, local_id DESC LIMIT 50";
  const endpoint = `${API}/draft`;
  app.post(endpoint, { bodyLimit: 4096 }, async (request, reply) => {
    //G 独立实例没有主站模型回调。
    if (bridge === undefined) return reply.code(409).send({ error: '独立预览仅支持读取' });

    const given = request.headers[protocol.KEY_HEADER];
    //G 本机直连不带宿主密钥，也不能触发模型。
    const verified = protocol.isSameKey(bridge.key, given);
    if (!verified) return reply.code(401).send({ error: '起草需要经过主站' });
    if (!bridge.callback) return reply.code(503).send({ error: '主站起草不可用' });

    const input = request.body as { account?: unknown; chat?: unknown } | null | undefined;
    const account = input?.account;
    const chat = input?.chat;
    if (typeof account !== 'string' || account === '' || typeof chat !== 'string' || chat === '') {
      //G 缺目标时不查其它会话。
      return reply.code(400).send({ error: '请选择已监听的会话' });
    }
    //G 账号和会话必须精确命中同一条监听。
    const findWatch = db.query<{ name: string }, [string, string]>(watchSql);
    const watch = findWatch.get(account, chat);
    //G 普通归档会话不使用模型。
    if (watch === null) return reply.code(400).send({ error: '请先监听会话，再让 AI 起草建议' });

    const scope = JSON.stringify([account, chat]);
    //G 同一监听只允许一个在途模型请求。
    if (busy.has(scope)) return reply.code(409).send({ error: '这个会话正在起草' });

    //M 从原会话缓存读取有文本的消息。
    const findMessages = db.query<{ text: string; from_self: number; sender: string }, [string, string]>(messagesSql);
    const rows = findMessages.all(account, chat);
    //G 没有参考内容时不让模型猜测。
    if (rows.length === 0) return reply.code(409).send({ error: '当前会话暂无可参考的聊天文字' });

    //M 只带当前账号和会话最近 50 条可读文字，按时间正序提供给模型。
    const lines = rows.reverse().map((row) => {
      let speaker = String(row.sender ?? '').slice(0, 160) || '对方';
      if (row.from_self === 1) {
        speaker = '我方';
      }
      return speaker + '：' + row.text.slice(0, 1000);
    });
    const payload = { channel: bridge.channel, lines };
    const headers = { [protocol.KEY_HEADER]: bridge.key, 'content-type': 'application/json' };
    const body = JSON.stringify(payload);
    const signal = AbortSignal.timeout(65_000);
    const options = { method: 'POST', headers, body, signal, redirect: 'error' as const };
    const callback = bridge.callback + '/channel/draft';
    busy.add(scope);
    try {
      //M 结果是普通文本；程序既不生成批准，也不调用发送。
      const response = await fetch(callback, options);
      if (!response.ok) return reply.code(502).send({ error: '主站未能起草建议' });

      const suggestion = await response.json() as { text?: unknown };
      const text = suggestion?.text;
      //G 空回执不能成为一条建议。
      if (typeof text !== 'string' || text.trim() === '') return reply.code(502).send({ error: '主站未返回建议' });

      //G 模型返回时再查监听，期间已取消的会话不再写建议。
      const current = findWatch.get(account, chat);
      if (current === null) return reply.code(409).send({ error: '会话已停止监听' });

      const name = current.name || chat;
      const at = Date.now();
      const insert = 'INSERT INTO wechat_outbox (account,chat,name,text,state,note,at)'
        + " VALUES (?,?,?,?,'draft','',?) RETURNING id,account,chat,name,text,state";
      //M 唯一写入是本地草稿，保留完整建议给页面读取。
      const save = db.query(insert);
      return save.get(account, chat, name, text, at);
    } catch {
      //G 上游异常细节不带入浏览器。
      return reply.code(502).send({ error: '起草建议暂不可用' });
    } finally {
      busy.delete(scope);
    }
  });
}
