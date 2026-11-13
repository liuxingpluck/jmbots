/**
 * 文档的分层阅读：运行包含步骤，步骤包含角色；目录只对应当前一个文件片段。
 * 展开、选中章节都保存为轻量 key，离开再返回时不必重新翻找。
 */
import * as react from 'react';
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
  /** 只保存当前条目的轻量状态。 */
  saveReading: readingModule.ReadingState['saveReading'];
}


/** 角色名称属于界面翻译，文件里的标题与时间仍按证据原文显示。 */
function kindLabel(kind: documentModule.DocumentKind, t: i18n.Translate): string {
  switch (kind) {
    case 'run': return t('运行');
    case 'step': return t('步骤');
    case 'user': return t('用户');
    case 'assistant': return t('助手');
    case 'tool-call': return t('工具调用');
    case 'tool-result': return t('工具结果');
    case 'thinking': return t('思考');
    case 'program': return t('程序');
    case 'review': return t('审核');
    case 'fragment': return t('接续片段');
    default: return t('章节');
  }
}


/** 默认展开项可记录 closed:key；默认收起的结果/思考仅在明确展开后显示。 */
function isOpen(block: documentModule.DocumentBlock, expanded: string[]): boolean {
  if (expanded.includes(`closed:${block.key}`)) {
    return false;
  }
  return expanded.includes(block.key) || !block.collapsed;
}


/** 章节收放包含其全部子步骤与角色，不把运行标题做成空卡片。 */
function DocumentSection(props: SectionProps): react.JSX.Element {
  const t = i18n.useT();
  const block = props.node.block;
  const open = isOpen(block, props.reading.expanded);
  const label = kindLabel(block.kind, t);
  const toggle = (nextOpen: boolean): void => {
    if (nextOpen === open) {
      return;
    }
    const expanded = props.reading.expanded.filter((key) => {
      return key !== block.key && key !== `closed:${block.key}`;
    });
    expanded.push(nextOpen ? block.key : `closed:${block.key}`);
    props.saveReading({ expanded });
  };

  return (
    <details
      className={`jm-document-block jm-document-${block.kind}`}
      data-document-key={block.key}
      open={open}
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
          {block.kind === 'fragment' ? <pre className="jm-preview-code">{block.body}</pre> : (
            <markdown.Markdown text={block.body} onOpen={props.onOpen} onLink={props.onLink} />
          )}
        </div>
      )}
      {open && props.node.children.length > 0 && (
        <div className="jm-document-children">
          {props.node.children.map((node) => <DocumentSection {...props} key={node.block.key} node={node} />)}
        </div>
      )}
    </details>
  );
}


/** 当前段的章节目录与结构化正文；点击目录时展开父层再定位。 */
export function DocumentView(props: DocumentViewProps): react.JSX.Element {
  const t = i18n.useT();
  const { reading, saveReading } = readingModule.useReadingState();
  const container = react.useRef<HTMLDivElement>(null);
  const sectionKeys = props.page.blocks.map((block) => block.key);

  /** 查找要定位的章节的祖先链，保证收起的父运行也能一并展开。 */
  const parentsOf = (nodes: documentModule.DocumentNode[], wanted: string): string[] | undefined => {
    for (const node of nodes) {
      if (node.block.key === wanted) {
        return [wanted];
      }
      const found = parentsOf(node.children, wanted);
      if (found) {
        return [node.block.key, ...found];
      }
    }
    return undefined;
  };
  const locate = (key: string): void => {
    const ancestors = parentsOf(props.page.nodes, key) ?? [key];
    const expanded = reading.expanded.filter((item) => !ancestors.some((ancestor) => item === `closed:${ancestor}`));
    saveReading({ section: key, expanded: [...new Set([...expanded, ...ancestors])] });

    /** React 提交展开状态后再定位；已卸载的旧目标不滚动新页面。 */
    requestAnimationFrame(() => {
      const element = container.current?.querySelector(`[data-document-key="${key}"]`);
      if (element?.isConnected) {
        element.scrollIntoView({ block: 'start', behavior: 'auto' });
      }
    });
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
          {props.page.outline.map((block) => (
            <button
              type="button"
              key={block.key}
              className={block.key === reading.section ? 'jm-document-current' : ''}
              style={{ paddingInlineStart: `${Math.max(0, block.level - 1) * 10 + 8}px` }}
              onClick={() => locate(block.key)}
            >
              {block.title}
            </button>
          ))}
        </nav>
      )}
      {props.page.nodes.map((node) => (
        <DocumentSection {...props} key={node.block.key} node={node} reading={reading} saveReading={saveReading} />
      ))}
    </div>
  );
}
