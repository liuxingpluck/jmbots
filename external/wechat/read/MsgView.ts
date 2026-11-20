/**
 * 微信消息安全 XML 提取器、17+ 种气泡视图（view）构建与群聊 @ 提及识别。
 * 零第三方依赖：拦截 DOCTYPE/ENTITY 防 XXE，限制 20KB 长度与节点上限，绝不向前端暴露原始 XML。
 */


/** 允许送入安全 XML 解析器的最大字符数，与原 Python 引擎上限一致。 */
export const MAX_XML_LENGTH = 20_000;

/** 单条 XML 允许展开的最大元素节点数，防止畸形深层嵌套耗尽内存。 */
const MAX_XML_NODES = 2048;

/** 单条 XML 允许的最大嵌套深度。 */
const MAX_XML_DEPTH = 64;

/** 禁止 DTD 与外部实体声明的守卫正则。 */
const UNSAFE_XML_RE = /<!\s*(?:DOCTYPE|ENTITY)\b/iu;

/** 剥除 HTML/XML 标签用的正则。 */
const STRIP_TAGS_RE = /<[^>]+>/gu;

/** 连续空白折叠正则。 */
const COLLAPSE_SPACE_RE = /\s+/gu;

/** 判断字符串中是否仍残留成对尖括号标签。 */
const LOOKS_LIKE_XML_RE = /<[A-Za-z_?!][^>]*>/u;

/** 匹配字节或文本中独立的 32 位小写十六进制 MD5。 */
const HEX_MD5_RE = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gu;

/** 系统消息模板中的 $name$ 占位符。 */
const DOLLAR_SLOT_RE = /\$([A-Za-z0-9_]+)\$/gu;

/** 拍一拍模板中的 ${wxid} 占位符。 */
const BRACE_SLOT_RE = /\$\{([^}]+)\}/gu;

/** msgsource XML 中的 <atuserlist> 提取正则（兼容可选 CDATA 包裹）。 */
const AT_USER_LIST_RE = /<atuserlist>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/atuserlist>/u;

/** XML 开标签属性对提取正则。 */
const XML_ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;

/** 微信群 @ 所有人在 msgsource 中的固定标识。 */
export const AT_ALL_WXID = 'notify@all';

/** 类型 49（appmsg）子类型到卡片气泡种类的映射。 */
const APP_KIND_BY_TYPE = new Map<number, MessageKind>([
  [3, 'music'],
  [4, 'link'],
  [5, 'link'],
  [6, 'file'],
  [19, 'record'],
  [33, 'miniapp'],
  [36, 'miniapp'],
  [40, 'record'],
  [44, 'miniapp'],
  [51, 'channels'],
  [57, 'quote'],
  [63, 'channels'],
  [87, 'link'],
  [2000, 'transfer'],
  [2001, 'redpacket'],
]);

/** 微信转账 paysubtype 到中文状态说明的映射。 */
const TRANSFER_DESC_BY_SUBTYPE = new Map<number, string>([
  [1, '转账'],
  [3, '已收款'],
  [4, '已退还'],
  [8, '待收款'],
]);

/** 语音/视频通话英文状态码到中文气泡文案的映射。 */
const CALL_STATUS_MAP = new Map<string, string>([
  ['Canceled', '已取消'],
  ['Line busy', '对方忙线'],
  ['Call not answered', '未接听'],
  ["Call wasn't answered", '未接听'],
]);

/** 非文本基础消息类型到简短中文标签的兜底映射。 */
const TYPE_LABELS = new Map<number, string>([
  [3, '图片'],
  [34, '语音'],
  [42, '名片'],
  [43, '视频'],
  [47, '表情'],
  [48, '位置'],
  [49, '链接/文件'],
  [50, '通话'],
]);


/** 支持的全部微信气泡视图种类（覆盖原引擎全部 18 种细分类型）。 */
export type MessageKind =
  | 'text'
  | 'system'
  | 'image'
  | 'emoji'
  | 'quote'
  | 'link'
  | 'file'
  | 'voice'
  | 'video'
  | 'miniapp'
  | 'music'
  | 'redpacket'
  | 'transfer'
  | 'call'
  | 'location'
  | 'card'
  | 'channels'
  | 'record'
  | 'other';

/** 引用回复气泡中被引用原消息的摘要。 */
export interface QuoteView {
  /** 被引用发言人的显示名。 */
  name: string;
  /** 被引用消息的摘要正文或类型占位。 */
  text: string;
}

/** 合并转发聊天记录卡片里的单条预览。 */
export interface RecordPreviewItem {
  /** 原消息发送者名称。 */
  sender: string;
  /** 原消息单行摘要。 */
  text: string;
}

/** 动画表情内部媒体定位字段（仅供服务端媒体提取使用）。 */
export interface EmojiMediaMeta {
  /** 明文表情 CDN 地址。 */
  cdnurl?: string;
  /** 加密表情 CDN 地址。 */
  encrypturl?: string;
  /** 表情 AES 解密密钥十六进制串。 */
  aeskey?: string;
  /** 表情 MD5 标识。 */
  md5?: string;
  /** 缩略图地址。 */
  thumburl?: string;
}

/** 气泡视图附带的内部媒体定位元数据。 */
export interface ViewMediaMeta {
  /** 图片 .dat 候选 MD5 列表（packed_info_data 优先）。 */
  image?: string[];
  /** 动画表情下载与解密参数。 */
  emoji?: EmojiMediaMeta;
}

/** 写入 wechat_messages.view 供客服页与渠道描述共用的结构化气泡视图。 */
export interface MessageView {
  /** 气泡种类。 */
  kind: MessageKind;
  /** 文本、系统提示、引用主文或通话状态。 */
  text?: string;
  /** 群聊发送者显示名；私聊与系统消息省略。 */
  sender?: string;
  /** 卡片、文件、位置、名片、红包、音乐等标题。 */
  title?: string;
  /** 卡片副标题、位置详细地址或转账状态。 */
  desc?: string;
  /** 来源应用或公众号名称（如“视频号”）。 */
  source?: string;
  /** 链接、文章或音乐跳转地址。 */
  url?: string;
  /** 卡片缩略图地址。 */
  thumburl?: string;
  /** 转账金额文案（如 ￥88.00）。 */
  amount?: string;
  /** 语音或视频时长，单位秒。 */
  seconds?: number;
  /** 文件字节大小。 */
  size?: number;
  /** 图片或表情像素宽度。 */
  width?: number;
  /** 图片或表情像素高度。 */
  height?: number;
  /** 引用回复的原消息信息。 */
  quote?: QuoteView;
  /** 合并转发卡片内的前几条消息预览。 */
  items?: RecordPreviewItem[];
  /** 服务端提取媒体用的内部定位信息。 */
  media?: ViewMediaMeta;
}

/** 安全轻量 XML 解析树节点。 */
export interface XmlNode {
  /** 标签名（保留原大小写）。 */
  tag: string;
  /** 属性键值表。 */
  attrs: Map<string, string>;
  /** 直接子元素列表。 */
  children: XmlNode[];
  /** 直接归属本节点的文本与 CDATA 片段。 */
  textParts: string[];
  /** 文档顺序下的混合子项（文本片段或子元素），供还原完整子树文本。 */
  ordered: Array<string | XmlNode>;
}

/** 群聊 @ 提及判定结果。 */
export interface MentionFlags {
  /** 是否明确 @ 了当前登录账号。 */
  atMe: boolean;
  /** 是否 @ 所有人。 */
  atAll: boolean;
  /** 判定依据来源：atuserlist（XML 精确名单）、text（正文推断）或空串。 */
  atSource: 'atuserlist' | 'text' | '';
}


/**
 * 拆分微信 64 位复合消息类型：低 32 位为基础类型，高 32 位为 appmsg 子类型。
 * 使用 BigInt 避免 JavaScript 32 位有符号位运算截断高 32 位。
 * @param localType 数据库里的 local_type 整数。
 * @returns 基础类型与子类型。
 */
export function splitMessageType(localType: number | bigint): { baseType: number; subType: number } {
  let raw = 0n;
  if (typeof localType === 'bigint') {
    raw = localType;
  }
  if (typeof localType === 'number' && Number.isFinite(localType) && localType > 0) {
    raw = BigInt(Math.trunc(localType));
  }
  if (raw <= 0n) return { baseType: 0, subType: 0 };

  const baseType = Number(raw & 0xffffffffn);
  const subType = Number(raw >> 32n);
  return { baseType, subType };
}


/**
 * 将基础消息类型格式化为会话列表使用的简短中文类型名。
 * @param localType 数据库里的 local_type 整数。
 * @returns 中文类型标签（如“文本”“图片”）。
 */
export function getMessageTypeLabel(localType: number | bigint): string {
  //M 先拆出低 32 位基础类型再查中文名。
  const { baseType } = splitMessageType(localType);
  if (baseType === 1) return '文本';
  if (baseType === 10000) return '系统';
  if (baseType === 10002) return '撤回';

  const label = TYPE_LABELS.get(baseType);
  if (label !== undefined) return label;

  return `type=${String(localType)}`;
}


/**
 * 解码文本或属性值中的标准 XML 实体与数字字符引用。
 * @param raw 含实体转义的原始片段。
 * @returns 解码后的纯文本。
 */
function decodeXmlEntities(raw: string): string {
  if (!raw.includes('&')) return raw;

  return raw.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/gu, (whole, dec, hex, named) => {
    if (typeof dec === 'string') {
      const code = Number.parseInt(dec, 10);
      if (code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      return whole;
    }
    if (typeof hex === 'string') {
      const code = Number.parseInt(hex, 16);
      if (code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      return whole;
    }
    if (named === 'lt') return '<';
    if (named === 'gt') return '>';
    if (named === 'amp') return '&';
    if (named === 'quot') return '"';
    if (named === 'apos') return "'";
    return whole;
  });
}


/**
 * 解析一段微信消息 XML 为只读节点树。
 * 自动截除首个 `<` 之前的群聊前缀杂质；超过 20KB、含 DOCTYPE/ENTITY 或语法损坏时返回 undefined。
 * @param content 解压后的消息文本。
 * @returns 根 XmlNode；不可安全解析时返回 undefined。
 */
export function parseSafeXml(content: string): XmlNode | undefined {
  //G 严格限制总长度并阻断任何 DTD / 外部实体声明。
  if (content === '' || content.length > MAX_XML_LENGTH) return undefined;
  if (UNSAFE_XML_RE.test(content)) return undefined;

  const firstLt = content.indexOf('<');
  if (firstLt < 0) return undefined;

  const xml = content.slice(firstLt);
  const length = xml.length;
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let nodeCount = 0;
  let cursor = 0;

  while (cursor < length) {
    const lt = xml.indexOf('<', cursor);
    if (lt < 0) {
      //M 根标签闭合后的尾部空白忽略，栈内仍有元素则补进当前节点文本。
      const current = stack[stack.length - 1];
      if (current !== undefined && cursor < length) {
        //M 解码尾部文本片段中的实体字符。
        const decoded = decodeXmlEntities(xml.slice(cursor));
        current.textParts.push(decoded);
        current.ordered.push(decoded);
      }
      break;
    }

    if (lt > cursor) {
      const current = stack[stack.length - 1];
      if (current !== undefined) {
        //M 把两个标签之间的文本解码后挂入栈顶元素。
        const decoded = decodeXmlEntities(xml.slice(cursor, lt));
        current.textParts.push(decoded);
        current.ordered.push(decoded);
      }
    }

    //G 处理注释节点 <!-- ... -->。
    if (xml.startsWith('<!--', lt)) {
      const commentEnd = xml.indexOf('-->', lt + 4);
      if (commentEnd < 0) return undefined;

      cursor = commentEnd + 3;
      continue;
    }

    //G 处理 XML 声明或处理指令 <? ... ?>。
    if (xml.startsWith('<?', lt)) {
      const piEnd = xml.indexOf('?>', lt + 2);
      if (piEnd < 0) return undefined;

      cursor = piEnd + 2;
      continue;
    }

    //M 处理 CDATA 原样文本块 <![CDATA[ ... ]]>，内部无需实体解码。
    if (xml.startsWith('<![CDATA[', lt)) {
      const cdataEnd = xml.indexOf(']]>', lt + 9);
      if (cdataEnd < 0) return undefined;

      const rawCdata = xml.slice(lt + 9, cdataEnd);
      const current = stack[stack.length - 1];
      if (current !== undefined) {
        //M 将 CDATA 原文追加进栈顶元素。
        current.textParts.push(rawCdata);
        current.ordered.push(rawCdata);
      }
      cursor = cdataEnd + 3;
      continue;
    }

    //G 其余以 <! 开头的声明一律视作不安全或非法语法拒绝。
    if (xml.startsWith('<!', lt)) return undefined;

    //M 找到当前标签结束的 `>`（跳过引号内部的 `>` 字符）。
    let gt = -1;
    let quoteChar = '';
    for (let scan = lt + 1; scan < length; scan += 1) {
      const ch = xml[scan]!;
      if (quoteChar !== '') {
        if (ch === quoteChar) {
          quoteChar = '';
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quoteChar = ch;
        continue;
      }
      if (ch === '>') {
        gt = scan;
        break;
      }
    }
    if (gt < 0) return undefined;

    const rawTagBody = xml.slice(lt + 1, gt).trim();
    cursor = gt + 1;
    if (rawTagBody === '') return undefined;

    //M 闭合标签 </tag>：要求与当前栈顶标签严格配对，否则视作坏 XML。
    if (rawTagBody.startsWith('/')) {
      const closeName = rawTagBody.slice(1).trim();
      const top = stack.pop();
      if (top === undefined || top.tag !== closeName) return undefined;

      if (stack.length === 0 && root !== undefined) {
        break;
      }
      continue;
    }

    //M 开标签或自闭合标签：解析标签名与属性表，并检查节点数与嵌套深度上限。
    const selfClosing = rawTagBody.endsWith('/');
    let openBody = rawTagBody;
    if (selfClosing) {
      openBody = rawTagBody.slice(0, -1).trim();
    }
    const nameMatch = /^([A-Za-z_][\w:.-]*)/u.exec(openBody);
    if (nameMatch === null) return undefined;

    nodeCount += 1;
    if (nodeCount > MAX_XML_NODES || stack.length >= MAX_XML_DEPTH) return undefined;

    const tagName = nameMatch[1]!;
    const attrSource = openBody.slice(tagName.length);
    const attrs = new Map<string, string>();
    for (const match of attrSource.matchAll(XML_ATTR_RE)) {
      const attrKey = match[1]!;
      const rawVal = match[2] ?? match[3] ?? '';
      //M 解码属性值里的引号与转义实体。
      const attrVal = decodeXmlEntities(rawVal);
      attrs.set(attrKey, attrVal);
    }

    const node: XmlNode = { tag: tagName, attrs, children: [], textParts: [], ordered: [] };
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      //M 将新节点挂入父元素子列表。
      parent.children.push(node);
      parent.ordered.push(node);
    }
    if (parent === undefined) {
      if (root !== undefined) return undefined;
      root = node;
    }
    if (!selfClosing) {
      //M 非自闭合标签压入解析栈等待配对闭合。
      stack.push(node);
    }
  }

  if (stack.length !== 0) return undefined;
  return root;
}


/**
 * 在节点后代中按深度优先查找第一个指定标签的子孙元素（不含 root 自身，对齐 ElementTree .//tag）。
 * @param root 起始节点。
 * @param tag 目标标签名。
 */
function findDescendant(root: XmlNode | undefined, tag: string): XmlNode | undefined {
  if (root === undefined) return undefined;

  for (const child of root.children) {
    if (child.tag === tag) return child;

    //M 递归向子树深处寻找首个同名后代。
    const nested = findDescendant(child, tag);
    if (nested !== undefined) return nested;
  }
  return undefined;
}


/**
 * 先检查自身再检查后代，定位第一个匹配标签的元素（对齐 msgview._attr 的查找顺序）。
 * @param root 起始节点。
 * @param tag 目标标签名。
 */
function findSelfOrDescendant(root: XmlNode | undefined, tag: string): XmlNode | undefined {
  if (root === undefined) return undefined;
  if (root.tag === tag) return root;

  //M 自身不是目标标签时在后代节点中继续查找。
  return findDescendant(root, tag);
}


/**
 * 收集节点子树内全部指定标签的后代元素（文档顺序）。
 * @param root 起始节点。
 * @param tag 目标标签名。
 * @param out 结果累加数组。
 */
function collectDescendants(root: XmlNode | undefined, tag: string, out: XmlNode[] = []): XmlNode[] {
  if (root === undefined) return out;

  for (const child of root.children) {
    if (child.tag === tag) {
      //M 记录命中的子元素。
      out.push(child);
    }
    //M 继续收集更深层的同名子孙元素。
    collectDescendants(child, tag, out);
  }
  return out;
}


/**
 * 读取直接子标签（或以 `/` 分隔的相对子路径）的文本并去除首尾空白。
 * @param node 父节点。
 * @param childPath 子标签名或形如 `content_template/template` 的直接路径。
 */
function getChildText(node: XmlNode | undefined, childPath: string): string {
  if (node === undefined) return '';

  let current: XmlNode | undefined = node;
  for (const segment of childPath.split('/')) {
    //M 逐级向直接子元素下钻定位路径。
    current = current.children.find((item) => item.tag === segment);
    if (current === undefined) return '';
  }
  return current.textParts.join('').trim();
}


/**
 * 读取后代中第一个指定标签节点的文本并去空白（对齐 ElementTree .findtext('.//tag')）。
 * @param root 起始节点。
 * @param tag 后代标签名。
 */
function getDescendantText(root: XmlNode | undefined, tag: string): string {
  //M 先定位首个后代节点再拼接其直接文本。
  const target = findDescendant(root, tag);
  if (target === undefined) return '';

  return target.textParts.join('').trim();
}


/**
 * 读取自身或后代中首个指定标签的某个属性值（去首尾空白）。
 * @param root 起始节点。
 * @param tag 标签名。
 * @param attrName 属性名。
 */
function getTagAttr(root: XmlNode | undefined, tag: string, attrName: string): string {
  //M 先找标签元素，再取对应属性值。
  const target = findSelfOrDescendant(root, tag);
  if (target === undefined) return '';

  //M 从标签属性表中取出值并去除首尾空白。
  const rawAttr = target.attrs.get(attrName) ?? '';
  return rawAttr.trim();
}


/**
 * 按文档顺序收集整棵子树内的所有非空文本段（对齐 ElementTree itertext）。
 * @param node 起始节点。
 * @param pieces 文本累加数组。
 */
function collectIterText(node: XmlNode, pieces: string[] = []): string[] {
  for (const item of node.ordered) {
    if (typeof item === 'string') {
      if (item.trim() !== '') {
        //M 追加非空直接文本段。
        pieces.push(item);
      }
      continue;
    }
    //M 遇到子元素时按深度优先继续收集内部文字。
    collectIterText(item, pieces);
  }
  return pieces;
}


/**
 * 剥除残留 HTML/XML 标签、折叠空白，并在超过上限时截断追加省略号。
 * @param raw 原始文本。
 * @param maxChars 最大字符数，0 表示不截断。
 */
export function cleanText(raw: string, maxChars = 0): string {
  if (raw === '') return '';

  const text = raw.replace(STRIP_TAGS_RE, '').replace(COLLAPSE_SPACE_RE, ' ').trim();
  if (maxChars > 0 && text.length > maxChars) {
    return `${text.slice(0, maxChars)}…`;
  }
  return text;
}


/**
 * 宽松解析十进制整数，失败时回退默认值。
 * @param raw 待解析文本或数字。
 * @param fallback 解析失败时的回退整数。
 */
function parseIntOr(raw: string | number | undefined, fallback = 0): number {
  if (typeof raw === 'number') {
    if (Number.isFinite(raw)) return Math.trunc(raw);
    return fallback;
  }
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;

  const parsed = Number.parseInt(raw.trim(), 10);
  if (Number.isNaN(parsed)) return fallback;

  return parsed;
}


/**
 * 从 packed_info_data 二进制与图片消息 XML 中提取去重后的 32 位小写图片 MD5 候选。
 * @param xmlContent 图片消息文本。
 * @param packed 可选的 packed_info_data 二进制列。
 * @returns 按优先级排列的 32 位十六进制 MD5 数组。
 */
export function extractImageMd5s(xmlContent: string, packed?: Uint8Array | null): string[] {
  const found: string[] = [];
  if (packed !== undefined && packed !== null && packed.byteLength > 0) {
    //M packed_info_data 里按 latin1 扫描连续 ASCII 十六进制串，命中率最高。
    const ascii = Buffer.from(packed).toString('latin1');
    for (const match of ascii.matchAll(HEX_MD5_RE)) {
      const md5 = match[0];
      if (!found.includes(md5)) {
        found.push(md5);
      }
    }
  }

  //M 补充解析 <img> 节点上的 md5 与 hdmd5 属性。
  const root = parseSafeXml(xmlContent);
  for (const key of ['md5', 'hdmd5']) {
    const candidate = getTagAttr(root, 'img', key).toLowerCase();
    if (/^[0-9a-f]{32}$/u.test(candidate) && !found.includes(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}


/**
 * 将系统消息（10000 / 10002 / 拍一拍）解析为单行干净中文提示，绝不返回原始 XML。
 * @param content 系统消息原始内容。
 * @param nameLookup 可选的 wxid -> 显示名查找函数（拍一拍模板替换用）。
 */
export function formatSystemText(content: string, nameLookup?: (wxid: string) => string | undefined): string {
  if (content === '') return '[系统消息]';

  if (!LOOKS_LIKE_XML_RE.test(content)) {
    //M 纯文本系统通知直接折叠空白输出。
    const plain = cleanText(content);
    if (plain !== '') return plain;
    return '[系统消息]';
  }

  //M 解析系统消息 XML，坏 XML 只取剥标签后的安全短文本或固定占位。
  const root = parseSafeXml(content);
  if (root === undefined) {
    const stripped = cleanText(content);
    if (stripped !== '' && !stripped.includes('<') && !stripped.includes('>') && stripped.length < 200) {
      return stripped;
    }
    return '[系统消息]';
  }

  let sysType = '';
  if (root.tag === 'sysmsg') {
    //M 读取系统消息顶层分类属性。
    const rawType = root.attrs.get('type') ?? '';
    sysType = rawType.trim();
  }

  //M 1. 撤回提示：<sysmsg type="revokemsg"><revokemsg><replacemsg>...
  if (sysType === 'revokemsg' || findDescendant(root, 'revokemsg') !== undefined) {
    const replaceMsg = cleanText(getDescendantText(root, 'replacemsg'));
    if (replaceMsg !== '') return replaceMsg;
    return '对方撤回了一条消息';
  }

  //M 2. 拍一拍提示：<pat><template>"${wxid_a}" 拍了拍 "${wxid_b}"</template>
  if (
    sysType === 'pat'
    || findDescendant(root, 'pat') !== undefined
    || findDescendant(root, 'patinfo') !== undefined
  ) {
    const patTemplate = getDescendantText(root, 'template');
    if (patTemplate !== '') {
      const rendered = patTemplate.replace(BRACE_SLOT_RE, (_whole, wxid: string) => {
        const mapped = nameLookup?.(wxid);
        if (mapped !== undefined && mapped !== '') return mapped;
        return '对方';
      });
      const cleaned = cleanText(rendered);
      if (cleaned !== '') return cleaned;
      return '拍了拍';
    }
    return '[拍一拍]';
  }

  //M 3. 进群/改群名等结构化系统模板：<sysmsgtemplate><content_template><template>$username$...
  let sysTemplate = getChildText(root, 'content_template/template');
  if (sysTemplate === '') {
    sysTemplate = getDescendantText(root, 'content_template/template');
  }
  if (sysTemplate === '') {
    sysTemplate = getDescendantText(root, 'template');
  }
  if (sysTemplate !== '') {
    const links = new Map<string, string>();
    for (const linkNode of collectDescendants(root, 'link')) {
      const linkName = linkNode.attrs.get('name') ?? '';
      const nicks: string[] = [];
      for (const nickNode of collectDescendants(linkNode, 'nickname')) {
        const nick = cleanText(nickNode.textParts.join(''));
        if (nick !== '') {
          nicks.push(nick);
        }
      }
      const linkTitle = cleanText(getChildText(linkNode, 'title'));
      let replacement = linkTitle;
      if (nicks.length > 0) {
        replacement = nicks.join('、');
      }
      links.set(linkName, replacement);
    }
    const filled = sysTemplate.replace(DOLLAR_SLOT_RE, (_whole, slot: string) => links.get(slot) ?? '');
    const cleaned = cleanText(filled);
    if (cleaned !== '') return cleaned;
  }

  //M 4. 其余系统 XML 拼接全部可见文本节点，确认不含标签后输出。
  const joined = cleanText(collectIterText(root).join(' '), 120);
  if (joined !== '' && !LOOKS_LIKE_XML_RE.test(joined)) return joined;

  return '[系统消息]';
}


/**
 * 从合并转发节点（recorditem CDATA 或 recordinfo）提取前 8 条预览。
 * @param appmsg appmsg 元素节点。
 */
function extractRecordItems(appmsg: XmlNode): RecordPreviewItem[] {
  const rawRecordXml = getChildText(appmsg, 'recorditem');
  let container: XmlNode | undefined;
  if (rawRecordXml !== '') {
    //M recorditem 常是一段嵌套的 CDATA XML，二次送入安全解析器提取 dataitem。
    container = parseSafeXml(rawRecordXml);
  }
  if (container === undefined) {
    container = findDescendant(appmsg, 'recordinfo') ?? appmsg;
  }

  const items: RecordPreviewItem[] = [];
  for (const dataItem of collectDescendants(container, 'dataitem')) {
    const rawBody = (
      getChildText(dataItem, 'datadesc')
      || getChildText(dataItem, 'datatitle')
      || getChildText(dataItem, 'title')
    );
    const text = cleanText(rawBody, 80);
    if (text === '') {
      continue;
    }
    //M 提取单条转发记录的发送者并收入预览数组。
    const rawSender = getChildText(dataItem, 'sourcename') || getChildText(dataItem, 'sourcehead');
    const sender = cleanText(rawSender, 40);
    items.push({ sender, text });
    if (items.length >= 8) {
      break;
    }
  }
  return items;
}


/**
 * 解析类型 49（appmsg）富媒体卡片：引用、文件、转账、红包、视频号、聊天记录、小程序、音乐、链接。
 * @param content 消息 XML 正文。
 * @param subType local_type 高 32 位携带的子类型。
 * @param nameLookup 拍一拍消息（app_type=62）使用的名字查找器。
 */
function buildAppMessageView(
  content: string,
  subType: number,
  nameLookup?: (wxid: string) => string | undefined,
): MessageView {
  //M 提取 <appmsg> 主体，缺失时兜底为普通链接卡片。
  const root = parseSafeXml(content);
  const appmsg = findSelfOrDescendant(root, 'appmsg');
  if (root === undefined || appmsg === undefined) {
    return { kind: 'link', title: '[链接/文件]' };
  }

  const appType = parseIntOr(getChildText(appmsg, 'type'), subType);
  if (appType === 62) {
    //M 部分微信版本以 appmsg(type=62) 承载拍一拍系统消息。
    return { kind: 'system', text: formatSystemText(content, nameLookup) };
  }

  const title = cleanText(getChildText(appmsg, 'title'), 120);
  const desc = cleanText(getChildText(appmsg, 'des'), 160);
  const appInfo = findDescendant(root, 'appinfo');
  const rawSource = getChildText(appmsg, 'sourcedisplayname') || getChildText(appInfo, 'appname');
  const source = cleanText(rawSource, 40);
  const url = (getChildText(appmsg, 'url') || getChildText(appmsg, 'dataurl')).trim();
  const thumburl = getChildText(appmsg, 'thumburl').trim();
  const kind: MessageKind = APP_KIND_BY_TYPE.get(appType) ?? 'link';

  if (kind === 'quote') {
    const ref = findDescendant(appmsg, 'refermsg');
    const refType = parseIntOr(getChildText(ref, 'type'), 1);
    let refText = getChildText(ref, 'content');
    if (refType !== 1 || LOOKS_LIKE_XML_RE.test(refText)) {
      const refLabel = TYPE_LABELS.get(refType) ?? '消息';
      refText = `[${refLabel}]`;
    }
    const quoteName = cleanText(getChildText(ref, 'displayname'), 40);
    const quoteBody = cleanText(refText, 120);
    return {
      kind: 'quote',
      text: title || '[引用]',
      quote: { name: quoteName, text: quoteBody },
    };
  }

  if (kind === 'file') {
    const attach = findDescendant(appmsg, 'appattach');
    const size = parseIntOr(getChildText(attach, 'totallen'), 0);
    return { kind: 'file', title: title || '[链接/文件]', size };
  }

  if (kind === 'transfer') {
    const pay = findDescendant(appmsg, 'wcpayinfo');
    const amount = cleanText(getChildText(pay, 'feedesc'), 30);
    const paySub = parseIntOr(getChildText(pay, 'paysubtype'), 0);
    const statusDesc = TRANSFER_DESC_BY_SUBTYPE.get(paySub) ?? '转账';
    return { kind: 'transfer', title: '微信转账', desc: statusDesc, amount };
  }

  if (kind === 'redpacket') {
    const pay = findDescendant(appmsg, 'wcpayinfo');
    const rawWish = getChildText(pay, 'sendertitle') || getChildText(pay, 'receivertitle');
    const wish = cleanText(rawWish, 40) || '恭喜发财，大吉大利';
    return { kind: 'redpacket', title: wish, desc: '微信红包' };
  }

  if (kind === 'channels') {
    const feed = findDescendant(appmsg, 'finderFeed');
    let feedTitle = title || '视频号';
    let feedDesc = desc;
    if (feed !== undefined) {
      feedTitle = cleanText(getChildText(feed, 'nickname'), 40) || title || '视频号';
      feedDesc = cleanText(getChildText(feed, 'desc'), 120);
    }
    return { kind: 'channels', title: feedTitle, desc: feedDesc, source: '视频号' };
  }

  if (kind === 'record') {
    //M 解析合并转发消息内的前几条聊天摘要。
    const items = extractRecordItems(appmsg);
    const view: MessageView = {
      kind: 'record',
      title: title || '聊天记录',
      desc: cleanText(desc, 120),
    };
    if (items.length > 0) {
      view.items = items;
    }
    return view;
  }

  let defaultTitle = title;
  if (kind === 'music' && defaultTitle === '') {
    defaultTitle = '音乐';
  }
  if (defaultTitle === '') {
    defaultTitle = '[链接/文件]';
  }

  const cardView: MessageView = {
    kind,
    title: defaultTitle,
    desc,
    source,
  };
  if (url !== '') {
    cardView.url = url;
  }
  if (thumburl !== '') {
    cardView.thumburl = thumburl;
  }
  return cardView;
}


/**
 * 构建动画表情（baseType=47）的气泡视图与内部下载参数。
 * @param content 表情消息 XML 正文。
 */
function buildEmojiView(content: string): MessageView {
  //M 提取表情宽高及内部 CDN/密钥元数据。
  const root = parseSafeXml(content);
  const emojiMeta: EmojiMediaMeta = {};
  const cdnurl = getTagAttr(root, 'emoji', 'cdnurl');
  const encrypturl = getTagAttr(root, 'emoji', 'encrypturl');
  const aeskey = getTagAttr(root, 'emoji', 'aeskey');
  const md5 = getTagAttr(root, 'emoji', 'md5');
  const thumburl = getTagAttr(root, 'emoji', 'thumburl');

  if (cdnurl !== '') {
    emojiMeta.cdnurl = cdnurl;
  }
  if (encrypturl !== '') {
    emojiMeta.encrypturl = encrypturl;
  }
  if (aeskey !== '') {
    emojiMeta.aeskey = aeskey;
  }
  if (md5 !== '') {
    emojiMeta.md5 = md5;
  }
  if (thumburl !== '') {
    emojiMeta.thumburl = thumburl;
  }

  const width = parseIntOr(getTagAttr(root, 'emoji', 'width'), 0);
  const height = parseIntOr(getTagAttr(root, 'emoji', 'height'), 0);
  const view: MessageView = { kind: 'emoji', width, height };
  if (emojiMeta.cdnurl !== undefined || emojiMeta.encrypturl !== undefined || emojiMeta.thumburl !== undefined) {
    view.media = { emoji: emojiMeta };
  }
  return view;
}


/**
 * 把单条微信消息（local_type + 去群前缀后的文本 + 发送者显示名 + 可选 packed）构建为气泡视图。
 * @param localType 数据库 local_type（支持 64 位复合子类型）。
 * @param text 已剥除群聊 `wxid:\n` 前缀后的消息内容。
 * @param sender 群聊解析出的发言人显示名；私聊或未知时传空串。
 * @param packed 可选的 packed_info_data 二进制列（图片 MD5 提取用）。
 * @param nameLookup 可选的 wxid -> 显示名查找函数（系统消息模板替换用）。
 * @returns 结构化 MessageView，绝不含未清洗的原始 XML。
 */
export function buildMessageView(
  localType: number | bigint,
  text: string,
  sender: string,
  packed?: Uint8Array | null,
  nameLookup?: (wxid: string) => string | undefined,
): MessageView {
  //M 拆出基础类型与子类型，系统消息和撤回提示优先直接返回（不挂群聊 sender）。
  const { baseType, subType } = splitMessageType(localType);
  if (baseType === 10000 || baseType === 10002) {
    return { kind: 'system', text: formatSystemText(text, nameLookup) };
  }

  let view: MessageView | undefined;
  if (baseType === 1) {
    view = { kind: 'text', text };
  }
  if (baseType === 3) {
    //M 提取图片候选 MD5 与缩略图宽高。
    const md5s = extractImageMd5s(text, packed);
    const root = parseSafeXml(text);
    const width = parseIntOr(getTagAttr(root, 'img', 'cdnthumbwidth'), 0);
    const height = parseIntOr(getTagAttr(root, 'img', 'cdnthumbheight'), 0);
    view = { kind: 'image', width, height };
    if (md5s.length > 0) {
      view.media = { image: md5s };
    }
  }
  if (baseType === 47) {
    //M 解析动画表情视图。
    view = buildEmojiView(text);
  }
  if (baseType === 34) {
    const root = parseSafeXml(text);
    const voiceMs = parseIntOr(getTagAttr(root, 'voicemsg', 'voicelength'), 0);
    view = { kind: 'voice', seconds: Math.round(voiceMs / 1000) };
  }
  if (baseType === 43) {
    const root = parseSafeXml(text);
    const seconds = parseIntOr(getTagAttr(root, 'videomsg', 'playlength'), 0);
    view = { kind: 'video', seconds };
  }
  if (baseType === 48) {
    const root = parseSafeXml(text);
    const label = cleanText(getTagAttr(root, 'location', 'label'), 120);
    const poiName = cleanText(getTagAttr(root, 'location', 'poiname'), 80);
    const title = poiName || cleanText(label, 80) || '位置';
    view = { kind: 'location', title, desc: label };
  }
  if (baseType === 42) {
    const root = parseSafeXml(text);
    const nickname = cleanText(getTagAttr(root, 'msg', 'nickname'), 40) || '名片';
    view = { kind: 'card', title: nickname, desc: '个人名片' };
  }
  if (baseType === 49) {
    //M 解析富媒体卡片；若是拍一拍系统变体则直接返回系统视图。
    const appView = buildAppMessageView(text, subType, nameLookup);
    if (appView.kind === 'system') return appView;
    view = appView;
  }
  if (baseType === 50) {
    const root = parseSafeXml(text);
    let rawCall = cleanText(getDescendantText(root, 'msg'));
    if (rawCall.startsWith('Duration:')) {
      const duration = rawCall.slice('Duration:'.length).trim();
      rawCall = `通话时长 ${duration}`;
    }
    const callText = CALL_STATUS_MAP.get(rawCall) ?? (rawCall || '语音通话');
    view = { kind: 'call', text: callText };
  }

  if (view === undefined) {
    const label = TYPE_LABELS.get(baseType) ?? '消息';
    view = { kind: 'other', text: `[${label}]` };
  }
  if (sender !== '') {
    view.sender = sender;
  }
  return view;
}


/**
 * 从消息表的 source（msgsource XML）提取被 @ 的 wxid 列表。
 * 没有 `<atuserlist>` 标签时返回 undefined（以便调用方退回正文推断），标签存在但为空时返回 `[]`。
 * @param sourceXml 解压后的 msgsource XML 字符串。
 */
export function parseAtUsersFromSource(sourceXml: string | undefined): string[] | undefined {
  if (sourceXml === undefined || sourceXml === '' || sourceXml.length > MAX_XML_LENGTH) return undefined;
  if (UNSAFE_XML_RE.test(sourceXml)) return undefined;

  const match = AT_USER_LIST_RE.exec(sourceXml);
  if (match === null) return undefined;

  const rawList = match[1] ?? '';
  return rawList
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}


/**
 * 转义正则表达式特殊字符，供按群昵称拼装 `@名字` 边界匹配。
 * @param literal 原始昵称文本。
 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}


/**
 * 从纯文本正文推断是否 `@我` 或 `@所有人`（微信 @ 后紧跟 `\u2005`、普通空白或句尾）。
 * @param text 已去掉群发送人前缀的消息正文。
 * @param atNames 本账号昵称及额外配置的群昵称列表。
 */
export function inferTextMentions(text: string, atNames: readonly string[]): { atMe: boolean; atAll: boolean } {
  if (text === '') return { atMe: false, atAll: false };

  const atAll = /@所有人(?:\u2005|\s|$)/u.test(text);
  for (const rawName of atNames) {
    const name = rawName.trim();
    if (name === '') {
      continue;
    }
    //M 严格校验 @名字 后面紧邻微信四分之一空格 \u2005、普通空白或行尾，避免前缀子串误判。
    const pattern = new RegExp(`@${escapeRegExp(name)}(?:\\u2005|\\s|$)`, 'u');
    if (pattern.test(text)) {
      return { atMe: true, atAll };
    }
  }
  return { atMe: false, atAll };
}


/**
 * 综合 msgsource XML 的 `<atuserlist>` 与文本正文判定群消息的 @ 标记。
 * 私聊一律不标 @；有 `<atuserlist>` 时严格以 XML 名单为准，无标签的文本消息才按昵称推断。
 * @param isGroup 是否为群聊会话。
 * @param localType 消息 local_type。
 * @param bodyText 去群前缀后的消息正文。
 * @param sourceXml 可选的解压后 msgsource XML。
 * @param selfWxid 当前登录微信号的 wxid。
 * @param atNames 用于正文推断的自身昵称与别名清单。
 */
export function getMentionFlags(
  isGroup: boolean,
  localType: number | bigint,
  bodyText: string,
  sourceXml: string | undefined,
  selfWxid: string,
  atNames: readonly string[],
): MentionFlags {
  if (!isGroup) return { atMe: false, atAll: false, atSource: '' };

  //M 优先采用微信 msgsource XML 里的精确 wxid 名单。
  const atUsers = parseAtUsersFromSource(sourceXml);
  if (atUsers !== undefined) {
    const atMe = selfWxid !== '' && atUsers.includes(selfWxid);
    const atAll = atUsers.includes(AT_ALL_WXID);
    return { atMe, atAll, atSource: 'atuserlist' };
  }

  //G 没有 XML 名单时，只有纯文本消息（baseType === 1）才根据正文里的 @昵称 推断。
  const { baseType } = splitMessageType(localType);
  if (baseType !== 1) return { atMe: false, atAll: false, atSource: '' };

  //M 按自身昵称和额外配置的群昵称检查正文。
  const inferred = inferTextMentions(bodyText, atNames);
  if (inferred.atMe || inferred.atAll) {
    return { atMe: inferred.atMe, atAll: inferred.atAll, atSource: 'text' };
  }
  return { atMe: false, atAll: false, atSource: '' };
}
