/**
 * 拼飞书卡片的 JSON：待确认卡片、进度卡片。纯函数，不碰网络、不碰库，离线测试直接 import。
 * 照 0.4 的 src/channels/Feishu.ts（buildCard、审核卡片、进度卡片）。
 * Pending、ProgressItem 的形状照 approval.md、progress.md 第 2 节，这里只取卡片用到的几项。
 * 待确认卡片照 Pending.card（utils/Card.ts 的卡片数据，网页审批面板画的是同一份）拼；老数据没有 card 时照 detail 拼。
 */
import type * as cardUtils from '../../../utils/Card.ts';
import { RISK_TEXT } from '../../../utils/Card.ts';
import * as textModule from '../../../utils/Text.ts';


/** 一件待确认的事（approval.md 第 2 节 Pending 里卡片用到的几项）。 */
export interface PendingLike {
  id: number;
  kind: string;
  title: string;
  detail: string;
  bot: string;
  session?: string;
  state: 'waiting' | 'approved' | 'rejected';
  by?: string;
  decidedAt?: number;
  /** 卡片数据（approval 给的）。 */
  card?: cardUtils.CardData;
}


/** 一项进度（progress.md 第 2 节 ProgressItem 里卡片用到的几项）。 */
export interface ProgressItemLike {
  id: number;
  sessionId: string;
  bot: string;
  text: string;
  stage: 'dispatching' | 'running' | 'done' | 'error' | 'stopped' | 'timeout' | 'flagged' | 'handed';
  action: string;
  startedAt: number;
  endedAt?: number;
  steps: number;
  deadline?: number;
  limitMinutes?: number;
  timings: { modelMs: number; tools: { name: string; count: number; ms: number }[] };
  result?: string;
}


/** 卡片上的一个按钮。 */
export interface Button {
  /** 按钮上的字。 */
  text: string;
  /** primary 蓝、danger 红、default 白。 */
  type: 'primary' | 'danger' | 'default';
  /** 点了以后飞书原样带回来的值。只放动作，号从表里查。 */
  value: Record<string, unknown>;
}


/** 拼卡片要的东西。 */
export interface CardSpec {
  /** 标题栏颜色：orange、blue、green、red、grey。 */
  color: string;
  /** 标题。 */
  title: string;
  /** 正文，每段一个 markdown 块。 */
  sections: string[];
  /** 一排按钮；没有就不放。 */
  buttons?: Button[];
  /** 底下灰色的小字。 */
  note?: string;
  /** 可展开的一块（飞书的折叠面板）：标题、里面的 markdown。 */
  fold?: { title: string; content: string };
}


/** 进度卡片限时的选项，分钟（0.4 src/capabilities/Progress.ts:31）。 */
export const LIMIT_CHOICES = [15, 20];

/** 待确认的细节最多放多少字。 */
const DETAIL_MAX = 1500;

/** 各阶段的颜色和图标。 */
const STAGES: Record<ProgressItemLike['stage'], { color: string; icon: string; text: string }> = {
  dispatching: { color: 'blue', icon: '📨', text: '前台在转' },
  running: { color: 'blue', icon: '⏳', text: '在做' },
  flagged: { color: 'orange', icon: '⚠️', text: '要留意' },
  done: { color: 'green', icon: '✅', text: '做完了' },
  handed: { color: 'green', icon: '📤', text: '交给后台了' },
  error: { color: 'red', icon: '❌', text: '出错了' },
  timeout: { color: 'red', icon: '⏰', text: '到点了' },
  stopped: { color: 'grey', icon: '⏹️', text: '停下了' },
};


/**
 * 截断。
 * @param text 原文。
 * @param max 最多几个字。
 * @returns 截过的。
 */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}……`;
}


/**
 * 拼一张卡片（0.4 buildCard）：标题栏、每段正文一个 markdown、一排按钮、灰色小字。
 * update_multi：卡片能被原地改（message.patch），所有人看到的都跟着变。
 * @param spec 颜色、标题、正文、按钮、小字。
 * @returns 飞书卡片 JSON。
 */
export function card(spec: CardSpec): Record<string, unknown> {
  const elements: unknown[] = spec.sections.map((content) => ({ tag: 'markdown', content }));
  //M 折叠面板：默认收着，点标题展开（放调用的工具数据）。
  if (spec.fold !== undefined) {
    elements.push({
      tag: 'collapsible_panel', expanded: false,
      header: { title: { tag: 'plain_text', content: spec.fold.title } },
      elements: [{ tag: 'markdown', content: spec.fold.content }],
    });
  }
  if (spec.buttons !== undefined && spec.buttons.length > 0) {
    elements.push({
      tag: 'action',
      actions: spec.buttons.map((button) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: button.text },
        type: button.type,
        value: button.value,
      })),
    });
  }
  if (spec.note !== undefined && spec.note !== '') {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: spec.note }] });
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: spec.color, title: { tag: 'plain_text', content: spec.title } },
    elements,
  };
}


/**
 * 待确认卡片。还在等：橙色，“同意执行”“拒绝”两个按钮；定了：灰色，写结果，没按钮。
 * @param pending 那件待确认的事。
 * @returns 飞书卡片 JSON。
 */
export function approval(pending: PendingLike): Record<string, unknown> {
  if (pending.card !== undefined) return fromCard(pending.id, pending.card);
  const sections = [`\`\`\`\n${cut(pending.detail, DETAIL_MAX)}\n\`\`\``];
  if (pending.session !== undefined && pending.session !== '') {
    sections.push(`**机器人 / 会话** ${pending.bot} / ${pending.session}`);
  }
  const title = `待确认 #${String(pending.id)}：${pending.title}`;
  if (pending.state === 'waiting') {
    return card({
      color: 'orange',
      title,
      sections,
      buttons: [
        { text: '同意执行', type: 'primary', value: { action: 'approve' } },
        { text: '拒绝', type: 'danger', value: { action: 'reject' } },
      ],
      note: `点按钮，或者直接回“同意 ${String(pending.id)}”“拒绝 ${String(pending.id)}”`,
    });
  }
  const result = pending.state === 'approved' ? '已同意执行' : '已拒绝';
  const when = pending.decidedAt === undefined ? '' : `，${new Date(pending.decidedAt).toLocaleString('zh-CN', { hour12: false })}`;
  sections.push(`**结果** ${result}（${pending.by ?? '未知'}${when}）`);
  return card({ color: 'grey', title, sections });
}


/**
 * 进度卡片：在做什么、用了多久、第几步、限时；各段耗时；结果。没结束有限时和终止按钮，结束了没按钮。
 * @param item 一项进度。
 * @param at 现在的毫秒时间戳（算“用了多久”“还剩多久”）；测试可以给固定值。
 * @returns 飞书卡片 JSON。
 */
export function progress(item: ProgressItemLike, at = Date.now()): Record<string, unknown> {
  const stage = STAGES[item.stage];
  const end = item.endedAt ?? at;
  const head = [`**${stage.icon} ${item.action || stage.text}**`, `用了 ${textModule.duration(end - item.startedAt)}`, `第 ${String(item.steps)} 步`];
  if (item.limitMinutes !== undefined && item.limitMinutes > 0) {
    const left = item.deadline !== undefined && item.endedAt === undefined ? `（还剩 ${textModule.duration(item.deadline - at)}）` : '';
    head.push(`限时 ${String(item.limitMinutes)} 分钟${left}`);
  }
  const sections = [head.join(' · ')];

  //M 各段耗时：模型多久，每个工具几次、多久。
  const tools = item.timings.tools.map((tool) => `${tool.name} ×${String(tool.count)} ${textModule.duration(tool.ms)}`);
  sections.push(`**耗时** 模型 ${textModule.duration(item.timings.modelMs)}${tools.length > 0 ? `；${tools.join('；')}` : ''}`);
  if (item.result !== undefined && item.result !== '') {
    sections.push(`**结果** ${item.result}`);
  }
  const buttons: Button[] = item.endedAt === undefined
    ? [
        ...LIMIT_CHOICES.map((minutes): Button => ({ text: `最多 ${String(minutes)} 分钟`, type: 'default', value: { action: 'limit', minutes } })),
        { text: '不限时', type: 'default', value: { action: 'limit', minutes: 0 } },
        { text: '终止', type: 'danger', value: { action: 'stop' } },
      ]
    : [];
  return card({ color: stage.color, title: `${item.bot}：${item.text}`, sections, buttons });
}


/** 风险等级的标题颜色和图标。 */
const RISK_LOOK: Record<cardUtils.RiskLevel, { color: string; icon: string }> = {
  low: { color: 'green', icon: '🟢' }, medium: { color: 'orange', icon: '🟠' }, high: { color: 'red', icon: '🔴' },
};


/**
 * 照卡片数据拼飞书卡片：标题、原因、具体项（命令、路径等宽）、风险、按钮（照卡片给的字和颜色）、可展开的工具数据。
 * 还在等有按钮；定了、结束了变灰，写结果，没按钮。
 * @param id 待确认的号（按钮值里不放号，号从表里查；标题上写出来）。
 * @param data 卡片数据。
 */
export function fromCard(id: number, data: cardUtils.CardData): Record<string, unknown> {
  //M 紧凑：上面一行“为什么 + 风险等级”，命令、目录、会动到、风险说明、工具数据都收进“详情”，点开才看。
  const head = [data.reason, data.risk === undefined ? '' : `${RISK_LOOK[data.risk.level].icon} 风险${RISK_TEXT[data.risk.level]}`].filter((part) => part !== '').join('　');
  const sections: string[] = head === '' ? [] : [cut(head, 200)];
  const more: string[] = data.items.map((item) => (item.code === true ? `**${item.label}**\n\`\`\`\n${cut(item.value, DETAIL_MAX)}\n\`\`\`` : `**${item.label}** ${cut(item.value, DETAIL_MAX)}`));
  if (data.risk !== undefined) more.push(`**风险** ${data.risk.text}`);
  if (data.details !== undefined) more.push(`**${data.details.label}**\n\`\`\`json\n${cut(JSON.stringify(data.details.data, null, 2), DETAIL_MAX)}\n\`\`\``);
  const fold = more.length === 0 ? undefined : { title: '详情', content: more.join('\n') };
  const title = `#${String(id)} ${data.title}`;
  if (data.state === 'waiting') {
    const spec: CardSpec = {
      color: data.risk === undefined ? 'orange' : RISK_LOOK[data.risk.level].color,
      title,
      sections,
      buttons: data.buttons.map((button) => ({ text: button.label, type: button.style, value: { action: button.action } })),
    };
    if (data.kind === 'long-run') spec.note = '不点就一直做下去';
    if (fold !== undefined) spec.fold = fold;
    return card(spec);
  }
  sections.push(`**结果** ${data.result ?? (data.state === 'ended' ? '已结束' : data.state === 'approved' ? '已同意' : '已拒绝')}`);
  const spec: CardSpec = { color: 'grey', title: data.state === 'ended' ? `${title}（已结束）` : title, sections };
  if (fold !== undefined) spec.fold = fold;
  return card(spec);
}
