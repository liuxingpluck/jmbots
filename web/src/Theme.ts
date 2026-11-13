/**
 * 主题（docs/界面/01_界面设计.md 第 5 节）：配色只在这一个文件里。深色是默认；浅色、科技、护眼先留好名字和切换口子，
 * 这期只把深色调完整。组件里不写颜色，一律用这里写进页面的 CSS 变量（--jm-…），antd 用 antdTheme() 给的令牌。
 */
import * as antd from 'antd';


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
    /** 页面底色。 */
    bg: string;
    /** 栏的底色。 */
    panel: string;
    /** 卡片、输入框的底色。 */
    surface: string;
    /** 鼠标移上去、选中的底色。 */
    hover: string;
    /** 分隔线、边框。 */
    border: string;
    /** 正文。 */
    text: string;
    /** 次要文字。 */
    muted: string;
    /** 强调色（按钮、链接、选中）。 */
    accent: string;
    /** 图表里柱子的颜色（用量页）：按 dataviz 技能的校验脚本核过，亮度在范围里、和底色对比够 3:1。 */
    chart: string;
    /** 用户消息的底色。 */
    userBubble: string;
    /** 机器人消息的底色。 */
    botBubble: string;
    /** 危险（拒绝、出错）。 */
    danger: string;
    /** 提醒（审核卡片、等待中）。 */
    warning: string;
    /** 成功（干活中、已连上）。 */
    success: string;
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
      bg: '#05070d',
      panel: '#0a0f1a',
      surface: '#0f1726',
      hover: '#14203a',
      border: '#1a2a44',
      text: '#d6e4ff',
      muted: '#6f86ad',
      accent: '#00d4ff',
      chart: '#009fc9',
      userBubble: '#0d2a40',
      botBubble: '#0c1424',
      danger: '#ff4d6d',
      warning: '#ffc857',
      success: '#2ee6a6',
    },
    avatars: ['#00d4ff', '#7c4dff', '#2ee6a6', '#ff4d6d', '#ffc857', '#4d7cff'],
  },
  eyecare: {
    name: 'eyecare',
    label: '护眼',
    dark: false,
    ready: false,
    radius: 12,
    colors: {
      bg: '#e8efe1',
      panel: '#f1f5ea',
      surface: '#e2eadb',
      hover: '#d8e3cf',
      border: '#cfdac5',
      text: '#2c3a2a',
      muted: '#66745f',
      accent: '#4f7a4a',
      chart: '#4f7a4a',
      userBubble: '#d5e5c9',
      botBubble: '#e9efe3',
      danger: '#b4534b',
      warning: '#b07d2b',
      success: '#4f7a4a',
    },
    avatars: ['#4f7a4a', '#7a6a4a', '#4a6a7a', '#7a4a5f', '#8a7a3a'],
  },
};

/** 默认主题。 */
export const DEFAULT_THEME: ThemeName = 'dark';

/** 浏览器本地存主题名用的键。 */
const STORAGE_KEY = 'jmbots.theme';


/**
 * 读用户选过的主题；没选过或认不出就用默认。
 * @param storage 浏览器本地存储。
 */
export function loadThemeName(storage: Pick<Storage, 'getItem'>): ThemeName {
  /** 存的名字。 */
  const saved = storage.getItem(STORAGE_KEY);
  return saved && saved in THEMES ? (saved as ThemeName) : DEFAULT_THEME;
}


/**
 * 记下用户选的主题。
 * @param storage 浏览器本地存储。
 * @param name 主题名。
 * 副作用：写浏览器本地存储。
 */
export function saveThemeName(storage: Pick<Storage, 'setItem'>, name: ThemeName): void {
  storage.setItem(STORAGE_KEY, name);
}


/**
 * 驼峰写成连字符：userBubble → user-bubble。
 * @param name 键名。
 */
function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}


/**
 * 一套主题的 CSS 变量（--jm-bg、--jm-user-bubble……）。
 * @param spec 主题。
 * @returns 变量名 → 值。
 */
export function cssVariables(spec: ThemeSpec): Record<string, string> {
  /** 变量。 */
  const variables: Record<string, string> = { '--jm-radius': `${spec.radius}px` };
  for (const [name, value] of Object.entries(spec.colors)) {
    variables[`--jm-${kebab(name)}`] = value;
  }
  return variables;
}


/**
 * 把主题写进页面：CSS 变量、color-scheme。
 * @param root 一般是 document.documentElement。
 * @param spec 主题。
 * 副作用：改 root 的样式和 data-theme。
 */
export function applyTheme(root: HTMLElement, spec: ThemeSpec): void {
  for (const [name, value] of Object.entries(cssVariables(spec))) {
    root.style.setProperty(name, value);
  }
  root.style.colorScheme = spec.dark ? 'dark' : 'light';
  root.dataset.theme = spec.name;
}


/**
 * antd 用的主题令牌。
 * @param spec 主题。
 */
export function antdTheme(spec: ThemeSpec): antd.ThemeConfig {
  return {
    algorithm: spec.dark ? antd.theme.darkAlgorithm : antd.theme.defaultAlgorithm,
    token: {
      colorPrimary: spec.colors.accent,
      colorBgBase: spec.colors.bg,
      colorBgContainer: spec.colors.surface,
      colorBgElevated: spec.colors.surface,
      colorBorder: spec.colors.border,
      colorBorderSecondary: spec.colors.border,
      colorTextBase: spec.colors.text,
      colorError: spec.colors.danger,
      colorWarning: spec.colors.warning,
      colorSuccess: spec.colors.success,
      borderRadius: spec.radius,
      fontFamily: 'var(--jm-font)',
    },
  };
}


/**
 * 按名字挑头像色块的颜色：同一个名字永远是同一个颜色。
 * @param name 机器人名。
 * @param palette 候选颜色。
 */
export function avatarColor(name: string, palette: string[]): string {
  /** 名字算出来的数。 */
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return palette[hash % palette.length] ?? palette[0] ?? '#888888';
}
