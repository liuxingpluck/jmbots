/**
 * 启动轨迹（journal/Trail.ts 的 getBootTrail，原 flow 的 Boot.test.ts）和泳道图（Lanes.ts）的离线测试。
 * 跑法：bun test ./src7/plugins/tutorial
 * 查的是：
 *   启动：每个道一步、关键变量原样给、注释挂在步上、出错标红、耗时到下一步开始；
 *   泳道图：启动摆成 加载 → 服务就绪 → 发事件 → 开始监听，消息摆成 存 → 分给机器人 → 会话第 N 步 → 回复；
 *     没有行的列不画；同一步跨阶段在两格各出现一次；箭头照行的先后、同一对只连一次。
 */
import { describe, expect, test } from 'bun:test';
import * as lanesModule from './Lanes.ts';
import * as sourceModule from './Source.ts';
import { LINES as MESSAGE_LINES } from '../journal/tests/Lines.ts';
import { getBootTrail, getTrail, type TrailLine } from '../journal/Trail.ts';


/** 一段注释。 */
function doc(name: string, site: string): sourceModule.CodeDoc {
  return { name, site, important: true, missing: '', signature: `${name}(): void`, summary: `${name} 干什么`, params: [], returns: '', throws: '', effects: '' };
}


let id = 0;
/** Boot.ts 交来的一行的样子。 */
function line(at: number, name: string, node: string, facts: Record<string, string | number | boolean>, docs: sourceModule.CodeDoc[] = []): TrailLine {
  id += 1;
  return {
    id, at, kind: '函数', name, listeners: [], text: `${name} 的人话`, site: `src7/Main.ts:${String(id)}`,
    sessionId: null, messageId: null, vars: facts, node, facts, docs,
  };
}


/** 一次启动的行。 */
const BOOT_LINES: TrailLine[] = [
  line(1000, 'main', 'main', { root: 'jmbotsData/', backfilled: true }, [doc('main', 'src7/Main.ts:36')]),
  line(1000, 'Resources', 'resources', { defaultModel: 'fake/echo' }),
  line(1000, 'tutorial', 'tutorial', { state: '挂好了', newServices: 'flow' }),
  line(1020, 'alpha', 'alpha', { state: '没挂上', failed: true }),
  line(1050, 'ready', 'main', { plugins: 2 }, [doc('ready 事件', 'src7/Main.ts:26')]),
  line(1050, '接着跑会话', 'main', { running: 0 }, [doc('Session.run', 'src7/Sessions.ts:226')]),
  line(1100, 'Http.listen', 'http', { port: 30086 }),
];


/**
 * 一张泳道图里某道某列的格子。
 * @param lanes 泳道图。
 * @param lane 道名。
 * @param column 列名。
 */
function getCell(lanes: lanesModule.Lanes, lane: string, column: string): lanesModule.LaneCell | undefined {
  const laneIndex = lanes.lanes.indexOf(lane);
  const columnIndex = lanes.columns.indexOf(column);
  return lanes.cells.find((cell) => cell.lane === laneIndex && cell.column === columnIndex);
}


/**
 * 箭头写成“道/列 → 道/列”，好比对。
 * @param lanes 泳道图。
 */
function getEdgeWords(lanes: lanesModule.Lanes): string[] {
  const word = (index: number): string => {
    const cell = lanes.cells[index];
    if (cell === undefined) return '?';

    return `${lanes.lanes[cell.lane] ?? '?'}/${lanes.columns[cell.column] ?? '?'}`;
  };
  return lanes.edges.map((edge) => `${word(edge.from)} → ${word(edge.to)}`);
}


describe('启动轨迹', () => {
  test('getBootTrail：一个道一步，连着的 main 收成一步；关键变量原样；注释挂在步上', () => {
    const trail = getBootTrail(BOOT_LINES);
    expect(trail).toMatchObject({ message: 0, session: null, channel: '启动', state: 'done', at: 1000, ms: 100, error: true });
    expect(trail.steps.map((step) => step.node)).toEqual(['main', 'resources', 'tutorial', 'alpha', 'main', 'http']);

    //M 关键变量不按 FACT_KEYS 筛：root、newServices 这些照样在。
    expect(trail.steps[0]?.rows[0]?.facts).toEqual({ root: 'jmbotsData/', backfilled: true });
    expect(trail.steps[2]?.rows[0]?.facts['newServices']).toBe('flow');

    //M 出错看 vars（启动轨迹的 vars 就是 facts）里的 failed。
    expect(trail.steps[3]?.error).toBe(true);
    expect(trail.steps[2]?.error).toBe(false);

    //M ready 和接着跑会话都在 main 上，收成一步，两段注释都在。
    expect(trail.steps[4]?.rows.map((row) => row.name)).toEqual(['ready', '接着跑会话']);
    expect(trail.steps[4]?.docs.map((item) => item.name)).toEqual(['ready 事件', 'Session.run']);
    expect(trail.steps[4]?.title).toBe('ready 的人话');

    //M 耗时到下一步开始：alpha 1020 → ready 1050。
    expect(trail.steps[3]?.ms).toBe(30);
  });

  test('说明表带上录启动给的和 name；还没 ready 是 running', () => {
    const notes = getBootTrail(BOOT_LINES, { root: '运行时目录' }).notes;
    expect(notes).toMatchObject({ root: '运行时目录', name: '这一行是哪个函数或事件' });
    expect(getBootTrail(BOOT_LINES.slice(0, 3)).state).toBe('running');
  });
});


describe('泳道图', () => {
  test('启动：四列；多出服务的（和骨架的 resources）在「服务就绪」再有一格，从加载格连过去', () => {
    const lanes = lanesModule.getLanes(getBootTrail(BOOT_LINES));
    expect(lanes.columns).toEqual(['加载（apply）', '服务就绪（inject）', '发事件', '开始监听']);
    expect(lanes.lanes).toEqual(['main', 'resources', 'tutorial', 'alpha', 'http']);

    //M 服务就绪：tutorial 提供 flow，resources 本身就是服务；alpha 没多出服务，没有这一格。
    expect(getCell(lanes, 'tutorial', '服务就绪（inject）')?.items).toEqual([{ step: 3, text: '提供 flow' }]);
    expect(getCell(lanes, 'resources', '服务就绪（inject）')?.items[0]?.text).toBe('提供 resources');
    expect(getCell(lanes, 'alpha', '服务就绪（inject）')).toBeUndefined();

    //M ready、接着跑会话是同一步，落在 main 的「发事件」一格；alpha 出错标红。
    expect(getCell(lanes, 'main', '发事件')?.items).toEqual([{ step: 5, text: 'ready 的人话' }]);
    expect(getCell(lanes, 'alpha', '加载（apply）')?.error).toBe(true);

    //M 箭头：加载一道道往下，服务格从加载格连过去，最后到发事件、开始监听。
    expect(getEdgeWords(lanes)).toEqual([
      'main/加载（apply） → resources/加载（apply）',
      'resources/加载（apply） → resources/服务就绪（inject）',
      'resources/加载（apply） → tutorial/加载（apply）',
      'tutorial/加载（apply） → tutorial/服务就绪（inject）',
      'tutorial/加载（apply） → alpha/加载（apply）',
      'alpha/加载（apply） → main/发事件',
      'main/发事件 → http/开始监听',
    ]);
  });

  test('消息：存 → 分给机器人 → 会话第 1、2 步 → 回复；一步跨阶段在两格各一次；没有行的「收到」不画', () => {
    const lanes = lanesModule.getLanes(getTrail(7, MESSAGE_LINES));
    expect(lanes.columns).toEqual(['存', '分给机器人', '会话第 1 步', '会话第 2 步', '回复']);
    expect(lanes.lanes).toEqual(['web-api', 'bots', 'sessions', 'tools']);

    //M web-api 那一步（第 1 步）先存、再推给机器人，在两格各出现一次。
    expect(getCell(lanes, 'web-api', '存')?.items.map((item) => item.step)).toEqual([1]);
    expect(getCell(lanes, 'web-api', '分给机器人')?.items.map((item) => item.step)).toEqual([1]);

    //M 会话第 1 步里 sessions 有两项：调模型那步、工具结果回来那步；工具结果那行出错，这格标红。
    expect(getCell(lanes, 'sessions', '会话第 1 步')?.items.map((item) => item.step)).toEqual([3, 5]);
    expect(getCell(lanes, 'sessions', '会话第 1 步')?.error).toBe(true);
    expect(getCell(lanes, 'tools', '会话第 1 步')?.items).toEqual([{ step: 4, text: '执行工具' }]);

    //M 会话这一轮结束、回话写回都在「回复」。
    expect(getCell(lanes, 'sessions', '回复')?.items.map((item) => item.step)).toEqual([5]);
    expect(getCell(lanes, 'web-api', '回复')?.items.map((item) => item.step)).toEqual([6]);

    //M 箭头照行的先后：工具回到会话那条往回连；同一对只一条。
    expect(getEdgeWords(lanes)).toEqual([
      'web-api/存 → web-api/分给机器人',
      'web-api/分给机器人 → bots/分给机器人',
      'bots/分给机器人 → sessions/分给机器人',
      'sessions/分给机器人 → sessions/会话第 1 步',
      'sessions/会话第 1 步 → tools/会话第 1 步',
      'tools/会话第 1 步 → sessions/会话第 1 步',
      'sessions/会话第 1 步 → sessions/会话第 2 步',
      'sessions/会话第 2 步 → sessions/回复',
      'sessions/回复 → web-api/回复',
    ]);
  });
});
