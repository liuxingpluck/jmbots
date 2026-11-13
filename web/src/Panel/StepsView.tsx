/**
 * 会话步骤的渲染（G批设计 8.3）：上半“分派记录”卡片，下半“步骤”折叠列表。
 * steps 由 Session.tsx 取来传进；这里只画，不发请求。
 * 工具调用（name + args）单独列出——验收在这里看 read 的 args.path；
 * event/stored/triggered 的原始 JSON 截断到 4000 字显示。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as i18n from '../I18n.ts';
import type * as types from '../Types.ts';
import * as stepsModule from './Steps.ts';


/** 原始 JSON 最多显示多少字，超了截断并注明。 */
const MAX_RAW_CHARS = 4000;


/** StepsView 的属性。 */
interface StepsViewProps {
  /** 后端返回的原始步骤（GET /api/sessions/:id/steps）。 */
  steps: types.SessionStep[];
}


/**
 * 步骤区：分派记录卡 + 步骤折叠。
 * @param props steps 原始步骤。
 */
export function StepsView(props: StepsViewProps): react.JSX.Element {
  const t = i18n.useT();
  /** 展示规则：一次渲染共用一个。 */
  const presenter = react.useMemo(() => new stepsModule.StepsPresenter(t), [t]);
  /** 界面条目，和 props.steps 同序。 */
  const items = presenter.items(props.steps);
  /** 分派记录卡。 */
  const dispatches = presenter.dispatches(props.steps);

  /**
   * 原始 JSON 给人看的样子：两格缩进，超 4000 字截断并注明。
   * @param value 步骤里的任何值。
   */
  const rawJson = (value: unknown): string => {
    /** 序列化。 */
    const text = JSON.stringify(value, null, 2);
    if (text.length <= MAX_RAW_CHARS) {
      return text;
    }
    return `${text.slice(0, MAX_RAW_CHARS)}…${t('（截断，共 {count} 字）', { count: text.length })}`;
  };

  /**
   * 一块原始 JSON（空的对象不占地方）。
   * @param label 块名：event、stored、triggered。
   * @param value 原始值。
   */
  const rawBlock = (label: string, value: Record<string, unknown>): react.JSX.Element | null => {
    //G 空表不显示，省得三步都是两行 {}。
    if (Object.keys(value).length === 0) {
      return null;
    }
    return (
      <div className="jm-step-raw-block">
        <div className="jm-muted">{label}</div>
        <pre>{rawJson(value)}</pre>
      </div>
    );
  };

  return (
    <div className="jm-steps">
      {dispatches.length > 0 && (
        <section className="jm-step-dispatches">
          <h4>{t('分派记录')}</h4>
          {dispatches.map((card, index) => (
            <antd.Descriptions
              key={`dispatch-${index}`}
              className="jm-step-dispatch-card"
              size="small"
              column={2}
              items={[
                { key: 'from', label: t('谁分的'), children: card.from },
                { key: 'by', label: t('谁定的'), children: card.by },
                { key: 'situation', label: t('什么情况'), children: card.situation, span: 2 },
                { key: 'model', label: t('模型和思考档'), children: card.model, span: 2 },
                { key: 'reason', label: t('为什么'), children: card.reason, span: 2 },
                { key: 'target', label: t('去向'), children: card.target, span: 2 },
              ]}
            />
          ))}
        </section>
      )}
      <section className="jm-step-list">
        <h4>{t('步骤')}</h4>
        {items.length === 0 && <div className="jm-muted">{t('还没有步骤')}</div>}
        <antd.Collapse
          size="small"
          items={items.map((item, index) => {
            /** 对应的原始步骤（items 和 steps 同序等长）。 */
            const step = props.steps[index];
            /** 工具调用和结果：单独列出。 */
            const callFacts = item.facts.filter((fact) => fact.key.startsWith('call:') || fact.key === 'result');
            /** 其余的事实。 */
            const otherFacts = item.facts.filter((fact) => !callFacts.includes(fact));
            return {
              key: `step-${item.seq}-${index}`,
              label: (
                <span
                  className="jm-step-label"
                  title={t('状态是后端原值：wait_response 在等模型，run_tools 在跑工具')}
                >
                  {`#${item.seq} ${item.row} · ${item.eventType} · ${item.state} · ${item.time}`}
                </span>
              ),
              children: (
                <div className="jm-step-body">
                  <div className="jm-step-summary">{item.summary}</div>
                  {callFacts.length > 0 && (
                    <div className="jm-step-calls">
                      {callFacts.map((fact) => (
                        <div key={fact.key} className="jm-step-call">
                          <div className="jm-step-call-name">{fact.label}</div>
                          <pre>{fact.value}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                  {otherFacts.length > 0 && (
                    <antd.Descriptions
                      className="jm-step-facts"
                      size="small"
                      column={1}
                      items={otherFacts.map((fact) => ({
                        key: fact.key,
                        label: fact.label,
                        children: <span className="jm-step-fact-value">{fact.value}</span>,
                      }))}
                    />
                  )}
                  <div className="jm-step-raw">
                    {step !== undefined && rawBlock('event', step.event)}
                    {step !== undefined && rawBlock('stored', step.stored)}
                    {step !== undefined && rawBlock('triggered', step.triggered)}
                  </div>
                </div>
              ),
            };
          })}
        />
      </section>
    </div>
  );
}
