/**
 * voice 的配置：config.yaml 顶层 voice 段在插件入口校验一次，交回 Settings；以后连接、转写、合成、派发直接用。
 * apply 调 getSettings；报错只说配置键和该写成什么样（数、开关、模型线路照 utils/Checks.ts 的公共校验）。
 */
import type { ProviderConfig } from '../../Resources.ts';
import * as checks from '../../utils/Checks.ts';
import * as asrModule from './Asr.ts';
import type * as models from './Models.ts';
import type * as taskModule from './Tasks.ts';
import * as turnModel from './TurnModel.ts';

/** 识别后端。 */
export type Provider = 'fake' | 'sherpa' | 'bailian' | 'xiaomi';
/** 合成后端。 */
export type TtsProvider = 'xiaomi' | 'local';

/** 浏览器 WebSocket 升级路径的默认值。 */
const DEFAULT_WS = '/api/voice/ws';
/** 状态接口的路径；升级路径不能和它撞。 */
export const STATUS_PATH = '/api/voice/status';

/** 双工时的插话判断。 */
export interface BargeIn {
  /** 连续转写达到多少个有效字符才有足够证据停播。 */
  minChars: number;
  /** 当前字幕与播报片段足够相似时，将它当成回声。 */
  echoSimilarity: number;
}

/** 校验后的语音设置。 */
export interface Settings {
  /** 是否允许开始听。 */
  enabled: boolean;
  /** 页面没有指定时的机器人。 */
  bot: string;
  /** 受 HTTP 鉴权保护的升级路径。 */
  wsPath: string;
  /** 用户明确配置的识别后端。 */
  provider: Provider;
  /** 可在主选失效时重放本句的另一端。 */
  asrFallback?: Exclude<Provider, 'fake'>;
  /** 百炼实时与小米整句模型标识。 */
  asrModels: Record<'bailian' | 'xiaomi', string>;
  /** 句尾静音长度。 */
  silenceMs: number;
  /** 单句话最长时间。 */
  maxUtteranceMs: number;
  /** 转写通过后使用的派发策略。 */
  tasks: taskModule.TaskSettings;
  /** 语音专用任务理解配置；缺席沿用 decision/judge。 */
  understanding?: models.ModelSettings;
  /** 半句判断与停顿参数；关闭时仅使用 ASR 的端点规则。 */
  turn?: { models: models.ModelSettings; pauseMs: number; maxPerMinute: number };
  /** 开启双工时的插话判断；缺席时沿用半双工。 */
  bargeIn?: BargeIn;
  /** 要优先使用的合成后端与音色。 */
  tts: { provider: TtsProvider; fallback?: TtsProvider; voice: string };
}

/** 识别后端的写法；fake 只出模拟字幕。 */
const PROVIDERS = ['sherpa', 'bailian', 'xiaomi', 'fake'] as const;
/** 可做识别备选的后端：真实的三家。 */
const ASR_FALLBACKS = ['sherpa', 'bailian', 'xiaomi'] as const;
/** 合成后端的写法。 */
const TTS_PROVIDERS = ['xiaomi', 'local'] as const;
/** 合成备选的写法；none 表示不备。 */
const TTS_FALLBACKS = ['local', 'xiaomi', 'none'] as const;
/** 模型线路先用哪一端。 */
const PREFERS = ['local', 'cloud'] as const;
/** 0 到 1 的阈值（判断的通过线、拒绝线）。 */
const PROBABILITY: checks.NumberRule = { min: 0, max: 1 };
/** 回声相似度：大于 0、不大于 1。 */
const SIMILARITY: checks.NumberRule = { above: 0, max: 1 };

/**
 * 在插件入口校验语音配置，默认关闭。apply 调一次，以后连接、转写、派发直接用。
 * @param raw config.yaml 顶层 voice 段原文。
 * @param providers 校验过的供应商表，查模型线路的供应商在不在。
 * @returns 校验后的语音设置。
 * @throws 哪一项写错就抛错，只说配置键和该写成什么样。
 */
export function getSettings(raw: unknown, providers: Record<string, ProviderConfig>): Settings {
  //M 各段没写当空的，取值处再补默认值。
  const voice = checks.checkRecord(raw ?? {}, 'voice');
  const asr = checks.checkRecord(voice['asr'] ?? {}, 'voice.asr');
  const turn = checks.checkRecord(voice['turn'] ?? {}, 'voice.turn');
  const judge = checks.checkRecord(voice['judge'] ?? {}, 'voice.judge');
  const tts = checks.checkRecord(voice['tts'] ?? {}, 'voice.tts');

  /** 读一个正整数配置，没写用默认值。key 是 voice 下的路径，如 turn.silence_ms。 */
  function count(value: unknown, key: string, fallback: number): number {
    return checks.checkNumber(value ?? fallback, 'voice.' + key, checks.POSITIVE_INT);
  }

  /** 校验语音模型的主备写法，不替使用者隐式启用外部供应商。 */
  function getModels(
    written: unknown,
    key: string,
    builtin?: string,
  ): models.ModelSettings | undefined {
    if (written === false || (written === undefined && builtin === undefined)) return undefined;

    const prefix = 'voice.' + key;
    //G 单独配置语音模型时必须先满足主备对象的结构；没写时只用内置断句模型。
    const input = checks.checkRecord(written ?? {}, prefix);
    const localWritten = input['local_model'];
    //M 没写模型段、或本地线路写的就是内置断句模型：用内置的。
    let local: string | undefined;
    if (written === undefined || localWritten === builtin) {
      local = builtin;
    }

    //G 其余线路都要写成“供应商名/模型 ID”，供应商要在 providers 里。
    if (localWritten !== undefined && localWritten !== builtin) {
      local = checks.checkModelRef(localWritten, prefix + '.local_model', providers);
    }
    let cloud: string | undefined;
    if (input['cloud_model'] !== undefined) {
      cloud = checks.checkModelRef(input['cloud_model'], prefix + '.cloud_model', providers);
    }

    //G 至少一条线路，两条不能相同。
    if (local === undefined && cloud === undefined) throw new Error(prefix + ' 至少配置一条模型线路');
    if (local !== undefined && local === cloud) throw new Error(prefix + ' 的本地和云端模型要不同');

    const prefer = checks.checkAllowedValue(input['prefer'] ?? 'local', PREFERS, prefix + '.prefer');

    //M 每条模型各有期限，断句失败还可及时沿用静音规则：内置断句 400 毫秒，外部模型 2500 毫秒。
    let fallback = 400;
    if (builtin === undefined) {
      fallback = 2500;
    }
    const timeoutMs = count(input['timeout_ms'], key + '.timeout_ms', fallback);
    return { local, cloud, prefer, timeoutMs };
  }

  //==========================================================
  //M 开关、插话、机器人和连接路径
  //==========================================================
  const enabled = checks.checkFlag(voice['enabled'] ?? false, 'voice.enabled');

  //M 默认双工：barge_in 不写就是开。
  const interrupt = checks.checkFlag(voice['barge_in'] ?? true, 'voice.barge_in');
  const minChars = count(voice['barge_in_min_chars'], 'barge_in_min_chars', 3);
  const echoWritten = voice['barge_in_echo_similarity'] ?? 0.75;
  const echoSimilarity = checks.checkNumber(echoWritten, 'voice.barge_in_echo_similarity', SIMILARITY);
  let bargeIn: BargeIn | undefined;
  if (interrupt) {
    bargeIn = { minChars, echoSimilarity };
  }

  //M bot 可以留空：留空时按 start.bot、第一个机器人取。
  const bot = voice['bot'] ?? '';
  if (typeof bot !== 'string') throw new Error('voice.bot 要是字符串');

  //G 升级路径要在 /api/ 下，不能和状态接口撞。
  const wsPath = voice['ws_path'] ?? DEFAULT_WS;
  if (typeof wsPath !== 'string' || !/^\/api\/[A-Za-z0-9_/-]+$/u.test(wsPath)
    || wsPath.includes('//') || wsPath === STATUS_PATH) {
    throw new Error('voice.ws_path 要是 /api/ 下的静态路径');
  }
  const sampleRate = voice['sample_rate'];
  if (sampleRate !== undefined && sampleRate !== asrModule.SAMPLE_RATE) {
    throw new Error('voice.sample_rate 只支持 16000');
  }

  //==========================================================
  //M 转写和合成的后端
  //==========================================================
  const provider = checks.checkAllowedValue(asr['provider'] ?? 'sherpa', PROVIDERS, 'voice.asr.provider');
  let asrFallback: Settings['asrFallback'];
  if (asr['fallback'] !== undefined) {
    asrFallback = checks.checkAllowedValue(asr['fallback'], ASR_FALLBACKS, 'voice.asr.fallback');
  }
  if (asrFallback !== undefined && (provider === 'fake' || (provider === 'sherpa') === (asrFallback === 'sherpa'))) {
    throw new Error('voice.asr.fallback 要与 asr.provider 分别位于本地和云端');
  }

  //M 云端不同协议各自保留已验证的默认模型。
  const bailianWritten = asr['bailian_model'] ?? 'fun-asr-realtime';
  const xiaomiWritten = asr['xiaomi_model'] ?? 'mimo-v2.5-asr';
  const bailian = checks.checkNonEmptyText(bailianWritten, 'voice.asr.bailian_model');
  const xiaomi = checks.checkNonEmptyText(xiaomiWritten, 'voice.asr.xiaomi_model');
  const asrModels = { bailian, xiaomi };

  //M 合成没写备选时：小米主选默认退到本地，本地主选默认不备。
  const speaker = checks.checkAllowedValue(tts['provider'] ?? 'xiaomi', TTS_PROVIDERS, 'voice.tts.provider');
  let fallbackDefault = 'none';
  if (speaker === 'xiaomi') {
    fallbackDefault = 'local';
  }
  const fallbackWritten = tts['fallback'] ?? fallbackDefault;
  const preferredFallback = checks.checkAllowedValue(fallbackWritten, TTS_FALLBACKS, 'voice.tts.fallback');
  if (preferredFallback === speaker) throw new Error('voice.tts.fallback 要与 tts.provider 不同');

  let ttsFallback: TtsProvider | undefined;
  if (preferredFallback !== 'none') {
    ttsFallback = preferredFallback;
  }
  const preset = checks.checkNonEmptyText(tts['voice'] ?? 'mimo_default', 'voice.tts.voice');
  const synthesis = { provider: speaker, fallback: ttsFallback, voice: preset };

  //==========================================================
  //M 断句、任务判断的阈值和模型
  //==========================================================
  //G 判断阈值只允许 0 到 1，拒绝颠倒的通过和拒绝线。
  const allowAt = checks.checkNumber(judge['allow_at'] ?? 0.8, 'voice.judge.allow_at', PROBABILITY);
  const denyAt = checks.checkNumber(judge['deny_at'] ?? 0.3, 'voice.judge.deny_at', PROBABILITY);
  if (allowAt < denyAt) throw new Error('voice.judge.allow_at 不能小于 deny_at');

  //M 只把已验证的字段交给连接、转写和派发实现。
  const silenceMs = count(turn['silence_ms'], 'turn.silence_ms', 1200);
  const maxUtteranceMs = count(turn['max_utterance_ms'], 'turn.max_utterance_ms', 60_000);
  const tasks: taskModule.TaskSettings = {
    minChars: count(judge['min_chars'], 'judge.min_chars', 6),
    stepChars: count(judge['step_chars'], 'judge.step_chars', 12),
    stepMs: count(judge['step_ms'], 'judge.step_ms', 1000),
    allowAt,
    denyAt,
    timeoutMs: count(judge['timeout_ms'], 'judge.timeout_ms', 12_000),
    maxPerMinute: count(judge['max_per_minute'], 'judge.max_per_minute', 30),
    mergeWindowMs: count(turn['merge_window_ms'], 'turn.merge_window_ms', 30_000),
  };

  //M 理解与断句单独选模型，使用者可只改其中一项。
  const understanding = getModels(judge['models'], 'judge.models');
  //M 断句优先用内置的轻量中文模型。
  const detector = getModels(turn['detector'], 'turn.detector', turnModel.LOCAL_TURN_MODEL);
  let boundary: Settings['turn'];
  if (detector !== undefined) {
    const pauseMs = count(turn['pause_ms'], 'turn.pause_ms', 300);
    const maxPerMinute = count(turn['max_per_minute'], 'turn.max_per_minute', 30);
    boundary = { models: detector, pauseMs, maxPerMinute };
  }
  return {
    enabled, bot, wsPath, provider, asrFallback, asrModels, silenceMs, maxUtteranceMs,
    tasks, understanding, turn: boundary, tts: synthesis, bargeIn,
  };
}
