/** voice：接入浏览器麦克风，让当前连接查看字幕，并把判断通过的语音交给机器人。 */

import * as path from 'node:path';
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as channel from '../../Channels.ts';
import * as requests from '../../utils/RequestEvent.ts';
import * as asrModule from './Asr.ts';
import * as taskModule from './Tasks.ts';

export const name = 'voice';
export const version = '0.2.0';
export const inject = ['resources', 'http', 'sessions'];

type Provider = 'fake' | 'sherpa';
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
  /** 句尾静音长度。 */
  silenceMs: number;
  /** 单句话最长时间。 */
  maxUtteranceMs: number;
  /** 转写通过后使用的派发策略。 */
  tasks: taskModule.TaskSettings;
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
}

declare module 'cordis' {
  interface Events {
    /** 语音请求。本步骤只接 status。 */
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
  /** 把字幕帧交回同一连接。 */
  send(data: string): void;
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

/** 读取配置对象；只在调用入口补默认值。 */
function getObject(value: unknown, key: string): Record<string, unknown> {
  if (value === undefined) return {};

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(key + ' 要是对象');
}

/** 校验参与本阶段的配置，默认关闭；其他阶段的配置留给相应实现。 */
function getSettings(raw: unknown): Settings {
  //G 把读取与验证集中在插件入口，错误仅指出配置键。
  const voice = getObject(raw, 'voice');
  const asr = getObject(voice['asr'], 'voice.asr');
  const turn = getObject(voice['turn'], 'voice.turn');
  const judge = getObject(voice['judge'], 'voice.judge');

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
  if (provider !== 'fake' && provider !== 'sherpa') {
    throw new Error('voice.asr.provider 只支持 fake 或 sherpa');
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
  return { enabled, bot, wsPath, provider, silenceMs, maxUtteranceMs, tasks };
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
  private stopping = false;
  private readonly messageIds = new Set<string>();

  /** 留下上下文与自己的连接，给下一次 start 创建新的转写流。 */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly socket: VoiceSocket,
    private readonly defaultBot: string,
    private readonly createAsr?: asrModule.AsrFactory,
    private readonly provider: Provider = 'fake',
    private readonly taskSettings?: taskModule.TaskSettings,
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
  reply(text: string, request: channel.ChannelReplyRequest): void {
    const messageId = request.sourceSnapshot.messageId;
    const owns = this.messageIds.has(messageId) || this.tasks?.isSending(messageId) === true;
    if (request.sourceSnapshot.channel !== 'voice' || !owns || this.socket.readyState !== OPEN) {
      throw new Error('原语音连接已结束');
    }

    //M 只回给原连接，普通文件或群消息不能通过当前连接转发。
    const frame = { type: 'reply', text, kind: request.kind };
    this.send(frame);
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
    if (stream === undefined) return;

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
    } catch {
      //G 识别引擎异常只回固定提示，错误中不能回送音频。
      this.fail(ASR_FAILED, 4500);
    }
  }

  /** 连接断开或被取代时释放转写，不再对旧连接回字幕。 */
  dispose(code?: number): void {
    if (this.closed) return;

    this.closed = true;
    this.tasks?.dispose();
    this.tasks = undefined;
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
      //G bot 与 lang 是可选的上下文标签，拒绝非字符串。
      const bot = message['bot'];
      const lang = message['lang'];
      if ((bot !== undefined && typeof bot !== 'string') || (lang !== undefined && typeof lang !== 'string')) {
        this.fail(BAD_FRAME, 4400);
        return;
      }

      //M 重复 start 复用当前转写流，已停止的连接才创建新的流。
      this.start(bot || this.defaultBot);
      return;
    }
    if (type === 'ping') {
      this.send({ type: 'pong' });
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
  private start(bot: string): void {
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
        this.tasks = new taskModule.VoiceTasks(this.ctx, bot, this.taskSettings, onTask, onFailure);
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
      const ready = { type: 'ready', asr: this.provider, sampleRate: asrModule.SAMPLE_RATE, bot };
      let stopWaitMs = 1500;
      if (this.taskSettings !== undefined) {
        //M 停麦之后为仍在执行的判断及最终句保留两次等待机会。
        stopWaitMs += 2 * this.taskSettings.timeoutMs;
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

    const stream = this.stream;
    this.stream = undefined;
    stream?.close();

    //M 用仍在显示的最近一条 partial 收尾，空句不发送 final。
    this.publish(this.partial, true);
    const tasks = this.tasks;
    if (tasks === undefined) {
      this.setState('idle');
      return;
    }

    //M 音轨已经断开；最终句的判断和任务回执出齐后再允许浏览器关连接。
    this.stopping = true;
    void tasks.finish().then(() => {
      this.tasks = undefined;
      this.stopping = false;
      if (!this.closed) {
        this.setState('idle');
      }
    });
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
      this.partial = '';
      this.seq += 1;
    }
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
  private send(frame: Record<string, unknown>): void {
    if (this.closed || this.socket.readyState !== OPEN) return;

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

  /** 向唯一的活动连接转发来源匹配的标准渠道回话。 */
  reply(text: string, request: channel.ChannelReplyRequest): void {
    const current = this.current;
    if (current === undefined) {
      throw new Error('原语音连接已结束');
    }

    //M 由连接核对消息归属，换到新标签页时不会串话。
    current.reply(text, request);
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

/**
 * 注册语音插件。启用且有 transport 时加 WS；状态查询可报告配置或依赖缺失。
 * @param ctx Cordis 插件上下文。
 * 副作用：在现有 HTTP 上登记路由，接入一个浏览器转写连接。
 */
export async function apply(ctx: cordis.Context): Promise<void> {
  //M 配置解析一次。只在用户明确选 fake 时启动模拟流。
  const raw = ctx.resources.raw['voice'];
  const settings = getSettings(raw);
  let createAsr: asrModule.AsrFactory | undefined;
  if (settings.enabled && settings.provider === 'fake') {
    createAsr = () => new asrModule.FakeAsr(settings.silenceMs, settings.maxUtteranceMs);
  }
  if (settings.enabled && settings.provider === 'sherpa') {
    const root = ctx.resources.root;
    const locations = {
      nativeDir: path.resolve(root, 'program', 'sherpa-onnx'),
      modelsDir: path.resolve(root, 'program', 'voice-models'),
      silenceMs: settings.silenceMs,
      maxUtteranceMs: settings.maxUtteranceMs,
    };

    //M 把模型与 ABI 已验证后才会使用的绝对目录交给本地识别入口。
    createAsr = await asrModule.loadSherpa(locations);
  }

  //M 用配置好的转写工厂管理本插件唯一的浏览器连接。
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
  if (settings.provider === 'sherpa') {
    taskSettings = settings.tasks;
  }
  //M 用已确定的默认机器人和转写工厂管理语音接收。
  const voice = new Voice(ctx, bot, createAsr, settings.provider, taskSettings);
  const status: Status = {
    enabled: settings.enabled,
    available: false,
    wsPath: settings.wsPath,
    error: DISABLED,
  };
  if (settings.enabled) {
    status.error = NO_ASR;
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

  //M 用骨架的标准文字渠道适配器应答，不直接登记 bots 服务。
  if (settings.enabled) {
    channel.registerTextReply(ctx, {
      channel: name,
      sendDirectText: (text, request) => voice.reply(text, request),
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
      const input = { kind: 'work', bot: incoming.bot, customer: 'voice:本机' } as const;
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

  //M 本阶段只应答状态，语音播放请求继续等待后续的播报监听。
  requests.onRequestEvent(ctx, 'voice/request', 'voice/result', () => {
    return { ok: status.available, error: status.error?.message, ...voice.counts };
  }, { filter: (request) => request.action === 'status' });

  //M 卸载时停止麦克风转写流，关闭本插件的连接。
  ctx.effect(() => () => {
    voice.dispose();
  });
}
