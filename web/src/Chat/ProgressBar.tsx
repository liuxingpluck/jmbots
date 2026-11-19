/**
 * 聊天区下面的进度条（docs/界面/03_进度事件和复盘设计.md 第 1～2 节）：这个机器人正在做的事，一件一行：
 * 现在在做什么、用了多久；不选就最长 20 分钟（第 10 分钟开始报时、到点先判断要不要延长），能选最多 15 / 20 分钟（从开始干活算）、不限时，能终止。
 * 和飞书的进度卡片用的是同一份数据（/api/progress），由 Poll.ts 每轮取一次放进仓库，这里按机器人筛。
 * 刚结束的留一分钟，显示结果和各段耗时。超过 30 件只画看得见的（Shared/LongList.tsx）。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';
import * as longList from '../Shared/LongList.tsx';
import type * as types from '../Types.ts';


/** 结束后还显示多久，毫秒。 */
const SHOW_ENDED_MS = 60_000;

/** 能选的限时，分钟（和后端的 LIMIT_CHOICES 一样）：从开始干活算，已经超过了点就马上收尾。 */
const LIMIT_CHOICES = [15, 20];

/** 件数多到虚拟化时，进度条占多高，像素；不把输入框挤出屏幕。 */
const LIST_HEIGHT = 200;

/** 两件之间的间距，像素；和 .jm-progress 的 gap 一样。 */
const ITEM_GAP = 4;


/**
 * 毫秒写成秒。
 * @param ms 毫秒。
 */
function getSeconds(ms: number): string {
  //G 不到一分钟（保留一位小数后也不到 60.0）：写到 0.1 秒。
  if (ms < 59_950) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  /** 整秒：先取整再拆成分和秒，免得 59.6 秒进成“30m60s”这样。 */
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${total % 60}s`;
}


/**
 * 聊天区下方的任务进度条组件，展示当前机器人运行中或刚结束的任务进度并支持限时、终止操作。
 * @param props 组件属性，bot 为当前选中的机器人名称。
 * @returns 有进度条目时返回进度条 JSX 元素，无条目时返回 null。
 * 副作用：用户点击限时或终止按钮时请求后台控制接口并更新提示。进度本身从仓库读，每轮轮询都会重画一次（耗时跟着走）。
 */
export function ProgressBar(props: { bot: string }): react.JSX.Element | null {
  //M 取翻译函数与隐私打码开关，用于按钮文案本地化以及脱敏展示会话标题、进度结果和提示。
  const t = i18n.useT();
  const masked = privacy.useMask();
  /** 全部机器人的进度，Poll.ts 写进仓库。 */
  const progress = context.useUi((state) => state.progress);
  /** 点按钮后的提示。 */
  const [notice, setNotice] = react.useState('');

  //M 只留这个机器人的：还在转的，和结束不到一分钟的。
  const items = progress.filter((item) => {
    if (item.bot !== props.bot) return false;
    if (item.endedAt === undefined) return true;

    return Date.now() - item.endedAt < SHOW_ENDED_MS;
  });

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
    //M 将用户的限时或终止指令发往后端进度控制接口，并把结果或报错展示在底部提示区。
    void api.progressAct(id, action, minutes).then(
      (result) => setNotice(result.text),
      (error: unknown) => {
        let message = String(error);
        if (error instanceof Error) {
          message = error.message;
        }
        setNotice(message);
      },
    );
  };
  /**
   * 画一件：动作、耗时、限时和会话标题，进行中的带按钮，结束的带结果。
   * @param item 进度卡片；由下面的 LongList 逐条传进来。
   */
  const renderItem = (item: types.ProgressView): react.ReactNode => {
    const ended = item.endedAt !== undefined;
    let rowClass = 'jm-progress-item';
    if (ended) {
      rowClass = 'jm-progress-item jm-progress-ended';
    }
    let limitText = '';
    if (item.limitMinutes) {
      limitText = ` · ${t('限时 {minutes} 分钟', { minutes: item.limitMinutes })}`;
    }
    let titleText = '';
    if (item.sessionTitle) {
      titleText = ` · ${privacy.name(item.sessionTitle, masked)}`;
    }
    let actionOrResult: react.ReactNode = null;
    if (!ended) {
      //M 进行中的任务渲染限时与终止按钮组，点击后提交对应控制动作。
      actionOrResult = (
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
      );
    }
    if (ended && item.result) {
      //M 已结束且带返回结果的任务，按当前隐私模式脱敏后展示结果摘要。
      actionOrResult = <span className="jm-progress-result">{privacy.text(item.result, masked)}</span>;
    }
    //M 渲染单条任务进度行，对动作文案脱敏并按起止时间计算已耗时长。
    return (
      <div className={rowClass}>
        <span className="jm-progress-action">{privacy.text(item.action, masked)}</span>
        <span className="jm-muted">
          {getSeconds((item.endedAt ?? Date.now()) - item.startedAt)}
          {limitText}
          {titleText}
        </span>
        {actionOrResult}
      </div>
    );
  };

  //M 不到 30 件逐条画；多了在固定高度里只画看得见的。
  return (
    <div className="jm-progress">
      <longList.LongList
        items={items}
        getKey={(item) => item.id}
        render={renderItem}
        gap={ITEM_GAP}
        height={LIST_HEIGHT}
      />
      {
        //M 存在操作反馈或错误提示时，按隐私模式脱敏后显示在进度条底部。
        notice && <div className="jm-muted">{privacy.text(notice, masked)}</div>
      }
    </div>
  );
}
