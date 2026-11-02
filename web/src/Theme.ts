/**
 * 科技主题：页面颜色和 antd 配置的唯一来源。颜色沿用旧版的“科技”主题（web_bak/src/Themes.ts），用户默认用它。
 * Main.tsx 调 applyThemeVariables 把颜色写成 CSS 变量给 App.css 用；App.tsx 把 ANTD_THEME 交给 ConfigProvider。
 */
import * as antd from 'antd';
import type { ThemeConfig } from 'antd';


/** 页面与控件共用的语义颜色；组件按用途取色。 */
export interface ThemeColors {
  /** 页面底色。 */
  background: string;
  /** 栏目、输入框和浮层的底色。 */
  surface: string;
  /** 正文与标题文字颜色。 */
  text: string;
  /** 辅助说明与次要文字颜色。 */
  muted: string;
  /** 分隔线、控件边框颜色。 */
  border: string;
  /** 主操作、链接和选中项的强调色。 */
  accent: string;
  /** 强调色背景上的文字颜色。 */
  onAccent: string;
  /** 成功状态颜色。 */
  success: string;
  /** 错误与危险操作颜色。 */
  danger: string;
}


/** 科技主题的颜色（深色）。 */
export const TECH_COLORS: ThemeColors = {
  background: '#071019',
  surface: '#0b1925',
  text: '#d8f3fa',
  muted: '#8baab9',
  border: '#193a49',
  accent: '#41d9ea',
  onAccent: '#03161d',
  success: '#5fdbb5',
  danger: '#ff8195',
};


/** 正文字体：用系统自带的中文字体，不加载外部字体文件。 */
const FONT_SANS = "'HarmonyOS Sans SC', 'MiSans', 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans SC', sans-serif";


/** 交给 antd ConfigProvider 的主题：深色算法，加上和页面同一套颜色。 */
export const ANTD_THEME: ThemeConfig = {
  algorithm: antd.theme.darkAlgorithm,
  token: {
    colorPrimary: TECH_COLORS.accent,
    colorInfo: TECH_COLORS.accent,
    colorSuccess: TECH_COLORS.success,
    colorError: TECH_COLORS.danger,
    colorBgBase: TECH_COLORS.background,
    colorBgLayout: TECH_COLORS.background,
    colorBgContainer: TECH_COLORS.surface,
    colorBgElevated: TECH_COLORS.surface,
    colorText: TECH_COLORS.text,
    colorTextSecondary: TECH_COLORS.muted,
    colorTextPlaceholder: TECH_COLORS.muted,
    colorTextLightSolid: TECH_COLORS.onAccent,
    colorBorder: TECH_COLORS.border,
    colorBorderSecondary: TECH_COLORS.border,
    fontFamily: FONT_SANS,
  },
};


/**
 * 把颜色写成根元素上的 CSS 变量（如 `--jm-background`、`--jm-accent`），再写入字体变量和深色标记。
 * 直接改传入元素的 style；页面启动时调用一次。
 */
export function applyThemeVariables(rootElement: HTMLElement): void {
  // m: 每种颜色一个变量，变量名就是 ThemeColors 的字段名。
  for (const name of Object.keys(TECH_COLORS) as (keyof ThemeColors)[]) {
    rootElement.style.setProperty(`--jm-${name}`, TECH_COLORS[name]);
  }
  rootElement.style.setProperty('--jm-font-sans', FONT_SANS);
  // m: 告诉浏览器这是深色页面，滚动条等原生控件也用深色。
  rootElement.style.colorScheme = 'dark';
}
