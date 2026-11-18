/**
 * 用量页（Usage.tsx）用的合计和换算（docs/15_用量表.md 第 4 节）：纯函数，好测（tests/Ui_Usage.test.ts）。
 * 后端回的是“每个时间段、每个分组一行”，这里再按分组、按时间段加起来，把数换成好读的字，算柱子的形状。
 */
import type * as types from '../Types.ts';


/** 一天多少毫秒。 */
const DAY_MS = 24 * 60 * 60 * 1000;


/** 一根柱子的位置和大小（SVG 里的单位）。 */
export interface BarShape {
  /** 左边。 */
  x: number;
  /** 顶。 */
  y: number;
  /** 宽。 */
  width: number;
  /** 高。 */
  height: number;
}


/**
 * 计算一行用量合计包含多少 token：输入、输出、缓存读、缓存写相加。
 * @param row 单行用量数据（不含 period 和 key）。
 * @returns 该行各类 token 数量总和。
 * 副作用：无。
 */
export function getTokens(row: Omit<types.UsageRow, 'period' | 'key'>): number {
  return row.input + row.output + row.cacheRead + row.cacheWrite;
}


/**
 * 计算缓存命中率：缓存读 / (输入 + 缓存读)；分母是 0 时算 0。
 * @param row 一行（至少有输入和缓存读）。
 * @returns 0 到 1 之间的命中率比值；分母为 0 时返回 0。
 * 副作用：无。
 */
export function getHitRate(row: Pick<types.UsageRow, 'input' | 'cacheRead'>): number {
  /** 分母。 */
  const total = row.input + row.cacheRead;
  if (total > 0) return row.cacheRead / total;

  return 0;
}


/**
 * 按分组加起来（列表用）：一个供应商、模型、用途或机器人一行，token 多的在前。
 * @param rows 后端回的行。
 * @returns 加好的行，period 是空的。
 * 副作用：无。
 */
export function getByKey(rows: types.UsageRow[]): types.UsageRow[] {
  //M 按分组键合并用量后按总 token 降序排列，高消耗分组排在列表顶部。
  return sumBy(rows, 'key').sort((a, b) => getTokens(b) - getTokens(a));
}


/**
 * 按时间段加起来（柱状图用）：一个时间段一行，从早到晚。
 * @param rows 后端回的行。
 * @returns 加好的行，key 是空的。
 * 副作用：无。
 */
export function getByPeriod(rows: types.UsageRow[]): types.UsageRow[] {
  //M 按时间段合并用量后按时间标识符升序排列，保证柱状图从早到晚顺序展示。
  return sumBy(rows, 'period').sort((a, b) => a.period.localeCompare(b.period));
}


/**
 * token 数换成好读的字：1234 → 1.2K，1234567 → 1.23M，十亿以上写 B。
 * @param value token 数。
 * @returns 带单位缩写的简短字符串（B/M/K 或四舍五入整数）。
 * 副作用：无。
 */
export function formatTokens(value: number): string {
  if (value >= 1e9) {
    return `${(value / 1e9).toFixed(2)}B`;
  }
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(2)}M`;
  }
  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(1)}K`;
  }
  return String(Math.round(value));
}


/**
 * 钱换成好读的字：不到 1 美元留 4 位小数，不然留 2 位。
 * @param value 美元。
 * @returns 带美元符号的格式化金额文本。
 * 副作用：无。
 */
export function formatCost(value: number): string {
  /** 留几位小数。 */
  let digits = 2;
  if (value < 1) {
    digits = 4;
  }
  return `$${value.toFixed(digits)}`;
}


/**
 * 比例换成百分数，留 1 位小数。
 * @param value 0～1。
 * @returns 带百分号且保留一位小数的百分比文本。
 * 副作用：无。
 */
export function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}


/**
 * 最近多少天的时间范围，到现在为止。
 * @param days 天数。
 * @param now 现在，毫秒。
 * @returns 包含起止时间戳（Unix 毫秒）的时间范围对象。
 * 副作用：无。
 */
export function getRange(days: number, now: number): { from: number; to: number } {
  return { from: now - days * DAY_MS, to: now };
}


/**
 * 一根柱子的 SVG 路径：顶上两个角圆，贴着底的两个角方（dataviz 技能：圆角只在数据那头）。
 * @param shape 柱子的位置和大小。
 * @param radius 圆角半径；不超过宽的一半，也不超过高。
 * @returns 用于 `<path d="...">` 的完整 SVG 路径命令串。
 * 副作用：无。
 */
export function getBarPath(shape: BarShape, radius: number): string {
  /** 实际用的半径。 */
  const r = Math.max(0, Math.min(radius, shape.width / 2, shape.height));
  /** 底边。 */
  const bottom = shape.y + shape.height;
  /** 右边。 */
  const right = shape.x + shape.width;
  /** 每一笔。 */
  const strokes = [
    `M${String(shape.x)},${String(bottom)}`,
    `V${String(shape.y + r)}`,
    `Q${String(shape.x)},${String(shape.y)} ${String(shape.x + r)},${String(shape.y)}`,
    `H${String(right - r)}`,
    `Q${String(right)},${String(shape.y)} ${String(right)},${String(shape.y + r)}`,
    `V${String(bottom)}`,
    'Z',
  ];
  return strokes.join(' ');
}


/**
 * 把几行按时间段或分组加到一起，命中率重算。
 * @param rows 后端回的行。
 * @param field 按哪个字段归到一起；另一个字段留空。
 */
function sumBy(rows: types.UsageRow[], field: 'key' | 'period'): types.UsageRow[] {
  /** 值 → 加到一起的那行。 */
  const sums = new Map<string, types.UsageRow>();
  for (const row of rows) {
    /** 归到哪一行。 */
    const name = row[field];
    /** 已经加了的。 */
    let sum = sums.get(name);
    if (!sum) {
      //G 尚无该分组或时间段的累计记录时，先初始化全零行并登记进映射表。
      sum = getEmptyRow();
      sum[field] = name;
      sums.set(name, sum);
    }
    sum.calls += row.calls;
    sum.failures += row.failures;
    sum.input += row.input;
    sum.output += row.output;
    sum.cacheRead += row.cacheRead;
    sum.cacheWrite += row.cacheWrite;
    sum.cost += row.cost;
    sum.ms += row.ms;
  }
  /** 加好的。 */
  const result = [...sums.values()];
  for (const sum of result) {
    //M 所有明细累加完毕后，依据总输入与总缓存读统一重算命中率。
    sum.hitRate = getHitRate(sum);
  }
  return result;
}


/** 一行全是 0 的。 */
function getEmptyRow(): types.UsageRow {
  return {
    period: '',
    key: '',
    calls: 0,
    failures: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    ms: 0,
    hitRate: 0,
  };
}
