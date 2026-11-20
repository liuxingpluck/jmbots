/**
 * 记忆：工具 memory（列、搜、读、写、删机器人自己的记忆和公共记忆），干活的会话第一次调模型前先替模型搜一次。
 * 开场搜技能目录和 Rust 记忆服务。两个记忆目录由提示词插件提供。
 * 客服用的记忆库（Store.ts、Backend.ts）：聊天记录按客户、会话、机器人收，知识库文件按段收；工具 memory 的 history、knowledge，
 *   开场先搜也带上“这个客户以前说过的”和知识库；结果带编号、来源、片段，回答时能引用。检索后端可换（本地 SQLite，或外部服务 backend_url）。
 *   HTTP：GET /api/memory/recall、POST /api/memory/knowledge、GET /api/memory/backend。
 * Rust 记忆服务 jmbots-memory 由 programs 插件按 config 拉起（界面在 /programs/jmbots-memory/），本插件不托管进程，
 *   只按 service_url（默认 http://127.0.0.1:30087）调 HTTP；服务没起来时接口和工具如实报“记忆服务没在线”。
 * 关系图（GraphRoutes.ts、GraphStore.ts、GraphSources.ts，原 memory-graph 并入）：GET /graph/、/api/memory-graph/* 与对话附带关系图链接提示。
 * 设计：docs/src7插件设计/memory.md。
 */
import * as botUtils from '../../utils/Bots.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { ChatRequest, Session } from '../../Sessions.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as filesModule from '../../utils/Files.ts';
import * as textModule from '../../utils/Text.ts';
import * as archiveListenModule from '../channels/ArchiveListen.ts';
import * as chatArchiveModule from '../channels/Archive.ts';
import * as backendModule from './Backend.ts';
import * as channelBackfillModule from './ChannelBackfill.ts';
import * as channelIndexModule from './ChannelIndex.ts';
import * as frontArchiveModule from './FrontArchive.ts';
import * as memoryKeyModule from './MemoryKey.ts';
import * as graphPolicy from './GraphPolicy.ts';
import * as graphRoutesModule from './GraphRoutes.ts';
import * as graphStoreModule from './GraphStore.ts';
import * as recall from './Recall.ts';
import * as searchModule from './Search.ts';
import * as storeModule from './Store.ts';


/** 插件名。 */
export const name = 'memory';
//M 插件版本号写成 x.y.z，供 plugins/Index.ts 加载时校验。
//M 1.2.1：听请求事件 memory/request（record-history、search-history、embed）回 memory/result；前台“先查记忆”的提示（MEMORY_HINT）从 bots 挪来自己加。
//M 1.6.0：不再托管 jmbots-memory（删 Services.ts、services 配置、/memory/* 转发、/api/memory/services），改由 programs 拉起；
//M   只按 service_url 调 HTTP，连不上时检索、事件回执、工具都写明“记忆服务没在线”。
//M 1.7.0：渠道记录带人或群归属，统一检索可按 person、group 限定。
//M 1.8.1：恢复受信群本人发言时的全部记忆访问。
//M 1.10.0：存量渠道索引可独立补归属，与已有 Rust 副本同步。
//M 1.10.9：用户的话改听 channel/direct、channel/mention、channel/listen（只听的、没登记的群也记）；语音半句（routing.partial）不记。
//M 1.11.0：听 channel/history（飞书拉回的群历史）进历史回填队列，并请回填开跑；ChannelBackfill 加 resume。
//M 1.11.1：客户号只读渠道写的（删 customerFrom）；私人记忆判断并进 MemoryKey.canReadAll，本人、群改问 channels。
//M 1.11.2：渠道索引按归档路径记附件、按撤回事件记时刻，表结构交 db 管版本。
//M 1.11.3：旧档回填问资源守卫改 requestEvent 新写法，不掐表（守卫读数自己限时），云端 19 第 1、2 条。
//M 1.11.4：前台往来检索与原文读取从 Search.ts 并入 FrontArchive.ts，bot_log 旧表双读补退场条件注释（云端 20 第 3 条、云端 18 第 4 条）。
export const version = '1.11.4';

/** 用到的服务：resources 拿目录和配置；tools 登记工具；bots 找机器人的记忆目录和语言。 */
export const inject = ['resources', 'tools'];


declare module '../../Sessions.ts' {
  interface SessionRow {
    /** 开场先搜到的那一段；'' 是搜过没搜到；没有这一项是还没搜。 */
    recall?: string;
    /** 生成 recall 时的授权范围，避免旧缓存串到不同归属的会话。 */
    recallScope?: string;
  }
}


/** memory search 时本地最多给几个文件、记忆库最多几条。 */
const SEARCH_HITS = 8;

/** 记忆服务默认地址：config.example.yaml 里 programs 的 jmbots-memory 条目固定听 127.0.0.1:30087。 */
const DEFAULT_SERVICE_URL = 'http://127.0.0.1:30087';

/** history、knowledge 默认给几条。 */
const CITE_HITS = 8;

const FILE_ACTIONS = ['list', 'read', 'write', 'delete'] as const;
const FILE_DESCRIPTION = '管理自己的记忆（scope=own）或公共记忆（scope=shared）。用 list、read、write、delete。'
  + 'path 为相对路径。增删改记忆时同步更新索引.md。';

const FILE_PARAMETERS = piAi.Type.Object({
  action: piAi.Type.Union(FILE_ACTIONS.map((action) => piAi.Type.Literal(action))),
  scope: piAi.Type.Optional(piAi.Type.Union([piAi.Type.Literal('own'), piAi.Type.Literal('shared')])),
  path: piAi.Type.Optional(piAi.Type.String({ description: 'read、write、delete 的相对路径' })),
  content: piAi.Type.Optional(piAi.Type.String({ description: 'write 的文件内容' })),
});

/**
 * 前台“先查记忆”的提示（2026-11-18 从 bots/FrontDesk.ts 挪来，契约 #35）：前台这一轮有 memory 工具、又能带私人记忆时加。
 * 没挂 memory 就没有这个工具，也就没有这句，别让模型去调（Claude 11-14 17:34 第 6 节）。
 */
const MEMORY_HINT = '客户问事实、业务知识或以前的聊天，先用 memory_search 找出处，按 ref 用 memory_get 核对原文。'
  + '如果只问这场对话，设 range 为 session。回答用到命中时标明来源，需要通读大量历史时用 hand_session。';
const SCOPED_HINT = '需要核对以前的聊天时，先用 memory_search 查当前对话的记忆，再用 memory_get 取原文。';


/** 插件配置（plugins 里 memory 的 config），都可以不写。 */
interface Settings {
  /** 收不收聊天记录，默认收。 */
  history: boolean;
  /** 开场先搜给几条这个客户以前的话、几条知识库；0 不给。 */
  recallHistory: number;
  recallKnowledge: number;
}


/** 把可信检索回来的片段写成模型可引用的提示。 */
function formatCitations(cited: searchModule.SearchHit[]): string {
  if (cited.length === 0) return '';

  const lines = cited.map((hit, index) => `[${String(index + 1)}] ${hit.title} ${hit.ref}\n${hit.snippet}`);
  return `# 可能相关的聊天记录和知识库（用到了请写明编号和出处）\n${lines.join('\n')}`;
}


/** 记忆插件：工具 memory、开场先搜、前台“先查记忆”的提示。导出给 Events.test.ts 单独建。 */
export class Memory {
  /** 前台按本轮和归属复用召回，下一轮重新计算。 */
  private readonly frontRecall = new WeakMap<Session, { key: string; said: string; at: number; text: string }>();

  /**
   * 登记工具，挂开场先搜。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param store 会话记录与知识库文件的存储。
   * @param settings 本插件配置。
   */
  constructor(
    private readonly ctx: cordis.Context,
    readonly store: storeModule.Store,
    private readonly settings: Settings,
  ) {
    //M 前台也登记记忆工具，执行时只允许 list、search、read。
    ctx.tools.register({
      definition: {
        name: 'memory',
        description: FILE_DESCRIPTION,
        parameters: piAi.Type.Object({
          ...FILE_PARAMETERS.properties,
          action: piAi.Type.Union(
            [...FILE_ACTIONS, 'search', 'history', 'knowledge'].map((value) => piAi.Type.Literal(value)),
          ),
          range: piAi.Type.Optional(piAi.Type.Union(['customer', 'session'].map((value) => piAi.Type.Literal(value)),
            { description: 'history 时：customer 这个客户（默认）、session 这一场' })),
          limit: piAi.Type.Optional(piAi.Type.Number({ description: 'history、knowledge 时最多几条，默认 8' })),
          query: piAi.Type.Optional(piAi.Type.String({ description: 'search、history、knowledge 时：要找什么，整句或几个词' })),
        }),
      },
      sessionKinds: ['front', 'work'],
      //M 模型调 memory 工具时走 this.run，由它按 action 分到 list、search、read、write、delete、history、knowledge。
      run: (args, session) => this.run(args, session),
    });

    //M 听 session/before-model：每一步调模型前骨架挨个问插件（ctx.serial），前台加“先查记忆”的提示，干活的会话加开场搜到的那段。
    ctx.on('session/before-model', (request) => this.onRequest(request));

    //M 听 session/new-message（通知）：用户看得到的会话（有渠道、没有 parent）每接一条就收进聊天记录。收不成只打日志，不挡会话。
    if (settings.history) {
      ctx.on('session/new-message', (session, message) => {
        if (message.role !== 'user' && message.role !== 'assistant') return;
        void store.ingestSession(session.row).then((count) => {
          if (count > 0) {
            session.save();
          }
        }).catch((error: unknown) => console.error(`记忆库收聊天记录出错：${textModule.getErrorMessage(error)}`));
      });
    }
  }

  /**
   * 响应 session/before-model。前台：这一轮有 memory 工具、又能带私人记忆，加“先查记忆”的提示（MEMORY_HINT）。
   * 干活的会话（开场先搜）：第一次调模型前搜一次，结果记在 row.recall，以后每一步带同一段。
   * @param request 这一步的请求。
   */
  private async onRequest(request: ChatRequest): Promise<void> {
    const session = request.session;
    const row = session.row;

    //M 记忆文件工具只展示文件操作，正文检索由两个专用工具负责。
    request.tools = request.tools.map((tool) => {
      if (tool.name !== 'memory') return tool;

      return { ...tool, description: FILE_DESCRIPTION, parameters: FILE_PARAMETERS };
    });

    //M 前台提示和开场召回都以本轮来源为准。没有确定归属的外来请求不带记忆。
    const access = memoryKeyModule.getMemoryAccess(row);
    if (!access.full && access.key === undefined) return;

    if (row.kind === 'front') {
      const hasTool = request.tools.some((tool) => tool.name === 'memory_search');
      if (access.full) {
        if (hasTool) {
          //M 本人沿用可指向知识与私人往来的检索提示。
          request.system.push(MEMORY_HINT);
        }
        return;
      }
      if (hasTool) {
        //M 受限会话只提示查询当前归属下的往来。
        request.system.push(SCOPED_HINT);
      }

      //M 非本人前台只搜该人或该群。缓存只在当轮使用，章句不写进会话记录。
      const latest = row.messages.findLast((message) => message.role === 'user');
      if (latest === undefined) return;

      const said = piAi.contentText(latest.content);
      const key = access.key!;
      const at = latest.timestamp;
      //M 同一轮保留已经按本次授权生成的段落。
      let cached = this.frontRecall.get(session);
      if (cached?.key !== key || cached.said !== said || cached.at !== at) {
        //M 新轮或新归属重新检索，再把引用整理进系统提示。
        const cited = await this.openingCitations(session, said, access).catch(() => []);
        const text = formatCitations(cited);
        cached = { key, at, said, text };
        this.frontRecall.set(session, cached);
      }
      if (cached.text !== '') {
        //M 把已限制归属的召回放进本次模型请求。
        request.system.push(cached.text);
      }
      return;
    }

    if (row.kind !== 'work') return;

    //G 旧召回可能来自过去的私人上下文；授权范围变化时重新算。
    const scope = access.key ?? memoryKeyModule.OWNER_KEY;
    if (row.recall === undefined || row.recallScope !== scope) {
      const said = row.messages.filter((message) => message.role === 'user')
        .map((message) => piAi.contentText(message.content))
        .join('\n');
      const started = Date.now();
      //M 只有本人可加载私人技能。其他人仅召回当前聊天归属下的往来。
      let skills: ReturnType<typeof recall.local> = Promise.resolve([]);
      if (access.full) {
        const roots = this.skillRoots(row.bot);
        skills = recall.local(roots, said).catch(() => []);
      }

      //M 当前来源授权决定召回用到的客户和渠道分区。
      const citations = this.openingCitations(session, said, access).catch(() => []);
      const [hits, cited] = await Promise.all([skills, citations]);

      //M 技能命中和 Rust 引用存进 row.recall，同一会话后续步骤继续用这段。
      const citedText = formatCitations(cited);
      let skillText = '';
      if (hits.length > 0) {
        const language = this.language(row.bot);
        skillText = recall.describe(hits, language);
      }
      row.recall = [skillText, citedText].filter((part) => part !== '').join('\n\n');
      row.recallScope = scope;

      //M 记录生成时的授权范围，防止后台会话恢复时复用越权缓存。
      session.save();

      //T 跟踪：开场先搜完了。
      const vars = { session: session.id, skillCount: hits.length, citationCount: cited.length, durationMs: Date.now() - started };
      this.ctx.emit('trace', 'Memory.recall', 'trace.memory.recall', 'recall.local + Search.find', vars);
    }
    if (row.recall !== '') {
      request.system.push(row.recall);
    }
  }

  /**
   * 开场先搜的引用：这个客户以前的（不含这一场）几条，知识库几条。
   * @param session 干活的会话。
   * @param said 用户说过的话。
   */
  private async openingCitations(
    session: Session,
    said: string,
    access: memoryKeyModule.MemoryAccess,
  ): Promise<searchModule.SearchHit[]> {
    const q = [...said].slice(0, 300).join('').trim();
    if (q === '') return [];

    //M 召回按检索入口自动加归属；同时用渠道索引接住还未同步到 Rust 的消息。
    const row = session.row;
    let sources = 'history';
    if (access.full || (access.chat && access.account)) {
      sources = 'history,channel';
    }
    const service = this.ctx.memory.unified;
    const groups = [{ sources, count: this.settings.recallHistory }];
    if (access.full) {
      groups.push({ sources: 'knowledge', count: this.settings.recallKnowledge });
    }
    const jobs = groups.map(async ({ sources, count }) => {
      if (count === 0) return [];

      //M 服务先排除当前场，再滤掉前台可能已经收录的本轮原话。
      const args = { q, sources, limit: count + 2 };
      const options = { notSession: row.id };
      const result = await service.find(args, session, options).catch(() => undefined);
      const hits = result?.hits ?? [];
      if (sources === 'knowledge') return hits.slice(0, count);

      return hits.filter((hit) => !said.includes(hit.snippet.replace(/^…|…$/gu, ''))).slice(0, count);
    });
    const hits = await Promise.all(jobs);
    return hits.flat();
  }

  /**
   * history、knowledge：照范围搜，写成带编号的引用。
   * @param action history 或 knowledge。
   * @param args 模型给的参数（query 必填，limit、range 可选）。
   * @param session 哪场会话：客户号、机器人从它的 row 取。
   * @returns 带编号、来源、片段的引用文字；没找到是一句“没找到”。
   * @throws 没给 query、range 不对、没有客户号时抛错，原因给模型看。
   */
  private async cite(
    action: 'history' | 'knowledge',
    args: Record<string, unknown>,
    session: Session,
  ): Promise<string> {
    //M 旧 action 只换参数名，检索和权限复用统一入口。
    const query = {
      q: args['query'], sources: action, limit: args['limit'] ?? CITE_HITS, range: args['range'],
    };

    //M 使用已归一的参数查可用记忆，统一入口继续核对会话权限。
    return this.searchText(query, session);
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

    //G 兼容检索可以查获准的往来；私人文件动作始终要求本人。
    const access = memoryKeyModule.getMemoryAccess(session.row);
    if (!access.full) {
      if (action === 'search' || action === 'history') {
        let sources = 'history';
        if (access.account && access.chat && access.channel) {
          sources = 'history,channel';
        }
        const query = { q: args['query'], sources, limit: args['limit'] ?? CITE_HITS };
        return this.searchText(query, session);
      }
      throw new Error('私人记忆文件和知识库仅本人可访问');
    }

    //G 沿用机器人归属，找不到配置时拒绝读取私有记忆。
    const botName = session.row.bot;
    const bot = botUtils.getBotConfig(this.ctx.resources.raw, botName);
    if (bot === undefined) throw new Error(`没有这个机器人：${session.row.bot}`);

    //M 公共记忆目录：所有机器人共用，scope 写 shared 才用它。
    const shared = this.ctx.resources.ensureRuntimeDir('memory');
    let dir = botUtils.getBotDir(this.ctx.resources, bot.name, 'memory');
    if (args['scope'] === 'shared') {
      dir = shared;
    }
    if (session.row.kind === 'front' && (action === 'write' || action === 'delete')) throw new Error('前台只能 list、search、read');

    if (action === 'list') {
      const names = await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: dir, onlyFiles: true })).catch(() => [] as string[]);
      if (names.length === 0) return '（记忆文件夹是空的）';

      return names.map((item) => item.replace(/\\/gu, '/')).sort().join('\n');
    }
    //M 兼容手动搜卡片、技能和知识库的旧 action。
    if (action === 'search') {
      const query = { q: args['query'], sources: 'card,knowledge', limit: SEARCH_HITS };
      const skills = this.skillRoots(bot.name);
      return this.searchText(query, session, skills);
    }

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
      const parentDir = path.dirname(file);
      //M 写入前确保记忆文件的上层目录存在。
      filesModule.ensureDir(parentDir);
      fs.writeFileSync(file, content, 'utf8');
      //M 交回写了多大（utils/Text.ts 的 formatByteSize）。
      const bytes = Buffer.byteLength(content, 'utf8');
      const sizeText = textModule.formatByteSize(bytes);
      return `已写入记忆 ${file}（${sizeText}）`;
    }
    fs.rmSync(file);
    return `已删除记忆 ${file}`;
  }

  /**
   * 旧 memory 检索入口保留带编号的文本格式，并补上可交给 memory_get 的 ref。
   */
  private async searchText(args: Record<string, unknown>, session: Session, skills: string[] = []): Promise<string> {
    //M 旧工具保留文本回执，并把统一检索的原文引用和未响应来源展示出来。
    const options = { cardRoots: skills };
    const result = await this.ctx.memory.unified.find(args, session, options);
    const lines = result.hits.map((hit, index) => `[${String(index + 1)}] ${hit.title} ${hit.ref}\n${hit.snippet}`);
    if (result.unavailable.length > 0) lines.push(`未响应：${result.unavailable.join('、')}`);

    //M 没响应的原因（Search.find 收进 warnings，如“记忆服务没在线”）也给模型，免得把连不上当成没找到。
    const warnings = result.warnings ?? [];
    if (warnings.length > 0) lines.push(`提示：${warnings.join('；')}`);
    if (lines.length === 0) return '没找到相关的记忆';

    const body = lines.join('\n');
    return `找到 ${String(result.hits.length)} 条（回答用到了写上编号和来源）：\n${body}`;
  }

  /** 两个技能目录：全局的、机器人自己的。 */
  private skillRoots(bot: string): string[] {
    //M 目录从资源服务（resources）算：机器人自己的 skills/ 在前，全局 skills/ 在后。
    return [this.ctx.resources.ensureRuntimeDir('bots', bot, 'skills'), this.ctx.resources.ensureRuntimeDir('skills')];
  }

  /** 机器人的语言，不写是 zh（和 prompt 同一个读法）。 */
  private language(bot: string): string {
    //M 从机器人服务（bots）取这个机器人的配置，读 language；机器人不在或没写就是 zh。
    return botUtils.getBotLanguage(this.ctx.resources.raw, bot);
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


/** 前台等别的插件往记忆库写、搜聊天记录时给的一段（客户号必带；进不进关系图由 memory 按 history_graph / no_graph_customers 定）。 */
export interface HistoryDoc {
  source: string; scope: 'history'; bot: string; customer: string; session: string; title: string; text: string; at: number; start: number; end: number;
}

declare module 'cordis' {
  interface Context {
    memory: MemoryService;
  }
  interface Events {
    /**
     * 别的插件请记忆库办事（serial 发、等 memory/result，用 utils/RequestEvent.ts 的 requestEvent）。本插件听（MemoryService.onRequest）。
     * 谁发：src7/plugins/bots/FrontDesk.ts 的 FrontDesk.readFront
     * 谁接：src7/plugins/memory/index.ts 的 MemoryService.constructor
     */
    'memory/request'(request: MemoryRequest): void | Promise<void>;
    /**
     * memory/request 的回执（emit），按 requestId 配对。
     * 谁发：src7/plugins/memory/index.ts 的 MemoryService.constructor
     * 谁接：src7/plugins/bots/FrontDesk.ts 的 FrontDesk.readFront
     */
    'memory/result'(result: MemoryResult): void;
  }
}


/** 事件 memory/request 的数据。bots 的前台（FrontDesk.ts 的 readFront）等插件发。 */
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
  /** 读取可信前台会话范围内的归档。 */
  action: 'front-history';
  /** 会话范围、分页和关键词等过滤条件。 */
  query: frontArchiveModule.FrontQuery;
} | {
  /** 按统一接口搜所有来源。 */
  action: 'search';
  /** 与 GET /api/memory/search 相同，支持 person 或 group；调用插件负责确认用户权限。 */
  query: Record<string, unknown>;
} | {
  /** 用记忆服务的本地嵌入模型算向量（同 embed）。 */
  action: 'embed';
  /** 要嵌入的文字。 */
  texts: string[];
});


/** 事件 memory/result 的数据：memory/request 的回执，每种 action 只带自己那一项。 */
export interface MemoryResult extends requestEventModule.ResultEnvelope {
  /** 办成没有：记忆服务没在线、记不成、搜不成都是 false，原因在 error。 */
  ok: boolean;
  /** search-history：命中原样（start 是来源里的编号）；没有客户号是 []。 */
  hits?: Array<{ start?: unknown; score?: unknown; text?: unknown }>;
  /** search：统一检索回执；某一路没响应写在它的 unavailable、warnings 里。 */
  search?: searchModule.SearchResult;
  /** front-history：按机器人和会话范围过滤后的往来。 */
  frontEntries?: frontArchiveModule.FrontEntry[];
  /** embed：每段一个向量；服务在线但模型没就绪是空。 */
  vectors?: number[][];
  /** 没办成的原因，如“记忆服务没在线（http://127.0.0.1:30087）：…”。 */
  error?: string;
}


/**
 * ctx.memory：记忆库只由本插件读写（2026-11-14 claude_指导意见 4.1）。别的插件发请求事件 memory/request（2026-11-18 起），
 * 或在 inject 里写 memory 再调这几个方法，不用知道记忆服务的地址、不读本插件的配置。
 * 记忆服务由 programs 插件拉起；它没在线时 embed、searchHistory、recordHistory 都抛“记忆服务没在线”，事件回执是 ok: false 带 error。
 */
export class MemoryService extends cordis.Service {
  /** 网页、模型和内部请求共用的检索。 */
  readonly unified: searchModule.Search;

  /**
   * 登记服务 memory，听请求事件 memory/request。
   * @param ctx 本插件的 ctx。
   * @param address 记忆服务地址（memory.service_url，入口 readSettings 校验过，默认 http://127.0.0.1:30087）。
   * @param graph 聊天记录进不进关系图。
   * @param channelIndex 渠道索引，关闭时缺省。
   * @param graphStore 与 Rust 同机部署时取相邻段的只读库。
   * @param disk 管理待同步的知识库文件。
   * @param token 调外部记忆服务的令牌，留空时不加认证头。
   */
  constructor(
    ctx: cordis.Context,
    private readonly address: string,
    private readonly graph: graphPolicy.GraphPolicy,
    channelIndex?: channelIndexModule.ChannelIndex,
    graphStore?: graphStoreModule.GraphStore,
    disk?: storeModule.Store,
    private readonly token = '',
    private readonly frontArchive?: frontArchiveModule.FrontArchive,
  ) {
    //M 登记成 ctx.memory 服务：别的插件 inject 里写 memory 就能用下面这几个方法。
    super(ctx, 'memory');

    //M 检索共用 Rust 网关和可选的渠道索引。
    this.unified = new searchModule.Search(ctx, this, channelIndex, graphStore, disk, frontArchive);

    //M 别的插件请记忆库办事走请求事件 memory/request：onRequest 按 action 调下面的方法，办完回 memory/result。
    //M   方法抛的错（记忆服务没在线、记不成、搜不成）转成 { ok: false, error }，调用方不干等超时。
    const options = {
      onError: (error: unknown) => {
        const message = textModule.getErrorMessage(error);
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
   * 响应 memory/request：按 action 调 recordHistory、searchHistory、统一检索或 embed。
   * @param request 别的插件用 requestEvent 发来的请求。
   * @returns 回执正文。
   * @throws 记忆服务没在线、记不成、搜不成时抛，由 onRequestEvent 的 onError 转成 { ok: false, error }。
   * 副作用：同各方法（调记忆服务 /remove、/ingest、/search、/embed）。
   */
  private async onRequest(request: MemoryRequest): Promise<requestEventModule.StripResultId<MemoryResult>> {
    //M record-history：同一 source 先删后收，记不成抛错。
    if (request.action === 'record-history') {
      await this.recordHistory(request.source, request.docs);
      return { ok: true };
    }

    //M search-history：搜这个客户的聊天记录；服务没在线、搜不成由 searchHistory 抛，回执写明原因。
    if (request.action === 'search-history') {
      const query = {
        query: request.query,
        bot: request.bot,
        customer: request.customer,
        limit: request.limit,
      };

      //M 搜这个客户的聊天记录交回命中；没有客户号时 searchHistory 交回空。
      const hits = await this.searchHistory(query);
      return { ok: true, hits };
    }

    if (request.action === 'front-history') {
      //M 归档只从渠道索引读取，会话范围已由 bots 依据父子关系决定。
      const frontEntries = this.frontArchive?.read(request.query) ?? [];
      return { ok: true, frontEntries };
    }

    if (request.action === 'search') {
      //M 内部插件用与 HTTP 入口一致的检索参数拿回命中和未响应的来源。
      const search = await this.unified.find(request.query);
      return { ok: true, search };
    }

    //M embed：算向量；服务在线但模型没就绪 vectors 为空，没在线由 embed 抛。
    const vectors = await this.embed(request.texts);
    return { ok: true, vectors };
  }

  /** 记忆服务地址（memory.service_url）。 */
  url(): string {
    return this.address;
  }

  /** 问 Rust 的 /health，不通时交回 ok:false 和原因（“记忆服务没在线…”）。 */
  async health(): Promise<Record<string, unknown>> {
    const url = this.address;
    const started = Date.now();
    try {
      //M 拼上 /health 去问，最多等 4 秒；连不上由 fetchMemory 写成“记忆服务没在线”。
      const headers = this.getHeaders();
      const init = { headers, signal: AbortSignal.timeout(4000) };
      const response = await backendModule.fetchMemory(url, '/health', init);
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      return { url, ok: response.ok, ms: Date.now() - started, ...body };
    } catch (error) {
      //M 连不上、超时也不抛：把原因写进交回的 error，让调用方（记忆页、关系图页）显示。
      return { url, ok: false, ms: Date.now() - started, error: textModule.getErrorMessage(error) };
    }
  }

  /** 2026-11-17 jm开发：原样转给记忆服务 POST /search（memory-graph 的检索页用，最多等 2 分钟）。服务没在线、超时抛错。 */
  search(body: Record<string, unknown>, timeout = 120_000): Promise<{ ok: boolean; status: number; json: unknown }> {
    //M 请求体原样转给记忆服务的 /search，等最长 2 分钟（检索页的慢查询）。
    return this.post('/search', body, timeout);
  }

  /** 从记忆服务读段落原文或客户归并号，调用方已固定地址及路径格式。 */
  async readSearchData(route: string): Promise<unknown> {
    //M 原文、客户归并查询无需等检索和大模型调用，最多等 8 秒；服务没在线由 fetchMemory 抛。
    const signal = AbortSignal.timeout(8000);
    const headers = this.getHeaders();
    const init = { headers, signal };
    const response = await backendModule.fetchMemory(this.address, route, init);
    if (!response.ok) throw new Error('记忆服务未返回原文或客户信息');

    return response.json();
  }

  /**
   * 往记忆服务发一个 POST（JSON 体），读回 JSON。
   * @param route 服务上的路径，如 /search、/embed、/ingest、/remove。
   * @param body 请求体，原样转成 JSON。
   * @param ms 最多等多久（毫秒）。
   * @returns ok、HTTP 状态、解析出的 JSON（解析不了是 undefined）。
   * @throws 记忆服务没在线、超时（fetchMemory 写好原因），由调用方决定怎么办。
   */
  private async post(route: string, body: unknown, ms: number): Promise<{ ok: boolean; status: number; json: unknown }> {
    //M 带上令牌（配了 backend_token 才有）和 JSON 头，限时 ms 毫秒。
    const headers = this.getHeaders();
    headers['content-type'] = 'application/json';
    const init = { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) };

    //M 发给记忆服务（service_url）；连不上不在这里兜，抛给调用方如实报。
    const response = await backendModule.fetchMemory(this.address, route, init);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    return { ok: response.ok, status: response.status, json };
  }

  /** 外部 Rust 服务配置了令牌时，检索、探活和原文均用同一份认证。 */
  private getHeaders(): Record<string, string> {
    if (this.token === '') return {};

    return { authorization: `Bearer ${this.token}` };
  }

  /**
   * 用记忆服务的本地嵌入模型算向量。
   * @returns 每段一个向量；服务在线但没有 /embed、模型没就绪交回 undefined。
   * @throws 记忆服务没在线、超时（post 抛）。
   */
  async embed(texts: string[]): Promise<number[][] | undefined> {
    if (texts.length === 0) return [];

    //M 请记忆服务的本地嵌入模型算向量，最多等 30 秒；按返回的形状判断能不能用。
    const res = await this.post('/embed', { texts }, 30000);
    const body = res.json as { ok?: unknown; vectors?: unknown } | undefined;
    if (!res.ok || body === undefined || body === null || body.ok === false || !Array.isArray(body.vectors)) return undefined;

    return body.vectors as number[][];
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

  /** 幂等写入一批渠道消息，不删除已有记录。只有 Rust 确认整批才返回。 */
  async ingestChannel(docs: ReturnType<typeof channelBackfillModule.getChannelDoc>[]): Promise<void> {
    const body = { docs };
    //M 数据源使用稳定来源键，重复提交由 Rust 的唯一约束合并。
    const response = await this.post('/ingest', body, 15_000);
    const result = response.json as { ok?: unknown; count?: unknown } | undefined;
    if (!response.ok || result?.ok !== true || result.count !== docs.length) {
      throw new Error('Rust 未确认整批渠道消息');
    }
  }

  /**
   * 搜这个客户的聊天记录（hybrid，不调大模型）。
   * @returns 命中原样（start 是来源里的编号）；没有客户号不搜，交回 []。
   * @throws 记忆服务没在线、超时（post 抛），或在线却没回命中列表。
   */
  async searchHistory(query: { query: string; bot: string; customer: string; limit: number }): Promise<Array<{ start?: unknown; score?: unknown; text?: unknown }>> {
    if (query.customer === '') return [];

    //M 请记忆服务按 hybrid 搜这个客户的聊天记录（不调大模型），最多等 8 秒。
    const body = { ...query, scope: 'history', mode: 'hybrid', rerank: false };
    const res = await this.post('/search', body, 8000);
    const hits = (res.json as { hits?: unknown } | undefined)?.hits;

    //G 服务在线却没回命中列表：如实抛，不当成没搜到。
    if (!res.ok || !Array.isArray(hits)) throw new Error(`记忆服务搜聊天记录出错（HTTP ${String(res.status)}）`);

    return hits as Array<{ start?: unknown }>;
  }
}

/**
 * 挂上记忆。
 * 依赖就绪后登记检索、知识库和 HTTP 接口；记忆服务进程由 programs 插件拉起，这里只按 service_url 调它。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context, config?: Record<string, unknown>): void {
  //G 读本插件配置和关系图配置：写错了这里抛错，插件不挂，打一行原因。
  const own = { ...(config ?? {}) };
  const settings = readSettings(own);
  const backfillSettings = channelBackfillModule.getBackfillSettings(own['backfill']);
  const graphSettings = graphRoutesModule.readGraphSettings(ctx.resources.root, own['graph']);

  //M 所有 Rust 请求都发到同一个地址：service_url（readSettings 已补默认、认旧 backend_url）。
  const address = settings.serviceUrl;

  //M 会话旧备份默认只进 SQLite，写了 backend_url 才同时发给 Rust；知识库导入要 Rust 确认写入，供统一接口立即检索。
  const local = new backendModule.LocalBackend(ctx.resources.db);
  let backend: backendModule.MemoryBackend = local;
  if (settings.sessionsToRust) {
    backend = new backendModule.HttpBackend(address, local, settings.timeoutMs, settings.token);
  }

  //M 知识库一律进 Rust，最后一个参数 true：Rust 没确认写入就抛，Store 不前推同步进度，下次再试。
  const knowledgeBackend = new backendModule.HttpBackend(address, local, settings.timeoutMs, settings.token, true);

  //M Store 统一管理旧会话备份和直接进入 Rust 的知识库。
  const store = new storeModule.Store(backend, ctx.resources.root, ctx.resources.db, settings.graph, knowledgeBackend);

  //M 给统一检索和渠道监听共用的索引；channel_index 不写是开。
  const channelIndexOn = channelIndexModule.readEnabled(own['channel_index']);
  const db = ctx.resources.db;
  //M db 已挂就复用它的服务，旧插件顺序也在同一主库按迁移账本升级。
  const migrations = ctx.get('db');
  const archiveIndex = new channelIndexModule.ChannelIndex(db, migrations);
  const frontArchive = new frontArchiveModule.FrontArchive(db, archiveIndex);
  let channelIndex: channelIndexModule.ChannelIndex | undefined;
  if (channelIndexOn) {
    channelIndex = archiveIndex;
  }

  //M 前台归档沿用本地库，即使关闭了原始渠道监听也保存会话往来。
  ctx.on('memory/front-message', (message) => {
    frontArchive.record(message);
  });

  //M 登记查询和知识库同步共用的 Rust 地址，图谱库用于读取同一来源的邻段。
  const graphStore = new graphStoreModule.GraphStore(graphSettings.db);
  const memoryService = new MemoryService(
    ctx, address, settings.graph, channelIndex, graphStore, store, settings.token, frontArchive,
  );

  //M 先登记工具和开场检索钩子，随后让关系图钩子检查这一轮有没有用到记忆。
  new Memory(ctx, store, settings);
  const unified = memoryService.unified;
  unified.registerTools();
  //M 索引和 Markdown 共用聊天目录，确保搜索里的附件路径指向归档文件。
  const root = ctx.resources.root;
  const chats = new chatArchiveModule.ChatArchive(root);
  const archive = { root, chats };
  if (channelIndex !== undefined) {
    //M 实时队列始终接新事件，历史回填由资源守卫和手动开关控制。
    const backfill = new channelBackfillModule.ChannelBackfill(ctx, channelIndex, memoryService, backfillSettings);
    channelIndexModule.applyChannelIndex(ctx, channelIndex, backfill, archive);
  }
  //M prepend 后登记先执行。先复制 Markdown 附件，再写索引，接着交给机器人认领。
  archiveListenModule.applyChatArchive(ctx, root, chats);

  //M 关系图路由（GraphRoutes）和记忆库的 HTTP 接口（routes）：http 插件在才真正登记。
  const graphRoutes = new graphRoutesModule.GraphRoutes(
    ctx, ctx.resources.root, memoryService, graphSettings, graphStore,
  );
  routes(ctx, store, graphRoutes, memoryService);

  //M 全部挂完先同步一次知识库（后台跑，不挡启动）。
  ctx.on('ready', () => void store.syncKnowledge(true).catch((error: unknown) => console.error(`知识库同步出错：${textModule.getErrorMessage(error)}`)));
}


/**
 * 读插件配置。都可以不写：
 * history（默认 true）收聊天记录；recall_history、recall_knowledge（默认 3、3）开场先搜给几条；
 * service_url 指定 Rust 地址（默认 DEFAULT_SERVICE_URL）；backend_url 写了（memory 或地址）会话备份也发给 Rust，是地址时当 service_url 的旧别名。
 * history_graph（默认 true）聊天记录抽不抽关系图；no_graph_customers 这些客户的聊天记录不抽（`demo:*` 按前缀），见 GraphPolicy.ts。
 * @throws 写错了抛错；还写着已删的 services（托管改归 programs）也抛。
 */
function readSettings(raw: Record<string, unknown>): Settings & {
  serviceUrl: string; sessionsToRust: boolean; token: string; timeoutMs: number; graph: graphPolicy.GraphPolicy;
} {
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

  //G 托管已交给 programs 插件（1.6.0）：还写着 services 说明配置没跟着换，直接拒，免得以为改它还管用。
  if (raw['services'] !== undefined) {
    const how = '删掉这一段，在 programs 里加 jmbots-memory（见 config.example.yaml）';
    throw new Error(`memory.services 已不用：记忆服务改由 programs 插件拉起，${how}`);
  }

  //G 旧 backend_url 只认 memory 或 Rust 地址；vgr 适配器已不用，写着就拒。
  const backendUrl = text('backend_url').replace(/\/+$/u, '');
  const backendIsUrl = /^https?:\/\//u.test(backendUrl);
  if (backendUrl !== '' && backendUrl !== 'memory' && !backendIsUrl) {
    throw new Error('memory.backend_url 要写 memory 或 HTTP(S) 地址（vgr 已不用）');
  }

  //G service_url 必须是 Rust 的 HTTP(S) 入口。
  let serviceUrl = text('service_url').replace(/\/+$/u, '');
  if (serviceUrl !== '' && !/^https?:\/\//u.test(serviceUrl)) throw new Error('memory.service_url 要写 HTTP(S) 地址');

  //M 没写 service_url：旧 backend_url 是地址就用它（旧配置照常），再没有用默认的 30087。
  if (serviceUrl === '' && backendIsUrl) {
    serviceUrl = backendUrl;
  }
  if (serviceUrl === '') {
    serviceUrl = DEFAULT_SERVICE_URL;
  }

  //M 数字项用 count 读（不写用默认值，写错抛错）、字符串项用 text 读；聊天记录进不进关系图的规则交给 GraphPolicy 的 readGraphPolicy 读。
  return {
    history: raw['history'] !== false, recallHistory: count('recall_history', 3), recallKnowledge: count('recall_knowledge', 3),
    serviceUrl, token: text('backend_token'), timeoutMs: count('backend_timeout_ms', 8000) || 8000,
    sessionsToRust: backendUrl !== '',
    graph: graphPolicy.readGraphPolicy(raw),
  };
}


/**
 * 记忆库与关系图的 HTTP 接口（http 插件在才登记）：
 * GET /api/memory/recall?q=&scope=history|knowledge|all&bot=&customer=&session=&limit= → {backend, hits}（给网页、别的服务查）；
 * POST /api/memory/knowledge {bot?, name, content} 写一篇知识库文件并马上收进去；GET /api/memory/backend 后端状态；
 * GET /api/memory/health 直探 Rust；以及由原 memory-graph 并入的 /graph/、/api/memory-graph/* 路由。
 * Rust 自己的界面和其它接口由 programs 插件挂在 /programs/jmbots-memory/ 下，本插件不再转发。
 */
function routes(
  ctx: cordis.Context,
  store: storeModule.Store,
  graphRoutes: graphRoutesModule.GraphRoutes,
  service: MemoryService,
): void {
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
      if (bot !== '' && botUtils.getBotConfig(ctx.resources.raw, bot) === undefined) return reply.code(400).send({ error: `没有这个机器人：${bot}` });
      try {
        //M 写一篇知识库文件并马上收进记忆库，成功交回文件路径；失败（名字不合法之类）回 400 并带原因。
        return { file: await store.writeKnowledge(bot, body['name'], body['content']) };
      } catch (error) {
        return reply.code(400).send({ error: textModule.getErrorMessage(error) });
      }
    });

    //M Rust 运行状态由 memory 直接探测，旧 URL 归本插件提供。
    app.get('/api/memory/health', async () => service.health());
    //M 管理页可查看 SQLite 备份和 Rust 后端状态（进程状态看 programs 的 /api/programs）。
    app.get('/api/memory/backend', async () => store.health());

    //M 关系图的页面和 /api/memory-graph/* 接口也挂到同一个 http 上。
    graphRoutes.mountRoutes(app);
    //M 统一检索与模型走同一份数据源和排名。
    service.unified.mount(app, graphRoutes);
  });
}
