/**
 * 审批卡片怎么拼（从 index.ts 搬出来的，行为不变）：
 *   plainCard：没给卡片时拼一张普通的“同意”“拒绝”卡；
 *   cardLabel：定了以后卡片结果写哪个按钮的字；
 *   reviewCard：命令审核问用户时的卡片（要做什么、动哪些、为什么问你三行，加详情、风险、原始数据）；
 *   getReviewReason：审核小会话没放行的理由原文，review 和卡片都用。
 * 只被 index.ts 的 Approval 调；ReviewInput 只 import type，不按值 import index.ts。
 */
import type { ReviewInput } from './index.ts';
import * as rules from './Rules.ts';
import * as cardUtils from '../../utils/Card.ts';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';


/** 审批卡片“动哪些”最多列几个路径。 */
const CARD_PATHS_MAX = 5;

/** 审批卡片正文每行最多几个字（飞书卡片顶上那段一眼要看完）。 */
const CARD_LINE_MAX = 160;


/**
 * 没给卡片时拼一张普通的：标题、细节，“同意”“拒绝”两个按钮。
 * @param title 标题。
 * @param detail 细节。
 */
export function plainCard(title: string, detail: string): Omit<cardUtils.CardData, 'state'> {
  //M 有细节就放一行“细节”；按钮固定是“同意”“拒绝”两个。
  const items: cardUtils.CardItem[] = [];
  if (detail !== '') {
    items.push({ label: '细节', value: detail });
  }
  return {
    kind: 'approval', title, reason: '', items,
    buttons: [
      { action: 'approve', label: '同意', style: 'primary' },
      { action: 'reject', label: '拒绝', style: 'default' },
    ],
  };
}

/** 卡片上某个按钮的字，结果里用（“终止了”“同意执行”）。 */
export function cardLabel(card: cardUtils.CardData, action: 'approve' | 'reject'): string {
  //M 取卡片上这个动作对应按钮的字；卡片上没有这个按钮，退回“已同意”“已拒绝”。
  const label = card.buttons.find((button) => button.action === action)?.label;
  if (label !== undefined) return `点了“${label}”`;

  if (action === 'approve') return '已同意';

  return '已拒绝';
}


/**
 * 审核小会话没放行的理由原文（用户 11-18 #172：卡片要说清为什么问你，不许空着）。
 * @param answer 审核模型的 JSON；没答上来是 undefined。
 * @returns 它写的 risk 原文；没答上来、没写、只写“无”的给一句固定的话。
 */
export function getReviewReason(answer: Record<string, unknown> | undefined): string {
  if (answer === undefined) return '没答上来（出错、超时或回的不是 JSON）';

  //G 没写理由、或者不放行却写“无”：照实说没给，不留空。
  const risk = utils.getStringField(answer, 'risk').trim();
  if (risk === '' || risk === '无') return '审核没给出理由';

  return risk;
}


/**
 * 卡片“动哪些”：命令里写的绝对路径在前，审核模型列的路径在后，去重后最多 CARD_PATHS_MAX 个；都没有就说在执行目录里。
 * @param input 审核的输入（命令、执行目录）。
 * @param modelPaths 审核模型 JSON 里的 paths。
 * @returns 一行文字。
 */
function getCardPaths(input: ReviewInput, modelPaths: string[]): string {
  //M 命令里解析出来的最可信，排前面；模型列的补在后面（相对路径的命令只有它能说出动哪里）。
  const commandPaths = rules.getAbsPaths(input.command);
  const all = [...new Set([...commandPaths, ...modelPaths])];
  if (all.length === 0) return `执行目录 ${input.cwd} 里的文件`;

  //M 超过 5 个只列前 5 个，后面说还有几个（详情里有全部）。
  const shown = all.slice(0, CARD_PATHS_MAX).join('、');
  if (all.length <= CARD_PATHS_MAX) return shown;

  return `${shown} 等 ${String(all.length)} 个`;
}


/**
 * 命令审批卡片（用户 11-18 #172：说清楚，别说空话）。正文（reason）三行，飞书卡片顶上、网页审批面板一眼看完：
 *   要做什么：审核小会话写的执行结果（what），没写用决策模型顺带写的 what，都没有写“说不清会做成什么（命令：…）”；
 *   动哪些：getCardPaths；
 *   为什么问你：review 里每一档没放行的原因（不在可信目录、决策模型拿不准、审核小会话的理由原文、必须人审的那一小块）。
 * 命令、目录、脚本、机器人在干的活、会动到的每个路径、审核建议放进详情；风险说明写具体理由，不单写“风险中”。
 * 风险高时“同意执行”用危险色；调用的工具数据和审核原话放进可展开的 details。
 * @param input 审核的输入。
 * @param script 要跑的脚本。
 * @param answer 审核模型的 JSON；没答上来是 undefined。
 * @param why 机器人在干的活（会话最后一句用户的话）。
 * @param asks review 里每一档没放行的原因，照先后。
 * @param decisionWhat 决策模型顺带写的执行结果（decision/judge-result 的 what）；没有是空串。
 * @returns 还没定状态的卡片。
 */
export function reviewCard(
  input: ReviewInput,
  script: ReturnType<typeof rules.readScript>,
  answer: Record<string, unknown> | undefined,
  why: string,
  asks: string[],
  decisionWhat: string,
): Omit<cardUtils.CardData, 'state' | 'result'> {
  //M 取审核回答里某个字段的文字，没写、不是字符串就是空串。
  const text = (key: string): string => {
    const value = answer?.[key];
    if (typeof value === 'string') return value.trim();

    return '';
  };
  //M 把审核模型给出的风险等级归一为标准档位（未知值回落 medium）。
  const level = cardUtils.getRiskLevel(answer?.['risk_level']);
  const items: cardUtils.CardItem[] = [
    { label: '命令', value: input.command, code: true },
    { label: '目录', value: input.cwd, code: true },
  ];
  if (script !== undefined) {
    items.push({ label: '要跑的脚本', value: script.file, code: true });
  }
  let paths: string[] = [];
  if (Array.isArray(answer?.['paths'])) {
    const rawPaths = answer['paths'] as unknown[];
    paths = rawPaths.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  }

  //M 把会动到的文件、机器人在干的活、审核建议逐项放进详情。
  for (const file of paths) {
    items.push({ label: '会动到', value: file, code: true });
  }
  if (why !== '') {
    items.push({ label: '机器人在干的活', value: why });
  }
  const advice = text('advice');
  if (advice !== '') {
    items.push({ label: '审核建议', value: advice });
  }
  let approveStyle: 'danger' | 'primary' = 'primary';
  if (level === 'high') {
    approveStyle = 'danger';
  }

  //M 正文第一行“要做什么”：先用审核小会话写的执行结果，其次决策模型顺带写的；都没有就照实说“说不清会做成什么”并带上命令，不编。
  let what = text('what');
  if (what === '') {
    what = decisionWhat;
  }
  if (what === '') {
    what = `说不清会做成什么（命令：${input.command}）`;
  }
  const whatLine = `要做什么：${textModule.clipText(what, CARD_LINE_MAX)}`;

  //M 第二行“动哪些”：命令里的路径和审核列的路径。
  const pathsLine = `动哪些：${textModule.clipText(getCardPaths(input, paths), CARD_LINE_MAX)}`;

  //M 第三行“为什么问你”：每一档没放行的原因；一条都没有（不该出现）就照实说。
  let askText = asks.join('；');
  if (askText === '') {
    askText = '前几档都没能放行';
  }
  const askLine = `为什么问你：${textModule.clipText(askText, CARD_LINE_MAX)}`;

  //M 风险说明写具体理由：审核小会话的理由原文，没给就写“审核没给出理由”。
  const riskText = getReviewReason(answer);

  //M 可展开的原始数据：调用的工具、命令、目录、会话、参数、审核原话。
  const detailsData = {
    工具: input.kind,
    命令: input.command,
    目录: input.cwd,
    会话: input.session ?? null,
    参数: input.payload,
    审核原话: answer ?? null,
  };

  //M 拼卡片：标题、三行正文、风险、可展开的原始数据；风险高时“同意执行”用危险色。
  return {
    kind: 'approval',
    title: text('title') || '要执行一条命令',
    reason: [whatLine, pathsLine, askLine].join('\n'),
    items,
    risk: { level, text: riskText },
    details: { label: '调用的工具数据', data: detailsData },
    buttons: [
      { action: 'approve', label: '同意执行', style: approveStyle },
      { action: 'reject', label: '拒绝', style: 'default' },
    ],
  };
}
