/**
 * 知识库编辑区底部的「相关文档」：打开一篇已有文档时问后端推荐几篇相关的，点一篇就打开它。
 * 接口 GET /api/knowledge/docs/:id/related?limit=6（knowledge v1.0.2）；后端没上线、没有推荐时整块不显示。
 */
import * as react from 'react';
import * as api from './KnowledgeApi.ts';


/** RelatedDocs 的入参。 */
export interface RelatedDocsProps {
  /** 现在打开的文档号。 */
  docId: string;
  /** 点了一篇推荐：打开它。实现在 KnowledgePage 的 openDoc（经 KnowledgeEditor 的 onOpenDoc 传进来）。 */
  open: (id: string) => void;
}


/**
 * 一篇推荐：标题，加推荐理由徽章（同专题、共同标签……）；点了打开它。
 * @param props 这一篇和打开操作。
 */
function RelatedItem({ item, open }: { item: api.RelatedDocItem; open: (id: string) => void }) {
  const reasons = item.reasons ?? [];
  return (
    <li>
      <button type="button" className="kb-related-item" onClick={() => open(item.id)}>
        <span className="kb-related-title">{item.title}</span>
        {reasons.length > 0 && (
          <span className="kb-related-reasons">
            {reasons.map((reason) => <span key={reason} className="kb-related-reason">{reason}</span>)}
          </span>
        )}
      </button>
    </li>
  );
}


/**
 * 相关文档推荐列表。
 * @param props 文档号和打开操作。
 * @returns 还在拿、没有推荐、拿不到时是 null。
 */
export function RelatedDocs({ docId, open }: RelatedDocsProps) {
  const [items, setItems] = react.useState<api.RelatedDocItem[]>([]);

  /** 请求序号：换文档就加一，迟到的旧回包对不上就不认。 */
  const seqRef = react.useRef(0);

  react.useEffect(() => {
    //M 换文档：序号加一、清空旧推荐，旧请求在清理时中止。
    seqRef.current += 1;
    const seq = seqRef.current;
    const controller = new AbortController();
    setItems([]);

    //M 拿到了再看一眼是不是还是这篇。
    void api.fetchRelatedDocs(docId, 6, controller.signal).then((found) => {
      if (controller.signal.aborted || seq !== seqRef.current) return;

      setItems(found);
    });
    return () => {
      controller.abort();
    };
  }, [docId]);

  //G 没有推荐：整块不显示。
  if (items.length === 0) return null;

  return (
    <section className="kb-related" aria-label="相关文档">
      <h3>相关文档</h3>
      <ul>
        {items.map((item) => <RelatedItem key={item.id} item={item} open={open} />)}
      </ul>
    </section>
  );
}
