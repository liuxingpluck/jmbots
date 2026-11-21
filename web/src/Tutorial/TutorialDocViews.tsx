/**
 * 教程页按需懒加载的「组块阅读 / 工具说明」与「插件详情」面板：
 * 将 react-markdown、remark-gfm、antd.Table / Tabs 与 JSON 树从首屏入口拆入独立按需 chunk。
 */
import { useEffect, useState, type JSX } from 'react';
import { Alert, Empty, Spin, Tabs, Tag, type TabsProps } from 'antd';
import * as virtuoso from 'react-virtuoso';
import { JsonBlock } from './Code.tsx';
import { useMindWords } from './MindState.ts';
import { CodeTab, TryTab } from './PluginTabs.tsx';
import { MarkdownContent, buildReadmeTabItems } from './ReadmeTabs.tsx';
import { TutorialApi, type PluginItem, type StateGroup } from './TutorialApi.ts';
import { STATE_WORDS, TutorialScrollContext, VIRTUAL_THRESHOLD } from './TutorialContext.tsx';


const STATE_MS = 3000;


/**
 * 读某个插件的 说明.md 原文。
 * @param name 插件名。
 */
function usePluginReadme(name: string): { text: string | null; error: string } {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setText(null);
    setError('');
    //M 按插件名即时抓取 说明.md 原文用于右栏分栏渲染。
    const loading = TutorialApi.get<{ text: string }>(`/api/tutorial/readme?name=${encodeURIComponent(name)}`);
    void loading.then((result) => setText(result.text), (failed: unknown) => setError((failed as Error).message));
  }, [name]);

  return { text, error };
}


/** 读取并展示一篇组块或骨架工具说明，切换时由文件名重建组件。 */
export function ReadingView(props: {
  name: string;
  loadingLabel: string;
  errorLabel: string;
  util?: boolean;
  onHashLink?: (href: string) => void;
}): JSX.Element {
  const { name } = props;
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    //M 右栏只读所选文档，跳走后忽略未完成的请求。
    let load = TutorialApi.getReading;
    if (props.util) load = TutorialApi.getUtilReadme;
    let file = name;
    if (name.startsWith('cordis/')) {
      load = TutorialApi.getCordisReading;
      file = name.slice('cordis/'.length);
    }
    //M 文档名已选好，按所属目录读取。
    const loading = load(file);
    void loading.then((result) => {
      if (!active) return;

      setText(result.text);
    }, () => {
      if (!active) return;

      setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [name, props.util]);

  if (failed) return <p className="tu-error" role="alert">{props.errorLabel}</p>;
  if (text === null) return <Spin aria-label={props.loadingLabel} />;

  //G 只有 Cordis 用法接管站内链接；组块阅读保持原来的链接行为。
  let onHashLink: ((href: string) => void) | undefined;
  if (name.startsWith('cordis/')) onHashLink = props.onHashLink;

  //M 复用插件说明页签的 Markdown、代码和表格渲染。
  return <article className="tu-doc"><MarkdownContent body={text} onHashLink={onHashLink} /></article>;
}


/**
 * 一组运行时状态的折叠块，PluginState 在常规和虚拟滚动模式下共用。
 * @param props.group 状态组。
 */
function PluginStateGroup(props: { group: StateGroup }): JSX.Element {
  const { group } = props;
  return (
    <details className="tu-state-group" open>
      <summary>{group.name}</summary>
      <JsonBlock
        head={<span className="tu-muted">{group.note}</span>}
        value={group.value}
        empty="（空）"
        notes={group.notes}
      />
    </details>
  );
}


/**
 * 插件的「状态」：它提供的服务对象、它用 ctx.flow.state 登记的，全量原样；每 STATE_MS 刷新一次，能暂停；组数 >= 30 时开启虚拟滚动。
 * @param props.name 插件名。
 */
function PluginState(props: { name: string }): JSX.Element {
  const [groups, setGroups] = useState<StateGroup[] | null>(null);
  const [at, setAt] = useState(0);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);

  //M 换了插件：清掉上一个的。
  useEffect(() => {
    setGroups(null);
    setAt(0);
  }, [props.name]);

  //M 没暂停就定时读。
  useEffect(() => {
    if (paused) return undefined;

    let alive = true;
    const load = (): void => {
      //M 现拉该插件服务对象及登记状态变量快照，实现状态面板实时刷新。
      const url = `/api/tutorial/state?name=${encodeURIComponent(props.name)}`;
      const loading = TutorialApi.get<{ at: number; groups: StateGroup[] }>(url);
      void loading.then((result) => {
        if (!alive) return;

        setGroups(result.groups);
        setAt(result.at);
        setError('');
      }, (failed: unknown) => {
        if (alive) {
          setError((failed as Error).message);
        }
      });
    };
    //M 组件挂载后立即首刷一次状态，再由定时器按固定频率周期轮询。
    load();
    const timer = window.setInterval(load, STATE_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [paused, props.name]);

  //M 顶上一行：什么时候读的、刷新还是暂停。
  let said = '正在读…';
  if (at > 0) {
    said = `${new Date(at).toLocaleTimeString()} 读的`;
  }
  let refresh = `每 ${String(STATE_MS / 1000)} 秒刷新`;
  if (paused) {
    refresh = '已暂停';
  }
  let button = '暂停';
  if (paused) {
    button = '继续刷新';
  }

  return (
    <TutorialScrollContext.Consumer>
      {(ctxScrollParent) => {
        if (ctxScrollParent !== scrollParent) {
          queueMicrotask(() => setScrollParent(ctxScrollParent));
        }
        const list = groups ?? [];
        const useVirtual = list.length >= VIRTUAL_THRESHOLD && ctxScrollParent !== null;
        return (
          <div className="tu-state">
            <div className="tu-head-row">
              <span className="tu-muted">{said} · {refresh}</span>
              <button type="button" className="tu-link" onClick={() => setPaused(!paused)}>{button}</button>
            </div>
            {error !== '' && <p className="tu-error">读不到：{error}</p>}
            {groups !== null && groups.length === 0 && (
              <Empty description="这个插件没有提供服务，也没登记运行时变量（用 ctx.flow.state 登记）" />
            )}
            {useVirtual && (
              <virtuoso.Virtuoso
                customScrollParent={ctxScrollParent}
                data={list}
                computeItemKey={(_index, group) => group.name}
                itemContent={(_index, group) => <PluginStateGroup group={group} />}
              />
            )}
            {!useVirtual && list.map((group) => (
              <PluginStateGroup key={group.name} group={group} />
            ))}
          </div>
        );
      }}
    </TutorialScrollContext.Consumer>
  );
}


/**
 * 插件详情面板：拆标签说明 + 状态 + 代码 + 试一试；支持可控当前标签、就地展开源码和点击事件高亮画布。
 */
export function PluginView(props: {
  plugin: PluginItem;
  pluginNames: Set<string>;
  activeTab: string;
  onTabChange: (key: string) => void;
  activeEvent: string;
  onSelectEvent: (eventName: string) => void;
  onSelectPlugin: (name: string) => void;
}): JSX.Element {
  const { plugin } = props;
  //M 插件状态沿用独立教程页的语言偏好。
  const t = useMindWords();
  //M 读取选中插件的 说明.md Markdown 文本准备拆分多页签展示。
  const readme = usePluginReadme(plugin.name);
  let version = '还没写版本号';
  if (plugin.version !== '') {
    version = `v${plugin.version}`;
  }
  let inject = '不用别的服务';
  if (plugin.inject.length > 0) {
    inject = `要用：${plugin.inject.join('、')}`;
  }

  //M 说明按 ## 拆成多个标签，再接原来的 状态 / 代码 / 试一试。
  const readmeTabs = buildReadmeTabItems({
    plugin,
    text: readme.text,
    error: readme.error,
    pluginNames: props.pluginNames,
    onSelectPlugin: props.onSelectPlugin,
    activeEvent: props.activeEvent,
    onSelectEvent: props.onSelectEvent,
  });
  const tabs: NonNullable<TabsProps['items']> = [
    ...readmeTabs,
    { key: 'state', label: '状态', children: <PluginState name={plugin.name} /> },
    { key: 'code', label: '代码', children: <CodeTab name={plugin.name} /> },
    { key: 'try', label: '试一试', children: <TryTab name={plugin.name} /> },
  ];

  //M 当 URL 里的子标签在这个插件被禁用或不存在时，安全回退到「概要」。
  let resolvedTab = props.activeTab;
  const matched = tabs.find((item) => item.key === resolvedTab && item.disabled !== true);
  if (matched === undefined) {
    resolvedTab = 'overview';
  }

  const stateWord = STATE_WORDS[plugin.state] ?? plugin.state;
  let stateText = t(stateWord);
  if (plugin.kind === 'skeleton') {
    stateText = '骨架常驻';
  }

  return (
    <div className="tu-doc tu-plugin-doc">
      <div className="tu-plugin-meta">
        <span className="tu-pane-plugin-name">{plugin.name}</span>
        {plugin.kind === 'skeleton' && <Tag>骨架</Tag>}
        <Tag className="tu-version">{version}</Tag>
        <span className="tu-muted">
          <span className={`tu-dot ${plugin.state}`} /> {stateText} · {inject}
        </span>
      </div>
      {plugin.error !== '' && <Alert type="error" showIcon title={plugin.error} />}
      <Tabs key={plugin.name} activeKey={resolvedTab} items={tabs} onChange={props.onTabChange} />
    </div>
  );
}
