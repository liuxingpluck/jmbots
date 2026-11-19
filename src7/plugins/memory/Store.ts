/**
 * 记忆库（客服用）：把聊天记录、知识库文件喂给检索后端（Backend.ts），再按客户、会话、机器人搜，交回能引用的条目。
 * - 聊天记录：有渠道、没有 parent 的会话（用户看得到的），用户的话和机器人回的文字，一条消息一段（长的切开）。
 * - 知识库：运行时目录 knowledge/（公共）和 bots/<机器人>/knowledge/（自己的）下的 .md、.txt，按段切，记行号；
 *   文件改了、删了，下次搜之前（最多 30 秒一次）或 POST /api/memory/knowledge 之后重建那个文件的片段。
 * - 客户：渠道:用户（customerFrom / getCustomer）。飞书私聊是 feishu:<open_id>，飞书群是 feishu:group:<chat_id>（按群一场，不按发言人）；
 *   微信是 wechat:<会话 username>（也是按聊天一场）；网页（渠道名 http）没有登录是 http:本机。
 *   address 里有 customer 就用；否则再看 userId、openId、user。插件也可以直接在会话记录上写 customer（账号合并时写成合并后的主号）。
 * 设计：docs/src7插件设计/memory.md 第 11 节。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type { Database } from 'bun:sqlite';
import type { SessionRow } from '../../Sessions.ts';
import * as backendModule from './Backend.ts';
import * as graphPolicy from './GraphPolicy.ts';
import * as filesModule from '../../utils/Files.ts';


declare module '../../Sessions.ts' {
  interface SessionRow {
    /** 客户：渠道:用户。不写就照渠道和 address 推（getCustomer）。 */
    customer?: string;
    /** 记忆库已经收到第几条消息（不含）：重启、续聊不重复收。 */
    memoryIndexed?: number;
  }
}


/** 一段最多几个字，长的切开。 */
const CHUNK_CHARS = 800;
/** 知识库同步最少隔多久。 */
const SYNC_EVERY_MS = 30_000;
/** 知识库文件最大多少字节，大的跳过。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;


/** 检索聊天记录却没有客户号时的报错（给模型、接口看）。 */
export const NO_CUSTOMER = '检索聊天记录必须带客户号（渠道:用户），这场会话没有客户，不能搜；只查公共知识库用 knowledge';


/** 记忆库。 */
export class Store {
  /** 上次同步知识库的时刻。 */
  private syncedAt = 0;
  /** 正在同步（并发的等同一个）。 */
  private syncing: Promise<void> | undefined;

  /**
   * @param backend 检索后端。
   * @param root 运行时根目录（找 knowledge/、bots/*\/knowledge/）。
   * @param db 记知识库文件的修改时间（memory_files 表）。
   * @param policy 聊天记录进不进关系图（memory.history_graph / no_graph_customers）；不给 = 都进。
   * @param knowledgeBackend 统一检索所用的知识库写入端点，默认沿用原后端。
   */
  constructor(
    readonly backend: backendModule.MemoryBackend,
    private readonly root: string,
    private readonly db: Database,
    private readonly policy: graphPolicy.GraphPolicy = graphPolicy.GRAPH_ALL,
    private readonly knowledgeBackend = backend,
  ) {
    //M 建表记知识库文件的修改时间和大小：同步时靠它判断哪些文件新了、改了。
    db.exec('CREATE TABLE IF NOT EXISTS memory_files (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL)');
  }

  /**
   * 会话里新接的消息收进聊天记录：从 row.memoryIndexed 收到最后，收完更新它（调用的负责存会话）。
   * @param row 会话记录（有渠道、没有 parent 的才收）。
   * @returns 收了几段。
   */
  async ingestSession(row: SessionRow): Promise<number> {
    const meta = row as SessionRow & { bot?: string; channel?: string };
    if (meta.channel === undefined || row.parent !== undefined) return 0;
    const from = row.memoryIndexed ?? 0;
    const docs: backendModule.MemoryDoc[] = [];
    row.messages.slice(from).forEach((message, offset) => {
      if (message.role !== 'user' && message.role !== 'assistant') return;
      const text = message.role === 'user' ? piAi.contentText(message.content)
        : message.content.filter((block) => block.type === 'text').map((block) => (block.type === 'text' ? block.text : '')).join('\n');
      if (text.trim() === '') return;
      const index = from + offset;

      //M 长的话切成 800 字一段，一段一条记录，都记同一个消息编号（start、end）。
      for (const piece of chunks(text)) {
        //M 按 history_graph / no_graph_customers 打标记：不进图的带 graph: false（外部服务照样收、能搜，只是不抽关系）。
        docs.push(graphPolicy.markGraph(this.policy, {
          source: `session:${row.id}`, scope: 'history', bot: meta.bot ?? '', customer: getCustomer(row), session: row.id,
          title: message.role === 'user' ? '用户说' : '机器人答', text: piece, at: message.timestamp ?? Date.now(), start: index, end: index,
        }));
      }
    });
    row.memoryIndexed = row.messages.length;

    //M 这次新接的几段一起收进检索后端；收的位置已经记在 row 上，调用的人负责存会话。
    if (docs.length > 0) await this.backend.ingest(docs);
    return docs.length;
  }

  /**
   * 搜：知识库先同步一下（最多 30 秒一次）。
   * @param query 要找什么、范围、谁的。
   */
  async search(query: backendModule.MemoryQuery): Promise<backendModule.Citation[]> {
    //G 隔离：碰聊天记录（history、all）的检索必须带客户号，没有就拒绝；不能不带客户去搜，否则会搜到所有客户的。
    //G   只搜公共知识库（knowledge）不用客户号。
    if (query.scope !== 'knowledge' && (query.customer ?? '').trim() === '') throw new Error(NO_CUSTOMER);

    //M 要搜知识库就先同步一下（最多 30 秒一次），新增、改过的文件才搜得到。
    if (query.scope !== 'history') await this.syncKnowledge();

    //M 交给检索后端搜（本地 SQLite 或外部服务），拿回带编号的引用。
    return this.backend.search(query);
  }

  /**
   * 写一篇知识库文件（POST /api/memory/knowledge 用），写完马上重建它的片段。
   * @param bot 机器人；'' 是公共的。
   * @param name 文件名（相对知识库目录，.md、.txt）。
   * @param content 内容。
   * @returns 绝对路径。
   * @throws 名字不对、跑出目录。
   */
  async writeKnowledge(bot: string, name: string, content: string): Promise<string> {
    const dir = bot === '' ? path.join(this.root, 'knowledge') : path.join(this.root, 'bots', bot, 'knowledge');
    const file = path.resolve(dir, name);
    const back = path.relative(dir, file);
    if (back === '' || back.startsWith('..') || path.isAbsolute(back)) throw new Error(`知识库文件只能在 ${dir} 里`);
    if (!/\.(md|txt)$/iu.test(file)) throw new Error('知识库文件要是 .md 或 .txt');
    const parentDir = path.dirname(file);
    //M 写入前确保已校验的知识库子目录存在。
    filesModule.ensureDir(parentDir);
    fs.writeFileSync(file, content, 'utf8');

    //M 文件写好后马上重建它的片段（先删旧的再收新的），不等下次同步，写完就搜得到。
    await this.indexFile(file, bot);
    return file;
  }

  /** 状态：后端的，加知识库文件数。 */
  async health(): Promise<Record<string, unknown>> {
    //M 先数一下已收的知识库文件，再把后端自己的状态摊开，一起交回给网页看。
    const files = (this.db.query('SELECT COUNT(*) AS n FROM memory_files').get() as { n: number }).n;
    return { ...(await this.backend.health()), knowledgeFiles: files };
  }

  /** 同步知识库：新的、改过的重建，删掉的清掉。 */
  async syncKnowledge(force = false): Promise<void> {
    if (!force && Date.now() - this.syncedAt < SYNC_EVERY_MS) return;
    if (this.syncing !== undefined) return this.syncing;
    this.syncing = (async () => {
      //M 扫公共的 knowledge/ 和每个机器人自己的 knowledge/，记下 文件→机器人（公共的是 ''）。
      const found = new Map<string, string>();
      for (const name of scan(path.join(this.root, 'knowledge'))) found.set(name, '');
      const botsDir = path.join(this.root, 'bots');
      const bots = fs.existsSync(botsDir) ? fs.readdirSync(botsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
      for (const bot of bots) for (const name of scan(path.join(botsDir, bot, 'knowledge'))) found.set(name, bot);

      //M 和库里记的修改时间、大小比：新的、改过的文件重建它的片段。
      const known = new Map((this.db.query('SELECT * FROM memory_files').all() as { path: string; mtime: number; size: number }[]).map((row) => [row.path, row]));
      for (const [file, bot] of found) {
        const stat = fs.statSync(file);
        const old = known.get(file);
        if (old === undefined || old.mtime !== Math.floor(stat.mtimeMs) || old.size !== stat.size) await this.indexFile(file, bot);
      }

      //M 库里记着、磁盘上已经没有的文件：删掉它的片段和记录。
      for (const file of known.keys()) {
        if (found.has(file)) continue;
        await this.knowledgeBackend.remove(file);
        this.db.query('DELETE FROM memory_files WHERE path = ?').run(file);
      }
      this.syncedAt = Date.now();
    })().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  /** 重建一个知识库文件的片段：按空行分段，攒到 800 字一段，记起止行号。 */
  private async indexFile(file: string, bot: string): Promise<void> {
    const stat = fs.statSync(file);

    //M 先删这个文件旧的片段，再重建，免得文件改短了还留着旧段。
    await this.knowledgeBackend.remove(file);
    const docs: backendModule.MemoryDoc[] = [];
    if (stat.size <= MAX_FILE_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u);
      let buffer: string[] = [];
      let start = 1;
      const flush = (end: number): void => {
        const text = buffer.join('\n').trim();
        if (text !== '') {
          docs.push({ source: file, scope: 'knowledge', bot, customer: '', session: '', title: path.basename(file), text, at: Math.floor(stat.mtimeMs), start, end });
        }
        buffer = [];
      };
      //M 逐行攒：遇到空行且已攒够半段，或攒满一段，就用 flush 收成一个片段，记下起止行号。
      lines.forEach((line, index) => {
        if (buffer.length === 0) start = index + 1;
        buffer.push(line);
        if ((line.trim() === '' && buffer.join('\n').length >= CHUNK_CHARS / 2) || buffer.join('\n').length >= CHUNK_CHARS) flush(index + 1);
      });

      //M 最后剩下的不够一段，也收成一个片段。
      flush(lines.length);
    }

    //M 这个文件的所有片段一起收进检索后端。
    if (docs.length > 0) await this.knowledgeBackend.ingest(docs);

    //M 记下文件的修改时间和大小，下次同步才知道它没变（超过 2MB 跳过的也记，免得每次重试）。
    this.db.query('INSERT INTO memory_files (path, mtime, size) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size')
      .run(file, Math.floor(stat.mtimeMs), stat.size);
  }
}


/**
 * 从渠道和回话地址推出客户号：渠道:用户。
 * 飞书私聊 feishu:<open_id>；飞书群 feishu:group:<chat_id>（按群，不按发言人；群和私聊不共用一场，免得回话地址被冲掉）。
 * 微信、网页等：address.customer 优先，否则 userId / openId / user，都没有就是 渠道:本机。
 * @param channel 渠道名。
 * @param address 渠道的回话地址。
 * @returns 没有渠道是 ''。
 */
export function customerFrom(channel: string | undefined, address: unknown): string {
  if (channel === undefined || channel === '') return '';
  const where = (typeof address === 'object' && address !== null && !Array.isArray(address) ? address : {}) as Record<string, unknown>;
  if (typeof where['customer'] === 'string' && where['customer'] !== '') return where['customer'];
  if (channel === 'feishu') {
    const chatType = String(where['chatType'] ?? where['chat_type'] ?? '');
    const chatId = String(where['chatId'] ?? where['chat_id'] ?? '');
    const openId = String(where['openId'] ?? where['open_id'] ?? '');
    if (chatType === 'group' && chatId !== '') return `feishu:group:${chatId}`;
    if (openId !== '') return `feishu:${openId}`;
    if (chatId !== '') return `feishu:group:${chatId}`;
  }
  const who = ['userId', 'openId', 'user'].map((key) => where[key]).find((value) => typeof value === 'string' && value !== '');
  return `${channel}:${typeof who === 'string' ? who : '本机'}`;
}


/**
 * 会话的客户：记录上写了 customer 就用；不然照渠道和 address 推（customerFrom）。
 * @param row 会话记录。
 * @returns 没有渠道是 ''。
 */
export function getCustomer(row: SessionRow): string {
  if (typeof row.customer === 'string' && row.customer !== '') return row.customer;
  const meta = row as SessionRow & { channel?: string; address?: unknown };

  //M 记录上没写客户号，就照渠道和回话地址推（飞书私聊、飞书群、微信、网页各有各的算法）。
  return customerFrom(meta.channel, meta.address);
}

/**
 * 搜到的写成给模型看的几行：编号、来源、片段；模型回答时照编号引用。
 * @param hits 搜到的。
 * @returns 没有是 ''。
 */
export function citeText(hits: backendModule.Citation[]): string {
  return hits.map((hit, index) => {
    const when = hit.at > 0 ? new Date(hit.at).toLocaleString('zh-CN', { hour12: false }) : '';
    const where = hit.scope === 'knowledge'
      ? `知识库 @${hit.source}${hit.start > 0 ? ` 第 ${String(hit.start)}–${String(hit.end)} 行` : ''}`
      : `聊天记录 会话 ${hit.session} 第 ${String(hit.start + 1)} 条 · ${hit.title} · 客户 ${hit.customer} · ${when}`;
    return `[${String(index + 1)}] ${where}（像 ${String(hit.score)}）\n    ${hit.snippet}`;
  }).join('\n');
}


/** 长的切成 800 字一段。 */
function chunks(text: string): string[] {
  const chars = [...text.trim()];
  const out: string[] = [];
  for (let at = 0; at < chars.length; at += CHUNK_CHARS) out.push(chars.slice(at, at + CHUNK_CHARS).join(''));
  return out;
}

/** 一个目录下的 .md、.txt（绝对路径）；目录不在是空的。 */
function scan(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return [...new Bun.Glob('**/*.{md,txt}').scanSync({ cwd: dir, onlyFiles: true })].map((name) => path.join(dir, name));
}
