/** 打开麦克风、输出一帧帧 PCM，并维护一次听写的 WebSocket 生命周期。 */

import * as tokenModule from '../Token.ts';
import * as pcm from './VoicePcm.ts';

/** 网页使用的就绪信息。 */
export interface VoiceStatus {
  /** 配置是否启用。 */
  enabled: boolean;
  /** 后端是否可以接听。 */
  available: boolean;
  /** 同源 API 中的 websocket 路径。 */
  wsPath: string;
  /** 后端的固定错误提示。 */
  error?: { code: string };
}

/** 一项由后端确认的语音任务。 */
export interface TaskCaption {
  /** 用于区分不同任务。 */
  taskId: string;
  /** 此次获得认领的文字。 */
  text: string;
  /** 是否继续之前的任务。 */
  merged: boolean;
}

/** 单次听写连接的界面更新。 */
export type VoiceUpdate =
  | { kind: 'ready'; simulated: boolean }
  | { kind: 'partial' | 'final'; seq: number; text: string }
  | { kind: 'task'; task: TaskCaption };

/** 发现后端实际挂载的 WS 路径；尚未安装的部署返回 undefined。 */
export async function getVoiceStatus(signal: AbortSignal): Promise<VoiceStatus | undefined> {
  const headers = new Headers();
  if (tokenModule.TOKEN !== '') {
    headers.set('Authorization', 'Bearer ' + tokenModule.TOKEN);
  }

  //M 使用已有 HTTP 鉴权查询语音是否就绪，避免还没准备好就请求麦克风。
  const response = await fetch('/api/voice/status', { headers, signal });
  if (!response.ok) return undefined;

  const status = await response.json() as VoiceStatus;
  if (typeof status.enabled !== 'boolean' || typeof status.available !== 'boolean'
    || typeof status.wsPath !== 'string' || !/^\/api\/[A-Za-z0-9_/-]+$/u.test(status.wsPath)) {
    return undefined;
  }
  return status;
}

/** 清理浏览器录音设备；也用于申请权限较晚成功时及时释放。 */
function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

/** 单次点「开始听」的设备、音频节点和 WebSocket。 */
export class VoiceCapture {
  private audio?: AudioContext;
  private media?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private socket?: WebSocket;
  private timer?: number;
  private ping?: number;
  private stopWaitMs = 1500;
  private closed = false;
  private stopping = false;
  private ready = false;

  /** 接受同源 WS 路径、选中机器人，以及回报状态/字幕的 UI 回调。 */
  constructor(
    private readonly path: string,
    private readonly bot: string,
    private readonly update: (event: VoiceUpdate) => void,
    private readonly ended: (code?: string) => void,
  ) {}

  /** 在用户点击后申请权限、准备 PCM 转换并接通后端；失败时关闭设备。 */
  async start(): Promise<void> {
    if (!window.isSecureContext || navigator.mediaDevices?.getUserMedia === undefined) {
      this.finish('insecure-context');
      return;
    }

    try {
      //M 受用户操作创建音频上下文，权限成功后把单声道连接到流式采样节点。
      const audio = new AudioContext();
      this.audio = audio;
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      if (this.closed) {
        stopTracks(media);
        return;
      }
      this.media = media;

      //M Worklet 运行在音频线程，以实际设备的采样率持续转换为 100 ms PCM 帧。
      const blob = new Blob([pcm.WORKLET_SOURCE], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await audio.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (this.closed) return;

      this.source = audio.createMediaStreamSource(media);
      this.worklet = new AudioWorkletNode(audio, pcm.WORKLET_NAME, {
        numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit',
      });
      this.worklet.port.onmessage = (event: MessageEvent<unknown>) => {
        const socket = this.socket;
        if (!this.ready || this.stopping || socket?.readyState !== WebSocket.OPEN) return;

        if (!(event.data instanceof ArrayBuffer)) return;

        if (socket.bufferedAmount >= 32_000) {
          this.finish('slow-connection');
          return;
        }
        socket.send(event.data);
      };
      await audio.resume();
      if (this.closed) return;

      //M 音频节点就绪之后联系后端，收到 ready 才开始流送。
      this.connect();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        this.finish('microphone-permission');
        return;
      }
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        this.finish('microphone-missing');
        return;
      }
      this.finish('microphone-failed');
    }
  }

  /** 立即关麦，等待服务器 final/idle，再断开连接。 */
  stop(): void {
    if (this.closed || this.stopping) return;

    this.stopping = true;
    this.releaseAudio();
    const socket = this.socket;
    if (!this.ready || socket?.readyState !== WebSocket.OPEN) {
      this.finish();
      return;
    }
    socket.send(JSON.stringify({ type: 'stop' }));
    this.timer = window.setTimeout(() => this.finish(), this.stopWaitMs);
  }

  /** 离开页面或切断网络连接时立即释放所有资源。 */
  dispose(): void {
    this.finish();
  }

  /** 接上 browser WS，带现有 HTTP 钩子认可的访问令牌。 */
  private connect(): void {
    //G 服务器只返回同源的 /api/ 路径。令牌不出现在错误提示里。
    const path = tokenModule.withToken(this.path, tokenModule.TOKEN);
    const url = new URL(path, window.location.href);
    if (url.origin !== window.location.origin) {
      this.finish('voice-unavailable');
      return;
    }
    url.protocol = 'ws:';
    if (window.location.protocol === 'https:') {
      url.protocol = 'wss:';
    }

    //M 首帧总是 start。等待超时或连接断开会关麦。
    const socket = new WebSocket(url);
    this.socket = socket;
    this.timer = window.setTimeout(() => this.finish('connection-timeout'), 5000);
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'start', bot: this.bot, lang: 'zh' }));
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data === 'string') {
        this.receive(event.data);
      }
    };
    socket.onclose = (event) => {
      if (event.code === 4001) {
        this.finish('connection-replaced');
        return;
      }
      if (this.stopping) {
        this.finish();
        return;
      }
      this.finish('connection-closed');
    };
  }

  /** 只接受服务端的就绪、字幕、错误和停止回执。 */
  private receive(written: string): void {
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(written) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;

      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const type = frame['type'];
    if (type === 'ready') {
      if (this.ready || this.stopping) return;

      if (frame['sampleRate'] !== pcm.SAMPLE_RATE) {
        this.finish('unsupported-sample-rate');
        return;
      }
      window.clearTimeout(this.timer);
      const wait = frame['stopWaitMs'];
      if (typeof wait === 'number' && Number.isSafeInteger(wait) && wait >= 1500) {
        this.stopWaitMs = Math.min(wait, 2_147_483_647);
      }

      //M 节点输出静音，连接目标只为保持 worklet 活跃，不回放麦克风。
      const worklet = this.worklet!;
      this.source!.connect(worklet);
      worklet.connect(this.audio!.destination);
      this.ready = true;
      this.update({ kind: 'ready', simulated: frame['asr'] === 'fake' });
      this.ping = window.setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: 'ping' }));
        }
      }, 20_000);
      return;
    }

    if (type === 'partial' || type === 'final') {
      const seq = frame['seq'];
      const text = frame['text'];
      if (typeof seq === 'number' && Number.isSafeInteger(seq) && typeof text === 'string') {
        this.update({ kind: type, seq, text });
      }
      return;
    }
    if (type === 'task') {
      //M 只显示后端确认的任务；任务展示不替换当前字幕。
      const taskId = frame['taskId'];
      const text = frame['text'];
      const merged = frame['merged'];
      if (typeof taskId === 'string' && typeof text === 'string' && typeof merged === 'boolean') {
        this.update({ kind: 'task', task: { taskId, text, merged } });
      }
      return;
    }
    if (type === 'error') {
      const code = frame['code'];
      if (typeof code === 'string') {
        this.finish(code);
        return;
      }
      this.finish('voice-unavailable');
      return;
    }
    if (type === 'state' && frame['state'] === 'idle' && this.stopping) {
      this.finish();
    }
  }

  /** 先停音轨，再释放音频线程和图。 */
  private releaseAudio(): void {
    if (this.media !== undefined) {
      stopTracks(this.media);
      this.media = undefined;
    }
    const worklet = this.worklet;
    if (worklet !== undefined) {
      worklet.port.onmessage = null;
      worklet.port.close();
      worklet.disconnect();
      this.worklet = undefined;
    }
    this.source?.disconnect();
    this.source = undefined;
    if (this.audio !== undefined) {
      void this.audio.close().catch(() => {});
      this.audio = undefined;
    }
  }

  /** 完成一次连接，只回报 UI 一次。 */
  private finish(code?: string): void {
    if (this.closed) return;

    this.closed = true;
    window.clearTimeout(this.timer);
    window.clearInterval(this.ping);
    this.releaseAudio();
    const socket = this.socket;
    if (socket !== undefined) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.close();
      this.socket = undefined;
    }
    this.ended(code);
  }
}
