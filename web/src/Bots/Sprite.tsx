/**
 * 头像和状态动效（docs/界面/01_界面设计.md 第 13 节）：全部走这一个模块，将来用户自定义动效（跳跳蹦蹦、一起敲键盘……）也接在这里。
 * 输入机器人和状态，输出头像和这一帧的颜文字。这期只有一个小动效：正在干活时颜文字两帧轮着切，像在敲键盘。
 * 动效用 CSS 动画做（App.css 的 jm-frame），React 不每帧重画；空闲时不动；系统设了“减少动态效果”时不动。
 */
import type * as react from 'react';
import * as statusModule from './Status.ts';
import * as theme from '../Theme.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';


/**
 * 头像：名字第一个字加色块，颜色从名字算出来、取自主题的头像色板。
 * @param props name 机器人名；size 边长（像素）。
 */
export function Avatar(props: { name: string; size?: number }): react.JSX.Element {
  /** 主题。 */
  const spec = theme.THEMES[context.useUi((state) => state.themeName)];
  /** 边长。 */
  const size = props.size ?? 40;
  /** 第一个字（按字符算，emoji 和汉字都对）。 */
  const first = [...props.name.trim()][0] ?? '?';
  return (
    <span className="jm-avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.46), background: theme.avatarColor(props.name, spec.avatars) }}>
      {first}
    </span>
  );
}


/**
 * 状态框：圆角小框，颜文字 + 文字。多帧的颜文字叠在一起，用 CSS 动画轮着显示，宽度按最宽那帧，不会抖。
 * @param props status 显示的状态；detail 跟在状态后面的短说明；title 鼠标放上去看的完整说明。
 */
export function StatusPill(props: { status: statusModule.ShownStatus; detail?: string; title?: string }): react.JSX.Element {
  const t = i18n.useT();
  /** 这种状态的样子。 */
  const look = statusModule.STATUS_LOOKS[props.status];
  return (
    <span className={`jm-status jm-tone-${look.tone}`} data-status={props.status} title={props.title}>
      <span className={`jm-frames jm-frames-${look.frames.length}`} aria-hidden="true">
        {look.frames.map((frame, index) => (
          <span key={frame} className={`jm-frame jm-frame-${index + 1}`}>
            {frame}
          </span>
        ))}
      </span>
      <span className="jm-status-label">
        {t(look.label)}
        {props.detail && <span className="jm-status-detail"> · {props.detail}</span>}
      </span>
    </span>
  );
}
