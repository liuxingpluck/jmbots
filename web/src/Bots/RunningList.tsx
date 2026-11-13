/**
 * 左栏机器人卡片下面：正在做的事和待审核（docs/界面/04_空白处的功能.md 第一、二行）。
 * 每件一行：哪个机器人、现在在做什么、用了多久；点一下切到那个机器人。待审核点一下打开右栏的“待审核”。
 * 数据和飞书进度卡片是同一份（/api/progress）；没有在做的事、也没有待审核时整块不显示。
 */
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import type * as types from '../Types.ts';


/** 多久问一次，毫秒。 */
const REFRESH_MS = 3000;


/**
 * 毫秒写成“12s”“3m5s”。
 * @param ms 毫秒。
 */
function elapsed(ms: number): string {
  /** 整秒：先取整再拆成分和秒，免得 59.6 秒进成“30m60s”这样。 */
  const total = Math.round(ms / 1000);
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m${total % 60}s`;
}


/** 正在做的事。 */
export function RunningList(): react.JSX.Element | null {
  const t = i18n.useT();
  /** 所有机器人正在做的。 */
  const [items, setItems] = react.useState<types.ProgressView[]>([]);
  /** 待审核。 */
  const approvals = context.useUi((state) => state.approvals);
  const selectBot = context.useUi((state) => state.selectBot);
  const openPanel = context.useUi((state) => state.openPanel);

  react.useEffect(() => {
    /** 停了没有。 */
    let stopped = false;
    /** 问一次。 */
    const load = (): void => {
      void api.progress('').then(
        (next) => {
          if (!stopped) {
            setItems(next.filter((item) => item.endedAt === undefined));
          }
        },
        () => undefined,
      );
    };
    load();
    /** 定时器。 */
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  if (items.length === 0 && approvals.length === 0) {
    return null;
  }
  return (
    <div className="jm-running">
      <div className="jm-running-head">{t('正在做的事')}</div>
      {items.map((item) => (
        <button key={item.id} type="button" className="jm-running-item" title={item.text} onClick={() => selectBot(item.bot)}>
          <span className="jm-running-bot">{item.bot}</span>
          <span className="jm-running-action">{item.action}</span>
          <span className="jm-muted">{elapsed(Date.now() - item.startedAt)}</span>
        </button>
      ))}
      {approvals.length > 0 && (
        <button type="button" className="jm-running-item jm-running-approvals" onClick={() => openPanel('approvals')}>
          {t('待审核 {count} 条', { count: approvals.length })}
        </button>
      )}
    </div>
  );
}
