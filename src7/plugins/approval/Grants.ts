/**
 * 目录授权（用户 #292、#297、#301“目录授权向下延伸”）：本人把某个人、某个群绑到几个目录，
 * 这些目录和下面的子目录里读写、跑命令（命令照样过审核规则）、发文件都不用再问本人；出了这些目录照旧。
 *   存：表 approval_grants，一行是“谁 → 一个目录”。谁：人是个人身份（飞书 feishu:<open_id>，别的渠道是客户号），
 *     群是群的客户号（feishu:group:<chat_id>），都照 Rules.ts 的 getSpeaker 算。
 *   进来的话（channel/direct、channel/mention、channel/listen，prepend：在 bots 认领、抄地址之前）：
 *     按说话人、按群查表，写进 origin.address.grants.dirs（utils/Workspace.ts 的 getGrantDirs 读）。
 *     外人那一轮升成 builder（approval 照 builder 给工具），工作区换成群绑的目录（群里谁说话都在群的目录里干活），
 *     没有群绑的、原来是 guest 的用他自己的授权目录；地址里原有的 grants 外人一律不认（只有本人的网页消息能带）。
 *   本人这一轮设的授权当轮就生效（用户 #301：说了授权又弹卡片）：写进这场会话现在的回话地址，再按这一轮的 replyRoundKey 记下，
 *     交办出去的后台在 session/before-model（index.ts）照同一个 replyRoundKey 补上。once 的只管这一轮，不存表。
 *   设定入口：模型工具 dir_grant（只有本人那一轮能用；外人的工具档位里没有它，执行前也挡），网页 GET/POST /api/grants。
 * 谁用这些目录：approval 审命令（index.ts 的 getReviewDirs）、file-tools 读写、飞书发文件（utils/Bots.ts 的 resolveSessionPath）。
 * 设计见同目录 说明.md 的「目录授权」一节。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import type { Session, SessionMeta } from '../../Sessions.ts';
import type { Tools } from '../../Tools.ts';
import * as protocol from '../channels/index.ts';
import * as checksModule from '../../utils/Checks.ts';
import * as utils from '../../utils/index.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import * as rules from './Rules.ts';


/** 最近见过的人和群最多记多少个（按名字授权、网页挑人用）；多了丢最早的。 */
const SEEN_MAX = 300;

/** 当轮授权最多记多少轮；多了丢最早的（交办的后台早就补上了）。 */
const TURN_MAX = 200;


/** 一条授权：谁（人或群）绑到哪个目录。 */
export interface Grant {
  /** 号：撤销用。 */
  id: number;
  /** 谁：人是个人身份（飞书 feishu:<open_id>），群是群的客户号（feishu:group:<chat_id>）。 */
  subject: string;
  /** 给人看的名字：群名、人名；设的时候没有就是 subject。 */
  label: string;
  /** 是不是群（照 subject 认，channels 的 isGroup）。 */
  group: boolean;
  /** 目录：入口 checkGrantDir 解开的真实绝对路径。 */
  dir: string;
  /** 谁设的：tool（本人对机器人说的）、http（网页）。 */
  by: string;
  /** 设的毫秒时刻。 */
  createdAt: number;
}

/** 最近见过的一个人或群：按名字授权（dir_grant 的 person）、网页挑人用。 */
export interface SeenSubject {
  /** 人或群的身份，和 Grant.subject 同一种写法。 */
  subject: string;
  /** 名字：群名、说话人名字；没有就是 subject。 */
  label: string;
  /** 是不是群。 */
  group: boolean;
  /** 在哪个聊天见到的（那个聊天的客户号）：按名字找人时先找这个聊天里的。 */
  chat: string;
  /** 最后见到的毫秒时刻。 */
  at: number;
}

/** 表里的一行。 */
interface GrantRow {
  id: number;
  subject: string;
  label: string;
  dir: string;
  by: string;
  created_at: number;
}


/** 目录授权：Approval 构造时建一个，挂在 approval.grants 上。 */
export class Grants {
  /** 最近见过的人和群：键是 subject，按最后见到的先后排；只在内存里，重启清空。 */
  private readonly seen = new Map<string, SeenSubject>();

  /** 本人说的当轮授权：这一轮的 replyRoundKey → 目录；只在内存里。 */
  private readonly turns = new Map<string, string[]>();

  /**
   * 建表，听进来的话（三种都听，prepend：在 bots 认领前把授权写进地址）。
   * @param ctx approval 插件的 Cordis 上下文：数据库、发 trace。
   */
  constructor(private readonly ctx: cordis.Context) {
    //M 建授权表（没有才建）：同一个人或群、同一个目录只一行。
    ctx.resources.db.exec('CREATE TABLE IF NOT EXISTS approval_grants (id INTEGER PRIMARY KEY AUTOINCREMENT,'
      + ' subject TEXT NOT NULL, label TEXT NOT NULL, dir TEXT NOT NULL, by TEXT NOT NULL, created_at INTEGER NOT NULL,'
      + ' UNIQUE (subject, dir))');

    //M 私聊、群里叫了机器人、只听的话都要写：只听的话前台判断接了以后也照这个地址干活。
    ctx.on('channel/direct', (message) => this.applyMessage(message), { prepend: true });
    ctx.on('channel/mention', (message) => this.applyMessage(message), { prepend: true });
    ctx.on('channel/listen', (message) => this.applyMessage(message), { prepend: true });
  }

  /**
   * 进来一句话：记下见过的人和群，按说话人、按群查授权目录，写进这条话的回话地址（bots 认领时照它抄给每个机器人）。
   * @param message 渠道发来的标准消息；会改它的 origin.address（grants、外人的 role、workspace）和 role。
   */
  applyMessage(message: protocol.ChannelMessage): void {
    const address = message.origin.address;
    const channel = message.origin.channel;
    const speaker = rules.getSpeaker(channel, address);
    this.remember(speaker, address);

    //M 群绑的目录：只在群里查（群号就是客户号）。
    let groupDirs: string[] = [];
    if (protocol.isGroup(address)) {
      groupDirs = this.getDirs(speaker.customer);
    }

    //M 人绑的目录：按个人身份查（私聊时个人身份就是客户号）。
    const personDirs = this.getDirs(speaker.actor);

    //==========================================================
    //M 本人：原来带的授权（网页、中控发消息时带的）加上库里的，工具、档位都不动
    //==========================================================
    if (protocol.isOwnerTurn(channel, address)) {
      const ownerDirs = [...workspaceModule.getGrantDirs(address), ...groupDirs, ...personDirs];
      if (ownerDirs.length === 0) return;

      setGrantDirs(address, ownerDirs);
      this.trace(speaker.actor, 'owner', ownerDirs);
      return;
    }

    //==========================================================
    //M 外人：只认库里查到的；查到了就升成 builder，在授权目录里干活
    //==========================================================
    //G 外人地址里原有的 grants 一律不认：只有本人的网页消息能带（web-api 入口 checkGrants）。
    delete address['grants'];
    const dirs = [...groupDirs, ...personDirs];
    if (dirs.length === 0) return;

    //M 记下原来是不是 builder（登记了自己目录的人）：builder 没有群绑的目录时留在他自己的目录里。
    const wasBuilder = protocol.getSpeakerRole(address) === 'builder';
    setGrantDirs(address, dirs);
    address['role'] = 'builder';
    address['owner'] = false;
    message.role = 'builder';

    //M 群绑的优先：群里谁说话，都在群的目录里干活（收到的附件也落进去）。
    if (groupDirs[0] !== undefined) {
      address['workspace'] = groupDirs[0];
      this.trace(speaker.actor, 'builder', dirs);
      return;
    }

    //M 没有群绑的：原来是 guest 的换到他自己的授权目录；原来就是 builder 的留在他登记的目录，授权目录照样能动。
    if (!wasBuilder && personDirs[0] !== undefined) {
      address['workspace'] = personDirs[0];
    }
    this.trace(speaker.actor, 'builder', dirs);
  }

  /**
   * 本人说的当轮授权补进这场会话的回话地址：前台这一轮接下来的每一步、这一轮交办出去的后台都补上。
   * session/before-model（index.ts）每一步先调它，再给工具、审命令。
   * @param session 这一步的会话；可能改它的 row.address.grants。
   */
  applyTurn(session: Session): void {
    //G 这一轮没有当轮授权：不动。
    const row = session.row;
    const dirs = this.getTurnDirs(row);
    if (dirs.length === 0) return;

    //M 补进现在的回话地址（和原有的合在一起，去重）。
    const address = utils.getRecord(row.address);
    const merged = [...workspaceModule.getGrantDirs(address), ...dirs];
    setGrantDirs(address, merged);
    row.address = address;
  }

  /**
   * 这场会话这一轮的当轮授权目录：applyTurn 补地址、审命令（index.ts 的 getReviewDirs，读的是库里的会话记录）都用。
   * @param row 会话记录（内存里的 session.row，或 sessions.find 读出的）。
   * @returns 目录；不是渠道进来的一轮、这一轮没设、地址已经换成外人的都是空数组。
   */
  getTurnDirs(row: SessionMeta): string[] {
    //M 这一轮的键（来源快照的 replyRoundKey）：没有就不是渠道进来的一轮，没有当轮授权。
    const key = getTurnKey(row);
    const dirs = this.turns.get(key);
    if (dirs === undefined) return [];

    //G 当轮授权是本人说的：地址已经换成外人的（群里别人插话），不算。
    if (!protocol.isOwnerTurn(row.channel, row.address)) return [];

    return dirs;
  }

  /**
   * 列出全部授权，按设的先后。
   * @returns 授权清单。
   */
  list(): Grant[] {
    const sql = 'SELECT id, subject, label, dir, by, created_at FROM approval_grants ORDER BY id';
    const rows = this.ctx.resources.db.query(sql).all() as GrantRow[];
    return rows.map(getGrant);
  }

  /**
   * 最近见过的人和群，最近的在前：网页挑人用。
   * @returns 见过的人和群。
   */
  getSeen(): SeenSubject[] {
    return [...this.seen.values()].reverse();
  }

  /**
   * 设一条授权（同一个人或群、同一个目录已经有了就只改名字）。
   * @param subject 谁：人或群的身份（入口查过非空）。
   * @param label 给人看的名字。
   * @param dir 目录：入口 checkGrantDir 解开的真实绝对路径。
   * @param by 谁设的：tool、http。
   * @returns 存好的这一条。
   * 副作用：写表、发 trace。
   */
  add(subject: string, label: string, dir: string, by: string): Grant {
    //M 写一行；同一个人或群、同一个目录已经有了，只改名字。
    const insert = 'INSERT INTO approval_grants (subject, label, dir, by, created_at) VALUES (?, ?, ?, ?, ?)'
      + ' ON CONFLICT (subject, dir) DO UPDATE SET label = excluded.label';
    this.ctx.resources.db.query(insert).run(subject, label, dir, by, Date.now());

    //M 读回这一行交回。
    const select = 'SELECT id, subject, label, dir, by, created_at FROM approval_grants WHERE subject = ? AND dir = ?';
    const row = this.ctx.resources.db.query(select).get(subject, dir) as GrantRow;
    const grant = getGrant(row);

    //T 跟踪：设了一条授权。
    const vars = { action: 'add', id: grant.id, subject, label, dir, by };
    this.ctx.emit('trace', 'Grants.add', 'trace.approval.grants', 'approval_grants INSERT', vars);
    return grant;
  }

  /**
   * 撤一条授权。
   * @param id 授权的号。
   * @returns 真撤掉了是 true；没有这一条是 false。
   * 副作用：删表里一行、发 trace。
   */
  remove(id: number): boolean {
    const result = this.ctx.resources.db.query('DELETE FROM approval_grants WHERE id = ?').run(id);
    const removed = result.changes > 0;

    //T 跟踪：撤了一条授权。
    const vars = { action: 'remove', id, removed };
    this.ctx.emit('trace', 'Grants.remove', 'trace.approval.grants', 'approval_grants DELETE', vars);
    return removed;
  }

  /**
   * 登记模型工具 dir_grant：本人对机器人说“把这个群 / 周周绑到某目录”“这件事我授权了”时用。
   * 不在 Rules.ts 的 READ_ONLY_TOOLS、BUILDER_TOOLS 里：外人那一轮拿不到，执行前也挡；run 里再核一次本人。
   * @param tools 骨架的工具服务（apply 里等 tools 就绪后传进来）。
   */
  registerTool(tools: Tools): void {
    const definition = {
      name: 'dir_grant',
      description: '目录授权（只有用户本人能用）：把这个聊天（群里就是整个群）或聊天里的某个人绑到一个目录，'
        + '这个目录和下面的子目录里读写文件、跑命令、发文件都不用再问用户；用户说“我授权”“这件事你做吧”时也用它（once）。'
        + 'list 列出全部授权，revoke 按号撤销。',
      parameters: piAi.Type.Object({
        action: piAi.Type.Union([piAi.Type.Literal('list'), piAi.Type.Literal('grant'), piAi.Type.Literal('revoke')]),
        dir: piAi.Type.Optional(piAi.Type.String({ description: 'grant：要授权的目录，绝对路径' })),
        person: piAi.Type.Optional(piAi.Type.String({
          description: 'grant：授权给最近说过话的这个人（写名字）；不写是授权给这个聊天',
        })),
        once: piAi.Type.Optional(piAi.Type.Boolean({
          description: 'grant：true 只管这一轮和这一轮交办的后台，不存下来；不写是一直有效，直到 revoke',
        })),
        id: piAi.Type.Optional(piAi.Type.Number({ description: 'revoke：list 里的号' })),
      }, { additionalProperties: false }),
    };
    const tool = {
      definition,
      sessionKinds: ['front', 'work'],
      run: async (args: Record<string, unknown>, session: Session): Promise<string> => {
        const answer = this.runTool(args, session);
        return JSON.stringify(answer);
      },
    };

    //M 登记进骨架的工具表。
    tools.register(tool);
  }

  /**
   * 挂网页接口：GET /api/grants 列授权和最近见过的人、群；POST /api/grants 设（add）、撤（remove）。
   * @param app http 的 Fastify 实例。
   * @param isVerified 这个请求是不是本人（本机或带对的令牌）：http 插件的 Http.isVerified，apply 里传进来。
   */
  mountRoutes(app: fastify.FastifyInstance, isVerified: (request: fastify.FastifyRequest) => boolean): void {
    //M 列授权、最近见过的人和群（网页挑人用）。
    app.get('/api/grants', async () => {
      const items = this.list();
      const seen = this.getSeen();
      return { items, seen };
    });

    //M 设、撤授权：放权限的事只认本人（和 POST /api/channel/send 一样看 isVerified）。
    app.post<{ Body: unknown }>('/api/grants', async (request, reply) => {
      if (!isVerified(request)) return reply.code(403).send({ error: '设目录授权要本人（本机或带令牌）' });

      const body = request.body;
      const action = utils.getStringField(body, 'action');

      //M 撤：号要是正整数，没有这一条回 404。
      if (action === 'remove') {
        const id = utils.getField(body, 'id');
        if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'id 要是正整数' });

        const removed = this.remove(id);
        if (!removed) return reply.code(404).send({ error: `没有这一条授权：${String(id)}` });

        return { ok: true };
      }

      //G 别的动作只有 add。
      if (action !== 'add') return reply.code(400).send({ error: 'action 要是 add 或 remove' });

      //G 谁：非空，最长 200 字。
      const subject = utils.getStringField(body, 'subject').trim();
      if (subject === '' || subject.length > 200) return reply.code(400).send({ error: 'subject 要写人或群的身份' });

      //M 目录在入口查一次（绝对路径、真有这个目录），写错了 checkGrantDir 抛带 400 的错，Fastify 照它回。
      const dir = checksModule.checkGrantDir(utils.getField(body, 'dir'));
      const label = utils.getStringField(body, 'label').trim() || subject;
      const grant = this.add(subject, label, dir, 'http');
      return { ok: true, grant };
    });
  }

  /**
   * 工具 dir_grant 真正干活：核本人，再按 action 列、设、撤。
   * @param args 模型给的参数（Tools.ts 照定义查过类型）。
   * @param session 哪场会话：本人那一轮、现在的聊天和地址。
   * @returns 交回给模型的对象。
   * @throws 不是本人那一轮、目录不对、找不到人、号不对时抛错（模型看到原因）。
   */
  private runTool(args: Record<string, unknown>, session: Session): Record<string, unknown> {
    //G 只有本人那一轮能设：外人不能给自己放权限。
    const row = session.row;
    if (!protocol.isOwnerTurn(row.channel, row.address)) {
      throw new Error('只有用户本人那一轮能设目录授权');
    }
    const action = args['action'];

    //M 列。
    if (action === 'list') return { ok: true, items: this.list() };

    //M 撤：按号。
    if (action === 'revoke') {
      const id = args['id'];
      if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('revoke 要写 id（list 里的号）');

      const removed = this.remove(id);
      if (!removed) throw new Error(`没有这一条授权：${String(id)}`);

      return { ok: true, removed: id };
    }

    //==========================================================
    //M 设：目录先查一次；once 的只当轮生效，不存表
    //==========================================================
    const dir = checksModule.checkGrantDir(args['dir']);
    if (args['once'] === true) {
      this.addTurn(session, dir);
      return { ok: true, once: true, dir };
    }

    //M 存表：先认给谁（这个聊天，或聊天里叫这个名字的人），认不出就抛错、什么都不放开。
    const target = this.getTarget(session, utils.getStringField(args, 'person').trim());
    const grant = this.add(target.subject, target.label, dir, 'tool');

    //M 存下的也当轮就生效：本人刚说完授权，这一轮接着干的活不再弹卡片（用户 #301）。
    this.addTurn(session, dir);
    return { ok: true, grant };
  }

  /**
   * dir_grant 设授权给谁：不写名字是这个聊天（群里就是整个群）；写了名字，在最近见过的人里找。
   * @param session 本人那一轮的会话：现在的聊天。
   * @param person 名字；空串是这个聊天。
   * @returns 谁、给人看的名字。
   * @throws 聊天认不出、名字找不到或有重名时抛错。
   */
  private getTarget(session: Session, person: string): { subject: string; label: string } {
    const address = session.row.address;
    const speaker = rules.getSpeaker(session.row.channel, address);

    //M 不写名字：这个聊天。
    if (person === '') {
      if (speaker.customer === '') throw new Error('认不出这个聊天，没法按聊天授权；写 person，或到网页设置里设');

      const label = utils.getStringField(address, 'chatName') || speaker.customer;
      return { subject: speaker.customer, label };
    }

    //M 写了名字：最近见过的人里叫这个名字的，先找这个聊天里的，再找全部。
    const named = [...this.seen.values()].filter((item) => !item.group && item.label === person);
    const here = named.filter((item) => item.chat === speaker.customer);
    if (here[0] !== undefined && here.length === 1) return here[0];
    if (named[0] !== undefined && named.length === 1) return named[0];

    //G 没见过、或有重名：说清楚，让用户换个说法或到网页上挑。
    if (named.length === 0) throw new Error(`最近没见过叫“${person}”的人说话（重启后要他先说一句），也可以到网页设置里设`);

    throw new Error(`叫“${person}”的人有 ${String(named.length)} 个，分不清是谁，到网页设置里挑`);
  }

  /**
   * 本人说的授权当轮就生效：写进这场会话现在的回话地址，再按这一轮的 replyRoundKey 记下（交办的后台在 applyTurn 补上）。
   * @param session 本人那一轮的会话。
   * @param dir 目录。
   */
  private addTurn(session: Session, dir: string): void {
    //M 现在的地址马上补上：这一轮接下来的工具、审命令马上认。
    const row = session.row;
    const address = utils.getRecord(row.address);
    setGrantDirs(address, [...workspaceModule.getGrantDirs(address), dir]);
    row.address = address;

    //G 不是渠道进来的一轮（没有来源快照）：没有交办的后台要补，记到这里就行。
    const key = getTurnKey(row);
    if (key === '') return;

    //M 按这一轮记下；多了丢最早的一轮。
    const dirs = this.turns.get(key) ?? [];
    this.turns.set(key, [...new Set([...dirs, dir])]);
    const oldest = this.turns.keys().next().value;
    if (this.turns.size > TURN_MAX && oldest !== undefined) {
      this.turns.delete(oldest);
    }
  }

  /**
   * 记下这句话的群和说话人（按名字授权、网页挑人用）。
   * @param speaker 客户号、个人身份（Rules.ts 的 getSpeaker）。
   * @param address 回话地址：群名、说话人名字。
   */
  private remember(speaker: { customer: string; actor: string }, address: Record<string, unknown>): void {
    const at = Date.now();

    //M 群：名字用群名，没有就用群号。
    if (protocol.isGroup(address) && speaker.customer !== '') {
      const label = utils.getStringField(address, 'chatName') || speaker.customer;
      this.see({ subject: speaker.customer, label, group: true, chat: speaker.customer, at });
    }

    //G 认不出人：不记。
    if (speaker.actor === '') return;

    //M 人：名字用说话人的名字，没有就用身份。
    const label = utils.getStringField(address, 'senderName') || speaker.actor;
    this.see({ subject: speaker.actor, label, group: false, chat: speaker.customer, at });
  }

  /**
   * 见过一个人或群：挪到最后（最近），多了丢最早的。
   * @param item 见到的人或群。
   */
  private see(item: SeenSubject): void {
    this.seen.delete(item.subject);
    this.seen.set(item.subject, item);
    const oldest = this.seen.keys().next().value;
    if (this.seen.size > SEEN_MAX && oldest !== undefined) {
      this.seen.delete(oldest);
    }
  }

  /**
   * 一个人或群绑的目录，按设的先后。
   * @param subject 人或群的身份；空串查不到。
   * @returns 目录；没有是空数组。
   */
  private getDirs(subject: string): string[] {
    if (subject === '') return [];

    const sql = 'SELECT dir FROM approval_grants WHERE subject = ? ORDER BY id';
    const rows = this.ctx.resources.db.query(sql).all(subject) as { dir: string }[];
    return rows.map((row) => row.dir);
  }

  /**
   * 发 trace：这句话带上了授权目录（教程插件、/flow/ 看得到）。
   * @param actor 说话人。
   * @param role 这一轮按哪一档：owner、builder。
   * @param dirs 授权目录。
   */
  private trace(actor: string, role: string, dirs: string[]): void {
    const vars = { action: 'apply', actor, role, dirs };
    this.ctx.emit('trace', 'Grants.applyMessage', 'trace.approval.grants', "address['grants'] = { dirs }", vars);
  }
}


/**
 * 这一轮的键：前台读本轮来源快照，后台读所领任务的来源快照（和 ChannelSend.ts 的 channel_send 一样）。
 * @param row 会话记录。
 * @returns 来源快照的 replyRoundKey；没有来源快照是空串。
 */
function getTurnKey(row: SessionMeta): string {
  const snapshot = row.activeSourceSnapshot ?? row.frontTask?.sourceSnapshot;
  return snapshot?.replyRoundKey ?? '';
}


/**
 * 把授权目录写进回话地址（去重，保留先后）。
 * @param address 回话地址（对象）；会改它的 grants。
 * @param dirs 目录。
 */
function setGrantDirs(address: Record<string, unknown>, dirs: string[]): void {
  const unique = [...new Set(dirs)];
  address['grants'] = { dirs: unique };
}


/**
 * 表里一行换成 Grant。
 * @param row 表里的一行。
 */
function getGrant(row: GrantRow): Grant {
  //M 是不是群照 subject 认（feishu:group: 开头）。
  const group = protocol.isGroup({ customer: row.subject });
  return {
    id: row.id,
    subject: row.subject,
    label: row.label,
    group,
    dir: row.dir,
    by: row.by,
    createdAt: row.created_at,
  };
}
