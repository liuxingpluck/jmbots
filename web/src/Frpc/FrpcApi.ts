/**
 * 外网隧道控制台（/frpc/）前端类型契约、HTTP 请求封装与校验纯函数。
 * 接口契约与后端 src7/plugins/frpc/ 严格对齐，统一复用 ../Api.ts 携带同源 Cookie 与访问令牌。
 */
import * as api from '../Api.ts';


/** 支持的隧道协议类型。 */
export type FrpcProtocol = 'http' | 'https' | 'tcp' | 'udp';

/** 进程控制动作。 */
export type FrpcControlAction = 'start' | 'stop' | 'restart';


/** 单条 [[proxies]] 端口映射规则。 */
export interface FrpcProxy {
  /** 规则唯一名称。 */
  name: string;
  /** 协议类型。 */
  type: FrpcProtocol;
  /** 本地源 IP（映射 30086 主站时须用局域网地址如 192.168.200.1）。 */
  localIP: string;
  /** 本地源端口（1..65535）。 */
  localPort: number;
  /** HTTP/HTTPS 绑定的自定义域名列表。 */
  customDomains?: string[];
  /** TCP/UDP 暴露在服务端的公网端口。 */
  remotePort?: number;
  /** HTTP/HTTPS 可选子域名前缀。 */
  subdomain?: string;
}


/** GET /api/frpc/status 返回的完整运行态与配置摘要（不含明文 token）。 */
export interface FrpcStatus {
  /** 是否找到并解析到有效 frpc.toml。 */
  configured: boolean;
  /** 客户端所在目录。 */
  dir: string;
  /** frpc.exe 进程是否存活。 */
  running: boolean;
  /** 隧道是否已成功连上远端 frps。 */
  connected: boolean;
  /** frpc.exe 进程号；未运行时为 0。 */
  pid: number;
  /** Windows 托盘守护脚本是否运行中。 */
  trayRunning: boolean;
  /** 托盘进程号；未运行时为 0。 */
  trayPid: number;
  /** Windows 开机自启脚本是否已开启。 */
  autoStart: boolean;
  /** 当前状态补充说明。 */
  detail: string;
  /** 状态采样时间文本。 */
  updatedAt: string;
  /** 远端 frps 服务器地址。 */
  serverAddr: string;
  /** 远端 frps 端口。 */
  serverPort: number;
  /** 客户端用户标识。 */
  user: string;
  /** 是否启用 TLS 传输加密。 */
  tlsEnabled: boolean;
  /** 是否已配置鉴权 Token（仅布尔值，绝不回传明文）。 */
  hasAuthToken: boolean;
  /** 推导出的公网快捷访问地址列表。 */
  publicUrls: string[];
  /** 当前全部隧道映射规则。 */
  proxies: FrpcProxy[];
}


/** GET /api/frpc/logs 返回结构。 */
export interface FrpcLogsResponse {
  ok: boolean;
  lines: string[];
  totalBytes: number;
  updatedAt: string;
}


/** 合法的协议枚举表。 */
export const FRPC_PROTOCOLS: readonly FrpcProtocol[] = ['http', 'https', 'tcp', 'udp'];


/**
 * 归一化单条隧道映射，过滤非法字段类型。
 */
function normalizeProxy(raw: Partial<FrpcProxy>): FrpcProxy {
  //M 校验协议枚举，无法识别时回退为 http。
  let proto: FrpcProtocol = 'http';
  if (raw.type === 'https' || raw.type === 'tcp' || raw.type === 'udp') {
    proto = raw.type;
  }
  const result: FrpcProxy = {
    name: String(raw.name ?? '').trim(),
    type: proto,
    localIP: String(raw.localIP ?? '').trim(),
    localPort: Number(raw.localPort ?? 0),
  };
  if (Array.isArray(raw.customDomains)) {
    const domains = raw.customDomains.map((item) => String(item).trim()).filter((item) => item !== '');
    if (domains.length > 0) result.customDomains = domains;
  }
  if (typeof raw.remotePort === 'number' && Number.isInteger(raw.remotePort) && raw.remotePort > 0) {
    result.remotePort = raw.remotePort;
  }
  if (typeof raw.subdomain === 'string' && raw.subdomain.trim() !== '') {
    result.subdomain = raw.subdomain.trim();
  }
  return result;
}


/**
 * 归一化后端返回的 FrpcStatus，防止缺省字段导致渲染异常。
 */
export function normalizeFrpcStatus(raw: Partial<FrpcStatus>): FrpcStatus {
  //M 确保数组字段始终是干净的数组实例。
  let publicUrls: string[] = [];
  if (Array.isArray(raw.publicUrls)) {
    publicUrls = raw.publicUrls.map((url) => String(url).trim()).filter((url) => url !== '');
  }
  let proxies: FrpcProxy[] = [];
  if (Array.isArray(raw.proxies)) {
    proxies = raw.proxies.map((item) => normalizeProxy(item));
  }
  return {
    configured: Boolean(raw.configured),
    dir: String(raw.dir ?? ''),
    running: Boolean(raw.running),
    connected: Boolean(raw.connected),
    pid: Number(raw.pid ?? 0),
    trayRunning: Boolean(raw.trayRunning),
    trayPid: Number(raw.trayPid ?? 0),
    autoStart: Boolean(raw.autoStart),
    detail: String(raw.detail ?? ''),
    updatedAt: String(raw.updatedAt ?? ''),
    serverAddr: String(raw.serverAddr ?? ''),
    serverPort: Number(raw.serverPort ?? 0),
    user: String(raw.user ?? ''),
    tlsEnabled: Boolean(raw.tlsEnabled),
    hasAuthToken: Boolean(raw.hasAuthToken),
    publicUrls,
    proxies,
  };
}


/**
 * 查询当前外网隧道状态与映射规则。
 */
export async function fetchFrpcStatus(): Promise<FrpcStatus> {
  //M 附带同源 Cookie 与可选 Bearer 令牌读取最新隧道状态。
  const raw = await api.getJson<Partial<FrpcStatus>>('/api/frpc/status', { credentials: 'same-origin' });
  return normalizeFrpcStatus(raw ?? {});
}


/**
 * 执行启动、停止或平滑重启隧道动作。
 * @param action 控制指令。
 */
export async function controlFrpc(
  action: FrpcControlAction,
): Promise<{ ok: boolean; status: FrpcStatus }> {
  //M 发送写请求切换隧道进程生命周期，并将返回状态归一化。
  const res = await api.sendJson<{ ok: boolean; status: Partial<FrpcStatus> }>(
    '/api/frpc/control',
    'POST',
    { action },
  );
  return { ok: Boolean(res.ok), status: normalizeFrpcStatus(res.status ?? {}) };
}


/**
 * 切换 Windows 开机自启开关。
 * @param enabled 是否启用开机自启。
 */
export async function setFrpcAutoStart(
  enabled: boolean,
): Promise<{ ok: boolean; autoStart: boolean }> {
  //M 调用后端开机自启接口创建或清理 Startup 目录下的无窗启动脚本。
  return api.sendJson<{ ok: boolean; autoStart: boolean }>(
    '/api/frpc/autostart',
    'POST',
    { enabled },
  );
}


/**
 * 保存全量 [[proxies]] 映射规则，可选保存后立即平滑重启。
 * @param proxies 完整规则列表。
 * @param restart 是否保存后重启隧道进程。
 */
export async function saveFrpcProxies(
  proxies: FrpcProxy[],
  restart = true,
): Promise<{ ok: boolean; status: FrpcStatus }> {
  //M 提交规则变更并无损回写 frpc.toml（后端自动保留头部注释与 auth.token）。
  const res = await api.sendJson<{ ok: boolean; status: Partial<FrpcStatus> }>(
    '/api/frpc/proxies',
    'PUT',
    { proxies, restart },
  );
  return { ok: Boolean(res.ok), status: normalizeFrpcStatus(res.status ?? {}) };
}


/**
 * 读取 frpc.log 末尾指定行数。
 * @param lines 行数（上限 500）。
 */
export async function fetchFrpcLogs(lines: number): Promise<FrpcLogsResponse> {
  //M 使用普通 GET 拉取末尾脱敏日志行。
  const safeLines = Math.max(20, Math.min(500, Math.trunc(lines)));
  const url = `/api/frpc/logs?lines=${String(safeLines)}`;
  const res = await api.getJson<Partial<FrpcLogsResponse>>(url, { credentials: 'same-origin' });
  let list: string[] = [];
  if (Array.isArray(res?.lines)) list = res.lines.map((line) => String(line));
  return {
    ok: Boolean(res?.ok ?? true),
    lines: list,
    totalBytes: Number(res?.totalBytes ?? 0),
    updatedAt: String(res?.updatedAt ?? ''),
  };
}


/**
 * 判断输入 IP 是否为本机环回地址（用于 30086 外网门禁防绕过校验）。
 * @param ip 待检主机名或 IP。
 */
export function isLoopbackIp(ip: string): boolean {
  const clean = ip.trim().toLowerCase();
  return clean === '127.0.0.1' || clean === 'localhost' || clean === '::1' || clean === '[::1]';
}


/**
 * 把逗号、空格或换行分隔的域名文本拆成去重域名数组。
 * @param raw 输入文本。
 */
export function parseDomainList(raw: string): string[] {
  //M 按逗号、空白切分并去重，剔除误填的协议前缀与尾部斜杠。
  const parts = raw.split(/[\s,，;；]+/u);
  const out: string[] = [];
  for (const part of parts) {
    const cleaned = part.trim().replace(/^https?:\/\//iu, '').replace(/\/+$/u, '');
    if (cleaned === '' || out.includes(cleaned)) continue;

    //M 收入去重清洗后的合法域名。
    out.push(cleaned);
  }
  return out;
}


/**
 * 校验单条待保存的隧道映射规则；合法返回空串，非法返回中文错误提示。
 * @param candidate 待校验规则。
 * @param existing 现有规则数组。
 * @param editIndex 编辑模式下原规则下标；新增模式传 -1。
 */
export function validateProxyCandidate(
  candidate: FrpcProxy,
  existing: readonly FrpcProxy[],
  editIndex: number,
): string {
  //G 逐项核对名称、唯一性、端口区间、30086 安全铁律与协议必填参数。
  const name = candidate.name.trim();
  if (name === '') return '请填写隧道名称（如 jmbots-web）';

  const duplicate = existing.some((item, idx) => idx !== editIndex && item.name === name);
  if (duplicate) return `隧道名称「${name}」已存在，请换一个唯一名称`;

  const ip = candidate.localIP.trim();
  if (ip === '') return '请填写本地源 IP 地址';

  const port = candidate.localPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return '本地端口必须是 1 到 65535 之间的整数';
  }
  //G 30086 主站端口禁止绑定本机环回 IP，防止外网流量绕过 AuthGate 门禁。
  if (port === 30086 && isLoopbackIp(ip)) {
    return '30086 主站端口禁止使用 127.0.0.1 / localhost，请改为局域网地址 192.168.200.1 以防绕过外网 AuthGate 登录门禁';
  }

  const isHttpLike = candidate.type === 'http' || candidate.type === 'https';
  if (isHttpLike) {
    const hasDomains = (candidate.customDomains?.length ?? 0) > 0;
    const hasSubdomain = (candidate.subdomain ?? '').trim() !== '';
    if (!hasDomains && !hasSubdomain) {
      return 'HTTP / HTTPS 隧道请至少填写一个绑定域名（customDomains）或子域名前缀（subdomain）';
    }
    return '';
  }

  const remotePort = candidate.remotePort ?? 0;
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    return 'TCP / UDP 隧道请填写 1 到 65535 之间的远端公网端口（remotePort）';
  }
  return '';
}


/**
 * 对单行 frpc.log 做轻量语义分类，供终端高亮成功、告警与错误行。
 * @param line 单行日志原文。
 */
export function classifyLogLine(line: string): 'ok' | 'err' | 'warn' | 'plain' {
  if (/\b(?:err|error|failed|panic|fatal)\b|\[E\]/iu.test(line)) return 'err';
  if (/\b(?:warn|warning|reconnect|try to connect)\b|\[W\]/iu.test(line)) return 'warn';
  if (/start proxy success|login to server success|\[I\].*success/iu.test(line)) return 'ok';

  return 'plain';
}


/**
 * 将字节数格式化为易读体积文本。
 * @param bytes 字节数。
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
