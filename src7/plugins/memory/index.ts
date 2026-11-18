/**
 * 记忆：工具 memory（列、搜、读、写、删机器人自己的记忆和公共记忆），干活的会话第一次调模型前先替模型搜一次。
 * 开场先搜只搜技能目录和基地的记忆库：两个记忆目录 prompt 插件每一步已经整篇拼进系统提示词了，不重复。
 * 配了基地（engine.index_url + engine.memory_libs）就后台跟着文件改动刷新记忆库索引（Libs.ts）。
 * 客服用的记忆库（Store.ts、Backend.ts）：聊天记录按客户、会话、机器人收，知识库文件按段收；工具 memory 的 history、knowledge，
 *   开场先搜也带上“这个客户以前说过的”和知识库；结果带编号、来源、片段，回答时能引用。检索后端可换（本地 SQLite，或外部服务 backend_url）。
 *   HTTP：GET /api/memory/recall、POST /api/memory/knowledge、GET /api/memory/backend。
 * 托管服务（Services.ts）：插件挂上时隐藏拉起 jmbots-memory、vgr，挂在主端口 /memory/、/memory/vgr/ 下；配置 services，见 Services.ts。
 * 关系图（GraphRoutes.ts、GraphStore.ts、GraphSources.ts，原 memory-graph 并入）：GET /graph/、/api/memory-graph/* 与对话附带关系图链接提示。
 * 设计：docs/src7插件设计/memory.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { ChatRequest, Session } from '../../Sessions.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import * as backendModule from './Backend.ts';
import * as channelIndexModule from './ChannelIndex.ts';
import * as graphPolicy from './GraphPolicy.ts';
import * as graphRoutesModule from './GraphRoutes.ts';
import * as libsModule from './Libs.ts';
import * as recall from './Recall.ts';
import * as servicesModule from './Services.ts';
import * as storeModule from './Store.ts';


/** 插件名。 */
export const name = 'memory';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。1.2.0：渠道消息索引（ChannelIndex.ts、工具 channel_search）。
//M 1.2.1：听请求事件 memory/request（record-history、search-history、embed）回 memory/result；前台“先查记忆”的提示（MEMORY_HINT）从 bots 挪来自己加。
export const version = '1.2.1';

/** 用到的服务：resources 拿目录和配置；tools 登记工具；bots 找机器人的记忆目录和语言。 */
export const inject = ['resources', 'tools', 'bots'];


declare module '../../Sessions.ts' {
  interface SessionRow {
    /** 开场先搜到的那一段；'' 是搜过没搜到；没有这一项是还没搜。 */
    recall?: string;
  }
}


/** memory search 时本地最多给几个文件、记忆库最多几条。 */
const SEARCH_HITS = 8;

/** 切不出字组时按词找，最多几行。 */
const WORD_LINES = 40;

/** 记忆库片段最多几个字。 */
const SNIPPET_CHARS = 300;

/** history、knowledge 默认给几条。 */
const CITE_HITS = 8;

/**
 * 前台“先查记忆”的提示（2026-11-18 从 bots/FrontDesk.ts 挪来，契约 #35）：前台这一轮有 memory 工具、又能带私人记忆时加。
 * 没挂 memory 就没有这个工具，也就没有这句，别让模型去调（Claude 11-14 17:34 第 6 节）。
 */
const MEMORY_HINT = '分清两类问题：客户问事实、业务知识（合同、产品、售后负责人、联系方式、组织关系、价格和规则等），'
  + '先调 memory 工具查记忆（action: history 查这个客户的资料和以前的记录，action: knowledge 查知识库），查到就直接带 [编号] 和出处回答，查不到或要多步核实再 hand_session；'
  + '只有问“我们之前（在这场对话里）聊过什么、说过什么”才用 history_search / history_get。';


/** 插件配置（plugins 里 memory 的 config），都可以不写。 */
interface Settings {
  /** 收不收聊天记录，默认收。 */
  history: boolean;
  /** 开场先搜给几条这个客户以前的话、几条知识库；0 不给。 */
  recallHistory: number;
  recallKnowledge: number;
}


/** 记忆插件：工具 memory、开场先搜、前台“先查记忆”的提示。导出给 Events.test.ts 单独建。 */
export class Memory {
  /**
   * 登记工具，挂开场先搜。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param base 基地和库；没配是 undefined。
   */
  constructor(private readonly ctx: cordis.Context, private readonly base: recall.Base | undefined, readonly store: storeModule.Store, private readonly settings: Settings) {
    //M 工具说明照 0.4 原文（src/capabilities/tools/Tools.ts:539-562）。前台也给，但只许 list、search、read（run 里查）。
    ctx.tools.register({
      definition: {
        name: 'memory',
        description: '记忆：你自己的 memory/，加所有机器人共用的公共记忆。scope 默认 own 是你自己的，'
          + 'shared 是公共的；写公共记忆必须明确写 shared。action：list 列出文件；'
          + 'search 找相关的（整句或几个词都行；你的记忆、公共记忆、技能一起搜，配了记忆库也用 RAG 一起搜，'
          + '不用给 scope，每条给文件和命中片段）；read 读一个文件；write 写（覆盖）；delete 删。'
          + 'path 是相对记忆文件夹的路径。索引.md 是记忆概要：增删改记忆时同步改它。'
          + 'history 找这个客户的资料和以前的聊天记录（range：customer 这个客户跟你的所有会话，默认；session 只这一场；只能查当前这个客户的，查不到别的客户）；'
          + 'knowledge 找知识库。这两个每条带编号、来源、片段：回答用到了就写上 [编号] 和来源，没找到就说没找到，不要编。'
          + '客户问事实、业务知识（合同、产品、负责人、联系方式、组织关系、规则等）先用 history 和 knowledge 查。',
        parameters: piAi.Type.Object({
          action: piAi.Type.Union(['list', 'search', 'read', 'write', 'delete', 'history', 'knowledge'].map((value) => piAi.Type.Literal(value)), { description: '做什么' }),
          range: piAi.Type.Optional(piAi.Type.Union(['customer', 'session'].map((value) => piAi.Type.Literal(value)),
            { description: 'history 时：customer 这个客户（默认）、session 这一场' })),
          limit: piAi.Type.Optional(piAi.Type.Number({ description: 'history、knowledge 时最多几条，默认 8' })),
          scope: piAi.Type.Optional(piAi.Type.Union(['own', 'shared'].map((value) => piAi.Type.Literal(value)),
            { description: 'list、read、write、delete 时：own 自己的（默认），shared 公共的' })),
          query: piAi.Type.Optional(piAi.Type.String({ description: 'search、history、knowledge 时：要找什么，整句或几个词' })),
          path: piAi.Type.Optional(piAi.Type.String({ description: 'read、write、delete 时：相对记忆文件夹的路径' })),
          content: piAi.Type.Optional(piAi.Type.String({ description: 'write 时：文件内容' })),
        }),
      },
      kinds: ['front', 'work'],
      //M 模型调 memory 工具时走 this.run，由它按 action 分到 list、search、read、write、delete、history、knowledge。
      run: (args, session) => this.run(args, session),
    });

    //M 听 session/request：每一步调模型前骨架挨个问插件（ctx.serial），前台加“先查记忆”的提示，干活的会话加开场搜到的那段。
    ctx.on('session/request', (request) => this.onRequest(request));

    //M 听 session/message（通知）：用户看得到的会话（有渠道、没有 parent）每接一条就收进聊天记录。收不成只打日志，不挡会话。
    if (settings.history) {
      ctx.on('session/message', (session, message) => {
        if (message.role !== 'user' && message.role !== 'assistant') return;
        void store.ingestSession(session.row).then((count) => {
          if (count > 0) {
            session.save();
          }
        }).catch((error: unknown) => console.error(`记忆库收聊天记录出错：${textModule.getMessage(error)}`));
      });
    }
  }

  /**
   * 响应 session/request。前台：这一轮有 memory 工具、又能带私人记忆，加“先查记忆”的提示（MEMORY_HINT）。
   * 干活的会话（开场先搜）：第一次调模型前搜一次，结果记在 row.recall，以后每一步带同一段。
   * @param request 这一步的请求。
   */
  private async onRequest(request: ChatRequest): Promise<void> {
    const session = request.session;
    const row = session.row;

    //M 前台：前面的插件收掉了 memory 工具（非本人那一轮 approval 收）就不提；不受信的群里也不提（群里大家都看得到回复）。
    if (row.kind === 'front') {
      const hasTool = request.tools.some((tool) => tool.name === 'memory');
      if (hasTool && workspaceModule.privateAllowed(row.address)) {
        request.system.push(MEMORY_HINT);
      }
      return;
    }

    if (row.kind !== 'work') return;
    //G 非本人（builder、guest）、不受信的群里不搜、不带开场先搜的：搜的是用户的记忆库、知识库和以前的聊天。
    if (!workspaceModule.privateAllowed(row.address)) return;

    if (row.recall === undefined) {
      const said = row.messages.filter((message) => message.role === 'user').map((message) => piAi.contentText(message.content)).join('\n');
      const started = Date.now();
      //G 搜不成（基地挂了之类）不挡会话：当没搜到。
      const hits = await Promise.all([recall.local(this.skillRoots(row.bot), said), recall.libs(this.base, said)])
        .then(([own, libs]) => [...own, ...libs]).catch(() => []);

      //M 再搜这个客户以前说过的话和知识库（走 store.search）；搜不成同样当没搜到。
      const cited = await this.openingCitations(row, said).catch(() => []);

      //M 搜到的引用拼成带编号、来源的一段，回答时模型能照着引用。
      let citedText = '';
      if (cited.length > 0) {
        citedText = `# 可能相关的聊天记录和知识库（程序先搜的；回答用到了写上 [编号] 和来源）\n${storeModule.citeText(cited)}`;
      }

      //M 技能目录、记忆库命中的描述加上引用，存在 row.recall 并存会话：以后每一步原样带同一段，不再重搜。
      row.recall = [recall.describe(hits, this.language(row.bot)), citedText].filter((part) => part !== '').join('\n\n');
      session.save();

      //T 跟踪：开场先搜完了。
      const vars = { 会话: session.id, 几条: hits.length, 引用: cited.length, 后端: this.store.backend.name, 用时毫秒: Date.now() - started };
      this.ctx.emit('trace', 'Memory.recall', '开场先搜完了', 'recall.local(技能目录) + recall.libs(记忆库) + store.search(聊天记录、知识库)', vars);
    }
    if (row.recall !== '') {
      request.system.push(row.recall);
    }
  }

  /**
   * 开场先搜的引用：这个客户以前的（不含这一场）几条，知识库几条。
   * @param row 干活的会话。
   * @param said 用户说过的话。
   */
  private async openingCitations(row: Session['row'], said: string): Promise<backendModule.Citation[]> {
    const query = [...said].slice(0, 300).join('');

    //M 取这个会话的客户号：没有客户号（不是客服场景）就不搜聊天记录。
    const customer = storeModule.getCustomer(row);

    //M 搜这个客户以前的话（不含这一场）：多要 2 条，下面要滤掉前台这一轮的原话。
    let history: backendModule.Citation[] = [];
    if (this.settings.recallHistory > 0 && customer !== '') {
      history = await this.store.search({ query, scope: 'history', bot: row.bot, customer, notSession: row.id, limit: this.settings.recallHistory + 2 });
    }
    //M 前台那场也记了这一轮的原话：片段就是这次说的话的，不算“以前说过的”。
    const older = history.filter((hit) => !said.includes(hit.snippet.replace(/^…|…$/gu, ''))).slice(0, this.settings.recallHistory);

    //M 再搜知识库：不分客户，按机器人搜，几条由 recall_knowledge 定。
    let knowledge: backendModule.Citation[] = [];
    if (this.settings.recallKnowledge > 0) {
      knowledge = await this.store.search({ query, scope: 'knowledge', bot: row.bot, limit: this.settings.recallKnowledge });
    }
    return [...older, ...knowledge];
  }

  /**
   * history、knowledge：照范围搜，写成带编号的引用。
   * @param action history 或 knowledge。
   * @param args 模型给的参数（query 必填，limit、range 可选）。
   * @param session 哪场会话：客户号、机器人从它的 row 取。
   * @returns 带编号、来源、片段的引用文字；没找到是一句“没找到”。
   * @throws 没给 query、range 不对、没有客户号时抛错，原因给模型看。
   */
  private async cite(action: 'history' | 'knowledge', args: Record<string, unknown>, session: Session): Promise<string> {
    //G 搜什么必须给，没给直接抛错让模型补。
    const query = required(args, 'query');
    let limit = CITE_HITS;
    if (typeof args['limit'] === 'number' && args['limit'] > 0) {
      limit = Math.min(30, Math.floor(args['limit']));
    }
    const row = session.row;
    const wanted: backendModule.MemoryQuery = { query, scope: action, bot: row.bot, limit };
    if (action === 'history') {
      const range = args['range'] ?? 'customer';
      //G 隔离：聊天记录每次都只搜这个客户的（session 也再加上客户号）；不再有“跟所有人的”（原来的 range: bot 会搜到别的客户，演示隔离题就是这么串的）。
      if (range !== 'customer' && range !== 'session') throw new Error(`range 只能是 customer 或 session，不能是 ${String(range)}：只能查当前这个客户的记录`);

      //M 取这个会话的客户号；没有客户号（不是客服场景）就不能查聊天记录，抛错。
      const customer = storeModule.getCustomer(row);
      if (customer === '') throw new Error(storeModule.NO_CUSTOMER);
      wanted.customer = customer;
      if (range === 'session') {
        wanted.session = row.id;
      }
    }

    //M 照上面定好的范围搜（后端是本地 SQLite 还是外部服务由 store 管），拿到带编号的命中。
    const hits = await this.store.search(wanted);
    //T 跟踪：history、knowledge 搜完了。
    this.ctx.emit('trace', 'Memory.cite', `memory ${action} 搜完了`, 'store.search(query)', { 会话: session.id, 条数: hits.length, 后端: this.store.backend.name, 范围: args['range'] ?? '' });
    if (hits.length === 0) {
      let label = '知识库内容';
      if (action === 'history') {
        label = '聊天记录';
      }
      return `没找到「${query}」相关的${label}`;
    }

    //M 查到了：带编号、来源、片段交回，让模型回答时引用。
    return `找到 ${String(hits.length)} 条（回答用到了写上 [编号] 和来源）：\n${storeModule.citeText(hits)}`;
  }

  /**
   * 工具本体。
   * @param args 模型给的参数（Tools.ts 照定义校验过）。
   * @param session 哪场会话。
   * @returns 给模型看的话。
   * @throws 参数缺了、越界、前台要写都抛错，原因给模型看。
   */
  private async run(args: Record<string, unknown>, session: Session): Promise<string> {
    const action = args['action'] as string;

    //G 会话的机器人要存在：自己的记忆目录（bot.memory）从它取。
    const bot = this.ctx.bots.get(session.row.bot);
    if (bot === undefined) throw new Error(`没有这个机器人：${session.row.bot}`);

    //M 公共记忆目录：所有机器人共用，scope 写 shared 才用它。
    const shared = this.ctx.resources.dir('memory');
    let dir = bot.memory;
    if (args['scope'] === 'shared') {
      dir = shared;
    }
    if (session.row.kind === 'front' && (action === 'write' || action === 'delete')) throw new Error('前台只能 list、search、read');

    if (action === 'list') {
      const names = await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: dir, onlyFiles: true })).catch(() => [] as string[]);
      if (names.length === 0) return '（记忆文件夹是空的）';

      return names.map((item) => item.replace(/\\/gu, '/')).sort().join('\n');
    }
    //M search：自己的记忆、公共记忆、两个技能目录一起搜，配了记忆库也用 RAG 搜。
    if (action === 'search') return this.search(required(args, 'query'), [bot.memory, shared, ...this.skillRoots(bot.name)], session);

    //M history、knowledge：搜这个客户以前的聊天记录、知识库，交回带编号的引用。
    if (action === 'history' || action === 'knowledge') return this.cite(action, args, session);

    //G 剩下的 read、write、delete 都要一个路径：算成绝对路径，越出记忆文件夹或指向文件夹本身就抛错。
    const file = memoryFile(dir, required(args, 'path'));
    if (action === 'read') {
      if (!fs.existsSync(file)) throw new Error(`没有这个记忆文件：${file}`);
      return fs.readFileSync(file, 'utf8');
    }
    if (action === 'write') {
      //G 写的内容必须给，但空串也算（写成空文件），所以 allowEmpty 给 true。
      const content = required(args, 'content', true);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      //M 交回写了多大（utils/Text.ts 的 getSizeText）。
      const bytes = Buffer.byteLength(content, 'utf8');
      const sizeText = textModule.getSizeText(bytes);
      return `已写入记忆 ${file}（${sizeText}）`;
    }
    fs.rmSync(file);
    return `已删除记忆 ${file}`;
  }

  /**
   * memory search：四处按字组打分（短话也算），配了记忆库再用 RAG 搜，两段合起来。
   * @param query 搜什么。
   * @param roots 自己的记忆、公共记忆、两个技能目录。
   * @param session 哪场会话（跟踪用）。
   */
  private async search(query: string, roots: string[], session: Session): Promise<string> {
    //M 先在本地几个目录里按字组打分搜（loose：短话也算），拿命中的文件和行。
    const hits = await recall.local(roots, query, { maxFiles: SEARCH_HITS, loose: true });
    let local = hits.map((hit) => [`@${hit.file}`, ...hit.lines.map((line) => `  …${line}`)].join('\n')).join('\n');

    //G 切不出字组（比如只有两个字母）：退回按词逐行找，最多 40 行。
    if (hits.length === 0 && recall.grams(query).size === 0) {
      local = wordLines(roots, query).join('\n');
    }

    //M 配了基地才再用 RAG 搜记忆库；没配就跳过，只有本地那一段。
    let found: Awaited<ReturnType<typeof recall.searchLibs>> = [];
    if (this.base !== undefined) {
      found = await recall.searchLibs(this.base, query, SEARCH_HITS);
    }

    //M 记忆库命中拼成“路径、摘要、片段”三行，片段按 300 字截短，免得一条占太多。
    const libText = found.map((item) => {
      let summary = '';
      if (item.summary !== '') {
        summary = `\n  ${item.summary}`;
      }
      let snippet = '';
      if (item.snippet !== '') {
        snippet = `\n  …${recall.short(item.snippet, SNIPPET_CHARS)}`;
      }
      return `${item.path}${summary}${snippet}`;
    }).join('\n\n');

    //G 再搜一份知识库带上；搜不成（后端挂了）当没有，不挡前面已经搜到的。
    const knowledge = await this.store.search({ query, scope: 'knowledge', bot: session.row.bot, limit: SEARCH_HITS }).catch(() => []);

    //T 跟踪：工具搜完了。
    const vars = { 会话: session.id, 本地: hits.length, 记忆库: found.length, 知识库: knowledge.length };
    this.ctx.emit('trace', 'Memory.search', 'memory 工具搜完了', 'recall.local + recall.searchLibs', vars);

    //M 本地、记忆库、知识库三段有哪段拼哪段交回；知识库那段用 citeText 带编号和来源。
    const parts: string[] = [];
    if (local !== '') {
      parts.push(`# 你的记忆、公共记忆、技能\n${local}`);
    }
    if (found.length > 0) {
      parts.push(`# 记忆库 ${this.base?.libs ?? ''}\n${libText}`);
    }
    if (knowledge.length > 0) {
      parts.push(`# 知识库（回答用到了写上 [编号] 和来源）\n${storeModule.citeText(knowledge)}`);
    }
    if (parts.length > 0) return parts.join('\n\n');

    return `没找到「${query}」相关的记忆`;
  }

  /** 两个技能目录：全局的、机器人自己的。 */
  private skillRoots(bot: string): string[] {
    //M 目录从资源服务（resources）算：机器人自己的 skills/ 在前，全局 skills/ 在后。
    return [this.ctx.resources.dir('bots', bot, 'skills'), this.ctx.resources.dir('skills')];
  }

  /** 机器人的语言，不写是 zh（和 prompt 同一个读法）。 */
  private language(bot: string): string {
    //M 从机器人服务（bots）取这个机器人的配置，读 language；机器人不在或没写就是 zh。
    return String(this.ctx.bots.get(bot)?.config['language'] ?? 'zh');
  }
}


/**
 * 取一个必填的字符串参数。
 * @param allowEmpty 空串也算（write 的 content）。
 * @throws 没给时抛错。
 */
function required(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key];
  if (typeof value !== 'string' || (!allowEmpty && value === '')) throw new Error(`这个 action 要给 ${key}`);
  return value;
}

/**
 * 记忆文件的绝对路径：开头的 @ 去掉，只能在记忆文件夹里，不能是文件夹本身。
 * @throws 越界时抛错。
 */
function memoryFile(dir: string, relative: string): string {
  const file = path.resolve(dir, relative.replace(/^@/u, ''));
  const back = path.relative(dir, file);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) throw new Error(`memory 只能动 ${dir} 里的文件`);
  return file;
}

/**
 * 按词逐行找（切不出字组时用）：几个目录下的 .md、.txt，每个词出现的行，不分大小写。
 * @returns “绝对路径:行号: 那一行”，去重，最多 40 行。
 */
function wordLines(roots: string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/u).filter((word) => word !== '');
  const lines = new Set<string>();
  for (const root of roots) {
    for (const name of new Bun.Glob('**/*.{md,txt}').scanSync({ cwd: root, onlyFiles: true })) {
      const file = path.join(root, name);
      if (fs.statSync(file).size > 256 * 1024) {
        continue;
      }
      const text = fs.readFileSync(file, 'utf8');
      text.split(/\r?\n/u).forEach((line, index) => {
        if (words.some((word) => line.toLowerCase().includes(word))) {
          //M 命中的行记成“绝对路径:行号: 内容”，内容截 160 字（recall.short）。
          lines.add(`${file}:${String(index + 1)}: ${recall.short(line.trim(), 160)}`);
        }
      });
      if (lines.size >= WORD_LINES) return [...lines].slice(0, WORD_LINES);
    }
  }
  return [...lines];
}



/** 前台等别的插件往记忆库写、搜聊天记录时给的一段（客户号必带；进不进关系图由 memory 按 history_graph / no_graph_customers 定）。 */
export interface HistoryDoc {
  source: string; scope: 'history'; bot: string; customer: string; session: string; title: string; text: string; at: number; start: number; end: number;
}

declare module 'cordis' {
  interface Context {
    memory: MemoryService;
  }
  interface Events {
    /** 别的插件请记忆库办事（serial 发、等 memory/result，用 utils/RequestEvent.ts 的 requestEvent）。本插件听（MemoryService.onRequest）。 */
    'memory/request'(request: MemoryRequest): void | Promise<void>;
    /** memory/request 的回执（emit），按 requestId 配对。 */
    'memory/result'(result: MemoryResult): void;
  }
}


/** 事件 memory/request 的数据：action 分三种（契约 3.2 第 6 条）。bots 的前台（FrontDesk.ts 的 askMemory）发。 */
export type MemoryRequest = requestEventModule.RequestEnvelope & ({
  /** 记一段往来（同 recordHistory）：同一 source 先删后收。 */
  action: 'record-history';
  /** 来源，比如 bot-log:<会话号>。 */
  source: string;
  /** 要收的段；没有客户号的不收。 */
  docs: HistoryDoc[];
} | {
  /** 搜这个客户的聊天记录（同 searchHistory）。 */
  action: 'search-history';
  /** 要找什么。 */
  query: string;
  /** 哪个机器人。 */
  bot: string;
  /** 客户号；空串不搜。 */
  customer: string;
  /** 最多几条。 */
  limit: number;
} | {
  /** 用记忆服务的本地嵌入模型算向量（同 embed）。 */
  action: 'embed';
  /** 要嵌入的文字。 */
  texts: string[];
});


/** 事件 memory/result 的数据：memory/request 的回执，每种 action 只带自己那一项。 */
export interface MemoryResult extends requestEventModule.ResultEnvelope {
  /** 办成没有：record-history 记不成是 false；search-history、embed 搜不成照样 true，交回空的。 */
  ok: boolean;
  /** search-history：命中原样（start 是来源里的编号）；搜不成是 []。 */
  hits?: Array<{ start?: unknown; score?: unknown; text?: unknown }>;
  /** embed：每段一个向量；服务没开、模型没就绪是空。 */
  vectors?: number[][];
  /** 没办成的原因。 */
  error?: string;
}


/**
 * ctx.memory：记忆库只由本插件读写（2026-11-14 claude_指导意见 4.1）。别的插件发请求事件 memory/request（2026-11-18 起），
 * 或在 inject 里写 memory 再调这几个方法，不用知道记忆服务的地址、不读本插件的配置。服务没开时：embed 交回 undefined、searchHistory 交回 []、recordHistory 抛错。
 */
export class MemoryService extends cordis.Service {
  /**
   * 登记服务 memory，听请求事件 memory/request。
   * @param ctx 本插件的 ctx。
   * @param getAddress 托管服务的内部地址：'memory' 是 jmbots-memory，'vgr' 是 vgr；'' 是没有。
   * @param graph 聊天记录进不进关系图。
   */
  constructor(ctx: cordis.Context, private readonly getAddress: (service: string) => string, private readonly graph: graphPolicy.GraphPolicy) {
    //M 登记成 ctx.memory 服务：别的插件 inject 里写 memory 就能用下面这几个方法。
    super(ctx, 'memory');

    //M 别的插件请记忆库办事走请求事件 memory/request：onRequest 按 action 调下面的方法，办完回 memory/result。
    //M   recordHistory 记不成抛的错转成 { ok: false, error }，调用方不干等超时。
    const options = {
      onError: (error: unknown) => {
        const message = textModule.getMessage(error);
        return { ok: false, error: message };
      },
    };

    //M 挂上请求事件：收到 memory/request 就调 this.onRequest，办完用 memory/result 回执（onError 处理抛错）。
    requestEventModule.onRequestEvent(
      ctx,
      'memory/request',
      'memory/result',
      (request) => this.onRequest(request),
      options,
    );
  }

  /**
   * 响应 memory/request：按 action 调 recordHistory、searchHistory、embed。
   * @param request 别的插件用 requestEvent 发来的请求。
   * @returns 回执正文。
   * @throws recordHistory 记不成时抛，由 onRequestEvent 的 onError 转成 { ok: false, error }。
   * 副作用：同各方法（调记忆服务 /remove、/ingest、/search、/embed）。
   */
  private async onRequest(request: MemoryRequest): Promise<requestEventModule.StripResultId<MemoryResult>> {
    //M record-history：同一 source 先删后收，记不成抛错。
    if (request.action === 'record-history') {
      await this.recordHistory(request.source, request.docs);
      return { ok: true };
    }

    //M search-history：搜这个客户的聊天记录，搜不成交回空。
    if (request.action === 'search-history') {
      const query = {
        query: request.query,
        bot: request.bot,
        customer: request.customer,
        limit: request.limit,
      };

      //M 搜这个客户的聊天记录交回命中；没有客户号或搜不成，searchHistory 自己交回空。
      const hits = await this.searchHistory(query);
      return { ok: true, hits };
    }

    //M embed：算向量，服务没开或模型没就绪 vectors 为空。
    const vectors = await this.embed(request.texts);
    return { ok: true, vectors };
  }

  /** 2026-11-17 jm开发：托管服务的地址（默认 jmbots-memory，可问 'vgr'），memory-graph 用，不再自己拼。'' 是没有。 */
  url(service = 'memory'): string {
    //M 地址由 apply 里传进来的函数现取（端口可能启动时才定），这里不缓存。
    return this.getAddress(service);
  }

  /** 2026-11-17 jm开发：问托管服务的 /health（默认 jmbots-memory，可问 'vgr'）。不通也不抛，交回 ok:false 和原因。 */
  async health(service = 'memory'): Promise<Record<string, unknown>> {
    //M 现取这个服务的内部地址，拼上 /health 去问。
    const url = this.getAddress(service);
    const started = Date.now();
    //G 没有地址：服务没托管、也没配 service_url。
    if (url === '') return { url, ok: false, ms: 0, error: `没有 ${service} 服务的地址` };
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      return { url, ok: response.ok, ms: Date.now() - started, ...body };
    } catch (error) {
      //M 连不上、超时也不抛：把原因写进交回的 error，让调用方（网页）显示。
      return { url, ok: false, ms: Date.now() - started, error: textModule.getMessage(error) };
    }
  }

  /** 2026-11-17 jm开发：原样转给记忆服务 POST /search（memory-graph 的检索页用，最多等 2 分钟）。连不上抛错，服务没开交回 503。 */
  search(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; json: unknown }> {
    //M 请求体原样转给记忆服务的 /search，等最长 2 分钟（检索页的慢查询）。
    return this.post('/search', body, 120_000);
  }

  /**
   * 往记忆服务发一个 POST（JSON 体），读回 JSON。
   * @param route 服务上的路径，如 /search、/embed、/ingest、/remove。
   * @param body 请求体，原样转成 JSON。
   * @param ms 最多等多久（毫秒）。
   * @returns ok、HTTP 状态、解析出的 JSON（解析不了是 undefined）；没有地址（服务没开）交回 503。
   * @throws 连不上、超时时 fetch 抛错，由调用方决定怎么办。
   */
  private async post(route: string, body: unknown, ms: number): Promise<{ ok: boolean; status: number; json: unknown }> {
    //M 现取记忆服务（jmbots-memory）的地址；没有地址就是服务没开，直接回 503。
    const base = this.getAddress('memory');
    if (base === '') return { ok: false, status: 503, json: undefined };
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    return { ok: response.ok, status: response.status, json };
  }

  /** 用记忆服务的本地嵌入模型算向量；没有 /embed、模型没就绪、连不上交回 undefined。 */
  async embed(texts: string[]): Promise<number[][] | undefined> {
    if (texts.length === 0) return [];
    try {
      //M 请记忆服务的本地嵌入模型算向量，最多等 30 秒；按返回的形状判断能不能用。
      const res = await this.post('/embed', { texts }, 30000);
      const body = res.json as { ok?: unknown; vectors?: unknown } | undefined;
      if (!res.ok || body === undefined || body === null || body.ok === false || !Array.isArray(body.vectors)) return undefined;
      return body.vectors as number[][];
    } catch {
      return undefined;
    }
  }

  /** 记一段往来：同一 source 先删后收；按关系图规则打 graph:false。没有客户号的不收。 */
  async recordHistory(source: string, docs: HistoryDoc[]): Promise<void> {
    //M 没有客户号的不收；其余按关系图规则（GraphPolicy）给每段打上 graph 标记，决定进不进关系图。
    const kept = docs.filter((doc) => doc.customer !== '').map((doc) => graphPolicy.markGraph(this.graph, doc));
    if (kept.length === 0) return;

    //M 先删这个来源旧的段、再收新的（同一 source 先删后收）；哪步不成都抛错，onRequest 的 onError 转成 ok:false。
    if (!(await this.post('/remove', { source }, 8000)).ok) throw new Error('remove failed');
    if (!(await this.post('/ingest', { docs: kept }, 15000)).ok) throw new Error('ingest failed');
  }

  /** 搜这个客户的聊天记录（hybrid，不调大模型）；没有客户号不搜。交回命中原样（start 是来源里的编号）。 */
  async searchHistory(query: { query: string; bot: string; customer: string; limit: number }): Promise<Array<{ start?: unknown; score?: unknown; text?: unknown }>> {
    if (query.customer === '') return [];
    try {
      //M 请记忆服务按 hybrid 搜这个客户的聊天记录（不调大模型），最多等 8 秒。
      const res = await this.post('/search', { ...query, scope: 'history', mode: 'hybrid', rerank: false }, 8000);
      const hits = (res.json as { hits?: unknown } | undefined)?.hits;
      if (res.ok && Array.isArray(hits)) return hits as Array<{ start?: unknown }>;

      return [];
    } catch {
      return [];
    }
  }
}

/**
 * 挂上记忆。
 * apply 是 Cordis 插件的入口：inject 里的服务都就绪后 Cordis 调一次。记忆库名读 engine.memory_libs，基地由 ctx.base 提供。
 * @param ctx Cordis 给这个插件的 ctx。
 * @throws memory_libs 不是字符串时抛错（插件不挂，打一行原因）。
 */
export function apply(ctx: cordis.Context, config?: Record<string, unknown>): void {
  //M 2026-11-14：记忆服务、vgr 归本插件托管（Services.ts）；backend_url 可写服务名（memory / vgr），走主端口下它的路径。
  const own = { ...(config ?? {}) };
  const mainPort = Number(((ctx.resources.raw['server'] ?? {}) as { port?: unknown }).port) || 30086;
  const hosted = new servicesModule.Services(ctx.resources.root, mainPort, servicesModule.readServices(own['services']));
  let named: ReturnType<typeof hosted.route> | undefined;
  if (typeof own['backend_url'] === 'string') {
    named = hosted.route(`/memory/${own['backend_url']}`);
    if (named === undefined && own['backend_url'] === 'memory') {
      named = hosted.route('/memory');
    }
  }
  if (named !== undefined) {
    own['backend_url'] = `http://127.0.0.1:${String(mainPort)}${named.item.spec.path}`;
  }

  //G 读本插件配置和关系图配置：写错了这里抛错，插件不挂，打一行原因。
  const settings = readSettings(own);
  const graphSettings = graphRoutesModule.readGraphSettings(ctx.resources.root, own['graph']);

  //M 检索后端默认是本地 SQLite（LocalBackend）；配了 backend_url 就换成外部服务（HttpBackend），连不上时它退回本地。
  const local = new backendModule.LocalBackend(ctx.resources.db);
  let backend: backendModule.MemoryBackend = local;
  if (settings.backendUrl !== '') {
    backend = new backendModule.HttpBackend(settings.backendUrl, local, settings.timeoutMs, settings.token);
  }

  //M 记忆库本体：管聊天记录、知识库文件的收录和搜索，后端用上面选好的。
  const store = new storeModule.Store(backend, ctx.resources.root, ctx.resources.db, settings.graph);
  const engine = (ctx.resources.raw['engine'] ?? {}) as Record<string, unknown>;
  const libs = engine['memory_libs'];
  if (libs !== undefined && typeof libs !== 'string') throw new Error('engine.memory_libs 要是字符串，几个库用逗号连着写');

  //M 不缓存启动时可能还没挂上的基地；Recall 每次请求再从 ctx 取服务，本地记忆照常工作。
  let base: recall.Base | undefined;
  if (typeof libs === 'string' && libs.trim() !== '') {
    base = { ctx, libs: libs.split(',').map((part) => part.trim()).filter((part) => part !== '').join(',') };
  }

  //M 工具 memory、开场先搜、聊天记录收录都挂在 Memory 的构造函数里，建一个就挂上。
  new Memory(ctx, base, store, settings);

  //M 渠道消息索引（ChannelIndex.ts，11-18）：各渠道消息按聊天记进 memory_channel_messages，工具 channel_search 查；配置 channel_index 不写是开。
  const channelIndexOn = channelIndexModule.readEnabled(own['channel_index']);
  if (channelIndexOn) {
    const channelIndex = new channelIndexModule.ChannelIndex(ctx.resources.db);
    channelIndexModule.applyChannelIndex(ctx, channelIndex);
  }

  //M 记忆服务地址：配置 service_url 优先，否则本插件托管的 memory（内部地址，端口可能启动时才定，所以每次现取）；vgr 等别的服务只看托管的。
  let serviceUrl = '';
  if (typeof own['service_url'] === 'string') {
    serviceUrl = own['service_url'].replace(/\/+$/u, '');
  }

  //M 登记 ctx.memory 服务：传进去的函数每次现取地址，配置 service_url 优先，其余看托管的。
  const memoryService = new MemoryService(ctx, (service) => {
    if (service === 'memory' && serviceUrl !== '') return serviceUrl;

    //M 没配 service_url（或问的是 vgr）就取本插件托管的服务地址；没托管交回 ''。
    return hosted.getUrl(service) ?? '';
  }, settings.graph);

  //M 关系图路由（GraphRoutes）和记忆库的 HTTP 接口（routes）：http 插件在才真正登记。
  const graphRoutes = new graphRoutesModule.GraphRoutes(ctx, ctx.resources.root, memoryService, graphSettings);
  routes(ctx, store, hosted, graphRoutes);

  //M 全部挂完（ready）才拉起托管的 jmbots-memory、vgr，插件被拔掉时停掉。
  ctx.on('ready', () => hosted.start());
  ctx.effect(() => () => hosted.stop());
  //M 进程直接退出（不走拔插件）时也把自己拉起的停掉；壳子被强杀时靠壳子的 Job Object。
  process.once('exit', () => hosted.stop());
  //M Ctrl+C / SIGTERM（源码模式）：先停自己拉起的；http 插件收到信号后会把信号再发一次让进程退出。
  process.once('SIGINT', () => hosted.stop());
  process.once('SIGTERM', () => hosted.stop());
  //M 全部挂完先同步一次知识库（后台跑，不挡启动）。
  ctx.on('ready', () => void store.syncKnowledge(true).catch((error: unknown) => console.error(`知识库同步出错：${textModule.getMessage(error)}`)));
  if (base === undefined) return;

  //M 配了记忆库：等全部插件挂完（ready）再开始刷新；基地缺失或离线时 Libs 静默跳过。
  //M   ctx.effect：先执行一次，交回的函数在插件被拔掉时 Cordis 来调，这里停掉定时器。
  const libsWatch = new libsModule.Libs(ctx, base);
  ctx.on('ready', () => libsWatch.start());
  ctx.effect(() => () => libsWatch.stop());
}


/**
 * 读插件配置。都可以不写：
 * history（默认 true）收聊天记录；recall_history、recall_knowledge（默认 3、3）开场先搜给几条；
 * backend_url 外部检索服务（vector-graph-rag 之类，协议见 memory.md 第 11 节），不写就用本地；backend_token、backend_timeout_ms。
 * history_graph（默认 true）聊天记录抽不抽关系图；no_graph_customers 这些客户的聊天记录不抽（`demo:*` 按前缀），见 GraphPolicy.ts。
 * @throws 写错了抛错。
 */
function readSettings(raw: Record<string, unknown>): Settings & { backendUrl: string; token: string; timeoutMs: number; graph: graphPolicy.GraphPolicy } {
  const count = (key: string, fallback: number): number => {
    const value = raw[key] ?? fallback;
    if (typeof value !== 'number' || value < 0 || !Number.isInteger(value)) throw new Error(`memory.${key} 要是不小于 0 的整数`);
    return value;
  };
  const text = (key: string): string => {
    const value = raw[key] ?? '';
    if (typeof value !== 'string') throw new Error(`memory.${key} 要是字符串`);
    return value.trim();
  };
  if (raw['history'] !== undefined && typeof raw['history'] !== 'boolean') throw new Error('memory.history 要是 true 或 false');
  //M 外部检索服务地址：用 text 读成字符串、去掉末尾斜杠。
  const url = text('backend_url').replace(/\/+$/u, '');
  if (url !== '' && !/^https?:\/\//u.test(url)) throw new Error('memory.backend_url 要是 http:// 或 https:// 开头');
  //M 数字项用 count 读（不写用默认值，写错抛错）、字符串项用 text 读；聊天记录进不进关系图的规则交给 GraphPolicy 的 readGraphPolicy 读。
  return {
    history: raw['history'] !== false, recallHistory: count('recall_history', 3), recallKnowledge: count('recall_knowledge', 3),
    backendUrl: url, token: text('backend_token'), timeoutMs: count('backend_timeout_ms', 8000) || 8000,
    graph: graphPolicy.readGraphPolicy(raw),
  };
}


/**
 * 记忆库与关系图的 HTTP 接口（http 插件在才登记）：
 * GET /api/memory/recall?q=&scope=history|knowledge|all&bot=&customer=&session=&limit= → {backend, hits}（给网页、别的服务查）；
 * POST /api/memory/knowledge {bot?, name, content} 写一篇知识库文件并马上收进去；GET /api/memory/backend 后端状态；
 * 以及由原 memory-graph 并入的 /graph/、/api/memory-graph/* 路由。
 */
function routes(ctx: cordis.Context, store: storeModule.Store, hosted: servicesModule.Services, graphRoutes: graphRoutesModule.GraphRoutes): void {
  //M 等 http 插件挂上才登记这些接口；没有 http 就一个也不登记，记忆功能本身不受影响。
  void ctx.inject(['http'], (sub) => {
    const app = sub.http.app;
    app.get<{ Querystring: Record<string, string | undefined> }>('/api/memory/recall', async (request, reply) => {
      const query = request.query;
      const q = (query['q'] ?? '').trim();
      if (q === '') return reply.code(400).send({ error: '要给 q' });

      let scope: backendModule.MemoryQuery['scope'] = 'all';
      if (query['scope'] === 'history' || query['scope'] === 'knowledge') {
        scope = query['scope'];
      }
      const wanted: backendModule.MemoryQuery = { query: q, scope, limit: Math.min(50, Math.max(1, Number(query['limit'] ?? 10) || 10)) };
      for (const key of ['bot', 'customer', 'session'] as const) {
        const value = query[key];
        if (value !== undefined && value !== '') {
          wanted[key] = value;
        }
      }
      //G 隔离：查聊天记录不带 customer 就 400（Store.search 也会拒）。
      if (scope !== 'knowledge' && wanted.customer === undefined) return reply.code(400).send({ error: storeModule.NO_CUSTOMER });

      //M 隔离检查过了：按条件搜，连后端名字一起交回给网页看。
      return { backend: store.backend.name, hits: await store.search(wanted) };
    });
    app.post<{ Body: unknown }>('/api/memory/knowledge', async (request, reply) => {
      let body: Record<string, unknown> = {};
      if (typeof request.body === 'object' && request.body !== null) {
        body = request.body as Record<string, unknown>;
      }
      let bot = '';
      if (typeof body['bot'] === 'string') {
        bot = body['bot'];
      }
      if (typeof body['name'] !== 'string' || typeof body['content'] !== 'string') return reply.code(400).send({ error: '要给 name、content' });
      //G 指定了机器人就要存在，免得知识库文件写进没人用的目录。
      if (bot !== '' && ctx.bots.get(bot) === undefined) return reply.code(400).send({ error: `没有这个机器人：${bot}` });
      try {
        //M 写一篇知识库文件并马上收进记忆库，成功交回文件路径；失败（名字不合法之类）回 400 并带原因。
        return { file: await store.writeKnowledge(bot, body['name'], body['content']) };
      } catch (error) {
        return reply.code(400).send({ error: textModule.getMessage(error) });
      }
    });

    //M 两个只读状态接口：检索后端的健康、托管服务（jmbots-memory、vgr）的状态，给网页显示。
    app.get('/api/memory/backend', async () => store.health());
    app.get('/api/memory/services', () => ({ services: hosted.status() }));
    //M 托管服务的转发：/memory/vgr/* → vgr，/memory/* → jmbots-memory（最长前缀优先）。/memory/ 本身留给页面。
    const forward = async (request: { url: string; method: string; headers: Record<string, unknown>; body: unknown }, reply: { code(n: number): { send(v: unknown): unknown }; header(k: string, v: string): unknown; send(v: unknown): unknown }) => {
      const found = hosted.route(request.url);
      if (found === undefined) return reply.code(404).send({ error: '没有这个服务' });

      //M 逐个挑要转发的请求头：host、content-length、connection 不带，让 fetch 自己重算。
      const headers: Record<string, string> = {};
      textModule.eachEntry(request.headers, (key, value) => {
        if (typeof value === 'string' && !['host', 'content-length', 'connection'].includes(key.toLowerCase())) {
          headers[key] = value;
        }
      });
      let body: BodyInit | undefined;
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.body !== undefined) {
        if (typeof request.body === 'string' || request.body instanceof Uint8Array) {
          body = request.body as BodyInit;
        }
        if (body === undefined) {
          body = JSON.stringify(request.body);
        }
      }
      try {
        const response = await fetch(`${found.item.url}${found.rest}`, { method: request.method, headers, body, signal: AbortSignal.timeout(300_000) });
        const type = response.headers.get('content-type');
        if (type !== null) {
          reply.header('content-type', type);
        }
        return reply.code(response.status).send(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        //M 2026-11-14 23:10 EST：报错写清是哪种：服务被重启/掐断，还是根本没开。
        const why = textModule.getMessage(error);
        let hint = '没开或连不上';
        if (/closed|reset|ECONNRESET/iu.test(why)) {
          hint = '连接中途断了（服务可能正被重启，稍后再试）';
        }
        return reply.code(503).send({ error: `${found.item.spec.name} ${hint}：${why}` });
      }
    };
    //M 转发要原样带请求体：单独一层作用域收任意类型的体（不影响别的插件的解析）。
    void app.register(async (scope) => {
      scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
      for (const prefix of hosted.paths()) {
        scope.all(`${prefix}/*`, forward as never);
      }
    });

    //M 关系图的页面和 /api/memory-graph/* 接口也挂到同一个 http 上。
    graphRoutes.mountRoutes(app);
  });
}
