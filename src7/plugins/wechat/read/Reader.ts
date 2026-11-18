/**
 * 读微信：调积木客服的只读引擎 wechat_cli（Python），拿账号、最近会话、增量消息。
 * 引擎和它的运行时放在 program/wechat/（照 jimukefu 的目录：python/、runtime/env/python/、runtime/data/），本插件只当子进程调，不改它。
 * 原理（jimukefu python/wechat_cli/commands/sync.py:187-325）：用账号目录里的密钥解密本机微信 4.x 的数据库副本，按会话读消息表，输出 JSON。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';


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
  view?: { kind?: string; text?: string; sender?: string; title?: string; desc?: string; seconds?: number; amount?: string; quote?: { name?: string; text?: string } };
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


/** 只读引擎的调用方。 */
export class Reader {
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
      .map((item) => ({ id: String(item['id']), nickname: String(item['nickname'] ?? ''), wxid: String(item['wxid'] ?? '') }));
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
    const relative = path.join('runtime', 'data', account, `jmbots_poll_${String(process.pid)}_${String(++this.seq)}.json`);
    fs.mkdirSync(path.dirname(path.join(this.root, relative)), { recursive: true });
    fs.writeFileSync(path.join(this.root, relative), JSON.stringify({ chats, initial_limit: 50, limit: 500 }));
    try {
      const parsed = JSON.parse(await this.run(account, ['sync-batch', '--request', relative])) as { results?: SyncResult[] };
      return parsed.results ?? [];
    } finally {
      fs.rmSync(path.join(this.root, relative), { force: true });
    }
  }

  /**
   * 取某个时间之前的一批历史消息（只读，jimukefu python/wechat_cli/commands/backfill.py）：create_time < until 的最近 limit 条，升序。
   * 2026-11-14 23:15 EST：给工具 wechat_history 用——库里存的不够时，模型要读更早的就从微信里补。
   */
  async backfill(account: string, chat: string, until: number, limit: number): Promise<SyncResult> {
    //M 用最早已知时间继续向前读取，把这批旧消息交给调用方入库。
    return JSON.parse(await this.run(account, ['backfill', chat, '--until-time', String(until), '--limit', String(limit)])) as SyncResult;
  }

  /**
   * 取一张图片的缩略图（只读，jimukefu python/wechat_cli/commands/media.py 的 op=image）：解密后写到 runtime/data/<账号>/media/jmbots/，交回文件路径和类型。
   * 已经取过的直接用缓存。
   */
  async image(account: string, chat: string, source: string, localId: number): Promise<{ file: string; mime: string }> {
    const relative = path.join('runtime', 'data', account, 'media', 'jmbots', `${source.replace(/[^\w-]/gu, '_')}_${String(localId)}.img`);
    const file = path.join(this.root, relative);
    const meta = `${file}.mime`;
    if (fs.existsSync(file) && fs.existsSync(meta)) return { file, mime: fs.readFileSync(meta, 'utf8') };
    const request = path.join('runtime', 'data', account, `jmbots_media_${String(process.pid)}_${String(++this.seq)}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(this.root, request), JSON.stringify({ op: 'image', chat, source, local_id: localId, out: relative, thumb: true }));
    let result: { ok?: boolean; mime?: string };
    try {
      //M 用临时请求指明要读取的图片，返回是否成功及其媒体类型。
      result = JSON.parse(await this.run(account, ['media', '--request', request])) as { ok?: boolean; mime?: string };
    } finally {
      fs.rmSync(path.join(this.root, request), { force: true });
    }
    let mime = 'image/jpeg';
    if (typeof result.mime === 'string' && result.mime.startsWith('image/')) {
      mime = result.mime;
    }
    fs.writeFileSync(meta, mime);
    return { file, mime };
  }

  /** 每个账号一条 Promise 链（链尾）。 */
  private readonly queues = new Map<string, Promise<unknown>>();

  //M 2026-11-15 00:46 EST：poll 的 sync-batch、backfillAll、页面当场同步原来各自起 python 并发；引擎原地改写 runtime/cache 的解密缓存、不加锁（jimukefu db_cache.py:196），并发会读坏。
  /** 同一账号的引擎调用排队挨个跑，不同账号并行；某次失败不卡后面的。 */
  private run(account: string, args: string[]): Promise<string> {
    //M 让当前请求接在同账号的上一个请求之后，即使上一条失败也继续。
    const next = (this.queues.get(account) ?? Promise.resolve()).catch(() => undefined).then(() => this.exec(account, args));
    this.queues.set(account, next);

    //M 完成后只清理仍指向自己的队尾，避免丢掉随后排进来的请求。
    void next.catch(() => undefined).then(() => { if (this.queues.get(account) === next) this.queues.delete(account); });
    return next;
  }

  /**
   * 跑 python -B -s -m wechat_cli.portable_entry 参数…，交回 stdout。只经 run 调（排队）。
   * 环境变量照 jimukefu src/services/Python.ts:71-87：运行目录、临时目录、编码都锁在引擎目录里。
   * @throws 超时、退出码不是 0 时抛错（原来带 stderr 最后一段；2026-11-14 20:10 起只带退出码和脱敏的简短原因，stderr 记进服务日志）。
   */
  private async exec(account: string, args: string[]): Promise<string> {
    const tmp = path.join(this.root, 'runtime', 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
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
      let detail = String(error);
      if (error instanceof Error) {
        detail = error.message;
      }
      console.error(`微信引擎拉不起来（wechat_cli ${command}）：${detail}`);
      throw new Error(`微信引擎拉不起来（wechat_cli ${command}）：python 不在或没权限启动`);
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, TIMEOUT_MS);
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0 || timedOut) {
      const tail = err.trim().split(/\r?\n/u).slice(-8).join('\n');
      //G 日志里也不留账号号码、wxid、昵称：这几样都换成 ***。
      let safeTail = tail;
      const secrets = [account, ...this.accounts().flatMap((item) => [item.id, item.wxid, item.nickname])].filter((value) => value.length >= 2);
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
