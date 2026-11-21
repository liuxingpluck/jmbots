/**
 * 知识库中栏：当前筛选胶囊、文档摘要列表（加载更多）、有搜索词时改显示搜索命中和折叠的“相关记忆”。
 * 只显示摘要不带正文，点了才由 KnowledgePage 去拉正文（简介索引 → 按需读正文）。
 */
import * as react from 'react';
import { TOKEN, withToken } from '../Token.ts';
import * as dirTree from './DirTree.tsx';
import * as api from './KnowledgeApi.ts';

/** 一个筛选胶囊：点 × 去掉这一项筛选。 */
export interface FilterChip {
  /** 哪一项：dir、tag、topic、q。 */
  key: 'dir' | 'tag' | 'topic' | 'q';
  /** 显示的字。 */
  label: string;
  /** 同一项里的哪一个值（多选标签每个标签一个胶囊）；单值的项不给。 */
  value?: string;
}

/** 中栏入参，数据和操作都来自 KnowledgePage。 */
interface DocListProps {
  /** 列表模式的文档摘要（没有搜索词时用）。 */
  items: api.KnowledgeDocSummary[];
  /** 列表模式满足筛选的总数。 */
  total: number;
  /** 搜索命中；有搜索词时才有，有它就显示它不显示 items。 */
  hits: api.KnowledgeSearchHit[] | undefined;
  /** 相关记忆命中。 */
  memoryHits: api.KnowledgeMemoryHit[];
  /** 记忆部分不可用时的温和说明。 */
  memoryWarning: string | undefined;
  /** 正在拉列表或搜索。 */
  loading: boolean;
  /** 列表或搜索失败的原因。 */
  error: string | undefined;
  /** 当前生效的筛选。 */
  chips: FilterChip[];
  /** 去掉一项筛选；给了 value 只去掉那一个值。实现在 KnowledgePage 的 clearChip。 */
  clearChip: (key: FilterChip['key'], value?: string) => void;
  /** 当前打开的文档号。 */
  activeId: string | undefined;
  /** 能不能把文档拖到目录上（桌面且可写）。 */
  dragEnabled: boolean;
  /** 目录号到目录名，列表里显示所在目录。 */
  dirNames: ReadonlyMap<string, string>;
  /** 打开一篇文档。实现在 KnowledgePage 的 openDoc。 */
  open: (id: string) => void;
  /** 加载下一页。实现在 KnowledgePage 的 loadMore。 */
  more: () => void;
}


/**
 * 毫秒时间戳写成“月-日 时:分”。
 * @param at 毫秒时间戳。
 */
export function getShortTime(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}


/**
 * 跳到工作决策并打开那个节点的地址（DecisionMapPage 认 ?focus=）。
 * @param topicId 工作决策节点号。
 */
export function getTopicHref(topicId: string): string {
  const route = `/work-decision/?focus=${encodeURIComponent(topicId)}`;
  return withToken(route, TOKEN);
}


/** 一行文档的入参。 */
interface DocRowProps {
  /** 文档摘要（搜索命中也是摘要加片段）。 */
  doc: api.KnowledgeDocSummary;
  /** 搜索命中的片段；没有就显示摘要。 */
  snippet: string | undefined;
  /** 是不是当前打开的。 */
  active: boolean;
  /** 能不能拖。 */
  dragEnabled: boolean;
  /** 所在目录名。 */
  dirName: string | undefined;
  /** 打开它。 */
  open: (id: string) => void;
}


/** 一行文档：标题、摘要两行、目录、标签、专题角标、更新时间。 */
function DocRow(props: DocRowProps): react.JSX.Element {
  const doc = props.doc;
  let text = doc.summary;
  if (props.snippet !== undefined && props.snippet !== '') {
    text = props.snippet;
  }

  //M 拖起来带文档号，DirTree 的目录行接住后移动文档。
  const onDragStart = (event: react.DragEvent): void => {
    event.dataTransfer.setData(dirTree.DOC_MIME, doc.id);
    //M 顺带文档现在所在的目录（未归类是空串）：拖回原目录时 DirTree 直接忽略，不发空 PUT。
    event.dataTransfer.setData(dirTree.DOC_DIR_MIME, doc.dirId ?? '');
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <li
      className="kb-doc-row"
      data-active={props.active}
      draggable={props.dragEnabled}
      onDragStart={onDragStart}
    >
      <button type="button" className="kb-doc-open" onClick={() => props.open(doc.id)}>
        <span className="kb-doc-title">{doc.title}</span>
        {text !== '' && <span className="kb-doc-summary">{text}</span>}
      </button>
      <div className="kb-doc-meta">
        {props.dirName !== undefined && <span className="kb-doc-dir">{props.dirName}</span>}
        {doc.tags.map((tag) => <span key={tag} className="kb-doc-tag">#{tag}</span>)}
        {doc.topicId !== null && (
          <a className="kb-topic" href={getTopicHref(doc.topicId)} title="在工作决策里打开这个节点">专题</a>
        )}
        <span className="kb-doc-time">{getShortTime(doc.updatedAt)}</span>
      </div>
    </li>
  );
}


/** 知识库中栏。 */
export function DocList(props: DocListProps): react.JSX.Element {
  //M 有搜索词时显示命中，没有时显示列表；两边共用 DocRow。
  const isSearch = props.hits !== undefined;
  let rows: { doc: api.KnowledgeDocSummary; snippet: string | undefined }[] = [];
  if (props.hits !== undefined) {
    rows = props.hits.map((hit) => ({ doc: hit, snippet: hit.snippet }));
  }
  if (props.hits === undefined) {
    rows = props.items.map((doc) => ({ doc, snippet: undefined }));
  }
  const hasMore = !isSearch && props.items.length < props.total;

  //M 头部一句话：搜索时说命中几篇，列表时说一共几篇。
  let headline = `共 ${String(props.total)} 篇`;
  if (isSearch) {
    headline = `命中 ${String(rows.length)} 篇`;
  }

  return (
    <section className="kb-list" aria-label="文档列表">
      <div className="kb-list-head">
        <span className="kb-muted">{headline}</span>
        {props.chips.map((chip) => (
          <button
            key={`${chip.key}:${chip.value ?? ''}`}
            type="button"
            className="kb-chip"
            onClick={() => props.clearChip(chip.key, chip.value)}
          >
            {chip.label}<span aria-hidden="true"> ×</span>
          </button>
        ))}
      </div>
      {props.error !== undefined && <p className="kb-error" role="alert">{props.error}</p>}
      {!props.loading && rows.length === 0 && props.error === undefined && (
        <p className="kb-empty">这里还没有文档</p>
      )}
      <ul className="kb-doc-list">
        {rows.map((row) => (
          <DocRow
            key={row.doc.id}
            doc={row.doc}
            snippet={row.snippet}
            active={props.activeId === row.doc.id}
            dragEnabled={props.dragEnabled}
            dirName={props.dirNames.get(row.doc.dirId ?? '')}
            open={props.open}
          />
        ))}
      </ul>
      {props.loading && <p className="kb-muted kb-center">正在加载…</p>}
      {hasMore && !props.loading && (
        <button type="button" className="kb-more" onClick={props.more}>
          加载更多（还有 {props.total - props.items.length} 篇）
        </button>
      )}
      {isSearch && props.memoryWarning !== undefined && <p className="kb-muted kb-small">{props.memoryWarning}</p>}
      {isSearch && props.memoryHits.length > 0 && (
        <details className="kb-memory">
          <summary>相关记忆（{props.memoryHits.length}）</summary>
          <ul>
            {props.memoryHits.map((hit) => (
              <li key={`${hit.source}:${hit.id}`}>
                <span className="kb-memory-source">{hit.source}</span>
                <span className="kb-memory-title">{hit.title}</span>
                <span className="kb-doc-summary">{hit.snippet}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
