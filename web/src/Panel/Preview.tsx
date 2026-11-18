/**
 * 右栏的“预览”（docs/界面/01_界面设计.md 第 9 节）：选中什么看什么。
 *   图片：直接显示，点一下在“适应宽度”和“原图大小”之间切。
 *   Markdown：默认渲染，能切原文；工作区里的会话 md 每 2 秒刷新（运行中的会话一直在写）。
 *   代码、JSON、纯文字：按最多 1MB 分段继续阅读，不积累全文。PDF：内嵌显示。音频、视频：播放器。
 *   别的：文件名、大小、路径，能下载。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as attachments from '../Chat/Attachments.ts';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';
import * as kinds from './PreviewKind.ts';
import * as context from '../Context.ts';
import * as documentModule from './Document.ts';
import * as documentView from './DocumentView.tsx';
import * as readingModule from './Reading.ts';
import * as vscodeLink from '../VscodeLink.tsx';
import type * as types from '../Types.ts';
import type * as storeModule from '../Store.ts';


/** 当前文件段的本地加载状态，不放进全局历史。 */
interface FileLoadState {
  /** path + offset 的读取身份，避免 effect 开始前短暂显示旧内容。 */
  key: string;
  /** 只保留当前段，加载下一段时清除。 */
  page: api.FileTextPage | null;
  /** 当前目标的读取错误；旧请求错误不回写。 */
  error: string;
  /** 当前段是否仍在读取。 */
  loading: boolean;
}


/** 读取当前一段；会话刷新仍只取本段，不偷偷下载整个文件。 */
function useFileText(path: string, live: boolean, offset: number): FileLoadState {
  const key = `${path}:${String(offset)}`;
  //M 缓存分段文件加载器，限定每次拉取字节上限并支持取消旧请求。
  const loader = react.useMemo(() => new api.FilePreviewLoader(kinds.MAX_TEXT_BYTES), []);
  const [state, setState] = react.useState<FileLoadState>({ key: '', page: null, error: '', loading: true });
  react.useEffect(() => {
    /** 停了没有。 */
    let stopped = false;
    /** 下一次的定时器。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 读一次。 */
    const load = async (): Promise<void> => {
      try {
        /** 内容。 */
        //M 按路径和起始偏移异步拉取这一分段正文，避免整份读取大文件。
        const page = await loader.read(path, offset);
        if (!stopped && page) {
          setState({ key, page, error: '', loading: false });
        }
      } catch (error) {
        if (!stopped) {
          let message = String(error);
          if (error instanceof Error) {
            message = error.message;
          }
          setState((old) => ({ ...old, error: message, loading: false }));
        }
      }
      if (live && !stopped) {
        //M 运行中的会话文档需要定时拉取当前段最新追加的内容。
        timer = setTimeout(() => void load(), kinds.LIVE_REFRESH_MS);
      }
    };
    //M 重置本地加载态并立即触发首次分段读取。
    setState({ key, page: null, error: '', loading: true });
    void load();
    return () => {
      stopped = true;
      //M 卸载或切换分段时中止进行中的请求并清理定时器。
      loader.cancel();
      clearTimeout(timer);
    };
  }, [path, live, offset, key, loader]);
  if (state.key === key) return state;

  return { key, page: null, error: '', loading: true };
}


/**
 * 文字类的预览（Markdown、代码、纯文字）。
 * @param props target 要看的；asMarkdown 按 Markdown 渲染。
 */
function TextPreview(props: { target: storeModule.PanelTarget; asMarkdown: boolean }): react.JSX.Element {
  //M 订阅翻译函数、面板打开动作及当前历史条目的阅读状态。
  const t = i18n.useT();
  const openPanel = context.useUi((state) => state.openPanel);
  const { reading, saveReading } = readingModule.useReadingState();

  //M 按目标路径与偏移分段加载文本内容，并按文件生成对应的结构阅读器。
  const file = useFileText(props.target.path, kinds.isLive(props.target.path), reading.pageOffset);
  const reader = react.useMemo(() => new documentModule.DocumentReader(), [props.target.path]);
  const scroll = react.useRef<HTMLDivElement>(null);
  const page = file.page;
  const document = react.useMemo(() => {
    if (!page || !props.asMarkdown) return null;

    //M 仅在 Markdown 模式下解析当前分段的章节树与代码块边界。
    return reader.read(page.text, page.start, page.nextOffset);
  }, [reader, page, props.asMarkdown]);
  //M 在当前分段文本加载完毕后接管滚动位置恢复与保存。
  readingModule.useReadingScroll(scroll, !file.loading && page !== null);

  const openFile = (target: storeModule.PanelTarget): void => {
    //M 把文档内引用目标解析成可预览的绝对路径，合法时在右栏打开。
    const path = kinds.getDocumentLink(props.target.path, target.path);
    if (path) {
      openPanel('preview', { path, name: target.name || attachments.getBaseName(path) });
    }
  };
  const openLink = (href: string): boolean => {
    //M 把 Markdown 链接解析为本地文件路径，合法时转交预览面板并拦截跳转。
    const path = kinds.getDocumentLink(props.target.path, href);
    if (!path) {
      return false;
    }
    //M 将解析出的本地文件路径交给预览面板打开，并拦截默认链接跳转。
    openPanel('preview', { path, name: attachments.getBaseName(path) });
    return true;
  };
  const changePage = (offset: number): void => {
    saveReading({ pageOffset: offset, scrollTop: 0, section: '' });
  };
  let viewMode = 'rendered';
  if (reading.raw) {
    viewMode = 'raw';
  }
  let totalText = t('总大小未记录');
  if (page && page.total !== null) {
    //M 有记录文件总字节数时格式化成易读单位展示在分页栏。
    totalText = attachments.formatSize(page.total);
  }
  let renderedText: react.ReactNode = null;
  if (!file.loading && page) {
    renderedText = <pre className="jm-preview-code">{page.text}</pre>;
    if (props.asMarkdown && !reading.raw && document) {
      renderedText = <documentView.DocumentView page={document} onOpen={openFile} onLink={openLink} />;
    }
  }

  return (
    <div className="jm-preview-text jm-reader-text">
      <div className="jm-reader-tools">
        {props.asMarkdown && <antd.Segmented
          size="small"
          value={viewMode}
          options={[{ value: 'rendered', label: t('阅读') }, { value: 'raw', label: t('原文') }]}
          onChange={(value) => saveReading({ raw: value === 'raw' })}
        />}
        {
          //M 若属于持续写入的会话文档，提示用户页面每 2 秒自动刷新。
          kinds.isLive(props.target.path) && <span className="jm-muted">{t('每 2 秒刷新')}</span>
        }
      </div>
      <div className="jm-reader-pages" aria-label={t('文件分段阅读')}>
        <button
          //M 跳回偏移 0，从文件最开头重新阅读。
          type="button"
          disabled={reading.pageOffset === 0}
          onClick={() => changePage(0)}>{t('回开头')}</button>
        <button
          //M 按单段上限回退偏移并切换至上一段内容。
          type="button" disabled={reading.pageOffset === 0 || file.loading}
          onClick={() => changePage(Math.max(0, (page?.start ?? reading.pageOffset) - kinds.MAX_TEXT_BYTES))}>
          {t('上一段')}
        </button>
        <button type="button" disabled={file.loading || page?.nextOffset === null || !page}
          onClick={() => {
            if (page?.nextOffset !== null && page) {
              //M 存在后续分段时跳转到下一段起始偏移。
              changePage(page.nextOffset);
            }
          }}>
          {t('下一段')}
        </button>
        {page && <span className="jm-muted">
          {t('当前片段 {start}–{end} / {total}', {
            //M 把当前段的起止字节偏移格式化为易读大小用于分页显示。
            start: attachments.formatSize(page.start),
            end: attachments.formatSize(page.end),
            total: totalText,
          })}
        </span>}
      </div>
      <div className="jm-reader-scroll" ref={scroll}>
        {file.loading && <antd.Spin className="jm-preview-spin" />}
        {file.error && <div className="jm-empty">{file.error}</div>}
        {renderedText}
      </div>
    </div>
  );
}


/** 右栏没选东西时列几个最近的附件。 */
const RECENT_FILES = 12;


/** 没选东西时：最近的附件（这个机器人最近消息和回复里的），点一下就预览（docs/界面/04_空白处的功能.md）。 */
function RecentFiles(): react.JSX.Element {
  //M 获取翻译函数，用于空态说明和近期附件列表标题。
  const t = i18n.useT();
  /** 正在看的机器人。 */
  //M 订阅当前选中的机器人与打开预览面板回调。
  const bot = context.useUi((state) => state.currentBot);
  const openPanel = context.useUi((state) => state.openPanel);
  /** 最近的附件。 */
  const [files, setFiles] = react.useState<types.Attachment[]>([]);
  react.useEffect(() => {
    if (!bot) {
      return undefined;
    }
    /** 停了没有。 */
    let stopped = false;
    //M 拉取当前机器人最近 40 条消息与回复，去重筛选出仍存在的附件。
    void api.messages(bot, { limit: 40 }).then(
      (page) => {
        /** 新的在前，同一个文件只留一次，文件不在了的不要。 */
        const seen = new Set<string>();
        /** 找到的。 */
        const found: types.Attachment[] = [];
        for (const message of [...page.messages].reverse()) {
          for (const item of [...message.replies.flatMap((reply) => reply.attachments).reverse(), ...message.attachments]) {
            if (item.size !== null && !seen.has(item.path)) {
              seen.add(item.path);
              found.push(item);
            }
          }
        }
        if (!stopped) {
          setFiles(found.slice(0, RECENT_FILES));
        }
      },
      () => undefined,
    );
    return () => {
      stopped = true;
    };
  }, [bot]);
  //M 渲染空白引导提示与近期附件按钮列表，显示格式化后的文件大小。
  return (
    <div className="jm-recent-files">
      <div className="jm-muted">{t('点时间线里的附件、事件，或者工作区里的文件来看')}</div>
      {files.length > 0 && <div className="jm-recent-head">{t('最近的附件')}</div>}
      {files.map((item) => (
        <button key={item.path} type="button" className="jm-recent-file" title={item.path} onClick={() => openPanel('preview', { path: item.path, name: item.name })}>
          <span className="jm-recent-name">{item.name}</span>
          <span className="jm-muted">{attachments.formatSize(item.size)}</span>
        </button>
      ))}
    </div>
  );
}


/** 按文件种类生成对应的预览内容。 */
function renderPreviewBody(
  kind: ReturnType<typeof kinds.getPreviewKind>,
  target: storeModule.PanelTarget,
  url: string,
  reading: readingModule.ReadingState['reading'],
  saveReading: readingModule.ReadingState['saveReading'],
  t: i18n.Translate,
): react.ReactNode {
  if (kind === 'image') {
    let imageClass = 'jm-preview-image';
    if (reading.imageActualSize) {
      imageClass = 'jm-preview-image jm-actual';
    }
    return (
      <button
        type="button"
        className={imageClass}
        onClick={() => saveReading({ imageActualSize: !reading.imageActualSize })}
        title={t('点一下切换原图大小')}
      >
        <img src={url} alt={target.name} />
      </button>
    );
  }
  if (kind === 'markdown' || kind === 'text') {
    return <TextPreview key={target.path} target={target} asMarkdown={kind === 'markdown'} />;
  }
  if (kind === 'pdf') return <iframe className="jm-preview-pdf" src={url} title={target.name} />;

  if (kind === 'audio') return <audio className="jm-preview-media" controls src={url} />;

  if (kind === 'video') return <video className="jm-preview-media" controls src={url} />;

  return (
    <dl className="jm-preview-facts">
      <dt>{t('名字')}</dt>
      <dd>{target.name}</dd>
      <dt>{t('路径')}</dt>
      <dd><vscodeLink.SiteLink site={target.path} /></dd>
      <dt>{t('怎么看')}</dt>
      <dd>{t('这种文件不能直接预览，点上面的“下载”')}</dd>
    </dl>
  );
}


/**
 * 预览。
 * @param props target 要看的东西；还没选时是 null（这时列最近的附件）。
 * @returns 文件预览视图或近期附件列表元素。
 * 副作用：按文件类型挂载文本/媒体子组件并同步容器滚动与图片尺寸阅读状态。
 */
export function Preview(props: { target: storeModule.PanelTarget | null }): react.JSX.Element {
  //M 获取翻译函数与演示打码开关，供预览标题与脱敏门控使用。
  const t = i18n.useT();
  const masked = privacy.useMask();
  /** 图片看原图大小还是适应宽度。 */
  //M 读取当前历史条目的轻量阅读状态及保存动作。
  const { reading, saveReading } = readingModule.useReadingState();
  const scroll = react.useRef<HTMLDivElement>(null);
  let kind: ReturnType<typeof kinds.getPreviewKind> = 'other';
  if (props.target) {
    //M 按文件路径扩展名识别预览类型，用于决定渲染方式与滚动归属。
    kind = kinds.getPreviewKind(props.target.path);
  }
  //M 非分段文本类型直接由外层容器接管滚动位置恢复与保存。
  readingModule.useReadingScroll(scroll, props.target !== null && kind !== 'markdown' && kind !== 'text');
  //G 文件来源未携带渠道；打码时不挂载正文、媒体或下载链接。
  if (masked) return <div className="jm-empty">{privacy.text('文件预览', true)}</div>;

  if (!props.target) {
    return <RecentFiles />;
  }
  /** 要看的。 */
  const target = props.target;
  /** 文件地址。 */
  //M 生成带访问令牌的文件下载与媒体访问 URL。
  const url = api.getFileUrl(target.path);
  /** 文件名一行。 */
  const title = (
    <div className="jm-preview-title" title={target.path}>
      <span className="jm-preview-name">{target.name}</span>
      <vscodeLink.VsCodeOpen site={target.path} />
      <a
        //M 从完整路径提取纯文件名作为浏览器下载时的默认文件名。
        className="jm-muted"
        href={url}
        download={attachments.getBaseName(target.path)}>
        {t('下载')}
      </a>
    </div>
  );
  /** 正文。 */
  //M 根据文件类型生成对应正文预览元素。
  const body = renderPreviewBody(kind, target, url, reading, saveReading, t);
  return (
    <div className="jm-preview jm-reader-preview" ref={scroll}>
      {title}
      {body}
    </div>
  );
}
