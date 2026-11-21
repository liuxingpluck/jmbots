/**
 * tutorial/Walk.ts 与 Snapshot.ts 离线单元测试：
 * 核对快照（slim: false，全量原样不打码不截断）与载荷（slim: true + limit，脱敏/图片占位/嵌套折叠/流式截断）
 * 共用一套 walk 遍历和 walkDiff 对比树，且路径段与点分下标字符串一一对应。
 * 跑法：bun test ./src7/plugins/tutorial/Snapshot.test.ts
 */
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import * as snapshotModule from './Snapshot.ts';
import * as walkModule from './Walk.ts';


class EmptyCustomBox {}

class PrivateService {
  private readonly secretKey = 'sk-RAW-SNAPSHOT-KEEP';

  get lazyField(): number {
    throw new Error('getter 不能被调用');
  }

  readSecret(): string {
    return this.secretKey;
  }
}


describe('Walk 与 Snapshot 共用遍历和对比', () => {
  test('WalkRule 开关区分快照全量原样（slim: false）与载荷精简脱敏（slim: true + limit）', () => {
    const rawPng = Buffer.alloc(4 * 1024, 3).toString('base64');
    const nestedSession = {
      id: 'ses-1',
      row: {
        id: 'ses-1',
        messages: [{ role: 'user', content: '第一句私密原话' }],
      },
    };
    const botLike = {
      name: '周小灵',
      home: { allBots: ['周小灵'] },
    };
    const sample = {
      apiKey: 'sk-PLAIN-SECRET',
      dataUrl: `data:image/png;base64,${rawPng}`,
      session: nestedSession,
      bot: botLike,
      service: new PrivateService(),
      emptyBox: new EmptyCustomBox(),
      emptyMap: new Map(),
    };

    //M 1. 快照模式（slim: false）：不隐藏凭据、不换图片占位、不折叠嵌套 Session/Bot，连 private 字段全量原样保留。
    const full = walkModule.walk(sample, { slim: false });
    expect(full.truncated).toBe(false);
    const fullVal = full.value as Record<string, unknown>;
    expect(fullVal['apiKey']).toBe('sk-PLAIN-SECRET');
    expect(fullVal['dataUrl']).toBe(`data:image/png;base64,${rawPng}`);
    expect((fullVal['session'] as { row: { messages: unknown[] } }).row.messages).toEqual([
      { role: 'user', content: '第一句私密原话' },
    ]);
    expect((fullVal['bot'] as { home: unknown }).home).toEqual({ allBots: ['周小灵'] });
    expect(fullVal['service']).toEqual({ secretKey: 'sk-RAW-SNAPSHOT-KEEP' });
    expect(fullVal['emptyBox']).toBe('[EmptyCustomBox]');
    expect(fullVal['emptyMap']).toEqual({});

    //M 2. 载荷模式（slim: true + limit）：凭据隐藏、图片换 [图片 ...]、嵌套 Session.row.messages 与 Bot.home 折叠。
    const slim = walkModule.walk(sample, { limit: 64 * 1024, slim: true });
    expect(slim.truncated).toBe(false);
    expect(slim.bytes).toBeGreaterThan(0);
    const slimVal = slim.value as Record<string, unknown>;
    expect(slimVal['apiKey']).toBe('[凭据 已隐藏]');
    expect(slimVal['dataUrl']).toBe('[图片 image/png 4KB]');
    expect((slimVal['session'] as { row: { messages: unknown } }).row.messages).toBe('[对话历史 1 条]');
    expect((slimVal['bot'] as { home: unknown }).home).toBe('[Bots]');
  });

  test('外部资源标签、[快照] 防重入、[循环] 与 [getter] 不触发副作用', () => {
    const ctx = new cordis.Context();
    const db = new Database(':memory:');
    try {
      const aborter = new AbortController();
      const fastifyLike = { inject() {}, listen() {}, register() {}, server: {} };
      const takenShot = [{ name: 'main', note: '', value: 1, notes: {} }];
      walkModule.markTaken(takenShot);

      let getterCalled = false;
      const cyclic: Record<string, unknown> = {
        ctx,
        db,
        emitter: new EventEmitter(),
        aborter,
        signal: aborter.signal,
        fastify: fastifyLike,
        bytes: new Uint8Array([1, 2, 3]),
        previousShot: takenShot,
      };
      Object.defineProperty(cyclic, 'boom', {
        enumerable: true,
        get() {
          getterCalled = true;
          return 42;
        },
      });
      cyclic['self'] = cyclic;

      const res = snapshotModule.walkState(cyclic) as Record<string, unknown>;
      expect(getterCalled).toBe(false);
      expect(res['ctx']).toBe('[Context]');
      expect(res['db']).toBe('[Database]');
      expect(res['emitter']).toBe('[EventEmitter]');
      expect(res['aborter']).toBe('[AbortController]');
      expect(res['signal']).toBe('[AbortSignal]');
      expect(res['fastify']).toBe('[Fastify]');
      expect(res['bytes']).toBe('[Uint8Array]');
      expect(res['previousShot']).toBe('[快照]');
      expect(res['boom']).toBe('[getter]');
      expect(res['self']).toBe('[循环]');
    } finally {
      db.close();
      void ctx.fiber.dispose();
    }
  });

  test('getDiff 与 computePayloadDiff 共用递归对比树，支持数组下标、特殊键名与未变组复用跳过', () => {
    const sharedUnchanged = { deep: { big: [1, 2, 3] } };
    const before = {
      sameGroup: sharedUnchanged,
      messages: [
        { role: 'user', content: '旧话' },
        { role: 'assistant', content: '旧答' },
      ],
      mapKeys: { 'http:local.1': 'old' },
      removedTop: true,
    };
    const after = {
      sameGroup: sharedUnchanged,
      messages: [
        { role: 'user', content: '新话' },
        { role: 'assistant', content: '旧答' },
        { role: 'user', content: '追问' },
      ],
      mapKeys: { 'http:local.1': 'new' },
      addedTop: 9,
    };

    //M 快照键路径保留原始键名与下标字符串，供前端 JsonBlock 按 PATH_SEP 精确标黄。
    expect(walkModule.getDiff(before, after)).toEqual([
      ['messages', '0', 'content'],
      ['messages', '2'],
      ['mapKeys', 'http:local.1'],
      ['removedTop'],
      ['addedTop'],
    ]);

    //M 载荷 diff 输出 messages[0].content / messages[2] 格式及顶层 same。
    const payloadDiff = walkModule.computePayloadDiff(before, after);
    expect(payloadDiff).toEqual([
      { path: 'messages[0].content', kind: 'change', before: '旧话', after: '新话' },
      { path: 'messages[2]', kind: 'add', after: '{"role":"user","content":"追问"}' },
      { path: 'mapKeys.http:local_1', kind: 'change', before: 'old', after: 'new' },
      { path: 'removedTop', kind: 'remove', before: 'true' },
      { path: 'addedTop', kind: 'add', after: '9' },
      { path: 'sameGroup', kind: 'same', before: '{"deep":{"big":[1,2,3]}}', after: '{"deep":{"big":[1,2,3]}}' },
    ]);
  });
});
