/**
 * 光斑卡片：鼠标在卡片上或附近时，一团柔光跟着指针走，卡片边缘也跟着亮；按下鼠标时光斑稍微放大变亮。
 * 用键盘把焦点移到卡片里的按钮等元素上时，光斑停在那个元素上。
 * 动效关着（顶栏开关、系统减少动态效果、手机触屏，见 PrefsStore.ts）时不挂监听，只显示静止的卡片。
 * 只给少量卡片用，不要套在长列表的每一行上：每张卡片都会在窗口上挂指针监听。
 *
 * 改编自 React Bits 的 SpotlightCard（TS-CSS 版，https://reactbits.dev/r/SpotlightCard-TS-CSS.json，2026-10-29 取）。
 * 版权和许可见同目录 ReactBits_LICENSE.md（MIT + Commons Clause：可以在 JMAI 里用和改，不能把组件本身拿去出售或再分发）。
 * 改动：只留圆形光斑和按下变亮；去掉 beam 形状、ambient 自动漂移、颗粒噪点和明暗两套配色，颜色改用 --jm-*；按项目规范改写。
 */
import * as react from 'react';
import type { ReactNode } from 'react';
import * as prefsStore from '../PrefsStore.ts';
import './SpotlightCard.css';


/** 光斑颜色：主题强调色。 */
const LIGHT_COLOR = 'var(--jm-accent)';


/** 光斑跟随指针的平滑度（0–1，越大跟得越慢），沿用原组件默认的 0.3。 */
const SMOOTHING = 0.3;


/** 卡片里面光斑的渐变色标（柔和度沿用原组件默认的 0.7），只算一次。 */
const FILL_STOPS = falloff(LIGHT_COLOR, 0.7);


/** 边缘高光的渐变色标（最柔），只算一次。 */
const EDGE_STOPS = falloff(LIGHT_COLOR, 1);


/** SpotlightCard 的参数。 */
interface SpotlightCardProps {
  /** 卡片里的内容。 */
  children: ReactNode;
  /** 额外的类名，用来定宽度等；内边距和圆角的默认值在 SpotlightCard.css。 */
  className?: string;
  /** 光斑半径（px），默认 240。 */
  size?: number;
  /** 光斑亮度（0–1），默认 0.15。 */
  intensity?: number;
  /** 边缘高光的亮度（0–1），默认 0.6。 */
  borderGlow?: number;
  /** 指针离卡片多近就开始亮（px），默认 80；0 表示只在卡片上亮。 */
  proximity?: number;
}


/** 光斑的参数，含义见 SpotlightCardProps。 */
interface SpotlightSettings {
  /** 光斑半径（px）。 */
  size: number;
  /** 光斑亮度（0–1）。 */
  intensity: number;
  /** 边缘高光的亮度（0–1）。 */
  borderGlow: number;
  /** 开始亮的距离（px）。 */
  proximity: number;
}


/** 光斑卡片；动效关着时是一张静止的卡片。 */
export default function SpotlightCard(props: SpotlightCardProps) {
  /** 光斑半径（px），至少 20。 */
  const size = Math.max(20, props.size ?? 240);
  /** 光斑亮度（0–1）。 */
  const intensity = clamp(props.intensity ?? 0.15, 0, 1);
  /** 边缘高光的亮度（0–1）。 */
  const borderGlow = clamp(props.borderGlow ?? 0.6, 0, 1);
  /** 开始亮的距离（px）。 */
  const proximity = Math.max(0, props.proximity ?? 80);
  /** 现在能不能播动效。 */
  const allowed = prefsStore.usePrefsStore(prefsStore.motionAllowed);
  /** 卡片本身。 */
  const rootRef = react.useRef<HTMLDivElement>(null);
  /** 内容下面的光斑层。 */
  const lightRef = react.useRef<HTMLSpanElement>(null);
  /** 边缘高光层。 */
  const edgeRef = react.useRef<HTMLSpanElement>(null);

  react.useEffect(() => {
    const root = rootRef.current;
    const light = lightRef.current;
    const edge = edgeRef.current;
    // g: 还没挂到页面上，或者动效关着时，不挂监听；光斑层默认透明（见 SpotlightCard.css）。
    if (root === null || light === null || edge === null || !allowed) {
      return;
    }
    // m: 挂上指针、焦点和滚动监听；有变化时排一帧，光斑追到位、亮度稳定后就停。
    return startSpotlight(root, light, edge, { size, intensity, borderGlow, proximity });
  }, [allowed, size, intensity, borderGlow, proximity]);

  /** 卡片的类名：固定的 spotlight-card，加上调用方给的。 */
  const className = props.className === undefined ? 'spotlight-card' : `spotlight-card ${props.className}`;
  return (
    <div ref={rootRef} className={className}>
      <span ref={lightRef} className="spotlight-card__light" aria-hidden="true" />
      {props.children}
      <span className="spotlight-card__border" aria-hidden="true" />
      <span ref={edgeRef} className="spotlight-card__edge" aria-hidden="true" />
    </div>
  );
}


/**
 * 让光斑跟着指针和键盘焦点动起来。
 * 输入：卡片、光斑层、边缘层和参数。副作用：在窗口、文档和卡片上挂监听，按需排动画帧，改两层的背景和透明度。
 * 返回停止函数：取消动画帧、摘掉监听并熄灭光斑。
 */
function startSpotlight(
  root: HTMLElement,
  light: HTMLElement,
  edge: HTMLElement,
  settings: SpotlightSettings,
): () => void {
  /** 光斑现在的位置（相对卡片左上角，px）、亮的程度（0–1）、按下变亮的程度（0–1），以及鼠标是否按着。 */
  const state = { x: 0, y: 0, presence: 0, flare: 0, pressed: false };
  /** 指针在窗口里的位置；active 为假表示指针不在窗口里。 */
  const pointer = { x: 0, y: 0, active: false };
  /** 上一次写进样式的两个渐变；没变就不重写。 */
  const drawn = { light: '', edge: '' };
  /** 卡片里获得键盘焦点的元素；有它时光斑停在它上面。 */
  let focus: Element | null = null;
  /** 排着的下一帧；0 表示没排。 */
  let raf = 0;
  /** 上一帧的时间（ms）。 */
  let last = 0;

  /** 把当前状态画到两层上；按下时光斑放大到 1.2 倍、亮度到 1.7 倍。 */
  const paint = (): void => {
    const radius = settings.size * (1 + 0.2 * state.flare);
    const boost = 1 + 0.7 * state.flare;
    const fill = gradient(radius, state.x, state.y, FILL_STOPS);
    const rim = gradient(radius * 0.6, state.x, state.y, EDGE_STOPS);
    if (fill !== drawn.light) {
      drawn.light = fill;
      light.style.background = fill;
    }
    if (rim !== drawn.edge) {
      drawn.edge = rim;
      edge.style.background = rim;
    }
    light.style.opacity = String(Math.min(1, state.presence * settings.intensity * boost));
    edge.style.opacity = String(Math.min(1, state.presence * settings.borderGlow * boost));
  };

  /** 一帧：算出光斑要去的位置和亮度，按指数平滑追过去；还没稳定就再排一帧。 */
  const tick = (now: number): void => {
    raf = 0;
    /** 距上一帧的秒数，限制在 1–50ms，切回标签页时不会一下跳太远。 */
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    const rect = root.getBoundingClientRect();
    /** 光斑要去的位置。 */
    let tx = state.x;
    let ty = state.y;
    /** 要达到的亮度（0–1）。 */
    let target = 0;
    if (focus !== null && root.contains(focus)) {
      const box = focus.getBoundingClientRect();
      tx = box.left + box.width / 2 - rect.left;
      ty = box.top + box.height / 2 - rect.top;
      target = 1;
    } else if (pointer.active) {
      tx = pointer.x - rect.left;
      ty = pointer.y - rect.top;
      /** 指针到卡片边缘的距离；在卡片上为 0。 */
      const gap = Math.hypot(Math.max(0, -tx, tx - rect.width), Math.max(0, -ty, ty - rect.height));
      target = nearness(gap, settings.proximity);
    }
    // 刚亮起来时直接跳到指针处，不从上次熄灭的地方滑过来。
    if (state.presence < 0.02 && target > 0) {
      state.x = tx;
      state.y = ty;
    }
    const follow = 1 - Math.exp(-dt / (0.015 + SMOOTHING * 0.22));
    state.x += (tx - state.x) * follow;
    state.y += (ty - state.y) * follow;
    // 变亮快（0.1 秒）、变暗慢（0.32 秒）。
    const fade = 1 - Math.exp(-dt / (target > state.presence ? 0.1 : 0.32));
    state.presence += (target - state.presence) * fade;
    if (Math.abs(target - state.presence) < 0.002) {
      state.presence = target;
    }
    /** 按下时要达到的变亮程度。 */
    const press = state.pressed ? 1 : 0;
    state.flare += (press - state.flare) * (1 - Math.exp(-dt / (state.pressed ? 0.05 : 0.28)));
    if (Math.abs(press - state.flare) < 0.002) {
      state.flare = press;
    }
    paint();
    /** 光斑是不是还在追指针。 */
    const moving = Math.abs(tx - state.x) > 0.1 || Math.abs(ty - state.y) > 0.1;
    if (moving || state.presence !== target || state.flare !== press) {
      raf = window.requestAnimationFrame(tick);
    }
  };

  /** 没排帧时排一帧。 */
  const wake = (): void => {
    if (raf !== 0) {
      return;
    }
    last = performance.now();
    raf = window.requestAnimationFrame(tick);
  };
  /** 指针在窗口里移动：已经亮着、允许靠近就亮，或者指针就在卡片上时才排帧。 */
  const onMove = (event: PointerEvent): void => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = true;
    if (state.presence > 0 || settings.proximity > 0 || (event.target instanceof Node && root.contains(event.target))) {
      wake();
    }
  };
  /** 指针离开整个窗口（这时 relatedTarget 为 null）：熄灭。 */
  const onOut = (event: PointerEvent): void => {
    if (event.relatedTarget !== null) {
      return;
    }
    pointer.active = false;
    wake();
  };
  /** 在卡片上按下：光斑变亮。 */
  const onDown = (event: PointerEvent): void => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = true;
    state.pressed = true;
    wake();
  };
  /** 松开或取消：变亮退回去；手指、笔抬起后不再算指针在窗口里。 */
  const onUp = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse') {
      pointer.active = false;
    }
    if (!state.pressed && event.pointerType === 'mouse') {
      return;
    }
    state.pressed = false;
    wake();
  };
  /** 键盘把焦点移进卡片里的元素（只认键盘焦点，鼠标点出来的不算）：光斑停到它上面。 */
  const onFocusIn = (event: FocusEvent): void => {
    if (!(event.target instanceof Element) || !event.target.matches(':focus-visible')) {
      return;
    }
    focus = event.target;
    wake();
  };
  /** 焦点移出卡片：回到跟指针。 */
  const onFocusOut = (event: FocusEvent): void => {
    if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) {
      return;
    }
    focus = null;
    wake();
  };
  /** 页面滚动时卡片相对指针的位置变了，亮着或指针在窗口里时重算。 */
  const onScroll = (): void => {
    if (pointer.active || state.presence > 0) {
      wake();
    }
  };

  // r: 指针在整个窗口上都要跟（靠近卡片也会亮）；按下只认卡片本身；焦点只认卡片里面。
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  document.addEventListener('pointerout', onOut);
  root.addEventListener('pointerdown', onDown);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  wake();

  return () => {
    window.cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('scroll', onScroll, { capture: true });
    document.removeEventListener('pointerout', onOut);
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('focusin', onFocusIn);
    root.removeEventListener('focusout', onFocusOut);
    light.style.opacity = '0';
    edge.style.opacity = '0';
  };
}


/** 指针离卡片边缘 gap 像素时的亮度：在卡片上为 1，越远越暗，超过 proximity 为 0。 */
function nearness(gap: number, proximity: number): number {
  if (gap === 0) {
    return 1;
  }
  if (proximity === 0) {
    return 0;
  }
  return Math.max(0, 1 - gap / proximity) ** 2;
}


/** 以 (x, y) 为圆心、radius 为半径（都是 px）的圆形渐变。 */
function gradient(radius: number, x: number, y: number, stops: string): string {
  return `radial-gradient(circle ${radius.toFixed(1)}px at ${x.toFixed(1)}px ${y.toFixed(1)}px, ${stops})`;
}


/**
 * 光斑从中心到边缘的渐变色标：中心最亮，往外按平滑曲线变暗；softness（0–1）越大，亮的核心越小、过渡越长。
 * 返回 radial-gradient 里逗号分隔的 16 个色标。
 */
function falloff(color: string, softness: number): string {
  /** 柔和度（0–1）。 */
  const soft = clamp(softness, 0, 1);
  /** 亮核心占半径的比例。 */
  const core = (1 - soft) ** 1.5 * 0.85;
  /** 色标，第一个是中心的纯色。 */
  const stops = [colorStop(color, 1, 0)];
  for (let i = 0; i <= 14; i += 1) {
    /** 这个色标在半径上的位置（0–1）。 */
    const at = core + ((1 - core) * i) / 14;
    /** 在核心以外的那段里走到了哪（0–1）。 */
    const g = (at - core) / (1 - core);
    const smooth = 1 - g * g * (3 - 2 * g);
    const glow = Math.exp(-4.6 * g * g) * (1 - g ** 6);
    stops.push(colorStop(color, smooth + (glow - smooth) * soft, at));
  }
  return stops.join(', ');
}


/** 一个色标：color 按 alpha（0–1）混上透明，放在半径的 at（0–1）处。 */
function colorStop(color: string, alpha: number, at: number): string {
  return `color-mix(in srgb, ${color} ${(alpha * 100).toFixed(2)}%, transparent) ${(at * 100).toFixed(2)}%`;
}


/** 把 value 限制在 min 和 max 之间。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
