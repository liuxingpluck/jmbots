/**
 * 外网隧道（frpc）管理插件：提供状态巡检、无窗启停重启、Windows 开机自启开关、
 * [[proxies]] 无损可视化编辑与实时脱敏日志接口，驱动 /frpc/ 控制台页面。
 * 所有写接口（POST/PUT）强制经过 ctx.http.isVerified(request) 核验，绝不暴露 auth.token 明文。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as checksModule from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as filesModule from '../../utils/Files.ts';
import * as processModule from './Process.ts';
import * as tomlModule from './Toml.ts';

export type { FrpcProxy, FrpcProxyType } from './Toml.ts';
export type { FrpcControlAction, FrpcRunner, LiveFrpcState } from './Process.ts';


/** 插件名。 */
export const name = 'frpc';

//M 1.0.0：外网隧道（frpc）状态巡检、无窗进程控制、Windows 开机自启、TOML 代理无损回写与日志脱敏接口。
/** 插件版本号。 */
export const version = '1.0.0';

/** 依赖资源目录与主 HTTP 服务。 */
export const inject = ['resources', 'http'];


//==========================================================
// 前后端共享状态契约
//==========================================================

/** GET /api/frpc/status 与控制/保存回执统一返回的完整状态。 */
export interface FrpcStatus {
  /** 客户端目录下是否已有可读的 frpc.toml。 */
  configured: boolean;
  /** 当前生效的客户端目录绝对路径。 */
  dir: string;
  /** frpc.exe 进程是否存活。 */
  running: boolean;
  /** 隧道是否已成功连接远端服务器。 */
  connected: boolean;
  /** frpc.exe 进程 PID（未运行为 0）。 */
  pid: number;
  /** Windows 托盘常驻脚本是否存活。 */
  trayRunning: boolean;
  /** 托盘脚本进程 PID（未运行为 0）。 */
  trayPid: number;
  /** Windows Startup 目录是否已开启开机自启。 */
  autoStart: boolean;
  /** 当前状态简短描述。 */
  detail: string;
  /** 最近采样时间。 */
  updatedAt: string;
  /** 远端 frps 服务器地址。 */
  serverAddr: string;
  /** 远端 frps 端口。 */
  serverPort: number;
  /** 客户端用户标识。 */
  user: string;
  /** 是否开启 TLS 传输加密。 */
  tlsEnabled: boolean;
  /** 是否配置了非空 auth.token（绝不返回 token 明文）。 */
  hasAuthToken: boolean;
  /** 根据自定义域名推导出的公网快捷访问地址。 */
  publicUrls: string[];
  /** 当前配置的全部隧道映射。 */
  proxies: tomlModule.FrpcProxy[];
}

/** 插件可选配置项。 */
export interface FrpcConfig {
  /** 可选客户端目录路径；不配时默认自动定位 works/frp-clients/windows。 */
  dir?: string;
  /** 可选自定义进程执行器（供单测离线注入）。 */
  runner?: processModule.FrpcRunner;
}


//==========================================================
// 目录定位与入参核验
//==========================================================

/**
 * 解析 frpc 客户端目录：优先使用 config.dir，缺省时兼容运行版（往上两级）与源码开发版（往上三级）目录布局。
 * @param runtimeRoot ctx.resources.root 运行时根目录。
 * @param configuredDir 配置里可选指定的目录。
 * @returns 客户端目录绝对路径。
 */
export function resolveFrpcDir(runtimeRoot: string, configuredDir?: string): string {
  if (configuredDir !== undefined && configuredDir.trim() !== '') {
    return path.resolve(runtimeRoot, configuredDir.trim());
  }

  const twoUp = path.resolve(runtimeRoot, '..', '..', 'works', 'frp-clients', 'windows');
  if (fs.existsSync(twoUp)) return twoUp;

  const threeUp = path.resolve(runtimeRoot, '..', '..', '..', 'works', 'frp-clients', 'windows');
  if (fs.existsSync(threeUp)) return threeUp;

  return twoUp;
}


/**
 * 解析并校验插件配置。
 * @param raw config.yaml 中 plugins.frpc 的原始值。
 * @returns 规范化后的配置对象。
 */
function parsePluginConfig(raw: unknown): FrpcConfig {
  if (raw === undefined || raw === true) return {};

  const rec = checksModule.checkRecord(raw, 'plugins.frpc');
  const out: FrpcConfig = {};
  if (rec['dir'] !== undefined) {
    out.dir = checksModule.checkNonEmptyText(rec['dir'], 'plugins.frpc.dir');
  }
  if (rec['runner'] !== undefined && typeof rec['runner'] === 'object' && rec['runner'] !== null) {
    out.runner = rec['runner'] as processModule.FrpcRunner;
  }
  return out;
}


/**
 * 拦截未经 HTTP 身份核验的写操作请求。
 * @param ctx 插件上下文。
 * @param request Fastify 请求对象。
 */
function requireVerified(ctx: cordis.Context, request: fastify.FastifyRequest): void {
  if (ctx.http.isVerified(request)) return;

  throw new failureModule.Failure(403, '外网隧道写操作需要先完成身份核验');
}


/**
 * 校验请求体为普通对象。
 * @param body Fastify 解析后的 body。
 * @returns 键值对象。
 */
function readBodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new failureModule.Failure(400, '请求体必须是 JSON 对象');
  }
  return body as Record<string, unknown>;
}


/**
 * 解析日志查询行数（默认 120，上限 500）。
 * @param query Fastify 请求的查询参数。
 * @returns 1..500 的正整数。
 */
function parseLogLinesCount(query: unknown): number {
  if (typeof query !== 'object' || query === null) return 120;

  const raw = (query as Record<string, unknown>)['lines'];
  if (raw === undefined || raw === '') return 120;

  const text = String(raw).trim();
  if (!/^\d+$/u.test(text)) {
    throw new failureModule.Failure(400, 'lines 参数必须是正整数');
  }
  const count = Number(text);
  if (count < 1) {
    throw new failureModule.Failure(400, 'lines 参数必须大于等于 1');
  }
  return Math.min(count, 500);
}


/**
 * 汇总 TOML 配置、进程实时状态与开机自启状态，拼出完整 FrpcStatus。
 * @param dir 客户端目录。
 * @param runner 进程与自启执行器。
 * @returns 当前完整状态。
 */
export async function buildFrpcStatus(dir: string, runner: processModule.FrpcRunner): Promise<FrpcStatus> {
  const tomlPath = path.join(dir, 'frpc.toml');
  const live = await runner.readLiveState(dir);
  const autoStart = runner.readAutoStart();
  const stat = fs.statSync(tomlPath, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) {
    return {
      configured: false,
      dir,
      running: live.running,
      connected: false,
      pid: live.pid,
      trayRunning: live.trayRunning,
      trayPid: live.trayPid,
      autoStart,
      detail: '未找到 frpc.toml',
      updatedAt: live.updatedAt,
      serverAddr: '',
      serverPort: 0,
      user: '',
      tlsEnabled: false,
      hasAuthToken: false,
      publicUrls: [],
      proxies: [],
    };
  }

  const rawToml = fs.readFileSync(tomlPath, 'utf8');
  const parsed = tomlModule.parseFrpcToml(rawToml);
  const publicUrls = tomlModule.derivePublicUrls(parsed.proxies);
  return {
    configured: true,
    dir,
    running: live.running,
    connected: live.connected,
    pid: live.pid,
    trayRunning: live.trayRunning,
    trayPid: live.trayPid,
    autoStart,
    detail: live.detail,
    updatedAt: live.updatedAt,
    serverAddr: parsed.serverAddr,
    serverPort: parsed.serverPort,
    user: parsed.user,
    tlsEnabled: parsed.tlsEnabled,
    hasAuthToken: parsed.hasAuthToken,
    publicUrls,
    proxies: parsed.proxies,
  };
}


//==========================================================
// 插件入口与 HTTP 路由挂载
//==========================================================

/**
 * 挂载 frpc 插件并在 ctx.http.app 上登记 5 条管理路由。
 * @param ctx Cordis 插件上下文。
 * @param config 可选插件配置（dir、runner）。
 */
export function apply(ctx: cordis.Context, config?: unknown): void {
  const settings = parsePluginConfig(config);
  const dir = resolveFrpcDir(ctx.resources.root, settings.dir);
  const runner = settings.runner ?? processModule.createDefaultRunner();
  const app = ctx.http.app;

  //M 1. 读取完整隧道状态、配置摘要与公网快捷入口（不返回 auth.token 明文）。
  app.get('/api/frpc/status', async () => {
    return buildFrpcStatus(dir, runner);
  });

  //M 2. 控制隧道启动、停止或平滑重启（强制身份核验）。
  app.post('/api/frpc/control', async (request) => {
    requireVerified(ctx, request);
    const body = readBodyObject(request.body);
    const action = body['action'];
    if (action !== 'start' && action !== 'stop' && action !== 'restart') {
      throw new failureModule.Failure(400, 'action 必须是 start、stop 或 restart');
    }
    await runner.control(dir, action);
    const status = await buildFrpcStatus(dir, runner);
    return { ok: true, status };
  });

  //M 3. 切换 Windows 登录开机自动拉起托盘与隧道（强制身份核验）。
  app.post('/api/frpc/autostart', async (request) => {
    requireVerified(ctx, request);
    const body = readBodyObject(request.body);
    const enabled = body['enabled'];
    if (typeof enabled !== 'boolean') {
      throw new failureModule.Failure(400, 'enabled 必须是布尔值');
    }
    const autoStart = runner.writeAutoStart(dir, enabled);
    return { ok: true, autoStart };
  });

  //M 4. 校验并无损保存 [[proxies]] 隧道映射，可选平滑重启（强制身份核验）。
  app.put('/api/frpc/proxies', async (request) => {
    requireVerified(ctx, request);
    const body = readBodyObject(request.body);
    const proxies = tomlModule.validateProxies(body['proxies']);
    const rawRestart = body['restart'];
    if (rawRestart !== undefined && typeof rawRestart !== 'boolean') {
      throw new failureModule.Failure(400, 'restart 必须是布尔值');
    }

    const tomlPath = path.join(dir, 'frpc.toml');
    const stat = fs.statSync(tomlPath, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile()) {
      throw new failureModule.Failure(404, `未找到配置文件：${tomlPath}`);
    }

    //M 写入前先备份 frpc.toml.bak，再原子替换新内容，100% 保留头部注释与 token 配置。
    const originalToml = fs.readFileSync(tomlPath, 'utf8');
    const nextToml = tomlModule.rewriteFrpcTomlProxies(originalToml, proxies);
    const bakPath = path.join(dir, 'frpc.toml.bak');
    filesModule.writeTextAtomic(bakPath, originalToml, true);
    filesModule.writeTextAtomic(tomlPath, nextToml, false);

    if (rawRestart === true) {
      await runner.control(dir, 'restart');
    }
    const status = await buildFrpcStatus(dir, runner);
    return { ok: true, status };
  });

  //M 5. 读取末尾最多 500 行 frpc.log 并自动脱敏凭据字段。
  app.get('/api/frpc/logs', async (request) => {
    const maxLines = parseLogLinesCount(request.query);
    const logPath = path.join(dir, 'frpc.log');
    const tail = tomlModule.readTailLines(logPath, maxLines);
    return {
      ok: true,
      lines: tail.lines,
      totalBytes: tail.totalBytes,
      updatedAt: tail.updatedAt,
    };
  });
}
