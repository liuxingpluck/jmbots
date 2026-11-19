/**
 * 左栏机器人卡片下面：正在做的事和待审核（docs/界面/04_空白处的功能.md 第一、二行）。
 * 每件一行：哪个机器人、现在在做什么、用了多久；点一下切到那个机器人。待审核点一下打开右栏的“待审核”。
 * 数据和飞书进度卡片是同一份（/api/progress），由 Poll.ts 每轮取一次放进仓库；行合进 BotList 的虚拟列表。
 */
import * as react from 'react';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';
import type * as types from '../Types.ts';


/** 左栏正在做的事与待审核状态。 */
export interface RunningState {
  /** 当前所有机器人正在进行的任务进度项。 */
  items: types.ProgressView[];
  /** 当前等待用户确认的审核项。 */
  approvals: types.ApprovalView[];
}


/**
 * 毫秒写成“12s”“3m5s”。
 * @param ms 已运行毫秒数。
 * @returns 人类可读的耗时文本。
 */
function getElapsedText(ms: number): string {
  /** 整秒：先取整再拆成分和秒，免得 59.6 秒进成“30m60s”这样。 */
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;

  return `${Math.floor(total / 60)}m${total % 60}s`;
}


/**
 * 从仓库读全部机器人正在做的事与待审核列表，供左栏虚拟列表按行消费。
 * @returns 正在做的进度数组与待审核数组。
 */
export function useRunningState(): RunningState {
  //M 进度卡片和待审核都由 Poll.ts 轮询写进仓库，这里只订阅。
  const progress = context.useUi((state) => state.progress);
  const approvals = context.useUi((state) => state.approvals);

  //M 只留还没结束的；仓库换了新数组才重新筛。
  const items = react.useMemo(() => progress.filter((item) => item.endedAt === undefined), [progress]);
  return { items, approvals };
}


/**
 * 单条正在做的事按钮，点击切到对应机器人。
 * @param props item 进度条目。
 * @returns 进度行按钮元素。
 */
export function RunningItemButton(props: { item: types.ProgressView }): react.JSX.Element {
  //M 订阅演示打码开关与切机器人动作，供脱敏渲染任务文字及点击跳转到对应机器人。
  const masked = privacy.useMask();
  const selectBot = context.useUi((state) => state.selectBot);

  /** 展示中的动作文字（演示打码开启时脱敏）。 */
  //M 开启演示打码时隐去正在执行的动作描述，防止旁路泄露敏感任务细节。
  const actionText = privacy.text(props.item.action, masked);

  /** 悬停查看的任务完整描述。 */
  //M 开启演示打码时隐去按钮悬停提示里的任务触发原文。
  const titleText = privacy.text(props.item.text, masked);

  /** 已耗时文本。 */
  //M 根据任务开始时间戳计算已耗时并格式化为紧凑文本展示在条目右侧。
  const elapsedLabel = getElapsedText(Date.now() - props.item.startedAt);

  return (
    <button
      type="button"
      className="jm-running-item"
      title={titleText}
      onClick={() => selectBot(props.item.bot)}
    >
      <span className="jm-running-bot">{props.item.bot}</span>
      <span className="jm-running-action">{actionText}</span>
      <span className="jm-muted">{elapsedLabel}</span>
    </button>
  );
}


/**
 * 待审核汇总按钮，点击打开右栏待审核页签。
 * @param props count 待审核条数。
 * @returns 待审核跳转按钮元素。
 */
export function RunningApprovalsButton(props: { count: number }): react.JSX.Element {
  //M 订阅翻译函数以拼接待审核条数文案，并取得右栏动作供点击跳到“待审核”页签。
  const t = i18n.useT();
  const openPanel = context.useUi((state) => state.openPanel);

  return (
    <button
      type="button"
      className="jm-running-item jm-running-approvals"
      onClick={() => openPanel('approvals')}
    >
      {t('待审核 {count} 条', { count: props.count })}
    </button>
  );
}
