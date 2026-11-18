/**
 * 左栏机器人卡片下面：正在做的事和待审核（docs/界面/04_空白处的功能.md 第一、二行）。
 * 每件一行：哪个机器人、现在在做什么、用了多久；点一下切到那个机器人。待审核点一下打开右栏的“待审核”。
 * 数据和飞书进度卡片是同一份（/api/progress）；没有在做的事、也没有待审核时整块不显示。
 */
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';
import type * as types from '../Types.ts';


/** 多久问一次，毫秒。 */
const REFRESH_MS = 3000;


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
 * 订阅并轮询全部机器人正在做的事与待审核列表，供左栏虚拟列表按行消费。
 * @returns 正在做的进度数组与待审核数组。
 */
export function useRunningState(): RunningState {
  /** 所有机器人正在做的任务列表。 */
  const [items, setItems] = react.useState<types.ProgressView[]>([]);

  /** 当前待审核列表，直接读状态仓库。 */
  //M 从全局状态仓库订阅待审核列表，与正在运行的任务一起交给左栏展示。
  const approvals = context.useUi((state) => state.approvals);

  /** 是否已挂载 progress 插件。 */
  //M 读取已挂载插件名单并判断 progress 是否启用，未挂载时跳过轮询避免请求 404。
  const mountedPlugins = context.useUi((state) => state.mountedPlugins);
  const progressEnabled = api.isPluginMounted(mountedPlugins, 'progress', false);

  //M 插件开启后每 3 秒拉一次未结束的全局进度，未挂载则保持空列表避免 404。
  react.useEffect(() => {
    if (!progressEnabled) {
      setItems([]);
      return undefined;
    }

    /** 卸载守卫标记，防止异步回包更新已销毁组件。 */
    let stopped = false;

    /** 拉取一次所有机器人的运行进度。 */
    const load = (): void => {
      //M 拉取全部机器人进度并只保留未结束的运行项（组件卸载后忽略回包）。
      void api.progress('').then(
        (next) => {
          if (!stopped) {
            setItems(next.filter((item) => item.endedAt === undefined));
          }
        },
        () => undefined,
      );
    };

    //M 挂载或插件开启时立即拉取一次运行进度，随后启动 3 秒定时轮询。
    load();

    /** 轮询定时器句柄。 */
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [progressEnabled]);

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


/**
 * 正在做的事整块列表（兼容保留）。
 * @returns 运行列表区块；全空时返回 null。
 */
export function RunningList(): react.JSX.Element | null {
  //M 订阅翻译函数并读取全部运行项与待审核列表，以决定是否渲染左栏运行区块。
  const t = i18n.useT();
  const state = useRunningState();

  //G 既没有正在做的事也没有待审核时不占位。
  if (state.items.length === 0 && state.approvals.length === 0) return null;

  return (
    <div className="jm-running">
      <div className="jm-running-head">{t('正在做的事')}</div>
      {state.items.map((item) => (
        <RunningItemButton key={item.id} item={item} />
      ))}
      {state.approvals.length > 0 && <RunningApprovalsButton count={state.approvals.length} />}
    </div>
  );
}
