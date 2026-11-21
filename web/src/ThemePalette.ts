/**
 * 纯 CSS 变量主题色板（零 antd 运行时依赖）：
 * 供首帧脚本与无 antd 独立页面（如 /frpc/、/work-decision/、/graph/）直接引用，避免拉入 CSS-in-JS 运行时。
 */


/** 主题名。 */
export type ThemeName = 'dark' | 'light' | 'tech' | 'eyecare';


/** 一套主题。 */
export interface ThemeSpec {
  /** 名字。 */
  name: ThemeName;
  /** 给人看的名字。 */
  label: string;
  /** 是不是深色底（antd 用深色算法）。 */
  dark: boolean;
  /** 调完整了没有；没调完的在设置里标“预览”。 */
  ready: boolean;
  /** 圆角，像素。 */
  radius: number;
  /** 颜色：键名就是 CSS 变量名去掉 --jm- 前缀。 */
  colors: {
    bg: string;
    panel: string;
    surface: string;
    hover: string;
    border: string;
    text: string;
    muted: string;
    accent: string;
    chart: string;
    userBubble: string;
    botBubble: string;
    danger: string;
    warning: string;
    success: string;
    accentSoft: string;
    warningSoft: string;
    dangerSoft: string;
  };
  /** 头像色块的候选颜色，按名字挑一个。 */
  avatars: string[];
}


/** 四套主题。 */
export const THEMES: Record<ThemeName, ThemeSpec> = {
  dark: {
    name: 'dark',
    label: '深色',
    dark: true,
    ready: true,
    radius: 12,
    colors: {
      bg: '#0b0c0f',
      panel: '#111317',
      surface: '#181b21',
      hover: '#20242c',
      border: '#23272f',
      text: '#e7e9ee',
      muted: '#8b919c',
      accent: '#7aa2ff',
      chart: '#6690f5',
      userBubble: '#1f2a44',
      botBubble: '#171a20',
      danger: '#ff6b6b',
      warning: '#f5b74e',
      success: '#4fd18b',
      accentSoft: 'rgba(122, 162, 255, 0.18)',
      warningSoft: 'rgba(245, 183, 78, 0.22)',
      dangerSoft: 'rgba(255, 107, 107, 0.16)',
    },
    avatars: ['#7aa2ff', '#b48cff', '#ff8fb1', '#ffb86b', '#4fd18b', '#4cc9f0', '#f4d35e'],
  },
  light: {
    name: 'light',
    label: '浅色',
    dark: false,
    ready: false,
    radius: 12,
    colors: {
      bg: '#f6f7f9',
      panel: '#ffffff',
      surface: '#f1f3f6',
      hover: '#e9ecf1',
      border: '#e3e6eb',
      text: '#1d2129',
      muted: '#6b7280',
      accent: '#3b6cf6',
      chart: '#3b6cf6',
      userBubble: '#e3ecff',
      botBubble: '#f1f3f6',
      danger: '#e5484d',
      warning: '#d68a00',
      success: '#18a058',
      accentSoft: '#e6f4ff',
      warningSoft: '#fff1b8',
      dangerSoft: '#fff2f0',
    },
    avatars: ['#3b6cf6', '#8b5cf6', '#ec4899', '#f97316', '#18a058', '#0ea5e9', '#ca8a04'],
  },
  tech: {
    name: 'tech',
    label: '科技',
    dark: true,
    ready: false,
    radius: 6,
    colors: {
      bg: '#070b12',
      panel: '#0c1320',
      surface: '#111b2c',
      hover: '#17253b',
      border: '#1e314d',
      text: '#dbeafe',
      muted: '#7da2cc',
      accent: '#38bdf8',
      chart: '#38bdf8',
      userBubble: '#0f2d4a',
      botBubble: '#0f1b2d',
      danger: '#fb7185',
      warning: '#fbbf24',
      success: '#34d399',
      accentSoft: 'rgba(56, 189, 248, 0.18)',
      warningSoft: 'rgba(251, 191, 36, 0.22)',
      dangerSoft: 'rgba(251, 113, 133, 0.16)',
    },
    avatars: ['#38bdf8', '#818cf8', '#22d3ee', '#34d399', '#a78bfa', '#f472b6', '#fbbf24'],
  },
  eyecare: {
    name: 'eyecare',
    label: '护眼',
    dark: false,
    ready: false,
    radius: 12,
    colors: {
      bg: '#f2efe6',
      panel: '#f8f5ec',
      surface: '#ebe6d8',
      hover: '#e1dbc9',
      border: '#d8d1be',
      text: '#2c2a24',
      muted: '#6e6a5e',
      accent: '#2f6f4e',
      chart: '#2f6f4e',
      userBubble: '#dceadf',
      botBubble: '#ece7da',
      danger: '#c44536',
      warning: '#b07d12',
      success: '#2f6f4e',
      accentSoft: '#dceadf',
      warningSoft: '#f5e6b8',
      dangerSoft: '#f6dcd8',
    },
    avatars: ['#2f6f4e', '#4c6f8c', '#8c5e3c', '#6b5b95', '#3d7a74', '#9c5b4f', '#7a7d3b'],
  },
};

/** 本地存储里记主题名的键。 */
const STORAGE_KEY = 'jmbots.theme';


/**
 * 从本地存储读主题名；没存过或存的词不认识时用 dark。
 * @param storage window.localStorage（测试里可传替身）。
 */
export function loadThemeName(storage?: Pick<Storage, 'getItem'>): ThemeName {
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    if (saved && Object.hasOwn(THEMES, saved)) {
      return saved as ThemeName;
    }
  } catch {
    //G 隐私模式禁用存储时回退默认深色主题。
  }
  return 'dark';
}


/**
 * 把主题名写进本地存储。
 * @param storage window.localStorage。
 * @param name 主题名。
 */
export function saveThemeName(storage: Pick<Storage, 'setItem'> | undefined, name: ThemeName): void {
  try {
    storage?.setItem(STORAGE_KEY, name);
  } catch {
    //G 隐私模式禁用存储时忽略写入异常，不影响即时换肤。
  }
}


/**
 * 把驼峰键名换成短横线：userBubble -> user-bubble。
 * @param key 键名。
 */
function kebab(key: string): string {
  return key.replaceAll(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}


/**
 * 算出一套主题对应的全部 CSS 变量（测试可直接拿来断言，不用真的 DOM）。
 * @param spec 主题。
 */
export function cssVariables(spec: ThemeSpec): Record<string, string> {
  const vars: Record<string, string> = { '--jm-radius': `${spec.radius}px` };
  for (const [key, value] of Object.entries(spec.colors)) {
    vars[`--jm-${kebab(key)}`] = value;
  }
  return vars;
}


/**
 * 把主题写进页面根节点（document.documentElement）。首帧在 React 挂载前先调一次，就不会闪白。
 * @param root 根节点。
 * @param spec 主题。
 */
export function applyTheme(root: HTMLElement, spec: ThemeSpec): void {
  //M 把当前主题的圆角与全部配色写入根节点 CSS 变量，让组件样式无需刷新即可即时换肤。
  for (const [name, value] of Object.entries(cssVariables(spec))) {
    root.style.setProperty(name, value);
  }
  let scheme = 'light';
  if (spec.dark) {
    scheme = 'dark';
  }
  root.style.colorScheme = scheme;
  root.dataset.theme = spec.name;
}


/**
 * 按名字挑头像色块的颜色：同一个名字永远是同一个颜色。
 * @param name 机器人名。
 * @param palette 候选颜色。
 */
export function avatarColor(name: string, palette: string[]): string {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return palette[hash % palette.length] ?? palette[0] ?? '#888888';
}
