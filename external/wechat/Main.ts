/**
 * 外置微信纯 Bun 独立收费插件入口（走 programs v1 生命周期协议 + 离线 Ed25519 授权门禁）。
 * 默认绑定 `127.0.0.1` 杜绝 Windows 防火墙弹窗，同时保留 `--host` 显式切换任意网卡或 `0.0.0.0`。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import * as util from 'node:util';
import * as sqlite from 'bun:sqlite';
import * as fastify from 'fastify';
import * as sendModule from './ApprovedSend.ts';
import * as embeddedPage from './EmbeddedPage.ts';
import * as kefu from './KefuRoutes.ts';
import * as licenseModule from './License.ts';
import * as protocol from './Protocol.ts';
import * as serviceModule from './ReaderService.ts';
import * as readOptions from './ReadOptions.ts';
import * as readRoutes from './ReadRoutes.ts';
import * as readerModule from './read/PureReader.ts';
import * as voiceModule from './read/VoiceCache.ts';
import * as web from './Web.ts';


/** 外置微信纯 Bun 插件当前版本号。 */
export const PLUGIN_VERSION = '1.0.0';

/** 默认监听地址（仅环回接口，不触发 Windows Defender 防火墙弹窗）。 */
export const DEFAULT_BIND_HOST = '127.0.0.1';

/** 进程标准身份回执对象。 */
export const PLUGIN_IDENTITY = {
  ok: true,
  name: 'wechat',
  protocol: protocol.PROTOCOL_VERSION,
  version: PLUGIN_VERSION,
} as const;


/** 渠道回调与可选外置发送配置。 */
export interface ChannelBridgeOptions {
  /** 宿主登记的渠道标识。 */
  channel: string;
  /** 宿主回调 URL 前缀。 */
  callback: string;
  /** 宿主下发的一次性通信密钥。 */
  key: string;
  /** 可选发送桥配置（默认关闭，只存草稿）。 */
  send: {
    enabled: boolean;
    ocr?: string;
    aobw?: string;
    lock?: string;
  };
}

/** 解析完成后的命令行运行模式与服务参数。 */
export type ParsedCliAction =
  | { mode: 'version' }
  | { mode: 'help' }
  | { mode: 'discover'; data: string; targetFolder: string }
  | { mode: 'connect'; data: string; targetFolder: string; pid?: number }
  | {
    mode: 'serve';
    data: string;
    engine: string;
    host: string;
    port: number;
    page?: string;
    licenseFile: string;
    licensePubkey?: string;
    read: { atNames: string; config: serviceModule.ReaderSettings };
    bridge?: ChannelBridgeOptions;
  };

/** 启动 HTTP 服务时允许单测注入的可选钩子。 */
export interface ServerRuntimeHooks {
  /** 可选自定义监听实现（单测验证 `--host 0.0.0.0` 透传而不触发宿主机防火墙弹窗）。 */
  listen?: (app: fastify.FastifyInstance, opts: { port: number; host: string }) => Promise<string>;
}


/**
 * 生成命令行 `--help` 中文说明文本。
 */
export function buildHelpText(): string {
  return [
    `jmbots-wechat v${PLUGIN_VERSION}（纯 Bun 微信客服收费插件，programs v1 协议）`,
    '',
    '用法：',
    '  jmbots-wechat --data <数据目录> [选项]',
    '  jmbots-wechat --data <数据目录> --discover <微信xwechat_files目录>',
    '  jmbots-wechat --data <数据目录> --connect <微信xwechat_files目录> [--pid <PID>]',
    '  jmbots-wechat --version | --help',
    '',
    '核心选项：',
    '  --data <目录>            独立进程数据与缓存目录（启动服务或账号管理必填）',
    '  --host <地址>            HTTP 绑定地址（默认 127.0.0.1，可显式传 0.0.0.0 或指定网卡 IP）',
    '  --port <端口>            HTTP 绑定端口（默认 0 由系统分配空闲端口）',
    '  --channel <渠道名>       主站 programs 登记的渠道名（配合宿主环境变量启用回调）',
    '  --license-file <路径>    Ed25519 离线许可证文件路径（默认 <data>/license.json）',
    '  --license-pubkey <公钥>  可选覆盖验签公钥（64 位十六进制或 PEM）',
    '  --interval-ms <毫秒>     后台轮询间隔（默认 3000，0 禁用轮询）',
    '  --chat-limit <数量>      单账号最近会话读取上限（默认 5000）',
    '  --at-names <昵称列表>    额外群提及昵称，逗号分隔',
    '  --archive-all            后台自动归档未监听会话',
  ].join('\n');
}


/**
 * 校验并解析命令行参数与宿主环境变量（读取一次性密钥后立即从 `env` 擦除）。
 * @param args 命令行参数数组（不含可执行文件前缀）。
 * @param env 进程环境变量对象（默认 `process.env`）。
 */
export function parseCliOptions(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): ParsedCliAction {
  const { values } = util.parseArgs({
    args,
    options: {
      version: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      data: { type: 'string' },
      engine: { type: 'string' },
      python: { type: 'string' },
      page: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string', default: '0' },
      channel: { type: 'string' },
      send: { type: 'boolean', default: false },
      'ocr-python': { type: 'string' },
      'aobw-url': { type: 'string' },
      'lock-file': { type: 'string' },
      'license-file': { type: 'string' },
      'license-pubkey': { type: 'string' },
      discover: { type: 'string' },
      connect: { type: 'string' },
      pid: { type: 'string' },
      ...readOptions.READ_FLAGS,
    },
  });

  if (values.version) return { mode: 'version' };
  if (values.help) return { mode: 'help' };

  if (!values.data || values.data.trim() === '') {
    throw new Error('微信独立进程需要 --data <隔离数据目录>');
  }
  const data = path.resolve(values.data);

  if (values.discover !== undefined) {
    if (values.discover.trim() === '') {
      throw new Error('--discover 需要指定微信存储目录');
    }
    return { mode: 'discover', data, targetFolder: path.resolve(values.discover) };
  }

  if (values.connect !== undefined) {
    if (values.connect.trim() === '') {
      throw new Error('--connect 需要指定微信存储目录');
    }
    let parsedPid: number | undefined;
    if (values.pid !== undefined) {
      const numPid = Number(values.pid);
      if (!/^\d+$/u.test(values.pid) || !Number.isSafeInteger(numPid) || numPid <= 0) {
        throw new Error('--pid 必须是正整数');
      }
      parsedPid = numPid;
    }
    return {
      mode: 'connect',
      data,
      targetFolder: path.resolve(values.connect),
      pid: parsedPid,
    };
  }

  const rawHost = values.host ?? env['JMBOTS_WECHAT_HOST'] ?? DEFAULT_BIND_HOST;
  const host = rawHost.trim();
  if (host === '' || /[\s\x00-\x1f]/u.test(host)) {
    throw new Error('--host 不能为空且不能包含空白或控制字符');
  }

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('--port 要是 0 至 65535 的整数');
  }

  const fallbackEngine = path.join(data, 'engine');
  const engine = path.resolve(values.engine ?? fallbackEngine);
  const licenseFile = path.resolve(values['license-file'] ?? path.join(data, 'license.json'));
  const licensePubkey = values['license-pubkey'] ?? env['JMBOTS_WECHAT_PUBKEY'];

  //M 校验轮询节拍与会话上限等读取端参数。
  const read = readOptions.getReadOptions(values);
  const channel = values.channel;
  if (channel !== undefined && !/^[a-z0-9-]+$/u.test(channel)) {
    throw new Error('--channel 要是渠道登记名');
  }

  //M 宿主密钥只供本进程内存持有，取出后立即从环境表移除。
  const key = env[protocol.KEY_ENV];
  const callback = env[protocol.CALLBACK_ENV];
  delete env[protocol.KEY_ENV];
  delete env[protocol.CALLBACK_ENV];

  if (channel === undefined && values.send) {
    throw new Error('--send 需要已登记的 --channel');
  }
  if (channel === undefined) {
    return {
      mode: 'serve',
      data,
      engine,
      host,
      port,
      page: values.page,
      licenseFile,
      licensePubkey,
      read,
    };
  }

  if (!key || !callback) {
    throw new Error('--channel 需要由已登记该渠道的 programs 启动');
  }

  const send = {
    enabled: values.send === true,
    ocr: values['ocr-python'],
    aobw: values['aobw-url'],
    lock: values['lock-file'],
  };
  return {
    mode: 'serve',
    data,
    engine,
    host,
    port,
    page: values.page,
    licenseFile,
    licensePubkey,
    read,
    bridge: { channel, callback, key, send },
  };
}


/**
 * 加载客服页单页 HTML：优先显式 `--page` 文件，其次单文件二进制内嵌 HTML，最后源码现场构建。
 * @param artifactPath 可选外部 HTML 文件路径。
 */
async function resolveKefuHtml(artifactPath?: string): Promise<string> {
  if (artifactPath !== undefined) {
    return fs.readFileSync(artifactPath, 'utf8');
  }
  //M 检查是否为 `bun build --compile` 预嵌入的单文件二进制。
  const embedded = embeddedPage.getEmbeddedKefuHtml();
  if (embedded !== undefined) {
    return embedded;
  }
  //M 源码开发模式下现场内联打包客服页。
  return await web.buildPage();
}


/**
 * 按给定服务配置启动外置微信 HTTP 服务、授权门禁与可选后台轮询。
 * @param options 已校验的 `serve` 配置。
 * @param hooks 可选测试监听注入。
 */
export async function startWechatServer(
  options: Extract<ParsedCliAction, { mode: 'serve' }>,
  hooks?: ServerRuntimeHooks,
): Promise<{ app: fastify.FastifyInstance; port: number; host: string; close: () => Promise<void> }> {
  //M 先初始化离线 Ed25519 许可证校验器（公钥格式错误在绑定端口前立即暴露）。
  const licenseGuard = new licenseModule.LicenseGuard({
    licenseFile: options.licenseFile,
    publicKey: options.licensePubkey,
  });
  const html = await resolveKefuHtml(options.page);

  fs.mkdirSync(options.data, { recursive: true });
  const messagesDir = path.join(options.data, 'message');
  const databasePath = path.join(options.data, 'wechat.db');
  const db = new sqlite.Database(databasePath);
  db.exec('PRAGMA journal_mode=WAL');

  const app = fastify.default({ logger: false, forceCloseConnections: true });
  const bridge = options.bridge;

  //M 最先挂载 `/jmbots/v1/license` 与全业务接口未授权门禁，确保未授权时一切业务调用统一 402 阻断。
  licenseGuard.mount(app, bridge?.key);

  //M 初始化 100% 纯 Bun 微信只读引擎、语音内存转码缓存与客服只读路由。
  const reader = new readerModule.Reader(options.data, options.read.atNames, undefined, options.engine);
  const voice = new voiceModule.VoiceAudio(reader, messagesDir);
  const service = new serviceModule.ReaderService(reader, db, options.read.config);
  readRoutes.mountReadRoutes(app, db, service, voice);

  app.addHook('onClose', async () => {
    //M HTTP 关闭前先等待进行中的数据库同步落盘。
    await service.drain();
  });

  const stopPoll = new AbortController();
  let pendingPoll: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  if (bridge !== undefined) {
    //M 挂载渠道入站队列、草稿回复与历史回调。
    service.connect(app, bridge.channel, bridge.callback, bridge.key);
  }

  let approvedSend: sendModule.ApprovedSend | undefined;
  if (bridge !== undefined) {
    let sender: sendModule.ExternalSender | undefined;
    if (bridge.send.enabled) {
      const { ocr, aobw, lock } = bridge.send;
      //M 显式启用 `--send` 时构建纯 HTTP 外置发送桥。
      sender = sendModule.createSender(options.engine, ocr, aobw, lock);
    }
    approvedSend = new sendModule.ApprovedSend(db, bridge.channel, reader, sender);
    //M 挂载经宿主审批的逐条发送接口。
    approvedSend.mount(app, bridge.key);
  }

  //M 挂载客服页能力查询、监听列表与 AI 起草入口。
  kefu.mountKefu(app, db, bridge);

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;

    closing = true;
    approvedSend?.stop();
    clearInterval(timer);
    stopPoll.abort();
    try {
      //M 先停止接收新的 HTTP 连接并等待在途请求收尾。
      await app.close();
    } finally {
      await Promise.allSettled([pendingPoll, approvedSend?.close()]);
      //M 待轮询与发件队列全部排空后关闭本地 SQLite 库。
      db.close();
    }
  };

  //M 挂载身份、健康检查与优雅退出管理接口。
  app.get('/jmbots/v1/info', () => {
    //M 实时返回当前协议身份与授权状态。
    const state = licenseGuard.getStatus().state;
    return {
      ...PLUGIN_IDENTITY,
      ui: '/',
      license: state,
      capabilities: [],
    };
  });
  //M 挂载轻量健康检查接口。
  app.get('/jmbots/v1/health', () => PLUGIN_IDENTITY);
  app.post('/jmbots/v1/exit', (request, reply) => {
    //G 由主程序拉起（登记了渠道、手里有宿主密钥）：只认带对 x-jmbots-key 的退出请求，本机别的进程关不掉它。
    //G   单独预览没有宿主密钥（没人能带），照旧放行，和 PUT /jmbots/v1/license 的规矩一样。
    const hostKey = bridge?.key;
    const given = request.headers[protocol.KEY_HEADER];
    if (hostKey !== undefined && !protocol.isSameKey(hostKey, given)) {
      return reply.code(401).send({ ok: false, error: '退出要带主程序给的密钥' });
    }

    //M 停发件队列，回完这条再关服务。
    approvedSend?.stop();
    reply.raw.once('finish', () => {
      void close();
    });
    return { ok: true };
  });

  //M 挂载单页客服工作台 HTML 入口。
  app.get('/', (_request, reply) => reply.type('text/html; charset=utf-8').send(html));
  const readOnly = (_request: fastify.FastifyRequest, reply: fastify.FastifyReply) => {
    //G 拒绝预览模式下的写请求与旧版直发入口。
    return reply.code(409).send({ error: '独立微信预览仅支持读消息' });
  };
  if (bridge === undefined) {
    //G 未登记渠道时禁止改动监听名单。
    app.put('/api/wechat-kefu/watch', readOnly);
  }
  app.post('/api/wechat-kefu/send', readOnly);

  try {
    let address: string;
    if (hooks?.listen !== undefined) {
      //M 测试钩子存在时委托注入的监听函数执行绑定。
      address = await hooks.listen(app, { port: options.port, host: options.host });
    }
    if (hooks?.listen === undefined) {
      //M 按配置的 host（默认 127.0.0.1）与端口正式启动 HTTP 监听。
      address = await app.listen({ port: options.port, host: options.host });
    }
    const port = Number(new URL(address!).port);
    const ready = {
      jmbots: PLUGIN_IDENTITY.protocol,
      event: 'ready',
      name: PLUGIN_IDENTITY.name,
      version: PLUGIN_IDENTITY.version,
      port,
    };
    console.log(JSON.stringify(ready));

    const backgroundReads = bridge !== undefined || service.config.archiveAll;
    if (backgroundReads && service.config.intervalMs > 0) {
      const tick = () => {
        if (pendingPoll !== undefined) return;

        //G 未授权或已过期时不后台读取微信数据库，仅记录明确未授权状态。
        const licStatus = licenseGuard.getStatus();
        if (licStatus.state !== 'licensed') {
          service.status.lastError = licStatus.reason ?? '未授权：请先配置有效的微信客服插件许可证';
          return;
        }

        pendingPoll = service.pollWatched(stopPoll.signal).catch(() => {
          if (stopPoll.signal.aborted) return;

          service.status.lastError = '外置微信未能完成后台读取或提交，稍后会重试';
        }).finally(() => {
          pendingPoll = undefined;
        });
      };
      timer = setInterval(tick, service.config.intervalMs);
    }
    return { app, port, host: options.host, close };
  } catch (error) {
    await close();
    throw error;
  }
}


/**
 * 执行完整 CLI 分发（供直接运行 `Main.ts` 及单文件编译入口 `Build.ts` 共用）。
 * @param args 命令行参数数组。
 */
export async function runCli(args: string[]): Promise<void> {
  //M 解析参数并根据子模式执行对应动作。
  const action = parseCliOptions(args);

  if (action.mode === 'version') {
    console.log(JSON.stringify({ ...PLUGIN_IDENTITY, engine: 'pure-bun' }));
    return;
  }
  if (action.mode === 'help') {
    console.log(buildHelpText());
    return;
  }
  if (action.mode === 'discover') {
    //M 纯 Bun 枚举微信账号目录并输出脱敏列表。
    const summary = readerModule.discoverAccountsToData(action.data, action.targetFolder);
    console.log(JSON.stringify({ ok: true, accounts: summary }));
    return;
  }
  if (action.mode === 'connect') {
    //M 按需惰性调用 Win32 FFI 提取微信进程密钥并保存 all_keys.json。
    const report = readerModule.connectAccountsToData(action.data, action.targetFolder, action.pid);
    const anyConnected = report.some((item) => item.status === 'connected');
    console.log(JSON.stringify({ ok: anyConnected, accounts: report }));
    if (!anyConnected) {
      globalThis.process.exitCode = 1;
    }
    return;
  }

  //M 默认进入守护进程模式监听 HTTP 生命周期与客服接口。
  const running = await startWechatServer(action);
  const onSignal = (): void => {
    void running.close();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
}


if (import.meta.main) {
  await runCli(process.argv.slice(2));
}
