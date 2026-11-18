/** 后台首先用有限的非正文线索分类，再决定要不要请求图像模型。 */

import type * as cordis from 'cordis';
import * as requests from '../../utils/RequestEvent.ts';

type Activity = '读代码' | '看视频' | '聊天' | '读文档' | '未知';
type Verdict = 'allow' | 'deny' | 'unsure';

/** 从程序、标题和控件提取的固定分类标签。 */
export interface Cues {
  /** 应用名所对应的用途。 */
  application: Activity;
  /** 窗口标题所对应的用途。 */
  window: Activity;
  /** 控件名或类型所对应的用途。 */
  control: Activity;
}

/** 不含任何标题、控件正文或模型理由的快速分析结果。 */
export interface Analysis {
  /** 决策模型确认的用途，证据不足时为未知。 */
  activity: Activity;
  /** 背景画面值得细看的判定。 */
  verdict: Verdict;
  /** 第一层收到最终裁定的耗时。 */
  decisionMs: number;
}

/** 将一段界面文字映射为固定标签，只输出有限词汇。 */
function getCue(text: string): Activity {
  if (/(?:vscode|code\.exe|cursor|visual studio|代码|源码|ide\b)/iu.test(text)) return '读代码';

  if (/(?:vlc|potplayer|youtube|bilibili|直播|视频|播放)/iu.test(text)) return '看视频';

  if (/(?:discord|slack|telegram|聊天|消息|会话)/iu.test(text)) return '聊天';

  if (/(?:notepad|winword|excel|pdf|记事本|文档|保存)/iu.test(text)) return '读文档';

  return '未知';
}

/** 标题与控件原文仍留在 HTTP 私有调用栈，分类器只收到这些标签。 */
export function getCues(processName: string, title: string, control: string): Cues {
  //M 分别提取有限的应用、标题和控件标签。
  const application = getCue(processName);
  const window = getCue(title);
  const element = getCue(control);
  return { application, window, control: element };
}

/** 使用既有二元决策协议确认候选用途，并独立判断是否需要进一步看图。 */
export async function analyze(ctx: cordis.Context, cues: Cues, signal: AbortSignal): Promise<Analysis> {
  const started = performance.now();
  const candidates = [cues.application, cues.window, cues.control];
  //M 已知程序的证据优先，通用浏览器再以标题和控件补充。
  const candidate = candidates.find((value) => value !== '未知') ?? '未知';
  const state = { 应用线索: cues.application, 窗口线索: cues.window, 控件线索: cues.control, 候选用途: candidate };
  const options = {
    prefix: 'screen',
    timeoutMs: 1800,
    signal,
    onFallback: () => ({ requestId: '', verdict: 'unsure' as const, reason: '决策不可用' }),
  };
  const detail = {
    kind: 'screen-detail',
    question: {
      instructions: '根据固定标签判断当前应用是否在执行明确任务，且看一眼界面能提供额外帮助。仅浏览或线索太弱时为否。',
      yes: '当前目的明确，查看局部界面有助于进一步理解',
      no: '当前场景不需要看图或证据不足',
    },
    state,
  };

  //M 先发需要细看的判定，不阻塞正常点击。
  const detailed = requests.requestEvent(ctx, 'decision/judge', 'decision/judge-result', detail, options);
  let activity: Activity = '未知';
  if (candidate !== '未知') {
    const usage = {
      kind: 'screen-activity',
      question: {
        instructions: '只根据应用、窗口和控件的固定分类标签，确认候选用途。证据冲突或不足时不确认。',
        yes: '当前活动符合候选用途',
        no: '当前活动无法确认符合候选用途',
      },
      state,
    };
    //M 用独立二元问题确认用途，两项裁定并行。
    const matched = await requests.requestEvent(ctx, 'decision/judge', 'decision/judge-result', usage, options);
    if (matched.verdict === 'allow') {
      activity = candidate;
    }
  }
  const result = await detailed;
  const decisionMs = Math.round(performance.now() - started);
  return { activity, verdict: result.verdict, decisionMs };
}
