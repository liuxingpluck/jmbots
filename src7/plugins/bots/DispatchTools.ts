/** 前台派活的三个模型工具，以及提示词和工具可见性。 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChatRequest, Session, SessionMeta, Thinking } from '../../Sessions.ts';
import * as imageModule from '../../utils/Image.ts';
import * as filesModule from '../../utils/Files.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import type * as modelCatalogPlugin from '../model-catalog/index.ts';
import type * as workspacesPlugin from '../workspaces/index.ts';
import * as protocol from '../channels/index.ts';
import type { DeliveryMode, FrontTask, Stage } from './DispatchResults.ts';
import * as dispatch from './DispatchResults.ts';
import type { FrontDesk } from './FrontDesk.ts';
import type { Bot, Origin } from './index.ts';

/** 思考档，从低到高。hand_session 的 thinking 只收这几个。 */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 前台整理结果的那一轮拿掉的工具：不再派活、不喊停、不交外部 AI。 */
const NO_DISPATCH = new Set(['hand_session', 'stop_session', 'agent_task']);
/** 回报到哪了的中文：list_sessions 用。 */
const STAGE_WORDS: Record<Stage, string> = {
  queued: '排着等前台整理',
  working: '前台在整理',
  sending: '正在发',
  sent: '已发到渠道',
  done: '已看完',
  partial: '只发了一部分',
  uncertain: '不知道发到没有（没重发）',
  rejected: '渠道没收',
};

/** 告诉前台怎么派活。 */
const HAND_HINT = '派活用 hand_session：action new 新开一场后台，append 接着一场（写 sessionId）。'
  + '在哪个工作区干写 workspaceId（工作区 ID，先用 workspace 工具 list 查），或者照旧写 workspace（工作区里的相对路径，或机器人登记的名字），'
  + '两个只写一个，都不写是默认工作区；工作区定了以后 append 不能换，要换就新开一场。'
  + '还可写 model（供应商名/模型 ID）、thinking（思考档）；不写模型就沿用你现在的。'
  + '后台做完的结果先回到你这里，由你整理后回给用户；要暂停一场用 stop_session，再 append 就接着做。'
  + '同一个群里同一个问题，已经交办后台在查的，你先不给结论，只说“在查，做完发你”；'
  + '后台的结论回来以它为准，要改你前面说过的话时明说“更正：……”。';

/** 注册派活工具并管理普通前台轮的派活说明。 */
export class DispatchTools {
  /** 共用 bots 的上下文和前台会话范围。 */
  constructor(
    private readonly home: cordis.Context,
    private readonly desk: FrontDesk,
  ) {
    //M list_sessions：这个客户干活的会话，每场一行。
    this.home.tools.register({
      definition: {
        name: 'list_sessions',
        description: '看这个客户干活的会话：正在跑的、暂停的、以前的，每场一行：会话号、状态、工作区、模型、结果回报到哪了、一句总结。',
        parameters: piAi.Type.Object({}),
      },
      sessionKinds: ['front'],

      //M 模型调 list_sessions：交 list 列出本客户干活的会话，排成文字回给模型。
      run: (_args, session) => this.list(session),
    });

    //M hand_session：新开或接着一场后台。
    this.home.tools.register({
      definition: {
        name: 'hand_session',
        description: '把一件事交给一场干活的后台会话。action new 新开（默认），append 接着一场（写 sessionId；暂停的也用它接着做）。'
          + '后台做完的结果先回到你这里，由你整理后回给用户。',
        parameters: piAi.Type.Object({
          action: piAi.Type.Optional(piAi.Type.Union([piAi.Type.Literal('new'), piAi.Type.Literal('append')], {
            description: 'new 新开（默认；写了 sessionId 默认是 append），append 接着一场',
          })),
          text: piAi.Type.String({ description: '要办的事，或接着补充的话' }),
          sessionId: piAi.Type.Optional(piAi.Type.String({ description: 'append 时写接着哪一场' })),
          workspaceId: piAi.Type.Optional(piAi.Type.String({
            description: '在哪个工作区干：工作区 ID（用 workspace 工具 list 查）；和 workspace 只写一个，都不写是默认工作区。只在 new 时看',
          })),
          workspace: piAi.Type.Optional(piAi.Type.String({
            description: '旧写法，在哪个目录干：工作区里的相对路径，或机器人配置 workspaces 里登记的名字；不写是工作区本身。只在 new 时看',
          })),
          model: piAi.Type.Optional(piAi.Type.String({ description: '用哪个模型，供应商名/模型 ID；不写沿用（new 沿用前台的，append 沿用那场的）' })),
          thinking: piAi.Type.Optional(piAi.Type.Union(LEVELS.map((level) => piAi.Type.Literal(level)), {
            description: '思考档；不写沿用',
          })),
        }),
      },
      sessionKinds: ['front'],

      //M 模型调 hand_session：交 hand 校验参数，新开或接着一场后台，回执给模型。
      run: (args, session) => this.hand(args, session),
    });

    //M stop_session：受管后台记暂停，别的喊停。
    this.home.tools.register({
      definition: {
        name: 'stop_session',
        description: '暂停一场干活的会话：停下来、不再往下做，结果也不交回；以后用 hand_session append 接着做。',
        parameters: piAi.Type.Object({
          sessionId: piAi.Type.String({ description: '哪一场' }),
        }),
      },
      sessionKinds: ['front'],

      //M 模型调 stop_session：交 pause 暂停那一场（受管后台记暂停，别的喊停）。
      run: (args, session) => this.pause(String(args['sessionId']), session),
    });

    //M onRequest 要等 model-catalog 回模型介绍，交回它的 Promise：骨架 serial 等它跑完再问下一个（Promise 落定的值是 undefined，不挡后面的人）。
    this.home.on('session/before-model', (request) => this.onRequest(request));
  }

  /**
   * hand_session：new 新开一场受管后台，append 接着一场。
   * @param args 工具参数，骨架照定义校验过。
   * @param front 调它的前台对话。
   * @returns 回执（JSON），给前台模型看。
   * @throws 机器人不在、workspaceId 和 workspace 都写了、工作区出界或没权限或已归档、模型不能用、会话不是本客户的、正在跑却要换模型时抛错，模型看得到。
   */
  private hand(args: Record<string, unknown>, front: Session): string {
    //M 机器人只从前台这场的 row.bot 取，模型不能填别人的。
    const bot = this.home.bots.get(front.row.bot);
    if (bot === undefined) {
      throw new Error(`没有这个机器人：${front.row.bot}`);
    }

    //M 参数：空串是没写。
    const sessionId = utils.getStringField(args, 'sessionId');
    const model = utils.getStringField(args, 'model');
    const thinking = utils.getStringField(args, 'thinking') as Thinking | '';
    const written = utils.getStringField(args, 'action');
    const workspaceId = utils.getStringField(args, 'workspaceId');
    const workspace = utils.getStringField(args, 'workspace');

    //G 工作区按 ID 选和旧写法只能写一个。
    if (workspaceId !== '' && workspace !== '') {
      throw new Error('workspace_selection_conflict：workspaceId 和 workspace 只能写一个');
    }

    //M 没写 action：写了会话号是 append，没写是 new。
    let action = written;
    if (written === '') {
      action = 'new';
    }
    if (written === '' && sessionId !== '') {
      action = 'append';
    }

    //G 不是本人（builder、guest、没写身份的外部渠道）不能挑模型、思考档，用前台的。
    const owner = protocol.isOwnerTurn(front.row.channel, front.row.address);
    if (!owner && (model !== '' || thinking !== '')) {
      throw new Error('只有本人能指定模型和思考档；不写就用前台的');
    }

    //M 新开与接着都带上这一轮的图片和来源，避免后续换地址时串回话。
    const asked = String(args['text']);
    const plan = this.getPlan(front, asked, model, thinking);

    if (action === 'new') {
      //M 工作区：按 ID 选，或旧写法（不写是 '.'，说话人的工作区本身）。
      const pick: WorkspacePick = {
        workspaceId,
        workspace: workspace || '.',
        allowArchived: false,
      };
      const newPlan = { ...plan, pick };

      //M action 是 new：新开一场受管后台，回执给前台模型。
      return this.create(front, bot, newPlan);
    }

    //G append 要写会话号。
    if (sessionId === '') {
      throw new Error('append 要写 sessionId：接着哪一场');
    }

    //M action 是 append：接着那一场，回执给前台模型。
    return this.append(front, bot, sessionId, plan);
  }

  /** 保留派活这一轮的图片和回话地址，供新开和续接共用。 */
  private getPlan(front: Session, asked: string, model: string, thinking: Thinking | ''): HandPlan {
    //M 图片：要办的事里 @ 的，加上这一轮用户发的。没写进要办的事的补上，后台才看得到。
    const images = [...new Set([...imageModule.getImagePaths(asked), ...this.desk.roundImages(front)])];
    const text = getTextWithImages(asked, images);

    //M 派活这一刻的渠道和地址：深拷贝，后面这场前台换了地址也不影响；channel_tool 会话同时传不可变来源快照。
    const activeFrontItem = dispatch.getActive(front.row);
    const activeSnapshot = activeFrontItem?.payload.sourceSnapshot ?? front.row.activeSourceSnapshot;
    const originSnapshot = activeSnapshot?.origin ?? {
      channel: front.row.channel,
      address: structuredClone(front.row.address),
    };
    const origin: Origin = {
      channel: originSnapshot.channel,
      address: structuredClone(originSnapshot.address),
    };
    let deliveryMode: DeliveryMode = dispatch.AUTO_REPLY_MODE;
    if (activeFrontItem?.deliveryMode === 'channel_tool' || activeSnapshot !== undefined) {
      deliveryMode = 'channel_tool';
    }

    return { text, model, thinking, images, origin, deliveryMode, sourceSnapshot: activeSnapshot };
  }

  /**
   * 新开一场受管后台：定工作区、模型、思考档，开会话，交给机器人推它跑。
   * @param front 前台对话。
   * @param bot 这个机器人。
   * @param plan 要办的事、选的工作区、模型、思考档（空串是没写）、这一轮的图片、派活时的地址。
   * @returns 回执 JSON。
   */
  private create(front: Session, bot: Bot, plan: HandPlan & { pick: WorkspacePick }): string {
    //M 工作区：在说话人能用的范围里定下（出界、没权限、已归档抛错），拿到 ID 和目录。
    const resolved = this.getWorkspace(bot, plan.origin, plan.pick);

    //M 模型和思考档：没写沿用前台的；写了照模型清单校验。
    const picked = this.getModel(front.row.model, front.row.thinking, plan);

    //M frontTask.workspace 只作显示：旧写法记前台写的，按 ID 选的记工作区名字。
    let shown = plan.pick.workspace;
    if (plan.pick.workspaceId !== '') {
      shown = resolved.workspace.name;
    }

    //M 开会话：记上原前台、工作区、地址、策略，绑上工作区 ID；quiet，回话不直发，先交回前台。
    const frontTask: FrontTask = {
      front: front.id,
      round: 1,
      workspace: shown,
      origin: plan.origin,
      deliveryMode: plan.deliveryMode,
      paused: false,
    };
    if (plan.sourceSnapshot !== undefined) {
      frontTask.sourceSnapshot = structuredClone(plan.sourceSnapshot);
    }

    //M 开后台会话：kind 是 work，挂在前台下面（parent），记上客户号、模型、思考档、frontTask 和工作区 ID。
    const work = this.home.sessions.create({
      kind: 'work',
      bot: bot.name,
      parent: front.id,
      customer: front.row.customer,
      model: picked.model,
      thinking: picked.thinking,
      frontTask,
      quiet: true,
      workspaceId: resolved.workspace.id,
    });

    //M 交给机器人：回话地址是派活时的地址加上工作区目录（工具都照地址里的 workspace 认工作区），话进会话，推它跑。
    const workOrigin: Origin = {
      channel: plan.origin.channel,
      address: getWorkAddress(plan.origin.address, resolved.directory),
    };

    //M 机器人把话交进这场后台并推它往下跑（不等）。
    bot.hand(plan.text, workOrigin, work.id);

    //M 回执（会话号、状态、说明）给前台模型，模型据此告诉用户已经派出去了。
    return getReceipt('new', work, front);
  }

  /**
   * 接着一场：正在跑只补话；没在跑可以换模型、思考档，取消暂停，接着跑。老的不受管的后台没在跑时接过来受管。
   * @param front 前台对话。
   * @param bot 这个机器人。
   * @param sessionId 接着哪一场。
   * @param plan 补的话、模型、思考档（空串是没写）、这一轮的图片、这一次的地址。
   * @returns 回执 JSON。
   */
  private append(front: Session, bot: Bot, sessionId: string, plan: HandPlan): string {
    //M 按会话号打开要接着的那一场（没有这场会抛错，模型看得到）。
    const work = this.home.sessions.open(sessionId);

    //G 不是本机器人、本客户、本人派的 → 不能接。
    const denied = this.getDenied(work, front);
    if (denied !== '') {
      throw new Error(denied);
    }

    //M 正在跑：只补话，下一步带上；换模型、思考档要先 stop_session 暂停。
    if (work.row.state === 'running') {
      const changeModel = plan.model !== '' && plan.model !== work.row.model;
      const changeThinking = plan.thinking !== '' && plan.thinking !== work.row.thinking;
      if (changeModel || changeThinking) {
        throw new Error(`running_model_change：会话 ${work.id} 正在跑，换模型、思考档要先 stop_session 暂停，再 append`);
      }

      //M 补的话进会话，推它往下走（它在转，下一步会带上这句）；回执给前台模型。
      work.queueUserMessage(plan.text);
      void work.run();
      return getReceipt('append', work, front);
    }

    //M 没在跑：先定下来再改，抛错时什么都没动。
    //M   工作区：绑定过的照 workspaceId 再核一遍这一次说话人能不能用（归档了也接着用），目录不变；
    //M   老的没绑定的照旧 workspace 在这一次说话人的范围里落一遍（老的不受管的后台是 '.'），再绑上 ID。
    //M   写了模型、思考档就换（照模型清单校验），有图而模型看不了图就换看图模型。
    const workspace = work.row.frontTask?.workspace ?? '.';
    const pick: WorkspacePick = {
      workspaceId: work.row.workspaceId ?? '',
      workspace,
      allowArchived: true,
    };
    //M 沿用已绑定的目录并复核权限，模型按本次派活及图片需要更新。
    const resolved = this.getWorkspace(bot, plan.origin, pick);
    const picked = this.getModel(work.row.model, work.row.thinking, plan);
    work.row.model = picked.model;
    work.row.thinking = picked.thinking;
    work.row.workspaceId = resolved.workspace.id;

    //M 受管：取消暂停，地址与来源策略换成这一次的。老的不受管的后台：接过来受管，结果交回这场前台。
    let task = work.row.frontTask;
    if (task === undefined) {
      task = {
        front: front.id,
        round: 1,
        workspace,
        origin: plan.origin,
        deliveryMode: plan.deliveryMode,
        paused: false,
      };
      if (plan.sourceSnapshot !== undefined) {
        task.sourceSnapshot = structuredClone(plan.sourceSnapshot);
      }
      work.row.frontTask = task;
      work.row.quiet = true;
      work.row.parent ??= front.id;
    }
    task.paused = false;
    task.origin = plan.origin;
    task.deliveryMode = plan.deliveryMode;
    if (plan.sourceSnapshot !== undefined) {
      task.sourceSnapshot = structuredClone(plan.sourceSnapshot);
    }

    //M 模型、思考档、工作区 ID、frontTask 都改好了，存库，再交给机器人推它跑。
    work.save();

    //M 交给机器人推它跑：回话地址换成这一次的，工作区目录照绑定的写进去。
    const workOrigin: Origin = {
      channel: plan.origin.channel,
      address: getWorkAddress(plan.origin.address, resolved.directory),
    };

    //M 机器人把补的话交进这场后台并推它往下跑（不等）。
    bot.hand(plan.text, workOrigin, work.id);

    //M 回执（会话号、状态、说明）给前台模型。
    return getReceipt('append', work, front);
  }

  /**
   * stop_session：受管后台持久记暂停，再喊停；别的照旧喊停。
   * @param sessionId 哪一场。
   * @param front 前台对话。
   * @returns 回执。
   * @throws 不是本客户的会话时抛错。
   */
  private pause(sessionId: string, front: Session): string {
    //M 按会话号打开要暂停的那一场（没有这场会抛错，模型看得到）。
    const target = this.home.sessions.open(sessionId);

    //G 不是本机器人、本客户、本人派的 → 不能停。
    const denied = this.getDenied(target, front);
    if (denied !== '') {
      throw new Error(denied);
    }
    const running = target.row.state === 'running';
    const task = target.row.frontTask;

    //M 不受管的老会话：照旧喊停。
    if (task === undefined && !running) return `会话 ${target.id} 没在跑`;

    //M 不受管、还在跑的老会话：直接喊停，没有暂停可记。
    if (task === undefined) {
      target.stop('前台');
      return `已喊停 ${target.id}`;
    }

    //M 受管：先存库记暂停（没在跑也记，免得排着的外部结果把它推起来），再喊停。已经做了的不回滚。
    task.paused = true;
    target.save();
    if (running) {
      target.stop('前台暂停');
    }
    const receipt = {
      ok: true,
      sessionId: target.id,
      paused: true,
      stopRequested: running,
      inFlightMayBeFinishing: running,
      note: '已请求暂停；正在执行的工具可能还在收尾，已做的不回滚。用 hand_session append 接着做。',
    };
    return JSON.stringify(receipt);
  }

  /**
   * list_sessions：本客户干活的会话，每场一行。
   * @param front 前台对话。
   */
  private list(front: Session): string {
    //M 范围：这场前台交办的（含老的没记前台的），和同一个客户的。
    const allow = new Set(this.desk.scopeIds(front));
    const customer = front.row.customer;
    const rows = this.home.sessions.find({ bot: front.row.bot, kind: 'work' }).filter((row) => {
      if (allow.has(row.id)) return true;

      return customer !== undefined && row.customer === customer;
    });
    if (rows.length === 0) return '还没有干活的会话。';

    //M 工作区的名字：只要这一次说话人看得到的（外人看不到别人工作区的名字）。
    const workspaces = this.home.workspaces;
    const access = workspaces.getAccess(front.row.bot, front.row.channel, front.row.address);
    const visible = workspaces.list(access, { includeArchived: true });
    const pairs = visible.map((item): [string, string] => [item.id, item.name]);
    const names = new Map(pairs);

    //M 每场会话排成一行（会话号、状态、工作区、回报到哪了、模型、总结），回给前台模型。
    const lines = rows.map((row) => this.getLine(row, front, names));
    return lines.join('\n');
  }

  /**
   * list_sessions 的一行：会话号、状态（暂停、转走也写出来）、工作区（名字和 ID）、回报到哪了、模型、总结。
   * @param row 后台会话的记录。
   * @param front 前台对话：从它的队列看这场的结果回报到哪了。
   * @param names 这一次说话人看得到的工作区：ID → 名字。
   */
  private getLine(row: SessionMeta, front: Session, names: Map<string, string>): string {
    const task = row.frontTask;
    let state: string = row.state;
    if (task?.paused === true) {
      state = 'paused';
    }
    if (task?.handedTo !== undefined) {
      state = `转到 ${task.handedTo}`;
    }
    const parts = [row.id, state];

    //M 受管的：工作区、结果回报到哪了（原前台队列里这场最近一项）。
    if (task !== undefined) {
      const items = (front.row.resultQueue ?? []).filter((item) => item.source.id === row.id);
      const last = items.at(-1);
      let returned = '还没交回';
      if (last !== undefined) {
        returned = STAGE_WORDS[last.stage];
      }
      //M 工作区写成“名字（ID）”这样一段，名字查不到（外人看不到别人的）就只写 ID。
      parts.push(getWorkspaceText(row, task, names));
      parts.push(`回报：${returned}`);
    }
    //M 列完派活状态，再补模型与摘要，便于选择要续接的会话。
    parts.push(`模型 ${row.model}（${row.thinking}）`);
    parts.push(row.summary ?? '（还没有总结）');
    return parts.join(' ');
  }

  /**
   * 能不能碰这场会话：本机器人的后台、本客户的；非本人（builder、guest）只能碰自己派的（群里别人派的带着别人的对话）。
   * @param work 要碰的会话。
   * @param front 前台对话。
   * @returns 不能碰的原因；能碰是空串。
   */
  private getDenied(work: Session, front: Session): string {
    const ours = work.row.kind === 'work' && work.row.bot === front.row.bot;
    if (!ours) return `session_not_owned：会话 ${work.id} 不是这个机器人干活的会话`;

    const customer = front.row.customer;
    if (customer !== undefined && work.row.customer !== undefined && work.row.customer !== customer) {
      return `session_not_owned：会话 ${work.id} 不是这个客户的`;
    }

    //M 不是本人：派活时的说话人要是他。
    if (!protocol.isOwnerTurn(front.row.channel, front.row.address)) {
      const speaker = utils.getStringField(front.row.address, 'openId');
      const owner = utils.getStringField(work.row.frontTask?.origin.address, 'openId');
      if (speaker === '' || speaker !== owner) return `session_not_owned：会话 ${work.id} 不是你派的`;
    }
    return '';
  }

  /**
   * 后台在哪个工作区干：在说话人能用的范围（builder、guest 是地址里他自己的目录，本人是这个机器人的全部工作区）里定下，
   * 交给 workspaces 插件的 resolve 查归属、范围、归档，旧写法的目录第一次用到时原地登记。
   * @param bot 这个机器人。
   * @param origin 派活时（append 是这一次）说话人的渠道和地址：照它算谁在用（workspaces.getAccess）。
   * @param pick 选哪个：workspaceId；没写看旧写法 workspace（'.' 是范围本身；机器人配置 workspaces 里登记的名字只给本人；
   *   别的当相对路径，目录不在就建）。
   * @returns 工作区和绝对目录。
   * @throws workspace_outside_scope（出了范围、非本人用登记的名字）、workspace_not_found、workspace_forbidden、workspace_archived。
   */
  private getWorkspace(bot: Bot, origin: Origin, pick: WorkspacePick): workspacesPlugin.ResolvedWorkspace {
    //M 先按说话人的渠道和地址算他是本人还是外人、能用哪个目录范围，下面的选法都在这个范围里。
    const address = origin.address;
    const workspaces = this.home.workspaces;
    const access = workspaces.getAccess(bot.name, origin.channel, address);

    //M 按 ID 选（新派的写了 workspaceId、绑定过的后台）。
    if (pick.workspaceId !== '') {
      const byId = { workspaceId: pick.workspaceId, allowArchived: pick.allowArchived };
      return workspaces.resolve(access, byId);
    }

    //M '.'：这个范围的默认工作区（默认的不会归档）。
    if (pick.workspace === '.') return workspaces.resolve(access);

    //M 机器人配置里登记的名字（比如源码仓库）：只给本人，用建机器人时登记的那个工作区。
    const registeredId = bot.registered.get(pick.workspace);
    if (registeredId !== undefined && !access.owner) {
      throw new Error(`workspace_outside_scope：登记的目录 ${pick.workspace} 只给本人用`);
    }
    if (registeredId !== undefined) {
      const byName = { workspaceId: registeredId, allowArchived: pick.allowArchived };
      return workspaces.resolve(access, byName);
    }

    //M 相对路径：出了范围 inside 抛错；目录不在就建，再原地登记成这个范围的工作区。
    //M   这一轮的授权目录（回话地址的 grants.dirs，用户 #301）里的也行：后台可以直接在授权目录里干活。
    const grantDirs = workspaceModule.getGrantDirs(address);
    let dir = '';
    try {
      dir = workspaceModule.resolveWorkspacePath(access.root, pick.workspace, grantDirs);
    } catch (error) {
      //G 保留路径校验失败的原异常，继续给工具回原拒绝原因。
      const reason = textModule.getErrorMessage(error);
      const options = { cause: error };
      throw new Error(`workspace_outside_scope：${reason}`, options);
    }
    //M 确保已校验的工作区目录存在，再原地登记。
    filesModule.ensureDir(dir);
    const byDirectory = {
      legacyDirectory: dir,
      legacyName: pick.workspace,
      allowArchived: pick.allowArchived,
    };

    //M 目录已经在范围里建好了：原地登记成这个范围的工作区（登记过的认出来），交回工作区和绝对目录。
    return workspaces.resolve(access, byDirectory);
  }

  /**
   * 定模型和思考档：没写沿用；写了的模型要在模型清单里，写了的思考档要是那个模型支持的。
   * 这一轮有图而模型看不了图：模型是沿用的就换看图模型；是写了的就报错，给候选，不悄悄换。
   * @param model 沿用的模型。
   * @param thinking 沿用的思考档。
   * @param plan 写了的模型、思考档（空串是没写）、这一轮的图片。
   * @returns 定下的模型和思考档。
   * @throws model_unavailable、thinking_unsupported、模型看不了图时抛错。
   */
  private getModel(model: string, thinking: Thinking, plan: HandPlan): { model: string; thinking: Thinking } {
    let picked = model;
    let level = thinking;
    if (plan.model !== '') {
      picked = plan.model;
    }
    if (plan.thinking !== '') {
      level = plan.thinking;
    }

    //G 供应商不在 config.yaml 里 → getModel 抛错。
    try {
      this.home.resources.getModel(picked);
    } catch (error) {
      //G 保留模型不可用的原异常，继续给工具回原错误文字。
      const reason = textModule.getErrorMessage(error);
      const options = { cause: error };
      throw new Error(`model_unavailable：${reason}`, options);
    }

    //M 有图而模型看不了图：写了模型的报错，没写的换看图模型（沿用的思考档 pi 会换成最近的）。
    const blind = plan.images.length > 0 && !this.desk.sees(picked);
    const vision = this.desk.visionModel();
    if (blind && plan.model !== '') {
      throw new Error(`模型 ${picked} 看不了图，这一轮有图；换一个看图的${getHintText(vision)}，或者不写 model`);
    }
    if (blind && vision !== undefined) {
      picked = vision;
    }

    //M 写了的才照模型清单查：清单里要有，思考档要是它支持的。没挂模型清单查不了，放行。
    const catalog = this.home.get('modelCatalog') as modelCatalogPlugin.ModelCatalog | undefined;
    if (catalog === undefined) return { model: picked, thinking: level };

    //M 取这个模型的介绍（有没有、支持哪些思考档），下面按它校验。
    const info = catalog.find(picked);
    if (plan.model !== '' && info === undefined) {
      throw new Error(`model_unavailable：模型清单里没有 ${picked}`);
    }
    const levels = info?.thinking ?? [];
    if (plan.thinking !== '' && levels.length > 0 && !levels.includes(level)) {
      throw new Error(`thinking_unsupported：${picked} 只支持 ${levels.join('、')}`);
    }
    return { model: picked, thinking: level };
  }
  /**
   * 响应 session/before-model：暂停的受管后台不调模型；前台整理结果那一轮拿掉派活工具；普通前台轮加上派活和选模型的说明。
   * @param request 这一步的请求。
   * 副作用：本人的前台轮发请求事件 model-catalog/request（action: prompt），本机拼、不掐表；没挂 model-catalog 立刻退回、不加模型介绍。
   */
  private async onRequest(request: ChatRequest): Promise<void> {
    const session = request.session;
    const row = session.row;

    //G 暂停的受管后台被推起来了（收尾时排着的话、重启）：喊停，给个空回答，不调模型。
    if (row.frontTask?.paused === true) {
      session.stop('暂停中');
      request.answer = piAi.fauxAssistantMessage('');
      return;
    }
    if (row.kind !== 'front') return;

    //M 整理结果的那一轮：不派活、不喊停（channel_tool 模式下用户输入首项同样占用 activeKey，仅 result 项移走派活工具）。
    const activeItem = dispatch.getActive(row);
    if (row.activeKey !== undefined && (activeItem === undefined || activeItem.kind === 'result')) {
      request.tools = request.tools.filter((tool) => !NO_DISPATCH.has(tool.name));
      return;
    }

    //G 这一轮没有派活工具（被收掉了）→ 不说。
    const canHand = request.tools.some((tool) => tool.name === 'hand_session');
    if (!canHand) return;

    //M 工具仍可用才把如何派活告诉模型。
    request.system.push(HAND_HINT);

    //G 不是本人（builder、guest、没写身份的外部渠道）不挑模型：不带模型介绍。
    if (!protocol.isOwnerTurn(row.channel, row.address)) return;

    //M 本人才能挑模型：发请求事件 model-catalog/request（action: prompt，契约 3.2 第 7 条），一次拿齐模型介绍评价和能用的思考档。
    //M   model-catalog 在本机拼，不掐表。
    const payload = { action: 'prompt' } as const;
    const options = { prefix: 'cat' };

    //M 发 model-catalog/request 事件、等配对的 model-catalog/result。
    const asked = await requestEventModule.requestEvent(
      this.home,
      'model-catalog/request',
      'model-catalog/result',
      payload,
      options,
    );

    //G 没挂 model-catalog、出错：这一轮只带派活说明。
    if (asked.why !== undefined) return;

    //G 没有模型介绍：不加，思考档那段也不加。
    const result = asked.reply;
    const prompt = result.prompt ?? '';
    if (prompt === '') return;

    //M 仅本人的前台请求附上模型介绍，方便为后台任务选模型。
    request.system.push(prompt);

    //M 有介绍的模型各自能用的思考档：有才加。
    const levels = result.levelsText ?? '';
    if (levels !== '') {
      request.system.push(levels);
    }
  }
}

/** hand_session 的计划：new 和 append 共用的几项。 */
interface HandPlan {
  /** 要办的事，图片路径补好了。 */
  text: string;
  /** 写了的模型；空串是没写。 */
  model: string;
  /** 写了的思考档；空串是没写。 */
  thinking: Thinking | '';
  /** 这一轮用户发的图片路径。 */
  images: string[];
  /** 派活这一刻的渠道和地址（深拷贝）。 */
  origin: Origin;
  /** 派活时的回复策略。 */
  deliveryMode: DeliveryMode;
  /** 派活时不可变来源快照。 */
  sourceSnapshot?: protocol.SourceSnapshot;
}


/** 后台选哪个工作区：getWorkspace 用。 */
interface WorkspacePick {
  /** 按 ID 选：新派的写了 workspaceId，或后台绑定的 row.workspaceId；空串是没有。 */
  workspaceId: string;
  /** 旧写法：相对路径或登记的名字；'.' 是说话人的范围本身。workspaceId 不是空串时不看。 */
  workspace: string;
  /** 已归档的也给：只给已经派出去的后台 append 接着用；新派的是 false。 */
  allowArchived: boolean;
}


/**
 * hand_session 的回执，JSON 给前台模型看。
 * @param action new 或 append。
 * @param work 交给的那场。
 * @param front 前台对话。
 */
function getReceipt(action: string, work: Session, front: Session): string {
  const receipt = {
    ok: true,
    action,
    sessionId: work.id,
    state: work.row.state,
    workspace: work.row.frontTask?.workspace ?? '.',
    workspaceId: work.row.workspaceId,
    model: work.row.model,
    thinking: work.row.thinking,
    returnTo: front.id,
    note: '结果会先回到你这里，由你整理后回给用户；不用等，先简短告诉用户已经在办。',
  };
  return JSON.stringify(receipt);
}


/**
 * 要办的事补上图片路径：这一轮用户发的图、没写进去的，补成 @路径（带空格的加引号）。
 * @param text 要办的事。
 * @param images 这一轮的图片路径。
 */
function getTextWithImages(text: string, images: string[]): string {
  //M 只补用户没写进任务的图片路径，已引用的保留原写法。
  const missing = images.filter((file) => !text.includes(`@${file}`) && !text.includes(`@"${file}"`));
  const tokens = missing.map((file) => {
    if (/\s/u.test(file)) return `@"${file}"`;

    return `@${file}`;
  });
  return [text, ...tokens].join('\n');
}


/**
 * list_sessions 一行里的工作区：绑定了 ID、说话人看得到的写“工作区 名字（ID）”，看不到的只写 ID；老的没绑定的写前台当时写的。
 * @param row 后台会话的记录。
 * @param task 它的 frontTask。
 * @param names 这一次说话人看得到的工作区：ID → 名字。
 */
function getWorkspaceText(row: SessionMeta, task: FrontTask, names: Map<string, string>): string {
  const id = row.workspaceId;
  if (id === undefined) return `工作区 ${task.workspace}`;

  //M 外人看不到别人工作区的名字：只写 ID。
  const workspaceName = names.get(id);
  if (workspaceName === undefined) return `工作区 ${id}`;

  return `工作区 ${workspaceName}（${id}）`;
}


/**
 * 后台的回话地址：派活时的地址抄一份，写上工作区（工具照地址里的 workspace 认工作区，见 utils/Workspace.ts 的 of）。
 * @param address 派活时的地址；不是对象（命令行这类）就只写工作区。
 * @param dir 工作区，绝对路径。
 */
function getWorkAddress(address: unknown, dir: string): Record<string, unknown> {
  let copy: Record<string, unknown> = {};
  if (typeof address === 'object' && address !== null && !Array.isArray(address)) {
    copy = structuredClone(address) as Record<string, unknown>;
  }
  copy['workspace'] = dir;
  return copy;
}


/**
 * 报错时给的看图模型候选。
 * @param vision 看图模型；没有是 undefined。
 */
function getHintText(vision: string | undefined): string {
  if (vision === undefined) return '';

  return `（比如 ${vision}）`;
}
