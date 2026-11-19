/** 和业务无关且在两处或更多地方共用的工具，例如对象、数组的遍历和字段读取。 */

/**
 * 读取对象的指定字段。
 * @param value 待读取的对象，null、数组和非对象值视为空对象。
 * @param key 哪一项。
 * @returns 那一项；没有是 undefined。
 */
export function getField(value: unknown, key: string): unknown {
  //G 只从非空、非数组的对象取字段。
  if (typeof value !== 'object') return undefined;
  if (value === null) return undefined;
  if (Array.isArray(value)) return undefined;

  const where = value as Record<string, unknown>;
  return where[key];
}


/**
 * 读取对象的字符串字段。
 * @param value 同 getField。
 * @param key 哪一项。
 * @returns 字符串字段的原值，字段缺失或类型不符时返回空字符串。
 */
export function getStringField(value: unknown, key: string): string {
  //M 复用对象字段读取规则，再检查字段类型。
  const field = getField(value, key);
  //M 是字符串就原样给，别的（没有、数字、对象）给空串。
  if (typeof field === 'string') return field;

  return '';
}


/**
 * 逐个处理一组“名字: 值”（Record：配置里的 providers、models，内嵌文件表这类）。
 * 用它代替 `for (const [name, value] of Object.entries(record))`，读的人一眼看出是在逐个处理哪一样。
 * 只用于同步的处理：each 里不能 await，也不能 break；要提前停或要等的，照旧写 for 循环。
 * @param record 要遍历的对象。键的范围和顺序与 Object.entries 相同。
 * @param each 每一项调一次。name 是键（比如供应商名），value 是值（比如这家供应商的配置）。
 * 副作用：本身没有；each 做什么由调用方定。
 */
export function eachEntry<T>(
  record: Readonly<Record<string, T>>,
  each: (name: string, value: T) => void,
): void {
  for (const [name, value] of Object.entries(record)) {
    //M 把当前的键和值交给调用方处理。
    each(name, value);
  }
}
