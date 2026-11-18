/**
 * 右栏的轻量查看历史：只存目标和阅读位置，绝不缓存文件、图片或事件响应。
 * UiStore 统一调用本类；浏览器的全局返回与文件多标签各自保持原有语义。
 */
import type * as storeModule from '../Store.ts';


/** 每条查看历史可恢复的阅读状态；值均属于该条目标。 */
export interface PanelReadingState {
  /** 独立阅读容器的垂直位置，像素。 */
  scrollTop: number;
  /** 展开的稳定项 key；组件可用 closed: 前缀记录默认展开项的主动收起。 */
  expanded: string[];
  /** 是否显示原始文字。 */
  raw: boolean;
  /** 当前文件分段的字节起点；不是行数。 */
  pageOffset: number;
  /** 当前目录选中的稳定章节 key；尚未选择是空字符串。 */
  section: string;
  /** 图片是否按原始大小显示。 */
  imageActualSize: boolean;
}


/** 一个查看目标；保留独立文件目标和所选回复，不缓存响应。 */
export interface PanelDestination {
  /** 本次查看时的机器人；还没选择机器人时为 null。 */
  bot: string | null;
  /** 右栏模块。 */
  tab: storeModule.PanelTab;
  /** 文件预览目标；模块之间切换仍保留之前的文件。 */
  target: storeModule.PanelTarget | null;
  /** 事件追踪目标；文件之间切换仍保留选中回复。 */
  traceTarget: storeModule.TraceTarget | null;
}


/** 一条历史，id 用于保证异步卸载只保存自己的阅读位置。 */
export interface PanelHistoryEntry extends PanelDestination {
  /** 当前仓库内唯一的条目号，不用于后端执行。 */
  id: string;
  /** 此目标自己的轻量阅读状态。 */
  reading: PanelReadingState;
}


/** 历史的只读视图，交给 UiStore 触发界面更新。 */
export interface PanelHistorySnapshot {
  /** 按查看顺序排列的条目，最多 40 个。 */
  entries: PanelHistoryEntry[];
  /** 正在阅读的条目下标；空历史是 -1。 */
  index: number;
}


/**
 * 生成初次查看目标时的默认轻量阅读状态；每次返回独立数组，不跨目标共享展开状态。
 * @returns 包含默认滚动位置、空展开列表及开关初始值的状态对象。
 * 副作用：无。
 */
export function getEmptyReading(): PanelReadingState {
  return {
    scrollTop: 0,
    expanded: [],
    raw: false,
    pageOffset: 0,
    section: '',
    imageActualSize: false,
  };
}


/**
 * 归一化文件路径用于比较：Windows 与 UNC 路径按系统语义统一斜杠与小写，POSIX 路径保留大小写。
 * @param path 待比较的文件路径；没有文件目标时为 undefined。
 * @returns 归一化后的比较键；输入为 undefined 时返回 undefined。
 * 副作用：无。
 */
export function getFileIdentity(path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined;
  }
  const normalized = path.replaceAll('\\', '/');
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) {
    return normalized.toLowerCase();
  }
  return normalized;
}


/** 查看栈最多保留多少条；旧正文始终由现有接口重新读取。 */
const HISTORY_LIMIT = 40;


/** 管理本次网页打开期间的查看历史；不持久化到磁盘或后端。 */
export class PanelHistory {
  /** 当前机器人范围内的查看条目。 */
  private entries: PanelHistoryEntry[] = [];
  /** 当前条目；回退后新看目标时丢弃其后的分支。 */
  private index = -1;
  /** 单调增加的条目号，已丢弃条目的异步保存不能命中新条目。 */
  private sequence = 0;

  /**
   * 新查看一个目标；相同目标不叠加，回退后新目标截断前进分支。
   * @param destination 本次要记录的右栏查看目标（机器人、标签及文件或追踪标识）。
   * @returns 更新后的只读历史快照。
   * 副作用：新增条目时递增内部 `sequence`、更新 `entries`（最多保留 40 条）与当前下标 `index`。
   */
  visit(destination: PanelDestination): PanelHistorySnapshot {
    const current = this.entries[this.index];
    //G 目标与当前历史条目相同时不重复叠加记录，直接返回当前快照。
    if (current && this.sameTarget(current, destination)) {
      return this.snapshot();
    }

    this.sequence += 1;
    let target: PanelDestination['target'] = null;
    if (destination.target) {
      target = { ...destination.target };
    }
    let traceTarget: PanelDestination['traceTarget'] = null;
    if (destination.traceTarget) {
      traceTarget = { ...destination.traceTarget };
    }
    //M 构造带唯一递增编号与初始轻量阅读状态的新历史条目。
    const entry: PanelHistoryEntry = {
      ...destination,
      target,
      traceTarget,
      id: `reading-${String(this.sequence)}`,
      reading: getEmptyReading(),
    };
    //M 回退后新开目标时截断前进分支，限制历史栈上限并返回最新快照。
    this.entries = [...this.entries.slice(0, this.index + 1), entry].slice(-HISTORY_LIMIT);
    this.index = this.entries.length - 1;
    return this.snapshot();
  }

  /**
   * 在已有查看历史内移动；到头保持当前状态，不创建新条目。
   * @param delta 移动步长，`-1` 表示后退，`1` 表示前进。
   * @returns 移动后的只读历史快照。
   * 副作用：目标位置未越界时更新当前下标 `index`。
   */
  move(delta: -1 | 1): PanelHistorySnapshot {
    const next = this.index + delta;
    if (next >= 0 && next < this.entries.length) {
      this.index = next;
    }
    //M 返回移动下标（或越界保持原位）后的最新历史快照。
    return this.snapshot();
  }

  /**
   * 保存指定条目的轻量状态；即使条目已不是当前的，也不能把位置写到新目标。
   * @param id 在组件渲染时绑定的历史条目号。
   * @param patch 要更新的少数字段；没有正文或附件字段。
   * @returns 最新快照；已被淘汰或切换机器人清掉的条目直接忽略。
   * 副作用：命中 `id` 时更新对应条目的 `reading` 状态。
   */
  save(id: string, patch: Partial<PanelReadingState>): PanelHistorySnapshot {
    this.entries = this.entries.map((entry) => {
      if (entry.id !== id) {
        return entry;
      }
      const reading = {
        ...entry.reading,
        ...patch,
        expanded: patch.expanded?.slice() ?? entry.reading.expanded,
      };
      return { ...entry, reading };
    });
    //M 返回保存指定条目阅读状态后的最新历史快照。
    return this.snapshot();
  }

  /**
   * 换机器人时清掉跨机器人条目；不改变独立文件多标签。
   * @param bot 当前选中的机器人名称；没有选中时为 `null`。
   * @returns 过滤并重新定位下标后的只读历史快照。
   * 副作用：过滤 `entries` 仅保留归属 `bot` 的记录，并调整当前下标 `index`。
   */
  isolate(bot: string | null): PanelHistorySnapshot {
    const currentId = this.entries[this.index]?.id;
    this.entries = this.entries.filter((entry) => entry.bot === bot);
    this.index = this.entries.findIndex((entry) => entry.id === currentId);
    if (this.index < 0 && this.entries.length > 0) {
      this.index = this.entries.length - 1;
    }
    //M 返回按机器人隔离并修正下标后的最新历史快照。
    return this.snapshot();
  }

  /**
   * 返回新的外层数组，阅读状态只通过 save 更新。
   * @returns 包含当前历史条目浅拷贝数组与当前下标的只读快照。
   * 副作用：无。
   */
  snapshot(): PanelHistorySnapshot {
    return { entries: this.entries.slice(), index: this.index };
  }

  /** 模块只按模块身份去重；文件和回复还必须是同一个明确目标。 */
  private sameTarget(left: PanelDestination, right: PanelDestination): boolean {
    if (left.bot !== right.bot || left.tab !== right.tab) {
      return false;
    }
    if (left.tab === 'preview') {
      //M 预览模块按所在系统路径语义比较两个目标是否指向同一文件。
      return getFileIdentity(left.target?.path) === getFileIdentity(right.target?.path);
    }
    if (left.tab === 'events') {
      return left.traceTarget?.bot === right.traceTarget?.bot
        && left.traceTarget?.messageId === right.traceTarget?.messageId
        && left.traceTarget?.replyIndex === right.traceTarget?.replyIndex;
    }
    return true;
  }
}
