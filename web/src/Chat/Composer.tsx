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
import * as privacy from '../Privacy/Mask.tsx';
import * as attachmentsModule from './Attachments.ts';
import type * as slash from './SlashCommands.ts';
import * as slashMenu from './SlashMenu.tsx';
import * as useAttachmentsModule from './useAttachments.ts';


/** 输入框选中的真实收件引用；机器人回复使用所属收件号。 */
export interface ReplyDraft {
  /** 收件消息号。 */
  id: number;
  /** 原收件渠道。 */
  channel: string;
  /** 显示的发言人。 */
  peer: string;
  /** 原文摘要。 */
  text: string;
}

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
  /** 当前回复目标。 */
  reply: ReplyDraft | null;
  /** 每次右键引用产生新的对象，重复引用同一句也会插入。 */
  quote: { text: string } | null;
  /** 取消引用；成功发送或清空时也调用。 */
  onCancelReply: () => void;
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
  const masked = privacy.useMask();
  const replyMasked = masked && privacy.wechat(props.reply);
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
  /** 默认模型：常规模型清单、这个机器人的前台对话（它的模型就是默认模型，后台会话跟着它开）。 */
  const [chatModels, setChatModels] = react.useState<api.ModelInfo[]>([]);
  const [front, setFront] = react.useState<api.SessionBrief | undefined>(undefined);
  react.useEffect(() => {
    void api.models().then((list) => setChatModels(list.filter((item) => item.kind === 'chat')), () => undefined);
    void api.sessions(props.bot).then((list) => setFront(list.find((item) => item.kind === 'front')), () => undefined);
  }, [props.bot]);
  /** 换默认模型：改前台对话的模型（POST /api/sessions/:id/model，存库）；思考档有 low 用 low，没有用它的第一档。 */
  const changeModel = (model: string): void => {
    if (front === undefined) return;
    const info = chatModels.find((item) => item.id === model);
    const thinking = info?.thinking.includes('low') ? 'low' : (info?.thinking[0] ?? null);
    api.changeSessionModel(front.id, model, thinking).then(
      () => setFront({ ...front, model }),
      (error: unknown) => setNotice(t('换模型没成功：{error}', { error: error instanceof Error ? error.message : String(error) })),
    );
  };
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

  //M 引用可能在关打码时已写进编辑器；开启后不挂载含引用的草稿，关闭可原样继续。
  const hasQuote = tiptapReact.useEditorState({
    editor,
    selector: ({ editor: current }) => JSON.stringify(current.getJSON()).includes('"blockquote"'),
  });
  const hideDraft = masked && hasQuote;

  react.useEffect(() => {
    if (props.reply) {
      editor.commands.focus();
    }
  }, [editor, props.reply]);

  react.useEffect(() => {
    if (!props.quote) return;

    const quotedText = privacy.text(props.quote.text, privacy.getMask());
    const paragraphs = quotedText.split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    }));
    editor.chain().focus().insertContent([
      { type: 'blockquote', content: paragraphs },
      { type: 'paragraph' },
    ]).run();
  }, [editor, props.quote]);

  /** 清空输入框和附件、指定的会话、工作区标签。 */
  const clearAll = react.useCallback(() => {
    editor.commands.clearContent();
    attachments.clear();
    clearWorkspaceTags();
    setTarget(null);
    setNotice('');
    props.onCancelReply();
  }, [editor, attachments, clearWorkspaceTags, props.onCancelReply]);

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

  //M 演示引导把推荐问题填进输入框。
  react.useEffect(() => {
    const onPrefill = (event: Event): void => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text;
      if (editor && typeof text === 'string' && text.trim()) {
        editor.commands.setContent(text);
      }
    };
    window.addEventListener('jmbots-guide-prefill', onPrefill);
    return () => window.removeEventListener('jmbots-guide-prefill', onPrefill);
  }, [editor]);

  /** 发送。 */
  const send = react.useCallback(() => {
    /** 文字（Markdown）。 */
    const text = editor.getMarkdown().trim();
    /** 正文接上工作区标签的 @绝对路径，发出去的是它（G批设计 7.4）。 */
    const finalText = attachmentsModule.withWorkspaceTags(text, tags.map((tag) => tag.path));
    if (hideDraft) return;

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
    const input = {
      text: finalText,
      bot: props.bot,
      uploads: attachments.uploadIds,
      session: props.reply ? undefined : target?.id,
      reply_to: props.reply?.id,
    };
    api.sendMessage(input).then(
      () => {
        editor.commands.clearContent();
        attachments.clear();
        clearWorkspaceTags();
        setTarget(null);
        setSending(false);
        props.onCancelReply();
        props.onSent();
        window.dispatchEvent(new Event('jmbots-guide-sent'));
      },
      (error: unknown) => {
        setSending(false);
        setNotice(t('没发出去：{error}', { error: error instanceof Error ? error.message : String(error) }));
      },
    );
  }, [editor, sending, props, attachments, target, tags, clearWorkspaceTags, t, hideDraft]);

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
      {props.reply && (
        <div className="jm-composer-reply" role="status">
          <icons.RollbackOutlined />
          <div>
            <strong>{t('回复')} · {props.reply.channel} · {privacy.name(props.reply.peer, replyMasked)} · #{props.reply.id}</strong>
            <span>{privacy.text(props.reply.text.slice(0, 60), replyMasked)}</span>
          </div>
          <antd.Button
            type="text"
            size="small"
            aria-label={t('取消回复')}
            icon={<icons.CloseOutlined />}
            onClick={props.onCancelReply}
          />
        </div>
      )}
      {(attachments.items.length > 0 || target || tags.length > 0) && (
        <div className="jm-chips">
          {target && (
            <span className="jm-chip jm-chip-target">
              <icons.MessageOutlined /> {t('发给会话「{title}」', { title: privacy.name(target.title, masked) })}
              <button type="button" aria-label={t('不指定会话')} onClick={() => setTarget(null)}>
                <icons.CloseOutlined />
              </button>
            </span>
          )}
          {tags.map((tag) => (
            <span key={tag.path} className="jm-chip" title={privacy.text(tag.path, masked)}>
              {tag.kind === 'dir' ? <icons.FolderOutlined /> : <icons.FileOutlined />}
              <span className="jm-chip-name">{privacy.name(tag.label, masked)}</span>
              <button type="button" aria-label={t('去掉标签 {name}', { name: privacy.name(tag.label, masked) })} onClick={() => removeWorkspaceTag(tag.path)}>
                <icons.CloseOutlined />
              </button>
            </span>
          ))}
          {attachments.items.map((item) => (
            <span key={item.key} className={item.error ? 'jm-chip jm-chip-error' : 'jm-chip'} title={privacy.text(item.error ?? item.name, masked)}>
              {!masked && item.preview ? <img src={item.preview} alt="" /> : <icons.PaperClipOutlined />}
              <span className="jm-chip-name">{privacy.name(item.name, masked)}</span>
              <span className="jm-muted">{item.error ? t('没传上') : attachmentsModule.formatSize(item.size)}</span>
              {!item.uploadId && !item.error && <span className="jm-chip-progress">{Math.round(item.progress * 100)}%</span>}
              <button type="button" aria-label={t('删掉 {name}', { name: privacy.name(item.name, masked) })} onClick={() => attachments.remove(item.key)}>
                <icons.CloseOutlined />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="jm-composer-box">
        <antd.Button type="text" icon={<icons.PaperClipOutlined />} aria-label={t('选文件')} onClick={() => pickFiles()} />
        {hideDraft ? <div className="jm-muted">{privacy.text('引用草稿', true)} <button type="button" onClick={clearAll}>{t('清空')}</button></div> : <tiptapReact.EditorContent editor={editor} className="jm-editor-wrap" onScroll={(event) => event.currentTarget.toggleAttribute('data-scrolled', event.currentTarget.scrollTop > 0)} />}
        {front !== undefined && chatModels.length > 0 && (
          <antd.Select
            className="jm-composer-model"
            size="small"
            virtual={false}
            popupMatchSelectWidth={false}
            value={front.model}
            title={t('默认模型：前台对话和新开的后台会话都用它')}
            options={chatModels.map((item) => ({ value: item.id, label: item.name || item.id }))}
            onChange={changeModel}
          />
        )}
        <antd.Button type="primary" icon={<icons.SendOutlined />} aria-label={t('发送（Enter）')} loading={sending} disabled={!props.online || hideDraft} onClick={send} />
      </div>
      {notice && <div className="jm-composer-notice">{privacy.text(notice, masked)}</div>}
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
              <span>{privacy.name(session.title, masked)}</span>
              <span className="jm-muted">
                {privacy.text(session.workspace, masked)} · {session.status === 'running' ? t('运行中') : t('空闲')}
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
