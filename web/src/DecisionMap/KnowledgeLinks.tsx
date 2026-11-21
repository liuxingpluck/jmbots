/**
 * 工作决策抽屉里的「相关文档」：按节点号（知识库的 topicId）列出挂在这个专题下的知识库文档，
 * 点一篇在新标签打开知识库看它；「＋ 记一篇」在新标签打开知识库新建页，带上专题和标题；
 * 「🔗 关联已有」展开一个小搜索框，挑一篇已有文档移到本专题（一篇文档只挂一个专题，原专题会解除）。
 * 知识库没启用（接口 404）时整块不显示；403、500、网络不通显示一行灰字「相关文档暂时拿不到」（云端 29 #14）；
 * 401 照工作台的老办法广播未授权事件。切回这个标签页时自动重拉（在新标签记完一篇回来就能看到，云端 29 #13）。
 * 接口：GET /api/knowledge/docs?topicId=&limit=20、GET /api/knowledge/search?q=&includeMemory=0&limit=10、
 *   PUT /api/knowledge/docs/:id {topicId}（src7/plugins/knowledge/Routes.ts）。
 * 设计见 docs/开发进度/积木知识库第3步前端设计_20261121.md 2.3 节。
 */
import * as react from 'react';
import * as token from '../Token.ts';
import * as words from './Words.ts';

const t = words.t;

/** 最多列几篇。 */
const DOC_LIMIT = 20;
/** 关联搜索最多几条候选。 */
const PICK_LIMIT = 10;
/** 搜索框停手多久才搜。 */
const SEARCH_DELAY_MS = 300;


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
  /** 现在挂的专题；关联候选里用来提示“会从哪个专题移过来”。 */
  topicId: string | null;
}

/**
 * 这一块现在的样子：
 *   loading 还在拿（不显示，免得一闪）；hidden 知识库没启用（不显示）；
 *   failed 拿不到（显示一行灰字）；ready 拿到了（可能是 0 篇）。
 */
type LinksState =
  | { phase: 'loading' }
  | { phase: 'hidden' }
  | { phase: 'failed' }
  | { phase: 'ready'; docs: DocSummary[] };

/** 调知识库接口的结果：undefined 是被中止或网络不通。 */
type CallResult = { status: number; body: unknown } | undefined;

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
 * 调一个知识库接口，读出状态码和 JSON。
 * @param route /api/knowledge/ 后面的路径（含查询串）。
 * @param init fetch 选项。
 * @returns 状态码和回包；被中止、网络不通是 undefined。
 * 副作用：401 时广播 jmbots:unauthorized，页面弹出令牌输入条（和 DecisionMapApi.ts 的 request 一样）。
 */
async function callKnowledge(route: string, init?: RequestInit): Promise<CallResult> {
  //M 非本机打开时带上已保存的令牌。
  const address = token.withToken(`/api/knowledge/${route}`, token.TOKEN);
  let response: Response;
  try {
    response = await fetch(address, init);
  } catch {
    return undefined;
  }

  //G 没令牌：照工作台的老办法广播未授权事件。
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent('jmbots:unauthorized'));
  }
  const body = await response.json().catch(() => undefined) as unknown;
  return { status: response.status, body };
}


/**
 * 从回包里取文档数组，只留有字符串 id 和 title 的项（云端 29 #12）。
 * @param body 回包。
 * @param key 数组在哪个键下：列表是 items，搜索是 hits。
 * @returns 文档摘要；回包不对是 undefined。
 */
function getDocs(body: unknown, key: 'items' | 'hits'): DocSummary[] | undefined {
  const record = body as Record<string, unknown> | undefined;
  const list = record?.[key];
  if (record?.['ok'] !== true || !Array.isArray(list)) return undefined;

  const items = list as Partial<DocSummary>[];
  return items.filter((item) => typeof item.id === 'string' && typeof item.title === 'string') as DocSummary[];
}


/**
 * 拿挂在这个节点下的文档。
 * @param nodeId 节点号（topicId）。
 * @param signal 换节点、关抽屉时中止。
 * @returns 这一块该显示成什么；被中止交回 undefined（不改显示）。
 */
async function loadDocs(nodeId: string, signal: AbortSignal): Promise<LinksState | undefined> {
  const query = new URLSearchParams({ topicId: nodeId, limit: String(DOC_LIMIT) });
  const result = await callKnowledge(`docs?${query.toString()}`, { signal });
  if (signal.aborted) return undefined;

  //G 网络不通、403、500：显示灰字；知识库没启用（404）：整块不显示。
  if (result === undefined) return { phase: 'failed' };
  if (result.status === 404) return { phase: 'hidden' };

  const docs = getDocs(result.body, 'items');
  if (docs === undefined) return { phase: 'failed' };

  return { phase: 'ready', docs };
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


/** 关联搜索框的参数。 */
interface LinkPickerProps {
  /** 当前节点号：候选里去掉已经挂在这里的，选中后挂到这里。 */
  nodeId: string;
  /** 挂好了：KnowledgeLinks 重拉列表、收起搜索框。 */
  linked: () => void;
}


/** 「关联已有」：搜知识库，点一篇移到本专题。 */
function LinkPicker({ nodeId, linked }: LinkPickerProps) {
  const [text, setText] = react.useState('');
  const [found, setFound] = react.useState<DocSummary[]>();
  const [hint, setHint] = react.useState<string>();
  const [busyId, setBusyId] = react.useState<string>();

  //M 停手 300ms 才搜；换词时中止上一次，迟到的回包不认。
  react.useEffect(() => {
    const q = text.trim();
    if (q === '') {
      setFound(undefined);
      setHint(undefined);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ q, includeMemory: '0', limit: String(PICK_LIMIT) });
      void callKnowledge(`search?${query.toString()}`, { signal: controller.signal }).then((result) => {
        if (controller.signal.aborted) return;

        const docs = getDocs(result?.body, 'hits');
        if (docs === undefined) {
          setFound(undefined);
          setHint(t('相关文档暂时拿不到'));
          return;
        }
        setFound(docs.filter((doc) => doc.topicId !== nodeId));
        setHint(undefined);
      });
    }, SEARCH_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [nodeId, text]);

  //M 点一篇：PUT topicId 挂到本专题；成功就让外面重拉、收起。
  const pick = async (doc: DocSummary): Promise<void> => {
    if (busyId !== undefined) return;

    setBusyId(doc.id);
    const init: RequestInit = {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topicId: nodeId }),
    };
    const result = await callKnowledge(`docs/${encodeURIComponent(doc.id)}`, init);
    setBusyId(undefined);
    if (result !== undefined && result.status === 200) {
      linked();
      return;
    }

    //G 没登录（403）、别的错：说一句，不关搜索框。
    let message = t('没移成，稍后再试');
    if (result?.status === 403) {
      message = t('需要先登录才能改知识库');
    }
    setHint(message);
  };

  return (
    <div className="decision-knowledge__picker">
      <input
        className="decision-knowledge__input"
        type="search"
        value={text}
        autoFocus
        placeholder={t('搜知识库里已有的文档')}
        onChange={(event) => setText(event.target.value)}
      />
      {hint !== undefined && <p className="decision-knowledge__hint">{hint}</p>}
      {found !== undefined && found.length === 0 && hint === undefined && (
        <p className="decision-knowledge__hint">{t('没有能移过来的文档')}</p>
      )}
      {found !== undefined && found.length > 0 && (
        <ul className="decision-knowledge__candidates">
          {found.map((doc) => (
            <li key={doc.id}>
              <button
                type="button"
                className="decision-knowledge__candidate"
                disabled={busyId !== undefined}
                onClick={() => void pick(doc)}
              >
                <span className="decision-knowledge__title">{doc.title}</span>
                {doc.topicId !== null && (
                  <span className="decision-knowledge__summary">{t('现挂在别的专题，会移过来')}</span>
                )}
                <span className="decision-knowledge__move">
                  {busyId === doc.id && t('正在移…')}
                  {busyId !== doc.id && t('移到本专题')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


/**
 * 抽屉里的「相关文档」一块。
 * @param props 节点号和标题。
 * @returns 知识库没启用、还在拿时是 null；拿不到显示一行灰字；拿到了列文档、「＋ 记一篇」和「🔗 关联已有」。
 */
export function KnowledgeLinks({ nodeId, title }: KnowledgeLinksProps) {
  const [state, setState] = react.useState<LinksState>({ phase: 'loading' });
  const [picking, setPicking] = react.useState(false);
  const [reloadKey, setReloadKey] = react.useState(0);

  /** 请求序号：换节点、重拉都加一，迟到的旧回包对不上序号就不认。 */
  const seqRef = react.useRef(0);

  //M 换节点：回到“在拿”、收起搜索框（只在节点变时，重拉时不闪）。
  react.useEffect(() => {
    setState({ phase: 'loading' });
    setPicking(false);
  }, [nodeId]);

  react.useEffect(() => {
    seqRef.current += 1;
    const seq = seqRef.current;
    const controller = new AbortController();

    //M 拿到了再看一眼是不是还是这一次：中止了、序号变了都不认。
    void loadDocs(nodeId, controller.signal).then((next) => {
      if (next === undefined || seq !== seqRef.current) return;

      setState(next);
    });

    //M 换节点、重拉、关抽屉：中止这次请求。
    return () => {
      controller.abort();
    };
  }, [nodeId, reloadKey]);

  //M 切回这个标签页时重拉：在新标签的知识库记完一篇回来就能看到（云端 29 #13）。
  react.useEffect(() => {
    const onVisibility = (): void => {
      if (document.hidden) return;

      setReloadKey((current) => current + 1);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  /** 关联好了：重拉、收起搜索框。 */
  const linked = react.useCallback(() => {
    setPicking(false);
    setReloadKey((current) => current + 1);
  }, []);

  //G 还在拿、知识库没启用：整块不显示。
  if (state.phase === 'loading' || state.phase === 'hidden') return null;

  //G 拿不到：一行灰字，不静默消失（云端 29 #14）。
  if (state.phase === 'failed') {
    return (
      <section className="decision-knowledge" aria-label={t('相关文档')}>
        <p className="decision-knowledge__empty">{t('相关文档暂时拿不到')}</p>
      </section>
    );
  }

  //M 「＋ 记一篇」：新标签打开知识库新建页，带上专题（节点号）和默认标题。
  const topic = encodeURIComponent(nodeId);
  const draftTitle = encodeURIComponent(title);
  const newHref = token.withToken(`/knowledge/?new=1&topic=${topic}&title=${draftTitle}`, token.TOKEN);
  const docs = state.docs;
  let pickText = t('🔗 关联已有');
  if (picking) {
    pickText = t('收起');
  }
  return (
    <section className="decision-knowledge" aria-label={t('相关文档')}>
      <div className="decision-knowledge__head">
        <h3>{t('相关文档')}</h3>
        <span className="decision-knowledge__actions">
          <button type="button" className="decision-knowledge__new" onClick={() => setPicking(!picking)}>
            {pickText}
          </button>
          <a className="decision-knowledge__new" href={newHref} target="_blank" rel="noreferrer">{t('＋ 记一篇')}</a>
        </span>
      </div>
      {picking && <LinkPicker nodeId={nodeId} linked={linked} />}
      {docs.length === 0 && <p className="decision-knowledge__empty">{t('这个专题还没有文档，记下的要点和资料会列在这里')}</p>}
      {docs.length > 0 && (
        <ul className="decision-knowledge__list">
          {docs.map((doc) => <DocItem key={doc.id} doc={doc} />)}
        </ul>
      )}
    </section>
  );
}
