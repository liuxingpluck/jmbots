/**
 * 微信单会话聊天记录显式本地导出模块（`export-chat`）：
 * 仅由命令行显式传参触发（AI 不可经 HTTP 或后台轮询静默调用），只读提取最近 N 条或全量分片历史，
 * 输出干净的 `messages.md` 与 `manifest.json`，将命中的图片/语音/文件安全复制至 `<out>/<mediaDir>/`，
 * 全程在 Markdown 与索引中使用相对路径并执行落盘前绝对路径零泄漏自检。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readerModule from './read/PureReader.ts';
import * as storeModule from './read/Store.ts';
import * as voiceModule from './read/VoiceCache.ts';


/** 默认导出的最近消息条数上限。 */
export const DEFAULT_EXPORT_LIMIT = 1000;

/** 允许导出的单次最大消息条数上限。 */
export const MAX_EXPORT_LIMIT = 500_000;

/** 按条数拆分子目录（`--chunk-by count`）时的默认每卷条数。 */
export const DEFAULT_CHUNK_SIZE = 1000;

/** 默认媒体相对目录名。 */
export const DEFAULT_MEDIA_DIR = 'media';

/** 支持的分卷拆分模式枚举。 */
export type ChunkMode = 'none' | 'month' | 'count';

/** Windows 保留设备名正则（不区分大小写）。 */
const WIN_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

/** 检测疑似宿主机绝对路径的脱敏自检正则（盘符路径、UNC 路径、常见系统用户根路径）。 */
const LEAKED_ABS_PATH_RE = new RegExp(
  '(?:[A-Za-z]:[\\\\/]|\\\\\\\\[A-Za-z0-9_.-]+[\\\\/]|(?:^|[\\s"\'`(])\\/(?:home|Users|root|tmp|var|etc|mnt|proc)\\/)',
  'u',
);


/** 入口校验通过后的导出配置（内部直接使用，不再补默认值）。 */
export interface ValidatedExportOptions {
  /** 外置微信数据目录绝对路径。 */
  dataDir: string;
  /** 兼容旧引擎目录绝对路径。 */
  engineDir: string;
  /** 可选显式指定的微信账号 ID。 */
  account?: string;
  /** 目标会话名称或原始 wxid。 */
  chat: string;
  /** 导出目标根目录绝对路径。 */
  outDir: string;
  /** 最近 N 条消息上限。 */
  limit: number;
  /** 分卷模式：`none` 单文件、`month` 按月子目录、`count` 按固定条数子目录。 */
  chunkBy: ChunkMode;
  /** `chunkBy === 'count'` 时每个分卷的条数上限。 */
  chunkSize: number;
  /** 归一化后的相对媒体子目录路径（正斜杠，不含前导 `./`，如 `media`）。 */
  mediaDir: string;
  /** 额外群提及昵称字符串。 */
  atNames: string;
}

/** 单个导出分卷在 `manifest.json` 中的索引条目。 */
export interface ExportChunkEntry {
  /** 分卷标识（如 `all`、`2026-11`、`part-001`）。 */
  id: string;
  /** 相对 `<out>` 根目录的正斜杠文件路径（如 `./messages.md` 或 `./2026-11/messages.md`）。 */
  file: string;
  /** 本分卷包含的消息条数。 */
  count: number;
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

/** 写入 `<out>/manifest.json` 的完整导出清单结构。 */
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
    /** 分卷拆分策略。 */
    chunkBy: ChunkMode;
    /** 按条数分卷时的单卷大小。 */
    chunkSize: number;
    /** 相对媒体目录路径（如 `./media`）。 */
    mediaDir: string;
  };
  /** 实际导出的消息总条数。 */
  totalMessages: number;
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
    /** 本地原件缺失或无法解密而优雅降级为纯文本占位的条数。 */
    missingCount: number;
    /** 已复制媒体的相对路径列表（如 `./media/20261121_001.png`）。 */
    files: string[];
  };
  /** 生成的 Markdown 分卷清单。 */
  chunks: ExportChunkEntry[];
  /** 落盘前执行的脱敏与绝对路径泄漏自检结果。 */
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
 * 在外部入口一次性校验全部 `export-chat` 原始参数并补齐默认值。
 * @param raw 命令行解析出的原始键值。
 */
export function validateExportCliInput(raw: {
  data?: string;
  engine?: string;
  account?: string;
  chat?: string;
  out?: string;
  limit?: string;
  chunkBy?: string;
  chunkSize?: string;
  mediaDir?: string;
  atNames?: string;
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

  const rawChunkBy = (raw.chunkBy ?? 'none').trim();
  if (rawChunkBy !== 'none' && rawChunkBy !== 'month' && rawChunkBy !== 'count') {
    throw new Error('--chunk-by 只支持 none、month 或 count');
  }
  const chunkBy: ChunkMode = rawChunkBy;

  const rawChunkSize = raw.chunkSize ?? String(DEFAULT_CHUNK_SIZE);
  const chunkSize = Number(rawChunkSize);
  const validChunkSize = /^\d+$/u.test(rawChunkSize)
    && Number.isSafeInteger(chunkSize)
    && chunkSize >= 1
    && chunkSize <= MAX_EXPORT_LIMIT;
  if (!validChunkSize) {
    throw new Error('--chunk-size 要是正整数');
  }

  //M 严格校验相对媒体目录不含任何路径穿越。
  const mediaDir = validateRelativeMediaDir(raw.mediaDir ?? DEFAULT_MEDIA_DIR, outDir);

  let account: string | undefined;
  if (raw.account !== undefined && raw.account.trim() !== '') {
    account = raw.account.trim();
  }

  return {
    dataDir,
    engineDir,
    account,
    chat: raw.chat.trim(),
    outDir,
    limit,
    chunkBy,
    chunkSize,
    mediaDir,
    atNames: raw.atNames ?? '',
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
 * 扫描所有待落盘的 Markdown 与 JSON 文本，确保零宿主机绝对路径泄漏。
 * @param contents 待检查的文件内容列表。
 * @param forbiddenPrefixes 已知敏感本机目录前缀（如 dataDir、outDir、engineDir）。
 */
export function verifyNoAbsolutePathLeak(
  contents: readonly string[],
  forbiddenPrefixes: readonly string[],
): RedactionCheckReport {
  const normalizedPrefixes: string[] = [];
  for (const prefix of forbiddenPrefixes) {
    const trimmed = prefix.trim();
    if (trimmed.length >= 4) {
      //M 同时登记原始反斜杠与正斜杠形式的本机路径前缀。
      normalizedPrefixes.push(trimmed);
      normalizedPrefixes.push(trimmed.replaceAll('\\', '/'));
    }
  }

  let leaked = 0;
  for (const text of contents) {
    if (LEAKED_ABS_PATH_RE.test(text)) {
      leaked += 1;
      continue;
    }
    for (const forbidden of normalizedPrefixes) {
      if (text.includes(forbidden)) {
        leaked += 1;
        break;
      }
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
 * 单会话显式导出执行器：协调只读会话查询、媒体解密复制、分卷 Markdown 生成与脱敏清单落盘。
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
    //==========================================================
    //M 第一步：确认已连接账号并读取目标会话最近 N 条消息
    //==========================================================
    const resolved = await this.resolveAccountAndHistory(options.account, options.chat, options.limit);
    const { accountId, username, displayName, isGroup, messages } = resolved;

    const mediaRootAbs = path.resolve(options.outDir, options.mediaDir);
    const copiedRelFiles: string[] = [];
    let copiedCount = 0;
    let missingCount = 0;
    let mediaSeq = 0;

    //==========================================================
    //M 第二步：逐条转换消息，解密/复制命中的图片、语音与本地文件至 <out>/<mediaDir>/
    //==========================================================
    const preparedItems: PreparedExportItem[] = [];
    for (const msg of messages) {
      const timeParts = formatTimestampParts(msg.create_time);
      //M 归一化气泡视图以识别图片、语音、文件及其余卡片类型。
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
          //M 调用纯 Bun 图片解密器获取缩略图/原图字节并拷入导出 media 目录。
          const img = await this.reader.image(accountId, username, msg.source, msg.local_id);
          const imgBytes = fs.readFileSync(img.file);
          mediaSeq += 1;
          const seqStr = String(mediaSeq).padStart(3, '0');
          const ext = extensionForImageMime(img.mime);
          const fileName = `${timeParts.compactDate}_${seqStr}${ext}`;
          writeMediaFileSafe(mediaRootAbs, fileName, imgBytes);
          const relFromOut = `./${options.mediaDir}/${fileName}`;
          //M 登记已复制媒体的相对路径。
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
          //M 本地原图不存在或无法解密时降级为纯文本占位。
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
          //M 从加密媒体库直提 SILK 并在内存转为标准 WAV 后写入导出 media 目录。
          const wavBytes = await this.voiceCache.get(
            { account: accountId, chat: username, source: msg.source, localId: msg.local_id },
            view.seconds,
          );
          mediaSeq += 1;
          const seqStr = String(mediaSeq).padStart(3, '0');
          const fileName = `${timeParts.compactDate}_${seqStr}.wav`;
          writeMediaFileSafe(mediaRootAbs, fileName, wavBytes);
          const relFromOut = `./${options.mediaDir}/${fileName}`;
          //M 登记已复制语音 WAV 的相对路径。
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
          //M 本地原音频不存在或转码失败时降级为带时长纯文本占位。
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
        //M 在账号 msg/file 目录内安全定位原件（拦截越界标题与外部软链接）。
        const foundFile = this.reader.findSafeFileAttachment(accountId, rawTitle, msg.create_time);
        if (foundFile !== undefined) {
          try {
            const fileBytes = fs.readFileSync(foundFile);
            mediaSeq += 1;
            const seqStr = String(mediaSeq).padStart(3, '0');
            const parsed = path.parse(rawTitle);
            const safeStem = sanitizeSafeSegment(parsed.name, 'file');
            const safeExt = sanitizeSafeSegment(parsed.ext.replace(/^\./u, ''), '');
            let fileName = `${timeParts.compactDate}_${seqStr}_${safeStem}`;
            if (safeExt !== '') {
              fileName += `.${safeExt}`;
            }
            writeMediaFileSafe(mediaRootAbs, fileName, fileBytes);
            const relFromOut = `./${options.mediaDir}/${fileName}`;
            //M 登记已复制附件的相对路径。
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
            // 读取异常时走下方未保存降级。
          }
        }
        missingCount += 1;
        //M 本地未保存原文件或路径越界被拦截时降级为纯文本占位。
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

      //M 普通文本、引用、卡片、转账等直接转为可读正文。
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
    //M 第三步：按 chunkBy（none / month / count）组织分卷 Markdown 与顶层导航
    //==========================================================
    let chatType: 'p2p' | 'group' = 'p2p';
    if (isGroup) {
      chatType = 'group';
    }
    const pendingWrites: Array<{ absPath: string; content: string }> = [];
    const chunkEntries: ExportChunkEntry[] = [];

    if (options.chunkBy === 'none') {
      const mdRelPrefix = `./${options.mediaDir}`;
      const mdText = this.renderChunkMarkdown(displayName, chatType, preparedItems, mdRelPrefix);
      const mdAbs = path.join(options.outDir, 'messages.md');
      //M 登记单卷模式下的根 Markdown 输出任务。
      pendingWrites.push({ absPath: mdAbs, content: mdText });

      const range = getItemsIsoRange(preparedItems);
      //M 登记单卷索引元数据。
      chunkEntries.push({
        id: 'all',
        file: './messages.md',
        count: preparedItems.length,
        startIso: range.startIso,
        endIso: range.endIso,
      });
    }

    if (options.chunkBy !== 'none') {
      const groups = splitIntoChunks(preparedItems, options.chunkBy, options.chunkSize);
      for (const group of groups) {
        const subDirRel = group.id;
        const relToMedia = path.posix.relative(subDirRel, options.mediaDir);
        let mdRelPrefix = relToMedia;
        if (!mdRelPrefix.startsWith('.')) {
          mdRelPrefix = `./${mdRelPrefix}`;
        }
        const chunkTitle = `${displayName}（${group.id}）`;
        const chunkMd = this.renderChunkMarkdown(chunkTitle, chatType, group.items, mdRelPrefix);
        const chunkAbs = path.join(options.outDir, subDirRel, 'messages.md');
        //M 登记当前分卷子目录的 Markdown 输出任务。
        pendingWrites.push({ absPath: chunkAbs, content: chunkMd });

        const range = getItemsIsoRange(group.items);
        //M 登记当前分卷的索引元数据。
        chunkEntries.push({
          id: group.id,
          file: `./${subDirRel}/messages.md`,
          count: group.items.length,
          startIso: range.startIso,
          endIso: range.endIso,
        });
      }

      //M 分卷模式下同时在顶层生成总目录 messages.md，方便从根入口直接索引各卷。
      const indexMd = renderRootIndexMarkdown(displayName, chatType, preparedItems.length, chunkEntries);
      pendingWrites.push({ absPath: path.join(options.outDir, 'messages.md'), content: indexMd });
    }

    //==========================================================
    //M 第四步：执行脱敏与零绝对路径泄漏自检，通过后原子写出 Markdown 与 manifest.json
    //==========================================================
    const exportedNowMs = Date.now();
    const totalRange = getItemsTimeRange(preparedItems);
    const safeFolderName = sanitizeSafeSegment(displayName, sanitizeSafeSegment(username, 'wechat_chat'));

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
        chunkBy: options.chunkBy,
        chunkSize: options.chunkSize,
        mediaDir: `./${options.mediaDir}`,
      },
      totalMessages: preparedItems.length,
      timeRange: totalRange,
      media: {
        copiedCount,
        missingCount,
        files: copiedRelFiles,
      },
      chunks: chunkEntries,
      redactionCheck: {
        passed: true,
        checkedFiles: pendingWrites.length + 1,
        leakedAbsolutePaths: 0,
      },
    };

    const textsToInspect = [
      ...pendingWrites.map((item) => item.content),
      JSON.stringify(draftManifest, null, 2),
    ];
    //M 对即将落盘的全部文本做宿主机绝对路径扫描。
    const checkReport = verifyNoAbsolutePathLeak(textsToInspect, [
      options.dataDir,
      options.engineDir,
      options.outDir,
    ]);
    draftManifest.redactionCheck = checkReport;
    if (!checkReport.passed) {
      throw new Error('导出脱敏校验未通过：检测到宿主机绝对路径残留，已中止落盘');
    }

    fs.mkdirSync(options.outDir, { recursive: true });
    for (const fileItem of pendingWrites) {
      //M 原子落盘各份已通过脱敏校验的 Markdown 文件。
      writeTextAtomic(fileItem.absPath, fileItem.content);
    }
    const manifestPath = path.join(options.outDir, 'manifest.json');
    //M 原子落盘导出清单 manifest.json。
    writeTextAtomic(manifestPath, `${JSON.stringify(draftManifest, null, 2)}\n`);
    return draftManifest;
  }

  /**
   * 定位目标已连接账号并读取该会话的历史消息。
   */
  private async resolveAccountAndHistory(
    explicitAccount: string | undefined,
    chatQuery: string,
    limit: number,
  ): Promise<{
    accountId: string;
    username: string;
    displayName: string;
    isGroup: boolean;
    messages: readerModule.RawMessage[];
  }> {
    //M 读取当前已连接的全部微信账号。
    const connected = this.reader.accounts();
    if (connected.length === 0) {
      throw new Error('当前没有已连接的微信账号，请先完成账号连接');
    }

    if (explicitAccount !== undefined) {
      const exists = connected.some((acc) => acc.id === explicitAccount);
      if (!exists) {
        throw new Error('指定的 --account 微信账号尚未连接');
      }
      //M 在显式指定的账号下查询目标会话记录。
      const hit = await this.reader.readChatHistory(explicitAccount, chatQuery, limit);
      if (hit === undefined) {
        throw new Error('在指定微信账号中未找到该会话');
      }
      return { accountId: explicitAccount, ...hit };
    }

    const matches: Array<{
      accountId: string;
      username: string;
      displayName: string;
      isGroup: boolean;
      messages: readerModule.RawMessage[];
    }> = [];
    for (const acc of connected) {
      //M 逐个已连接账号尝试匹配目标会话。
      const hit = await this.reader.readChatHistory(acc.id, chatQuery, limit);
      if (hit !== undefined) {
        //M 记录命中该会话的账号结果。
        matches.push({ accountId: acc.id, ...hit });
      }
    }

    if (matches.length === 0) {
      throw new Error('未找到匹配的微信会话，请核对会话名或 wxid');
    }
    if (matches.length > 1) {
      throw new Error('多个已连接微信账号均包含同名会话，请通过 --account 明确指定账号');
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
      //M 写入本卷消息覆盖的起止日期时间。
      lines.push(`- 时间范围：${first.dateText} ${first.timeText} 至 ${last.dateText} ${last.timeText}（UTC+8）`);
    }
    //M 插入头部元信息与正文之间的分隔空行。
    lines.push('');

    if (items.length === 0) {
      //M 空会话写入明确提示行。
      lines.push('_（暂无消息记录）_', '');
      return lines.join('\n');
    }

    let currentDate = '';
    for (const item of items) {
      if (item.dateText !== currentDate) {
        currentDate = item.dateText;
        //M 按日期变化插入二级标题。
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

      //M 写入带时分秒的发言人标题与消息正文段落。
      lines.push(`**[${item.timeText}] ${item.speaker}**`, renderedBody, '');
    }
    return lines.join('\n');
  }
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
      //M 将消息归入所属月份分卷。
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
    //M 按顺序切出固定条数分卷。
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
  for (const chunk of chunks) {
    //M 追加指向各分卷相对路径的目录列表项。
    lines.push(`- [${chunk.id}](${chunk.file})（${String(chunk.count)} 条）`);
  }
  //M 末尾保留标准换行。
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
  //M 初始化只读微信引擎与临时语音转码缓存目录，执行显式导出。
  const reader = new readerModule.Reader(options.dataDir, options.atNames, undefined, options.engineDir);
  const voiceCacheDir = path.join(options.dataDir, 'message');
  const voiceCache = new voiceModule.VoiceAudio(reader, voiceCacheDir);
  const exporter = new ChatExporter(reader, voiceCache);
  return await exporter.exportChat(options);
}
