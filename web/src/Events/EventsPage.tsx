/**
 * “事件”页面（jmbots 的白盒子）：左栏提交任务和会话列表，右栏选中会话的全部记录。
 * PC 上两栏并排；手机上一次一层，选了会话看记录，左上角返回列表。网址是 `#/events`、`#/events/<会话ID>`。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import type { ReactNode } from 'react';
import * as eventsStore from './EventsStore.ts';
import SessionList from './SessionList.tsx';
import SessionView from './SessionView.tsx';


/** EventsPage 的参数。 */
interface EventsPageProps {
  /** PC 顶栏；手机上不用。 */
  header: ReactNode;
  /** 是不是窄屏。 */
  compact: boolean;
}


/** 事件页。 */
export default function EventsPage(props: EventsPageProps) {
  /** 选中的会话。 */
  const sessionId = eventsStore.useEventsStore((state) => state.sessionId);
  /** 刷新的动作。 */
  const refresh = eventsStore.useEventsStore((state) => state.refresh);

  // m: 进到事件页先取一次，之后由 EventsStore 每 2 秒刷新。
  react.useEffect(() => {
    void refresh();
  }, [refresh]);

  // m: 手机：选了会话就只显示记录，返回键回到列表。
  if (props.compact) {
    return (
      <div className="mobile-layout">
        <div className="mobile-header">
          {sessionId ? (
            <antd.Button type="text" className="mobile-back" icon={<icons.LeftOutlined />} onClick={() => {
                window.location.hash = '#/events';
              }}>
              会话列表
            </antd.Button>
          ) : (
            <span className="mobile-title">事件</span>
          )}
        </div>
        <div className="mobile-pane">{sessionId ? <SessionView /> : <SessionList />}</div>
      </div>
    );
  }
  return (
    <div className="events-layout">
      <header className="pc-header">{props.header}</header>
      <aside className="pc-pane pc-left">
        <SessionList />
      </aside>
      <main className="pc-pane">
        <SessionView />
      </main>
    </div>
  );
}
