/**
 * 网页根组件：主题、中文语言包，以及按屏幕宽度选布局。
 * 宽屏用 PcLayout（顶栏 + 三栏），窄屏（小于 768px）用 MobileLayout（一次显示一层）；两种布局用同样的三个栏目。
 * 打开页面时加载一次知识库数据。PC 顶栏最右边是动效开关（Effects/MotionToggle.tsx）。
 * 网址是 `#/events` 开头时显示 jmbots 的“事件”页面（Events/EventsPage.tsx），不显示知识库。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import zhCN from 'antd/locale/zh_CN';
import * as react from 'react';
import type { ReactNode } from 'react';
import Magnet from './Effects/Magnet.tsx';
import EventsPage from './Events/EventsPage.tsx';
import * as eventsStore from './Events/EventsStore.ts';
import MotionToggle from './Effects/MotionToggle.tsx';
import BaseTree from './Knowledge/BaseTree.tsx';
import DocumentList from './Knowledge/DocumentList.tsx';
import DocumentView from './Knowledge/DocumentView.tsx';
import * as knowledgeStore from './KnowledgeStore.ts';
import MobileLayout from './Layout/MobileLayout.tsx';
import PcLayout from './Layout/PcLayout.tsx';
import * as prefsStore from './PrefsStore.ts';
import * as theme from './Theme.ts';
import * as viewStore from './ViewStore.ts';


/** 根组件。 */
export default function App() {
  /** 加载知识库数据的动作。 */
  const load = knowledgeStore.useKnowledgeStore((state) => state.load);
  /** 是不是窄屏；窄屏用手机布局。 */
  const compact = prefsStore.usePrefsStore((state) => state.compact);
  /** 是不是在“事件”页。 */
  const eventsActive = eventsStore.useEventsStore((state) => state.active);

  // m: 打开页面时取一次目录和文档。
  react.useEffect(() => {
    void load();
  }, [load]);

  // r: 搜索框在 PC 上放进顶栏，在手机上放在文档列表那一层的顶部。
  /** 两种布局共用的搜索框。 */
  const searchBox = <SearchBox />;
  // m: 事件页单独一套布局。
  if (eventsActive) {
    return (
      <antd.ConfigProvider theme={theme.ANTD_THEME} locale={zhCN}>
        <EventsPage compact={compact} header={<TopBar search={null} eventsActive />} />
      </antd.ConfigProvider>
    );
  }
  return (
    <antd.ConfigProvider theme={theme.ANTD_THEME} locale={zhCN}>
      {compact ? (
        <MobileLayout
          search={searchBox}
          left={<BaseTree />}
          middle={<DocumentList />}
          right={<DocumentView />}
        />
      ) : (
        <PcLayout
          header={<TopBar search={searchBox} eventsActive={false} />}
          left={<BaseTree />}
          middle={<DocumentList />}
          right={<DocumentView />}
        />
      )}
    </antd.ConfigProvider>
  );
}


/** TopBar 的参数。 */
interface TopBarProps {
  /** 放在顶栏右边的搜索框；事件页没有。 */
  search: ReactNode;
  /** 现在是不是在“事件”页（决定哪个模块按钮亮着）。 */
  eventsActive: boolean;
}


/** PC 顶栏：名称（鼠标靠近时轻轻磁吸）、模块入口（知识库、事件；“对话”“设置”先灰着，给以后留位置）、搜索框、动效开关。 */
function TopBar(props: TopBarProps) {
  return (
    <div className="top-bar">
      <Magnet padding={24} maxOffset={4}>
        <span className="top-bar-brand">JMBOTS</span>
      </Magnet>
      <nav className="top-bar-modules">
        <antd.Button
          type="text"
          className={props.eventsActive ? undefined : 'is-active'}
          onClick={() => {
            window.location.hash = '#/kb';
          }}
        >
          知识库
        </antd.Button>
        <antd.Button
          type="text"
          className={props.eventsActive ? 'is-active' : undefined}
          onClick={() => {
            window.location.hash = '#/events';
          }}
        >
          事件
        </antd.Button>
        <antd.Button type="text" disabled>
          对话
        </antd.Button>
        <antd.Button type="text" disabled>
          设置
        </antd.Button>
      </nav>
      {props.search}
      <MotionToggle />
    </div>
  );
}


/** 按标题过滤文档的搜索框；搜索词记在 ViewStore，文档列表从那里读。 */
function SearchBox() {
  /** 搜索框里的文字。 */
  const query = viewStore.useViewStore((state) => state.query);
  /** 改搜索词的动作。 */
  const setQuery = viewStore.useViewStore((state) => state.setQuery);
  return (
    <antd.Input
      className="top-bar-search"
      allowClear
      prefix={<icons.SearchOutlined />}
      placeholder="按标题过滤文档"
      value={query}
      onChange={(event) => setQuery(event.target.value)}
    />
  );
}
