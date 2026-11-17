/**
 * 卡片数据：一张要用户点的卡片长什么样。审批卡片（approval）、长跑提醒卡片（progress：后台会话跑满 15 分钟问要不要终止）共用这一种结构。
 * 网页（审批面板、聊天里的卡片）和飞书（feishu/cards/Render.ts）都照这份数据画，不各自拼文字。
 * 只是数据和两个小函数，不碰网络、不碰库。
 */


/** 风险等级：低、中、高。高的时候“同意”按钮用危险色。 */
export type RiskLevel = 'low' | 'medium' | 'high';

/** 卡片的状态：在等；同意了；拒绝了；结束了（比如会话做完了，卡片作废）。 */
export type CardState = 'waiting' | 'approved' | 'rejected' | 'ended';

/** 一个按钮。action 只有两种：approve（卡片的“是”，审批是同意、长跑提醒是终止）、reject（卡片的“否”）。 */
export interface CardButton {
  action: 'approve' | 'reject';
  /** 按钮上的字。 */
  label: string;
  /** primary 主色、danger 危险色、default 普通。 */
  style: 'primary' | 'danger' | 'default';
}

/** 一行具体信息：命令、目录、文件路径、已运行时长…… */
export interface CardItem {
  label: string;
  value: string;
  /** 用等宽字显示（命令、路径）。 */
  code?: boolean;
}

/** 一张卡片。 */
export interface CardData {
  /** approval：审批；long-run：长跑提醒。 */
  kind: 'approval' | 'long-run';
  /** 标题：要做什么，大白话。 */
  title: string;
  /** 为什么要做 / 为什么来问。 */
  reason: string;
  /** 具体的命令、文件路径、时长、在做什么。 */
  items: CardItem[];
  /** 风险等级和一句说明；长跑提醒没有。 */
  risk?: { level: RiskLevel; text: string };
  /** 可展开的原始数据：调用的工具和参数、审核模型的原话。 */
  details?: { label: string; data: unknown };
  /** 按钮，照先后排。 */
  buttons: CardButton[];
  /** 状态。 */
  state: CardState;
  /** 定了、结束了以后的一句话（谁定的、什么时候）。 */
  result?: string;
}


/** 风险等级的中文。 */
export const RISK_TEXT: Record<RiskLevel, string> = { low: '低', medium: '中', high: '高' };


/**
 * 认风险等级：low/medium/high，也认“低 / 中 / 高”；认不出当 medium。
 * @param value 模型给的。
 */
export function riskLevel(value: unknown): RiskLevel {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'low' || text === '低') return 'low';
  if (text === 'high' || text === '高') return 'high';
  return 'medium';
}


/**
 * 卡片写成几行文字：给只认文字的渠道（命令行、没有卡片的聊天）和待确认的 detail 用。
 * @param card 卡片。
 */
export function cardText(card: CardData): string {
  //M 标题一行，后面有什么写什么：为什么、每一条具体信息、风险、结果。
  const lines = [card.title];
  if (card.reason !== '') {
    lines.push(`为什么：${card.reason}`);
  }
  for (const item of card.items) {
    lines.push(`${item.label}：${item.value}`);
  }
  if (card.risk !== undefined) {
    const level = RISK_TEXT[card.risk.level];
    lines.push(`风险：${level}，${card.risk.text}`);
  }
  if (card.result !== undefined) {
    lines.push(`结果：${card.result}`);
  }
  return lines.join('\n');
}
