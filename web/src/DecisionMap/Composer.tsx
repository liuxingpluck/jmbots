/** 常驻直达中控输入框与专题往来留言流（PC 右侧常驻栏 / 手机底部悬浮条）。 */
import * as react from 'react';
import type * as types from '../../../src7/plugins/work-decision/Types.ts';
import * as drafts from './Drafts.ts';
import * as drawer from './Drawer.tsx';
import * as words from './Words.ts';

/** 新加的界面字过语言包；写成 t('原文')，提取脚本 scripts/I18n_Extract.ts 才认得出。 */
const t = words.t;

/** 带所属节点信息的单条留言，供专题或总览汇总时间线展示。 */
export interface ScopedNoteItem {
  /** 留言所属节点。 */
  node: types.DecisionNode;
  /** 留言记录本身。 */
  note: types.DecisionNote;
}

/**
 * 收集一组节点下的全部往来留言并按时间升序排列。
 * @param nodes 当前专题或总览范围内的节点列表。
 * @returns 按时间排序的留言数组。
 */
export function collectScopedNotes(nodes: types.DecisionNode[]): ScopedNoteItem[] {
  const items: ScopedNoteItem[] = [];
  for (const node of nodes) {
    for (const note of node.notes ?? []) {
      items.push({ node, note });
    }
  }
  items.sort((left, right) => left.note.at - right.note.at);
  return items;
}

/** 专题或节点往来留言流参数。 */
interface ScopeNoteFeedProps {
  /** 当前范围的节点集合。 */
  nodes: types.DecisionNode[];
  /** 当前范围主节点号（用于区分是否需要标注子节点名）。 */
  scopeRootId: string;
  /** 当前输入框锁定的目标节点号。 */
  targetNodeId: string;
  /** 点击某条子节点留言时切换输入框上下文到该子节点。 */
  onSelectNode: (id: string) => void;
}

/** 展示当前专题或节点下的用户留言、投递状态与中控回复。 */
export function ScopeNoteFeed({ nodes, scopeRootId, targetNodeId, onSelectNode }: ScopeNoteFeedProps) {
  const items = react.useMemo(() => collectScopedNotes(nodes), [nodes]);

  if (items.length === 0) {
    return (
      <section className="decision-notes decision-notes--empty" aria-label={t('往来留言与中控回复')}>
        <h3>{t('往来留言与中控回复')}</h3>
        <p className="decision-notes__placeholder">
          {t('还没有留言。在下方输入框写一句即可直达中控（经 relay 收发，中控回复自动回显在这里）。')}
        </p>
      </section>
    );
  }

  return (
    <section className="decision-notes" aria-label={t('往来留言与中控回复')}>
      <h3>{t('往来留言与中控回复')}（{String(items.length)}）</h3>
      <div role="list" className="decision-notes__list">
        {items.map(({ node, note }) => {
          let who = t('你');
          if (note.author === 'central') {
            who = t('中控');
          }
          let state = '';
          if (note.author === 'user' && note.repliedAt === undefined) {
            state = t('等中控回');
          }
          if (note.author === 'user' && note.repliedAt !== undefined) {
            state = t('中控已回');
          }
          const optionObj = node.options?.find((opt) => opt.id === note.option);
          let optionLabel = note.option ?? '';
          if (optionObj !== undefined) {
            optionLabel = optionObj.text;
          }
          const showNodeTag = node.id !== scopeRootId || nodes.length > 1;
          let itemClass = 'decision-note';
          if (node.id === targetNodeId && nodes.length > 1) {
            itemClass = 'decision-note decision-note--active';
          }
          return (
            <div key={`${node.id}:${note.id}`} role="listitem" className={itemClass} data-author={note.author}>
              <div className="decision-note__meta">
                <strong>{who}</strong> · {drawer.getTime(note.at)}
                {state !== '' && <span className="decision-note__state">{state}</span>}
                {showNodeTag && (
                  <button
                    type="button"
                    className="decision-note__node-chip"
                    onClick={() => onSelectNode(node.id)}
                    title={t('点此针对该节点继续发话')}
                  >
                    @{node.title}
                  </button>
                )}
              </div>
              {note.option !== undefined && (
                <p className="decision-note__option">{t('选了')}「{optionLabel}」</p>
              )}
              <p className="decision-note__text">{note.text}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** 常驻直达中控面板（PC 右栏常驻 / 手机底部悬浮）的参数。 */
export interface CentralDockProps {
  /** 当前输入框实际挂载的目标节点（选中的子节点，或默认挂当前专题/总览根）。 */
  targetNode: types.DecisionNode;
  /** 当前视图的默认挂靠节点（专题根或项目总览根）。 */
  defaultNode: types.DecisionNode;
  /** 当前范围全部节点，用于展示往来留言。 */
  scopeNodes: types.DecisionNode[];
  /** 取消具体子节点选中，退回默认专题/总览根。 */
  onResetTarget: () => void;
  /** 切换输入框锁定的节点。 */
  onSelectNode: (id: string) => void;
  /** 发送留言（复用 POST /api/work-decision/note）。 */
  onSendNote: (nodeId: string, text: string) => Promise<boolean>;
  /** 是否正在发送。 */
  sending: boolean;
  /** 发送错误提示。 */
  noteError?: string;
  /** 手机单栏已内嵌留言流时不在底部条重复展开列表。 */
  inlineMobileNotes?: boolean;
  /** 输入框的唯一 id（同页不与已打开的侧栏撞号）。 */
  inputId?: string;
}

/** 常驻直达中控输入栏：带上下文胶囊、按节点 localStorage 草稿持久化与往来留言回显。 */
export function CentralDock({
  targetNode,
  defaultNode,
  scopeNodes,
  onResetTarget,
  onSelectNode,
  onSendNote,
  sending,
  noteError,
  inlineMobileNotes,
  inputId = 'decision-write-text',
}: CentralDockProps) {
  const [draft, setDraft] = drafts.useNodeDraft(targetNode.id);
  const [mobileNotesOpen, setMobileNotesOpen] = react.useState(false);
  const written = draft.trim();
  const isCustomTarget = targetNode.id !== defaultNode.id;
  const isPending = targetNode.kind === 'pending' && targetNode.status === 'open';
  const noteCount = react.useMemo(() => collectScopedNotes(scopeNodes).length, [scopeNodes]);

  let hint = t('直达中控：追问、改主意、派新要求都可以写（草稿自动保存）');
  if (isPending) {
    hint = t('针对这道待拍板项发话给中控；也可写完直接点左侧选项一并发出');
  }

  /** 提交当前节点的草稿到中控 relay 收件箱。 */
  const submit = (event: react.FormEvent): void => {
    event.preventDefault();
    if (written === '' || sending) return;

    //M 发送成功才清空该节点草稿，失败保留原字方便重试。
    void onSendNote(targetNode.id, written).then((ok) => {
      if (ok) setDraft('');
    });
  };

  /** 桌面端支持 Ctrl+Enter 或 Cmd+Enter 快捷发送，中文输入法组合态不误触。 */
  const handleKeyDown = (event: react.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      if (written === '' || sending) return;

      void onSendNote(targetNode.id, written).then((ok) => {
        if (ok) setDraft('');
      });
    }
  };

  let mobileToggleText = `${t('留言')} (${String(noteCount)})`;
  if (mobileNotesOpen) {
    mobileToggleText = t('收起留言');
  }

  return (
    <aside className="decision-dock" aria-label={t('直达中控')}>
      <div className="decision-dock__notes" data-mobile-open={mobileNotesOpen && !inlineMobileNotes}>
        <ScopeNoteFeed
          nodes={scopeNodes}
          scopeRootId={defaultNode.id}
          targetNodeId={targetNode.id}
          onSelectNode={onSelectNode}
        />
      </div>
      <form className="decision-write decision-dock__form" onSubmit={submit}>
        <div className="decision-dock__capsule-row">
          <label className="decision-capsule" htmlFor={inputId} title={targetNode.title}>
            <span className="decision-capsule__prefix">{t('发往')}</span>
            <span className="decision-capsule__title">{targetNode.title}</span>
          </label>
          <div className="decision-dock__capsule-actions">
            {isCustomTarget && (
              <button
                type="button"
                className="decision-capsule__reset"
                onClick={onResetTarget}
                title={defaultNode.title}
              >
                × {t('回本专题')}
              </button>
            )}
            {!inlineMobileNotes && (
              <button
                type="button"
                className="decision-dock__mobile-notes-btn"
                onClick={() => setMobileNotesOpen(!mobileNotesOpen)}
              >
                {mobileToggleText}
              </button>
            )}
          </div>
        </div>
        <div className="decision-dock__input-row">
          <textarea
            id={inputId}
            value={draft}
            maxLength={2000}
            rows={2}
            placeholder={hint}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button type="submit" className="decision-dock__send" disabled={written === '' || sending}>
            {sending && t('发送中')}
            {!sending && t('发给中控')}
          </button>
        </div>
        {noteError !== undefined && noteError !== '' && (
          <p className="decision-error" role="alert">{noteError}</p>
        )}
      </form>
    </aside>
  );
}
