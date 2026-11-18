/**
 * 右栏的“工作区”（docs/界面/01_界面设计.md 第 9 节）：只显示工作区。这个机器人有 N 个工作区，点开一个先看文件树
 * （点文件/文件夹往输入框插标签，G批设计 7.2），下面列里面的会话（标题，运行中的带标记）；点会话行打开右栏的
 * “会话”页（会话 md 由会话页里的按钮打开）。每几秒刷新一次，新会话和运行状态跟着变。
 * 有会话在跑的工作区，不用点开就看得见（用户 11-06 原话第 62 节）：名字前一个干活的小鲸鱼娘，后面写“N 个在干活”。
 * 会话不限量，每个工作区的会话列表用 react-virtuoso 虚拟滚动（用户 11-17），借整个标签的滚动元素（customScrollParent）。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as virtuoso from 'react-virtuoso';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';
import * as images from '../Mascot/Images.ts';
import * as readingModule from './Reading.ts';
import * as workspaceFiles from './WorkspaceFiles.tsx';


/** 会话列表多久刷新一次，毫秒。 */
const REFRESH_MS = 3000;


/**
 * 工作区。
 * @returns 机器人工作区折叠列表、文件树及各工作区会话列表元素。
 * 副作用：定时轮询机器人工作区目录与会话清单，恢复并保存阅读滚动与折叠展开状态，点击会话切换到会话页。
 */
export function Workspace(): react.JSX.Element {
  //M 获取翻译函数与演示打码开关，供工作区与会话文本脱敏和文案显示使用。
  const t = i18n.useT();
  const masked = privacy.useMask();
  /** 正在聊的机器人。 */
  //M 订阅当前选中机器人与切会话动作，用于加载工作区列表及跳转会话页。
  const bot = context.useUi((state) => state.currentBot);
  const openSession = context.useUi((state) => state.openSession);
  /** 工作区（名字、说明）。 */
  const [workspaces, setWorkspaces] = react.useState<api.BotInfo['workspaces']>([]);
  /** 全部会话，最近的在前。 */
  const [sessions, setSessions] = react.useState<api.SessionBrief[]>([]);
  /** 出错的原因。 */
  const [error, setError] = react.useState('');
  /** 读取完成的机器人身份，避免切换时把旧目录的位置恢复到加载占位。 */
  const [loadedBot, setLoadedBot] = react.useState<string | null>(null);
  //M 读取当前查看条目的阅读状态，并在机器人工作区加载完成后接管滚动位置恢复与保存。
  const { reading, saveReading } = readingModule.useReadingState();
  const scroll = react.useRef<HTMLDivElement>(null);
  readingModule.useReadingScroll(scroll, bot !== null && loadedBot === bot);
  /** 同一个滚动元素放进 state：会话的虚拟列表要拿它当 customScrollParent，挂上以后要重画一次。 */
  const [scrollParent, setScrollParent] = react.useState<HTMLDivElement | null>(null);

  /** 滚动元素挂上、卸下时：阅读位置的 ref 和虚拟列表的 state 一起更新；useCallback 保证 React 不会每次渲染都重挂。 */
  const attachScroll = react.useCallback((element: HTMLDivElement | null): void => {
    scroll.current = element;
    setScrollParent(element);
  }, []);

  /**
   * 一个会话一行：点了打开右栏的“会话”页。
   * 由下面每个工作区的 Virtuoso 的 itemContent 调，只画滚到眼前的那几行。
   * @param session 这一行的会话。
   */
  const renderSession = (session: api.SessionBrief): react.JSX.Element => (
    <div className="jm-workspace-session-row">
      <button
        //M 对会话标题与摘要按演示状态脱敏，并在点击时跳转到对应会话详情页。
        type="button" className="jm-pick-item jm-workspace-session jm-reader-session"
        title={privacy.name(session.title, masked)} onClick={() => openSession(session.id)}>
        {session.status === 'running' && <img className="jm-ws-figure" src={images.IMAGES.work_mini_1} alt="" />}
        <span className="jm-reader-session-main">
          <span className="jm-workspace-title">{privacy.name(session.title, masked)}</span>
          <span className="jm-reader-session-summary">{privacy.text(session.summary, masked) || t('摘要未记录')}</span>
          <span className="jm-muted jm-reader-session-meta">
            {t('更新于 {time}', { time: new Date(session.updatedAt).toLocaleString() })}
            <span>{session.model}</span>
          </span>
        </span>
        {session.status === 'running' && <antd.Tag color="green">{t('运行中')}</antd.Tag>}
        {session.status === 'error' && <antd.Tag color="red">{t('出错')}</antd.Tag>}
      </button>
    </div>
  );

  react.useEffect(() => {
    setWorkspaces([]);
    setSessions([]);
    setError('');
    setLoadedBot(null);
    if (!bot) {
      return undefined;
    }
    /** 停了没有。 */
    let stopped = false;
    /** 下一次的定时器。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 取一次工作区和会话。 */
    const load = async (): Promise<void> => {
      try {
        /** 工作区和会话。 */
        //M 并行拉取当前机器人的工作区目录与全量会话列表，同步刷新两者视图。
        const [info, list] = await Promise.all([api.botInfo(bot), api.sessions(bot)]);
        if (!stopped) {
          setWorkspaces(info.workspaces);
          setSessions(list);
          setError('');
          setLoadedBot(bot);
        }
      } catch (problem) {
        if (!stopped) {
          let message = String(problem);
          if (problem instanceof Error) {
            message = problem.message;
          }
          setError(message);
        }
      }
      //M 本轮加载完成后只要尚未卸载，就预约下一次定时刷新。
      if (!stopped) {
        timer = setTimeout(() => void load(), REFRESH_MS);
      }
    };
    //M 选中机器人后立即发起首次工作区和会话加载。
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bot]);

  if (error && workspaces.length === 0) {
    //G 尚未拉取到任何工作区且请求失败时，展示脱敏后的错误提示。
    return <div className="jm-empty">{privacy.text(error, masked)}</div>;
  }
  return (
    <div className="jm-workspace jm-reader-workspace" ref={attachScroll}>
      <antd.Collapse
        size="small"
        activeKey={reading.expanded.filter((key) => key.startsWith('workspace:')).map((key) => key.slice(10))}
        onChange={(value) => {
          let keys = [String(value)];
          if (Array.isArray(value)) {
            keys = value.map(String);
          }
          saveReading({ expanded: keys.map((key) => `workspace:${key}`) });
        }}
        items={workspaces.map((workspace) => {
          /** 这个工作区的会话。 */
          const mine = sessions.filter((session) => session.workspace === workspace.name);
          /** 运行中的有几个。 */
          const running = mine.filter((session) => session.status === 'running').length;
          //M 对工作区名称按演示开关做姓名脱敏，有会话运行时在前面追加干活图标。
          let label: react.ReactNode = privacy.name(workspace.name, masked);
          if (running > 0) {
            label = (
              <span className="jm-ws-label">
                <img className="jm-ws-figure" src={images.IMAGES.work_mini_typing_1} alt="" />
                {privacy.name(workspace.name, masked)}
              </span>
            );
          }
          return {
            key: workspace.name,
            label,
            extra: (
              <span className="jm-muted">
                {t('{count} 个会话', { count: mine.length })}
                {running > 0 && (
                  <span className="jm-ws-busy">
                    {t('，{count} 个在干活', { count: running })}
                    <span className="jm-worker-dots" aria-hidden="true"><i /><i /><i /></span>
                  </span>
                )}
              </span>
            ),
            children: (
              <div className="jm-workspace-sessions">
                {
                  //M 存在工作区说明时先按演示开关脱敏，再展示在文件树上方。
                  workspace.description && <div className="jm-muted jm-workspace-desc">{privacy.text(workspace.description, masked)}</div>
                }
                {bot !== null && <workspaceFiles.WorkspaceFiles bot={bot} workspace={workspace} />}
                {mine.length === 0 && <div className="jm-muted">{t('还没有会话')}</div>}
                {mine.length > 0 && scrollParent && (
                  <virtuoso.Virtuoso
                    customScrollParent={scrollParent}
                    data={mine}
                    computeItemKey={(_index, session) => session.id}
                    itemContent={(_index, session) => renderSession(session)}
                  />
                )}
              </div>
            ),
          };
        })}
      />
      {workspaces.length === 0 && <div className="jm-muted">{t('还没有工作区')}</div>}
    </div>
  );
}
