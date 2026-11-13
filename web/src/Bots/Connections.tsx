/**
 * 左下角版本号旁边的三个小圆点：后端、基地、飞书，绿是通、灰是断，鼠标放上去写原因（docs/界面/04_空白处的功能.md）。
 * 外出回来一眼看出是谁断了。每 30 秒问一次；后端连不上时三个都灰。
 */
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';


/** 多久问一次，毫秒。 */
const REFRESH_MS = 30_000;


/** 一个点。 */
interface Dot {
  /** 叫什么。 */
  label: string;
  /** 通不通；不知道是 undefined（不画）。 */
  ok: boolean | undefined;
  /** 鼠标放上去的说明。 */
  detail: string;
}


/** 三个小圆点。 */
export function Connections(): react.JSX.Element {
  const t = i18n.useT();
  /** 后端连得上吗（主循环在问）。 */
  const online = context.useUi((state) => state.online) !== false;
  /** 基地、飞书。 */
  const [base, setBase] = react.useState<boolean | undefined>(undefined);
  const [feishu, setFeishu] = react.useState<{ ok: boolean | undefined; detail: string }>({ ok: undefined, detail: '' });

  react.useEffect(() => {
    /** 停了没有。 */
    let stopped = false;
    /** 问一次。 */
    const load = (): void => {
      void api.updateInfo().then((info) => !stopped && setBase(info.managed === true), () => !stopped && setBase(false));
      void api.uiStatus().then(
        (status) => {
          /** 飞书的几个应用。 */
          const apps = status.channels.filter((item) => item.name.startsWith('feishu'));
          if (!stopped) {
            setFeishu(apps.length === 0 ? { ok: undefined, detail: '' } : { ok: apps.every((item) => item.connected), detail: apps.map((item) => `${item.bot ?? item.name}：${item.detail}`).join('\n') });
          }
        },
        () => !stopped && setFeishu({ ok: false, detail: '' }),
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

  /** 三个点。 */
  const dots: Dot[] = [
    { label: t('后端'), ok: online, detail: online ? t('后端：通') : t('后端：连不上') },
    { label: t('基地'), ok: online ? base : false, detail: base ? t('基地：通，在守护后端') : t('基地：没开，或者是老版本') },
    { label: t('飞书'), ok: online ? feishu.ok : false, detail: feishu.detail || t('飞书：没配，或者连不上') },
  ];
  return (
    <span className="jm-dots">
      {dots
        .filter((dot) => dot.ok !== undefined)
        .map((dot) => (
          <span key={dot.label} className={dot.ok ? 'jm-dot jm-dot-ok' : 'jm-dot'} title={dot.detail} aria-label={dot.detail} />
        ))}
    </span>
  );
}
