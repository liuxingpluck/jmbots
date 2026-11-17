/**
 * 审核和待确认。
 *   review：审一条命令，照 0.4 的顺序一档一档来：程序规则 → 决策模型（decision 插件，挂了才问）→ 审核小会话（让模型看一眼）→ 问用户。
 *   ask：登记一件要用户点头的事（谁都能提），存表，发 approval/asked，有会话就 bots.say 告诉用户怎么回。
 *   decide：用户定了，改表，发 approval/decided。谁提的谁听这个通知自己去做（exec、runs……），这里不执行任何东西。
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
import type { AskInput as SessionAskInput, Session } from '../../Sessions.ts';
import type { Thinking } from '../../Chat.ts';
import type { ReceiveEvent } from '../bots/index.ts';
import * as rules from './Rules.ts';
import * as cardUtils from '../../utils/Card.ts';
import * as textModule from '../../utils/Text.ts';
import * as workspaceModule from '../../utils/Workspace.ts';


/** 插件名。 */
export const name = 'approval';

/** 决策模型放行的最低门槛，也是默认值。 */
export const DECISION_PASS = 0.8;

/** 用到的服务。decision、http 是可选的，不写在这里（写进 inject 就成了“必须有”）。 */
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


/** decision 服务里用到的（decision.md 第 2 节）。那个插件还没写，这里只按约定写结构，不 import 它。 */
interface DecisionLike {
  judge(input: {
    kind: string; question: { instructions: string; yes: string; no: string };
    state: Record<string, unknown>; bot?: string; allowAt?: number;
  }): Promise<{ verdict: 'allow' | 'deny' | 'unsure'; score?: number; reason: string }>;
}


/** 校验后的配置。 */
interface ApprovalConfig {
  /** 审核小会话用哪个模型；undefined 用 default_model。 */
  model?: string;
  /** 审核小会话的思考档。 */
  thinking: Thinking;
  /** 决策模型合出来的“安全”分不低于它就放行。 */
  decisionPass: number;
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
  + '只回一个 JSON，不要别的文字：\n'
  + '{"safe": true 或 false, "title": "大白话：要做什么，20 字以内", "reason": "为什么要做（机器人在干什么活）", '
  + '"what": "这条命令具体做什么（一两句）", "paths": ["会动到的文件或目录，没有就空数组"], '
  + '"risk_level": "low、medium 或 high", "risk": "一句话：风险在哪；没有就写“无”", "advice": "建议同意还是拒绝，为什么"}';

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
   * 建表，听 bot/receive（认文字回答）、session/request（给审核小会话加提示词；guest、builder 说的这一轮只给这一档的工具）
   * 和 session/before-tool（这一档没有的工具不让执行）。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param config 校验后的配置。
   */

  constructor(ctx: cordis.Context, private readonly config: ApprovalConfig) {
    super(ctx, 'approval');
    ctx.resources.db.exec('CREATE TABLE IF NOT EXISTS approval_pending (id INTEGER PRIMARY KEY AUTOINCREMENT,'
      + ' kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, payload TEXT NOT NULL, bot TEXT NOT NULL,'
      + ' session TEXT, state TEXT NOT NULL, decided_by TEXT, asked_at INTEGER NOT NULL, decided_at INTEGER)');
    //M 卡片列是 11-14 加的：老库没有就补上（老的行 card 是空的，读的时候照 title、detail 拼一张）。
    const columns = ctx.resources.db.query('PRAGMA table_info(approval_pending)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'card')) ctx.resources.db.exec('ALTER TABLE approval_pending ADD COLUMN card TEXT');
    if (!columns.some((column) => column.name === 'customer')) ctx.resources.db.exec('ALTER TABLE approval_pending ADD COLUMN customer TEXT');
    if (!columns.some((column) => column.name === 'actor')) ctx.resources.db.exec('ALTER TABLE approval_pending ADD COLUMN actor TEXT');

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
      const role = workspaceModule.roleOf(address);
      const allowedTools = rules.toolsFor(role);
      if (allowedTools === undefined) return;

      request.tools = request.tools.filter((tool) => allowedTools.has(tool.name));
      const prompt = role === 'builder' ? builderPrompt(textModule.textOf(address, 'workspace')) : GUEST_PROMPT;
      request.system.push(prompt);
    });

    //M 兜底：工具清单是这一步开头定的，会话转到一半换了说话人（群里别人插话）时，执行前再按现在的说话人拦一次。
    ctx.on('session/before-tool', (gate) => {
      if (gate.deny !== undefined) return;

      const role = workspaceModule.roleOf(gate.session.row.address);
      const allowedTools = rules.toolsFor(role);
      if (allowedTools === undefined || allowedTools.has(gate.call.name)) return;

      gate.deny = role === 'builder'
        ? '这一轮说话的人只能在他自己的目录里读写、跑命令、发文件，这个工具不给'
        : '这一轮说话的不是用户本人，只能用查、读、搜、答这类工具';
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

    const script = rules.readScript(command, cwd);
    const bot = input.bot ?? this.ctx.bots.list()[0]?.name ?? '';
    const state: Record<string, unknown> = { 命令: command, 执行目录: cwd };
    if (script !== undefined) Object.assign(state, { 要跑的脚本: script.file, 脚本内容: script.content });
    if (input.session !== undefined) state['哪场会话'] = input.session;
    if (input.confined !== undefined) state['约束'] = confinedRule(input.confined);

    //G 删系统级文件或目录、删注册表、删数据（Rules.ts mustAsk，范围故意很小）：不问决策模型、不让审核小会话放行，直接问用户。
    const danger = rules.mustAsk(command, this.ctx.resources.root, cwd);
    let last: { by: ReviewBy; reason: string } = { by: 'rule', reason: danger ?? '规则定不了' };

    //M 第二档：决策模型（只用来放行只读、低风险的）。decision 是可选的服务，ctx.get 现取（没挂、没开工就是 undefined），没有就跳过这一档。
    const decision = danger === undefined ? this.ctx.get('decision') as DecisionLike | undefined : undefined;
    if (decision !== undefined) {
      const judged = await decision.judge({ kind: input.kind, bot, allowAt: this.config.decisionPass, question: SAFE, state })
        .catch((error: unknown) => ({ verdict: 'unsure' as const, reason: `决策模型出错：${String(error)}` }));
      if (judged.verdict === 'allow') return this.traced(input, { result: 'pass', by: 'decision', reason: `决策模型认为安全：${judged.reason}` });
      if (judged.verdict === 'deny') return this.traced(input, { result: 'reject', by: 'decision', reason: judged.reason });
      last = { by: 'decision', reason: judged.reason };
    }

    //M 第三档：开一场不带工具的审核小会话，让模型看一眼，要它只回一段 JSON。
    const why = this.whyOf(input.session);
    const answer = await this.askModel(input, bot, script, why);
    if (answer?.['safe'] === true && danger === undefined) {
      const what = typeof answer['what'] === 'string' ? answer['what'] : '（没写）';
      return this.traced(input, { result: 'pass', by: 'review', reason: `模型看过，能直接执行：${what}` });
    }
    if (answer !== undefined && danger === undefined) last = { by: 'review', reason: typeof answer['risk'] === 'string' ? answer['risk'] : '模型认为有风险' };

    //G 调用方说了不问用户 → 直接拒绝（0.4 原话：ExecReview.ts:279）。
    if (input.ask === false) {
      return this.traced(input, { result: 'reject', by: last.by, reason: `没放行：${last.reason}。要用户拍板就带上 ask_user 再发一次。` });
    }

    //G builder 的命令审不过直接拒：登记了待确认，发起人自己就能说“同意 N”（allowed 认 actor），等于自己批自己。
    if (input.confined !== undefined) {
      return this.traced(input, { result: 'reject', by: last.by, reason: `没放行：${last.reason}。只能在 ${input.confined} 里动，别的要用户本人来说。` });
    }

    //M 第四档：照审核模型写的内容拼一张卡片，登记待确认，问用户。不等用户：马上交回“已经去问了”，用户定了由 approval/decided 通知提的人。
    const card = reviewCard(input, script, answer, why);
    const detail = cardUtils.cardText({ ...card, state: 'waiting' });
    const pending = this.ask({ kind: input.kind, title: card.title, detail, payload: input.payload, bot, session: input.session, card });
    return this.traced(input, { result: 'asked', id: pending.id, reason: `等用户决定（待确认 #${String(pending.id)}）` });
  }

  /**
   * 第三档：开一场审核小会话。命令放第一行（假模型回的是话的前 40 字，离线测“放行”靠它）。
   * @param input 审核的输入。
   * @param bot 记在哪个机器人名下。
   * @param script 要跑的脚本，可能没有。
   * @returns 模型回的 JSON；没做完、不是 JSON 都是 undefined（当拿不准）。
   */
  private async askModel(input: ReviewInput, bot: string, script: ReturnType<typeof rules.readScript>, why: string): Promise<Record<string, unknown> | undefined> {
    const config = this.config;
    const lines = [`命令：${input.command}`, `执行目录：${input.cwd}`];
    if (input.confined !== undefined) lines.push(confinedRule(input.confined));
    if (script !== undefined) lines.push(`要跑的脚本：${script.file}（前 4000 字）\n${script.content}`);
    if (why !== '') lines.push(`机器人在干的活：${why}`);
    lines.push('只回一段 JSON：{"safe": ..., "title": "...", "reason": "...", "what": "...", "paths": [...], "risk_level": "...", "risk": "...", "advice": "..."}');

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
    const { ok, reply } = await this.ctx.sessions.ask(askInput);

    //G 没做完（出错、停了）→ 当拿不准。
    if (!ok) return undefined;

    const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
    try {
      const parsed: unknown = JSON.parse(json);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
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
    const vars = { 命令: input.command.slice(0, 80), 结论: verdict.result, 谁定的: 'by' in verdict ? verdict.by : 'user', 原因: verdict.reason };
    this.ctx.emit('trace', 'Approval.review', '审完一条命令', 'approval.review(input)', vars);
    return verdict;
  }

  /**
   * 登记一件要用户点头的事。
   * @param input 谁提的、标题、细节、payload、机器人、会话。
   * @returns 新的待确认，state 是 waiting。
   * 副作用：写库；发 approval/asked；有会话就 bots.say 告诉用户怎么回。
   */
  ask(input: AskInput): Pending {
    const card: cardUtils.CardData = { ...(input.card ?? plainCard(input.title, input.detail)), state: 'waiting' };
    const who = this.initiatorOf(input.session);
    const sql = 'INSERT INTO approval_pending (kind, title, detail, payload, bot, session, customer, actor, state, asked_at, card) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const values = [input.kind, input.title, input.detail, JSON.stringify(input.payload ?? null), input.bot, input.session ?? null,
      who.customer, who.actor, 'waiting', Date.now(), JSON.stringify(card)];
    const done = this.ctx.resources.db.query(sql).run(...values);
    const pending = this.rowOf(Number(done.lastInsertRowid)) as Pending;

    //T 跟踪：登记了一件待确认。
    const vars = { 号: pending.id, 谁提的: pending.kind, 机器人: pending.bot, 会话: pending.session ?? '（没有）' };
    this.ctx.emit('trace', 'Approval.ask', '登记一件待确认，告诉用户', "ctx.emit('approval/asked', pending)", vars);
    this.ctx.emit('approval/asked', pending);

    //G 飞书群里的会话不说细节和怎么回：群里谁都看得到、都能回，群里只由飞书卡片那块回一句“要本人确认”，卡片发本人私聊。
    const where = pending.session === undefined ? undefined : this.ctx.sessions.find({ id: pending.session })[0]?.address;
    if (workspaceModule.isGroup(where)) return pending;

    //M 有会话就跟用户说一句怎么回（照 0.4：src/executors/ExecReview.ts:452-458）。
    if (pending.session !== undefined) {
      const id = String(pending.id);
      const how = pending.card.kind === 'long-run'
        ? `点卡片上的“终止”或“继续”；也可以回复“同意 ${id}”（终止）或“拒绝 ${id}”（继续）。不回就一直做下去。`
        : `回复“同意 ${id}”或“拒绝 ${id}”。`;
      const text = `要确认一件事（待确认 #${id}）：${pending.title}\n${pending.detail}\n${how}`;
      this.ctx.bots.say(this.ctx.sessions.open(pending.session), text);
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
    const found = this.rowOf(id);
    if (found === undefined) return `没有待确认 #${String(id)}`;

    if (found.state !== 'waiting') return `待确认 #${String(id)} 已经定过了（${STATE_TEXT[found.state]}）`;

    return this.settle(found, approve ? 'approved' : 'rejected', by, `${approve ? cardLabel(found.card, 'approve') : cardLabel(found.card, 'reject')}（${by}）`);
  }

  /**
   * 作废一件还在等的事：提的人自己不要了（比如长跑提醒的会话已经做完）。记成拒绝，卡片变灰写明原因。
   * @param id 待确认的号。
   * @param note 一句原因，如“会话已结束”。
   * @returns 作废后的那件；找不到、已经定过的交回一句原因。
   */
  close(id: number, note: string): Pending | string {
    const found = this.rowOf(id);
    if (found === undefined) return `没有待确认 #${String(id)}`;
    if (found.state !== 'waiting') return `待确认 #${String(id)} 已经定过了（${STATE_TEXT[found.state]}）`;
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
    const id = found.id;
    const at = Date.now();
    const card: cardUtils.CardData = { ...found.card, state: cardState ?? state, result: `${result}，${new Date(at).toLocaleString('zh-CN', { hour12: false })}` };
    const sql = 'UPDATE approval_pending SET state = ?, decided_by = ?, decided_at = ?, card = ? WHERE id = ?';
    this.ctx.resources.db.query(sql).run(state, by, at, JSON.stringify(card), id);
    const pending = this.rowOf(id) as Pending;

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
    const since = Date.now() - RECENT_MS;
    const rows = this.ctx.resources.db.query("SELECT * FROM approval_pending WHERE state != 'waiting' AND decided_at >= ? ORDER BY id").all(since) as Row[];
    return rows.map(pendingOf).filter((item) => item.card.kind === 'long-run');
  }

  /**
   * 机器人在干什么活：会话最后一句用户的话（前 200 字），审核模型拿它写卡片的“原因”。
   * @param sessionId 提问的会话。
   */
  private whyOf(sessionId: string | undefined): string {
    if (sessionId === undefined) return '';
    const meta = this.ctx.sessions.find({ id: sessionId })[0];
    if (meta === undefined) return '';
    const said = this.ctx.sessions.open(sessionId).row.messages.findLast((message) => message.role === 'user');
    return said === undefined ? '' : piAi.contentText(said.content).slice(0, 200);
  }

  /** @returns 还在等的待确认，号从小到大。 */
  list(): Pending[] {
    const rows = this.ctx.resources.db.query("SELECT * FROM approval_pending WHERE state = 'waiting' ORDER BY id").all() as Row[];
    return rows.map(pendingOf);
  }

  /**
   * 认文字回答（bot/receive）。认出来并且说话人有权处理，才 handled，不进前台。
   * 无权的人（微信客户、飞书群里的其他人）同样的话当普通消息交给前台；不靠前面有没有分好会话。
   * @param event 收到的消息。
   */
  private onReceive(event: ReceiveEvent): void {
    if (event.handled === true) return;

    const said = rules.parseReply(event.message.text);
    if (said === undefined) return;

    const bot = event.bot.name;
    const speaker = speakerOf(event.message.channel, event.message.address);
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
    const candidates = said.id === undefined ? waiting.filter((item) => item.session !== undefined && item.card.kind !== 'long-run') : waiting;
    const named = said.id === undefined ? undefined : candidates.find((item) => item.id === said.id);
    if (candidates.length === 0 || (said.id !== undefined && named === undefined)) return;

    event.handled = true;
    const targets = named !== undefined ? [named] : said.all === true || candidates.length === 1 ? candidates : [];
    if (targets.length === 0) {
      const text = `现在有 ${String(candidates.length)} 条，要说是哪一条：\n${listText(candidates)}\n回复“同意 号”“拒绝 号”或“全部同意”。`;
      this.answer(bot, candidates[0], text);
      return;
    }
    for (const item of targets) {
      this.decide(item.id, said.approve, `${event.message.channel} 文字回复`);
    }
    const ids = targets.map((item) => `#${String(item.id)}`).join('、');
    this.answer(bot, targets[0], `${said.approve ? '已同意' : '已拒绝'}待确认 ${ids}。`);
  }

  /**
   * 从发起会话上抄客户号和个人身份，登记时写进待确认。
   * @param sessionId 提问的会话；没有就是空的。
   */
  private initiatorOf(sessionId: string | undefined): { customer: string | null; actor: string | null } {
    if (sessionId === undefined) return { customer: null, actor: null };
    const found = this.ctx.sessions.find({ id: sessionId })[0];
    const row = found ?? this.ctx.sessions.open(sessionId).row;
    const meta = row as { customer?: string; channel?: string; address?: unknown };
    const speaker = speakerOf(meta.channel, meta.address);
    const customer = typeof meta.customer === 'string' && meta.customer !== '' ? meta.customer : speaker.customer;
    return { customer: customer === '' ? null : customer, actor: speaker.actor === '' ? null : speaker.actor };
  }

  /**
   * 回用户一句：回给那件事的会话；没有会话的回给这个机器人的前台会话；都没有就只发跟踪点。
   * @param bot 机器人名。
   * @param about 说的是哪一件（可能没有）。
   * @param text 回的话。
   */
  private answer(bot: string, about: Pending | undefined, text: string): void {
    const sessionId = about?.session ?? this.ctx.sessions.find({ bot, kind: 'front' })[0]?.id;
    if (sessionId !== undefined) {
      this.ctx.bots.say(this.ctx.sessions.open(sessionId), text);
      return;
    }
    //T 跟踪：没有会话可回。
    this.ctx.emit('trace', 'Approval.answer', '没有会话可回，这句只记在跟踪里', 'bots.say', { 机器人: bot, 话: text });
  }

  /**
   * 读一行转成 Pending。
   * @param id 号。
   * @returns 没有是 undefined。
   */
  private rowOf(id: number): Pending | undefined {
    const row = this.ctx.resources.db.query('SELECT * FROM approval_pending WHERE id = ?').get(id) as Row | null;
    return row === null ? undefined : pendingOf(row);
  }
}


/**
 * 没给卡片时拼一张普通的：标题、细节，“同意”“拒绝”两个按钮。
 * @param title 标题。
 * @param detail 细节。
 */
function plainCard(title: string, detail: string): Omit<cardUtils.CardData, 'state'> {
  return {
    kind: 'approval', title, reason: '', items: detail === '' ? [] : [{ label: '细节', value: detail }],
    buttons: [{ action: 'approve', label: '同意', style: 'primary' }, { action: 'reject', label: '拒绝', style: 'default' }],
  };
}

/** 卡片上某个按钮的字，结果里用（“终止了”“同意执行”）。 */
function cardLabel(card: cardUtils.CardData, action: 'approve' | 'reject'): string {
  const label = card.buttons.find((button) => button.action === action)?.label;
  return label === undefined ? (action === 'approve' ? '已同意' : '已拒绝') : `点了“${label}”`;
}

/**
 * 命令审批卡片：照审核模型的回答拼。模型没答上来（出错、不是 JSON）时，用命令本身拼一张，风险记“中、审核没写出来”。
 * 风险高时“同意执行”用危险色；调用的工具数据和审核原话放进可展开的 details。
 * @param input 审核的输入。
 * @param script 要跑的脚本。
 * @param answer 审核模型的 JSON。
 * @param why 机器人在干的活。
 */
function reviewCard(input: ReviewInput, script: ReturnType<typeof rules.readScript>, answer: Record<string, unknown> | undefined, why: string): Omit<cardUtils.CardData, 'state' | 'result'> {
  const text = (key: string): string => (typeof answer?.[key] === 'string' ? (answer[key] as string).trim() : '');
  const level = cardUtils.riskLevel(answer?.['risk_level']);
  const items: cardUtils.CardItem[] = [{ label: '命令', value: input.command, code: true }, { label: '目录', value: input.cwd, code: true }];
  if (script !== undefined) items.push({ label: '要跑的脚本', value: script.file, code: true });
  const paths = Array.isArray(answer?.['paths']) ? (answer['paths'] as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
  for (const file of paths) items.push({ label: '会动到', value: file, code: true });
  if (text('what') !== '') items.push({ label: '具体做什么', value: text('what') });
  if (text('advice') !== '') items.push({ label: '审核建议', value: text('advice') });
  return {
    kind: 'approval',
    title: text('title') || '要执行一条命令',
    reason: text('reason') || why || '审核没写出原因，请看命令本身',
    items,
    risk: { level, text: text('risk') || (answer === undefined ? '审核模型没答上来，拿不准' : '审核没写风险') },
    details: { label: '调用的工具数据', data: { 工具: input.kind, 命令: input.command, 目录: input.cwd, 会话: input.session ?? null, 参数: input.payload, 审核原话: answer ?? null } },
    buttons: [
      { action: 'approve', label: '同意执行', style: level === 'high' ? 'danger' : 'primary' },
      { action: 'reject', label: '拒绝', style: 'default' },
    ],
  };
}



/**
 * 从渠道和回话地址取出说话人的客户号、个人身份。飞书按人（不用群号当个人），其余用地址里的 customer。
 * @param channel 渠道名。
 * @param address 渠道的回话地址。
 */
export function speakerOf(channel: string | undefined, address: unknown): { customer: string; actor: string } {
  const where = (typeof address === 'object' && address !== null && !Array.isArray(address) ? address : {}) as Record<string, unknown>;
  const customer = typeof where['customer'] === 'string' ? where['customer'] : '';
  if (channel === 'feishu') {
    const who = String(where['openId'] ?? where['open_id'] ?? '');
    return { customer, actor: who === '' ? customer : `feishu:${who}` };
  }
  return { customer, actor: customer };
}


/**
 * 是不是用户本人：只看渠道写在回话地址里的 owner。本人只在渠道那边判断一次（飞书照插件配置的 people），这里不另存名单。
 * @param address 渠道的回话地址。
 * @returns 写了 owner: true 才是。
 */
export function isOwner(address: unknown): boolean {
  return textModule.fieldOf(address, 'owner') === true;
}


/**
 * 这个人能不能处理这件待确认：用户本人，或登记时的同一发起人。
 * 旧记录没有发起人身份的，只许用户本人处理，避免群里的人靠同一客户号误批。
 * 群里说的、群里提的，只认用户本人：群里的发起人不能自己批自己，绕过用户（2026-11-17，0.7.18）。
 * @param item 待确认。
 * @param speaker 说话人。
 * @param owner 是不是用户本人。
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
function pendingOf(row: Row): Pending {
  const pending: Pending = {
    id: row.id, kind: row.kind, title: row.title, detail: row.detail, payload: JSON.parse(row.payload) as unknown,
    bot: row.bot, state: row.state, askedAt: row.asked_at,
    card: row.card === null ? { ...plainCard(row.title, row.detail), state: row.state } : JSON.parse(row.card) as cardUtils.CardData,
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
  const payload = (typeof pending.payload === 'object' && pending.payload !== null ? pending.payload : {}) as Record<string, unknown>;
  return {
    id: pending.id, bot: pending.bot, sessionId: pending.session ?? '', title: pending.title,
    command: typeof payload['command'] === 'string' ? payload['command'] : pending.title,
    workDir: typeof payload['cwd'] === 'string' ? payload['cwd'] : '',
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
  app.post<{ Params: { id: string }; Body: unknown }>('/api/approvals/:id', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body['approve'] !== 'boolean') return reply.code(400).send({ error: 'approve 要是 true 或 false' });

    const result = approval.decide(Number(request.params.id), body['approve'], 'HTTP');
    if (typeof result === 'string') return reply.code(404).send({ error: result });

    return { ok: true, approval: view(result) };
  });
}


/**
 * 挂上审核和待确认。
 * apply 是 Cordis 插件的入口：inject 里的 resources、bots、sessions 都就绪后 Cordis 调一次（详见 plugins/Index.ts）。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config plugins 段里写给它的：{ model?, thinking?, decision_pass? }，在这里校验一次。
 * @throws 配置不对时抛错。
 */
export function apply(ctx: cordis.Context, config: unknown): void {
  const raw = (config ?? {}) as Record<string, unknown>;
  const model = raw['model'];
  if (model !== undefined && (typeof model !== 'string' || !model.includes('/'))) {
    throw new Error('approval.model 要写成“供应商名/模型 ID”');
  }
  if (typeof model === 'string' && ctx.resources.config.providers[model.slice(0, model.indexOf('/'))] === undefined) {
    throw new Error(`approval.model 的供应商不在 providers 里：${model}`);
  }
  const thinking = raw['thinking'] ?? 'low';
  if (typeof thinking !== 'string') throw new Error('approval.thinking 要是思考档（off、low、medium、high……）');

  //G 决策模型只放行只读、低风险的命令，门槛至少 0.8（用户 11-14；原来默认 0.2，放行过 rd /s /q System32）。
  const pass = raw['decision_pass'] ?? DECISION_PASS;
  if (typeof pass !== 'number' || pass < DECISION_PASS || pass > 1) throw new Error(`approval.decision_pass 要是 ${String(DECISION_PASS)}～1 的数`);

  const approval = new Approval(ctx, { model: model as string | undefined, thinking: thinking as Thinking, decisionPass: pass });

  //M http 是可选的：ctx.inject(服务, 回调) 等于再挂一个小插件，http 在了才调回调、登记接口。
  void ctx.inject(['http'], (sub) => {
    routes(sub.http.app, approval);
  });
}
