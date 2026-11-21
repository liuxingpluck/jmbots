/**
 * 教程页里看代码、看变量的几块，几个地方共用（原来在 /flow/ 的 FlowPage 里，11-17 搬过来）：
 *   JsonBlock     一块 JSON（关键变量、运行时变量），能开合、能复制，键名后灰字跟中文解释，变了的键标黄；
 *   SourceToggle  “看实现”：点开才要这个函数的完整源码（SourceView），里面调到的函数能再点开；
 *   CallerList    “谁调它”：每处调用的位置、为什么调、那一行代码；
 *   VsCodeOpen    在 VS Code 里打开这一行。
 */
import { useContext, useEffect, useState, type CSSProperties, type JSX, type ReactNode } from 'react';
import JsonView from '@uiw/react-json-view';
import { darkTheme } from '@uiw/react-json-view/dark';
import { lightTheme } from '@uiw/react-json-view/light';
import * as virtuoso from 'react-virtuoso';
import * as theme from '../ThemePalette.ts';
import {
  SiteLink,
  TutorialWorkspaceContext,
  VsCodeOpen,
  getSiteParts,
  getVscodeHref,
} from '../VscodeLink.tsx';
import { TutorialApi, type FunctionSource } from './TutorialApi.ts';
import {
  CODE_VIRTUAL_LINES,
  PATH_SEP,
  TutorialScrollContext,
  VIRTUAL_THRESHOLD,
} from './TutorialContext.tsx';


export {
  CODE_VIRTUAL_LINES,
  PATH_SEP,
  SiteLink,
  TutorialScrollContext,
  TutorialWorkspaceContext,
  VIRTUAL_THRESHOLD,
  VsCodeOpen,
  getSiteParts,
  getVscodeHref,
};


/** 单条函数调用处（与 FunctionSource.callers 项一致）。 */
type FunctionCaller = FunctionSource['callers'][number];

/**
 * 按当前主题挑 JSON 树的配色，底色透明（用外面 .tu-json 的底）。
 */
function getJsonStyle(): CSSProperties {
  //M 深色、科技主题用库自带深色配色，浅色、护眼用亮色配色。
  const name = theme.loadThemeName(window.localStorage);
  const spec = theme.THEMES[name];
  let base = lightTheme;
  if (spec.dark) {
    base = darkTheme;
  }
  return {
    ...base,
    '--w-rjv-background-color': 'transparent',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
  } as CSSProperties;
}


/**
 * 复制到剪贴板，结果用一句话交回按钮。不是 https 也不是本机时浏览器不给用剪贴板，提示手动选中。
 * @param text 要复制的。
 * @param said 按钮上换成的那句话。
 */
export function copyText(text: string, said: (word: string) => void): void {
  if (!window.isSecureContext) {
    said('浏览器不让复制，请手动选中');
    return;
  }
  const done = navigator.clipboard.writeText(text);
  void done.then(() => said('已复制'), () => said('复制失败，请手动选中'));
}


/**
 * 一个键在整个值里的路径（和后端 getDiff 给的一样，一串键名）。
 * @param keys 库给的路径：有的版本含这个键自己，有的只到上一层，最后一个不是它就补上。
 * @param keyName 这个键。
 */
function getKeyPath(keys: readonly (string | number)[] | undefined, keyName: string | number | undefined): string[] {
  const path = (keys ?? []).map(String);
  if (keyName === undefined) return path;

  //M 当前键可能已经在库返回的路径末尾。
  const key = String(keyName);
  if (path.at(-1) !== key) {
    path.push(key);
  }
  return path;
}


/**
 * 一块 JSON（@uiw/react-json-view）：默认展开前两层，节点能开合、能复制；顶上“复制全部”复制整块。
 * 键名有中文解释的后面灰字跟 // 解释（只是显示，复制的还是纯 JSON）；变了的键标黄。调试用，全量原样，不打码、不截断。
 * @param props.head 复制按钮左边的标题。
 * @param props.value 要显示的值；undefined 显示 empty；不是对象、数组的直接显示。
 * @param props.empty 没有值时的一句话。
 * @param props.marks 变了的路径（一串键名用 PATH_SEP 连起来）；不给就不标。
 * @param props.notes 键的中文解释。
 */
export function JsonBlock(props: {
  head: ReactNode;
  value: unknown;
  empty: string;
  marks?: Set<string>;
  notes?: Record<string, string>;
}): JSX.Element {
  const { value } = props;
  const [copied, setCopied] = useState('复制全部');
  let json = '';
  if (value !== undefined) {
    json = JSON.stringify(value, null, 2);
  }
  const marks = props.marks ?? new Set<string>();
  //M 用 Map 查：JSON 里有叫 constructor、toString 的键时，不会查到对象原型上的东西。
  const notes = new Map(Object.entries(props.notes ?? {}));

  //M 正文：先按非对象简单值兜底，是对象或数组再换成 JsonView；没有值写 empty。
  const isObject = typeof value === 'object' && value !== null;
  let body: ReactNode = <p className="tu-muted">{props.empty}</p>;
  if (value !== undefined && !isObject) {
    body = <pre className="tu-json">{json}</pre>;
  }
  if (isObject) {
    const jsonStyle = getJsonStyle();
    body = (
      <div className="tu-json">
        <JsonView value={value} style={jsonStyle} collapsed={2} displayDataTypes={false} shortenTextAfterLength={0}>
          {/* 键名不带引号：解释跟在键名后面，带引号会夹在引号里。 */}
          <JsonView.Quote render={() => <span />} />
          {/* 键名：有解释或变了才自己画，别的返回 undefined 交回库默认的。 */}
          <JsonView.KeyName<'span'>
            render={(attrs, result) => {
              const { keys, keyName } = result;
              let name = '';
              if (keyName !== undefined) {
                name = String(keyName);
              }
              //M 计算当前键的完整路径标识，以便对齐后端 diff 与中文解释映射表。
              const path = getKeyPath(keys, keyName);
              const keyPath = path.join(PATH_SEP);
              const mark = marks.has(keyPath);
              const note = notes.get(name);
              if (!mark && note === undefined) return undefined;

              let className = attrs.className;
              if (mark) {
                className = `${attrs.className ?? ''} tu-changed`;
              }
              return (
                <>
                  <span {...attrs} className={className}>{name}</span>
                  {note !== undefined && <span className="tu-json-note">{` // ${note}`}</span>}
                </>
              );
            }}
          />
        </JsonView>
      </div>
    );
  }

  return (
    <>
      <div className="tu-head-row">
        {props.head}
        {json !== '' && (
          <button
            type="button"
            className="tu-link"
            onClick={
              //M 点击后把格式化好的完整变量 JSON 文本复制到剪贴板，并在按钮上显示结果。
              () => copyText(json, setCopied)
            }
          >
            {copied}
          </button>
        )}
      </div>
      {body}
    </>
  );
}


/**
 * “看实现”：默认收起，点开才向后端要这个函数的完整源码（SourceView）。
 * @param props.site 文件:行号：定义那一行，或函数里面任意一行（后端往上找它所在的函数）；没有行号不显示。
 * @param props.label 按钮上的字；不给是“看实现”。
 */
export function SourceToggle(props: { site: string; label?: string }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  //M 拆出位置里的文件路径与起始行号，格式非法则不渲染源码开关。
  const parts = getSiteParts(props.site);
  if (parts === undefined) return null;

  //M 按钮上的字：开着是“收起 …”，关着是 label 或“看实现”。
  let word = props.label ?? '看实现';
  if (open) {
    word = `收起 ${props.label ?? '实现'}`;
  }
  return (
    <div className="tu-src">
      <button type="button" className="tu-link" onClick={() => setOpen(!open)}>{word}</button>
      {open && <SourceView file={parts.file} line={parts.line} />}
    </div>
  );
}


/**
 * 一条调用处展示内容：位置直接点开 VS Code，旁边可展开看源码，附为什么注释与代码行。
 * @param caller 调用信息。
 */
function CallerEntryContent(caller: FunctionCaller): JSX.Element {
  return (
    <>
      <div className="tu-site">
        <SiteLink site={caller.site} />
        <SourceToggle site={caller.site} label="看调用段" />
      </div>
      {caller.why === '' && <span className="tu-caller-why tu-error">调用处没写注释</span>}
      {caller.why !== '' && <span className="tu-caller-why">为什么：{caller.why}</span>}
      <code className="tu-signature">{caller.code}</code>
    </>
  );
}


/**
 * “谁调它”：向后端要这个函数的 callers，每处调用列出位置（点开看那一段、或直开 VS Code）、为什么调、那一行代码。
 * 调用处上方没写 //M 的标“调用处没写注释”；超过 30 处且存在外层滚动父容器时切换为虚拟滚动。
 * @param props.site 文件:行号；没有行号不显示。
 */
export function CallerList(props: { site: string }): JSX.Element | null {
  const [source, setSource] = useState<FunctionSource | null>(null);
  const [error, setError] = useState('');
  const scrollParent = useContext(TutorialScrollContext);
  //M 解析目标位置中的文件路径与行号以请求后端“谁调它”列表。
  const parts = getSiteParts(props.site);
  const file = parts?.file ?? '';
  const line = parts?.line ?? 0;

  useEffect(() => {
    if (file === '') return;

    const query = `file=${encodeURIComponent(file)}&line=${String(line)}`;
    //M 按文件与行号向 tutorial 后端查询函数定义体及全项目所有调用方。
    const loading = TutorialApi.get<FunctionSource>(`/api/tutorial/source?${query}`);
    loading.then(setSource, (failed: unknown) => setError(String(failed)));
  }, [file, line]);

  if (parts === undefined) return null;
  if (error !== '') return <p className="tu-error">取不到谁调它：{error}</p>;
  if (source === null) return <p className="tu-muted">正在找谁调它…</p>;
  if (source.name === '') return null;
  if (source.callers.length === 0) return <p className="tu-muted">谁调它：后端源码里没找到调用处（可能是事件回调、Cordis 调的）。</p>;

  const useVirtual = source.callers.length >= VIRTUAL_THRESHOLD && scrollParent !== null;
  return (
    <div className="tu-callers">
      <p className="tu-muted">谁调它（{source.callers.length} 处）：</p>
      {useVirtual && (
        <div className="tu-caller-virt">
          <virtuoso.Virtuoso
            customScrollParent={scrollParent}
            data={source.callers}
            computeItemKey={(_index, caller) => caller.site}
            itemContent={(_index, caller) => (
              <div className="tu-caller-row">
                {CallerEntryContent(caller)}
              </div>
            )}
          />
        </div>
      )}
      {!useVirtual && (
        <ul>
          {source.callers.map((caller) => (
            <li key={caller.site}>
              {CallerEntryContent(caller)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


/**
 * 一个函数的源码：等宽、带源文件里的真实行号（行号不进复制），顶上“复制”复制整段。
 * 里面调到的、后端找得到定义的函数名做成能点的，点了在下面再展开那个函数，再点收起。
 * @param props.file 文件（后端会从最后一个 src7/ 截起）。
 * @param props.line 第几行。
 */
export function SourceView(props: { file: string; line: number }): JSX.Element {
  const { file, line } = props;
  const [source, setSource] = useState<FunctionSource | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('复制');
  /** 点开的被调函数：名字和“文件:行号”，照点开的先后。 */
  const [opened, setOpened] = useState<{ name: string; site: string }[]>([]);
  const scrollParent = useContext(TutorialScrollContext);

  useEffect(() => {
    const query = `file=${encodeURIComponent(file)}&line=${String(line)}`;
    //M 按文件与行号请求后端截取所属完整函数体与可跳转内部调用清单。
    const loading = TutorialApi.get<FunctionSource>(`/api/tutorial/source?${query}`);
    loading.then(setSource, (failed: unknown) => setError(String(failed)));
  }, [file, line]);

  if (error !== '') return <p className="tu-error">取不到源码：{error}</p>;
  if (source === null) return <p className="tu-muted">正在取源码…</p>;

  //M 被调函数名：拼成一个正则把每行切开，切出来的名字（奇数下标）做成按钮。
  const sites = new Map(source.calls.map((call) => [call.name, call.site]));
  const names = source.calls.map((call) => call.name.replaceAll('$', '\\$'));
  let pattern: RegExp | null = null;
  if (names.length > 0) {
    pattern = new RegExp(`(?<![\\w$])(${names.join('|')})(?=\\s*(?:<[^<>()]*>)?\\()`, 'u');
  }

  //M 点一个被调函数：开着就收起，没开就接在后面。
  const toggle = (name: string, site: string): void => {
    const has = opened.some((item) => item.site === site);
    if (has) {
      setOpened(opened.filter((item) => item.site !== site));
      return;
    }
    setOpened([...opened, { name, site }]);
  };

  //M 一行源码：被调函数名换成按钮。
  const getLineView = (text: string): ReactNode => {
    if (pattern === null) return text;

    return text.split(pattern).map((part, index) => {
      const site = sites.get(part);
      if (index % 2 === 0 || site === undefined) return part;

      return (
        <button
          key={index}
          type="button"
          className="tu-code-call"
          title={site}
          onClick={
            //M 点击源码行里的函数调用名，切换下方嵌套源码视图的展开与收起。
            () => toggle(part, site)
          }
        >
          {part}
        </button>
      );
    });
  };

  //M 一行源码：行号加正文；虚拟滚动和普通渲染共用这一份。
  const getCodeLine = (text: string, index: number): JSX.Element => (
    <div key={index} className="tu-code-line">
      <span className="tu-code-no">{source.start + index}</span>
      <span>{
        //M 渲染单行源码并将匹配到的内部函数调用切为可点击按钮。
        getLineView(text)
      }</span>
    </div>
  );

  //M 长函数借右栏的滚动容器虚拟滚动；没有右栏容器时给固定高度自己滚。
  const useVirtual = source.lines.length >= CODE_VIRTUAL_LINES;
  let frame: { customScrollParent?: HTMLElement; style?: CSSProperties } = { style: { height: 480 } };
  if (scrollParent !== null) {
    frame = { customScrollParent: scrollParent };
  }

  return (
    <div className="tu-code-box">
      <div className="tu-head-row">
        <span className="tu-muted tu-site">
          <SiteLink
            site={`${source.file}:${String(source.start)}`}
            label={`${source.file}:${String(source.start)}–${String(source.end)}`}
          />
          {source.cut && '（没找到函数结尾，只给了这几行）'}
        </span>
        <button
          type="button"
          className="tu-link"
          onClick={
            //M 点击复制当前函数全部源码行文本到剪贴板。
            () => copyText(source.lines.join('\n'), setCopied)
          }
        >
          {copied}
        </button>
      </div>
      <pre className="tu-code">
        {useVirtual && (
          <virtuoso.Virtuoso
            {...frame}
            data={source.lines}
            computeItemKey={(index) => index}
            itemContent={(index, text) => getCodeLine(text, index)}
          />
        )}
        {!useVirtual && source.lines.map(getCodeLine)}
      </pre>
      {opened.map((item) => {
        //M 解析已点开被调函数的定位，并在嵌套卡片里递归渲染其源码实现。
        const parts = getSiteParts(item.site);
        return (
          <div key={item.site} className="tu-code-nested">
            <div className="tu-head-row">
              <span className="tu-site-inline">
                <code>{item.name}</code>
                <SiteLink site={item.site} />
              </span>
              <button
                type="button"
                className="tu-link"
                onClick={
                  //M 点击收起已展开的子调用函数源码区块。
                  () => toggle(item.name, item.site)
                }
              >
                收起
              </button>
            </div>
            <SourceView file={parts?.file ?? ''} line={parts?.line ?? 0} />
          </div>
        );
      })}
    </div>
  );
}
