/**
 * 网址里的选中状态：选中了哪个目录、哪篇文档。
 * 写法：`#/kb`（还没选目录）、`#/kb/all`（全部文档）、`#/kb/3`（目录 3）、`#/kb/3/doc/12`（目录 3 里的第 12 篇）。
 * 这里只有解析和拼写两个纯函数；跟着网址变、往历史记录里跳的是 ViewStore.ts。
 */


/** 选中状态。 */
export interface Route {
  /** 选中的目录 ID；'all' 表示“全部文档”；null 表示还没选，PC 上当成“全部文档”，手机上停在目录这一层。 */
  baseId: number | 'all' | null;
  /** 选中的文档 ID；没选文档时为 null。 */
  documentId: number | null;
}


/** 网址没写或写错时用的状态：还没选目录，也没选文档。 */
const DEFAULT_ROUTE: Route = { baseId: null, documentId: null };


/** 把网址的 hash（例如 `#/kb/3/doc/12`）解析成选中状态；认不出来时返回默认状态。 */
export function parseRoute(hash: string): Route {
  // m: 去掉开头的 `#/`，按斜杠拆成 ['kb', 目录, 'doc', 文档]。
  /** hash 的各段。 */
  const parts = hash.replace(/^#\/?/, '').split('/');
  // g: 不是 kb 开头、没写目录或者目录段写错，就用默认状态。
  if (parts[0] !== 'kb') {
    return DEFAULT_ROUTE;
  }
  /** 目录段解析的结果；null 表示没写或写错。 */
  const baseId = parseBaseId(parts[1]);
  if (baseId === null) {
    return DEFAULT_ROUTE;
  }
  // m: 有 doc 段、并且后面是正整数，才算选中了文档；否则只选目录。
  /** 文档 ID；没写或写错时为 null。 */
  const documentId = parts[2] === 'doc' ? parsePositiveInteger(parts[3]) : null;
  return { baseId, documentId };
}


/** 把选中状态写成 hash，例如 { baseId: 3, documentId: 12 } → `#/kb/3/doc/12`。选了文档却没选目录时，目录按“全部文档”写。 */
export function formatRoute(route: Route): string {
  if (route.documentId !== null) {
    return `#/kb/${route.baseId ?? 'all'}/doc/${route.documentId}`;
  }
  if (route.baseId === null) {
    return '#/kb';
  }
  return `#/kb/${route.baseId}`;
}


/** 解析目录段：'all' 或正整数；没写或写错时返回 null。 */
function parseBaseId(text: string | undefined): number | 'all' | null {
  if (text === 'all') {
    return 'all';
  }
  return parsePositiveInteger(text);
}


/** 解析正整数；空、0、负数、小数、带字母时都返回 null。 */
function parsePositiveInteger(text: string | undefined): number | null {
  // g: 只认纯数字，避免 Number('1e3')、Number(' 3') 这类意外也被当成数字。
  if (text === undefined || !/^\d+$/.test(text)) {
    return null;
  }
  /** 转成的数字。 */
  const value = Number(text);
  if (value < 1 || !Number.isSafeInteger(value)) {
    return null;
  }
  return value;
}
