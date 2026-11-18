/** 旧记忆归属补标。默认只读汇总，--write 才更新已确认的归属。 */
import * as sqlite from 'bun:sqlite';
import * as path from 'node:path';
import * as audit from './Count_Memory_Keys.ts';
import * as channel from './ChannelIndex.ts';
import * as keys from './MemoryKey.ts';


/** 按原消息键找到的 Rust 副本，不读正文。 */
interface ChannelCopy {
  /** 用于原地更新和摘挂关系的段落行号。 */
  id: number;
  /** 锁定 history 空间，防止迁移其他来源类型。 */
  scope: string;
  /** 写前核对的旧客户号。 */
  customer: string;
}


/** 一条已复核的渠道迁移项，两边用同一原消息键关联。 */
interface ChannelChange {
  /** 原渠道消息键。 */
  messageKey: string;
  /** 要补入的归属键。 */
  key: string;
  /** 扫描空键用空串，迁移已补索引的 Rust 段落时用现有正确键。 */
  previous: string;
  /** 已有的唯一 Rust 副本，没有副本时只补主库。 */
  copy: ChannelCopy | undefined;
}


/** 生成只含标识及计数的计划；同时预查已存在的 Rust 副本。 */
function planMemoryKeys(store: sqlite.Database, index: sqlite.Database, schema: audit.IndexSchema) {
  const pending = new Map<string, { key: string; previous: string }>();
  const sessions: audit.KeyCandidate[] = [];
  let channelCandidates = 0;
  const collectDocument = (item: audit.KeyCandidate): void => {
    if (item.messageKey === undefined) {
      //M 会话来源没有渠道副本，由原段落迁移流程处理。
      sessions.push(item);
      return;
    }
    //M Rust 还没补的段落也可能对应已标记的渠道行。
    channelCandidates += 1;
    const planned = { key: item.key, previous: item.key };
    pending.set(item.messageKey, planned);
  };
  const collectIndex = (messageKey: string, key: string): void => {
    //M 合并 Rust 和索引计划，同一消息只协调一次。
    const planned = { key, previous: '' };
    pending.set(messageKey, planned);
  };

  //M 即便 Rust 尚无副本，空键索引也可以独立进入计划。
  const counts = audit.countMemoryKeys(store, index, collectDocument, schema);
  const indexCounts = audit.countChannelKeys(index, collectIndex, schema);

  //M 按稳定的来源键定位，不凭旧客户号、内容或时间相似度匹配。
  const copySql = 'SELECT rowid AS id, scope, customer FROM docs WHERE source = ? LIMIT 2';
  const findCopies = store.query<ChannelCopy, [string]>(copySql);
  const indexSql = `SELECT memory_key FROM ${schema}.memory_channel_messages WHERE msg_key = ?`;
  const findIndex = index.query<{ memory_key: string }, [string]>(indexSql);
  const conflicts = { duplicateCopies: 0, differentScope: 0, differentOwner: 0, changedIndex: 0 };
  const channels: ChannelChange[] = [];
  let existingCopies = 0;
  let indexPlanned = 0;
  //M 逐项核对，两边已知的归属发生冲突时保留原记录。
  for (const [messageKey, item] of pending) {
    const row = findIndex.get(messageKey);
    if (row?.memory_key !== item.previous) {
      conflicts.changedIndex += 1;
      continue;
    }

    const source = `${channel.CHANNEL_PARTITION}${messageKey}`;
    const copies = findCopies.all(source);
    if (copies.length > 1) {
      conflicts.duplicateCopies += 1;
      continue;
    }
    const copy = copies[0];
    if (copy !== undefined) {
      if (copy.scope !== 'history') {
        conflicts.differentScope += 1;
        continue;
      }
      //G 已有明确归属的副本只能与同一归属协调。
      const personal = keys.isMemoryKey('person', copy.customer);
      const group = keys.isMemoryKey('group', copy.customer);
      const tagged = personal || group;
      if (tagged && copy.customer !== item.key) {
        conflicts.differentOwner += 1;
        continue;
      }
      existingCopies += 1;
    }
    if (item.previous === '') {
      indexPlanned += 1;
    }
    //M 通过核对的项记录两边现状，供同一事务里的更新使用。
    const change = { messageKey, ...item, copy };
    channels.push(change);
  }

  const report = {
    ...counts,
    channelCandidates,
    sessionCandidates: sessions.length,
    channelIndex: { ...indexCounts, planned: indexPlanned, existingCopies, conflicts },
  };
  return { report, channels, sessions };
}


/**
 * 在一个事务里同步 Rust 客户维度与渠道索引。原记录、向量和全文索引不重建。
 * @param store 附上 app_index 主库后的 Rust 连接。
 * @returns 实际补标、确认入库和冲突数。
 */
export function applyMemoryKeys(store: sqlite.Database) {
  const migration = store.transaction(() => {
    //G 重新在事务内规划，避免在只读预览之后沿用已变化的来源元数据。
    const plan = planMemoryKeys(store, store, 'app_index');
    let moved = 0;
    let conflicts = 0;
    let indexed = 0;
    let confirmedCopies = 0;
    //M 先更新段落归属并摘挂旧图；唯一键冲突时保留段落和索引原位。
    const moveSql = 'UPDATE OR IGNORE docs SET customer = ?, graph = CASE WHEN graph = 3 THEN 3 ELSE 0 END'
      + ' WHERE rowid = ? AND customer = ?';
    const move = store.query(moveSql);
    const unlinkSql = 'DELETE FROM rel_docs WHERE doc = ?';
    const unlink = store.query(unlinkSql);
    const moveDocument = (id: number, previous: string, key: string): boolean => {
      const result = move.run(key, id, previous);
      if (result.changes !== 1) return false;

      //M 原来参与抽取的段落由 memsvc 在新空间重建关系。
      unlink.run(id);
      moved += 1;
      return true;
    };

    //M 已入库的行标已确认，避免后台按新的归属重新提交同一条内容。
    const updateSql = 'UPDATE app_index.memory_channel_messages'
      + ' SET memory_key = ?, rust_state = CASE WHEN ? = 1 THEN 2 ELSE rust_state END'
      + ' WHERE msg_key = ? AND memory_key = ?';
    const update = store.query(updateSql);
    for (const item of plan.channels) {
      const copy = item.copy;
      if (copy !== undefined && copy.customer !== item.key) {
        const changed = moveDocument(copy.id, copy.customer, item.key);
        if (!changed) {
          conflicts += 1;
          continue;
        }
      }
      const confirmed = Number(copy !== undefined);
      //G 空键候选写入时仍匹配空键；如果索引未写成，回滚前面的段落改动。
      const result = update.run(item.key, confirmed, item.messageKey, item.previous);
      if (result.changes !== 1) {
        throw new Error('渠道索引归属更新失败，整批回滚');
      }
      if (item.previous === '') {
        indexed += 1;
      }
      confirmedCopies += confirmed;
    }

    //M 渠道协调完成后再补能查明来源的会话段落。
    for (const item of plan.sessions) {
      const changed = moveDocument(item.id, item.previous, item.key);
      if (!changed) {
        conflicts += 1;
      }
    }

    if (moved > 0) {
      //M 只清理没有任何出处的图索引，其他段落的关系仍由其出处保留。
      store.exec('DELETE FROM relations WHERE id NOT IN (SELECT relation FROM rel_docs)');
      store.exec('DELETE FROM entities WHERE id NOT IN (SELECT subj FROM relations UNION SELECT obj FROM relations)');
    }
    const channelConflicts = plan.report.channelIndex.conflicts;
    return { moved, indexed, confirmedCopies, conflicts, channelConflicts };
  });
  return migration.immediate();
}


/** 默认只读扫描两个库。显式 --write 后再次核对原键，再按计划事务更新。 */
function main(): void {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const positional = args.filter((arg) => arg !== '--write');
  const [flag, runtime, storeFlag, storeFile, ...extra] = positional;
  const validStore = storeFlag === undefined || (storeFlag === '--store' && Boolean(storeFile));
  if (flag !== '--data' || !runtime || !validStore || extra.length > 0) {
    throw new Error('用法：bun Backfill_Memory_Keys.ts --data <运行时目录> [--store <记忆库文件>] [--write]');
  }

  const data = path.join(runtime, 'data');
  const indexPath = path.join(data, 'jmbots7.db');
  const storePath = storeFile ?? path.join(data, 'memory', 'memory.db');
  const readonly = { readonly: true, create: false };
  //M 以只读方式预览两边的候选和冲突。
  const index = new sqlite.Database(indexPath, readonly);
  let report: ReturnType<typeof planMemoryKeys>['report'];
  try {
    const store = new sqlite.Database(storePath, readonly);
    try {
      //M 先取得只读报告和可写计划，扫描过程不获取写锁。
      const plan = planMemoryKeys(store, index, 'main');
      report = plan.report;
    } finally {
      //M 关闭扫描连接后再考虑写入，释放存量库的读游标。
      store.close();
    }
  } finally {
    //M 主库报告同样在写入前关闭。
    index.close();
  }

  //M 报告不打印消息键、客户标识或历史正文。
  const preview = JSON.stringify(report, null, 2);
  console.log(preview);
  if (!write) return;

  const store = new sqlite.Database(storePath, { create: false });
  try {
    //M 仅写入模式附带主库；先补渠道，再补会话来源段落。
    const attachSql = 'ATTACH DATABASE ? AS app_index';
    const attach = store.query(attachSql);
    attach.run(indexPath);
    const changed = applyMemoryKeys(store);
    const output = JSON.stringify(changed, null, 2);
    console.log(output);
  } finally {
    store.close();
  }
}


if (import.meta.main) {
  //M 直接运行才打开数据文件；测试在内存库里调用事务函数。
  main();
}
