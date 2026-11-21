/**
 * voice 的线路装配：按校验过的配置，把转写（sherpa 本地、百炼、小米）和合成（小米、本地 MeloTTS）的主备线路装好。
 * apply 启用且不是 fake 时各调一次；交回的工厂、播报入口交给 Voice，预热函数由 apply 挂在 ready 上（守卫可回执以后才加载本地模型）。
 * 云端线路的地址和密钥取自 config.yaml 的 providers.bailian、providers.xiaomi；没配的线路也照样排上，开的时候报固定原因，供换线记录。
 */
import type * as cordis from 'cordis';
import * as asrModule from './Asr.ts';
import * as cloudAsr from './CloudAsr.ts';
import type * as configModule from './Config.ts';
import * as routedAsr from './RoutedAsr.ts';
import * as routes from './Routes.ts';
import * as ttsModule from './Tts.ts';

/** 给客户端的固定提示：错误码可本地化，message 是默认中文。 */
export interface Notice {
  /** 客户端可本地化的固定错误码。 */
  code: string;
  /** 默认中文提示。 */
  message: string;
}

/** 本地转写缺文件、没装好。 */
export const NO_ASR: Notice = { code: 'asr-model-missing', message: '本地转写还没装好' };

/** 转写线路装好后的样子。 */
export interface AsrLines {
  /** 每个连接开一条主备转写；一条能开的线路都没有时是 undefined。 */
  createAsr?: asrModule.AsrFactory;
  /** 开不了时状态接口报的原因：本地缺文件，或首选的云端没配。 */
  unavailable: Notice;
  /** 首选 sherpa 且文件齐时，ready 后预热本地模型；其余是 undefined。 */
  prewarm?: () => void;
}

/** 合成线路装好后的样子。 */
export interface Speaker {
  /** 按主备次序合成并播放的入口，交给 Voice。 */
  speak: ttsModule.Speak;
  /** 排了本地线路时，ready 后预热 MeloTTS；其余是 undefined。 */
  prewarm?: () => void;
  /** 卸载时释放已加载的本地合成器。 */
  dispose: () => void;
}

/**
 * 从既有供应商配置取认证和语音端点；找不到时留给线路选择报告。
 * @param ctx 插件 ctx，读 resources.config.providers。
 * @param name bailian（实时 WebSocket）或 xiaomi（Chat Completions）。
 * @returns 端点地址和密钥；没配、没密钥、地址协议不对时是 undefined。
 */
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
 * 装转写线路：按 asr.provider、asr.fallback 的次序排主备，本地线路的模型加载推迟到守卫放行、真要开流时。
 * @param ctx 插件 ctx：问资源守卫、读供应商配置。
 * @param settings 校验后的语音设置（启用且不是 fake）。
 * @param locations sherpa 的目录、静音和单句时长。
 * @param signal 插件生命周期：卸载后不再预热。
 * @returns 转写工厂、不可用原因和预热函数。
 */
export function getAsrLines(
  ctx: cordis.Context,
  settings: configModule.Settings,
  locations: asrModule.SherpaOptions,
  signal: AbortSignal,
): AsrLines {
  const maxSamples = settings.maxUtteranceMs * asrModule.SAMPLE_RATE / 1000;
  let unavailable = NO_ASR;

  //==========================================================
  //M 本地 sherpa：没缺文件才准备，实际加载推迟到资源守卫已可回执时
  //==========================================================
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
  const openLocal = async (lineSignal: AbortSignal): Promise<asrModule.Asr> => {
    //G 缺文件时保留明确的失败原因供备用线路记录。
    if (!sherpaReady) throw new routes.RouteFailure(NO_ASR.message);

    //G 本地识别吃 CPU：开流前先问 programs 的资源守卫（routes.allowLocal），CPU、内存紧时不开，限住本地并发。
    await routes.allowLocal(ctx, lineSignal);
    lineSignal.throwIfAborted();
    //M 在进程中复用已加载的本地转写模型。
    const factory = await getSherpa();
    lineSignal.throwIfAborted();
    if (factory === undefined) throw new routes.RouteFailure('本地转写模型加载失败');

    return factory();
  };
  let prewarm: (() => void) | undefined;
  if (sherpaReady && settings.provider === 'sherpa') {
    //M 守卫可以回执后预热首选模型，避免首次接麦才加载。
    prewarm = () => {
      void routes.allowLocal(ctx, signal).then(() => {
        signal.throwIfAborted();
        return getSherpa();
      }).catch(() => {});
    };
  }

  //==========================================================
  //M 按所选主备次序排线路；缺文件、没配的也排上，开的时候报原因
  //==========================================================
  let canStart = false;
  const choices: routedAsr.AsrRoute[] = [];
  //M apply 只在不是 fake 时调，主选、备选都是真实后端。
  const selected = [settings.provider, settings.asrFallback] as configModule.Settings['asrFallback'][];
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
  if (!canStart) return { unavailable, prewarm };

  //M 连接持有独立的未确认 PCM 与主备线路，不共享用户音频。
  const limit = maxSamples * 2;
  const createAsr = (): asrModule.Asr => new routedAsr.RoutedAsr(choices, limit);
  return { createAsr, unavailable, prewarm };
}

/**
 * 装合成线路：按 tts.provider、tts.fallback 的次序排主备，本地 MeloTTS 在守卫放行后才建。
 * @param ctx 插件 ctx：问资源守卫、读供应商配置。
 * @param settings 校验后的语音设置（启用且不是 fake）。
 * @param nativeDir sherpa-onnx 原生库目录。
 * @param modelsDir 语音模型目录。
 * @param signal 插件生命周期：卸载后不再建本地合成器。
 * @returns 播报入口、预热函数和释放函数。
 */
export function getSpeaker(
  ctx: cordis.Context,
  settings: configModule.Settings,
  nativeDir: string,
  modelsDir: string,
  signal: AbortSignal,
): Speaker {
  let local: ttsModule.LocalTts | undefined;
  let warming: Promise<ttsModule.LocalTts> | undefined;
  const getLocal = async (): Promise<ttsModule.LocalTts> => {
    if (local !== undefined) return local;

    if (warming === undefined) {
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

  const lines: ttsModule.SynthesisRoute[] = [];
  const wanted = [settings.tts.provider, settings.tts.fallback];
  let prewarm: (() => void) | undefined;
  for (const id of wanted) {
    if (id === undefined) continue;

    if (id === 'local') {
      const produce: ttsModule.SynthesisRoute['produce'] = async (text, lineSignal, emit) => {
        //M 唤醒已准入的本地合成器，首句也复用预热工作。
        const engine = await getLocal();
        //G 停止播报后即使预热成功也不再生成旧音频。
        lineSignal.throwIfAborted();
        const chunk = await engine.generate(text, lineSignal);
        emit(chunk);
      };
      //M MeloTTS 的整句 PCM 也经同一播放入口发回。
      lines.push({ place: 'local', produce });
      //M 资源守卫已注册后尝试预热，临时拒绝可在真正播报时重试。
      prewarm = () => { void getLocal().catch(() => {}); };
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
  const speak = ttsModule.createSpeaker(lines);
  const dispose = (): void => {
    local?.dispose();
  };
  return { speak, prewarm, dispose };
}
