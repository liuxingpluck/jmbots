/**
 * GET /api/flow/boot 的格式（2026-11-16，132 写）：boot-trail 交来的行，收成和请求轨迹（/api/flow/trail）同一个格式。
 * 跑法：bun test ./src7/plugins/flow/Boot.test.ts。不起整个服务：假的 ctx，接口用真的 fastify inject 调。
 * 查的是：每行一步、点用行上的 node、关键变量原样给（不按 FACT_KEYS 筛）、注释挂在步上、出错标红、耗时到下一步开始；
 * 没挂 boot-trail 时 503 并说清写在哪。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type * as cordis from 'cordis';
import fastify from 'fastify';
import * as os from 'node:os';
import * as path from 'node:path';
import * as flowModule from './index.ts';
import { bootTrailOf, type CodeDoc, type Trail, type TrailLine } from './Trail.ts';


/** 一段注释。 */
function doc(name: string, site: string): CodeDoc {
  return { name, site, important: true, missing: '', signature: `${name}(): void`, summary: `${name} 干什么`, params: [], returns: '', throws: '', effects: '' };
}


let id = 0;
/** boot-trail 交来的一行的样子。 */
function line(at: number, name: string, node: string, facts: Record<string, string | number | boolean>, docs: CodeDoc[] = []): TrailLine {
  id += 1;
  return {
    id, at, kind: '函数', name, listeners: [], text: `${name} 的人话`, site: `src7/Main.ts:${String(id)}`,
    sessionId: null, messageId: null, vars: facts, node, facts, docs,
  };
}


const LINES: TrailLine[] = [
  line(1000, 'main', 'main', { root: 'jmbotsData/', backfilled: true }, [doc('main', 'src7/Main.ts:36')]),
  line(1000, 'Resources', 'resources', { defaultModel: 'fake/echo' }),
  line(1000, 'boot-trail', 'boot-trail', { state: '挂好了', newServices: 'bootTrail' }),
  line(1020, 'alpha', 'alpha', { state: '没挂上', failed: true }),
  line(1050, 'ready', 'main', { plugins: 2 }, [doc('ready 事件', 'src7/Main.ts:26')]),
  line(1050, '接着跑会话', 'main', { running: 0 }, [doc('Session.run', 'src7/Sessions.ts:226')]),
  line(1100, 'Http.listen', 'http', { port: 30086 }),
];


/** 测完要关的 fastify。 */
const apps: ReturnType<typeof fastify>[] = [];
afterAll(async () => {
  for (const app of apps) await app.close();
});


/**
 * 挂上 flow，只给接口用到的几样。
 * @param boot boot-trail 服务；不给就当没挂。
 */
async function serve(boot: { lines(): Promise<TrailLine[]>; notes?: Record<string, string> } | undefined): Promise<ReturnType<typeof fastify>> {
  const app = fastify();
  apps.push(app);
  const fake = {
    http: { app },
    //M root：FlowFiles 按它算 data/flow/；这里 on 不挂监听，不会真写文件。
    resources: { root: path.join(os.tmpdir(), 'flow-boot-test'), pluginStatus: [], config: { plugins: [] } },
    get: (name: string) => (name === 'bootTrail' ? boot : undefined),
    provide: () => () => undefined,
    on: () => () => undefined,
  };
  flowModule.apply(fake as unknown as cordis.Context);
  await app.ready();
  return app;
}


describe('启动轨迹', () => {
  test('bootTrailOf：一个点一步，连着的 main 收成一步；关键变量原样；注释挂在步上', () => {
    const trail = bootTrailOf(LINES);
    expect(trail).toMatchObject({ message: 0, session: null, channel: '启动', state: 'done', at: 1000, ms: 100, error: true });
    expect(trail.steps.map((step) => step.node)).toEqual(['main', 'resources', 'boot-trail', 'alpha', 'main', 'http']);

    //M 关键变量不按 FACT_KEYS 筛：root、newServices 这些照样在。
    expect(trail.steps[0]?.rows[0]?.facts).toEqual({ root: 'jmbotsData/', backfilled: true });
    expect(trail.steps[2]?.rows[0]?.facts['newServices']).toBe('bootTrail');

    //M 出错看 vars（启动轨迹的 vars 就是 facts）里的 failed。
    expect(trail.steps[3]?.error).toBe(true);
    expect(trail.steps[2]?.error).toBe(false);

    //M ready 和接着跑会话都在 main 上，收成一步，两段注释都在。
    expect(trail.steps[4]?.rows.map((row) => row.name)).toEqual(['ready', '接着跑会话']);
    expect(trail.steps[4]?.docs.map((item) => item.name)).toEqual(['ready 事件', 'Session.run']);
    expect(trail.steps[4]?.title).toBe('ready 的人话');

    //M 耗时到下一步开始：alpha 1020 → ready 1050。
    expect(trail.steps[3]?.ms).toBe(30);
    expect(trail.steps[0]?.docs[0]?.site).toBe('src7/Main.ts:36');
  });

  test('说明表：boot-trail 给的和一步里每行的 name 都带上', () => {
    const notes = bootTrailOf(LINES, { root: '运行时目录' }).notes;
    expect(notes).toMatchObject({ root: '运行时目录', name: '这一行是哪个函数或事件' });
  });

  test('还没 ready：state 是 running', () => {
    expect(bootTrailOf(LINES.slice(0, 3)).state).toBe('running');
  });

  test('GET /api/flow/boot：挂了 boot-trail 交回轨迹；没挂 503', async () => {
    const withBoot = await serve({ lines: () => Promise.resolve(LINES), notes: { port: 'HTTP 端口' } });
    const ok = await withBoot.inject({ method: 'GET', url: '/api/flow/boot' });
    expect(ok.statusCode).toBe(200);
    const trail = ok.json() as Trail;
    expect(trail.message).toBe(0);
    expect(trail.notes['port']).toBe('HTTP 端口');
    expect(trail.steps).toHaveLength(6);
    expect(trail.steps[0]?.docs[0]?.name).toBe('main');

    const without = await serve(undefined);
    const missing = await without.inject({ method: 'GET', url: '/api/flow/boot' });
    expect(missing.statusCode).toBe(503);
    expect((missing.json() as { error: string }).error).toContain('第一个');
  }, 180_000);
});
