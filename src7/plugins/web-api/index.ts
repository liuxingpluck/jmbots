/**
 * web-api：HTTP 渠道，加上网页要的全部核心接口。
 * 它是一个渠道（渠道名 http）：POST /api/message 收话，记进自己的收件表 web_messages，用消息号当回话地址发 channel/message；
 * 模型一轮里每调一次 channel_reply（还有零次兜底、审批直回）都经 channel/reply 追加到那条消息的回话清单，一轮收尾（channel/settled）标成回完。
 * HTTP 不主动推：网页轮询 GET /api/messages。
 * 别的渠道（飞书、命令行、微信）的消息也记一份（带标准消息号），回话按“消息号 + 机器人”挂回，网页右栏“消息”靠它。
 * 另外接网页的会话列表和详情、步骤、换模型、喊停、正在跑的任务、回话追溯、机器人、界面信息、渠道状态。
 * 不查令牌（http 统一查：本机不查，别的机器要带）；不托管网页（web）；不分派（前台在 bots 里）。
 * 文件：本文件（渠道和会话、机器人的接口）、Timeline.ts（收件表、时间线、补取、搜索）、Trace.ts（步骤、追溯、生成依据）。
 * 设计：docs/src7插件设计/web-api.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as embedded from '../../utils/Embedded.ts';
import * as versions from '../../utils/Versions.ts';
import type * as fastify from 'fastify';
import type { Session, SessionMeta, Thinking } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';
import * as timelineModule from './Timeline.ts';
import * as traceModule from './Trace.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as checksModule from '../../utils/Checks.ts';
import * as protocol from '../../Channels.ts';
import { WebHistory } from './History.ts';


/** 插件名。 */
export const name = 'web-api';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.1.2：新增 History.ts（WebHistory）响应 channel/history，支持本人跨渠道与网页会话查历史。
//M 1.1.3：指定会话、引用别的渠道的消息也走 channel/message（routing.sessionId、replyOrigin），去掉 bot.hand 旁路；
//M   网页改成 channel_tool：一轮里 channel_reply 几次就追加几条，收尾（channel/settled）才标回完；role 写 owner；
//M   别的渠道的回话按“标准消息号 + 机器人”精确挂回（source_id 列），不再按地址找最新一行。
//M 1.1.4：网页入站地址带 owner: true（“同意 N”可批所有待确认）；replyDirect 支持跨渠道发往网页的回复落入时间线。
//M 1.1.5：registerTextReply 接入 getTargetAddress 自行识别网页跨渠道发话目标；带 target 的跨渠道请求不串挂回原入站行。
//M 1.1.6：模型目录、进度、流水和用量改用请求与回执事件；清理分支写法。
export const version = '1.1.8';

/** 网页端跨渠道/跨聊天回复允许认出的本机聊天名称集合。 */
const WEB_TARGET_CHATS = new Set(['', '本机', 'http:本机', '网页', 'local', 'web']);

/**
 * 用到的服务。渠道收发向 bots 登记（bots.channel / bots.receive）；还要 resources；会话接口要 sessions；登记接口要 http。
 * 审批列表、基地版本、保存附件、模型目录、进度、流水和用量都通过请求事件处理。
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


/** POST /api/message 的请求体：外面进来的，accept 里校验一次。 */
interface MessageBody {
  text?: unknown;
  bot?: unknown;
  from?: unknown;
  images?: unknown;
  uploads?: unknown;
  session?: unknown;
  reply_to?: unknown;
  /** 网页正在看哪个渠道、哪个聊天：{ channel, chat? }，chat 不写或空是整个渠道。 */
  view?: unknown;
  /** 授权范围（用户 11-18 #169）：{ dirs: [绝对路径…] }，这场会话里 exec 在这些目录里的命令不用再问（approval 读回话地址的 grants）。 */
  grants?: unknown;
}


/** 步骤默认几步、最多几步（同 src6/channels/HttpSessions.ts:432-444）。 */
const STEPS_DEFAULT = 100;
const STEPS_MAX = 500;

/** 进度和模型目录查询共用事件契约里的 3 秒等待上限。 */
const LOOKUP_TIMEOUT_MS = 3_000;


/** HTTP 渠道和网页接口。 */
class WebApi {
  /** 渠道名：会话记着它，回话靠它认回来。 */
  readonly name = 'http';

  /** 挂上的时刻：网页靠 /api/ui/info 的它认出后端换了进程（web/src/Api.ts:795）。 */
  readonly startedAt = Date.now();

  /** 收件表和时间线。 */
  private readonly timeline: timelineModule.Timeline;

  /** 单调时间戳游标，防止同一毫秒连发多条 HTTP 消息时间戳撞车。 */
  private lastAt = 0;

  /** 别的渠道发出去、还没等到回执的回话（replyRequestKey → 正文和请求）：回执说发到了才挂进时间线。 */
  private readonly otherReplies = new Map<string, { text: string; request: protocol.ChannelReplyRequest }>();
  /** 正在等待保存回执的上传暂存文件，避免并发消息消费同一上传号。 */
  private readonly savingUploads = new Set<string>();

  /**
   * 建收件表；听别的渠道的消息和回话；在一个 Fastify 作用域里登记全部接口。
   * 向 bots 登记本渠道的发送函数；一轮结束回话和中途先说一句由 bots 按渠道名调用，只管 channel 是 http 的会话。
   * @param ctx Cordis 给这个插件的 ctx：在它上面 ctx.on 听的事件，插件被拔掉时 Cordis 自动撤掉。
   */
  constructor(private readonly ctx: cordis.Context) {
    //M 旧路回话（指定了后台会话、一轮结束自动回一条）：bots 按渠道名调这里登记的 send。
    this.ctx.effect(() => this.ctx.bots.channel(this.name, (reply, session) => this.send(reply, session)));

    //M 模型一轮里每调一次 channel_reply、零次兜底、审批直回，都经 channel/reply 到这里，追加进那条消息的回话清单。
    protocol.registerTextReply(this.ctx, {
      channel: this.name,
      getTargetAddress: (chat) => this.getReplyTargetAddress(chat),
      sendDirectText: (text, request) => {
        this.replyDirect(text, request);
      },
    });

    //M 初始化收件表和时间线，让网页查询与历史监听共享已建好的记录。
    this.timeline = new timelineModule.Timeline(ctx);

    //M 登记网页历史监听，为渠道历史工具提供分页结果。
    new WebHistory(ctx);

    //M 一轮收尾（bots 发 channel/settled）：网页的那条标成回完；没回成又一句没回过的，补一句原因。
    ctx.on('channel/settled', (event) => {
      this.onSettled(event);
    });

    //M 别的渠道的消息：bot/receive 是“挨个问”（ctx.serial），这里只读不改、不写 handled；http 的已经在 accept 里记过。
    //M   记下标准消息号（sourceId），回话按“消息号 + 机器人”精确挂回。
    ctx.on('bot/receive', (event) => {
      const message = event.message;
      if (message.channel === this.name) return;

      const address = JSON.stringify(message.address ?? null);
      const newMessage: timelineModule.NewMessage = {
        bot: message.bot,
        channel: message.channel,
        source: message.channel,
        text: message.text,
        address,
      };
      if (message.sourceId !== undefined) {
        newMessage.source_id = message.sourceId;
      }
      //M 将其他渠道的入站记录写入时间线，并保留旧分派路径已经选定的会话。
      const id = this.timeline.insert(newMessage);
      if (event.session !== undefined) {
        this.timeline.bindSession(id, event.session.id);
      }
    });

    //M 别的渠道的消息认领完了（channel/message 里 bots 排在前面，claims 已填好）：记下各机器人进了哪场会话，网页引用它时回得到原会话。
    ctx.on('channel/message', (message, control) => {
      if (message.channel === this.name) return;

      for (const claim of control?.claims ?? []) {
        if (claim.sessionId === undefined) continue;

        //M 按标准消息号定位这个机器人的收件记录，以便引用时找回认领会话。
        const id = this.timeline.findBySource(claim.bot, message.messageId);
        if (id !== undefined) this.timeline.bindSession(id, claim.sessionId);
      }
    });

    //M 别的渠道 channel_tool 的回话：发出时先记下正文，渠道回执说发到了，再按“消息号 + 机器人”挂回那一行；跨聊天发出的（带 target）不挂回原入站行。
    ctx.on('channel/reply', (request) => {
      if (request.channel === this.name || request.mode !== 'text' || request.target !== undefined) return;

      const text = request.parts.map((part) => part.text ?? '').filter((part) => part !== '').join('\n');
      if (text === '') return;

      this.otherReplies.set(request.replyRequestKey, { text, request });
    });
    ctx.on('channel/replied', (event) => {
      //M 收到实际交付回执后尝试把对应回话挂回原消息。
      this.recordOtherReply(event);
    });

    //M 别的渠道旧路的回话（relay 这类认领了会话、一轮结束自动回的）：按会话最近认领的消息号挂回；channel_tool 的不在这里记。
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
        let status = (error as { statusCode?: number }).statusCode ?? 500;
        if (error instanceof failureModule.Failure) {
          status = error.status;
        }
        //M 用同一结构把错误文字与选定的 HTTP 状态码交回网页。
        const message = textModule.getMessage(error);
        await reply.code(status).send({ error: message });
        return reply;
      });

      //M 把网页入口和收件查询都装进统一的错误处理作用域。
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
    //M 登记网页发话入口，交给渠道入站逻辑统一校验和分派。
    scope.post<{ Body: unknown }>('/api/message', async (request) => this.accept(request.body));

    //M 让网页按消息号和回话下标查询回复的生成过程。
    scope.get<Id & Query>('/api/messages/:id/trace', async (request) => this.trace(request.params.id, request.query['reply']));

    //M 给网页提供会话选择列表、正在运行清单和指定会话的详情。
    scope.get<Query>('/api/sessions', async (request) => this.sessionList(request.query));
    scope.get<Query>('/api/ui/sessions', async (request) => this.sessionList(request.query));
    scope.get<Query>('/api/ui/running', async (request) => this.runningList(request.query));
    scope.get<Id>('/api/sessions/:id', async (request) => this.sessionDetail(request.params.id));
    scope.get<Id & Query>('/api/sessions/:id/steps', async (request) => {
      //M 先打开指定会话，为步骤页取得完整对话记录。
      const row = this.open(request.params.id).row;

      //M 网址里的 after、limit：写错按默认，超上限按上限。
      const after = textModule.getNumber(request.query['after'], 0, 0, Infinity);
      const limit = textModule.getNumber(request.query['limit'], STEPS_DEFAULT, 0, STEPS_MAX);
      return traceModule.steps(row, after, limit);
    });

    //M 将网页的模型切换和停止请求交给对应的会话控制入口。
    scope.post<Id & { Body: unknown }>('/api/sessions/:id/model', async (request) => this.setModel(request.params.id, request.body));
    scope.post<Id & { Body: unknown }>('/api/sessions/:id/stop', async (request) => this.stop(request.params.id, request.body));

    //M 为机器人选择器和详情页提供概要与目录信息。
    scope.get('/api/bots', async () => this.botList());
    scope.get<{ Params: { name: string } }>('/api/ui/bots/:name', async (request) => this.botInfo(request.params.name));

    //M 为网页状态栏提供版本信息和渠道连接状态。
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
    //M 取得后端编译时刻，供网页与版本号一起展示。
    const builtAt = embedded.getBuiltTime();
    const server = { version: versions.VERSION, builtAt };

    //M 补充可用的壳子版本，让网页分别显示壳子与后端。
    const shell = await this.shellVersion();
    return { startedAt: this.startedAt, version: server.version, builtAt: server.builtAt, server, shell };
  }

  /**
   * 通过基地事件查询壳子版本。
   * @returns 壳子版本与编译时刻，查询不可用时返回 null。
   */
  private async shellVersion(): Promise<{ version: string; builtAt: number } | null> {
    const request = { method: 'GET', route: '/version', timeoutMs: 800 } as const;
    const options = { timeoutMs: 1800, onFallback: () => ({ requestId: '', ok: false }) };

    //M 基地版本单独查询，后端版本和启动时刻照常返回。
    const response = await requestEventModule.requestEvent(this.ctx, 'base/request', 'base/result', request, options);

    //G 无回执、失败或旧壳子不提供版本时，由页面显示未知。
    const status = response.status;
    if (!response.ok || status === undefined || status < 200 || status >= 300) return null;

    const body = (response.body ?? {}) as { version?: unknown; builtAt?: unknown };
    if (typeof body.version !== 'string') return null;

    //M 只展示有效版本号，旧壳子未报编译时刻时沿用 0。
    const version = body.version.trim();
    if (version === '') return null;

    let builtAt = 0;
    if (typeof body.builtAt === 'number' && Number.isFinite(body.builtAt)) {
      builtAt = body.builtAt;
    }
    return { version, builtAt };
  }

  /**
   * POST /api/message：校验、存附件、记一行、推给机器人。
   * @param raw 请求体。
   * @returns { id: 消息号, file: '' }（src7 不给每条消息写文件）。
   * @throws Failure(400)：字段不对、没有机器人或会话、上传号失效、分派失败。Failure(503/500)：附件存不下。
   */
  private async accept(raw: unknown): Promise<{ id: number; file: string }> {
    //M 外面进来的，这里校验一次。
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new failureModule.Failure(400, '请求体要是 JSON 对象');

    //G 正文缺省可以靠附件发出，给了正文就必须是字符串。
    const body = raw as MessageBody;
    const text = body.text ?? '';
    if (typeof text !== 'string') throw new failureModule.Failure(400, 'text 要是字符串');

    //G 来源省略时按 HTTP 处理，传入时必须是非空字符串。
    const from = body.from ?? 'http';
    if (typeof from !== 'string' || from === '') throw new failureModule.Failure(400, 'from 要是非空字符串');

    //G 授权范围（可选）：本人、中控（from: claude）交代任务时写明哪些目录可信；这里查一次、规范化一次，写错回 400（Checks.ts 的 checkGrants）。
    const grants = checksModule.checkGrants(body.grants);

    //M 指定了会话就直接交给它（不分派）；机器人不写就用会话的，会话也没有就用名单第一个。
    const sessionId = body.session ?? '';
    if (typeof sessionId !== 'string') throw new failureModule.Failure(400, 'session 要是字符串');

    //G 找到显式指定的会话，防止错误编号被当成普通分派。
    let session: SessionMeta | undefined;
    if (sessionId !== '') {
      session = this.ctx.sessions.find({ id: sessionId })[0];
      if (session === undefined) throw new failureModule.Failure(400, `没有这场会话：${sessionId}`);
    }

    let quoted: timelineModule.MessageRecord | undefined;
    //G 校验引用编号并查到原件，供后续确认机器人与会话归属。
    if (body.reply_to !== undefined) {
      if (typeof body.reply_to !== 'number' || !Number.isSafeInteger(body.reply_to) || body.reply_to <= 0) {
        throw new failureModule.Failure(400, 'reply_to 要是正整数');
      }

      //G 引用编号有效后查原消息，找不到就拒绝提交。
      quoted = this.timeline.get(body.reply_to);
      if (quoted === undefined) throw new failureModule.Failure(400, '被回复的消息不存在');
    }

    //G 按请求和引用信息确定目标机器人，并核对指定会话是否归它。
    const wanted = body.bot ?? quoted?.bot ?? session?.bot ?? this.ctx.bots.list()[0]?.name;
    if (typeof wanted !== 'string' || this.ctx.bots.get(wanted) === undefined) {
      throw new failureModule.Failure(400, `没有这个机器人：${String(wanted)}`);
    }
    if (session !== undefined && session.bot !== wanted) {
      throw new failureModule.Failure(400, `会话 ${session.id} 是机器人 ${session.bot} 的，不是 ${wanted} 的`);
    }

    //G 引用的消息必须属于这次发话的机器人，避免跨机器人串挂。
    if (quoted !== undefined && quoted.bot !== wanted) {
      throw new failureModule.Failure(400, '不能回复其他机器人的消息');
    }
    //M 外部渠道回复必须回到原会话；不重新分派，避免混入网页上下文。
    let external: timelineModule.MessageRecord | undefined;
    if (quoted?.channel !== undefined && quoted.channel !== this.name) {
      external = quoted;
      let target: SessionMeta | undefined;
      if (external.sessionId !== null) {
        const targetId = external.sessionId;
        target = this.ctx.sessions.find({ id: targetId })[0];
      }
      //G 原渠道消息没有有效会话时，拒绝把引用回复误投到其他会话。
      if (target === undefined) throw new failureModule.Failure(400, '被回复的消息尚未关联会话');
      if (session !== undefined && session.id !== target.id) {
        throw new failureModule.Failure(400, '指定会话与被回复消息的会话不同');
      }
      session = target;
    }

    //M 网页正在看哪儿（可选）：渠道要挂着、聊天要在清单里，这里查一次，带进 channel/message。
    const view = this.getView(body.view, wanted);

    //M 附件先都读到手（任何一个不对就 400，什么都不存），再存进机器人工作区，最后删掉用过的上传。
    const files = [...this.images(body.images), ...this.uploads(body.uploads)];
    if (text.trim() === '' && files.length === 0) throw new failureModule.Failure(400, 'text 和附件至少要有一样');

    //M 由机器人保存附件，所有回执都成功后才提交消息。
    const paths = await this.saveAttachments(wanted, files);

    //M 附件写成 @绝对路径 接在话后面（路径里有空白就加引号），模型用 read 工具就能读到。
    const mentions = paths.map((item) => {
      if (/\s/u.test(item)) return `@"${item}"`;

      return `@${item}`;
    });
    const said = [text, ...mentions].filter((item) => item !== '').join('\n');

    //M 网页发的话都记成网页自己的一条（引用别的渠道的消息也是），引用的那条记在 reply_to。
    const newMessage: timelineModule.NewMessage = {
      bot: wanted,
      channel: this.name,
      source: from,
      text: said,
      address: null,
    };
    if (quoted !== undefined) {
      newMessage.reply_to = quoted.id;
    }
    //M 先写入网页消息并取收件编号，供分派和回话定位。
    const id = this.timeline.insert(newMessage);

    //M 给模型看的话：引用了就在前面写清引的是谁的哪句。
    let input = said;
    if (quoted !== undefined) {
      input = `【回复 ${this.timeline.peer(quoted)} 的消息：${quoted.text.slice(0, 500)}】\n${said}`;
    }

    //M 路由：一对一的渠道，零次回复直接发最后的话；指定会话、引用别的渠道的消息时带上校验过的会话号；
    //M   引用别的渠道的消息再记下被引那条的原渠道、原机器人、原会话（回话照旧回网页这条）。
    const routing: protocol.ChannelRouting = {
      listenOnly: false,
      autoFinal: true,
    };
    if (session !== undefined) {
      routing.sessionId = session.id;
    }
    if (external !== undefined && session !== undefined) {
      routing.replyOrigin = { source: external.channel, bot: external.bot, sessionId: session.id };
    }

    //T 跟踪：收下一条消息。
    let sessionLabel = '（没有）';
    if (session !== undefined) {
      sessionLabel = session.id;
    }
    const vars = { 消息号: id, 机器人: wanted, 附件几个: paths.length, 指定会话: sessionLabel };
    this.ctx.emit('trace', 'WebApi.accept', '收下一条消息，推给机器人', "ctx.serial('channel/message')", vars);

    //M 推给机器人；回话地址就是消息号。推不进去（比如没有插件管分派）就删掉这一行，告诉调用方。
    try {
      await this.emitChannelMessage(id, wanted, said, input, routing, view, grants);
    } catch (error) {
      this.timeline.remove(id);
      throw new failureModule.Failure(400, textModule.getMessage(error));
    }
    return { id, file: '' };
  }

  /**
   * 网页的一条话发出标准 channel/message：approval 先看“同意 N”，bots 再按 routing 认领（指定会话的只进那场）。
   * 附件在 accept 里已经存进 bots 工作区并拼成 @路径，因此 attachments 传空以免重复物化。
   * 网页来的都是本人（http 统一查令牌：本机、免令牌地址、带对令牌的才进得来），role 写 owner。
   * @param id web_messages 消息号。
   * @param wanted 目标机器人名。
   * @param rawText 原始用户输入+@路径。
   * @param text 带引用描述前缀的输入文本。
   * @param routing accept 里算好的路由（指定会话、引用来源、autoFinal）。
   * @param view 网页正在看哪儿（getView 校验过）；没带是 undefined，消息上就不写这一项。
   * @param grants 授权范围（checkGrants 查过、规范化过）；没带是 undefined，地址上就不写这一项。
   * @throws 没人认领、也不是“同意 N”时抛错。
   * 副作用：认领到会话的，把会话号记到这一行上。
   */
  private async emitChannelMessage(
    id: number,
    wanted: string,
    rawText: string,
    text: string,
    routing: protocol.ChannelRouting,
    view: protocol.ChannelView | undefined,
    grants: checksModule.Grants | undefined,
  ): Promise<void> {
    const now = Math.max(Date.now(), this.lastAt + 1);
    this.lastAt = now;
    //M 网页来源已经由 http 插件按本机/令牌核验过身份，带上 owner: true 让 approval 认出可批所有待确认。
    const address: Record<string, unknown> = { messageId: id, customer: 'http:本机', owner: true };

    //M 带了授权范围就写进回话地址：bots.route 把地址记到会话上，交办的后台会话也带着，approval 审 exec 时读 grants.dirs。
    if (grants !== undefined) {
      address['grants'] = grants;
    }
    const nativeId = String(id);
    const messageId = protocol.makeChannelMessageId(this.name, 'local', nativeId);
    const channelMessage: protocol.ChannelMessage = {
      v: 1,
      messageId,
      nativeId,
      channel: this.name,
      accountId: 'local',
      chatId: 'http:本机',
      chatType: 'local',
      sender: { id: 'http:本机', name: '网页' },
      role: 'owner',
      targetBots: [wanted],
      mentions: [],
      rawText,
      text,
      attachments: [],
      createdAt: now,
      receivedAt: now,
      timeSource: 'received',
      replyTo: null,
      origin: {
        channel: this.name,
        address: { ...address },
      },
      visibility: {
        scope: 'http:local:http:本机',
        trusted: true,
        publicSourceIds: [],
      },
      routing,
    };
    if (view !== undefined) {
      channelMessage.view = view;
    }

    //M 发出 channel/message：approval 先看“同意 N”，bots 再认领进会话（前台用 channel_reply 回，几条都追加进回话清单）。
    const control: protocol.ChannelMessageControl = { claims: [] };
    await this.ctx.serial('channel/message', channelMessage, control);
    if (control.approvalHandled !== true && control.claims.length === 0) {
      throw new Error(`机器人 ${wanted} 收到了消息，但前台没有定下进哪场会话`);
    }

    //M 认领到哪场会话就记到这一行上：回话、引用都靠它找回会话。
    const claim = control.claims.find((one) => one.bot === wanted && one.sessionId !== undefined);
    if (claim?.sessionId !== undefined) {
      this.timeline.bindSession(id, claim.sessionId);
    }
  }

  /**
   * 校验 POST /api/message 的 view（网页正在看哪个渠道、哪个聊天），外面进来的在这里查一次。
   * @param raw 请求体的 view；不写是 undefined。
   * @param bot 这条发给哪个机器人（聊天清单按机器人列）。
   * @returns 校验过的 view，带上给人看的名字；没写是 undefined。
   * @throws Failure(400)：不是 { channel, chat? }、渠道没挂着、聊天不在这个渠道的清单里。
   */
  private getView(raw: unknown, bot: string): protocol.ChannelView | undefined {
    if (raw === undefined) return undefined;

    //G 形状：对象，channel 非空字符串，chat 不写或字符串。
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new failureModule.Failure(400, 'view 要写成 { channel, chat }');
    }
    //G 提取视图里的渠道和聊天字段，拒绝无法定位的字段类型。
    const channel = textModule.getField(raw, 'channel');
    const chat = textModule.getField(raw, 'chat') ?? '';
    if (typeof channel !== 'string' || channel === '' || typeof chat !== 'string') {
      throw new failureModule.Failure(400, 'view 要写成 { channel, chat }，channel 是非空字符串，chat 不写或是字符串');
    }

    //G 渠道要挂着（和 GET /api/channels 列的一样）。
    const summary = this.timeline.getChannels(bot).find((item) => item.id === channel);
    if (summary === undefined) throw new failureModule.Failure(400, `view.channel 没挂着：${channel}`);

    //M 看的是整个渠道：名字写“飞书·全部聊天”。
    if (chat === '') return { channel, chat, label: `${summary.label}·全部聊天` };

    //G 聊天要在这个渠道的清单里。
    const found = summary.chats.find((item) => item.id === chat);
    if (found === undefined) throw new failureModule.Failure(400, `view.chat 不在 ${channel} 的聊天清单里：${chat}`);

    return { channel, chat, label: found.label };
  }

  /**
   * 网页渠道接 channel/reply：模型的 channel_reply、零次兜底、审批直回，都追加进那条消息的回话清单。
   * 会话用这一行记的（认领时记下的）；审批直回没有会话，用这个机器人网页的前台，并马上标成回完（没有模型轮，不会再有 channel/settled）。
   * @param text 要追加进 replies 的正文。
   * @param request 标准回复请求（来源地址里的 messageId 就是网页的消息号）。
   */
  private replyDirect(text: string, request: protocol.ChannelReplyRequest): void {
    const messageId = request.sourceSnapshot.origin.address['messageId'];
    //G 跨渠道发到网页或没有原网页消息号：新建跨渠道网页记录并挂回回话，不回挂原渠道消息。
    if (request.target !== undefined || typeof messageId !== 'number') {
      //M 定位或新建该机器人的网页前台会话，在收件表补记跨渠道发话行后追加回话并标回完。
      const crossSession = this.getOrCreateWebFront(request.bot);
      const crossId = this.timeline.insert({
        bot: request.bot,
        channel: this.name,
        source: 'http',
        text: '（跨渠道发话）',
        address: null,
      });
      //M 跨渠道消息没有原模型轮，立即绑定前台会话、记入回话并标回完。
      this.timeline.bindSession(crossId, crossSession.id);
      this.timeline.reply(crossId, crossSession, text);
      this.timeline.markReplied(crossId);
      return;
    }

    //M 按原网页消息号取出收件记录；找不到直接跳过。
    const record = this.timeline.get(messageId);
    if (record === undefined) return;

    //M 认领时记下了会话：用它（一轮里连发的几条都挂在同一场上）。
    if (record.sessionId !== null && this.ctx.sessions.find({ id: record.sessionId })[0] !== undefined) {
      const session = this.ctx.sessions.open(record.sessionId);
      this.timeline.reply(messageId, session, text);
      return;
    }

    //M 没有会话（审批直回）：挂在这个机器人网页的前台上，没有就开一场。
    const session = this.getOrCreateWebFront(request.bot);
    this.timeline.reply(messageId, session, text);
    this.timeline.markReplied(messageId);
  }

  /**
   * 识别跨渠道发往网页的目标聊天名称（仅接受本机网页别名）；认不出时返回 undefined。
   * @param chat 调用方传入的目标聊天名称。
   */
  private getReplyTargetAddress(chat: string): Record<string, unknown> | undefined {
    if (!WEB_TARGET_CHATS.has(chat.trim())) return undefined;

    return { customer: 'http:本机', owner: true };
  }

  /**
   * 查找或新建该机器人的网页本机前台会话。
   * @param bot 机器人名。
   * @returns 网页前台会话。
   */
  private getOrCreateWebFront(bot: string): Session {
    //M 优先复用已有的网页本机前台会话；没有时再新建一场。
    const found = this.ctx.sessions.find({ bot, kind: 'front', customer: 'http:本机' })[0];
    if (found !== undefined) return this.ctx.sessions.open(found.id);

    //M 尚未建立网页本机前台时直接新建一场。
    return this.ctx.sessions.create({ bot, kind: 'front', customer: 'http:本机' });
  }

  /**
   * 一轮收尾（channel/settled）：网页自己的那条标成回完；没回成、一句也没回过的，补一句原因（原来一轮结束会把出错的话回过来）。
   * @param event 收尾通知：来源快照、stage、原因。
   */
  private onSettled(event: protocol.ChannelSettledEvent): void {
    const snapshot = event.sourceSnapshot;
    if (snapshot.channel !== this.name) return;

    const messageId = snapshot.origin.address['messageId'];
    if (typeof messageId !== 'number') return;

    //G 只更新仍存在的网页消息，避免收尾事件写到失效记录。
    const record = this.timeline.get(messageId);
    if (record === undefined) return;

    //M 没回成又一句没回过：补一句原因，网页上看得到为什么没回。
    const failed = event.stage !== 'sent' && event.stage !== 'sending';
    if (failed && record.replies.length === 0 && record.sessionId !== null) {
      const session = this.ctx.sessions.open(record.sessionId);
      let reason = event.note;
      if (reason === '') {
        reason = event.stage;
      }
      //M 在尚无回复的时间线里写入失败原因，供网页展示。
      this.timeline.reply(messageId, session, `（没回成：${reason}）`);
    }

    //M 将已经收到收尾通知的消息标为回完，供轮询更新状态。
    this.timeline.markReplied(messageId);
  }

  /**
   * 请求体里的 images：[{ name?, data: base64 }]，data 前面可以带 data:...;base64, 头。
   * @param value 请求体的 images。
   * @returns 文件名和内容。
   * @throws Failure(400)：形状不对。
   */
  private images(value: unknown): { name: string; data: Uint8Array; upload?: string }[] {
    if (value === undefined || value === null) return [];
    //G 拒绝非数组图片参数，再逐个读取内联文件。
    if (!Array.isArray(value)) throw new failureModule.Failure(400, 'images 要是数组：[{ name?, data }]');

    return value.map((item: unknown, index) => {
      //G 内联图片必须提供非空的 base64 字段，才能提取文件内容。
      let image: { name?: unknown; data?: unknown } = {};
      if (typeof item === 'object' && item !== null) {
        image = item;
      }
      //G 内联文件必须含可解码的正文。
      if (typeof image.data !== 'string' || image.data === '') throw new failureModule.Failure(400, `images[${String(index)}].data 要是 base64 字符串`);

      let name = `图片${String(index + 1)}.png`;
      if (typeof image.name === 'string' && image.name !== '') {
        name = image.name;
      }
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
    //G 上传参数必须是数组，逐项校验后才查暂存文件。
    if (!Array.isArray(value)) throw new failureModule.Failure(400, 'uploads 要是上传号的数组');

    //M 定位上传暂存目录，用上传号前缀匹配已落盘的文件。
    const dir = this.ctx.resources.dir('data', 'tmp', 'uploads');
    const names = fs.readdirSync(dir);
    return value.map((id: unknown) => {
      //G 只接受约定格式的上传号和确实存在的暂存文件。
      if (typeof id !== 'string' || !/^\d{20}$/u.test(id)) throw new failureModule.Failure(400, `上传号要是 20 位数字：${String(id)}`);

      //M 用上传号定位暂存文件，同时取出用户上传时的文件名。
      const found = names.find((item) => item.startsWith(`${id}_`));
      if (found === undefined) throw new failureModule.Failure(400, `上传号不在了（用过了，或者没传上）：${id}`);

      const upload = path.join(dir, found);
      return { name: found.slice(id.length + 1), data: fs.readFileSync(upload), upload };
    });
  }

  /**
   * 经机器人事件保存消息附件，成功后消费一次性上传号。
   * @param bot 接收附件的机器人。
   * @param files 已校验的附件与可选暂存路径。
   * @returns 机器人确认保存的路径，顺序与附件一致。
   * 副作用：附件写进工作区。等待期间占住上传号，全部保存后清理暂存文件。
   */
  private async saveAttachments(
    bot: string,
    files: { name: string; data: Uint8Array; upload?: string }[],
  ): Promise<string[]> {
    const uploads = files.map((file) => file.upload).filter((file) => file !== undefined);

    //G 上传号只能由一条消息消费，先检查全部暂存文件是否空闲。
    const busy = uploads.some((file) => this.savingUploads.has(file));
    if (busy) throw new failureModule.Failure(409, '有附件正在用于另一条消息');

    for (const upload of uploads) {
      //M 占用暂存文件，等待保存回执时不让并发消息重复消费。
      this.savingUploads.add(upload);
    }

    const paths: string[] = [];
    const options = {
      timeoutMs: 5000,
      onFallback: (reason: requestEventModule.FallbackReason, detail?: string) => ({
        requestId: '', ok: false, error: detail ?? `保存附件未获回执（${reason}）`,
      }),
    };
    try {
      for (const file of files) {
        const request = { action: 'save-file', bot, name: file.name, data: file.data } as const;

        //M 让机器人保存附件，收到实际路径后才能写进对话。
        const saved = await requestEventModule.requestEvent(this.ctx, 'bot/request', 'bot/result', request, options);

        //G 任一附件没确认保存就中止发消息，保留暂存上传供重试。
        if (!saved.ok || saved.path === undefined) {
          let status = 500;
          if (saved.requestId === '') {
            status = 503;
          }
          const error = `附件存不下：${saved.error ?? '机器人未返回文件路径'}`;

          //G 区分无服务与执行失败，让页面拿到真实原因。
          throw new failureModule.Failure(status, error);
        }

        //M 收下确认保存的路径，稍后生成消息里的文件引用。
        paths.push(saved.path);
      }

      for (const upload of uploads) {
        //M 所有附件都拿到路径后才清理一次性上传。
        fs.rmSync(upload, { force: true });
      }
      return paths;
    } finally {
      for (const upload of uploads) {
        //M 释放占用，失败的上传号可以重新提交。
        this.savingUploads.delete(upload);
      }
    }
  }

  /**
   * 渠道基类要的：把机器人的话交给用户。HTTP 不主动推，就是追加到那条消息的回话清单里，网页轮询时看到。
   * @param reply 要说的话。
   * @param session 哪场会话说的；回话地址从 session.row.address 取（收话时记的 { messageId }，直接信，不再校验）。
   */
  protected send(reply: string, session: Session): void {
    const address = session.row.address as { messageId?: unknown } | undefined;
    if (typeof address?.messageId !== 'number') return;

    //M 把旧路径送回的机器回复追加到对应收件记录，供网页轮询显示。
    this.timeline.reply(address.messageId, session, reply);
  }

  /**
   * 别的渠道旧路的会话回话（relay 这类认领了会话、一轮结束自动回的；中途 bot/say 的）：
   * 按这场会话最近认领的那条（sourceClaims 最后一项，里面是标准消息号和机器人）精确挂回。
   * channel_tool 的轮不在这里记（发出去的经 channel/replied 记，row.reply 只是草稿）；认不出是哪条的不记，不按地址猜。
   * @param session 哪场会话。
   * @param text 说的话。
   */
  private recordOther(session: Session, text: string): void {
    const row = session.row;
    if (row.channel === undefined || row.channel === this.name || text === '') return;

    //G 正在跑 channel_tool 的轮（bots 不自动发它的话）→ 不记。
    if (row.quiet === true || row.activeSourceSnapshot !== undefined) return;

    //G 没认领过标准消息（旧路 bots.receive 进来的，比如微信起草）→ 认不出是哪条，不记。
    const claimKey = row.sourceClaims?.at(-1);
    if (claimKey === undefined) return;

    //G 最近认领的那条是 channel_tool 排进前台的：这一轮刚收尾，row.reply 是草稿，真发出去的已经经 channel/replied 记过。
    const queued = (row.resultQueue ?? []).some((item) => item.claimKey === claimKey);
    if (queued) return;

    //M claimKey 是 JSON [消息号, 机器人]（protocol.getClaimKey）。
    const parsed = JSON.parse(claimKey) as unknown;
    if (!Array.isArray(parsed)) return;

    const sourceId: unknown = parsed[0];
    if (typeof sourceId !== 'string') return;

    //M 按标准消息号和机器人找到旧路径回复的原消息，再把回复追加进去。
    const id = this.timeline.findBySource(row.bot, sourceId);
    if (id !== undefined) this.timeline.reply(id, session, text);
  }

  /**
   * 别的渠道 channel_tool 的回话发到了（channel/replied）：照发出时记下的来源快照，按“标准消息号 + 机器人”挂回那一行。
   * 会话用那一行认领时记下的；还没记会话的不挂（Timeline.reply 要会话算生成依据）。
   * @param event 渠道回执。
   */
  private recordOtherReply(event: protocol.ChannelRepliedEvent): void {
    //G 用回执的请求号反查待确认正文，只处理本插件之前记过的请求。
    const key = event.receipt.replyRequestKey;
    const pending = this.otherReplies.get(key);
    if (pending === undefined) return;

    this.otherReplies.delete(key);
    const status = event.receipt.status;
    if (status !== 'sent' && status !== 'partial') return;

    //M 找回原话那一行，和它记下的会话。
    const snapshot = pending.request.sourceSnapshot;
    const id = this.timeline.findBySource(snapshot.botName, snapshot.messageId);
    if (id === undefined) return;

    //G 原消息必须还在并已绑定会话，才有足够资料补记回话。
    const record = this.timeline.get(id);
    if (record === undefined) return;

    if (record.sessionId === null) return;

    //M 用原会话恢复回话的生成依据，随正文一起挂回对应收件记录。
    const session = this.ctx.sessions.open(record.sessionId);
    this.timeline.reply(id, session, pending.text);
  }

  /**
   * 会话简要：列表、详情、搜索共用（web/src/Api.ts:335-352 的 SessionBrief）。
   * @param meta 会话记录。
   */
  private brief(meta: SessionMeta): Record<string, unknown> {
    //M 从会话记录取显示用的客户名称，缺少时留空。
    const customer = textModule.getText(meta, 'customer');

    //M 将会话标题、状态和文件地址组装成网页列表与详情共用的摘要。
    return {
      id: meta.id,
      bot: meta.bot,
      kind: meta.kind,
      parent: meta.parent,
      customer,
      workspace: 'workspace',
      title: timelineModule.title(meta),
      summary: meta.summary ?? '',
      model: meta.model,
      status: timelineModule.getStatus(meta.state),
      updatedAt: meta.updatedAt,
      files: { ...timelineModule.sessionFiles(this.ctx.resources.root, meta), compact: '' },
    };
  }

  /**
   * GET /api/sessions、/api/ui/sessions：一个机器人的会话（只给没有 parent 的，小会话不给网页看），最近动过的在前。
   * @param query bot（不写是第一个）、status（idle、running、error）。
   */
  private sessionList(query: Record<string, string | undefined>): Record<string, unknown>[] {
    //G 先确定会话列表的目标机器人，没有可用机器人时返回空列表。
    const bot = this.timeline.getBot(query['bot']);
    if (bot === undefined) return [];

    //G 拒绝网页不支持的状态筛选词。
    const status = query['status'];
    if (status !== undefined && status !== '' && !['idle', 'running', 'error'].includes(status)) {
      throw new failureModule.Failure(400, 'status 要是 idle、running 或 error');
    }

    //M 按机器人与页面状态筛出独立会话，生成网页需要的会话摘要。
    return this.ctx.sessions.find({ bot })
      .filter((meta) => meta.parent === undefined)
      .filter((meta) => status === undefined || status === '' || timelineModule.getStatus(meta.state) === status)
      .map((meta) => this.brief(meta));
  }

  /**
   * GET /api/ui/running：当前机器人正在跑的前台和后台会话（含有 parent 的子会话），给右栏「正在运行」。
   * 每条带标题、客户/渠道标签、本轮开始时间和最新进度（progress、assist 待办、对话里最近的工具调用）。
   * @param query bot（不写是第一个）。
   */
  private async runningList(query: Record<string, string | undefined>): Promise<Record<string, unknown>[]> {
    //G 只查已确定机器人的运行会话，没有可用机器人时返回空列表。
    const bot = this.timeline.getBot(query['bot']);
    if (bot === undefined) return [];

    const request = { action: 'list', bot } as const;
    const options = {
      timeoutMs: LOOKUP_TIMEOUT_MS,
      onFallback: () => ({ requestId: '', items: [] }),
    };

    //M 向进度插件取生效的卡片，无应答时从会话本身恢复展示。
    const progress = await requestEventModule.requestEvent(
      this.ctx,
      'progress/request',
      'progress/result',
      request,
      options,
    );
    const cards = progress.items ?? [];

    //M 给每个运行会话匹配仍生效的进度卡并读出会话详情。
    return this.ctx.sessions.find({ bot, state: 'running' }).map((meta) => {
      const card = cards.find((item) => item.sessionId === meta.id && item.endedAt === undefined);
      const session = this.ctx.sessions.open(meta.id);
      const customer = textModule.getText(meta, 'customer');

      //M 优先采用进度卡，缺失时从待办和对话补出开始时刻及当前动作。
      const startedAt = card?.startedAt ?? runStartedAt(session, meta.updatedAt);
      const action = card?.action
        || assistDoing(this.ctx.resources.db, meta.id)
        || latestAction(session, meta.kind);

      //M 给网页运行卡片提供可读的会话标题和来源标签。
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
    //G 在打开前确认编号存在，让接口对缺失会话回 404。
    if (this.ctx.sessions.find({ id }).length === 0) throw new failureModule.Failure(404, `没有这场会话：${id}`);

    //M 已确认存在后打开会话，供详情或操作接口使用。
    return this.ctx.sessions.open(id);
  }

  /**
   * GET /api/sessions/:id：会话详情（web/src/Types.ts:566-595 的 SessionDetail）。
   * @param id 会话号。
   */
  private sessionDetail(id: string): Record<string, unknown> {
    //M 读取会话后组装列表摘要和镜像文件位置，供详情页展示。
    const row = this.open(id).row;
    const brief = this.brief(row);
    const files = timelineModule.sessionFiles(this.ctx.resources.root, row);
    //M 上一次调模型时的上下文：最后一条模型回答的输入加缓存读。
    const last = row.messages.findLast((item) => item.role === 'assistant');
    let tokens = 0;
    if (last?.role === 'assistant') {
      tokens = last.usage.input + last.usage.cacheRead;
    }

    //M 已生成的镜像正文直接提供给网页详情。
    let md = '';
    if (files.md !== '') {
      md = fs.readFileSync(files.md, 'utf8');
    }
    return {
      ...brief,
      thinking: row.thinking,
      tokens,
      runs: [],
      createdAt: row.messages[0]?.timestamp ?? row.updatedAt,
      files,
      md,
    };
  }

  /**
   * POST /api/sessions/:id/model：换会话的模型和思考档，在转的会话下一步就用新的（骨架每一步现读 row.model、row.thinking）。
   * @param id 会话号。
   * @param raw { model, thinking }：thinking 是 null 取这个模型支持的最高一档。
   * @returns 会话当前的模型、思考档和状态。
   * @throws Failure：没有这场会话时返回 404，模型不可用或思考档不支持时返回 400。
   * 副作用：保存会话模型和思考档，并发出变更通知。
   */
  private async setModel(id: string, raw: unknown): Promise<Record<string, unknown>> {
    //G 先确认会话存在，并校验请求带了可查询的模型名。
    const session = this.open(id);
    const model = textModule.getField(raw, 'model');
    if (typeof model !== 'string' || model === '') throw new failureModule.Failure(400, 'model 要是非空字符串');

    const request = { action: 'find', model } as const;
    const options = {
      timeoutMs: LOOKUP_TIMEOUT_MS,
      onFallback: () => ({ requestId: '', info: undefined }),
    };

    //G 允许模型目录确认过的聊天模型，无应答时按未知模型处理。
    const result = await requestEventModule.requestEvent(
      this.ctx,
      'model-catalog/request',
      'model-catalog/result',
      request,
      options,
    );
    const info = result.info;
    if (info === undefined || info.kind !== 'chat') throw new failureModule.Failure(400, `模型不可用：${model}`);

    //G 显式思考档必须受该模型支持，省略时使用最高档。
    const requested = textModule.getField(raw, 'thinking');
    let thinking = info.thinking.at(-1) ?? 'off';
    if (requested !== null && requested !== undefined) {
      if (typeof requested !== 'string' || !info.thinking.includes(requested)) {
        throw new failureModule.Failure(400, `思考档 ${String(requested)} 这个模型不支持，支持：${info.thinking.join('、')}`);
      }
      thinking = requested;
    }

    //M 持久化模型和思考档，供会话后续步骤读取并保留变更前后值。
    const row = session.row;
    const change = { session, from: row.model, to: model, thinkingFrom: row.thinking, thinkingTo: thinking, by: 'HTTP' as const };
    row.model = model;
    row.thinking = thinking as Thinking;
    session.save();

    //T 跟踪：换了模型。
    const vars = { 会话: id, 原来: `${change.from} ${change.thinkingFrom}`, 换成: `${change.to} ${change.thinkingTo}` };
    this.ctx.emit('trace', 'WebApi.setModel', '网页换了会话的模型', 'row.model = model; session.save()', vars);
    this.ctx.emit('web-api/model', change);
    return { id, model: row.model, thinking: row.thinking, status: timelineModule.getStatus(row.state) };
  }

  /**
   * POST /api/sessions/:id/stop：喊停。正在等的模型请求马上掐掉；骨架加了停止信号以后，慢的工具也跟着断开。
   * @param id 会话号。
   * @param raw { reason? }：不写是“HTTP”。
   */
  private stop(id: string, raw: unknown): Record<string, unknown> {
    //M 读取目标会话与请求原因，为停止动作准备参数。
    const session = this.open(id);
    const reason = textModule.getText(raw, 'reason') || 'HTTP';
    if (session.row.state !== 'running') {
      //G 已经不在运行的会话只交回当前状态，无需触发停止。
      return { id, stopped: false, status: timelineModule.getStatus(session.row.state), reason: '会话没在跑' };
    }

    //M 以请求中的原因停止正在运行的会话。
    session.stop(reason);
    //M stop() 里改了状态；TypeScript 以为上面查过就还是 running，这里按普通字符串再看一次。
    const stopped = (session.row.state as string) === 'stopped';
    const result = { id, stopped, status: timelineModule.getStatus(session.row.state) };

    //G 记录上是在转，这个进程里却没有在转的循环（上次没跑完、重启后还没接着跑）→ 没停下，说清楚。
    if (stopped) return result;

    return { ...result, reason: '会话记录是在转，但这个进程里没有在跑的循环' };
  }

  /** GET /api/bots：机器人列表，状态按“等确认 → 干活 → 闲着”（同 0.4：HttpUi.ts:400-418；src7 不排队，queued 是 0）。 */
  private async botList(): Promise<Record<string, unknown>[]> {
    const request = { action: 'list' } as const;
    const options = { timeoutMs: 3000, onFallback: () => ({ requestId: '', items: [] }) };

    //M 查待确认列表算机器人状态，查询不可用时仍返回机器人和运行数。
    const listed = await requestEventModule.requestEvent(
      this.ctx, 'approval/request', 'approval/result', request, options,
    );
    const pending = listed.items ?? [];

    //M 为每个机器人汇总审核项与运行会话，计算网页显示的状态。
    return this.ctx.bots.list().map((bot) => {
      //M 干活中的后台子会话也算（有 parent，不出现在会话下拉里，但机器人应显示在干活）。
      const running = this.ctx.sessions.find({ bot: bot.name, state: 'running' }).length;
      const waiting = pending.filter((item) => (
        item.bot === bot.name && item.session !== undefined && item.session !== ''
      ));
      const approvals = waiting.length;
      let status = 'idle';
      if (running > 0) {
        status = 'working';
      }
      if (approvals > 0) {
        status = 'waiting';
      }

      //M 在机器人没有设置语言时给网页默认语言。
      const language = getBotLanguage(bot.config);
      return { name: bot.name, language, status, running, queued: 0, approvals };
    });
  }

  /**
   * GET /api/ui/bots/:name：一个机器人的目录、工作区、记忆概要（web/src/Api.ts:438-449 的 BotInfo）。
   * @param botName 机器人名。
   * @throws Failure(404)：没有这个机器人。
   */
  private botInfo(botName: string): Record<string, unknown> {
    //G 机器人不存在时用 404 结束详情查询。
    const bot = this.ctx.bots.get(botName);
    if (bot === undefined) throw new failureModule.Failure(404, `没有这个机器人：${botName}`);

    const index = ['索引.md', 'index.md'].map((file) => path.join(bot.memory, file)).find((file) => fs.existsSync(file));
    let memoryIndex = '';
    if (index !== undefined) {
      memoryIndex = fs.readFileSync(index, 'utf8');
    }

    //M 为详情页提供机器人的语言、目录和记忆入口。
    const language = getBotLanguage(bot.config);
    return {
      name: bot.name,
      language,
      paths: {
        botDir: path.join(this.ctx.resources.root, 'bots', bot.name),
        messageDir: path.join(bot.workspace, 'inbox'),
        workspaceRoot: bot.workspace,
        memoryDir: bot.memory,
      },
      workspaces: [{ name: 'workspace', description: '机器人的工作区：工具在这里读写文件，收到的附件在 inbox/ 下', dir: bot.workspace }],
      memoryIndex,
    };
  }

  /**
   * GET /api/messages/:id/trace?reply=N：一句回话的追溯。
   * @param id 消息号。
   * @param reply 回话下标，从 0 起。
   * @throws Failure：reply 不是非负整数 400；消息不在、下标越界 404。
   */
  private async trace(id: string, reply: string | undefined): Promise<Record<string, unknown>> {
    //G 回话下标必须是非负整数，才能定位要追溯的回话。
    if (reply === undefined || !/^\d+$/u.test(reply)) throw new failureModule.Failure(400, 'reply 要是非负整数（回话下标，从 0 起）');

    //G 先找相应的收件记录，消息不存在时返回 404。
    const message = this.timeline.get(Number(id));
    if (message === undefined) throw new failureModule.Failure(404, `没有这条消息：${id}`);

    //M 取目标回复所关联会话的标题，合并收件关联信息生成追溯结果。
    const replyIndex = Number(reply);
    const sessionId = message.replies[replyIndex]?.sessionId;
    let sessionTitle: string | null = null;
    if (sessionId !== undefined) {
      const meta = this.ctx.sessions.find({ id: sessionId })[0];
      if (meta !== undefined) {
        sessionTitle = timelineModule.title(meta);
      }
    }

    //M 保留回复与原消息的关联，等流水和用量补齐追溯结果。
    const association = this.timeline.association(message.id);
    const input = { message, replyIndex, sessionTitle, association };
    return traceModule.trace(this.ctx, input);
  }
}


/**
 * 读取机器人的页面语言，无字符串配置时使用中文。
 * @param config 机器人配置。
 * @returns 页面语言标识。
 */
function getBotLanguage(config: Record<string, unknown>): string {
  const language = config['language'];
  if (typeof language === 'string') return language;

  return 'zh';
}


/**
 * 正在跑的会话标题：有总结用总结；没有就写成「前台 会话 <号>」或「后台 会话 <号>」。
 * @param meta 会话记录。
 */
function runningTitle(meta: SessionMeta): string {
  //M 先取得常规会话标题，只给无总结时的回退标题加前台或后台标识。
  const raw = timelineModule.title(meta);
  if (!raw.startsWith('会话 ')) return raw;
  if (meta.kind === 'front') return `前台 ${raw}`;

  return `后台 ${raw}`;
}


/**
 * 客户号写成短标签：网页、飞书、飞书群、微信，或渠道名。
 * @param customer 渠道:用户；没有是空串。
 */
function customerLabel(customer: string): string {
  if (customer === '') return '';
  if (customer.startsWith('http:')) return '网页';
  if (customer.startsWith('feishu:group:')) return '飞书群';
  if (customer.startsWith('feishu:')) return '飞书';
  if (customer.startsWith('wechat:')) return '微信';
  const cut = customer.indexOf(':');
  if (cut <= 0) return customer;

  return customer.slice(0, cut);
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
      if (typeof item.timestamp === 'number') return item.timestamp;

      return fallback;
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
    //M 读取该会话最新一次保存的待办，供运行卡片推断当前动作。
    const row = sqlite.query("SELECT data FROM assist_items WHERE kind = 'todo' AND session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId) as { data: string } | null;
    if (row === null || row === undefined) return '';
    const parsed = JSON.parse(row.data) as { items?: TodoItem[] };
    const items = parsed.items ?? [];
    //M 优先显示正在做的待办，没有时预览第一条待做事项。
    const doing = items.find((item) => item.status === 'doing' && typeof item.text === 'string' && item.text.trim() !== '');
    const text = doing?.text ?? items.find((item) => item.status === 'todo' && typeof item.text === 'string' && item.text.trim() !== '')?.text;
    if (typeof text !== 'string') return '';

    return text.trim().slice(0, 80);
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
      //M 从最新的模型消息中找工具调用，给运行列表显示工具名。
      const call = item.content.find((block) => block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'toolCall') as { name?: unknown } | undefined;
      if (typeof call?.name === 'string' && call.name !== '') return `正在调用 ${call.name}`;
      return '在写回答';
    }
  }
  if (kind === 'front') return '前台处理中';

  return '后台运行中';
}


/**
 * 挂上 web-api。
 * apply 是 Cordis 插件的入口：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 先等 inject 里的 resources、bots、sessions、http
 * 都就绪，再调一次 apply(ctx)。http 等事件 ready（全部插件挂完）才开始监听，所以这里登记的接口赶得上。
 * 拔掉插件时，ctx.on 听的事件 Cordis 自动撤掉；Fastify 开始监听后不能删路径，接口要重启才没。没有配置。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  //M 挂上网页渠道、历史监听和核心 HTTP 接口。
  new WebApi(ctx);
}
