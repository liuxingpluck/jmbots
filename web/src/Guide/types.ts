/**
 * 演示引导步骤的形状。话术放在 steps-*.ts，改说明不用动组件。
 * 中文直接写 UTF-8，不要用 \u 转义。
 */
/** 步骤话术支持的语言代码。 */
export type GuideLang = 'zh-CN' | 'en';

/** 一步引导。 */
export interface GuideStep {
  /** 步骤编号，方便以后改某一句。 */
  id: string;
  /** CSS 选择器；不写则居中显示介绍，不圈具体元素。 */
  element?: string;
  /** 步骤弹窗标题，按界面语言分中英文。 */
  title: Record<GuideLang, string>;
  /** 步骤弹窗正文说明，按界面语言分中英文。 */
  description: Record<GuideLang, string>;
  /** 弹窗相对高亮元素的弹出方向，省略时默认在下方。 */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** 弹窗相对高亮元素的对齐方式，省略时默认居中。 */
  align?: 'start' | 'center' | 'end';
  /** 高亮这一步时，把推荐演示问题填进输入框或编辑器。 */
  prefill?: string;
  /** 图谱页：把客户、检索方式一并设好。 */
  graph?: { customer?: string; mode?: 'hybrid' | 'graph' };
  /** 发出后（或检索完成后）自动进下一步；也可以点「下一步」跳过等待。 */
  waitFor?: 'jmbots-guide-sent' | 'jmbots-guide-searched';
  /** 元素当前不在页面上就跳过（例如还没有回复、没有正在运行的任务）。 */
  optional?: boolean;
}

/**
 * 从界面语言落到步骤话术：繁体用中文，其它非中文用英文；无副作用。
 * @param language 当前界面语言代码。
 * @returns 步骤话术使用的语言键（`zh-CN` 或 `en`）。
 */
export function getStepLang(language: string | undefined | null): GuideLang {
  if (language && language.toLowerCase().startsWith('zh')) return 'zh-CN';

  return 'en';
}
