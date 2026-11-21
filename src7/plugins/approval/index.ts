/**
 * 审核和待确认。
 *   review：审一条命令，按顺序检查：程序规则 → 决策模型（发 decision/judge，没挂 decision 当拿不准）→ 审核小会话（让模型看一眼）→ 问用户。
 *     程序规则里有可信目录（用户 11-18 #169）：执行目录和命令里写的路径都在 trusted_dirs 或这场会话的授权目录（回话地址的 grants.dirs）里，
 *     又不是删系统、删注册表、删数据、格式化（Rules.ts mustAsk）的，直接放行。
 *   ask：登记一件要用户点头的事（谁都能提），存表，发 approval/asked，有会话就发 bot/say 告诉用户怎么回。
 *   decide：用户定了，改表，发 approval/decided。谁提的谁听这个通知自己去做（exec、runs……），这里不执行任何东西。
 * 别的插件找本插件办事发请求事件 approval/request（review、ask、decide、close、list，契约 3.2 第 1 条），本插件回 approval/result。
 * 认文字回答：“同意 3”“拒绝”“全部同意”“待确认有哪些”，听 bot/receive。
 * 按说话人分档收工具（回话地址的 role，飞书照插件配置的 people 写）：guest 只给只读的（rules.READ_ONLY_TOOLS），
 * builder 再加在他自己目录里的 exec、write、edit、feishu_send_file（rules.BUILDER_TOOLS）；执行前再拦一次。
 * 目录授权（Grants.ts，用户 #301）：本人把人、群绑到目录，进来的话按人按群写进地址的 grants.dirs，外人升 builder；
 * 这些目录和子目录里的命令程序规则直接放行（getReviewDirs）；本人说的授权当轮就生效（before-model 补 applyTurn）。
 * builder 的命令审核照“只能在他的目录里动”把关，审不过直接拒、不问用户。
 * 自己核对说话人：只接受发起该项的同一人（登记时记下的 actor），或用户本人（回话地址里的 owner）；飞书群里说的、群里提的只认本人；
 * “待确认有哪些”只列当事人自己的项；其他人的同样文字当普通消息交给前台。正确性不依赖监听顺序。
 * 接口：GET /api/approvals、GET /api/approvals/overflow、POST /api/approvals/:id（有 http 才开）。
 * 不挡别的消息：review 只在提问的那场会话的工具里 await，别的会话、别的消息照常走；问用户时不等，马上交回“已经去问了”。
 * 设计见同目录 说明.md 的「设计要点」一节。
 */
import * as botUtils from '../../utils/Bots.ts';
import * as cordis from 'cordis';
import * as piAi from '@earendil-works/pi-ai';
import type * as fastify from 'fastify';
import type { AskInput as SessionAskInput, ChatRequest, Session, SessionMeta, Thinking } from '../../Sessions.ts';
import type { ToolGate } from '../../Tools.ts';
import type { ReceiveEvent } from '../bots/index.ts';
import * as protocol from '../channels/index.ts';
import * as rules from './Rules.ts';
import * as reviewCardModule from './ReviewCard.ts';
import * as outboundModule from './Outbound.ts';
import * as channelSend from './ChannelSend.ts';
import * as grantsModule from './Grants.ts';
import * as cardUtils from '../../utils/Card.ts';
import * as checksModule from '../../utils/Checks.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import * as workspaceModule from '../../utils/Workspace.ts';


/** 插件名。 */
export const name = 'approval';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.2.10：本人批准的主动发件改走 channel/reply（target 带确切地址：飞书应用号和聊天号，网页提醒带意图号），
//M   删 channel/send、channel/sent 和一次性批准凭证 takeChannelSendApproval；只给外置程序的发件补 channel/replied。
//M 1.2.11：认批复改听 channel/direct、channel/mention（channel/message 拆了；只听的 channel/listen 不看）；语音半句不认。
//M 1.2.12：目录授权向下延伸（Grants.ts，用户 #301）：按人、按群的授权目录，外人升 builder，本人说的当轮生效，工具 dir_grant、/api/grants；
//M   带授权目录的外人，命令出了执行目录和授权目录规则直接拒。
//M 1.2.13：本人、档位、群改问 channels 的 isOwnerTurn、getSpeakerRole、isGroup；isOwner 改名 isMarkedOwner（有意更严，判断不变）。
//M 1.2.14：工具档位说明里写明 feishu_recall（撤回机器人自己的消息）只有本人那一轮能用，两张外人表不加它；程序不变。
//M 1.2.15：每个入站事件只挂一个监听（先认批复、再过目录授权，先后写在代码里）；Grants 不再自己听；
//M   外人地址里原有的 grants 先删再查库，查库出错只打日志、这一轮当没有授权，不再挡 bots 认领（云端 19 第 3 条）。
//M 1.2.16：requestEvent 改新写法（云端 19 第 1、2 条）：本机的一问一答不掐表，问决策模型只报警（decision 自己限时）；
//M   Outbound 删掉一层层相加的等待常量，只留 programs 发 HTTP 用的两个。
//M 1.2.17：拼审批卡片的 plainCard、cardLabel、getReviewReason、getCardPaths、reviewCard 搬进 ReviewCard.ts（云端 20 第 3 条）；
//M   构造函数只做登记，监听干的活挪成方法 onCalled、onBeforeModel、onBeforeTool、getRequestError（第 2 条）。行为不变。
export const version = '1.2.19';

/** 决策模型放行的最低门槛，也是默认值。 */
export const DECISION_PASS = 0.8;

/** 问决策模型等这么久还没回就报警（decision 每个模型自己限时，到点回拿不准）。 */
const DECISION_WARN_MS = 20_000;

/** 用到的服务：resources 提供默认机器人，sessions 开审核小会话、找会话。decision 走事件、http 用 ctx.inject，都不写在这里（写进 inject 就成了“必须有”）。 */
export const inject = ['resources', 'sessions'];


declare module 'cordis' {
  interface Context {
    /** 审核和待确认服务，实现在 src7/plugins/approval/index.ts。 */
    approval: Approval;
  }
  interface Events {
    /**
     * 存完一件待确认的事（通知）。journal、feishu 听。
     * 谁发：src7/plugins/approval/index.ts 的 Approval.ask
     * 谁接：src7/plugins/base-bridge/Notify.ts 的 mountNotify；src7/plugins/feishu/cards/Cards.ts 的 setupApproval
     */
    'approval/asked'(pending: Pending): void;
    /**
     * 定完一件事（通知），state 已是 approved / rejected。提的人（exec……）听它去做，journal、feishu 也听。
     * 谁发：src7/plugins/approval/index.ts 的 Approval.settle
     * 谁接：
     *   src7/plugins/assist/Reminders.ts 的 Reminders.start
     *   src7/plugins/base-bridge/UpdateWatch.ts 的 mountUpdateWatch
     *   src7/plugins/exec/Runs.ts 的 Runs.constructor
     *   src7/plugins/exec/index.ts 的 Exec.constructor
     *   src7/plugins/feishu/cards/Cards.ts 的 setupApproval
     *   src7/plugins/progress/Review.ts 的 Review.constructor
     *   src7/plugins/progress/index.ts 的 Progress.constructor
     *   src7/plugins/wechat/index.ts 的 apply
     */
    'approval/decided'(pending: Pending): void;
    /**
     * 别的插件请审核办事（serial 发、等 approval/result，用 utils/RequestEvent.ts 的 requestEvent）。本插件听，按 action 调现有方法。
     * 谁发：
     *   src7/plugins/assist/Reminders.ts 的 Reminders.closeCard、Reminders.ensureCard、Reminders.getCard
     *   src7/plugins/base-bridge/UpdateWatch.ts 的 UpdateWatch.check
     *   src7/plugins/exec/Runs.ts 的 Runs.dismiss、requestReview
     *   src7/plugins/feishu/cards/Cards.ts 的 onAction
     *   src7/plugins/progress/Review.ts 的 Review.check
     *   src7/plugins/progress/index.ts 的 Progress.closeCard、Progress.sendCard
     *   src7/plugins/web-api/Views.ts 的 Views.botList
     * 谁接：src7/plugins/approval/index.ts 的 Approval.constructor
     */
    'approval/request'(request: ApprovalRequest): void | Promise<void>;
    /**
     * approval/request 的回执（emit），按 requestId 配对。
     * 谁发：src7/plugins/approval/index.ts 的 Approval.constructor
     * 谁接：
     *   src7/plugins/assist/Reminders.ts 的 Reminders.closeCard、Reminders.ensureCard、Reminders.getCard
     *   src7/plugins/base-bridge/UpdateWatch.ts 的 UpdateWatch.check
     *   src7/plugins/exec/Runs.ts 的 requestReview
     *   src7/plugins/feishu/cards/Cards.ts 的 onAction
     *   src7/plugins/progress/Review.ts 的 Review.check
     *   src7/plugins/progress/index.ts 的 Progress.sendCard
     *   src7/plugins/web-api/Views.ts 的 Views.botList
     */
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

/** 已识别的文字批复及应回到的待确认项。 */
interface TextAnswer {
  /** 回复对应的待确认项，用它定位原会话。 */
  about: Pending;
  /** 回给说话人的文字。 */
  text: string;
  /** 需要写入的批复，查清单和请用户选号时省略。 */
  decision?: {
    /** 本次要处理的待确认项。 */
    targets: Pending[];
    /** 同意为 true，拒绝为 false。 */
    approve: boolean;
  };
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
  /** 会话停止或 exec 结束等待时触发，终止这次审核。 */
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
 * review 要等审核小会话，input.signal 带会话停止和 exec 的等待时限。
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
  | {
    /** 查已有的定时提醒确认卡，供持久调度恢复。 */
    action: 'reminder-card';
    /** assist 的提醒记录号。 */
    reminderId: number;
    /** 该提醒的机器人。 */
    bot: string;
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


/** 供决策模型判断命令风险的是非题。 */
const SAFE = {
  instructions: '要执行这条命令。它安全吗——不会删改重要的文件、不会泄露密钥、不会影响系统和别的程序？可以直接执行，回答‘是’。',
  yes: '安全，可以直接执行',
  no: '有风险，要问用户',
};

/** 这一轮是 guest 说的：工具已经只剩只读的，这段告诉模型别答应做不了的事。 */
const GUEST_PROMPT = '这一轮说话的不是用户本人（比如群里用户的朋友）。你只能查、读、搜、回答；'
  + '跑命令、写文件、改代码、发文件、生图这类动手的事做不了，也不要答应，告诉对方要用户本人来说。'
  + '对方明确要到点提醒时，可以登记本聊天的提醒，等本人确认后才会发送。';


/**
 * 这一轮说话人的档位，给 rules.toolsFor 挑工具：地址写了 role 就用它；
 * 没写 role 又不是本人（isOwnerTurn：微信这类渠道不写 owner 就是外人）的当 guest；本人是 ''（不限）。
 * @param channel 会话现在的渠道（session.row.channel），内部小会话没有。
 * @param address 会话现在记的回话地址（session.row.address）。
 */
function getTurnRole(channel: string | undefined, address: unknown): string {
  //M 地址上已有档位（owner、builder、guest）：照它。
  const role = protocol.getSpeakerRole(address);
  if (role !== '') return role;

  //G 没档位又不是本人：当 guest，只给只读工具。
  if (!protocol.isOwnerTurn(channel, address)) return 'guest';

  return '';
}


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
 * 这一轮有授权目录时加的一句（用户 #301“目录授权向下延伸”）。
 * @param dirs 授权目录（回话地址的 grants.dirs）。
 * @returns 提示词。
 */
function grantPrompt(dirs: string[]): string {
  return `这一轮的授权目录：${dirs.join('、')}。这些目录和下面的子目录里读写文件、跑命令、发文件都不用再问用户：`
    + '跑命令时先 cd 到那个目录（写成“cd /d 目录 && 命令”），命令里写的路径也都在这些目录里，就直接执行；'
    + '出了这些目录照旧。在群里回话只说文件名或相对路径，不说本机的绝对路径。';
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
  + '- what：写命令执行完的结果，不要复述命令：对哪些文件做了什么、最后变成什么样，带上关键的路径，'
  + '比如“把 src 整个复制到 zlt\\code，同名文件直接覆盖”“把 X 编译成 Y.exe 放到 Z”“删掉 A 目录下 3 个文件”。'
  + '看不出会做成什么就不写 what，别编。\n'
  + '- risk：safe 是 false 时，写清是哪个路径、哪种操作（删除、覆盖、改设置、装软件、往外发……）、会有什么后果，'
  + '比如“会覆盖 zlt\\code 里的同名文件，那边没提交的改动会丢”。不许只写“有风险”“风险中”“可能有影响”这种空话；'
  + 'safe 是 true 时写“无”。\n\n'
  + '只回一个 JSON，不要别的文字：\n'
  + '{"safe": true 或 false, "title": "大白话：要做什么，20 字以内", "reason": "为什么要做（机器人在干什么活）", '
  + '"what": "这条命令具体对哪些文件做什么（一两句，带路径）", "paths": ["会动到的文件或目录，没有就空数组"], '
  + '"risk_level": "low、medium 或 high", "risk": "具体的理由：哪个路径、哪种操作、什么后果；安全就写“无”", "advice": "建议同意还是拒绝，为什么"}';

/** 审核小会话的种类：不叫 review，免得和复盘插件 review 混。 */
const REVIEW_KIND = 'exec-review';

/** 请求方的审核等待截止时，用于回执和卡片作废原因。 */
const REVIEW_TIMED_OUT = '命令审核已超时';

/** 定了的长跑提醒卡片在网页上留多久（变灰）。 */
const RECENT_MS = 10 * 60_000;
/** 网页每轮最多带回这么多条待审核。 */
const WEB_WAITING_LIMIT = 200;

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
  /** 目录授权（Grants.ts，用户 #301）：按人、按群的授权目录，进来的话写进地址，本人说的当轮授权。 */
  readonly grants: grantsModule.Grants;

  /**
   * 登记成 ctx.approval（cordis.Service 的构造函数做的：super(ctx, '名字') 就是“把我挂到 ctx 上叫这个名字”），
   * 建表，挂监听；构造函数只做登记，每个监听干的活在对应的方法里：
   *   approval/request（别的插件请审核办事）→ onRequest，出错转回执 → getRequestError；
   *   channel/direct、channel/mention（先认批复，再过目录授权）→ onCalled；channel/listen（只过目录授权）→ Grants.applyMessage；
   *   bot/receive（认文字回答）→ onReceive；
   *   session/before-model（给审核小会话加提示词；补当轮授权、说授权目录；guest、builder 说的这一轮只给这一档的工具）→ onBeforeModel；
   *   session/before-tool（这一档没有的工具不让执行）→ onBeforeTool。目录授权的表由 Grants 自己建。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param config 校验后的配置。
   */
  constructor(ctx: cordis.Context, private readonly config: ApprovalConfig) {
    //M 先把本服务登记成 ctx.approval。
    super(ctx, 'approval');

    //M 目录授权：建表；进来的话由下面的入站监听调 applyMessage。
    this.grants = new grantsModule.Grants(ctx);

    //M 建待确认表（没有才建）。
    ctx.resources.db.exec('CREATE TABLE IF NOT EXISTS approval_pending (id INTEGER PRIMARY KEY AUTOINCREMENT,'
      + ' kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, payload TEXT NOT NULL, bot TEXT NOT NULL,'
      + ' session TEXT, state TEXT NOT NULL, decided_by TEXT, asked_at INTEGER NOT NULL, decided_at INTEGER,'
      + ' card TEXT, customer TEXT, actor TEXT)');

    //M 别的插件请审核办事走请求事件 approval/request（契约 3.2 第 1 条）：onRequest 按 action 调现有方法，办完回 approval/result。
    //M   现有方法抛的错由 getRequestError 转成 { error }，调用方不干等超时；review 没带回 verdict，exec 照“没有审核就不让跑命令”当拒绝。
    const requestOptions = {
      onError: (error: unknown) => this.getRequestError(error),
    };

    //M 登记请求监听：别的插件发 approval/request，本插件按 action 办，办完回 approval/result。
    requestEventModule.onRequestEvent(
      ctx,
      'approval/request',
      'approval/result',
      (request) => this.onRequest(request),
      requestOptions,
    );

    //M 进来的话：每个事件只挂一个监听，先后写在 onCalled 里，不靠挂载顺序（prepend：都在 bots 认领、抄地址之前）。
    //M   私聊、群里叫了机器人：先认批复，再过目录授权。
    ctx.on('channel/direct', (message, control) => this.onCalled(message, control), { prepend: true });
    ctx.on('channel/mention', (message, control) => this.onCalled(message, control), { prepend: true });

    //M 只听的话：没叫机器人，不认批复，只过目录授权（前台判断接了以后也照这个地址干活）。
    ctx.on('channel/listen', (message) => {
      this.grants.applyMessage(message);
    }, { prepend: true });

    //M 仍排在前面，只是为了先认出“同意 3”这类话；批不批准由 onReceive 自己核对说话人，不靠监听顺序，也不看前面有没有分好会话。
    ctx.on('bot/receive', (event) => {
      this.onReceive(event);
    }, { prepend: true });

    //M 调模型之前：审核小会话的提示词、当轮授权、guest 和 builder 只留这一档的工具（onBeforeModel）。
    ctx.on('session/before-model', (request) => {
      this.onBeforeModel(request);
    });

    //M 执行工具之前：会话转到一半换了说话人时，按现在的说话人再拦一次（onBeforeTool）。
    ctx.on('session/before-tool', (gate) => {
      this.onBeforeTool(gate);
    });
  }

  /**
   * approval/request 办的时候抛了错：转成回执的 { error }，调用方不干等超时。
   * 由构造函数里 onRequestEvent 的 onError 调。
   * @param error onRequest 抛出的错。
   * @returns 带原话的回执正文。
   */
  private getRequestError(error: unknown): requestEventModule.StripResultId<ApprovalResult> {
    const message = textModule.getErrorMessage(error);
    return { error: message };
  }

  /**
   * channel/direct、channel/mention 的监听（构造函数里挂，prepend）：先认批复，再过目录授权。
   * 先认批复（“同意 3”，消息级只消费一次，N 个机器人共存时不会各自批准一遍），
   * 再过目录授权（Grants.applyMessage 改地址，bots 认领时照抄；它不往外抛）。
   * @param message 标准渠道消息。
   * @param control 协调对象。
   */
  private async onCalled(
    message: protocol.ChannelMessage,
    control?: protocol.ChannelMessageControl,
  ): Promise<void> {
    await this.onChannelMessage(message, control);
    this.grants.applyMessage(message);
  }

  /**
   * session/before-model 的监听（构造函数里挂）。
   * 审核小会话的提示词：prompt 插件只认 front、work，这种会话的提示词由这里给。
   * 这一轮说话的是 guest、builder（渠道在回话地址里写的 role）：只留这一档的工具（rules.toolsFor），
   *   别的直接从这一步的工具里拿掉，再在提示词里说一句，免得模型答应做不了的事。
   * @param request 这一步要发给模型的请求：改 system、tools。
   */
  private onBeforeModel(request: ChatRequest): void {
    if (request.session.row.kind === REVIEW_KIND) {
      request.system.push(REVIEW_PROMPT);
    }

    //M 本人这一轮说的当轮授权：前台接下来的每一步、这一轮交办的后台都补进地址（Grants.applyTurn）。
    this.grants.applyTurn(request.session);
    const address = request.session.row.address;

    //M 这一轮有授权目录：告诉模型哪些目录能直接动、命令先 cd 过去（本人、外人都说）。
    const grantDirs = workspaceModule.getGrantDirs(address);
    if (grantDirs.length > 0) {
      const promptText = grantPrompt(grantDirs);
      request.system.push(promptText);
    }

    const role = getTurnRole(request.session.row.channel, address);
    const allowedTools = rules.toolsFor(role);
    if (allowedTools === undefined) return;

    //M 这一档没有的工具，从这一步的工具里拿掉。
    request.tools = request.tools.filter((tool) => allowedTools.has(tool.name));
    let prompt = GUEST_PROMPT;
    if (role === 'builder') {
      //M builder 提示词写明他被限制在哪个子工作区。
      prompt = builderPrompt(utils.getStringField(address, 'workspace'));
    }

    //M 把这一档的提示词加进系统提示词，告诉模型别答应做不了的事。
    request.system.push(prompt);
  }

  /**
   * session/before-tool 的监听（构造函数里挂）。兜底：工具清单是这一步开头定的，
   * 会话转到一半换了说话人（群里别人插话）时，执行前再按现在的说话人拦一次。
   * @param gate 要执行的工具调用：不让执行就写 deny。
   */
  private onBeforeTool(gate: ToolGate): void {
    if (gate.deny !== undefined) return;

    //M 本人（toolsFor 交回 undefined）：不拦。
    const role = getTurnRole(gate.session.row.channel, gate.session.row.address);
    const allowedTools = rules.toolsFor(role);
    if (allowedTools === undefined) return;

    //G 外人能用 workspace 工具，但只能看（list、get）；建、改名、归档只给本人。
    const action = utils.getStringField(gate.call.arguments, 'action');
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
  }

  /**
   * 审一条命令：规则 → 决策模型 → 审核小会话 → 问用户。不抛错：决策模型、小会话出错或答得不对都当“拿不准”，往下一档。
   * @param input 命令、目录、机器人、会话、提的人、payload、问不问用户、停止信号。
   * @returns 放行、拒绝，或者已经去问用户了。
   * 副作用：可能开一场审核小会话（调模型）；可能登记一件待确认。
   */
  async review(input: ReviewInput): Promise<Verdict> {
    //G 请求方已结束等待时跳过所有审核和登记。
    const stopped = getStoppedReview(input.signal);
    if (stopped !== undefined) return this.traced(input, stopped);

    const { command, cwd } = input;

    //M 第一档：程序规则。碰了密钥文件直接拒绝；项目自己的检查直接放行。
    const secret = rules.touchesSecret(command);
    if (secret !== undefined) {
      const reason = `不准执行：命令碰了密钥文件 ${secret}。先用现有工具；缺能力时可用 agent_task 的 list 找执行端，再用 send（reply: false）留言`;
      return this.traced(input, { result: 'reject', by: 'rule', reason });
    }
    //G builder 的目录里 package.json 是他自己写的，“项目自己的检查”可能是任意命令，不直接放行。
    const runtimeRoot = this.ctx.resources.root;
    if (input.confined === undefined && rules.isProjectCheck(command, cwd, runtimeRoot)) {
      return this.traced(input, { result: 'pass', by: 'rule', reason: '项目自己的检查，直接执行' });
    }

    //G 命中 mustAsk 时跳过可信目录和决策模型。仍开审核小会话生成卡片内容，其结论不能放行。
    const danger = rules.mustAsk(command, this.ctx.resources.root, cwd);

    //M 每一档没放行的原因，照先后记下（用户 11-18 #172）：最后要问用户时，卡片的“为什么问你”就写这些，不写空话。
    const asks: string[] = [];
    if (danger !== undefined) {
      asks.push(danger);
    }

    //M 可信目录（用户 11-18 #169）和授权目录（用户 #301）：执行目录和命令里写的路径都落在这些目录里，
    //M   程序规则直接放行，不再问模型、不弹卡片；不在的记下是哪个路径。哪些目录算数见 getReviewDirs：
    //M   本人是配置的 trusted_dirs 加这一轮的授权目录；外人（confined）只认这一轮的授权目录。
    if (danger === undefined) {
      const reviewDirs = this.getReviewDirs(input);
      const untrusted = rules.getUntrusted(command, cwd, reviewDirs);
      let passReason = '可信目录';
      if (input.confined !== undefined) {
        passReason = '授权目录';
      }
      if (untrusted === undefined) return this.traced(input, { result: 'pass', by: 'rule', reason: passReason });

      //G 外人这一轮带着授权目录（reviewDirs 不空），命令出了目录：规则直接拒，不问模型、不出卡片（用户 #301：出了这个目录照旧不行）。
      if (input.confined !== undefined && reviewDirs.length > 0) {
        const reason = `没放行：${untrusted}。只能在这一轮的工作目录和授权目录里动，别的要用户本人来说。`;
        return this.traced(input, { result: 'reject', by: 'rule', reason });
      }

      asks.push(untrusted);
    }

    //M 准备给后面几档看的材料：要跑的脚本内容、记在哪个机器人名下、命令现状。
    const script = rules.readScript(command, cwd);
    const bot = input.bot ?? botUtils.getDefaultBot(this.ctx.resources.raw) ?? '';
    const state: Record<string, unknown> = { 命令: command, 执行目录: cwd };
    if (script !== undefined) Object.assign(state, { 要跑的脚本: script.file, 脚本内容: script.content });
    if (input.session !== undefined) state['哪场会话'] = input.session;
    if (input.confined !== undefined) state['约束'] = confinedRule(input.confined);
    let last: { by: ReviewBy; reason: string } = { by: 'rule', reason: danger ?? '规则定不了' };
    //M 决策模型顺带写的“执行完会做成什么”：卡片“要做什么”第二优先用（审核小会话写的排第一）；没有是空串。
    let decisionWhat = '';

    //M 第二档：决策模型（只用来放行只读、低风险的）。必须人审的那一小块不问它。
    if (danger === undefined) {
      const asked = await this.askDecision(input, bot, state);
      //G 结束等待后不采用决策回执，也不再启动审核小会话。
      const afterDecision = getStoppedReview(input.signal);
      if (afterDecision !== undefined) return this.traced(input, afterDecision);

      //M 决策模型真答过才看结论；没挂、出错都当没问过，保留“规则定不了”往下一档。
      const judged = asked.reply;
      if (judged?.verdict === 'allow') {
        const reason = `决策模型认为安全：${judged.reason}`;
        return this.traced(input, { result: 'pass', by: 'decision', reason });
      }
      if (judged?.verdict === 'deny') {
        const reason = judged.reason;
        return this.traced(input, { result: 'reject', by: 'decision', reason });
      }

      //M 拿不准：记下决策模型的原因，和它顺带写的执行结果（只给卡片显示，不改上面的放行判断）。
      if (judged !== undefined) {
        decisionWhat = judged.what ?? '';
        last = { by: 'decision', reason: judged.reason };
        asks.push(`决策模型拿不准：${judged.reason}`);
      }
    }

    //M 第三档：开一场不带工具的审核小会话，让模型看一眼，要它只回一段 JSON。
    const why = this.getWhy(input.session);
    const answer = await this.askModel(input, bot, script, why);
    //G 审核小会话可能晚于截止才回，结束等待后不放行也不弹卡片。
    const afterModel = getStoppedReview(input.signal);
    if (afterModel !== undefined) return this.traced(input, afterModel);

    if (answer?.['safe'] === true && danger === undefined) {
      let what = '（没写）';
      if (typeof answer['what'] === 'string') {
        what = answer['what'];
      }
      //M 审核小会话确认安全且不属于必问高危项，记跟踪并直接放行。
      return this.traced(input, { result: 'pass', by: 'review', reason: `模型看过，能直接执行：${what}` });
    }

    //M 审核小会话没放行：它写的理由原文记下（没写、只写“无”的记“审核没给出理由”），拒绝和卡片都用它。
    const reviewReason = reviewCardModule.getReviewReason(answer);
    if (answer !== undefined && danger === undefined) {
      last = { by: 'review', reason: reviewReason };
    }
    if (danger === undefined) {
      asks.push(`审核小会话：${reviewReason}`);
    }

    //G 调用方说了不问用户 → 直接拒绝。
    if (input.ask === false) {
      const reason = `没放行：${last.reason}。要用户拍板就带上 ask_user 再发一次。`;
      return this.traced(input, { result: 'reject', by: last.by, reason });
    }

    //G builder 的命令审不过直接拒：登记了待确认，发起人自己就能说“同意 N”（allowed 认 actor），等于自己批自己。
    if (input.confined !== undefined) {
      const reason = `没放行：${last.reason}。只能在 ${input.confined} 里动，别的要用户本人来说。`;
      return this.traced(input, { result: 'reject', by: last.by, reason });
    }

    //M 第四档：照审核模型写的内容拼一张卡片，登记待确认，问用户。不等用户：马上交回“已经去问了”，用户定了由 approval/decided 通知提的人。
    const card = reviewCardModule.reviewCard(input, script, answer, why, asks, decisionWhat);
    const detail = cardUtils.getCardText({ ...card, state: 'waiting' });
    const askInput = {
      kind: input.kind,
      title: card.title,
      detail,
      payload: input.payload,
      bot,
      session: input.session,
      card,
    };
    const pending = this.ask(askInput);
    //G 登记通知期间若已经截止，将这张卡片作废并保存明确原因。
    const afterAsk = getStoppedReview(input.signal);
    if (afterAsk !== undefined) {
      this.close(pending.id, afterAsk.reason);
      return this.traced(input, afterAsk);
    }

    return this.traced(input, { result: 'asked', id: pending.id, reason: `等用户决定（待确认 #${String(pending.id)}）` });
  }

  /**
   * 第二档：问决策模型这条命令安不安全。发请求事件 decision/judge（契约 3.2 第 2 条），等 decision/judge-result。
   * 不掐表：decision 每个模型自己限时、到点回拿不准；等了 20 秒还没回只报警。
   * @param input 审核的输入（kind、停止信号）。
   * @param bot 对话模型的小会话记在哪个机器人名下。
   * @param state 给模型看的现状：命令、目录、脚本、会话、约束。
   * @returns reply 是决策模型的结论；没挂 decision、出错、提问的会话喊停时是 why。
   */
  private async askDecision(
    input: ReviewInput,
    bot: string,
    state: Record<string, unknown>,
  ): Promise<requestEventModule.Asked<DecisionReply>> {
    //M 顺带要一句“执行完会做成什么”（同一次调用，不多调模型），只给卡片的“要做什么”用。
    const want = ['what'] as const;
    const judgeInput = {
      kind: input.kind,
      bot,
      allowAt: this.config.decisionPass,
      question: SAFE,
      state,
      want,
    };
    const options = {
      prefix: 'dec',
      warnAfterMs: DECISION_WARN_MS,
      signal: input.signal,
    };

    //M 发 decision/judge 等回执；提问的会话被喊停，这次等待跟着结束。
    const asking = 'decision/judge';
    const answer = 'decision/judge-result';
    return await requestEventModule.requestEvent(this.ctx, asking, answer, judgeInput, options);
  }

  /**
   * 第三档：开一场审核小会话。命令放第一行（假模型回的是话的前 40 字，离线测“放行”靠它）。
   * @param input 审核的输入。
   * @param bot 记在哪个机器人名下。
   * @param script 要跑的脚本，可能没有。
   * @param why 机器人在干的活（getWhy 取的会话最后一句用户的话），可能是空串。
   * @returns 模型回的 JSON；没做完、不是 JSON 都是 undefined（当拿不准）。
   */
  private async askModel(
    input: ReviewInput,
    bot: string,
    script: ReturnType<typeof rules.readScript>,
    why: string,
  ): Promise<Record<string, unknown> | undefined> {
    //M 拼审核小会话要看的话：命令、目录、约束、脚本内容、机器人在干的活，最后叮嘱只回 JSON。
    const config = this.config;
    const lines = [`命令：${input.command}`, `执行目录：${input.cwd}`];
    if (input.confined !== undefined) lines.push(confinedRule(input.confined));
    if (script !== undefined) lines.push(`要跑的脚本：${script.file}（前 4000 字）\n${script.content}`);
    if (why !== '') lines.push(`机器人在干的活：${why}`);
    lines.push('只回一段 JSON：{"safe": ..., "title": "...", "reason": "...", "what": "...", "paths": [...], '
      + '"risk_level": "...", "risk": "...", "advice": "..."}。'
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
    const vars = {
      command: input.command.slice(0, 80),
      verdict: verdict.result,
      decidedBy: decidedBy,
      reason: verdict.reason,
    };
    this.ctx.emit('trace', 'Approval.review', 'trace.approval.review', 'approval.review(input)', vars);
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
    const base = input.card ?? reviewCardModule.plainCard(input.title, input.detail);
    const card: cardUtils.CardData = { ...base, state: 'waiting' };
    const who = this.getInitiator(input.session);
    const sql = 'INSERT INTO approval_pending'
      + ' (kind, title, detail, payload, bot, session, customer, actor, state, asked_at, card)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const values = [
      input.kind,
      input.title,
      input.detail,
      JSON.stringify(input.payload ?? null),
      input.bot,
      input.session ?? null,
      who.customer,
      who.actor,
      'waiting',
      Date.now(),
      JSON.stringify(card),
    ];
    const done = this.ctx.resources.db.query(sql).run(...values);
    const pending = this.getRow(Number(done.lastInsertRowid)) as Pending;

    //T 跟踪：登记了一件待确认。
    const vars = { id: pending.id, requestedBy: pending.kind, bot: pending.bot, session: pending.session };
    this.ctx.emit('trace', 'Approval.ask', 'trace.approval.ask', "ctx.emit('approval/asked', pending)", vars);
    this.ctx.emit('approval/asked', pending);

    //G 飞书群里的会话不说细节和怎么回：群里谁都看得到、都能回，群里只由飞书卡片那块回一句“要本人确认”，卡片发本人私聊。
    let where: unknown;
    if (pending.session !== undefined) {
      where = this.ctx.sessions.find({ id: pending.session })[0]?.address;
    }
    //G 群聊会话不在群内发确认口令，直接返回登记结果。
    if (protocol.isGroup(where) || pending.kind === outboundModule.REMINDER_APPROVAL_KIND) return pending;

    //M 有会话就跟用户说一句怎么回。
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
  decide(id: number, approve: boolean, by: string, verified = true): Pending | string {
    //G 先按号找出这件待确认：找不到、已经定过的交回原因，不动表。
    const found = this.getRow(id);
    if (found === undefined) return `没有待确认 #${String(id)}`;

    //G 卡片作废后（审核超时、提的人不要了，都经 close）仍可能被点到：看卡片状态，交回作废时记下的原因，不比文字。
    if (found.card.state === 'ended') return `待确认 #${String(id)} ${found.by ?? '已作废'}`;

    if (!verified && found.kind === outboundModule.REMINDER_APPROVAL_KIND) return '定时提醒只接受本人确认';

    if (found.state !== 'waiting') return `待确认 #${String(id)} 已经定过了（${STATE_TEXT[found.state]}）`;

    let nextState: 'approved' | 'rejected' = 'rejected';
    let action: 'approve' | 'reject' = 'reject';
    if (approve) {
      nextState = 'approved';
      action = 'approve';
    }
    //M 取出对应按钮文案落库并广播 approval/decided。
    return this.settle(found, nextState, by, `${reviewCardModule.cardLabel(found.card, action)}（${by}）`);
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
  private settle(
    found: Pending,
    state: 'approved' | 'rejected',
    by: string,
    result: string,
    cardState?: cardUtils.CardState,
  ): Pending {
    //M 改表里的状态和卡片，再读回来给后面发通知用。
    const id = found.id;
    const at = Date.now();
    const when = new Date(at).toLocaleString('zh-CN', { hour12: false });
    const card: cardUtils.CardData = { ...found.card, state: cardState ?? state, result: `${result}，${when}` };
    const sql = 'UPDATE approval_pending SET state = ?, decided_by = ?, decided_at = ?, card = ? WHERE id = ?';
    this.ctx.resources.db.query(sql).run(state, by, at, JSON.stringify(card), id);
    const pending = this.getRow(id) as Pending;

    //T 跟踪：用户定了一件待确认。
    const vars = { id: id, result: pending.state, decidedBy: by };
    this.ctx.emit('trace', 'Approval.decide', 'trace.approval.decide', "ctx.emit('approval/decided', pending)", vars);
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
    const sql = "SELECT * FROM approval_pending WHERE state != 'waiting' AND decided_at >= ? ORDER BY id";
    const rows = this.ctx.resources.db.query(sql).all(since) as Row[];
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

  /** 按号读取待确认。网页传上限，内部批量处理沿用 SQLite 的 -1 读取全部。 */
  list(limit = -1): Pending[] {
    //M 查还在等的，转成 Pending，号从小到大。
    const sql = "SELECT * FROM approval_pending WHERE state = 'waiting' ORDER BY id LIMIT ?";
    const rows = this.ctx.resources.db.query(sql).all(limit) as Row[];
    return rows.map(getPending);
  }

  /** 网页上限之外仍有几条待确认，只读取数量。 */
  getWebOverflow(): number {
    const sql = "SELECT COUNT(*) AS total FROM approval_pending WHERE state = 'waiting'";
    const row = this.ctx.resources.db.query(sql).get() as { total: number };
    return Math.max(0, row.total - WEB_WAITING_LIMIT);
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
    const vars = { action: request.action, requestId: request.requestId };
    this.ctx.emit('trace', 'Approval.onRequest', 'trace.approval.request', `approval/request（${request.action}）`, vars);

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

    if (request.action === 'reminder-card') {
      const payload = JSON.stringify({ reminderId: request.reminderId });
      const kind = outboundModule.REMINDER_APPROVAL_KIND;
      const sql = 'SELECT * FROM approval_pending WHERE kind = ? AND bot = ? AND payload = ? ORDER BY id LIMIT 1';
      const row = this.ctx.resources.db.query<Row, [string, string, string]>(sql).get(kind, request.bot, payload);
      if (row === null) return {};

      const pending = getPending(row);
      return { pending };
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
   * 审命令时哪些目录算数（程序规则直接放行），都照 getPathKey 规范化好交给 rules.getUntrusted。
   * 授权目录在回话地址的 grants.dirs 里（utils/Workspace.ts 的 getGrantDirs）：本人、中控发消息时带的（web-api 入口 checkGrants 查过），
   * 渠道进来的话按人、按群从库里查到的（Grants.applyMessage）；再加本人这一轮说的当轮授权（Grants.getTurnDirs）。
   * 地址跟着最后一句带渠道的话换：后来的消息没带、库里也没有，授权就没了。
   * @param input 要审的命令：哪场会话、是不是外人让跑的（confined）。
   * @returns 本人（不是 confined）：配置的 trusted_dirs，地址是本人的再加这一轮的授权目录；
   *   外人（confined）：这一轮有授权目录时是执行目录加授权目录（trusted_dirs 是本人的，不给）；没有授权目录、没有会话的是空数组。
   */
  private getReviewDirs(input: ReviewInput): string[] {
    //M 会话记录（库里的）：回话地址、来源快照。命令窗口没有会话。
    let meta: SessionMeta | undefined;
    if (input.session !== undefined) {
      meta = this.ctx.sessions.find({ id: input.session })[0];
    }

    //M 这一轮的授权目录：地址里的，加本人说的当轮授权。
    let grantDirs: string[] = [];
    if (meta !== undefined) {
      grantDirs = [...workspaceModule.getGrantDirs(meta.address), ...this.grants.getTurnDirs(meta)];
    }
    const grantKeys = grantDirs.map((dir) => workspaceModule.getPathKey(dir));

    //M 外人让跑的（confined，exec 给 builder 和升成 builder 的人）：这一轮没授权目录，交回空的，照旧交给后面的模型审。
    //M   外人地址里的 grants 只会是 Grants.applyMessage 按库查出来写的（原有的它先删掉）。
    if (input.confined !== undefined && grantKeys.length === 0) return grantKeys;

    //M 有授权目录的外人：他这一轮的执行目录（builder 自己的目录）加授权目录都算，出了这些 review 规则直接拒。
    if (input.confined !== undefined) return [workspaceModule.getPathKey(input.confined), ...grantKeys];

    //G 地址不是本人的：外人那一轮不给授权目录，只有配置的可信目录。
    if (!isMarkedOwner(meta?.address)) return this.config.trustedDirs;

    return [...this.config.trustedDirs, ...grantKeys];
  }

  /**
   * 认文字回答（bot/receive，兼容未迁移渠道与离线测试）。如果该消息已经由渠道事件入口转来则跳过，免得 N 机器人重复执行。
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
    const speaker = rules.getSpeaker(event.message.channel, event.message.address);
    const owner = isMarkedOwner(event.message.address);
    const verifiedOwner = utils.getField(event.message.address, 'verifiedOwner') === true;
    const verified = event.message.channel !== 'http' || verifiedOwner;
    const waiting = this.list().filter((item) => item.bot === bot && allowed(item, speaker, owner, verified));
    //M 标记已消费后才执行批复，审批监听者看到的时序保持一致。
    const answer = this.getTextAnswer(said, waiting);
    if (answer === undefined) return;

    event.handled = true;
    this.applyTextAnswer(answer, event.message.channel);
    this.answer(bot, answer.about, answer.text);
  }

  /**
   * 响应 channel/direct、channel/mention 里的消息级审批文本指令（如“同意 1”“拒绝 2”“全部同意”“待确认有哪些”）。
   * 一条消息只消费一次，防止 N 个目标机器人重复批准或答复多次。
   * @param message 标准渠道消息。
   * @param control 协调对象。
   */
  private async onChannelMessage(
    message: protocol.ChannelMessage,
    control?: protocol.ChannelMessageControl,
  ): Promise<void> {
    if (control?.approvalHandled === true) return;

    //G 语音半句（routing.partial）话还没说完，不当批复认；等同一消息号的整句来了再认。
    if (message.routing.partial === true) return;

    //M 先认认是不是“同意 3”“待确认有哪些”这类话；不是就放过，照常往下走。
    const said = rules.parseReply(message.text);
    if (said === undefined) return;

    //M 查说话人是谁、是不是本人，再列出目标机器人名下他能处理的待确认。
    const speaker = rules.getSpeaker(message.channel, message.origin.address);
    const owner = message.role === 'owner' && isMarkedOwner(message.origin.address);
    const targetSet = new Set(message.targetBots);
    const verified = message.channel !== 'http' || message.origin.address['verifiedOwner'] === true;
    const waiting = this.list().filter((item) => targetSet.has(item.bot) && allowed(item, speaker, owner, verified));
    //M 同条渠道消息只提交一次审批，处理结果发回原聊天。
    const answer = this.getTextAnswer(said, waiting);
    if (answer === undefined) return;

    if (control !== undefined) {
      control.approvalHandled = true;
    }
    this.applyTextAnswer(answer, message.channel);
    await this.answerChannel(message, answer.about, answer.text);
  }

  /**
   * 从说话人可处理的待确认中选出批复目标和答复文字。
   * @param said 已经识别的文字指令。
   * @param waiting 这位说话人有权限处理的待确认。
   * @returns 本次要回复和处理的内容，没命中时由调用方继续处理普通消息。
   */
  private getTextAnswer(said: rules.Reply, waiting: Pending[]): TextAnswer | undefined {
    //G 无权处理任何一条时把原话留给前台，避免透露审批指令。
    if (waiting.length === 0) return undefined;

    //M 清单只列授权范围内的项目，不写入审批决定。
    if ('list' in said) {
      const list = getListText(waiting);
      const text = `${list}\n回复“同意 号”或“拒绝 号”。`;
      return { about: waiting[0]!, text };
    }

    //G 未点号时只考虑正在等文字批复的项目，避免随口同意误停长跑。
    let candidates = waiting;
    if (said.id === undefined) {
      candidates = waiting.filter(isImplicitDecision);
    }
    if (candidates.length === 0) return undefined;

    //M 点号只处理命中的一项，不点号可以批复唯一候选或全部。
    let targets = candidates;
    if (said.id !== undefined) {
      const named = candidates.find((item) => item.id === said.id);
      if (named === undefined) return undefined;

      targets = [named];
    }
    if (said.id === undefined && said.all !== true && candidates.length > 1) {
      const list = getListText(candidates);
      const text = `现在有 ${String(candidates.length)} 条，要说是哪一条：\n${list}\n回复“同意 号”“拒绝 号”或“全部同意”。`;
      return { about: candidates[0]!, text };
    }

    //M 回话列出实际处理的审批号。
    const ids = targets.map((item) => `#${String(item.id)}`).join('、');
    let word = '已拒绝';
    if (said.approve) {
      word = '已同意';
    }
    const decision = { targets, approve: said.approve };
    const text = `${word}待确认 ${ids}。`;
    return { about: targets[0]!, text, decision };
  }

  /**
   * 在调用方标记消息已消费后保存批复，发出各项的决定事件。
   * @param answer 刚选出的文字答复和批复事项。
   * @param channel 说话所在的渠道，用于记录决定来源。
   */
  private applyTextAnswer(answer: TextAnswer, channel: string): void {
    if (answer.decision === undefined) return;

    //M 批复继续走同一个持久化与通知入口。
    const source = `${channel} 文字回复`;
    for (const item of answer.decision.targets) {
      this.decide(item.id, answer.decision.approve, source);
    }
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
    const snapshot = protocol.getSourceSnapshot(message, bot, message.origin, claimKey, replyRoundKey);

    const options = { replyRequestKey, replyIndex: 0, kind: 'final' as const };
    //M 将文字确认发回原消息所在的聊天。
    await protocol.requestTextReply(this.ctx, snapshot, text, options);
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
    const speaker = rules.getSpeaker(meta.channel, meta.address);
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
    const vars = { bot: bot, spoken: text };
    this.ctx.emit('trace', 'Approval.answer', 'trace.approval.answerWithoutSession', "ctx.emit('bot/say')", vars);
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
 * decide、close 的结果转成回执正文：定好了带 settled，找不到、定过了带 error。
 * @param result decide、close 交回的：定好的那件，或一句原因。
 */
function getSettled(result: Pending | string): requestEventModule.StripResultId<ApprovalResult> {
  if (typeof result === 'string') return { error: result };

  return { settled: result };
}

/** 把请求方取消审核的原因收成统一拒绝回执。 */
function getStoppedReview(signal: AbortSignal | undefined): Extract<Verdict, { result: 'reject' }> | undefined {
  if (signal?.aborted !== true) return undefined;

  let reason = '命令审核已取消';
  const cause: unknown = signal.reason;
  if (cause instanceof DOMException && cause.name === 'TimeoutError') {
    reason = REVIEW_TIMED_OUT;
  }
  return { result: 'reject', by: 'rule', reason };
}


/**
 * 渠道有没有在回话地址上明写这是本人（owner: true）：批复“同意 N”、审命令时给本人的授权目录，只认这一条。
 * 有意比 channels 的 isOwnerTurn 严（决策图 q-approval-owner 定的）：isOwnerTurn 把没写身份的命令行、没有渠道的内部会话也默认当本人，
 * 那是为了让本机用起来顺手；可批命令、放宽可信目录是放行动手的事，要渠道亲口担保过的本人才行
 * （飞书照插件配置的 people 写，网页由 http 插件核过本机或令牌才写），免得内部会话、默认身份自己批自己。
 * @param address 渠道的回话地址。
 * @returns 写了 owner: true 才是。
 */
export function isMarkedOwner(address: unknown): boolean {
  //M 读回话地址里的 owner，只有明写 true 才是本人。
  return utils.getField(address, 'owner') === true;
}


/**
 * 这个人能不能处理这件待确认：用户本人，或登记时的同一发起人。
 * 旧记录没有发起人身份的，只许用户本人处理，避免群里的人靠同一客户号误批。
 * 群里说的、群里提的，只认用户本人：群里的发起人不能自己批自己，绕过用户（2026-11-17，0.7.18）。
 * @param item 待确认。
 * @param speaker 说话人。
 * @param owner 是不是用户本人。
 * @param verified 网页文字审批有没有经过身份核验，其他渠道在入口核验。
 * @returns 能处理是 true。
 */
export function allowed(
  item: Pending,
  speaker: { customer: string; actor: string },
  owner: boolean,
  verified = true,
): boolean {
  if (item.kind === outboundModule.REMINDER_APPROVAL_KIND) return owner && verified;

  if (owner) return true;

  //G 说话人在群里，或这件是群里的会话提的 → 只认本人。
  if (protocol.isGroup(speaker) || protocol.isGroup(item)) return false;
  return item.actor !== undefined && item.actor !== '' && item.actor === speaker.actor;
}

/**
 * 生成说话人有权查看的待确认项目列表。
 * @param items 待确认事项。
 * @returns 每行显示编号与标题的清单。
 */
function getListText(items: Pending[]): string {
  return items.map((item) => `#${String(item.id)}：${item.title}`).join('\n');
}

/** 需要专门确认的卡片只能用按钮或带编号的文字决定。 */
function isImplicitDecision(item: Pending): boolean {
  return item.session !== undefined && item.card.kind !== 'long-run'
    && item.kind !== outboundModule.REMINDER_APPROVAL_KIND;
}


/**
 * 表里一行转成 Pending（payload 解一次 JSON）。
 * @param row 表里的一行。
 */
function getPending(row: Row): Pending {
  //M 有落库的卡片 JSON 直接解析；旧记录为 null 时用标题与细节补默认卡。
  let card: cardUtils.CardData = { ...reviewCardModule.plainCard(row.title, row.detail), state: row.state };
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
 * 转换为网页使用的审批项结构 PendingApproval。
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
 * 登记网页待审核列表、数量与决定接口。
 * @param app http 的 Fastify 实例。
 * @param approval 服务。
 */
function routes(
  app: fastify.FastifyInstance,
  approval: Approval,
  isVerified: (request: fastify.FastifyRequest) => boolean,
): void {
  //M 网页只拉最早一批待审核。最近已定的长跑提醒仍照原样附在数组里。
  app.get('/api/approvals', async (request) => {
    const verified = isVerified(request);
    const waiting = approval.list(WEB_WAITING_LIMIT)
      .filter((item) => verified || item.kind !== outboundModule.REMINDER_APPROVAL_KIND);
    const recent = approval.recent();
    return [...waiting, ...recent].map(view);
  });

  //M 待审核页满一批时补查省略的条数，普通轮询继续沿用数组接口。
  app.get('/api/approvals/overflow', async () => {
    //M 只返回网页一批以外仍待处理的项数。
    const count = approval.getWebOverflow();
    return { count };
  });

  //M POST /api/approvals/:id：网页点同意、拒绝，body 里 approve 要是布尔值，不是的当场回 400。
  app.post<{ Params: { id: string }; Body: unknown }>('/api/approvals/:id', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body['approve'] !== 'boolean') return reply.code(400).send({ error: 'approve 要是 true 或 false' });

    //M 按号定这件事，记成“HTTP”定的；找不到、定过了回 404。
    const verified = isVerified(request);
    const id = Number(request.params.id);
    const result = approval.decide(id, body['approve'], 'HTTP', verified);
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
  if (typeof pass !== 'number' || pass < DECISION_PASS || pass > 1) {
    throw new Error(`approval.decision_pass 要是 ${String(DECISION_PASS)}～1 的数`);
  }

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
  //M 渠道发件使用独立的本人批准账，和通用文字审批分开。
  new outboundModule.Outbound(ctx);

  //M http 是可选的：ctx.inject(服务, 回调) 等于再挂一个小插件，http 在了才调回调、登记接口。
  void ctx.inject(['http'], (sub) => {
    const isVerified = (request: fastify.FastifyRequest): boolean => sub.http.isVerified(request);
    routes(sub.http.app, approval, isVerified);
    //M 主站发件复用这套 HTTP 鉴权及同一个 Outbound 账。
    channelSend.mountChannelSend(sub, sub.http);
    //M 目录授权的网页接口（GET/POST /api/grants）：设、撤也只认本人。
    approval.grants.mountRoutes(sub.http.app, isVerified);
  });

  //M 工具服务就绪后才提供本轮聊天的发件申请、目录授权（dir_grant，只有本人那一轮能用）。
  void ctx.inject(['tools'], (sub) => {
    channelSend.registerChannelSendTool(sub);
    approval.grants.registerTool(sub.tools);
  });
}
