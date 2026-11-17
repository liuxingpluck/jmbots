/**
 * 演示引导：右上角「演示引导」按钮；网址带 ?guide=1 时自动开始。
 * 用 driver.js 高亮目标元素，步骤话术在 steps-*.ts。
 */
import { driver, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import * as react from 'react';
import * as i18n from '../I18n.ts';
import './Guide.css';
import type { GuideStep } from './types.ts';
import { stepLang } from './types.ts';


/** 打开输入框或图谱检索条时一并带上的内容。 */
export interface GuidePrefillDetail {
  text?: string;
  customer?: string;
  mode?: 'hybrid' | 'graph';
}


/**
 * 找得到、并且有尺寸的元素才高亮；逗号选择器取第一个看得见的。
 * @param selector CSS 选择器。
 */
function visible(selector: string): Element | undefined {
  const nodes = document.querySelectorAll(selector);
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.width >= 2 && rect.height >= 2) {
      return node;
    }
  }
  return undefined;
}


/**
 * 演示引导按钮。
 * @param props steps 步骤；language 界面语言（图谱页没有状态仓库时从网址或本机记录来）；className 按钮样式。
 */
export function Guide(props: { steps: GuideStep[]; language?: i18n.Language; className?: string }): react.JSX.Element {
  const language = props.language
    ?? i18n.matchLanguage(new URLSearchParams(window.location.search).get('lang'))
    ?? i18n.loadLanguage(window.localStorage, navigator.language);
  const t = react.useCallback((text: string) => i18n.translate(language, text), [language]);
  const lang = stepLang(language);
  const tour = react.useRef<Driver | null>(null);
  const waiting = react.useRef<(() => void) | null>(null);

  const stopWait = (): void => {
    waiting.current?.();
    waiting.current = null;
  };

  const start = react.useCallback(() => {
    stopWait();
    tour.current?.destroy();
    tour.current = null;
    const steps = props.steps;
    const instance = driver({
      showProgress: true,
      animate: true,
      allowClose: true,
      smoothScroll: true,
      stagePadding: 8,
      stageRadius: 10,
      nextBtnText: t('下一步'),
      prevBtnText: t('上一步'),
      doneBtnText: t('完成'),
      progressText: '{{current}} / {{total}}',
      popoverClass: 'jm-guide-pop',
      onPopoverRender: (popover) => {
        const skip = document.createElement('button');
        skip.type = 'button';
        skip.className = 'jm-guide-skip';
        skip.textContent = t('跳过');
        skip.addEventListener('click', () => instance.destroy());
        popover.footerButtons.prepend(skip);
      },
      steps: steps.map((step) => ({
        element: step.element,
        popover: {
          title: step.title[lang],
          description: step.description[lang],
          side: step.side ?? 'bottom',
          align: step.align ?? 'center',
        },
      })),
      onHighlighted: (_element, _step, { state }) => {
        stopWait();
        const index = typeof state.activeIndex === 'number' ? state.activeIndex : 0;
        const current = steps[index];
        if (!current) {
          return;
        }
        if (current.element && current.optional && !visible(current.element)) {
          window.setTimeout(() => instance.moveNext(), 0);
          return;
        }
        if (current.id === 'panel' && !document.querySelector('.jm-panel')) {
          const toggle = document.querySelector('.jm-chat-panel-toggle');
          if (toggle instanceof HTMLElement) {
            toggle.click();
          }
        }
        if (current.prefill || current.graph) {
          window.dispatchEvent(new CustomEvent<GuidePrefillDetail>('jmbots-guide-prefill', {
            detail: { text: current.prefill, ...current.graph },
          }));
        }
        if (current.waitFor) {
          const eventName = current.waitFor;
          const onDone = (): void => {
            stopWait();
            instance.moveNext();
          };
          window.addEventListener(eventName, onDone);
          waiting.current = () => window.removeEventListener(eventName, onDone);
        }
      },
      onDeselected: () => {
        stopWait();
      },
      onDestroyed: () => {
        stopWait();
        if (tour.current === instance) {
          tour.current = null;
        }
      },
    });
    tour.current = instance;
    instance.drive();
  }, [props.steps, lang, t]);

  react.useEffect(() => {
    if (new URLSearchParams(window.location.search).get('guide') !== '1') {
      return undefined;
    }
    const timer = window.setTimeout(() => start(), 700);
    return () => window.clearTimeout(timer);
  }, [start]);

  react.useEffect(() => () => {
    stopWait();
    tour.current?.destroy();
    tour.current = null;
  }, []);

  return (
    <button type="button" className={props.className ?? 'jm-guide-btn'} onClick={start}>
      {t('演示引导')}
    </button>
  );
}
