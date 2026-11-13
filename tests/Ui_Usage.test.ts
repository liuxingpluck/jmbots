/**
 * 用量页的合计和换算（web/src/Panel/UsageData.ts，docs/15_用量表.md 第 4 节）的离线测试：
 * 按分组、按时间段加起来，命中率重算；token、钱、比例换成好读的字；时间范围；柱子的路径。
 */
import * as bunTest from 'bun:test';
import * as usageData from '../web/src/Panel/UsageData.ts';
import type * as types from '../web/src/Types.ts';


/**
 * 造一行：默认 2026-11-07、调用一次、输入 100、输出 10。
 * @param patch 要改的字段。
 */
function row(patch: Partial<types.UsageRow>): types.UsageRow {
  return {
    period: '2026-11-07',
    key: 'magpie',
    calls: 1,
    failures: 0,
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.001,
    ms: 500,
    hitRate: 0,
    ...patch,
  };
}


bunTest.describe('用量页', () => {
  bunTest.test('按分组加起来：token 多的在前、命中率重算；按时间段加起来：从早到晚', () => {
    /** 后端回的三行：两天、两个分组。 */
    const rows = [
      row({ period: '2026-11-07', key: 'a', cacheRead: 100 }),
      row({ period: '2026-11-08', key: 'a', cacheRead: 300, failures: 1 }),
      row({ period: '2026-11-07', key: 'b', input: 50, output: 0 }),
    ];
    /** 按分组。 */
    const keys = usageData.byKey(rows);
    bunTest.expect(keys.map((item) => `${item.key}|${String(item.calls)}|${String(item.failures)}`)).toEqual(['a|2|1', 'b|1|0']);
    bunTest.expect(keys[0]!.hitRate).toBeCloseTo(400 / 600);
    bunTest.expect(keys[0]!.period).toBe('');
    /** 按时间段（倒着给也排回从早到晚）。 */
    const periods = usageData.byPeriod([...rows].reverse());
    bunTest.expect(periods.map((item) => `${item.period}|${String(usageData.tokensOf(item))}`)).toEqual(['2026-11-07|260', '2026-11-08|410']);
    bunTest.expect(periods[0]!.key).toBe('');
  });

  bunTest.test('换成好读的字：token 用 K、M、B，钱不到 1 美元留 4 位小数，比例留 1 位', () => {
    bunTest.expect(usageData.formatTokens(999)).toBe('999');
    bunTest.expect(usageData.formatTokens(1234)).toBe('1.2K');
    bunTest.expect(usageData.formatTokens(1234567)).toBe('1.23M');
    bunTest.expect(usageData.formatTokens(2.5e9)).toBe('2.50B');
    bunTest.expect(usageData.formatCost(0.0123)).toBe('$0.0123');
    bunTest.expect(usageData.formatCost(12.5)).toBe('$12.50');
    bunTest.expect(usageData.formatRate(0.4567)).toBe('45.7%');
    bunTest.expect(usageData.hitRateOf({ input: 0, cacheRead: 0 })).toBe(0);
    bunTest.expect(usageData.rangeOf(7, 1e12)).toEqual({ from: 1e12 - 7 * 24 * 60 * 60 * 1000, to: 1e12 });
  });

  bunTest.test('柱子的路径：顶上两个角圆、底下方；矮的柱子圆角不超过高', () => {
    bunTest.expect(usageData.barPath({ x: 0, y: 10, width: 8, height: 20 }, 4)).toBe('M0,30 V14 Q0,10 4,10 H4 Q8,10 8,14 V30 Z');
    bunTest.expect(usageData.barPath({ x: 0, y: 0, width: 8, height: 2 }, 4)).toBe('M0,2 V2 Q0,0 2,0 H6 Q8,0 8,2 V2 Z');
  });
});
