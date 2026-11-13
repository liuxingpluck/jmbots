/**
 * 右栏的“待审核”（docs/界面/01_界面设计.md 第 9 节）：所有还在等决定的命令，一张一张，都能点。
 */
import type * as react from 'react';
import * as approvalCard from '../Approval/ApprovalCard.tsx';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';


/** 待审核。 */
export function Approvals(): react.JSX.Element {
  const t = i18n.useT();
  /** 还在等的命令。 */
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
