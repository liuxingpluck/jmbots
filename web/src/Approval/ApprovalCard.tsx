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
import * as vscodeLink from '../VscodeLink.tsx';
import * as rules from './Rules.ts';
import type * as types from '../Types.ts';


/**
 * 审核卡片。
 * @param props approval 这条待确认。
 */
export function ApprovalCard(props: { approval: types.ApprovalView }): react.JSX.Element {
  //M 订阅界面翻译函数，供旧卡片兜底字段与审批结果提示本地化使用。
  const t = i18n.useT();
  /** 这条待确认。 */
  const current = props.approval;
  /** 决定了就马上从列表里拿掉（两处的卡片一起没）。 */
  //M 从全局状态仓库读取移除待审核项动作，提交成功后不等轮询立即消掉卡片。
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
    //G 防重入与防误触守卫：正在提交或卡片刚出现未满安全延迟时不发审批请求。
    if (deciding || !rules.isArmed(shownAt, Date.now())) {
      return;
    }

    setDeciding(true);
    //M 向后端发送同意或拒绝决定；成功后立即移除卡片，失败或已处理时展示提示。
    void api.decideApproval(current.id, decision === 'approve').then((status) => {
      setDeciding(false);
      if (status >= 200 && status < 300) {
        dropApproval(current.id);
        return;
      }

      //M 按决定与接口状态码（如 404 已在别处处理、0 断连）生成底部错误提示。
      setNotice(rules.getDecisionNotice(decision, status, t));
    });
  };

  //M 优先按后端统一下发的 card 渲染；缺 card 的旧数据即时拼出兼容结构交由 CardBody 展示。
  return <CardBody approval={current} card={current.card ?? getLegacyCard(current, t)} armed={armed} deciding={deciding} notice={notice} decide={decide} />;
}


/**
 * 没 card 的旧数据拼成卡片数据。
 * @param approval 这条待确认。
 * @param t 翻译。
 */
function getLegacyCard(approval: types.ApprovalView, t: ReturnType<typeof i18n.useT>): types.CardView {
  const items: types.CardView['items'] = [{ label: t('命令'), value: approval.command, code: true }];
  if (approval.workDir) {
    items.push({ label: t('目录'), value: approval.workDir });
  }
  if (approval.review.advice) {
    items.push({ label: t('建议'), value: approval.review.advice });
  }
  const card: types.CardView = {
    kind: 'approval',
    title: approval.title || t('{bot} 要执行一条命令', { bot: approval.bot }),
    reason: approval.review.what,
    items,
    buttons: [{ action: 'approve', label: t('同意执行'), style: 'primary' }, { action: 'reject', label: t('拒绝'), style: 'default' }],
    state: 'waiting',
  };
  if (approval.review.risk) {
    card.risk = { level: 'medium' as const, text: approval.review.risk };
  }
  return card;
}


/** 风险等级的中文与标签色。 */
const RISK_TEXT = { low: '低', medium: '中', high: '高' } as const;
const RISK_COLORS = { low: 'green', medium: 'orange', high: 'red' } as const;


/**
 * 照卡片数据画的卡片。
 * @param props approval 这条；card 卡片数据；armed 能按了；deciding 正在定；notice 提示；decide 做决定。
 */
function CardBody(props: {
  approval: types.ApprovalView; card: types.CardView; armed: boolean; deciding: boolean; notice: string; decide: (decision: rules.Decision) => void;
}): react.JSX.Element {
  //M 订阅翻译函数与演示打码开关，在渲染卡片标题、明细及提示时按需脱敏。
  const t = i18n.useT();
  const masked = privacy.useMask();
  const { approval, card, armed, deciding, decide } = props;
  /** 还在等（有按钮）。 */
  const waiting = card.state === 'waiting';
  /** 展开了没有（默认收着，一行）。 */
  const [open, setOpen] = react.useState(false);
  let doneClass = ' jm-approval-done';
  if (waiting) {
    doneClass = '';
  }
  let riskClass = '';
  if (card.risk) {
    riskClass = ` jm-risk-${card.risk.level}`;
  }
  let kindIcon = <icons.SafetyCertificateOutlined />;
  if (card.kind === 'long-run') {
    kindIcon = <icons.ClockCircleOutlined />;
  }
  let endedText = '';
  if (!waiting && card.state === 'ended') {
    endedText = t('（已结束）');
  }
  let toggleLabel = t('展开');
  let toggleIcon = <icons.DownOutlined />;
  if (open) {
    toggleLabel = t('收起');
    toggleIcon = <icons.UpOutlined />;
  }
  let waitingHint = t('点卡片后也能按 Y 同意、N 拒绝；也能直接回复“同意 {id}”“拒绝 {id}”', { id: approval.id });
  if (card.kind === 'long-run') {
    waitingHint = t('不点就一直做下去');
  }
  if (!armed) {
    waitingHint = t('看清楚再点…');
  }
  //M 渲染审核卡片本体并在无障碍标签上应用脱敏，仅在卡片聚焦且等待确认时响应快捷键。
  return (
    <section
      className={`jm-approval jm-approval-compact jm-card-${card.kind}${doneClass}${riskClass}`}
      tabIndex={0}
      aria-label={privacy.name(card.title, masked)}
      aria-expanded={open}
      onKeyDown={(event) => {
        if (!waiting) return;
        /** 按键算不算决定（焦点在卡片里，不在输入框里）。 */
        //M 判断聚焦卡片内按键是否构成有效 Y/N 决定，屏蔽修饰键与 Enter 默认提交。
        const decision = rules.getDecisionForKey(event.key, true, armed, event.ctrlKey || event.altKey || event.metaKey);
        if (decision) {
          event.preventDefault();
          //M 拦截默认按键事件后提交对应的同意或拒绝决定。
          decide(decision);
        }
      }}
    >
      <header className="jm-approval-head">
        {kindIcon}
        {
          //M 标题与悬停提示文本按演示打码开关脱敏，点击可展开或收起命令详情。
        /**/}
        <span className="jm-approval-title" title={privacy.text(card.reason || card.title, masked)} onClick={() => setOpen(!open)}>
          {`#${approval.id} ${privacy.name(card.title, masked)}${endedText}`}
        </span>
        {card.risk && <antd.Tag color={RISK_COLORS[card.risk.level]}>{t('风险 {level}', { level: t(RISK_TEXT[card.risk.level]) })}</antd.Tag>}
        {waiting && [...card.buttons].reverse().map((button) => {
          let buttonClass = 'jm-approval-reject';
          let maskedLabel = t('拒绝');
          if (button.action === 'approve') {
            buttonClass = 'jm-approval-approve';
            maskedLabel = t('同意执行');
          }
          let buttonType: 'default' | 'primary' = 'primary';
          if (button.style === 'default') {
            buttonType = 'default';
          }
          let buttonLabel = button.label;
          if (masked) {
            buttonLabel = maskedLabel;
          }

          //M 渲染操作按钮并绑定点击决定回调，由 decide 处理防连点与防误触校验。
          return (
            <antd.Button
              key={button.action}
              size="small"
              className={buttonClass}
              type={buttonType}
              danger={button.style === 'danger'}
              disabled={!armed || deciding}
              loading={deciding && button.action === 'approve'}
              onClick={() => decide(button.action)}
            >
              {buttonLabel}
            </antd.Button>
          );
        })}
        <antd.Button size="small" type="text" aria-label={toggleLabel} icon={toggleIcon} onClick={() => setOpen(!open)} />
      </header>
      {open && (
        <div className="jm-approval-more">
          {
            //M 展开区首段展示脱敏后的审批理由，便于用户核对执行目的。
          /**/}
          {card.reason && <div className="jm-approval-reason">{privacy.text(card.reason, masked)}</div>}
          <dl className="jm-approval-facts">
            {card.items.map((item, index) => {
              //M 先对键值明细内容按演示开关脱敏，再交给链接识别组件渲染。
              const displayValue = privacy.text(item.value, masked);
              let itemNode: react.ReactNode = (
                <vscodeLink.TextWithVscodeLinks text={displayValue} masked={masked} />
              );
              if (item.code) {
                itemNode = (
                  <pre className="jm-approval-command">
                    <vscodeLink.TextWithVscodeLinks text={displayValue} masked={masked} />
                  </pre>
                );
              }

              //M 渲染脱敏后的明细键名及对应的值节点。
              return (
                <react.Fragment key={index}>
                  <dt>{privacy.text(item.label, masked)}</dt>
                  <dd>{itemNode}</dd>
                </react.Fragment>
              );
            })}
            {
              //M 在事实清单末尾追加展示脱敏后的风险描述与最终审批结果。
            /**/}
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
          {
            //M 将工具调用附加数据的标题与 JSON 内容脱敏后放入折叠面板按需查看。
          /**/}
          {card.details && (
            <antd.Collapse
              size="small"
              ghost
              items={[
                {
                  key: 'details',
                  label: privacy.text(card.details.label, masked),
                  children: (
                    <pre className="jm-approval-command">
                      <vscodeLink.TextWithVscodeLinks
                        text={privacy.text(JSON.stringify(card.details.data, null, 2), masked)}
                        masked={masked}
                      />
                    </pre>
                  ),
                },
              ]}
            />
          )}
          {waiting && (
            <div className="jm-muted jm-approval-hint">
              {waitingHint}
            </div>
          )}
        </div>
      )}
      {
        //M 卡片收起时直接显示脱敏后的已处理结果，并在底部展示接口提交反馈提示。
      /**/}
      {!open && card.result && <div className="jm-muted jm-approval-hint">{privacy.text(card.result, masked)}</div>}
      {props.notice && <div className="jm-approval-notice">{privacy.text(props.notice, masked)}</div>}
    </section>
  );
}
