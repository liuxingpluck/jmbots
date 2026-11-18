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


// 2026-11-17：自己的 cut 去掉，太长的字改用 utils/Text.ts 的 clip 截（按字截，末尾加“…”）。


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
  //M 若已提供统一结构化卡片数据，直接转绘为飞书交互卡片结构，与网页审批面板保持一致。
  if (pending.card !== undefined) return fromCard(pending.id, pending.card);
  const sections = [`\`\`\`\n${textModule.clip(pending.detail, DETAIL_MAX)}\n\`\`\``];
  if (pending.session !== undefined && pending.session !== '') {
    sections.push(`**机器人 / 会话** ${pending.bot} / ${pending.session}`);
  }
  const title = `待确认 #${String(pending.id)}：${pending.title}`;
  if (pending.state === 'waiting') {
    //M 仍待审批时渲染橙色带同意/拒绝按钮的可交互卡片。
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
  let result = '已拒绝';
  if (pending.state === 'approved') {
    result = '已同意执行';
  }
  let when = '';
  if (pending.decidedAt !== undefined) {
    when = `，${new Date(pending.decidedAt).toLocaleString('zh-CN', { hour12: false })}`;
  }
  sections.push(`**结果** ${result}（${pending.by ?? '未知'}${when}）`);
  //M 已审批落定后转为灰底只读卡片并移除所有按钮。
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
  const head = [
    `**${stage.icon} ${item.action || stage.text}**`,
    `用了 ${textModule.getDuration(end - item.startedAt)}`,
    `第 ${String(item.steps)} 步`,
  ];
  if (item.limitMinutes !== undefined && item.limitMinutes > 0) {
    let left = '';
    if (item.deadline !== undefined && item.endedAt === undefined) {
      //M 任务未结束且设置截止时间时计算剩余时长文本。
      const leftText = textModule.getDuration(item.deadline - at);
      left = `（还剩 ${leftText}）`;
    }
    head.push(`限时 ${String(item.limitMinutes)} 分钟${left}`);
  }
  const sections = [head.join(' · ')];

  //M 各段耗时：模型多久，每个工具几次、多久。
  const tools = item.timings.tools.map((tool) => {
    return `${tool.name} ×${String(tool.count)} ${textModule.getDuration(tool.ms)}`;
  });
  let toolSuffix = '';
  if (tools.length > 0) {
    toolSuffix = `；${tools.join('；')}`;
  }
  //M 格式化模型累计耗时文本并拼接各工具调用统计。
  const modelCost = textModule.getDuration(item.timings.modelMs);
  sections.push(`**耗时** 模型 ${modelCost}${toolSuffix}`);
  if (item.result !== undefined && item.result !== '') {
    sections.push(`**结果** ${item.result}`);
  }
  let buttons: Button[] = [];
  if (item.endedAt === undefined) {
    buttons = [
      ...LIMIT_CHOICES.map((minutes): Button => ({
        text: `最多 ${String(minutes)} 分钟`,
        type: 'default',
        value: { action: 'limit', minutes },
      })),
      { text: '不限时', type: 'default', value: { action: 'limit', minutes: 0 } },
      { text: '终止', type: 'danger', value: { action: 'stop' } },
    ];
  }
  //M 按阶段配色、当前进展描述与耗时摘要组装进度卡片 JSON。
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
  let riskPart = '';
  if (data.risk !== undefined) {
    riskPart = `${RISK_LOOK[data.risk.level].icon} 风险${RISK_TEXT[data.risk.level]}`;
  }
  const head = [data.reason, riskPart].filter((part) => part !== '').join('　');
  const sections: string[] = [];
  if (head !== '') {
    //M 裁剪顶部摘要行长度后放进卡片首段正文：审批卡片是三行（要做什么、动哪些、为什么问你），每行最多 160 字，600 字放得下。
    const clippedHead = textModule.clip(head, 600);
    sections.push(clippedHead);
  }
  const more: string[] = data.items.map((item) => {
    //M 按详情最大字数截断字段值，代码类条目单独包裹围栏块。
    const clipped = textModule.clip(item.value, DETAIL_MAX);
    if (item.code === true) return `**${item.label}**\n\`\`\`\n${clipped}\n\`\`\``;

    return `**${item.label}** ${clipped}`;
  });
  if (data.risk !== undefined) {
    more.push(`**风险** ${data.risk.text}`);
  }
  if (data.details !== undefined) {
    const detailJson = textModule.clip(JSON.stringify(data.details.data, null, 2), DETAIL_MAX);
    more.push(`**${data.details.label}**\n\`\`\`json\n${detailJson}\n\`\`\``);
  }
  let fold: CardSpec['fold'];
  if (more.length > 0) {
    fold = { title: '详情', content: more.join('\n') };
  }
  const title = `#${String(id)} ${data.title}`;
  if (data.state === 'waiting') {
    let waitColor = 'orange';
    if (data.risk !== undefined) {
      waitColor = RISK_LOOK[data.risk.level].color;
    }
    const spec: CardSpec = {
      color: waitColor,
      title,
      sections,
      buttons: data.buttons.map((button) => ({
        text: button.label,
        type: button.style,
        value: { action: button.action },
      })),
    };
    if (data.kind === 'long-run') {
      spec.note = '不点就一直做下去';
    }
    if (fold !== undefined) {
      spec.fold = fold;
    }
    //M 将等待态通用审批卡片规格渲染成飞书交互卡片结构。
    return card(spec);
  }
  let fallbackResult = '已拒绝';
  if (data.state === 'approved') {
    fallbackResult = '已同意';
  }
  if (data.state === 'ended') {
    fallbackResult = '已结束';
  }
  sections.push(`**结果** ${data.result ?? fallbackResult}`);
  let endTitle = title;
  if (data.state === 'ended') {
    endTitle = `${title}（已结束）`;
  }
  const spec: CardSpec = { color: 'grey', title: endTitle, sections };
  if (fold !== undefined) {
    spec.fold = fold;
  }
  //M 将已结束或已决定的通用审批卡片渲染为灰底终态卡片。
  return card(spec);
}
