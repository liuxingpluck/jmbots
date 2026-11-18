/**
 * 客服页面的接口。（原：页面是 Page.ts 里的字符串、不进 web/ 打包；2026-11-14 起页面改为 React，在 web/wechat-kefu.html，由 web 插件挂在 /wechat-kefu/。）令牌由 http 统一查（本机免令牌）。
 *   GET  /wechat-kefu/                    客服页面：React 版由 web 插件托管（web/wechat-kefu.html）；旧路径 /wechat/ 在这里跳过去
 *   GET  /api/wechat-kefu/status               轮询状态、账号
 *   GET  /api/wechat-kefu/chats?account=       最近会话，带“监听”“自动发”两个开关
 *   PUT  /api/wechat-kefu/watch                { account, chat, name, watch, auto }
 *   GET  /api/wechat-kefu/messages?account=&chat=&limit=
 *   GET  /api/wechat-kefu/outbox               最近的发件
 *   POST /api/wechat-kefu/draft                { account, chat }：对已监听会话让 AI 起草一条回复，只存草稿不发送
 *   POST /api/wechat-kefu/send                 { account, chat, text }：页面上人手发，直接发
 *   POST /api/wechat-kefu/outbox/send          { id }：草稿、发失败的，人手点发送
 * 对应积木客服的 /api/accounts、/api/watch、/api/messages、/api/drafts*、/api/sender（jimukefu src/services/Api.ts、Drafts.ts:182-185）。
 */
import * as fs from 'node:fs';
import type { Database } from 'bun:sqlite';
import type { Http } from '../../http/index.ts';
import type { Wechat } from '../index.ts';


/** 请求体、查询里的一个字符串；没有是 ''。 */
//M 提取可读错误文本。
function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;

  return String(error);
}

function field(from: unknown, key: string): string {
  const value = (from as Record<string, unknown> | undefined)?.[key];
  if (typeof value === 'string') return value;

  return '';
}


/**
 * 在 http.app 上登记页面和接口。要在 ready（开始监听）之前调。
 * @param http HTTP 服务。
 * @param db 运行时数据库（wechat_* 表）。
 * @param wechat 微信渠道。
 * 副作用：登记客服页的读取、草稿和发送路由。
 */
export function routes(http: Http, db: Database, wechat: Wechat): void {
  const app = http.app;
  //M 2026-11-14 jm开发：页面改成 React（web/wechat-kefu.html，源码 web/src/WechatKefu/），由 web 插件按插件名挂在 /wechat-kefu/；
  //M   这里不再登记 /wechat-kefu、/wechat-kefu/（再登记会和 web 插件撞路由）。旧的字符串页面 Page.ts 已删（16:25 EST，备份在 cache/src7备份/20261114-1625EST-删Page和Assets/）。
  app.get('/wechat', (_request, reply) => reply.redirect('/wechat-kefu/'));
  app.get('/wechat/', (_request, reply) => reply.redirect('/wechat-kefu/'));

  //M 把轮询状态、微信账号和刷新周期一并交给客服页面。
  app.get('/api/wechat-kefu/status', () => ({ ...wechat.status, accounts: wechat.reader.accounts(), interval: wechat.config.intervalMs }));

  //M 提供账号的最近会话，供客服页展示监听和自动发送开关。
  app.get('/api/wechat-kefu/chats', async (request, reply) => {
    //M 定位所选账号并读取该账号的开关状态，稍后与会话列表合并。
    const account = field(request.query, 'account');
    const flags = db.query('SELECT chat, auto FROM wechat_watch WHERE account = ?').all(account) as { chat: string; auto: number }[];
    //M 2026-11-14 20:10：引擎失败时回 500 加一句脱敏的简短原因（Reader 已去掉人名、消息），不再是光秃秃的 Internal Server Error。
    let chats: Awaited<ReturnType<typeof wechat.reader.sessions>>;
    try {
      //M 2026-11-15 00:17 EST：chat_limit 默认 5000（用户实际约 1459 个，原先默认 1000 会截断）。
      chats = await wechat.reader.sessions(account, wechat.config.chatLimit);
    } catch (error) {
      return reply.code(500).send({ error: getErrorText(error) });
    }
    return chats.map((chat) => {
      const flag = flags.find((item) => item.chat === chat.username);
      return { ...chat, watch: flag !== undefined, auto: flag?.auto === 1 };
    });
  });

  app.put('/api/wechat-kefu/watch', (request) => {
    const body = request.body as Record<string, unknown>;
    //M 从请求确定开关归属的微信账号和会话。
    const account = field(body, 'account'), chat = field(body, 'chat');
    if (body['watch'] !== true) {
      //M 取消监听时移除名单记录，该会话后续不再按监听规则处理。
      db.query('DELETE FROM wechat_watch WHERE account = ? AND chat = ?').run(account, chat);
      return { ok: true };
    }
    let autoFlag = 0;
    if (body['auto'] === true) {
      autoFlag = 1;
    }

    //M 新增或更新监听项，保存展示名称和自动发送设置。
    db.query('INSERT INTO wechat_watch (account, chat, name, auto, last_time) VALUES (?, ?, ?, ?, NULL)'
      + ' ON CONFLICT (account, chat) DO UPDATE SET name = excluded.name, auto = excluded.auto')
      .run(account, chat, field(body, 'name') || chat, autoFlag);
    //M 勾上监听后，后台把这个会话的全部历史补进库（只存不交）；不阻塞这次保存开关。
    void wechat.fillWatched(account, chat, field(body, 'name') || chat);
    return { ok: true };
  });

  //M 客服页打开会话时取本地已保存的聊天记录。
  app.get('/api/wechat-kefu/messages', async (request, reply) => {
    //M 解析账号、会话及读取上限，限制该次查询的返回量。
    const limit = Math.min(Number(field(request.query, 'limit')) || 100, 5000);
    const account = field(request.query, 'account'), chat = field(request.query, 'chat');
    //M 2026-11-14 23:15 EST：点开一个后台还没轮到的会话，当场只读同步一次（最近 50 条存量），不用等后台。
    //M 2026-11-15 00:17 EST：已监听的会话再补全部历史（不阻塞这次读，下一轮刷新就能看到更早的）。
    const synced = db.query('SELECT full FROM wechat_sync WHERE account = ? AND chat = ?').get(account, chat) as { full: number | null } | null;
    if (synced === null && account !== '' && chat !== '') {
      try {
        await wechat.syncChats(account, [{ chat, name: field(request.query, 'name') || chat, since: null, at: 0 }]);
      } catch (error) {
        return reply.code(500).send({ error: getErrorText(error) });
      }
    }

    //M 查监听状态，只为仍在监听且未补全的会话安排历史补录。
    const watched = db.query('SELECT 1 FROM wechat_watch WHERE account = ? AND chat = ?').get(account, chat);
    if (watched !== null && (synced === null || synced.full !== 1) && account !== '' && chat !== '') {
      void wechat.backfillAll(account, chat);
    }

    //M 从库里取最新的限量消息，再按对话时间正序返回页面。
    const rows = db.query('SELECT * FROM wechat_messages WHERE account = ? AND chat = ? ORDER BY at DESC, local_id DESC LIMIT ?')
      .all(account, chat, limit);
    return rows.reverse();
  });

  //M 2026-11-14 23:30 EST：图片缩略图（只读解密，jimukefu /api/media/image 的做法）；只认库里有的这条消息，不拿任意 id 去扫微信目录。
  app.get('/api/wechat-kefu/image', async (request, reply) => {
    const account = field(request.query, 'account'), chat = field(request.query, 'chat'), source = field(request.query, 'source');
    const localId = Number(field(request.query, 'local_id'));
    const row = db.query("SELECT 1 FROM wechat_messages WHERE account = ? AND chat = ? AND source = ? AND local_id = ? AND kind = 'image'").get(account, chat, source, localId);
    if (row === null) return reply.code(404).send({ error: '没有这条图片消息' });
    try {
      const found = await wechat.reader.image(account, chat, source, localId);
      return reply.header('Cache-Control', 'private, max-age=86400').type(found.mime).send(fs.readFileSync(found.file));
    } catch (error) {
      return reply.code(404).send({ error: getErrorText(error) });
    }
  });

  //M 把最新发件和草稿提供给客服页的发件列表。
  app.get('/api/wechat-kefu/outbox', () => db.query('SELECT * FROM wechat_outbox ORDER BY id DESC LIMIT 100').all());

  //M 2026-11-15 00:17 EST：人手点“让 AI 回复”。只对已监听会话起草，结果进草稿栏，绝不发送。
  app.post('/api/wechat-kefu/draft', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const account = field(body, 'account'), chat = field(body, 'chat');
    try {
      const row = await wechat.draftReply(account, chat);
      if (row === null) return reply.code(502).send({ error: '模型没有生成回复' });
      return row;
    } catch (error) {
      const text = getErrorText(error);
      let code = 500;
      if (text.includes('请先勾选监听')) {
        code = 400;
      }
      //G 返回起草失败的原因，未开监听和服务错误使用不同状态码。
      return reply.code(code).send({ error: text });
    }
  });

  //M 接收客服手工输入的回复，送入统一的发件流程。
  app.post('/api/wechat-kefu/send', async (request, reply) => {
    const body = request.body;
    //M 提取回复目标和正文，供下方判断可否发送。
    const account = field(body, 'account'), chat = field(body, 'chat'), text = field(body, 'text').trim();

    //G 只允许向当前监听名单内的会话提交非空文本。
    const watch = db.query('SELECT name FROM wechat_watch WHERE account = ? AND chat = ?').get(account, chat) as { name: string } | null;
    if (watch === null || text === '') return reply.code(400).send({ error: '只能发给监听名单里的会话，内容不能空' });

    //M 建发件记录后按该记录发送，最终返回实际状态给客服页。
    const id = wechat.outbox({ account, chat, name: watch.name }, text, 'sending');
    await wechat.deliver(id);
    return db.query('SELECT * FROM wechat_outbox WHERE id = ?').get(id);
  });

  app.post('/api/wechat-kefu/outbox/send', async (request, reply) => {
    const id = Number((request.body as Record<string, unknown>)['id']);
    //G 只允许在客服页触发草稿、失败或已拒绝的发件。
    const item = db.query('SELECT state FROM wechat_outbox WHERE id = ?').get(id) as { state: string } | null;
    if (item === null || !['draft', 'failed', 'rejected'].includes(item.state)) return reply.code(400).send({ error: '只能发草稿、发失败、被拒的' });

    //M 交给共用的发送流程，并回查该条发件的最终状态。
    await wechat.deliver(id);
    return db.query('SELECT * FROM wechat_outbox WHERE id = ?').get(id);
  });
}
