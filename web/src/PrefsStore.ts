/**
 * 设备和偏好（zustand）：是不是窄屏、系统是否要求减少动态效果、有没有鼠标，以及用户的动效开关。
 * 窄屏（小于 768px）时 App 用手机布局，旋转屏幕、拖窄窗口时会跟着切换。
 * Effects 里的装饰动效三个条件都满足才播：用户开着顶栏的“动效”开关、系统没要求减少动态效果、有能悬停的精确指针。
 * 手机和纯触屏设备没有悬停，动效一律不播。媒体查询的监听在本文件加载时装一次。
 * 动效开关记在浏览器的 localStorage 里；读不到或写不进去时按“开”处理，只影响这一次打开。
 */
import * as zustand from 'zustand';


/** 窄屏的媒体查询：宽度小于 768px。 */
const COMPACT_QUERY = '(max-width: 767px)';
/** 系统要求减少动态效果时成立的媒体查询。 */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
/** 有能悬停的精确指针（鼠标、触控板）时成立的媒体查询。 */
const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)';
/** localStorage 里记动效开关的键；值是 'on' 或 'off'。 */
const STORAGE_KEY = 'jmai.motion';


/** 设备状态、偏好和改偏好的动作。 */
interface PrefsState {
  /** 是不是窄屏；窄屏用手机布局。 */
  compact: boolean;
  /** 系统是否要求减少动态效果。 */
  reducedMotion: boolean;
  /** 有没有鼠标或触控板。 */
  finePointer: boolean;
  /** 用户是否开着动效；默认开。 */
  motionEnabled: boolean;
  /** 改动效开关，同时记到浏览器里。 */
  setMotionEnabled: (enabled: boolean) => void;
}


/** 三条媒体查询的监听对象，加载时建一次。 */
const compactMedia = window.matchMedia(COMPACT_QUERY);
const reducedMotionMedia = window.matchMedia(REDUCED_MOTION_QUERY);
const finePointerMedia = window.matchMedia(FINE_POINTER_QUERY);


/** 设备和偏好的 store；组件用 `usePrefsStore((state) => state.xxx)` 取一块，派生值用下面的 blockedReason、motionAllowed。 */
export const usePrefsStore = zustand.create<PrefsState>()((set) => ({
  compact: compactMedia.matches,
  reducedMotion: reducedMotionMedia.matches,
  finePointer: finePointerMedia.matches,
  motionEnabled: readSaved(),
  setMotionEnabled: (motionEnabled) => {
    save(motionEnabled);
    set({ motionEnabled });
  },
}));


// m: 媒体查询变化时只改对应的那一项。
compactMedia.addEventListener('change', (event) => usePrefsStore.setState({ compact: event.matches }));
reducedMotionMedia.addEventListener('change', (event) => usePrefsStore.setState({ reducedMotion: event.matches }));
finePointerMedia.addEventListener('change', (event) => usePrefsStore.setState({ finePointer: event.matches }));


/** 系统这边不让播动效的原因；系统允许时为 null。顶栏开关用它变灰并说明原因。用法：`usePrefsStore(prefsStore.blockedReason)`。 */
export function blockedReason(state: PrefsState): string | null {
  if (state.reducedMotion) {
    return '系统设置了减少动态效果';
  }
  if (!state.finePointer) {
    return '没有鼠标或触控板';
  }
  return null;
}


/** 现在能不能播装饰动效：用户开着，并且系统允许。用法：`usePrefsStore(prefsStore.motionAllowed)`。 */
export function motionAllowed(state: PrefsState): boolean {
  return state.motionEnabled && blockedReason(state) === null;
}


/** 读用户上次的选择；没记过或读不到时算“开”。 */
function readSaved(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}


/** 把用户的选择记到浏览器里。 */
function save(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // 写不进去（如隐私模式）就算了，开关照样在这次打开里生效。
  }
}
