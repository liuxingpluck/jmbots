/**
 * 模型介绍和评价汇总页（/model-notes/，web 插件托管 dist/web/model-notes.html）。2026-11-17。
 * 展示每个模型的介绍、打过分的会话数 N、平均分和最近评价；点评价里的会话号直接跳回主网页那场会话。
 * 打分只在主网页会话面板里点着打（或由其它 AI 调 POST /api/model-notes/rate），本页不放打分表单。
 * 不打码：这是用户自己的页面。
 */
import * as antd from 'antd';
import zhCN from 'antd/locale/zh_CN';
import * as react from 'react';
import * as reactMarkdown from 'react-markdown';
import * as virtuoso from 'react-virtuoso';
import remarkGfm from 'remark-gfm';
import * as theme from '../Theme.ts';
import { TOKEN, withToken } from '../Token.ts';


/** 一条评价。 */
interface Rating {
  /** 评价时间，形如 "2026-11-17 13:50 EST"。 */
  at: string;
  /** 评价者。 */
  by: string;
  /** 分数，1 到 5。 */
  score: number;
  /** 关联会话号；旧的手写记录为空串。 */
  session: string;
  /** 那场会话的思考档；未知或旧记录为空串。 */
  thinking: string;
  /** 旧格式里的任务名。 */
  task: string;
  /** 一句话评语。 */
  note: string;
}


/** 一个模型的介绍和评价汇总。 */
interface ModelNote {
  /** 模型 ID。 */
  model: string;
  /** 介绍，原样显示（保留换行，不渲染 Markdown）。 */
  intro: string;
  /** 评价，按文件里的先后排（旧的在前，同人同会话只留最新）。 */
  ratings: Rating[];
  /** 打过分的会话数 N。 */
  sessionCount: number;
  /** 平均分；没有评价时是 0。 */
  average: number;
}


/** 每个模型默认显示最近几条评价。 */
const SHOWN_COUNT = 5;


/** 访问 model-notes 列表接口，出错抛 Error。 */
class ModelNotesApi {
  /**
   * 拉所有模型汇总。
   * @returns 模型汇总列表。
   */
  async load(): Promise<ModelNote[]> {
    //M 给汇总接口拼上统一访问令牌发起 GET 请求，拉取所有模型的介绍与评价列表。
    const response = await fetch(withToken('/api/model-notes', TOKEN));
    const body = await response.json().catch(() => ({})) as { list: ModelNote[]; error?: string };
    //G 后端回了错：抛出 error，没有 error 字段就用状态码。
    if (!response.ok) throw new Error(body.error ?? `HTTP ${String(response.status)}`);

    return body.list;
  }
}


/** 页面用的接口实例。 */
//M 复用页面级单例接口对象，统一处理带令牌的 /api/model-notes 拉取与错误解析。
const api = new ModelNotesApi();


/**
 * 一个模型卡片：ID、平均分与会话数 N、介绍、最近评价（点会话号跳回主网页会话面板）。
 * @param props.note 这个模型的汇总内容。
 */
function ModelNoteCard(props: { note: ModelNote }): react.JSX.Element {
  const { note } = props;
  /** 评价是不是全部展开。 */
  const [expanded, setExpanded] = react.useState(false);

  //M 评价新的在前；没展开时只留最近 SHOWN_COUNT 条。
  const newestFirst = [...note.ratings].reverse();
  let shown = newestFirst;
  if (!expanded) {
    shown = newestFirst.slice(0, SHOWN_COUNT);
  }

  //M 平均分和会话数 N 文字；星星只读，按半星取整。
  let scoreText = '还没有会话打分';
  if (note.ratings.length > 0) {
    scoreText = `平均 ${note.average.toFixed(1)} 分 · ${String(note.sessionCount)} 场会话`;
    if (note.ratings.length !== note.sessionCount) {
      scoreText = `${scoreText}（共 ${String(note.ratings.length)} 条评价）`;
    }
  }
  const averageStars = Math.round(note.average * 2) / 2;

  //M 展开按钮的字。
  let expandText = `展开全部（共 ${String(newestFirst.length)} 条）`;
  if (expanded) {
    expandText = '收起';
  }

  //M 渲染单张模型卡片：名称与只读平均星级、Markdown 介绍以及最近评价列表。
  return (
    <antd.Card>
      <div className="mn-head">
        <antd.Typography.Text code copyable strong>{note.model}</antd.Typography.Text>
        <antd.Rate disabled allowHalf value={averageStars} />
        <span className="mn-score-text">{scoreText}</span>
      </div>

      <div className="mn-section">
        <div className="mn-section-title">介绍</div>
        <div className="mn-intro">
          <reactMarkdown.default
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
            }}
          >
            {note.intro}
          </reactMarkdown.default>
        </div>
      </div>

      {
        //M 有评价时展示最近评价列表，并把关联会话号拼成带访问令牌的跳转链接。
      /**/}
      {newestFirst.length > 0 && <div className="mn-section">
        <div className="mn-section-title">最近评价（点会话号跳到那场会话）</div>
        {shown.map((rating, index) => (
          <div className="mn-rating" key={`${rating.at}-${rating.by}-${rating.session}-${String(index)}`}>
            <span>{[rating.at, rating.by, `${String(rating.score)}/5`].filter((part) => part !== '').join(' · ')}</span>
            {rating.session !== '' && (
              <>
                <span> · </span>
                <a className="mn-session-link" href={withToken(`/#session=${encodeURIComponent(rating.session)}`, TOKEN)}>
                  {`会话 ${rating.session}`}
                  {rating.thinking !== '' && `（${rating.thinking}）`}
                </a>
              </>
            )}
            {rating.session === '' && rating.task !== '' && <span>{` · 任务：${rating.task}`}</span>}
            {rating.note !== '' && <span>{` · ${rating.note}`}</span>}
          </div>
        ))}
        {newestFirst.length > SHOWN_COUNT && <antd.Button type="link" size="small" onClick={() => setExpanded(!expanded)}>
          {expandText}
        </antd.Button>}
      </div>}
    </antd.Card>
  );
}


/**
 * 模型介绍和评价汇总页面组件：展示标题、返回/刷新按钮与模型汇总卡片列表。
 * @returns 包裹了 antd 主题与中文语言包的页面主区域 JSX 元素。
 * 副作用：订阅 localStorage 跨标签页主题变更并写入根元素 CSS 变量，开页及点击刷新时请求 `/api/model-notes`。
 */
export function ModelNotesPage(): react.JSX.Element {
  //M 读主网页保存的主题（默认深色），别的标签页切换主题时跟着变。
  const [themeName, setThemeName] = react.useState<theme.ThemeName>(() => theme.loadThemeName(window.localStorage));
  const themeSpec = theme.THEMES[themeName];
  /** 所有模型。 */
  const [notes, setNotes] = react.useState<ModelNote[]>([]);
  /** 正在拉列表。 */
  const [loading, setLoading] = react.useState(true);
  /** 拉列表失败的原因；空表示没失败。 */
  const [error, setError] = react.useState('');

  react.useEffect(() => {
    //M 当前主题切换时，把 CSS 变量与深浅色方案实时写入页面根元素。
    theme.applyTheme(document.documentElement, themeSpec);
  }, [themeSpec]);

  react.useEffect(() => {
    const onStorage = (): void => {
      //M 其他同源标签页修改主题设置后，重新读取本地存储并同步本页主题。
      const next = theme.loadThemeName(window.localStorage);
      setThemeName(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  /** 拉一次列表（开页和点“刷新”时用）。 */
  const load = react.useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');

    try {
      //M 调用接口实例拉取全部模型介绍与评价汇总，更新列表数据。
      setNotes(await api.load());
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  //M 开页拉一次。
  react.useEffect(() => {
    void load();
  }, [load]);

  //M 渲染模型汇总页主体：按当前主题配置 antd 并提供返回/刷新按钮与虚拟滚动模型列表。
  return (
    <antd.ConfigProvider theme={theme.antdTheme(themeSpec)} locale={zhCN}>
      <div className="mn-main">
        <div className="mn-title">
          <h1>模型介绍和评价汇总</h1>
          <antd.Button href={withToken('/', TOKEN)}>返回聊天</antd.Button>
          <antd.Button onClick={() => void load()} loading={loading}>刷新</antd.Button>
        </div>
        <div className="mn-sub">在会话面板里给每场会话打分；这里按模型汇总打过分的会话数、平均分和最近评价，点会话号可直达对应会话。</div>

        {error !== '' && <antd.Alert type="error" showIcon message="读不到模型列表" description={error} style={{ marginBottom: 16 }} />}

        <antd.Spin spinning={loading}>
          <div className="mn-list" style={{ minHeight: 80 }}>
            {notes.length > 0 && (
              <virtuoso.Virtuoso
                useWindowScroll
                data={notes}
                computeItemKey={(_index, note) => note.model}
                itemContent={(_index, note) => (
                  <div style={{ paddingBottom: 16 }}>
                    <ModelNoteCard note={note} />
                  </div>
                )}
              />
            )}
            {!loading && error === '' && notes.length === 0 && <antd.Empty description="models/ 下还没有模型介绍" />}
          </div>
        </antd.Spin>
      </div>
    </antd.ConfigProvider>
  );
}
