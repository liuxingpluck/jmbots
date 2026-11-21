/**
 * 工作决策抽屉里的「相关文档」：按节点号（知识库的 topicId）列出挂在这个专题下的知识库文档，
 * 点一篇在新标签打开知识库看它；「＋ 记一篇」在新标签打开知识库新建页，带上专题和标题。
 * 知识库没启用（接口 404）、网络不通、回包不对时整块不显示，不打扰工作台；401 照工作台的老办法广播未授权事件。
 * 接口：GET /api/knowledge/docs?topicId=<节点号>&limit=20（src7/plugins/knowledge 的 HTTP 接口）。
 * 设计见 docs/开发进度/积木知识库第3步前端设计_20261121.md 2.3 节。
 */
import * as react from 'react';
import * as token from '../Token.ts';
import * as words from './Words.ts';

const t = words.t;

/** 最多列几篇。 */
const DOC_LIMIT = 20;


/** 知识库交回的一篇文档摘要：只取这里用到的几项，字段同 src7/plugins/knowledge/Types.ts 的 KnowledgeDocSummary。 */
interface DocSummary {
  /** 文档号：打开时拼进 /knowledge/?doc=。 */
  id: string;
  /** 标题。 */
  title: string;
  /** 摘要：这里只显示第一行有字的。 */
  summary: string;
  /** 标签名。 */
  tags: string[];
}

/**
 * 这一块现在的样子：
 *   loading 还在拿（不显示，免得一闪）；hidden 知识库没启用或拿不到（不显示）；ready 拿到了（可能是 0 篇）。
 */
type LinksState = { phase: 'loading' } | { phase: 'hidden' } | { phase: 'ready'; docs: DocSummary[] };

/** KnowledgeLinks 的参数。 */
export interface KnowledgeLinksProps {
  /** 工作决策节点号：就是知识库文档的 topicId。 */
  nodeId: string;
  /** 节点标题：新建文档时带过去当默认标题。 */
  title: string;
}


/**
 * 摘要只取第一行有字的。
 * @param text 摘要全文。
 * @returns 第一行有字的；全是空的交回空串。
 */
function getFirstLine(text: string): string {
  const line = text.split(/\r?\n/u).find((one) => one.trim() !== '');
  if (line === undefined) return '';

  return line.trim();
}


/**
 * 拿挂在这个节点下的文档。
 * @param nodeId 节点号（topicId）。
 * @param signal 换节点、关抽屉时中止。
 * @returns 文档摘要；知识库没启用（404）、网络不通、被中止、回包不对都交回 undefined。
 * 副作用：401 时广播 jmbots:unauthorized，页面弹出令牌输入条（和 DecisionMapApi.ts 的 request 一样）。
 */
async function loadDocs(nodeId: string, signal: AbortSignal): Promise<DocSummary[] | undefined> {
  //M 拼地址：按专题筛、最多 20 篇；非本机打开时带上已保存的令牌。
  const query = new URLSearchParams({ topicId: nodeId, limit: String(DOC_LIMIT) });
  const address = token.withToken(`/api/knowledge/docs?${query.toString()}`, token.TOKEN);

  //G 网络不通、被中止：安静交回 undefined，整块不显示。
  let response: Response;
  try {
    response = await fetch(address, { signal });
  } catch {
    return undefined;
  }

  //G 没令牌：照工作台的老办法广播未授权事件，这一块先不显示。
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent('jmbots:unauthorized'));
    return undefined;
  }

  //G 知识库没启用（404）或别的错：不显示。
  if (!response.ok) return undefined;

  //M 回包要是 { ok: true, items: [...] }，别的样子都当拿不到。
  const body = await response.json().catch(() => undefined) as { ok?: unknown; items?: unknown } | undefined;
  if (body?.ok !== true || !Array.isArray(body.items)) return undefined;

  //G 只留有字符串 id 和 title 的项（云端 29 #12）。
  const items = body.items as Partial<DocSummary>[];
  return items.filter((item) => typeof item.id === 'string' && typeof item.title === 'string') as DocSummary[];
}


/**
 * 列表里的一篇：标题、摘要第一行、标签；点了在新标签打开知识库看它。
 * @param doc 文档摘要。
 */
function DocItem({ doc }: { doc: DocSummary }) {
  const href = token.withToken(`/knowledge/?doc=${encodeURIComponent(doc.id)}`, token.TOKEN);
  const line = getFirstLine(doc.summary ?? '');
  const tags = doc.tags ?? [];
  return (
    <li className="decision-knowledge__item">
      <a href={href} target="_blank" rel="noreferrer">
        <span className="decision-knowledge__title">{doc.title}</span>
        {line !== '' && <span className="decision-knowledge__summary">{line}</span>}
        {tags.length > 0 && (
          <span className="decision-knowledge__tags">
            {tags.map((tag) => <span key={tag} className="decision-knowledge__tag">{tag}</span>)}
          </span>
        )}
      </a>
    </li>
  );
}


/**
 * 抽屉里的「相关文档」一块。
 * @param props 节点号和标题。
 * @returns 知识库没启用、还在拿、拿不到时是 null；拿到了列文档（0 篇时一行引导）和「＋ 记一篇」。
 */
export function KnowledgeLinks({ nodeId, title }: KnowledgeLinksProps) {
  const [state, setState] = react.useState<LinksState>({ phase: 'loading' });

  /** 请求序号：换节点就加一，迟到的旧回包对不上序号就不认。 */
  const seqRef = react.useRef(0);

  react.useEffect(() => {
    //M 换节点：序号加一，先回到“在拿”，旧请求在清理时中止。
    seqRef.current += 1;
    const seq = seqRef.current;
    const controller = new AbortController();
    setState({ phase: 'loading' });

    //M 拿到了再看一眼是不是还是这个节点：中止了、序号变了都不认。
    void loadDocs(nodeId, controller.signal).then((docs) => {
      if (controller.signal.aborted || seq !== seqRef.current) return;

      if (docs === undefined) {
        setState({ phase: 'hidden' });
        return;
      }
      setState({ phase: 'ready', docs });
    });

    //M 换节点、关抽屉：中止这次请求。
    return () => {
      controller.abort();
    };
  }, [nodeId]);

  //G 还在拿、知识库没启用或拿不到：整块不显示。
  if (state.phase !== 'ready') return null;

  //M 「＋ 记一篇」：新标签打开知识库新建页，带上专题（节点号）和默认标题。
  const topic = encodeURIComponent(nodeId);
  const draftTitle = encodeURIComponent(title);
  const newHref = token.withToken(`/knowledge/?new=1&topic=${topic}&title=${draftTitle}`, token.TOKEN);
  const docs = state.docs;
  return (
    <section className="decision-knowledge" aria-label={t('相关文档')}>
      <div className="decision-knowledge__head">
        <h3>{t('相关文档')}</h3>
        <a className="decision-knowledge__new" href={newHref} target="_blank" rel="noreferrer">{t('＋ 记一篇')}</a>
      </div>
      {docs.length === 0 && <p className="decision-knowledge__empty">{t('这个专题还没有文档，记下的要点和资料会列在这里')}</p>}
      {docs.length > 0 && (
        <ul className="decision-knowledge__list">
          {docs.map((doc) => <DocItem key={doc.id} doc={doc} />)}
        </ul>
      )}
    </section>
  );
}
