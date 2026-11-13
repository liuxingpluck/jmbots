/**
 * 0.4 学习界面还在用的类型（src/channels/HttpLearn.ts、tests/Ui_Learn.test.ts）。
 * 从原来的 learn/src/Types.ts 搬过来，学习页已经去掉，0.6 不再用这些类型。
 */


/** 流向图上的一个节点。 */
export interface FlowNode {
  /** 显示的名字。 */
  label: string;
  /** 在哪一层：前端、网络、后端、存储。 */
  layer: string;
}


/** 指向源码的锚点：文件里第一处含 find 的那一行开始。 */
export interface Anchor {
  /** 相对仓库的文件路径。 */
  file: string;
  /** 那一行里的一段字（函数开头这类），不写死行号。 */
  find: string;
}


/** 一步。 */
export interface Step {
  /** 标题。 */
  title: string;
  /** 在哪一层（和流向图的 layer 一样的说法）。 */
  phase: string;
  /** 亮流向图的第几个节点。 */
  flow?: number;
  /** 这一步的函数。 */
  func: string;
  /** 文件（给人看）。 */
  file: string;
  /** 这一步在干什么。 */
  desc: string;
  /** 进去的参数。 */
  input?: unknown;
  /** 出来的结果。 */
  output?: unknown;
  /** 这一步结束时的变量快照：和上一步比，变了的亮一下。 */
  vars?: Record<string, unknown>;
  /** 真实源码的位置；有它就显示抽出来的源码。 */
  anchor?: Anchor;
  /** 回放真实消息时用：tests/trace-anchors.json 里的键（后端只给键，不知道源码在哪一行）。 */
  ref?: string;
  /** 没有单独对应的源码时，原型写的示意代码。 */
  sketch?: string[];
  /** 跟进去的子步骤。 */
  children?: Step[];
}


/** 一个场景。 */
export interface Scene {
  /** 号。 */
  id: string;
  /** 名字。 */
  name: string;
  /** 一句话说明。 */
  desc: string;
  /** 流向图的节点，按顺序。 */
  flows: FlowNode[];
  /** 步骤。 */
  steps: Step[];
}


/** 打包时抽出来的一段源码。 */
export interface Snippet {
  /** 文件。 */
  file: string;
  /** 从第几行开始（1 起）。 */
  start: number;
  /** 那几行。 */
  lines: string[];
}


/** 打包时交给 0.4 界面的全部数据。 */
export interface LearnData {
  /** 场景。 */
  scenes: Scene[];
  /** 抽出来的源码：键是 “文件#find”。 */
  snippets: Record<string, Snippet>;
  /** 回放真实消息时，步骤的 ref → 锚点（tests/trace-anchors.json）。 */
  traceAnchors: Record<string, Anchor>;
}


/**
 * 一步要显示哪段源码：自己写了锚点用自己的；回放来的步骤按 ref 去 traceAnchors 里找。
 * @param step 这一步。
 * @param traceAnchors ref → 锚点。
 * @returns 锚点。
 */
export function anchorOf(step: Step, traceAnchors: Record<string, Anchor>): Anchor | undefined {
  return step.anchor ?? (step.ref ? traceAnchors[step.ref] : undefined);
}


/**
 * 锚点在 snippets 里的键。
 * @param anchor 锚点。
 * @returns 键。
 */
export function snippetKey(anchor: Anchor): string {
  return `${anchor.file}#${anchor.find}`;
}
