/**
 * 知识库编辑区下方的「🔗 双向链接」折叠卡片：引出链接（本篇写的 [[ ]]，还没建的标成虚线、可一键创建）
 * 和反向链接（谁引用了本篇），点一项就打开那篇。接口 GET /api/knowledge/docs/:id/links（knowledge 1.1.0）。
 * 后端没上线、拿不到时整块不显示。
 */
import * as react from 'react';
import * as api from './KnowledgeApi.ts';


/** LinksPanel 的入参。 */
export interface LinksPanelProps {
  /** 现在打开的文档号。 */
  docId: string;
  /** 这篇的 updatedAt：保存后变了就重新拉。 */
  version: number;
  /** 打开一篇。实现在 KnowledgePage 的 openDoc。 */
  open: (id: string) => void;
  /** 创建一篇还没有的词条。实现在 KnowledgePage 的 createTitled；只读时不给。 */
  create: ((title: string) => void) | undefined;
}


/**
 * 双向链接卡片。
 * @param props 文档号、版本和打开、创建操作。
 * @returns 还在拿、拿不到时是 null。
 */
export function LinksPanel(props: LinksPanelProps): react.JSX.Element | null {
  const { docId, version, open, create } = props;
  const [links, setLinks] = react.useState<api.KnowledgeLinksResponse>();

  react.useEffect(() => {
    //M 换文档或保存后：中止旧请求，拿到了再认。
    const controller = new AbortController();
    api.fetchDocLinks(docId, controller.signal).then((found) => {
      if (controller.signal.aborted) return;

      setLinks(found);
    }).catch(() => {
      if (controller.signal.aborted) return;

      setLinks(undefined);
    });
    return () => controller.abort();
  }, [docId, version]);

  //G 拿不到：整块不显示。
  if (links === undefined) return null;

  const total = links.outgoing.length + links.backlinks.length;
  return (
    <details className="kb-links" open={total > 0}>
      <summary>
        🔗 双向链接
        <span className="kb-muted kb-small">
          引出 {links.outgoing.length} · 被引用 {links.backlinks.length}
        </span>
      </summary>
      <div className="kb-links-cols">
        <section aria-label="引出链接">
          <h4>引出链接 Outlinks</h4>
          {links.outgoing.length === 0 && <p className="kb-muted kb-small">正文里还没有 [[双链]]</p>}
          <ul>
            {links.outgoing.map((link) => (
              <li key={link.targetTitle}>
                {link.targetId !== null && (
                  <button type="button" className="kb-wiki-chip" onClick={() => open(link.targetId!)}>
                    {link.targetTitle}
                  </button>
                )}
                {link.targetId === null && (
                  <span className="kb-links-missing">
                    <span className="kb-wiki-chip" data-missing="true">{link.targetTitle}</span>
                    {create !== undefined && (
                      <button type="button" className="kb-link-btn" onClick={() => create(link.targetTitle)}>
                        创建该词条
                      </button>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="反向链接">
          <h4>谁引用了本篇 Backlinks</h4>
          {links.backlinks.length === 0 && <p className="kb-muted kb-small">还没有别的词条链到这里</p>}
          <ul>
            {links.backlinks.map((item) => (
              <li key={item.id}>
                <button type="button" className="kb-related-item" onClick={() => open(item.id)}>
                  <span className="kb-related-title">{item.title}</span>
                  {item.summary !== '' && <span className="kb-doc-summary">{item.summary}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </details>
  );
}
