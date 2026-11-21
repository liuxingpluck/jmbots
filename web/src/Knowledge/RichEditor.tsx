/**
 * 知识库正文的「富文本」模式（所见即所得）：Tiptap 加 Markdown 扩展，进出都是 Markdown。
 * KnowledgeEditor.tsx 用 react.lazy 按需加载它：只有切到富文本才拉 Tiptap，不拉高 /knowledge/ 首屏。
 * 写法参考 web/src/Chat/Composer.tsx（只读参考，不共用组件）。
 */
import * as react from 'react';
import * as tiptapMarkdown from '@tiptap/markdown';
import * as tiptapReact from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';


/** RichEditor 的参数。 */
export interface RichEditorProps {
  /** 正文 Markdown：外面换文档、恢复草稿时变，编辑器跟着换。 */
  value: string;
  /** 只读：不能改、不显示工具条。 */
  readOnly: boolean;
  /** 改了正文：交回新的 Markdown（KnowledgeEditor 的 setField('content', …)）。 */
  onChange: (markdown: string) => void;
}

/** 工具条上的一个按钮。 */
interface Tool {
  /** 键：同时是按钮的 key 和高亮表里的名字。 */
  key: string;
  /** 按钮上的字。 */
  label: string;
  /** 鼠标停上去的说明。 */
  title: string;
  /** 点了做什么。 */
  run: (editor: tiptapReact.Editor) => void;
  /** 光标所在处是不是这种格式（高亮按钮）；分割线没有。 */
  isActive?: (editor: tiptapReact.Editor) => boolean;
}

/** 工具条：标题、加粗、斜体、列表、引用、代码、分割线。 */
const TOOLS: Tool[] = [
  {
    key: 'h1',
    label: 'H1',
    title: '一级标题',
    run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    isActive: (editor) => editor.isActive('heading', { level: 1 }),
  },
  {
    key: 'h2',
    label: 'H2',
    title: '二级标题',
    run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    isActive: (editor) => editor.isActive('heading', { level: 2 }),
  },
  {
    key: 'h3',
    label: 'H3',
    title: '三级标题',
    run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    isActive: (editor) => editor.isActive('heading', { level: 3 }),
  },
  {
    key: 'bold',
    label: 'B',
    title: '加粗',
    run: (editor) => editor.chain().focus().toggleBold().run(),
    isActive: (editor) => editor.isActive('bold'),
  },
  {
    key: 'italic',
    label: 'I',
    title: '斜体',
    run: (editor) => editor.chain().focus().toggleItalic().run(),
    isActive: (editor) => editor.isActive('italic'),
  },
  {
    key: 'bulletList',
    label: '•',
    title: '无序列表',
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
    isActive: (editor) => editor.isActive('bulletList'),
  },
  {
    key: 'orderedList',
    label: '1.',
    title: '有序列表',
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
    isActive: (editor) => editor.isActive('orderedList'),
  },
  {
    key: 'blockquote',
    label: '❝',
    title: '引用',
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
    isActive: (editor) => editor.isActive('blockquote'),
  },
  {
    key: 'code',
    label: '`',
    title: '行内代码',
    run: (editor) => editor.chain().focus().toggleCode().run(),
    isActive: (editor) => editor.isActive('code'),
  },
  {
    key: 'codeBlock',
    label: '{ }',
    title: '代码块',
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
    isActive: (editor) => editor.isActive('codeBlock'),
  },
  {
    key: 'hr',
    label: '—',
    title: '分割线',
    run: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
];


/**
 * 光标所在处哪些格式是开着的（工具条按钮高亮用）。
 * @param editor 编辑器；还没建好是 null。
 * @returns 工具键 → 开没开。
 */
function getActive(editor: tiptapReact.Editor | null): Record<string, boolean> {
  const active: Record<string, boolean> = {};
  if (editor === null) return active;

  for (const tool of TOOLS) {
    if (tool.isActive !== undefined) {
      active[tool.key] = tool.isActive(editor);
    }
  }
  return active;
}


/** 富文本转回 Markdown 时可能被简化的写法：表格分隔行、图片、任务列表（云端 30 #2）。 */
const LOSSY_PATTERNS = [
  /^\s*\|?[\s:-]+\|[\s|:-]*$/mu,
  /!\[[^\]]*\]\([^)]+\)/u,
  /^\s*[-*+]\s+\[[ xX]\]/mu,
];


/**
 * 富文本正文编辑器。
 * @param props 正文、只读、改动回调。
 */
export function RichEditor({ value, readOnly, onChange }: RichEditorProps) {
  /** 最近一次和外面对齐过的 Markdown：自己打字回传的不再灌回去（光标不跳、不死循环），外面换了才灌。 */
  const syncedRef = react.useRef(value);

  /** 回调放进 ref：父组件每次渲染都换新函数，编辑器不用跟着重建。 */
  const onChangeRef = react.useRef(onChange);
  onChangeRef.current = onChange;

  //M 建编辑器：初始内容按 Markdown 解析；每次改动把 Markdown 交回去，并记成“已对齐”。
  const editor = tiptapReact.useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      tiptapMarkdown.Markdown,
    ],
    content: value,
    contentType: 'markdown',
    editable: !readOnly,
    onUpdate: ({ editor: current }) => {
      const markdown = current.getMarkdown();
      syncedRef.current = markdown;
      onChangeRef.current(markdown);
    },
    editorProps: {
      attributes: { class: 'kb-rich-content', 'aria-label': '富文本正文' },
    },
  });

  //M 外面的正文变了（换文档、恢复草稿），且不是自己刚交回去的：灌进编辑器，不触发 onUpdate 回传。
  react.useEffect(() => {
    if (editor === null) return;

    if (value === syncedRef.current) return;

    syncedRef.current = value;
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
  }, [editor, value]);

  //M 只读切换跟着外面走（登录状态变了）。
  react.useEffect(() => {
    if (editor === null) return;

    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  //M 工具条高亮：光标、选区一变就重算。
  const active = tiptapReact.useEditorState({
    editor,
    selector: ({ editor: current }) => getActive(current),
  });

  //M 正文里有富文本可能改坏的写法：工具条下面提醒一句，只提醒不拦。
  const isLossy = LOSSY_PATTERNS.some((pattern) => pattern.test(value));

  /**
   * 点一个工具按钮。
   * @param tool 哪个按钮。
   */
  const runTool = (tool: Tool): void => {
    if (editor === null) return;

    tool.run(editor);
  };

  return (
    <div className="kb-rich" data-readonly={readOnly}>
      {!readOnly && (
        <div className="kb-rich-tools" role="toolbar" aria-label="格式">
          {TOOLS.map((tool) => (
            <button
              key={tool.key}
              type="button"
              title={tool.title}
              aria-label={tool.title}
              data-active={active?.[tool.key] === true}
              disabled={editor === null}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runTool(tool)}
            >
              {tool.label}
            </button>
          ))}
        </div>
      )}
      {!readOnly && isLossy && (
        <p className="kb-rich-warn" role="note">
          本文包含表格、图片或任务列表，富文本编辑可能简化原格式，建议切回「源码」编辑
        </p>
      )}
      <tiptapReact.EditorContent editor={editor} className="kb-rich-body" />
    </div>
  );
}
