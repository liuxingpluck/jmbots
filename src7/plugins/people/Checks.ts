/**
 * people 插件配置的入口校验：config.yaml 里 people 插件 config 段的名单（每人 id、显示名、role、memory、绑定元组）。
 * 只有 people 用，所以放在这里；字段怎么查借骨架 utils/Checks.ts 的 record、list、text、oneOf。
 * 校验一次，交回确定类型；插件内部不再查。报错只写第几项、哪个字段，不带绑定里的平台标识。
 */
import * as checks from '../../utils/Checks.ts';


/** 身份角色：本人、帮忙干活的、访客。 */
export const ROLES = ['owner', 'builder', 'guest'] as const;
export type Role = typeof ROLES[number];

/** 能读的记忆范围：自己的、当前群的、全部。 */
export const MEMORY_SCOPES = ['own', 'group', 'all'] as const;
export type MemoryScope = typeof MEMORY_SCOPES[number];

/** 一个渠道绑定元组：四项一起才认得出一个人，哪项都不能空。 */
export interface Binding {
  /** 渠道名，如 feishu、wechat。 */
  channel: string;
  /** 租户或应用的命名空间，由渠道适配器按平台定。 */
  authority: string;
  /** 本渠道接入的账号（哪个应用、哪个号）。 */
  account: string;
  /** 经适配器核验的发话人原始标识（如 open_id）；原样比对，不改大小写、不截断。 */
  subject: string;
}

/** 配置里登记的一个人，校验后。 */
export interface ConfiguredPerson {
  /** 稳定的人员号；不按显示名算，改名不变。 */
  id: string;
  /** 显示名；可以和别人重名，不参与认人。 */
  name: string;
  /** 身份角色；没写是 guest。 */
  role: Role;
  /** 记忆范围；没写时 owner 是 all，别人是 own。 */
  memory: MemoryScope;
  /** 这个人的渠道绑定；没写是空。 */
  bindings: Binding[];
}


/**
 * 把一个绑定元组拼成查表用的键。四项按位置放进 JSON 数组，任何一项里有什么字符都不会和别的元组拼成同一个键。
 * @param binding 绑定元组。
 * @returns 键。
 */
export function getBindingKey(binding: Binding): string {
  const parts = [binding.channel, binding.authority, binding.account, binding.subject];
  return JSON.stringify(parts);
}


/**
 * 校验 people 插件的配置。
 * @param raw config.yaml 里 people 插件的 config 段（没写时 Main.ts 给空对象）。
 * @returns 名单；没写 people 是空名单。
 * @throws 哪一项不对时抛错：字段缺、写法不对、人员号重复、同一绑定登记给两个人、非本人配 all、本人配 own/group。
 */
export function checkPeopleConfig(raw: unknown): ConfiguredPerson[] {
  const written = checks.checkRecord(raw, 'people 插件的配置');

  //M 没写名单：只靠自动 guest 名片。
  const listed = written['people'];
  if (listed === undefined) return [];

  const items = checks.checkArray(listed, 'people');
  /** 已出现过的人员号，查重复。 */
  const ids = new Set<string>();
  /** 已出现过的绑定键 → 第几项登记的，查同一绑定给了两个人。 */
  const owners = new Map<string, string>();
  const people: ConfiguredPerson[] = [];

  for (const [index, item] of items.entries()) {
    const label = `people[${String(index)}]`;
    const person = checkPerson(item, label);

    //G 人员号重复：两张卡分不清，拒绝。
    if (ids.has(person.id)) {
      throw new Error(`${label}.id 和前面的人重复了`);
    }
    ids.add(person.id);

    //G 同一个绑定元组只能归一个人：冲突就拒绝，不取第一条。
    for (const [bindingIndex, binding] of person.bindings.entries()) {
      const key = getBindingKey(binding);
      const earlier = owners.get(key);
      if (earlier !== undefined) {
        throw new Error(`${label}.bindings[${String(bindingIndex)}] 和 ${earlier} 登记的是同一个绑定`);
      }
      owners.set(key, `${label}.bindings[${String(bindingIndex)}]`);
    }

    people.push(person);
  }
  return people;
}


/**
 * 校验名单里的一个人。
 * @param raw 原始值。
 * @param label 是名单的第几项，写进错误信息。
 * @returns 校验后的人。
 * @throws 字段缺、写法不对，或角色和记忆范围冲突时抛错。
 */
function checkPerson(raw: unknown, label: string): ConfiguredPerson {
  const item = checks.checkRecord(raw, label);
  const id = checks.checkNonEmptyText(item['id'], `${label}.id`);
  const name = checks.checkNonEmptyText(item['name'], `${label}.name`);

  //M 角色没写是 guest：没写清的人一律不给高权限。
  let role: Role = 'guest';
  if (item['role'] !== undefined) {
    role = checks.checkAllowedValue(item['role'], ROLES, `${label}.role`);
  }

  //M 记忆范围没写：本人是 all，别人是 own。
  let memory: MemoryScope = 'own';
  if (role === 'owner') {
    memory = 'all';
  }
  if (item['memory'] !== undefined) {
    memory = checks.checkAllowedValue(item['memory'], MEMORY_SCOPES, `${label}.memory`);
  }

  //G 本人写了 own/group：和“本人能读全部”冲突，报错让用户改，不悄悄改成 all。
  if (role === 'owner' && memory !== 'all') {
    throw new Error(`${label}.memory：本人（owner）只能是 all，或者不写`);
  }

  //G 非本人配 all：首期不开放，等用户在决策图上定了再放开。
  if (role !== 'owner' && memory === 'all') {
    throw new Error(`${label}.memory：非本人暂不开放 all，只能写 own 或 group`);
  }

  //M 绑定没写是空：这个人先登记着，还认不出来。
  let bindings: Binding[] = [];
  if (item['bindings'] !== undefined) {
    const listed = checks.checkArray(item['bindings'], `${label}.bindings`);
    bindings = listed.map((entry, index) => checkBinding(entry, `${label}.bindings[${String(index)}]`));
  }

  return { id, name, role, memory, bindings };
}


/**
 * 校验一个绑定元组：四项都要非空文字，原样保留。
 * @param raw 原始值。
 * @param label 是哪个人的第几个绑定，写进错误信息。
 * @returns 绑定元组。
 */
function checkBinding(raw: unknown, label: string): Binding {
  const item = checks.checkRecord(raw, label);
  const channel = checks.checkNonEmptyText(item['channel'], `${label}.channel`);
  const authority = checks.checkNonEmptyText(item['authority'], `${label}.authority`);
  const account = checks.checkNonEmptyText(item['account'], `${label}.account`);
  const subject = checks.checkNonEmptyText(item['subject'], `${label}.subject`);
  return { channel, authority, account, subject };
}
