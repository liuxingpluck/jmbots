/**
 * 右栏的“记忆”（docs/界面/01_界面设计.md 第 11 节）：上面是这个机器人 memory/ 里的文件（MemoryFiles.tsx），下面是检索与入口。
 * 兼容两套后端：
 *   1. 新版 jmbots-memory（/api/memory/health 返回 counts/service，无 libs）：展示记忆规模统计、公共知识库检索，以及跳转到 /memory/ 和 /graph/ 的快捷入口；
 *   2. 旧版 memorycli（/api/memory/health 返回 libs）：保留按库筛选的 RRF 与 RAG（BM25）检索。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as virtuoso from 'react-virtuoso';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as memoryFiles from './MemoryFiles.tsx';
import * as readingModule from './Reading.ts';
import * as privacy from '../Privacy/Mask.tsx';
import * as vscodeLink from '../VscodeLink.tsx';
import { TOKEN, withToken } from '../Token.ts';


/** 旧版 memorycli 搜哪一种。 */
type Mode = 'memory' | 'rag';

/** 图谱检索路数显示名称。 */
const VIA_NAMES: Record<string, string> = {
  keyword: '关键词',
  vector: '向量',
  graph: '关系图',
};

/** 公共知识库片段前缀清洗（后端检索片段常带【来源：…】）。 */
function cleanSnippet(text: string): string {
  //M 剥离后端检索片段开头的来源标签，只保留正文摘要供卡片显示。
  return text.replace(/^【来源：[^】]*】\s*/u, '');
}


/**
 * 记忆。
 * @returns 记忆面板元素（包含本地记忆文件列表和知识库/RRF/RAG 检索界面）。
 * 副作用：挂载时探测记忆服务状态与库列表，检索或建索引时请求后端接口并可打开预览。
 */
export function Memory(): react.JSX.Element {
  //M 获取翻译函数与演示打码开关，供文案翻译和敏感内容隐藏使用。
  const t = i18n.useT();
  const masked = privacy.useMask();
  const panelScroll = react.useContext(readingModule.PanelScrollContext);
  /** 打开预览。 */
  //M 订阅全局面板打开动作，用于点击命中结果后打开文件预览。
  const openPanel = context.useUi((state) => state.openPanel);
  /** 服务模式（新版 jmbots-memory 或旧版 memorycli）；壳子不在时的原因。 */
  const [serviceMode, setServiceMode] = react.useState<'memsvc' | 'legacy' | null>(null);
  const [health, setHealth] = react.useState<api.MemoryHealth | null>(null);
  const [libs, setLibs] = react.useState<string[]>([]);
  const [problem, setProblem] = react.useState('');
  /** 选了哪些库、搜什么、搜哪一种。 */
  const [picked, setPicked] = react.useState<string[]>([]);
  const [query, setQuery] = react.useState('');
  const [mode, setMode] = react.useState<Mode>('memory');
  /** 结果。 */
  const [memoryHits, setMemoryHits] = react.useState<api.MemoryHit[]>([]);
  const [ragHits, setRagHits] = react.useState<api.RagHit[]>([]);
  const [knowledgeHits, setKnowledgeHits] = react.useState<api.MemoryGraphSearchHit[]>([]);
  const [notIndexed, setNotIndexed] = react.useState<string[]>([]);
  const [loading, setLoading] = react.useState(false);
  const [notice, setNotice] = react.useState('');
  const getErrorText = (error: unknown): string => {
    if (error instanceof Error) return error.message;

    return String(error);
  };

  react.useEffect(() => {
    //M 挂载时请求记忆服务健康状态，区分新版记忆服务与旧版分库模式。
    void api.memoryLibs().then(
      (result) => {
        setHealth(result);
        setProblem('');
        if (result.service === 'jmbots-memory' || !Array.isArray(result.libs)) {
          setServiceMode('memsvc');
          setLibs([]);
          return;
        }
        setServiceMode('legacy');
        setLibs(result.libs.map((lib) => lib.name));
      },
      //G 服务探测失败时记录可读错误原因，界面改为提示检查本地服务。
      (error: unknown) => setProblem(getErrorText(error)),
    );
  }, []);

  /** 搜一次。 */
  const search = (): void => {
    if (!query.trim()) {
      return;
    }
    setLoading(true);
    setNotice('');
    /** 搜完。 */
    const done = (): void => setLoading(false);
    /** 出错。 */
    const fail = (error: unknown): void => {
      //G 检索请求失败时显示可读错误信息并结束加载态。
      setNotice(getErrorText(error));
      done();
    };
    if (serviceMode === 'memsvc') {
      //M 新版服务调用图谱公共知识库检索，成功后更新命中列表并收起加载态。
      void api.memoryGraphKnowledgeSearch(query).then((out) => {
        setKnowledgeHits(out.hits);
        done();
      }, fail);
      return;
    }
    if (mode === 'memory') {
      //M 旧版记忆模式执行多路 RRF 检索，拿到结果后刷新列表并结束加载态。
      void api.memorySearch(query, picked).then((out) => {
        setMemoryHits(out.hits);
        done();
      }, fail);
      return;
    }
    //M 旧版 RAG 模式执行 BM25 检索，更新命中片段与未建索引库清单并收起加载态。
    void api.ragSearch(query, picked).then((out) => {
      setRagHits(out.hits);
      setNotIndexed(out.not_indexed);
      done();
    }, fail);
  };

  /**
   * 在预览里打开一个命中的文件。
   * @param path 绝对路径；没有时不能打开。
   * @param name 显示的名字。
   */
  const open = (path: string | undefined, name: string): void => {
    if (path) {
      openPanel('preview', { path, name });
    }
  };

  if (problem) {
    //G 记忆服务未就绪时仅渲染本地文件列表和脱敏后的故障提示。
    return (
      <>
        <memoryFiles.MemoryFiles />
        <div className="jm-empty">{t('记忆搜索要开着基地 jmbots.exe（{reason}）', { reason: privacy.text(problem, masked) })}</div>
      </>
    );
  }
  //G 演示打码开启时不挂载检索结果和个人记忆文件列表，避免旁路露出微信资料。
  if (masked) return <div className="jm-empty">记忆内容（已打码），关闭演示打码后可检索和查看。</div>;

  if (serviceMode === 'memsvc') {
    const counts = health?.counts;
    let statsText = 'jmbots-memory 在线';
    if (counts) {
      statsText = `jmbots-memory · ${String(counts.docs ?? 0)} 段 · ${String(counts.entities ?? 0)} 实体 · ${String(counts.relations ?? 0)} 关系`;
    }
    const renderKnowledgeHit = (hit: api.MemoryGraphSearchHit): react.JSX.Element => {
      //M 剥离片段来源前缀，只保留正文摘要供知识库命中卡片展示。
      const summaryText = cleanSnippet(hit.snippet);
      return (
        <div
          key={hit.id}
          role="button"
          tabIndex={0}
          className="jm-memory-hit"
          style={{ width: '100%' }}
          //M 点击命中卡片时在右栏预览对应的知识原文件。
          onClick={() => open(hit.file, hit.title)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              //M 键盘回车或空格激活卡片时同样打开文件预览。
              open(hit.file, hit.title);
            }
          }}
        >
          <div className="jm-memory-hit-head">
            <span className="jm-memory-path">{hit.title}</span>
            <span className="jm-memory-score">
              {Boolean(hit.file) && <vscodeLink.VsCodeOpen site={hit.file ?? ''} />}
              {' '}{hit.score.toFixed(3)}
            </span>
          </div>
          <div className="jm-memory-routes">
            {hit.via.map((route) => (
              <antd.Tag key={route}>{VIA_NAMES[route] ?? route}</antd.Tag>
            ))}
          </div>
          <div className="jm-memory-snippet">{summaryText}</div>
        </div>
      );
    };
    //M 渲染新版记忆服务界面：展示文件列表、规模统计、带令牌跳转链接及检索结果。
    return (
      <>
        <memoryFiles.MemoryFiles />
        <div className="jm-memory">
          <div className="jm-memory-service">
            <span className="jm-muted">{statsText}</span>
            <span className="jm-memory-links">
              <a href={withToken('/memory/', TOKEN)} target="_blank" rel="noreferrer">{t('记忆检索页')}</a>
              <a href={withToken('/graph/', TOKEN)} target="_blank" rel="noreferrer">{t('关系图谱')}</a>
            </span>
          </div>
          <antd.Input.Search value={query} placeholder={t('搜公共知识库')} enterButton={t('搜')} loading={loading} onChange={(event) => setQuery(event.target.value)} onSearch={search} />
          {notice && <div className="jm-field-error">{notice}</div>}
          <div className="jm-memory-hits">
            {knowledgeHits.length > 0 && panelScroll !== null && (
              <virtuoso.Virtuoso
                customScrollParent={panelScroll}
                data={knowledgeHits}
                computeItemKey={(_index, hit) => hit.id}
                itemContent={(_index, hit) => <div style={{ paddingBottom: 8 }}>{renderKnowledgeHit(hit)}</div>}
              />
            )}
            {!loading && query && knowledgeHits.length === 0 && <div className="jm-muted">{t('没搜到（点「搜」查公共知识库，查客户聊天请去记忆检索页）')}</div>}
          </div>
        </div>
      </>
    );
  }

  const renderMemoryHit = (hit: api.MemoryHit): react.JSX.Element => {
    let libPrefix = '';
    if (hit.lib) {
      libPrefix = `${hit.lib} · `;
    }
    return (
      <div
        key={`${hit.lib ?? ''}/${hit.path}`}
        role="button"
        tabIndex={0}
        className="jm-memory-hit"
        style={{ width: '100%' }}
        //M 点击记忆命中卡片时在右栏打开对应原文件预览。
        onClick={() => open(hit.abs_path, hit.path)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            //M 键盘回车或空格激活时打开对应记忆文件预览。
            open(hit.abs_path, hit.path);
          }
        }}
      >
        <div className="jm-memory-hit-head">
          <span className="jm-memory-path">{libPrefix}{hit.path}</span>
          <span className="jm-memory-score" title={t('RRF 融合分数：每一路按排名给 1/(60+名次)，加起来')}>
            {Boolean(hit.abs_path) && <vscodeLink.VsCodeOpen site={hit.abs_path ?? ''} />}
            {' '}RRF {hit.score.toFixed(4)}
          </span>
        </div>
        <div className="jm-memory-routes">
          {hit.matched.map((route) => (
            <antd.Tag key={route}>{route}</antd.Tag>
          ))}
          {hit.tags.slice(0, 6).map((tag) => (
            <antd.Tag key={`t-${tag}`} color="blue">
              {tag}
            </antd.Tag>
          ))}
        </div>
        {hit.summary && <div className="jm-memory-summary">{hit.summary}</div>}
        {hit.snippets.slice(0, 2).map((snippet) => (
          <div key={`${snippet.start_line}-${snippet.end_line}`} className="jm-memory-snippet">
            <span className="jm-muted">
              {t('第 {start}～{end} 行 {title}', { start: snippet.start_line, end: snippet.end_line, title: snippet.title })}
            </span>
            <div>{snippet.text}</div>
          </div>
        ))}
      </div>
    );
  };

  const renderRagHit = (hit: api.RagHit): react.JSX.Element => {
    const ragSite = `${hit.abs_path}:${String(hit.start_line)}`;
    return (
      <div
        key={`${hit.lib}/${hit.path}/${hit.start_line}`}
        role="button"
        tabIndex={0}
        className="jm-memory-hit"
        style={{ width: '100%' }}
        //M 点击 RAG 命中卡片时在右栏打开对应原文件预览。
        onClick={() => open(hit.abs_path, hit.path)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            //M 键盘回车或空格激活时打开对应 RAG 原文件预览。
            open(hit.abs_path, hit.path);
          }
        }}
      >
        <div className="jm-memory-hit-head">
          <span className="jm-memory-path">
            {t('{lib} · {path} · 第 {start}～{end} 行', { lib: hit.lib, path: hit.path, start: hit.start_line, end: hit.end_line })}
          </span>
          <span className="jm-memory-score">
            {hit.abs_path !== '' && <vscodeLink.VsCodeOpen site={ragSite} />}
            {' '}BM25 {hit.score.toFixed(2)}
          </span>
        </div>
        {hit.title && <div className="jm-memory-summary">{hit.title}</div>}
        <div className="jm-memory-snippet">{hit.text}</div>
      </div>
    );
  };

  let activeHitsCount = ragHits.length;
  if (mode === 'memory') {
    activeHitsCount = memoryHits.length;
  }
  return (
    <>
    <memoryFiles.MemoryFiles />
    <div className="jm-memory">
      <antd.Segmented
        size="small"
        value={mode}
        options={[
          { value: 'memory', label: t('记忆搜索（RRF）') },
          { value: 'rag', label: t('RAG（BM25）') },
        ]}
        onChange={(value) => setMode(value as Mode)}
      />
      <antd.Select mode="multiple" allowClear placeholder={t('全部库（{count} 个）', { count: libs.length })} value={picked} options={libs.map((name) => ({ value: name, label: name }))} onChange={(value: string[]) => setPicked(value)} />
      <antd.Input.Search value={query} placeholder={t('搜什么')} enterButton={t('搜')} loading={loading} onChange={(event) => setQuery(event.target.value)} onSearch={search} />
      {notice && <div className="jm-field-error">{notice}</div>}
      {mode === 'rag' && notIndexed.length > 0 && (
        <div className="jm-memory-notice">
          <span>{t('这几个库还没建 RAG 索引：{libs}', { libs: notIndexed.join('、') })}</span>
          <antd.Button
            size="small"
            onClick={() => {
              //M 为未建索引的库触发后台 RAG 建索引，完成后提示用户重新检索。
              void api.ragIndex(notIndexed).then(
                (out) => setNotice(t('开始建索引：{libs}，建好再搜一次', { libs: out.started.join('、') || t('（都在建）') })),
                //G 建索引请求失败时展示可读错误原因。
                (error: unknown) => setNotice(getErrorText(error)),
              );
            }}
          >
            {t('建索引')}
          </antd.Button>
        </div>
      )}
      <div className="jm-memory-hits">
        {mode === 'memory' && memoryHits.length > 0 && panelScroll !== null && (
          <virtuoso.Virtuoso
            customScrollParent={panelScroll}
            data={memoryHits}
            computeItemKey={(_index, hit) => `${hit.lib ?? ''}/${hit.path}`}
            itemContent={(_index, hit) => <div style={{ paddingBottom: 8 }}>{renderMemoryHit(hit)}</div>}
          />
        )}
        {mode === 'rag' && ragHits.length > 0 && panelScroll !== null && (
          <virtuoso.Virtuoso
            customScrollParent={panelScroll}
            data={ragHits}
            computeItemKey={(_index, hit) => `${hit.lib}/${hit.path}/${hit.start_line}`}
            itemContent={(_index, hit) => <div style={{ paddingBottom: 8 }}>{renderRagHit(hit)}</div>}
          />
        )}
        {!loading && query && activeHitsCount === 0 && <div className="jm-muted">{t('没搜到（或者还没搜）')}</div>}
      </div>
    </div>
    </>
  );
}
