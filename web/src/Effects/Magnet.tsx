/**
 * 磁吸：鼠标靠近时，里面的内容轻轻朝指针挪一点，离开后用弹簧回到原位。
 * 只跟鼠标和触控板，不跟手指。动效关着（见 PrefsStore.ts）时不挂监听，内容不动。
 * 一页最多放一两个：每个都会在窗口上挂指针监听，鼠标一动就量一次位置。
 *
 * 改编自 React Bits 的 Magnet（TS-CSS 版，https://reactbits.dev/r/Magnet-TS-CSS.json，2026-10-29 取）。
 * 版权和许可见同目录 ReactBits_LICENSE.md（MIT + Commons Clause）。
 * 改动：只留平移和弹簧回位；去掉多个磁吸之间的抢占、单轴、倾斜、缩放和激活回调；按项目规范改写。
 */
import * as react from 'react';
import type { CSSProperties, ReactNode } from 'react';
import * as prefsStore from '../PrefsStore.ts';


/** 弹簧的刚度、阻尼和质量，沿用原组件的默认值。 */
const SPRING = { stiffness: 170, damping: 16, mass: 1 };


/** 外层：占住内容原来的位置，内容挪动时不影响周围排版。 */
const WRAPPER_STYLE: CSSProperties = { position: 'relative', display: 'inline-block' };


/** 里层：真正挪动的那一层。 */
const INNER_STYLE: CSSProperties = { willChange: 'transform' };


/** Magnet 的参数。 */
interface MagnetProps {
  /** 被吸的内容。 */
  children: ReactNode;
  /** 指针离内容边缘多近开始吸（px），默认 40。 */
  padding?: number;
  /** 吸力：位移 = 指针偏离中心的距离 ÷ 它，越大挪得越少；默认 2。 */
  strength?: number;
  /** 最多挪多远（px），默认 6。 */
  maxOffset?: number;
}


/** 磁吸的参数，含义见 MagnetProps。 */
interface MagnetSettings {
  /** 开始吸的距离（px）。 */
  padding: number;
  /** 吸力。 */
  strength: number;
  /** 最多挪多远（px）。 */
  maxOffset: number;
}


/** 二维的位置、位移或速度。 */
interface Point {
  /** 横向。 */
  x: number;
  /** 纵向。 */
  y: number;
}


/** 磁吸外壳；动效关着时就是一个普通的行内块。 */
export default function Magnet(props: MagnetProps) {
  /** 开始吸的距离（px）。 */
  const padding = Math.max(0, props.padding ?? 40);
  /** 吸力，至少 0.1，免得除出很大的位移。 */
  const strength = Math.max(0.1, props.strength ?? 2);
  /** 最多挪多远（px）。 */
  const maxOffset = Math.max(0, props.maxOffset ?? 6);
  /** 现在能不能播动效。 */
  const allowed = prefsStore.usePrefsStore(prefsStore.motionAllowed);
  /** 外层，用来量位置。 */
  const wrapperRef = react.useRef<HTMLDivElement>(null);
  /** 里层，用来挪动。 */
  const innerRef = react.useRef<HTMLDivElement>(null);

  react.useEffect(() => {
    const wrapper = wrapperRef.current;
    const inner = innerRef.current;
    // g: 还没挂到页面上，或者动效关着时，不挂监听。
    if (wrapper === null || inner === null || !allowed) {
      return;
    }
    // m: 挂上指针和滚动监听；指针一动就排一帧，弹簧停稳后不再排。
    return startMagnet(wrapper, inner, { padding, strength, maxOffset });
  }, [allowed, padding, strength, maxOffset]);

  return (
    <div ref={wrapperRef} className="magnet" style={WRAPPER_STYLE}>
      <div ref={innerRef} className="magnet__inner" style={INNER_STYLE}>
        {props.children}
      </div>
    </div>
  );
}


/**
 * 让内容跟着指针轻轻挪动。
 * 输入：外层、里层和参数。副作用：在窗口和页面根元素上挂监听，按需排动画帧，改里层的 transform。
 * 返回停止函数：取消动画帧、摘掉监听，内容回到原位。
 */
function startMagnet(wrapper: HTMLElement, inner: HTMLElement, settings: MagnetSettings): () => void {
  /** 现在的位移（px）。 */
  const current: Point = { x: 0, y: 0 };
  /** 现在的速度（px/秒）。 */
  const velocity: Point = { x: 0, y: 0 };
  /** 指针在窗口里的位置；指针离开窗口、窗口失去焦点时为 null。 */
  let pointer: Point | null = null;
  /** 排着的下一帧；0 表示没排。 */
  let raf = 0;
  /** 上一帧的时间（ms）；0 表示这一轮刚开始。 */
  let last = 0;

  /** 算要去的位移：指针在吸附范围外时回到原位。 */
  const measure = (): Point => {
    /** 这一刻的指针位置。 */
    const at = pointer;
    if (at === null) {
      return { x: 0, y: 0 };
    }
    const rect = wrapper.getBoundingClientRect();
    /** 指针相对内容中心的偏移。 */
    const dx = at.x - (rect.left + rect.width / 2);
    const dy = at.y - (rect.top + rect.height / 2);
    /** 指针到内容边缘的距离；在内容上为 0。 */
    const outside = Math.hypot(
      Math.max(0, Math.abs(dx) - rect.width / 2),
      Math.max(0, Math.abs(dy) - rect.height / 2),
    );
    if (outside > settings.padding) {
      return { x: 0, y: 0 };
    }
    /** 吸的力度（0–1）：吸附范围靠里的一半是满力，靠外的一半平滑减到 0。 */
    const pull = settings.padding > 0 ? 1 - smoothstep(settings.padding * 0.5, settings.padding, outside) : 1;
    /** 按吸力算出的位移，超过 maxOffset 时按比例缩回去。 */
    const x = (dx / settings.strength) * pull;
    const y = (dy / settings.strength) * pull;
    const length = Math.hypot(x, y);
    if (length <= settings.maxOffset) {
      return { x, y };
    }
    return { x: (x * settings.maxOffset) / length, y: (y * settings.maxOffset) / length };
  };

  /** 弹簧走一小步（dt 秒）；返回是否已经停稳。 */
  const solve = (target: Point, dt: number): boolean => {
    let resting = true;
    for (const key of ['x', 'y'] as const) {
      const force = SPRING.stiffness * (target[key] - current[key]) - SPRING.damping * velocity[key];
      velocity[key] += (force / SPRING.mass) * dt;
      current[key] += velocity[key] * dt;
      if (Math.abs(target[key] - current[key]) > 0.05 || Math.abs(velocity[key]) > 0.05) {
        resting = false;
      }
    }
    return resting;
  };

  /** 一帧：量出要去的位移，弹簧追过去；停稳后贴到目标上，不再排帧。 */
  const frame = (now: number): void => {
    raf = 0;
    /** 距上一帧的秒数；最多按 1/30 秒算，切回标签页时不会猛跳。 */
    const dt = last === 0 ? 1 / 60 : Math.min((now - last) / 1000, 1 / 30);
    last = now;
    const target = measure();
    // 一帧拆成 1/120 秒的小步算，帧率低时弹簧也不会发散。
    const steps = Math.ceil(dt / (1 / 120));
    let resting = true;
    for (let i = 0; i < steps; i += 1) {
      resting = solve(target, dt / steps);
    }
    if (resting) {
      current.x = target.x;
      current.y = target.y;
      velocity.x = 0;
      velocity.y = 0;
    }
    inner.style.transform = `translate3d(${current.x.toFixed(2)}px, ${current.y.toFixed(2)}px, 0)`;
    if (resting) {
      last = 0;
      return;
    }
    raf = window.requestAnimationFrame(frame);
  };

  /** 没排帧时排一帧。 */
  const wake = (): void => {
    if (raf === 0) {
      raf = window.requestAnimationFrame(frame);
    }
  };
  /** 鼠标或触控板移动：记下位置；手指不算。 */
  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      return;
    }
    pointer = { x: event.clientX, y: event.clientY };
    wake();
  };
  /** 指针离开窗口或窗口失去焦点：回到原位。 */
  const onLeave = (): void => {
    pointer = null;
    wake();
  };

  // r: 滚动时内容相对指针的位置变了，也要重算。
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('scroll', wake, { passive: true, capture: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  window.addEventListener('blur', onLeave);

  return () => {
    window.cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('scroll', wake, { capture: true });
    document.documentElement.removeEventListener('pointerleave', onLeave);
    window.removeEventListener('blur', onLeave);
    inner.style.transform = '';
  };
}


/** 平滑阶梯：value 不到 edge0 时为 0，超过 edge1 时为 1，中间按 S 形曲线过渡。 */
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
