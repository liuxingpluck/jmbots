/**
 * 一张审核卡片（docs/界面/01_界面设计.md 第 8 节）：聊天记录里、右栏“待审核”标签里都用它。卡片不挡消息，翻上去也能点。
 * 写清哪个机器人、命令（等宽，太长能滚动）、执行目录、做什么、风险、建议；“同意执行”“拒绝”两个按钮。
 * 在别处（飞书、打字）先决定了，下一次轮询这条就没了，卡片自己消失；接口回 404 时提示“已经处理过了”。不能错按的规矩在 Rules.ts。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as rules from './Rules.ts';
import type * as types from '../Types.ts';


/**
 * 审核卡片。
 * @param props approval 这条待确认。
 */
export function ApprovalCard(props: { approval: types.ApprovalView }): react.JSX.Element {
  const t = i18n.useT();
  /** 这条待确认。 */
  const current = props.approval;
  /** 决定了就马上从列表里拿掉（两处的卡片一起没）。 */
  const dropApproval = context.useUi((state) => state.dropApproval);
  /** 这张卡片出现的时间。 */
  const [shownAt] = react.useState(() => Date.now());
  /** 按钮能不能按了。 */
  const [armed, setArmed] = react.useState(false);
  /** 正在决定（防连点）。 */
  const [deciding, setDeciding] = react.useState(false);
  /** 提示。 */
  const [notice, setNotice] = react.useState('');

  react.useEffect(() => {
    //M 出现 1 秒后才能按。
    /** 到点放开。 */
    const timer = setTimeout(() => setArmed(true), rules.ARM_MS);
    return () => clearTimeout(timer);
  }, []);

  /**
   * 做决定。
   * @param decision 同意还是拒绝。
   */
  const decide = (decision: rules.Decision): void => {
    if (deciding || !rules.isArmed(shownAt, Date.now())) {
      return;
    }
    setDeciding(true);
    void api.decideApproval(current.id, decision === 'approve').then((status) => {
      setDeciding(false);
      if (status >= 200 && status < 300) {
        dropApproval(current.id);
      } else {
        setNotice(rules.decisionNotice(decision, status, t));
      }
    });
  };

  return (
    <section
      className="jm-approval"
      tabIndex={0}
      aria-label={t('待确认的命令：{bot}', { bot: current.bot })}
      onKeyDown={(event) => {
        /** 按键算不算决定（焦点在卡片里，不在输入框里）。 */
        const decision = rules.decisionForKey(event.key, true, armed, event.ctrlKey || event.altKey || event.metaKey);
        if (decision) {
          event.preventDefault();
          decide(decision);
        }
      }}
    >
      <header className="jm-approval-head">
        <icons.SafetyCertificateOutlined />
        <span className="jm-approval-title">
          {current.title ? t('{title}，等你决定（#{id}）', { title: current.title, id: current.id }) : t('{bot} 要执行一条命令，等你决定（#{id}）', { bot: current.bot, id: current.id })}
        </span>
      </header>
      <pre className="jm-approval-command">{current.command}</pre>
      <dl className="jm-approval-facts">
        {current.workDir && (
          <>
            <dt>{t('目录')}</dt>
            <dd>{current.workDir}</dd>
          </>
        )}
        <dt>{t('做什么')}</dt>
        <dd>{current.review.what || t('（没写）')}</dd>
        <dt>{t('风险')}</dt>
        <dd>{current.review.risk || t('（没写）')}</dd>
        <dt>{t('建议')}</dt>
        <dd>{current.review.advice || t('（没写）')}</dd>
      </dl>
      <footer className="jm-approval-actions">
        <span className="jm-muted">{armed ? t('点卡片后也能按 Y 同意、N 拒绝；也能直接回复“同意 {id}”“拒绝 {id}”', { id: current.id }) : t('看清楚再点…')}</span>
        <antd.Button className="jm-approval-reject" danger disabled={!armed || deciding} onClick={() => decide('reject')}>
          {t('拒绝')}
        </antd.Button>
        <antd.Button className="jm-approval-approve" disabled={!armed || deciding} loading={deciding} onClick={() => decide('approve')}>
          {t('同意执行')}
        </antd.Button>
      </footer>
      {notice && <div className="jm-approval-notice">{notice}</div>}
    </section>
  );
}
