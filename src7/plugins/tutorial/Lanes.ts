/**
 * 泳道图：把一条轨迹（journal/Trail.ts 收好的一步一步）摆进格子，教程页右栏照这里画。
 *   一道一行：第一列是道名（插件名，或骨架的 main、resources、tools、sessions），照第一次出现的先后往下排；
 *   一个阶段一列：同一阶段的放在同一列，图往下长，不往右拉长。
 *     启动：加载（apply）→ 服务就绪（inject）→ 发事件 → 开始监听；
 *     消息：收到 → 存 → 分给机器人 → 会话第 1 步、第 2 步……（每调一次模型一列）→ 回复。
 *   阶段按录下来的行认（行名见下面几张表），没有行落进去的列不画（web-api 收的消息从“存”起，没有“收到”那列）。
 *   一步的几行跨了阶段（比如 web-api 那一步先收到、再存），这一步在两格里各出现一次，点哪格都是看这一步。
 *   箭头：照行的先后，从上一行所在的格连到下一行所在的格（同一对只连一次）；启动的「服务就绪」格从它那道的加载格连过来。
 */
import type * as trailModule from '../journal/Trail.ts';
import type { TraceParams } from '../../../web/src/locales/Trace.ts';


/** 格子里的一项：哪一步、这一格里它在干什么。 */
export interface LaneItem {
  /** 第几步，从 1 起（Trail.steps 的 no）。 */
  step: number;
  /** 一句话：这一步落在这格的第一行的人话；服务就绪格是多出的服务。 */
  text: string;
  /** 文案插值。 */
  params?: TraceParams;
}


/** 一个格子。 */
export interface LaneCell {
  /** 第几道，从 0 起（lanes 的下标）。 */
  lane: number;
  /** 第几列，从 0 起（columns 的下标）。 */
  column: number;
  /** 落在这格的步，照先后。 */
  items: LaneItem[];
  /** 这格里有没有出错的行。 */
  error: boolean;
}


/** 一个箭头：从哪格到哪格（cells 的下标）。 */
export interface LaneEdge {
  /** 起点格。 */
  from: number;
  /** 终点格。 */
  to: number;
}


/** 一张泳道图。 */
export interface Lanes {
  /** 列名，照先后。 */
  columns: string[];
  /** 道名，照第一次出现的先后。 */
  lanes: string[];
  /** 有东西的格子。 */
  cells: LaneCell[];
  /** 箭头。 */
  edges: LaneEdge[];
}


/** 启动的四列，名字就是列名，先后就是这个先后。 */
const BOOT_COLUMNS = ['加载（apply）', '服务就绪（inject）', '发事件', '开始监听'];

/** 启动里算「发事件」的行：Main.ts 发 ready，接着推没跑完的会话。 */
const BOOT_EMIT = new Set(['ready', '接着跑会话']);

/** 启动里算「开始监听」的行。 */
const BOOT_LISTEN = new Set(['Http.listen']);

/** 骨架自己就是服务的三道：它们的加载那步也是服务就绪。 */
const SKELETON_SERVICES = new Set(['resources', 'tools', 'sessions']);

/** 消息里算「存」的行：web-api 的收件表记下。渠道来的消息，它前面还有渠道那几行（飞书收到、去重、认 @），journal 按标准消息号一并交来，落在「收到」列。 */
const MESSAGE_STORE = new Set(['web-api/received', 'Timeline.insert']);

/** 消息里算「分给机器人」的行：WebApi.accept 是“收下，推给机器人”，排在 web-api/received 后面；channel/message 与独立认领也落这列。 */
const MESSAGE_DISPATCH = new Set([
  'WebApi.accept',
  'bot/receive',
  'Bots.receive',
  'Bot.receive',
  'channel/message',
  'Bots.onChannelMessage',
  'Dispatch.claimChannelMessage',
]);

/** 消息里算「回复」的行；会话这一轮结束（session/change 变成下面几种状态）也算。 */
const MESSAGE_REPLY = new Set(['web-api/replied', 'Timeline.reply']);

/** 会话这一轮结束的状态。 */
const ENDED = new Set(['done', 'failed', 'stopped']);

/** 消息前三列的名字和先后。 */
const MESSAGE_HEAD = ['收到', '存', '分给机器人'];

/** 「回复」排在所有会话步后面：先后号给个够大的数。 */
const REPLY_RANK = 100000;


/** 摆格子：记下道、列、格子、箭头，最后按列的先后排好交出去。 */
class LaneMaker {
  /** 道名，照第一次出现的先后。 */
  private readonly lanes: string[] = [];

  /** 列名 → 先后号（小的在左）。 */
  private readonly ranks = new Map<string, number>();

  /** 格子，键是“道\0列名”。 */
  private readonly cells = new Map<string, { lane: string; column: string; items: LaneItem[]; error: boolean }>();

  /** 箭头，“起点键\n终点键”，同一对只记一次。 */
  private readonly edges = new Set<string>();

  /** 上一行落在的格子：下一行落到别的格就连一个箭头。 */
  private last = '';

  /**
   * 一行落进一格：没有这格就建；这一步在这格还没有项就加一项；和上一行不在同一格就连箭头。
   * @param lane 道名。
   * @param column 列名。
   * @param rank 列的先后号。
   * @param step 第几步。
   * @param text 这一行的人话。
   * @param error 这一行出没出错。
   */
  addRow(lane: string, column: string, rank: number, step: number, text: string, error: boolean, params?: TraceParams): void {
    //M 先把这一行落进对应格子并取得格子键，再决定要不要和上一格连箭头。
    const key = this.addItem(lane, column, rank, step, text, error, params);

    //M 和上一行不在同一格：连一个箭头。
    if (this.last !== '' && this.last !== key) {
      this.edges.add(`${this.last}\n${key}`);
    }
    this.last = key;
  }

  /**
   * 加一格里的一项，不连箭头（启动的「服务就绪」格用）；返回这格的键。
   * @param lane 道名。
   * @param column 列名。
   * @param rank 列的先后号。
   * @param step 第几步。
   * @param text 这一项的人话。
   * @param error 出没出错。
   */
  addItem(lane: string, column: string, rank: number, step: number, text: string, error: boolean, params?: TraceParams): string {
    if (!this.lanes.includes(lane)) {
      this.lanes.push(lane);
    }
    this.ranks.set(column, rank);

    //M 找这格，没有就建。
    const key = `${lane}\0${column}`;
    let cell = this.cells.get(key);
    if (cell === undefined) {
      cell = { lane, column, items: [], error: false };
      this.cells.set(key, cell);
    }

    //M 这一步在这格还没有项：加一项，人话用这一步落进来的第一行的；已经有了、那项没人话就补上。
    const item = cell.items.find((one) => one.step === step);
    if (item === undefined) {
      cell.items.push({ step, text, params });
    }
    if (item !== undefined && item.text === '') {
      item.text = text;
      item.params = params;
    }
    cell.error ||= error;
    return key;
  }

  /**
   * 连一个箭头（启动的加载格 → 服务就绪格）。
   * @param from 起点格的键。
   * @param to 终点格的键。
   */
  addEdge(from: string, to: string): void {
    //M 记录一条从加载格指向服务就绪格的单向边，Set 自动去重。
    this.edges.add(`${from}\n${to}`);
  }

  /** 交出去：列按先后号排，格子和箭头换成下标。 */
  getLanes(): Lanes {
    //M 列：按先后号从小到大。
    const ranked = [...this.ranks.entries()];
    ranked.sort((a, b) => a[1] - b[1]);
    const columns = ranked.map((entry) => entry[0]);

    //M 格子：道名、列名换成下标；记下键 → 下标，给箭头用。
    const cells: LaneCell[] = [];
    const indexOfKey = new Map<string, number>();
    for (const [key, cell] of this.cells) {
      indexOfKey.set(key, cells.length);
      cells.push({
        lane: this.lanes.indexOf(cell.lane),
        column: columns.indexOf(cell.column),
        items: cell.items,
        error: cell.error,
      });
    }

    //M 箭头：两头的键换成格子下标。
    const edges: LaneEdge[] = [];
    for (const pair of this.edges) {
      const [fromKey = '', toKey = ''] = pair.split('\n');
      const from = indexOfKey.get(fromKey);
      const to = indexOfKey.get(toKey);
      if (from === undefined || to === undefined) continue;

      edges.push({ from, to });
    }
    return { columns, lanes: this.lanes, cells, edges };
  }
}


/**
 * 一条轨迹的泳道图。消息号是 0 的是启动。
 * @param trail journal/Trail.ts 收好的轨迹（现算的，或从快照文件读回来的）。
 */
export function getLanes(trail: trailModule.Trail): Lanes {
  //M 初始化泳道排布器，按消息号是否为空区分启动轨迹与消息轨迹。
  const maker = new LaneMaker();
  if (trail.message === 0) {
    //M 启动轨迹按加载、服务就绪、发事件、开始监听四列排格并连线。
    addBoot(maker, trail);
    //M 收敛所有格子和箭头为索引结构返回给前端渲染。
    return maker.getLanes();
  }

  //M 消息轨迹按收到、存、分给机器人、会话第 N 步与回复动态展开列。
  addMessage(maker, trail);
  //M 收敛所有格子和箭头为索引结构返回给前端渲染。
  return maker.getLanes();
}


/**
 * 启动的每一行摆进四列；插件多出了服务（骨架的三道本身就是服务），在「服务就绪」再放一格，从它的加载格连过去。
 * @param maker 摆格子的。
 * @param trail 启动轨迹。
 */
function addBoot(maker: LaneMaker, trail: trailModule.Trail): void {
  for (const step of trail.steps) {
    for (const row of step.rows) {
      //M 这一行在哪一列：ready、接着跑会话是发事件；Http.listen 是开始监听；别的都是加载。
      let column = BOOT_COLUMNS[0] ?? '';
      if (BOOT_EMIT.has(row.name)) {
        column = BOOT_COLUMNS[2] ?? '';
      }
      if (BOOT_LISTEN.has(row.name)) {
        column = BOOT_COLUMNS[3] ?? '';
      }
      //M 确定列名下标后把当前启动行摆入对应道与列。
      const rank = BOOT_COLUMNS.indexOf(column);
      maker.addRow(step.node, column, rank, step.no, row.text, row.error, row.params);

      //G 不在加载列的行，没有「服务就绪」可说。
      if (rank !== 0) continue;

      //M 这一步多出的服务：插件那步记在 newServices；骨架三道本身就是服务。
      let services = '';
      const added = row.facts['newServices'];
      if (typeof added === 'string') {
        services = added;
      }
      if (SKELETON_SERVICES.has(step.node)) {
        services = step.node;
      }
      if (services === '') continue;

      //M 放进「服务就绪」，从这道的加载格连过去。
      const serviceColumn = BOOT_COLUMNS[1] ?? '';
      const loadKey = `${step.node}\0${column}`;
      const params = { services };
      const serviceKey = maker.addItem(step.node, serviceColumn, 1, step.no, 'trace.lane.serviceReady', false, params);
      maker.addEdge(loadKey, serviceKey);
    }
  }
}


/**
 * 消息的每一行摆进列：收到 → 存 → 分给机器人 → 会话第 N 步 → 回复。
 * 阶段只往后走：认到「存」「分给机器人」的行才往后挪；每个 session/before-model 开一个新的会话步；认到回复的行进「回复」。
 * @param maker 摆格子的。
 * @param trail 一条消息的轨迹。
 */
function addMessage(maker: LaneMaker, trail: trailModule.Trail): void {
  /** 现在在哪一列的先后号：0 收到、1 存、2 分给机器人、2+N 会话第 N 步、REPLY_RANK 回复。 */
  let rank = 0;
  /** 会话走到第几步（第几次 session/before-model）。 */
  let round = 0;

  for (const step of trail.steps) {
    for (const row of step.rows) {
      //M 认这一行把阶段往后挪到哪：存、分给机器人只在会话开始前认，只往后挪。认出它们之前的行（渠道收到，如 Feishu.onMessage）都在「收到」。
      if (MESSAGE_STORE.has(row.name) && rank < 1) {
        rank = 1;
      }
      if (MESSAGE_DISPATCH.has(row.name) && rank < 2) {
        rank = 2;
      }

      //M 要调模型了：开新的一步。
      if (row.name === 'session/before-model') {
        round += 1;
        rank = 2 + round;
      }

      //M 回话写回、会话这一轮结束：进「回复」。
      const state = row.facts['state'];
      const ended = row.name === 'session/change' && typeof state === 'string' && ENDED.has(state);
      if (MESSAGE_REPLY.has(row.name) || ended) {
        rank = REPLY_RANK;
      }

      //M 根据推进后的阶段编号算列名并把当前消息行落入对应格子。
      const column = getMessageColumn(rank);
      maker.addRow(step.node, column, rank, step.no, row.text, row.error, row.params);
    }
  }
}


/**
 * 消息的列名。
 * @param rank 先后号。
 */
function getMessageColumn(rank: number): string {
  if (rank === REPLY_RANK) return '回复';

  const head = MESSAGE_HEAD[rank];
  if (head !== undefined) return head;

  return `会话第 ${String(rank - 2)} 步`;
}
