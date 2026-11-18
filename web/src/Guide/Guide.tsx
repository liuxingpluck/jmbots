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
import { getStepLang } from './types.ts';


/** 打开输入框或图谱检索条时一并带上的内容。 */
export interface GuidePrefillDetail {
  /** 预填进聊天输入框或检索框的问题文本；省略时不修改输入内容。 */
  text?: string;
  /** 图谱/记忆页预选的演示客户标识；省略时保持当前选择。 */
  customer?: string;
  /** 预选的检索模式（混合检索或图谱+重排）；省略时保持当前模式。 */
  mode?: 'hybrid' | 'graph';
}


/**
 * 找得到、并且有尺寸的元素才高亮；逗号选择器取第一个看得见的。
 * @param selector CSS 选择器。
 */
function getVisibleElement(selector: string): Element | undefined {
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
 * 演示引导按钮；点击或网址带 ?guide=1 时启动 driver.js 分步高亮，并按步骤触发预填和监听前进事件。
 * @param props steps 步骤；language 界面语言（图谱页没有状态仓库时从网址或本机记录来）；className 按钮样式。
 * @returns 演示引导触发按钮元素。
 * 副作用：驱动 driver.js 操作页面高亮层、向 window 派发 jmbots-guide-prefill 并监听 waitFor 事件。
 */
export function Guide(props: { steps: GuideStep[]; language?: i18n.Language; className?: string }): react.JSX.Element {
  //M 按组件入参、网址 ?lang=、本机存储的顺序确定界面语言，供引导按钮和弹窗翻译使用。
  const language = props.language
    ?? i18n.matchLanguage(new URLSearchParams(window.location.search).get('lang'))
    ?? i18n.loadLanguage(window.localStorage);
  //M 绑定当前界面语言的翻译函数，用于渲染引导按钮及弹窗上的操作文案。
  const t = react.useCallback((text: string) => i18n.translate(language, text), [language]);
  //M 将界面语言映射到引导步骤话术支持的 zh-CN 或 en 键。
  const lang = getStepLang(language);
  const tour = react.useRef<Driver | null>(null);
  const waiting = react.useRef<(() => void) | null>(null);

  /** 解除上一步挂载的等待事件监听，防止跳过或关闭后旧事件仍推动下一步。 */
  const stopWait = (): void => {
    waiting.current?.();
    waiting.current = null;
  };

  const start = react.useCallback(() => {
    //M 重新开启引导前先清理上轮等待事件监听并销毁旧实例，防止多个浮层同时存在。
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
        //M 高亮新步骤前先撤掉上一步的等待监听，避免旧完成事件触发连续自动翻页。
        stopWait();
        let index = 0;
        if (typeof state.activeIndex === 'number') {
          index = state.activeIndex;
        }
        const current = steps[index];
        if (!current) {
          return;
        }

        //G 可选步骤若目标元素当前未显示或尺寸过小，自动跳到下一步不阻塞引导流程。
        if (current.element && current.optional && !getVisibleElement(current.element)) {
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
            //M 收到完成事件后先解除监听再自动前进，避免事件重复派发导致连续跳步。
            stopWait();
            instance.moveNext();
          };
          window.addEventListener(eventName, onDone);
          waiting.current = () => window.removeEventListener(eventName, onDone);
        }
      },
      onDeselected: () => {
        //M 离开当前高亮步骤时清理等待事件监听，防止用户手动切步后旧事件继续生效。
        stopWait();
      },
      onDestroyed: () => {
        //M 引导结束或被跳过销毁时清除等待监听并清空当前实例引用，以便下次点击重新初始化。
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
    //M 组件卸载时解除等待监听并销毁引导浮层，防止残留事件监听或 DOM 遮罩。
    stopWait();
    tour.current?.destroy();
    tour.current = null;
  }, []);

  //M 渲染右上角演示引导按钮，点击后从第一步启动分步高亮指引。
  return (
    <button type="button" className={props.className ?? 'jm-guide-btn'} onClick={start}>
      {t('演示引导')}
    </button>
  );
}
