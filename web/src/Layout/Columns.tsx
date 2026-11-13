/**
 * 三栏（docs/界面/01_界面设计.md 第 5 节）：铺满窗口，高度不能调，每栏自己滚动。
 * 宽度能用鼠标拖分隔线调，分隔线有焦点时也能用 ←/→ 调；调好的宽度记在浏览器本地。右栏收起时中栏占满。
 * 窗口窄于 900 像素时一次只显示一栏，上面有切换。宽度怎么算在 Widths.ts。
 */
import * as react from 'react';
import * as i18n from '../I18n.ts';
import * as widthsModule from './Widths.ts';


/** 三栏的内容。 */
interface ColumnsProps {
  /** 左栏。 */
  left: react.ReactNode;
  /** 中栏。 */
  center: react.ReactNode;
  /** 右栏；收起时是 null。 */
  right: react.ReactNode | null;
}


/** 窄窗口时显示哪一栏。 */
type NarrowTab = 'left' | 'center' | 'right';


/**
 * 一条分隔线。
 * @param props which 是哪条、label 给读屏的说明、onDrag 拖动开始、onKey 键盘。
 */
function Splitter(props: { which: 'left' | 'right'; label: string; onPointerDown: (event: react.PointerEvent<HTMLDivElement>) => void; onKeyDown: (event: react.KeyboardEvent<HTMLDivElement>) => void }): react.JSX.Element {
  return <div className="jm-splitter" role="separator" aria-orientation="vertical" aria-label={props.label} tabIndex={0} data-which={props.which} onPointerDown={props.onPointerDown} onKeyDown={props.onKeyDown} />;
}


/**
 * 三栏布局。
 * @param props 三栏的内容。
 */
export function Columns(props: ColumnsProps): react.JSX.Element {
  const t = i18n.useT();
  /** 窗口宽度。 */
  const [total, setTotal] = react.useState(() => window.innerWidth);
  /** 想要的宽度（用户调的）。 */
  const [widths, setWidths] = react.useState(() => widthsModule.loadWidths(window.localStorage));
  /** 窄窗口时显示哪一栏。 */
  const [narrowTab, setNarrowTab] = react.useState<NarrowTab>('center');
  /** 右栏展开没有。 */
  const rightOpen = props.right !== null;
  /** 实际用的宽度。 */
  const shown = widthsModule.clampWidths(total, widths, rightOpen);

  react.useEffect(() => {
    /** 窗口变了，重算。 */
    const onResize = (): void => setTotal(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  //M 右栏刚展开时，窄窗口直接切过去看。
  react.useEffect(() => {
    setNarrowTab(rightOpen ? 'right' : 'center');
  }, [rightOpen]);

  /**
   * 开始拖一条分隔线：抓住鼠标，挪动时改宽度，松开时记下来。
   * @param which 哪条。
   */
  const startDrag = (which: 'left' | 'right') => (event: react.PointerEvent<HTMLDivElement>): void => {
    /** 开始时的位置和宽度。 */
    const startX = event.clientX;
    const start = shown;
    /** 最后一次的宽度。 */
    let last = shown;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('jm-dragging');
    /** 挪动。 */
    const onMove = (move: PointerEvent): void => {
      last = widthsModule.dragWidths(start, which, move.clientX - startX, window.innerWidth, rightOpen);
      setWidths(last);
    };
    /** 松开。 */
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('jm-dragging');
      widthsModule.saveWidths(window.localStorage, last);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /**
   * 分隔线有焦点时用 ←/→ 调宽度。
   * @param which 哪条。
   */
  const onKey = (which: 'left' | 'right') => (event: react.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    /** 调完的宽度。 */
    const next = widthsModule.dragWidths(shown, which, event.key === 'ArrowRight' ? widthsModule.KEY_STEP : -widthsModule.KEY_STEP, total, rightOpen);
    setWidths(next);
    widthsModule.saveWidths(window.localStorage, next);
  };

  if (widthsModule.isNarrow(total, rightOpen)) {
    /** 能切的几栏。 */
    const tabs: { key: NarrowTab; label: string }[] = [
      { key: 'left', label: t('机器人') },
      { key: 'center', label: t('聊天') },
      ...(rightOpen ? [{ key: 'right' as const, label: t('内容') }] : []),
    ];
    /** 现在显示的那栏（右栏收起时不会停在右栏）。 */
    const current = narrowTab === 'right' && !rightOpen ? 'center' : narrowTab;
    return (
      <div className="jm-narrow">
        <nav className="jm-narrow-tabs">
          {tabs.map((tab) => (
            <button key={tab.key} type="button" className={tab.key === current ? 'jm-narrow-tab jm-active' : 'jm-narrow-tab'} onClick={() => setNarrowTab(tab.key)}>
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="jm-narrow-body">
          {current === 'left' && <aside className="jm-column jm-left">{props.left}</aside>}
          {current === 'center' && <main className="jm-column jm-center">{props.center}</main>}
          {current === 'right' && <aside className="jm-column jm-right">{props.right}</aside>}
        </div>
      </div>
    );
  }

  return (
    <div className="jm-columns">
      <aside className="jm-column jm-left" style={{ width: shown.left }}>
        {props.left}
      </aside>
      <Splitter which="left" label={t('调左栏宽度')} onPointerDown={startDrag('left')} onKeyDown={onKey('left')} />
      <main className="jm-column jm-center">{props.center}</main>
      {rightOpen && (
        <>
          <Splitter which="right" label={t('调右栏宽度')} onPointerDown={startDrag('right')} onKeyDown={onKey('right')} />
          <aside className="jm-column jm-right" style={{ width: shown.right }}>
            {props.right}
          </aside>
        </>
      )}
    </div>
  );
}
