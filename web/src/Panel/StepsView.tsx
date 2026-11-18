/**
 * 会话步骤的渲染（G批设计 8.3）：上半“分派记录”卡片，下半“步骤”折叠列表。
 * steps 由 Session.tsx 取来传进；这里只画，不发请求。
 * 工具调用（name + args）单独列出——验收在这里看 read 的 args.path；
 * event/stored/triggered 的原始 JSON 截断到 4000 字显示。
 * 步骤最多 500 步，用 react-virtuoso 虚拟滚动（用户 11-17），借 Session.tsx 的 .jm-session 当滚动元素；
 * 每步是一个只含一项的折叠面板，展开了哪些记在这里（openKeys），滚出去再滚回来照旧展开。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as virtuoso from 'react-virtuoso';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';
import * as vscodeLink from '../VscodeLink.tsx';
import type * as types from '../Types.ts';
import * as stepsModule from './Steps.ts';


/** 原始 JSON 最多显示多少字，超了截断并注明。 */
const MAX_RAW_CHARS = 4000;

/** 看得见的上下各多画多少像素，快速滚动时不露白。 */
const OVERSCAN_PX = 600;


/** StepsView 的属性。 */
interface StepsViewProps {
  /** 后端返回的原始步骤（GET /api/sessions/:id/steps）。 */
  steps: types.SessionStep[];
  /** 外面的滚动元素（Session.tsx 的 .jm-session，经 ref 回调交进来）；还没挂上时是 null，先不画步骤。 */
  scrollParent: HTMLElement | null;
  /** 可选运行时根目录，让步骤里相对 bots/ 路径也能用 VS Code 打开。 */
  runtimeRoot?: string;
}


/**
 * 步骤区：分派记录卡 + 步骤折叠。
 * @param props steps 原始步骤、外层滚动容器及可选运行时根目录。
 * @returns 分派记录卡片与虚拟滚动步骤列表元素。
 * 副作用：仅维护各步骤折叠项的本地展开状态，不发起网络请求。
 */
export function StepsView(props: StepsViewProps): react.JSX.Element {
  //M 获取翻译函数与演示打码开关，供步骤列表文案及敏感字段脱敏使用。
  const t = i18n.useT();
  const masked = privacy.useMask();
  /** 展示规则：一次渲染共用一个。 */
  //M 随当前语言缓存步骤展示器实例，统一整理步骤和分派记录。
  const presenter = react.useMemo(() => new stepsModule.StepsPresenter(t), [t]);
  /** 界面条目，和 props.steps 同序。 */
  //M 把原始步骤数组投影为界面的步骤条目列表，保持原有顺序。
  const items = presenter.items(props.steps);
  /** 分派记录卡。 */
  //M 提取其中的分派记录，生成顶部“分派记录”卡片视图。
  const dispatches = presenter.dispatches(props.steps);
  /** 展开着的步骤的键（getStepKey 算的）；原来记在 antd Collapse 里，虚拟滚动后面板会卸载，改记在这里。 */
  const [openKeys, setOpenKeys] = react.useState<string[]>([]);

  /**
   * 一步的键：和原来 Collapse 的 key 一样，轮询整表替换时同一步不变。
   * @param seq 步骤号。
   * @param index 在列表里的位置。
   */
  const getStepKey = (seq: number, index: number): string => `step-${String(seq)}-${String(index)}`;

  /**
   * 展开或收起一步。
   * @param key getStepKey 算的键。
   * @param open 展开为真。
   */
  const toggle = (key: string, open: boolean): void => {
    setOpenKeys((old) => {
      const rest = old.filter((item) => item !== key);
      if (!open) return rest;

      return [...rest, key];
    });
  };

  /**
   * 原始 JSON 给人看的样子：两格缩进，超 4000 字截断并注明。
   * @param value 步骤里的任何值。
   */
  const getRawJson = (value: unknown): string => {
    /** 序列化。 */
    //M 将原始步骤字段格式化为缩进 JSON 并按演示开关脱敏。
    const text = privacy.text(JSON.stringify(value, null, 2), masked);
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
  const getRawBlock = (label: string, value: Record<string, unknown>): react.JSX.Element | null => {
    //G 空表不显示，省得三步都是两行 {}。
    if (Object.keys(value).length === 0) {
      return null;
    }
    return (
      <div className="jm-step-raw-block">
        <div className="jm-muted">{label}</div>
        <pre>{getRawJson(value)}</pre>
      </div>
    );
  };

  /**
   * 一步：只含一项的折叠面板，展开与否由 openKeys 控制。
   * 由下面 Virtuoso 的 itemContent 调，只画滚到眼前的那几步。
   * @param index 在列表里的位置（items 和 props.steps 同序等长）。
   * @param item 这一步的界面条目。
   */
  const renderStep = (index: number, item: stepsModule.StepItem): react.JSX.Element => {
    /** 这一步的键。 */
    //M 为当前步骤生成跨轮询保持稳定的折叠键。
    const key = getStepKey(item.seq, index);
    /** 对应的原始步骤。 */
    const step = props.steps[index];
    /** 工具调用和结果：单独列出。 */
    const callFacts = item.facts.filter((fact) => fact.key.startsWith('call:') || fact.key === 'result');
    /** 其余的事实。 */
    const otherFacts = item.facts.filter((fact) => !callFacts.includes(fact));

    //M 展开着就把自己的键交给 Collapse，收着给空。
    let activeKey: string[] = [];
    if (openKeys.includes(key)) {
      activeKey = [key];
    }

    /** 折叠面板的这一项：标题一行，展开是摘要、工具调用、其余事实、原始 JSON。 */
    //M 组装单个步骤折叠项的标题与正文，并对摘要和工具调用字段按演示开关脱敏。
    const panel = {
      key,
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
          <div className="jm-step-summary">{privacy.text(item.summary, masked)}</div>
          {callFacts.length > 0 && (
            <div className="jm-step-calls">
              {callFacts.map((fact) => (
                <div key={fact.key} className="jm-step-call">
                  <div className="jm-step-call-name">{privacy.text(fact.label, masked)}</div>
                  <pre>
                    <vscodeLink.TextWithVscodeLinks
                      text={privacy.text(fact.value, masked)}
                      masked={masked}
                      runtimeRoot={props.runtimeRoot}
                    />
                  </pre>
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
                //M 对其余事实键名与取值按演示状态脱敏，再渲染内嵌路径链接。
                label: privacy.text(fact.label, masked),
                children: (
                  <span className="jm-step-fact-value">
                    <vscodeLink.TextWithVscodeLinks
                      text={privacy.text(fact.value, masked)}
                      masked={masked}
                      runtimeRoot={props.runtimeRoot}
                    />
                  </span>
                ),
              }))}
            />
          )}
          <div className="jm-step-raw">
            {
              //M 仅渲染非空的 event 原始字段块。
              step !== undefined && getRawBlock('event', step.event)
            }
            {
              //M 仅渲染非空的 stored 原始字段块。
              step !== undefined && getRawBlock('stored', step.stored)
            }
            {
              //M 仅渲染非空的 triggered 原始字段块。
              step !== undefined && getRawBlock('triggered', step.triggered)
            }
          </div>
        </div>
      ),
    };

    return (
      <div className="jm-step-item">
        <antd.Collapse
          size="small"
          activeKey={activeKey}
          //M 展开或收起折叠项时更新本地展开键集合，避免虚拟滚动卸载丢状态。
          onChange={(keys) => toggle(key, keys.length > 0)}
          items={[panel]}
        />
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
                //M 对分派卡片中的人员、情况、理由与去向字段统一按演示开关脱敏。
                { key: 'from', label: t('谁分的'), children: privacy.text(card.from, masked) },
                { key: 'by', label: t('谁定的'), children: privacy.text(card.by, masked) },
                { key: 'situation', label: t('什么情况'), children: privacy.text(card.situation, masked), span: 2 },
                { key: 'model', label: t('模型和思考档'), children: card.model, span: 2 },
                { key: 'reason', label: t('为什么'), children: privacy.text(card.reason, masked), span: 2 },
                { key: 'target', label: t('去向'), children: privacy.text(card.target, masked), span: 2 },
              ]}
            />
          ))}
        </section>
      )}
      <section className="jm-step-list">
        <h4>{t('步骤')}</h4>
        {items.length === 0 && <div className="jm-muted">{t('还没有步骤')}</div>}
        {props.scrollParent && (
          <virtuoso.Virtuoso
            customScrollParent={props.scrollParent}
            data={items}
            //M 使用步骤序号与列表下标生成稳定键，防止轮询刷新时项重挂载。
            computeItemKey={(index, item) => getStepKey(item.seq, index)}
            increaseViewportBy={OVERSCAN_PX}
            itemContent={renderStep}
          />
        )}
      </section>
    </div>
  );
}
