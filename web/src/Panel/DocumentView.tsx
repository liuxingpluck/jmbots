/**
 * 文档的分层阅读：运行包含步骤，步骤包含角色；目录只对应当前一个文件片段。
 * 展开、选中章节都保存为轻量 key，离开再返回时不必重新翻找。
 */
import * as react from 'react';
import * as virtuoso from 'react-virtuoso';
import * as markdown from '../Chat/Markdown.tsx';
import * as i18n from '../I18n.ts';
import * as readingModule from './Reading.ts';
import type * as documentModule from './Document.ts';
import type * as historyModule from './History.ts';
import type * as storeModule from '../Store.ts';


/** 当前文档片段与原有文件预览接线。 */
interface DocumentViewProps {
  /** 当前段的结构，不包含以前分段的正文。 */
  page: documentModule.DocumentPage;
  /** 文件或附件仍走已有右栏预览动作。 */
  onOpen: (target: storeModule.PanelTarget) => void;
  /** 普通 Markdown 内链可由预览接管；网络外链返回 false。 */
  onLink: (href: string) => boolean;
}


/** 一层文档节点的纯显示依赖，阅读状态由顶层统一取得。 */
interface SectionProps extends DocumentViewProps {
  /** 本层标题或角色及其子内容。 */
  node: documentModule.DocumentNode;
  /** 当前历史条目的阅读状态。 */
  reading: historyModule.PanelReadingState;
  /** 当前段的展开标记，供大量节点常数时间查询。 */
  expandedKeys: ReadonlySet<string>;
  /** 只保存当前条目的轻量状态。 */
  saveReading: readingModule.ReadingState['saveReading'];
  /** 使用虚拟列表时，子节点由列表单独渲染。 */
  flat?: boolean;
}

/** 大文档中一行对应一个可见节点，缩进沿用其原有层级。 */
interface DocumentRow {
  /** 当前节点及其正文。 */
  node: documentModule.DocumentNode;
  /** 相对于顶层的层级。 */
  depth: number;
}

const OUTLINE_VIRTUAL_AFTER = 40;
const BODY_VIRTUAL_AFTER = 24;

/** 各文档节点类型对应的翻译函数；保留字面量 t(...) 以供语言包提取。 */
const KIND_LABELS: Partial<Record<documentModule.DocumentKind, (t: i18n.Translate) => string>> = {
  run: (t) => t('运行'),
  step: (t) => t('步骤'),
  user: (t) => t('用户'),
  assistant: (t) => t('助手'),
  'tool-call': (t) => t('工具调用'),
  'tool-result': (t) => t('工具结果'),
  thinking: (t) => t('思考'),
  program: (t) => t('程序'),
  review: (t) => t('审核'),
  fragment: (t) => t('接续片段'),
};


/** 角色名称属于界面翻译，文件里的标题与时间仍按证据原文显示。 */
function getKindLabel(kind: documentModule.DocumentKind, t: i18n.Translate): string {
  const format = KIND_LABELS[kind];
  if (format) return format(t);

  return t('章节');
}


/** 默认展开项可记录 closed:key；默认收起的结果/思考仅在明确展开后显示。 */
function isOpen(block: documentModule.DocumentBlock, expanded: ReadonlySet<string>): boolean {
  if (expanded.has(`closed:${block.key}`)) return false;

  return expanded.has(block.key) || !block.collapsed;
}

/** 保留原顺序，收起的子节点不进入虚拟滚动列表。 */
function appendRows(
  nodes: documentModule.DocumentNode[],
  expanded: ReadonlySet<string>,
  depth: number,
  rows: DocumentRow[],
): void {
  for (const node of nodes) {
    rows.push({ node, depth });
    //M 展开后子节点紧随父段落显示。
    if (isOpen(node.block, expanded)) {
      const childDepth = depth + 1;
      appendRows(node.children, expanded, childDepth, rows);
    }
  }
}


/** 章节收放包含其全部子步骤与角色，不把运行标题做成空卡片。 */
function DocumentSection(props: SectionProps): react.JSX.Element {
  //M 读取翻译函数、当前块展开状态及角色/结构显示标签，准备渲染折叠节点。
  const t = i18n.useT();
  const block = props.node.block;
  const open = isOpen(block, props.expandedKeys);
  const label = getKindLabel(block.kind, t);
  const toggle = (nextOpen: boolean): void => {
    if (nextOpen === open) {
      return;
    }
    const expanded = props.reading.expanded.filter((key) => {
      return key !== block.key && key !== `closed:${block.key}`;
    });
    let nextKey = `closed:${block.key}`;
    if (nextOpen) {
      nextKey = block.key;
    }
    //M 写入最新的展开或主动收起标记，持久化到当前历史条目的阅读状态。
    expanded.push(nextKey);
    props.saveReading({ expanded });
  };
  let bodyContent: react.ReactNode = <markdown.Markdown text={block.body} onOpen={props.onOpen} onLink={props.onLink} />;
  if (block.kind === 'fragment') {
    bodyContent = <pre className="jm-preview-code">{block.body}</pre>;
  }

  return (
    <details
      className={`jm-document-block jm-document-${block.kind}`}
      data-document-key={block.key}
      open={open}
      //M 用户手动切换折叠状态时同步更新当前历史条目的展开集合。
      onToggle={(event) => toggle(event.currentTarget.open)}
    >
      <summary>
        <span className="jm-document-kind">{label}</span>
        <span className="jm-document-title">{block.title || t('正文')}</span>
        {block.time && <span className="jm-document-time">{block.time}</span>}
        {block.summary && <span className="jm-document-summary">{block.summary}</span>}
      </summary>
      {open && block.body.trim() && (
        <div className="jm-document-body">
          {bodyContent}
        </div>
      )}
      {open && !props.flat && props.node.children.length > 0 && (
        <div className="jm-document-children">
          {props.node.children.map((node) => <DocumentSection {...props} key={node.block.key} node={node} />)}
        </div>
      )}
    </details>
  );
}


/**
 * 渲染当前文档片段的章节目录与结构化正文；点击目录时先展开父层再定位滚动。
 * @param props 包含当前文档结构 `page` 以及文件/外链打开回调 `onOpen`、`onLink`。
 * @returns 分段控制条、章节目录导航与嵌套结构正文视图。
 * 副作用：订阅当前历史条目的阅读状态；点击目录或展收按钮会更新当前条目的 `expanded` 与 `section`，定位时会触发 DOM `scrollIntoView`。
 */
export function DocumentView(props: DocumentViewProps): react.JSX.Element {
  //M 取当前语言翻译函数与当前历史条目的轻量阅读状态及保存回调。
  const t = i18n.useT();
  const { reading, saveReading } = readingModule.useReadingState();
  const container = react.useRef<HTMLDivElement>(null);
  const bodyList = react.useRef<virtuoso.VirtuosoHandle>(null);
  const [scrollParent, setScrollParent] = react.useState<HTMLElement | null>();
  const [scrollKey, setScrollKey] = react.useState<string>();
  const largeBody = props.page.blocks.length > BODY_VIRTUAL_AFTER;
  const sectionKeys = react.useMemo(() => props.page.blocks.map((block) => block.key), [props.page.blocks]);
  const expandedKeys = react.useMemo(() => new Set(reading.expanded), [reading.expanded]);
  const visibleRows = react.useMemo(() => {
    if (!largeBody) return [];

    //M 一次把展开的正文摊成虚拟行，滚动保存时不重新遍历整段文档。
    const rows: DocumentRow[] = [];
    appendRows(props.page.nodes, expandedKeys, 0, rows);
    return rows;
  }, [largeBody, props.page.nodes, expandedKeys]);

  react.useLayoutEffect(() => {
    //M 复用预览自己的滚动元素及既有位置恢复，不产生第二个正文滚动条。
    const scroll = container.current?.closest<HTMLElement>('.jm-reader-scroll');
    setScrollParent(scroll ?? null);
  }, []);

  react.useEffect(() => {
    if (scrollKey === undefined || !largeBody || !scrollParent) return undefined;

    //M 等祖先展开，再按虚拟行号找尚未挂载的目标段落。
    const index = visibleRows.findIndex((row) => row.node.block.key === scrollKey);
    if (index < 0) return undefined;

    const frame = requestAnimationFrame(() => {
      const target = { index, align: 'start', behavior: 'auto' } as const;
      bodyList.current?.scrollToIndex(target);
      setScrollKey(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [largeBody, scrollKey, scrollParent, visibleRows]);

  /** 查找要定位的章节的祖先链，保证收起的父运行也能一并展开。 */
  const getParents = (nodes: documentModule.DocumentNode[], wanted: string): string[] | undefined => {
    for (const node of nodes) {
      if (node.block.key === wanted) {
        return [wanted];
      }
      //M 当前节点未直接命中时，递归向下查找目标章节的祖先路径。
      const found = getParents(node.children, wanted);
      if (found) {
        return [node.block.key, ...found];
      }
    }
    return undefined;
  };
  const locate = (key: string): void => {
    //M 计算目标章节的完整祖先链，清除主动收起标记并保存当前选中章节与展开集合。
    const ancestors = getParents(props.page.nodes, key) ?? [key];
    const expanded = reading.expanded.filter((item) => !ancestors.some((ancestor) => item === `closed:${ancestor}`));
    saveReading({ section: key, expanded: [...new Set([...expanded, ...ancestors])] });

    if (largeBody && scrollParent) {
      setScrollKey(key);
      return;
    }

    /** React 提交展开状态后再定位；已卸载的旧目标不滚动新页面。 */
    requestAnimationFrame(() => {
      const element = container.current?.querySelector(`[data-document-key="${key}"]`);
      if (element?.isConnected) {
        element.scrollIntoView({ block: 'start', behavior: 'auto' });
      }
    });
  };

  const renderOutlineItem = (block: documentModule.DocumentBlock): react.JSX.Element => {
    let buttonClass = '';
    if (block.key === reading.section) {
      buttonClass = 'jm-document-current';
    }
    const padding = Math.max(0, block.level - 1) * 10 + 8;
    return (
      <button
        type="button"
        key={block.key}
        className={buttonClass}
        style={{ paddingInlineStart: padding }}
        //M 保留点目录后展开祖先并定位的行为。
        onClick={() => locate(block.key)}
      >
        {block.title}
      </button>
    );
  };

  const renderOutline = (): react.ReactNode => {
    const outline = props.page.outline;
    if (outline.length <= OUTLINE_VIRTUAL_AFTER) return outline.map(renderOutlineItem);

    //M 大纲沿用原有的有限高度，只挂载当前可见的标题按钮。
    return (
      <virtuoso.Virtuoso
        data={outline}
        style={{ height: 200 }}
        computeItemKey={(_index, block) => block.key}
        itemContent={(_index, block) => (
          <div style={{ display: 'grid', paddingBottom: 4 }}>{renderOutlineItem(block)}</div>
        )}
      />
    );
  };

  const renderBody = (): react.ReactNode => {
    const section = { ...props, reading, expandedKeys, saveReading };
    if (!largeBody || scrollParent === null) {
      return props.page.nodes.map((node) => <DocumentSection {...section} key={node.block.key} node={node} />);
    }
    if (scrollParent === undefined) return null;

    //M 大段文档按可见行渲染，折叠状态仍取自同一个阅读条目。
    return (
      <virtuoso.Virtuoso
        ref={bodyList}
        customScrollParent={scrollParent}
        data={visibleRows}
        defaultItemHeight={110}
        computeItemKey={(_index, row) => row.node.block.key}
        itemContent={(_index, row) => (
          <div style={{ paddingBlock: 1, paddingInlineStart: row.depth * 12 }}>
            <DocumentSection {...section} node={row.node} flat />
          </div>
        )}
      />
    );
  };

  return (
    <div className="jm-document" ref={container}>
      {!props.page.structureKnown && (
        <p className="jm-reader-notice">
          {t('此处是文件中段，上文结构未确认；按接续原文显示，避免把代码误作章节。')}
        </p>
      )}
      <div className="jm-document-controls">
        <strong>{t('当前片段目录')}</strong>
        <button type="button" onClick={() => saveReading({ expanded: sectionKeys })}>{t('展开本段')}</button>
        <button type="button" onClick={() => saveReading({ expanded: sectionKeys.map((key) => `closed:${key}`) })}>
          {t('收起本段')}
        </button>
      </div>
      {props.page.outline.length > 0 && (
        <nav className="jm-document-outline" aria-label={t('当前片段章节')}>
          {renderOutline()}
        </nav>
      )}
      {renderBody()}
    </div>
  );
}
