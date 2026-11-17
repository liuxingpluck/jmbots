/**
 * web-api：HTTP 渠道，加上网页要的全部核心接口。
 * 它是一个渠道（渠道名 http）：POST /api/message 收话，记进自己的收件表 web_messages，用消息号当回话地址推给机器人；
 * 会话回话时（中途说的 bot/say、这一轮的结果）把话追加到那条消息的回话清单里。HTTP 不主动推：网页轮询 GET /api/messages。
 * 别的渠道（飞书、命令行）的消息也记一份，网页右栏“消息”靠它。
 * 另外接网页的会话列表和详情、步骤、换模型、喊停、正在跑的任务、回话追溯、机器人、界面信息、渠道状态。
 * 不查令牌（http 统一查：本机不查，别的机器要带）；不托管网页（web）；不分派（前台 bot-front-desk）。
 * 文件：本文件（渠道和会话、机器人的接口）、Timeline.ts（收件表、时间线、补取、搜索）、Trace.ts（步骤、追溯、生成依据）。
 * 设计：docs/src7插件设计/web-api.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as embedded from '../../utils/Embedded.ts';
import * as versions from '../../utils/Versions.ts';
import type * as fastify from 'fastify';
import type { Thinking } from '../../Chat.ts';
import type { Session, SessionMeta } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';
import * as timelineModule from './Timeline.ts';
import * as traceModule from './Trace.ts';


/** 插件名。 */
export const name = 'web-api';

/**
 * 用到的服务。渠道收发向 bots 登记（bots.channel / bots.receive）；还要 resources；会话接口要 sessions；登记接口要 http。
 * 可选的 approval、journal、usage、modelCatalog 不写在这里：写进 inject 就成了“必须有”，没挂它们的人连消息都收不了。
 * 它们在用到的那一刻 ctx.get('名字') 现取，没挂就是 undefined。
 */
export const inject = ['resources', 'bots', 'sessions', 'http'];


/** 一个渠道连接的状态，给网页左下角的圆点（web/src/Bots/Connections.tsx:41-46 只认 feishu 开头的 name）。 */
export interface ChannelStatus {
  /** 'feishu:<应用号>' 这样；网页按 name 开头认渠道。 */
  name: string;
  /** 这条连接属于哪个机器人。 */
  bot?: string;
  /** 通不通。 */
  connected: boolean;
  /** 鼠标放上去的一句话，如“长连接已连上”“断了：原因”。 */
  detail: string;
}


declare module 'cordis' {
  interface Events {
    /** GET /api/ui/status 每来一次就挨个问（ctx.serial）：每个渠道往 list 里 push 自己的一项或几项。监听的函数不许有返回值。 */
    'web-api/status'(list: ChannelStatus[]): void | Promise<void>;
    /** 收件表记下一条（HTTP 的、别的渠道的都算）。只是通知，journal 听。 */
    'web-api/received'(message: { id: number; bot: string; channel: string; source: string; text: string; at: number }): void;
    /** 一句回话追加进收件表，replyIndex 是它在 replies 里的下标。只是通知，journal 听。 */
    'web-api/replied'(reply: { messageId: number; replyIndex: number; session: Session; text: string; at: number }): void;
    /** 网页换了会话的模型。只是通知，journal 听。 */
    'web-api/model'(change: { session: Session; from: string; to: string; thinkingFrom: string; thinkingTo: string; by: 'HTTP' }): void;
  }
}


/** 审核服务 approval 的样子（approval.md 第 2 节）。还没写好、也可能没挂，这里只按约定写结构，不 import 它。 */
interface ApprovalLike {
  list(): { bot: string; session?: string }[];
}


/** POST /api/message 的请求体：外面进来的，accept 里校验一次。 */
interface MessageBody {
  text?: unknown;
  bot?: unknown;
  from?: unknown;
  images?: unknown;
  uploads?: unknown;
  session?: unknown;
  reply_to?: unknown;
}


/** 步骤默认几步、最多几步（同 src6/channels/HttpSessions.ts:432-444）。 */
const STEPS_DEFAULT = 100;
const STEPS_MAX = 500;


/** HTTP 渠道和网页接口。 */
class WebApi {
  /** 渠道名：会话记着它，回话靠它认回来。 */
  readonly name = 'http';

  /** 挂上的时刻：网页靠 /api/ui/info 的它认出后端换了进程（web/src/Api.ts:795）。 */
  readonly startedAt = Date.now();

  /** 收件表和时间线。 */
  private readonly timeline: timelineModule.Timeline;

  /**
   * 建收件表；听别的渠道的消息和回话；在一个 Fastify 作用域里登记全部接口。
   * 向 bots 登记本渠道的发送函数；一轮结束回话和中途先说一句由 bots 按渠道名调用，只管 channel 是 http 的会话。
   * @param ctx Cordis 给这个插件的 ctx：在它上面 ctx.on 听的事件，插件被拔掉时 Cordis 自动撤掉。
   */
  constructor(private readonly ctx: cordis.Context) {
    this.ctx.effect(() => this.ctx.bots.channel(this.name, (reply, session) => this.send(reply, session)));
    this.timeline = new timelineModule.Timeline(ctx);

    //M 别的渠道的消息：bot/receive 是“挨个问”（ctx.serial），这里只读不改、不写 handled；http 的已经在 accept 里记过。
    ctx.on('bot/receive', (event) => {
      const message = event.message;
      if (message.channel === this.name) return;

      const address = JSON.stringify(message.address ?? null);
      const id = this.timeline.insert({
        bot: message.bot, channel: message.channel, source: message.channel, text: message.text, address,
      });
      if (event.session !== undefined) {
        ctx.resources.db.query('UPDATE web_messages SET session_id = ? WHERE id = ?').run(event.session.id, id);
      }
    });

    //M 别的渠道的会话回话（中途说的、这一轮的结果）：按（机器人、渠道、地址）找回那一行追加。
    ctx.on('bot/say', (session, text) => {
      this.recordOther(session, text);
    });
    ctx.on('session/change', (session) => {
      if (session.row.state !== 'running') this.recordOther(session, session.row.reply);
    });

    //M 路由登记在一个作用域里（register 开出来的子作用域）：这里设的错误处理只管这些接口，出错统一回 { error }。
    //M Fastify 在 http 开始监听时才执行这个函数，那时别的插件的路径都登记好了，hasRoute 查得到。
    ctx.http.app.register(async (scope) => {
      scope.setErrorHandler(async (error, _request, reply) => {
        //M 自己抛的 Failure 照它的状态码；Fastify 自己的错（比如请求体不是 JSON）带 statusCode；别的算 500。
        const status = error instanceof traceModule.Failure ? error.status : ((error as { statusCode?: number }).statusCode ?? 500);
        await reply.code(status).send({ error: textModule.messageOf(error) });
        return reply;
      });
      this.routes(scope);
      this.timeline.routes(scope);
    });
  }

  /**
   * 登记会话、机器人、界面信息、追溯这些接口。
   * @param scope 上面开的作用域。
   */
  private routes(scope: fastify.FastifyInstance): void {
    type Query = { Querystring: Record<string, string | undefined> };
    type Id = { Params: { id: string } };
    scope.post<{ Body: unknown }>('/api/message', async (request) => this.accept(request.body));
    scope.get<Id & Query>('/api/messages/:id/trace', async (request) => this.trace(request.params.id, request.query['reply']));
    scope.get<Query>('/api/sessions', async (request) => this.sessionList(request.query));
    scope.get<Query>('/api/ui/sessions', async (request) => this.sessionList(request.query));
    scope.get<Query>('/api/ui/running', async (request) => this.runningList(request.query));
    scope.get<Id>('/api/sessions/:id', async (request) => this.sessionDetail(request.params.id));
    scope.get<Id & Query>('/api/sessions/:id/steps', async (request) => {
      const row = this.open(request.params.id).row;

      //M 网址里的 after、limit：写错按默认，超上限按上限。
      const after = textModule.numberOf(request.query['after'], 0, 0, Infinity);
      const limit = textModule.numberOf(request.query['limit'], STEPS_DEFAULT, 0, STEPS_MAX);
      return traceModule.steps(row, after, limit);
    });
    scope.post<Id & { Body: unknown }>('/api/sessions/:id/model', async (request) => this.setModel(request.params.id, request.body));
    scope.post<Id & { Body: unknown }>('/api/sessions/:id/stop', async (request) => this.stop(request.params.id, request.body));
    scope.get('/api/bots', async () => this.botList());
    scope.get<{ Params: { name: string } }>('/api/ui/bots/:name', async (request) => this.botInfo(request.params.name));
    scope.get('/api/ui/info', async () => this.uiInfo());
    scope.get('/api/ui/status', async () => {
      const list: ChannelStatus[] = [];
      await this.ctx.serial('web-api/status', list);
      return { channels: list };
    });
  }

  /**
   * 左下角版本：后端版本和编译时间；能连上基地时再带上壳子 jmbots.exe 的版本。
   * version / builtAt 仍放在顶层，兼容原先只读这两项的网页。
   */
  private async uiInfo(): Promise<{
    startedAt: number;
    version: string;
    builtAt: number;
    server: { version: string; builtAt: number };
    shell: { version: string; builtAt: number } | null;
  }> {
    const builtAt = embedded.builtTime();
    const server = { version: versions.VERSION, builtAt };
    const shell = await this.shellVersion();
    return { startedAt: this.startedAt, version: server.version, builtAt: server.builtAt, server, shell };
  }

  /**
   * 通过可选的基地服务问壳子版本，不再另猜本机端口。
   * 连不上或旧壳子没有 /version 就当没有，不挡界面信息。
   */
  private async shellVersion(): Promise<{ version: string; builtAt: number } | null> {
    //M 后端版本与 startedAt 不依赖基地；基地不可用只让 shell 为 null，接口仍回 200。
    const base = this.ctx.get('base');
    if (base === undefined) return null;
    try {
      const response = await base.getJson('/version', 800);
      if (response.status < 200 || response.status >= 300) return null;
      const body = (response.body ?? {}) as { version?: unknown; builtAt?: unknown };
      if (typeof body.version !== 'string' || body.version.trim() === '') return null;
      const builtAt = typeof body.builtAt === 'number' && Number.isFinite(body.builtAt) ? body.builtAt : 0;
      return { version: body.version.trim(), builtAt };
    } catch {
      return null;
    }
  }

  /**
   * POST /api/message：校验、存附件、记一行、推给机器人。
   * @param raw 请求体。
   * @returns { id: 消息号, file: '' }（src7 不给每条消息写文件）。
   * @throws Failure(400)：字段不对、没有这个机器人、没有这场会话、上传号不在了、推给机器人失败。
   */
  private async accept(raw: unknown): Promise<{ id: number; file: string }> {
    //M 外面进来的，这里校验一次。
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new traceModule.Failure(400, '请求体要是 JSON 对象');

    const body = raw as MessageBody;
    const text = body.text ?? '';
    if (typeof text !== 'string') throw new traceModule.Failure(400, 'text 要是字符串');

    const from = body.from ?? 'http';
    if (typeof from !== 'string' || from === '') throw new traceModule.Failure(400, 'from 要是非空字符串');

    //M 指定了会话就直接交给它（不分派）；机器人不写就用会话的，会话也没有就用名单第一个。
    const sessionId = body.session ?? '';
    if (typeof sessionId !== 'string') throw new traceModule.Failure(400, 'session 要是字符串');

    let session = sessionId === '' ? undefined : this.ctx.sessions.find({ id: sessionId })[0];
    if (sessionId !== '' && session === undefined) throw new traceModule.Failure(400, `没有这场会话：${sessionId}`);

    let quoted: timelineModule.MessageRecord | undefined;
    if (body.reply_to !== undefined) {
      if (typeof body.reply_to !== 'number' || !Number.isSafeInteger(body.reply_to) || body.reply_to <= 0) {
        throw new traceModule.Failure(400, 'reply_to 要是正整数');
      }
      quoted = this.timeline.get(body.reply_to);
      if (quoted === undefined) throw new traceModule.Failure(400, '被回复的消息不存在');
    }
    const wanted = body.bot ?? quoted?.bot ?? session?.bot ?? this.ctx.bots.list()[0]?.name;
    if (typeof wanted !== 'string' || this.ctx.bots.get(wanted) === undefined) {
      throw new traceModule.Failure(400, `没有这个机器人：${String(wanted)}`);
    }
    if (session !== undefined && session.bot !== wanted) {
      throw new traceModule.Failure(400, `会话 ${session.id} 是机器人 ${session.bot} 的，不是 ${wanted} 的`);
    }

    if (quoted !== undefined && quoted.bot !== wanted) {
      throw new traceModule.Failure(400, '不能回复其他机器人的消息');
    }
    //M 外部渠道回复必须回到原会话；不重新分派，避免混入网页上下文。
    const external = quoted?.channel !== undefined && quoted.channel !== this.name ? quoted : undefined;
    if (external) {
      const target = external.sessionId === null ? undefined : this.ctx.sessions.find({ id: external.sessionId })[0];
      if (target === undefined) throw new traceModule.Failure(400, '被回复的消息尚未关联会话');
      if (session !== undefined && session.id !== target.id) {
        throw new traceModule.Failure(400, '指定会话与被回复消息的会话不同');
      }
      session = target;
    }

    //M 附件先都读到手（任何一个不对就 400，什么都不存），再存进机器人工作区，最后删掉用过的上传。
    const files = [...this.images(body.images), ...this.uploads(body.uploads)];
    if (text.trim() === '' && files.length === 0) throw new traceModule.Failure(400, 'text 和附件至少要有一样');

    const paths: string[] = [];
    try {
      for (const file of files) {
        paths.push(this.ctx.bots.saveFile(wanted, file.name, file.data));
      }
    } catch (error) {
      throw new traceModule.Failure(400, `附件存不下：${textModule.messageOf(error)}`);
    }
    for (const file of files) {
      if (file.upload !== undefined) fs.rmSync(file.upload, { force: true });
    }

    //M 附件写成 @绝对路径 接在话后面（路径里有空白就加引号），模型用 read 工具就能读到。
    const said = [text, ...paths.map((item) => (/\s/u.test(item) ? `@"${item}"` : `@${item}`))].filter((item) => item !== '').join('\n');
    const channel = external ? external.channel : this.name;
    const address = external ? external.address : null;
    const id = this.timeline.insert({
      bot: wanted, channel, source: from, text: said, address,
      ...(quoted === undefined ? {} : { reply_to: quoted.id }),
    });
    const input = quoted === undefined ? said : `【回复 ${this.timeline.peer(quoted)} 的消息：${quoted.text.slice(0, 500)}】\n${said}`;

    //T 跟踪：收下一条消息。
    const vars = { 消息号: id, 机器人: wanted, 附件几个: paths.length, 指定会话: sessionId === '' ? '（没有）' : sessionId };
    this.ctx.emit('trace', 'WebApi.accept', '收下一条消息，推给机器人', session === undefined ? 'receive(bot, text, { messageId })' : 'bot.hand(text, origin, sessionId)', vars);

    //M 推给机器人；回话地址就是消息号。推不进去（比如没有插件管分派）就删掉这一行，告诉调用方。
    try {
      if (session === undefined) {
        await this.ctx.bots.receive(this.name, wanted, input, { messageId: id, customer: 'http:本机' });
      } else {
        const origin = { channel, address: external ? JSON.parse(address ?? 'null') : { messageId: id, customer: 'http:本机' } };
        this.ctx.resources.db.query('UPDATE web_messages SET session_id = ? WHERE id = ?').run(session.id, id);
        //M 接着已有会话发不走 bot/receive：挂了 flow 就在这里让它认快照关键词（去掉关键词、记下这场会话要拍），和 bot/receive 那处同一个判断。
        const handed = this.ctx.get('flow')?.mark(input, session.id) ?? input;
        this.ctx.bots.get(wanted)?.hand(handed, origin, session.id);
      }
    } catch (error) {
      this.timeline.remove(id);
      throw new traceModule.Failure(400, textModule.messageOf(error));
    }
    return { id, file: '' };
  }

  /**
   * 请求体里的 images：[{ name?, data: base64 }]，data 前面可以带 data:...;base64, 头。
   * @param value 请求体的 images。
   * @returns 文件名和内容。
   * @throws Failure(400)：形状不对。
   */
  private images(value: unknown): { name: string; data: Uint8Array; upload?: string }[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new traceModule.Failure(400, 'images 要是数组：[{ name?, data }]');

    return value.map((item: unknown, index) => {
      const image = (typeof item === 'object' && item !== null ? item : {}) as { name?: unknown; data?: unknown };
      if (typeof image.data !== 'string' || image.data === '') throw new traceModule.Failure(400, `images[${String(index)}].data 要是 base64 字符串`);

      const name = typeof image.name === 'string' && image.name !== '' ? image.name : `图片${String(index + 1)}.png`;
      return { name, data: Buffer.from(image.data.replace(/^data:[^,]*,/u, ''), 'base64') };
    });
  }

  /**
   * 请求体里的 uploads：files-api 给的上传号（20 位数字）。按前缀在 data/tmp/uploads/ 里找 <上传号>_<文件名>（和 files-api 的约定）。
   * @param value 请求体的 uploads。
   * @returns 文件名、内容、暂存文件的路径（用完删）。
   * @throws Failure(400)：形状不对、上传号不在了（用过或过期删了）。
   */
  private uploads(value: unknown): { name: string; data: Uint8Array; upload: string }[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new traceModule.Failure(400, 'uploads 要是上传号的数组');

    const dir = this.ctx.resources.dir('data', 'tmp', 'uploads');
    const names = fs.readdirSync(dir);
    return value.map((id: unknown) => {
      if (typeof id !== 'string' || !/^\d{20}$/u.test(id)) throw new traceModule.Failure(400, `上传号要是 20 位数字：${String(id)}`);

      const found = names.find((item) => item.startsWith(`${id}_`));
      if (found === undefined) throw new traceModule.Failure(400, `上传号不在了（用过了，或者没传上）：${id}`);

      const upload = path.join(dir, found);
      return { name: found.slice(id.length + 1), data: fs.readFileSync(upload), upload };
    });
  }

  /**
   * 渠道基类要的：把机器人的话交给用户。HTTP 不主动推，就是追加到那条消息的回话清单里，网页轮询时看到。
   * @param reply 要说的话。
   * @param session 哪场会话说的；回话地址从 session.row.address 取（收话时记的 { messageId }，直接信，不再校验）。
   */
  protected send(reply: string, session: Session): void {
    const address = session.row.address as { messageId?: unknown } | undefined;
    if (typeof address?.messageId !== 'number') return;

    this.timeline.reply(address.messageId, session, reply);
  }

  /**
   * 别的渠道的会话回话：会话有渠道、又不是 http 的，按（机器人、渠道、地址）找回最新那一行追加。找不到就不记。
   * @param session 哪场会话。
   * @param text 说的话。
   */
  private recordOther(session: Session, text: string): void {
    const row = session.row;
    if (row.channel === undefined || row.channel === this.name || text === '') return;

    const id = this.timeline.findByAddress(row.bot, row.channel, JSON.stringify(row.address ?? null));
    if (id !== undefined) this.timeline.reply(id, session, text);
  }

  /**
   * 会话简要：列表、详情、搜索共用（web/src/Api.ts:335-352 的 SessionBrief）。
   * @param meta 会话记录。
   */
  private brief(meta: SessionMeta): Record<string, unknown> {
    return {
      id: meta.id,
      bot: meta.bot,
      kind: meta.kind,
      parent: meta.parent,
      customer: typeof (meta as { customer?: unknown }).customer === 'string' ? (meta as { customer?: string }).customer : '',
      workspace: 'workspace',
      title: timelineModule.title(meta),
      summary: meta.summary ?? '',
      model: meta.model,
      status: timelineModule.statusOf(meta.state),
      updatedAt: meta.updatedAt,
      files: { ...timelineModule.sessionFiles(this.ctx.resources.root, meta), compact: '' },
    };
  }

  /**
   * GET /api/sessions、/api/ui/sessions：一个机器人的会话（只给没有 parent 的，小会话不给网页看），最近动过的在前。
   * @param query bot（不写是第一个）、status（idle、running、error）。
   */
  private sessionList(query: Record<string, string | undefined>): Record<string, unknown>[] {
    const bot = this.timeline.botOf(query['bot']);
    if (bot === undefined) return [];

    const status = query['status'];
    if (status !== undefined && status !== '' && !['idle', 'running', 'error'].includes(status)) {
      throw new traceModule.Failure(400, 'status 要是 idle、running 或 error');
    }
    return this.ctx.sessions.find({ bot })
      .filter((meta) => meta.parent === undefined)
      .filter((meta) => status === undefined || status === '' || timelineModule.statusOf(meta.state) === status)
      .map((meta) => this.brief(meta));
  }

  /**
   * GET /api/ui/running：当前机器人正在跑的前台和后台会话（含有 parent 的子会话），给右栏「正在运行」。
   * 每条带标题、客户/渠道标签、本轮开始时间和最新进度（progress、assist 待办、对话里最近的工具调用）。
   * @param query bot（不写是第一个）。
   */
  private runningList(query: Record<string, string | undefined>): Record<string, unknown>[] {
    const bot = this.timeline.botOf(query['bot']);
    if (bot === undefined) return [];

    const progress = this.ctx.get('progress') as ProgressLike | undefined;
    const cards = progress?.list(bot) ?? [];
    return this.ctx.sessions.find({ bot, state: 'running' }).map((meta) => {
      const card = cards.find((item) => item.sessionId === meta.id && item.endedAt === undefined);
      const session = this.ctx.sessions.open(meta.id);
      const customer = typeof (meta as { customer?: unknown }).customer === 'string'
        ? (meta as { customer: string }).customer : '';
      const startedAt = card?.startedAt ?? runStartedAt(session, meta.updatedAt);
      const action = card?.action
        || assistDoing(this.ctx.resources.db, meta.id)
        || latestAction(session, meta.kind);
      return {
        id: meta.id,
        kind: meta.kind,
        parent: meta.parent,
        title: runningTitle(meta),
        customer,
        customerLabel: customerLabel(customer),
        status: 'running',
        startedAt,
        updatedAt: meta.updatedAt,
        action,
      };
    });
  }

  /**
   * 打开一场会话。
   * @param id 会话号。
   * @throws Failure(404)：没有这场。
   */
  private open(id: string): Session {
    if (this.ctx.sessions.find({ id }).length === 0) throw new traceModule.Failure(404, `没有这场会话：${id}`);

    return this.ctx.sessions.open(id);
  }

  /**
   * GET /api/sessions/:id：会话详情（web/src/Types.ts:566-595 的 SessionDetail）。
   * @param id 会话号。
   */
  private sessionDetail(id: string): Record<string, unknown> {
    const row = this.open(id).row;
    const brief = this.brief(row);
    const files = timelineModule.sessionFiles(this.ctx.resources.root, row);
    const last = row.messages.findLast((item) => item.role === 'assistant');
    return {
      ...brief,
      thinking: row.thinking,
      //M 上一次调模型时的上下文：最后一条模型回答的输入加缓存读。
      tokens: last?.role === 'assistant' ? last.usage.input + last.usage.cacheRead : 0,
      runs: [],
      createdAt: row.messages[0]?.timestamp ?? row.updatedAt,
      files,
      md: files.md === '' ? '' : fs.readFileSync(files.md, 'utf8'),
    };
  }

  /**
   * POST /api/sessions/:id/model：换会话的模型和思考档，在转的会话下一步就用新的（骨架每一步现读 row.model、row.thinking）。
   * @param id 会话号。
   * @param raw { model, thinking }：thinking 是 null 取这个模型支持的最高一档。
   * @throws Failure：没挂 model-catalog 503；没有这场 404；模型不在清单、不是 chat、思考档不支持 400。
   */
  private setModel(id: string, raw: unknown): Record<string, unknown> {
    //M model-catalog 是可选的：用到这一刻才 ctx.get 取，没挂就是 undefined。
    const catalog = this.ctx.get('modelCatalog');
    if (catalog === undefined) throw new traceModule.Failure(503, '没挂 model-catalog，换不了模型');

    const session = this.open(id);
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as { model?: unknown; thinking?: unknown };
    if (typeof body.model !== 'string' || body.model === '') throw new traceModule.Failure(400, 'model 要是非空字符串');

    const info = catalog.find(body.model);
    if (info === undefined || info.kind !== 'chat') throw new traceModule.Failure(400, `模型不可用：${body.model}`);

    let thinking: string;
    if (body.thinking === null || body.thinking === undefined) {
      thinking = info.thinking.at(-1) ?? 'off';
    } else if (typeof body.thinking === 'string' && info.thinking.includes(body.thinking)) {
      thinking = body.thinking;
    } else {
      throw new traceModule.Failure(400, `思考档 ${String(body.thinking)} 这个模型不支持，支持：${info.thinking.join('、')}`);
    }

    const row = session.row;
    const change = { session, from: row.model, to: body.model, thinkingFrom: row.thinking, thinkingTo: thinking, by: 'HTTP' as const };
    row.model = body.model;
    row.thinking = thinking as Thinking;
    session.save();

    //T 跟踪：换了模型。
    const vars = { 会话: id, 原来: `${change.from} ${change.thinkingFrom}`, 换成: `${change.to} ${change.thinkingTo}` };
    this.ctx.emit('trace', 'WebApi.setModel', '网页换了会话的模型', 'row.model = model; session.save()', vars);
    this.ctx.emit('web-api/model', change);
    return { id, model: row.model, thinking: row.thinking, status: timelineModule.statusOf(row.state) };
  }

  /**
   * POST /api/sessions/:id/stop：喊停。正在等的模型请求马上掐掉；骨架加了停止信号以后，慢的工具也跟着断开。
   * @param id 会话号。
   * @param raw { reason? }：不写是“HTTP”。
   */
  private stop(id: string, raw: unknown): Record<string, unknown> {
    const session = this.open(id);
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as { reason?: unknown };
    const reason = typeof body.reason === 'string' && body.reason !== '' ? body.reason : 'HTTP';
    if (session.row.state !== 'running') {
      return { id, stopped: false, status: timelineModule.statusOf(session.row.state), reason: '会话没在跑' };
    }

    session.stop(reason);
    //M stop() 里改了状态；TypeScript 以为上面查过就还是 running，这里按普通字符串再看一次。
    const stopped = (session.row.state as string) === 'stopped';
    const result = { id, stopped, status: timelineModule.statusOf(session.row.state) };

    //G 记录上是在转，这个进程里却没有在转的循环（上次没跑完、重启后还没接着跑）→ 没停下，说清楚。
    return stopped ? result : { ...result, reason: '会话记录是在转，但这个进程里没有在跑的循环' };
  }

  /** GET /api/bots：机器人列表，状态按“等确认 → 干活 → 闲着”（同 0.4：HttpUi.ts:400-418；src7 不排队，queued 是 0）。 */
  private botList(): Record<string, unknown>[] {
    const approval = this.ctx.get('approval') as ApprovalLike | undefined;
    const pending = approval?.list() ?? [];
    return this.ctx.bots.list().map((bot) => {
      //M 干活中的后台子会话也算（有 parent，不出现在会话下拉里，但机器人应显示在干活）。
      const running = this.ctx.sessions.find({ bot: bot.name, state: 'running' }).length;
      const approvals = pending.filter((item) => item.bot === bot.name && item.session !== undefined && item.session !== '').length;
      const status = approvals > 0 ? 'waiting' : running > 0 ? 'working' : 'idle';
      const language = typeof bot.config['language'] === 'string' ? bot.config['language'] : 'zh';
      return { name: bot.name, language, status, running, queued: 0, approvals };
    });
  }

  /**
   * GET /api/ui/bots/:name：一个机器人的目录、工作区、记忆概要（web/src/Api.ts:438-449 的 BotInfo）。
   * @param botName 机器人名。
   * @throws Failure(404)：没有这个机器人。
   */
  private botInfo(botName: string): Record<string, unknown> {
    const bot = this.ctx.bots.get(botName);
    if (bot === undefined) throw new traceModule.Failure(404, `没有这个机器人：${botName}`);

    const index = ['索引.md', 'index.md'].map((file) => path.join(bot.memory, file)).find((file) => fs.existsSync(file));
    return {
      name: bot.name,
      language: typeof bot.config['language'] === 'string' ? bot.config['language'] : 'zh',
      paths: {
        botDir: path.join(this.ctx.resources.root, 'bots', bot.name),
        messageDir: path.join(bot.workspace, 'inbox'),
        workspaceRoot: bot.workspace,
        memoryDir: bot.memory,
      },
      workspaces: [{ name: 'workspace', description: '机器人的工作区：工具在这里读写文件，收到的附件在 inbox/ 下', dir: bot.workspace }],
      memoryIndex: index === undefined ? '' : fs.readFileSync(index, 'utf8'),
    };
  }

  /**
   * GET /api/messages/:id/trace?reply=N：一句回话的追溯。
   * @param id 消息号。
   * @param reply 回话下标，从 0 起。
   * @throws Failure：reply 不是非负整数 400；消息不在、下标越界 404。
   */
  private trace(id: string, reply: string | undefined): Record<string, unknown> {
    if (reply === undefined || !/^\d+$/u.test(reply)) throw new traceModule.Failure(400, 'reply 要是非负整数（回话下标，从 0 起）');

    const message = this.timeline.get(Number(id));
    if (message === undefined) throw new traceModule.Failure(404, `没有这条消息：${id}`);

    const replyIndex = Number(reply);
    const sessionId = message.replies[replyIndex]?.sessionId;
    const meta = sessionId === undefined ? undefined : this.ctx.sessions.find({ id: sessionId })[0];
    const sessionTitle = meta === undefined ? null : timelineModule.title(meta);
    return traceModule.trace(this.ctx, { message, replyIndex, sessionTitle, association: this.timeline.association(message.id) });
  }
}


/** 进度插件的只读外形：没挂 progress 时 runningList 不用它。 */
interface ProgressLike {
  list(bot?: string): { sessionId: string; action: string; startedAt: number; endedAt?: number }[];
}


/**
 * 正在跑的会话标题：有总结用总结；没有就写成「前台 会话 <号>」或「后台 会话 <号>」。
 * @param meta 会话记录。
 */
function runningTitle(meta: SessionMeta): string {
  const raw = timelineModule.title(meta);
  if (!raw.startsWith('会话 ')) return raw;
  return `${meta.kind === 'front' ? '前台' : '后台'} ${raw}`;
}


/**
 * 客户号写成短标签：网页、飞书、飞书群、微信，或渠道名。
 * @param customer 渠道:用户；没有是空串。
 */
function customerLabel(customer: string): string {
  if (customer === '') return '';
  if (customer === 'http:本机' || customer.startsWith('http:')) return customer === 'http:本机' ? '网页' : `网页`;
  if (customer.startsWith('feishu:group:')) return '飞书群';
  if (customer.startsWith('feishu:')) return '飞书';
  if (customer.startsWith('wechat:')) return '微信';
  const cut = customer.indexOf(':');
  return cut <= 0 ? customer : customer.slice(0, cut);
}


/**
 * 本轮开始时间：最近一条用户消息的时刻（后台就是这次交办的那句）；没有就用 updatedAt。
 * @param session 正在跑的会话（内存里就有）。
 * @param fallback 找不到用户消息时用。
 */
function runStartedAt(session: Session, fallback: number): number {
  const messages = session.row.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item !== undefined && item.role === 'user') {
      return typeof item.timestamp === 'number' ? item.timestamp : fallback;
    }
  }
  return fallback;
}


/** assist 待办一行的外形。 */
interface TodoItem { text?: unknown; status?: unknown }

/**
 * 这场会话最新一份待办里，正在做的那一项；没有待办或表不存在就返回空。
 * @param db 运行时库。
 * @param sessionId 会话号。
 */
function assistDoing(db: unknown, sessionId: string): string {
  try {
    const sqlite = db as { query: (sql: string) => { get: (...values: string[]) => unknown } };
    const row = sqlite.query("SELECT data FROM assist_items WHERE kind = 'todo' AND session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId) as { data: string } | null;
    if (row === null || row === undefined) return '';
    const parsed = JSON.parse(row.data) as { items?: TodoItem[] };
    const items = parsed.items ?? [];
    const doing = items.find((item) => item.status === 'doing' && typeof item.text === 'string' && item.text.trim() !== '');
    const text = doing?.text ?? items.find((item) => item.status === 'todo' && typeof item.text === 'string' && item.text.trim() !== '')?.text;
    return typeof text === 'string' ? text.trim().slice(0, 80) : '';
  } catch {
    return '';
  }
}


/**
 * 从对话里推最新进度：正在调哪个工具、在想下一步、在写回答；看不出来就写前台/后台处理中。
 * @param session 正在跑的会话。
 * @param kind front 或 work。
 */
function latestAction(session: Session, kind: string): string {
  const messages = session.row.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item === undefined) continue;
    if (item.role === 'toolResult') return '在想下一步';
    if (item.role === 'assistant' && Array.isArray(item.content)) {
      const call = item.content.find((block) => block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'toolCall') as { name?: unknown } | undefined;
      if (typeof call?.name === 'string' && call.name !== '') return `正在调用 ${call.name}`;
      return '在写回答';
    }
  }
  return kind === 'front' ? '前台处理中' : '后台运行中';
}


/**
 * 挂上 web-api。
 * apply 是 Cordis 插件的入口：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 先等 inject 里的 resources、bots、sessions、http
 * 都就绪，再调一次 apply(ctx)。http 等事件 ready（全部插件挂完）才开始监听，所以这里登记的接口赶得上。
 * 拔掉插件时，ctx.on 听的事件 Cordis 自动撤掉；Fastify 开始监听后不能删路径，接口要重启才没。没有配置。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  new WebApi(ctx);
}
