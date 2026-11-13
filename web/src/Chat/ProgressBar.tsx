/**
 * 聊天区下面的进度条（docs/界面/03_进度事件和复盘设计.md 第 1～2 节）：这个机器人正在做的事，一件一行：
 * 现在在做什么、用了多久；不选就最长 20 分钟（第 10 分钟开始报时、到点先判断要不要延长），能选最多 15 / 20 分钟（从开始干活算）、不限时，能终止。
 * 和飞书的进度卡片用的是同一份数据（/api/progress）。
 * 刚结束的留一分钟，显示结果和各段耗时。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as i18n from '../I18n.ts';
import type * as types from '../Types.ts';


/** 多久问一次，毫秒。 */
const REFRESH_MS = 2000;

/** 结束后还显示多久，毫秒。 */
const SHOW_ENDED_MS = 60_000;

/** 能选的限时，分钟（和后端的 LIMIT_CHOICES 一样）：从开始干活算，已经超过了点就马上收尾。 */
const LIMIT_CHOICES = [15, 20];


/**
 * 毫秒写成秒。
 * @param ms 毫秒。
 */
function seconds(ms: number): string {
  //G 不到一分钟（保留一位小数后也不到 60.0）：写到 0.1 秒。
  if (ms < 59_950) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  /** 整秒：先取整再拆成分和秒，免得 59.6 秒进成“30m60s”这样。 */
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${total % 60}s`;
}


/**
 * 进度条。
 * @param props bot 是现在看的机器人。
 */
export function ProgressBar(props: { bot: string }): react.JSX.Element | null {
  const t = i18n.useT();
  /** 这个机器人的进度。 */
  const [items, setItems] = react.useState<types.ProgressView[]>([]);
  /** 点按钮后的提示。 */
  const [notice, setNotice] = react.useState('');

  react.useEffect(() => {
    /** 停了没有。 */
    let stopped = false;
    /** 问一次。 */
    const load = (): void => {
      void api.progress(props.bot).then(
        (next) => {
          if (!stopped) {
            setItems(next.filter((item) => item.endedAt === undefined || Date.now() - item.endedAt < SHOW_ENDED_MS));
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
  }, [props.bot]);

  if (items.length === 0) {
    return null;
  }
  /**
   * 点了按钮。
   * @param id 卡片号。
   * @param action 终止或限时。
   * @param minutes 限时几分钟；0 是不限时。
   */
  const act = (id: number, action: 'stop' | 'limit', minutes = 0): void => {
    void api.progressAct(id, action, minutes).then((result) => setNotice(result.text), (error: unknown) => setNotice(error instanceof Error ? error.message : String(error)));
  };
  return (
    <div className="jm-progress">
      {items.map((item) => (
        <div key={item.id} className={item.endedAt === undefined ? 'jm-progress-item' : 'jm-progress-item jm-progress-ended'}>
          <span className="jm-progress-action">{item.action}</span>
          <span className="jm-muted">
            {seconds((item.endedAt ?? Date.now()) - item.startedAt)}
            {item.limitMinutes ? ` · ${t('限时 {minutes} 分钟', { minutes: item.limitMinutes })}` : ''}
            {item.sessionTitle ? ` · ${item.sessionTitle}` : ''}
          </span>
          {item.endedAt === undefined ? (
            <span className="jm-progress-buttons">
              {LIMIT_CHOICES.map((minutes) => (
                <antd.Button key={minutes} size="small" onClick={() => act(item.id, 'limit', minutes)}>
                  {t('最多 {minutes} 分钟', { minutes })}
                </antd.Button>
              ))}
              <antd.Button size="small" onClick={() => act(item.id, 'limit', 0)}>
                {t('不限时')}
              </antd.Button>
              <antd.Button size="small" danger onClick={() => act(item.id, 'stop')}>
                {t('终止')}
              </antd.Button>
            </span>
          ) : (
            item.result && <span className="jm-progress-result">{item.result}</span>
          )}
        </div>
      ))}
      {notice && <div className="jm-muted">{notice}</div>}
    </div>
  );
}
