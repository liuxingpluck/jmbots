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


/** 白名单放行 VS Code（含 Insiders）打开本机源码文件的安全协议。 */
export const VSCODE_FILE_SCHEME = /^vscode(?:-insiders)?:\/\/file\//i;


/**
 * 判断链接地址是否命中 vscode://file/ 白名单协议。
 * @param href 原始链接地址。
 */
function isVscodeFileHref(href: string | undefined): boolean {
  if (href === undefined) return false;

  return VSCODE_FILE_SCHEME.test(href);
}


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
function getText(node: react.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(getText).join('');
  }
  if (react.isValidElement<{ children?: react.ReactNode }>(node)) {
    //M 递归提取 React 元素子节点里的纯文本，用于代码块一键复制。
    return getText(node.props.children);
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
  let copyIcon = <icons.CopyOutlined />;
  if (copied) {
    copyIcon = <icons.CheckOutlined />;
  }
  return (
    <div className="jm-code">
      <button
        type="button"
        className="jm-code-copy"
        onClick={() => {
          //M 从代码块子树提取纯文本并去掉末尾换行，写入系统剪贴板。
          void navigator.clipboard.writeText(getText(props.children).replace(/\n$/, '')).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copyIcon}
      </button>
      <pre>{props.children}</pre>
    </div>
  );
}


/**
 * 渲染一段 Markdown，把正文里的附件路径转换成附件卡片并接管代码块复制与文档内链点击。
 * @param props 组件属性，包含待渲染文本、附件打开回调及可选的链接拦截回调。
 * @returns Markdown 渲染容器 JSX 元素。
 * 副作用：无直接副作用；点击代码块复制按钮会写入剪贴板，点击链接可能触发拦截回调。
 */
export function Markdown(props: MarkdownProps): react.JSX.Element {
  /** 附件换成链接以后的文字。 */
  //M 先把正文中的 @附件路径 改写成 jmfile: 链接，交给 react-markdown 统一识别并渲染成附件组件。
  const source = react.useMemo(() => attachmentsModule.withAttachmentLinks(props.text), [props.text]);
  /** 点了附件。 */
  const onOpen = props.onOpen;
  const onLink = props.onLink;
  /** 换掉的几个元素。 */
  const components = react.useMemo<reactMarkdown.Components>(
    () => ({
      a: (anchor) => {
        /** 附件的路径。 */
        //M 从链接地址反解附件路径，判断它是否属于内部附件占位链接。
        const path = attachmentsModule.getPathFromLink(anchor.href);
        if (path) {
          //M 确认为内部附件时拆出文件名和类型，改用 AttachmentView 卡片渲染。
          const attachment = {
            path,
            name: attachmentsModule.getBaseName(path),
            kind: attachmentsModule.getAttachmentKind(path),
          };
          return <attachmentView.AttachmentView attachment={attachment} onOpen={onOpen} />;
        }
        const handleAnchorClick = (event: react.MouseEvent<HTMLAnchorElement>): void => {
          if (anchor.href && onLink?.(anchor.href)) {
            event.preventDefault();
          }
        };
        if (isVscodeFileHref(anchor.href)) {
          //M 命中 vscode://file/ 时不加 target="_blank"，防止浏览器拉起编辑器后残留空白页。
          return (
            <a href={anchor.href} onClick={handleAnchorClick}>
              {anchor.children}
            </a>
          );
        }
        return (
          <a href={anchor.href} target="_blank" rel="noreferrer" onClick={handleAnchorClick}>
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
      <reactMarkdown.default
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={(url) => {
          if (url.startsWith(attachmentsModule.FILE_SCHEME)) return url;
          if (VSCODE_FILE_SCHEME.test(url)) return url;

          return reactMarkdown.defaultUrlTransform(url);
        }}
      >
        {source}
      </reactMarkdown.default>
    </div>
  );
}
