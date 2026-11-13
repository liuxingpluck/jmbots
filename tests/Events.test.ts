/**
 * 事件总线的离线测试（docs/11_附_事件总线_第一步实现.md 第 6.2 节 1～5、9、13）：写库、订阅、处理器出错不挡、密钥和截短、
 * 去重的键、链条太深、问（没人挂、叫停、超时、记 gate.decided）、过期删除、取整串、按条件查。
 * 临时运行时目录、内存数据库，不联网、不调模型。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as eventsModule from '../src/capabilities/Events.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as resourcesModule from '../src/resources/Resources.ts';


/** 临时目录的根：JMBOTS_TEST_TMP 优先，没设就用系统临时目录。 */
const TMP_ROOT = process.env.JMBOTS_TEST_TMP ?? os.tmpdir();

/** 一个密钥的真值（够 8 个字才会被换掉）。 */
const SECRET = 'sk-test-secret-123456';


/** 一次测试的东西。 */
interface Harness {
  /** 事件总线。 */
  bus: eventsModule.EventBus;
  /** 数据库。 */
  store: storeModule.Store;
  /** 临时运行时目录。 */
  dir: string;
}


/**
 * 建事件总线：拦处理器最多等 50 毫秒，链条最多 2 层。
 * @returns 事件总线、数据库、目录。
 */
async function setup(): Promise<Harness> {
  /** 临时运行时目录。 */
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'jmbots-events-'));
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    'providers: {}\ndefault_model: magpie/test\nbots:\n  - name: 小测\n    language: zh\nevents:\n  gate_timeout_ms: 50\n  max_depth: 2\n  keep_days: 30\n',
  );
  /** 资源。 */
  const resources = await resourcesModule.Resources.load(dir);
  /** 数据库。 */
  const store = new storeModule.Store(':memory:');
  return { bus: new eventsModule.EventBus(store, resources, new secretsModule.Secrets([SECRET])), store, dir };
}


bunTest.test('报：没人订也照样写一行；精确订阅和 xxx.* 订阅都叫到，step.* 叫不到 tool.after', async () => {
  /** 测试的东西。 */
  const h = await setup();
  try {
    /** 叫到的。 */
    const heard: string[] = [];
    h.bus.on('tool.after', () => {
      heard.push('精确');
    });
    h.bus.on('tool.*', () => {
      heard.push('通配');
    });
    h.bus.on('step.*', () => {
      heard.push('不该叫到');
    });
    /** 记下的。 */
    const record = h.bus.emit('tool.after', { tool: 'read' }, { source: '测试', bot: '小测', sessionId: 's1' });
    bunTest.expect(record?.id).toBeGreaterThan(0);
    bunTest.expect(heard).toEqual(['精确', '通配']);
    bunTest.expect(h.store.listEvents({ sessionId: 's1', limit: 10 }).map((row) => row.type)).toEqual(['tool.after']);
    bunTest.expect(h.bus.emit('run.started', {}, { source: '测试' })?.type).toBe('run.started');
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});


bunTest.test('观察处理器抛错、异步出错都不挡后面的处理器，也不挡报事件', async () => {
  /** 测试的东西。 */
  const h = await setup();
  /** 原来的 console.error。 */
  const originalError = console.error;
  /** 打出来的错。 */
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  try {
    /** 最后一个处理器叫到没有。 */
    let lastCalled = false;
    h.bus.on('x.y', () => {
      throw new Error('同步出错');
    });
    h.bus.on('x.y', () => Promise.reject(new Error('异步出错')));
    h.bus.on('x.y', () => {
      lastCalled = true;
    });
    bunTest.expect(h.bus.emit('x.y', {}, { source: '测试' })).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 10));
    bunTest.expect(lastCalled).toBe(true);
    bunTest.expect(logged.some((line) => line.includes('同步出错'))).toBe(true);
    bunTest.expect(logged.some((line) => line.includes('异步出错'))).toBe(true);
  } finally {
    console.error = originalError;
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});


bunTest.test('数据进库前：密钥换成替身，太长的字截短并注明原长，嵌在对象、数组里的也一样', async () => {
  /** 测试的东西。 */
  const h = await setup();
  try {
    /** 很长的字。 */
    const long = '字'.repeat(5000);
    /** 记下的。 */
    const record = h.bus.emit('reply.before', { text: `密钥是 ${SECRET}`, nested: { list: [SECRET, long] } }, { source: '测试' });
    /** 库里那一行。 */
    const row = h.store.getEvent(record!.id)!;
    /** 整条转成文字。 */
    const json = JSON.stringify(row.data);
    bunTest.expect(json).not.toContain(SECRET);
    bunTest.expect(json).toContain('{{secret:1}}');
    bunTest.expect(json).toContain('共 5000 字');
    bunTest.expect(json.length).toBeLessThan(5000);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});


bunTest.test('去重的键：同一个类型、同一个键第二次不记；forget 以后又能记；不同类型同一个键各记各的', async () => {
  /** 测试的东西。 */
  const h = await setup();
  try {
    /** 键。 */
    const key = 'https://mp.weixin.qq.com/s/abc';
    bunTest.expect(h.bus.emit('公众号.新标签', {}, { source: '测试', key })).toBeDefined();
    bunTest.expect(h.bus.emit('公众号.新标签', {}, { source: '测试', key })).toBeUndefined();
    bunTest.expect(h.bus.seen('公众号.新标签', key)).toBe(true);
    bunTest.expect(h.bus.emit('公众号.抓取完成', {}, { source: '测试', key })).toBeDefined();
    bunTest.expect(h.bus.forget('公众号.新标签', key)).toBe(true);
    bunTest.expect(h.bus.seen('公众号.新标签', key)).toBe(false);
    bunTest.expect(h.bus.emit('公众号.新标签', {}, { source: '测试', key })).toBeDefined();
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});


bunTest.test('链条太深（超过 max_depth 2）：不记，改记一条 event.too_deep；取整串按号从小到大', async () => {
  /** 测试的东西。 */
  const h = await setup();
  try {
    /** 第 0 层。 */
    const top = h.bus.emit('a.b', {}, { source: '测试' })!;
    /** 第 1 层。 */
    const one = h.bus.emit('a.c', {}, { source: '测试', parent: top.id })!;
    /** 第 2 层。 */
    const two = h.bus.emit('a.d', {}, { source: '测试', parent: one.id })!;
    bunTest.expect([top.depth, one.depth, two.depth]).toEqual([0, 1, 2]);
    bunTest.expect(h.bus.emit('a.e', {}, { source: '测试', parent: two.id })).toBeUndefined();
    bunTest.expect(h.store.listEvents({ type: 'event.too_deep', limit: 5 })).toHaveLength(1);
    bunTest.expect(h.bus.chain(two.id).map((row) => row.type)).toEqual(['a.b', 'a.c', 'a.d']);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});


bunTest.test('问：没人挂马上放行、不记 gate.decided；挂了的按先后问，谁叫停就停，后面的不再问', async () => {
  /** 测试的东西。 */
  const h = await setup();
  try {
    bunTest.expect(h.bus.hasGate('dispatch.decided')).toBe(false);
    bunTest.expect(await h.bus.gate('dispatch.decided', {}, { source: '测试' })).toEqual({ go: true });
    bunTest.expect(h.store.listEvents({ type: 'gate.decided', limit: 5 })).toHaveLength(0);
    /** 问到的。 */
    const asked: string[] = [];
    h.bus.onGate('tool.before', () => {
      asked.push('第二个');
      return { go: false, reason: '不许删' };
    }, 20, '第二个');
    h.bus.onGate('tool.*', () => {
      asked.push('第一个');
      return { go: true };
    }, 10, '第一个');
    h.bus.onGate('tool.before', () => {
      asked.push('第三个');
      return { go: true };
    }, 30, '第三个');
    /** 结果。 */
    const result = await h.bus.gate('tool.before', { tool: 'exec' }, { source: '测试', sessionId: 's1' });
    bunTest.expect(asked).toEqual(['第一个', '第二个']);
    bunTest.expect(result).toEqual({ go: false, reason: '不许删', by: '第二个' });
    /** 记下的 gate.decided。 */
    const decided = h.store.listEvents({ type: 'gate.decided', limit: 5 });
    bunTest.expect(decided).toHaveLength(1);
    /** 问的那一条。 */
    const askedEvent = h.store.listEvents({ type: 'tool.before', limit: 5 })[0]!;
    bunTest.expect(decided[0]!.parent).toBe(askedEvent.id);
    bunTest.expect(decided[0]!.sessionId).toBe('s1');
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});


bunTest.test('问：拦处理器出错、超时都按放行；给了 decision 的照样带回来', async () => {
  /** 测试的东西。 */
  const h = await setup();
  /** 原来的 console.error。 */
  const originalError = console.error;
  console.error = () => undefined;
  try {
    h.bus.onGate('limit.reached', () => {
      throw new Error('坏了');
    }, 10, '出错的');
    h.bus.onGate('limit.reached', () => new Promise(() => undefined), 20, '不回话的');
    h.bus.onGate('limit.reached', () => ({ go: true, extendMinutes: 5 }), 30, '续时间的');
    /** 结果。 */
    const result = await h.bus.gate('limit.reached', {}, { source: '测试' });
    bunTest.expect(result.go).toBe(true);
    bunTest.expect(result.extendMinutes).toBe(5);
    bunTest.expect(result.by).toBe('续时间的');
  } finally {
    console.error = originalError;
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});


bunTest.test('过期的事件第一次报的时候删掉（记过的键不删）；按类型、会话、时间、条数查', async () => {
  /** 测试的东西。 */
  const h = await setup();
  try {
    /** 31 天前。 */
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    h.store.addEvent({ type: 'old.one', at: old, source: '测试', bot: null, sessionId: 's0', messageId: null, key: 'k', data: {}, parent: null, depth: 0 });
    h.bus.emit('tool.after', {}, { source: '测试', sessionId: 's1' });
    h.bus.emit('tool.before', {}, { source: '测试', sessionId: 's1' });
    h.bus.emit('step.after', {}, { source: '测试', sessionId: 's2' });
    bunTest.expect(h.store.listEvents({ type: 'old.one', limit: 5 })).toHaveLength(0);
    bunTest.expect(h.store.hasEventKey('old.one', 'k')).toBe(true);
    bunTest.expect(h.bus.list({ type: 'tool.*', limit: 10 }).map((row) => row.type)).toEqual(['tool.after', 'tool.before']);
    bunTest.expect(h.bus.list({ sessionId: 's2', limit: 10 }).map((row) => row.type)).toEqual(['step.after']);
    bunTest.expect(h.bus.list({ limit: 2 }).map((row) => row.type)).toEqual(['tool.before', 'step.after']);
    bunTest.expect(h.bus.list({ since: Date.now() + 60_000, limit: 10 })).toHaveLength(0);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});
