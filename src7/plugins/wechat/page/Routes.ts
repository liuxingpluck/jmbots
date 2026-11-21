/**
 * 客服页面的接口。（原：页面是 Page.ts 里的字符串、不进 web/ 打包；2026-11-14 起页面改为 React，
 * 在 web/wechat-kefu.html，由 http 的 Static.ts 挂在 /wechat-kefu/。）令牌由 http 统一查（本机免令牌）。
 *   GET  /wechat-kefu/                    客服页面：React 版由 http 的 Static.ts 托管（web/wechat-kefu.html）；旧路径 /wechat/ 在这里跳过去
 *   GET  /api/wechat-kefu/status               轮询状态、账号
 *   GET  /api/wechat-kefu/chats?account=       最近会话与监听配置，fresh=1 强制扫描
 *   PUT  /api/wechat-kefu/watch                { account, chat, name, watch, auto }
 *   GET  /api/wechat-kefu/messages?account=&chat=&limit=
 *   GET  /api/wechat-kefu/voice?account=&chat=&source=&local_id=  原语音 WAV
 *   GET  /api/wechat-kefu/outbox               最近的发件
 *   POST /api/wechat-kefu/draft                { account, chat }：对已监听会话让 AI 起草一条回复，只存草稿不发送
 *   POST /api/wechat-kefu/send                 { account, chat, text }：页面上人手发，直接发
 *   POST /api/wechat-kefu/outbox/send          { id }：草稿、发失败的，人手点发送
 * 对应积木客服的 /api/accounts、/api/watch、/api/messages、/api/drafts*、/api/sender
 * （jimukefu src/services/Api.ts、Drafts.ts:182-185）。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type * as fastify from 'fastify';
import type { Database } from 'bun:sqlite';
import * as textModule from '../../../utils/Text.ts';
import type { Http } from '../../http/index.ts';
import type { Wechat } from '../index.ts';
import * as readerModule from '../read/Reader.ts';
import * as storeModule from '../read/Store.ts';
import type * as voiceModule from '../read/Voice.ts';


/** 客服页收到固定原因和错误码，文件系统或引擎的原始错误只在内部使用。 */
function getMediaError(error: unknown, fallback: string): { error: string; code: string } {
  if (error instanceof readerModule.MediaUnavailable) {
    return { error: error.message, code: error.code };
  }
  return { error: fallback, code: 'unavailable' };
}

function field(from: unknown, key: string): string {
  const value = (from as Record<string, unknown> | undefined)?.[key];
  if (typeof value === 'string') return value;

  return '';
}

/** 读取历史气泡中的语音秒数，旧库空值表示未知。 */
function getVoiceSeconds(view: string | null): number | undefined {
  if (!view) return undefined;

  try {
    const parsed = JSON.parse(view) as { seconds?: unknown } | null;
    const seconds = parsed?.seconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) return seconds;
  } catch {
    //M 旧消息偶尔缺气泡数据，播放时以浏览器测到的时长显示。
    return undefined;
  }
  return undefined;
}

/** 内置渠道和独立进程共用的客服读取能力。 */
type ReadSource = Pick<Wechat, 'reader' | 'status' | 'syncChats'> & {
  /** 给客服页的刷新周期和会话数量上限。 */
  config: Pick<Wechat['config'], 'intervalMs' | 'chatLimit'>;
  /** 内置渠道复用后台最新的会话列表。 */
  getPageChats?: Wechat['getPageChats'];
  /** 独立进程打开会话时按读取进度刷新增量。 */
  syncOnRead?: boolean;
  /** 内置渠道为监听中的会话继续补录历史。 */
  backfillAll?: Wechat['backfillAll'];
};

/**
 * 挂载客服聊天、图片、语音和本地发件箱的读取接口。
 * @param app 当前进程的 Fastify 路由。
 * @param db 微信消息库。
 * @param wechat 提供会话读取和同步。
 * @param voice 音频提取及缓存。
 */
export function readRoutes(
  app: fastify.FastifyInstance, db: Database, wechat: ReadSource, voice: voiceModule.VoiceAudio,
): void {
  //M 为当前路由实例生成进程代次并确保会话消息修订触发器就绪，供轮询轻量判变。
  const bootId = crypto.randomUUID().slice(0, 8);
  storeModule.ensureMessageRevisionTriggers(db);

  //M 把轮询状态、微信账号和刷新周期一并交给客服页面。
  app.get('/api/wechat-kefu/status', () => ({
    ...wechat.status, accounts: wechat.reader.accounts(), interval: wechat.config.intervalMs,
  }));

  //M 提供账号的最近会话及监听配置。
  app.get('/api/wechat-kefu/chats', async (request, reply) => {
    const account = field(request.query, 'account');
    const fresh = field(request.query, 'fresh') === '1';
    let chats: Awaited<ReturnType<typeof wechat.reader.sessions>>;
    try {
      //M 内置页能复用后台扫描，其他调用方仍直接读引擎。
      const read = wechat.getPageChats?.(account, fresh);
      const limit = wechat.config.chatLimit;
      chats = await (read ?? wechat.reader.sessions(account, limit));
    } catch (error) {
      //G 保留引擎提供的简短错误。
      const reason = textModule.getErrorMessage(error);
      return reply.code(500).send({ error: reason });
    }

    //M 会话缓存不包含开关，仍以数据库当前的监听配置为准。
    const query = db.query('SELECT chat, auto FROM wechat_watch WHERE account = ?');
    const flags = query.all(account) as { chat: string; auto: number }[];
    const flagsByChat = new Map(flags.map((flag) => [flag.chat, flag]));
    return chats.map((chat) => {
      const flag = flagsByChat.get(chat.username);
      return { ...chat, watch: flag !== undefined, auto: flag?.auto === 1 };
    });
  });

  //M 客服页打开会话时取本地已保存的聊天记录。
  app.get('/api/wechat-kefu/messages', async (request, reply) => {
    //M 解析账号、会话及读取上限，限制该次查询的返回量。
    const limit = Math.min(Number(field(request.query, 'limit')) || 100, 5000);
    const account = field(request.query, 'account'), chat = field(request.query, 'chat');
    //M 2026-11-14 23:15 EST：点开一个后台还没轮到的会话，当场只读同步一次（最近 50 条存量），不用等后台。
    //M 2026-11-15 00:17 EST：已监听的会话再补全部历史（不阻塞这次读，下一轮刷新就能看到更早的）。
    const synced = db
      .query('SELECT full, last_time FROM wechat_sync WHERE account = ? AND chat = ?')
      .get(account, chat) as { full: number | null; last_time: number | null } | null;
    if ((synced === null || wechat.syncOnRead === true) && account !== '' && chat !== '') {
      try {
        //M 独立进程按上次同步位置继续读，内置渠道首次打开才走这里。
        const name = field(request.query, 'name') || chat;
        const since = synced?.last_time ?? null;
        const conversations = [{ chat, name, since, at: 0 }];
        await wechat.syncChats(account, conversations);
      } catch (error) {
        return reply.code(500).send({ error: textModule.getErrorMessage(error) });
      }
    }

    //M 查监听状态，只为仍在监听且未补全的会话安排历史补录。
    const watched = db.query('SELECT 1 FROM wechat_watch WHERE account = ? AND chat = ?').get(account, chat);
    if (watched !== null && (synced === null || synced.full !== 1) && account !== '' && chat !== '') {
      void wechat.backfillAll?.(account, chat);
    }

    //M 带 version 参数的轮询先比对会话窗口版本号，未变化时直接回轻量标记，免每 3 秒查表重传千条正文。
    const queryRecord = request.query as Record<string, unknown> | undefined;
    const hasVersion = typeof queryRecord?.['version'] === 'string';
    if (hasVersion) {
      const version = storeModule.getChatMessageVersion(db, bootId, account, chat, limit);
      const knownVersion = field(request.query, 'version');
      if (knownVersion !== '' && knownVersion === version) return { unchanged: true, version };

      const rows = db
        .query('SELECT * FROM wechat_messages WHERE account = ? AND chat = ? ORDER BY at DESC, local_id DESC LIMIT ?')
        .all(account, chat, limit);
      return { unchanged: false, version, messages: rows.reverse() };
    }

    //M 未传 version 的调用方保持原样返回消息数组（兼容外置页与直接调用）。
    const rows = db
      .query('SELECT * FROM wechat_messages WHERE account = ? AND chat = ? ORDER BY at DESC, local_id DESC LIMIT ?')
      .all(account, chat, limit);
    return rows.reverse();
  });

  //M 2026-11-14 23:30 EST：图片缩略图（只读解密，jimukefu /api/media/image 的做法）；只认库里有的这条消息，不拿任意 id 去扫微信目录。
  app.get('/api/wechat-kefu/image', async (request, reply) => {
    const account = field(request.query, 'account'), chat = field(request.query, 'chat'),
      source = field(request.query, 'source');
    const localId = Number(field(request.query, 'local_id'));
    const row = db
      .query("SELECT 1 FROM wechat_messages"
        + " WHERE account = ? AND chat = ? AND source = ? AND local_id = ? AND kind = 'image'")
      .get(account, chat, source, localId);
    if (row === null) return reply.code(404).send({ error: '没有这条图片消息' });
    try {
      const found = await wechat.reader.image(account, chat, source, localId);
      return reply.header('Cache-Control', 'private, max-age=86400').type(found.mime).send(fs.readFileSync(found.file));
    } catch (error) {
      //M 报具体缺件原因，短时失败缓存过去后仍能重试。
      const result = getMediaError(error, '取不到图片：读取失败');
      return reply.code(404).header('Cache-Control', 'private, no-store').send(result);
    }
  });

  //M 只为消息库中完整匹配的语音取文件，挂在与客服页相同的令牌保护下。
  app.get('/api/wechat-kefu/voice', async (request, reply) => {
    const account = field(request.query, 'account');
    const chat = field(request.query, 'chat');
    const source = field(request.query, 'source');
    const rawId = field(request.query, 'local_id');
    const localId = Number(rawId);
    if (!account || !chat || !source || !/^\d+$/u.test(rawId) || !Number.isSafeInteger(localId)) {
      return reply.code(400).send({ error: '语音消息编号不完整' });
    }

    //G 账号、会话和来源须同时匹配，禁止使用只在另一会话出现的消息号。
    const sql = 'SELECT view FROM wechat_messages'
      + " WHERE account = ? AND chat = ? AND source = ? AND local_id = ? AND kind = 'voice'";
    const row = db.query(sql).get(account, chat, source, localId) as { view: string | null } | null;
    if (row === null) return reply.code(404).send({ error: '没有这条语音消息' });

    const message = { account, chat, source, localId };
    try {
      //M 用完整消息键提取或复用解码后的 WAV，给浏览器流式播放器使用。
      const expected = getVoiceSeconds(row.view);
      const wav = await voice.get(message, expected);
      return reply.header('Cache-Control', 'private, no-store').type('audio/wav').send(wav);
    } catch (error) {
      //M 留下可读的缺件原因，内部错误或路径保持在服务端。
      const result = getMediaError(error, '读取微信语音失败');
      return reply.code(404).header('Cache-Control', 'private, no-store').send(result);
    }
  });

  //M 把最新发件和草稿提供给客服页的发件列表。
  app.get('/api/wechat-kefu/outbox', () => db.query('SELECT * FROM wechat_outbox ORDER BY id DESC LIMIT 100').all());
}

/**
 * 在 http.app 上登记页面和接口。要在 ready（开始监听）之前调。
 * @param http HTTP 服务。
 * @param db 运行时数据库（wechat_* 表）。
 * @param wechat 微信渠道。
 * @param voice 提取及缓存语音的实例。
 * 副作用：登记客服页的读取、草稿和发送路由。
 */
export function routes(http: Http, db: Database, wechat: Wechat, voice: voiceModule.VoiceAudio): void {
  const app = http.app;
  //M 2026-11-14 jm开发：页面改成 React（web/wechat-kefu.html，源码 web/src/WechatKefu/），由 http 的 Static.ts 按插件名挂在 /wechat-kefu/；
  //M   这里不再登记 /wechat-kefu、/wechat-kefu/（再登记会撞路由）。旧的字符串页面 Page.ts 已删
  //M   （16:25 EST，备份在 cache/src7备份/20261114-1625EST-删Page和Assets/）。
  app.get('/wechat', (_request, reply) => reply.redirect('/wechat-kefu/'));
  app.get('/wechat/', (_request, reply) => reply.redirect('/wechat-kefu/'));

  //M 读会话、图片与语音用和独立进程同一组入口。
  readRoutes(app, db, wechat, voice);

  //M 保存客服页为单个会话选择的监听状态。
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

  //M 2026-11-15 00:17 EST：人手点“让 AI 回复”。只对已监听会话起草，结果进草稿栏，不直接发送。
  app.post('/api/wechat-kefu/draft', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const account = field(body, 'account'), chat = field(body, 'chat');
    try {
      const row = await wechat.draftReply(account, chat);
      if (row === null) return reply.code(502).send({ error: '模型没有生成回复' });
      return row;
    } catch (error) {
      const text = textModule.getErrorMessage(error);
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
    const watch = db
      .query('SELECT name FROM wechat_watch WHERE account = ? AND chat = ?')
      .get(account, chat) as { name: string } | null;
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
    if (item === null || !['draft', 'failed', 'rejected'].includes(item.state)) {
      return reply.code(400).send({ error: '只能发草稿、发失败、被拒的' });
    }

    //M 交给共用的发送流程，并回查该条发件的最终状态。
    await wechat.deliver(id);
    return db.query('SELECT * FROM wechat_outbox WHERE id = ?').get(id);
  });
}
