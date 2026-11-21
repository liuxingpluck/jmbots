/**
 * frpc.toml 无损解析、隧道映射校验、代理段落局部回写与日志脱敏。
 * 绝不向外暴露 auth.token 明文；回写 [[proxies]] 时 100% 原样保留头部注释、鉴权、TLS 与日志配置。
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as checksModule from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as textModule from '../../utils/Text.ts';


//==========================================================
// 共享契约类型
//==========================================================

/** 支持的四类 frpc 代理协议。 */
export type FrpcProxyType = 'http' | 'https' | 'tcp' | 'udp';

/** 单条 frpc 隧道映射定义（前后端共享契约）。 */
export interface FrpcProxy {
  /** 隧道唯一名称。 */
  name: string;
  /** 转发协议类型。 */
  type: FrpcProxyType;
  /** 本机或局域网源地址（映射 30086 严禁用 127.0.0.1/localhost）。 */
  localIP: string;
  /** 本机源端口（1..65535）。 */
  localPort: number;
  /** HTTP/HTTPS 绑定的自定义域名列表。 */
  customDomains?: string[];
  /** TCP/UDP 远端暴露端口（1..65535）。 */
  remotePort?: number;
  /** HTTP/HTTPS 可选子域名。 */
  subdomain?: string;
}

/** 从 frpc.toml 提取的脱敏摘要（不含 auth.token 明文）。 */
export interface ParsedFrpcToml {
  /** 远端 frps 服务器地址。 */
  serverAddr: string;
  /** 远端 frps 控制端口。 */
  serverPort: number;
  /** 客户端用户标识。 */
  user: string;
  /** 是否开启 transport.tls.enable。 */
  tlsEnabled: boolean;
  /** 是否已配置非空 auth.token。 */
  hasAuthToken: boolean;
  /** 解析出的全部隧道映射。 */
  proxies: FrpcProxy[];
}

/** 解析 [[proxies]] 过程中的可变草稿。 */
interface ProxyDraft {
  name?: string;
  type?: FrpcProxyType;
  localIP?: string;
  localPort?: number;
  customDomains?: string[];
  remotePort?: number;
  subdomain?: string;
}


/** 合法协议集合。 */
const VALID_TYPES: readonly FrpcProxyType[] = ['http', 'https', 'tcp', 'udp'];

/** frpc 隧道不写 localIP 时它自己用的源地址。 */
const FRPC_DEFAULT_LOCAL_IP = '127.0.0.1';

/** 30086 回环地址拦截提示语。 */
export const LOOPBACK_30086_ERROR =
  '30086 端口映射禁止使用 127.0.0.1/localhost，请使用局域网地址 192.168.200.1 以防绕过外网 AuthGate 登录门禁';

/** 现有 frpc.toml 含高级字段时拒绝覆盖提示语。 */
export const UNSUPPORTED_TOML_ERROR =
  '现有 frpc.toml 含控制台暂不支持的高级字段，请手改文件避免丢失';

/** 控制台支持无损编辑的 [[proxies]] 白名单键名。 */
const ALLOWED_PROXY_KEYS = new Set([
  'name',
  'type',
  'localIP',
  'localIp',
  'localPort',
  'customDomains',
  'subdomain',
  'remotePort',
]);


//==========================================================
// TOML 词法与无损解析
//==========================================================

/**
 * 剥离 TOML 单行中位于引号之外的 # 注释。
 * @param line 原始单行文本。
 * @returns 去掉行尾注释后的文本。
 */
function stripTomlComment(line: string): string {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inDouble && ch === '\\') {
      escaped = true;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inDouble && !inSingle && ch === '#') return line.slice(0, i);
  }
  return line;
}


/**
 * 解析单个 TOML 字符串字面量（双引号或单引号）。
 * @param raw 去首尾空白后的字面量。
 * @returns 字符串值；不是字符串字面量时回 undefined。
 */
function parseTomlString(raw: string): string | undefined {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);

  return undefined;
}


/**
 * 解析 TOML 字符串数组（如 ["a.example.com", "b.example.com"]）。
 * @param raw 去首尾空白后的数组字面量。
 * @returns 字符串列表；格式不对回 undefined。
 */
function parseTomlStringArray(raw: string): string[] | undefined {
  if (!raw.startsWith('[') || !raw.endsWith(']')) return undefined;

  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];

  //M 按引号状态切分逗号项，防止字符串内部字符干扰。
  const parts: string[] = [];
  let start = 0;
  let inQuotes = false;
  let quoteChar = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inQuotes && ch === quoteChar && inner[i - 1] !== '\\') {
      inQuotes = false;
      continue;
    }
    if (!inQuotes && (ch === '"' || ch === "'")) {
      inQuotes = true;
      quoteChar = ch;
      continue;
    }
    if (!inQuotes && ch === ',') {
      parts.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(inner.slice(start).trim());

  const result: string[] = [];
  for (const part of parts) {
    if (part === '') continue;

    const str = parseTomlString(part);
    if (str !== undefined && str.trim() !== '') {
      result.push(str.trim());
    }
  }
  return result;
}


/**
 * 校验并收敛草稿为正式 FrpcProxy。
 * @param draft 解析到的段落字段。
 * @returns 字段齐全时返回 FrpcProxy，残缺段落返回 undefined。
 */
function finalizeDraft(draft: ProxyDraft): FrpcProxy | undefined {
  if (draft.name === undefined || draft.name === '') return undefined;
  if (draft.type === undefined) return undefined;
  if (draft.localPort === undefined || draft.localPort <= 0) return undefined;

  //M 没写 localIP 时 frpc 自己按 127.0.0.1 转发；照实记成回环地址，读状态的告警才看得见，不悄悄丢掉这条隧道。
  let localIP = FRPC_DEFAULT_LOCAL_IP;
  if (draft.localIP !== undefined && draft.localIP !== '') {
    localIP = draft.localIP;
  }

  const proxy: FrpcProxy = {
    name: draft.name,
    type: draft.type,
    localIP,
    localPort: draft.localPort,
  };
  if (draft.customDomains !== undefined && draft.customDomains.length > 0) {
    proxy.customDomains = draft.customDomains;
  }
  if (draft.remotePort !== undefined && draft.remotePort > 0) {
    proxy.remotePort = draft.remotePort;
  }
  if (draft.subdomain !== undefined && draft.subdomain !== '') {
    proxy.subdomain = draft.subdomain;
  }
  return proxy;
}


/**
 * 把一行键值写入当前 [[proxies]] 草稿。
 * @param draft 当前代理草稿。
 * @param key 键名。
 * @param valText 等号右侧原文。
 */
function applyProxyField(draft: ProxyDraft, key: string, valText: string): void {
  const str = parseTomlString(valText);
  if (key === 'name' && str !== undefined) {
    draft.name = str.trim();
    return;
  }
  if (key === 'type' && str !== undefined) {
    const normalized = str.trim().toLowerCase() as FrpcProxyType;
    if (VALID_TYPES.includes(normalized)) {
      draft.type = normalized;
    }
    return;
  }
  if ((key === 'localIP' || key === 'localIp') && str !== undefined) {
    draft.localIP = str.trim();
    return;
  }
  if (key === 'subdomain' && str !== undefined) {
    draft.subdomain = str.trim();
    return;
  }
  if (key === 'localPort' && /^\d+$/u.test(valText)) {
    draft.localPort = Number(valText);
    return;
  }
  if (key === 'remotePort' && /^\d+$/u.test(valText)) {
    draft.remotePort = Number(valText);
    return;
  }
  if (key === 'customDomains') {
    const domains = parseTomlStringArray(valText);
    if (domains !== undefined) {
      draft.customDomains = domains;
    }
  }
}


/**
 * 解析 frpc.toml 文本，提取连接摘要与 [[proxies]] 列表，绝不带出 auth.token 明文。
 * @param raw frpc.toml 原文（兼容 UTF-8 BOM 与点分键/表头两种写法）。
 * @returns 脱敏后的结构化配置。
 */
export function parseFrpcToml(raw: string): ParsedFrpcToml {
  const clean = raw.replace(/^\uFEFF/u, '');
  const lines = clean.split(/\r?\n/u);
  let section = '';
  let currentProxy: ProxyDraft | undefined;
  const drafts: ProxyDraft[] = [];

  let serverAddr = '';
  let serverPort = 0;
  let user = '';
  let tlsEnabled = false;
  let hasAuthToken = false;

  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim();
    if (line === '') continue;

    //M 识别 [[proxies]] 数组表头。
    if (/^\[\[\s*proxies\s*\]\]$/u.test(line)) {
      section = '[[proxies]]';
      currentProxy = {};
      drafts.push(currentProxy);
      continue;
    }

    //M 识别其他数组表头或普通表头（如 [auth]、[transport.tls]）。
    const arrayHeader = /^\[\[\s*([^\]]+?)\s*\]\]$/u.exec(line);
    if (arrayHeader !== null) {
      section = `[[${(arrayHeader[1] ?? '').trim()}]]`;
      currentProxy = undefined;
      continue;
    }
    const tableHeader = /^\[\s*([^\]]+?)\s*\]$/u.exec(line);
    if (tableHeader !== null) {
      section = (tableHeader[1] ?? '').trim();
      currentProxy = undefined;
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = line.slice(0, eqIndex).trim();
    const valText = line.slice(eqIndex + 1).trim();
    if (currentProxy !== undefined) {
      applyProxyField(currentProxy, key, valText);
      continue;
    }

    //M 顶层或普通表头下的全局字段统一拼成点分键名。
    let fullKey = key;
    if (section !== '' && !section.startsWith('[[')) {
      fullKey = `${section}.${key}`;
    }
    const strVal = parseTomlString(valText);
    if (fullKey === 'serverAddr' && strVal !== undefined) {
      serverAddr = strVal.trim();
      continue;
    }
    if (fullKey === 'serverPort' && /^\d+$/u.test(valText)) {
      serverPort = Number(valText);
      continue;
    }
    if (fullKey === 'user' && strVal !== undefined) {
      user = strVal.trim();
      continue;
    }
    if (fullKey === 'transport.tls.enable') {
      tlsEnabled = valText === 'true';
      continue;
    }
    if (fullKey === 'auth.token' && strVal !== undefined && strVal.trim() !== '') {
      hasAuthToken = true;
    }
  }

  const proxies: FrpcProxy[] = [];
  for (const draft of drafts) {
    const item = finalizeDraft(draft);
    if (item !== undefined) {
      proxies.push(item);
    }
  }
  return { serverAddr, serverPort, user, tlsEnabled, hasAuthToken, proxies };
}


//==========================================================
// 隧道映射严格校验与无损回写
//==========================================================

/**
 * 严格白名单核验主站端口映射源地址：仅允许标准点分十进制非回环、非全零 IPv4 地址，
 * 彻底封死 ::、::ffff:127.0.0.1、localhost.、0x7f.0.0.1、八进制或整数 IP 等全部绕过写法。
 * @param host 待检 localIP。
 * @returns 允许映射返回 true。
 */
export function isAllowedServerMapIp(host: string): boolean {
  const trimmed = host.trim();
  if (!net.isIPv4(trimmed)) return false;

  return !/^(127\.|0\.)/u.test(trimmed);
}


/**
 * 判断一条隧道是不是把主站端口接到了不许的源地址：PUT 校验和读状态告警共用这一个判断。
 * @param localIP 隧道源地址。
 * @param localPort 隧道源端口。
 * @param guardedPort 主站 HTTP 监听端口（随 server.port）。
 * @returns true 表示外网请求会被当成本机请求，绕过登录门禁。
 */
export function isUnsafeGuardedProxy(localIP: string, localPort: number, guardedPort: number): boolean {
  const isGuardedPort = localPort === 30086 || localPort === guardedPort;
  if (!isGuardedPort) return false;

  return !isAllowedServerMapIp(localIP);
}


/**
 * 读状态时核对 frpc.toml 里现有的隧道：有人手改接了回环地址，控制台要看得出来。
 * @param proxies 从 frpc.toml 解析出的隧道。
 * @param guardedPort 主站 HTTP 监听端口。
 * @returns 每条不安全隧道一句告警；都安全时是空数组。
 */
export function getProxyWarnings(proxies: FrpcProxy[], guardedPort: number): string[] {
  const warnings: string[] = [];
  for (const proxy of proxies) {
    const unsafe = isUnsafeGuardedProxy(proxy.localIP, proxy.localPort, guardedPort);
    if (!unsafe) continue;

    warnings.push(`隧道 ${proxy.name}：${LOOPBACK_30086_ERROR}`);
  }
  return warnings;
}


/** 合法端口号范围（1..65535 整数）。 */
const PORT_RULE: checksModule.NumberRule = { integer: true, min: 1, max: 65535 };


/**
 * 校验自定义域名数组，拒绝含引号、斜杠或空白的非法输入以防 TOML 注入。
 * @param raw customDomains 原始值。
 * @param proxyName 所属隧道名。
 * @returns 过滤空串后的合法域名列表；未提供时返回 undefined。
 */
function checkCustomDomains(raw: unknown, proxyName: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new failureModule.Failure(400, `隧道 ${proxyName} 的 customDomains 要写成字符串数组`);
  }

  const domains: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new failureModule.Failure(400, `隧道 ${proxyName} 的域名必须是字符串`);
    }
    const trimmed = item.trim();
    if (trimmed === '') continue;
    if (!/^[A-Za-z0-9.*-]+$/u.test(trimmed)) {
      throw new failureModule.Failure(400, `隧道 ${proxyName} 的域名格式不合法：${trimmed}`);
    }
    domains.push(trimmed);
  }
  return domains;
}


/**
 * 严格校验 PUT /api/frpc/proxies 提交的整套隧道配置。
 * @param raw 请求体里的 proxies 字段。
 * @param guardedPort 主站 HTTP 监听端口（默认 30086，随 server.port 注入同步保护）。
 * @returns 规范化后的 FrpcProxy 列表。
 */
export function validateProxies(raw: unknown, guardedPort = 30086): FrpcProxy[] {
  //G 外层必须是数组。
  if (!Array.isArray(raw)) {
    throw new failureModule.Failure(400, 'proxies 要写成数组');
  }

  const seenNames = new Set<string>();
  const result: FrpcProxy[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    const tag = `proxies[${String(i)}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new failureModule.Failure(400, `${tag} 要写成对象`);
    }

    const rec = item as Record<string, unknown>;
    const rawName = rec['name'];
    if (typeof rawName !== 'string' || rawName.trim() === '' || /[\r\n"'\\]/u.test(rawName)) {
      throw new failureModule.Failure(400, `${tag}.name 要填写不含引号或换行的非空名称`);
    }
    const name = rawName.trim();
    if (seenNames.has(name)) {
      throw new failureModule.Failure(400, `隧道名称不能重复：${name}`);
    }
    seenNames.add(name);

    const rawType = rec['type'];
    if (typeof rawType !== 'string' || !VALID_TYPES.includes(rawType as FrpcProxyType)) {
      throw new failureModule.Failure(400, `隧道 ${name} 的 type 必须是 http、https、tcp 或 udp`);
    }
    const type = rawType as FrpcProxyType;

    const rawIp = rec['localIP'];
    if (typeof rawIp !== 'string' || rawIp.trim() === '' || /[\s"'\\]/u.test(rawIp.trim())) {
      throw new failureModule.Failure(400, `隧道 ${name} 的 localIP 不能为空且不能含空白或引号`);
    }
    const localIP = rawIp.trim();
    const localPort = checksModule.checkNumber(rec['localPort'], `隧道 ${name} 的 localPort`, PORT_RULE);

    //G 安全铁律：主站端口映射强制走严格 IPv4 非回环白名单，防止外网流量变成 isLocal 免登录请求。
    const unsafe = isUnsafeGuardedProxy(localIP, localPort, guardedPort);
    if (unsafe) {
      throw new failureModule.Failure(400, LOOPBACK_30086_ERROR);
    }

    const proxy: FrpcProxy = { name, type, localIP, localPort };
    if (type === 'http' || type === 'https') {
      const domains = checkCustomDomains(rec['customDomains'], name);
      const rawSub = rec['subdomain'];
      let subdomain = '';
      if (typeof rawSub === 'string' && rawSub.trim() !== '') {
        subdomain = rawSub.trim();
        if (!/^[A-Za-z0-9-]+$/u.test(subdomain)) {
          throw new failureModule.Failure(400, `隧道 ${name} 的 subdomain 格式不合法：${subdomain}`);
        }
      }
      const hasDomains = domains !== undefined && domains.length > 0;
      if (!hasDomains && subdomain === '') {
        throw new failureModule.Failure(400, `隧道 ${name} (${type.toUpperCase()}) 至少要填写 customDomains 或 subdomain`);
      }
      if (hasDomains) {
        proxy.customDomains = domains;
      }
      if (subdomain !== '') {
        proxy.subdomain = subdomain;
      }
      result.push(proxy);
      continue;
    }

    //M TCP / UDP 隧道必须给合法 remotePort。
    const remoteLabel = `隧道 ${name} (${type.toUpperCase()}) 的 remotePort`;
    const remotePort = checksModule.checkNumber(rec['remotePort'], remoteLabel, PORT_RULE);
    proxy.remotePort = remotePort;
    result.push(proxy);
  }

  return result;
}


/**
 * 将单条 FrpcProxy 序列化为标准 [[proxies]] TOML 段落行。
 * @param proxy 已通过校验的隧道对象。
 * @returns 行数组。
 */
function formatProxyBlock(proxy: FrpcProxy): string[] {
  const lines = [
    '[[proxies]]',
    `name = ${JSON.stringify(proxy.name)}`,
    `type = ${JSON.stringify(proxy.type)}`,
    `localIP = ${JSON.stringify(proxy.localIP)}`,
    `localPort = ${String(proxy.localPort)}`,
  ];
  if (proxy.customDomains !== undefined && proxy.customDomains.length > 0) {
    const items = proxy.customDomains.map((domain) => JSON.stringify(domain)).join(', ');
    lines.push(`customDomains = [${items}]`);
  }
  if (proxy.subdomain !== undefined && proxy.subdomain !== '') {
    lines.push(`subdomain = ${JSON.stringify(proxy.subdomain)}`);
  }
  if (proxy.remotePort !== undefined) {
    lines.push(`remotePort = ${String(proxy.remotePort)}`);
  }
  return lines;
}


/**
 * 无损替换 frpc.toml 中的 [[proxies]] 段落，100% 原样保留顶部注释、auth.token、TLS 与 log 配置。
 * @param originalToml 原 frpc.toml 全文。
 * @param proxies 已校验通过的新隧道列表。
 * @returns 更新后的完整 TOML 文本。
 */
export function rewriteFrpcTomlProxies(originalToml: string, proxies: FrpcProxy[]): string {
  let bom = '';
  let body = originalToml;
  if (body.startsWith('\uFEFF')) {
    bom = '\uFEFF';
    body = body.slice(1);
  }
  let eol = '\r\n';
  if (!body.includes('\r\n') && body.includes('\n')) {
    eol = '\n';
  }

  //M 逐行扫描：拦截原 [[proxies]] 中任何控制台暂不支持的高级字段、子表或跨行数组，防静默丢失。
  const rawLines = body.split(/\r?\n/u);
  const keptLines: string[] = [];
  let pendingComments: string[] = [];
  let inProxyBlock = false;

  for (const rawLine of rawLines) {
    const cleaned = stripTomlComment(rawLine).trim();
    if (/^\[\[?\s*proxies\s*\./iu.test(cleaned)) {
      throw new failureModule.Failure(409, UNSUPPORTED_TOML_ERROR);
    }
    if (/^\[\[\s*proxies\s*\]\]$/u.test(cleaned)) {
      inProxyBlock = true;
      pendingComments = [];
      continue;
    }
    if (inProxyBlock && /^\[.+\]$/u.test(cleaned)) {
      inProxyBlock = false;
      keptLines.push(...pendingComments);
      pendingComments = [];
    }
    if (!inProxyBlock) {
      keptLines.push(rawLine);
      continue;
    }
    if (cleaned === '') {
      pendingComments.push(rawLine);
      continue;
    }
    pendingComments = [];
    const eqIndex = cleaned.indexOf('=');
    if (eqIndex <= 0) {
      throw new failureModule.Failure(409, UNSUPPORTED_TOML_ERROR);
    }
    const key = cleaned.slice(0, eqIndex).trim();
    const valText = cleaned.slice(eqIndex + 1).trim();
    if (!ALLOWED_PROXY_KEYS.has(key) || valText === '') {
      throw new failureModule.Failure(409, UNSUPPORTED_TOML_ERROR);
    }
    if (valText.startsWith('"""') || valText.startsWith("'''") || valText.startsWith('{')) {
      throw new failureModule.Failure(409, UNSUPPORTED_TOML_ERROR);
    }
    if (key === 'customDomains' && parseTomlStringArray(valText) === undefined) {
      throw new failureModule.Failure(409, UNSUPPORTED_TOML_ERROR);
    }
  }

  //M 去掉末尾多余空行，再统一追加格式化后的 [[proxies]] 段落。
  while (keptLines.length > 0 && (keptLines[keptLines.length - 1] ?? '').trim() === '') {
    keptLines.pop();
  }

  const proxyBlocks: string[] = [];
  for (const proxy of proxies) {
    proxyBlocks.push(formatProxyBlock(proxy).join(eol));
  }

  if (proxyBlocks.length === 0) return `${bom}${keptLines.join(eol)}${eol}`;

  const head = keptLines.join(eol);
  if (head === '') return `${bom}${proxyBlocks.join(`${eol}${eol}`)}${eol}`;

  return `${bom}${head}${eol}${eol}${proxyBlocks.join(`${eol}${eol}`)}${eol}`;
}


//==========================================================
// 公网快捷地址推导与日志安全脱敏
//==========================================================

/**
 * 根据 HTTP/HTTPS 隧道的 customDomains 推导公网快捷入口地址。
 * @param proxies 当前配置的隧道列表。
 * @returns 去重后的公网 URL 列表。
 */
export function derivePublicUrls(proxies: FrpcProxy[]): string[] {
  const seen = new Set<string>();
  for (const proxy of proxies) {
    if (proxy.type !== 'http' && proxy.type !== 'https') continue;
    if (proxy.customDomains === undefined) continue;

    for (const domain of proxy.customDomains) {
      if (proxy.localPort === 30086) {
        seen.add(`https://${domain}/work-decision/`);
        seen.add(`https://${domain}/knowledge/`);
        seen.add(`https://${domain}/tutorial/`);
        seen.add(`https://${domain}/wechat-kefu/`);
        seen.add(`https://${domain}/graph/`);
        seen.add(`https://${domain}/memory/`);
        seen.add(`https://${domain}/frpc/`);
        seen.add(`https://${domain}/`);
        continue;
      }
      seen.add(`https://${domain}/`);
    }
  }
  return [...seen];
}


const SECRET_KV_PATTERN = new RegExp(
  '(["\']?\\b(?:auth\\.token|[A-Za-z0-9_]*token|credentials?|password|passwd|secret)\\b["\']?)'
    + '(\\s*[=:]\\s*)("[^"]*"|\'[^\']*\'|[^\\s,;}\\]]+)',
  'giu',
);

/**
 * 脱敏单行日志中可能出现的 token、authToken、auth.token、credential、password 或 Bearer 凭据（兼容 JSON 引号键）。
 * @param line 原始日志行。
 * @returns 脱敏后的安全日志行。
 */
export function redactLogLine(line: string): string {
  const maskedKV = line.replace(SECRET_KV_PATTERN, '$1$2"***"');
  return maskedKV.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu, '$1***');
}


/** 读取日志尾部时的最大单次字节窗口（256 KB 足够容纳逾千行日志）。 */
const MAX_LOG_TAIL_BYTES = 256 * 1024;


/**
 * 读取 frpc.log 末尾至多 maxLines 行并逐行脱敏。
 * @param filePath 日志文件绝对路径。
 * @param maxLines 最多返回的行数（调用方已限制 1..500）。
 * @returns 脱敏行数组、文件总字节数与最近更新时间。
 */
export function readTailLines(
  filePath: string,
  maxLines: number,
): { lines: string[]; totalBytes: number; updatedAt: string } {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) {
    return { lines: [], totalBytes: 0, updatedAt: '' };
  }

  const totalBytes = stat.size;
  const updatedAt = textModule.formatLocalTime(stat.mtimeMs, 'date');
  if (totalBytes === 0) {
    return { lines: [], totalBytes: 0, updatedAt };
  }

  //M 大日志文件只从末尾窗口截读，避免把整份几兆日志读进内存。
  const readBytes = Math.min(totalBytes, MAX_LOG_TAIL_BYTES);
  const offset = totalBytes - readBytes;
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(readBytes);
  try {
    fs.readSync(fd, buf, 0, readBytes, offset);
  } finally {
    fs.closeSync(fd);
  }

  let chunk = buf.toString('utf8').replace(/^\uFEFF/u, '');
  if (offset > 0) {
    const firstNewline = chunk.indexOf('\n');
    if (firstNewline >= 0) {
      chunk = chunk.slice(firstNewline + 1);
    }
  }

  const rawLines = chunk.split(/\r?\n/u);
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }
  const sliced = rawLines.slice(-maxLines).map((line) => redactLogLine(line));
  return { lines: sliced, totalBytes, updatedAt };
}
