/**
 * 审核和待确认。
 *   review：审一条命令，照 0.4 的顺序一档一档来：程序规则 → 决策模型（发 decision/judge，没挂 decision 当拿不准）→ 审核小会话（让模型看一眼）→ 问用户。
 *     程序规则里有可信目录（用户 11-18 #169）：执行目录和命令里写的路径都在 trusted_dirs 或这场会话的授权目录（回话地址的 grants.dirs）里，
 *     又不是删系统、删注册表、删数据、格式化（Rules.ts mustAsk）的，直接放行。
 *   ask：登记一件要用户点头的事（谁都能提），存表，发 approval/asked，有会话就发 bot/say 告诉用户怎么回。
 *   decide：用户定了，改表，发 approval/decided。谁提的谁听这个通知自己去做（exec、runs……），这里不执行任何东西。
 * 别的插件找本插件办事发请求事件 approval/request（review、ask、decide、close、list，契约 3.2 第 1 条），本插件回 approval/result。
 * 认文字回答：“同意 3”“拒绝”“全部同意”“待确认有哪些”，听 bot/receive。
 * 按说话人分档收工具（回话地址的 role，飞书照插件配置的 people 写）：guest 只给只读的（rules.READ_ONLY_TOOLS），
 * builder 再加在他自己目录里的 exec、write、edit、feishu_send_file（rules.BUILDER_TOOLS）；执行前再拦一次。
 * builder 的命令审核照“只能在他的目录里动”把关，审不过直接拒、不问用户。
 * 自己核对说话人：只接受发起该项的同一人（登记时记下的 actor），或用户本人（回话地址里的 owner）；飞书群里说的、群里提的只认本人；
 * “待确认有哪些”只列当事人自己的项；其他人的同样文字当普通消息交给前台。正确性不依赖监听顺序。
 * 接口：GET /api/approvals、POST /api/approvals/:id（有 http 才开）。
 * 不挡别的消息：review 只在提问的那场会话的工具里 await，别的会话、别的消息照常走；问用户时不等，马上交回“已经去问了”。
 * 设计：docs/src7插件设计/approval.md。
 */
import * as cordis from 'cordis';
import * as piAi from '@earendil-works/pi-ai';
import type * as fastify from 'fastify';
import type { AskInput as SessionAskInput, Session, Thinking } from '../../Sessions.ts';
import type { ReceiveEvent } from '../bots/index.ts';
import * as protocol from '../../Channels.ts';
import * as rules from './Rules.ts';
import * as cardUtils from '../../utils/Card.ts';
import * as checksModule from '../../utils/Checks.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as workspaceModule from '../../utils/Workspace.ts';


/** 插件名。 */
export const name = 'approval';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
export const version = '1.1.2';

/** 决策模型放行的最低门槛，也是默认值。 */
export const DECISION_PASS = 0.8;

/** 问决策模型最多等多久（契约 3.1：decision/judge 20 秒）；没回当拿不准，往下一档。 */
const DECISION_WAIT_MS = 20_000;

/** 用到的服务：bots 挑默认机器人，sessions 开审核小会话、找会话。decision 走事件、http 用 ctx.inject，都不写在这里（写进 inject 就成了“必须有”）。 */
export const inject = ['resources', 'bots', 'sessions'];


declare module 'cordis' {
  interface Context {
    /** 审核和待确认服务，实现在 src7/plugins/approval/index.ts。 */
    approval: Approval;
  }
  interface Events {
    /** 存完一件待确认的事（通知）。journal、feishu 听。 */
    'approval/asked'(pending: Pending): void;
    /** 定完一件事（通知），state 已是 approved / rejected。提的人（exec……）听它去做，journal、feishu 也听。 */
    'approval/decided'(pending: Pending): void;
    /** 别的插件请审核办事（serial 发、等 approval/result，用 utils/RequestEvent.ts 的 requestEvent）。本插件听，按 action 调现有方法。 */
    'approval/request'(request: ApprovalRequest): void | Promise<void>;
    /** approval/request 的回执（emit），按 requestId 配对。 */
    'approval/result'(result: ApprovalResult): void;
  }
}


/** 一件待确认的事。 */
export interface Pending {
  /** 号：从 1 往上，不复用，重启接着数。 */
  id: number;
  /** 谁提的：exec、run、update、review…… */
  kind: string;
  /** 一句话：要确认什么。 */
  title: string;
  /** 给用户看的细节，多行。 */
  detail: string;
  /** 提的人自己放的，原样存成 JSON，决定后原样还给他。 */
  payload: unknown;
  /** 哪个机器人的。 */
  bot: string;
  /** 哪场会话提的；命令窗口、更新提醒没有。 */
  session?: string;
  /** 发起该项的客户号（会话上的 customer），只读，核对用。 */
  customer?: string;
  /** 发起人的个人身份（如飞书按人、微信按聊天），只读，核对用。 */
  actor?: string;
  /** 在等、同意了、拒绝了。 */
  state: 'waiting' | 'approved' | 'rejected';
  /** 谁定的：“HTTP”“cli 文字回复”“飞书卡片 ou_x”…… */
  by?: string;
  /** 提的时刻，毫秒。 */
  askedAt: number;
  /** 定的时刻，毫秒。 */
  decidedAt?: number;
  /** 给用户点的卡片（utils/Card.ts）：网页审批面板、飞书卡片都照它画。 */
  card: cardUtils.CardData;
}

/** ask 要给的：card 可以不给，不给就照 title、detail 拼一张普通的。 */
export type AskInput = Pick<Pending, 'kind' | 'title' | 'detail' | 'payload' | 'bot' | 'session'> & {
  card?: Omit<cardUtils.CardData, 'state' | 'result'>;
};

/** review 要给的。 */
export interface ReviewInput {
  /** 要审的命令，原样。 */
  command: string;
  /** 在哪个目录跑。 */
  cwd: string;
  /** 给了就是 builder 让跑的，只能在这个目录里动（就是 cwd）：审核照这条把关，项目检查不直接放行，审不过直接拒、不问用户。 */
  confined?: string;
  /** 哪个机器人；不给用名单第一个（命令窗口没有机器人）。 */
  bot?: string;
  /** 哪场会话提的。 */
  session?: string;
  /** 谁提的，进待确认的 kind。 */
  kind: string;
  /** 放不了行、去问用户时，原样存进待确认。 */
  payload: unknown;
  /** 前三档都放不了行时问不问用户；不写是 true。不问就直接拒绝。 */
  ask?: boolean;
  /** 提问的那场会话被喊停时触发：审核小会话跟着停（设计文档没写，总管 11-14 加的）。 */
  signal?: AbortSignal;
}

/** 谁定的：rule 程序规则、decision 决策模型、review 审核小会话。 */
export type ReviewBy = 'rule' | 'decision' | 'review';

/** 审的结论：放行、拒绝，或者已经去问用户了（带待确认的号）。 */
export type Verdict =
  | { result: 'pass'; by: ReviewBy; reason: string }
  | { result: 'reject'; by: ReviewBy; reason: string }
  | { result: 'asked'; id: number; reason: string };


/**
 * approval/request 的请求（契约 3.2 第 1 条）：按 action 分五种，各对应本服务一个现有方法。
 * review 要等审核小会话，发的一方等 65 秒、透传 input.signal；没人答、超时一律当拒绝（exec 那边做）。
 */
export type ApprovalRequest = requestEventModule.RequestEnvelope & (
  | {
    /** 审一条命令（review）。 */
    action: 'review';
    /** 命令、目录、机器人、会话、提的人、payload、问不问用户、停止信号。 */
    input: ReviewInput;
  }
  | {
    /** 登记一件要用户点头的事（ask）。 */
    action: 'ask';
    /** 谁提的、标题、细节、payload、机器人、会话、卡片。 */
    input: AskInput;
  }
  | {
    /** 定一件事（decide）。 */
    action: 'decide';
    /** 待确认的号。 */
    id: number;
    /** true 同意，false 拒绝。 */
    approve: boolean;
    /** 谁定的：“飞书卡片 ou_x”“命令窗口：发命令的停下了”…… */
    by: string;
  }
  | {
    /** 作废一件还在等的事（close）。 */
    action: 'close';
    /** 待确认的号。 */
    id: number;
    /** 一句原因，如“会话已结束”。 */
    note: string;
  }
  | {
    /** 列还在等的（list）。 */
    action: 'list';
    /** 只要这一种（exec、update、review……）；不给是全部。 */
    kind?: string;
    /** 只要这个机器人的；不给是全部。 */
    bot?: string;
  }
);

/** approval/result 的回执：按请求的 action 带回对应的一项，没办成的写 error。 */
export interface ApprovalResult extends requestEventModule.ResultEnvelope {
  /** review：审的结论。 */
  verdict?: Verdict;
  /** ask：新登记的待确认。 */
  pending?: Pending;
  /** decide、close：定好的那件。 */
  settled?: Pending;
  /** list：还在等的，号从小到大。 */
  items?: Pending[];
  /** decide、close 找不到、已经定过的原因；办的时候出错的原话。 */
  error?: string;
}

/** 决策模型的回执：照 decision 声明的 decision/judge-result 取，不 import decision 目录。 */
type DecisionReply = requestEventModule.EventArg<'decision/judge-result'>;


/** 校验后的配置。 */
interface ApprovalConfig {
  /** 审核小会话用哪个模型；undefined 用 default_model。 */
  model?: string;
  /** 审核小会话的思考档。 */
  thinking: Thinking;
  /** 决策模型合出来的“安全”分不低于它就放行。 */
  decisionPass: number;
  /** 可信目录（trusted_dirs）：入口 Checks.ts 的 checkDirs 规范化过的绝对路径；空数组是没配。 */
  trustedDirs: string[];
}


/** 问决策模型的是非题，照 0.4 原文（src/executors/ExecReview.ts:77-83）。 */
const SAFE = {
  instructions: '要执行这条命令。它安全吗——不会删改重要的文件、不会泄露密钥、不会影响系统和别的程序？可以直接执行，回答‘是’。',
  yes: '安全，可以直接执行',
  no: '有风险，要问用户',
};

/** 这一轮是 guest 说的：工具已经只剩只读的，这段告诉模型别答应做不了的事。 */
const GUEST_PROMPT = '这一轮说话的不是用户本人（比如群里用户的朋友）。你只能查、读、搜、回答；'
  + '跑命令、写文件、改代码、发文件、生图这类动手的事做不了，也不要答应，告诉对方要用户本人来说。';


/**
 * 这一轮是 builder 说的：告诉模型他能在哪动、哪些事做不了。
 * @param dir 他的目录（回话地址的 workspace）。
 * @returns 提示词。
 */
function builderPrompt(dir: string): string {
  return `这一轮说话的不是用户本人，是用户允许在自己目录里干活的人。工作区现在是他的目录 ${dir}：`
    + '可以在这里读写文件、写代码、跑命令（命令照样要审核），也可以把这里的文件发给他；'
    + '出了这个目录的文件、系统设置、装全局的东西、记忆、通知、交给别的 AI 这些做不了，也不要答应，告诉对方要用户本人来说。';
}


/**
 * 审核时给 builder 的命令加的一句约束。
 * @param dir 他的目录。
 * @returns 写进审核小会话、决策模型状态的话。
 */
function confinedRule(dir: string): string {
  return `这条命令是用户允许的另一个人让跑的，这个人只能在 ${dir} 里动：`
    + '读写、删改这个目录外面的文件，改系统设置，装全局的东西（npm -g、pip 装到系统、改环境变量），读密钥，往外发数据，一律拒绝。';
}

/** 审核小会话的系统提示词：照 prompts/zh/30_审核.md，去掉 read、find（小会话不带工具，脚本内容直接放在话里）。 */
const REVIEW_PROMPT = '你是命令审核员。一个机器人要在用户的电脑上执行一条命令（见用户的话：命令、执行目录，可能还有要跑的脚本内容）。'
  + '你不执行它，只判断能不能直接执行，并替用户把这条命令说清楚。\n\n'
  + '能直接执行：只读的查看和检查；在工作目录里新建、修改文件，而且能重来；项目自己的构建、测试。\n'
  + '要问用户：删除或覆盖用户的文件（尤其是工作目录外面的）、改系统设置、装卸软件、动别的程序和服务、往外发数据、花钱、读密钥。拿不准就问用户。\n\n'
  + '要问用户时，你写的就是给用户看的审批卡片：标题用大白话说要做什么（不要写“执行命令”这种空话），原因从机器人的任务里看。\n\n'
  + '"what" 和 "risk" 用户一眼就要看懂，必须具体：\n'
  + '- what：用大白话说这条命令对哪些文件做什么，带上关键的路径，比如“把 src 整个复制到 zlt\\code，同名文件直接覆盖”。\n'
  + '- risk：safe 是 false 时，写清是哪个路径、哪种操作（删除、覆盖、改设置、装软件、往外发……）、会有什么后果，'
  + '比如“会覆盖 zlt\\code 里的同名文件，那边没提交的改动会丢”。不许只写“有风险”“风险中”“可能有影响”这种空话；'
  + 'safe 是 true 时写“无”。\n\n'
  + '只回一个 JSON，不要别的文字：\n'
  + '{"safe": true 或 false, "title": "大白话：要做什么，20 字以内", "reason": "为什么要做（机器人在干什么活）", '
  + '"what": "这条命令具体对哪些文件做什么（一两句，带路径）", "paths": ["会动到的文件或目录，没有就空数组"], '
  + '"risk_level": "low、medium 或 high", "risk": "具体的理由：哪个路径、哪种操作、什么后果；安全就写“无”", "advice": "建议同意还是拒绝，为什么"}';

/** 审核小会话的种类：不叫 review，免得和复盘插件 review 混。 */
const REVIEW_KIND = 'exec-review';

/** 定了的长跑提醒卡片在网页上留多久（变灰）。 */
const RECENT_MS = 10 * 60_000;

/** 状态的人话。 */
const STATE_TEXT: Record<Pending['state'], string> = { waiting: '在等', approved: '已同意', rejected: '已拒绝' };


/** 表里的一行。 */
interface Row {
  id: number;
  kind: string;
  title: string;
  detail: string;
  payload: string;
  bot: string;
  session: string | null;
  customer: string | null;
  actor: string | null;
  state: Pending['state'];
  decided_by: string | null;
  asked_at: number;
  decided_at: number | null;
  card: string | null;
}


/** 审核和待确认服务。 */
export class Approval extends cordis.Service {
  /**
   * 登记成 ctx.approval（cordis.Service 的构造函数做的：super(ctx, '名字') 就是“把我挂到 ctx 上叫这个名字”），
   * 建表，听 approval/request（别的插件请审核办事）、channel/message 和 bot/receive（认文字回答）、
   * session/request（给审核小会话加提示词；guest、builder 说的这一轮只给这一档的工具）和 session/before-tool（这一档没有的工具不让执行）。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param config 校验后的配置。
   */
  constructor(ctx: cordis.Context, private readonly config: ApprovalConfig) {
    //M 先把本服务登记成 ctx.approval。
    super(ctx, 'approval');

    //M 建待确认表（没有才建）。
    ctx.resources.db.exec('CREATE TABLE IF NOT EXISTS approval_pending (id INTEGER PRIMARY KEY AUTOINCREMENT,'
      + ' kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, payload TEXT NOT NULL, bot TEXT NOT NULL,'
      + ' session TEXT, state TEXT NOT NULL, decided_by TEXT, asked_at INTEGER NOT NULL, decided_at INTEGER)');
    //M 卡片列是 11-14 加的：老库没有就补上（老的行 card 是空的，读的时候照 title、detail 拼一张）。
    const columns = ctx.resources.db.query('PRAGMA table_info(approval_pending)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'card')) ctx.resources.db.exec('ALTER TABLE approval_pending ADD COLUMN card TEXT');
    if (!columns.some((column) => column.name === 'customer')) ctx.resources.db.exec('ALTER TABLE approval_pending ADD COLUMN customer TEXT');
    if (!columns.some((column) => column.name === 'actor')) ctx.resources.db.exec('ALTER TABLE approval_pending ADD COLUMN actor TEXT');

    //M 别的插件请审核办事走请求事件 approval/request（契约 3.2 第 1 条）：onRequest 按 action 调现有方法，办完回 approval/result。
    //M   现有方法抛的错转成 { error }，调用方不干等超时；review 没带回 verdict，exec 照“没有审核就不让跑命令”当拒绝。
    const requestOptions = {
      onError: (error: unknown) => {
        const message = textModule.getMessage(error);
        return { error: message };
      },
    };

    //M 登记请求监听：别的插件发 approval/request，本插件按 action 办，办完回 approval/result。
    requestEventModule.onRequestEvent(
      ctx,
      'approval/request',
      'approval/result',
      (request) => this.onRequest(request),
      requestOptions,
    );

    //M channel/message 消息级审批指令只消费一次：N 个机器人共存时不会各自批准一遍。
    ctx.on('channel/message', (message, control) => this.onChannelMessage(message, control), { prepend: true });

    //M 仍排在前面，只是为了先认出“同意 3”这类话；批不批准由下面自己核对说话人，不靠监听顺序，也不看前面有没有分好会话。
    ctx.on('bot/receive', (event) => {
      this.onReceive(event);
    }, { prepend: true });

    //M 审核小会话的提示词：prompt 插件只认 front、work，这种会话的提示词由这里给。
    //M 这一轮说话的是 guest、builder（渠道在回话地址里写的 role）：只留这一档的工具（rules.toolsFor），
    //M   别的直接从这一步的工具里拿掉，再在提示词里说一句，免得模型答应做不了的事。
    ctx.on('session/request', (request) => {
      if (request.session.row.kind === REVIEW_KIND) request.system.push(REVIEW_PROMPT);
      const address = request.session.row.address;
      const role = workspaceModule.getRole(address);
      const allowedTools = rules.toolsFor(role);
      if (allowedTools === undefined) return;

      //M 这一档没有的工具，从这一步的工具里拿掉。
      request.tools = request.tools.filter((tool) => allowedTools.has(tool.name));
      let prompt = GUEST_PROMPT;
      if (role === 'builder') {
        //M builder 提示词写明他被限制在哪个子工作区。
        prompt = builderPrompt(textModule.getText(address, 'workspace'));
      }

      //M 把这一档的提示词加进系统提示词，告诉模型别答应做不了的事。
      request.system.push(prompt);
    });

    //M 兜底：工具清单是这一步开头定的，会话转到一半换了说话人（群里别人插话）时，执行前再按现在的说话人拦一次。
    ctx.on('session/before-tool', (gate) => {
      if (gate.deny !== undefined) return;

      //M 本人（toolsFor 交回 undefined）：不拦。
      const role = workspaceModule.getRole(gate.session.row.address);
      const allowedTools = rules.toolsFor(role);
      if (allowedTools === undefined) return;

      //G 外人能用 workspace 工具，但只能看（list、get）；建、改名、归档只给本人。
      const action = textModule.getText(gate.call.arguments, 'action');
      const changesWorkspace = gate.call.name === 'workspace' && !rules.OTHERS_WORKSPACE_ACTIONS.has(action);
      if (changesWorkspace) {
        gate.deny = `这一轮说话的不是用户本人：workspace 只能 list、get 看自己的工作区，${action} 只有本人能用`;
        return;
      }

      //M 这一档有的工具：放行。
      if (allowedTools.has(gate.call.name)) return;

      //G 这一档没有的：builder 和 guest 各说一句为什么。
      if (role === 'builder') {
        gate.deny = '这一轮说话的人只能在他自己的目录里读写、跑命令、发文件，这个工具不给';
        return;
      }
      gate.deny = '这一轮说话的不是用户本人，只能用查、读、搜、答这类工具';
    });
  }

  /**
   * 审一条命令：规则 → 决策模型 → 审核小会话 → 问用户。不抛错：决策模型、小会话出错或答得不对都当“拿不准”，往下一档。
   * @param input 命令、目录、机器人、会话、提的人、payload、问不问用户、停止信号。
   * @returns 放行、拒绝，或者已经去问用户了。
   * 副作用：可能开一场审核小会话（调模型）；可能登记一件待确认。
   */
  async review(input: ReviewInput): Promise<Verdict> {
    const { command, cwd } = input;

    //M 第一档：程序规则。碰了密钥文件直接拒绝；项目自己的检查直接放行。
    const secret = rules.touchesSecret(command);
    if (secret !== undefined) {
      const reason = `不准执行：命令碰了密钥文件 ${secret}。要能力就用现成的工具；没有合适的，用 note_claude 找 Claude 加`;
      return this.traced(input, { result: 'reject', by: 'rule', reason });
    }
    //G builder 的目录里 package.json 是他自己写的，“项目自己的检查”可能是任意命令，不直接放行。
    if (input.confined === undefined && rules.isProjectCheck(command)) {
      return this.traced(input, { result: 'pass', by: 'rule', reason: '项目自己的检查，直接执行' });
    }

    //G 删系统级文件或目录、删注册表、删数据、格式化（Rules.ts mustAsk，范围故意很小）：不看可信目录、不问决策模型、不让审核小会话放行，直接问用户。
    const danger = rules.mustAsk(command, this.ctx.resources.root, cwd);

    //M 每一档没放行的原因，照先后记下（用户 11-18 #172）：最后要问用户时，卡片的“为什么问你”就写这些，不写空话。
    const asks: string[] = [];
    if (danger !== undefined) {
      asks.push(danger);
    }

    //M 可信目录（用户 11-18 #169）：配置的 trusted_dirs，加上这场会话的授权目录（本人、中控发消息时带的 grants.dirs）。
    //M   执行目录和命令里写的路径都落在这些目录里，程序规则直接放行，不再问模型、不弹卡片；不在的记下是哪个路径。
    //G builder 让跑的（confined）不算：他只能在自己的目录里动，由审核照目录约束把关。
    if (danger === undefined && input.confined === undefined) {
      const grantDirs = this.getGrantDirs(input.session);
      const trustedDirs = [...this.config.trustedDirs, ...grantDirs];
      const untrusted = rules.getUntrusted(command, cwd, trustedDirs);
      if (untrusted === undefined) return this.traced(input, { result: 'pass', by: 'rule', reason: '可信目录' });

      asks.push(untrusted);
    }

    //M 准备给后面几档看的材料：要跑的脚本内容、记在哪个机器人名下、命令现状。
    const script = rules.readScript(command, cwd);
    const bot = input.bot ?? this.ctx.bots.list()[0]?.name ?? '';
    const state: Record<string, unknown> = { 命令: command, 执行目录: cwd };
    if (script !== undefined) Object.assign(state, { 要跑的脚本: script.file, 脚本内容: script.content });
    if (input.session !== undefined) state['哪场会话'] = input.session;
    if (input.confined !== undefined) state['约束'] = confinedRule(input.confined);
    let last: { by: ReviewBy; reason: string } = { by: 'rule', reason: danger ?? '规则定不了' };

    //M 第二档：决策模型（只用来放行只读、低风险的）。必须人审的那一小块不问它。
    if (danger === undefined) {
      const judged = await this.askDecision(input, bot, state);
      if (judged.verdict === 'allow') return this.traced(input, { result: 'pass', by: 'decision', reason: `决策模型认为安全：${judged.reason}` });
      if (judged.verdict === 'deny') return this.traced(input, { result: 'reject', by: 'decision', reason: judged.reason });

      //M 拿不准：决策模型真答过（不是没挂、超时、出错的退回）才记成这一档的原因，否则保留“规则定不了”。
      if (judged.requestId !== '') {
        last = { by: 'decision', reason: judged.reason };
        asks.push(`决策模型拿不准：${judged.reason}`);
      }
    }

    //M 第三档：开一场不带工具的审核小会话，让模型看一眼，要它只回一段 JSON。
    const why = this.getWhy(input.session);
    const answer = await this.askModel(input, bot, script, why);
    if (answer?.['safe'] === true && danger === undefined) {
      let what = '（没写）';
      if (typeof answer['what'] === 'string') {
        what = answer['what'];
      }
      //M 审核小会话确认安全且不属于必问高危项，记跟踪并直接放行。
      return this.traced(input, { result: 'pass', by: 'review', reason: `模型看过，能直接执行：${what}` });
    }

    //M 审核小会话没放行：它写的理由原文记下（没写、只写“无”的记“审核没给出理由”），拒绝和卡片都用它。
    const reviewReason = getReviewReason(answer);
    if (answer !== undefined && danger === undefined) {
      last = { by: 'review', reason: reviewReason };
    }
    if (danger === undefined) {
      asks.push(`审核小会话：${reviewReason}`);
    }

    //G 调用方说了不问用户 → 直接拒绝（0.4 原话：ExecReview.ts:279）。
    if (input.ask === false) {
      return this.traced(input, { result: 'reject', by: last.by, reason: `没放行：${last.reason}。要用户拍板就带上 ask_user 再发一次。` });
    }

    //G builder 的命令审不过直接拒：登记了待确认，发起人自己就能说“同意 N”（allowed 认 actor），等于自己批自己。
    if (input.confined !== undefined) {
      return this.traced(input, { result: 'reject', by: last.by, reason: `没放行：${last.reason}。只能在 ${input.confined} 里动，别的要用户本人来说。` });
    }

    //M 第四档：照审核模型写的内容拼一张卡片，登记待确认，问用户。不等用户：马上交回“已经去问了”，用户定了由 approval/decided 通知提的人。
    const card = reviewCard(input, script, answer, why, asks);
    const detail = cardUtils.getCardText({ ...card, state: 'waiting' });
    const pending = this.ask({ kind: input.kind, title: card.title, detail, payload: input.payload, bot, session: input.session, card });
    return this.traced(input, { result: 'asked', id: pending.id, reason: `等用户决定（待确认 #${String(pending.id)}）` });
  }

  /**
   * 第二档：问决策模型这条命令安不安全。发请求事件 decision/judge（契约 3.2 第 2 条），等 decision/judge-result。
   * 没挂 decision、超过 20 秒、提问的会话喊停、decision 出错，都退回拿不准（getUnsure，requestId 是空串），往下一档。
   * @param input 审核的输入（kind、停止信号）。
   * @param bot 对话模型的小会话记在哪个机器人名下。
   * @param state 给模型看的现状：命令、目录、脚本、会话、约束。
   * @returns 决策模型的结论；退回的 requestId 是空串。
   */
  private async askDecision(input: ReviewInput, bot: string, state: Record<string, unknown>): Promise<DecisionReply> {
    const judgeInput = {
      kind: input.kind,
      bot,
      allowAt: this.config.decisionPass,
      question: SAFE,
      state,
    };
    const options = {
      prefix: 'dec',
      timeoutMs: DECISION_WAIT_MS,
      signal: input.signal,
      onFallback: getUnsure,
    };

    //M 发 decision/judge 等回执；提问的会话被喊停，这次等待跟着结束。
    return await requestEventModule.requestEvent(this.ctx, 'decision/judge', 'decision/judge-result', judgeInput, options);
  }

  /**
   * 第三档：开一场审核小会话。命令放第一行（假模型回的是话的前 40 字，离线测“放行”靠它）。
   * @param input 审核的输入。
   * @param bot 记在哪个机器人名下。
   * @param script 要跑的脚本，可能没有。
   * @param why 机器人在干的活（getWhy 取的会话最后一句用户的话），可能是空串。
   * @returns 模型回的 JSON；没做完、不是 JSON 都是 undefined（当拿不准）。
   */
  private async askModel(input: ReviewInput, bot: string, script: ReturnType<typeof rules.readScript>, why: string): Promise<Record<string, unknown> | undefined> {
    //M 拼审核小会话要看的话：命令、目录、约束、脚本内容、机器人在干的活，最后叮嘱只回 JSON。
    const config = this.config;
    const lines = [`命令：${input.command}`, `执行目录：${input.cwd}`];
    if (input.confined !== undefined) lines.push(confinedRule(input.confined));
    if (script !== undefined) lines.push(`要跑的脚本：${script.file}（前 4000 字）\n${script.content}`);
    if (why !== '') lines.push(`机器人在干的活：${why}`);
    lines.push('只回一段 JSON：{"safe": ..., "title": "...", "reason": "...", "what": "...", "paths": [...], "risk_level": "...", "risk": "...", "advice": "..."}。'
      + 'what、risk 要写具体的路径和操作，不许只写“有风险”。');

    //M 开审核小会话问一次；提问的会话被喊停，它也停（input.signal）。
    const askInput: SessionAskInput = {
      kind: REVIEW_KIND,
      bot,
      parent: input.session,
      model: config.model,
      thinking: config.thinking,
      text: lines.join('\n\n'),
      signal: input.signal,
    };

    //M 发出去等它答完：ok 是不是做完了，reply 是模型的原话。
    const { ok, reply } = await this.ctx.sessions.ask(askInput);

    //G 没做完（出错、停了）→ 当拿不准。
    if (!ok) return undefined;

    //M 从回答里掏出 {…} 这一段（模型可能在前后多写了别的字），解析成对象交回。
    const json =reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
    try {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;

      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 审核结论发一个跟踪点再交回。
   * @param input 审核的输入。
   * @param verdict 结论。
   */
  private traced(input: ReviewInput, verdict: Verdict): Verdict {
    //T 跟踪：审核结论。
    let decidedBy: string = 'user';
    if ('by' in verdict) {
      decidedBy = verdict.by;
    }
    const vars = { 命令: input.command.slice(0, 80), 结论: verdict.result, 谁定的: decidedBy, 原因: verdict.reason };
    this.ctx.emit('trace', 'Approval.review', '审完一条命令', 'approval.review(input)', vars);
    return verdict;
  }

  /**
   * 登记一件要用户点头的事。
   * @param input 谁提的、标题、细节、payload、机器人、会话。
   * @returns 新的待确认，state 是 waiting。
   * 副作用：写库；发 approval/asked；有会话就发 bot/say 告诉用户怎么回。
   */
  ask(input: AskInput): Pending {
    //M 拼卡片、查出发起人，把这件事存进表，再按自增号读回来。
    const card: cardUtils.CardData = { ...(input.card ?? plainCard(input.title, input.detail)), state: 'waiting' };
    const who = this.getInitiator(input.session);
    const sql = 'INSERT INTO approval_pending (kind, title, detail, payload, bot, session, customer, actor, state, asked_at, card) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const values = [input.kind, input.title, input.detail, JSON.stringify(input.payload ?? null), input.bot, input.session ?? null,
      who.customer, who.actor, 'waiting', Date.now(), JSON.stringify(card)];
    const done = this.ctx.resources.db.query(sql).run(...values);
    const pending = this.getRow(Number(done.lastInsertRowid)) as Pending;

    //T 跟踪：登记了一件待确认。
    const vars = { 号: pending.id, 谁提的: pending.kind, 机器人: pending.bot, 会话: pending.session ?? '（没有）' };
    this.ctx.emit('trace', 'Approval.ask', '登记一件待确认，告诉用户', "ctx.emit('approval/asked', pending)", vars);
    this.ctx.emit('approval/asked', pending);

    //G 飞书群里的会话不说细节和怎么回：群里谁都看得到、都能回，群里只由飞书卡片那块回一句“要本人确认”，卡片发本人私聊。
    let where: unknown;
    if (pending.session !== undefined) {
      where = this.ctx.sessions.find({ id: pending.session })[0]?.address;
    }
    //G 群聊会话不在群内发确认口令，直接返回登记结果。
    if (workspaceModule.isGroup(where)) return pending;

    //M 有会话就跟用户说一句怎么回（照 0.4：src/executors/ExecReview.ts:452-458）。
    if (pending.session !== undefined) {
      const id = String(pending.id);
      let how = `回复“同意 ${id}”或“拒绝 ${id}”。`;
      if (pending.card.kind === 'long-run') {
        how = `点卡片上的“终止”或“继续”；也可以回复“同意 ${id}”（终止）或“拒绝 ${id}”（继续）。不回就一直做下去。`;
      }
      //M 拼要跟用户说的话，找到这场会话，下面发给它。
      const text = `要确认一件事（待确认 #${id}）：${pending.title}\n${pending.detail}\n${how}`;
      const session = this.ctx.sessions.open(pending.session);

      //M 发通知 bot/say：bots 听它，按这场会话的渠道发出去（契约 #25，不直接调 bots.say）。
      this.ctx.emit('bot/say', session, text);
    }
    return pending;
  }

  /**
   * 定一件事。
   * @param id 待确认的号。
   * @param approve true 同意，false 拒绝。
   * @param by 谁定的。
   * @returns 定好的那件；找不到、已经定过的交回一句原因。
   * 副作用：改表；发 approval/decided。
   */
  decide(id: number, approve: boolean, by: string): Pending | string {
    //G 先按号找出这件待确认：找不到、已经定过的交回原因，不动表。
    const found = this.getRow(id);
    if (found === undefined) return `没有待确认 #${String(id)}`;

    if (found.state !== 'waiting') return `待确认 #${String(id)} 已经定过了（${STATE_TEXT[found.state]}）`;

    let nextState: 'approved' | 'rejected' = 'rejected';
    let action: 'approve' | 'reject' = 'reject';
    if (approve) {
      nextState = 'approved';
      action = 'approve';
    }
    //M 取出对应按钮文案落库并广播 approval/decided。
    return this.settle(found, nextState, by, `${cardLabel(found.card, action)}（${by}）`);
  }

  /**
   * 作废一件还在等的事：提的人自己不要了（比如长跑提醒的会话已经做完）。记成拒绝，卡片变灰写明原因。
   * @param id 待确认的号。
   * @param note 一句原因，如“会话已结束”。
   * @returns 作废后的那件；找不到、已经定过的交回一句原因。
   */
  close(id: number, note: string): Pending | string {
    //G 先按号找出这件待确认：找不到、已经定过的交回原因，不动表。
    const found = this.getRow(id);
    if (found === undefined) return `没有待确认 #${String(id)}`;
    if (found.state !== 'waiting') return `待确认 #${String(id)} 已经定过了（${STATE_TEXT[found.state]}）`;

    //M 作废：记成拒绝，卡片变灰、写明原因。
    return this.settle(found, 'rejected', note, note, 'ended');
  }

  /**
   * 改表、改卡片、发 approval/decided。
   * @param found 还在等的那件。
   * @param state 同意、拒绝。
   * @param by 谁定的。
   * @param result 卡片上写的结果。
   * @param cardState 卡片的状态；不给就跟着 state。
   */
  private settle(found: Pending, state: 'approved' | 'rejected', by: string, result: string, cardState?: cardUtils.CardState): Pending {
    //M 改表里的状态和卡片，再读回来给后面发通知用。
    const id = found.id;
    const at = Date.now();
    const card: cardUtils.CardData = { ...found.card, state: cardState ?? state, result: `${result}，${new Date(at).toLocaleString('zh-CN', { hour12: false })}` };
    const sql = 'UPDATE approval_pending SET state = ?, decided_by = ?, decided_at = ?, card = ? WHERE id = ?';
    this.ctx.resources.db.query(sql).run(state, by, at, JSON.stringify(card), id);
    const pending = this.getRow(id) as Pending;

    //T 跟踪：用户定了一件待确认。
    const vars = { 号: id, 结果: pending.state, 谁定的: by };
    this.ctx.emit('trace', 'Approval.decide', '定了一件待确认，通知提的人', "ctx.emit('approval/decided', pending)", vars);
    this.ctx.emit('approval/decided', pending);
    return pending;
  }

  /**
   * 最近定了的、卡片要变灰留着给人看的：长跑提醒（会话结束、点了继续或终止）10 分钟内的。网页审批面板用。
   * @returns 号从小到大。
   */
  recent(): Pending[] {
    //M 查 10 分钟内定了的，只留长跑提醒（网页上变灰留着给人看）。
    const since = Date.now() - RECENT_MS;
    const rows = this.ctx.resources.db.query("SELECT * FROM approval_pending WHERE state != 'waiting' AND decided_at >= ? ORDER BY id").all(since) as Row[];
    return rows.map(getPending).filter((item) => item.card.kind === 'long-run');
  }

  /**
   * 机器人在干什么活：会话最后一句用户的话（前 200 字），审核模型拿它写卡片的“原因”。
   * @param sessionId 提问的会话。
   */
  private getWhy(sessionId: string | undefined): string {
    //G 没有会话，就没有“在干的活”。
    if (sessionId === undefined) return '';

    //M 会话要还在；取出它最后一句用户的话。
    const meta = this.ctx.sessions.find({ id: sessionId })[0];
    if (meta === undefined) return '';
    const said = this.ctx.sessions.open(sessionId).row.messages.findLast((message) => message.role === 'user');
    if (said === undefined) return '';

    //M 把这句话的文字取出来，只要前 200 字，给审核模型写“原因”用。
    return piAi.contentText(said.content).slice(0, 200);
  }

  /** @returns 还在等的待确认，号从小到大。 */
  list(): Pending[] {
    //M 查还在等的，转成 Pending，号从小到大。
    const rows = this.ctx.resources.db.query("SELECT * FROM approval_pending WHERE state = 'waiting' ORDER BY id").all() as Row[];
    return rows.map(getPending);
  }

  /**
   * 响应 approval/request：按 action 调本服务现有的方法（review、ask、decide、close、list）。
   * @param request 别的插件用 requestEvent 发来的请求；清理类的 decide、close 不带 requestId，办完不回执。
   * @returns 回执正文：review 带 verdict，ask 带 pending，decide、close 带 settled 或 error，list 带 items。
   * @throws 现有方法抛的错原样抛，由 onRequestEvent 的 onError 转成 { error }。
   * 副作用：同各方法（开审核小会话、写库、发 approval/asked、approval/decided）；发一个跟踪点。
   */
  private async onRequest(request: ApprovalRequest): Promise<requestEventModule.StripResultId<ApprovalResult>> {
    //T 跟踪：别的插件经事件请审核办事。
    const vars = { 要做: request.action, 请求号: request.requestId ?? '（不等回执）' };
    this.ctx.emit('trace', 'Approval.onRequest', '别的插件经事件 approval/request 请审核办事', `approval/request（${request.action}）`, vars);

    //M review：审一条命令，可能要等审核小会话。
    if (request.action === 'review') {
      const verdict = await this.review(request.input);
      return { verdict };
    }

    //M ask：登记一件待确认。
    if (request.action === 'ask') {
      const pending = this.ask(request.input);
      return { pending };
    }

    //M decide：定一件事；找不到、定过了写进 error。
    if (request.action === 'decide') {
      const decided = this.decide(request.id, request.approve, request.by);
      return getSettled(decided);
    }

    //M close：作废一件还在等的事；找不到、定过了写进 error。
    if (request.action === 'close') {
      const closed = this.close(request.id, request.note);
      return getSettled(closed);
    }

    //M list：还在等的，照给了的 kind、bot 筛。
    const { kind, bot } = request;
    const items = this.list().filter((item) => {
      if (kind !== undefined && item.kind !== kind) return false;
      if (bot !== undefined && item.bot !== bot) return false;

      return true;
    });
    return { items };
  }

  /**
   * 这场会话带的授权目录（用户 11-18 #169）：本人、中控发消息时在消息里写 grants.dirs（POST /api/message 在入口 Checks.ts 的 checkGrants 查过、规范化过），
   * 渠道把它写进回话地址，会话记着这个地址（bots.route），交办出去的后台会话也带着同一个地址。
   * 地址跟着最后一句带渠道的话换：后来的消息没带 grants，授权就没了。
   * @param sessionId 提问的会话；命令窗口没有。
   * @returns 授权目录；没有会话、地址不是本人的（owner 不是 true）、没带 grants 都是空数组。
   */
  private getGrantDirs(sessionId: string | undefined): string[] {
    if (sessionId === undefined) return [];

    //G 只认本人的地址：外人（builder、guest）那一轮不给授权，哪怕地址里有这一项。
    const address = this.ctx.sessions.find({ id: sessionId })[0]?.address;
    if (!isOwner(address)) return [];

    //M 地址里的 grants.dirs 是入口规范化过的绝对路径，直接用。
    const grants = textModule.getField(address, 'grants');
    const dirs = textModule.getField(grants, 'dirs');
    if (!Array.isArray(dirs)) return [];

    return dirs as string[];
  }

  /**
   * 认文字回答（bot/receive，兼容未迁移渠道与离线测试）。如果该消息已经由 channel/message 入口转来则跳过，免得 N 机器人重复执行。
   * 无权的人（微信客户、飞书群里的其他人）同样的话当普通消息交给前台；不靠前面有没有分好会话。
   * @param event 收到的消息。
   */
  private onReceive(event: ReceiveEvent): void {
    if (event.fromChannelEvent === true) return;
    if (event.handled === true) return;

    //M 先认认是不是“同意 3”“待确认有哪些”这类话；不是就放过，照常交给前台。
    const said = rules.parseReply(event.message.text);
    if (said === undefined) return;

    //M 查说话人是谁、是不是本人，再列出这个机器人名下他能处理的待确认。
    const bot = event.bot.name;
    const speaker = getSpeaker(event.message.channel, event.message.address);
    const owner = isOwner(event.message.address);
    const waiting = this.list().filter((item) => item.bot === bot && allowed(item, speaker, owner));
    const listText = (items: Pending[]): string => items.map((item) => `#${String(item.id)}：${item.title}`).join('\n');

    //M “待确认有哪些”：只列当事人自己能看的项；一件都没有就当普通消息交给前台，不回“现在没有”，免得泄露这是一条审核指令。
    if ('list' in said) {
      if (waiting.length === 0) return;
      event.handled = true;
      this.answer(bot, waiting[0], `${listText(waiting)}\n回复“同意 号”或“拒绝 号”。`);
      return;
    }

    //M 没点号只算卡着会话的（0.4：BotLoop.ts:686-688）；点的号不在自己能处理的里面、或者没有候选 → 不算回答，照常进前台。
    //G 长跑提醒（同意 = 终止）不认没点号的“同意”：免得随口一句“同意”把会话停了。
    let candidates = waiting;
    if (said.id === undefined) {
      candidates = waiting.filter((item) => item.session !== undefined && item.card.kind !== 'long-run');
    }
    let named: Pending | undefined;
    if (said.id !== undefined) {
      named = candidates.find((item) => item.id === said.id);
    }
    if (candidates.length === 0 || (said.id !== undefined && named === undefined)) return;

    //M 这条话是在回答待确认，标记一下，前台不用再处理；再挑出要办的几条。
    event.handled = true;
    let targets: Pending[] = [];
    if (named !== undefined) {
      targets = [named];
    }
    if (named === undefined && (said.all === true || candidates.length === 1)) {
      targets = candidates;
    }

    //G 没点号、候选有好几条又没说“全部”：回一句让用户点明是哪一条，这次不办。
    if (targets.length === 0) {
      const text = `现在有 ${String(candidates.length)} 条，要说是哪一条：\n${listText(candidates)}\n回复“同意 号”“拒绝 号”或“全部同意”。`;
      this.answer(bot, candidates[0], text);
      return;
    }
    for (const item of targets) {
      //M 逐条把文字批复写入待确认记录并触发决断通知。
      this.decide(item.id, said.approve, `${event.message.channel} 文字回复`);
    }

    //M 把办了的号拼成一句话。
    const ids = targets.map((item) => `#${String(item.id)}`).join('、');
    let word = '已拒绝';
    if (said.approve) {
      word = '已同意';
    }
    //M 向会话回复本次文字批复的处理结果。
    this.answer(bot, targets[0], `${word}待确认 ${ids}。`);
  }

  /**
   * 响应 channel/message 消息级审批文本指令（如“同意 1”“拒绝 2”“全部同意”“待确认有哪些”）。
   * 一条消息只消费一次，防止 N 个目标机器人重复批准或答复多次。
   * @param message 标准渠道消息。
   * @param control 协调对象。
   */
  private async onChannelMessage(
    message: protocol.ChannelMessage,
    control?: protocol.ChannelMessageControl,
  ): Promise<void> {
    if (control?.approvalHandled === true) return;

    //M 先认认是不是“同意 3”“待确认有哪些”这类话；不是就放过，照常往下走。
    const said = rules.parseReply(message.text);
    if (said === undefined) return;

    //M 查说话人是谁、是不是本人，再列出目标机器人名下他能处理的待确认。
    const speaker = getSpeaker(message.channel, message.origin.address);
    const owner = message.role === 'owner' && isOwner(message.origin.address);
    const targetSet = new Set(message.targetBots);
    const waiting = this.list().filter((item) => targetSet.has(item.bot) && allowed(item, speaker, owner));
    const listText = (items: Pending[]): string => items.map((item) => `#${String(item.id)}：${item.title}`).join('\n');

    //M “待确认有哪些”：只列当事人自己能看的；一件都没有就放过，当普通消息。
    if ('list' in said) {
      if (waiting.length === 0) return;

      //M 标记这条消息已被审批指令消费，别的机器人不再答一遍；然后把清单回给当事人。
      if (control !== undefined) control.approvalHandled = true;
      await this.answerChannel(message, waiting[0], `${listText(waiting)}\n回复“同意 号”或“拒绝 号”。`);
      return;
    }

    //M 挑候选：没点号的只算卡着会话的（长跑提醒不算，免得随口一句“同意”把会话停了）；点了号的要在候选里。
    let candidates = waiting;
    if (said.id === undefined) {
      candidates = waiting.filter((item) => item.session !== undefined && item.card.kind !== 'long-run');
    }
    let named: Pending | undefined;
    if (said.id !== undefined) {
      named = candidates.find((item) => item.id === said.id);
    }
    if (candidates.length === 0 || (said.id !== undefined && named === undefined)) return;

    //M 这条话是在回答待确认，标记已消费；再挑出要办的几条。
    if (control !== undefined) control.approvalHandled = true;
    let targets: Pending[] = [];
    if (named !== undefined) {
      targets = [named];
    }
    if (named === undefined && (said.all === true || candidates.length === 1)) {
      targets = candidates;
    }

    //G 没点号、候选有好几条又没说“全部”：回一句让用户点明是哪一条，这次不办。
    if (targets.length === 0) {
      const text = `现在有 ${String(candidates.length)} 条，要说是哪一条：\n${listText(candidates)}\n回复“同意 号”“拒绝 号”或“全部同意”。`;
      await this.answerChannel(message, candidates[0], text);
      return;
    }

    //M 逐条把文字批复写入待确认记录并触发决断通知。
    for (const item of targets) {
      this.decide(item.id, said.approve, `${message.channel} 文字回复`);
    }

    //M 把办了的号拼成一句话。
    const ids = targets.map((item) => `#${String(item.id)}`).join('、');
    let word = '已拒绝';
    if (said.approve) {
      word = '已同意';
    }

    //M 回用户处理结果。
    await this.answerChannel(message, targets[0], `${word}待确认 ${ids}。`);
  }

  /**
   * 经统一渠道事件 channel/reply 回复消息级审批确认文本（无会话时仅发跟踪点）。
   * @param message 原标准消息。
   * @param about 命中的待确认项。
   * @param text 回复正文。
   */
  private async answerChannel(
    message: protocol.ChannelMessage,
    about: Pending | undefined,
    text: string,
  ): Promise<void> {
    const bot = about?.bot ?? message.targetBots[0] ?? '';
    if (bot === '') return;

    //M 算回复请求的几个键，再把原消息的来源拷成快照：渠道插件靠它们配对、去重、找回原聊天。
    const claimKey = protocol.getClaimKey(message.messageId, bot);
    const replyRoundKey = protocol.getReplyRoundKey(message.messageId, bot, 'approval');
    const replyRequestKey = protocol.getReplyRequestKey(replyRoundKey, `approval_${String(Date.now())}`);
    const snapshot: protocol.SourceSnapshot = {
      messageId: message.messageId,
      nativeId: message.nativeId,
      channel: message.channel,
      accountId: message.accountId,
      chatId: message.chatId,
      chatType: message.chatType,
      senderId: message.sender.id,
      role: message.role,
      targetBots: [...message.targetBots],
      mentions: structuredClone(message.mentions),
      origin: { channel: message.origin.channel, address: structuredClone(message.origin.address) },
      visibility: structuredClone(message.visibility),
      botName: bot,
      claimKey,
      replyRoundKey,
    };
    if (message.sender.name !== undefined) {
      snapshot.senderName = message.sender.name;
    }
    //M 把正文包成一段文字，经 channel/reply 请求发回原聊天。
    const parts: protocol.ReplyPartInput[] = [{ partId: 'text:0', kind: 'text', text }];
    await protocol.requestChannelReply(this.ctx, {
      channel: message.channel,
      bot,
      replyRequestKey,
      replyRoundKey,
      replyIndex: 0,
      kind: 'final',
      mode: 'text',
      sourceSnapshot: snapshot,
      payloadHash: protocol.getPayloadHash({ kind: 'final', mode: 'text', parts }),
      parts,
    });
  }

  /**
   * 从发起会话上抄客户号和个人身份，登记时写进待确认。
   * @param sessionId 提问的会话；没有就是空的。
   */
  private getInitiator(sessionId: string | undefined): { customer: string | null; actor: string | null } {
    //G 没有会话，就没有客户号和个人身份。
    if (sessionId === undefined) return { customer: null, actor: null };

    //M 找到会话（找不到就打开读），从渠道和回话地址取出说话人；会话上写了 customer 的以它为准。
    const found = this.ctx.sessions.find({ id: sessionId })[0];
    const row = found ?? this.ctx.sessions.open(sessionId).row;
    const meta = row as { customer?: string; channel?: string; address?: unknown };
    const speaker = getSpeaker(meta.channel, meta.address);
    let customer = speaker.customer;
    if (typeof meta.customer === 'string' && meta.customer !== '') {
      customer = meta.customer;
    }
    let outCustomer: string | null = null;
    if (customer !== '') {
      outCustomer = customer;
    }
    let outActor: string | null = null;
    if (speaker.actor !== '') {
      outActor = speaker.actor;
    }
    return { customer: outCustomer, actor: outActor };
  }

  /**
   * 回用户一句：回给那件事的会话；没有会话的回给这个机器人的前台会话；都没有就只发跟踪点。
   * @param bot 机器人名。
   * @param about 说的是哪一件（可能没有）。
   * @param text 回的话。
   */
  private answer(bot: string, about: Pending | undefined, text: string): void {
    //M 找要回的会话：那件事自己的会话；没有就用这个机器人的前台会话。
    const sessionId = about?.session ?? this.ctx.sessions.find({ bot, kind: 'front' })[0]?.id;
    if (sessionId !== undefined) {
      const session = this.ctx.sessions.open(sessionId);

      //M 发通知 bot/say：bots 听它，按这场会话的渠道发出去（契约 #26，不直接调 bots.say）。
      this.ctx.emit('bot/say', session, text);
      return;
    }
    //T 跟踪：没有会话可回。
    this.ctx.emit('trace', 'Approval.answer', '没有会话可回，这句只记在跟踪里', "ctx.emit('bot/say')", { 机器人: bot, 话: text });
  }

  /**
   * 读一行转成 Pending。
   * @param id 号。
   * @returns 没有是 undefined。
   */
  private getRow(id: number): Pending | undefined {
    //M 按号读表里的一行，没有就是 undefined。
    const row = this.ctx.resources.db.query('SELECT * FROM approval_pending WHERE id = ?').get(id) as Row | null;
    if (row === null) return undefined;

    //M 把数据库原始行解出 JSON 字段还原为 Pending。
    return getPending(row);
  }
}


/**
 * 没给卡片时拼一张普通的：标题、细节，“同意”“拒绝”两个按钮。
 * @param title 标题。
 * @param detail 细节。
 */
function plainCard(title: string, detail: string): Omit<cardUtils.CardData, 'state'> {
  //M 有细节就放一行“细节”；按钮固定是“同意”“拒绝”两个。
  const items: cardUtils.CardItem[] = [];
  if (detail !== '') {
    items.push({ label: '细节', value: detail });
  }
  return {
    kind: 'approval', title, reason: '', items,
    buttons: [{ action: 'approve', label: '同意', style: 'primary' }, { action: 'reject', label: '拒绝', style: 'default' }],
  };
}

/**
 * decide、close 的结果转成回执正文：定好了带 settled，找不到、定过了带 error。
 * @param result decide、close 交回的：定好的那件，或一句原因。
 */
function getSettled(result: Pending | string): requestEventModule.StripResultId<ApprovalResult> {
  if (typeof result === 'string') return { error: result };

  return { settled: result };
}

/**
 * 问决策模型没回（没挂 decision、超时、停了、出错）时的退回：当拿不准，requestId 留空串让 review 认出是退回的。
 * 写明返回类型，交给 requestEvent 的 onFallback。
 * @param reason requestEvent 给的退回原因。
 * @param detail 出错时的原话。
 */
function getUnsure(reason: requestEventModule.FallbackReason, detail?: string): DecisionReply {
  let text = `决策模型没回（${reason}）`;
  if (detail !== undefined) {
    text = `决策模型出错：${detail}`;
  }
  return { requestId: '', verdict: 'unsure', reason: text };
}

/** 卡片上某个按钮的字，结果里用（“终止了”“同意执行”）。 */
function cardLabel(card: cardUtils.CardData, action: 'approve' | 'reject'): string {
  //M 取卡片上这个动作对应按钮的字；卡片上没有这个按钮，退回“已同意”“已拒绝”。
  const label = card.buttons.find((button) => button.action === action)?.label;
  if (label !== undefined) return `点了“${label}”`;

  if (action === 'approve') return '已同意';

  return '已拒绝';
}

/** 审批卡片“动哪些”最多列几个路径。 */
const CARD_PATHS_MAX = 5;

/** 审批卡片正文每行最多几个字（飞书卡片顶上那段一眼要看完）。 */
const CARD_LINE_MAX = 160;


/**
 * 审核小会话没放行的理由原文（用户 11-18 #172：卡片要说清为什么问你，不许空着）。
 * @param answer 审核模型的 JSON；没答上来是 undefined。
 * @returns 它写的 risk 原文；没答上来、没写、只写“无”的给一句固定的话。
 */
function getReviewReason(answer: Record<string, unknown> | undefined): string {
  if (answer === undefined) return '没答上来（出错、超时或回的不是 JSON）';

  //G 没写理由、或者不放行却写“无”：照实说没给，不留空。
  const risk = textModule.getText(answer, 'risk').trim();
  if (risk === '' || risk === '无') return '审核没给出理由';

  return risk;
}


/**
 * 卡片“动哪些”：命令里写的绝对路径在前，审核模型列的路径在后，去重后最多 CARD_PATHS_MAX 个；都没有就说在执行目录里。
 * @param input 审核的输入（命令、执行目录）。
 * @param modelPaths 审核模型 JSON 里的 paths。
 * @returns 一行文字。
 */
function getCardPaths(input: ReviewInput, modelPaths: string[]): string {
  //M 命令里解析出来的最可信，排前面；模型列的补在后面（相对路径的命令只有它能说出动哪里）。
  const commandPaths = rules.getAbsPaths(input.command);
  const all = [...new Set([...commandPaths, ...modelPaths])];
  if (all.length === 0) return `执行目录 ${input.cwd} 里的文件`;

  //M 超过 5 个只列前 5 个，后面说还有几个（详情里有全部）。
  const shown = all.slice(0, CARD_PATHS_MAX).join('、');
  if (all.length <= CARD_PATHS_MAX) return shown;

  return `${shown} 等 ${String(all.length)} 个`;
}


/**
 * 命令审批卡片（用户 11-18 #172：说清楚，别说空话）。正文（reason）三行，飞书卡片顶上、网页审批面板一眼看完：
 *   要做什么：审核模型写的人话（what），没写用它的标题，再没有用命令本身；
 *   动哪些：getCardPaths；
 *   为什么问你：review 里每一档没放行的原因（不在可信目录、决策模型拿不准、审核小会话的理由原文、必须人审的那一小块）。
 * 命令、目录、脚本、机器人在干的活、会动到的每个路径、审核建议放进详情；风险说明写具体理由，不单写“风险中”。
 * 风险高时“同意执行”用危险色；调用的工具数据和审核原话放进可展开的 details。
 * @param input 审核的输入。
 * @param script 要跑的脚本。
 * @param answer 审核模型的 JSON；没答上来是 undefined。
 * @param why 机器人在干的活（会话最后一句用户的话）。
 * @param asks review 里每一档没放行的原因，照先后。
 * @returns 还没定状态的卡片。
 */
function reviewCard(
  input: ReviewInput,
  script: ReturnType<typeof rules.readScript>,
  answer: Record<string, unknown> | undefined,
  why: string,
  asks: string[],
): Omit<cardUtils.CardData, 'state' | 'result'> {
  //M 取审核回答里某个字段的文字，没写、不是字符串就是空串。
  const text = (key: string): string => {
    const value = answer?.[key];
    if (typeof value === 'string') return value.trim();

    return '';
  };
  //M 把审核模型给出的风险等级归一为标准档位（未知值回落 medium）。
  const level = cardUtils.getRiskLevel(answer?.['risk_level']);
  const items: cardUtils.CardItem[] = [{ label: '命令', value: input.command, code: true }, { label: '目录', value: input.cwd, code: true }];
  if (script !== undefined) items.push({ label: '要跑的脚本', value: script.file, code: true });
  let paths: string[] = [];
  if (Array.isArray(answer?.['paths'])) {
    paths = (answer['paths'] as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  }

  //M 把会动到的文件、机器人在干的活、审核建议逐项放进详情。
  for (const file of paths) items.push({ label: '会动到', value: file, code: true });
  if (why !== '') items.push({ label: '机器人在干的活', value: why });
  if (text('advice') !== '') items.push({ label: '审核建议', value: text('advice') });
  let approveStyle: 'danger' | 'primary' = 'primary';
  if (level === 'high') {
    approveStyle = 'danger';
  }

  //M 正文第一行“要做什么”：审核写的人话，没写退回标题，再没有就写命令本身。
  const what = text('what') || text('title') || `执行命令 ${input.command}`;
  const whatLine = `要做什么：${textModule.clip(what, CARD_LINE_MAX)}`;

  //M 第二行“动哪些”：命令里的路径和审核列的路径。
  const pathsLine = `动哪些：${textModule.clip(getCardPaths(input, paths), CARD_LINE_MAX)}`;

  //M 第三行“为什么问你”：每一档没放行的原因；一条都没有（不该出现）就照实说。
  let askText = asks.join('；');
  if (askText === '') {
    askText = '前几档都没能放行';
  }
  const askLine = `为什么问你：${textModule.clip(askText, CARD_LINE_MAX)}`;

  //M 风险说明写具体理由：审核小会话的理由原文，没给就写“审核没给出理由”。
  const riskText = getReviewReason(answer);

  //M 拼卡片：标题、三行正文、风险、可展开的原始数据；风险高时“同意执行”用危险色。
  return {
    kind: 'approval',
    title: text('title') || '要执行一条命令',
    reason: [whatLine, pathsLine, askLine].join('\n'),
    items,
    risk: { level, text: riskText },
    details: { label: '调用的工具数据', data: { 工具: input.kind, 命令: input.command, 目录: input.cwd, 会话: input.session ?? null, 参数: input.payload, 审核原话: answer ?? null } },
    buttons: [
      { action: 'approve', label: '同意执行', style: approveStyle },
      { action: 'reject', label: '拒绝', style: 'default' },
    ],
  };
}



/**
 * 从渠道和回话地址取出说话人的客户号、个人身份。飞书按人（不用群号当个人），其余用地址里的 customer。
 * @param channel 渠道名。
 * @param address 渠道的回话地址。
 * @returns customer 客户号（地址里没写是空串）；actor 个人身份（飞书是 feishu:openId，其余同 customer）。
 */
export function getSpeaker(channel: string | undefined, address: unknown): { customer: string; actor: string } {
  let where: Record<string, unknown> = {};
  if (typeof address === 'object' && address !== null && !Array.isArray(address)) {
    where = address as Record<string, unknown>;
  }
  let customer = '';
  if (typeof where['customer'] === 'string') {
    customer = where['customer'];
  }
  if (channel === 'feishu') {
    const who = String(where['openId'] ?? where['open_id'] ?? '');
    if (who === '') return { customer, actor: customer };

    return { customer, actor: `feishu:${who}` };
  }
  return { customer, actor: customer };
}


/**
 * 是不是用户本人：只看渠道写在回话地址里的 owner。本人只在渠道那边判断一次（飞书照插件配置的 people），这里不另存名单。
 * @param address 渠道的回话地址。
 * @returns 写了 owner: true 才是。
 */
export function isOwner(address: unknown): boolean {
  //M 读回话地址里的 owner，只有明写 true 才是本人。
  return textModule.getField(address, 'owner') === true;
}


/**
 * 这个人能不能处理这件待确认：用户本人，或登记时的同一发起人。
 * 旧记录没有发起人身份的，只许用户本人处理，避免群里的人靠同一客户号误批。
 * 群里说的、群里提的，只认用户本人：群里的发起人不能自己批自己，绕过用户（2026-11-17，0.7.18）。
 * @param item 待确认。
 * @param speaker 说话人。
 * @param owner 是不是用户本人。
 * @returns 能处理是 true。
 */
export function allowed(item: Pending, speaker: { customer: string; actor: string }, owner: boolean): boolean {
  if (owner) return true;

  //G 说话人在群里，或这件是群里的会话提的 → 只认本人。
  if (workspaceModule.isGroup(speaker) || workspaceModule.isGroup(item)) return false;
  return item.actor !== undefined && item.actor !== '' && item.actor === speaker.actor;
}


/**
 * 表里一行转成 Pending（payload 解一次 JSON）。
 * @param row 表里的一行。
 */
function getPending(row: Row): Pending {
  //M 有落库的卡片 JSON 直接解析；旧记录为 null 时用标题与细节补默认卡。
  let card: cardUtils.CardData = { ...plainCard(row.title, row.detail), state: row.state };
  if (row.card !== null) {
    card = JSON.parse(row.card) as cardUtils.CardData;
  }
  const pending: Pending = {
    id: row.id, kind: row.kind, title: row.title, detail: row.detail, payload: JSON.parse(row.payload) as unknown,
    bot: row.bot, state: row.state, askedAt: row.asked_at,
    card,
  };
  if (row.session !== null) pending.session = row.session;
  if (row.customer !== null && row.customer !== '') pending.customer = row.customer;
  if (row.actor !== null && row.actor !== '') pending.actor = row.actor;
  if (row.decided_by !== null) pending.by = row.decided_by;
  if (row.decided_at !== null) pending.decidedAt = row.decided_at;
  return pending;
}


/**
 * 转成网页要的形状（照 0.4 的 PendingApproval，web/src/Types.ts:73-90）。
 * @param pending 一件待确认。
 */
function view(pending: Pending): Record<string, unknown> {
  let payload: Record<string, unknown> = {};
  if (typeof pending.payload === 'object' && pending.payload !== null) {
    payload = pending.payload as Record<string, unknown>;
  }
  let command = pending.title;
  if (typeof payload['command'] === 'string') {
    command = payload['command'];
  }
  let workDir = '';
  if (typeof payload['cwd'] === 'string') {
    workDir = payload['cwd'];
  }
  return {
    id: pending.id, bot: pending.bot, sessionId: pending.session ?? '', title: pending.title,
    command, workDir,
    review: { what: pending.detail, risk: '', advice: '' }, createdAt: pending.askedAt, card: pending.card,
  };
}


/**
 * 登记两条接口。
 * @param app http 的 Fastify 实例。
 * @param approval 服务。
 */
function routes(app: fastify.FastifyInstance, approval: Approval): void {
  //M 还在等的，加上最近定了的长跑提醒（卡片变灰）。网页照 card 画，card.state 不是 waiting 的不给按钮。
  app.get('/api/approvals', async () => [...approval.list(), ...approval.recent()].map(view));

  //M POST /api/approvals/:id：网页点同意、拒绝，body 里 approve 要是布尔值，不是的当场回 400。
  app.post<{ Params: { id: string }; Body: unknown }>('/api/approvals/:id', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body['approve'] !== 'boolean') return reply.code(400).send({ error: 'approve 要是 true 或 false' });

    //M 按号定这件事，记成“HTTP”定的；找不到、定过了回 404。
    const result = approval.decide(Number(request.params.id), body['approve'], 'HTTP');
    if (typeof result === 'string') return reply.code(404).send({ error: result });

    //M 把定好的那件转成网页要的形状交回。
    return { ok: true, approval: view(result) };
  });
}


/**
 * 挂上审核和待确认。
 * apply 是 Cordis 插件的入口：inject 里的 resources、bots、sessions 都就绪后 Cordis 调一次（详见 plugins/Index.ts）。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config plugins 段里写给它的：{ model?, thinking?, decision_pass?, trusted_dirs? }，在这里校验一次。
 * @throws 配置不对时抛错。
 */
export function apply(ctx: cordis.Context, config: unknown): void {
  //G 配置在这里校验一次：模型要写成“供应商名/模型 ID”，思考档、放行门槛也在下面查。
  const raw = (config ?? {}) as Record<string, unknown>;
  const model = raw['model'];
  if (model !== undefined && (typeof model !== 'string' || !model.includes('/'))) {
    throw new Error('approval.model 要写成“供应商名/模型 ID”');
  }

  //G 模型的供应商要在 providers 里。
  if (typeof model === 'string' && ctx.resources.config.providers[model.slice(0, model.indexOf('/'))] === undefined) {
    throw new Error(`approval.model 的供应商不在 providers 里：${model}`);
  }
  const thinking = raw['thinking'] ?? 'low';
  if (typeof thinking !== 'string') throw new Error('approval.thinking 要是思考档（off、low、medium、high……）');

  //G 决策模型只放行只读、低风险的命令，门槛至少 0.8（用户 11-14；原来默认 0.2，放行过 rd /s /q System32）。
  const pass = raw['decision_pass'] ?? DECISION_PASS;
  if (typeof pass !== 'number' || pass < DECISION_PASS || pass > 1) throw new Error(`approval.decision_pass 要是 ${String(DECISION_PASS)}～1 的数`);

  //M 可信目录（用户 11-18 #169）：绝对路径的数组，在 config.yaml 里配，代码不写死；这里规范化一次（解开 ..、Windows 上转小写）。
  const trustedDirs = checksModule.checkDirs(raw['trusted_dirs'], 'approval.trusted_dirs');

  const approvalConfig: ApprovalConfig = {
    model: model as string | undefined,
    thinking: thinking as Thinking,
    decisionPass: pass,
    trustedDirs,
  };

  //M 校验过的配置交给服务，建好后它自己登记成 ctx.approval、挂上各个监听。
  const approval = new Approval(ctx, approvalConfig);

  //M http 是可选的：ctx.inject(服务, 回调) 等于再挂一个小插件，http 在了才调回调、登记接口。
  void ctx.inject(['http'], (sub) => {
    routes(sub.http.app, approval);
  });
}
