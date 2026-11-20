/**
 * 外置微信客服页自包含的语音播放气泡组件（使用相对路径 `./api/wechat-kefu/voice` 兼容宿主同源代理）。
 * 点击播放前不自动拉取原音频，开启演示打码时不渲染音频控件。
 */
import * as react from 'react';
import * as locale from '../KefuLocale.ts';
import * as token from './Token.ts';


/** 语音气泡属性。 */
export interface VoiceProps {
  /** 微信账号编号。 */
  account: string;
  /** 会话原始 username。 */
  chat: string;
  /** 消息所在分片名。 */
  source: string;
  /** 分片内消息本地编号。 */
  localId: number;
  /** 微信气泡记录的秒数。 */
  seconds?: number;
  /** 是否处于演示打码状态。 */
  mask: boolean;
}


/**
 * 渲染单条微信语音播放条；加载失败时自动再拉一次 JSON 错误原因展示给客服。
 */
export function WechatVoice({ account, chat, source, localId, seconds, mask }: VoiceProps): react.JSX.Element {
  const [labels] = react.useState(locale.getLabels);
  const [reason, setReason] = react.useState<string>();
  const [measuredDuration, setMeasuredDuration] = react.useState<number>();
  const [checking, setChecking] = react.useState(false);

  const stopOnDetach = react.useCallback((audio: HTMLAudioElement | null) => {
    if (audio === null) return;

    return () => {
      //G 组件卸载、切换会话或进入打码模式时立即暂停音频。
      audio.pause();
    };
  }, []);

  const duration = measuredDuration ?? seconds;
  let lengthText = '时长未知';
  if (duration !== undefined && duration > 0) {
    const rounded = Math.max(1, Math.round(duration));
    lengthText = `${String(rounded)} 秒`;
  }
  const title = `语音 · ${lengthText}`;

  if (mask) return <div className="wk-bubble wk-voice">{title}{labels.maskedText}</div>;
  if (reason !== undefined) return <div className="wk-bubble wk-voice">{title}（取不到：{reason}）</div>;

  const params = new URLSearchParams({ account, chat, source, local_id: String(localId) });
  const relativeRoute = `./api/wechat-kefu/voice?${params.toString()}`;
  //M 使用相对路径拼接当前令牌，确保在 `/programs/<name>/` 代理下不跳出挂载前缀。
  const address = token.withToken(relativeRoute, token.TOKEN);

  async function explainFailure(): Promise<void> {
    if (checking) return;

    setChecking(true);
    let message = labels.voiceUnplayable;
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
    //M audio 元素无法直接读取 404 JSON 正文，触发一次异步探测展示具体缺件原因。
    void explainFailure();
  };

  const onMetadata = (event: react.SyntheticEvent<HTMLAudioElement>): void => {
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
