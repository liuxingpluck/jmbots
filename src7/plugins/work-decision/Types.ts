/** 决策图的后端、网页和跟踪记录共用的数据结构。 */

export const KINDS = ['goal', 'fork', 'feature', 'pending', 'decided', 'work'] as const;
export const STATUSES = ['open', 'decided', 'working', 'done', 'dropped'] as const;

export type DecisionKind = typeof KINDS[number];
export type DecisionStatus = typeof STATUSES[number];

/** 用户可以选择的一项。 */
export interface DecisionOption {
  /** 同一节点内唯一的选项号。 */
  id: string;
  /** 一句话说明选择。 */
  text: string;
  /** 是否为推荐选项。 */
  recommended?: boolean;
  /** 一句话说明选择的代价。 */
  cost?: string;
}

/** 用户或中控在节点上写的一句话。 */
export interface DecisionNote {
  /** 节点内递增的留言号，如 n1。 */
  id: string;
  /** 谁写的。 */
  author: 'user' | 'central';
  /** 写下的毫秒时间戳。 */
  at: number;
  /** 写的内容。 */
  text: string;
  /** 用户写话时一并选的选项号。 */
  option?: string;
  /** 中控这句回的是哪条留言。 */
  replyTo?: string;
  /** 中控回过这条用户留言的毫秒时间戳。 */
  repliedAt?: number;
  /** 来自 relay 的持久回信号，重试时用它对账。 */
  relayReplyId?: number;
}

/** 主人定完以后接收结果的一方。 */
export type DecisionAsker = {
  /** 把结果送回提问的会话。 */
  kind: 'session';
  /** 提问时正在运行的持久会话号。 */
  sessionId: string;
} | {
  /** 把结果送到外部助手的 relay 收件。 */
  kind: 'helper';
  /** relay 配置中的助手名。 */
  name: string;
};

/** 当前图中的一个节点。 */
export interface DecisionNode {
  /** 图中唯一的节点号。 */
  id: string;
  /** 决策节点的类别。 */
  kind: DecisionKind;
  /** 画布上显示的简短标题。 */
  title: string;
  /** 一段可选的结论或背景。 */
  summary: string;
  /** 上一级节点号，中心目标是 null。 */
  parent: string | null;
  /** 归属的机器人；旧决策尚无归属时省略。 */
  bot?: string;
  /** 归属的工作区；缺省时列在该机器人名下的未归类决策。 */
  workspaceId?: string;
  /** 用户定完以后该把结果送给谁。 */
  asker?: DecisionAsker;
  /** 节点当前状态。 */
  status: DecisionStatus;
  /** 节点首次写入的毫秒时间戳。 */
  createdAt: number;
  /** 决定作出的毫秒时间戳，历史未记录时省略。 */
  decidedAt?: number;
  /** 作出决定的人。 */
  decidedBy?: 'user' | 'central';
  /** 决策提供的选项。 */
  options?: DecisionOption[];
  /** 已选的选项号。 */
  chosen?: string;
  /** 中控确认收到的毫秒时间戳。 */
  acknowledgedAt?: number;
  /** 中控确认时附的说明。 */
  note?: string;
  /** 详细说明在仓库中的位置。 */
  detailPath?: string;
  /** 侧栏展示的 Markdown 正文。 */
  body?: string;
  /** 记录决定来历的文档路径。 */
  sources?: string[];
  /** 可打开的证据链接。 */
  links?: string[];
  /** 节点是否在主线上。 */
  main?: boolean;
  /** 跨枝依赖的节点号。 */
  needs?: string[];
  /** 用户和中控在这个节点上写的话，按时间先后。 */
  notes?: DecisionNote[];
}

/** 整张图的公开快照。 */
export interface DecisionGraph {
  /** 最后一次改动的序号。 */
  revision: number;
  /** 供前端布局的节点。 */
  nodes: DecisionNode[];
  /** 公开接口附上各项目的根节点和显示名。 */
  projects?: DecisionProject[];
}

/** 工作决策页面可选择的一组节点。 */
export interface DecisionProject {
  /** 这一组节点的任务树根节点号。 */
  root: string;
  /** 工作区当前名称或未归类的显示名称。 */
  name: string;
}

/** 待主人定的事项，调用方附上提问方和项目归属。 */
export interface DecisionAsk {
  /** 调用方提供的去重键或节点编号。 */
  id: string;
  /** 简短标题。 */
  title: string;
  /** 一句话交代决策背景。 */
  summary: string;
  /** 可直接点选的项目。 */
  options: DecisionOption[];
  /** 可选 Markdown 正文。 */
  body?: string;
  /** 提问所在的机器人。 */
  bot: string;
  /** 提问所在的工作区，没有绑定时归到该机器人名下。 */
  workspaceId?: string;
  /** 决定送回的会话或外部助手。 */
  asker: DecisionAsker;
}

/** 一项值得通知中控的任务变化。 */
export interface DecisionTaskChange {
  /** 实际节点号，回信仍写进该节点。 */
  node: string;
  /** 变化时的标题。 */
  title: string;
  /** 新状态。 */
  status: DecisionStatus;
  /** 原状态，创建节点时省略。 */
  previousStatus?: DecisionStatus;
}

/** 每次改动追加到历史的一条。 */
export interface DecisionChange {
  /** 可用于增量查询的递增序号。 */
  seq: number;
  /** 改动时间戳。 */
  at: number;
  /** 改动发起者。 */
  actor: 'central' | 'user' | 'plugin';
  /** 操作名称。 */
  action: 'put' | 'status' | 'choose' | 'ack' | 'note' | 'reply';
  /** 受影响的节点号。 */
  nodes: readonly string[];
  /** 新建及状态变化详情，relay 不可用时可按变更接口读取。 */
  tasks?: readonly DecisionTaskChange[];
  /** 用户选择时的选项号。 */
  option?: string;
  /** 用户选择时的节点标题。 */
  title?: string;
  /** 确认附言。 */
  note?: string;
  /** 写话或回话时的留言号。 */
  noteId?: string;
}
