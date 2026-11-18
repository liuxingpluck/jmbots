/** 客服聊天区的微信语音条，在点播放前不下载原音频。 */
import * as react from 'react';
import * as i18n from '../I18n.ts';
import * as token from '../Token.ts';

/** 语音条所对应的微信消息。 */
interface VoiceProps {
  /** 账号号。 */
  account: string;
  /** 会话号。 */
  chat: string;
  /** 微信引擎的消息来源。 */
  source: string;
  /** 消息在来源里的编号。 */
  localId: number;
  /** 微信记录里的语音时长。 */
  seconds?: number;
  /** 打码时不展示或请求音频。 */
  mask: boolean;
}

/** 展示时长，原音频无法播放时保留一条带原因的消息。 */
export function WechatVoice({ account, chat, source, localId, seconds, mask }: VoiceProps) {
  //M 独立客服页按地址或浏览器偏好设置语音提示的语言。
  const [language] = react.useState<i18n.Language>(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('lang');
    const explicit = i18n.matchLanguage(requested);
    if (explicit !== undefined) return explicit;

    try {
      //M 地址没有覆盖值时用浏览器已保存的偏好。
      return i18n.loadLanguage(window.localStorage);
    } catch {
      //G 本地存储不可用时使用简体中文。
      return 'zh-CN';
    }
  });
  const t: i18n.Translate = (label) => i18n.translate(language, label);

  const [reason, setReason] = react.useState<string>();
  const [measuredDuration, setMeasuredDuration] = react.useState<number>();
  const [checking, setChecking] = react.useState(false);
  const stopOnDetach = react.useCallback((audio: HTMLAudioElement | null) => {
    if (audio === null) return;

    return () => {
      //G 打码、切换会话或虚拟列表卸载时立即停止播放。
      audio.pause();
    };
  }, []);
  const duration = measuredDuration ?? seconds;
  let length = '时长未知';
  if (duration !== undefined && duration > 0) {
    const rounded = Math.max(1, Math.round(duration));
    length = `${String(rounded)} 秒`;
  }
  const title = `语音 · ${length}`;
  //G 打码时仅显示时长和占位，避免创建音频播放器。
  if (mask) return <div className="wk-bubble wk-voice">{title}{t('（已打码）')}</div>;
  if (reason !== undefined) return <div className="wk-bubble wk-voice">{title}（取不到：{reason}）</div>;

  //M 用原消息的完整编号走客服音频接口，账号、来源和会话共同定位缓存。
  const params = new URLSearchParams({ account, chat, source, local_id: String(localId) });
  const route = `/api/wechat-kefu/voice?${params.toString()}`;
  const address = token.withToken(route, token.TOKEN);

  /** 播放器拿不到 HTTP 错误体，再单独取一次原因供气泡显示。 */
  async function explain(): Promise<void> {
    if (checking) return;

    setChecking(true);
    //M 接口有具体错误时展示原原因，缺少原因时用语言包里的播放提示。
    let message = t('音频无法播放');
    try {
      const response = await fetch(address);
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        message = body.error ?? message;
      }
    } catch {
      message = '读取音频失败';
    }
    setReason(message);
  }

  const onError = (): void => {
    //M 用接口给出的原因说明讲话为什么播不了。
    void explain();
  };

  const onMetadata = (event: react.SyntheticEvent<HTMLAudioElement>): void => {
    //M 遇到旧记录没有时长时，用已加载音频的实测时长补显示。
    const measured = event.currentTarget.duration;
    if (Number.isFinite(measured) && measured > 0) {
      setMeasuredDuration(measured);
    }
  };

  return (
    <div className="wk-bubble wk-voice">
      <div>{title}</div>
      <audio
        ref={stopOnDetach}
        aria-label={title}
        controls
        preload="none"
        src={address}
        onError={onError}
        onLoadedMetadata={onMetadata}
        style={{ display: 'block', width: 245, maxWidth: '100%', height: 34, marginTop: 5 }}
      />
      {checking && <span role="status">读取原因…</span>}
    </div>
  );
}
