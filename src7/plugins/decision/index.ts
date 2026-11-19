/**
 * 决策模型：一道是非题加一份现状，交给配置里的一个或几个模型同时打分（“答案是‘是’”的把握，0～1），合成一个分，照阈值交回
 * allow / deny / unsure。两种模型都认：对话模型（开一场 kind: 'decision' 的小会话，让它回一段带 probability 的 JSON）；
 * 0.4 用的分类器（typesafe-system-one，直接给概率）。不拦事件、不出题、不记表。
 * 谁要判断谁发请求事件 decision/judge（approval、bots 前台、progress 可选地用），本插件回 decision/judge-result；没挂本插件时发的一方当场退回拿不准。
 * 请求带 want: ['what'] 时，对话模型在同一次回答里顺带写一句“执行完会做成什么”，回执带回 what（只用来显示，不进合分）；分类器给不出文字，不带 what。
 * 照 0.4 src/capabilities/Model.ts:382-390、446-453、727-744。设计见同目录 说明.md 的「设计要点」一节。
 */
import * as botUtils from '../../utils/Bots.ts';
import * as piAi from '@earendil-works/pi-ai';
import * as piSystemOne from '@earendil-works/pi-ai/api/typesafe-system-one.lazy';
import * as cordis from 'cordis';
import type { AskInput } from '../../Sessions.ts';
import { onRequestEvent, type RequestEnvelope, type ResultEnvelope } from '../../utils/RequestEvent.ts';


/** 插件名。 */
export const name = 'decision';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
export const version = '1.1.1';

/** 默认的决策模型：Magpie 里的 jev-1.14 分类器（jev-router 在这个地区用不了）。 */
const DEFAULT_MODELS = [{ model: 'magpie/openrouter/typesafe/jev-1.14', type: 'classifier' }];

/** 用到的服务：resources 拿配置和供应商；sessions 开小会话；bots 小会话记在哪个机器人名下。 */
export const inject = ['resources', 'sessions'];


declare module 'cordis' {
  interface Context {
    /** 决策模型服务，实现在 src7/plugins/decision/index.ts。 */
    decision: Decision;
  }
  interface Events {
    /**
     * 请求（serial）：决策模型打分并合成 allow / deny / unsure 结论，回发 decision/judge-result。
     * 谁发：
     *   src7/plugins/approval/index.ts 的 Approval.askDecision
     *   src7/plugins/progress/index.ts 的 Progress.judge
     *   src7/plugins/screen/Analysis.ts 的 analyze
     *   src7/plugins/voice/Tasks.ts 的 VoiceTasks.judge
     * 谁接：src7/plugins/decision/index.ts 的 Decision.constructor
     */
    'decision/judge'(request: DecisionJudgeRequest): void | Promise<void>;
    /**
     * 回执（emit）：决策裁定结果（按 requestId 配对）。
     * 谁发：src7/plugins/decision/index.ts 的 Decision.constructor
     * 谁接：
     *   src7/plugins/approval/index.ts 的 Approval.askDecision
     *   src7/plugins/progress/index.ts 的 Progress.judge
     *   src7/plugins/screen/Analysis.ts 的 analyze
     *   src7/plugins/voice/Tasks.ts 的 VoiceTasks.judge
     */
    'decision/judge-result'(result: DecisionJudgeResult): void;
  }
}


/** 调用方能顺带要的字段：what 是命令执行完会做成什么（一句话）。 */
export type JudgeWant = 'what';

/** 调用方给的。 */
export interface JudgeInput {
  /** 为什么问：exec、run、progress……只进跟踪。 */
  kind: string;
  /** 是非题，照 0.4 的 ClassifierBoolQuestion。 */
  question: { instructions: string; yes: string; no: string };
  /** 给模型看的现状；第一项放最要紧的。 */
  state: Record<string, unknown>;
  /** 对话模型的小会话记在哪个机器人名下；不给用名单第一个。 */
  bot?: string;
  /** 分数 ≥ 它就 allow；不给用配置的 allow_at。 */
  allowAt?: number;
  /** 分数 < 它就 deny；不给用配置的 deny_at。 */
  denyAt?: number;
  /** 顺带要的字段：带 'what' 就在同一次提问里多要一句执行结果；不给就和原来一样，提示词、回执都不变。 */
  want?: readonly JudgeWant[];
}

/** 一个模型的结果。 */
export interface ModelResult {
  /** 配置里的模型名。 */
  model: string;
  /** 答案是“是”的把握，0～1；没答出分时没有。 */
  score?: number;
  /** 对话模型写的一句理由。 */
  reason?: string;
  /** 带了 want: ['what'] 时对话模型写的执行结果；没写、写空串时没有。 */
  what?: string;
  /** 没答上来的原因（出错、超时、没答出分）。 */
  error?: string;
  /** 花了多少毫秒。 */
  ms: number;
}

/** 合出来的结论。 */
export interface Judgement {
  verdict: 'allow' | 'deny' | 'unsure';
  score?: number;
  reason: string;
  /** 带了 want: ['what'] 时，按配置 models 的顺序第一个写了的执行结果；都没写时没有。 */
  what?: string;
  results: ModelResult[];
}

/** decision/judge 请求载荷。 */
export type DecisionJudgeRequest = RequestEnvelope & JudgeInput;

/** decision/judge-result 回执载荷。 */
export interface DecisionJudgeResult extends ResultEnvelope {
  /** 结论：分数 ≥ allowAt 是 allow，< denyAt 是 deny，别的（含都没答上来）是 unsure。 */
  verdict: 'allow' | 'deny' | 'unsure';
  /** 合出来的分，0～1；都没答上来时没有。 */
  score?: number;
  /** 一句人话：怎么合的分、比的哪个阈值。 */
  reason: string;
  /** 带了 want: ['what'] 才可能有：命令执行完会做成什么，一句话；模型都没写就没有。 */
  what?: string;
}

/** 配置里的一个模型。 */
interface Member { name: string; type: 'chat' | 'classifier' }

/** 校验后的配置。 */
interface DecisionConfig {
  members: Member[];
  combine: 'average' | 'min' | 'max';
  allowAt: number;
  denyAt: number;
  timeoutMs: number;
}


/** 从对话模型的回答里找分：不要求整段是合法 JSON。 */
const PROBABILITY = /probability"?\s*[:：]\s*([0-9.]+)/u;
/** 一句理由。 */
const REASON = /reason"?\s*[:：]\s*"([^"]*)"/u;
/** 带了 want: ['what'] 时的执行结果。 */
const WHAT = /"what"\s*[:：]\s*"([^"]*)"/u;
/** 不带 want 时要的回答格式（和原来一字不差）。 */
const PLAIN_FORMAT = '只回一段 JSON：{"probability": 0 到 1 的数，答案是‘是’的把握, "reason": "一句话"}';
/** 带了 want: ['what'] 时要的回答格式：多要一句执行结果，看不出就留空，别编。 */
const WHAT_FORMAT = '只回一段 JSON：{"probability": 0 到 1 的数，答案是‘是’的把握, "reason": "一句话", '
  + '"what": "命令执行完的结果，一句话：对哪些文件做了什么、最后变成什么样；看不出就写空串，别编"}';
/** 合分方式的中文。 */
const COMBINE_WORDS = { average: '取平均', min: '取最低', max: '取最高' } as const;


/** 按各模型有效分数合出结论和理由。 */
function buildJudgement(
  scores: number[],
  results: ModelResult[],
  combine: DecisionConfig['combine'],
  allowAt: number,
  denyAt: number,
): Judgement {
  if (scores.length === 0) {
    const details = results.map((result) => `${result.model} ${result.error ?? '没答出分'}`).join('；');
    return { verdict: 'unsure', reason: `决策模型都没答上来：${details}`, results };
  }
  let score = Math.max(...scores);
  if (combine === 'min') {
    score = Math.min(...scores);
  }
  if (combine === 'average') {
    score = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  }
  const how = `${String(scores.length)} 个模型${COMBINE_WORDS[combine]}`;
  const shown = score.toFixed(2);
  if (score >= allowAt) return { verdict: 'allow', score, reason: `决策模型认为是（${shown} ≥ ${String(allowAt)}，${how}）`, results };
  if (score < denyAt) return { verdict: 'deny', score, reason: `决策模型认为否（${shown} < ${String(denyAt)}，${how}）`, results };

  return { verdict: 'unsure', score, reason: `决策模型拿不准（${shown}，${how}）`, results };
}


/** 决策模型服务。 */
export class Decision extends cordis.Service {
  /** 分类器使用的 MutableModels。setProvider 登记供应商，getModelOfType 取分类模型，classify 执行分类。 */
  private readonly classifiers: piAi.MutableModels | undefined;

  /**
   * 登记 decision 插件：把 Decision 作为服务挂到 Cordis 上（super(ctx, 'decision') 做的；以后用 ctx.decision 取）；有分类器就照 0.4 建一份只放分类器的集合。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param config 校验后的配置。
   * 副作用：把 Decision 服务挂到 ctx.decision；存在分类器时单独建一份分类器模型集合。
   */
  constructor(ctx: cordis.Context, private readonly config: DecisionConfig) {
    super(ctx, 'decision');
    //M 先挂事件驱动裁定入口，确保即使未配置 classifier 成员也能响应对话模型判定请求。
    onRequestEvent(ctx, 'decision/judge', 'decision/judge-result', async (request) => {
      //M 转调内部多模型合成函数并抽取外部协议需要的精简结论。
      const judgement = await this.judge(request);
      const out: Omit<DecisionJudgeResult, 'requestId'> = { verdict: judgement.verdict, reason: judgement.reason };
      if (judgement.score !== undefined) out.score = judgement.score;
      //M 带了 want: ['what'] 且有模型写了，才把执行结果带回；不带 want 的回执和原来一样。
      if (judgement.what !== undefined) {
        out.what = judgement.what;
      }
      return out;
    });
    const wanted = config.members.filter((member) => member.type === 'classifier');
    if (wanted.length === 0) {
      this.classifiers = undefined;
      return;
    }
    //M 分类器：骨架的 pi 集合只建对话模型，这里按供应商另建一份，每家只放用到的分类器（地址、密钥取 providers 里那份）。
    this.classifiers = piAi.createModels();
    const byProvider = new Map<string, string[]>();
    for (const member of wanted) {
      const slash = member.name.indexOf('/');
      const provider = member.name.slice(0, slash);
      byProvider.set(provider, [...(byProvider.get(provider) ?? []), member.name.slice(slash + 1)]);
    }
    for (const [provider, ids] of byProvider) {
      const written = ctx.resources.config.providers[provider];
      if (written === undefined) continue;

      //M 密钥和骨架建对话模型用同一份（Resources 的 getProviderAuth：取 config.yaml 里这家的 api_key）。
      this.classifiers.setProvider(piAi.createProvider({
        id: provider,
        baseUrl: written.baseUrl,
        auth: ctx.resources.getProviderAuth(written),
        //M ClassifierModel 描述分类器的 id、type 和 api。ClassifierApi 是分类适配器标识，例如 typesafe-system-one。
        models: ids.map((id): piAi.ClassifierModel<piAi.ClassifierApi> => ({
          id, name: id, provider, baseUrl: written.baseUrl, type: 'classifier', api: 'typesafe-system-one',
          input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0,
        })),
        api: {},
        classifiers: { 'typesafe-system-one': piSystemOne.typesafeSystemOneApi() },
      }));
    }
  }

  /**
   * 同时问所有模型，各自限时；有分的合起来，比阈值。不抛错。
   * @param input 题、现状、阈值。
   * @returns 结论和每个模型的结果。
   * 副作用：向配置的决策模型发请求或开启 decision 小会话；发一条 trace 跟踪事件。
   */
  async judge(input: JudgeInput): Promise<Judgement> {
    //M 并发向配置中的所有决策模型限时打分，收集各模型的结果（含超时与出错）。
    const results = await Promise.all(this.config.members.map((member) => this.limited(member, input)));
    const scores: number[] = [];
    for (const result of results) {
      if (result.score !== undefined) {
        scores.push(result.score);
      }
    }
    //M 取传入阈值或配置默认阈值，把各模型的有效分合并成 allow / deny / unsure 结论。
    const allowAt = input.allowAt ?? this.config.allowAt;
    const denyAt = input.denyAt ?? this.config.denyAt;
    const judgement = buildJudgement(scores, results, this.config.combine, allowAt, denyAt);
    //M 执行结果按配置 models 的顺序取第一个写了的（Promise.all 保持顺序，不看谁先回）；只用来显示，不进合分。
    const written = results.find((result) => result.what !== undefined);
    if (written?.what !== undefined) {
      judgement.what = written.what;
    }
    const summaryList = results.map((result) => {
      if (result.score === undefined) return `${result.model}=（${result.error ?? ''}） ${String(result.ms)}ms`;

      return `${result.model}=${result.score.toFixed(2)} ${String(result.ms)}ms`;
    });
    //T 跟踪：每个模型的分和结论。
    this.ctx.emit('trace', 'Decision.judge', 'trace.decision.judge', 'Promise.all(members.map(ask))', {
      category: input.kind, verdict: judgement.verdict, score: judgement.score, reason: judgement.reason, executionResult: judgement.what,
      models: summaryList,
    });
    return judgement;
  }

  /** 限时问一个：超时记 error，不等它（对话模型的小会话照样停下）。 */
  private async limited(member: Member, input: JudgeInput): Promise<ModelResult> {
    const began = Date.now();
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<ModelResult>((resolve) => {
      timer = setTimeout(() => {
        stop.abort();
        resolve({ model: member.name, error: `超过 ${String(this.config.timeoutMs)} 毫秒没回`, ms: Date.now() - began });
      }, this.config.timeoutMs);
    });
    //M 发起单模型打分并在失败时把异常折成 error 字段，便于和超时定时器竞速。
    const asked = this.ask(member, input, stop.signal)
      .catch((error: unknown) => {
        if (error instanceof Error) return { error: error.message };

        return { error: String(error) };
      })
      .then((part): ModelResult => ({ model: member.name, ...part, ms: Date.now() - began }));
    try {
      return await Promise.race([asked, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 问一个模型：分类器直接要概率；对话模型开小会话，从回答里找 probability。 */
  private async ask(member: Member, input: JudgeInput, signal: AbortSignal): Promise<Omit<ModelResult, 'model' | 'ms'>> {
    if (member.type === 'classifier') {
      const slash = member.name.indexOf('/');
      const model = this.classifiers?.getModelOfType('classifier', member.name.slice(0, slash), member.name.slice(slash + 1));
      if (model === undefined) return { error: '分类器没建起来（供应商不在 providers 里？）' };
      const result = await this.classifiers!.classify(model, {
        //M JsonObject 是给分类器的 JSON 状态对象，键是字符串，值可以嵌套对象或数组。
        state: input.state as piAi.JsonObject,
        questions: { q: { type: 'bool', instructions: input.question.instructions, criteria: { true: input.question.yes, false: input.question.no } } },
      }, { signal });
      if (result.stopReason !== 'stop') return { error: `${result.stopReason}：${result.errorMessage ?? ''}` };
      const answer = result.answers['q'] as { probability?: number } | undefined;
      if (typeof answer?.probability === 'number') return { score: answer.probability };

      return { error: '没答出分' };
    }

    //M sessions.ask 开一场 kind: 'decision' 的小会话问一次（走骨架循环，循环里调 chat()，假模型也接得住），思考档 off；超时（signal）就停。
    const bot = input.bot ?? botUtils.getDefaultBot(this.ctx.resources.raw) ?? '';
    //M 带了 want: ['what']：同一次提问里多要一句执行结果，不另调模型；不带就照原样只要分和理由。
    const wantWhat = input.want?.includes('what') === true;
    let answerFormat = PLAIN_FORMAT;
    if (wantWhat) {
      answerFormat = WHAT_FORMAT;
    }
    //G 第一行放现状：假模型回话的前 40 字，离线测时能把分带回来。
    const text = [
      JSON.stringify(input.state),
      input.question.instructions,
      `是：${input.question.yes}`,
      `否：${input.question.no}`,
      answerFormat,
    ].join('\n');
    const askInput: AskInput = {
      kind: 'decision',
      bot,
      model: member.name,
      thinking: 'off',
      text,
      signal,
    };
    //M 开一场不带工具和思考的 decision 小会话向对话模型提问，拿回文本供解析概率。
    const { ok, reply } = await this.ctx.sessions.ask(askInput);

    //G 没做完（出错、超时停了）→ 原因当错误交回。
    if (!ok) return { error: reply || '没做完' };

    //M 从回答里找分和理由。
    const found = PROBABILITY.exec(reply);
    if (found === null) return { error: '没答出分' };

    const score = Number(found[1]);
    if (!(score >= 0 && score <= 1)) return { error: '没答出分' };

    const part: Omit<ModelResult, 'model' | 'ms'> = { score };
    const reason = REASON.exec(reply)?.[1];
    if (reason !== undefined) {
      part.reason = reason;
    }
    if (!wantWhat) return part;

    //M 带了 want：再找执行结果；空串、只有空白的当没写（模型看不出就留空，不编）。
    const whatFound = WHAT.exec(reply);
    const what = whatFound?.[1]?.trim() ?? '';
    if (what !== '') {
      part.what = what;
    }
    return part;
  }
}


/**
 * 校验顶层 decision 段。
 * @param raw ctx.resources.raw['decision']。
 * @param providers 配置里的供应商名。
 * @throws 不对就抛错，插件挂不上。
 */
function checkConfig(raw: unknown, providers: Record<string, unknown>): DecisionConfig {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null)) throw new Error('decision 段要是一组设置');
  const record = (raw ?? {}) as Record<string, unknown>;
  //M 用户 11-14：只用 jev 一个分类器，不再几个模型取平均。不写 models 就用它。
  const models = record['models'] ?? DEFAULT_MODELS;
  if (!Array.isArray(models) || models.length === 0) throw new Error('decision 段要写 models（至少一个）');
  const members = models.map((item: unknown, index): Member => {
    const label = `decision.models[${String(index)}]`;
    let entry: Record<string, unknown> | null = item as Record<string, unknown> | null;
    if (typeof item === 'string') {
      entry = { model: item, type: 'chat' };
    }
    const model = entry?.['model'];
    const type = entry?.['type'] ?? 'chat';
    if (typeof model !== 'string' || !model.includes('/')) throw new Error(`${label} 要写成“供应商名/模型 ID”或 { model, type: classifier }`);
    if (type !== 'chat' && type !== 'classifier') throw new Error(`${label}.type 只能是 chat 或 classifier`);
    if (providers[model.slice(0, model.indexOf('/'))] === undefined) throw new Error(`${label} 的供应商不在 providers 里：${model}`);
    return { name: model, type };
  });
  const combine = record['combine'] ?? 'average';
  if (combine !== 'average' && combine !== 'min' && combine !== 'max') throw new Error('decision.combine 只能是 average、min、max');
  const ratio = (key: string, fallback: number): number => {
    const value = record[key] ?? fallback;
    if (typeof value !== 'number' || value < 0 || value > 1) throw new Error(`decision.${key} 要是 0～1 的数`);
    return value;
  };
  //M 解析并校验 allow_at 与 deny_at 阈值（均须落在 0～1），供后续比对大小关系。
  const allowAt = ratio('allow_at', 0.8);
  const denyAt = ratio('deny_at', 0);
  if (denyAt > allowAt) throw new Error('decision.deny_at 要小于等于 allow_at');
  const timeoutMs = record['timeout_ms'] ?? 10_000;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('decision.timeout_ms 要是正整数');
  return { members, combine, allowAt, denyAt, timeoutMs };
}


/**
 * 挂上决策模型。
 * apply 是 Cordis 插件的入口：inject 里的服务都就绪后调一次。配置在顶层 decision 段（骨架不认的顶层段原样留在 raw 里）。
 * @param ctx Cordis 给这个插件的 ctx。
 * @throws decision 段配置写得不对时抛错。
 * 副作用：校验配置并把 Decision 服务挂到 ctx.decision。
 */
export function apply(ctx: cordis.Context): void {
  //M 校验顶层 decision 配置并实例化 Decision 服务挂到 ctx.decision。
  new Decision(ctx, checkConfig(ctx.resources.raw['decision'], ctx.resources.config.providers));
}
