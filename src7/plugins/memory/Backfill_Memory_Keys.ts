/** 旧记忆归属补标。默认只读汇总，--write 才更新已确认的归属。 */
import * as sqlite from 'bun:sqlite';
import * as path from 'node:path';
import * as audit from './Count_Memory_Keys.ts';


/**
 * 在一个事务里同步 Rust 客户维度与渠道索引。原记录、向量和全文索引不重建。
 * @param store 附上 app_index 主库后的 Rust 连接。
 * @param items 只包含已核对来源的候选，渠道在前、会话在后。
 * @returns 实际补标和冲突数。
 */
export function applyMemoryKeys(store: sqlite.Database, items: audit.KeyCandidate[]) {
  //G 渠道补标依赖第一阶段已经建好的索引列。
  const schema = 'PRAGMA app_index.table_info(memory_channel_messages)';
  const columns = store.query<{ name: string }, []>(schema).all();
  const installed = columns.some((column) => column.name === 'memory_key');
  if (!installed && items.some((item) => item.messageKey !== undefined)) {
    throw new Error('主库还没有 memory_key，先让 memory 1.7 或更新版启动一次');
  }

  const migration = store.transaction(() => {
    let moved = 0;
    let conflicts = 0;
    //M 先核对新旧键，冲突的内容保留原位；重跑时已经完成的段落不会重复补写。
    const move = store.query('UPDATE OR IGNORE docs SET customer = ?, graph = CASE WHEN graph = 3 THEN 3 ELSE 0 END'
      + ' WHERE rowid = ? AND customer = ?');
    const unlink = store.query('DELETE FROM rel_docs WHERE doc = ?');
    for (const item of items) {
      let indexRow: { memory_key: string } | null = null;
      if (item.messageKey !== undefined) {
        const sql = 'SELECT memory_key FROM app_index.memory_channel_messages WHERE msg_key = ?';
        indexRow = store.query<{ memory_key: string }, [string]>(sql).get(item.messageKey);
        if (indexRow === null || (indexRow.memory_key !== '' && indexRow.memory_key !== item.key)) {
          conflicts += 1;
          continue;
        }
      }
      //M 只有原客户仍一致的段落才更新，避免覆盖扫描后的并发改动。
      const result = move.run(item.key, item.id, item.previous);
      if (result.changes !== 1) {
        conflicts += 1;
        continue;
      }
      if (item.messageKey !== undefined && indexRow?.memory_key === '') {
        const sql = "UPDATE app_index.memory_channel_messages SET memory_key = ? WHERE msg_key = ? AND memory_key = ''";
        //M 渠道索引与 Rust 同时补键，统一检索仍能使用原渠道引用。
        store.query(sql).run(item.key, item.messageKey);
      }
      //M 旧空间的关系摘挂；原来参与抽取的段落由 memsvc 在新空间重建。
      unlink.run(item.id);
      moved += 1;
    }

    if (moved > 0) {
      //M 只清理没有任何出处的图索引，其他段落的关系仍由其出处保留。
      store.exec('DELETE FROM relations WHERE id NOT IN (SELECT relation FROM rel_docs)');
      store.exec('DELETE FROM entities WHERE id NOT IN (SELECT subj FROM relations UNION SELECT obj FROM relations)');
    }
    return { moved, conflicts };
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
  const channels: audit.KeyCandidate[] = [];
  const sessions: audit.KeyCandidate[] = [];
  //M 选择采用可复核的源消息和会话元数据，计划里只保存归属和行号。
  const collect = (item: audit.KeyCandidate): void => {
    if (item.messageKey !== undefined) {
      channels.push(item);
      return;
    }
    //M 会话来源放第二阶段；渠道映射优先处理。
    sessions.push(item);
  };

  const index = new sqlite.Database(indexPath, readonly);
  let counts: ReturnType<typeof audit.countMemoryKeys>;
  try {
    const store = new sqlite.Database(storePath, readonly);
    try {
      //M 先取得只读报告和可写计划，扫描过程不获取写锁。
      counts = audit.countMemoryKeys(store, index, collect);
    } finally {
      //M 关闭扫描连接后再考虑写入，释放存量库的读游标。
      store.close();
    }
  } finally {
    //M 主库报告同样在写入前关闭。
    index.close();
  }

  //M 报告不打印消息键、客户标识或历史正文。
  const report = { ...counts, channelCandidates: channels.length, sessionCandidates: sessions.length };
  console.log(JSON.stringify(report, null, 2));
  if (!write) return;

  const store = new sqlite.Database(storePath, { create: false });
  try {
    //M 仅写入模式附带主库；先补渠道，再补会话来源段落。
    store.query('ATTACH DATABASE ? AS app_index').run(indexPath);
    const items = [...channels, ...sessions];
    const changed = applyMemoryKeys(store, items);
    console.log(JSON.stringify(changed, null, 2));
  } finally {
    store.close();
  }
}


if (import.meta.main) {
  //M 直接运行才打开数据文件；测试在内存库里调用事务函数。
  main();
}
