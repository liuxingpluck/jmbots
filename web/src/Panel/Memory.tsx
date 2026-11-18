/**
 * 右栏的“记忆”（docs/界面/01_界面设计.md 第 11 节）：上面是这个机器人 memory/ 里的文件（MemoryFiles.tsx），下面是检索与入口。
 * 右栏显示 Rust 记忆服务统计、公共知识库检索和记忆页入口。
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
 * @returns 记忆文件列表和公共知识库检索。
 * 副作用：挂载时探活，搜索后可以打开文件预览。
 */
export function Memory(): react.JSX.Element {
  //M 获取翻译函数与演示打码开关，供文案翻译和敏感内容隐藏使用。
  const t = i18n.useT();
  const masked = privacy.useMask();
  const panelScroll = react.useContext(readingModule.PanelScrollContext);
  /** 打开预览。 */
  //M 订阅全局面板打开动作，用于点击命中结果后打开文件预览。
  const openPanel = context.useUi((state) => state.openPanel);
  const [health, setHealth] = react.useState<api.MemoryHealth | null>(null);
  const [problem, setProblem] = react.useState('');
  const [query, setQuery] = react.useState('');
  const [memoryHits, setMemoryHits] = react.useState<api.MemoryHit[]>([]);
  const [loading, setLoading] = react.useState(false);
  const [notice, setNotice] = react.useState('');
  const getErrorText = (error: unknown): string => {
    if (error instanceof Error) return error.message;

    return String(error);
  };

  react.useEffect(() => {
    //M 直接探测 Rust 记忆服务，离线时显示原因并保留记忆文件和搜索入口。
    void api.memoryHealth().then(
      (result) => {
        setHealth(result);
        setProblem(result.error ?? '');
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
    //M 右栏只检索公共知识库，状态和结果由统一接口返回。
    const params = new URLSearchParams({ q: query, sources: 'knowledge' });
    void api.memorySearch(params).then((out) => {
      //M 保存已收到的结果，并标出未响应的来源。
      setMemoryHits(out.hits);
      if (out.unavailable.length > 0) setNotice(`未响应：${out.unavailable.join('、')}`);
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

  //G 演示打码开启时不挂载检索结果和个人记忆文件列表，避免旁路露出微信资料。
  if (masked) return <div className="jm-empty">记忆内容（已打码），关闭演示打码后可检索和查看。</div>;

  const renderMemoryHit = (hit: api.MemoryHit): react.JSX.Element => {
    //M 去掉 Rust 添加的来源前缀，右栏标题上单独展示出处。
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

  const counts = health?.counts;
  let statsText = '正在读取记忆服务状态';
  if (health?.ok === true) statsText = 'jmbots-memory 在线';

  if (health?.ok === false || problem !== '') statsText = '记忆服务离线';
  if (health?.ok && counts) {
    const documents = String(counts.docs ?? 0);
    const entities = String(counts.entities ?? 0);
    const relations = String(counts.relations ?? 0);
    statsText = `jmbots-memory · ${documents} 段 · ${entities} 实体 · ${relations} 关系`;
  }
  //M 文件列表与知识库检索共用右栏。
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
        {problem !== '' && <div className="jm-muted">{problem}</div>}
        <antd.Input.Search value={query} placeholder={t('搜公共知识库')} enterButton={t('搜')} loading={loading}
          onChange={(event) => setQuery(event.target.value)} onSearch={search} />
        {notice && <div className="jm-field-error">{notice}</div>}
        <div className="jm-memory-hits">
          {memoryHits.length > 0 && panelScroll !== null && (
            <virtuoso.Virtuoso
              customScrollParent={panelScroll}
              data={memoryHits}
              computeItemKey={(_index, hit) => `${hit.source}:${hit.id}`}
              itemContent={(_index, hit) => <div style={{ paddingBottom: 8 }}>{renderMemoryHit(hit)}</div>}
            />
          )}
          {!loading && query && memoryHits.length === 0 && (
            <div className="jm-muted">{t('没搜到（点「搜」查公共知识库，查客户聊天请去记忆检索页）')}</div>
          )}
        </div>
      </div>
    </>
  );
}
