/**
 * progress 用的话和小函数：各段耗时、参数摘要、限时写法、读审核结论、几段提示词。都是纯函数，照 0.4 src/capabilities/Progress.ts。
 * 时长写法、截字在 utils/Text.ts（duration、clip）。
 */
import * as textModule from '../../utils/Text.ts';


/** 到点问 decision 的三道是非题（照 0.4 :43-59）：推进、5 分钟能做完、在打转。 */
export const QUESTIONS = {
  progressing: { instructions: '这件事还在往前推进吗？最近几步在做新的事、有进展，算“是”；原地踏步、重复同样的操作，算“否”。', yes: '在推进', no: '没在推进' },
  nearlyDone: { instructions: '照现在的进度，再给 5 分钟能把用户要的做完吗？', yes: '5 分钟内能做完', no: '5 分钟做不完' },
  looping: { instructions: '有没有在打转：同一条命令反复失败、反复做同样的事、绕圈子、偏离了用户要的？', yes: '在打转', no: '没在打转' },
};

/** 收尾总结怎么写（照 0.4 :74-77）。 */
export const WRAPUP_PROMPT: Record<string, string> = {
  zh: '用户给这件事设了时间上限，现在到点了，工作已经停下。照下面的工作过程写一段收尾总结，三小段，每段一两句：做到哪了；卡在哪、为什么慢；还剩什么、接着做先干什么。只写工作过程里有的，不要编。',
  en: 'The user set a time limit for this task and it has been reached; the work has stopped. '
    + 'Using the work log below, write a short wrap-up in three parts, one or two sentences each: '
    + 'what got done; where it got stuck and why it was slow; what is left and what to do first next time. '
    + 'Only state what is in the log.',
};

/** 延够了以后审核怎么看（照 0.4 :80-95）：离谱不离谱、要不要转新会话，只回一个 JSON。 */
export const REVIEW_PROMPT: Record<string, string> = {
  zh: [
    '用户给这件事设了时间上限，已经延长过两次，还没做完。你是审核：读下面的用户原话和工作过程，判断两件事，只回一个 JSON，不要别的字：',
    '{"absurd": true 或 false, "absurdWhy": "…", "handoff": true 或 false, "handoffNote": "…"}',
    '- absurd：有没有离谱的行为：同一条命令反复失败、绕圈子、偏离了用户要的、乱删乱改。有就 true，absurdWhy 用一两句说清哪里离谱，引用工作过程里的事；没有就 false，absurdWhy 写空字符串。',
    '- handoff：要不要转到一个新会话接着做。方向是对的，只是上下文被旧的尝试塞满、越做越乱，换个干净的会话更容易做完，就 true；'
      + '做不下去的原因换会话也解决不了（缺权限、缺东西、要用户定），就 false。absurd 是 true 时 handoff 写 false。',
    '- handoffNote：handoff 是 true 时写给新会话的交接说明，分四段，每段开头写小标题：目标（用户要什么）；做到哪了；'
      + '卡在哪；别再怎么做（试过不行的路）。只写工作过程里有的，不要编。handoff 是 false 时写空字符串。',
  ].join('\n'),
  en: [
    'The user set a time limit for this task; it has been extended twice and is still not done. '
      + 'You are the reviewer: read the user request and the work log below and decide two things. '
      + 'Reply with one JSON object only, nothing else:',
    '{"absurd": true or false, "absurdWhy": "...", "handoff": true or false, "handoffNote": "..."}',
    '- absurd: is there unreasonable behaviour — the same command failing again and again, going in circles, '
      + 'drifting from what the user asked, careless deletes or edits? '
      + 'If so true, and absurdWhy says where in one or two sentences, citing the log; '
      + 'otherwise false and an empty absurdWhy.',
    '- handoff: should the work continue in a fresh session? '
      + 'true when the direction is right but the context is clogged with old attempts '
      + 'and a clean session would finish more easily; '
      + 'false when a fresh session would not help (missing permission, missing material, needs the user to decide). '
      + 'If absurd is true, handoff is false.',
    '- handoffNote: when handoff is true, a handover note for the new session in four parts, '
      + 'each with a short heading: goal (what the user wants); what is done; where it is stuck; '
      + 'what not to do again (paths that failed). '
      + 'Only state what is in the log. Empty string when handoff is false.',
  ].join('\n'),
};


/** 审核的结论。 */
export interface Verdict {
  absurd: boolean;
  absurdWhy: string;
  handoff: boolean;
  handoffNote: string;
  why: string;
}

/** 各段耗时。 */
export interface Timings {
  modelMs: number;
  tools: { name: string; count: number; ms: number }[];
}


/**
 * 各段耗时说成一句话，如“思考 5 步 40.2 秒；find ×3 18.4 秒、read ×5 2.1 秒；总共 1 分 3 秒”。
 * @param steps 模型回答了几次。
 * @param timings 各段耗时。
 * @param usedMs 一共用了多久。
 * @returns 拼接好的各段耗时说明字符串。
 */
export function timingsText(steps: number, timings: Timings, usedMs: number): string {
  const parts: string[] = [];
  if (steps > 0) parts.push(`思考 ${String(steps)} 步 ${textModule.formatDuration(timings.modelMs)}`);
  if (timings.tools.length > 0) {
    const byTime = [...timings.tools].sort((left, right) => right.ms - left.ms);
    const toolTexts = byTime.map((item) => `${item.name} ×${String(item.count)} ${textModule.formatDuration(item.ms)}`);
    parts.push(toolTexts.join('、'));
  }
  parts.push(`总共 ${textModule.formatDuration(usedMs)}`);
  return parts.join('；');
}

/**
 * 工具参数说成一句短话：最能说明它在干什么的那个参数，截 60 字。
 * @param args 参数。
 * @returns 截断至 60 字的核心参数摘要；找不到合适字符串参数时返回空串。
 */
export function argsBrief(args: Record<string, unknown>): string {
  //M 按优先级从常见关键参数中挑选一项，压缩空白并截短供进度界面展示。
  const main = args['command']
    ?? args['query']
    ?? args['path']
    ?? args['pattern']
    ?? args['text']
    ?? args['action']
    ?? args['prompt'];
  if (typeof main === 'string') return textModule.clipText(main.replace(/\s+/gu, ' '), 60);

  return '';
}

/**
 * 限时写成一句：“不限时”“最多 20 分钟”“最多 20 分钟（延长过 1 次，共 25 分钟）”。
 * @param limitMinutes 限时几分钟；不限时是 undefined。
 * @param extended 延长过几次。
 * @param extendMinutes 一次延几分钟。
 * @returns 格式化后的限时描述文本。
 */
export function limitText(limitMinutes: number | undefined, extended: number, extendMinutes: number): string {
  if (limitMinutes === undefined) return '不限时';
  if (extended === 0) return `最多 ${String(limitMinutes)} 分钟`;
  const total = limitMinutes + extended * extendMinutes;
  return `最多 ${String(limitMinutes)} 分钟（延长过 ${String(extended)} 次，共 ${String(total)} 分钟）`;
}

/**
 * 读审核的回答：取出 JSON，absurd、handoff 是真假值才算；建议转却没写交接说明的，算不转。
 * @param text 审核小会话的回答。
 * @returns 读不出来就是不离谱、不转，why 写原因。
 */
export function readVerdict(text: string): Verdict {
  const none = (why: string): Verdict => ({ absurd: false, absurdWhy: '', handoff: false, handoffNote: '', why });
  //M 从审核小会话回答里提取 JSON 对象，解析出是否离谱、是否交接及说明。
  const json = extractJson(text);
  //G 未提取到有效对象或关键布尔字段缺失时，按无法判定处理并带上原回答片段停下收尾。
  if (json === undefined || typeof json['absurd'] !== 'boolean' || typeof json['handoff'] !== 'boolean') {
    return none(`审核的回答读不出结论，停下收尾：${textModule.clipText(text.replace(/\s+/gu, ' '), 200)}`);
  }
  let absurdWhy = '';
  if (typeof json['absurdWhy'] === 'string') {
    absurdWhy = json['absurdWhy'].trim();
  }
  let handoffNote = '';
  if (typeof json['handoffNote'] === 'string') {
    handoffNote = json['handoffNote'].trim();
  }
  //M 优先判定是否离谱，其次校验交接说明是否齐全，决定最终审核动作。
  if (json['absurd'] === true) return { absurd: true, absurdWhy, handoff: false, handoffNote: '', why: '审核发现离谱' };
  //G 虽建议转新会话但没写交接说明，避免新会话盲跑，按不转停下收尾。
  if (json['handoff'] === true && handoffNote === '') return none('审核建议转新会话，但没写交接说明，停下收尾');
  if (json['handoff'] === true) return { absurd: false, absurdWhy: '', handoff: true, handoffNote, why: '审核建议转新会话' };

  //M 既不离谱也不建议转交，构造正常停下收尾结论返回给进度管理器。
  return none('审核：不离谱，也不建议转新会话，停下收尾');
}

/**
 * 一段话里找第一个 { 到最后一个 } 当 JSON 读（模型常在 JSON 外面包一层代码块或多说一句）。
 * @param text 包含 JSON 对象的原始文本。
 * @returns 读不出是 undefined。
 */
export function extractJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

