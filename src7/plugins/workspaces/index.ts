/**
 * 工作区：一个机器人可以有好几个工作区，名字可以重复，每个有唯一 ID（crypto.randomUUID），归属某个机器人。服务 ctx.workspaces。
 * 自有表 workspaces：一行一个工作区。目录登记以后不改；改名只改 name，归档只改 status，都不搬、不删文件。
 * 旧目录原地登记，不搬不删：
 *   - bots/<机器人>/workspace/ 是这个机器人的 private 默认工作区（ensureDefault，bots 建机器人时调）；
 *   - 机器人配置 workspaces 里登记的目录（比如源码仓库）登记成 private 工作区，只给本人（bots 建机器人时调 resolve 登记）；
 *   - 外人（builder、guest）的根是渠道写在回话地址里的目录（utils/Workspace.ts 的 getWorkspace），第一次用到时登记成他那个范围的默认；
 *   - hand_session 旧 workspace 参数给的相对路径，第一次用到时原地登记（resolve 的 legacyDirectory）。
 * 谁能看、能用：本人（不是 builder、guest）能看、能用这个机器人全部的工作区；外人只看、只用自己范围（scope_key）里的。
 * 模型工具 workspace（只给前台）：create、get、list、rename、archive；create、rename、archive 只给本人。
 * 发的事件：workspaces/changed（created、renamed、archived），存库以后发。
 * 设计和做法的为什么见同目录 说明.md 的「设计要点」一节。
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';
import * as filesModule from '../../utils/Files.ts';
import * as utils from '../../utils/index.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import * as protocol from '../channels/index.ts';


/** 插件名。 */
export const name = 'workspaces';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.1.0：getAccess 多收渠道名，是不是本人改问 channels 的 isOwnerTurn（删 isNonOwnerSpeaker），判断不变。
export const version = '1.1.0';

/** 用到的服务：resources 建表、算目录；tools 登记工具 workspace。 */
export const inject = ['resources', 'tools'];


declare module 'cordis' {
  interface Context {
    /** 工作区服务，实现在 src7/plugins/workspaces/index.ts。bots 建机器人时登记默认工作区，前台派后台时选工作区。 */
    workspaces: Workspaces;
  }
  interface Events {
    /**
     * 工作区新建、改名、归档了（存库以后发）。重复登记、改成同名、再归档一次不发。
     * 谁发：src7/plugins/workspaces/index.ts 的 Workspaces.emitChanged
     * 谁接：暂无
     */
    'workspaces/changed'(change: WorkspaceChange): void;
  }
}


/** 一个工作区。 */
export interface Workspace {
  /** 唯一 ID（crypto.randomUUID）；不从名字、目录、机器人名推。 */
  id: string;
  /** 归属哪个机器人。 */
  bot: string;
  /** 名字，只用来显示；同一个机器人里也可以重复。 */
  name: string;
  /** 目录：运行时目录里的存相对路径（/ 隔开），外面的（配置登记的源码仓库）存绝对路径。登记以后不改。 */
  directory: string;
  /** 范围：private 是本人的；外人的是 dir:<他的根目录>。 */
  scopeKey: string;
  /** 是不是这个机器人、这个范围的默认工作区；默认的不能归档。 */
  isDefault: boolean;
  /** active 能用；archived 归档了，不能新派活，已经绑定的后台照样接着用。 */
  status: 'active' | 'archived';
  /** 登记的时刻，毫秒。旧目录是登记那一刻，不是目录建的时候。 */
  createdAt: number;
  /** 最后改名、归档的时刻，毫秒。 */
  updatedAt: number;
}


/** 谁在用工作区：从会话的回话地址算（getAccess），模型填不了。 */
export interface WorkspaceAccess {
  /** 哪个机器人。 */
  bot: string;
  /** 是不是本人（channels 的 isOwnerTurn）。 */
  owner: boolean;
  /** 范围键：本人是 private；外人是 dir:<他的根目录>。 */
  scopeKey: string;
  /** 这个范围的根目录，绝对路径（utils/Workspace.ts 的 getWorkspace 算的）：外人是地址里他自己的目录，本人是机器人的默认工作区。旧 workspace 相对路径照它落。 */
  root: string;
}


/** resolve 选哪个工作区：都不写是这个范围的默认工作区；workspaceId 写了就不看旧目录。 */
export interface WorkspaceSelection {
  /** 按 ID 选。 */
  workspaceId?: string;
  /** 旧目录，绝对路径：调用方已经查过在范围里（inside）或是配置里登记的。这个范围没登记过就原地登记一条。 */
  legacyDirectory?: string;
  /** 旧目录第一次登记时用的名字；不写用目录最后一段。 */
  legacyName?: string;
  /** 已归档的也给：只给已经绑定过的后台接着用，模型填不了。 */
  allowArchived?: boolean;
}


/** resolve 交回的：工作区，和能直接用的目录。 */
export interface ResolvedWorkspace {
  /** 工作区。 */
  workspace: Workspace;
  /** 目录，绝对路径。 */
  directory: string;
}


/** 事件 workspaces/changed 的数据：不带目录。 */
export interface WorkspaceChange {
  /** 哪个工作区。 */
  workspaceId: string;
  /** 归属哪个机器人。 */
  bot: string;
  /** 新建（含旧目录第一次登记）、改名、归档。 */
  action: 'created' | 'renamed' | 'archived';
}


/** 带错误码的错：工具照它交回 { ok: false, error: { code, message } }；前台派活时原样抛给模型看。 */
export class WorkspaceError extends Error {
  /**
   * @param code 错误码：workspace_not_found、workspace_forbidden、workspace_archived、
   *   workspace_invalid_name、workspace_default_protected。
   * @param reason 一句话原因；不带别的工作区的名字、目录。
   */
  constructor(readonly code: string, readonly reason: string) {
    super(`${code}：${reason}`);
  }
}


/** 表里的一行，列名照表。 */
interface WorkspaceRecord {
  /** 见 Workspace.id。 */
  id: string;
  /** 见 Workspace.bot。 */
  bot: string;
  /** 见 Workspace.name。 */
  name: string;
  /** 见 Workspace.directory。 */
  directory: string;
  /** 见 Workspace.scopeKey。 */
  scope_key: string;
  /** 1 是默认，0 不是。 */
  is_default: number;
  /** active 或 archived。 */
  status: string;
  /** 见 Workspace.createdAt。 */
  created_at: number;
  /** 见 Workspace.updatedAt。 */
  updated_at: number;
}


/** 新登记一条要给的：ID 由调用方先生成（新建的要拿它建目录）。 */
type WorkspaceDraft = Omit<Workspace, 'status' | 'createdAt' | 'updatedAt'>;


/** 本人的范围键。 */
const PRIVATE = 'private';

/** 默认工作区的名字。 */
const DEFAULT_NAME = '默认工作区';


/** 工作区服务。 */
export class Workspaces extends cordis.Service {
  /**
   * workspaces 插件自己的 ctx。别的插件调 ctx.workspaces 的方法时，this.ctx 是调用方的 ctx（Cordis 服务的规矩），本类一律用它。
   */
  private readonly home: cordis.Context;

  /**
   * 建表 workspaces 和三个索引，登记工具 workspace。
   * @param ctx Cordis 给 workspaces 插件的 ctx。
   */
  constructor(ctx: cordis.Context) {
    //M 登记成 Cordis 服务 workspaces，别的插件用 ctx.workspaces 取；自己的 ctx 记在 home 上，方法里一律用它。
    super(ctx, 'workspaces');
    this.home = ctx;

    //M 一行一个工作区；列的意思见 Workspace。
    const db = ctx.resources.db;
    db.exec('CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY NOT NULL, bot TEXT NOT NULL,'
      + ' name TEXT NOT NULL,'
      + ' directory TEXT NOT NULL, scope_key TEXT NOT NULL, is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),'
      + " status TEXT NOT NULL CHECK (status IN ('active', 'archived')),"
      + ' created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');

    //M 每个机器人每个范围只有一个默认；同一个范围同一个目录只登记一条；列清单按机器人、状态、登记先后。
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS workspaces_default ON workspaces (bot, scope_key) WHERE is_default = 1');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS workspaces_path_scope ON workspaces (bot, directory, scope_key)');
    db.exec('CREATE INDEX IF NOT EXISTS workspaces_bot_status ON workspaces (bot, status, created_at, id)');

    //M workspace：前台管工作区。后台会话的回话地址里 workspace 已换成干活的目录，从它算不出外人的范围，所以只给前台。
    this.home.tools.register({
      definition: {
        name: 'workspace',
        description: '管这个机器人的工作区（派活时 hand_session 写 workspaceId 选在哪个工作区干）。'
          + 'list：列工作区（ID、名字、目录、是不是默认）；get：看一个（id）；create：新建一个（name，名字可以重复，按 ID 认）；'
          + 'rename：改名（id、name）；archive：归档（id，不删文件，归档的不能再派新活，默认的不能归档）。'
          + 'create、rename、archive 只有本人能用。',
        parameters: piAi.Type.Object({
          action: piAi.Type.Union([
            piAi.Type.Literal('list'),
            piAi.Type.Literal('get'),
            piAi.Type.Literal('create'),
            piAi.Type.Literal('rename'),
            piAi.Type.Literal('archive'),
          ]),
          id: piAi.Type.Optional(piAi.Type.String({ description: '工作区 ID（get、rename、archive）' })),
          name: piAi.Type.Optional(piAi.Type.String({ description: '名字（create、rename）' })),
          includeArchived: piAi.Type.Optional(piAi.Type.Boolean({ description: '归档的也列出来（list）；不写不列' })),
        }),
      },
      sessionKinds: ['front'],
      //M 模型调工具时转给 run：照 action 分派，出错换成 { ok: false, error } 交回模型。
      run: (args, session) => this.run(args, session),
    });
  }

  /**
   * 谁在用：从渠道和回话地址算机器人、是不是本人、范围键、范围的根目录。
   * @param bot 机器人名（会话的 row.bot）。
   * @param channel 渠道名（会话的 row.channel）；没有渠道（建机器人时登记、内部会话）当本人。
   * @param address 回话地址（会话的 row.address）。是不是本人照 channels 的 isOwnerTurn 判。
   * @returns 访问身份；交给本服务别的方法。
   */
  getAccess(bot: string, channel: string | undefined, address: unknown): WorkspaceAccess {
    //M 本人：范围 private，根是机器人的默认工作区。
    const home = this.getHome(bot);
    const owner = protocol.isOwnerTurn(channel, address);
    if (owner) return { bot, owner, scopeKey: PRIVATE, root: home };

    //M 外人：根是地址里写的他自己的目录（飞书给 builder、guest 写的；没写落回默认工作区，和现在一样），范围就是这个根。
    const root = workspaceModule.getWorkspace(home, address);
    const scopeKey = `dir:${this.getStored(root)}`;
    return { bot, owner, scopeKey, root };
  }

  /**
   * 新建一个工作区：目录是 bots/<机器人>/workspaces/<ID>/，范围 private。只给本人。
   * @param input 名字（去掉首尾空白后不能空，可以和别的重名）。
   * @param access 谁在建。
   * @returns 新的工作区。
   * @throws workspace_forbidden（不是本人）、workspace_invalid_name。
   * 副作用：建目录、写库、发 workspaces/changed。
   */
  create(input: { name: string }, access: WorkspaceAccess): Workspace {
    //G 只给本人。
    if (!access.owner) throw new WorkspaceError('workspace_forbidden', '只有本人能新建工作区');

    //M ID 先生成，目录照 ID 建（resources.ensureRuntimeDir 没有就建）；名字只用来显示。
    const workspaceName = getName(input.name);
    const id = crypto.randomUUID();
    const full = this.home.resources.ensureRuntimeDir('bots', access.bot, 'workspaces', id);

    //M 拼一条新登记：目录换成存法（运行时目录里存相对路径），范围 private，不是默认。
    const draft: WorkspaceDraft = {
      id,
      bot: access.bot,
      name: workspaceName,
      directory: this.getStored(full),
      scopeKey: PRIVATE,
      isDefault: false,
    };

    //M 写库并发 workspaces/changed（created），交回新的工作区。
    return this.insert(draft);
  }

  /**
   * 按 ID 取一个工作区；归档的也给。
   * @param id 工作区 ID。
   * @param access 谁在看。
   * @returns 工作区。
   * @throws workspace_not_found、workspace_forbidden（别的机器人的、外人看别的范围的）。
   */
  get(id: string, access: WorkspaceAccess): Workspace {
    //G 查有没有、是不是这个机器人的、外人是不是自己范围的；不合格直接抛。
    return this.getAllowed(id, access);
  }

  /**
   * 列这个机器人的工作区：本人看全部范围，外人只看自己范围的；按登记先后。
   * @param access 谁在看。
   * @param input includeArchived：归档的也列；不写不列。
   * @returns 工作区清单。
   */
  list(access: WorkspaceAccess, input: { includeArchived?: boolean } = {}): Workspace[] {
    let sql = 'SELECT * FROM workspaces WHERE bot = ?';
    const values: string[] = [access.bot];

    //M 外人：只列自己范围的。
    if (!access.owner) {
      sql += ' AND scope_key = ?';
      values.push(access.scopeKey);
    }

    //M 不要归档的：只列 active。
    if (input.includeArchived !== true) {
      sql += " AND status = 'active'";
    }

    //M 按登记顺序执行筛选，再把库行转成工作区清单。
    sql += ' ORDER BY created_at, id';
    const records = this.home.resources.db.query(sql).all(...values) as WorkspaceRecord[];
    return records.map(getWorkspace);
  }

  /**
   * 改名：只改 name 和 updated_at；ID、目录、范围、归属不变。归档的也能改。只给本人。
   * @param id 工作区 ID。
   * @param name 新名字（去掉首尾空白后不能空）。
   * @param access 谁在改。
   * @returns 改完的工作区；和原来同名就原样交回，不发事件。
   * @throws workspace_forbidden、workspace_not_found、workspace_invalid_name。
   * 副作用：写库、发 workspaces/changed。
   */
  rename(id: string, name: string, access: WorkspaceAccess): Workspace {
    //G 只给本人。
    if (!access.owner) throw new WorkspaceError('workspace_forbidden', '只有本人能改工作区的名字');

    //G 检查工作区归属，并把新名字整理成可保存的非空名称。
    const workspace = this.getAllowed(id, access);
    const workspaceName = getName(name);

    //G 同名：什么都不改。
    if (workspaceName === workspace.name) return workspace;

    //M 把新名字和更新时间写回原工作区。
    const now = Date.now();
    const values = [workspaceName, now, workspace.id];
    const update = this.home.resources.db.query('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?');
    update.run(...values);

    //M 写库成功后通知监听者名称已变更，并交回更新后的对象。
    const renamed: Workspace = { ...workspace, name: workspaceName, updatedAt: now };
    this.emitChanged(renamed, 'renamed');
    return renamed;
  }

  /**
   * 归档：不能再派新活；不搬、不删目录，已经绑定的后台照样接着用。默认的不能归档。只给本人。
   * @param id 工作区 ID。
   * @param access 谁在归档。
   * @returns 归档后的工作区；已经归档过就原样交回，不发事件。
   * @throws workspace_forbidden、workspace_not_found、workspace_default_protected。
   * 副作用：写库、发 workspaces/changed。
   */
  archive(id: string, access: WorkspaceAccess): Workspace {
    //G 只给本人。
    if (!access.owner) throw new WorkspaceError('workspace_forbidden', '只有本人能归档工作区');

    //G 确认工作区在当前身份可操作的范围内，再判断能否归档。
    const workspace = this.getAllowed(id, access);

    //G 默认的不能归档；已经归档过的原样交回。
    if (workspace.isDefault) throw new WorkspaceError('workspace_default_protected', '默认工作区不能归档');

    if (workspace.status === 'archived') return workspace;

    //M 持久化归档状态，给后续派活检查使用。
    const now = Date.now();
    const values = [now, workspace.id];
    const update = this.home.resources.db
      .query("UPDATE workspaces SET status = 'archived', updated_at = ? WHERE id = ?");
    update.run(...values);

    //M 写库成功后通知监听者工作区已归档。
    const archived: Workspace = { ...workspace, status: 'archived', updatedAt: now };
    this.emitChanged(archived, 'archived');
    return archived;
  }

  /**
   * 定下在哪个工作区干，交回能直接用的目录。前台派后台（bots/Dispatch.ts 的 getWorkspace）、bots 登记配置里的目录调。
   *   - 写了 workspaceId：查归属和范围，归档的只在 allowArchived 时给；
   *   - 写了 legacyDirectory：就是这个范围的根 → 默认工作区；别的这个范围登记过就用那条，没登记过原地登记一条；
   *   - 都没写：这个范围的默认工作区（本人是 bots/<机器人>/workspace/，外人是他的根目录；没登记过就登记）。
   * @param access 谁在用。
   * @param selection 选哪个，见 WorkspaceSelection。
   * @returns 工作区和绝对目录。
   * @throws workspace_not_found、workspace_forbidden、workspace_archived。
   * 副作用：旧目录、外人的默认第一次用到时写库、发 workspaces/changed。
   */
  resolve(access: WorkspaceAccess, selection: WorkspaceSelection = {}): ResolvedWorkspace {
    const id = selection.workspaceId ?? '';
    const legacy = selection.legacyDirectory ?? '';
    const allowArchived = selection.allowArchived === true;

    //M 按 ID 选：查归属和范围；归档的不给新活。
    if (id !== '') {
      const chosen = this.getAllowed(id, access);
      return this.getResolved(chosen, allowArchived);
    }

    //M 没写旧目录，或旧目录就是这个范围的根（写的 '.'、'./' 这类）：这个范围的默认工作区，不另登记。
    const directory = this.getStored(legacy || access.root);
    const root = this.getStored(access.root);
    if (directory === root) {
      const fallback = this.getDefault(access);
      return this.getResolved(fallback, allowArchived);
    }

    //M 别的旧目录：这个范围登记过就用那条，没登记过原地登记一条（不搬、不建目录）。
    const legacyName = selection.legacyName || path.basename(legacy);
    const registered = this.register(access.bot, access.scopeKey, directory, legacyName, false);
    return this.getResolved(registered, allowArchived);
  }

  /**
   * 这个机器人的 private 默认工作区：bots/<机器人>/workspace/，原地登记，不搬不删。按目录认，反复调交回同一条。
   * bots 建机器人（Bot 的构造函数）时调。
   * @param bot 机器人名（bots 校验过的）。
   * @returns 默认工作区。
   * 副作用：目录没有就建；第一次调时写库、发 workspaces/changed。
   */
  ensureDefault(bot: string): Workspace {
    //M 找到机器人自己的默认工作区目录，确保第一次使用时目录存在。
    const full = this.getHome(bot);
    //M 先建机器人的默认工作区，再登记。
    filesModule.ensureDir(full);

    //M 将目录转成存储用路径，复用同一范围内已有的默认登记。
    const directory = this.getStored(full);
    return this.register(bot, PRIVATE, directory, DEFAULT_NAME, true);
  }

  /**
   * 工具 workspace：照 action 调 create、get、list、rename、archive。
   * @param args 工具参数，骨架照定义校验过。
   * @param session 调它的前台：从它的 row.bot、row.address 算谁在用。
   * @returns JSON：{ ok: true, workspace } 或 { ok: true, items }；出错 { ok: false, error: { code, message } }。
   */
  private run(args: Record<string, unknown>, session: Session): string {
    //M 从会话身份和工具参数整理出动作、目标及访问范围。
    const access = this.getAccess(session.row.bot, session.row.channel, session.row.address);
    const action = utils.getStringField(args, 'action');
    const id = utils.getStringField(args, 'id');
    const workspaceName = utils.getStringField(args, 'name');
    const includeArchived = args['includeArchived'] === true;

    try {
      //M 在当前身份的访问范围内执行动作，并把成功结果交回工具调用者。
      const result = this.runAction(action, id, workspaceName, includeArchived, access);
      const done = { ok: true, ...result };
      return JSON.stringify(done);
    } catch (error) {
      //G 出错：交回错误码和一句话，原因里不带别的工作区的名字、目录。
      let code = 'workspace_error';
      let message = textModule.getErrorMessage(error);
      if (error instanceof WorkspaceError) {
        code = error.code;
        message = error.reason;
      }
      const failed = { ok: false, error: { code, message } };
      return JSON.stringify(failed);
    }
  }

  /**
   * 工具的一个 action 做什么。
   * @param action list、get、create、rename、archive（骨架照定义查过，只会是这几个）。
   * @param id 工作区 ID；没写是空串（get、rename、archive 会报 workspace_not_found）。
   * @param workspaceName 名字；没写是空串（create、rename 会报 workspace_invalid_name）。
   * @param includeArchived list 要不要带归档的。
   * @param access 谁在用。
   * @returns { workspace } 或 { items }。
   */
  private runAction(
    action: string,
    id: string,
    workspaceName: string,
    includeArchived: boolean,
    access: WorkspaceAccess,
  ): { workspace: Workspace } | { items: Workspace[] } {
    //M 将创建结果放进单个工作区的返回结构。
    if (action === 'create') return { workspace: this.create({ name: workspaceName }, access) };

    //M 按当前访问范围读取指定工作区。
    if (action === 'get') return { workspace: this.get(id, access) };

    //M 按指定编号改名，并交回改名后的记录。
    if (action === 'rename') return { workspace: this.rename(id, workspaceName, access) };

    //M 按指定编号归档，并交回归档后的记录。
    if (action === 'archive') return { workspace: this.archive(id, access) };

    //M 剩下的是 list。
    return { items: this.list(access, { includeArchived }) };
  }

  /**
   * 按 ID 取一个这个身份能碰的工作区。get、rename、archive、resolve 共用。
   * @param id 工作区 ID。
   * @param access 谁在用。
   * @throws workspace_not_found（没有）、workspace_forbidden（别的机器人的、外人碰别的范围的）。
   */
  private getAllowed(id: string, access: WorkspaceAccess): Workspace {
    //G 先按编号定位记录，缺失时结束操作并报告原因。
    const query = this.home.resources.db.query('SELECT * FROM workspaces WHERE id = ?');
    const record = query.get(id) as WorkspaceRecord | null;
    if (record === null) throw new WorkspaceError('workspace_not_found', `没有工作区 ${id}`);

    //G 别的机器人的；外人碰别的范围的（比如本人的私有工作区）→ 不给，也不说它叫什么、在哪。
    const workspace = getWorkspace(record);
    const ours = workspace.bot === access.bot;
    const inScope = access.owner || workspace.scopeKey === access.scopeKey;
    if (!ours || !inScope) throw new WorkspaceError('workspace_forbidden', `不能用工作区 ${id}`);

    return workspace;
  }

  /**
   * 这个范围的默认工作区：本人是 ensureDefault；外人是他的根目录，没登记过就登记成他范围的默认。
   * @param access 谁在用。
   */
  private getDefault(access: WorkspaceAccess): Workspace {
    //M 本人使用机器人自己的私有默认工作区。
    if (access.owner) return this.ensureDefault(access.bot);

    //M 外部会话使用身份范围的根目录，首次访问时登记默认工作区。
    const directory = this.getStored(access.root);
    return this.register(access.bot, access.scopeKey, directory, DEFAULT_NAME, true);
  }

  /**
   * 原地登记一个目录：这个机器人、这个范围登记过这个目录就交回那条（不改名字），没有就登记一条新的。
   * @param bot 机器人名。
   * @param scopeKey 范围键。
   * @param directory 存法的目录（getStored 算的）。
   * @param workspaceName 第一次登记时用的名字。
   * @param isDefault 是不是这个范围的默认。
   * 副作用：第一次登记时写库、发 workspaces/changed。
   */
  private register(
    bot: string,
    scopeKey: string,
    directory: string,
    workspaceName: string,
    isDefault: boolean,
  ): Workspace {
    //G 先找同一机器人与范围下已登记的目录，重复使用时保留原编号。
    const sql = 'SELECT * FROM workspaces WHERE bot = ? AND directory = ? AND scope_key = ?';
    const query = this.home.resources.db.query(sql);
    const found = query.get(bot, directory, scopeKey) as WorkspaceRecord | null;
    if (found !== null) return getWorkspace(found);

    const draft: WorkspaceDraft = {
      id: crypto.randomUUID(),
      bot,
      name: workspaceName,
      directory,
      scopeKey,
      isDefault,
    };

    //M 目录首次使用时将新编号和范围写进登记表。
    return this.insert(draft);
  }

  /**
   * 写进表：状态 active，登记、更新时刻都是现在。
   * @param draft ID、归属、名字、目录、范围、是不是默认。
   * @returns 写进去的工作区。
   * 副作用：写库、发 workspaces/changed（created）。
   */
  private insert(draft: WorkspaceDraft): Workspace {
    const now = Date.now();
    const workspace: Workspace = { ...draft, status: 'active', createdAt: now, updatedAt: now };

    const sql = 'INSERT INTO workspaces'
      + ' (id, bot, name, directory, scope_key, is_default, status, created_at, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const values = [
      workspace.id,
      workspace.bot,
      workspace.name,
      workspace.directory,
      workspace.scopeKey,
      Number(workspace.isDefault),
      workspace.status,
      now,
      now,
    ];
    //M 持久化工作区记录，供后续查询和派活使用。
    this.home.resources.db.query(sql).run(...values);

    //M 持久化完成后告诉监听者新增了一个工作区。
    this.emitChanged(workspace, 'created');
    return workspace;
  }

  /**
   * 交回工作区和它的绝对目录；归档的只在 allowArchived 时给。resolve 的每条路都从这里出去。
   * @param workspace 选定的工作区。
   * @param allowArchived 归档的也给（已经绑定的后台接着用）。
   * @throws workspace_archived。
   */
  private getResolved(workspace: Workspace, allowArchived: boolean): ResolvedWorkspace {
    //G 归档了：不能再派新活。
    if (workspace.status === 'archived' && !allowArchived) {
      throw new WorkspaceError('workspace_archived', `工作区 ${workspace.id} 已归档，不能再派新活`);
    }

    const directory = path.resolve(this.home.resources.root, workspace.directory);

    //T 跟踪：定下在哪个工作区干。
    const vars = { workspace: workspace.id, name: workspace.name, scope: workspace.scopeKey, directory: directory };
    this.home.emit('trace', 'Workspaces.resolve', 'trace.workspaces.resolve', 'workspaces.resolve(access, selection)', vars);
    return { workspace, directory };
  }

  /**
   * 发 workspaces/changed（带跟踪）：存库以后调。
   * @param workspace 变了的工作区。
   * @param action created、renamed、archived。
   */
  private emitChanged(workspace: Workspace, action: WorkspaceChange['action']): void {
    const change: WorkspaceChange = { workspaceId: workspace.id, bot: workspace.bot, action };

    //T 跟踪：工作区变了。
    const vars = { workspace: workspace.id, bot: workspace.bot, name: workspace.name, action: action };
    this.home.emit('trace', 'Workspaces.emitChanged', 'trace.workspaces.changed', "ctx.emit('workspaces/changed', change)", vars);
    this.home.emit('workspaces/changed', change);
  }

  /**
   * 机器人的默认工作区目录：运行时目录 bots/<机器人>/workspace/，绝对路径（不建）。
   * @param bot 机器人名。
   */
  private getHome(bot: string): string {
    return path.join(this.home.resources.root, 'bots', bot, 'workspace');
  }

  /**
   * 目录的存法：在运行时目录里的存相对路径（/ 隔开），外面的存绝对路径。
   * @param full 绝对路径。
   */
  private getStored(full: string): string {
    const relative = path.relative(this.home.resources.root, full);

    //M 在运行时目录外面（../ 出去、换了盘符）：存绝对路径。
    if (relative.startsWith('..') || path.isAbsolute(relative)) return path.resolve(full);

    //M 就是运行时目录本身：写 '.'。
    if (relative === '') return '.';

    return relative.split(path.sep).join('/');
  }
}


/**
 * 表里一行换成 Workspace。
 * @param record 表里的一行。
 */
function getWorkspace(record: WorkspaceRecord): Workspace {
  return {
    id: record.id,
    bot: record.bot,
    name: record.name,
    directory: record.directory,
    scopeKey: record.scope_key,
    isDefault: record.is_default === 1,
    status: record.status as Workspace['status'],
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}


/**
 * 工作区的名字：去掉首尾空白，不能空。名字可以重复。
 * @param written 模型、调用方写的名字。
 * @throws workspace_invalid_name。
 */
function getName(written: string): string {
  const workspaceName = written.trim();
  //G 去掉空白后仍为空的名字不能写入登记表。
  if (workspaceName === '') throw new WorkspaceError('workspace_invalid_name', '工作区要有名字');

  return workspaceName;
}


/**
 * 挂上工作区服务：建表、登记工具 workspace。没有配置。
 * apply 是 Cordis 插件的入口函数，详见 plugins/Index.ts 的 PluginModule。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  //M 建立工作区服务，供插件查询和模型工具使用。
  new Workspaces(ctx);
}
