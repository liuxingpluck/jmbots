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
import * as kinds from './PreviewKind.ts';
import * as context from '../Context.ts';
import * as documentModule from './Document.ts';
import * as documentView from './DocumentView.tsx';
import * as readingModule from './Reading.ts';
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
        const page = await loader.read(path, offset);
        if (!stopped && page) {
          setState({ key, page, error: '', loading: false });
        }
      } catch (error) {
        if (!stopped) {
          setState((old) => ({ ...old, error: error instanceof Error ? error.message : String(error), loading: false }));
        }
      }
      if (live && !stopped) {
        timer = setTimeout(() => void load(), kinds.LIVE_REFRESH_MS);
      }
    };
    setState({ key, page: null, error: '', loading: true });
    void load();
    return () => {
      stopped = true;
      loader.cancel();
      clearTimeout(timer);
    };
  }, [path, live, offset, key, loader]);
  return state.key === key ? state : { key, page: null, error: '', loading: true };
}


/**
 * 文字类的预览（Markdown、代码、纯文字）。
 * @param props target 要看的；asMarkdown 按 Markdown 渲染。
 */
function TextPreview(props: { target: storeModule.PanelTarget; asMarkdown: boolean }): react.JSX.Element {
  const t = i18n.useT();
  const openPanel = context.useUi((state) => state.openPanel);
  const { reading, saveReading } = readingModule.useReadingState();
  const file = useFileText(props.target.path, kinds.isLive(props.target.path), reading.pageOffset);
  const reader = react.useMemo(() => new documentModule.DocumentReader(), [props.target.path]);
  const scroll = react.useRef<HTMLDivElement>(null);
  const page = file.page;
  const document = react.useMemo(() => {
    return page && props.asMarkdown ? reader.read(page.text, page.start, page.nextOffset) : null;
  }, [reader, page, props.asMarkdown]);
  readingModule.useReadingScroll(scroll, !file.loading && page !== null);

  const openFile = (target: storeModule.PanelTarget): void => {
    const path = kinds.documentLink(props.target.path, target.path);
    if (path) {
      openPanel('preview', { path, name: target.name || attachments.baseName(path) });
    }
  };
  const openLink = (href: string): boolean => {
    const path = kinds.documentLink(props.target.path, href);
    if (!path) {
      return false;
    }
    openPanel('preview', { path, name: attachments.baseName(path) });
    return true;
  };
  const changePage = (offset: number): void => {
    saveReading({ pageOffset: offset, scrollTop: 0, section: '' });
  };

  return (
    <div className="jm-preview-text jm-reader-text">
      <div className="jm-reader-tools">
        {props.asMarkdown && <antd.Segmented
          size="small"
          value={reading.raw ? 'raw' : 'rendered'}
          options={[{ value: 'rendered', label: t('阅读') }, { value: 'raw', label: t('原文') }]}
          onChange={(value) => saveReading({ raw: value === 'raw' })}
        />}
        {kinds.isLive(props.target.path) && <span className="jm-muted">{t('每 2 秒刷新')}</span>}
      </div>
      <div className="jm-reader-pages" aria-label={t('文件分段阅读')}>
        <button type="button" disabled={reading.pageOffset === 0} onClick={() => changePage(0)}>{t('回开头')}</button>
        <button type="button" disabled={reading.pageOffset === 0 || file.loading}
          onClick={() => changePage(Math.max(0, (page?.start ?? reading.pageOffset) - kinds.MAX_TEXT_BYTES))}>
          {t('上一段')}
        </button>
        <button type="button" disabled={file.loading || page?.nextOffset === null || !page}
          onClick={() => {
            if (page?.nextOffset !== null && page) {
              changePage(page.nextOffset);
            }
          }}>
          {t('下一段')}
        </button>
        {page && <span className="jm-muted">
          {t('当前片段 {start}–{end} / {total}', {
            start: attachments.formatSize(page.start),
            end: attachments.formatSize(page.end),
            total: page.total === null ? t('总大小未记录') : attachments.formatSize(page.total),
          })}
        </span>}
      </div>
      <div className="jm-reader-scroll" ref={scroll}>
        {file.loading && <antd.Spin className="jm-preview-spin" />}
        {file.error && <div className="jm-empty">{file.error}</div>}
        {!file.loading && page && (
          props.asMarkdown && !reading.raw && document
            ? <documentView.DocumentView page={document} onOpen={openFile} onLink={openLink} />
            : <pre className="jm-preview-code">{page.text}</pre>
        )}
      </div>
    </div>
  );
}


/** 右栏没选东西时列几个最近的附件。 */
const RECENT_FILES = 12;


/** 没选东西时：最近的附件（这个机器人最近消息和回复里的），点一下就预览（docs/界面/04_空白处的功能.md）。 */
function RecentFiles(): react.JSX.Element {
  const t = i18n.useT();
  /** 正在看的机器人。 */
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


/**
 * 预览。
 * @param props target 要看的东西；还没选时是 null（这时列最近的附件）。
 */
export function Preview(props: { target: storeModule.PanelTarget | null }): react.JSX.Element {
  const t = i18n.useT();
  /** 图片看原图大小还是适应宽度。 */
  const { reading, saveReading } = readingModule.useReadingState();
  const scroll = react.useRef<HTMLDivElement>(null);
  const kind = props.target ? kinds.previewKind(props.target.path) : 'other';
  readingModule.useReadingScroll(scroll, props.target !== null && kind !== 'markdown' && kind !== 'text');
  if (!props.target) {
    return <RecentFiles />;
  }
  /** 要看的。 */
  const target = props.target;
  /** 文件地址。 */
  const url = api.fileUrl(target.path);
  /** 样子。 */
  /** 文件名一行。 */
  const title = (
    <div className="jm-preview-title" title={target.path}>
      <span className="jm-preview-name">{target.name}</span>
      <a className="jm-muted" href={url} download={attachments.baseName(target.path)}>
        {t('下载')}
      </a>
    </div>
  );
  /** 正文。 */
  let body: react.ReactNode;
  if (kind === 'image') {
    body = (
      <button type="button" className={reading.imageActualSize ? 'jm-preview-image jm-actual' : 'jm-preview-image'}
        onClick={() => saveReading({ imageActualSize: !reading.imageActualSize })} title={t('点一下切换原图大小')}>
        <img src={url} alt={target.name} />
      </button>
    );
  } else if (kind === 'markdown' || kind === 'text') {
    body = <TextPreview key={target.path} target={target} asMarkdown={kind === 'markdown'} />;
  } else if (kind === 'pdf') {
    body = <iframe className="jm-preview-pdf" src={url} title={target.name} />;
  } else if (kind === 'audio') {
    body = <audio className="jm-preview-media" controls src={url} />;
  } else if (kind === 'video') {
    body = <video className="jm-preview-media" controls src={url} />;
  } else {
    body = (
      <dl className="jm-preview-facts">
        <dt>{t('名字')}</dt>
        <dd>{target.name}</dd>
        <dt>{t('路径')}</dt>
        <dd>{target.path}</dd>
        <dt>{t('怎么看')}</dt>
        <dd>{t('这种文件不能直接预览，点上面的“下载”')}</dd>
      </dl>
    );
  }
  return (
    <div className="jm-preview jm-reader-preview" ref={scroll}>
      {title}
      {body}
    </div>
  );
}
