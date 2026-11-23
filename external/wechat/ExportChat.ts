/**
 * 微信单会话与多会话授权批量本地导出模块（`export-chat` / `export-batch`）：
 * 仅由命令行显式传参触发（AI 不可经 HTTP 或后台轮询静默调用），默认导出最近 30 天（`--since-days 30`）、
 * 按天分卷（`--chunk-by day` → `YYYY-MM-DD.md`）并按单卷 100K Token 上限自动无损拆分为 `_part2.md`；
 * 将命中的图片/语音/文件安全复制至相对目录 `./media/`，全程执行落盘前宿主机绝对路径零泄漏自检。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readerModule from './read/PureReader.ts';
import * as storeModule from './read/Store.ts';
import * as voiceModule from './read/VoiceCache.ts';


/** 默认导出的最近消息条数上限（配合默认 30 天时间窗，兼顾活跃大群完整覆盖与内存安全）。 */
export const DEFAULT_EXPORT_LIMIT = 50_000;

/** 允许导出的单次最大消息条数上限。 */
export const MAX_EXPORT_LIMIT = 500_000;

/** 默认导出的最近天数窗口（30 天 = 最近 1 个月；传 `0` 表示导出全部历史）。 */
export const DEFAULT_SINCE_DAYS = 30;

/** 默认分卷模式（按天生成 `YYYY-MM-DD.md`）。 */
export const DEFAULT_CHUNK_BY = 'day' as const;

/** 默认单篇 Markdown 最大估算 Token 上限（100K；传 `0` 表示不限制）。 */
export const DEFAULT_MAX_TOKENS = 100_000;

/** 默认单个媒体/附件最大允许复制体积上限（100 MB；传 `0` 表示不限制）。 */
export const DEFAULT_MAX_FILE_MB = 100;

/** 按条数拆分子目录（`--chunk-by count`）时的默认每卷条数。 */
export const DEFAULT_CHUNK_SIZE = 1000;

/** 默认媒体相对目录名。 */
export const DEFAULT_MEDIA_DIR = 'media';

/** 支持的分卷拆分模式枚举。 */
export type ChunkMode = 'none' | 'day' | 'month' | 'count';

/** Windows 保留设备名正则（不区分大小写）。 */
const WIN_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

/**
 * 检测结构化区域疑似宿主机绝对路径的脱敏自检正则：
 * 盘符路径必须带非标识符前边界（防止把 `https://` / `http://` / `mailto:` 误判为 `s:/` 或 `p:/`），
 * 同时拦截 UNC 路径与常见系统用户根路径。
 */
const LEAKED_ABS_PATH_RE = new RegExp(
  '(?:(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\\\/]|\\\\\\\\[A-Za-z0-9_.-]+[\\\\/]'
  + '|(?:^|[\\s"\'`(])\\/(?:home|Users|root|tmp|var|etc|mnt|proc)\\/)',
  'u',
);


/** 入口校验通过后的单会话导出配置（内部直接使用，不再补默认值）。 */
export interface ValidatedExportOptions {
  /** 外置微信数据目录绝对路径（全程只读）。 */
  dataDir: string;
  /** 兼容旧引擎目录绝对路径。 */
  engineDir: string;
  /** 解密副本与语音转码缓存根目录绝对路径（默认指向系统临时目录，不往 `--data` 写文件）。 */
  cacheDir: string;
  /** 可选显式指定的微信账号 ID、昵称或 wxid。 */
  account?: string;
  /** 目标会话名称或原始 wxid。 */
  chat: string;
  /** 导出目标根目录绝对路径。 */
  outDir: string;
  /** 最近 N 条消息上限。 */
  limit: number;
  /** 最近 N 天时间窗口（`0` 表示不限时间导出全部历史）。 */
  sinceDays: number;
  /** 分卷模式：`none` 单文件、`day` 按天 `YYYY-MM-DD.md`、`month` 按月子目录、`count` 按固定条数子目录。 */
  chunkBy: ChunkMode;
  /** `chunkBy === 'count'` 时每个分卷的条数上限。 */
  chunkSize: number;
  /** 单篇 Markdown 最大估算 Token 上限（`0` 表示不限制）。 */
  maxTokens: number;
  /** 单个媒体/附件最大复制体积上限（MB，`0` 表示不限制）。 */
  maxFileMb: number;
  /** 归一化后的相对媒体子目录路径（正斜杠，不含前导 `./`，如 `media`）。 */
  mediaDir: string;
  /** 额外群提及昵称字符串。 */
  atNames: string;
  /** 是否仅输出纯 JSON。 */
  json?: boolean;
  /** 可选参考当前毫秒时间戳（供离线单测固定时间窗，生产默认 `Date.now()`）。 */
  nowMs?: number;
}

/** 入口校验通过后的多会话批量导出配置（`export-batch`）。 */
export interface ValidatedBatchExportOptions {
  /** 外置微信数据目录绝对路径（全程只读）。 */
  dataDir: string;
  /** 兼容旧引擎目录绝对路径。 */
  engineDir: string;
  /** 解密副本与语音转码缓存根目录绝对路径（默认指向系统临时目录，不往 `--data` 写文件）。 */
  cacheDir: string;
  /** 可选显式指定的微信账号 ID、昵称或 wxid。 */
  account?: string;
  /** 显式指定的会话名称/wxid 列表（`all === false` 时非空）。 */
  chats: string[];
  /** 是否导出该账号下全部会话。 */
  all: boolean;
  /** `--all` 模式下可选会话类型过滤。 */
  typeFilter: 'all' | 'p2p' | 'group';
  /** `--all` 模式下是否仅导出置顶会话。 */
  pinnedOnly: boolean;
  /** 导出根目录绝对路径（内部自动按 `私聊/<安全显示名_唯一ID>/` 与 `群聊/<安全群名_唯一ID>/` 落盘）。 */
  outDir: string;
  /** 是否在 `<out>` 下额外嵌套一层 `<安全昵称>_<accountId>/` 账号目录（多微信号归档隔离）。 */
  withAccountDir: boolean;
  /** 每个会话导出的最大消息条数上限。 */
  limit: number;
  /** 最近 N 天时间窗口（默认 30，`0` 表示全部历史）。 */
  sinceDays: number;
  /** 分卷模式（默认 `day`）。 */
  chunkBy: ChunkMode;
  /** `chunkBy === 'count'` 时的每卷条数。 */
  chunkSize: number;
  /** 单篇 Markdown 最大估算 Token 上限（默认 `100000`，`0` 不限制）。 */
  maxTokens: number;
  /** 单个媒体/附件最大复制体积上限（默认 `100` MB，`0` 不限制）。 */
  maxFileMb: number;
  /** 相对媒体子目录名（默认 `media`）。 */
  mediaDir: string;
  /** 额外群提及昵称字符串。 */
  atNames: string;
  /** 是否仅输出纯 JSON。 */
  json: boolean;
  /** 可选参考当前毫秒时间戳（供离线单测固定时间窗）。 */
  nowMs?: number;
}

/** 单个导出分卷在 `manifest.json` 中的索引条目。 */
export interface ExportChunkEntry {
  /** 分卷标识（如 `all`、`2026-11-21`、`2026-11-21_part2`、`2026-11`、`part-001`）。 */
  id: string;
  /** 相对 `<out>` 根目录的正斜杠文件路径（如 `./2026-11-21.md`、`./messages.md` 或 `./2026-11/messages.md`）。 */
  file: string;
  /** 本分卷包含的消息条数。 */
  count: number;
  /** 本分卷全文的确定性估算 Token 数。 */
  estimatedTokens: number;
  /** 本分卷首条消息时间（ISO 8601）。 */
  startIso: string | null;
  /** 本分卷末条消息时间（ISO 8601）。 */
  endIso: string | null;
}

/** 导出脱敏与路径安全自检报告。 */
export interface RedactionCheckReport {
  /** 是否全部通过零绝对路径泄漏校验。 */
  passed: boolean;
  /** 本次扫描核验的输出文本文件数。 */
  checkedFiles: number;
  /** 检出的宿主机绝对路径泄漏次数（通过时必为 0）。 */
  leakedAbsolutePaths: number;
}

/** 写入 `<out>/manifest.json` 的完整单会话导出清单结构。 */
export interface ExportManifest {
  /** 清单结构版本号。 */
  schemaVersion: 1;
  /** 导出完成时刻（ISO 8601）。 */
  exportedAt: string;
  /** 导出完成时刻（Unix 毫秒）。 */
  exportedAtMs: number;
  /** 导出的目标会话脱敏元信息（不含本机数据库目录或密钥）。 */
  chat: {
    /** 会话展示名称。 */
    displayName: string;
    /** 私聊或群聊类型。 */
    chatType: 'p2p' | 'group';
    /** 安全目录名建议值。 */
    safeFolderName: string;
  };
  /** 本次导出的筛选与分卷参数记录。 */
  query: {
    /** 请求的最大消息条数。 */
    limit: number;
    /** 最近 N 天过滤窗口（0 表示全部历史）。 */
    sinceDays: number;
    /** 分卷拆分策略。 */
    chunkBy: ChunkMode;
    /** 按条数分卷时的单卷大小。 */
    chunkSize: number;
    /** 单卷最大 Token 预算（0 表示不限）。 */
    maxTokens: number;
    /** 单个媒体/附件最大复制体积上限（MB，0 表示不限）。 */
    maxFileMb: number;
    /** 相对媒体目录路径（如 `./media`）。 */
    mediaDir: string;
  };
  /** 实际导出的消息总条数。 */
  totalMessages: number;
  /** 所有分卷累计估算 Token 总数。 */
  totalEstimatedTokens: number;
  /** 导出消息覆盖的起止时间范围。 */
  timeRange: {
    /** 首条消息秒级时间戳；空消息时为 null。 */
    startAt: number | null;
    /** 末条消息秒级时间戳；空消息时为 null。 */
    endAt: number | null;
    /** 首条消息 ISO 8601 时间；空消息时为 null。 */
    startIso: string | null;
    /** 末条消息 ISO 8601 时间；空消息时为 null。 */
    endIso: string | null;
  };
  /** 媒体提取与降级统计。 */
  media: {
    /** 成功提取复制到 `<out>/<mediaDir>/` 的媒体文件数。 */
    copiedCount: number;
    /** 本地原件缺失、无法解密或超过体积上限而优雅降级为纯文本占位的条数。 */
    missingCount: number;
    /** 因超过 `--max-file-mb` 单文件大小上限而跳过复制并写明占位说明的条数。 */
    oversizeCount: number;
    /** 已复制媒体的相对路径列表（如 `./media/20261121_001.png`）。 */
    files: string[];
  };
  /** 生成的 Markdown 分卷清单。 */
  chunks: ExportChunkEntry[];
  /** 若磁盘上存在尚未提取密钥的新消息分片（如 `--connect` 后新生成的 `message_4.db`），列出其相对路径提示重刷密钥。 */
  unkeyedShards?: string[];
  /** 落盘前执行的脱敏与绝对路径泄漏自检结果。 */
  redactionCheck: RedactionCheckReport;
}

/** 写入 `<out>/batch-manifest.json` 的多会话批量导出总清单结构。 */
export interface BatchExportManifest {
  schemaVersion: 1;
  exportedAt: string;
  exportedAtMs: number;
  account: {
    accountId: string;
    nickname: string;
    wxid: string;
    safeFolderName: string;
  };
  query: {
    mode: 'chats' | 'all';
    sinceDays: number;
    chunkBy: ChunkMode;
    maxTokens: number;
    maxFileMb: number;
    limit: number;
    mediaDir: string;
    withAccountDir: boolean;
  };
  totals: {
    exportedChats: number;
    skippedChats: number;
    failedChats: number;
    totalMessages: number;
    totalChunks: number;
    totalEstimatedTokens: number;
    totalMediaCopied: number;
    totalMediaOversize: number;
  };
  items: Array<{
    chat: string;
    chatType: 'p2p' | 'group';
    safeFolderName: string;
    folder: string;
    totalMessages: number;
    chunks: number;
    estimatedTokens: number;
    mediaCopied: number;
    mediaMissing: number;
    mediaOversize: number;
    redactionPassed: boolean;
  }>;
  skipped: Array<{ chat: string; reason: string }>;
  failed: Array<{ chat: string; error: string }>;
  unkeyedShards?: string[];
  redactionCheck: RedactionCheckReport;
}

/** 已完成媒体处理、准备渲染进 Markdown 的中间消息行。 */
interface PreparedExportItem {
  /** 秒级时间戳。 */
  timestamp: number;
  /** 东八区日期 `YYYY-MM-DD`。 */
  dateText: string;
  /** 东八区月份 `YYYY-MM`。 */
  monthText: string;
  /** 东八区时分秒 `HH:mm:ss`。 */
  timeText: string;
  /** 发言人可读名称。 */
  speaker: string;
  /** 若该条消息成功复制了媒体，记录其在 `mediaDir` 内的纯文件名（如 `20261121_001.png`）。 */
  mediaFileName?: string;
  /** 媒体渲染类别（图片用 `![图片](...)`，语音/文件用 `[标签](...)`）。 */
  mediaRenderKind?: 'image' | 'link';
  /** 媒体链接标签或纯文本正文（未命中媒体时已是优雅降级占位文本）。 */
  bodyOrLabel: string;
}


/**
 * 确定性、无外部依赖的文本 Token 估算器：
 * - 中文/CJK 汉字与全角标点按 ~1.5 字符/token（`ceil(cjkCount * 2 / 3)`）估算；
 * - ASCII / 英文 / 数字 / 常规符号按 ~4 字符/token（`ceil(otherCount / 4)`）估算。
 */
export function estimateTokens(text: string): number {
  if (text === '') return 0;

  let cjkCount = 0;
  let otherCount = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCjk = (
      (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x3000 && code <= 0x30ff)
      || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xff00 && code <= 0xffef)
      || (code >= 0x20000 && code <= 0x2ebef)
    );
    if (isCjk) {
      cjkCount += 1;
      continue;
    }
    otherCount += 1;
  }
  return Math.ceil((cjkCount * 2) / 3) + Math.ceil(otherCount / 4);
}


/**
 * 将任意会话名或附件文件名清洗为不含路径分隔符、不含 `..` 且兼容 Windows/Linux 的安全单段名称。
 * @param raw 原始名称字符串。
 * @param fallback 清洗后为空时的回退名。
 */
export function sanitizeSafeSegment(raw: string, fallback = 'untitled'): string {
  const cleaned = raw
    .replace(/[\x00-\x1f<>:"/\\|?*]+/gu, '_')
    .replace(/\s+/gu, '_')
    .replace(/\.+/gu, '.')
    .replace(/^[._]+|[._]+$/gu, '')
    .slice(0, 80);
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback;
  if (WIN_RESERVED_NAME_RE.test(cleaned)) return `_${cleaned}`;

  return cleaned;
}


/**
 * 构建兼顾可读性与全局防重名碰撞的安全目录名：`<安全显示名>_<安全唯一ID>`。
 * 当显示名缺失或与唯一 ID 相同（如无名称群聊直接显示 chatroomId）时自动退化为单个 `<安全唯一ID>`。
 * @param displayName 可读名称（备注、群名或昵称）。
 * @param uniqueId 稳定唯一标识（如 `wxid_xxx`、`xxx@chatroom` 或 `accountId`）。
 * @param fallback 二者皆空时的兜底目录名。
 */
export function buildUniqueSafeFolderName(
  displayName: string,
  uniqueId: string,
  fallback = 'wechat_chat',
): string {
  const safeId = sanitizeSafeSegment(uniqueId, fallback);
  const safeName = sanitizeSafeSegment(displayName, '').slice(0, 50).replace(/[._]+$/gu, '');
  if (safeName === '' || safeName.toLowerCase() === safeId.toLowerCase()) {
    return safeId;
  }
  return `${safeName}_${safeId}`;
}


/**
 * 校验并归一化 `--media-dir` 参数：只允许位于 `<out>` 内部的子目录相对路径，严防 `..` 或绝对路径穿越。
 * @param rawMediaDir 用户传入的 `--media-dir` 字符串。
 * @param resolvedOutDir 已解析的 `<out>` 绝对路径。
 */
export function validateRelativeMediaDir(rawMediaDir: string, resolvedOutDir: string): string {
  const trimmed = rawMediaDir.trim();
  if (trimmed === '' || trimmed.includes('\0')) {
    throw new Error('--media-dir 不能为空');
  }
  if (/^[A-Za-z]:/u.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw new Error('--media-dir 必须是相对路径，禁止传入绝对路径');
  }
  if (/[<>:"|?*]/u.test(trimmed)) {
    throw new Error('--media-dir 包含非法路径字符');
  }

  const unified = trimmed.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (unified === '' || unified === '.' || unified === '..') {
    throw new Error('--media-dir 必须指向导出目录下的子目录（如 media）');
  }
  const segments = unified.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..' || WIN_RESERVED_NAME_RE.test(seg)) {
      throw new Error('--media-dir 禁止包含 .. 回溯段或系统保留目录名');
    }
  }

  const resolvedMedia = path.resolve(resolvedOutDir, unified);
  const relCheck = path.relative(resolvedOutDir, resolvedMedia);
  if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error('--media-dir 越出了导出目标目录边界');
  }
  return unified;
}


/**
 * 校验非负整数参数（如 `--since-days`、`--max-tokens`）。
 */
function parseNonNegativeInt(raw: string, flagName: string, maxAllowed: number): number {
  const trimmed = raw.trim();
  const num = Number(trimmed);
  if (!/^\d+$/u.test(trimmed) || !Number.isSafeInteger(num) || num < 0 || num > maxAllowed) {
    throw new Error(`${flagName} 要是 0 至 ${String(maxAllowed)} 的非负整数`);
  }
  return num;
}


/**
 * 校验 `--chunk-by` 模式枚举。
 */
function parseChunkMode(raw: string | undefined): ChunkMode {
  const mode = (raw ?? DEFAULT_CHUNK_BY).trim();
  if (mode !== 'none' && mode !== 'day' && mode !== 'month' && mode !== 'count') {
    throw new Error('--chunk-by 只支持 none、day、month 或 count');
  }
  return mode;
}


function resolveExportCacheDir(rawCacheDir: string | undefined, dataDir: string): string {
  if (rawCacheDir === undefined) {
    return readerModule.defaultTempCacheDir(dataDir);
  }
  const trimmed = rawCacheDir.trim();
  if (trimmed === '') {
    throw new Error('--cache-dir 不能为空');
  }
  return path.resolve(trimmed);
}


/**
 * 在外部入口一次性校验全部 `export-chat` 原始参数并补齐默认值：
 * 默认 `--since-days 30`、`--chunk-by day`、`--max-tokens 100000`（传 `--since-days 0` 或 `--max-tokens 0` 可解除对应上限）。
 * @param raw 命令行解析出的原始键值。
 */
export function validateExportCliInput(raw: {
  data?: string;
  engine?: string;
  cacheDir?: string;
  account?: string;
  chat?: string;
  out?: string;
  limit?: string;
  sinceDays?: string;
  chunkBy?: string;
  chunkSize?: string;
  maxTokens?: string;
  maxFileMb?: string;
  mediaDir?: string;
  atNames?: string;
  json?: boolean;
  nowMs?: number;
}): ValidatedExportOptions {
  if (!raw.data || raw.data.trim() === '') {
    throw new Error('export-chat 需要 --data <外置微信数据目录>');
  }
  if (!raw.chat || raw.chat.trim() === '') {
    throw new Error('export-chat 需要显式指定 --chat <会话名或wxid>');
  }
  if (!raw.out || raw.out.trim() === '') {
    throw new Error('export-chat 需要显式指定 --out <导出目标目录>');
  }

  const dataDir = path.resolve(raw.data);
  const engineDir = path.resolve(raw.engine ?? path.join(dataDir, 'engine'));
  const cacheDir = resolveExportCacheDir(raw.cacheDir, dataDir);
  const outDir = path.resolve(raw.out);

  //G 禁止把导出目标目录直接设在数据目录根或系统盘根，防止误覆盖运行态配置。
  if (path.dirname(outDir) === outDir) {
    throw new Error('--out 不能直接指向磁盘根目录');
  }
  if (outDir === dataDir) {
    throw new Error('--out 必须是独立的目标导出目录，不能与 --data 相同');
  }

  const rawLimit = raw.limit ?? String(DEFAULT_EXPORT_LIMIT);
  const limit = Number(rawLimit);
  if (!/^\d+$/u.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXPORT_LIMIT) {
    throw new Error(`--limit 要是 1 至 ${String(MAX_EXPORT_LIMIT)} 的正整数`);
  }

  const sinceDays = parseNonNegativeInt(raw.sinceDays ?? String(DEFAULT_SINCE_DAYS), '--since-days', 36_500);
  const chunkBy = parseChunkMode(raw.chunkBy);

  const rawChunkSize = raw.chunkSize ?? String(DEFAULT_CHUNK_SIZE);
  const chunkSize = Number(rawChunkSize);
  const validChunkSize = /^\d+$/u.test(rawChunkSize)
    && Number.isSafeInteger(chunkSize)
    && chunkSize >= 1
    && chunkSize <= MAX_EXPORT_LIMIT;
  if (!validChunkSize) {
    throw new Error('--chunk-size 要是正整数');
  }

  const maxTokens = parseNonNegativeInt(raw.maxTokens ?? String(DEFAULT_MAX_TOKENS), '--max-tokens', 50_000_000);
  const maxFileMb = parseNonNegativeInt(raw.maxFileMb ?? String(DEFAULT_MAX_FILE_MB), '--max-file-mb', 102_400);
  const mediaDir = validateRelativeMediaDir(raw.mediaDir ?? DEFAULT_MEDIA_DIR, outDir);

  let account: string | undefined;
  if (raw.account !== undefined && raw.account.trim() !== '') {
    account = raw.account.trim();
  }

  return {
    dataDir,
    engineDir,
    cacheDir,
    account,
    chat: raw.chat.trim(),
    outDir,
    limit,
    sinceDays,
    chunkBy,
    chunkSize,
    maxTokens,
    maxFileMb,
    mediaDir,
    atNames: raw.atNames ?? '',
    json: raw.json === true,
    nowMs: raw.nowMs,
  };
}


/**
 * 在外部入口校验 `export-batch` 参数：要求显式传 `--chats` 或 `--all` 二选一。
 */
export function validateBatchExportInput(raw: {
  data?: string;
  engine?: string;
  cacheDir?: string;
  account?: string;
  chats?: string;
  all?: boolean;
  type?: string;
  pinnedOnly?: boolean;
  out?: string;
  withAccountDir?: boolean;
  limit?: string;
  sinceDays?: string;
  chunkBy?: string;
  chunkSize?: string;
  maxTokens?: string;
  maxFileMb?: string;
  mediaDir?: string;
  atNames?: string;
  json?: boolean;
  nowMs?: number;
}): ValidatedBatchExportOptions {
  if (!raw.data || raw.data.trim() === '') {
    throw new Error('export-batch 需要 --data <外置微信数据目录>');
  }
  if (!raw.out || raw.out.trim() === '') {
    throw new Error('export-batch 需要显式指定 --out <导出根目录>');
  }

  const dataDir = path.resolve(raw.data);
  const engineDir = path.resolve(raw.engine ?? path.join(dataDir, 'engine'));
  const cacheDir = resolveExportCacheDir(raw.cacheDir, dataDir);
  const outDir = path.resolve(raw.out);
  if (path.dirname(outDir) === outDir) {
    throw new Error('--out 不能直接指向磁盘根目录');
  }
  if (outDir === dataDir) {
    throw new Error('--out 必须是独立的目标导出目录，不能与 --data 相同');
  }

  const allFlag = raw.all === true;
  const parsedChats = (raw.chats ?? '')
    .split(/[,，]/u)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  const uniqueChats = [...new Set(parsedChats)];

  if (allFlag && uniqueChats.length > 0) {
    throw new Error('export-batch 的 --chats 与 --all 只能二选一');
  }
  if (!allFlag && uniqueChats.length === 0) {
    throw new Error('export-batch 需要显式指定 --chats "会话1,会话2" 或 --all');
  }

  const rawType = (raw.type ?? 'all').trim();
  if (rawType !== 'all' && rawType !== 'p2p' && rawType !== 'group') {
    throw new Error('--type 只支持 all、p2p 或 group');
  }

  const rawLimit = raw.limit ?? String(DEFAULT_EXPORT_LIMIT);
  const limit = Number(rawLimit);
  if (!/^\d+$/u.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXPORT_LIMIT) {
    throw new Error(`--limit 要是 1 至 ${String(MAX_EXPORT_LIMIT)} 的正整数`);
  }

  const sinceDays = parseNonNegativeInt(raw.sinceDays ?? String(DEFAULT_SINCE_DAYS), '--since-days', 36_500);
  const chunkBy = parseChunkMode(raw.chunkBy);

  const rawChunkSize = raw.chunkSize ?? String(DEFAULT_CHUNK_SIZE);
  const chunkSize = Number(rawChunkSize);
  const validChunkSize = /^\d+$/u.test(rawChunkSize)
    && Number.isSafeInteger(chunkSize)
    && chunkSize >= 1
    && chunkSize <= MAX_EXPORT_LIMIT;
  if (!validChunkSize) {
    throw new Error('--chunk-size 要是正整数');
  }

  const maxTokens = parseNonNegativeInt(raw.maxTokens ?? String(DEFAULT_MAX_TOKENS), '--max-tokens', 50_000_000);
  const maxFileMb = parseNonNegativeInt(raw.maxFileMb ?? String(DEFAULT_MAX_FILE_MB), '--max-file-mb', 102_400);
  const mediaDir = validateRelativeMediaDir(raw.mediaDir ?? DEFAULT_MEDIA_DIR, outDir);

  let account: string | undefined;
  if (raw.account !== undefined && raw.account.trim() !== '') {
    account = raw.account.trim();
  }

  return {
    dataDir,
    engineDir,
    cacheDir,
    account,
    chats: uniqueChats,
    all: allFlag,
    typeFilter: rawType,
    pinnedOnly: raw.pinnedOnly === true,
    outDir,
    withAccountDir: raw.withAccountDir === true,
    limit,
    sinceDays,
    chunkBy,
    chunkSize,
    maxTokens,
    maxFileMb,
    mediaDir,
    atNames: raw.atNames ?? '',
    json: raw.json === true,
    nowMs: raw.nowMs,
  };
}


/**
 * 按东八区（`Asia/Shanghai`）将秒级 Unix 时间戳格式化为日期、月份、紧凑日期与时分秒。
 * @param epochSeconds Unix 秒级时间戳。
 */
function formatTimestampParts(epochSeconds: number): {
  dateText: string;
  monthText: string;
  compactDate: string;
  timeText: string;
  isoText: string;
} {
  const safeMs = Math.max(0, Math.trunc(epochSeconds) * 1000);
  const dt = new Date(safeMs);
  const svText = dt.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false });
  const datePart = svText.slice(0, 10);
  const timePart = svText.slice(11, 19);
  return {
    dateText: datePart,
    monthText: datePart.slice(0, 7),
    compactDate: datePart.replaceAll('-', ''),
    timeText: timePart,
    isoText: dt.toISOString(),
  };
}


/**
 * 根据图片 MIME 类型映射干净的小写文件扩展名。
 * @param mime 图片媒体类型。
 */
function extensionForImageMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower === 'image/png') return '.png';
  if (lower === 'image/gif') return '.gif';
  if (lower === 'image/webp') return '.webp';
  if (lower === 'image/bmp') return '.bmp';
  if (lower === 'image/wxgf') return '.wxgf';
  return '.jpg';
}


/**
 * 转义 Markdown 链接方括号文本中的特殊括号与换行，防止破坏链接语法。
 * @param label 原始标签文本。
 */
function escapeMarkdownLabel(label: string): string {
  return label.replace(/[\r\n]+/gu, ' ').replace(/[[\]\\]/gu, '\\$&').trim();
}


/**
 * 提取单篇导出 Markdown 中由工具自身生成的结构化区域（顶部元信息头或分卷总目录），剥离群友自由聊天正文。
 */
export function extractStructuredMarkdownHeader(markdown: string): string {
  const lines = markdown.split(/\r?\n/u);
  const headerLines: string[] = [];
  for (const line of lines) {
    if (/^## \d{4}-\d{2}-\d{2}$/u.test(line)) {
      break;
    }
    headerLines.push(line);
  }
  return headerLines.join('\n');
}


function buildNormalizedPrefixes(rawPrefixes: readonly string[]): string[] {
  const out: string[] = [];
  for (const prefix of rawPrefixes) {
    const trimmed = prefix.trim();
    if (trimmed.length >= 4) {
      out.push(trimmed);
      const slashForm = trimmed.replaceAll('\\', '/');
      if (slashForm !== trimmed) {
        out.push(slashForm);
      }
    }
  }
  return out;
}


/**
 * 落盘前绝对路径零泄漏校验：
 * 1. `forbiddenPrefixes`（宿主机真实敏感目录：`dataDir`、`outDir`、`engineDir`、`cacheDir`、账号 `dbDir` 等）在全文与结构化区域 100% 严防死守；
 * 2. 通用绝对路径正则 `LEAKED_ABS_PATH_RE` 与可选 `structuredPrefixes`（如 `os.homedir()`）仅校验工具生成的结构化区域
 *    （`manifest.json`、Markdown 元信息头、分卷总目录与 `./media/...` 链接），绝不误杀群友聊天正文中讨论代码的 `C:\...` / `/Users/...` / `https://...`。
 * @param contents 待落盘的全部文件内容列表（含完整 Markdown 与 JSON）。
 * @param forbiddenPrefixes 全文严禁出现的宿主机真实目录前缀。
 * @param structuredContents 可选仅含结构化区域的文本片段列表；省略时默认等同于 `contents`。
 * @param structuredPrefixes 可选仅在结构化区域附加拦截的目录前缀（如 `os.homedir()`）。
 */
export function verifyNoAbsolutePathLeak(
  contents: readonly string[],
  forbiddenPrefixes: readonly string[],
  structuredContents?: readonly string[],
  structuredPrefixes: readonly string[] = [],
): RedactionCheckReport {
  const fullPrefixes = buildNormalizedPrefixes(forbiddenPrefixes);
  const extraStructPrefixes = buildNormalizedPrefixes(structuredPrefixes);

  if (structuredContents === undefined) {
    const mergedPrefixes = [...fullPrefixes, ...extraStructPrefixes];
    let leakedSingle = 0;
    for (const text of contents) {
      if (LEAKED_ABS_PATH_RE.test(text) || mergedPrefixes.some((p) => text.includes(p))) {
        leakedSingle += 1;
      }
    }
    return {
      passed: leakedSingle === 0,
      checkedFiles: contents.length,
      leakedAbsolutePaths: leakedSingle,
    };
  }

  let leaked = 0;
  for (const text of contents) {
    if (fullPrefixes.some((p) => text.includes(p))) {
      leaked += 1;
    }
  }
  for (const structText of structuredContents) {
    const hitPrefix = fullPrefixes.some((p) => structText.includes(p))
      || extraStructPrefixes.some((p) => structText.includes(p));
    if (LEAKED_ABS_PATH_RE.test(structText) || hitPrefix) {
      leaked += 1;
    }
  }

  return {
    passed: leaked === 0,
    checkedFiles: contents.length,
    leakedAbsolutePaths: leaked,
  };
}


/**
 * 原子写入 UTF-8 文本文件（统一使用 CRLF 行尾）。
 * @param targetPath 目标文件绝对路径。
 * @param content 文本内容。
 */
function writeTextAtomic(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const crlfContent = content.replace(/\r?\n/gu, '\r\n');
  const tempPath = `${targetPath}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tempPath, crlfContent, 'utf8');
  fs.renameSync(tempPath, targetPath);
}


/**
 * 原子写入二进制媒体文件，写入前二次确认目标路径未越出媒体目录边界。
 * @param mediaRootAbs 已解析的 `<out>/<mediaDir>` 绝对路径。
 * @param fileName 安全单段文件名。
 * @param bytes 文件字节内容。
 */
function writeMediaFileSafe(mediaRootAbs: string, fileName: string, bytes: Uint8Array): void {
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    throw new Error('媒体输出文件名非法');
  }
  const targetPath = path.resolve(mediaRootAbs, fileName);
  const rel = path.relative(mediaRootAbs, targetPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('媒体输出路径越出媒体目录');
  }
  fs.mkdirSync(mediaRootAbs, { recursive: true });
  const tempPath = `${targetPath}.${String(process.pid)}.tmp`;
  fs.writeFileSync(tempPath, bytes);
  fs.renameSync(tempPath, targetPath);
}


/**
 * 使用内核级 `fs.copyFileSync` 流式原子拷贝本地磁盘媒体文件（不将大文件整块读入 V8/JSC 堆内存）。
 * @param srcAbsPath 已核验安全的源磁盘文件绝对路径。
 * @param mediaRootAbs 已解析的 `<out>/<mediaDir>` 绝对路径。
 * @param fileName 安全单段输出文件名。
 */
function copyMediaFileSafe(srcAbsPath: string, mediaRootAbs: string, fileName: string): void {
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    throw new Error('媒体输出文件名非法');
  }
  const targetPath = path.resolve(mediaRootAbs, fileName);
  const rel = path.relative(mediaRootAbs, targetPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('媒体输出路径越出媒体目录');
  }
  fs.mkdirSync(mediaRootAbs, { recursive: true });
  const tempPath = `${targetPath}.${String(process.pid)}.tmp`;
  fs.copyFileSync(srcAbsPath, tempPath);
  fs.renameSync(tempPath, targetPath);
}


/**
 * 将字节数格式化为保留 1 位小数的 MB 文本（用于超大文件跳过复制提示）。
 */
function formatSizeMb(sizeBytes: number): string {
  return (sizeBytes / (1024 * 1024)).toFixed(1);
}


/**
 * 计算单条消息在 Markdown 渲染后的块文本（不含日期二级标题），用于精确估算单条 Token 开销。
 */
function renderSingleItemBlock(item: PreparedExportItem, mediaRelPrefix: string): string {
  let renderedBody = item.bodyOrLabel;
  if (item.mediaFileName !== undefined) {
    const relUrl = `${mediaRelPrefix}/${item.mediaFileName}`;
    if (item.mediaRenderKind === 'image') {
      renderedBody = `![${item.bodyOrLabel}](${relUrl})`;
    }
    if (item.mediaRenderKind === 'link') {
      renderedBody = `[${item.bodyOrLabel}](${relUrl})`;
    }
  }
  return `**[${item.timeText}] ${item.speaker}**\n${renderedBody}\n`;
}


/**
 * 将一组消息按 `maxTokens` 上限无损拆分为若干子片（`maxTokens <= 0` 时不拆分，单条超大消息独占一片不丢数据）。
 */
function splitGroupByTokenBudget(
  items: readonly PreparedExportItem[],
  mediaRelPrefix: string,
  maxTokens: number,
  headerOverheadTokens = 90,
): PreparedExportItem[][] {
  if (maxTokens <= 0 || items.length <= 1) {
    return [[...items]];
  }

  const parts: PreparedExportItem[][] = [];
  let current: PreparedExportItem[] = [];
  let currentTokens = headerOverheadTokens;
  let lastDate = '';

  for (const item of items) {
    let itemTokens = estimateTokens(renderSingleItemBlock(item, mediaRelPrefix));
    if (item.dateText !== lastDate) {
      itemTokens += estimateTokens(`## ${item.dateText}\n\n`);
    }

    if (current.length > 0 && currentTokens + itemTokens > maxTokens) {
      parts.push(current);
      current = [item];
      lastDate = item.dateText;
      currentTokens = headerOverheadTokens
        + estimateTokens(`## ${item.dateText}\n\n`)
        + estimateTokens(renderSingleItemBlock(item, mediaRelPrefix));
      continue;
    }
    current.push(item);
    lastDate = item.dateText;
    currentTokens += itemTokens;
  }

  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}


/**
 * 单会话显式导出执行器：协调只读会话查询、时间窗过滤、媒体解密复制、按天/Token 分卷与脱敏清单落盘。
 */
export class ChatExporter {
  /**
   * @param reader 纯 Bun 微信只读引擎实例。
   * @param voiceCache 纯 Bun 语音转 WAV 缓存器实例。
   */
  constructor(
    private readonly reader: readerModule.Reader,
    private readonly voiceCache: voiceModule.VoiceAudio,
  ) {}

  /**
   * 按校验通过的导出参数完成整场导出并返回生成的 `ExportManifest`。
   * @param options 已通过入口校验的导出选项。
   */
  async exportChat(options: ValidatedExportOptions): Promise<ExportManifest> {
    const nowMs = options.nowMs ?? Date.now();
    let sinceTimestamp: number | undefined;
    if (options.sinceDays > 0) {
      sinceTimestamp = Math.floor((nowMs - options.sinceDays * 86_400_000) / 1000);
    }

    //==========================================================
    //M 第一步：确认已连接账号并读取目标会话在时间窗内的最近 N 条消息
    //==========================================================
    const resolved = await this.resolveAccountAndHistory(
      options.account,
      options.chat,
      options.limit,
      sinceTimestamp,
    );
    const { accountId, username, displayName, isGroup, messages } = resolved;

    const mediaRootAbs = path.resolve(options.outDir, options.mediaDir);
    let maxFileBytes = 0;
    if (options.maxFileMb > 0) {
      maxFileBytes = options.maxFileMb * 1024 * 1024;
    }
    const copiedRelFiles: string[] = [];
    let copiedCount = 0;
    let missingCount = 0;
    let oversizeCount = 0;
    let mediaSeq = 0;

    //==========================================================
    //M 第二步：逐条转换消息，解密/复制命中的图片、语音与本地文件至 <out>/<mediaDir>/
    //==========================================================
    const preparedItems: PreparedExportItem[] = [];
    for (const msg of messages) {
      const timeParts = formatTimestampParts(msg.create_time);
      const view = storeModule.getMessageView(msg);
      const kind = view.kind ?? 'other';

      let speaker = view.sender ?? '';
      if (msg.from_self === true) {
        speaker = '我方';
      }
      if (msg.from_self !== true && speaker === '') {
        speaker = displayName;
      }

      if (kind === 'image') {
        try {
          const img = await this.reader.image(accountId, username, msg.source, msg.local_id);
          const imgStat = fs.statSync(img.file);
          if (maxFileBytes > 0 && imgStat.size > maxFileBytes) {
            oversizeCount += 1;
            missingCount += 1;
            const sizeText = `${formatSizeMb(imgStat.size)} MB`;
            const capText = `超过单文件大小上限 ${String(options.maxFileMb)} MB 未复制`;
            preparedItems.push({
              timestamp: msg.create_time,
              dateText: timeParts.dateText,
              monthText: timeParts.monthText,
              timeText: timeParts.timeText,
              speaker,
              bodyOrLabel: `[图片（${sizeText}，${capText}）]`,
            });
            continue;
          }
          mediaSeq += 1;
          const seqStr = String(mediaSeq).padStart(3, '0');
          const ext = extensionForImageMime(img.mime);
          const fileName = `${timeParts.compactDate}_${seqStr}${ext}`;
          copyMediaFileSafe(img.file, mediaRootAbs, fileName);
          const relFromOut = `./${options.mediaDir}/${fileName}`;
          copiedRelFiles.push(relFromOut);
          copiedCount += 1;
          preparedItems.push({
            timestamp: msg.create_time,
            dateText: timeParts.dateText,
            monthText: timeParts.monthText,
            timeText: timeParts.timeText,
            speaker,
            mediaFileName: fileName,
            mediaRenderKind: 'image',
            bodyOrLabel: '图片',
          });
          continue;
        } catch {
          missingCount += 1;
          preparedItems.push({
            timestamp: msg.create_time,
            dateText: timeParts.dateText,
            monthText: timeParts.monthText,
            timeText: timeParts.timeText,
            speaker,
            bodyOrLabel: '[图片（本地原图未保存）]',
          });
          continue;
        }
      }

      if (kind === 'voice') {
        const sec = view.seconds ?? 0;
        const label = `语音 ${String(sec)} 秒`;
        try {
          const wavBytes = await this.voiceCache.get(
            { account: accountId, chat: username, source: msg.source, localId: msg.local_id },
            view.seconds,
          );
          mediaSeq += 1;
          const seqStr = String(mediaSeq).padStart(3, '0');
          const fileName = `${timeParts.compactDate}_${seqStr}.wav`;
          writeMediaFileSafe(mediaRootAbs, fileName, wavBytes);
          const relFromOut = `./${options.mediaDir}/${fileName}`;
          copiedRelFiles.push(relFromOut);
          copiedCount += 1;
          preparedItems.push({
            timestamp: msg.create_time,
            dateText: timeParts.dateText,
            monthText: timeParts.monthText,
            timeText: timeParts.timeText,
            speaker,
            mediaFileName: fileName,
            mediaRenderKind: 'link',
            bodyOrLabel: label,
          });
          continue;
        } catch {
          missingCount += 1;
          preparedItems.push({
            timestamp: msg.create_time,
            dateText: timeParts.dateText,
            monthText: timeParts.monthText,
            timeText: timeParts.timeText,
            speaker,
            bodyOrLabel: `[${label}（本地原音频未保存）]`,
          });
          continue;
        }
      }

      if (kind === 'file') {
        const rawTitle = (view.title ?? '').trim();
        const displayTitle = rawTitle || '未命名文件';
        const locatedFile = this.reader.locateFileAttachment(accountId, rawTitle, msg.create_time);
        if (locatedFile !== undefined) {
          if (maxFileBytes > 0 && locatedFile.sizeBytes > maxFileBytes) {
            oversizeCount += 1;
            missingCount += 1;
            const sizeText = `${formatSizeMb(locatedFile.sizeBytes)} MB`;
            const capText = `超过单文件大小上限 ${String(options.maxFileMb)} MB 未复制`;
            preparedItems.push({
              timestamp: msg.create_time,
              dateText: timeParts.dateText,
              monthText: timeParts.monthText,
              timeText: timeParts.timeText,
              speaker,
              bodyOrLabel: `[文件: ${displayTitle}（${sizeText}，${capText}）]`,
            });
            continue;
          }
          try {
            mediaSeq += 1;
            const seqStr = String(mediaSeq).padStart(3, '0');
            const parsed = path.parse(rawTitle);
            const safeStem = sanitizeSafeSegment(parsed.name, 'file');
            const safeExt = sanitizeSafeSegment(parsed.ext.replace(/^\./u, ''), '');
            let fileName = `${timeParts.compactDate}_${seqStr}_${safeStem}`;
            if (safeExt !== '') {
              fileName += `.${safeExt}`;
            }
            copyMediaFileSafe(locatedFile.absPath, mediaRootAbs, fileName);
            const relFromOut = `./${options.mediaDir}/${fileName}`;
            copiedRelFiles.push(relFromOut);
            copiedCount += 1;
            preparedItems.push({
              timestamp: msg.create_time,
              dateText: timeParts.dateText,
              monthText: timeParts.monthText,
              timeText: timeParts.timeText,
              speaker,
              mediaFileName: fileName,
              mediaRenderKind: 'link',
              bodyOrLabel: `文件: ${escapeMarkdownLabel(displayTitle)}`,
            });
            continue;
          } catch {
            // 拷贝异常时走下方未保存降级。
          }
        }
        missingCount += 1;
        preparedItems.push({
          timestamp: msg.create_time,
          dateText: timeParts.dateText,
          monthText: timeParts.monthText,
          timeText: timeParts.timeText,
          speaker,
          bodyOrLabel: `[文件: ${displayTitle}（本地未保存）]`,
        });
        continue;
      }

      const described = storeModule.describe(view).trim() || '[微信消息]';
      preparedItems.push({
        timestamp: msg.create_time,
        dateText: timeParts.dateText,
        monthText: timeParts.monthText,
        timeText: timeParts.timeText,
        speaker,
        bodyOrLabel: described,
      });
    }

    //==========================================================
    //M 第三步：按 chunkBy（none / day / month / count）与 maxTokens 切分 Markdown 分卷
    //==========================================================
    let chatType: 'p2p' | 'group' = 'p2p';
    if (isGroup) {
      chatType = 'group';
    }
    const pendingWrites: Array<{ absPath: string; content: string }> = [];
    const chunkEntries: ExportChunkEntry[] = [];

    if (options.chunkBy === 'none') {
      const mdRelPrefix = `./${options.mediaDir}`;
      const subParts = splitGroupByTokenBudget(preparedItems, mdRelPrefix, options.maxTokens);
      for (let idx = 0; idx < subParts.length; idx += 1) {
        const partItems = subParts[idx]!;
        let chunkId = 'all';
        let fileName = 'messages.md';
        if (idx > 0) {
          chunkId = `all_part${String(idx + 1)}`;
          fileName = `messages_part${String(idx + 1)}.md`;
        }
        let title = displayName;
        if (subParts.length > 1) {
          title = `${displayName}（第 ${String(idx + 1)}/${String(subParts.length)} 卷）`;
        }
        const mdText = this.renderChunkMarkdown(title, chatType, partItems, mdRelPrefix);
        pendingWrites.push({ absPath: path.join(options.outDir, fileName), content: mdText });
        const range = getItemsIsoRange(partItems);
        chunkEntries.push({
          id: chunkId,
          file: `./${fileName}`,
          count: partItems.length,
          estimatedTokens: estimateTokens(mdText),
          startIso: range.startIso,
          endIso: range.endIso,
        });
      }
    }

    if (options.chunkBy === 'day') {
      const mdRelPrefix = `./${options.mediaDir}`;
      const dayGroups = splitIntoDayGroups(preparedItems);
      for (const dayGroup of dayGroups) {
        const subParts = splitGroupByTokenBudget(dayGroup.items, mdRelPrefix, options.maxTokens);
        for (let idx = 0; idx < subParts.length; idx += 1) {
          const partItems = subParts[idx]!;
          let chunkId = dayGroup.id;
          if (idx > 0) {
            chunkId = `${dayGroup.id}_part${String(idx + 1)}`;
          }
          const fileName = `${chunkId}.md`;
          let chunkTitle = `${displayName}（${dayGroup.id}）`;
          if (subParts.length > 1) {
            chunkTitle = `${displayName}（${dayGroup.id} · 第 ${String(idx + 1)}/${String(subParts.length)} 卷）`;
          }
          const chunkMd = this.renderChunkMarkdown(chunkTitle, chatType, partItems, mdRelPrefix);
          pendingWrites.push({ absPath: path.join(options.outDir, fileName), content: chunkMd });
          const range = getItemsIsoRange(partItems);
          chunkEntries.push({
            id: chunkId,
            file: `./${fileName}`,
            count: partItems.length,
            estimatedTokens: estimateTokens(chunkMd),
            startIso: range.startIso,
            endIso: range.endIso,
          });
        }
      }
      const indexMd = renderRootIndexMarkdown(displayName, chatType, preparedItems.length, chunkEntries);
      pendingWrites.push({ absPath: path.join(options.outDir, 'messages.md'), content: indexMd });
    }

    if (options.chunkBy === 'month' || options.chunkBy === 'count') {
      const groups = splitIntoChunks(preparedItems, options.chunkBy, options.chunkSize);
      for (const group of groups) {
        const subDirRel = group.id;
        const relToMedia = path.posix.relative(subDirRel, options.mediaDir);
        let mdRelPrefix = relToMedia;
        if (!mdRelPrefix.startsWith('.')) {
          mdRelPrefix = `./${mdRelPrefix}`;
        }
        const subParts = splitGroupByTokenBudget(group.items, mdRelPrefix, options.maxTokens);
        for (let idx = 0; idx < subParts.length; idx += 1) {
          const partItems = subParts[idx]!;
          let chunkId = group.id;
          let mdFileName = 'messages.md';
          if (idx > 0) {
            chunkId = `${group.id}_part${String(idx + 1)}`;
            mdFileName = `messages_part${String(idx + 1)}.md`;
          }
          let chunkTitle = `${displayName}（${group.id}）`;
          if (subParts.length > 1) {
            chunkTitle = `${displayName}（${group.id} · 第 ${String(idx + 1)}/${String(subParts.length)} 卷）`;
          }
          const chunkMd = this.renderChunkMarkdown(chunkTitle, chatType, partItems, mdRelPrefix);
          const chunkAbs = path.join(options.outDir, subDirRel, mdFileName);
          pendingWrites.push({ absPath: chunkAbs, content: chunkMd });

          const range = getItemsIsoRange(partItems);
          chunkEntries.push({
            id: chunkId,
            file: `./${subDirRel}/${mdFileName}`,
            count: partItems.length,
            estimatedTokens: estimateTokens(chunkMd),
            startIso: range.startIso,
            endIso: range.endIso,
          });
        }
      }

      const indexMd = renderRootIndexMarkdown(displayName, chatType, preparedItems.length, chunkEntries);
      pendingWrites.push({ absPath: path.join(options.outDir, 'messages.md'), content: indexMd });
    }

    //==========================================================
    //M 第四步：执行脱敏与零绝对路径泄漏自检，通过后原子写出 Markdown 与 manifest.json
    //==========================================================
    const exportedNowMs = Date.now();
    const totalRange = getItemsTimeRange(preparedItems);
    const safeFolderName = buildUniqueSafeFolderName(displayName, username, 'wechat_chat');
    const totalEstimatedTokens = chunkEntries.reduce((sum, item) => sum + item.estimatedTokens, 0);

    const accountDbDir = this.reader.getAccountDbDir(accountId);
    const unkeyedShards = this.reader.getUnkeyedMessageShards(accountId);

    const draftManifest: ExportManifest = {
      schemaVersion: 1,
      exportedAt: new Date(exportedNowMs).toISOString(),
      exportedAtMs: exportedNowMs,
      chat: {
        displayName,
        chatType,
        safeFolderName,
      },
      query: {
        limit: options.limit,
        sinceDays: options.sinceDays,
        chunkBy: options.chunkBy,
        chunkSize: options.chunkSize,
        maxTokens: options.maxTokens,
        maxFileMb: options.maxFileMb,
        mediaDir: `./${options.mediaDir}`,
      },
      totalMessages: preparedItems.length,
      totalEstimatedTokens,
      timeRange: totalRange,
      media: {
        copiedCount,
        missingCount,
        oversizeCount,
        files: copiedRelFiles,
      },
      chunks: chunkEntries,
      redactionCheck: {
        passed: true,
        checkedFiles: pendingWrites.length + 1,
        leakedAbsolutePaths: 0,
      },
    };
    if (unkeyedShards.length > 0) {
      draftManifest.unkeyedShards = unkeyedShards;
    }

    const manifestDraftJson = JSON.stringify(draftManifest, null, 2);
    const textsToInspect = [
      ...pendingWrites.map((item) => item.content),
      manifestDraftJson,
    ];
    const mediaLinkSnippets: string[] = [];
    for (const item of preparedItems) {
      if (item.mediaFileName !== undefined) {
        mediaLinkSnippets.push(`./${options.mediaDir}/${item.mediaFileName}`);
      }
    }
    const structuredToInspect = [
      manifestDraftJson,
      ...pendingWrites.map((item) => extractStructuredMarkdownHeader(item.content)),
      ...mediaLinkSnippets,
    ];
    const checkReport = verifyNoAbsolutePathLeak(
      textsToInspect,
      [
        options.dataDir,
        options.engineDir,
        options.cacheDir,
        options.outDir,
        accountDbDir,
      ],
      structuredToInspect,
      [os.homedir()],
    );
    draftManifest.redactionCheck = checkReport;
    if (!checkReport.passed) {
      throw new Error('导出脱敏校验未通过：检测到宿主机绝对路径残留，已中止落盘');
    }

    fs.mkdirSync(options.outDir, { recursive: true });
    for (const fileItem of pendingWrites) {
      writeTextAtomic(fileItem.absPath, fileItem.content);
    }
    const manifestPath = path.join(options.outDir, 'manifest.json');
    writeTextAtomic(manifestPath, `${JSON.stringify(draftManifest, null, 2)}\n`);
    return draftManifest;
  }

  /**
   * 定位目标已连接账号（支持 `--account` 传账号ID、微信昵称或 wxid）并读取该会话的历史消息。
   */
  private async resolveAccountAndHistory(
    explicitAccount: string | undefined,
    chatQuery: string,
    limit: number,
    sinceTimestamp?: number,
  ): Promise<{
    accountId: string;
    username: string;
    displayName: string;
    isGroup: boolean;
    messages: readerModule.RawMessage[];
  }> {
    const connected = this.reader.accounts();
    if (connected.length === 0) {
      throw new Error('当前没有已连接的微信账号，请先完成账号连接');
    }

    if (explicitAccount !== undefined) {
      const targetAcc = this.reader.resolveAccountFlexible(explicitAccount);
      const hit = await this.reader.readChatHistory(targetAcc.id, chatQuery, limit, sinceTimestamp);
      if (hit === undefined) {
        throw new Error('在指定微信账号中未找到该会话');
      }
      return { accountId: targetAcc.id, ...hit };
    }

    const matches: Array<{
      accountId: string;
      username: string;
      displayName: string;
      isGroup: boolean;
      messages: readerModule.RawMessage[];
    }> = [];
    for (const acc of connected) {
      const hit = await this.reader.readChatHistory(acc.id, chatQuery, limit, sinceTimestamp);
      if (hit !== undefined) {
        matches.push({ accountId: acc.id, ...hit });
      }
    }

    if (matches.length === 0) {
      throw new Error('未找到匹配的微信会话，请核对会话名或 wxid');
    }
    if (matches.length > 1) {
      throw new Error('多个已连接微信账号均包含同名会话，请通过 --account 明确指定账号ID或昵称');
    }
    return matches[0]!;
  }

  /**
   * 将一批已准备好的消息按日期分节渲染成干净的 Markdown 文档（所有媒体链接均为相对路径）。
   */
  private renderChunkMarkdown(
    title: string,
    chatType: 'p2p' | 'group',
    items: readonly PreparedExportItem[],
    mediaRelPrefix: string,
  ): string {
    let typeLabel = '私聊';
    if (chatType === 'group') {
      typeLabel = '群聊';
    }
    const lines: string[] = [
      `# 微信聊天记录：${title}`,
      '',
      `- 会话类型：${typeLabel}`,
      `- 消息条数：${String(items.length)}`,
    ];

    if (items.length > 0) {
      const first = items[0]!;
      const last = items[items.length - 1]!;
      lines.push(`- 时间范围：${first.dateText} ${first.timeText} 至 ${last.dateText} ${last.timeText}（UTC+8）`);
    }
    lines.push('');

    if (items.length === 0) {
      lines.push('_（暂无消息记录）_', '');
      return lines.join('\n');
    }

    let currentDate = '';
    for (const item of items) {
      if (item.dateText !== currentDate) {
        currentDate = item.dateText;
        lines.push(`## ${currentDate}`, '');
      }

      let renderedBody = item.bodyOrLabel;
      if (item.mediaFileName !== undefined) {
        const relUrl = `${mediaRelPrefix}/${item.mediaFileName}`;
        if (item.mediaRenderKind === 'image') {
          renderedBody = `![${item.bodyOrLabel}](${relUrl})`;
        }
        if (item.mediaRenderKind === 'link') {
          renderedBody = `[${item.bodyOrLabel}](${relUrl})`;
        }
      }

      lines.push(`**[${item.timeText}] ${item.speaker}**`, renderedBody, '');
    }
    return lines.join('\n');
  }
}


/**
 * 按东八区日期 `YYYY-MM-DD` 切分消息列表（空会话生成单个 `empty` 占位卷以产出干净摘要）。
 */
function splitIntoDayGroups(
  items: readonly PreparedExportItem[],
): Array<{ id: string; items: PreparedExportItem[] }> {
  if (items.length === 0) {
    return [];
  }
  const byDay = new Map<string, PreparedExportItem[]>();
  for (const item of items) {
    const dayKey = sanitizeSafeSegment(item.dateText, 'unknown-day');
    let bucket = byDay.get(dayKey);
    if (bucket === undefined) {
      bucket = [];
      byDay.set(dayKey, bucket);
    }
    bucket.push(item);
  }
  const result: Array<{ id: string; items: PreparedExportItem[] }> = [];
  for (const [id, groupItems] of byDay) {
    result.push({ id, items: groupItems });
  }
  return result;
}


/**
 * 按 `month`（月份 `YYYY-MM`）或 `count`（每卷固定条数 `part-001`）切分消息列表。
 */
function splitIntoChunks(
  items: readonly PreparedExportItem[],
  mode: 'month' | 'count',
  chunkSize: number,
): Array<{ id: string; items: PreparedExportItem[] }> {
  if (items.length === 0) {
    return [{ id: 'empty', items: [] }];
  }

  if (mode === 'month') {
    const byMonth = new Map<string, PreparedExportItem[]>();
    for (const item of items) {
      const monthKey = sanitizeSafeSegment(item.monthText, 'unknown-month');
      let bucket = byMonth.get(monthKey);
      if (bucket === undefined) {
        bucket = [];
        byMonth.set(monthKey, bucket);
      }
      bucket.push(item);
    }
    const result: Array<{ id: string; items: PreparedExportItem[] }> = [];
    for (const [id, groupItems] of byMonth) {
      result.push({ id, items: groupItems });
    }
    return result;
  }

  const totalParts = Math.ceil(items.length / chunkSize);
  const padDigits = Math.max(3, String(totalParts).length);
  const chunks: Array<{ id: string; items: PreparedExportItem[] }> = [];
  for (let offset = 0; offset < items.length; offset += chunkSize) {
    const partIndex = Math.floor(offset / chunkSize) + 1;
    const id = `part-${String(partIndex).padStart(padDigits, '0')}`;
    chunks.push({ id, items: items.slice(offset, offset + chunkSize) });
  }
  return chunks;
}


/**
 * 渲染分卷模式下的顶层总索引 `messages.md`。
 */
function renderRootIndexMarkdown(
  displayName: string,
  chatType: 'p2p' | 'group',
  totalCount: number,
  chunks: readonly ExportChunkEntry[],
): string {
  let typeLabel = '私聊';
  if (chatType === 'group') {
    typeLabel = '群聊';
  }
  const lines: string[] = [
    `# 微信聊天记录总目录：${displayName}`,
    '',
    `- 会话类型：${typeLabel}`,
    `- 总消息数：${String(totalCount)}`,
    `- 分卷数量：${String(chunks.length)}`,
    '',
    '## 分卷列表',
    '',
  ];
  if (chunks.length === 0) {
    lines.push('_（所选时间窗口内暂无消息记录）_', '');
    return lines.join('\n');
  }
  for (const chunk of chunks) {
    lines.push(
      `- [${chunk.id}](${chunk.file})（${String(chunk.count)} 条，约 ${String(chunk.estimatedTokens)} tokens）`,
    );
  }
  lines.push('');
  return lines.join('\n');
}


/**
 * 计算一组消息的首尾 ISO 时间对。
 */
function getItemsIsoRange(items: readonly PreparedExportItem[]): {
  startIso: string | null;
  endIso: string | null;
} {
  if (items.length === 0) {
    return { startIso: null, endIso: null };
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  return {
    startIso: new Date(first.timestamp * 1000).toISOString(),
    endIso: new Date(last.timestamp * 1000).toISOString(),
  };
}


/**
 * 计算导出消息总列表的秒级时间戳与 ISO 起止范围。
 */
function getItemsTimeRange(items: readonly PreparedExportItem[]): ExportManifest['timeRange'] {
  if (items.length === 0) {
    return { startAt: null, endAt: null, startIso: null, endIso: null };
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  return {
    startAt: first.timestamp,
    endAt: last.timestamp,
    startIso: new Date(first.timestamp * 1000).toISOString(),
    endIso: new Date(last.timestamp * 1000).toISOString(),
  };
}


/**
 * 命令行显式 `export-chat` 一站式入口：构建只读引擎与语音缓存器并执行单会话导出。
 * @param options 已通过 `validateExportCliInput` 校验的导出配置。
 */
export async function runExportChatCli(options: ValidatedExportOptions): Promise<ExportManifest> {
  const reader = new readerModule.Reader(
    options.dataDir,
    options.atNames,
    undefined,
    options.engineDir,
    options.cacheDir,
  );
  const voiceCacheDir = path.join(options.cacheDir, 'voice_cache');
  const voiceCache = new voiceModule.VoiceAudio(reader, voiceCacheDir);
  const exporter = new ChatExporter(reader, voiceCache);
  return await exporter.exportChat(options);
}


/**
 * 命令行显式 `export-batch` 一站式入口：
 * 将多个指定会话或全账号会话按飞书渠道同构目录树（`<out>/私聊/<安全会话名>/` 与 `<out>/群聊/<安全会话名>/`）批量导出，
 * 并在根目录产出经零绝对路径泄漏校验的 `batch-manifest.json`。
 */
export async function runExportBatchCli(options: ValidatedBatchExportOptions): Promise<BatchExportManifest> {
  const nowMs = options.nowMs ?? Date.now();
  let sinceTimestamp = 0;
  if (options.sinceDays > 0) {
    sinceTimestamp = Math.floor((nowMs - options.sinceDays * 86_400_000) / 1000);
  }

  const reader = new readerModule.Reader(
    options.dataDir,
    options.atNames,
    undefined,
    options.engineDir,
    options.cacheDir,
  );
  const targetAccount = reader.resolveAccountFlexible(options.account);
  const voiceCacheDir = path.join(options.cacheDir, 'voice_cache');
  const voiceCache = new voiceModule.VoiceAudio(reader, voiceCacheDir);
  const exporter = new ChatExporter(reader, voiceCache);

  //M 组装待导出的会话标识队列（--all 模式先从 session.db 只读筛出目标会话并跳过超期不活跃会话）。
  const targets: Array<{ query: string; knownId?: string; knownDisplay?: string; knownGroup?: boolean }> = [];
  const skipped: Array<{ chat: string; reason: string }> = [];
  const failed: Array<{ chat: string; error: string }> = [];

  if (options.all) {
    const metaList = reader.listChatMetadata(targetAccount.id);
    for (const meta of metaList) {
      if (options.typeFilter !== 'all' && meta.chatType !== options.typeFilter) {
        continue;
      }
      if (options.pinnedOnly && !meta.pinned) {
        continue;
      }
      if (sinceTimestamp > 0 && meta.lastTimestamp < sinceTimestamp) {
        skipped.push({
          chat: meta.displayName,
          reason: `最近 ${String(options.sinceDays)} 天内无活跃消息`,
        });
        continue;
      }
      targets.push({
        query: meta.id,
        knownId: meta.id,
        knownDisplay: meta.displayName,
        knownGroup: meta.chatType === 'group',
      });
    }
  }
  if (!options.all) {
    for (const chatQuery of options.chats) {
      targets.push({ query: chatQuery });
    }
  }

  const accountSafeFolder = buildUniqueSafeFolderName(targetAccount.nickname, targetAccount.id, 'wechat_account');
  let accountRelPrefix = '';
  if (options.withAccountDir) {
    accountRelPrefix = `${accountSafeFolder}/`;
  }
  const usedRelFolders = new Set<string>();
  const exportedItems: BatchExportManifest['items'] = [];

  for (const target of targets) {
    try {
      let sinceArg: number | undefined;
      if (sinceTimestamp > 0) {
        sinceArg = sinceTimestamp;
      }
      const preview = await reader.readChatHistory(
        targetAccount.id,
        target.query,
        1,
        sinceArg,
      );
      if (preview === undefined) {
        failed.push({ chat: target.query, error: '未找到匹配的微信会话' });
        continue;
      }
      if (options.all && preview.messages.length === 0 && sinceTimestamp > 0) {
        skipped.push({
          chat: preview.displayName,
          reason: `最近 ${String(options.sinceDays)} 天内无消息记录`,
        });
        continue;
      }

      let categoryDir = '私聊';
      if (preview.isGroup) {
        categoryDir = '群聊';
      }
      const uniqueSafeName = buildUniqueSafeFolderName(preview.displayName, preview.username, 'wechat_chat');
      let relFolder = `${accountRelPrefix}${categoryDir}/${uniqueSafeName}`;
      if (usedRelFolders.has(relFolder.toLowerCase())) {
        relFolder = `${accountRelPrefix}${categoryDir}/${uniqueSafeName}_${String(usedRelFolders.size + 1)}`;
      }
      usedRelFolders.add(relFolder.toLowerCase());

      const chatOutDir = path.join(options.outDir, ...relFolder.split('/'));
      const manifest = await exporter.exportChat({
        dataDir: options.dataDir,
        engineDir: options.engineDir,
        cacheDir: options.cacheDir,
        account: targetAccount.id,
        chat: preview.username,
        outDir: chatOutDir,
        limit: options.limit,
        sinceDays: options.sinceDays,
        chunkBy: options.chunkBy,
        chunkSize: options.chunkSize,
        maxTokens: options.maxTokens,
        maxFileMb: options.maxFileMb,
        mediaDir: options.mediaDir,
        atNames: options.atNames,
        nowMs,
      });

      exportedItems.push({
        chat: manifest.chat.displayName,
        chatType: manifest.chat.chatType,
        safeFolderName: manifest.chat.safeFolderName,
        folder: `./${relFolder}`,
        totalMessages: manifest.totalMessages,
        chunks: manifest.chunks.length,
        estimatedTokens: manifest.totalEstimatedTokens,
        mediaCopied: manifest.media.copiedCount,
        mediaMissing: manifest.media.missingCount,
        mediaOversize: manifest.media.oversizeCount,
        redactionPassed: manifest.redactionCheck.passed,
      });
    } catch (error) {
      let msg = String(error);
      if (error instanceof Error) {
        msg = error.message;
      }
      failed.push({ chat: target.knownDisplay ?? target.query, error: msg });
    }
  }

  let queryMode: 'chats' | 'all' = 'chats';
  if (options.all) {
    queryMode = 'all';
  }

  const exportedAtMs = Date.now();
  const batchManifest: BatchExportManifest = {
    schemaVersion: 1,
    exportedAt: new Date(exportedAtMs).toISOString(),
    exportedAtMs,
    account: {
      accountId: targetAccount.id,
      nickname: targetAccount.nickname,
      wxid: targetAccount.wxid,
      safeFolderName: accountSafeFolder,
    },
    query: {
      mode: queryMode,
      sinceDays: options.sinceDays,
      chunkBy: options.chunkBy,
      maxTokens: options.maxTokens,
      maxFileMb: options.maxFileMb,
      limit: options.limit,
      mediaDir: `./${options.mediaDir}`,
      withAccountDir: options.withAccountDir,
    },
    totals: {
      exportedChats: exportedItems.length,
      skippedChats: skipped.length,
      failedChats: failed.length,
      totalMessages: exportedItems.reduce((sum, item) => sum + item.totalMessages, 0),
      totalChunks: exportedItems.reduce((sum, item) => sum + item.chunks, 0),
      totalEstimatedTokens: exportedItems.reduce((sum, item) => sum + item.estimatedTokens, 0),
      totalMediaCopied: exportedItems.reduce((sum, item) => sum + item.mediaCopied, 0),
      totalMediaOversize: exportedItems.reduce((sum, item) => sum + item.mediaOversize, 0),
    },
    items: exportedItems,
    skipped,
    failed,
    redactionCheck: {
      passed: true,
      checkedFiles: 1,
      leakedAbsolutePaths: 0,
    },
  };

  const accountDbDir = reader.getAccountDbDir(targetAccount.id);
  const unkeyedShards = reader.getUnkeyedMessageShards(targetAccount.id);
  if (unkeyedShards.length > 0) {
    batchManifest.unkeyedShards = unkeyedShards;
  }

  const batchJsonText = JSON.stringify(batchManifest, null, 2);
  const check = verifyNoAbsolutePathLeak(
    [batchJsonText],
    [
      options.dataDir,
      options.engineDir,
      options.cacheDir,
      options.outDir,
      accountDbDir,
    ],
    [batchJsonText],
    [os.homedir()],
  );
  batchManifest.redactionCheck = check;
  if (!check.passed) {
    throw new Error('批量导出脱敏校验未通过：batch-manifest.json 检测到宿主机绝对路径残留');
  }

  fs.mkdirSync(options.outDir, { recursive: true });
  writeTextAtomic(path.join(options.outDir, 'batch-manifest.json'), `${JSON.stringify(batchManifest, null, 2)}\n`);
  return batchManifest;
}
