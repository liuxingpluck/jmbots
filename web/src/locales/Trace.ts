/** 跟踪点文案由网页和后端打印共用，旧流水的文本直接显示。 */
import zh from './trace.zh.json' with { type: 'json' };
import zhTW from './trace.zh-TW.json' with { type: 'json' };
import en from './trace.en.json' with { type: 'json' };
import fr from './trace.fr.json' with { type: 'json' };

export type TraceLanguage = 'zh' | 'zh-TW' | 'en' | 'fr';
export type TraceParams = Record<string, string | number>;

const PACKS: Record<TraceLanguage, Record<string, string>> = { zh, 'zh-TW': zhTW, en, fr };
const PARAM = /\{(\w+)\}/gu;
const MODE_IDS: Record<string, string> = {
  serial: 'trace.mode.serial',
  bail: 'trace.mode.serial',
  emit: 'trace.mode.notify',
  parallel: 'trace.mode.notify',
};

/** 识别 Cordis 的发法，旧流水存的显示文字直接沿用。 */
export function getTraceModeId(mode: string): string {
  if (!Object.hasOwn(MODE_IDS, mode)) return mode;

  return MODE_IDS[mode]!;
}

/** 将界面语言归到后端打印语言，未配置时使用简体中文。 */
export function getTraceLanguage(value: unknown): TraceLanguage {
  if (typeof value !== 'string') return 'zh';

  const language = value.trim().replaceAll('_', '-').toLowerCase();
  if (/^zh-(tw|hk|mo|hant)(-|$)/u.test(language)) return 'zh-TW';
  if (/^en(-|$)/u.test(language)) return 'en';
  if (/^fr(-|$)/u.test(language)) return 'fr';
  return 'zh';
}

/** 只识别已登记的文案编号。 */
export function isTraceText(value: string): boolean {
  return Object.hasOwn(PACKS.zh, value);
}

/** 只交给界面当前文案明确需要的标量，避免把所有跟踪变量带进画布。 */
export function getTraceParams(id: string, vars: Record<string, unknown>): TraceParams | undefined {
  if (!isTraceText(id)) return undefined;

  const written = PACKS.zh[id]!;
  const params: TraceParams = {};
  //M 读取文案中声明的占位符，保留实际变量的原始文字。
  for (const match of written.matchAll(PARAM)) {
    const key = match[1]!;
    const value = vars[key];
    if (typeof value === 'string' || typeof value === 'number') params[key] = value;
    if (typeof value === 'boolean') params[key] = String(value);
  }
  if (Object.keys(params).length === 0) return undefined;

  return params;
}

/** 按显示端语言填文案；旧流水和未知编号原样显示。 */
export function getTraceText(language: TraceLanguage, text: string, vars: Record<string, unknown> = {}): string {
  if (!isTraceText(text)) return text;

  const caption = PACKS[language][text] ?? PACKS.en[text] ?? PACKS.zh[text]!;
  return caption.replace(PARAM, (whole, key: string) => {
    const value = vars[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);

    return whole;
  });
}

/** 已知变量使用语言包中的标签，未知或旧变量保留原键。 */
export function getTraceFieldLabel(language: TraceLanguage, field: string): string {
  const id = `trace.field.${field}`;
  if (!isTraceText(id)) return field;

  return getTraceText(language, id);
}

interface TitleRow {
  kind: string;
  name: string;
  text: string;
  params?: TraceParams;
  gap: number;
  facts: Record<string, unknown>;
}

/** 组装一步标题，保留函数优先和等模型的摘要。 */
export function getTraceStepTitle(rows: TitleRow[], render: (text: string, params?: TraceParams) => string): string {
  const descriptions = rows.map((row) => render(row.text, row.params)).filter((text) => text !== '');
  const events = [...new Set(descriptions)].slice(0, 3).join('，');
  const firstFunction = rows.find((row) => row.kind === '函数' && row.text !== '');
  let title = events || rows[0]?.name || '';
  if (firstFunction !== undefined) title = render(firstFunction.text, firstFunction.params);

  const waited = rows.find((row) => row.name === 'Session.loop' && row.gap >= 500);
  if (waited !== undefined) {
    const answer = rows.find((row) => row.name === 'session/new-message' && row.facts['role'] === 'assistant');
    const seconds = (waited.gap / 1000).toFixed(1);
    let text = title;
    if (answer !== undefined && answer.text !== '') text = render(answer.text, answer.params);
    return render('trace.waited', { seconds, text });
  }

  const toolRow = rows.find((row) => row.kind === '函数' && typeof row.facts['tool'] === 'string');
  const tool = toolRow?.facts['tool'];
  if (typeof tool === 'string' && !title.includes(tool)) return `${title}：${tool}`;

  return title;
}
