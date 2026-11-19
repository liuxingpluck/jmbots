/** 按提醒配置把模型给出的本地日期转换为 UTC，并校验夏令时边界。 */

const DAY_MS = 86_400_000;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const LOCAL = /^(\d{4}-\d{2}-\d{2})(?:[T ]((?:[01]\d|2[0-3]):[0-5]\d))?$/u;

/** 一个插件实例使用同一份时区和早上默认时刻。 */
export class ReminderTime {
  readonly zone: string;
  readonly morning: string;
  private readonly clock: Intl.DateTimeFormat;

  /** 校验 `plugins[assist].config.reminders` 并建立时区格式化器。 */
  constructor(config: unknown) {
    const input = config ?? {};
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('assist.reminders 要是一组配置');
    }

    const values = input as Record<string, unknown>;
    const zone = values['time_zone'] ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const morning = values['morning'] ?? '09:00';
    if (typeof zone !== 'string' || zone === '' || /^[+-]/u.test(zone)) {
      throw new Error('assist.reminders.time_zone 要是 IANA 时区名');
    }
    if (typeof morning !== 'string' || !TIME.test(morning)) {
      throw new Error('assist.reminders.morning 要是 HH:mm');
    }

    try {
      //M 用同一时钟显示绝对时间，也查本地时刻所在日期的时区偏移。
      this.clock = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZoneName: 'longOffset',
      });
    } catch {
      throw new Error('assist.reminders.time_zone 要是有效的 IANA 时区名');
    }
    this.zone = this.clock.resolvedOptions().timeZone;
    this.morning = morning;
  }

  /** 显示指定 UTC 毫秒在配置时区里的日历日期和分钟。 */
  format(at: number): string {
    const parts = this.clock.formatToParts(at);
    const get = (type: Intl.DateTimeFormatPartTypes): string => {
      //M 按字段名取日期和时间片段，结果顺序由提醒格式固定。
      const part = parts.find((item) => item.type === type);
      return part!.value;
    };
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  }

  /** 接 `YYYY-MM-DD[ HH:mm]`，省略分钟时用 morning。返回最早匹配的 UTC 毫秒。 */
  parse(written: string): number {
    const local = LOCAL.exec(written);
    if (local === null) throw new Error('提醒时间要写成 YYYY-MM-DD HH:mm 或 YYYY-MM-DD');

    const date = local[1];
    const time = local[2] ?? this.morning;
    const isoMinute = `${date}T${time}`;
    const asUtc = Date.parse(`${isoMinute}:00Z`);
    if (!Number.isFinite(asUtc) || new Date(asUtc).toISOString().slice(0, 16) !== isoMinute) {
      throw new Error('提醒日期无效');
    }

    //M 同时尝试换钟前后的偏移。重复的一小时取先发生的一次，跳过的时刻退回模型核对。
    const nearby = [asUtc - DAY_MS, asUtc + DAY_MS];
    let earliest = Infinity;
    for (const instant of nearby) {
      const parts = this.clock.formatToParts(instant);
      const offsetName = parts.find((item) => item.type === 'timeZoneName');
      const offset = offsetName!.value.slice(3) || 'Z';
      const candidate = Date.parse(`${isoMinute}:00${offset}`);
      if (!Number.isFinite(candidate)) continue;

      const localMinute = `${date} ${time}`;
      //G 换算回配置时区后仍是用户写的那一分钟，才接受这个 UTC 时刻。
      const candidateMinute = this.format(candidate);
      if (candidateMinute === localMinute) {
        earliest = Math.min(earliest, candidate);
      }
    }
    if (!Number.isFinite(earliest)) throw new Error('这个时区在该日期没有这个时刻');

    return earliest;
  }
}
