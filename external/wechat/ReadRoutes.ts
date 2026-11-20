/**
 * 外置微信自包含的客服只读接口（`/api/wechat-kefu/{status,chats,messages,image,voice,outbox}`）。
 * 零跨目录引用 `src7/`，图片与语音均严格核对已在 `wechat_messages` 落库的四元组记录。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type * as sqlite from 'bun:sqlite';
import type * as fastify from 'fastify';
import * as readerModule from './read/PureReader.ts';
import * as storeModule from './read/Store.ts';
import type * as voiceModule from './read/VoiceCache.ts';


/** 供客服只读路由消费的服务接口。 */
export interface KefuReadSource {
  /** 纯 Bun 微信只读引擎（或其测试桩）。 */
  reader: Pick<readerModule.Reader, 'accounts' | 'sessions' | 'image'>;
  /** 轮询状态对象。 */
  status: Record<string, unknown>;
  /** 读取与轮询配置。 */
  config: { intervalMs: number; chatLimit: number };
  /** 打开会话时是否同步最新增量。 */
  syncOnRead?: boolean;
  /** 同步指定会话列表。 */
  syncChats?: (
    account: string,
    chats: Array<{ chat: string; name: string; since: number | null; at: number }>,
  ) => Promise<void>;
  /** 后台异步向前补录已监听会话历史。 */
  backfillAll?: (account: string, chat: string) => Promise<void>;
}


/**
 * 从查询对象中安全取出字符串字段。
 * @param from 查询参数对象。
 * @param key 字段名。
 */
function readStringField(from: unknown, key: string): string {
  const value = (from as Record<string, unknown> | undefined)?.[key];
  if (typeof value === 'string') return value;

  return '';
}


/**
 * 提取异常的可读文本（避免向客户端泄漏堆栈）。
 * @param error 捕获到的异常。
 */
function getSafeErrorText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;

  return '读取失败';
}


/**
 * 将媒体读取异常转换为 `{ error, code }` 固定响应体。
 * @param error 捕获到的异常。
 * @param fallback 未知异常时的默认提示文案。
 */
function toMediaErrorPayload(error: unknown, fallback: string): { error: string; code: string } {
  if (error instanceof readerModule.MediaUnavailable) {
    return { error: error.message, code: error.code };
  }
  return { error: fallback, code: 'unavailable' };
}


/**
 * 从数据库保存的气泡 JSON 中提取语音秒数；缺失或非法时返回 undefined。
 * @param viewJson `wechat_messages.view` 列文本。
 */
function parseVoiceSeconds(viewJson: string | null): number | undefined {
  if (!viewJson) return undefined;

  try {
    const parsed = JSON.parse(viewJson) as { seconds?: unknown } | null;
    const seconds = parsed?.seconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
      return seconds;
    }
  } catch {
    return undefined;
  }
  return undefined;
}


/**
 * 在 Fastify 实例上挂载客服页所需的会话、消息、图片、语音和发件箱只读路由。
 * @param app 外置微信 Fastify 实例。
 * @param db 本地 `wechat.db` 连接。
 * @param source 读取服务实例。
 * @param voice 语音解码与缓存器。
 */
export function mountReadRoutes(
  app: fastify.FastifyInstance,
  db: sqlite.Database,
  source: KefuReadSource,
  voice: voiceModule.VoiceAudio,
): void {
  const bootId = crypto.randomUUID().slice(0, 8);
  //M 初始化连接级临时修订触发器，支持带 version 参数的轻量轮询。
  storeModule.ensureMessageRevisionTriggers(db);

  //M 挂载轮询状态与已连接账号列表接口。
  app.get('/api/wechat-kefu/status', () => {
    //M 读取当前已连接微信账号摘要。
    const accounts = source.reader.accounts();
    return {
      ...source.status,
      accounts,
      interval: source.config.intervalMs,
    };
  });

  //M 挂载指定账号最近会话与监听标记接口。
  app.get('/api/wechat-kefu/chats', async (request, reply) => {
    const account = readStringField(request.query, 'account');
    let chats: readerModule.ChatItem[];
    try {
      //M 查询指定账号最近活跃会话。
      chats = await source.reader.sessions(account, source.config.chatLimit);
    } catch (error) {
      return reply.code(500).send({ error: getSafeErrorText(error) });
    }

    //M 叠加本地持久化的监听开关标记。
    const flags = db
      .query<{ chat: string; auto: number }, [string]>('SELECT chat, auto FROM wechat_watch WHERE account = ?')
      .all(account);
    const flagsByChat = new Map(flags.map((flag) => [flag.chat, flag]));
    return chats.map((chat) => {
      const flag = flagsByChat.get(chat.username);
      return { ...chat, watch: flag !== undefined, auto: flag?.auto === 1 };
    });
  });

  //M 挂载单会话消息列表查询接口（支持打开即时增量同步与版本号判变）。
  app.get('/api/wechat-kefu/messages', async (request, reply) => {
    const rawLimit = Number(readStringField(request.query, 'limit')) || 100;
    const limit = Math.min(Math.max(1, rawLimit), 5000);
    const account = readStringField(request.query, 'account');
    const chat = readStringField(request.query, 'chat');

    const synced = db
      .query<{ full: number | null; last_time: number | null }, [string, string]>(
        'SELECT full, last_time FROM wechat_sync WHERE account = ? AND chat = ?',
      )
      .get(account, chat);

    const shouldSyncNow = (synced === null || source.syncOnRead === true)
      && account !== ''
      && chat !== ''
      && source.syncChats !== undefined;
    if (shouldSyncNow) {
      try {
        //M 打开会话时按已知同步游标当场拉一次最新增量。
        const name = readStringField(request.query, 'name') || chat;
        const since = synced?.last_time ?? null;
        await source.syncChats!(account, [{ chat, name, since, at: 0 }]);
      } catch (error) {
        return reply.code(500).send({ error: getSafeErrorText(error) });
      }
    }

    const watched = db
      .query('SELECT 1 FROM wechat_watch WHERE account = ? AND chat = ?')
      .get(account, chat);
    if (watched !== null && (synced === null || synced.full !== 1) && account !== '' && chat !== '') {
      //M 已监听但尚未补齐全部历史的会话在后台继续补录，不阻塞当次返回。
      void source.backfillAll?.(account, chat);
    }

    const queryRecord = request.query as Record<string, unknown> | undefined;
    if (typeof queryRecord?.['version'] === 'string') {
      //M 计算会话窗口版本号，版本未变时直接回轻量 unchanged。
      const version = storeModule.getChatMessageVersion(db, bootId, account, chat, limit);
      const knownVersion = readStringField(request.query, 'version');
      if (knownVersion !== '' && knownVersion === version) {
        return { unchanged: true, version };
      }
      const rows = db
        .query('SELECT * FROM wechat_messages WHERE account = ? AND chat = ? ORDER BY at DESC, local_id DESC LIMIT ?')
        .all(account, chat, limit);
      return { unchanged: false, version, messages: rows.reverse() };
    }

    const rows = db
      .query('SELECT * FROM wechat_messages WHERE account = ? AND chat = ? ORDER BY at DESC, local_id DESC LIMIT ?')
      .all(account, chat, limit);
    return rows.reverse();
  });

  //M 挂载已落库图片消息的纯 Bun 解密缩略图接口。
  app.get('/api/wechat-kefu/image', async (request, reply) => {
    const account = readStringField(request.query, 'account');
    const chat = readStringField(request.query, 'chat');
    const sourceShard = readStringField(request.query, 'source');
    const localId = Number(readStringField(request.query, 'local_id'));
    const row = db
      .query("SELECT 1 FROM wechat_messages"
        + " WHERE account = ? AND chat = ? AND source = ? AND local_id = ? AND kind = 'image'")
      .get(account, chat, sourceShard, localId);
    if (row === null) {
      //G 拦截不在消息表或非图片类型的任意请求。
      return reply.code(404).send({ error: '没有这条图片消息' });
    }

    try {
      //M 仅对消息表已确认的图片记录执行纯 Bun .dat 解密。
      const found = await source.reader.image(account, chat, sourceShard, localId);
      return reply
        .header('Cache-Control', 'private, max-age=86400')
        .type(found.mime)
        .send(fs.readFileSync(found.file));
    } catch (error) {
      const payload = toMediaErrorPayload(error, '取不到图片：读取失败');
      return reply.code(404).header('Cache-Control', 'private, no-store').send(payload);
    }
  });

  //M 挂载已落库语音消息的纯 Bun 提取与 WAV 转码接口。
  app.get('/api/wechat-kefu/voice', async (request, reply) => {
    const account = readStringField(request.query, 'account');
    const chat = readStringField(request.query, 'chat');
    const sourceShard = readStringField(request.query, 'source');
    const rawId = readStringField(request.query, 'local_id');
    const localId = Number(rawId);
    if (!account || !chat || !sourceShard || !/^\d+$/u.test(rawId) || !Number.isSafeInteger(localId)) {
      //G 缺少四元组任一字段或非正整数消息号直接返回 400。
      return reply.code(400).send({ error: '语音消息编号不完整' });
    }

    const row = db
      .query<{ view: string | null }, [string, string, string, number]>(
        "SELECT view FROM wechat_messages"
          + " WHERE account = ? AND chat = ? AND source = ? AND local_id = ? AND kind = 'voice'",
      )
      .get(account, chat, sourceShard, localId);
    if (row === null) {
      //G 未命中已同步语音消息时拒绝访问媒体库。
      return reply.code(404).send({ error: '没有这条语音消息' });
    }

    try {
      //M 提取或复用已转码 WAV 并核对气泡时长。
      const expected = parseVoiceSeconds(row.view);
      const wav = await voice.get({ account, chat, source: sourceShard, localId }, expected);
      return reply.header('Cache-Control', 'private, no-store').type('audio/wav').send(wav);
    } catch (error) {
      const payload = toMediaErrorPayload(error, '读取微信语音失败');
      return reply.code(404).header('Cache-Control', 'private, no-store').send(payload);
    }
  });

  //M 挂载本地发件与草稿原始列表接口。
  app.get('/api/wechat-kefu/outbox', () => {
    //M 按自增编号倒序读取最近 100 条草稿记录。
    return db.query('SELECT * FROM wechat_outbox ORDER BY id DESC LIMIT 100').all();
  });
}
