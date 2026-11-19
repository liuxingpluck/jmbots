/**
 * 右栏的“待审核”（docs/界面/01_界面设计.md 第 9 节）：所有还在等决定的命令，一张一张，都能点。
 */
import * as react from 'react';
import * as virtuoso from 'react-virtuoso';
import * as api from '../Api.ts';
import * as approvalCard from '../Approval/ApprovalCard.tsx';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as readingModule from './Reading.ts';

const VIRTUAL_AFTER = 12;
/** 只有网页端收到满一批待审核时才补查溢出数量。与 approval 的网页上限一致。 */
const WEB_WAITING_LIMIT = 200;


/**
 * 右栏“待审核”标签页：展示所有还在等待用户决定的命令审核卡片。
 * @returns 待审核命令卡片列表；当前没有待审核命令时返回空状态提示节点。
 * 副作用：仅订阅当前语言与全局 UI 状态中的待审核列表，不修改状态。
 */
export function Approvals(): react.JSX.Element {
  //M 取当前语言翻译函数，用于格式化没有待审核命令时的空状态文案。
  const t = i18n.useT();
  /** 还在等的命令。 */
  //M 订阅全局 UI 状态中的待审核命令列表，用于决定显示空提示还是逐条渲染审核卡片。
  const approvals = context.useUi((state) => state.approvals);
  const scroll = react.useContext(readingModule.PanelScrollContext);
  const [overflow, setOverflow] = react.useState(0);
  const waiting = approvals.filter((item) => !item.card || item.card.state === 'waiting').length;
  const full = waiting >= WEB_WAITING_LIMIT;

  react.useEffect(() => {
    if (!full) {
      setOverflow(0);
      return undefined;
    }

    //M 只查上限外的条数。跟随现有轮询结果，旧请求取消后不回写。
    const controller = new AbortController();
    const params = { signal: controller.signal };
    void api.getJson<{ count: number }>('/api/approvals/overflow', params).then((result) => {
      if (!controller.signal.aborted) {
        setOverflow(result.count);
      }
    }).catch(() => undefined);
    return () => controller.abort();
  }, [approvals, full]);

  if (approvals.length === 0) {
    return <div className="jm-empty">{t('现在没有待审核的命令')}</div>;
  }

  const renderCards = (): react.ReactNode => {
    if (approvals.length <= VIRTUAL_AFTER) {
      return approvals.map((approval) => <approvalCard.ApprovalCard key={approval.id} approval={approval} />);
    }
    if (scroll === null) return null;

    //M 大量卡片按原右栏滚动，保留变高的命令卡和稳定的审核号。
    return (
      <virtuoso.Virtuoso
        customScrollParent={scroll}
        data={approvals}
        defaultItemHeight={180}
        computeItemKey={(_index, approval) => approval.id}
        itemContent={(_index, approval) => (
          <div style={{ paddingBottom: 12 }}>
            <approvalCard.ApprovalCard approval={approval} />
          </div>
        )}
      />
    );
  };
  return (
    <div className="jm-panel-approvals">
      {full && overflow > 0 && (
        <div className="jm-muted" role="status">{t('还有 {count} 条', { count: overflow })}</div>
      )}
      {renderCards()}
    </div>
  );
}
