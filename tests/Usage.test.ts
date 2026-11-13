/**
 * 用量表的离线测试（docs/15_用量表.md）：记一行、按时间段和分组合计（失败次数、token、钱）、时间范围。内存数据库。
 */
import * as bunTest from 'bun:test';
import * as storeModule from '../src/capabilities/Store.ts';


/**
 * 本地时间的毫秒（用量表按服务器本地时间切时间段，测试也按本地时间造，在哪个时区跑都一样）。
 * @param year 年。
 * @param month 月（1～12）。
 * @param day 日。
 * @param hour 时。
 * @param minute 分。
 */
function local(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}


/**
 * 一行用量（没给的用默认值）。
 * @param patch 要改的字段。
 */
function row(patch: Partial<storeModule.UsageRow>): storeModule.UsageRow {
  return {
    at: local(2026, 11, 7, 10, 15),
    provider: 'magpie',
    model: 'magpie/workbuddy/hy4free',
    kind: 'chat',
    purpose: 'session',
    input: 100,
    output: 10,
    cacheRead: 300,
    cacheWrite: 0,
    cost: 0.01,
    ms: 1000,
    ok: true,
    ...patch,
  };
}


bunTest.test('按天、按模型合计：调用次数、失败次数、token、钱；时间范围外的不算', () => {
  /** 内存数据库。 */
  const store = new storeModule.Store(':memory:');
  store.addUsage(row({}));
  store.addUsage(row({ ok: false, error: '429', input: 0, output: 0, cacheRead: 0, cost: 0 }));
  store.addUsage(row({ model: 'magpie/workbuddy/deepseek-v4.1-flash', input: 50 }));
  store.addUsage(row({ at: local(2026, 11, 8, 9, 0) }));
  store.addUsage(row({ at: local(2026, 10, 1, 9, 0) }));
  /** 合计。 */
  const rows = store.usageReport({ by: 'day', group: 'model', from: local(2026, 11, 1, 0, 0), to: local(2026, 11, 9, 0, 0) });
  bunTest.expect(rows.map((item) => `${item.period}|${item.key}|${String(item.calls)}|${String(item.failures)}|${String(item.input)}`)).toEqual([
    '2026-11-07|magpie/workbuddy/deepseek-v4.1-flash|1|0|50',
    '2026-11-07|magpie/workbuddy/hy4free|2|1|100',
    '2026-11-08|magpie/workbuddy/hy4free|1|0|100',
  ]);
  bunTest.expect(rows[1]!.cacheRead).toBe(300);
  bunTest.expect(rows[1]!.cost).toBeCloseTo(0.01);
});


bunTest.test('按小时、按供应商；按周、按月切出来的时间段写法', () => {
  /** 内存数据库。 */
  const store = new storeModule.Store(':memory:');
  store.addUsage(row({}));
  store.addUsage(row({ at: local(2026, 11, 7, 10, 45), provider: 'openrouter', model: 'openrouter/x' }));
  store.addUsage(row({ at: local(2026, 11, 7, 11, 5) }));
  /** 范围。 */
  const range = { from: local(2026, 11, 7, 0, 0), to: local(2026, 11, 8, 0, 0) };
  //G bun test 里 JS 的时区是 UTC，SQLite 的本地时间跟着系统走，两边可能差几个小时：只核“同一小时的合在一起、下一小时另起一段”。
  /** 按小时、按供应商。 */
  const hourly = store.usageReport({ by: 'hour', group: 'provider', ...range });
  bunTest.expect(hourly.map((item) => `${item.key}|${String(item.calls)}`)).toEqual(['magpie|1', 'openrouter|1', 'magpie|1']);
  bunTest.expect(hourly[0]!.period).toBe(hourly[1]!.period);
  bunTest.expect(hourly[2]!.period).not.toBe(hourly[0]!.period);
  bunTest.expect(hourly[0]!.period).toMatch(/^\d{4}-\d\d-\d\d \d\d:00$/);
  bunTest.expect(store.usageReport({ by: 'month', group: 'provider', ...range })[0]!.period).toMatch(/^2026-1[01]$/);
  bunTest.expect(store.usageReport({ by: 'week', group: 'provider', ...range })[0]!.period).toMatch(/^2026-W\d\d$/);
});
