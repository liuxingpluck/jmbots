/**
 * 三栏宽度的计算（docs/界面/01_界面设计.md 第 5 节）：纯函数，拖分隔线、键盘调、窗口变大变小、存取都走这里，好测。
 * 左栏和右栏记宽度，中栏占剩下的；右栏收起时中栏占满。窗口窄于 NARROW_WIDTH 时一次只显示一栏。
 */


/** 左右两栏的宽度，像素；中栏占剩下的。 */
export interface ColumnWidths {
  /** 左栏。 */
  left: number;
  /** 右栏（展开时）。 */
  right: number;
}


/** 每栏最窄多少像素。 */
export const MIN_WIDTHS = { left: 200, center: 600, right: 500 };

/** 左栏最宽多少像素。右栏不用单独限，它被中栏的最窄宽度顶住。 */
export const MAX_LEFT_WIDTH = 300;

/** 默认宽度。 */
export const DEFAULT_WIDTHS: ColumnWidths = { left: 264, right: 420 };

/** 窗口窄于这个宽度时一次只显示一栏。 */
export const NARROW_WIDTH = 900;

/** 键盘调宽度时一下挪多少像素。 */
export const KEY_STEP = 24;

/** 分隔线占多宽，像素。 */
export const SPLITTER_WIDTH = 6;

/** 浏览器本地存宽度用的键。 */
const STORAGE_KEY = 'jmbots.columns';


/**
 * 把宽度收进能放下的范围：每栏不窄于最小值，左栏不宽于最大值；放不下时先压右栏、再压左栏，中栏至少留最小值。
 * @param total 窗口宽度。
 * @param widths 想要的宽度。
 * @param rightOpen 右栏展开没有。
 * @returns 能用的宽度。
 */
export function clampWidths(total: number, widths: ColumnWidths, rightOpen: boolean): ColumnWidths {
  /** 两条分隔线（右栏收起时一条）。 */
  const splitters = SPLITTER_WIDTH * (rightOpen ? 2 : 1);
  /** 左栏。 */
  let left = Math.min(MAX_LEFT_WIDTH, Math.max(MIN_WIDTHS.left, Math.round(widths.left)));
  /** 右栏。 */
  let right = Math.max(MIN_WIDTHS.right, Math.round(widths.right));
  /** 中栏还剩多少。 */
  let center = total - splitters - left - (rightOpen ? right : 0);
  if (center < MIN_WIDTHS.center && rightOpen) {
    right = Math.max(MIN_WIDTHS.right, right - (MIN_WIDTHS.center - center));
    center = total - splitters - left - right;
  }
  if (center < MIN_WIDTHS.center) {
    left = Math.max(MIN_WIDTHS.left, left - (MIN_WIDTHS.center - center));
  }
  return { left, right };
}


/**
 * 拖了一条分隔线以后的宽度。
 * @param start 开始拖时的宽度。
 * @param which 拖的是左边那条（左栏和中栏之间）还是右边那条（中栏和右栏之间）。
 * @param delta 鼠标横着挪了多少像素（往右为正）。
 * @param total 窗口宽度。
 * @param rightOpen 右栏展开没有。
 */
export function dragWidths(start: ColumnWidths, which: 'left' | 'right', delta: number, total: number, rightOpen: boolean): ColumnWidths {
  //M 左边那条往右拖，左栏变宽；右边那条往右拖，右栏变窄。
  /** 想要的。 */
  const wanted = which === 'left' ? { ...start, left: start.left + delta } : { ...start, right: start.right - delta };
  return clampWidths(total, wanted, rightOpen);
}


/**
 * 是不是窄窗口（一次只显示一栏）：右栏开着时三栏的最窄宽度加起来放不下也算（用户 11-06：右栏打开至少 500）。
 * @param total 窗口宽度。
 * @param rightOpen 右栏开着没有。
 */
export function isNarrow(total: number, rightOpen = false): boolean {
  return total < (rightOpen ? MIN_WIDTHS.left + MIN_WIDTHS.center + MIN_WIDTHS.right + SPLITTER_WIDTH * 2 : NARROW_WIDTH);
}


/**
 * 读记下的宽度；没记过或坏了就用默认。
 * @param storage 浏览器本地存储。
 */
export function loadWidths(storage: Pick<Storage, 'getItem'>): ColumnWidths {
  try {
    /** 存的。 */
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as Partial<ColumnWidths> | null;
    if (saved && typeof saved.left === 'number' && typeof saved.right === 'number') {
      return { left: saved.left, right: saved.right };
    }
  } catch {
    //M 坏了就用默认。
  }
  return { ...DEFAULT_WIDTHS };
}


/**
 * 记下宽度。
 * @param storage 浏览器本地存储。
 * @param widths 宽度。
 * 副作用：写浏览器本地存储。
 */
export function saveWidths(storage: Pick<Storage, 'setItem'>, widths: ColumnWidths): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(widths));
}
