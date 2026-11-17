/**
 * 一张审核卡片（docs/界面/01_界面设计.md 第 8 节）：聊天记录里、右栏“待审核”标签里都用它。
 * 默认是一行小卡片：序号、标题、风险等级、按钮、展开箭头；点标题或箭头才展开为什么、命令、目录、会动到、说明、工具数据。不挡聊天内容。
 * 在别处（飞书、打字）先决定了，下一次轮询这条就没了，卡片自己消失；接口回 404 时提示“已经处理过了”。不能错按的规矩在 Rules.ts。
 * 后端给了 card（卡片数据，飞书画的是同一份）就照它画；旧数据没 card 就拼一份同样的。card 不在等了就变灰、写结果、没按钮。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';
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

  return <CardBody approval={current} card={current.card ?? legacyCard(current, t)} armed={armed} deciding={deciding} notice={notice} decide={decide} />;
}


/**
 * 没 card 的旧数据拼成卡片数据。
 * @param approval 这条待确认。
 * @param t 翻译。
 */
function legacyCard(approval: types.ApprovalView, t: ReturnType<typeof i18n.useT>): types.CardView {
  return {
    kind: 'approval',
    title: approval.title || t('{bot} 要执行一条命令', { bot: approval.bot }),
    reason: approval.review.what,
    items: [
      { label: t('命令'), value: approval.command, code: true },
      ...(approval.workDir ? [{ label: t('目录'), value: approval.workDir }] : []),
      ...(approval.review.advice ? [{ label: t('建议'), value: approval.review.advice }] : []),
    ],
    ...(approval.review.risk ? { risk: { level: 'medium' as const, text: approval.review.risk } } : {}),
    buttons: [{ action: 'approve', label: t('同意执行'), style: 'primary' }, { action: 'reject', label: t('拒绝'), style: 'default' }],
    state: 'waiting',
  };
}


/** 风险等级的中文。 */
const RISK_TEXT = { low: '低', medium: '中', high: '高' } as const;


/**
 * 照卡片数据画的卡片。
 * @param props approval 这条；card 卡片数据；armed 能按了；deciding 正在定；notice 提示；decide 做决定。
 */
function CardBody(props: {
  approval: types.ApprovalView; card: types.CardView; armed: boolean; deciding: boolean; notice: string; decide: (decision: rules.Decision) => void;
}): react.JSX.Element {
  const t = i18n.useT();
  const masked = privacy.useMask();
  const { approval, card, armed, deciding, decide } = props;
  /** 还在等（有按钮）。 */
  const waiting = card.state === 'waiting';
  /** 展开了没有（默认收着，一行）。 */
  const [open, setOpen] = react.useState(false);
  return (
    <section
      className={`jm-approval jm-approval-compact jm-card-${card.kind}${waiting ? '' : ' jm-approval-done'}${card.risk ? ` jm-risk-${card.risk.level}` : ''}`}
      tabIndex={0}
      aria-label={privacy.name(card.title, masked)}
      aria-expanded={open}
      onKeyDown={(event) => {
        if (!waiting) return;
        /** 按键算不算决定（焦点在卡片里，不在输入框里）。 */
        const decision = rules.decisionForKey(event.key, true, armed, event.ctrlKey || event.altKey || event.metaKey);
        if (decision) {
          event.preventDefault();
          decide(decision);
        }
      }}
    >
      <header className="jm-approval-head">
        {card.kind === 'long-run' ? <icons.ClockCircleOutlined /> : <icons.SafetyCertificateOutlined />}
        <span className="jm-approval-title" title={privacy.text(card.reason || card.title, masked)} onClick={() => setOpen(!open)}>
          {`#${approval.id} ${privacy.name(card.title, masked)}${waiting ? '' : card.state === 'ended' ? t('（已结束）') : ''}`}
        </span>
        {card.risk && <antd.Tag color={card.risk.level === 'high' ? 'red' : card.risk.level === 'medium' ? 'orange' : 'green'}>{t('风险 {level}', { level: t(RISK_TEXT[card.risk.level]) })}</antd.Tag>}
        {waiting && [...card.buttons].reverse().map((button) => (
          <antd.Button
            key={button.action}
            size="small"
            className={button.action === 'approve' ? 'jm-approval-approve' : 'jm-approval-reject'}
            type={button.style === 'default' ? 'default' : 'primary'}
            danger={button.style === 'danger'}
            disabled={!armed || deciding}
            loading={deciding && button.action === 'approve'}
            onClick={() => decide(button.action)}
          >
            {masked ? t(button.action === 'approve' ? '同意执行' : '拒绝') : button.label}
          </antd.Button>
        ))}
        <antd.Button size="small" type="text" aria-label={open ? t('收起') : t('展开')} icon={open ? <icons.UpOutlined /> : <icons.DownOutlined />} onClick={() => setOpen(!open)} />
      </header>
      {open && (
        <div className="jm-approval-more">
          {card.reason && <div className="jm-approval-reason">{privacy.text(card.reason, masked)}</div>}
          <dl className="jm-approval-facts">
            {card.items.map((item, index) => (
              <react.Fragment key={index}>
                <dt>{privacy.text(item.label, masked)}</dt>
                <dd>{item.code ? <pre className="jm-approval-command">{privacy.text(item.value, masked)}</pre> : privacy.text(item.value, masked)}</dd>
              </react.Fragment>
            ))}
            {card.risk && (
              <>
                <dt>{t('风险')}</dt>
                <dd>{privacy.text(card.risk.text, masked)}</dd>
              </>
            )}
            {card.result && (
              <>
                <dt>{t('结果')}</dt>
                <dd>{privacy.text(card.result, masked)}</dd>
              </>
            )}
          </dl>
          {card.details && (
            <antd.Collapse size="small" ghost items={[{ key: 'details', label: privacy.text(card.details.label, masked), children: <pre className="jm-approval-command">{privacy.text(JSON.stringify(card.details.data, null, 2), masked)}</pre> }]} />
          )}
          {waiting && (
            <div className="jm-muted jm-approval-hint">
              {!armed ? t('看清楚再点…') : card.kind === 'long-run' ? t('不点就一直做下去') : t('点卡片后也能按 Y 同意、N 拒绝；也能直接回复“同意 {id}”“拒绝 {id}”', { id: approval.id })}
            </div>
          )}
        </div>
      )}
      {!open && card.result && <div className="jm-muted jm-approval-hint">{privacy.text(card.result, masked)}</div>}
      {props.notice && <div className="jm-approval-notice">{privacy.text(props.notice, masked)}</div>}
    </section>
  );
}
