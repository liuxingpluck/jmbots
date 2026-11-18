/** 查看节点结论并提交选项的侧栏。 */
import type * as types from '../../../src7/plugins/decision-map/Types.ts';

/** 侧栏由页面管理选中的节点和请求状态。 */
interface DrawerProps {
  /** 正在查看的节点。 */
  node: types.DecisionNode;
  /** 正在保存的选项号。 */
  saving?: string;
  /** 本次点选失败的原因。 */
  error?: string;
  /** 收起选项。 */
  close: () => void;
  /** 提交选项。 */
  choose: (id: string) => void;
}

/** 打开经过校验的 HTTP 证据链接，其他文本只作参考。 */
function getLinks(values: string[]): string[] {
  return values.filter((value) => /^https?:\/\//iu.test(value));
}

/** 当前节点记下的决定来源和当时的选项。 */
function DecisionHistory({ node }: { node: types.DecisionNode }) {
  let actor = '决定人未记录';
  if (node.decidedBy === 'central') actor = '中控定的';
  if (node.decidedBy === 'user') actor = '用户定的';
  if (node.decidedBy === 'user' && node.chosen !== undefined) actor = '用户点的';
  let time = '时间未记录';
  if (node.decidedAt !== undefined) {
    const date = new Date(node.decidedAt);
    time = date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false });
  }

  //M 旧选项只供回看，突出当时选中的一项。
  return (
    <section aria-label="决定记录" className="decision-history">
      <p>{actor} · {time}</p>
      {(node.options?.length ?? 0) > 0 && (
        <ul className="decision-options">
          {node.options?.map((option) => (
            <li
              className="decision-option"
              key={option.id}
              data-chosen={option.id === node.chosen}
              data-option-id={option.id}
            >
              <span className="decision-option__title">
                {option.text}
                {option.id === node.chosen && <span className="decision-option__recommended">已选 ✓</span>}
              </span>
              {option.cost && <span className="decision-option__cost">{option.cost}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 待定时显示点击即可提交的选项，已定时显示中控接收状态。 */
export function Drawer({ node, saving, error, close, choose }: DrawerProps) {
  const isPending = node.kind === 'pending' && node.status === 'open';
  const isConfirmed = node.acknowledgedAt !== undefined;
  const isDecided = node.kind === 'decided' || node.status === 'decided';
  const awaitingCentral = node.decidedBy === 'user' && node.chosen !== undefined;

  //G 证据列表只把 HTTP 链接渲染成可操作地址。
  const links = getLinks(node.links ?? []);
  const sources = new Set(node.sources ?? []);
  if (node.detailPath) {
    sources.add(node.detailPath);
  }
  let stateText = '节点详情';
  if (isPending) stateText = '★ 要你定';
  if (isDecided) stateText = '已定 ✓';

  //M 点节点时先看结论和选择，已到手的决定单独标明中控确认。
  return (
    <aside className="decision-drawer" aria-labelledby="decision-drawer-title">
      <div className="decision-drawer__head">
        <span className="decision-drawer__state">{stateText}</span>
        <button type="button" onClick={close} className="decision-close" aria-label="关闭详情">×</button>
      </div>
      <h2 id="decision-drawer-title">{node.title}</h2>
      {node.summary !== '' && <p className="decision-drawer__summary">{node.summary}</p>}
      {isPending && (
        <div className="decision-options" aria-label="可选决定">
          {node.options?.map((option) => (
            <button
              className="decision-option"
              key={option.id}
              type="button"
              data-option-id={option.id}
              disabled={saving !== undefined}
              onClick={() => choose(option.id)}
            >
              <span className="decision-option__title">
                {option.text}
                {option.recommended && <span className="decision-option__recommended">推荐</span>}
              </span>
              {option.cost && <span className="decision-option__cost">{option.cost}</span>}
              {saving === option.id && <span className="decision-option__cost">正在保存</span>}
            </button>
          ))}
        </div>
      )}
      {isDecided && <DecisionHistory node={node} />}
      {awaitingCentral && (
        <div className="decision-receipt" data-confirmed={isConfirmed}>
          {isConfirmed && <span>中控已收到{node.note && ` · ${node.note}`}</span>}
          {!isConfirmed && <span>等待中控确认</span>}
        </div>
      )}
      {error && <p className="decision-error" role="alert">{error}</p>}
      {sources.size > 0 && (
        <section className="decision-sources" aria-label="出处">
          <h3>出处</h3>
          <ul className="decision-links">
            {[...sources].map((source) => <li key={source}>{source}</li>)}
          </ul>
        </section>
      )}
      {links.length > 0 && (
        <ul className="decision-links">
          {links.map((link) => <li key={link}><a href={link} target="_blank" rel="noreferrer">{link}</a></li>)}
        </ul>
      )}
    </aside>
  );
}
