/**
 * 中栏“文档列表”：顶部是目录名、篇数和“获取一下”，下面每篇显示标题、摘要、标签和时间。
 * 选中的目录来自网址：“全部文档”列出全部，具体目录只列它保存的成员。点一篇就改网址打开它。
 * “获取一下”第 3 步接上，现在按钮是灰的。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as format from '../Format.ts';
import * as knowledgeStore from '../KnowledgeStore.ts';
import type { DocumentSummary, KnowledgeBase } from '../Types.ts';
import * as viewStore from '../ViewStore.ts';


/** 文档列表栏：数据来自 KnowledgeStore，选中状态和搜索词来自 ViewStore。 */
export default function DocumentList() {
  /** 全部目录，用来找选中目录的名字和成员。 */
  const bases = knowledgeStore.useKnowledgeStore((state) => state.bases);
  /** 全部文档摘要。 */
  const documents = knowledgeStore.useKnowledgeStore((state) => state.documents);
  /** 是否正在加载。 */
  const loading = knowledgeStore.useKnowledgeStore((state) => state.loading);
  /** 加载失败的原因；没失败为 null。 */
  const error = knowledgeStore.useKnowledgeStore((state) => state.error);
  /** 网址里的选中状态。 */
  const current = viewStore.useViewStore((state) => state.route);
  /** 搜索框里的文字；只按标题过滤，空字符串表示不过滤。 */
  const query = viewStore.useViewStore((state) => state.query);
  /** 跳转的动作。 */
  const goTo = viewStore.useViewStore((state) => state.goTo);

  // m: 找到选中的目录，再筛出要列的文档。
  /** 选中的目录；选“全部文档”或目录已不存在时为 undefined。 */
  const base = bases.find((item) => item.id === current.baseId);
  /** 中栏要列出的文档。 */
  const visibleDocuments = react.useMemo(
    () => filterDocuments(documents, current.baseId, base, query),
    [documents, current.baseId, base, query],
  );
  /** 栏目标题：目录名；没选目录时当成“全部文档”，网址里的目录不存在时说明一下。 */
  const title = current.baseId === 'all' || current.baseId === null ? '全部文档' : (base?.name ?? '目录不存在');

  // g: 加载失败时不显示列表，直接说原因。
  if (error !== null) {
    return <antd.Result status="error" title="加载失败" subTitle={error} />;
  }
  return (
    <div className="document-list">
      <div className="pane-title">
        <span className="pane-title-text">{title}</span>
        <span className="pane-title-count">{visibleDocuments.length} 篇</span>
        <antd.Button size="small" disabled>
          获取一下
        </antd.Button>
      </div>
      <antd.List
        className="document-list-body"
        loading={loading}
        dataSource={visibleDocuments}
        locale={{ emptyText: '这里还没有文档' }}
        renderItem={(item) => (
          <DocumentItem
            item={item}
            selected={item.id === current.documentId}
            onOpen={() => goTo({ baseId: current.baseId ?? 'all', documentId: item.id })}
          />
        )}
      />
    </div>
  );
}


/** DocumentItem 的参数。 */
interface DocumentItemProps {
  /** 这一篇的摘要。 */
  item: DocumentSummary;
  /** 是不是右栏正在显示的那篇。 */
  selected: boolean;
  /** 点击或按回车时调用，打开这一篇。 */
  onOpen: () => void;
}


/** 列表里的一篇：标题、两行摘要、标签和时间。 */
function DocumentItem(props: DocumentItemProps) {
  return (
    <antd.List.Item
      className={props.selected ? 'document-item is-selected' : 'document-item'}
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          props.onOpen();
        }
      }}
    >
      <div className="document-item-body">
        <div className="document-item-title">{props.item.title}</div>
        <div className="document-item-summary">{props.item.summary}</div>
        <div className="document-item-meta">
          {props.item.tags.map((tag) => (
            <antd.Tag key={tag}>{tag}</antd.Tag>
          ))}
          <span className="document-item-time">{format.formatTime(props.item.createdAt)}</span>
        </div>
      </div>
    </antd.List.Item>
  );
}


/**
 * 按选中的目录和搜索词筛出要列的文档，按时间从新到旧排。
 * 具体目录只列它保存的成员；网址里的目录不存在时一篇都不列。
 */
function filterDocuments(
  documents: DocumentSummary[],
  baseId: number | 'all' | null,
  base: KnowledgeBase | undefined,
  query: string,
): DocumentSummary[] {
  // m: 选“全部文档”或还没选目录时不按成员筛；选具体目录时只留它的成员。
  /** 选中目录保存的文档 ID；为 null 表示不按成员筛。 */
  const memberIds = typeof baseId === 'number' ? new Set(base?.memberIds ?? []) : null;
  /** 去掉首尾空格并转成小写的搜索词；空字符串表示不按标题筛。 */
  const keyword = query.trim().toLowerCase();
  return documents
    .filter((item) => memberIds === null || memberIds.has(item.id))
    .filter((item) => keyword === '' || item.title.toLowerCase().includes(keyword))
    .sort((left, right) => right.createdAt - left.createdAt);
}
