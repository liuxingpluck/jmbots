/**
 * 右栏的“待审核”（docs/界面/01_界面设计.md 第 9 节）：所有还在等决定的命令，一张一张，都能点。
 */
import type * as react from 'react';
import * as approvalCard from '../Approval/ApprovalCard.tsx';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';


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
  if (approvals.length === 0) {
    return <div className="jm-empty">{t('现在没有待审核的命令')}</div>;
  }
  return (
    <div className="jm-panel-approvals">
      {approvals.map((approval) => (
        <approvalCard.ApprovalCard key={approval.id} approval={approval} />
      ))}
    </div>
  );
}
