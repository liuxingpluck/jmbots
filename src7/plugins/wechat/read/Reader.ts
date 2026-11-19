/**
 * 读微信：调积木客服的只读引擎 wechat_cli（Python），拿账号、最近会话、增量消息。
 * 引擎和它的运行时放在 program/wechat/（照 jimukefu 的目录：python/、runtime/env/python/、runtime/data/），本插件只当子进程调，不改它。
 * 原理（jimukefu python/wechat_cli/commands/sync.py:187-325）：用账号目录里的密钥解密本机微信 4.x 的数据库副本，按会话读消息表，输出 JSON。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import * as filesModule from '../../../utils/Files.ts';
import * as textModule from '../../../utils/Text.ts';


/** 一个微信账号（runtime/data/accounts.yaml 里 status 是 connected 的）。 */
export interface Account {
  id: string;
  nickname: string;
  wxid: string;
}

/** 最近会话里的一个（wechat_cli sessions 的输出，jimukefu sessions.py:55-65）。 */
export interface ChatItem {
  username: string;
  chat: string;
  is_group: boolean;
  unread: number;
  last_message: string;
  timestamp: number;
}

/** 一条消息（sync 的输出，jimukefu sync.py:217-228）。view 是气泡视图：kind、text、群里还有 sender。 */
export interface RawMessage {
  source: string;
  local_id: number;
  local_type: number;
  create_time: number;
  from_self: boolean | null;
  at_me: boolean;
  //M 2026-11-14 23:30 EST：气泡视图的其余字段（jimukefu python/wechat_cli/core/msgview.py）：图片、语音、链接卡片等。
  view?: {
    kind?: string; text?: string; sender?: string; title?: string; desc?: string; seconds?: number; amount?: string;
    quote?: { name?: string; text?: string };
  };
}

/** sync-batch 里一个会话的结果。 */
export interface SyncResult {
  chat: string;
  missing: boolean;
  error?: string;
  is_group?: boolean;
  chat_display?: string;
  messages?: RawMessage[];
}

/** 定位语音必须同时核对微信会话、来源分片和消息编号。 */
export interface VoiceMessage {
  /** 微信账号。 */
  account: string;
  /** 这条消息所在的会话。 */
  chat: string;
  /** 消息所在的分片。 */
  source: string;
  /** 该分片里的消息编号。 */
  localId: number;
}

type MediaKind = 'image' | 'voice';

/** 已确认成功的媒体回执。 */
interface MediaResult {
  /** 引擎给出的媒体类型。 */
  mime?: string;
}

/** 已落盘并可供客服页读取的缩略图。 */
interface ImageFile {
  /** 缩略图文件。 */
  file: string;
  /** 图片媒体类型。 */
  mime: string;
}

/** 可直接回给客服页的脱敏原因，附供日志定位的错误码和退出码。 */
export class MediaUnavailable extends Error {
  /** 页面文案、固定原因码和已知的引擎退出码。 */
  constructor(message: string, readonly code = 'unavailable', readonly exitCode?: number) {
    super(message);
  }
}

/** 保留语音解码器对格式、时长等错误的归类。 */
export class VoiceUnavailable extends MediaUnavailable {}

const MEDIA_REASONS = new Map([
  ['bad_request', '微信引擎无法识别这条媒体请求'],
  ['internal', '微信引擎处理媒体时出错'],
  ['need_image_key', '取不到图片：缺少微信图片解密密钥'],
  ['decrypt_failed', '取不到图片：图片解密失败'],
  ['not_silk', '原音频格式无法解码'],
  ['ambiguous', '无法确认原音频属于本会话'],
]);

/** 只接受约定的错误码。引擎的原始输出可含聊天内容和本机路径。 */
function getMediaFailure(kind: MediaKind, code: unknown, exitCode: number): MediaUnavailable {
  if (code === 'not_found') {
    if (kind === 'image') return new MediaUnavailable('取不到图片：微信未保存这张图片', code, exitCode);

    return new MediaUnavailable('微信未保存原音频', code, exitCode);
  }
  if (code === 'unknown_op') {
    if (kind === 'image') return new MediaUnavailable('当前微信引擎没有图片读取入口', code, exitCode);

    return new MediaUnavailable('当前微信引擎没有语音读取入口', code, exitCode);
  }
  if (typeof code === 'string') {
    const message = MEDIA_REASONS.get(code);
    if (message !== undefined) return new MediaUnavailable(message, code, exitCode);
  }

  return new MediaUnavailable('微信引擎未提供可识别的媒体原因', 'unknown_media_error', exitCode);
}

/** 校验退出状态及 stdout 的回执。非法或未知内容不回显。 */
function readMediaResult(kind: MediaKind, out: string, exitCode: number, timedOut: boolean): MediaResult {
  if (timedOut) {
    throw new MediaUnavailable('微信引擎读取媒体超时', 'timeout', exitCode);
  }
  if (exitCode !== 0 && exitCode !== 1) {
    throw new MediaUnavailable('微信引擎异常退出', 'engine_exit', exitCode);
  }

  let result: unknown;
  try {
    result = JSON.parse(out);
  } catch {
    throw new MediaUnavailable('微信引擎未返回可识别的媒体回执', 'invalid_response', exitCode);
  }
  if (result !== null && typeof result === 'object' && 'ok' in result) {
    //M media 在 stdout 写失败回执，再以退出码 1 结束。
    if (result.ok === false && 'error' in result) {
      throw getMediaFailure(kind, result.error, exitCode);
    }

    if (exitCode === 0 && result.ok === true) {
      if ('mime' in result && typeof result.mime === 'string') return { mime: result.mime };

      return {};
    }
  }

  throw new MediaUnavailable('微信引擎未返回可识别的媒体回执', 'invalid_response', exitCode);
}


/**
 * 引擎失败的简短原因，只按 stderr 里的异常类型归类，不带原文（原文里可能有人名、消息、账号目录）。
 * @param err 引擎的 stderr。
 * @param timedOut 是不是超时被停的。
 */
function getReason(err: string, timedOut: boolean): string {
  if (timedOut) return `超时（${String(TIMEOUT_MS / 1000)} 秒）`;
  if (/PermissionError|Access is denied|拒绝访问|EACCES|EPERM/u.test(err)) return '没有权限（读写引擎目录或微信数据被拒）';
  if (/FileNotFoundError|No such file|找不到/u.test(err)) return '找不到文件（引擎、密钥或微信数据目录）';
  if (/ModuleNotFoundError|ImportError/u.test(err)) return '引擎缺 Python 模块';
  if (/database is locked|sqlite3\.OperationalError/u.test(err)) return '微信数据库读不了（被占用或解密失败）';
  //G 其余情况只摘取异常类别，供界面解释引擎失败。
  const kind = /(?:^|\n)\s*([A-Za-z_][\w.]*(?:Error|Exception))\b/u.exec(err)?.[1];
  if (kind !== undefined) return `引擎报错 ${kind}`;

  return '引擎报错（详见服务日志）';
}


/** 子进程最长跑多久，毫秒。解密首次要久一点。 */
const TIMEOUT_MS = 120_000;
const MEDIA_RETRY_MS = 30_000;
const MEDIA_FAILURE_LIMIT = 512;

/** 同一媒体共用进行中的读取。短暂复用失败，成功仍由既有文件缓存负责。 */
export class MediaAttempts<T> {
  private readonly pending = new Map<string, Promise<T>>();
  private readonly failures = new Map<string, {
    /** 本次读取的失败结果。 */
    readonly error: unknown;
    /** 可重新读取的时间戳，毫秒。 */
    readonly retryAt: number;
  }>();

  constructor(private readonly kind: MediaKind) {}

  /** 返回进行中的读取或仍有效的失败。到期后让调用方再发起读取。 */
  getCached(key: string): Promise<T> | undefined {
    const active = this.pending.get(key);
    if (active !== undefined) return active;

    const failure = this.failures.get(key);
    if (failure === undefined) return undefined;
    if (failure.retryAt > Date.now()) return Promise.reject(failure.error);

    //M 窗口过去后允许重新取，微信刚同步下来的媒体仍可恢复。
    this.failures.delete(key);
  }

  /** 登记新读取，失败时记录一次诊断并在短时间内复用原来的结果。 */
  async track(key: string, attempt: Promise<T>): Promise<T> {
    this.pending.set(key, attempt);
    try {
      return await attempt;
    } catch (error) {
      //G 只记固定错误类别，省去可能含聊天内容、账号和路径的引擎输出或 I/O 错误。
      let detail = 'unavailable';
      if (error instanceof MediaUnavailable) {
        detail = error.code;
        if (error.exitCode !== undefined) {
          detail += `，退出码 ${String(error.exitCode)}`;
        }
      }
      console.error(`微信媒体读取失败（${this.kind}）：${detail}`);

      //M 仅保留有限数量的失败记录，批量浏览旧聊天不会无限增长。
      if (this.failures.size >= MEDIA_FAILURE_LIMIT) {
        const oldest = this.failures.keys().next().value;
        if (oldest !== undefined) this.failures.delete(oldest);
      }
      const retryAt = Date.now() + MEDIA_RETRY_MS;
      this.failures.set(key, { error, retryAt });
      throw error;
    } finally {
      this.pending.delete(key);
    }
  }
}


/** 只读引擎的调用方。 */
export class Reader {
  private readonly images = new MediaAttempts<ImageFile>('image');
  /**
   * @param root 引擎目录：里面有 python/ 和 runtime/。
   * @param python 跑 wechat_cli 的 python.exe。
   * @param atNames 推断“@我”用的额外群昵称，逗号分隔。
   */
  constructor(readonly root: string, readonly python: string, private readonly atNames: string) {}

  /** 请求文件的序号。 */
  private seq = 0;

  /** 已连接的账号。accounts.yaml 不在时是空的。 */
  accounts(): Account[] {
    const file = path.join(this.root, 'runtime', 'data', 'accounts.yaml');
    if (!fs.existsSync(file)) return [];

    const list = (yaml.parse(fs.readFileSync(file, 'utf8')) ?? []) as Record<string, unknown>[];
    return list.filter((item) => item['status'] === 'connected')
      .map((item) => ({
        id: String(item['id']), nickname: String(item['nickname'] ?? ''), wxid: String(item['wxid'] ?? ''),
      }));
  }

  /** 最近会话，最近的在前。 */
  async sessions(account: string, limit: number): Promise<ChatItem[]> {
    //M 读取指定账号的最近会话，作为轮询比对同步进度的输入。
    return JSON.parse(await this.run(account, ['sessions', '--limit', String(limit)])) as ChatItem[];
  }

  /**
   * 一个进程里同步多个会话。since 是上次同步到的秒级时间；null 表示第一次，取最近 initial 条（存量，不当新消息）。
   * 请求写成文件（引擎只收项目内的请求文件，jimukefu sync.py:281-289）。
   */
  async syncBatch(account: string, chats: { chat: string; since: number | null }[]): Promise<SyncResult[]> {
    //M 2026-11-14 23:40 EST：请求文件名带进程号和序号、用完删掉——后台轮询和页面当场同步、正式版和测试版不会互相覆盖同一个文件。
    const relative = path.join(
      'runtime', 'data', account, `jmbots_poll_${String(process.pid)}_${String(++this.seq)}.json`,
    );
    const requestFile = path.join(this.root, relative);
    const requestDir = path.dirname(requestFile);
    //M 确保同步请求文件的目录存在。
    filesModule.ensureDir(requestDir);
    fs.writeFileSync(requestFile, JSON.stringify({ chats, initial_limit: 50, limit: 500 }));
    try {
      const parsed = JSON.parse(
        await this.run(account, ['sync-batch', '--request', relative]),
      ) as { results?: SyncResult[] };
      return parsed.results ?? [];
    } finally {
      fs.rmSync(requestFile, { force: true });
    }
  }

  /**
   * 取某个时间之前的一批历史消息（只读，jimukefu python/wechat_cli/commands/backfill.py）：create_time < until 的最近 limit 条，升序。
   * memory_get 读取微信归档时，库里缺少的早期记录从微信里补。
   */
  async backfill(account: string, chat: string, until: number, limit: number): Promise<SyncResult> {
    //M 用最早已知时间继续向前读取，把这批旧消息交给调用方入库。
    return JSON.parse(
      await this.run(account, ['backfill', chat, '--until-time', String(until), '--limit', String(limit)]),
    ) as SyncResult;
  }

  /**
   * 取一张图片的缩略图（只读，jimukefu python/wechat_cli/commands/media.py 的 op=image）：
   * 解密后写到 runtime/data/<账号>/media/jmbots/，交回文件路径和类型。
   * 已经取过的直接用缓存。
   */
  image(account: string, chat: string, source: string, localId: number): Promise<ImageFile> {
    //M 合并相同账号、会话、分片和消息号的请求，避免同账号排队时又排进重复项。
    const key = JSON.stringify([account, chat, source, localId]);
    const known = this.images.getCached(key);
    if (known !== undefined) return known;

    //M 只有首次请求需要检查文件缓存或调用引擎。
    const attempt = this.loadImage(account, chat, source, localId);
    return this.images.track(key, attempt);
  }

  private async loadImage(account: string, chat: string, source: string, localId: number): Promise<ImageFile> {
    const relative = path.join(
      'runtime', 'data', account, 'media', 'jmbots', `${source.replace(/[^\w-]/gu, '_')}_${String(localId)}.img`,
    );
    const file = path.join(this.root, relative);
    const meta = `${file}.mime`;
    if (fs.existsSync(file) && fs.existsSync(meta)) return { file, mime: fs.readFileSync(meta, 'utf8') };
    const request = path.join(
      'runtime', 'data', account, `jmbots_media_${String(process.pid)}_${String(++this.seq)}.json`,
    );
    const imageDir = path.dirname(file);
    //M 为引擎输出缩略图准备目录。
    filesModule.ensureDir(imageDir);
    fs.writeFileSync(
      path.join(this.root, request),
      JSON.stringify({ op: 'image', chat, source, local_id: localId, out: relative, thumb: true }),
    );
    let result: MediaResult;
    try {
      //M 接收媒体状态和类型。失败回执直接交给客服页。
      const args = ['media', '--request', request];
      result = await this.run(account, args, 'image');
    } finally {
      fs.rmSync(path.join(this.root, request), { force: true });
    }
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size === 0) {
      throw new MediaUnavailable('取不到图片：未生成图片文件', 'missing_output');
    }

    let mime = 'image/jpeg';
    if (typeof result.mime === 'string' && result.mime.startsWith('image/')) {
      mime = result.mime;
    }
    fs.writeFileSync(meta, mime);
    return { file, mime };
  }

  /**
   * 请微信引擎按消息键提取 SILK。
   * @param message 按微信账号、会话、来源分片和编号查出的语音消息。
   * @returns 完整的 SILK 字节。取不到时抛出一句可用于语音气泡的原因。
   * 副作用：在引擎目录开临时请求及输出文件，读完即清理。
   */
  async voice(message: VoiceMessage): Promise<Buffer> {
    //M 沿用微信引擎的 media/voice，临时输出和正式音频缓存分开。
    const id = crypto.randomUUID();
    const base = path.join('runtime', 'tmp', `jmbots_voice_${id}`);
    const relative = `${base}.json`;
    const output = `${base}.silk`;
    const request = path.join(this.root, relative);
    const extracted = path.join(this.root, output);
    const payload = {
      op: 'voice',
      chat: message.chat,
      source: message.source,
      local_id: message.localId,
      out: output,
    };
    fs.mkdirSync(path.dirname(request), { recursive: true });
    const encoded = JSON.stringify(payload);
    fs.writeFileSync(request, encoded, { mode: 0o600, flag: 'wx' });
    try {
      //M 引擎只在同一账号内排队执行，取音失败的结构化结果给页面说明。
      const args = ['media', '--request', relative];
      const result = await this.run(message.account, args, 'voice');

      if (result.mime !== undefined && result.mime !== 'audio/silk') {
        //G 引擎返回的其他格式不交给 SILK 解码器。
        throw new VoiceUnavailable('原音频格式无法解码', 'invalid_mime');
      }
      //G 没有输出或输出过大时，只保留消息说明。
      const size = fs.statSync(extracted, { throwIfNoEntry: false })?.size ?? 0;
      if (size < 10 || size > 2 * 1024 * 1024) {
        throw new VoiceUnavailable('微信原音频丢失或大小异常', 'invalid_output');
      }

      return fs.readFileSync(extracted);
    } finally {
      fs.rmSync(request, { force: true });
      fs.rmSync(extracted, { force: true });
    }
  }

  /** 每个账号一条 Promise 链（链尾）。 */
  private readonly queues = new Map<string, Promise<unknown>>();

  //M 2026-11-15 00:46 EST：poll 的 sync-batch、backfillAll、页面当场同步原来各自起 python 并发；
  //M 引擎原地改写 runtime/cache 的解密缓存、不加锁（jimukefu db_cache.py:196），并发会读坏。
  /** 同一账号的引擎调用排队挨个跑，不同账号并行；某次失败不卡后面的。 */
  private run(account: string, args: string[]): Promise<string>;
  private run(account: string, args: string[], media: MediaKind): Promise<MediaResult>;
  private run(account: string, args: string[], media?: MediaKind): Promise<string | MediaResult> {
    //M 让当前请求接在同账号的上一个请求之后，即使上一条失败也继续。
    const next = (this.queues.get(account) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.exec(account, args, media));
    this.queues.set(account, next);

    //M 完成后只清理仍指向自己的队尾，避免丢掉随后排进来的请求。
    void next.catch(() => undefined).then(() => {
      if (this.queues.get(account) === next) this.queues.delete(account);
    });
    return next;
  }

  /**
   * 跑 python -B -s -m wechat_cli.portable_entry 参数…，交回 stdout。只经 run 调（排队）。
   * 环境变量照 jimukefu src/services/Python.ts:71-87：运行目录、临时目录、编码都锁在引擎目录里。
   * @throws 超时、退出码不是 0 时抛错（原来带 stderr 最后一段；2026-11-14 20:10 起只带退出码和脱敏的简短原因，stderr 记进服务日志）。
   */
  private async exec(account: string, args: string[], media?: MediaKind): Promise<string | MediaResult> {
    const tmp = path.join(this.root, 'runtime', 'tmp');
    //M 引擎使用这个目录存放自己的临时文件。
    filesModule.ensureDir(tmp);
    const env: Record<string, string | undefined> = {
      ...process.env, JIMUKEFU_RUNTIME_DIR: path.join(this.root, 'runtime'), JIMUKEFU_ACCOUNT: account,
      JIMUKEFU_AT_NAMES: this.atNames, PYTHONPATH: path.join(this.root, 'python'), PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', TEMP: tmp, TMP: tmp, TMPDIR: tmp,
    };
    delete env['PYTHONHOME'];
    const command = args[0] ?? '';
    //M 2026-11-14 20:10（Claude 19:58 第 6 节第 4 条）：引擎失败时，退出码和 stderr 最后几行记进服务日志（账号号码换成 ***）；
    //M   抛出去的只是一句脱敏的简短原因（不带人名、消息、路径），页面和接口看到的就是它。仍然只读，不发送。
    const spawn = () => Bun.spawn([this.python, '-B', '-s', '-m', 'wechat_cli.portable_entry', ...args], {
      cwd: this.root, env, stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn();
    } catch (error) {
      if (media !== undefined) {
        throw new MediaUnavailable('找不到微信引擎或没有启动权限', 'engine_start_failed');
      }
      const detail = textModule.getErrorMessage(error);
      console.error(`微信引擎拉不起来（wechat_cli ${command}）：${detail}`);
      //G 回给界面原有提示，同时让排查能追到启动异常。
      const options = { cause: error };
      throw new Error(`微信引擎拉不起来（wechat_cli ${command}）：python 不在或没权限启动`, options);
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, TIMEOUT_MS);
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    clearTimeout(timer);
    //M 图片和语音共用 CLI 的 stdout 回执，错误由媒体请求记录一次。
    if (media !== undefined) return readMediaResult(media, out, code, timedOut);

    if (code !== 0 || timedOut) {
      const tail = err.trim().split(/\r?\n/u).slice(-8).join('\n');
      //G 日志里也不留账号号码、wxid、昵称：这几样都换成 ***。
      let safeTail = tail;
      const secrets = [account, ...this.accounts().flatMap((item) => [item.id, item.wxid, item.nickname])]
        .filter((value) => value.length >= 2);
      for (const value of secrets) safeTail = safeTail.replaceAll(value, '***');
      let timeoutNote = '';
      if (timedOut) {
        timeoutNote = '，超时被停';
      }
      console.error(`微信引擎失败（wechat_cli ${command}）：退出码 ${String(code)}${timeoutNote}；stderr 最后几行：\n${safeTail}`);
      throw new Error(`微信引擎失败（wechat_cli ${command}）：退出码 ${String(code)}，${getReason(err, timedOut)}`);
    }

    return out;
  }
}
