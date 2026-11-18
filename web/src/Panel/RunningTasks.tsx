/**
 * 右栏顶部「正在运行」：列出当前机器人正在跑的前台和后台会话。
 * 每条显示标题、客户/渠道标签、已运行时长（每秒刷新）、最新进度；点击切到那个会话。
 * 没有任务时整块不显示。数据来自 GET /api/ui/running，每 2 秒轮询。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';


/** 任务列表多久重取一次，毫秒。 */
const POLL_MS = 2000;

/** 时长显示多久刷新一次，毫秒。 */
const TICK_MS = 1000;


/**
 * 毫秒写成「12 秒」「1 分 30 秒」。
 * @param ms 已经跑了多久。
 * @param t 翻译函数。
 */
function getElapsed(ms: number, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) {
    return t('{seconds} 秒', { seconds: total });
  }
  return t('{minutes} 分 {seconds} 秒', { minutes: Math.floor(total / 60), seconds: total % 60 });
}


/**
 * 正在运行的任务列表。没有任务时不渲染。
 * @returns 运行中任务区域元素；未选中机器人或无任务时返回 null。
 * 副作用：按固定周期轮询运行中任务接口并每秒刷新计时器，点击任务行切换当前查看会话。
 */
export function RunningTasks(): react.JSX.Element | null {
  //M 订阅翻译、演示打码开关、当前机器人、当前会话及切会话回调。
  const t = i18n.useT();
  const masked = privacy.useMask();
  const bot = context.useUi((state) => state.currentBot);
  const current = context.useUi((state) => state.panelSessionId);
  const openSession = context.useUi((state) => state.openSession);
  const [items, setItems] = react.useState<api.RunningTask[]>([]);
  const [now, setNow] = react.useState(() => Date.now());

  react.useEffect(() => {
    setItems([]);
    if (!bot) {
      return undefined;
    }
    let stopped = false;
    const load = (): void => {
      //M 向后端拉取当前机器人正在运行的前台和后台任务列表。
      void api.runningTasks(bot).then(
        (next) => {
          if (!stopped) {
            setItems(next);
          }
        },
        () => undefined,
      );
    };
    //M 挂载或切换机器人时先立即拉取一次，再交由定时器持续轮询。
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [bot]);

  react.useEffect(() => {
    if (items.length === 0) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [items.length]);

  if (bot === null || bot === undefined || items.length === 0) {
    return null;
  }

  return (
    <div className="jm-running-tasks" role="region" aria-label={t('正在运行')}>
      <div className="jm-running-tasks-head">
        {t('正在运行')}
        <antd.Tag color="green">{items.length}</antd.Tag>
      </div>
      {items.map((item) => {
        //M 整理前后台类型、脱敏客户标签和默认标题，再渲染可点击的任务条目。
        let kind = t('后台');
        if (item.kind === 'front') {
          kind = t('前台');
        }
        let tag = kind;
        if (item.customerLabel !== '') {
          tag = `${kind} · ${privacy.name(t(item.customerLabel), masked)}`;
        }
        let itemClass = 'jm-running-tasks-item';
        if (item.id === current) {
          itemClass = 'jm-running-tasks-item is-current';
        }
        let itemTitle = item.title;
        if (item.title === '') {
          itemTitle = item.id;
        }
        //M 渲染运行中任务条目，按演示开关脱敏标题与最新进度，并换算已运行时长。
        return (
          <button
            key={item.id}
            type="button"
            className={itemClass}
            title={`${privacy.name(item.title, masked)} ${tag} ${privacy.text(item.action, masked)}`}
            onClick={() => openSession(item.id)}
          >
            <div className="jm-running-tasks-row">
              <span className="jm-running-tasks-title" title={item.id}>{privacy.name(itemTitle, masked)}</span>
              <antd.Tag>{tag}</antd.Tag>
              <span className="jm-running-tasks-time">{getElapsed(now - item.startedAt, t)}</span>
            </div>
            {item.action !== '' && <div className="jm-running-tasks-action">{privacy.text(item.action, masked)}</div>}
          </button>
        );
      })}
    </div>
  );
}
