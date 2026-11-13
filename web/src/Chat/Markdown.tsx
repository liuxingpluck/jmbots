/**
 * Markdown 渲染（docs/界面/01_界面设计.md 第 7.1 节）：标题、粗体、列表、引用、代码块（带复制）、表格（GFM）。
 * 文字里的 @路径 先换成 jmfile: 链接，渲染时换成附件（图片、播放器、文件卡片）。不认原始 HTML（安全，也不会把页面弄乱）。
 */
import * as icons from '@ant-design/icons';
import * as react from 'react';
import * as reactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as attachmentsModule from './Attachments.ts';
import * as attachmentView from './AttachmentView.tsx';


/** Markdown 的属性。 */
interface MarkdownProps {
  /** 要渲染的文字。 */
  text: string;
  /** 点了附件在右栏打开。 */
  onOpen: (target: { path: string; name: string }) => void;
  /** 预览可接管文档内链；返回 true 时阻止外部打开，聊天默认保持原行为。 */
  onLink?: (href: string) => boolean;
}


/**
 * 一段节点里的纯文字（复制代码块用）。
 * @param node React 节点。
 */
function textOf(node: react.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join('');
  }
  if (react.isValidElement<{ children?: react.ReactNode }>(node)) {
    return textOf(node.props.children);
  }
  return '';
}


/**
 * 代码块：右上角一个复制按钮。
 * @param props children 是 <code>。
 */
function CodeBlock(props: { children?: react.ReactNode }): react.JSX.Element {
  /** 刚复制过。 */
  const [copied, setCopied] = react.useState(false);
  return (
    <div className="jm-code">
      <button
        type="button"
        className="jm-code-copy"
        onClick={() => {
          void navigator.clipboard.writeText(textOf(props.children).replace(/\n$/, '')).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <icons.CheckOutlined /> : <icons.CopyOutlined />}
      </button>
      <pre>{props.children}</pre>
    </div>
  );
}


/**
 * 渲染一段 Markdown。
 * @param props 文字和点了附件怎么办。
 */
export function Markdown(props: MarkdownProps): react.JSX.Element {
  /** 附件换成链接以后的文字。 */
  const source = react.useMemo(() => attachmentsModule.withAttachmentLinks(props.text), [props.text]);
  /** 点了附件。 */
  const onOpen = props.onOpen;
  const onLink = props.onLink;
  /** 换掉的几个元素。 */
  const components = react.useMemo<reactMarkdown.Components>(
    () => ({
      a: (anchor) => {
        /** 附件的路径。 */
        const path = attachmentsModule.pathFromLink(anchor.href);
        if (path) {
          return <attachmentView.AttachmentView attachment={{ path, name: attachmentsModule.baseName(path), kind: attachmentsModule.attachmentKind(path) }} onOpen={onOpen} />;
        }
        return (
          <a href={anchor.href} target="_blank" rel="noreferrer" onClick={(event) => {
            if (anchor.href && onLink?.(anchor.href)) {
              event.preventDefault();
            }
          }}>
            {anchor.children}
          </a>
        );
      },
      pre: (block) => <CodeBlock>{block.children}</CodeBlock>,
      table: (table) => (
        <div className="jm-table">
          <table>{table.children}</table>
        </div>
      ),
    }),
    [onOpen, onLink],
  );
  return (
    <div className="jm-markdown">
      <reactMarkdown.default remarkPlugins={[remarkGfm]} components={components} urlTransform={(url) => (url.startsWith(attachmentsModule.FILE_SCHEME) ? url : reactMarkdown.defaultUrlTransform(url))}>
        {source}
      </reactMarkdown.default>
    </div>
  );
}
