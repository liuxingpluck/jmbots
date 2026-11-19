/** 用内存库和假 ctx 验证 todo 工具的入口：超过上限退回模型，不截断；上限以内照常写入。不调用模型。 */
import * as sqlite from 'bun:sqlite';
import { expect, test } from 'bun:test';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as assist from './index.ts';

/** 登记进来的工具：只留测试要调的 run。 */
type ToolRun = (args: Record<string, unknown>, session: Session) => string;

test('todo 超过 50 项抛错退回模型，50 项以内照常写入', () => {
  //M 内存库、只记工具的假 ctx；事件、接口、会话查询都用空实现。
  const db = new sqlite.Database(':memory:');
  const tools = new Map<string, ToolRun>();
  const ctx = {
    resources: { db },
    on: () => undefined,
    emit: () => undefined,
    tools: {
      register: (tool: { definition: { name: string }; run: ToolRun }) => {
        tools.set(tool.definition.name, tool.run);
      },
    },
    http: { app: { get: () => undefined, post: () => undefined } },
    sessions: { find: () => [] },
  } as unknown as cordis.Context;
  assist.apply(ctx);

  //M 一场没有父会话的前台会话；todo 只读 row 的 id、bot、parent。
  const session = { row: { id: 's1', bot: '小测', parent: null } } as unknown as Session;
  const run = tools.get('todo');
  if (run === undefined) throw new Error('todo 工具没登记');

  //M 51 项：入口直接拒绝，库里不留东西。
  const tooMany = Array.from({ length: 51 }, (_value, index) => ({ text: `第 ${String(index)} 件`, status: 'todo' }));
  expect(() => run({ items: tooMany }, session)).toThrow('待办最多 50 项');
  const empty = db.query("SELECT COUNT(*) AS n FROM assist_items WHERE kind = 'todo'").get() as { n: number };
  expect(empty.n).toBe(0);

  //M 50 项：照常写入一份。
  const enough = tooMany.slice(0, 50);
  expect(run({ items: enough }, session)).toBe('待办已更新：0/50 做完');
  const saved = db.query("SELECT COUNT(*) AS n FROM assist_items WHERE kind = 'todo'").get() as { n: number };
  expect(saved.n).toBe(1);
});
