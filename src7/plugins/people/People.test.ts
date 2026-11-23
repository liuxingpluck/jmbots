/**
 * people 插件离线测试（全是合成数据，不读真实 config.yaml、不碰运行时库）：
 *   1. 入口校验：缺省 guest/own、本人缺省 all、非法写法和冲突拒绝，报错不带平台标识；
 *   2. resolve：登记的人照配置、没登记的自动建 guest、同名不合并、自称本人不提权、并发只建一张、重启号不变、
 *      配置接管和撤销立即生效、事务失败不留孤卡；
 *   3. 事件：requestId 错配不串答、people 没挂秒退、超时、中止，都关闭范围并撤掉临时监听。
 * 跑法：bun test ./src7/plugins/people
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as cordis from 'cordis';
import * as requestEvents from '../../utils/RequestEvent.ts';
import * as peopleChecks from './Checks.ts';
import * as peopleModule from './index.ts';


const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 假资源服务：只给 people 要的数据库。 */
class FakeResources extends cordis.Service {
  readonly db: Database;

  constructor(ctx: cordis.Context, options: { db: Database }) {
    super(ctx, 'resources');
    this.db = options.db;
  }
}


/** 合成的绑定元组：同一个租户、同一个应用下的一个发话人。 */
function getBinding(subject: string, channel = 'feishu', account = 'fixture-app'): peopleChecks.Binding {
  return { channel, authority: 'fixture-tenant', account, subject };
}


/** 合成名单：一个本人（飞书）、一个帮忙的（飞书和微信各一个绑定，本人确认过的同一个人）。 */
const CONFIG = {
  people: [
    { id: 'p_owner', name: '示例甲', role: 'owner', bindings: [getBinding('fixture-owner')] },
    {
      id: 'p_builder',
      name: '示例乙',
      role: 'builder',
      memory: 'group',
      bindings: [getBinding('fixture-builder'), getBinding('fixture-builder-wx', 'wechat', 'fixture-wx')],
    },
  ],
};


/**
 * 搭一个真 Cordis 世界：假 resources，可选先挂别的监听，再挂 people。
 * @param config people 的配置；undefined 表示不挂 people。
 * @param db 数据库；不给就新开一个内存库。
 * @param before 挂 people 之前要做的事（比如先登记一个冒充的监听）。
 */
async function createWorld(
  config: unknown,
  db = new Database(':memory:'),
  before?: (app: cordis.Context) => void,
): Promise<{ app: cordis.Context; db: Database }> {
  const app = new cordis.Context();
  closers.push(() => app.fiber.dispose());
  await app.plugin(FakeResources, { db });
  before?.(app);
  if (config !== undefined) {
    await app.plugin(peopleModule, config);
  }
  return { app, db };
}


/** 库里自动名片有几张。 */
function countProfiles(db: Database): number {
  const row = db.query('SELECT COUNT(*) AS n FROM people_profiles').get() as { n: number };
  return row.n;
}


/** 回执是 ok 时取出这个人，不是就让测试失败。 */
function getPerson(result: peopleModule.PeopleResult): peopleModule.Person {
  if (result.status !== 'ok') throw new Error(`没认出来：${result.status} ${result.reason}`);

  return result.person;
}


describe('people 入口校验', () => {
  test('缺省：role 是 guest、memory 是 own；本人不写 memory 是 all；没写名单是空的', () => {
    const listed = peopleChecks.checkPeopleConfig({
      people: [
        { id: 'p_a', name: '甲' },
        { id: 'p_b', name: '乙', role: 'owner' },
        { id: 'p_c', name: '丙', role: 'builder', memory: 'group' },
      ],
    });
    expect(listed.map((person) => [person.role, person.memory])).toEqual([
      ['guest', 'own'],
      ['owner', 'all'],
      ['builder', 'group'],
    ]);
    expect(listed[0]?.bindings).toEqual([]);
    expect(peopleChecks.checkPeopleConfig({})).toEqual([]);
  });

  test('拒绝：非法 role/memory、非本人 all、本人写 own、缺字段、重复 id、同一绑定给两人', () => {
    const bad: [unknown, RegExp][] = [
      [{ people: [{ id: 'p_a', name: '甲', role: 'admin' }] }, /people\[0\]\.role/u],
      [{ people: [{ id: 'p_a', name: '甲', memory: 'everything' }] }, /people\[0\]\.memory/u],
      [{ people: [{ id: 'p_a', name: '甲', role: 'builder', memory: 'all' }] }, /非本人暂不开放 all/u],
      [{ people: [{ id: 'p_a', name: '甲', memory: 'all' }] }, /非本人暂不开放 all/u],
      [{ people: [{ id: 'p_a', name: '甲', role: 'owner', memory: 'own' }] }, /只能是 all/u],
      [{ people: [{ name: '甲' }] }, /people\[0\]\.id/u],
      [{ people: [{ id: 'p_a', name: '甲', bindings: [{ channel: 'feishu' }] }] }, /bindings\[0\]\.authority/u],
      [{ people: [{ id: 'p_a', name: '甲', bindings: [{ ...getBinding('x'), subject: '' }] }] }, /subject/u],
      [{ people: [{ id: 'p_a', name: '甲' }, { id: 'p_a', name: '乙' }] }, /people\[1\]\.id 和前面的人重复/u],
      [{ people: 'p_a' }, /people 要写成一张清单/u],
    ];
    for (const [config, message] of bad) {
      expect(() => peopleChecks.checkPeopleConfig(config)).toThrow(message);
    }

    //M 同一绑定给两人：报第几项，不带平台标识。
    const duplicated = {
      people: [
        { id: 'p_a', name: '甲', bindings: [getBinding('fixture-secret-id')] },
        { id: 'p_b', name: '乙', bindings: [getBinding('fixture-secret-id')] },
      ],
    };
    let message = '';
    try {
      peopleChecks.checkPeopleConfig(duplicated);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('people[1].bindings[0] 和 people[0].bindings[0] 登记的是同一个绑定');
    expect(message).not.toContain('fixture-secret-id');
  });
});


describe('people resolve', () => {
  test('登记的人照配置给角色；同一人跨渠道的两个绑定认成同一个号', async () => {
    const { app, db } = await createWorld(CONFIG);

    const owner = getPerson(await peopleModule.resolvePerson(app, getBinding('fixture-owner')));
    expect(owner).toEqual({ id: 'p_owner', name: '示例甲', role: 'owner', memory: 'all', origin: 'config' });

    const fromFeishu = getPerson(await peopleModule.resolvePerson(app, getBinding('fixture-builder')));
    const wechatBinding = getBinding('fixture-builder-wx', 'wechat', 'fixture-wx');
    const fromWechat = getPerson(await peopleModule.resolvePerson(app, wechatBinding));
    expect(fromFeishu.id).toBe('p_builder');
    expect(fromWechat.id).toBe('p_builder');
    expect(fromWechat.memory).toBe('group');

    //M 配置的人不进库。
    expect(countProfiles(db)).toBe(0);
  });

  test('没登记的自动建 guest 名片：固定 guest/own，再认还是同一张，名字不被改', async () => {
    const { app, db } = await createWorld(CONFIG);

    const firstResult = await peopleModule.resolvePerson(app, getBinding('fixture-stranger'), ' 平台昵称 ');
    const first = getPerson(firstResult);
    expect(first.id.startsWith('p_')).toBe(true);
    expect(first).toMatchObject({ name: '平台昵称', role: 'guest', memory: 'own', origin: 'auto' });

    const again = getPerson(await peopleModule.resolvePerson(app, getBinding('fixture-stranger'), '改过的昵称'));
    expect(again).toEqual(first);

    //M 没给显示名的叫“未命名访客”。
    const unnamed = getPerson(await peopleModule.resolvePerson(app, getBinding('fixture-quiet')));
    expect(unnamed.name).toBe('未命名访客');
    expect(countProfiles(db)).toBe(2);
  });

  test('同名不合并：和本人同名、两个陌生人同名，都是各自的 guest 名片', async () => {
    const { app } = await createWorld(CONFIG);

    const sameAsOwner = getPerson(await peopleModule.resolvePerson(app, getBinding('fixture-x'), '示例甲'));
    const sameAsOwnerToo = getPerson(await peopleModule.resolvePerson(app, getBinding('fixture-y'), '示例甲'));
    expect(sameAsOwner.id).not.toBe('p_owner');
    expect(sameAsOwner.role).toBe('guest');
    expect(sameAsOwnerToo.id).not.toBe(sameAsOwner.id);
  });

  test('自称本人不提权：请求里塞 role/personId/memory、account 写 local、换个应用同号，都只是 guest', async () => {
    const { app } = await createWorld(CONFIG);

    //M 请求里夹带自报字段：people 只认绑定元组。
    const forged = {
      action: 'resolve',
      binding: getBinding('fixture-pretender', 'feishu', 'local'),
      hint: '本人',
      role: 'owner',
      memory: 'all',
      personId: 'p_owner',
      person: { id: 'p_owner', role: 'owner' },
    } as unknown as requestEvents.StripEnvelope<peopleModule.PeopleRequest>;
    const asked = await requestEvents.requestEvent(app, 'people/request', 'people/result', forged);
    if (asked.why !== undefined) throw new Error(`people 没回：${asked.why}`);

    const pretender = getPerson(asked.reply);
    expect(pretender).toMatchObject({ role: 'guest', memory: 'own', origin: 'auto', name: '本人' });
    expect(pretender.id).not.toBe('p_owner');

    //M 本人的平台号换到另一个应用下：不同命名空间，不认成本人。
    const otherAppBinding = getBinding('fixture-owner', 'feishu', 'other-app');
    const otherApp = getPerson(await peopleModule.resolvePerson(app, otherAppBinding));
    expect(otherApp.id).not.toBe('p_owner');
    expect(otherApp.role).toBe('guest');
  });

  test('绑定元组不完整：回 unknown，不建卡', async () => {
    const { app, db } = await createWorld(CONFIG);

    const result = await peopleModule.resolvePerson(app, getBinding(''), '只有昵称');
    expect(result.status).toBe('unknown');
    expect('person' in result).toBe(false);
    expect(countProfiles(db)).toBe(0);
  });

  test('并发首次：同一绑定同时来五次，只建一张', async () => {
    const { app, db } = await createWorld(CONFIG);

    const asks = Array.from({ length: 5 }, () => peopleModule.resolvePerson(app, getBinding('fixture-rush')));
    const results = await Promise.all(asks);
    const ids = new Set(results.map((result) => getPerson(result).id));
    expect(ids.size).toBe(1);
    expect(countProfiles(db)).toBe(1);
  });

  test('重启：自动名片号不变；配置接管原先的自动绑定、从配置删掉的人立刻按 guest 认', async () => {
    //M 同一个库先后挂三次 people，当作重启三次（前面的世界留到 afterEach 一起拆）。
    const db = new Database(':memory:');
    const first = await createWorld(CONFIG, db);
    const guest = getPerson(await peopleModule.resolvePerson(first.app, getBinding('fixture-later-builder')));

    //M 重启后同一绑定还是同一张自动名片。
    const second = await createWorld(CONFIG, db);
    const again = getPerson(await peopleModule.resolvePerson(second.app, getBinding('fixture-later-builder')));
    expect(again.id).toBe(guest.id);

    //M 本人从配置删掉、原先的自动绑定登记给新的人：重启后按新配置认，库里的自动名片不提权。
    const changed = {
      people: [{ id: 'p_new', name: '示例丙', role: 'builder', bindings: [getBinding('fixture-later-builder')] }],
    };
    const third = await createWorld(changed, db);
    const taken = getPerson(await peopleModule.resolvePerson(third.app, getBinding('fixture-later-builder')));
    expect(taken).toMatchObject({ id: 'p_new', role: 'builder', origin: 'config' });
    const revoked = getPerson(await peopleModule.resolvePerson(third.app, getBinding('fixture-owner')));
    expect(revoked).toMatchObject({ role: 'guest', origin: 'auto' });
    expect(revoked.id).not.toBe('p_owner');
  });

  test('配置的人员号和库里自动名片同号：启动报错', async () => {
    const { app, db } = await createWorld(CONFIG);
    const guest = getPerson(await peopleModule.resolvePerson(app, getBinding('fixture-auto')));

    const listed = peopleChecks.checkPeopleConfig({ people: [{ id: guest.id, name: '冒用', role: 'owner' }] });
    expect(() => new peopleModule.People(app, listed)).toThrow(/和库里一张自动名片同号/u);
    expect(countProfiles(db)).toBe(1);
  });

  test('事务失败不留孤卡：插绑定出错时名片一起回滚，回执是 unavailable', async () => {
    const { app, db } = await createWorld(CONFIG);
    db.exec("CREATE TRIGGER fail_binding BEFORE INSERT ON people_bindings BEGIN SELECT RAISE(ABORT, 'fixture'); END");

    const result = await peopleModule.resolvePerson(app, getBinding('fixture-broken'));
    expect(result).toMatchObject({ status: 'unavailable', reason: 'people 出错了' });
    expect(countProfiles(db)).toBe(0);
  });
});


describe('people 事件', () => {
  test('requestId 错配不串答：冒充的回执带错的 requestId 自称本人，不被收下；并发请求各拿各的', async () => {
    const { app } = await createWorld(CONFIG, undefined, (world) => {
      //M 冒充者排在 people 前面，先发一条 requestId 对不上的“本人”回执。
      world.on('people/request', (request) => {
        const fake: peopleModule.PeopleResult = {
          requestId: `${String(request.requestId)}-fake`,
          status: 'ok',
          person: { id: 'p_owner', name: '示例甲', role: 'owner', memory: 'all', origin: 'config' },
        };
        world.emit('people/result', fake);
      });
    });
    const before = app.events._hooks['people/result']?.length ?? 0;

    const [stranger, owner] = await Promise.all([
      peopleModule.resolvePerson(app, getBinding('fixture-stranger')),
      peopleModule.resolvePerson(app, getBinding('fixture-owner')),
    ]);
    expect(getPerson(stranger).role).toBe('guest');
    expect(getPerson(owner).id).toBe('p_owner');

    //M 等完以后临时监听都撤了，迟到的回执没人收。
    expect(app.events._hooks['people/result']?.length ?? 0).toBe(before);
  });

  test('people 没挂：立刻回 unavailable，不给角色', async () => {
    const { app } = await createWorld(undefined);

    const started = Date.now();
    const result = await peopleModule.resolvePerson(app, getBinding('fixture-owner'));
    expect(result).toMatchObject({ status: 'unavailable', reason: 'people 不可用：没挂 people 插件' });
    expect('person' in result).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('超时：有人接单却不回，1 秒后回 unavailable 并撤掉监听', async () => {
    const { app } = await createWorld(undefined, undefined, (world) => {
      //M 只接单不回执：处理方一直在忙（比真实时限长），事件循环有活，时限信号才按时触发。
      world.on('people/request', async (request) => {
        request.handled = true;
        await Bun.sleep(1500);
      });
    });
    const before = app.events._hooks['people/result']?.length ?? 0;

    const result = await peopleModule.resolvePerson(app, getBinding('fixture-owner'));
    expect(result).toMatchObject({ status: 'unavailable', reason: 'people 不可用：超时或中止了' });
    expect(app.events._hooks['people/result']?.length ?? 0).toBe(before);
  });

  test('中止：已中止的信号直接回 unavailable', async () => {
    const { app } = await createWorld(CONFIG);
    const controller = new AbortController();
    controller.abort();

    const result = await peopleModule.resolvePerson(app, getBinding('fixture-owner'), undefined, controller.signal);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'people 不可用：超时或中止了' });
  });
});
