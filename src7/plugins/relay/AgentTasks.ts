/**
 * 外部 AI 任务通道：Claude、Codex、Grok、DSH 这类外部 AI 自己来打招呼、领活、下载附件、交回结果；jmbots 不去操控它们（照 0.4）。
 * 工具 agent_task（前台、后台会话；外人的会话由 approval 拿掉）：list 看接上了谁、会用哪些模型；send 交一件活；status 看一件到哪了。
 * 新协议 v1（11-17，TaskProtocol.ts）：
 *   - send 的每件都写明开不开子代理、用什么模型、执行端的次高思考档、交回物；模型和思考档照执行端打招呼时登记的能力定，
 *     定不了就报错给模型看，不猜档、不换付费模型；
 *   - 任务单存进表的 protocol 列，也写成任务文件夹里的 task.json（机器读）和 task.md（人读），附件放 input/；
 *   - 领取带 claimKey：同一个键重领交回原样，别人领了回 409；
 *   - 交回 result.json 的内容：HTTP 正文的 protocolResult，或执行者写进 result/result.json 由定时扫描收；两条路都走 finish。
 *   - reply:false 的交办无需模型配置。领取时归档，只记送达，不走结果投递。
 * 交回的结果经 bot/request 排进派活会话的结果队列，收到成功回执后再改任务状态：
 *   前台整理后回原渠道，后台看一轮接着做。protocol 是 NULL 的旧任务照旧格式 { ok, text, uploads } 收。
 * 照 0.4 src/capabilities/AgentTasks.ts。设计见同目录 说明.md 的「设计要点」一节（外部任务协议 v1）。
 * relay 的 apply 调 getScanMs 查配置，http 就绪后调 applyAgentTasks 挂上。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as filesModule from '../../utils/Files.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import type * as dispatchModule from '../bots/Dispatch.ts';
import * as checksModule from './Checks.ts';
import * as protocolModule from './TaskProtocol.ts';
import { registerRoutes } from './TaskRoutes.ts';


/** 任务通道要的服务：resources 存表和文件夹；tools 登记工具；http 开接口。 */
export const TASKS_INJECT = ['resources', 'tools', 'http'];

/**
 * 把外部任务结果或转话回信交给派活会话的结果队列。
 * @param ctx 调用方的 Cordis 上下文。
 * @param input 含稳定结果键的投递内容。
 * @returns 机器人投递回执和结果是否不确定。
 */
export async function requestResultDelivery(ctx: cordis.Context, input: dispatchModule.ResultInput) {
  const request = { action: 'accept-result', input } as const;
  const options = {
    timeoutMs: 5000,
    onFallback: (reason: requestEventModule.FallbackReason, detail?: string) => {
      return { requestId: '', ok: false, error: detail ?? `结果投递未获回执（${reason}）` };
    },
  };

  //M 两个入口都以稳定键提交，只有确定收到入队回执才能标为已送。
  const result = await requestEventModule.requestEvent(ctx, 'bot/request', 'bot/result', request, options);
  if (requestEventModule.isUnsure(result)) return { ...result, uncertain: true, error: '结果投递状态不确定' };

  return { ...result, uncertain: false };
}


/** 任务的四种状态。 */
export const STATUSES = ['new', 'taken', 'done', 'failed'] as const;
export type TaskStatus = typeof STATUSES[number];

/** 外部 AI 的名字规则（照 0.4）。 */
export const NAME = /^[A-Za-z0-9_-]{1,40}$/u;


/** 一个外部 AI 的登记。 */
export interface AgentInfo {
  /** 名字。 */
  name: string;
  /** 一句话说会做什么。 */
  description: string;
  /** 最近打招呼的时间，毫秒。 */
  hello: number;
  /** 最近来领活的时间，毫秒；0 是还没来过。 */
  seen: number;
  /** 打招呼时报的能力（会用的模型和思考档、能不能开子代理、怎么交回）；没报过没有这项。 */
  abilities?: checksModule.AgentAbilities;
}


/** 一件活（JSON 形状照 0.4，id 写成字符串）。 */
export interface Task {
  /** 任务号。 */
  id: string;
  /** 交给哪个外部 AI。 */
  agent: string;
  /** 哪个机器人派的。 */
  bot: string;
  /** 派活的会话号：结果交回这里。 */
  sessionId: string;
  /** 一句话标题。 */
  title: string;
  /** 要做什么。 */
  text: string;
  /** 附件：任务文件夹里的相对路径（新协议在 input/ 下）。 */
  files: string[];
  /** 缺省要交回结果；false 的任务在领取时即送达。 */
  reply?: false;
  /** 状态。 */
  status: TaskStatus;
  /** 派的时间，毫秒。 */
  createdAt: number;
  /** 领走的时间，毫秒。 */
  takenAt?: number;
  /** 交回结果或免回信任务送达的时间，毫秒。 */
  doneAt?: number;
  /** 交回的话和文件（文件是任务文件夹 result/ 里的相对路径）。 */
  result?: { text: string; files: string[] };
  /** 新协议：任务单、回话地址、领取键、交回的结果；旧任务没有。 */
  protocol?: protocolModule.Protocol;
}


/** send 收到的（模型给的工具参数，骨架照定义查过）。 */
export interface SendInput extends protocolModule.ExecutionInput {
  /** 交给谁。 */
  agent: string;
  /** 一句话标题。 */
  title: string;
  /** 要做什么：目标、约束、怎么算做完。 */
  text: string;
  /** 附件，@路径，相对机器人工作区。 */
  files: string[];
  /** 缺省等待结果；false 只把内容送到执行端。 */
  reply?: boolean;
  /** 交回物：要交回哪些东西，每项一句。 */
  deliverables: string[];
  /** 派活调用键 <派活会话号>/<callId>（sendText 拼）：同一个键再调回原来那件，不派第二件。 */
  requestKey: string;
}


/** finish 收的：交回的内容。 */
export interface FinishInput {
  /** 旧格式：做成了没有，不写当做成了。新协议不看它，照 result.status。 */
  ok?: boolean;
  /** 旧格式：做了什么、文件是什么。新协议不看它，照 result.summary。 */
  text?: string;
  /** 上传号：PUT /api/uploads/<文件名> 回的 20 位 id，复制进任务的 result/（新协议进 result/artifacts/）。 */
  uploads: string[];
  /** 新协议：校验过的结果（Checks.ts 的 checkTaskResult）；旧任务没有。 */
  result?: checksModule.TaskResult;
}


/** 复制进任务文件夹的一个上传：复制后的文件名、上传的原件（记上了才删）。 */
interface CopiedUpload {
  /** 复制后的文件名。 */
  name: string;
  /** 上传的原件，在 data/tmp/uploads/ 里。 */
  source: string;
}


/** 列任务最多几件。 */
const LIST_MAX = 50;
/** list 每个外部 AI 带几件。 */
const LIST_PER_AGENT = 5;
/** 上传号：20 位数字。 */
const UPLOAD_ID = /^\d{20}$/u;
/** 定时扫 file 交回的任务，默认每 10 秒一次；config 的 scan_ms 可改。 */
const SCAN_MS = 10_000;
/** 状态的中文。 */
const STATUS_WORDS: Record<TaskStatus, string> = { new: '等它来领', taken: '它在做', done: '做完了', failed: '没做成' };


/** 任务通道。 */
export class AgentTasks {
  /** 定时扫描收不了的 result.json：任务号 → 那一版文件的“大小:修改时间”。文件没变就不再试，免得反复报同一个错。 */
  private readonly broken = new Map<string, string>();
  /** 同一任务的 HTTP 交回和文件交回串行处理，避免等待回执时覆盖产物。 */
  private readonly finishing = new Map<number, Promise<Task>>();

  /**
   * 建两张表（老库补新协议的两列）、登记工具 agent_task。
   * @param ctx Cordis 给这个插件的 ctx。
   */
  constructor(private readonly ctx: cordis.Context) {
    const db = ctx.resources.db;
    db.exec('CREATE TABLE IF NOT EXISTS agent_tasks_agents (name TEXT PRIMARY KEY, description TEXT NOT NULL,'
      + ' hello INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0, abilities TEXT)');
    db.exec('CREATE TABLE IF NOT EXISTS agent_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL,'
      + ' bot TEXT NOT NULL, session TEXT NOT NULL,'
      + ' title TEXT NOT NULL, text TEXT NOT NULL, files TEXT NOT NULL, status TEXT NOT NULL,'
      + ' result_text TEXT, result_files TEXT,'
      + ' created_at INTEGER NOT NULL, taken_at INTEGER, done_at INTEGER, protocol TEXT)');

    //M 派活调用键唯一：同一次工具调用（会话号/callId）只能派出一件。旧任务 protocol 是 NULL，唯一索引不管 NULL。
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_request_key ON agent_tasks'
      + " (json_extract(protocol, '$.requestKey'))");

    //M tools.register：登记给前台和后台；模型调它时骨架调 run(参数, 会话, 停止信号, callId)，交回的文字就是工具结果。
    ctx.tools.register({
      definition: {
        name: 'agent_task',
        description: '把一件活交给其他已登记的执行端。'
          + 'list：看接上了哪些 AI、各自会做什么、会用哪些模型（带次高思考档）、最近的任务；'
          + 'send：交一件活，agent、title、text 必写。只是转告时写 reply:false，无需回信。'
          + '要收结果时写 deliverables；model 不写用它登记的第一个，thinking 不写取它登记的次高档'
          + '（它没登记就两样都要写）；要开子代理写 subagents，不开就不写；files 是附件 @路径；'
          + 'status：看一件任务到哪了（agent、id）。交出去以后不用等，先做别的或者先结束，结果到了会接着做。',
        parameters: piAi.Type.Object({
          action: piAi.Type.Union([piAi.Type.Literal('list'), piAi.Type.Literal('send'), piAi.Type.Literal('status')]),
          agent: piAi.Type.Optional(piAi.Type.String({ description: '交给谁（send、status）' })),
          title: piAi.Type.Optional(piAi.Type.String({ description: '一句话标题（send）' })),
          text: piAi.Type.Optional(piAi.Type.String({ description: '要做什么：目标、约束、怎么算做完（send）' })),
          reply: piAi.Type.Optional(piAi.Type.Boolean({ description: '默认 true 需交回，false 领取即送达、无需回信' })),
          deliverables: piAi.Type.Optional(piAi.Type.Array(
            piAi.Type.String(),
            { description: '交回物：需要回信的 send 必写，每项一句' },
          )),
          model: piAi.Type.Optional(piAi.Type.String({ description: '主执行用的模型 ID，照它登记的写法；不写用它登记的第一个（send）' })),
          thinking: piAi.Type.Optional(piAi.Type.String({ description: '主执行的思考档；不写取它登记的次高档（send）' })),
          subagents: piAi.Type.Optional(piAi.Type.Array(piAi.Type.Object({
            name: piAi.Type.String({ description: '子代理叫什么' }),
            responsibility: piAi.Type.String({ description: '它负责什么' }),
            model: piAi.Type.Optional(piAi.Type.String({ description: '它用的模型；不写同主执行' })),
            thinking: piAi.Type.Optional(piAi.Type.String({ description: '它的思考档；不写取次高档' })),
            files: piAi.Type.Optional(piAi.Type.Array(piAi.Type.String(), { description: '它负责改的文件' })),
          }), { description: '要开的子代理，每个写清负责什么；不开就不写（send）' })),
          files: piAi.Type.Optional(piAi.Type.Array(piAi.Type.String(), { description: '附件，@路径，相对工作区（send）' })),
          id: piAi.Type.Optional(piAi.Type.String({ description: '任务号（status）' })),
        }),
      },
      sessionKinds: ['front', 'work'],
      run: (args, session, _signal, callId) => this.run(args, session, callId),
    });
  }

  /**
   * 打招呼：登记或更新一个外部 AI。说明空、能力没报都留旧的；seen 留旧的。
   * @param agent 名字（路由查过）。
   * @param said 说明和能力（Checks.ts 的 checkAgentHello 查过）。
   * @returns 更新后的登记。
   * 副作用：写库。
   */
  hello(agent: string, said: checksModule.AgentHello): AgentInfo {
    //M 能力：报了存 JSON；没报是 NULL，下面 COALESCE 留旧的。
    let abilities: string | null = null;
    if (said.abilities !== undefined) {
      abilities = JSON.stringify(said.abilities);
    }

    //M 没有就插一行，有就更新。
    const sql = 'INSERT INTO agent_tasks_agents (name, description, hello, seen, abilities) VALUES (?, ?, ?, 0, ?)'
      + ' ON CONFLICT(name) DO UPDATE SET hello = excluded.hello,'
      + " description = CASE WHEN excluded.description = '' THEN description ELSE excluded.description END,"
      + ' abilities = COALESCE(excluded.abilities, abilities)';
    this.ctx.resources.db.query(sql).run(agent, said.description.trim(), Date.now(), abilities);
    return this.agents().find((item) => item.name === agent)!;
  }

  /** 全部登记，按名字排。 */
  agents(): AgentInfo[] {
    const sql = 'SELECT name, description, hello, seen, abilities FROM agent_tasks_agents ORDER BY name';
    //M 读取已登记的执行端，转换成任务接口和工具共用的清单。
    const rows = this.ctx.resources.db.query(sql).all() as Record<string, unknown>[];
    return rows.map(getAgent);
  }

  /**
   * 列一个外部 AI 的任务，新的在前。
   * @param agent 名字。
   * @param status 只列这个状态的；不给列全部。
   * @param touch 是不是它自己来领活：是就先记它来过（seen）。
   * @param limit 最多几件。
   */
  list(agent: string, status?: TaskStatus, touch = false, limit = LIST_MAX): Task[] {
    const db = this.ctx.resources.db;
    if (touch) {
      //M 把这次轮询计入最近活跃时间，供执行端列表展示。
      db.query('UPDATE agent_tasks_agents SET seen = ? WHERE name = ?').run(Date.now(), agent);
    }

    //M 拼查询：给了状态就加一个条件。
    let sql = 'SELECT * FROM agent_tasks WHERE agent = ?';
    const values: (string | number)[] = [agent];
    if (status !== undefined) {
      sql += ' AND status = ?';
      values.push(status);
    }
    sql += ' ORDER BY id DESC LIMIT ?';
    values.push(limit);

    //M 按筛选条件取任务记录，转成响应中使用的任务结构。
    const rows = db.query(sql).all(...values) as Record<string, unknown>[];
    return rows.map(getTask);
  }

  /** 一件；没有是 undefined。 */
  get(agent: string, id: number): Task | undefined {
    //M 同时按执行端和任务号查找，限定在该执行端的任务内。
    const query = this.ctx.resources.db.query('SELECT * FROM agent_tasks WHERE id = ? AND agent = ?');
    const row = query.get(id, agent) as Record<string, unknown> | null;
    if (row === null) return undefined;

    //M 把命中的记录还原成包含协议与结果的任务对象。
    return getTask(row);
  }

  /** 任务文件夹：integrations/agents/<名字>/tasks/<号>/…（resources.ensureRuntimeDir 没有就建）。 */
  dir(agent: string, id: number | string, ...more: string[]): string {
    //M 定位该执行端的任务文件，必要时由资源服务创建父目录。
    return this.ctx.resources.ensureRuntimeDir('integrations', 'agents', agent, 'tasks', String(id), ...more);
  }

  /**
   * 派活：查重 → 定执行配置 → 查附件 → 一个事务里插一行拿号、复制附件、写任务单（protocol 列、task.json、task.md）。
   * @param session 派活的会话：结果交回这里。
   * @param input 模型给的参数和派活调用键。
   * @returns 新任务；这个调用键派过的，交回原来那件。
   * @throws 外部 AI 没打过招呼、执行配置定不了（getExecution）、附件不在或越界时抛错，模型看得到。
   * 副作用：写库、写任务文件夹（查重命中时都不写）。
   */
  send(session: Session, input: SendInput): Task {
    //M 同一次工具调用又来一遍（同一个 requestKey，比如重启后重跑）：交回原来那件，不派第二件。
    const sameSql = "SELECT * FROM agent_tasks WHERE json_extract(protocol, '$.requestKey') = ?";
    const same = this.ctx.resources.db.query(sameSql).get(input.requestKey) as Record<string, unknown> | null;
    if (same !== null) {
      const task = getTask(same);

      //T 跟踪：查重命中，没派第二件。
      const sameVars = { taskId: task.id, requestKey: input.requestKey };
      const sameSummary = 'trace.agentTasks.reuse';
      this.ctx.emit('trace', 'AgentTasks.send', sameSummary, 'SELECT agent_tasks by requestKey', sameVars);
      return task;
    }

    //G 外部 AI 要先来打过招呼。
    const agent = this.agents().find((item) => item.name === input.agent);
    if (agent === undefined) throw new Error(`${input.agent} 还没来打过招呼（没接上通道），交不了；用 list 看有哪些`);

    //M 要求交回时才依据登记核对模型和子代理。留言发给已登记的执行端即可。
    let execution: protocolModule.ExecutionSpec | undefined;
    if (input.reply !== false) {
      execution = protocolModule.getExecution(agent, input);
    }

    //G 附件先都找到，再落库（找不到的不留半截任务）。
    const sources = this.getSources(session, input.files);

    //M 一个事务：插一行拿号 → 附件复制进 input/ → 写任务单。中间出错整件不算，执行者看不到半截任务。
    const db = this.ctx.resources.db;
    const create = db.transaction((): number => {
      const insert = 'INSERT INTO agent_tasks (agent, bot, session, title, text, files, status, created_at)'
        + " VALUES (?, ?, ?, ?, ?, '[]', 'new', ?)";
      const inserted = db.query(insert).run(
        agent.name,
        session.row.bot,
        session.row.id,
        input.title,
        input.text,
        Date.now(),
      );
      const id = Number(inserted.lastInsertRowid);
      const names = this.copyInputs(agent.name, id, sources);
      const protocol = this.getProtocol(session, agent, id, input, execution, names);

      //M 任务单存进 protocol 列；同样的内容原子写成 task.json，再写一份可读的 task.md。
      const update = 'UPDATE agent_tasks SET files = ?, protocol = ? WHERE id = ?';
      db.query(update).run(JSON.stringify(names), JSON.stringify(protocol), id);
      const folder = this.dir(agent.name, id);
      filesModule.writeTextAtomic(path.join(folder, 'task.json'), JSON.stringify(protocol.spec, null, 2));
      filesModule.writeTextAtomic(path.join(folder, 'task.md'), protocolModule.getTaskMarkdown(protocol.spec));
      return id;
    });
    const id = create();

    //T 跟踪：派出一件。
    const vars = {
      taskId: id,
      externalAgent: agent.name,
      session: session.row.id,
      attachmentCount: sources.length,
      model: execution?.model,
      thinking: execution?.thinking,
      subagentCount: execution?.subagents.length ?? 0,
    };
    const sendSummary = 'trace.agentTasks.send';
    this.ctx.emit('trace', 'AgentTasks.send', sendSummary, 'INSERT agent_tasks + task.json', vars);

    //M 返回已落库的任务及任务单，用于生成工具回执。
    return this.get(agent.name, id)!;
  }

  /**
   * 认领：一条带条件的 UPDATE 定输赢，两个同时领只有一个成。
   * @param agent 名字。
   * @param id 任务号。
   * @param claimKey 执行者定的领取键；同一个键重领交回原样。新协议的任务没带就替它生成一个。
   * @returns 领到的任务（新协议的带着 claimKey）。
   * @throws 没有这件 404；已经被领了、交了 409。
   * 副作用：写库。
   */
  take(agent: string, id: number, claimKey: string | undefined): Task {
    //G 先按归属读取任务当前状态，任务不存在时停止领取。
    const before = this.get(agent, id);
    if (before === undefined) throw new failureModule.Failure(404, `没有任务 ${String(id)}`);

    //M 同一个领取键重领（上次受理不明又来一次）：交回原样，不算冲突。
    const received = before.reply === false && before.status === 'done';
    const taken = before.status === 'taken' || received;
    const again = claimKey !== undefined && taken && before.protocol?.claimKey === claimKey;
    if (again) return before;

    //M 新协议的任务都要有领取键：执行者没带就替它生成一个，领到的任务里带着，交回时照填。
    let key = claimKey;
    if (key === undefined && before.protocol !== undefined) {
      key = crypto.randomUUID();
    }

    //M 单向任务在确认领取时就落送达时间，状态不会进入等结果的 taken。
    const now = Date.now();
    let status = 'taken';
    let doneAt: number | null = null;
    if (before.reply === false) {
      status = 'done';
      doneAt = now;
    }
    const sql = 'UPDATE agent_tasks SET status = ?, taken_at = ?, done_at = ?,'
      + " protocol = json_set(protocol, '$.claimKey', ?)"
      + " WHERE id = ? AND agent = ? AND status = 'new'";
    const values = [status, now, doneAt, key ?? null, id, agent];

    //M 领取时一并写状态、时间和领取键。
    const query = this.ctx.resources.db.query(sql);

    //M 写入领取后的状态和时间；条件确保每件任务只能领取一次。
    const updated = query.run(...values);
    const task = this.get(agent, id)!;

    //G 没更新到是另一位执行者先领走了，用最新状态构造冲突回执。
    if (updated.changes !== 1) {
      const message = `任务 ${String(id)} 已经是 ${task.status} 了`;
      throw new failureModule.Failure(409, message);
    }

    //T 跟踪：被领走。
    const takeSummary = 'trace.agentTasks.take';
    const takeVars = { taskId: id, externalAgent: agent, claimKey: key };
    this.ctx.emit('trace', 'AgentTasks.take', takeSummary, 'UPDATE agent_tasks', takeVars);
    return task;
  }

  /**
   * 交回：查新旧、查重交 → 上传复制进 result/ → 新协议查产物、写 result.json → 改状态和送回会话放在一个事务里。
   * @param agent 名字。
   * @param id 任务号。
   * @param input 交回的内容：HTTP 正文（TaskRoutes.ts 的 getFinishInput）或扫到的 result.json（scan）。
   * @returns 交回后的任务；同一份内容重交，交回原样。
   * @throws 没有这件 404；新旧格式不对、上传号不对、产物不在或 SHA-256 对不上 400；
   *   没领取、领取键对不上、交过了内容不一样（result_conflict）、交回时状态变了 409；投递失败 503。
   * 副作用：写任务文件夹；结果得到入队回执后落库并清理上传原件。
   */
  async finish(agent: string, id: number, input: FinishInput): Promise<Task> {
    //M 查正在交回的同一件，保持校验和落盘的顺序。
    const pending = this.finishing.get(id);
    const finish = async (): Promise<Task> => {
      if (pending !== undefined) {
        //M 先让上一份交回结束，再按当前任务状态校验重试或冲突。
        await pending.catch(() => undefined);
      }

      //M 校验并投递这一份结果。
      return this.finishTask(agent, id, input);
    };

    //M 在同一任务上串接本次交回，成功和失败都释放本次记录。
    const running = finish();
    this.finishing.set(id, running);
    try {
      return await running;
    } finally {
      if (this.finishing.get(id) === running) {
        this.finishing.delete(id);
      }
    }
  }

  /**
   * 校验产物、请求入队，收到回执后登记任务结果。
   * @param agent 执行端名字。
   * @param id 任务编号。
   * @param input 交回内容与上传引用。
   * @returns 已登记的任务。
   * 副作用：写任务文件、排结果队列，成功后更新任务表。
   */
  private async finishTask(agent: string, id: number, input: FinishInput): Promise<Task> {
    //G 先按归属读任务，未找到时拒绝处理这次交回。
    const task = this.get(agent, id);
    if (task === undefined) throw new failureModule.Failure(404, `没有任务 ${String(id)}`);

    //G 单向任务只认领，任何结果均不写文件、不入会话队列。
    if (task.reply === false) throw new failureModule.Failure(409, '这件任务领取即送达，无需交回');

    //G 新旧对上：新协议的任务要交结果（protocolResult 或 result.json），旧任务只收 { ok, text, uploads }。
    const protocol = task.protocol;
    const result = input.result;
    if (protocol !== undefined && result === undefined) {
      const message = `任务 ${task.id} 是新协议的，要交 protocolResult（或写 result/result.json），`
        + '见 GET /api/agents/guide';
      throw new failureModule.Failure(400, message);
    }
    if (protocol === undefined && result !== undefined) {
      throw new failureModule.Failure(400, `任务 ${task.id} 是旧任务，交 { ok, text, uploads }`);
    }

    //G 已经交过：同一份内容是重交，交回原样；内容不一样报冲突，不覆盖。
    const hash = protocolModule.getHash(result ?? input);
    const finished = task.status === 'done' || task.status === 'failed';
    if (finished && protocol?.hash === hash) return task;

    //G 已结束的任务只接受前面识别出的同内容重试。
    if (finished) throw new failureModule.Failure(409, `result_conflict：任务 ${task.id} 已经交过了，这次内容不一样`);

    //G 新协议：要先领取，任务号和领取键都要对上。
    if (result !== undefined && task.status !== 'taken') {
      throw new failureModule.Failure(409, `任务 ${task.id} 还没领取（${task.status}），先 POST .../take`);
    }
    if (result !== undefined && (result.taskId !== task.id || result.claimKey !== protocol?.claimKey)) {
      throw new failureModule.Failure(409, `任务 ${task.id} 的 taskId 或 claimKey 对不上：要写这件的任务号和领取时的 claimKey`);
    }

    //M 上传的文件复制进 result/（新协议进 result/artifacts/）；记上了才删原件，没记上可以拿同样的上传号重交。
    const resultDir = this.dir(agent, id, 'result');
    let folder = resultDir;
    if (protocol !== undefined) {
      folder = this.dir(agent, id, 'result', 'artifacts');
    }
    //M 将本次上传复制到任务产物目录，后面据此生成回传附件。
    const uploads = this.copyUploads(input.uploads, folder);

    //M 送回会话的文件（绝对路径）：旧任务是上传的那些；新协议是清单里的产物，逐个查在不在、SHA-256 对不对。
    let files = uploads.map((item) => path.join(folder, item.name));
    if (result !== undefined) {
      files = this.checkArtifacts(folder, result);
    }

    //M 新协议：结果原子写成 result/result.json（file 交回的本来就在，换成查过、补了 resultKey 的同一份）。
    if (result !== undefined) {
      filesModule.writeTextAtomic(path.join(resultDir, 'result.json'), JSON.stringify(result, null, 2));
    }

    //M 成没成、话：新协议照结果（completed 算做完，failed、capability_missing 算没做成）；旧任务照交来的，不写当做成了。
    let ok = input.ok ?? true;
    let text = input.text ?? '';
    if (result !== undefined) {
      ok = result.status === 'completed';
      text = result.summary;
    }
    let status: TaskStatus = 'failed';
    if (ok) {
      status = 'done';
    }

    /** 记进表里的交回文件：相对 result/ 的路径。 */
    const names = files.map((file) => path.relative(resultDir, file).replaceAll('\\', '/'));

    /**
     * 改任务状态：带条件（还是交回前那个状态）的 UPDATE；没改成说明别人抢先交了或改了，抛 409。
     * 机器人确认入队后调用；稳定结果键允许在本地登记失败后重试。
     * @param delivery 送回会话的情况，记进 protocol（旧任务没有 protocol，不记）。
     */
    const record = (delivery: string): void => {
      let stored: string | null = null;
      if (protocol !== undefined) {
        stored = JSON.stringify({ ...protocol, result, hash, delivery });
      }
      const sql = 'UPDATE agent_tasks SET status = ?, result_text = ?, result_files = ?, done_at = ?, protocol = ?'
        + ' WHERE id = ? AND agent = ? AND status = ?';
      const values = [status, text, JSON.stringify(names), Date.now(), stored, id, agent, task.status];
      //M 原子更新领取时看到的状态，防止并发交回覆盖已有结果。
      const changes = this.ctx.resources.db.query(sql).run(...values).changes;
      if (changes !== 1) throw new failureModule.Failure(409, `任务 ${task.id} 交回时状态变了（别人交过或改过），没记上`);
    };

    //M 用稳定结果键投递；已经入队的同一份结果允许补记任务状态。
    const resultInput: dispatchModule.ResultInput = {
      key: `agent:${task.id}:result`,
      sessionId: task.sessionId,
      source: { type: 'agent', id: task.id },
      origin: protocol?.origin,
      payload: { text: this.getResultText(task, ok, text, result), files },
    };

    //M 等机器人确认稳定结果键已入队，才能登记本地任务结果。
    const delivered = await requestResultDelivery(this.ctx, resultInput);

    //G 超时保留任务状态和上传原件，按同一结果键核对是否已入队。
    if (delivered.uncertain) {
      const reason = `任务 #${task.id} 的结果投递状态不确定，请按原任务号核对`;
      throw new failureModule.Failure(504, reason);
    }

    //G 确定未送达时保留任务状态和原件，告知执行端可以重试。
    const receipt = delivered.receipt;
    if (!delivered.ok || receipt === undefined) {
      const reason = `任务 #${task.id} 的结果送不回会话 ${task.sessionId}：${delivered.error ?? '未返回投递凭据'}`;
      throw new failureModule.Failure(503, reason);
    }

    let delivery = '已排进会话的结果队列';
    if (receipt.status === 'duplicate') {
      delivery = '会话的结果队列里早有这份';
    }

    //M 入队和已在队列中的回执都能确认结果已经送达。
    record(delivery);

    //M 记上了：删掉上传的原件。
    for (const item of uploads) {
      fs.rmSync(item.source, { force: true });
    }

    //T 跟踪：交回并排进会话的结果队列。
    const done = this.get(agent, id)!;
    const vars = {
      taskId: id,
      externalAgent: agent,
      session: done.sessionId,
      state: done.status,
      file: files.length,
      usesProtocol: protocol !== undefined,
    };
    const finishSummary = 'trace.agentTasks.finish';
    this.ctx.emit('trace', 'AgentTasks.finish', finishSummary, 'bot/request accept-result + UPDATE agent_tasks', vars);
    return done;
  }

  /**
   * 扫一遍选了 file 交回、已经领走的任务：result/result.json 出现了，就照 HTTP 交回一样走 finish。
   * 执行者先写临时文件再改名，所以只认 result.json；坏的、对不上的记下这一版，文件改了再试。apply 里的定时器调。
   * 副作用：见 finish；收不了的写一行错误日志。
   */
  async scan(): Promise<void> {
    const sql = "SELECT * FROM agent_tasks WHERE status = 'taken'"
      + " AND json_extract(protocol, '$.spec.result.returnMode') = 'file'";
    //M 仅扫描已领取且约定从文件交回的任务。
    const rows = this.ctx.resources.db.query(sql).all() as Record<string, unknown>[];
    for (const row of rows) {
      //M 从任务行取归属与编号，定位执行端的结果文件。
      const task = getTask(row);
      const id = Number(task.id);

      //G HTTP 或上次扫描已在交回这件任务，留给这次交回收尾。
      if (this.finishing.has(id)) continue;

      //M 在任务结果目录里找执行端原子写好的交回文件。
      const resultDir = this.dir(task.agent, task.id, 'result');
      const file = path.join(resultDir, 'result.json');

      //M 还没交（没有 result.json）：下次再看。
      if (!fs.existsSync(file)) continue;

      //G 上次收不了、文件也没变：不再试。
      const stat = fs.statSync(file);
      const mark = `${String(stat.size)}:${String(stat.mtimeMs)}`;
      if (this.broken.get(task.id) === mark) continue;

      //M 读出来查一遍，走 finish；收不了记下这一版文件。
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        const result = checksModule.checkTaskResult(raw);
        const input = { uploads: [], result };
        await this.finish(task.agent, id, input);
        this.broken.delete(task.id);
      } catch (error) {
        //G 明确失败或结果不确定都保留结果文件。下轮仍只用原结果键核对。
        if (error instanceof failureModule.Failure && (error.status === 503 || error.status === 504)) {
          console.error(error.message);
          continue;
        }

        this.broken.set(task.id, mark);
        console.error(`任务 #${task.id} 的 result/result.json 收不了：${textModule.getErrorMessage(error)}（文件改了会再试）`);
      }
    }
  }

  /**
   * 查附件：都要在这个机器人的文件夹里、都在。
   * @param session 派活的会话。
   * @param files 模型写的 @路径，相对机器人工作区。
   * @returns 绝对路径。
   * @throws 越出机器人文件夹、不在、不是文件时抛错。
   */
  private getSources(session: Session, files: string[]): string[] {
    //M 从派活会话所属机器人的目录定位可附带的文件。
    const botDir = this.ctx.resources.ensureRuntimeDir('bots', session.row.bot);
    const workspace = path.join(botDir, 'workspace');
    return files.map((file) => {
      const full = path.resolve(workspace, file.replace(/^@/u, ''));
      const back = path.relative(botDir, full);
      if (back.startsWith('..') || path.isAbsolute(back)) throw new Error(`附件只能在这个机器人的文件夹 ${botDir} 里：${file}`);

      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`附件不在：${file}`);

      return full;
    });
  }

  /**
   * 附件复制进任务文件夹的 input/（和 task.json、task.md 分开，不会撞名），重名加序号。
   * @param agent 名字。
   * @param id 任务号。
   * @param sources 附件的绝对路径（getSources 查过）。
   * @returns 任务文件夹里的相对路径 input/<文件名>。
   */
  private copyInputs(agent: string, id: number, sources: string[]): string[] {
    if (sources.length === 0) return [];

    //M 把已校验的输入附件集中放进任务目录，供执行端取用。
    const folder = this.dir(agent, id, 'input');
    const names: string[] = [];
    for (const source of sources) {
      let base = path.basename(source);
      for (let index = 1; names.includes(`input/${base}`); index += 1) {
        base = `${String(index)}_${path.basename(source)}`;
      }
      fs.copyFileSync(source, path.join(folder, base));
      names.push(`input/${base}`);
    }
    return names;
  }

  /**
   * 拼新协议的 Protocol：任务单 + 派活那一刻的回话地址。
   * @param session 派活的会话。
   * @param agent 执行端的登记。
   * @param id 任务号。
   * @param input 模型给的参数。
   * @param execution getExecution 定的执行配置。
   * @param names 附件在任务文件夹里的相对路径。
   */
  private getProtocol(
    session: Session,
    agent: AgentInfo,
    id: number,
    input: SendInput,
    execution: protocolModule.ExecutionSpec | undefined,
    names: string[],
  ): protocolModule.Protocol {
    const row = session.row;

    //M 原前台：受管后台记在 frontTask 里；老的后台看 parent；前台就是它自己。
    const front = row.frontTask?.front ?? row.parent ?? row.id;

    //M 回话地址：受管后台用派活时的，别的用会话现在记的；深拷贝，之后会话换地址也不影响。
    const origin = row.frontTask?.origin ?? { channel: row.channel, address: row.address };

    const base = {
      version: 1 as const,
      kind: 'task' as const,
      taskId: String(id),
      assignedTo: agent.name,
      source: { bot: row.bot, frontSessionId: front, sessionId: row.id },
      workspace: { bot: row.bot, path: row.frontTask?.workspace ?? '.' },
      operation: 'new' as const,
      task: { title: input.title, goal: input.text, inputs: names, deliverables: input.deliverables },
    };
    const context = { origin: structuredClone(origin), requestKey: input.requestKey };
    if (execution === undefined) {
      //M 单向任务的协议仍有任务单、附件和领取键，交回物和模型配置留空。
      const task = { ...base.task, deliverables: [] };
      const spec = { ...base, task, reply: false as const };
      return { spec, ...context };
    }

    const spec: protocolModule.TaskSpec = {
      ...base,
      execution,
      result: {
        format: 'result.json + result.md + artifacts/',
        root: `integrations/agents/${agent.name}/tasks/${String(id)}/result`,
        returnMode: agent.abilities?.returnMode ?? 'http',
      },
    };
    return { spec, ...context };
  }

  /**
   * 上传的文件复制进任务文件夹（文件名去掉上传号前缀，同名覆盖：重交时是同一个文件）。
   * @param uploads 上传号。
   * @param folder 复制到哪。
   * @returns 复制后的文件名和原件。
   * @throws 上传号格式不对、找不到时抛 400。
   */
  private copyUploads(uploads: string[], folder: string): CopiedUpload[] {
    //M 定位上传暂存目录，后面按上传号查找原文件。
    const uploadDir = this.ctx.resources.ensureRuntimeDir('data', 'tmp', 'uploads');
    const present = fs.readdirSync(uploadDir);
    const copied: CopiedUpload[] = [];
    for (const upload of uploads) {
      //G 只接受上传接口签发的格式，避免把任意路径当成上传号。
      if (!UPLOAD_ID.test(upload)) {
        const message = `上传号不对：${upload}（是 PUT /api/uploads/<文件名> 回的 20 位 id）`;
        throw new failureModule.Failure(400, message);
      }

      //G 用上传号匹配暂存文件，找不到时提示执行端重新上传。
      const file = present.find((item) => item.startsWith(`${upload}_`));
      if (file === undefined) throw new failureModule.Failure(400, `没有这个上传：${upload}`);

      const name = path.basename(file.slice(file.indexOf('_') + 1));
      const source = path.join(uploadDir, file);
      fs.copyFileSync(source, path.join(folder, name));
      copied.push({ name, source });
    }
    return copied;
  }

  /**
   * 查新协议清单里的产物：每个都要在 result/artifacts/ 里，SHA-256 对得上。路径安全 checkTaskResult 查过。
   * @param folder result/artifacts/ 的绝对路径。
   * @param result 交回的结果。
   * @returns 产物的绝对路径：送回会话时前台只能 @ 这些文件。
   * @throws 不在、不是文件、SHA-256 对不上时抛 400。
   */
  private checkArtifacts(folder: string, result: checksModule.TaskResult): string[] {
    const files: string[] = [];
    for (const artifact of result.artifacts) {
      const file = path.join(folder, artifact.path);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        //G 清单中缺失或指向非文件的产物无法交回。
        throw new failureModule.Failure(400, `产物不在 result/artifacts/ 里：${artifact.path}（http 交回的先上传，file 交回的先放进去）`);
      }

      const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      //G 内容摘要不一致时中止交回，避免登记错误的产物。
      if (digest !== artifact.sha256) {
        const message = `产物 ${artifact.path} 的 SHA-256 对不上（算出来是 ${digest}）`;
        throw new failureModule.Failure(400, message);
      }

      files.push(file);
    }
    return files;
  }

  /**
   * 送回会话的那段话（payload.text）：谁交回哪件、成没成、说了什么；新协议再加实际怎么执行的、子代理、检查、没做完的、缺的能力。
   * 交回的文件不写在这里：放在 payload.files，处理那一轮由 bots/Dispatch.ts 列出来。
   * @param task 任务。
   * @param ok 成没成。
   * @param text 交回的话。
   * @param result 新协议的结果；旧任务没有。
   */
  private getResultText(task: Task, ok: boolean, text: string, result: checksModule.TaskResult | undefined): string {
    //M 结论：缺能力的单说，它没动手。
    let verdict = '没做成';
    if (ok) {
      verdict = '做完了';
    }
    if (result?.status === 'capability_missing') {
      verdict = '缺能力，没做';
    }
    const lines = [`【${task.agent} 交回任务 #${task.id}「${task.title}」：${verdict}】`, text];

    //M 新协议：实际执行、子代理、检查、没做完的、缺的能力，有才写。
    if (result !== undefined) {
      const actual = result.actualExecution;
      const requested = `${actual.requestedModel} / ${actual.requestedThinking}`;
      const actually = `${actual.actualModel} / ${actual.actualThinking}`;
      lines.push(`实际执行：${actual.host}，主会话 ${actual.sessionId}；要求 ${requested}，实际 ${actually}`);
      for (const item of actual.subagents) {
        lines.push(`子代理 ${item.id}：${item.responsibility}（${item.model} / ${item.thinking}）`);
      }
      for (const item of result.verification) {
        lines.push(`检查 ${item.check}：${item.outcome}`);
      }
      for (const item of result.remaining) {
        lines.push(`没做完：${item}`);
      }
      for (const item of result.capabilityMissing) {
        lines.push(`缺的能力：${item}`);
      }
    }

    lines.push('', `（任务文件夹：integrations/agents/${task.agent}/tasks/${task.id}/，交回的文件在 result/ 里）`);
    return lines.join('\n');
  }

  /** 一行：#N → 外部 AI「标题」状态（派于、交回于）。 */
  private describe(task: Task): string {
    let done = '';
    let status = STATUS_WORDS[task.status];
    if (task.doneAt !== undefined) {
      done = `，交回于 ${time(task.doneAt)}`;
    }
    if (task.doneAt !== undefined && task.reply === false) {
      status = '已送达';
      done = `，领取于 ${time(task.doneAt)}`;
    }
    return `#${task.id} → ${task.agent}「${task.title}」${status}（派于 ${time(task.createdAt)}${done}）`;
  }

  /**
   * 工具 agent_task：照 action 分三支。
   * @param args 工具参数，骨架照定义查过（action 只会是 list、send、status）。
   * @param session 调它的会话。
   * @param callId 模型这次工具调用的调用号（骨架 Tools.execute 给的 call.id）：send 拿它防重复派活。
   * @returns 工具结果，给模型看。
   */
  private run(args: Record<string, unknown>, session: Session, callId: string): string {
    const action = args['action'];

    //M list：接上了谁、会用什么模型、最近的任务。
    if (action === 'list') return this.listText();

    //M status：看一件到哪了。
    if (action === 'status') return this.statusText(args);

    //M 剩下是 send：交一件活。
    return this.sendText(args, session, callId);
  }

  /** list：每个外部 AI 一段：说明、最近来领活、能力、最近几件任务。 */
  private listText(): string {
    //M 从登记表读取执行端，作为任务通道状态列表的起点。
    const agents = this.agents();
    if (agents.length === 0) return '还没有别的 AI 接上任务通道：它们照 GET /api/agents/guide 的说明来打过招呼才会出现在这里';

    const lines: string[] = [];
    for (const agent of agents) {
      let seen = '还没来过';
      if (agent.seen !== 0) {
        //M 把最近轮询时间转为本地时间，供派活者判断执行端是否活跃。
        seen = time(agent.seen);
      }
      lines.push(`- ${agent.name}：${agent.description || '（没说会做什么）'}；最近来领活：${seen}`);
      lines.push(`  ${getAbilitiesText(agent.abilities)}`);

      //M 给每个执行端附上最近任务，展示这份列表时不更新时间。
      for (const task of this.list(agent.name, undefined, false, LIST_PER_AGENT)) {
        lines.push(`  ${this.describe(task)}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * send：取参数、派活，回一句交给谁、按什么配置。同一次调用（同一个 callId）再来，回的是同一件的同一句回执。
   * @param args 工具参数。
   * @param session 派活的会话。
   * @param callId 这次工具调用的调用号。
   * @throws 必写的没写，或 send 抛的错，模型看得到。
   */
  private sendText(args: Record<string, unknown>, session: Session, callId: string): string {
    //G 交付地址、标题和内容必写。仅会交回结果的任务需要交回物。
    const agent = getArg(args, 'agent');
    const title = getArg(args, 'title');
    const text = getArg(args, 'text');
    const deliverables = getList(args['deliverables']);
    const reply = args['reply'] !== false;
    if (agent === undefined || title === undefined || text === undefined) {
      throw new Error('send 要写 agent、title、text');
    }
    if (reply && deliverables.length === 0) {
      throw new Error('send 需要交回结果时要写 deliverables（交回物，至少一项）');
    }

    //M 派活调用键：会话号加调用号，同一场会话里每次调用都不一样，同一次调用重来还是这个。
    const requestKey = `${session.row.id}/${callId}`;

    //M 剩下的可选：附件、模型、思考档、子代理（形状骨架照定义查过）。
    const input: SendInput = {
      agent,
      title,
      text,
      reply,
      deliverables,
      files: getList(args['files']),
      model: getArg(args, 'model'),
      thinking: getArg(args, 'thinking'),
      subagents: (args['subagents'] ?? []) as protocolModule.SubagentInput[],
      requestKey,
    };
    //M 按已整理的参数派活，用保存后的任务生成回执。
    const task = this.send(session, input);

    const spec = task.protocol!.spec;
    if (spec.reply === false) {
      return `已交给 ${task.agent}：任务 #${task.id}「${task.title}」，对方领取即送达，无需回信。`;
    }

    //M 普通任务回执包含模型和思考档，且由执行端交回结果。
    const execution = spec.execution;
    let subagents = '不开子代理';
    if (execution.subagents.length > 0) {
      subagents = `开 ${String(execution.subagents.length)} 个子代理`;
    }
    return `已交给 ${task.agent}：任务 #${task.id}「${task.title}」，附件 ${String(task.files.length)} 个；`
      + `${execution.model}，思考档 ${execution.thinking}（${execution.effortPolicy}），${subagents}。`
      + '它来领、做完会把结果送回这个会话；不用等，先做别的或先结束。';
  }

  /**
   * status：一件任务到哪了；新协议带执行要求和送回会话的情况。
   * @throws 没有这件时抛错，模型看得到。
   */
  private statusText(args: Record<string, unknown>): string {
    //M 从工具参数读取任务归属和号，供下方定位一件任务。
    const agent = getArg(args, 'agent') ?? '';
    const id = Number(getArg(args, 'id'));
    let task: Task | undefined;
    if (Number.isInteger(id)) {
      //M 只有任务号是整数才查询对应执行端的任务。
      task = this.get(agent, id);
    }
    if (task === undefined) throw new Error(`${agent} 没有这件任务`);

    //M 先用简述展示任务状态，再附加执行与交回细节。
    const lines = [this.describe(task)];

    //M 新协议：执行要求和交回物。
    const spec = task.protocol?.spec;
    if (spec?.reply === false) {
      lines.push('领取即送达，无需回信。');
    }
    if (spec !== undefined && spec.reply !== false) {
      const execution = spec.execution;
      const subagentCount = String(execution.subagents.length);
      const deliverables = spec.task.deliverables.join('；');
      lines.push(`要求：${execution.model} / ${execution.thinking}，子代理 ${subagentCount} 个；交回物：${deliverables}`);
    }

    //M 交回了：话、文件、送回会话的情况。
    if (task.result !== undefined) {
      lines.push(`交回的话：${task.result.text}`);
    }
    if (task.result !== undefined && task.result.files.length > 0) {
      const folder = this.dir(task.agent, task.id, 'result');
      const files = task.result.files.map((file) => `@${path.join(folder, file)}`);
      lines.push(`交回的文件：${files.join(' ')}`);
    }
    if (task.protocol?.delivery !== undefined) {
      lines.push(`送回会话：${task.protocol.delivery}`);
    }
    return lines.join('\n');
  }
}


/** 本地时间，到分钟。 */
function time(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false }).slice(0, -3);
}

/** 工具参数里的一项非空文字；没写、空串、不是文字是 undefined。 */
function getArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== 'string' || value === '') return undefined;

  return value;
}

/** 工具参数里的一张文字清单；没写是空的。 */
function getList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.map(String);
}

/** 能力的一行字：会用的模型（档位、次高档）、能不能开子代理、怎么交回。list 用。 */
function getAbilitiesText(abilities: checksModule.AgentAbilities | undefined): string {
  if (abilities === undefined) return '没登记会用的模型和思考档：send 要写 model 和 thinking';

  const models = abilities.models.map((item) => {
    //M 把该模型的次高档附在能力说明里，便于派活方预览默认选择。
    const second = protocolModule.getSecondEffort(item.efforts) ?? '定不了';
    return `${item.id}（档位 ${item.efforts.join('/')}，次高 ${second}）`;
  });
  let subagents = '开不了子代理';
  if (abilities.subagents) {
    subagents = '能开子代理';
  }
  return `会用：${models.join('、')}；${subagents}；交回 ${abilities.returnMode}`;
}

/** 登记表里一行转成登记。 */
function getAgent(row: Record<string, unknown>): AgentInfo {
  const agent: AgentInfo = {
    name: row['name'] as string,
    description: row['description'] as string,
    hello: row['hello'] as number,
    seen: row['seen'] as number,
  };
  if (row['abilities'] !== null) {
    agent.abilities = JSON.parse(row['abilities'] as string) as checksModule.AgentAbilities;
  }
  return agent;
}

/** 任务表里一行转成任务。 */
function getTask(row: Record<string, unknown>): Task {
  const task: Task = {
    id: String(row['id']),
    agent: row['agent'] as string,
    bot: row['bot'] as string,
    sessionId: row['session'] as string,
    title: row['title'] as string,
    text: row['text'] as string,
    files: JSON.parse(row['files'] as string) as string[],
    status: row['status'] as TaskStatus,
    createdAt: row['created_at'] as number,
  };
  if (row['taken_at'] !== null) task.takenAt = row['taken_at'] as number;
  if (row['done_at'] !== null) task.doneAt = row['done_at'] as number;
  if (row['result_text'] !== null) {
    const resultFiles = JSON.parse((row['result_files'] as string | null) ?? '[]') as string[];
    task.result = { text: row['result_text'] as string, files: resultFiles };
  }
  if (row['protocol'] !== null) task.protocol = JSON.parse(row['protocol'] as string) as protocolModule.Protocol;
  if (task.protocol?.spec.reply === false) task.reply = false;
  return task;
}


/**
 * 查任务通道的配置（relay 配置里的 tasks 子键）。relay 的 apply 在入口调一次，查过的值交给 applyAgentTasks。
 * @param raw config.yaml 里 relay 的 tasks：{ scan_ms?: 定时扫 file 交回的间隔，毫秒，不少于 1000 }；不写是 10 秒。
 * @returns 扫描间隔，毫秒。
 * @throws tasks 不是对象、scan_ms 写得不对时抛错，relay 不挂。
 */
export function getScanMs(raw: unknown): number {
  //G tasks 子键：不写，或者是一个对象。
  if (raw === undefined) return SCAN_MS;

  if (typeof raw !== 'object' || raw === null) throw new Error('relay 的 tasks 要写成 { scan_ms: 毫秒 }');

  //G scan_ms：不少于 1000 的整数毫秒。
  const every = (raw as { scan_ms?: unknown }).scan_ms ?? SCAN_MS;
  if (typeof every !== 'number' || !Number.isInteger(every) || every < 1000) {
    throw new Error('relay 的 tasks.scan_ms 要写成不少于 1000 的整数（毫秒）');
  }
  return every;
}


/**
 * 挂上任务通道：建表、登记工具 agent_task、7 个接口，起定时扫描。
 * relay 的 apply 用 ctx.inject(TASKS_INJECT, …) 调：http 就绪后挂，拔掉时一起撤。
 * @param ctx inject 给的子 ctx。
 * @param every 定时扫 file 交回的间隔，毫秒（getScanMs 查过）。
 * 副作用：建表、登记工具和接口、起定时器（ctx.effect 在拔掉时清）。
 */
export function applyAgentTasks(ctx: cordis.Context, every: number): void {
  //M 建立任务服务，再把执行端接口接到同一个服务实例。
  const tasks = new AgentTasks(ctx);
  registerRoutes(ctx, tasks);

  //M 定时扫 file 交回的任务；ctx.effect 在插件被拔掉时清定时器。
  ctx.effect(() => {
    const timer = setInterval(() => {
      //M 从文件收结果时等待投递回执，扫描异常写日志供下次排查。
      void tasks.scan().catch((error: unknown) => console.error(`扫描任务结果失败：${textModule.getErrorMessage(error)}`));
    }, every);
    return () => clearInterval(timer);
  });
}
