/**
 * 观察处理器的离线测试（docs/11_附_事件总线_第一步实现.md 第 6.2 节 12）：思考太慢、太多步；工具连着出错；搜索没搜到、太慢、反复搜。
 * 限时的计时在进度卡片里（tests/Progress.test.ts 测）。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as eventWatchModule from '../src/capabilities/EventWatch.ts';
import * as eventsModule from '../src/capabilities/Events.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as resourcesModule from '../src/resources/Resources.ts';


/** 临时目录的根：JMBOTS_TEST_TMP 优先，没设就用系统临时目录。 */
const TMP_ROOT = process.env.JMBOTS_TEST_TMP ?? os.tmpdir();

/** 一次测试的东西。 */
interface Harness {
  /** 事件总线。 */
  bus: eventsModule.EventBus;
  /** 观察处理器。 */
  watch: eventWatchModule.EventWatch;
  /** 临时运行时目录。 */
  dir: string;
}


/**
 * 建事件总线和观察处理器：想 1 秒算慢、3 步算多，工具连错 3 次，搜索 100 毫秒算慢、同一句 3 次算反复。
 * @returns 事件总线、观察处理器、目录。
 */
async function setup(): Promise<Harness> {
  /** 临时运行时目录。 */
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'jmbots-watch-'));
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    [
      'providers: {}',
      'default_model: magpie/test',
      'bots:',
      '  - name: 小测',
      '    language: zh',
      'events:',
      '  watch_think_slow_seconds: 1',
      '  watch_think_max_steps: 3',
      '  watch_tool_fail_run: 3',
      '  watch_rag_slow_ms: 100',
      '  watch_rag_repeat: 3',
    ].join('\n'),
  );
  /** 资源。 */
  const resources = await resourcesModule.Resources.load(dir);
  /** 事件总线。 */
  const bus = new eventsModule.EventBus(new storeModule.Store(':memory:'), resources, new secretsModule.Secrets([]));
  /** 观察处理器。 */
  const watch = new eventWatchModule.EventWatch(bus, resources);
  watch.start();
  return { bus, watch, dir };
}


/**
 * 收拾。
 * @param h 测试的东西。
 */
function cleanup(h: Harness): void {
  h.watch.stop();
  fs.rmSync(h.dir, { recursive: true, force: true });
}


/**
 * 报一个会话里的事件（来源写 AgentLoop，像会话循环报的一样）。
 * @param h 测试的东西。
 * @param type 类型。
 * @param data 数据。
 * @param sessionId 会话号。
 */
function emit(h: Harness, type: string, data: Record<string, unknown>, sessionId = 's1'): eventsModule.EventRecord | undefined {
  return h.bus.emit(type, data, { source: 'AgentLoop', bot: '小测', sessionId });
}


/**
 * 观察处理器报的事件，按先后。
 * @param h 测试的东西。
 * @param type 类型（全名或 xxx.*）。
 */
function watched(h: Harness, type: string): eventsModule.EventRecord[] {
  return h.bus.list({ type, limit: 100 }).filter((row) => row.source === 'EventWatch');
}


bunTest.test('思考：一步想超过 1 秒报 slow；走到第 4 步报 many，只报一次', async () => {
  /** 测试的东西。 */
  const h = await setup();
  try {
    emit(h, 'run.started', { run: 1 });
    emit(h, 'step.after', { step: 1, ms: 1500 });
    emit(h, 'step.after', { step: 2, ms: 10 });
    emit(h, 'step.after', { step: 4, ms: 10 });
    emit(h, 'step.after', { step: 5, ms: 10 });
    /** 报的。 */
    const thinking = watched(h, 'watch.thinking').map((row) => row.data.reason);
    bunTest.expect(thinking).toEqual(['slow', 'many']);
  } finally {
    cleanup(h);
  }
});


bunTest.test('工具：同一个工具连着错 3 次报一次；中间成功一次就从头数；别的工具各数各的', async () => {
  /** 测试的东西。 */
  const h = await setup();
  try {
    emit(h, 'run.started', { run: 1 });
    for (const isError of [true, true, false, true, true, true, true]) {
      emit(h, 'tool.after', { tool: 'exec', isError });
    }
    emit(h, 'tool.after', { tool: 'read', isError: true });
    /** 报的。 */
    const fails = watched(h, 'watch.toolfail');
    bunTest.expect(fails).toHaveLength(1);
    bunTest.expect(fails[0]!.data).toEqual({ tool: 'exec', count: 3 });
  } finally {
    cleanup(h);
  }
});


bunTest.test('搜索：没搜到报 empty、太慢报 slow、同一句（不管空白）第 3 次报 repeat；换个会话从头数', async () => {
  /** 测试的东西。 */
  const h = await setup();
  try {
    emit(h, 'run.started', { run: 1 });
    emit(h, 'search.done', { kind: 'rag', query: '飞书 发件箱', hits: 0, ms: 10 });
    emit(h, 'search.done', { kind: 'local', query: '飞书发件箱', hits: 2, ms: 500 });
    emit(h, 'search.done', { kind: 'rag', query: ' 飞书发件箱 ', hits: 1, ms: 10 });
    emit(h, 'run.started', { run: 1 }, 's2');
    emit(h, 'search.done', { kind: 'rag', query: '飞书发件箱', hits: 1, ms: 10 }, 's2');
    /** 报的理由，按先后。 */
    const reasons = watched(h, 'watch.search').map((row) => `${row.sessionId ?? ''}:${String(row.data.reason)}`);
    bunTest.expect(reasons).toEqual(['s1:empty', 's1:slow', 's1:repeat']);
  } finally {
    cleanup(h);
  }
});
