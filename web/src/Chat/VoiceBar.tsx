/** 聊天输入区上方的语音控件。字幕留在当前页面内存中。 */

import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as i18n from '../I18n.ts';
import * as captureModule from './VoiceCapture.ts';

type Phase = 'idle' | 'connecting' | 'listening' | 'stopping' | 'error';

interface Caption {
  /** 服务器给每句的序号。 */
  seq: number;
  /** 该句最终字幕。 */
  text: string;
}

interface ViewProps {
  /** 当前按钮决定显示什么动作。 */
  phase: Phase;
  /** 页面是否可以开始听。 */
  available: boolean;
  /** 当前句的实时字幕。 */
  partial: string;
  /** 最后几句已经结束的字幕。 */
  finals: Caption[];
  /** 最近获认领的任务。 */
  tasks: captureModule.TaskCaption[];
  /** 使用模拟转写时提醒这不是麦克风识别结果。 */
  simulated?: boolean;
  /** 当前连接中各语音阶段实际使用的线路。 */
  routes?: Partial<Record<captureModule.VoiceStage, captureModule.VoicePlace>>;
  /** 不能开始或连接失败的提示码。 */
  error?: string;
  /** 用户点击了开始或停止。 */
  toggle: () => void;
  /** 使用网页当前语言。 */
  t: i18n.Translate;
}

const ROUTE_LABELS = [
  ['asr', '转写'],
  ['tts', '合成'],
  ['judge', '理解'],
  ['turn', '断句'],
] as const;

/** 按 antd 当前主题渲染控制、状态和字幕；不操作浏览器设备。 */
export function VoiceBarView(props: ViewProps): react.JSX.Element {
  const { token } = antd.theme.useToken();
  const phase = props.phase;
  const t = props.t;
  const active = phase === 'connecting' || phase === 'listening' || phase === 'stopping';
  let tone: 'default' | 'processing' | 'success' | 'error' = 'default';
  let label = t('未连接');
  let button = t('开始听');
  let icon = <icons.AudioOutlined />;
  if (active) {
    button = t('停止听');
    icon = <icons.StopOutlined />;
  }
  if (phase === 'connecting') {
    tone = 'processing';
    label = t('连接中');
  }
  if (phase === 'listening') {
    tone = 'success';
    label = t('正在听');
    if (props.partial !== '') {
      label = t('正在转写');
    }
  }
  if (phase === 'stopping') {
    tone = 'processing';
    label = t('正在停止听写');
  }
  if (props.error !== undefined) {
    tone = 'error';
    const messages: Record<string, string> = {
      'voice-disabled': t('语音听写未启用'),
      'asr-model-missing': t('本地转写还没装好'),
      'asr-cloud-unconfigured': t('云端转写需要配置地址和密钥'),
      'websocket-missing': t('语音服务缺少 WebSocket 依赖'),
      'asr-failed': t('语音转写失败'),
      'voice-no-bot': t('没有选定接收语音任务的机器人'),
      'voice-task-failed': t('机器人没有接收这条语音任务'),
      'invalid-frame': t('语音帧无效，第一帧必须是 start'),
      'insecure-context': t('请在本机或 HTTPS 页面使用麦克风'),
      'microphone-permission': t('未获得麦克风权限'),
      'microphone-missing': t('找不到麦克风'),
      'microphone-failed': t('无法开启麦克风'),
      'voice-unavailable': t('语音服务不可用'),
      'connection-timeout': t('语音服务连接超时'),
      'connection-replaced': t('麦克风已被另一页面接管'),
      'connection-closed': t('语音连接已断开'),
      'unsupported-sample-rate': t('语音服务的采样率不受支持'),
      'slow-connection': t('语音连接过慢，听写已停止'),
    };
    label = t('语音服务不可用');
    const found = messages[props.error];
    if (typeof found === 'string') {
      label = found;
    }
  }
  const showCaptions = props.finals.length > 0 || props.partial !== '';

  return (
    <antd.Flex
      vertical
      gap={6}
      style={{
        padding: '7px 12px',
        borderTop: '1px solid ' + token.colorBorderSecondary,
        background: token.colorBgContainer,
      }}
    >
      <antd.Flex align="center" gap={10} wrap>
        <antd.Button
          size="small"
          icon={icon}
          onClick={props.toggle}
          disabled={!props.available || phase === 'stopping'}
        >
          {button}
        </antd.Button>
        <antd.Badge status={tone} text={label} />
        {props.simulated && (
          <antd.Typography.Text type="secondary">{t('模拟听写')}</antd.Typography.Text>
        )}
        {ROUTE_LABELS.map(([stage, title]) => {
          const place = props.routes?.[stage];
          if (place === undefined) return null;

          let route = t('本地');
          if (place === 'cloud') {
            route = t('云端');
          }
          return <antd.Tag key={stage}>{t(title)} · {route}</antd.Tag>;
        })}
      </antd.Flex>
      {showCaptions && (
        <div
          aria-live="polite"
          aria-label={t('语音字幕')}
          style={{ padding: '2px 0', overflowWrap: 'anywhere', maxHeight: '7em', overflowY: 'auto' }}
        >
          {props.finals.map(({ seq, text }) => (
            <div key={seq}><antd.Typography.Text>{text}</antd.Typography.Text></div>
          ))}
          {props.partial !== '' && (
            <div><antd.Typography.Text type="secondary">{props.partial}</antd.Typography.Text></div>
          )}
        </div>
      )}
      {props.tasks.length > 0 && (
        <ul aria-label={t('语音任务')} aria-live="polite" style={{ margin: 0, overflowWrap: 'anywhere' }}>
          {props.tasks.map((task) => {
            let label = t('已开任务：{text}', { text: task.text });
            if (task.merged) {
              label = t('补充：{text}', { text: task.text });
            }
            return <li key={task.taskId}><antd.Typography.Text>{label}</antd.Typography.Text></li>;
          })}
        </ul>
      )}
    </antd.Flex>
  );
}

interface VoiceBarProps {
  /** 正在看的机器人，作为 start 的显示上下文。 */
  bot: string;
  /** 后端当前在线。 */
  online: boolean;
}

/** 只有后端配置启用时才显示语音，离开聊天页立即关麦。 */
export function VoiceBar(props: VoiceBarProps): react.JSX.Element | null {
  const t = i18n.useT();
  const [status, setStatus] = react.useState<captureModule.VoiceStatus>();
  const [phase, setPhase] = react.useState<Phase>('idle');
  const [partial, setPartial] = react.useState('');
  const [finals, setFinals] = react.useState<Caption[]>([]);
  const [tasks, setTasks] = react.useState<captureModule.TaskCaption[]>([]);
  const [error, setError] = react.useState<string>();
  const [simulated, setSimulated] = react.useState(false);
  const [routes, setRoutes] = react.useState<ViewProps['routes']>();
  const running = react.useRef<captureModule.VoiceCapture | undefined>(undefined);

  //M 页面就绪时读取实际后端路径；离开、断线时取消查询并关闭麦克风。
  react.useEffect(() => {
    if (!props.online) {
      setStatus(undefined);
      setPhase('idle');
      return;
    }
    const controller = new AbortController();
    const signal = controller.signal;
    void captureModule.getVoiceStatus(signal).then((found) => {
      if (!signal.aborted) {
        setStatus(found);
      }
    }).catch(() => {
      if (!signal.aborted) {
        setStatus(undefined);
      }
    });

    return () => {
      controller.abort();
      const current = running.current;
      running.current = undefined;
      current?.dispose();
    };
  }, [props.online]);

  if (status?.enabled !== true) return null;

  //M 停止先关本地音轨，等最终字幕；开始时只创建一个新连接。
  const toggle = (): void => {
    const current = running.current;
    if (current !== undefined) {
      setPhase('stopping');
      current.stop();
      return;
    }
    if (!status.available || !props.online) return;

    setPartial('');
    setFinals([]);
    setTasks([]);
    setError(undefined);
    setSimulated(false);
    setRoutes(undefined);
    setPhase('connecting');
    const capture = new captureModule.VoiceCapture(status.wsPath, props.bot, (update) => {
      if (running.current !== capture) return;

      if (update.kind === 'ready') {
        setSimulated(update.simulated);
        setPhase('listening');
        return;
      }
      if (update.kind === 'partial') {
        setPartial(update.text);
        return;
      }
      if (update.kind === 'task') {
        setTasks((list) => [...list, update.task].slice(-5));
        return;
      }
      if (update.kind === 'route') {
        if (update.stage === 'asr' && update.place === undefined) {
          //G 已退出的转写线路不再留下临时字幕。
          setPartial('');
        }

        //M 各阶段独立更新，云端理解不覆盖本地转写标记。
        setRoutes((current) => ({ ...current, [update.stage]: update.place }));
        return;
      }
      setPartial('');
      const caption = { seq: update.seq, text: update.text };
      setFinals((list) => [...list, caption].slice(-3));
    }, (message) => {
      if (running.current !== capture) return;

      running.current = undefined;
      setPartial('');
      setError(message);
      setRoutes(undefined);
      let next: Phase = 'idle';
      if (message !== undefined) {
        next = 'error';
      }
      setPhase(next);
    });
    running.current = capture;
    void capture.start();
  };

  return (
    <VoiceBarView
      phase={phase}
      partial={partial}
      finals={finals}
      tasks={tasks}
      available={status.available && props.online}
      simulated={simulated}
      routes={routes}
      error={error ?? status.error?.code}
      toggle={toggle}
      t={t}
    />
  );
}
