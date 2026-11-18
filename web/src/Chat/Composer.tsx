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
import * as virtuoso from 'react-virtuoso';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';
import * as attachmentsModule from './Attachments.ts';
import type * as slash from './SlashCommands.ts';
import * as slashMenu from './SlashMenu.tsx';
import * as useAttachmentsModule from './useAttachments.ts';


/**
 * 选默认模型的下拉有多宽，像素。antd Select 的 popupMatchSelectWidth 是 false 时会关掉虚拟滚动，
 * 给一个数就照样虚拟（用户 11-17：有滚动条的地方都要虚拟滚动），长名字省略，悬停看全名。
 */
const MODEL_POPUP_WIDTH = 360;

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
  /** 正在查看的渠道与聊天上下文（带进 POST /api/message 的 view）。 */
  view?: { channel: string; chat?: string };
  /** 输入框上方显示的一行查看上下文提示。 */
  viewBanner?: string;
  /** 点横幅关闭按钮回到全部渠道。 */
  onClearView?: () => void;
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


function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;

  return String(error);
}


/**
 * 聊天底部输入框组件：管理富文本草稿、附件拖拽/粘贴上传、斜杠命令、回复/引用与默认模型切换。
 * @param props 输入框属性，包含当前机器人、在线状态、回复/引用上下文及回调。
 * @returns 聊天输入区及关联弹窗 JSX 元素。
 * 副作用：请求模型与会话列表、修改前台会话模型、提交发送请求到 `/api/message`，并监听/派发引导页自定义事件。
 */
export function Composer(props: ComposerProps): react.JSX.Element {
  //M 取翻译函数、隐私打码开关，并结合当前回复目标渠道判断回复栏是否需脱敏。
  const t = i18n.useT();
  const masked = privacy.useMask();
  const replyMasked = masked && privacy.wechat(props.reply);
  /** 附件。 */
  //M 初始化附件上传队列状态，供粘贴、拖拽、芯片展示及发送前校验使用。
  const attachments = useAttachmentsModule.useAttachments();
  /** 工作区标签：右栏“工作区”文件树点出来的，发送时拼成 @绝对路径（G批设计 7.5）。 */
  //M 读取工作区文件标签及增删动作，供渲染标签条并在发送或清空时同步清理。
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
  /** 选会话弹窗里的滚动元素（.jm-pick-list，限高 60vh）：会话不限量，交给 react-virtuoso 当 customScrollParent。 */
  const [pickScroller, setPickScroller] = react.useState<HTMLDivElement | null>(null);
  /** 正在发。 */
  const [sending, setSending] = react.useState(false);
  /** 默认模型：常规模型清单、这个机器人的前台对话（它的模型就是默认模型，后台会话跟着它开）。 */
  const [chatModels, setChatModels] = react.useState<api.ModelInfo[]>([]);
  const [front, setFront] = react.useState<api.SessionBrief | undefined>(undefined);
  react.useEffect(() => {
    //M 切换机器人时同步拉取可用对话模型列表与该机器人的前台会话，用于底部模型选择器。
    void api.models().then((list) => setChatModels(list.filter((item) => item.kind === 'chat')), () => undefined);
    void api.sessions(props.bot).then((list) => setFront(list.find((item) => item.kind === 'front')), () => undefined);
  }, [props.bot]);
  /** 换默认模型：改前台对话的模型（POST /api/sessions/:id/model，存库）；思考档有 low 用 low，没有用它的第一档。 */
  const changeModel = (model: string): void => {
    if (front === undefined) return;
    const info = chatModels.find((item) => item.id === model);
    let thinking: string | null = info?.thinking[0] ?? null;
    if (info?.thinking.includes('low')) {
      thinking = 'low';
    }
    //M 把选中的默认模型和思考档位提交到后端持久化，失败时提取报错显示在提示区。
    api.changeSessionModel(front.id, model, thinking).then(
      () => setFront({ ...front, model }),
      (error: unknown) => setNotice(t('换模型没成功：{error}', { error: getErrorText(error) })),
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
      //M 挂载斜杠命令与回车发送扩展，输入 / 时弹出命令菜单、按 Enter 直接发送。
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
        //M 从剪贴板提取文件或截图，无文件时交还编辑器执行普通文本粘贴。
        const files = useAttachmentsModule.getFilesFrom(event.clipboardData);
        if (files.length === 0) {
          return false;
        }
        //M 拦截剪贴板文件并送入附件上传队列，阻止编辑器把文件当作文本插入。
        attachments.add(files);
        return true;
      },
      handleDrop: (_view, event) => {
        /** 拖进来的文件。 */
        //M 从拖放数据中提取文件列表，非文件拖放则交给编辑器默认处理。
        const files = useAttachmentsModule.getFilesFrom(event.dataTransfer);
        if (files.length === 0) {
          return false;
        }
        //M 阻止浏览器直接打开拖入的文件，并将文件加入附件上传队列。
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

    //M 触发引用时先按全局隐私开关处理引用文本，避免打码模式下把明文插进编辑器草稿。
    const quotedText = privacy.text(props.quote.text, privacy.getMask());
    const paragraphs = quotedText.split('\n').map((line) => {
      let content: { type: string; text: string }[] = [];
      if (line) {
        content = [{ type: 'text', text: line }];
      }
      return {
        type: 'paragraph',
        content,
      };
    });
    editor.chain().focus().insertContent([
      { type: 'blockquote', content: paragraphs },
      { type: 'paragraph' },
    ]).run();
  }, [editor, props.quote]);

  /** 清空输入框和附件、指定的会话、工作区标签。 */
  const clearAll = react.useCallback(() => {
    //M 一键重置编辑器正文、附件队列、工作区标签、指定会话、提示语及回复目标。
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
    //M 触发 /会话 命令时先从后端拉取当前机器人的会话列表，再弹出选择窗口。
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
    //M 将工作区文件标签拼成 @绝对路径 接在正文末尾，作为最终发送内容并参与空消息校验。
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
    let session: string | undefined = target?.id;
    if (props.reply) {
      session = undefined;
    }
    const body: Record<string, unknown> = {
      text: finalText,
      bot: props.bot,
      from: 'web',
      uploads: attachments.uploadIds,
      session,
      reply_to: props.reply?.id,
    };
    if (props.view) {
      body['view'] = props.view;
    }
    //M 把整理好的消息载荷发往发送接口，成功则清空输入区，失败则给出提示。
    api.sendJson<{ id: number; file: string }>('/api/message', 'POST', body).then(
      () => {
        //M 消息提交成功后清空正文、附件、标签与回复目标，并触发时间线刷新和引导完成事件。
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
        //M 发送失败时解除发送锁，保留草稿并把可读报错信息展示到提示条。
        setSending(false);
        setNotice(t('没发出去：{error}', { error: getErrorText(error) }));
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
        //M 提取拖到输入区外框的文件，只要包含文件就拦截浏览器打开并加入附件上传队列。
        const files = useAttachmentsModule.getFilesFrom(event.dataTransfer);
        if (files.length > 0) {
          event.preventDefault();
          attachments.add(files);
        }
      }}
    >
      {props.viewBanner && (
        <div className="jm-composer-view" role="status">
          <icons.EyeOutlined />
          <span className="jm-composer-view-text">{props.viewBanner}</span>
          {props.onClearView && (
            <antd.Button
              type="text"
              size="small"
              className="jm-composer-view-clear"
              aria-label={t('回到全部渠道')}
              icon={<icons.CloseOutlined />}
              onClick={props.onClearView}
            />
          )}
        </div>
      )}
      {props.reply && (
        //M 展示当前待回复消息的渠道、脱敏发言人和摘要，方便发送前确认上下文。
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
            //M 已通过 /会话 指定直达目标时，展示脱敏后的会话标题标签及取消按钮。
            <span className="jm-chip jm-chip-target">
              <icons.MessageOutlined /> {t('发给会话「{title}」', { title: privacy.name(target.title, masked) })}
              <button type="button" aria-label={t('不指定会话')} onClick={() => setTarget(null)}>
                <icons.CloseOutlined />
              </button>
            </span>
          )}
          {tags.map((tag) => {
            let tagIcon = <icons.FileOutlined />;
            if (tag.kind === 'dir') {
              tagIcon = <icons.FolderOutlined />;
            }
            //M 渲染工作区文件标签，按隐私开关对完整路径与标签名脱敏并绑定移除事件。
            return (
              <span key={tag.path} className="jm-chip" title={privacy.text(tag.path, masked)}>
                {tagIcon}
                <span className="jm-chip-name">{privacy.name(tag.label, masked)}</span>
                <button type="button" aria-label={t('去掉标签 {name}', { name: privacy.name(tag.label, masked) })} onClick={() => removeWorkspaceTag(tag.path)}>
                  <icons.CloseOutlined />
                </button>
              </span>
            );
          })}
          {attachments.items.map((item) => {
            let chipClass = 'jm-chip';
            if (item.error) {
              chipClass = 'jm-chip jm-chip-error';
            }
            let preview: react.JSX.Element = <icons.PaperClipOutlined />;
            if (!masked && item.preview) {
              preview = <img src={item.preview} alt="" />;
            }
            //M 格式化附件大小作为标签元信息，上传失败时改显示错误提示。
            let metaText = attachmentsModule.formatSize(item.size);
            if (item.error) {
              metaText = t('没传上');
            }
            //M 渲染附件预览标签、脱敏后的文件名/报错和删除按钮，传完前显示上传进度。
            return (
              <span key={item.key} className={chipClass} title={privacy.text(item.error ?? item.name, masked)}>
                {preview}
                <span className="jm-chip-name">{privacy.name(item.name, masked)}</span>
                <span className="jm-muted">{metaText}</span>
                {!item.uploadId && !item.error && <span className="jm-chip-progress">{Math.round(item.progress * 100)}%</span>}
                <button type="button" aria-label={t('删掉 {name}', { name: privacy.name(item.name, masked) })} onClick={() => attachments.remove(item.key)}>
                  <icons.CloseOutlined />
                </button>
              </span>
            );
          })}
        </div>
      )}
      <div className="jm-composer-box">
        <antd.Button
          type="text"
          icon={<icons.PaperClipOutlined />}
          aria-label={t('选文件')}
          //M 点击回形针触发隐藏文件选择器，供用户主动挑选附件上传。
          onClick={() => pickFiles()}
        />
        {hideDraft && (
          //M 打码开启且草稿含引用块时遮蔽富文本区，避免泄露原引用内容并提供一键清空。
          <div className="jm-muted">
            {privacy.text('引用草稿', true)} <button type="button" onClick={clearAll}>{t('清空')}</button>
          </div>
        )}
        {!hideDraft && (
          <tiptapReact.EditorContent
            editor={editor}
            className="jm-editor-wrap"
            onScroll={(event) => event.currentTarget.toggleAttribute('data-scrolled', event.currentTarget.scrollTop > 0)}
          />
        )}
        {front !== undefined && chatModels.length > 0 && (
          <antd.Select
            className="jm-composer-model"
            size="small"
            popupMatchSelectWidth={MODEL_POPUP_WIDTH}
            value={front.model}
            title={t('默认模型：前台对话和新开的后台会话都用它')}
            options={chatModels.map((item) => ({ value: item.id, label: item.name || item.id }))}
            onChange={changeModel}
          />
        )}
        <antd.Button type="primary" icon={<icons.SendOutlined />} aria-label={t('发送（Enter）')} loading={sending} disabled={!props.online || hideDraft} onClick={send} />
      </div>
      {
        //M 存在校验或发送提示时，按隐私开关脱敏后渲染到输入框底部提示条。
        notice && <div className="jm-composer-notice">{privacy.text(notice, masked)}</div>
      }
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          //M 把选中的文件送入上传队列，并重置 input.value 以便下次继续选同一文件。
          attachments.add([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
      <antd.Modal open={choosing === 'session'} title={t('这条发给哪个会话（不分派）')} footer={null} onCancel={() => setChoosing(null)}>
        <div className="jm-pick-list" ref={setPickScroller}>
          {sessionList.length === 0 && <div className="jm-muted">{t('还没有会话')}</div>}
          {/* //M 会话不限量：虚拟滚动，借 .jm-pick-list 自己限高滚动，会话少时弹窗照旧矮。 */}
          {sessionList.length > 0 && pickScroller && (
            <virtuoso.Virtuoso
              customScrollParent={pickScroller}
              data={sessionList}
              computeItemKey={(_index, session) => session.id}
              itemContent={(_index, session) => {
                let statusText = t('空闲');
                if (session.status === 'running') {
                  statusText = t('运行中');
                }
                return (
                  <div className="jm-pick-row">
                    <button
                      type="button"
                      className="jm-pick-item"
                      onClick={() => {
                        setTarget(session);
                        setChoosing(null);
                        editor.commands.focus();
                      }}
                    >
                      <span>{
                        //M 展示可选会话标题时按当前隐私开关脱敏。
                        privacy.name(session.title, masked)
                      }</span>
                      <span className="jm-muted">
                        {
                          //M 展示会话工作区路径时按隐私开关脱敏，并拼接当前运行状态。
                          privacy.text(session.workspace, masked)
                        } · {statusText}
                      </span>
                    </button>
                  </div>
                );
              }}
            />
          )}
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
                //M 切换当前聊天机器人并关闭机器人选择弹窗。
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
