/**
 * 微信语音纯 Bun 媒体库直提与 SILK -> WAV 内存解码：
 * 复用 P1 的 DbCache 与 bun:sqlite 从 media_N.db / biz_media_N.db 只读提取 SILK 字节，
 * 直接在内存交给 silk-wasm 解码成单声道 24kHz WAV，彻底免除 Python 子进程与临时 .silk 落盘。
 */
import * as sqlite from 'bun:sqlite';
import * as silk from 'silk-wasm';
import * as cacheModule from './DbCache.ts';


/** 微信 SILK v3 音频标准魔数头。 */
export const SILK_MAGIC = Buffer.from('#!SILK_V3', 'ascii');

/** 允许提取并送入解码器的最小语音字节数。 */
const MIN_SILK_BYTES = 10;

/** 允许提取并送入解码器的最大语音字节数（2 MiB）。 */
const MAX_SILK_BYTES = 2 * 1024 * 1024;

/** 输出 WAV 的固定采样率，单位 Hz。 */
const WAV_SAMPLE_RATE = 24_000;

/** 16 位单声道 PCM 每秒字节数。 */
const WAV_BYTE_RATE = WAV_SAMPLE_RATE * 2;

/** 单条语音允许解码的最大时长（120 秒），毫秒。 */
const MAX_VOICE_DURATION_MS = 120_000;

/** 允许产出的最大 PCM 字节数。 */
const MAX_PCM_BYTES = (WAV_BYTE_RATE * MAX_VOICE_DURATION_MS) / 1000;

/** 标准 RIFF PCM WAV 文件头长度，字节。 */
const WAV_HEADER_BYTES = 44;

/** 合法 SQLite 标识符正则（只允许字母、数字与下划线，杜绝动态表/列名注入）。 */
const SAFE_SQL_IDENT_RE = /^[A-Za-z0-9_]+$/u;

/** 媒体表候选二进制音频列名优先级。 */
const BLOB_COL_CANDIDATES = ['voice_data', 'voicedata', 'voicebuf', 'buf', 'data', 'reserved0', 'content'] as const;

/** 媒体表候选消息编号列名优先级。 */
const ID_COL_CANDIDATES = ['local_id', 'localid', 'msgid', 'msg_id', 'svrid', 'svr_id', 'id'] as const;

/** 媒体表候选会话归属列名优先级。 */
const CHAT_COL_CANDIDATES = [
  'talker', 'username', 'user_name', 'chat', 'fromuser', 'from_user', 'belong', 'belong_id', 'chat_name_id',
] as const;

/** 媒体表候选时长列名优先级。 */
const DURATION_COL_CANDIDATES = [
  'voicelength', 'voice_length', 'duration', 'length', 'seconds', 'playtime', 'play_time',
] as const;


/** 从媒体分片库提取出的原始语音结果。 */
export interface ExtractedVoice {
  /** 已归一化为 `#!SILK_V3` 开头的完整 SILK 音频字节。 */
  silk: Buffer;
  /** 媒体库记录的时长（单位毫秒，库中未记录时为 0）。 */
  durationMs: number;
}

/** 语音提取或解码失败时的结构化异常（错误码与客服页既有语音提示对齐）。 */
export class VoiceExtractError extends Error {
  /**
   * @param message 可直接回给页面的脱敏中文原因。
   * @param code 固定分类码（如 not_found / not_silk / duration_mismatch / silk_decode_failed）。
   */
  constructor(message: string, readonly code: string) {
    super(message);
  }
}


/**
 * 从 all_keys 映射中筛选全部语音媒体分片库相对路径（`media_*.db` 与 `biz_media_*.db`）。
 * @param allKeys 账号密钥表。
 */
export function findMediaDbKeys(allKeys: cacheModule.KeyTable): string[] {
  const matched = new Set<string>();
  for (const rawKey of Object.keys(allKeys)) {
    if (rawKey.startsWith('_')) {
      continue;
    }
    //M 归一化斜杠后匹配 media_*.db 或 biz_media_*.db。
    const normalized = cacheModule.normalizeDbRelPath(rawKey);
    if (normalized === undefined) {
      continue;
    }
    const baseName = normalized.split('/').pop()?.toLowerCase() ?? '';
    const isMediaDb = (
      (baseName.startsWith('media_') || baseName.startsWith('biz_media_'))
      && baseName.endsWith('.db')
    );
    if (isMediaDb) {
      matched.add(normalized);
    }
  }
  return [...matched].sort();
}


/**
 * 剥除微信语音记录常见的 `0x02` 或短长度前缀，还原以 `#!SILK_V3` 开头的标准流。
 * @param raw 数据库 BLOB 原始字节。
 * @returns 合法大小且以 `#!SILK_V3` 开头的 Buffer；非 SILK 或大小越界返回 undefined。
 */
export function normalizeSilkBytes(raw: Uint8Array): Buffer | undefined {
  if (raw.byteLength < MIN_SILK_BYTES || raw.byteLength > MAX_SILK_BYTES) return undefined;

  const buf = Buffer.from(raw);
  const pos = buf.indexOf(SILK_MAGIC);
  //G 魔数必须在开头或前 16 字节头部填充内，避免把偶然包含字面量的其它数据当语音。
  if (pos < 0 || pos > 16) return undefined;

  const sliced = buf.subarray(pos);
  if (sliced.byteLength < MIN_SILK_BYTES) return undefined;

  return Buffer.from(sliced);
}


/**
 * 读取媒体分库内可选的 Name2Id 表，找出目标会话 username 对应的整数编号（微信 4.x VoiceInfo 常存 chat_name_id）。
 * @param conn 已打开的媒体库只读连接。
 * @param chatUsername 目标会话 username。
 */
function findChatRowIds(conn: sqlite.Database, chatUsername: string): number[] {
  const ids: number[] = [];
  try {
    const sql = 'SELECT rowid FROM Name2Id WHERE user_name = ?';
    //M 查询 Name2Id 表把会话 username 映射为整数编号。
    const rows = conn.query<{ rowid: number }, [string]>(sql).all(chatUsername);
    for (const row of rows) {
      if (Number.isInteger(row.rowid)) {
        //M 收集匹配到的整数会话编号。
        ids.push(row.rowid);
      }
    }
  } catch {
    // 媒体分库不含 Name2Id 表时跳过整数会话号匹配。
  }
  return ids;
}


/**
 * 在单个已解密媒体库连接中检索匹配 `(chat, localId)` 的语音二进制记录。
 * 优先精确核对会话列（字符串 username 或 Name2Id 整数号），无会话列的表才单按 localId 匹配。
 * @param conn 已打开的媒体库只读连接。
 * @param chat 会话原始 username。
 * @param localId 分片内消息编号。
 */
function queryVoiceBlobInDb(
  conn: sqlite.Database,
  chat: string,
  localId: number,
): { blob: Uint8Array; durationMs: number } | undefined {
  let tableRows: { name: string }[];
  try {
    //M 读取当前媒体分库内的全部表名以定位语音表。
    tableRows = conn.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  } catch {
    return undefined;
  }

  //M 先尝试解析 Name2Id 里的整数会话编号，兼容 chat_name_id 整数列。
  const chatRowIds = findChatRowIds(conn, chat);

  for (const tableEntry of tableRows) {
    const table = tableEntry.name;
    if (!SAFE_SQL_IDENT_RE.test(table)) {
      continue;
    }
    const lowerTable = table.toLowerCase();
    const isVoiceTable = (
      lowerTable.includes('voice')
      || lowerTable === 'media'
      || lowerTable === 'mediamessage'
    );
    if (!isVoiceTable) {
      continue;
    }

    const colRows = conn
      .query<{ name: string; type: string | null }, []>(`PRAGMA table_info([${table}])`)
      .all();
    const lowerToActual = new Map<string, string>();
    const lowerToType = new Map<string, string>();
    for (const col of colRows) {
      if (!SAFE_SQL_IDENT_RE.test(col.name)) {
        continue;
      }
      const low = col.name.toLowerCase();
      lowerToActual.set(low, col.name);
      lowerToType.set(low, (col.type ?? '').toLowerCase());
    }

    //M 选出语音二进制列、编号列、会话归属列与可选时长列。
    let blobCol: string | undefined;
    for (const cand of BLOB_COL_CANDIDATES) {
      const actual = lowerToActual.get(cand);
      const colType = lowerToType.get(cand) ?? '';
      const isBlobLike = colType === 'blob' || colType === '' || cand.includes('data') || cand.includes('buf');
      if (actual !== undefined && isBlobLike) {
        blobCol = actual;
        break;
      }
    }
    if (blobCol === undefined) {
      for (const col of colRows) {
        if (SAFE_SQL_IDENT_RE.test(col.name) && (col.type ?? '').toLowerCase() === 'blob') {
          blobCol = col.name;
          break;
        }
      }
    }
    if (blobCol === undefined) {
      continue;
    }

    const idCols = ID_COL_CANDIDATES
      .map((cand) => lowerToActual.get(cand))
      .filter((col): col is string => col !== undefined);
    if (idCols.length === 0) {
      continue;
    }

    const chatCols = CHAT_COL_CANDIDATES
      .map((cand) => lowerToActual.get(cand))
      .filter((col): col is string => col !== undefined);

    let durCol: string | undefined;
    for (const cand of DURATION_COL_CANDIDATES) {
      const actual = lowerToActual.get(cand);
      if (actual !== undefined) {
        durCol = actual;
        break;
      }
    }

    let selectExpr = `[${blobCol}] AS voice_blob`;
    if (durCol !== undefined) {
      selectExpr += `, [${durCol}] AS voice_dur`;
    }

    //M 构造查询计划：有会话列时先带会话约束（字符串与 Name2Id 整数），无会话列时按编号查。
    const plans: Array<{ sql: string; params: Array<string | number> }> = [];
    for (const idCol of idCols) {
      for (const chatCol of chatCols) {
        plans.push({
          sql: `SELECT ${selectExpr} FROM [${table}] WHERE [${idCol}] = ? AND [${chatCol}] = ? LIMIT 5`,
          params: [localId, chat],
        });
        for (const rowId of chatRowIds) {
          plans.push({
            sql: `SELECT ${selectExpr} FROM [${table}] WHERE [${idCol}] = ? AND [${chatCol}] = ? LIMIT 5`,
            params: [localId, rowId],
          });
        }
      }
      if (chatCols.length === 0) {
        //M 无会话归属列的旧媒体表退回单按消息本地编号检索。
        plans.push({
          sql: `SELECT ${selectExpr} FROM [${table}] WHERE [${idCol}] = ? LIMIT 5`,
          params: [localId],
        });
      }
    }

    for (const plan of plans) {
      let rows: Array<{ voice_blob: Uint8Array | null; voice_dur?: number | null }>;
      try {
        rows = conn
          .query<{ voice_blob: Uint8Array | null; voice_dur?: number | null }, Array<string | number>>(plan.sql)
          .all(...plan.params);
      } catch {
        continue;
      }
      for (const row of rows) {
        if (row.voice_blob instanceof Uint8Array && row.voice_blob.byteLength >= MIN_SILK_BYTES) {
          let durationMs = 0;
          if (typeof row.voice_dur === 'number' && Number.isFinite(row.voice_dur) && row.voice_dur > 0) {
            durationMs = Math.trunc(row.voice_dur);
          }
          return { blob: row.voice_blob, durationMs };
        }
      }
    }
  }
  return undefined;
}


/**
 * 遍历全部已解密媒体分片库，提取一条语音的归一化 SILK 字节。
 * @param cache P1 的增量解密缓存。
 * @param allKeys 账号密钥表。
 * @param chat 会话原始 username。
 * @param localId 分片本地消息号。
 * @returns 归一化后的 SILK 与时长；未保存原音频时抛 `not_found`，非 SILK 格式时抛 `not_silk`。
 */
export function extractVoiceSilk(
  cache: cacheModule.DbCache,
  allKeys: cacheModule.KeyTable,
  chat: string,
  localId: number,
): ExtractedVoice {
  //M 找出全部媒体分片键并逐库只读检索。
  const mediaKeys = findMediaDbKeys(allKeys);
  for (const relKey of mediaKeys) {
    //M 刷新或复用该媒体分片库的明文副本。
    const replicaPath = cache.getDecryptedPath(relKey);
    if (replicaPath === undefined) {
      continue;
    }

    let hit: { blob: Uint8Array; durationMs: number } | undefined;
    const conn = new sqlite.Database(replicaPath, { readonly: true });
    try {
      //M 在单分片内按会话与消息号定位语音 BLOB。
      hit = queryVoiceBlobInDb(conn, chat, localId);
    } finally {
      conn.close();
    }
    if (hit === undefined) {
      continue;
    }

    //M 校验并剥除前缀还原标准 SILK 流。
    const normalized = normalizeSilkBytes(hit.blob);
    if (normalized === undefined) {
      throw new VoiceExtractError('原音频格式无法解码', 'not_silk');
    }
    return { silk: normalized, durationMs: hit.durationMs };
  }

  throw new VoiceExtractError('微信未保存原音频', 'not_found');
}


/**
 * 为无标准 `0xffff` 结束帧的腾讯变体 SILK 流补回 `0x02` 前缀字节，供 silk-wasm 识别边界。
 * @param input 以 `#!SILK_V3` 开头的字节流。
 */
function buildSilkDecoderInput(input: Uint8Array): Uint8Array {
  if (input[0] === 2) return input;

  for (let offset = SILK_MAGIC.byteLength; offset + 1 < input.byteLength;) {
    const frameBytes = input[offset]! + input[offset + 1]! * 256;
    if (frameBytes === 0xffff) return input;

    offset += 2 + frameBytes;
  }
  const prefixed = new Uint8Array(input.byteLength + 1);
  prefixed[0] = 2;
  prefixed.set(input, 1);
  return prefixed;
}


/**
 * 将已提取的 SILK 音频解码为 24kHz 单声道 16-bit PCM WAV，并核对与聊天记录一致的秒数余量（1 秒内）。
 * @param silkInput 完整的 SILK 字节。
 * @param expectedSeconds 可选的气泡记录时长（秒）。
 */
export async function decodeSilkToWav(silkInput: Uint8Array, expectedSeconds?: number): Promise<Buffer> {
  //G 交给 WASM 前先核对 SILK 签名与总时长上限。
  if (!silk.isSilk(silkInput)) {
    throw new VoiceExtractError('原音频格式无法解码', 'not_silk');
  }
  const durationMs = silk.getDuration(silkInput);
  if (durationMs <= 0 || durationMs > MAX_VOICE_DURATION_MS) {
    throw new VoiceExtractError('原音频时长异常', 'invalid_duration');
  }

  let pcm: Uint8Array;
  try {
    //M 适配腾讯流头后调用 silk-wasm 解码 24kHz PCM。
    const decoderInput = buildSilkDecoderInput(silkInput);
    const decoded = await silk.decode(decoderInput, WAV_SAMPLE_RATE);
    pcm = decoded.data;
  } catch {
    throw new VoiceExtractError('SILK 解码失败', 'silk_decode_failed');
  }

  if (pcm.byteLength === 0 || pcm.byteLength > MAX_PCM_BYTES || pcm.byteLength % 2 !== 0) {
    throw new VoiceExtractError('原音频解码后数据不完整', 'invalid_pcm');
  }

  //G 聊天记录明确带有时长时，禁止把时长偏差超过 1 秒的错位音频回给页面。
  if (expectedSeconds !== undefined) {
    const actualSeconds = pcm.byteLength / WAV_BYTE_RATE;
    if (Math.abs(actualSeconds - expectedSeconds) > 1) {
      throw new VoiceExtractError('音频时长与聊天记录不符', 'duration_mismatch');
    }
  }

  //M 封装 44 字节标准 RIFF WAVEfmt 头并拷入单声道 PCM 样本。
  const wav = Buffer.allocUnsafe(WAV_HEADER_BYTES + pcm.byteLength);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.byteLength - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(WAV_SAMPLE_RATE, 24);
  wav.writeUInt32LE(WAV_BYTE_RATE, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.byteLength, 40);
  wav.set(pcm, WAV_HEADER_BYTES);
  return wav;
}


/**
 * 一步从加密媒体分片库直提语音并在内存解码为 WAV（零 Python、零临时文件）。
 * @param cache P1 的增量解密缓存。
 * @param allKeys 账号密钥表。
 * @param chat 会话原始 username。
 * @param localId 分片本地消息号。
 * @param expectedSeconds 可选的气泡记录时长（秒）。
 */
export async function extractVoiceWav(
  cache: cacheModule.DbCache,
  allKeys: cacheModule.KeyTable,
  chat: string,
  localId: number,
  expectedSeconds?: number,
): Promise<Buffer> {
  //M 先从媒体库提取 SILK 字节，再在内存直接转成 WAV。
  const extracted = extractVoiceSilk(cache, allKeys, chat, localId);
  return await decodeSilkToWav(extracted.silk, expectedSeconds);
}
