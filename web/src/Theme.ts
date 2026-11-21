/**
 * 主题（docs/界面/01_界面设计.md 第 5 节）：配色定义见 ThemePalette.ts，此处补充 antd ConfigProvider 令牌生成。
 */
import { theme as antdThemeAlg, type ThemeConfig } from 'antd';
import {
  THEMES,
  applyTheme,
  avatarColor,
  cssVariables,
  loadThemeName,
  saveThemeName,
  type ThemeName,
  type ThemeSpec,
} from './ThemePalette.ts';

export { THEMES, applyTheme, avatarColor, cssVariables, loadThemeName, saveThemeName, type ThemeName, type ThemeSpec };


/**
 * antd 用的主题令牌。
 * @param spec 主题。
 */
export function antdTheme(spec: ThemeSpec): ThemeConfig {
  let algorithm = antdThemeAlg.defaultAlgorithm;
  if (spec.dark) {
    algorithm = antdThemeAlg.darkAlgorithm;
  }
  return {
    algorithm,
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
