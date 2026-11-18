/**
 * 全站共用的「在 VS Code 里打开」组件与路径解析工具：
 *   - 支持源码相对路径（src7/、web/、local/、scripts/、tests/）：从 Context 或 GET /api/tutorial/plugins 的 workspace 拼接；
 *   - 教程插件未挂载或拿不到源码根时，源码相对路径退化成普通文本，不显示空/错误链接；
 *   - 运行时目录下的绝对路径（bots/...、F:/...、/home/...）与相对路径（传 runtimeRoot 或自动推算）直接拼 vscode://file/；
 *   - TextWithVscodeLinks 自动把工具参数 JSON、报错栈、文件路径字符串里的可用路径转为可点击链接。
 */
import { createContext, useContext, useEffect, useState, type JSX, type MouseEvent, type ReactNode } from 'react';
import * as sourceDirModule from '../../src7/utils/SourceDir.ts';
import { TOKEN, withToken } from './Token.ts';
import './VscodeLink.css';


/** 教程页或全局提供源码根目录的 React Context。 */
export const TutorialWorkspaceContext = createContext<string>('');

/** 同页复用的源码根目录缓存，避免每个组件重复请求 /api/tutorial/plugins。 */
let cachedWorkspace: string | null = null;
let workspacePromise: Promise<string> | null = null;

/** 同页复用的运行时根目录缓存（从 /api/bots + /api/ui/bots/:name 提取），供 bots/... 相对路径使用。 */
let cachedRuntimeRoot: string | null = null;
let runtimeRootPromise: Promise<string> | null = null;

/** 源码根目录下认得的顶层目录：后端源码根（src7/utils/SourceDir.ts 的 SOURCE_DIR）和网页、基地、脚本、测试。 */
const SOURCE_ROOTS = [sourceDirModule.SOURCE_DIR, 'web', 'local', 'scripts', 'tests'];

/** 上面几个目录名拼成的正则分支，如 src7|web|local|scripts|tests。 */
const SOURCE_ROOTS_GROUP = SOURCE_ROOTS.join('|');

/** 以上面几个目录之一开头的源码相对路径。 */
const SOURCE_RELATIVE_RE = new RegExp(`^(?:${SOURCE_ROOTS_GROUP})/`, 'u');

/** 文本里出现上面几个目录之一加斜杠（要源码根目录才能解析的相对路径标记）。 */
const SOURCE_MARK_RE = new RegExp(`(?:${SOURCE_ROOTS_GROUP})/`, 'u');

/** 路径的文件名部分：到空白、引号、括号、逗号、分号为止，可选附带 :行[:列]。 */
const PATH_BODY = /[^\s"'`<>()[\]{},;]+(?::\d+(?::\d+)?)?/u.source;

/** Windows 绝对路径开头（含 JSON 双反斜杠）。 */
const WINDOWS_HEAD = /[A-Za-z]:(?:\\\\|\\|\/)/u.source;

/** POSIX 绝对路径开头。 */
const POSIX_HEAD = /\/(?:home|opt|usr|var|mnt|root|app|Users|tmp)\//u.source;

/** 源码或 bots 相对路径开头。 */
const RELATIVE_HEAD = `(?:${SOURCE_ROOTS_GROUP}|bots)/`;

/** 文本内嵌路径匹配的正则原文：三种开头各自接文件名部分。 */
const INLINE_PATH_SOURCE = `(${WINDOWS_HEAD}${PATH_BODY}|${POSIX_HEAD}${PATH_BODY}|${RELATIVE_HEAD}${PATH_BODY})`;

/** 文本内嵌路径匹配：Windows 绝对路径（含 JSON 双反斜杠）、POSIX 绝对路径、源码或 bots 相对路径，可选附带 :行[:列]。 */
const INLINE_PATH_RE = new RegExp(INLINE_PATH_SOURCE, 'gu');


/**
 * 从任意浏览器页面按需读取源码根目录（只在页面内缓存并发复用一次；接口不存在或失败返回空串）。
 */
function fetchSourceWorkspaceOnce(): Promise<string> {
  if (cachedWorkspace !== null) return Promise.resolve(cachedWorkspace);

  if (workspacePromise !== null) return workspacePromise;

  if (typeof fetch !== 'function') return Promise.resolve('');

  //M 首次需要源码根时把令牌拼进路径并发起一次可复用的插件清单请求，合并同页并发调用。
  workspacePromise = fetch(withToken('/api/tutorial/plugins', TOKEN))
    .then(async (resp) => {
      if (!resp.ok) return '';

      const json = (await resp.json().catch(() => null)) as { workspace?: unknown } | null;
      if (json !== null && typeof json.workspace === 'string') return json.workspace;

      return '';
    })
    .catch(() => '')
    .then((ws) => {
      cachedWorkspace = ws;
      workspacePromise = null;
      return ws;
    });
  return workspacePromise;
}


/**
 * 从机器人接口按需读取运行时根目录（遇到不带盘符的 bots/... 路径时才调用一次）。
 */
function fetchRuntimeRootOnce(): Promise<string> {
  if (cachedRuntimeRoot !== null) return Promise.resolve(cachedRuntimeRoot);

  if (runtimeRootPromise !== null) return runtimeRootPromise;

  if (typeof fetch !== 'function') return Promise.resolve('');

  //M 遇到 bots/ 相对路径时带令牌拉取机器人列表，取首个机器人来反推运行时根目录并全页缓存。
  runtimeRootPromise = fetch(withToken('/api/bots', TOKEN))
    .then(async (resp) => {
      if (!resp.ok) return '';

      const bots = (await resp.json().catch(() => null)) as { name?: unknown }[] | null;
      let firstName: unknown;
      if (Array.isArray(bots)) {
        firstName = bots[0]?.name;
      }
      if (typeof firstName !== 'string' || firstName === '') return '';

      //M 用首个机器人名称带令牌查询它的目录结构，拿到 botDir 才能截出运行时根路径。
      const infoResp = await fetch(withToken(`/api/ui/bots/${encodeURIComponent(firstName)}`, TOKEN));
      if (!infoResp.ok) return '';

      const info = (await infoResp.json().catch(() => null)) as { paths?: { botDir?: unknown } } | null;
      const botDir = info?.paths?.botDir;
      if (typeof botDir !== 'string' || botDir === '') return '';

      //M 从 botDir 中裁出 /bots/ 前面的父目录，作为所有 bots/... 相对路径的拼接基准。
      return getRuntimeRoot(botDir);
    })
    .catch(() => '')
    .then((root) => {
      cachedRuntimeRoot = root;
      runtimeRootPromise = null;
      return root;
    });
  return runtimeRootPromise;
}


/**
 * React Hook：读取源码根目录（优先用外层 Context 注入值；否则懒加载一次 /api/tutorial/plugins）。
 * @param skipFetch 传入已知非空根目录或明确跳过远端读取时为 true。
 */
export function useSourceWorkspace(skipFetch = false): string {
  const ctx = useContext(TutorialWorkspaceContext);
  const [ws, setWs] = useState<string>(() => cachedWorkspace ?? '');

  useEffect(() => {
    if (ctx !== '' || skipFetch) return undefined;

    if (cachedWorkspace !== null) {
      setWs(cachedWorkspace);
      return undefined;
    }
    let stopped = false;
    //M 未命中缓存且外层未提供源码根时发起一次性懒加载，卸载后丢弃回调以免写已销毁组件。
    void fetchSourceWorkspaceOnce().then((value) => {
      if (!stopped) {
        setWs(value);
      }
    });
    return () => {
      stopped = true;
    };
  }, [ctx, skipFetch]);

  if (ctx !== '') return ctx;

  return ws;
}


/**
 * React Hook：仅当文本确实含相对 bots/ 路径且外部未传 runtimeRoot 时，按需加载一次运行时根目录。
 * @param enabled 是否需要异步查运行时根目录。
 */
export function useRuntimeRoot(enabled: boolean): string {
  const [root, setRoot] = useState<string>(() => cachedRuntimeRoot ?? '');

  useEffect(() => {
    if (!enabled) return undefined;

    if (cachedRuntimeRoot !== null) {
      setRoot(cachedRuntimeRoot);
      return undefined;
    }
    let stopped = false;
    //M 需要解析 bots/ 相对路径且未缓存时懒加载一次运行时根目录，组件卸载时跳过回写。
    void fetchRuntimeRootOnce().then((value) => {
      if (!stopped) {
        setRoot(value);
      }
    });
    return () => {
      stopped = true;
    };
  }, [enabled]);

  return root;
}


/**
 * 从 botDir 或会话文件路径里截取 /bots/ 前面的运行时根目录。
 * @param pathText 如 F:\aidata\AIJMBots\jmbotsData\bots\周小灵。
 */
export function getRuntimeRoot(pathText: string): string {
  const norm = pathText.trim().replaceAll('\\', '/');
  const idx = norm.lastIndexOf('/bots/');
  if (idx > 0) return norm.slice(0, idx);

  return '';
}


/**
 * 把“文件:行号[:列号]”拆开。
 * @param site 原始位置串，反斜杠与 JSON 转义双反斜杠均认。
 * @returns 没有行号时返回 undefined。
 */
export function getSiteParts(site: string): { file: string; line: number } | undefined {
  const norm = site.trim().replace(/\\\\/gu, '/').replaceAll('\\', '/');
  const lineColMatch = /^(.+):(\d+):(\d+)$/u.exec(norm);
  if (lineColMatch !== null) {
    return { file: lineColMatch[1] ?? '', line: Number(lineColMatch[2]) };
  }
  const match = /^(.+):(\d+)$/u.exec(norm);
  if (match === null) return undefined;

  return { file: match[1] ?? '', line: Number(match[2]) };
}


/** 判断标准路径是否像源码根目录下的相对路径。 */
function isSourceRelative(norm: string): boolean {
  return SOURCE_RELATIVE_RE.test(norm);
}


/** 判断路径是否带有常见文件扩展名（无扩展名多为文件夹）。 */
function hasFileExtension(norm: string): boolean {
  const base = norm.split('/').pop() ?? '';
  return /\.[a-zA-Z0-9]{1,10}$/u.test(base);
}


/**
 * 解析给 VS Code 使用的目标文件与可选行号。
 * @param site 原始路径或 文件:行[:列]。
 */
function getSiteTarget(site: string): { file: string; line: number | null; runtimeRel: boolean } | undefined {
  //M 先按“路径:行[:列]”提取位置与行号，成功则不必按无行号纯路径再猜默认第 1 行。
  const withLine = getSiteParts(site);
  if (withLine !== undefined) {
    const clean = withLine.file;
    const isAbs = /^[A-Za-z]:\//u.test(clean) || /^\/(?!\/)/u.test(clean);
    //G 只放行绝对路径、源码相对路径或 bots/ 运行时路径，防止把普通文本里的冒号数字误判成位置。
    if (isAbs || isSourceRelative(clean) || clean.startsWith('bots/')) {
      return { file: clean, line: withLine.line, runtimeRel: clean.startsWith('bots/') };
    }
    return undefined;
  }

  const norm = site.trim().replace(/\\\\/gu, '/').replaceAll('\\', '/').replace(/\/+$/u, '');
  if (norm === '') return undefined;

  if (/^[A-Za-z]:\//u.test(norm) || /^\/(?!\/)/u.test(norm)) {
    let defaultLine: number | null = null;
    //G 绝对路径带扩展名视为文件并定位第 1 行，无扩展名视为目录不附带行号。
    if (hasFileExtension(norm)) {
      defaultLine = 1;
    }
    return { file: norm, line: defaultLine, runtimeRel: false };
  }

  //G 源码相对路径必须带文件扩展名才成链接，避免把普通的 src7/ 或 web/ 目录名当成文件。
  if (isSourceRelative(norm) && hasFileExtension(norm)) {
    return { file: norm, line: 1, runtimeRel: false };
  }

  if (norm.startsWith('bots/') && norm.length > 'bots/'.length) {
    let defaultLine: number | null = null;
    //G bots/ 下带扩展名的文件默认定位第 1 行，无扩展名目录保留 null 以便直接打开文件夹。
    if (hasFileExtension(norm)) {
      defaultLine = 1;
    }
    return { file: norm, line: defaultLine, runtimeRel: true };
  }
  return undefined;
}


/**
 * 把“文件:行号”、源码相对路径或运行时绝对路径拼成 vscode://file/... 地址。
 * @param workspace 源码根目录；为空时源码相对路径返回 null（仅绝对路径有效）。
 * @param site 文件:行号、文件或目录路径。
 * @param runtimeRoot 运行时根目录（给相对路径 bots/... 用）；可省略。
 */
export function getVscodeHref(workspace: string, site: string, runtimeRoot = ''): string | null {
  //M 把原始位置拆成标准化路径、可选行号与是否 bots/ 运行时路径，认不出来就返回 null 隐藏链接。
  const target = getSiteTarget(site);
  if (target === undefined) return null;

  const { file, line, runtimeRel } = target;
  let lineSuffix = '';
  if (line !== null) {
    lineSuffix = `:${String(line)}`;
  }

  //M 本来就是绝对路径：直接拼 vscode://file/，不依赖根目录。
  if (/^[A-Za-z]:\//u.test(file) || file.startsWith('/')) {
    return `vscode://file/${file}${lineSuffix}`;
  }

  //M 运行时 bots/ 相对路径：只拼已知的 runtimeRoot。
  if (runtimeRel) {
    const rt = runtimeRoot.trim().replaceAll('\\', '/').replace(/\/+$/u, '');
    if (rt === '') return null;

    return `vscode://file/${rt}/${file}${lineSuffix}`;
  }

  //M 源码相对路径：必须拿到源码根目录；拿不到不出链接。
  const root = workspace.trim().replaceAll('\\', '/').replace(/\/+$/u, '');
  if (root === '') return null;

  //M 带着前面目录的，先从后端源码根截起：getSourceStart 不认 web/ 下面那个，源码目录改名成 src 后 web/src/ 不会被误截。
  const prefixed = `/${file}`;
  const sourceAt = sourceDirModule.getSourceStart(prefixed);
  if (sourceAt >= 0) return `vscode://file/${root}/${prefixed.slice(sourceAt)}${lineSuffix}`;

  //M 再认网页、基地、脚本、测试这几层，从最后一处截起。
  let relative = file;
  for (const mark of ['/web/', '/local/', '/scripts/', '/tests/']) {
    const at = prefixed.lastIndexOf(mark);
    if (at < 0) continue;

    relative = prefixed.slice(at + 1);
    break;
  }
  return `vscode://file/${root}/${relative}${lineSuffix}`;
}


/**
 * 从可选外部文本（如记忆命中的 where：“第12行” / “L12-L18”）提取起始行号拼到 site 后。
 * @param path 文件路径。
 * @param where 可选行号描述。
 */
export function withLineHint(path: string, where?: string): string {
  if (!path) return '';

  //G 路径自身已经带着 :行号 时保留精确位置，不用 where 里的粗略行号覆盖。
  if (getSiteParts(path) !== undefined) return path;

  if (!where) return path;

  const match = /(?:^|[^\d])(?:L|第\s*)(\d+)/u.exec(where);
  if (match === null) return path;

  return `${path}:${match[1]}`;
}


/** 判断文本里是否包含无需源码根即可直接跳过的纯绝对路径前缀。 */
function isAbsolutePathText(site: string): boolean {
  const s = site.trim();
  return /^[A-Za-z]:[\\/]/u.test(s) || /^\/(?!\/)/u.test(s);
}


/** 判断文本里是否出现需要源码根目录解析的相对路径标记。 */
function hasSourcePrefix(text: string): boolean {
  return SOURCE_MARK_RE.test(text);
}


/**
 * 在 VS Code 里打开文件/位置的小图标链接；拼不出地址时不显示。
 */
export function VsCodeOpen(props: {
  workspace?: string;
  runtimeRoot?: string;
  site: string;
  label?: string;
}): JSX.Element | null {
  //G 外层已传入源码根或目标本身为绝对路径时跳过拉取 /api/tutorial/plugins，避免多余请求。
  const skipSourceFetch =
    (props.workspace !== undefined && props.workspace !== '') || isAbsolutePathText(props.site);
  //M 按需获取源码根目录，供 src7/、web/ 等源码相对路径拼出完整的 vscode:// 地址。
  const sourceWorkspace = useSourceWorkspace(skipSourceFetch);
  const effectiveWorkspace = props.workspace ?? sourceWorkspace;
  const needsRuntime = props.runtimeRoot === undefined && props.site.trim().startsWith('bots/');
  //M 仅当目标以 bots/ 开头且外部未传 runtimeRoot 时按需拉取运行时根目录来拼接绝对路径。
  const autoRuntimeRoot = useRuntimeRoot(needsRuntime);
  const effectiveRuntime = props.runtimeRoot ?? autoRuntimeRoot;

  //M 综合源码根目录与运行时根目录生成 vscode://file/ 链接，拼不出则隐藏图标避免点出空链。
  const href = getVscodeHref(effectiveWorkspace, props.site, effectiveRuntime);
  if (href === null) return null;

  //M 渲染在 VS Code 打开的小图标链接，并阻止点击冒泡以免触发外层行选择。
  return (
    <a
      className="tu-vscode jm-vscode"
      href={href}
      title={props.label ?? `在 VS Code 里打开 ${props.site}`}
      aria-label={props.label ?? '在 VS Code 里打开'}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => event.stopPropagation()}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          fill="currentColor"
          d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 19.61V4.39a1.5 1.5 0 0 0-.85-1.803zm-2.226 15.012-8.784-6.35v-.01l8.784-6.35z"
        />
      </svg>
    </a>
  );
}


/**
 * 把“文件路径”或“文件:行号”文字做成 vscode:// 链接并附小图标；拼不出来时退回普通文本。
 */
export function SiteLink(props: {
  site: string;
  workspace?: string;
  runtimeRoot?: string;
  label?: ReactNode;
}): JSX.Element {
  //G 外层已传入源码根或目标本身为绝对路径时跳过拉取 /api/tutorial/plugins，避免多余请求。
  const skipSourceFetch =
    (props.workspace !== undefined && props.workspace !== '') || isAbsolutePathText(props.site);
  //M 按需获取源码根目录，供 src7/、web/ 等源码相对路径拼出可点的 vscode:// 地址。
  const sourceWorkspace = useSourceWorkspace(skipSourceFetch);
  const effectiveWorkspace = props.workspace ?? sourceWorkspace;
  const needsRuntime = props.runtimeRoot === undefined && props.site.trim().startsWith('bots/');
  //M 仅当目标以 bots/ 开头且外部未传 runtimeRoot 时按需拉取运行时根目录来拼接绝对路径。
  const autoRuntimeRoot = useRuntimeRoot(needsRuntime);
  const effectiveRuntime = props.runtimeRoot ?? autoRuntimeRoot;

  //M 尝试拼出 vscode://file/ 链接；拼不出时下方退回纯文本，不显示可点死链。
  const href = getVscodeHref(effectiveWorkspace, props.site, effectiveRuntime);
  let shown: ReactNode = props.site;
  if (props.label !== undefined) {
    shown = props.label;
  }
  if (href === null) return <span>{shown}</span>;

  //M 把路径文本与 VS Code 图标并排渲染为行内链接，阻止点击冒泡避免误触外层卡片。
  return (
    <span className="tu-site-inline jm-site-inline" onClick={(event: MouseEvent<HTMLSpanElement>) => event.stopPropagation()}>
      <a className="tu-site-link jm-site-link" href={href} title={`在 VS Code 里打开 ${props.site}`}>
        {shown}
      </a>
      <VsCodeOpen workspace={effectiveWorkspace} runtimeRoot={effectiveRuntime} site={props.site} />
    </span>
  );
}


/** 裁剪匹配路径尾部误粘的句末标点（保留扩展名与 :行号）。 */
function trimMatchedPath(raw: string): { pathText: string; suffix: string } {
  //M 剥掉路径末尾误粘的中英文句末标点留作普通后缀，保住文件扩展名和 :行号。
  const trimmed = raw.replace(/[.:。，；、！？]+$/u, '');
  const suffix = raw.slice(trimmed.length);
  return { pathText: trimmed, suffix };
}


/**
 * 自动把报错栈、工具调用 JSON 参数、字段原文里内嵌的文件路径与「文件:行号」转成可点开 VS Code 的链接；
 * 开启演示打码时不解析也不生成任何链接。
 */
export function TextWithVscodeLinks(props: {
  text: string;
  masked?: boolean;
  workspace?: string;
  runtimeRoot?: string;
}): JSX.Element {
  const text = props.text;
  const hasCandidate = !props.masked && text !== '' && INLINE_PATH_RE.test(text);
  INLINE_PATH_RE.lastIndex = 0;

  //G 演示打码开启、外层已传源码根或原文压根不含源码相对前缀时跳过拉取源码根，防止冗余请求或暴露链接。
  const skipSourceFetch =
    props.masked === true
    || (props.workspace !== undefined && props.workspace !== '')
    || !hasSourcePrefix(text);
  //M 按需读取源码根目录，用来把正文里混排的源码相对路径转成可点开 VS Code 的链接。
  const sourceWorkspace = useSourceWorkspace(skipSourceFetch);
  const effectiveWorkspace = props.workspace ?? sourceWorkspace;
  const needsRuntime = !props.masked && props.runtimeRoot === undefined && text.includes('bots/');
  //M 仅当原文提到 bots/ 且未开启打码和未传 runtimeRoot 时懒加载运行时根目录。
  const autoRuntimeRoot = useRuntimeRoot(needsRuntime);
  const effectiveRuntime = props.runtimeRoot ?? autoRuntimeRoot;

  if (props.masked || !hasCandidate) return <>{text}</>;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  let seq = 0;
  const matcher = new RegExp(INLINE_PATH_RE.source, 'gu');
  for (let hit = matcher.exec(text); hit !== null; hit = matcher.exec(text)) {
    const start = hit.index;
    const rawMatch = hit[0];
    if (start > cursor) {
      nodes.push(text.slice(cursor, start));
    }
    //M 把匹配到的路径尾端句末标点剥回 suffix，保证只有纯路径与 :行号 参与链接拼接。
    const { pathText, suffix } = trimMatchedPath(rawMatch);
    //M 尝试拼出可点击的 vscode://file/ 地址；拼不出的片段按原样纯文本保留，不生成无效链接。
    const href = getVscodeHref(effectiveWorkspace, pathText, effectiveRuntime);
    if (href === null) {
      nodes.push(rawMatch);
      cursor = start + rawMatch.length;
      continue;
    }
    nodes.push(
      <a
        key={`vs-${String(seq)}`}
        className="jm-site-link"
        href={href}
        title={`在 VS Code 里打开 ${pathText}`}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => event.stopPropagation()}
      >
        {pathText}
      </a>,
    );
    if (suffix !== '') {
      nodes.push(suffix);
    }
    seq += 1;
    cursor = start + rawMatch.length;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  //M 按原有顺序拼回普通文字片段和可点击链接，保持报错栈与参数文本结构不变。
  return <>{nodes}</>;
}
