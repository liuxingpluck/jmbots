/** 决策图节点的标题、当前状态和交互入口。 */
import * as xyflow from '@xyflow/react';
import type * as types from '../../../src7/plugins/work-decision/Types.ts';
import type * as layout from './Layout.ts';
import * as words from './Words.ts';

const t = words.t;

const SIDES = [xyflow.Position.Top, xyflow.Position.Right, xyflow.Position.Bottom, xyflow.Position.Left];

/** 按主线和决定状态提供视觉样式与说明。 */
function getAppearance(entry: types.DecisionNode): { state: string; badge: string } {
  if (entry.kind === 'goal') return { state: 'goal', badge: '当前目标' };
  if (entry.kind === 'pending' && entry.status === 'open') return { state: 'pending', badge: '★ 要你定' };
  if (entry.status === 'done') return { state: 'done', badge: '已完成' };
  if (entry.status === 'dropped') return { state: 'done', badge: '已放下' };
  if (entry.status === 'working') return { state: 'working', badge: '进行中' };
  if (entry.status === 'open' && entry.chosen !== undefined) return { state: 'open', badge: t('未开始') };
  if (entry.decidedBy === 'central') return { state: 'confirmed', badge: '中控已定 ✓' };
  if (entry.chosen !== undefined && entry.acknowledgedAt !== undefined) return { state: 'chosen', badge: '用户已定 ✓ 中控已收' };
  if (entry.chosen !== undefined || entry.decidedBy === 'user') return { state: 'chosen', badge: '用户已定 ✓' };
  if (entry.kind === 'decided' || entry.status === 'decided') return { state: 'confirmed', badge: '已定 ✓' };
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
export function DecisionNode({ data, selected }: xyflow.NodeProps<layout.CardNode>) {
  const { entry, open, fold, hint } = data;

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
        {hint !== undefined && <span className="decision-node__hint">{hint}</span>}
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

/** 按日期看法的日期卡片：点一下收起或展开这一天，有等用户定的事时醒目。 */
export function DayNode({ data }: xyflow.NodeProps<layout.DayNode>) {
  const { day, label, total, asks, expanded, open } = data;
  let className = 'decision-node decision-node--day';
  if (asks > 0) className += ' decision-node--day-ask';
  let badge = t('{total} 项，无待定', { total });
  if (asks > 0) badge = t('★ {asks} 件等你定 · 共 {total} 项', { asks, total });
  let mark = '▾';
  let action = t('收起「{label}」', { label });
  if (!expanded) {
    mark = '▸';
    action = t('展开「{label}」', { label });
  }

  //M 日期只有左进右出两个锚点，点击切换这一天的内容。
  return (
    <div className={className}>
      <button
        type="button"
        className="decision-node__button nodrag"
        data-day-id={day}
        aria-label={action}
        aria-expanded={expanded}
        title={action}
        onClick={() => open(`day:${day}`, !expanded)}
      >
        <span className="decision-node__badge">{badge}</span>
        <strong className="decision-node__title">{mark} {label}</strong>
      </button>
      <xyflow.Handle type="target" id={xyflow.Position.Left} position={xyflow.Position.Left} isConnectable={false} />
      <xyflow.Handle type="source" id={xyflow.Position.Right} position={xyflow.Position.Right} isConnectable={false} />
    </div>
  );
}

/** 折叠整支子树时，让控件留在父卡片上，不再占用一个画布节点。 */
function FoldButton(
  { fold, title, open }: Required<Pick<layout.CardNode['data'], 'fold' | 'open'>> & { title: string },
) {
  let badge = `+${fold.count}`;
  let label = t('展开「{title}」下的子项', { title });
  if (fold.expanded) {
    badge = `−${fold.count}`;
    label = t('折叠「{title}」下的子项', { title });
  }

  //M 展开控件只切换分支，卡片本身继续打开完整说明。
  return (
    <button
      type="button"
      className="decision-node__fold nodrag"
      title={label}
      aria-label={label}
      aria-expanded={fold.expanded}
      data-fold-node={fold.id}
      onClick={() => open(fold.id, !fold.expanded)}
    >
      {badge}
    </button>
  );
}
