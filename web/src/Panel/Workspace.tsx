/**
 * 右栏的“工作区”（docs/界面/01_界面设计.md 第 9 节）：只显示工作区。这个机器人有 N 个工作区，点开一个先看文件树
 * （点文件/文件夹往输入框插标签，G批设计 7.2），下面列里面的会话（标题，运行中的带标记）；点会话行打开右栏的
 * “会话”页（会话 md 由会话页里的按钮打开）。每几秒刷新一次，新会话和运行状态跟着变。
 * 有会话在跑的工作区，不用点开就看得见（用户 11-06 原话第 62 节）：名字前一个干活的小鲸鱼娘，后面写“N 个在干活”。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as images from '../Mascot/Images.ts';
import * as readingModule from './Reading.ts';
import * as workspaceFiles from './WorkspaceFiles.tsx';


/** 会话列表多久刷新一次，毫秒。 */
const REFRESH_MS = 3000;


/** 工作区。 */
export function Workspace(): react.JSX.Element {
  const t = i18n.useT();
  /** 正在聊的机器人。 */
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
  const { reading, saveReading } = readingModule.useReadingState();
  const scroll = react.useRef<HTMLDivElement>(null);
  readingModule.useReadingScroll(scroll, bot !== null && loadedBot === bot);

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
        const [info, list] = await Promise.all([api.botInfo(bot), api.sessions(bot)]);
        if (!stopped) {
          setWorkspaces(info.workspaces);
          setSessions(list);
          setError('');
          setLoadedBot(bot);
        }
      } catch (problem) {
        if (!stopped) {
          setError(problem instanceof Error ? problem.message : String(problem));
        }
      }
      if (!stopped) {
        timer = setTimeout(() => void load(), REFRESH_MS);
      }
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bot]);

  if (error && workspaces.length === 0) {
    return <div className="jm-empty">{error}</div>;
  }
  return (
    <div className="jm-workspace jm-reader-workspace" ref={scroll}>
      <antd.Collapse
        size="small"
        activeKey={reading.expanded.filter((key) => key.startsWith('workspace:')).map((key) => key.slice(10))}
        onChange={(value) => {
          const keys = Array.isArray(value) ? value : [value];
          saveReading({ expanded: keys.map((key) => `workspace:${String(key)}`) });
        }}
        items={workspaces.map((workspace) => {
          /** 这个工作区的会话。 */
          const mine = sessions.filter((session) => session.workspace === workspace.name);
          /** 运行中的有几个。 */
          const running = mine.filter((session) => session.status === 'running').length;
          return {
            key: workspace.name,
            label: running > 0 ? (
              <span className="jm-ws-label">
                <img className="jm-ws-figure" src={images.IMAGES.work_mini_typing_1} alt="" />
                {workspace.name}
              </span>
            ) : workspace.name,
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
                {workspace.description && <div className="jm-muted jm-workspace-desc">{workspace.description}</div>}
                {bot !== null && <workspaceFiles.WorkspaceFiles bot={bot} workspace={workspace} />}
                {mine.length === 0 && <div className="jm-muted">{t('还没有会话')}</div>}
                {mine.map((session) => (
                  <button key={session.id} type="button" className="jm-pick-item jm-workspace-session jm-reader-session"
                    title={session.title} onClick={() => openSession(session.id)}>
                    {session.status === 'running' && <img className="jm-ws-figure" src={images.IMAGES.work_mini_1} alt="" />}
                    <span className="jm-reader-session-main">
                      <span className="jm-workspace-title">{session.title}</span>
                      <span className="jm-reader-session-summary">{session.summary || t('摘要未记录')}</span>
                      <span className="jm-muted jm-reader-session-meta">
                        {t('更新于 {time}', { time: new Date(session.updatedAt).toLocaleString() })}
                        <span>{session.model}</span>
                      </span>
                    </span>
                    {session.status === 'running' && <antd.Tag color="green">{t('运行中')}</antd.Tag>}
                    {session.status === 'error' && <antd.Tag color="red">{t('出错')}</antd.Tag>}
                  </button>
                ))}
              </div>
            ),
          };
        })}
      />
      {workspaces.length === 0 && <div className="jm-muted">{t('还没有工作区')}</div>}
    </div>
  );
}
