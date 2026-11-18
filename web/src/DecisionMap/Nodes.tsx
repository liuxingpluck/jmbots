/** 决策图节点的标题、当前状态和交互入口。 */
import * as xyflow from '@xyflow/react';
import type * as types from '../../../src7/plugins/decision-map/Types.ts';
import type * as layout from './Layout.ts';

const SIDES = [xyflow.Position.Top, xyflow.Position.Right, xyflow.Position.Bottom, xyflow.Position.Left];

/** 按主线和决定状态提供视觉样式与说明。 */
function getAppearance(entry: types.DecisionNode): { state: string; badge: string } {
  if (entry.kind === 'goal') return { state: 'goal', badge: '当前目标' };
  if (entry.kind === 'pending' && entry.status === 'open') return { state: 'pending', badge: '★ 要你定' };
  if (entry.kind === 'decided' && entry.decidedBy === 'central') return { state: 'confirmed', badge: '中控已定 ✓' };
  if (entry.chosen !== undefined && entry.acknowledgedAt !== undefined) return { state: 'confirmed', badge: '已定 ✓' };
  if (entry.chosen !== undefined) return { state: 'chosen', badge: '已定 ✓' };
  if (entry.status === 'done') return { state: 'done', badge: '已完成' };
  if (entry.status === 'dropped') return { state: 'done', badge: '已放下' };
  if (entry.kind === 'decided' || entry.status === 'decided') return { state: 'confirmed', badge: '已定 ✓' };
  if (entry.status === 'working') return { state: 'working', badge: '进行中' };
  if (entry.kind === 'fork') return { state: 'fork', badge: '分叉' };

  return { state: 'open', badge: '功能' };
}

/** 当前目标在图上用一句短标题，说明仍保留完整目标。 */
function getCanvasTitle(entry: types.DecisionNode): string {
  const prefix = '让 jmbots 成为插件只靠事件互通';
  if (entry.kind === 'goal' && entry.title.startsWith(prefix)) return '让 jmbots 好扩展、好管理';

  return entry.title;
}

/** 尺寸固定以支持画布缩放，用按钮同时支持指针和键盘。 */
export function DecisionNode({ data, selected }: xyflow.NodeProps<layout.FlowNode>) {
  const { entry, open, fold } = data;

  //M 用相同的状态词和颜色表达中控是否已确认。
  const appearance = getAppearance(entry);
  let className = `decision-node decision-node--${appearance.state}`;
  if (entry.main === true) className += ' decision-node--main';
  if (selected) className += ' decision-node--selected';
  const title = getCanvasTitle(entry);

  //M 图上的每一侧都提供不可见的连接锚点，卡片本身用于点选查看。
  return (
    <div className={className}>
      <button
        type="button"
        className="decision-node__button nodrag"
        data-node-id={entry.id}
        aria-label={entry.title}
        title={entry.title}
        onClick={() => open(entry.id)}
      >
        <span className="decision-node__badge">{appearance.badge}</span>
        <strong className="decision-node__title">{title}</strong>
      </button>
      {fold !== undefined && <FoldButton fold={fold} title={entry.title} open={open} />}
      {SIDES.map((position) => (
        <xyflow.Handle
          key={`target-${position}`} type="target" id={position} position={position} isConnectable={false}
        />
      ))}
      {SIDES.map((position) => (
        <xyflow.Handle
          key={`source-${position}`} type="source" id={position} position={position} isConnectable={false}
        />
      ))}
    </div>
  );
}

/** 折叠整支子树时，让控件留在父卡片上，不再占用一个画布节点。 */
function FoldButton(
  { fold, title, open }: Required<Pick<layout.FlowNode['data'], 'fold' | 'open'>> & { title: string },
) {
  let badge = `+${fold.count}`;
  let label = `展开「${title}」下的 ${fold.count} 项`;
  if (fold.expanded) {
    badge = `−${fold.count}`;
    label = `折叠「${title}」下的 ${fold.count} 项`;
  }

  //M 展开控件只切换分支，卡片本身继续打开完整说明。
  return (
    <button
      type="button"
      className="decision-node__fold nodrag"
      title={label}
      aria-label={label}
      aria-expanded={fold.expanded}
      onClick={() => open(fold.id, true)}
    >
      {badge}
    </button>
  );
}
