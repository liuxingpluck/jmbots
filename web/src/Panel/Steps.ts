/**
 * 会话步骤的展示规则（G批设计 8.3）：Session.tsx 把后端 steps 交给 StepsPresenter，
 * 得到可读的步骤条目和分派记录卡。写法照 Trace.ts 的 TracePresenter。
 * 这里只整理已有记录，不发请求、不改状态；event 里的键“有就显示、没有不崩”。
 */
import * as i18n from '../I18n.ts';
import type * as types from '../Types.ts';


/** 工具参数、结果片段最多显示多少字，超了截断并注明。 */
const MAX_CHARS = 4000;


/** 一步在界面上的样子。 */
export interface StepItem {
  /** seq，显示用。 */
  seq: number;
  /** 行号：分派、E1…E12、恢复。 */
  row: string;
  /** 事件名（原样，不翻译成 0.4 名——这是会话页，不是 trace）。 */
  eventType: string;
  /** 时间，格式化后的 HH:MM:SS。 */
  time: string;
  /** 状态变化：idle → wait_response（后端原值，调试用途）。 */
  state: string;
  /** 一句话摘要（从 event/stored 里取）。 */
  summary: string;
  /** 展开后的事实（event/stored/triggered 的键值，工具调用和结果整理成可读文本）。 */
  facts: { key: string; label: string; value: string }[];
  /** 是不是分派记录。 */
  dispatch: boolean;
}


/** 分派记录的一张卡。 */
export interface DispatchCardView {
  /** 谁分来的：渠道 + 来源。 */
  from: string;
  /** 什么情况：机器人、原话、最近会话、当时的工作区。 */
  situation: string;
  /** 用的模型和思考档。 */
  model: string;
  /** 为什么。 */
  reason: string;
  /** 谁定的：决策模型 / 程序兜底 / 调用方指定。 */
  by: string;
  /** 进哪个会话、哪个工作区。 */
  target: string;
}


/** event.calls 里的一个工具调用（安全取出后的样子）。 */
interface ToolCall {
  /** 调用号；没有是空串。 */
  id: string;
  /** 工具名；没有是空串。 */
  name: string;
  /** 参数的 JSON 原文。 */
  args: string;
}


/**
 * 是字符串就原样，不是就空串。
 * @param value 任何值。
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}


/**
 * 安全取一个对象值：不是对象一律当空表（后端在补键，缺了不能崩）。
 * @param value 任何值。
 */
function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}


/**
 * 安全取 event.calls：不是列表当没有，坏项跳过；args 不是字符串就序列化。
 * @param event 步骤的 event。
 */
function callsOf(event: Record<string, unknown>): ToolCall[] {
  /** 原始的 calls。 */
  const raw = event.calls;
  if (!Array.isArray(raw)) {
    return [];
  }
  /** 认出来的调用。 */
  const calls: ToolCall[] = [];
  for (const item of raw) {
    /** 一个调用。 */
    const record = recordOf(item);
    if (Object.keys(record).length === 0) {
      continue;
    }
    calls.push({
      id: text(record.id),
      name: text(record.name),
      args: typeof record.args === 'string' ? record.args : JSON.stringify(record.args ?? {}),
    });
  }
  return calls;
}


/**
 * 会话步骤的展示规则；只整理已有记录，不发请求。
 * 翻译来自 I18n.useT；离线测试省略参数时使用中文原文。
 */
export class StepsPresenter {
  /** @param t 界面当前语言的翻译函数，不执行任何外部请求。 */
  constructor(private readonly t: i18n.Translate = i18n.source) {}


  /**
   * steps 列表 → 界面条目（顺序不变）。
   * @param steps 后端返回的原始步骤。
   */
  items(steps: types.SessionStep[]): StepItem[] {
    return steps.map((step) => ({
      seq: step.seq,
      row: step.row,
      eventType: step.eventType,
      time: this.timeOf(step.at),
      state: `${step.stateBefore} → ${step.stateAfter}`,
      summary: this.summaryOf(step),
      facts: this.factsOf(step),
      dispatch: step.row === '分派',
    }));
  }


  /**
   * 只取分派记录（steps 里 row === '分派'，stored 是整份分派记录）。
   * @param steps 后端返回的原始步骤。
   */
  dispatches(steps: types.SessionStep[]): DispatchCardView[] {
    return steps
      .filter((step) => step.row === '分派')
      .map((step) => this.dispatchCardOf(step.stored));
  }


  /**
   * 毫秒 → HH:MM:SS（浏览器本地时区）。
   * @param at 记录时间。
   */
  private timeOf(at: number): string {
    //G 时间不对劲就明说，不猜。
    if (!Number.isFinite(at)) {
      return this.t('未记录');
    }
    /** 补零。 */
    const two = (value: number): string => String(value).padStart(2, '0');
    /** 本地时间。 */
    const date = new Date(at);
    return [date.getHours(), date.getMinutes(), date.getSeconds()].map(two).join(':');
  }


  /**
   * 长文字截断：超过 4000 字截断并注明总字数。
   * @param value 原文。
   */
  private clip(value: string): string {
    if (value.length <= MAX_CHARS) {
      return value;
    }
    return `${value.slice(0, MAX_CHARS)}…${this.t('（截断，共 {count} 字）', { count: value.length })}`;
  }


  /**
   * 一句话摘要：按行号取 event/stored 里有的键；认不出的行用事件名。
   * @param step 原始步骤。
   */
  private summaryOf(step: types.SessionStep): string {
    const t = this.t;
    /** 这一步的事件数据。 */
    const event = step.event;
    switch (step.row) {
      case '分派': {
        /** 分派结论。 */
        const result = recordOf(step.stored.result);
        return t('分派到会话 {session} · 模型 {model}', {
          session: text(result.session) || t('未记录'),
          model: text(result.model) || t('未记录'),
        });
      }
      case 'E1': {
        /** 开跑时的模型（后端在补，可能没有）。 */
        const model = text(event.model);
        return model === '' ? t('运行开始') : t('运行开始 · 模型 {model}', { model });
      }
      case 'E2': {
        /** 这一步调的工具名。 */
        const names = this.toolNames(event);
        return names.length === 0 ? t('模型返回') : t('模型返回 · 调用 {names}', { names: names.join('、') });
      }
      case 'E3':
      case 'E4': {
        /** 工具名和结果长度。 */
        const name = text(event.name) === '' ? t('工具') : text(event.name);
        //G 后端明确说失败才算失败；ok/isError 两个键都认（在补的过程中可能只有其一）。
        if (event.ok === false || event.isError === true) {
          return t('工具 {name} 出错', { name });
        }
        /** 结果字符数。 */
        const chars = event.resultChars;
        return typeof chars === 'number'
          ? t('工具 {name} 完成 · 结果 {chars} 字', { name, chars })
          : t('工具 {name} 完成', { name });
      }
      case 'E5': {
        /** 结局。 */
        const ending = text(event.ending);
        return ending === '' ? t('回复已发出') : t('回复已发出 · 结局 {ending}', { ending });
      }
      case 'E6':
        return t('准备调模型');
      case 'E7':
      case 'E10':
      case 'E11': {
        /** 结局和错误。 */
        const ending = text(event.ending) || t('未记录');
        const error = text(event.error);
        return error === ''
          ? t('运行结束 · {ending}', { ending })
          : t('运行结束 · {ending} · {error}', { ending, error });
      }
      case 'E8': {
        /** 停下的说明。 */
        const note = text(event.note);
        return note === '' ? t('要求停下') : t('要求停下：{note}', { note });
      }
      case 'E9': {
        /** 换的前后模型。 */
        const from = text(event.from);
        const to = text(event.to);
        return from === '' || to === ''
          ? t('换模型')
          : t('换模型 · {from} → {to}', { from, to });
      }
      case '恢复':
        return t('会话恢复');
      default:
        return step.eventType;
    }
  }


  /**
   * 这一步调了哪些工具：优先 event.calls 的名字，没有就退回 event.tools。
   * @param event 步骤的 event。
   */
  private toolNames(event: Record<string, unknown>): string[] {
    /** calls 里的名字。 */
    const fromCalls = callsOf(event)
      .map((call) => (call.name === '' ? this.t('工具') : call.name));
    if (fromCalls.length > 0) {
      return fromCalls;
    }
    /** 老的 tools 键（字符串列表）。 */
    const tools = event.tools;
    return Array.isArray(tools)
      ? tools.filter((item): item is string => typeof item === 'string')
      : [];
  }


  /**
   * 展开后的事实：工具调用（name + args JSON）和结果片段整理成可读文本，
   * 再把 event 里的标量键列上；对象、数组交给原始 JSON 那块（StepsView）。
   * @param step 原始步骤。
   */
  private factsOf(step: types.SessionStep): StepItem['facts'] {
    /** 攒出来的事实。 */
    const facts: StepItem['facts'] = [];
    for (const call of callsOf(step.event)) {
      facts.push({
        key: `call:${call.id}`,
        label: this.t('调用 {name}', { name: call.name === '' ? this.t('工具') : call.name }),
        value: this.clip(call.args),
      });
    }
    /** 工具结果片段（E3/E4，后端在补）。 */
    const result = step.event.result;
    if (typeof result === 'string' && result !== '') {
      facts.push({ key: 'result', label: this.t('工具结果'), value: this.clip(result) });
    }
    for (const [key, value] of Object.entries(step.event)) {
      //G 对象和数组不进 facts（下面原始 JSON 里有），只列一眼能读的标量。
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        facts.push({ key: `event.${key}`, label: key, value: String(value) });
      }
    }
    return facts;
  }


  /**
   * 一份分派记录（DispatchRecord）投影成卡片：谁分的、什么情况、模型+思考档、为什么、谁定的、去向。
   * 0.6.0 的旧记录形状不一样（workspaces 是字符串数组、有 lastSession），读不出就显示未记录，不崩。
   * @param stored 分派步的 stored（整份分派记录；键缺了显示“未记录”）。
   */
  private dispatchCardOf(stored: Record<string, unknown>): DispatchCardView {
    const t = this.t;
    /** 分派记录的几块。 */
    const from = recordOf(stored.from);
    const situation = recordOf(stored.situation);
    const result = recordOf(stored.result);
    /** 没有就写未记录。 */
    const unknown = t('未记录');

    /** 谁分来的：渠道 · 来源。 */
    const fromParts = [text(from.channel), text(from.source)].filter((part) => part !== '');
    /** 当时有哪些工作区（新记录是对象数组，旧记录是字符串数组）。 */
    const workspaces = Array.isArray(situation.workspaces)
      ? situation.workspaces
        .map((item) => (typeof item === 'string' ? item : text(recordOf(item).name)))
        .filter((name) => name !== '')
      : [];
    /** 候选会话有几个。 */
    const sessionCount = Array.isArray(situation.sessions) ? situation.sessions.length : 0;
    /** 情况几段。 */
    const situationParts = [`${t('机器人')} ${text(situation.bot) || unknown}`];
    const original = text(situation.text);
    if (original !== '') {
      situationParts.push(`${t('原话')}「${original}」`);
    }
    situationParts.push(t('候选会话 {count} 个', { count: sessionCount }));
    if (workspaces.length > 0) {
      situationParts.push(`${t('当时的工作区')} ${workspaces.join('、')}`);
    }
    /** 思考档。 */
    const thinking = text(result.thinking);
    /** 理由。 */
    const reason = text(result.reason);
    /** 谁定的。 */
    let by = t('程序兜底');
    if (stored.by === 'direct') {
      by = t('调用方指定');
    } else if (stored.by === 'decision') {
      by = t('决策模型');
    } else if (stored.by === 'quick') {
      by = t('低思考模型');
    } else if (stored.by === 'llm') {
      by = t('常规模型');
    }
    return {
      from: fromParts.join(' · ') || unknown,
      situation: situationParts.join('；'),
      model: `${text(result.model) || unknown} · ${t('思考档')} ${thinking === '' ? t('默认（最高档）') : thinking}`,
      reason: reason === '' ? t('当时的分派理由未记录。') : reason,
      by,
      target: `${t('会话')} ${text(result.session) || unknown} · ${t('工作区')} ${text(result.workspace) || unknown}`,
    };
  }
}
