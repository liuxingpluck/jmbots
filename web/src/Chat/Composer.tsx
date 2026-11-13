/**
 * 输入框（docs/界面/01_界面设计.md 第 7.2、7.3 节）：Tiptap 富文本，发出去的是 Markdown。
 *   Enter 发送；Shift+Enter、Alt+Enter 换行；中文输入法组字时按 Enter 不发送（交给输入法选字）。
 *   附件：拖进来、Ctrl+V 粘贴、回形针选文件、/图片 /文件；选中就开始上传，发送时等它们传完。
 *   工作区标签：右栏“工作区”文件树点文件/文件夹出 chip，发送时拼成 @绝对路径 接在正文后（G批设计 7.4）。
 *   斜杠命令：行首或空格后打 /（SlashMenu.tsx、SlashCommands.ts）。/会话 选了以后，这条直接发给那个会话，不分派。
 */
import * as icons from '@ant-design/icons';
import type * as tiptapCore from '@tiptap/core';
import * as tiptapExtensions from '@tiptap/extensions';
import * as tiptapMarkdown from '@tiptap/markdown';
import * as tiptapReact from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as attachmentsModule from './Attachments.ts';
import type * as slash from './SlashCommands.ts';
import * as slashMenu from './SlashMenu.tsx';
import * as useAttachmentsModule from './useAttachments.ts';


/** 输入框的属性。 */
interface ComposerProps {
  /** 发给哪个机器人。 */
  bot: string;
  /** 连得上后端吗（连不上时不让发）。 */
  online: boolean;
  /** 全部机器人的名字（/机器人 用）。 */
  bots: string[];
  /** 换和谁聊。 */
  selectBot: (name: string) => void;
  /** 打开设置。 */
  openSettings: () => void;
  /** 打开帮助。 */
  openHelp: () => void;
  /** 发出去了（让时间线马上取一次）。 */
  onSent: () => void;
}


/**
 * “Enter 发送”：一个按键扩展。组字中不响应；Shift+Enter、Alt+Enter 照常换行（列表里接着列表）。
 * @param send 发送（读最新的输入框内容）。
 */
function sendOnEnter(send: () => void): tiptapReact.Extension {
  /** 换行：和 Tiptap 原来的 Enter 一样的那一串。 */
  const newline = ({ editor }: { editor: tiptapReact.Editor }): boolean =>
    editor.commands.first(({ commands }) => [
      () => commands.newlineInCode(),
      () => commands.splitListItem('listItem'),
      () => commands.createParagraphNear(),
      () => commands.liftEmptyBlock(),
      () => commands.splitBlock(),
    ]);
  return tiptapReact.Extension.create({
    name: 'sendOnEnter',
    priority: 1000,
    addKeyboardShortcuts() {
      return {
        Enter: ({ editor }) => {
          //G 输入法正在组字：这个 Enter 是选字，交给输入法。
          if (editor.view.composing) {
            return false;
          }
          send();
          return true;
        },
        'Shift-Enter': newline,
        'Alt-Enter': newline,
      };
    },
  });
}


/**
 * 输入框。
 * @param props 发给谁、连没连上、几个界面动作。
 */
export function Composer(props: ComposerProps): react.JSX.Element {
  const t = i18n.useT();
  /** 附件。 */
  const attachments = useAttachmentsModule.useAttachments();
  /** 工作区标签：右栏“工作区”文件树点出来的，发送时拼成 @绝对路径（G批设计 7.5）。 */
  const tags = context.useUi((state) => state.workspaceTags);
  const removeWorkspaceTag = context.useUi((state) => state.removeWorkspaceTag);
  const clearWorkspaceTags = context.useUi((state) => state.clearWorkspaceTags);
  /** 选文件的 input。 */
  const fileInput = react.useRef<HTMLInputElement>(null);
  /** 指定的会话：这条直接发给它（/会话）。 */
  const [target, setTarget] = react.useState<api.SessionBrief | null>(null);
  /** 选会话、选机器人的弹窗开着没有；会话列表。 */
  const [choosing, setChoosing] = react.useState<'session' | 'bot' | null>(null);
  const [sessionList, setSessionList] = react.useState<api.SessionBrief[]>([]);
  /** 正在发。 */
  const [sending, setSending] = react.useState(false);
  /** 提示（没传完、发失败……）。 */
  const [notice, setNotice] = react.useState('');
  /** 最新的发送函数（Enter 扩展里读它，拿到的总是最新的状态）。 */
  const sendRef = react.useRef<() => void>(() => undefined);
  /** 最新的斜杠命令上下文。 */
  const slashRef = react.useRef<() => slash.SlashActions>(() => ({
    pickFiles: () => undefined,
    chooseSession: () => undefined,
    chooseBot: () => undefined,
    openSettings: () => undefined,
    openHelp: () => undefined,
    clearAll: () => undefined,
  }));

  /** 草稿（文档 JSON）：语言变了输入框要重建（占位符是创建时定的），重建时把草稿接上。 */
  const draftRef = react.useRef<tiptapCore.JSONContent | undefined>(undefined);
  /** 输入框本身；t 变了重建，占位符、aria、斜杠菜单跟着新语言。 */
  const editor = tiptapReact.useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      tiptapExtensions.Placeholder.configure({ placeholder: t('发消息…  打 / 用命令，Enter 发送，Shift+Enter 换行') }),
      tiptapMarkdown.Markdown,
      slashMenu.createSlashExtension(() => slashRef.current(), t),
      sendOnEnter(() => sendRef.current()),
    ],
    content: draftRef.current,
    onUpdate: ({ editor: current }) => {
      draftRef.current = current.getJSON();
    },
    editorProps: {
      attributes: { class: 'jm-editor', 'aria-label': t('输入消息') },
      handlePaste: (_view, event) => {
        /** 粘贴的文件（截图、复制的文件）。 */
        const files = useAttachmentsModule.filesFrom(event.clipboardData);
        if (files.length === 0) {
          return false;
        }
        attachments.add(files);
        return true;
      },
      handleDrop: (_view, event) => {
        /** 拖进来的文件。 */
        const files = useAttachmentsModule.filesFrom(event.dataTransfer);
        if (files.length === 0) {
          return false;
        }
        event.preventDefault();
        attachments.add(files);
        return true;
      },
    },
  }, [t]);

  /** 清空输入框和附件、指定的会话、工作区标签。 */
  const clearAll = react.useCallback(() => {
    editor.commands.clearContent();
    attachments.clear();
    clearWorkspaceTags();
    setTarget(null);
    setNotice('');
  }, [editor, attachments, clearWorkspaceTags]);

  /** 打开选文件。 */
  const pickFiles = react.useCallback((accept?: string) => {
    /** input。 */
    const input = fileInput.current;
    if (input) {
      input.accept = accept ?? '';
      input.click();
    }
  }, []);

  /** 选会话：先取列表。 */
  const chooseSession = react.useCallback(() => {
    void api.sessions(props.bot).then(
      (list) => {
        setSessionList(list);
        setChoosing('session');
      },
      () => setNotice(t('取不到会话列表')),
    );
  }, [props.bot, t]);

  /** 发送。 */
  const send = react.useCallback(() => {
    /** 文字（Markdown）。 */
    const text = editor.getMarkdown().trim();
    /** 正文接上工作区标签的 @绝对路径，发出去的是它（G批设计 7.4）。 */
    const finalText = attachmentsModule.withWorkspaceTags(text, tags.map((tag) => tag.path));
    if (sending) {
      return;
    }
    if (!props.online) {
      setNotice(t('连不上后端，等它回来再发'));
      return;
    }
    if (attachments.uploading) {
      setNotice(t('附件还在传，传完再发'));
      return;
    }
    if (attachments.items.some((item) => item.error)) {
      setNotice(t('有附件没传上去，删掉它再发'));
      return;
    }
    if (!finalText && attachments.uploadIds.length === 0) {
      return;
    }
    setSending(true);
    setNotice('');
    api.sendMessage({ text: finalText, bot: props.bot, uploads: attachments.uploadIds, session: target?.id }).then(
      () => {
        editor.commands.clearContent();
        attachments.clear();
        clearWorkspaceTags();
        setTarget(null);
        setSending(false);
        props.onSent();
      },
      (error: unknown) => {
        setSending(false);
        setNotice(t('没发出去：{error}', { error: error instanceof Error ? error.message : String(error) }));
      },
    );
  }, [editor, sending, props, attachments, target, tags, clearWorkspaceTags, t]);

  sendRef.current = send;
  slashRef.current = () => ({
    pickFiles,
    chooseSession,
    chooseBot: () => setChoosing('bot'),
    openSettings: props.openSettings,
    openHelp: props.openHelp,
    clearAll,
  });

  return (
    <div
      className="jm-composer"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        /** 拖到输入框外面（但在这一块里）的文件。 */
        const files = useAttachmentsModule.filesFrom(event.dataTransfer);
        if (files.length > 0) {
          event.preventDefault();
          attachments.add(files);
        }
      }}
    >
      {(attachments.items.length > 0 || target || tags.length > 0) && (
        <div className="jm-chips">
          {target && (
            <span className="jm-chip jm-chip-target">
              <icons.MessageOutlined /> {t('发给会话「{title}」', { title: target.title })}
              <button type="button" aria-label={t('不指定会话')} onClick={() => setTarget(null)}>
                <icons.CloseOutlined />
              </button>
            </span>
          )}
          {tags.map((tag) => (
            <span key={tag.path} className="jm-chip" title={tag.path}>
              {tag.kind === 'dir' ? <icons.FolderOutlined /> : <icons.FileOutlined />}
              <span className="jm-chip-name">{tag.label}</span>
              <button type="button" aria-label={t('去掉标签 {name}', { name: tag.label })} onClick={() => removeWorkspaceTag(tag.path)}>
                <icons.CloseOutlined />
              </button>
            </span>
          ))}
          {attachments.items.map((item) => (
            <span key={item.key} className={item.error ? 'jm-chip jm-chip-error' : 'jm-chip'} title={item.error ?? item.name}>
              {item.preview ? <img src={item.preview} alt="" /> : <icons.PaperClipOutlined />}
              <span className="jm-chip-name">{item.name}</span>
              <span className="jm-muted">{item.error ? t('没传上') : attachmentsModule.formatSize(item.size)}</span>
              {!item.uploadId && !item.error && <span className="jm-chip-progress">{Math.round(item.progress * 100)}%</span>}
              <button type="button" aria-label={t('删掉 {name}', { name: item.name })} onClick={() => attachments.remove(item.key)}>
                <icons.CloseOutlined />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="jm-composer-box">
        <antd.Button type="text" icon={<icons.PaperClipOutlined />} aria-label={t('选文件')} onClick={() => pickFiles()} />
        <tiptapReact.EditorContent editor={editor} className="jm-editor-wrap" onScroll={(event) => event.currentTarget.toggleAttribute('data-scrolled', event.currentTarget.scrollTop > 0)} />
        <antd.Button type="primary" icon={<icons.SendOutlined />} aria-label={t('发送（Enter）')} loading={sending} disabled={!props.online} onClick={send} />
      </div>
      {notice && <div className="jm-composer-notice">{notice}</div>}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          attachments.add([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
      <antd.Modal open={choosing === 'session'} title={t('这条发给哪个会话（不分派）')} footer={null} onCancel={() => setChoosing(null)}>
        <div className="jm-pick-list">
          {sessionList.length === 0 && <div className="jm-muted">{t('还没有会话')}</div>}
          {sessionList.map((session) => (
            <button
              key={session.id}
              type="button"
              className="jm-pick-item"
              onClick={() => {
                setTarget(session);
                setChoosing(null);
                editor.commands.focus();
              }}
            >
              <span>{session.title}</span>
              <span className="jm-muted">
                {session.workspace} · {session.status === 'running' ? t('运行中') : t('空闲')}
              </span>
            </button>
          ))}
        </div>
      </antd.Modal>
      <antd.Modal open={choosing === 'bot'} title={t('和谁聊')} footer={null} onCancel={() => setChoosing(null)}>
        <div className="jm-pick-list">
          {props.bots.map((name) => (
            <button
              key={name}
              type="button"
              className="jm-pick-item"
              onClick={() => {
                props.selectBot(name);
                setChoosing(null);
              }}
            >
              {name}
            </button>
          ))}
        </div>
      </antd.Modal>
    </div>
  );
}
