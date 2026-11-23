/**
 * 人员名单 people：跨渠道认人。渠道适配器拿到经平台核验的绑定元组（channel、authority、account、subject），
 * 发 people/request 的 resolve 问“这是谁”，people 回 people/result：登记过的人照配置给角色和记忆范围，
 * 没登记的自动建一张 guest 名片（固定 guest/own）。
 * 权威只有一个：人工登记和权限只在 config.yaml 的名单里（启动时建成内存里的只读投影），库里只存自动 guest 名片和它的绑定，
 * 库里不存任何角色，自动建卡也绝不提权、不按同名合并、不收请求里自报的人员号或角色。
 * 第 1 步只有插件本体：还没有渠道接线、记忆授权（authorize-memory）、名单管理（list/manage）和老记忆迁移。
 * 设计见 docs/开发进度/人员名单_细节_20261118.md，说明见同目录 说明.md。
 */
import * as crypto from 'node:crypto';
import type * as sqlite from 'bun:sqlite';
import type * as cordis from 'cordis';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as peopleChecks from './Checks.ts';


/** 插件名。 */
export const name = 'people';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
export const version = '1.0.1';

/** 用到的服务：resources 拿数据库。 */
export const inject = ['resources'];


declare module 'cordis' {
  interface Events {
    /**
     * 问 people：现在只有 resolve（这个绑定元组是谁）。渠道适配器发，people 接。
     * 谁发：src7/plugins/people/index.ts 的 resolvePerson
     * 谁接：src7/plugins/people/index.ts 的 apply
     */
    'people/request'(request: PeopleRequest): void | Promise<void>;
    /**
     * people 的回执，按 requestId 配对。
     * 谁发：src7/plugins/people/index.ts 的 apply
     * 谁接：src7/plugins/people/index.ts 的 resolvePerson
     */
    'people/result'(result: PeopleResult): void;
  }
}


/** 认出来的一个人。 */
export interface Person {
  /** 稳定的人员号：配置登记的是配置里的 id，自动名片是 p_ 加随机 UUID。 */
  id: string;
  /** 显示名；可能和别人重名，不能拿来认人或授权。 */
  name: string;
  /** 身份角色；自动名片固定 guest。 */
  role: peopleChecks.Role;
  /** 记忆范围；自动名片固定 own。 */
  memory: peopleChecks.MemoryScope;
  /** config：配置登记的人；auto：库里自动建的 guest 名片。 */
  origin: 'config' | 'auto';
}

/** people/request 的请求。 */
export type PeopleRequest = requestEventModule.RequestEnvelope & {
  /** 按绑定元组认人；没登记就建 guest 名片。 */
  action: 'resolve';
  /** 渠道适配器经平台核验后拼出的绑定元组；不能用消息正文里的名字、ID 拼。 */
  binding: peopleChecks.Binding;
  /** 平台上的显示名，只在新建自动名片时当名字用；不参与认人，以后也不拿它改名。 */
  hint?: string;
};

/** people/result 的回执。 */
export type PeopleResult = requestEventModule.ResultEnvelope & ({
  /** 认出来了（登记过的，或刚建好的 guest 名片）。 */
  status: 'ok';
  /** 认出来的人。 */
  person: Person;
} | {
  /** unknown：绑定元组不完整，认不出也不建卡；unavailable：people 没挂、超时、中止或出错。两种都不给任何角色。 */
  status: 'unknown' | 'unavailable';
  /** 一句人话原因；不带平台标识。 */
  reason: string;
});

/** people/result 去掉 requestId 的回执体：People.resolve 交回它，onRequestEvent 补上 requestId 再发。 */
type PeopleAnswer = requestEventModule.StripResultId<PeopleResult>;

/** 库里一张自动名片，查绑定时连表取出。 */
interface AutoRow {
  /** 人员号。 */
  id: string;
  /** 显示名。 */
  name: string;
}


/** 认人请求最多等多久，毫秒（设计第 5 节拟定的 1 秒，不是实测）。 */
const RESOLVE_TIMEOUT_MS = 1000;

/** 自动名片没给平台显示名时的名字。 */
const UNNAMED = '未命名访客';

/** 自动名片的名字最多几个字。 */
const NAME_MAX = 64;

/** 认人没拿到 people 回执的原因，写成人话。 */
const FALLBACK_TEXTS: Record<requestEventModule.FallbackReason, string> = {
  unhandled: '没挂 people 插件',
  aborted: '超时或中止了',
  error: '出错了',
};


/** 名单：配置登记的人（内存里的只读投影）加库里的自动 guest 名片。 */
export class People {
  /** 插件的 ctx：发跟踪点用。 */
  private readonly ctx: cordis.Context;

  /** 数据库（ctx.resources.db）：自动名片和它的绑定存在里面。 */
  private readonly db: sqlite.Database;

  /** 配置登记的人：绑定键（Checks.ts 的 getBindingKey）→ 这个人。启动时照配置建一次，不写库。 */
  private readonly configured = new Map<string, Person>();

  /**
   * 建表，把配置名单建成只读投影。
   * @param ctx 插件的 ctx；用它的 resources.db。
   * @param listed 入口校验过的配置名单（Checks.ts 的 checkPeopleConfig）。
   * 副作用：建 people_profiles、people_bindings 两张表；配置里有绑定原先归自动名片的，打一行提示（只报个数）。
   * @throws 配置的人员号和库里一张自动名片同号时抛错。
   */
  constructor(ctx: cordis.Context, listed: peopleChecks.ConfiguredPerson[]) {
    this.ctx = ctx;
    this.db = ctx.resources.db;

    //M 自动名片表：只存号、名字、建的时刻；角色和记忆范围固定 guest/own，不进库。
    this.db.exec('CREATE TABLE IF NOT EXISTS people_profiles ('
      + 'id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)');

    //M 绑定表：四项联合主键，一个绑定只能归一张卡。
    this.db.exec('CREATE TABLE IF NOT EXISTS people_bindings ('
      + 'channel TEXT NOT NULL, authority TEXT NOT NULL, account TEXT NOT NULL, subject TEXT NOT NULL,'
      + ' person_id TEXT NOT NULL REFERENCES people_profiles (id), created_at INTEGER NOT NULL,'
      + ' PRIMARY KEY (channel, authority, account, subject))');

    /** 配置里原先归自动名片的绑定有几个。 */
    let shadowed = 0;
    for (const configuredPerson of listed) {
      //G 配置的人员号和库里一张自动名片同号：同一个号两张卡，记忆和权限会串，拒绝。
      const sameIdQuery = this.db.query('SELECT id FROM people_profiles WHERE id = ?');
      const sameId = sameIdQuery.get(configuredPerson.id);
      if (sameId !== null) {
        const hint = '换一个 id；自动名片转登记要等管理操作';
        throw new Error(`people 配置里的 ${configuredPerson.id} 和库里一张自动名片同号，${hint}`);
      }

      //M 这个人的名片：角色和记忆范围照配置。
      const person: Person = {
        id: configuredPerson.id,
        name: configuredPerson.name,
        role: configuredPerson.role,
        memory: configuredPerson.memory,
        origin: 'config',
      };

      for (const binding of configuredPerson.bindings) {
        //M 绑定原先归一张自动名片：以配置为准，自动名片留在库里不动（它的老记忆以后迁移时再处理）。
        const earlier = this.findAuto(binding);
        if (earlier !== undefined) {
          shadowed += 1;
        }

        const key = peopleChecks.getBindingKey(binding);
        this.configured.set(key, person);
      }
    }

    //M 有被配置接管的绑定：提示一句，只报个数，不打印平台标识。
    if (shadowed > 0) {
      console.error(`people：配置里有 ${String(shadowed)} 个绑定原先归自动 guest 名片，现在按配置认人`);
    }
  }

  /**
   * 认人：这个绑定元组是谁。
   * @param binding 渠道适配器核验后拼出的绑定元组。
   * @param hint 平台显示名，只在新建自动名片时用。
   * @returns ok 带这个人；绑定元组有一项是空的回 unknown。
   * 副作用：没登记过时在库里建一张自动 guest 名片和它的绑定；发跟踪点。
   */
  resolve(binding: peopleChecks.Binding, hint: string | undefined): PeopleAnswer {
    //G 绑定元组有一项空：只凭昵称或空 ID 认不出人，不建能跨会话聚合的卡。
    const parts = [binding.channel, binding.authority, binding.account, binding.subject];
    const incomplete = parts.some((part) => part === '');
    if (incomplete) return { status: 'unknown', reason: '绑定元组不完整，认不出是谁' };

    //M 先查配置登记的人：人工登记和权限只认配置。
    const key = peopleChecks.getBindingKey(binding);
    let person = this.configured.get(key);

    //M 配置里没有：查库里的自动名片，还没有就新建一张 guest 名片。
    if (person === undefined) {
      person = this.getAuto(binding, hint);
    }

    //T 跟踪点：认出了谁（不带平台标识）。
    const vars = {
      personName: person.name,
      channel: binding.channel,
      personId: person.id,
      source: person.origin,
      role: person.role,
      memory: person.memory,
    };
    this.ctx.emit('trace', 'People.resolve', 'trace.people.resolve', 'people.resolve(binding)', vars);
    return { status: 'ok', person };
  }

  /**
   * 取库里这个绑定的自动名片，没有就建一张。
   * @param binding 完整的绑定元组。
   * @param hint 平台显示名。
   * @returns 自动名片（guest/own）。
   * 副作用：可能插入 people_profiles、people_bindings 各一行。
   */
  private getAuto(binding: peopleChecks.Binding, hint: string | undefined): Person {
    //M 多数时候已经建过：只读不加写锁。
    const found = this.findAuto(binding);
    if (found !== undefined) return found;

    //M 新建放进一个事务：两条首次消息同时来只留一张卡，插绑定失败时名片一起回滚，不留孤卡。
    const create = this.db.transaction(() => {
      //G 拿到写锁后再查一次：别处可能刚建好。
      const existing = this.findAuto(binding);
      if (existing !== undefined) return existing;

      const id = `p_${crypto.randomUUID()}`;
      const personName = getAutoName(hint);
      const now = Date.now();

      //M 先插名片，再插绑定（绑定的 person_id 指向名片）。
      const insertProfile = this.db.query('INSERT INTO people_profiles (id, name, created_at) VALUES (?, ?, ?)');
      insertProfile.run(id, personName, now);

      const bindingSql = 'INSERT INTO people_bindings'
        + ' (channel, authority, account, subject, person_id, created_at) VALUES (?, ?, ?, ?, ?, ?)';
      const insertBinding = this.db.query(bindingSql);
      insertBinding.run(
        binding.channel,
        binding.authority,
        binding.account,
        binding.subject,
        id,
        now,
      );
      return getAutoPerson({ id, name: personName });
    });

    //M immediate：开事务就拿写锁，查和插之间别人插不进来。
    return create.immediate();
  }

  /**
   * 查库里这个绑定归哪张自动名片。
   * @param binding 绑定元组。
   * @returns 自动名片；没有是 undefined。
   */
  private findAuto(binding: peopleChecks.Binding): Person | undefined {
    const sql = 'SELECT p.id AS id, p.name AS name FROM people_bindings b'
      + ' JOIN people_profiles p ON p.id = b.person_id'
      + ' WHERE b.channel = ? AND b.authority = ? AND b.account = ? AND b.subject = ?';
    const query = this.db.query<AutoRow, sqlite.SQLQueryBindings[]>(sql);
    const row = query.get(binding.channel, binding.authority, binding.account, binding.subject);
    if (row === null) return undefined;

    return getAutoPerson(row);
  }
}


/**
 * 库里的一行拼成自动名片：角色、记忆范围固定 guest/own。
 * @param row 名片的号和名字。
 * @returns 自动名片。
 */
function getAutoPerson(row: AutoRow): Person {
  return { id: row.id, name: row.name, role: 'guest', memory: 'own', origin: 'auto' };
}


/**
 * 自动名片的名字：平台显示名去掉首尾空白、截到 NAME_MAX 个字；没给或是空的叫“未命名访客”。
 * @param hint 平台显示名。
 * @returns 名字。
 */
function getAutoName(hint: string | undefined): string {
  const trimmed = (hint ?? '').trim();
  if (trimmed === '') return UNNAMED;

  return textModule.clipText(trimmed, NAME_MAX);
}


/**
 * 问 people 这个绑定元组是谁。给渠道适配器用：在发进来的渠道事件（channel/direct、mention、listen）、构造本轮来源快照之前调。
 * 走 people/request → people/result，不直接调 People 的方法；people 没挂、超时（1 秒）、中止、出错，一律回 unavailable，
 * 不给任何角色。调用方拿到不是 ok 的，按“认不出”处理，不能回退成本人。
 * @param ctx 调用方插件的 ctx。
 * @param binding 经平台核验的绑定元组。
 * @param hint 平台显示名，新建自动名片时当名字。
 * @param signal 可选中止信号。
 * @returns people/result 的回执。
 */
export async function resolvePerson(
  ctx: cordis.Context,
  binding: peopleChecks.Binding,
  hint?: string,
  signal?: AbortSignal,
): Promise<PeopleResult> {
  const payload = { action: 'resolve' as const, binding, hint };

  //M 认人最多等 1 秒：自己的时限和调用方的中止信号合成一个交给 requestEvent。
  const signals = [AbortSignal.timeout(RESOLVE_TIMEOUT_MS)];
  if (signal !== undefined) {
    signals.push(signal);
  }
  const options = { prefix: 'ppl', signal: AbortSignal.any(signals) };
  const asked = await requestEventModule.requestEvent(ctx, 'people/request', 'people/result', payload, options);
  if (asked.why === undefined) return asked.reply;

  //G 没拿到 people 的回执：关闭范围，不给角色。
  const text = FALLBACK_TEXTS[asked.why];
  return { requestId: '', status: 'unavailable', reason: `people 不可用：${text}` };
}


/**
 * 插件入口。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config config.yaml 里 people 插件的 config 段：people 名单（见 Checks.ts）。
 * 副作用：建表；听 people/request。
 * @throws 名单不对，或配置的人员号和库里自动名片同号时抛错（插件不挂，别的插件照常）。
 */
export function apply(ctx: cordis.Context, config: unknown): void {
  //M 入口校验一次名单，内部只用校验过的。
  const listed = peopleChecks.checkPeopleConfig(config);

  //M 建表，配置名单建成只读投影。
  const people = new People(ctx, listed);

  //M 出错时回 unavailable，原因只写一句，详细错误打到标准错误（不带平台标识）。
  const onError = (error: unknown): PeopleAnswer => {
    const detail = textModule.getErrorMessage(error);
    console.error(`people：认人出错：${detail}`);
    return { status: 'unavailable', reason: 'people 出错了' };
  };

  //M 接 people/request：现在只有 resolve 一种。
  requestEventModule.onRequestEvent(ctx, 'people/request', 'people/result', (request) => {
    return people.resolve(request.binding, request.hint);
  }, { onError });
}
