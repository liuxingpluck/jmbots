/** 工作决策的 SQLite 表、快照查询和旧文件的一次性导入。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import type * as dbModule from '../db/index.ts';
import type * as types from './Types.ts';

/**
 * 迁移第 1 版：原来的三张表和索引（decisions 不带 quadrant，quadrant 在第 2 版加）。
 * 每句之间用 Drizzle 的 `--> statement-breakpoint` 隔开：db.migrate 按它拆句，不隔开只会执行第一句。
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT,
    bot TEXT,
    parent TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT,
    options TEXT,
    chosen TEXT,
    asker TEXT,
    main TEXT,
    needs TEXT,
    sources TEXT,
    links TEXT,
    detail_path TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    acknowledged_at INTEGER,
    note TEXT
  );
  --> statement-breakpoint
  CREATE INDEX IF NOT EXISTS decisions_project ON decisions (bot, workspace_id);
  --> statement-breakpoint
  CREATE TABLE IF NOT EXISTS decision_notes (
    decision_id TEXT NOT NULL REFERENCES decisions (id),
    id TEXT NOT NULL,
    author TEXT NOT NULL,
    at INTEGER NOT NULL,
    text TEXT NOT NULL,
    option TEXT,
    reply_to TEXT,
    replied_at INTEGER,
    relay_reply_id INTEGER,
    PRIMARY KEY (decision_id, id)
  );
  --> statement-breakpoint
  CREATE TABLE IF NOT EXISTS decision_changes (
    seq INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    decision_ids TEXT NOT NULL,
    detail TEXT NOT NULL
  );
`;

/**
 * 工作决策在 db 迁移账本里的版本。
 * 第 1 版：三张表（旧库里表已经在，IF NOT EXISTS 什么都不改，账本只登记）。
 * 第 2 版：加四象限列 quadrant；1.3.11 起旧代码已经手动补过这一列的库，adoptColumn 只登记、不重加。
 */
export const decisionMigrations: dbModule.MigrationPlan = {
  plugin: 'work-decision',
  migrations: [
    { version: 1, sql: SCHEMA },
    {
      version: 2,
      sql: 'ALTER TABLE decisions ADD COLUMN quadrant TEXT',
      adoptColumn: { table: 'decisions', name: 'quadrant' },
    },
  ],
};

//M 使用原节点的 JSON 字段绑定 SQLite 列，数组、对象和布尔值保留 JSON 类型。
const PUT_NODE = `
  INSERT INTO decisions (
    id, workspace_id, bot, parent, kind, status, title, summary, body, options, chosen, asker,
    main, quadrant, needs, sources, links, detail_path, created_at, decided_at, decided_by, acknowledged_at, note
  ) VALUES (
    $node ->> '$.id', $node ->> '$.workspaceId', $node ->> '$.bot', $node ->> '$.parent',
    $node ->> '$.kind', $node ->> '$.status', $node ->> '$.title', $node ->> '$.summary',
    $node ->> '$.body', $node -> '$.options', $node ->> '$.chosen', $node -> '$.asker',
    $node -> '$.main', $node ->> '$.quadrant', $node -> '$.needs', $node -> '$.sources', $node -> '$.links',
    $node ->> '$.detailPath', $node ->> '$.createdAt', $node ->> '$.decidedAt',
    $node ->> '$.decidedBy', $node ->> '$.acknowledgedAt', $node ->> '$.note'
  ) ON CONFLICT (id) DO UPDATE SET
    workspace_id = excluded.workspace_id, bot = excluded.bot, parent = excluded.parent,
    kind = excluded.kind, status = excluded.status, title = excluded.title, summary = excluded.summary,
    body = excluded.body, options = excluded.options, chosen = excluded.chosen, asker = excluded.asker,
    main = excluded.main, quadrant = excluded.quadrant, needs = excluded.needs,
    sources = excluded.sources, links = excluded.links,
    detail_path = excluded.detail_path, decided_at = excluded.decided_at, decided_by = excluded.decided_by,
    acknowledged_at = excluded.acknowledged_at, note = excluded.note
`;

//M 用原有节点的 JSON 形状读取。省略的可选字段继续省略，根节点的 parent 保留 null。
const SELECT_NODES = `
  SELECT json_patch(json_object('parent', parent), json_object(
    'id', id, 'workspaceId', workspace_id, 'bot', bot, 'kind', kind, 'status', status, 'title', title,
    'summary', summary, 'body', body, 'options', json(options), 'chosen', chosen, 'asker', json(asker),
    'main', json(main), 'quadrant', quadrant, 'needs', json(needs), 'sources', json(sources), 'links', json(links),
    'detailPath', detail_path, 'createdAt', created_at, 'decidedAt', decided_at, 'decidedBy', decided_by,
    'acknowledgedAt', acknowledged_at, 'note', note
  )) AS value FROM decisions ORDER BY rowid
`;

const PUT_NOTE = `
  INSERT INTO decision_notes (decision_id, id, author, at, text, option, reply_to, replied_at, relay_reply_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (decision_id, id) DO UPDATE SET replied_at = excluded.replied_at
`;

const SELECT_NOTES = `
  SELECT decision_id, json_patch('{}', json_object(
    'id', id, 'author', author, 'at', at, 'text', text, 'option', option,
    'replyTo', reply_to, 'repliedAt', replied_at, 'relayReplyId', relay_reply_id
  )) AS value FROM decision_notes ORDER BY rowid
`;

const SELECT_CHANGES = `
  SELECT json_patch(detail, json_object(
    'seq', seq, 'at', at, 'actor', actor, 'action', action, 'nodes', json(decision_ids)
  )) AS value FROM decision_changes WHERE seq > ? ORDER BY seq
`;

/** 旧快照的 head 补足崩溃时尚未追加到 history.jsonl 的最后一次改动。 */
interface LegacyGraph extends types.DecisionGraph {
  /** 快照已提交的最后一次变化。 */
  head?: types.DecisionChange;
}

/** 导入时为旧任务树指定一个已有项目。 */
export interface LegacyProject {
  /** 工作区归属的机器人。 */
  bot: string;
  /** 已登记的工作区号。 */
  workspaceId: string;
}

/** 属主工作区的公开身份，分组只读取这几个字段。 */
export interface WorkspaceProject extends LegacyProject {
  /** 工作区当前显示名。 */
  name: string;
}

/** 三张表使用资源插件已有的应用数据库。 */
export class Sqlite {
  /**
   * @param db 由 resources 管理连接。
   * @param migrations db 插件的迁移服务（ctx.db），和 db 用同一个连接。
   * 副作用：按迁移账本建表、加列；旧库照账本平滑升级。
   */
  constructor(
    private readonly db: Database,
    migrations: dbModule.Db,
  ) {
    //M 建表、加列只走 db 的迁移账本，不在这里查列补列。
    migrations.migrate(decisionMigrations);
  }

  /** 读取客户端版本，包括旧快照的历史已被清理时保留的版本。 */
  getRevision(): number {
    const sql = `
      SELECT max(coalesce(max(seq), 0), coalesce((
        SELECT json_extract(detail, '$.revision') FROM decision_changes WHERE seq = 0
      ), 0)) AS revision FROM decision_changes
    `;
    //M 序号零只记录导入状态，公开版本在第一次实际改动后继续递增。
    return this.db.query<{ revision: number }, []>(sql).get()!.revision;
  }

  /** 从资源库读取已登记的本人工作区，未挂工作区插件时可以没有。 */
  getWorkspace(id: string): WorkspaceProject | undefined {
    const table = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'";
    //G 没挂工作区插件时没有工作区可归组。
    if (this.db.query(table).get() === null) return;

    //M 项目沿用工作区的实际身份和名称，避免维护另一份项目数据。
    const sql = "SELECT id AS workspaceId, bot, name FROM workspaces WHERE id = ? AND scope_key = 'private'";
    const row = this.db.query<WorkspaceProject, [string]>(sql).get(id);
    return row ?? undefined;
  }

  /** 用同一个读事务返回完整快照。 */
  getGraph(): types.DecisionGraph {
    //M 节点与留言在同一次读取中对齐。
    const read = this.db.transaction(() => {
      //M 读同一快照的最新版本给页面刷新使用。
      const revision = this.getRevision();
      //M 读取树结构并沿原来的顺序排节点。
      const rows = this.db.query<{ value: string }, []>(SELECT_NODES).all();
      //M 从独立表读出各节点的留言。
      const notes = this.db.query<{ decision_id: string; value: string }, []>(SELECT_NOTES).all();
      const nodes = rows.map((row) => JSON.parse(row.value) as types.DecisionNode);
      const byId = new Map(nodes.map((node) => [node.id, node]));

      //M 一次读取的留言按节点归回公开快照，保持原来的追加顺序。
      for (const row of notes) {
        const node = byId.get(row.decision_id)!;
        const note = JSON.parse(row.value) as types.DecisionNote;
        node.notes ??= [];
        node.notes.push(note);
      }
      return { revision, nodes };
    });
    return read();
  }

  /** 分页轮询只读指定序号以后的实际变化。 */
  getChanges(since: number) {
    //M 把最后序号与变化读取合在同一事务内。
    const read = this.db.transaction(() => {
      //M 最后序号包括旧快照已保留但无明细的版本。
      const last = this.getRevision();
      //M 只取调用方还没读过的流水。
      const rows = this.db.query<{ value: string }, [number]>(SELECT_CHANGES).all(since);
      const changes = rows.map((row) => JSON.parse(row.value) as types.DecisionChange);
      return { last, changes };
    });
    return read();
  }

  /** 写入一批变更过的节点、相关留言和一条流水。版本落后时拒绝覆盖。 */
  save(nodes: readonly types.DecisionNode[], change: types.DecisionChange): boolean {
    //M 启动一次写事务，节点、留言和变化一并提交。
    const write = this.db.transaction(() => {
      //G 草稿基于旧版本时让调用方刷新，保护刚提交的决定。
      if (this.getRevision() + 1 !== change.seq) return false;

      //M 版本、节点和留言在同一事务中生效，失败时可按旧版本重试。
      this.putNodes(nodes);
      this.putChange(change);
      return true;
    });
    return write.immediate();
  }

  //退场：所有运行时的旧 data/decision-map/graph.json 都导入 SQLite 以后
  /** 从项目配置指定的工作区导入快照、留言和历史，原文件留作备份。 */
  importLegacy(dir: string, project?: LegacyProject): void {
    const graphPath = path.join(dir, 'graph.json');
    const historyPath = path.join(dir, 'history.jsonl');
    //M 导入完成标记随旧数据同时写入。
    const write = this.db.transaction(() => {
      //G 库里已有变化表示应用开始用 SQLite 存储。
      const recorded = this.db.query('SELECT 1 FROM decision_changes LIMIT 1').get();
      if (recorded !== null || !fs.existsSync(graphPath)) return;

      //M 旧文件仅在首次启动导入。节点和历史都写成功才记导入完成。
      const encoded = fs.readFileSync(graphPath, 'utf8');
      const legacy = JSON.parse(encoded) as LegacyGraph;
      if (!Array.isArray(legacy.nodes) || !Number.isSafeInteger(legacy.revision) || legacy.revision < 0) {
        throw new Error('旧工作决策快照的节点或版本无效');
      }
      const nodes = legacy.nodes.map((node) => {
        if (project === undefined) return node;

        return { ...node, bot: project.bot, workspaceId: project.workspaceId };
      });
      const changes = new Map<number, types.DecisionChange>();
      if (fs.existsSync(historyPath)) {
        const body = fs.readFileSync(historyPath, 'utf8');
        for (const line of body.split('\n')) {
          if (line.trim() === '') continue;

          //G 旧版追加历史中断可能留下半行，由快照的 head 补回。
          try {
            const change = JSON.parse(line) as types.DecisionChange;
            if (Number.isSafeInteger(change.seq) && change.seq > 0) changes.set(change.seq, change);
          } catch {
            continue;
          }
        }
      }
      if (legacy.head !== undefined && legacy.head.seq > 0) {
        changes.set(legacy.head.seq, legacy.head);
      }

      //M 序号零记录导入已完成，与原来公开的历史序号分开。
      this.putNodes(nodes);
      for (const change of changes.values()) {
        this.putChange(change);
      }
      const marker = JSON.stringify({ revision: legacy.revision });
      const sql = "INSERT INTO decision_changes VALUES (0, ?, 'plugin', 'import', '[]', ?)";
      //M 以序号零保存导入完成与原公开版本。
      this.db.query(sql).run(Date.now(), marker);
    });
    write.immediate();
  }

  /** 写入指定节点及其留言。调用方已打开事务并校验了结构。 */
  private putNodes(nodes: readonly types.DecisionNode[]): void {
    //M 用预编译语句逐节点保存具名字段。
    const putNode = this.db.query(PUT_NODE);
    //M 用独立语句保存留言与回话关系。
    const putNote = this.db.query(PUT_NOTE);
    for (const node of nodes) {
      const { notes, ...fields } = node;
      const encoded = JSON.stringify(fields);
      const bindings = { $node: encoded };

      //M 决策行只含节点字段，回话单独写入留言表。
      putNode.run(bindings);
      for (const note of notes ?? []) {
        const values = [
          node.id, note.id, note.author, note.at, note.text, note.option ?? null,
          note.replyTo ?? null, note.repliedAt ?? null, note.relayReplyId ?? null,
        ];
        putNote.run(...values);
      }
    }
  }

  /** 记录公开变化，常用的序号和操作列可直接筛选。 */
  private putChange(change: types.DecisionChange): void {
    const { seq, at, actor, action, nodes, ...detail } = change;
    const ids = JSON.stringify(nodes);
    const encoded = JSON.stringify(detail);
    const sql = 'INSERT INTO decision_changes (seq, at, actor, action, decision_ids, detail) VALUES (?, ?, ?, ?, ?, ?)';
    //M 公开流水按调用方已确定的序号入库。
    this.db.query(sql).run(seq, at, actor, action, ids, encoded);
  }
}
