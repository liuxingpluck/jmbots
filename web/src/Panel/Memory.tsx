/**
 * 右栏的“记忆”（docs/界面/01_界面设计.md 第 11 节）：上面是这个机器人 memory/ 里的文件（MemoryFiles.tsx），下面是搜索。
 * 记忆搜索要开着基地 jmbots.exe（它取代了独立的 memorycli 服务）。
 *   记忆搜索：输入词，选库，看结果——每条显示文件、AI 摘要、标签、命中了哪几路、RRF 融合分数、命中片段（带行号）；点一下走预览。
 *   RAG：同一个词走 /rag/search（Tantivy + jieba，BM25），看片段和分数；还没建索引的库可以点一下建（后台跑）。
 * 只读记忆库；网页的请求都经后端转发给壳子（/api/memory/*、/api/rag/*）。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as memoryFiles from './MemoryFiles.tsx';


/** 搜哪一种。 */
type Mode = 'memory' | 'rag';


/** 记忆。 */
export function Memory(): react.JSX.Element {
  const t = i18n.useT();
  /** 打开预览。 */
  const openPanel = context.useUi((state) => state.openPanel);
  /** 库的清单；壳子不在时的原因。 */
  const [libs, setLibs] = react.useState<string[]>([]);
  const [problem, setProblem] = react.useState('');
  /** 选了哪些库、搜什么、搜哪一种。 */
  const [picked, setPicked] = react.useState<string[]>([]);
  const [query, setQuery] = react.useState('');
  const [mode, setMode] = react.useState<Mode>('memory');
  /** 结果。 */
  const [memoryHits, setMemoryHits] = react.useState<api.MemoryHit[]>([]);
  const [ragHits, setRagHits] = react.useState<api.RagHit[]>([]);
  const [notIndexed, setNotIndexed] = react.useState<string[]>([]);
  const [loading, setLoading] = react.useState(false);
  const [notice, setNotice] = react.useState('');

  react.useEffect(() => {
    void api.memoryLibs().then(
      (health) => {
        setLibs(health.libs.map((lib) => lib.name));
        setProblem('');
      },
      (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
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
      setNotice(error instanceof Error ? error.message : String(error));
      done();
    };
    if (mode === 'memory') {
      void api.memorySearch(query, picked).then((out) => {
        setMemoryHits(out.hits);
        done();
      }, fail);
    } else {
      void api.ragSearch(query, picked).then((out) => {
        setRagHits(out.hits);
        setNotIndexed(out.not_indexed);
        done();
      }, fail);
    }
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
    return (
      <>
        <memoryFiles.MemoryFiles />
        <div className="jm-empty">{t('记忆搜索要开着基地 jmbots.exe（{reason}）', { reason: problem })}</div>
      </>
    );
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
              void api.ragIndex(notIndexed).then(
                (out) => setNotice(t('开始建索引：{libs}，建好再搜一次', { libs: out.started.join('、') || t('（都在建）') })),
                (error: unknown) => setNotice(error instanceof Error ? error.message : String(error)),
              );
            }}
          >
            {t('建索引')}
          </antd.Button>
        </div>
      )}
      <div className="jm-memory-hits">
        {mode === 'memory' &&
          memoryHits.map((hit) => (
            <button key={`${hit.lib ?? ''}/${hit.path}`} type="button" className="jm-memory-hit" onClick={() => open(hit.abs_path, hit.path)}>
              <div className="jm-memory-hit-head">
                <span className="jm-memory-path">{hit.lib ? `${hit.lib} · ` : ''}{hit.path}</span>
                <span className="jm-memory-score" title={t('RRF 融合分数：每一路按排名给 1/(60+名次)，加起来')}>RRF {hit.score.toFixed(4)}</span>
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
            </button>
          ))}
        {mode === 'rag' &&
          ragHits.map((hit) => (
            <button key={`${hit.lib}/${hit.path}/${hit.start_line}`} type="button" className="jm-memory-hit" onClick={() => open(hit.abs_path, hit.path)}>
              <div className="jm-memory-hit-head">
                <span className="jm-memory-path">
                  {t('{lib} · {path} · 第 {start}～{end} 行', { lib: hit.lib, path: hit.path, start: hit.start_line, end: hit.end_line })}
                </span>
                <span className="jm-memory-score">BM25 {hit.score.toFixed(2)}</span>
              </div>
              {hit.title && <div className="jm-memory-summary">{hit.title}</div>}
              <div className="jm-memory-snippet">{hit.text}</div>
            </button>
          ))}
        {!loading && query && (mode === 'memory' ? memoryHits : ragHits).length === 0 && <div className="jm-muted">{t('没搜到（或者还没搜）')}</div>}
      </div>
    </div>
    </>
  );
}
