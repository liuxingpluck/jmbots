/**
 * web-api：HTTP 渠道，加上网页要的全部核心接口。
 * 它是一个渠道（渠道名 http）：POST /api/message 收话，记进自己的收件表 web_messages，用消息号当回话地址发 channel/direct（网页是私聊）；
 * 模型一轮里每调一次 channel_reply（还有零次兜底、审批直回）都经 channel/reply 追加到那条消息的回话清单，一轮收尾（bot/settled）标成回完。
 * HTTP 不主动推：网页轮询 GET /api/messages。
 * 别的渠道（飞书、命令行、微信）的消息也记一份（带标准消息号），回话按“消息号 + 机器人”挂回，网页右栏“消息”靠它。
 * 另外接网页的会话列表和详情、步骤、换模型、喊停、正在跑的任务、回话追溯、机器人、界面信息、渠道状态。
 * 不查令牌（http 统一查：本机不查，别的机器要带）；不托管网页（web）；不分派（前台在 bots 里）。
 * 文件：本文件（渠道收发、界面信息）、Views.ts（会话、机器人的接口和回话追溯入口）、Timeline.ts（收件表、时间线、补取、搜索）、Trace.ts（步骤、追溯、生成依据）。
 * 设计见同目录 说明.md 的「设计要点」一节。
 */
import * as botUtils from '../../utils/Bots.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as embedded from '../../utils/Embedded.ts';
import * as versions from '../../utils/Versions.ts';
import type * as fastify from 'fastify';
import type { Session, SessionMeta } from '../../Sessions.ts';
import type { ReceiveEvent } from '../bots/index.ts';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import * as timelineModule from './Timeline.ts';
import * as viewsModule from './Views.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as checksModule from '../../utils/Checks.ts';
import * as protocol from '../channels/index.ts';


/** 插件名。 */
export const name = 'web-api';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.1.3：指定会话、引用别的渠道的消息也走 channel/message（routing.sessionId、replyOrigin），去掉 bot.hand 旁路；
//M   网页改成 channel_tool：一轮里 channel_reply 几次就追加几条，收尾（bot/settled）才标回完；role 写 owner；
//M   别的渠道的回话按“标准消息号 + 机器人”精确挂回（source_id 列），不再按地址找最新一行。
//M 1.1.4：网页入站地址带 owner: true（“同意 N”可批所有待确认）；replyDirect 支持跨渠道发往网页的回复落入时间线。
//M 1.1.5：registerTextReply 接入 getTargetAddress 自行识别网页跨渠道发话目标；带 target 的跨渠道请求不串挂回原入站行。
//M 1.1.6：模型目录、进度、流水和用量改用请求与回执事件；清理分支写法。
//M 1.1.10：回话追溯挑行改由 journal（journal/request 的 reply-lines，journal/Trail.ts 的 pickReply）做，Trace.ts 只拼网页要的形状。
//M 1.1.16：Timeline.insert 的跟踪点带 sourceId（标准消息号），journal 按它把渠道那几行串在收件行前面。
//M 1.1.19：回话追溯不再 import journal/Trail.ts：reply-lines 回的已是网页事件外壳 events，流水行换壳那段并进 journal/Trace.ts。
//M 1.1.21：网页发话改经 emitInbound 发 channel/direct；别的渠道的认领挂回改听 direct、mention、listen 三个；
//M   语音入档改看 voice/record 的 waiting（不再看 routing.recordOnly）。
//M 1.1.22：按地址发的网页回话由 replyByAddress 追加。
//M 1.1.23：插件间请求直接用 reply 或 why，网页沿用各自的缺项和失败反馈。
//M 1.1.24：会话、机器人接口和回话追溯入口搬进 Views.ts（云端20 第2+3条）；构造函数只做登记，事件处理挪成 onVoiceRecord、onReceive、bindClaims 方法。
//M 1.1.25：GET /api/ui/status 附带内存 startedAt 与可选 ui.language（不问基地），供前端高频轮询轻量探测进程变化。
export const version = '1.1.25';

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
    /**
     * GET /api/ui/status 每来一次就挨个问（ctx.serial）：每个渠道往 list 里 push 自己的一项或几项。监听的函数不许有返回值。
     * 谁发：src7/plugins/web-api/index.ts 的 WebApi.routes
     * 谁接：src7/plugins/feishu/index.ts 的 Feishu.constructor；src7/plugins/wechat/index.ts 的 Wechat.constructor
     */
    'web-api/status'(list: ChannelStatus[]): void | Promise<void>;
    /**
     * 收件表记下一条（HTTP 的、别的渠道的都算）。journal 和 tutorial 通过 internal/dispatch 记录。
     * 谁发：src7/plugins/web-api/Timeline.ts 的 Timeline.insert
     * 谁接：暂无
     */
    'web-api/received'(message: { id: number; bot: string; channel: string; source: string; text: string; at: number }): void;
    /**
     * 一句回话追加进收件表，replyIndex 是它在 replies 里的下标。journal 和 tutorial 通过 internal/dispatch 记录。
     * 谁发：src7/plugins/web-api/Timeline.ts 的 Timeline.reply
     * 谁接：暂无
     */
    'web-api/replied'(reply: { messageId: number; replyIndex: number; session: Session; text: string; at: number }): void;
    /**
     * 网页换了会话的模型。journal 通过 internal/dispatch 记录。
     * 谁发：src7/plugins/web-api/Views.ts 的 Views.setModel
     * 谁接：暂无
     */
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

/** HTTP 渠道和网页接口。 */
class WebApi {
  /** 渠道名：会话记着它，回话靠它认回来。 */
  readonly name = 'http';

  /** 挂上的时刻：网页靠 /api/ui/info 的它认出后端换了进程（web/src/Api.ts:795）。 */
  readonly startedAt = Date.now();

  /** 收件表和时间线。 */
  private readonly timeline: timelineModule.Timeline;

  /** 会话和机器人接口（Views.ts）。 */
  private readonly views: viewsModule.Views;

  /** 单调时间戳游标，防止同一毫秒连发多条 HTTP 消息时间戳撞车。 */
  private lastAt = 0;

  /** 正在等待保存回执的上传暂存文件，避免并发消息消费同一上传号。 */
  private readonly savingUploads = new Set<string>();

  /**
   * 建收件表和会话、机器人接口；听别的渠道的消息和回话；在一个 Fastify 作用域里登记全部接口。
   * 构造函数只做登记，每个事件的处理写成下面的方法。
   * 向 bots 登记本渠道名；所有发到网页的话（模型的 channel_reply、按地址发的自动回话、审批直回、本人批准的提醒）都经 channel/reply 到 replyDirect。
   * @param ctx Cordis 给这个插件的 ctx：在它上面 ctx.on 听的事件，插件被拔掉时 Cordis 自动撤掉。
   */
  constructor(private readonly ctx: cordis.Context) {
    //M 初始化收件表和时间线，让网页查询与历史监听共享已建好的记录；会话、机器人接口也读它。
    this.timeline = new timelineModule.Timeline(ctx);
    this.views = new viewsModule.Views(ctx, this.timeline);

    //M 向 bots 登记渠道名（网页的渠道清单用），随本插件卸载自动撤销。
    this.ctx.effect(() => this.ctx.bots.channel(this.name));

    //M 发到网页的话都经 channel/reply 到这里，追加进那条消息的回话清单（提醒写一条系统提示）。
    protocol.registerTextReply(this.ctx, {
      channel: this.name,
      getTargetAddress: (chat) => this.getReplyTargetAddress(chat),
      sendDirectText: (text, request, targetAddress) => this.replyDirect(text, request, targetAddress),
    });

    //M 语音整句入档：写进时间线，接回半句已开工的会话。
    ctx.on('voice/record', (message, sessionId, waiting) => {
      this.onVoiceRecord(message, sessionId, waiting);
    });

    //M 一轮收尾（bots 发 bot/settled）：网页的那条标成回完；没回成又一句没回过的，补一句原因。
    ctx.on('bot/settled', (event) => {
      this.onSettled(event);
    });

    //M 别的渠道的消息：记进时间线。
    ctx.on('bot/receive', (event) => {
      this.onReceive(event);
    });

    //M 别的渠道的消息认领完了：私聊、群里叫了机器人、只听的同一个处理。
    ctx.on('channel/direct', (message, control) => {
      this.bindClaims(message, control);
    });
    ctx.on('channel/mention', (message, control) => {
      this.bindClaims(message, control);
    });
    ctx.on('channel/listen', (message, control) => {
      this.bindClaims(message, control);
    });

    //M 别的渠道发成了的回话按“消息号 + 机器人”挂回；按地址发的回话找会话最近认领的那条。
    ctx.on('channel/replied', (event) => {
      this.recordOtherReply(event);
    });

    //M Fastify 在 http 开始监听时才执行这个函数，那时别的插件的路径都登记好了，hasRoute 查得到。
    ctx.http.app.register(async (scope) => {
      //M 延迟登记网页路由，等其他插件先挂好自己的路径。
      this.routes(scope);
      this.views.routes(scope);
      this.timeline.routes(scope);
    });
  }

  /**
   * voice/record：语音只在 ASR 确认整句后写入时间线，使用与半句任务相同的标准来源号。
   * 每个目标机器人一行，按来源号去重；半句已开工的（带会话号）绑回那场会话。
   * @param message 语音整句的渠道消息。
   * @param sessionId 半句已开工的会话号；没开工是 undefined。
   * @param waiting 这句等不等机器人回话：false 是只入档，直接标成回完。
   */
  private onVoiceRecord(message: protocol.ChannelMessage, sessionId: string | undefined, waiting: boolean): void {
    for (const bot of message.targetBots) {
      let id = this.timeline.findBySource(bot, message.messageId);
      if (id === undefined) {
        const sourceAddress = { ...message.origin.address };
        if ('taskId' in message.routing && typeof message.routing.taskId === 'string') {
          sourceAddress['voiceTaskId'] = message.routing.taskId;
        }
        const address = JSON.stringify(sourceAddress);
        const row: timelineModule.NewMessage = {
          bot,
          channel: message.channel,
          source: message.channel,
          text: message.rawText,
          address,
          source_id: message.messageId,
          createdAt: message.createdAt,
        };
        //M 先存最终文本，审批回复和认领回执才有可关联的原话。
        id = this.timeline.insert(row);
        //M 只入档、没有后台任务的语音句不等回话，直接标成回完。
        if (!waiting) {
          this.timeline.markReplied(id);
        }
      }
      if (sessionId !== undefined) {
        //M 半句已开工，整句接回原任务会话。
        this.timeline.bindSession(id, sessionId);
      }
    }
  }

  /**
   * bot/receive：别的渠道的消息记一份。bot/receive 是“挨个问”（ctx.serial），这里只读不改、不写 handled；
   * http 的已经在 accept 里记过，语音的由 onVoiceRecord 记。记下标准消息号（sourceId），回话按“消息号 + 机器人”精确挂回。
   * @param event bots 发的收件事件。
   */
  private onReceive(event: ReceiveEvent): void {
    const message = event.message;
    if (message.channel === this.name || message.channel === 'voice') return;

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
  }

  /**
   * channel/direct、channel/mention、channel/listen：别的渠道的消息认领完了（三个进来的事件里 bots 排在前面，claims 已填好），
   * 记下各机器人进了哪场会话，网页引用它时回得到原会话。只听的认领记录是记背景的那场前台。
   * @param message 渠道消息。
   * @param control 认领结果；没有就不记。
   */
  private bindClaims(message: protocol.ChannelMessage, control?: protocol.ChannelMessageControl): void {
    if (message.channel === this.name) return;

    for (const claim of control?.claims ?? []) {
      if (claim.sessionId === undefined) continue;

      //M 按标准消息号定位这个机器人的收件记录，以便引用时找回认领会话。
      const id = this.timeline.findBySource(claim.bot, message.messageId);
      if (id !== undefined) this.timeline.bindSession(id, claim.sessionId);
    }
  }

  /**
   * 登记渠道收话、界面信息、渠道状态这些接口；会话、机器人、追溯的接口在 Views.routes。
   * @param scope 上面开的作用域。
   */
  private routes(scope: fastify.FastifyInstance): void {
    //M 登记网页发话入口，交给渠道入站逻辑统一校验和分派。
    scope.post<{ Body: unknown }>('/api/message', async (request) => {
      //M 来源标记取自 HTTP 钩子，正文里的身份字段不会进入可信快照。
      const verified = this.ctx.http.isVerified(request);
      return this.accept(request.body, verified);
    });

    //M 为网页状态栏提供版本信息和渠道连接状态；/api/ui/status 顺带交回内存启动时刻与界面语言，免高频打基地。
    scope.get('/api/ui/info', async () => this.uiInfo());
    scope.get('/api/ui/status', async () => {
      const list: ChannelStatus[] = [];
      await this.ctx.serial('web-api/status', list);
      const language = this.getUiLanguage();
      if (language === undefined) return { startedAt: this.startedAt, channels: list };

      return { startedAt: this.startedAt, language, channels: list };
    });
  }

  /** 读取 config.yaml 里可选的 ui.language，未配置时返回 undefined。 */
  private getUiLanguage(): string | undefined {
    const ui = this.ctx.resources.raw['ui'];
    const language = utils.getStringField(ui, 'language').trim();
    if (language === '') return undefined;

    return language;
  }

  /**
   * 左下角版本：后端版本和编译时间；能连上基地时再带上壳子 jmbots.exe 的版本。
   * version / builtAt 仍放在顶层，兼容原先只读这两项的网页。
   */
  private async uiInfo(): Promise<{
    startedAt: number;
    version: string;
    builtAt: number;
    language?: string;
    server: { version: string; builtAt: number };
    shell: { version: string; builtAt: number } | null;
  }> {
    //M 取得后端编译时刻，供网页与版本号一起展示。
    const builtAt = embedded.getBuiltTime();
    const server = { version: versions.VERSION, builtAt };
    const language = this.getUiLanguage();

    //M 补充可用的壳子版本，让网页分别显示壳子与后端。
    const shell = await this.shellVersion();
    const base = { startedAt: this.startedAt, version: server.version, builtAt: server.builtAt, server, shell };
    if (language === undefined) return base;

    return { ...base, language };
  }

  /**
   * 通过基地事件查询壳子版本。
   * @returns 壳子版本与编译时刻，查询不可用时返回 null。
   */
  private async shellVersion(): Promise<{ version: string; builtAt: number } | null> {
    const request = { method: 'GET', route: '/version', timeoutMs: 800 } as const;
    const options = { warnAfterMs: 1800 };

    //M 基地版本单独查询，后端版本和启动时刻照常返回。
    const result = await requestEventModule.requestEvent(this.ctx, 'base/request', 'base/result', request, options);

    //G 无回执、失败或旧壳子不提供版本时，由页面显示未知。
    const response = result.reply;
    if (response === undefined) return null;

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
   * @param verifiedOwner HTTP 服务记录的身份核验结果。
   * @returns { id: 消息号, file: '' }（src7 不给每条消息写文件）。
   * @throws Failure(400)：字段不对、没有机器人或会话、上传号失效、分派失败。Failure(503/500)：附件存不下。
   */
  private async accept(raw: unknown, verifiedOwner: boolean): Promise<{ id: number; file: string }> {
    //M 外面进来的，这里校验一次。
    const body = checksModule.checkRecord(raw, '请求体') as MessageBody;
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
    const wanted = body.bot ?? quoted?.bot ?? session?.bot ?? botUtils.getDefaultBot(this.ctx.resources.raw);
    if (typeof wanted !== 'string' || botUtils.getBotConfig(this.ctx.resources.raw, wanted) === undefined) {
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

    //M 网页正在看哪儿（可选）：渠道要挂着、聊天要在清单里，这里查一次，带进发出的标准消息。
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
    const vars = {
      messageId: id, bot: wanted, table: 'web_messages', autoFinal: routing.autoFinal === true,
      attachmentCount: paths.length, targetSession: sessionLabel,
    };
    this.ctx.emit('trace', 'WebApi.accept', 'trace.webApi.accept', 'protocol.emitInbound(ctx, msg, true, control)', vars);

    //M 推给机器人；回话地址就是消息号。推不进去（比如没有插件管分派）就删掉这一行，告诉调用方。
    try {
      await this.emitChannelMessage(id, wanted, said, input, routing, view, grants, verifiedOwner);
    } catch (error) {
      this.timeline.remove(id);
      throw new failureModule.Failure(400, textModule.getErrorMessage(error));
    }
    return { id, file: '' };
  }

  /**
   * 网页的一条话经 emitInbound 发出 channel/direct（网页是私聊）：approval 先看“同意 N”，bots 再按 routing 认领（指定会话的只进那场）。
   * 附件在 accept 里已经存进 bots 工作区并拼成 @路径，因此 attachments 传空以免重复物化。
   * 网页来的都是本人（http 统一查令牌：本机、免令牌地址、带对令牌的才进得来），role 写 owner。
   * @param id web_messages 消息号。
   * @param wanted 目标机器人名。
   * @param rawText 原始用户输入+@路径。
   * @param text 带引用描述前缀的输入文本。
   * @param routing accept 里算好的路由（指定会话、引用来源、autoFinal）。
   * @param view 网页正在看哪儿（getView 校验过）；没带是 undefined，消息上就不写这一项。
   * @param grants 授权范围（checkGrants 查过、规范化过）；没带是 undefined，地址上就不写这一项。
   * @param verifiedOwner HTTP 服务核对过本机或令牌后写入的标记。
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
    verifiedOwner: boolean,
  ): Promise<void> {
    const now = Math.max(Date.now(), this.lastAt + 1);
    this.lastAt = now;
    //M 网页来源已经由 http 插件按本机/令牌核验过身份，带上 owner: true 让 approval 认出可批所有待确认。
    const address: Record<string, unknown> = { messageId: id, customer: 'http:本机', owner: true, verifiedOwner };

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

    //M 发出 channel/direct（网页是私聊、本人叫机器人）：approval 先看“同意 N”，bots 再认领进会话（前台用 channel_reply 回，几条都追加进回话清单）。
    const control: protocol.ChannelMessageControl = { claims: [] };
    await protocol.emitInbound(this.ctx, channelMessage, true, control);
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
    const channel = utils.getField(raw, 'channel');
    const chat = utils.getField(raw, 'chat') ?? '';
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
   * 网页渠道接 channel/reply：模型的 channel_reply、零次兜底、审批直回、按地址发的自动回话，都追加进那条消息的回话清单。
   * 会话用这一行记的（认领时记下的）；审批直回没有会话，用这个机器人网页的前台，并马上标成回完（没有模型轮，不会再有 bot/settled）。
   * 按地址发的回话没有来源快照，挂在说话的会话上；本人批准的提醒写一条系统提示。
   * @param text 要追加进 replies 的正文。
   * @param request 标准回复请求（来源地址里的 messageId 就是网页的消息号）。
   * @param targetAddress 确切地址（自动回话是会话记的 { messageId }，提醒是 { reminder: 意图号 }）或跨聊天认出的地址；回原消息时没有。
   * @returns 按地址发时缺原消息号、提醒的机器人不在时是 rejected；别的算已发。
   */
  private replyDirect(
    text: string,
    request: protocol.ChannelReplyRequest,
    targetAddress?: Record<string, unknown>,
  ): protocol.TextReplyOutcome | void {
    //M 本人批准过的提醒（approval 的主动发件）：写原机器人网页时间线的一条系统提示，不开模型轮。
    const reminder = utils.getStringField(targetAddress, 'reminder');
    if (reminder !== '') return this.writeReminder(request.bot, reminder, text);

    //M 按地址发的回话（会话一轮结束、中途一句）用会话记的 { messageId }，挂在说话的会话上。
    const snapshot = request.sourceSnapshot;
    if (snapshot === undefined) return this.replyByAddress(text, request, targetAddress);

    const messageId = snapshot.origin.address['messageId'];
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
   * 按地址发的回话（会话一轮结束自动回、中途一句）：追加到会话记的那条网页消息，挂在说话的会话上。
   * @param text 要追加的正文。
   * @param request 回复请求（带 sessionId）。
   * @param targetAddress 会话记的回话地址 { messageId }。
   * @returns 地址里没有原消息号、没有会话号时是 rejected（不猜发到哪）；挂上了算已发。
   */
  private replyByAddress(
    text: string,
    request: protocol.ChannelReplyRequest,
    targetAddress?: Record<string, unknown>,
  ): protocol.TextReplyOutcome | void {
    const messageId = utils.getField(targetAddress, 'messageId');
    if (typeof messageId !== 'number') return { status: 'rejected', reason: 'no_message：网页回话地址里没有原消息号' };

    const sessionId = request.sessionId;
    if (sessionId === undefined) return { status: 'rejected', reason: 'no_session：网页旧路回话没有会话号' };

    //M 把按地址发的机器回复追加到对应收件记录，供网页轮询显示。
    const session = this.ctx.sessions.open(sessionId);
    this.timeline.reply(messageId, session, text);
  }

  /**
   * 把本人批准过的提醒写到原机器人在本机网页的时间线（同一意图只写一条）。
   * @param bot 原机器人（approval 照提醒记录填的）。
   * @param intentId 发件意图号，拼成来源号去重。
   * @param text 提醒正文。
   * @returns 机器人不在是 rejected；写了（或早写过）算已发。
   */
  private writeReminder(bot: string, intentId: string, text: string): protocol.TextReplyOutcome {
    if (bot === '') return { status: 'rejected', reason: '网页提醒没有目标机器人' };
    if (botUtils.getBotConfig(this.ctx.resources.raw, bot) === undefined) return { status: 'rejected', reason: '原机器人已不存在' };

    const sourceId = `reminder:${intentId}`;
    const session = this.getOrCreateWebFront(bot);
    const write = this.ctx.resources.db.transaction(() => {
      const existing = this.timeline.findBySource(bot, sourceId);
      if (existing !== undefined) return;

      //M 复用网页的系统提示行，展示一个提醒条目。
      const shown = `（系统）${text}`;
      const item = { bot, channel: this.name, source: 'reminder', text: shown, address: null, source_id: sourceId };
      const id = this.timeline.insert(item);
      this.timeline.bindSession(id, session.id);
      this.timeline.markReplied(id);
    });
    write.immediate();
    return { status: 'sent' };
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
   * 一轮收尾（bot/settled）：网页自己的那条标成回完；没回成、一句也没回过的，补一句原因（原来一轮结束会把出错的话回过来）。
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
    const dir = this.ctx.resources.ensureRuntimeDir('data', 'tmp', 'uploads');
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
    const uncertain = '附件保存结果不确定，请核对工作区后再提交。';
    const options = { warnAfterMs: 5000 };
    try {
      for (const file of files) {
        const request = { action: 'save-file', bot, name: file.name, data: file.data } as const;

        //M 让机器人保存附件，收到实际路径后才能写进对话。
        const result = await requestEventModule.requestEvent(this.ctx, 'bot/request', 'bot/result', request, options);

        //G 未发起保存时可重试，执行结果未知时请用户先核对工作区。
        if (result.why === 'unhandled') {
          const reason = result.detail ?? `保存附件未获回执（${result.why}）`;
          const error = `附件存不下：${reason}`;
          throw new failureModule.Failure(503, error);
        }

        //G 保存结果未确认时保留暂存数据供核对。
        if (result.why !== undefined) throw new failureModule.Failure(504, uncertain);

        //G 确定未保存时停止发消息，保留暂存上传供重试。
        const saved = result.reply;
        if (!saved.ok || saved.path === undefined) {
          const error = `附件存不下：${saved.error ?? '机器人未返回文件路径'}`;
          throw new failureModule.Failure(500, error);
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
   * 别的渠道按地址发成的回话（relay 回信、一轮结束自动回的、中途一句，没有来源快照，带会话号）：
   * 按这场会话最近认领的那条（sourceClaims 最后一项，里面是标准消息号和机器人）精确挂回；认不出是哪条的不记，不按地址猜。
   * @param sessionId 哪场会话说的；没有会话的（本人批准的主动发件、外置程序发件）不记。
   * @param text 说的话。
   */
  private recordOther(sessionId: string | undefined, text: string): void {
    if (sessionId === undefined) return;

    //G 会话不在了 → 认不出是哪条，不记。
    if (this.ctx.sessions.find({ id: sessionId })[0] === undefined) return;

    const session = this.ctx.sessions.open(sessionId);
    const row = session.row;
    //G 正在跑 channel_tool 的轮：它的话照来源快照记，不在这里记。
    if (row.activeSourceSnapshot !== undefined) return;

    //G 直接经 bots.receive 入站（如微信起草）可能未认领标准消息，无法定位原消息就不记。
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

    //M 按标准消息号和机器人找到这场会话的原消息，再把回复追加进去。
    const id = this.timeline.findBySource(row.bot, sourceId);
    if (id !== undefined) this.timeline.reply(id, session, text);
  }

  /**
   * 别的渠道的回话发到了（channel/replied，带着请求正文）：有来源快照的按“标准消息号 + 机器人”挂回那一行，按地址发的回话按会话挂回。
   * 会话用那一行认领时记下的；还没记会话的不挂（Timeline.reply 要会话算生成依据）。跨聊天发出的（只带 target.chat）不挂回原入站行。
   * @param event 渠道回执。
   */
  private recordOtherReply(event: protocol.ChannelRepliedEvent): void {
    //G 网页自己的回话在 replyDirect 里挂过；只记别的渠道发成了的文字回复。
    const request = event.request;
    if (request.channel === this.name || request.mode !== 'text') return;

    const status = event.receipt.status;
    if (status !== 'sent' && status !== 'partial') return;

    const text = request.parts.map((part) => part.text ?? '').filter((part) => part !== '').join('\n');
    if (text === '') return;

    //M 按地址发的回话（没有来源快照）挂回说话的会话最近认领的那条。
    const snapshot = request.sourceSnapshot;
    if (snapshot === undefined) {
      this.recordOther(request.sessionId, text);
      return;
    }

    //G 带 target 的是发到别处的，不挂回原入站行。
    if (request.target !== undefined) return;

    //M 找回原话那一行，和它记下的会话。
    const key = event.receipt.replyRequestKey;
    const id = this.timeline.findBySource(snapshot.botName, snapshot.messageId);
    if (id === undefined) return;

    //G 原消息必须还在并已绑定会话，才有足够资料补记回话。
    const record = this.timeline.get(id);
    if (record === undefined) return;

    if (snapshot.channel === 'voice') {
      //M 语音后台有来源会话，审批直回等程序回复也可没有会话。
      const sourceSession = snapshot.origin.address['voiceSessionId'];
      let session: Session | undefined;
      if (typeof sourceSession === 'string') {
        session = this.ctx.sessions.open(sourceSession);
      }
      if (session === undefined && record.sessionId !== null) {
        session = this.ctx.sessions.open(record.sessionId);
      }
      const spoken = 'spoken' in event.receipt && event.receipt.spoken === true;
      const delivery = { key, spoken };
      //M 回复幂等键和实际播放状态与文字一起落盘。
      this.timeline.reply(id, session, text, delivery);
      return;
    }
    if (record.sessionId === null) return;

    //M 用原会话恢复回话的生成依据，随正文一起挂回对应收件记录。
    const session = this.ctx.sessions.open(record.sessionId);
    this.timeline.reply(id, session, text);
  }
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
