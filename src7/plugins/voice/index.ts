/** voice：接入浏览器麦克风，让当前连接查看字幕，并把判断通过的语音交给机器人。 */

import * as path from 'node:path';
import * as timers from 'node:timers/promises';
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as channel from '../../Channels.ts';
import * as requests from '../../utils/RequestEvent.ts';
import * as asrModule from './Asr.ts';
import * as cloudAsr from './CloudAsr.ts';
import * as models from './Models.ts';
import * as replyModule from './Replies.ts';
import * as routedAsr from './RoutedAsr.ts';
import * as routes from './Routes.ts';
import * as taskModule from './Tasks.ts';
import * as ttsModule from './Tts.ts';
import * as turnModule from './Turn.ts';
import * as turnModel from './TurnModel.ts';

export const name = 'voice';
export const version = '0.5.0';
export const inject = ['resources', 'http', 'sessions'];

type Provider = 'fake' | 'sherpa' | 'bailian' | 'xiaomi';
type TtsProvider = 'xiaomi' | 'local';
type State = 'idle' | 'listening' | 'error';

interface Settings {
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
  /** 要优先使用的合成后端与音色。 */
  tts: { provider: TtsProvider; fallback?: TtsProvider; voice: string };
}

/** 插件已准备好的判断服务，连接只保留本轮断句状态。 */
interface Judging {
  /** 可选语音任务理解模型。 */
  understand?: models.Predict;
  /** 主、备理解均耗尽时的最长等待。 */
  understandWaitMs?: number;
  /** 可选断句配置及模型。 */
  turn?: { predict: models.Predict; pauseMs: number; maxPerMinute: number };
}

type VoiceRequest = requests.RequestEnvelope & (
  | { action: 'status' }
  | { action: 'speak'; text: string; interrupt?: boolean; group?: string }
  | { action: 'stop'; group?: string }
);

interface VoiceResult extends requests.ResultEnvelope {
  /** 状态是否可用。 */
  ok: boolean;
  /** 配置、依赖或识别后端不可用的原因。 */
  error?: string;
  /** 当前连接是否已经开始听。 */
  listening: boolean;
  /** 有无浏览器连接。 */
  clients: number;
  /** 当前是否有播报在生成或播放。 */
  speaking?: boolean;
}

declare module 'cordis' {
  interface Events {
    /** 语音状态以及可按来源组发起或取消的播报。 */
    'voice/request'(request: VoiceRequest): void | Promise<void>;
    /** 状态结果，携带现有连接信息，不含字幕。 */
    'voice/result'(result: VoiceResult): void;
    /** 每次更新某句短暂转写。 */
    'voice/transcript'(event: taskModule.Transcript): void;
    /** 听写状态变化。 */
    'voice/state'(event: { state: State; reason?: string }): void;
  }
}

interface Notice {
  /** 客户端可本地化的固定错误码。 */
  code: string;
  /** 默认中文提示。 */
  message: string;
}

interface Status {
  /** 用户是否启用插件。 */
  enabled: boolean;
  /** 此部署可否接通听写。 */
  available: boolean;
  /** 后端升级路径。 */
  wsPath: string;
  /** 缺依赖或没启用时的固定提示。 */
  error?: Notice;
}

type RawFrame = Buffer | ArrayBuffer | Buffer[];

/** 只使用 ws 在本阶段需要的连接接口。 */
export interface VoiceSocket {
  /** WebSocket 当前状态；1 表示仍打开。 */
  readonly readyState: number;
  /** 把字幕或 PCM 音频帧交回同一连接。 */
  send(data: string | Buffer): void;
  /** 向当前浏览器结束连接。 */
  close(code?: number): void;
  /** 文本和二进制共享 WebSocket 消息入口。 */
  on(name: 'message', handler: (data: RawFrame, isBinary: boolean) => void): void;
  /** 断开与异常都释放转写流。 */
  on(name: 'close' | 'error', handler: () => void): void;
}

const DISABLED: Notice = { code: 'voice-disabled', message: '语音听写未启用' };
const NO_ASR: Notice = { code: 'asr-model-missing', message: '本地转写还没装好' };
const NO_WS: Notice = { code: 'websocket-missing', message: '语音服务缺少 WebSocket 依赖' };
const BAD_FRAME: Notice = { code: 'invalid-frame', message: '语音帧无效，第一帧必须是 start' };
const ASR_FAILED: Notice = { code: 'asr-failed', message: '语音转写失败' };
const NO_BOT: Notice = { code: 'voice-no-bot', message: '没有选定接收语音任务的机器人' };
const TASK_FAILED: Notice = { code: 'voice-task-failed', message: '机器人没有接收这条语音任务' };
const DEFAULT_WS = '/api/voice/ws';
const STATUS_PATH = '/api/voice/status';
const OPEN = 1;
const PLAYBACK_MARGIN_MS = 100;
const ASR_STOP_WAIT_MS = 22_000;

/** 排队或正在发送的播报，图片类调用用 group 限定自己的取消范围。 */
interface Speech {
  /** 当前语音帧组，浏览器只可确认在播的组。 */
  utterId?: string;
  /** 告知标准文字回复，音频有无实际播放。 */
  onPlayed?: (played: boolean) => void;
  /** 这一句要合成的可见文本。 */
  text: string;
  /** 调用方可选的取消分组。 */
  group?: string;
  /** 只取消这一句的生成和播放等待。 */
  controller: AbortController;
  /** 按已发 PCM 样本数估计的播放结束时刻。 */
  audibleUntil: number;
}

/** 读取配置对象；只在调用入口补默认值。 */
function getObject(value: unknown, key: string): Record<string, unknown> {
  if (value === undefined) return {};

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(key + ' 要是对象');
}

/** 在语音配置入口读取供应商模型 ID 或默认值。 */
function getModelId(raw: unknown, key: string, fallback: string): string {
  if (raw === undefined) return fallback;

  if (typeof raw !== 'string' || raw.trim() === '') throw new Error(key + ' 要是非空字符串');

  return raw.trim();
}

/** 在插件入口校验语音配置，默认关闭。 */
function getSettings(raw: unknown): Settings {
  //G 把读取与验证集中在插件入口，错误仅指出配置键。
  const voice = getObject(raw, 'voice');
  const asr = getObject(voice['asr'], 'voice.asr');
  const turn = getObject(voice['turn'], 'voice.turn');
  const judge = getObject(voice['judge'], 'voice.judge');
  const tts = getObject(voice['tts'], 'voice.tts');

  function number(value: unknown, key: string, fallback: number): number {
    if (value === undefined) return fallback;

    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new Error('voice.' + key + ' 要是正整数');
    }
    return value;
  }

  function probability(key: string, fallback: number): number {
    const value = judge[key];
    if (value === undefined) return fallback;

    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error('voice.judge.' + key + ' 要是 0 到 1 之间的数');
    }
    return value;
  }

  /** 校验语音模型的主备写法，不替使用者隐式启用外部供应商。 */
  function getModels(
    written: unknown,
    key: string,
    builtin?: string,
  ): models.ModelSettings | undefined {
    if (written === false || (written === undefined && builtin === undefined)) return undefined;

    const prefix = 'voice.' + key;
    //G 单独配置语音模型时必须先满足主备对象的结构。
    const input = getObject(written, prefix);
    let local = input['local_model'];
    const cloud = input['cloud_model'];
    if (written === undefined) {
      local = builtin;
    }
    const modelRef = /^[\w.-]+\/[^\s/][^\s]*$/u;
    if (local !== undefined && (typeof local !== 'string' || (local !== builtin && !modelRef.test(local)))) {
      throw new Error(prefix + '.local_model 要写成供应商名/模型 ID 或本插件内置断句模型');
    }
    if (cloud !== undefined && (typeof cloud !== 'string' || !modelRef.test(cloud))) {
      throw new Error(prefix + '.cloud_model 要写成供应商名/模型 ID');
    }
    if (local === undefined && cloud === undefined) {
      throw new Error(prefix + ' 至少配置一条模型线路');
    }
    if (local !== undefined && local === cloud) throw new Error(prefix + ' 的本地和云端模型要不同');

    const prefer = input['prefer'] ?? 'local';
    if (prefer !== 'local' && prefer !== 'cloud') {
      throw new Error(prefix + '.prefer 只支持 local 或 cloud');
    }
    //M 每条模型各有期限，断句失败还可及时沿用静音规则。
    const timeoutKey = key + '.timeout_ms';
    let fallback = 400;
    if (builtin === undefined) {
      fallback = 2500;
    }
    //G 只接收正整数毫秒，模型等待有显式的上限。
    const timeoutMs = number(input['timeout_ms'], timeoutKey, fallback);
    return { local, cloud, prefer, timeoutMs };
  }

  let enabled = voice['enabled'];
  if (enabled === undefined) {
    enabled = false;
  }
  if (typeof enabled !== 'boolean') {
    throw new Error('voice.enabled 要是布尔值');
  }
  let bot = voice['bot'];
  if (bot === undefined) {
    bot = '';
  }
  if (typeof bot !== 'string') {
    throw new Error('voice.bot 要是字符串');
  }
  let wsPath = voice['ws_path'];
  if (wsPath === undefined) {
    wsPath = DEFAULT_WS;
  }
  if (typeof wsPath !== 'string' || !/^\/api\/[A-Za-z0-9_/-]+$/u.test(wsPath)
    || wsPath.includes('//') || wsPath === STATUS_PATH) {
    throw new Error('voice.ws_path 要是 /api/ 下的静态路径');
  }
  const sampleRate = voice['sample_rate'];
  if (sampleRate !== undefined && sampleRate !== asrModule.SAMPLE_RATE) {
    throw new Error('voice.sample_rate 只支持 16000');
  }
  let provider = asr['provider'];
  if (provider === undefined) {
    provider = 'sherpa';
  }
  if (provider !== 'fake' && provider !== 'sherpa' && provider !== 'bailian' && provider !== 'xiaomi') {
    throw new Error('voice.asr.provider 只支持 sherpa、bailian、xiaomi 或 fake');
  }
  const asrFallback = asr['fallback'];
  if (asrFallback !== undefined && asrFallback !== 'sherpa'
    && asrFallback !== 'bailian' && asrFallback !== 'xiaomi') {
    throw new Error('voice.asr.fallback 只支持 sherpa、bailian 或 xiaomi');
  }
  if (asrFallback !== undefined && (provider === 'fake' || (provider === 'sherpa') === (asrFallback === 'sherpa'))) {
    throw new Error('voice.asr.fallback 要与 asr.provider 分别位于本地和云端');
  }

  //M 云端不同协议各自保留已验证的默认模型。
  const bailian = getModelId(asr['bailian_model'], 'voice.asr.bailian_model', 'fun-asr-realtime');
  const xiaomi = getModelId(asr['xiaomi_model'], 'voice.asr.xiaomi_model', 'mimo-v2.5-asr');
  const asrModels = { bailian, xiaomi };
  const speaker = tts['provider'] ?? 'xiaomi';
  if (speaker !== 'xiaomi' && speaker !== 'local') {
    throw new Error('voice.tts.provider 只支持 xiaomi 或 local');
  }
  const preferredFallback = tts['fallback'];
  if (preferredFallback !== undefined && preferredFallback !== 'none'
    && preferredFallback !== 'xiaomi' && preferredFallback !== 'local') {
    throw new Error('voice.tts.fallback 只支持 local、xiaomi 或 none');
  }
  if (preferredFallback === speaker) throw new Error('voice.tts.fallback 要与 tts.provider 不同');

  let ttsFallback: TtsProvider | undefined;
  if (preferredFallback === 'local' || preferredFallback === 'xiaomi') {
    ttsFallback = preferredFallback;
  }
  if (preferredFallback === undefined && speaker === 'xiaomi') {
    ttsFallback = 'local';
  }
  const preset = tts['voice'] ?? 'mimo_default';
  if (typeof preset !== 'string' || preset.trim() === '') {
    throw new Error('voice.tts.voice 要是非空字符串');
  }

  //G 判断阈值只允许合法区间，拒绝颠倒的通过和拒绝线。
  const allowAt = probability('allow_at', 0.8);
  const denyAt = probability('deny_at', 0.3);
  if (allowAt < denyAt) {
    throw new Error('voice.judge.allow_at 不能小于 deny_at');
  }

  //M 只把已验证的字段交给连接、转写和派发实现。
  const silenceMs = number(turn['silence_ms'], 'turn.silence_ms', 1200);
  const maxUtteranceMs = number(turn['max_utterance_ms'], 'turn.max_utterance_ms', 60_000);
  const tasks: taskModule.TaskSettings = {
    minChars: number(judge['min_chars'], 'judge.min_chars', 6),
    stepChars: number(judge['step_chars'], 'judge.step_chars', 12),
    stepMs: number(judge['step_ms'], 'judge.step_ms', 1000),
    allowAt,
    denyAt,
    timeoutMs: number(judge['timeout_ms'], 'judge.timeout_ms', 12_000),
    maxPerMinute: number(judge['max_per_minute'], 'judge.max_per_minute', 30),
    mergeWindowMs: number(turn['merge_window_ms'], 'turn.merge_window_ms', 30_000),
  };
  const synthesis = { provider: speaker, fallback: ttsFallback, voice: preset.trim() } as const;
  //M 理解与断句单独选模型，使用者可只改其中一项。
  const understanding = getModels(judge['models'], 'judge.models');
  //M 断句优先用内置的轻量中文模型。
  const detector = getModels(turn['detector'], 'turn.detector', turnModel.LOCAL_TURN_MODEL);
  let boundary: Settings['turn'];
  if (detector !== undefined) {
    const pauseMs = number(turn['pause_ms'], 'turn.pause_ms', 300);
    const maxPerMinute = number(turn['max_per_minute'], 'turn.max_per_minute', 30);
    boundary = { models: detector, pauseMs, maxPerMinute };
  }
  return {
    enabled, bot, wsPath, provider, asrFallback, asrModels, silenceMs, maxUtteranceMs,
    tasks, understanding, turn: boundary, tts: synthesis,
  };
}

/** 把 ws 原始数据整理为可读 PCM 或 UTF-8 文本的连续内存。 */
function getBytes(raw: RawFrame): Buffer {
  if (Buffer.isBuffer(raw)) return raw;

  if (Array.isArray(raw)) return Buffer.concat(raw);

  return Buffer.from(raw);
}

/** 这个连接的唯一转写流。关闭和被替换都立即释放音频处理。 */
class VoiceConnection {
  private stream?: asrModule.Asr;
  private began = false;
  private closed = false;
  private seq = 1;
  private partial = '';
  private tasks?: taskModule.VoiceTasks;
  private turn?: turnModule.Turn;
  private stopping = false;
  private readonly messageIds = new Set<string>();
  private queue: Speech[] = [];
  private playing?: Speech;
  private nextUtterance = 0;

  /** 留下上下文与自己的连接，给下一次 start 创建新的转写流。 */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly socket: VoiceSocket,
    private readonly defaultBot: string,
    private readonly createAsr?: asrModule.AsrFactory,
    private readonly provider: Provider = 'fake',
    private readonly taskSettings?: taskModule.TaskSettings,
    private readonly speak?: ttsModule.Speak,
    private readonly models?: Judging,
  ) {}

  /** 连接是否正在转写。 */
  get listening(): boolean {
    return this.stream !== undefined;
  }

  /** 取得当前连接的任务处理器，供自己的渠道认领和收尾事件使用。 */
  get currentTasks(): taskModule.VoiceTasks | undefined {
    return this.tasks;
  }

  /** 把结果只给提交该消息的连接；已换页面或没有来源时交由协议回报失败。 */
  reply(
    text: string,
    messageId: string,
    kind: channel.ReplyKind,
    group?: string,
    onPlayed?: (played: boolean) => void,
  ): boolean {
    const owns = this.messageIds.has(messageId) || this.tasks?.isSending(messageId) === true;
    if (this.closed || !owns || this.socket.readyState !== OPEN) return false;

    //M 只回给原连接，普通文件或群消息不能通过当前连接转发。
    const frame = { type: 'reply', text, kind };
    this.send(frame);

    if (kind === 'final') {
      //M 文字立即送达；声音按同一连接的回复顺序排队。
      const accepted = this.enqueueSpeech(text, group, false, onPlayed);
      if (!accepted) {
        onPlayed?.(false);
      }
    }
    return true;
  }

  /** 将可选分组文本排入当前连接，interrupt 只替换匹配的组。 */
  enqueueSpeech(raw: string, group?: string, interrupt = false, onPlayed?: (played: boolean) => void): boolean {
    const speak = this.speak;
    const text = raw.trim();
    if (this.closed || !this.began || this.socket.readyState !== OPEN || !speak || text === '') return false;

    if (interrupt) {
      //M 同组已播或排队的内容过时后，才开始新讲解。
      this.stopSpeech(group);
    }
    const job = { text, group, onPlayed, controller: new AbortController(), audibleUntil: 0 };
    //M 保留申请顺序，组内替换后的任务仍需排在普通回复之后。
    this.queue.push(job);
    //M 只让一个任务占用客户端播放队列，避免同组取消误伤普通答复。
    void this.drainSpeech(speak);
    return true;
  }

  /** 停止匹配组。普通对话的音频不会和屏幕组共用在途播放。 */
  stopSpeech(group?: string): void {
    this.queue = this.queue.filter((job) => {
      if (group !== undefined && job.group !== group) return true;

      //G 已取消的排队语音立即交回未播结果。
      job.onPlayed?.(false);
      return false;
    });
    const active = this.playing;
    if (active === undefined || (group !== undefined && active.group !== group)) return;

    //G 打断前结束还在等待浏览器确认的播报。
    active.onPlayed?.(false);
    active.onPlayed = undefined;
    active.controller.abort();
    if (active.audibleUntil > performance.now()) {
      //M 已送到浏览器的同组音频需要同步清掉。
      this.send({ type: 'stop-audio' });
    }
    active.audibleUntil = 0;
  }

  /** 当前正生成音频或正在等待这段音频播放完。 */
  get speaking(): boolean {
    return this.playing !== undefined;
  }

  /** 按顺序生成，每段都让浏览器播完才交给下一段。 */
  private async drainSpeech(speak: ttsModule.Speak): Promise<void> {
    if (this.playing !== undefined || this.closed) return;

    let job = this.queue.shift();
    while (job !== undefined && !this.closed) {
      this.playing = job;
      try {
        //M 一个任务负责它的全部音频和播放余量。
        await this.play(job, speak);
      } catch {
        //G 连接已结束时无需让失败影响队列中的随后回复。
      } finally {
        //M 合成结束而未等到浏览器确认时，文字照常保留。
        job.onPlayed?.(false);
        this.playing = undefined;
      }
      job = this.queue.shift();
    }
  }

  /** 给连续 PCM 帧标明采样率。云流失败转本地时停播未完成的片段。 */
  private async play(job: Speech, speak: ttsModule.Speak): Promise<void> {
    const signal = job.controller.signal;
    if (signal.aborted) return;

    let utterId: string | undefined;
    let activeRate: number | undefined;
    let place: routes.Place | undefined;
    const report: routes.Report = (actual, reason) => {
      if (signal.aborted) return;

      if (place !== undefined && place !== actual && utterId !== undefined) {
        //M 同采样率的备选也从头合成，需要先清掉旧线路留在队列的声音。
        this.send({ type: 'stop-audio' });
        job.audibleUntil = 0;
        activeRate = undefined;
        utterId = undefined;
      }
      place = actual;
      //M 标记实际产生 PCM 的线路。
      this.reportRoute('tts', actual, reason);
    };
    const publish = (audio: ttsModule.AudioChunk): void => {
      if (signal.aborted) return;

      if (audio.sampleRate !== activeRate) {
        if (utterId !== undefined) {
          //M 云端退回本地时停播旧采样率的剩余音频。
          this.send({ type: 'stop-audio' });
          job.audibleUntil = 0;
        }
        this.nextUtterance += 1;
        utterId = 'voice-' + this.nextUtterance;
        job.utterId = utterId;
        activeRate = audio.sampleRate;
        const start = { type: 'audio-start', utterId, format: 'pcm_s16le', sampleRate: activeRate };
        //M 让浏览器按本次实际采样率建立播放段。
        this.send(start);
      }
      //M 二进制帧只在音频元数据和结束标记之间出现。
      this.send(audio.pcm);
      const now = performance.now();
      const duration = audio.pcm.length * 500 / audio.sampleRate;
      job.audibleUntil = Math.max(job.audibleUntil, now + PLAYBACK_MARGIN_MS) + duration;
    };

    try {
      //M 合成的传输步骤沿用当前连接的取消信号。
      await speak(job.text, signal, publish, report);
    } catch (error) {
      if (!signal.aborted) {
        //M 合成故障不关闭字幕连接。
        const reason = routes.getFailure(error, '语音合成失败');
        this.reportRoute('tts', undefined, reason);
        this.send({ type: 'audio-error', code: 'tts-unavailable' });
      }
    } finally {
      if (utterId !== undefined && !signal.aborted) {
        //M 结束音频输入后，客户端把已排队的声音播完。
        this.send({ type: 'audio-end', utterId });
      }
    }
    if (signal.aborted) return;

    const remaining = job.audibleUntil - performance.now();
    if (remaining > 0) {
      //M 保留浏览器播放余量。定向 stop 刚停止本段时立即放行下一段。
      await timers.setTimeout(remaining, undefined, { signal }).catch(() => {});
    }
  }

  /** 接收一个 WS transport 已拆包的帧。无合法首帧时回错并关闭。 */
  accept(raw: RawFrame, binary: boolean): void {
    if (this.closed) return;

    //M 收包阶段只处理当前连接；在 stop 后忽略后续音频。
    const bytes = getBytes(raw);
    if (!binary) {
      this.control(bytes);
      return;
    }
    if (!this.began) {
      this.fail(BAD_FRAME, 4400);
      return;
    }
    const stream = this.stream;
    if (stream === undefined || this.stopping) return;

    if (bytes.length === 0 || bytes.length % 2 !== 0) {
      //G 未开始转写的连接不能先发音频。
      this.fail(BAD_FRAME, 4400);
      return;
    }

    //M 按协议解码有符号小端 PCM，保留原有样本顺序和数值。
    const pcm = new Int16Array(bytes.length / 2);
    for (let index = 0; index < pcm.length; index += 1) {
      pcm[index] = bytes.readInt16LE(index * 2);
    }
    try {
      stream.accept(pcm);
      const cut = stream.cut;
      if (cut !== undefined && this.turn !== undefined) {
        //M 把这一帧的新字幕和声能一起用来判断是否可提前收尾。
        const endTurn = (): void => cut.call(stream);
        this.turn.accept(pcm, endTurn);
      }
    } catch {
      //G 识别引擎异常只回固定提示，错误中不能回送音频。
      this.fail(ASR_FAILED, 4500);
    }
  }

  /** 连接断开或被取代时释放转写，不再对旧连接回字幕。 */
  dispose(code?: number): void {
    if (this.closed) return;

    this.closed = true;
    //M 断开时取消该连接的全部语音。
    this.stopSpeech();
    this.tasks?.dispose();
    this.tasks = undefined;
    this.turn?.reset();
    this.turn = undefined;
    this.messageIds.clear();
    const stream = this.stream;
    this.stream = undefined;
    this.partial = '';
    stream?.close();
    if (code !== undefined && this.socket.readyState === OPEN) {
      //M 服务端主动结束时给浏览器返回对应关码。
      this.socket.close(code);
    }
  }

  /** 解析文本帧，只在 start 时创建 ASR。stop 后仍接 ping 或下一次 start。 */
  private control(raw: Buffer): void {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('需要对象');
      }
      message = parsed as Record<string, unknown>;
    } catch {
      //G JSON 形状不可读时只回固定提示并关闭。
      this.fail(BAD_FRAME, 4400);
      return;
    }

    //G 首帧必须是 start，否则关闭，避免进错会话。
    const type = message['type'];
    if (!this.began && type !== 'start') {
      this.fail(BAD_FRAME, 4400);
      return;
    }
    if (type === 'start') {
      //G 旧网页可以省略 device，提供时只接受浏览器生成的 UUID。
      const bot = message['bot'];
      const lang = message['lang'];
      const device = message['device'];
      const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
      const invalidDevice = device !== undefined && (typeof device !== 'string' || !idPattern.test(device));
      if ((bot !== undefined && typeof bot !== 'string') || (lang !== undefined && typeof lang !== 'string')
        || invalidDevice) {
        this.fail(BAD_FRAME, 4400);
        return;
      }

      //M 重复 start 复用当前转写流，已停止的连接才创建新的流。
      this.start(bot || this.defaultBot, device);
      return;
    }
    if (type === 'ping') {
      this.send({ type: 'pong' });
      return;
    }
    if (type === 'audio-played') {
      const job = this.playing;
      const playedId = message['utterId'];
      if (job?.utterId !== undefined && playedId === job.utterId) {
        //G 只承认这个连接当前仍在播放的回复。
        job.onPlayed?.(true);
        job.onPlayed = undefined;
      }
      return;
    }
    if (type === 'stop') {
      this.stop();
      return;
    }

    //G 不认识的控制动作不能进入转写。
    this.fail(BAD_FRAME, 4400);
  }

  /** 创建转写流，随后向客户端确认可发送音频。 */
  private start(bot: string, device?: string): void {
    if (this.stream !== undefined || this.stopping) return;

    //G 未部署真实转写时提供明确状态，不切到假后端。
    if (this.createAsr === undefined) {
      this.fail(NO_ASR, 4500);
      return;
    }

    if (this.taskSettings !== undefined && bot === '') {
      //G 找不到接收方时不把识别文字提交给决策。
      this.fail(NO_BOT, 4400);
      return;
    }

    try {
      if (this.taskSettings !== undefined) {
        //M 一轮录音独享自己的判断和任务回执，模拟 ASR 的部署不走这条路。
        const onTask = (task: taskModule.VoiceTask, messageId: string): void => {
          this.messageIds.add(messageId);
          if (this.messageIds.size > 200) {
            const oldest = this.messageIds.values().next().value;
            if (oldest !== undefined) {
              this.messageIds.delete(oldest);
            }
          }

          //M 只有后端确认认领的任务才发给浏览器。
          const frame = { type: 'task', ...task };
          this.send(frame);
        };
        const onFailure = (): void => this.fail(TASK_FAILED, 4500);
        //M 把真实字幕交给这轮的任务处理器，并绑定本连接回执。
        const decide = this.models?.understand;
        const report = (place?: routes.Place, reason?: string): void => this.reportRoute('judge', place, reason);
        //M 把浏览器设备号带到各句的标准渠道地址里。
        this.tasks = new taskModule.VoiceTasks(
          this.ctx, bot, this.taskSettings, onTask, onFailure, decide, report, device,
        );
      }
      const boundary = this.models?.turn;
      if (boundary !== undefined) {
        const report = (place?: routes.Place, reason?: string): void => this.reportRoute('turn', place, reason);
        const { predict, pauseMs, maxPerMinute } = boundary;
        //M 每轮 start 单独计停顿和判断次数。
        this.turn = new turnModule.Turn(predict, pauseMs, maxPerMinute, report);
      }

      //M 接上当前连接自己的字幕回调，不让前一轮的异步回调串进下一轮。
      const stream = this.createAsr();
      this.stream = stream;
      this.began = true;
      stream.onPartial = (text) => {
        if (this.stream !== stream) return;

        //M 中间结果只更新创建此识别流的连接。
        this.publish(text, false);
      };
      stream.onFinal = (text) => {
        if (this.stream !== stream) return;

        //M 最终结果也须来自当前这轮识别流。
        this.publish(text, true);
      };
      stream.onProvider = (place, reason) => {
        if (this.stream !== stream) return;

        //M 只有已接上的线路能改变页面当前标记。
        this.reportRoute('asr', place, reason);
      };
      stream.onReset = () => {
        if (this.stream !== stream) return;

        //G 预留给备选转写的同一个句号不再使用旧线路的临时文本。
        this.partial = '';
        this.turn?.reset();
        this.tasks?.invalidate(this.seq);
        this.reportRoute('asr');
      };
      stream.onError = (reason) => {
        if (this.stream !== stream) return;

        //G 所有配置的转写线路都已用尽，保留固定故障原因。
        this.reportRoute('asr', undefined, reason);
        this.fail(ASR_FAILED, 4500);
      };
      const ready = { type: 'ready', asr: this.provider, sampleRate: asrModule.SAMPLE_RATE, bot };
      let stopWaitMs = 1500;
      if (this.taskSettings !== undefined) {
        //M 停麦之后为仍在执行的判断及最终句保留两次等待机会。
        const decisionMs = this.models?.understandWaitMs ?? this.taskSettings.timeoutMs;
        stopWaitMs += 2 * decisionMs + ASR_STOP_WAIT_MS;
      }

      //M 通知网页已能接收音频，随后发布正在听的状态。
      this.send({ ...ready, stopWaitMs });
      this.setState('listening');
    } catch {
      //G 转写引擎无法启动时结束此连接。
      this.fail(ASR_FAILED, 4500);
    }
  }

  /** 停止收 PCM，将最后的半句作为 final 发完，再进入 idle。 */
  private stop(): void {
    if (this.stopping) return;

    this.stopping = true;
    this.turn?.reset();
    this.turn = undefined;
    const stream = this.stream;
    try {
      //M 实际识别器先把已收到的最后几个音节解完。
      const finished = stream?.finish?.();
      if (finished !== undefined) {
        //M 云端最后的回执有界等待，断开时不会把旧结果交给新连接。
        void finished.then(() => this.finishStop(stream)).catch(() => {
          if (this.closed) return;

          //G 只有仍使用这个流的连接需要显示错误。
          this.fail(ASR_FAILED, 4500);
        });
        return;
      }
    } catch {
      //G 同步收尾失败时立即交给当前连接的错误处理。
      this.fail(ASR_FAILED, 4500);
      return;
    }
    //M 同步引擎与测试入口仍在本次停止中交完字幕。
    this.finishStop(stream);
  }

  /** 转写已结束，再等待任务回执后报告 idle。 */
  private finishStop(stream?: asrModule.Asr): void {
    if (this.closed || this.stream !== stream) return;

    this.stream = undefined;
    stream?.close();

    //M 用仍在显示的最近一条 partial 收尾，空句不发送 final。
    this.publish(this.partial, true);
    const tasks = this.tasks;
    if (tasks === undefined) {
      this.stopping = false;
      this.setState('idle');
      return;
    }

    //M 音轨已经断开；最终句的判断和任务回执出齐后再允许浏览器关连接。
    void tasks.finish().then(() => {
      this.tasks = undefined;
      this.stopping = false;
      if (!this.closed) {
        this.setState('idle');
      }
    });
  }

  /** 将线路选择通知当前页，并在 trace 记录切换或失败的固定原因。 */
  private reportRoute(stage: routes.Stage, place?: routes.Place, reason?: string): void {
    const details = { stage, place, reason };
    //M 网页用同一条语音连接更新对应阶段的标记。
    this.send({ type: 'voice-route', ...details });
    if (reason === undefined) return;

    //T 不将供应商响应、音频或字幕写入线路切换记录。
    this.ctx.emit('trace', 'Voice.route', reason, 'reportRoute(stage, place, reason)', details);
  }

  /** 发布本连接内字幕；可选监听者只收到文本事件，音频不进入事件。 */
  private publish(text: string, final: boolean): void {
    const cleaned = text.trim();
    if (cleaned === '') return;

    if (!final && cleaned === this.partial) return;

    //M partial 与对应的 final 使用同一序号，完整结果后才推进句子。
    let type = 'partial';
    if (final) {
      type = 'final';
    }
    const data = { seq: this.seq, text: cleaned };

    //M 逐帧发送给当前浏览器并广播符合契约的字幕通知。
    this.send({ type, ...data });
    const transcript = { ...data, final, at: Date.now() };
    this.ctx.emit('voice/transcript', transcript);

    //M 字幕发出后再判断是否开任务，模型等待不会卡住转写显示。
    this.tasks?.push(transcript);
    this.partial = cleaned;
    if (final) {
      this.turn?.reset();
      this.partial = '';
      this.seq += 1;
      return;
    }
    //M 中途修订会撤掉对应旧字幕的断句判断。
    this.turn?.update(cleaned);
  }

  /** 通知页面和状态事件，供提示当前是否在听。 */
  private setState(state: State, reason?: string): void {
    //M 让页面与内部监听者看到同一听写状态。
    this.send({ type: 'state', state });
    this.ctx.emit('voice/state', { state, reason });
  }

  /** 固定提示只发给当前页面，然后关闭错误连接。 */
  private fail(issue: Notice, code: number): void {
    //M 向当前页面交付固定错误和状态，关闭有问题的连接。
    this.send({ type: 'error', ...issue });
    this.setState('error', issue.code);
    this.dispose(code);
  }

  /** WebSocket 关闭或已替换后跳过消息发送。 */
  private send(frame: Record<string, unknown> | Buffer): void {
    if (this.closed || this.socket.readyState !== OPEN) return;

    if (Buffer.isBuffer(frame)) {
      //M PCM 原样交给 WebSocket，避免转成 JSON 或 base64。
      this.socket.send(frame);
      return;
    }
    const encoded = JSON.stringify(frame);
    //M 通过发起听写的原连接回送结果。
    this.socket.send(encoded);
  }
}

/** 每个插件只维护一个连接；先停旧流，再接受新连接。 */
export class Voice {
  private current?: VoiceConnection;

  /** 收已准备好的转写工厂；没有工厂时 start 报本地转写不可用。 */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly defaultBot: string,
    private readonly createAsr?: asrModule.AsrFactory,
    private readonly provider: Provider = 'fake',
    private readonly taskSettings?: taskModule.TaskSettings,
    private readonly synthesizer?: ttsModule.Speak,
    private readonly judging?: Judging,
  ) {}

  /** 读状态给 status 事件，不把连接对象或转写正文交出去。 */
  get counts(): { listening: boolean; clients: number } {
    const listening = this.current?.listening === true;
    let clients = 0;
    if (this.current !== undefined) {
      clients = 1;
    }
    return { listening, clients };
  }

  /** 接入通过 HTTP 钩子鉴权的 WebSocket。 */
  attach(socket: VoiceSocket): void {
    //M 新连接接管麦克风时关掉旧连接，旧连接稍后 close 时不能删掉新流。
    const old = this.current;
    const connection = new VoiceConnection(
      this.ctx,
      socket,
      this.defaultBot,
      this.createAsr,
      this.provider,
      this.taskSettings,
      this.synthesizer,
      this.judging,
    );
    this.current = connection;
    old?.dispose(4001);

    //M 三个监听只操作它们自己的连接实例。
    const end = (): void => {
      connection.dispose();
      if (this.current !== connection) return;

      this.current = undefined;
      this.ctx.emit('voice/state', { state: 'idle' });
    };
    //M 将本连接的帧和生命周期绑定到自己的转写流。
    socket.on('message', (raw, binary) => {
      //M 按文本或二进制标记把帧交给当前会话。
      connection.accept(raw, binary);
    });
    //M 连接结束时统一清除自己的识别资源。
    socket.on('close', end);
    socket.on('error', end);
  }

  /** 允许自己的新消息在 bot/receive 关口取得一个后台会话。 */
  getTasks(messageId: string): taskModule.VoiceTasks | undefined {
    const tasks = this.current?.currentTasks;
    if (tasks?.isSending(messageId)) return tasks;

    return undefined;
  }

  /** 把结束事件转给正在接收的连接，只更新属于它的任务。 */
  settle(messageId?: string, sessionId?: string): void {
    //M 可能消息协调尚在进行，任务处理器也会记录提前到达的收尾。
    this.current?.currentTasks?.settle(messageId, sessionId);
  }

  /** 将文字送给原连接，至多等 20 秒确认已经播放过一段声音。 */
  async playReply(text: string, request: channel.ChannelReplyRequest): Promise<boolean> {
    const connection = this.current;
    if (connection === undefined) return false;

    const messageId = request.sourceSnapshot.messageId;
    if (request.kind !== 'final') {
      //M 进度回复只送文字。
      connection.reply(text, messageId, request.kind);
      return false;
    }
    const group = request.replyRequestKey;
    const confirmation = Promise.withResolvers<boolean>();
    //M 浏览器确认此音频组实际播放过后，才把回执标成已播。
    const started = connection.reply(text, messageId, request.kind, group, confirmation.resolve);
    if (!started) return false;

    //G 请求即将超时时取消本组，防止未播回执之后意外播放。
    const timeout = setTimeout(() => connection.stopSpeech(group), 20_000);
    try {
      return await confirmation.promise;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 按来源消息号找到同一条连接，后台回复和标准渠道共用这个入口。 */
  sendReply(text: string, messageId: string, kind: channel.ReplyKind): boolean {
    //M 由连接核对消息归属，网页重连后不会收到旧会话的回复。
    return this.current?.reply(text, messageId, kind) === true;
  }

  /** 插件事件只向当前已开始的语音连接添加播报。 */
  speak(text: string, group?: string, interrupt = false): boolean {
    //M 网页连接独享发给它的合成队列。
    return this.current?.enqueueSpeech(text, group, interrupt) === true;
  }

  /** 仅取消指定组，未给组时取消所有。 */
  stopSpeech(group?: string): void {
    //M 向持有播放状态的连接发出取消。
    this.current?.stopSpeech(group);
  }

  /** 供状态事件报告是否正在实际处理播报。 */
  get speaking(): boolean {
    return this.current?.speaking === true;
  }

  /** 插件卸载时释放流和连接。 */
  dispose(): void {
    //M 清理属于此插件的唯一连接，其他服务继续工作。
    const old = this.current;
    this.current = undefined;
    old?.dispose(1001);
  }
}

/**
 * 加载 Fastify WebSocket 能力；缺依赖时只让语音不可用。
 * @returns 安装后的插件入口，或 undefined。
 */
export async function loadWebSocket(): Promise<fastify.FastifyPluginCallback | undefined> {
  try {
    //M 从发布依赖加载 transport；模块尚未安装时走语音专用的不可用状态。
    const module = await import('@fastify/websocket');
    return module.default as fastify.FastifyPluginCallback;
  } catch {
    return undefined;
  }
}

/** 从既有供应商配置取认证和语音端点；找不到时留给线路选择报告。 */
function getCloud(ctx: cordis.Context, name: 'bailian' | 'xiaomi'): { url: URL; apiKey: string } | undefined {
  const provider = ctx.resources.config.providers?.[name];
  if (provider === undefined || provider.apiKey.trim() === '') return undefined;

  try {
    const url = new URL(provider.baseUrl);
    if (name === 'bailian') {
      if (url.protocol === 'https:') {
        url.protocol = 'wss:';
      }
      if (url.protocol !== 'wss:') return undefined;

      if (url.pathname === '/') {
        url.pathname = '/api-ws/v1/inference';
      }
      return { url, apiKey: provider.apiKey };
    }
    if (url.protocol !== 'https:') return undefined;

    //M 小米沿用供应商地址的版本或套餐前缀。
    url.pathname = url.pathname.replace(/\/$/u, '') + '/chat/completions';
    return { url, apiKey: provider.apiKey };
  } catch {
    return undefined;
  }
}

/**
 * 注册语音插件。启用且有 transport 时加 WS；状态查询可报告配置或依赖缺失。
 * @param ctx Cordis 插件上下文。
 * 副作用：在现有 HTTP 上登记路由，接入一个浏览器转写连接。
 */
export async function apply(ctx: cordis.Context): Promise<void> {
  //M 配置解析一次。只在用户明确选 fake 时启动模拟流。
  const raw = ctx.resources.raw['voice'];
  const settings = getSettings(raw);
  const lifetime = new AbortController();
  const root = ctx.resources.root;
  const nativeDir = path.resolve(root, 'program', 'sherpa-onnx');
  const modelsDir = path.resolve(root, 'program', 'voice-models');
  const maxSamples = settings.maxUtteranceMs * asrModule.SAMPLE_RATE / 1000;
  const locations = {
    nativeDir,
    modelsDir,
    silenceMs: settings.silenceMs,
    maxUtteranceMs: settings.maxUtteranceMs,
  };
  let createAsr: asrModule.AsrFactory | undefined;
  let unavailable = NO_ASR;
  if (settings.enabled && settings.provider === 'fake') {
    const { silenceMs, maxUtteranceMs } = settings;
    createAsr = () => new asrModule.FakeAsr(silenceMs, maxUtteranceMs);
  }
  if (settings.enabled && settings.provider !== 'fake') {
    //M 没缺文件才准备本地备选，实际加载推迟到资源守卫已可回执时。
    const sherpaReady = asrModule.hasSherpa(locations);
    let sherpa: asrModule.AsrFactory | undefined;
    let warming: Promise<asrModule.AsrFactory | undefined> | undefined;
    const getSherpa = async (): Promise<asrModule.AsrFactory | undefined> => {
      if (sherpa !== undefined) return sherpa;

      if (warming === undefined) {
        //M 并发的预热与听写连接共用一次模型加载。
        warming = asrModule.loadSherpa(locations).then((factory) => {
          sherpa = factory;
          return factory;
        }).finally(() => {
          warming = undefined;
        });
      }
      return warming;
    };
    const openLocal = async (signal: AbortSignal): Promise<asrModule.Asr> => {
      //G 缺文件时保留明确的失败原因供备用线路记录。
      if (!sherpaReady) throw new routes.RouteFailure(NO_ASR.message);

      //G 每条本地识别流都会加载独享的 VAD，需要先检查当前资源。
      await routes.allowLocal(ctx, signal);
      signal.throwIfAborted();
      //M 在进程中复用已加载的本地转写模型。
      const factory = await getSherpa();
      signal.throwIfAborted();
      if (factory === undefined) throw new routes.RouteFailure('本地转写模型加载失败');

      return factory();
    };
    if (sherpaReady && settings.provider === 'sherpa') {
      //M 守卫可以回执后预热首选模型，避免首次接麦才加载。
      ctx.on('ready', () => {
        const signal = lifetime.signal;
        void routes.allowLocal(ctx, signal).then(() => {
          signal.throwIfAborted();
          return getSherpa();
        }).catch(() => {});
      });
    }
    let canStart = false;
    const choices: routedAsr.AsrRoute[] = [];
    const selected = [settings.provider, settings.asrFallback];
    for (const id of selected) {
      if (id === undefined) continue;

      if (id === 'sherpa') {
        if (sherpaReady) {
          canStart = true;
        }
        //M 始终保留所选主备次序，缺文件也能明确记录退出理由。
        choices.push({ place: 'local', open: openLocal });
        continue;
      }

      //M 只为已配置的转写线路准备该供应商端点。
      const auth = getCloud(ctx, id);
      const missing = '语音转写选了 ' + id + '，请配置 providers.' + id + ' 的地址和密钥';
      if (auth !== undefined) {
        canStart = true;
      }
      if (id === settings.provider) {
        unavailable = { code: 'asr-cloud-unconfigured', message: missing };
      }
      const open = (): asrModule.Asr => {
        //G 未配置当前云端时才启用允许的后备线路。
        if (auth === undefined) throw new routes.RouteFailure(missing);

        const model = settings.asrModels[id];
        const options = { ...auth, model, silenceMs: settings.silenceMs, maxSamples };
        //M 小米整句提交，使用配置的静音和时长分句。
        if (id === 'xiaomi') return new cloudAsr.XiaomiAsr(options);

        //M 百炼用实时双向 WebSocket 逐帧识别。
        return new cloudAsr.BailianAsr(options);
      };
      //M 与其它实现按相同方式交给单连接换线入口。
      choices.push({ place: 'cloud', open });
    }
    if (canStart) {
      const limit = maxSamples * 2;
      //M 连接持有独立的未确认 PCM 与主备线路，不共享用户音频。
      createAsr = () => new routedAsr.RoutedAsr(choices, limit);
    }
  }

  let local: ttsModule.LocalTts | undefined;
  let speak: ttsModule.Speak | undefined;
  if (settings.enabled && settings.provider !== 'fake') {
    const lines: ttsModule.SynthesisRoute[] = [];
    const wanted = [settings.tts.provider, settings.tts.fallback];
    let warming: Promise<ttsModule.LocalTts> | undefined;
    const getLocal = async (): Promise<ttsModule.LocalTts> => {
      if (local !== undefined) return local;

      if (warming === undefined) {
        const signal = lifetime.signal;
        //G 预热和首轮播报共用同一次资源申请。
        warming = routes.allowLocal(ctx, signal).then(() => {
          signal.throwIfAborted();
          local = new ttsModule.LocalTts(nativeDir, modelsDir);
          return local;
        }).finally(() => {
          warming = undefined;
        });
      }
      return warming;
    };
    for (const id of wanted) {
      if (id === undefined) continue;

      if (id === 'local') {
        const produce: ttsModule.SynthesisRoute['produce'] = async (text, signal, emit) => {
          //M 唤醒已准入的本地合成器，首句也复用预热工作。
          const engine = await getLocal();
          //G 停止播报后即使预热成功也不再生成旧音频。
          signal.throwIfAborted();
          const chunk = await engine.generate(text, signal);
          emit(chunk);
        };
        //M MeloTTS 的整句 PCM 也经同一播放入口发回。
        lines.push({ place: 'local', produce });
        //M 资源守卫已注册后尝试预热，临时拒绝可在真正播报时重试。
        ctx.on('ready', () => { void getLocal().catch(() => {}); });
        continue;
      }
      //M 小米沿用运行时供应商的兼容 API 和音色。
      const auth = getCloud(ctx, 'xiaomi');
      let xiaomi: ttsModule.Xiaomi | undefined;
      if (auth !== undefined) {
        xiaomi = { ...auth, voice: settings.tts.voice };
      }
      //M 云端配置不可用也保留该线路的固定失败原因供 trace 记录。
      const route = ttsModule.getXiaomiRoute(xiaomi);
      lines.push(route);
    }
    //M 播放入口只需要一份按优先级排列的线路。
    speak = ttsModule.createSpeaker(lines);
  }

  //M 从资源配置取缺省目标，网页选择和 voice.bot 仍优先。
  let bot = settings.bot;
  const configured = ctx.resources.raw['bots'];
  if (bot === '' && Array.isArray(configured)) {
    const first = configured[0] as { name?: unknown } | undefined;
    if (typeof first?.name === 'string') {
      bot = first.name;
    }
  }
  let taskSettings: taskModule.TaskSettings | undefined;
  if (settings.provider !== 'fake') {
    taskSettings = settings.tasks;
  }

  const judging: Judging = {};
  if (settings.enabled && settings.provider !== 'fake') {
    const signal = lifetime.signal;
    if (settings.understanding !== undefined) {
      //M 语音自选理解线路接入既有快照和任务认领流程。
      const model = new models.Models(ctx, settings.understanding, signal);
      judging.understand = model.predict;
      judging.understandWaitMs = 2 * settings.understanding.timeoutMs;
    }
    if (settings.turn !== undefined) {
      const { models: config, pauseMs, maxPerMinute } = settings.turn;
      const model = new models.Models(ctx, config, signal);
      judging.turn = { predict: model.predict, pauseMs, maxPerMinute };
      //M 内置模型可在资源守卫挂好后预热，不为首句增加启动等待。
      ctx.on('ready', () => model.prewarm());
    }
  }

  //M 用已确定的默认机器人和转写工厂管理语音接收。
  const voice = new Voice(ctx, bot, createAsr, settings.provider, taskSettings, speak, judging);
  const status: Status = {
    enabled: settings.enabled,
    available: false,
    wsPath: settings.wsPath,
    error: DISABLED,
  };
  if (settings.enabled) {
    status.error = unavailable;
  }

  //M 先注册 transport 的握手钩子，然后挂 WS；GET 状态给页面发现实际路径和阻塞原因。
  ctx.http.app.register(async (scope) => {
    if (settings.enabled) {
      const transport = await loadWebSocket();
      if (transport !== undefined) {
        await scope.register(transport);
        const options = {
          method: 'GET' as const,
          url: settings.wsPath,
          handler: (_request: fastify.FastifyRequest, reply: fastify.FastifyReply) => {
            return reply.code(426).send({ error: '请使用 WebSocket 连接' });
          },
          wsHandler: (socket: VoiceSocket) => {
            voice.attach(socket);
          },
        };
        //M 将此路径注册为单向 PCM 和双向控制的升级入口。
        scope.route(options);
      }
      if (createAsr !== undefined) {
        status.error = NO_WS;
        if (transport !== undefined) {
          status.available = true;
          status.error = undefined;
        }
      }
    }

    //M 给网页提供同源路径及当前不可用原因。
    scope.get(STATUS_PATH, async () => status);
  });

  if (settings.enabled) {
    //M 标准回执和后台完成都进同一个语音回复出口。
    const play = (text: string, request: channel.ChannelReplyRequest) => voice.playReply(text, request);
    const replies = new replyModule.VoiceReplies(ctx, play);
    void ctx.inject(['bots'], (sub) => {
      const send: Parameters<typeof sub.bots.channel>[1] = (text, session, origin) => {
        //M 后台到这里后只发标准回复，网页根据回执记一次文字。
        return replies.fromWork(text, session, origin);
      };
      //M 卸载时撤掉语音发送入口及渠道登记。
      sub.effect(() => sub.bots.channel(name, send));
    });

    //M 首次语音任务在已有接收关口认领后台会话，继续遵守渠道的发消息协议。
    ctx.on('bot/receive', (event) => {
      const incoming = event.message;
      const messageId = incoming.sourceId;
      if (!event.fromChannelEvent || incoming.channel !== name || messageId === undefined
        || event.handled || event.session !== undefined) return;

      //G 只认领本插件这次正在送的消息，等待其他渠道的任务不受影响。
      const tasks = voice.getTasks(messageId);
      if (tasks === undefined) return;

      //M 通过骨架创建实际后台会话，机器人继续照既有流程接收这条消息。
      const input = { kind: 'work', bot: incoming.bot, customer: tasks.customer } as const;
      const session = ctx.sessions.create(input);
      tasks.bind(messageId, session.id);
      event.session = session;
    });

    //M 标准渠道收尾和旧式后台的会话收尾都能关闭合并窗口。
    ctx.on('channel/settled', (event) => {
      const source = event.sourceSnapshot;
      if (source.channel !== name || event.stage === 'sending') return;

      //M 标记这条语音来源结束，后到的文字另开任务。
      voice.settle(source.messageId);
    });
    ctx.on('session/change', (session) => {
      const row = session.row;
      if (row.channel !== name || row.kind !== 'work' || row.state === 'running') return;

      //M 直接认领的后台走旧式送达，收尾从骨架会话状态获知。
      voice.settle(undefined, session.id);
    });
  }

  //M 跨插件播报、分组停止与状态共用配对事件。接受只代表成功排队。
  requests.onRequestEvent(ctx, 'voice/request', 'voice/result', (request) => {
    const counts = voice.counts;
    if (request.action === 'status') {
      return { ok: status.available, error: status.error?.message, speaking: voice.speaking, ...counts };
    }
    if (request.action === 'stop') {
      //M 未连接时停止也是幂等操作。
      voice.stopSpeech(request.group);
      return { ok: true, ...counts };
    }
    const interrupt = request.interrupt === true;
    //M 同组停止与替换由当前连接统一处理。
    const accepted = voice.speak(request.text, request.group, interrupt);
    if (!accepted) return { ok: false, error: '没有可播报的语音连接或合成服务', ...counts };

    return { ok: true, ...counts };
  });

  //M 卸载时停止麦克风转写流，关闭本插件的连接。
  ctx.effect(() => () => {
    lifetime.abort();
    voice.dispose();
    local?.dispose();
  });
}
