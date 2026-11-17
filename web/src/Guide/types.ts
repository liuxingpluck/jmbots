/**
 * 演示引导步骤的形状。话术放在 steps-*.ts，改说明不用动组件。
 * 中文直接写 UTF-8，不要用 \u 转义。
 */
export type GuideLang = 'zh-CN' | 'en';

/** 一步引导。 */
export interface GuideStep {
  /** 步骤编号，方便以后改某一句。 */
  id: string;
  /** CSS 选择器；不写则居中显示介绍，不圈具体元素。 */
  element?: string;
  title: Record<GuideLang, string>;
  description: Record<GuideLang, string>;
  side?: 'top' | 'bottom' | 'left' | 'right';
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

/** 从界面语言落到步骤话术：繁体用中文，其它非中文用英文。 */
export function stepLang(language: string | undefined | null): GuideLang {
  return language && language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}
