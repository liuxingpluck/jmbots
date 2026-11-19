/**
 * 设置页的接口：看和改 config.yaml、新建机器人、重启。五条路径都登记在 ctx.http.app 上；令牌由 http 统一查。
 *   GET  /api/settings          白名单里的段，密钥换成代号
 *   PUT  /api/settings          照网页发来的改动改 config.yaml（注释、顺序都留着），重启后生效
 *   POST /api/bots              新建机器人：写进 bots 段（填了飞书再写 channels.feishu），建目录和记忆概要，当场加进名单
 *   POST /api/settings/apply    立即重启
 *   POST /api/service/restart   请基地重启（不是基地拉起的，同“立即重启”）
 * 骨架的 resources.raw 是启动时读的、只读，这里改的文件要重启才生效。
 * 设计见同目录 说明.md 的「设计要点」一节。
 */
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as configFile from './ConfigFile.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';


/** 插件名。 */
export const name = 'settings';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
export const version = '1.0.6';

/** 用到的服务：resources 读配置，http 登记路由，bots 查重。新建机器人和请基地重启走事件。 */
export const inject = ['resources', 'http', 'bots'];


/** 退出前等多久，让回应先发出去。 */
const EXIT_DELAY_MS = 300;
/** 源码模式重启时最多等 HTTP 关多久（毫秒）；在途的请求（比如网页长轮询）不等它们。 */
const HTTP_CLOSE_TIMEOUT_MS = 10_000;
/** 探活读取当前服务启动时间的最长等待。 */
const HTTP_INJECT_TIMEOUT_MS = 5000;
/** 校验模型目录的最长等待。 */
const CATALOG_TIMEOUT_MS = 3000;
/** 等待机器人登记回执。 */
const BOT_ADD_TIMEOUT_MS = 5000;

/** 请基地重启最多等多久。 */
const BASE_TIMEOUT_MS = 15_000;

/** 机器人名里不许有的字符（Windows 文件夹名不许用的，加控制字符）。 */
const BAD_NAME = /[\\/<>:"|?*\u0000-\u001f]/u;


/** 设置页接口。 */
class Settings {
  /** config.yaml。 */
  private readonly file: configFile.ConfigFile;

  /** 正在重启：防连点两次。 */
  private restarting = false;

  /**
   * 登记五条路径。
   * @param ctx Cordis 给这个插件的 ctx。
   */
  constructor(private readonly ctx: cordis.Context) {
    //M 构造运行时 config.yaml 处理器并把配置读写、建机器人及重启五条接口挂到 HTTP 服务上。
    this.file = new configFile.ConfigFile(path.join(ctx.resources.root, 'config.yaml'));
    const app = ctx.http.app;
    app.get('/api/settings', () => ({ config: this.file.masked() }));
    app.put<{ Body: unknown }>('/api/settings', (request) => {
      //M 校验并原子改写 config.yaml，拿到被修改的顶层段名用于返回值提示与跟踪记录。
      const changed = this.file.edit(request.body);
      let count = 0;
      if (Array.isArray(request.body)) {
        count = request.body.length;
      }

      //T 跟踪：存了配置（只带改了哪些段，不带值）。
      this.ctx.emit('trace', 'Settings.save', 'trace.settings.save', 'configFile.edit(edits)',
        { sections: changed.join('、'), stepCount: count });
      return { ok: true, changed: count, note: `改了 ${changed.join('、')}：config.yaml 是启动时读的，重启后生效` };
    });
    //M 登记新建机器人和重启接口，业务错误由 HTTP 插件统一返回。
    app.post<{ Body: unknown }>('/api/bots',
      (request) => this.createBot(request.body));
    app.post('/api/settings/apply', () => this.restart(false));
    app.post('/api/service/restart', () => this.restart(true));
  }

  /**
   * POST /api/bots：新建机器人。
   * @param raw 请求体 { name, identity, language, model?, feishu?: { app_id, app_secret } }（外面进来的，这里校验一次）。
   * @returns { ok, bot: { name, language }, feishu?: 一句话 }。
   * @throws Failure(400)：名字不对、重名、模型不对、飞书只填一半或已被绑。Failure(503)：配置已保存，运行时未确认登记。
   */
  private async createBot(raw: unknown): Promise<Record<string, unknown>> {
    //G 解析请求体并校验机器人名非空且不含文件夹禁用字符，避免后续建目录报错。
    const body = configFile.asRecord(raw);
    const botName = getTrimmed(body['name']);
    if (botName === '' || BAD_NAME.test(botName) || /[. ]$/u.test(botName)) {
      throw new failureModule.Failure(400, '机器人名不能为空，不能有 \\ / < > : " | ? * 和控制字符，不能以点或空格结尾');
    }

    //G 校验语言配置只允许 zh 或 en，供下面生成对应语言的记忆索引文件名。
    const language = body['language'] ?? 'zh';
    if (language !== 'zh' && language !== 'en') throw new failureModule.Failure(400, 'language 只能是 zh 或 en');

    //M 整理可选的身份文字，待创建记忆索引时使用。
    const identity = getTrimmed(body['identity']);

    //M 整理待校验的模型 ID。
    const model = getTrimmed(body['model']);
    if (model !== '') {
      //M 先等模型校验，再读改写配置，避免并发请求使用旧的追加下标。
      await this.checkModel(model);
    }

    //M 读出现有 config.yaml，供下面查重名和检查飞书应用占用情况。
    const document = this.file.read();
    const written = (document.toJSON() ?? {}) as Record<string, unknown>;
    let list: { name?: unknown }[] = [];
    if (Array.isArray(written['bots'])) {
      list = written['bots'] as { name?: unknown }[];
    }
    //G 同时比对配置文件与内存机器人表防止重名，命中则返回 400。
    if (list.some((item) => item.name === botName) || this.ctx.bots.get(botName) !== undefined) {
      throw new failureModule.Failure(400, `已经有机器人「${botName}」了`);
    }
    //M 飞书：两个都空当没填；只填一个、或这个应用已经绑给别的机器人 → 400。
    const feishu = configFile.asRecord(body['feishu']);
    const appId = getTrimmed(feishu['app_id']);
    const appSecret = getTrimmed(feishu['app_secret']);
    if ((appId === '') !== (appSecret === '')) throw new failureModule.Failure(400, '飞书的 app_id 和 app_secret 要一起填');
    const channels = (written['channels'] ?? {}) as { feishu?: { app_id?: unknown }[] };
    let apps: { app_id?: unknown }[] = [];
    if (Array.isArray(channels.feishu)) {
      apps = channels.feishu;
    }
    //G 校验要绑定的飞书 app_id 尚未被其他机器人占用，防止配置冲突。
    if (appId !== '' && apps.some((app) => app.app_id === appId)) {
      throw new failureModule.Failure(400, `飞书应用 ${appId} 已经绑给别的机器人了`);
    }

    //M 写配置：bots 末尾加一项；填了飞书再往 channels.feishu 末尾加一项。
    const entry: Record<string, unknown> = { name: botName, language };
    if (model !== '') entry['model'] = model;
    const edits: configFile.Edit[] = [{ path: ['bots', list.length], value: entry }];
    if (appId !== '') {
      edits.push({
        path: ['channels', 'feishu', apps.length],
        value: { app_id: appId, app_secret: appSecret, bot: botName },
      });
    }

    //M 先持久化新配置，登记事件失联时仍可在下次启动读取。
    this.file.edit(edits);

    const config = { name: botName, language };
    const request = { action: 'add', config } as const;
    const uncertain = `机器人「${botName}」的配置已保存，实时登记结果不确定。请核对机器人列表后再操作。`;
    const options = {
      timeoutMs: BOT_ADD_TIMEOUT_MS,
      onFallback: (reason: requestEventModule.FallbackReason, detail?: string) => {
        return { requestId: '', ok: false, error: detail ?? `机器人登记未获回执（${reason}）` };
      },
    };

    //M 让机器人插件按已保存的配置实时登记，并返回它分配的记忆目录。
    const added = await requestEventModule.requestEvent(this.ctx, 'bot/request', 'bot/result', request, options);
    const bot = added.bot;

    //G 失去回执时可能已登记，保留配置并提示核对。
    if (requestEventModule.isUnsure(added)) throw new failureModule.Failure(504, uncertain);

    //G 确定未登记时告诉调用者配置已保存，可重启生效。
    if (!added.ok || bot === undefined) {
      const reason = added.error ?? '未返回机器人信息';
      const error = `机器人「${botName}」的配置已保存，实时登记没办成：${reason}。请重启后生效。`;
      throw new failureModule.Failure(503, error);
    }

    //M 记忆概要只在还没有索引时写入，保留现有内容。
    let indexName = '索引.md';
    if (language === 'en') {
      indexName = 'index.md';
    }
    const indexFile = path.join(bot.memory, indexName);
    try {
      fs.writeFileSync(indexFile, memoryIndex(botName, language, identity, model), { encoding: 'utf8', flag: 'wx' });
    } catch {
      // 已经有了，不动。
    }

    //T 跟踪：建了机器人。
    this.ctx.emit('trace', 'Settings.createBot', 'trace.settings.createBot', 'bot/request add',
      { bot: botName, feishu: appId !== '' });
    const result: Record<string, unknown> = { ok: true, bot: { name: botName, language } };
    if (appId !== '') result['feishu'] = '飞书要重启后才连上：设置页点“立即重启”';
    return result;
  }

  /**
   * 核对模型：供应商要在 providers 里；模型清单应答时，清单里要有它。
   * @param model 供应商名/模型 ID。
   * @throws Failure(400)。
   */
  private async checkModel(model: string): Promise<void> {
    const slash = model.indexOf('/');
    //G 校验模型前缀对应的供应商已在 providers 中配置，否则回 400。
    if (slash <= 0 || this.ctx.resources.config.providers[model.slice(0, slash)] === undefined) {
      throw new failureModule.Failure(400, `模型 ${model} 的供应商不在 providers 里`);
    }
    const lookup = { action: 'find', model } as const;
    const options = {
      timeoutMs: CATALOG_TIMEOUT_MS,
      onFallback: () => ({ requestId: '' }),
    };

    //M 通过事件核对模型。没有应答时沿用只查供应商的行为。
    const result = await requestEventModule.requestEvent(
      this.ctx,
      'model-catalog/request',
      'model-catalog/result',
      lookup,
      options,
    );
    if (result.requestId === '') return;

    //G 收到明确回执时，未找到的模型仍回 400。
    if (result.info === undefined) throw new failureModule.Failure(400, `模型清单里没有 ${model}`);
  }

  /**
   * 两个重启接口共用。
   * @param viaBase 是不是“请基地重启”。
   * @returns { ok, startedAt, note }。
   * @throws Failure(409)：已经在重启、基地不肯；Failure(503)：探活或基地请求失败。
   */
  private async restart(viaBase: boolean): Promise<Record<string, unknown>> {
    //G 防前端重复点击并发触发两次重启，正在重启时直接回 409。
    if (this.restarting) throw new failureModule.Failure(409, '已经在重启了');

    //M 在等待事件前占住重启入口，失败时允许前端重试。
    this.restarting = true;
    try {
      //M 读取当前进程启动时间，供前端轮询确认新进程接管。
      const startedAt = await this.startedAt();
      const note = '重启请求已受理。等 /api/ui/info 的 startedAt 变化再确认新进程已接管';

      //M 基地拉起的进程由基地接管，显式请求基地重启时等它答复。
      if (process.env['JMBOTS_SUPERVISED'] !== undefined) {
        if (viaBase) {
          //M 只有基地确认后才提示重启已经开始。
          await this.askBase();
          return { ok: true, startedAt, note };
        }

        //M 回应发出后退出，交给基地拉起新进程。
        this.exitSoon('基地拉起的：退出后基地拉起新的');
        return { ok: true, startedAt, note };
      }

      //M 源码模式先回应，再关 HTTP 监听，避免 Windows 子进程继承监听句柄。
      this.exitSoon('源码模式：关掉监听、起新进程、自己退出', async () => {
        //M 等 HTTP 放手后才能拉起新进程。
        await this.closeHttp();

        //M 为新进程定位重启日志目录。
        const logDir = this.ctx.resources.ensureRuntimeDir('data', 'logs');
        const logPath = path.join(logDir, 'restart.log');
        const args = process.argv.slice(1);
        const cwd = process.cwd();
        const log = fs.openSync(logPath, 'a');
        try {
          const options: childProcess.SpawnOptions = {
            cwd,
            detached: true,
            windowsHide: true,
            stdio: ['ignore', log, log],
            env: process.env,
          };

          //M 沿用当前命令启动新进程，日志写到运行时目录。
          const child = childProcess.spawn(process.execPath, args, options);
          child.unref();

          //T 跟踪：新进程起了。
          const vars = { processId: child.pid };
          this.ctx.emit('trace', 'Settings.restart', 'trace.settings.spawn', 'childProcess.spawn(process.execPath, argv)', vars);
        } finally {
          fs.closeSync(log);
        }
      });
      return { ok: true, startedAt, note };
    } catch (error) {
      //G 基地可能已开始重启时保留占用，防止前端重复发起。
      if (!(error instanceof failureModule.Failure) || error.status !== 504) {
        this.restarting = false;
      }
      throw error;
    }
  }

  /**
   * 关闭 HTTP，确认关完才允许启动替代进程。
   * @throws 无人处理、关闭失败或结果不确定时停止重启。
   */
  private async closeHttp(): Promise<void> {
    const request = { action: 'close' } as const;
    const options = {
      timeoutMs: HTTP_CLOSE_TIMEOUT_MS,
      onFallback: (reason: requestEventModule.FallbackReason, detail?: string) => {
        return { requestId: '', ok: false, error: detail ?? reason };
      },
    };

    //M 只发一次关闭请求。十秒内未确认时，保留尚在关闭的原进程。
    const result = await requestEventModule.requestEvent(this.ctx, 'http/request', 'http/result', request, options);
    if (result.ok) return;

    //G 未开始关闭，允许 HTTP 插件恢复后重新申请。
    if (result.fallback === 'unhandled') {
      this.restarting = false;
      throw new Error('无人处理 HTTP 关闭请求');
    }

    //G 接单状态未知时保留停止占用，并报告事件失败原因。
    if (requestEventModule.isUnsure(result)) throw new Error(`HTTP 关闭结果不确定（${result.error}）`);

    //G 处理方已开始关闭但等待到期，同样无法确认监听是否已释放。
    if (result.error === '等待 HTTP 关闭超时') throw new Error('HTTP 关闭结果不确定，请核对运行状态');

    //G HTTP 没有确认释放端口时，不启动替代进程。
    throw new Error(result.error ?? 'HTTP 未确认关闭');
  }

  /**
   * 通过 base/request 请基地重启，等待其明确答复。
   * @returns 基地确认重启后结束等待。
   * @throws Failure(503)：本地提交失败。Failure(504)：结果不确定。Failure(409)：基地不肯。
   */
  private async askBase(): Promise<void> {
    const request = { method: 'POST', route: '/restart', body: {}, timeoutMs: BASE_TIMEOUT_MS } as const;
    const uncertain = '基地重启结果不确定。请核对服务的启动时间后再操作。';
    const options = {
      timeoutMs: BASE_TIMEOUT_MS + 1000,
      onFallback: (reason: requestEventModule.FallbackReason, detail?: string) => {
        return { requestId: '', ok: false, error: detail ?? `基地重启未获回执（${reason}）` };
      },
    };

    //M 等待基地完成请求，预留一秒用于返回连接错误。
    const response = await requestEventModule.requestEvent(this.ctx, 'base/request', 'base/result', request, options);

    //G 基地可能已收到请求，超时或响应中断时保留占用。
    if (requestEventModule.isUnsure(response) || response.error === '基地没响应') {
      throw new failureModule.Failure(504, uncertain);
    }

    //G 无人接单或本地明确失败时结束请求，允许修复后重试。
    if (!response.ok || response.status === undefined) {
      throw new failureModule.Failure(503, response.error ?? '基地未返回重启结果');
    }

    const answer = (response.body ?? {}) as { ok?: unknown; error?: unknown };
    let reason = `基地没答应重启（HTTP ${String(response.status)}）`;
    if (typeof answer.error === 'string') {
      reason = answer.error;
    }
    //G 基地明确拒绝重启时抛出 409 并透传基地返回的拒绝原因给前端。
    if (response.status < 200 || response.status >= 300 || answer.ok !== true) {
      throw new failureModule.Failure(409, reason);
    }
  }

  /**
   * 过一会儿退出，让回应先发出去。
   * @param why 跟踪里写的原因。
   * @param before 退出前必须完成的事。源码模式先关闭监听，再起新进程。
   */
  private exitSoon(why: string, before?: () => Promise<void>): void {
    //T 跟踪：要重启了。
    this.ctx.emit('trace', 'Settings.restart', 'trace.settings.restart', 'process.exit(0)', { reason: why });
    setTimeout(() => {
      //M 只有重启前置步骤完成才退出。关闭未确认时保留进程并记下原因。
      void Promise.resolve().then(before).then(() => {
        process.exit(0);
      }).catch((error: unknown) => {
        const vars = { reason: String(error) };
        this.ctx.emit('trace', 'Settings.restart', 'trace.settings.restartCancelled', 'before()', vars);
      });
    }, EXIT_DELAY_MS);
  }

  /**
   * @returns /api/ui/info 的 startedAt，接口未登记或没有该字段时返回 0。
   * @throws Failure(503)：HTTP 插件未应答或注入失败。
   */
  private async startedAt(): Promise<number> {
    const request = { action: 'inject', method: 'GET', url: '/api/ui/info' } as const;
    const options = {
      timeoutMs: HTTP_INJECT_TIMEOUT_MS,
      onFallback: (reason: requestEventModule.FallbackReason, detail?: string) => ({
        requestId: '',
        ok: false,
        error: detail ?? `读取服务启动时间失败（${reason}）`,
      }),
    };

    //M 通过 HTTP 插件读取用于判断重启是否完成的启动时间。
    const response = await requestEventModule.requestEvent(this.ctx, 'http/request', 'http/result', request, options);
    if (!response.ok) throw new failureModule.Failure(503, response.error ?? '读取服务启动时间失败');
    if (response.statusCode !== 200 || response.body === undefined) return 0;

    //M 成功探活但旧接口没返回启动时间时，保留原来的 0。
    const info = JSON.parse(response.body) as { startedAt?: unknown };
    if (typeof info.startedAt === 'number') return info.startedAt;

    return 0;
  }
}



/** 取出去掉两头空白的字符串；不是字符串给空串。 */
function getTrimmed(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();

  return '';
}


/**
 * 新机器人的记忆概要（照 0.4 的 src/capabilities/Files.ts:166-169）。
 * @param botName 机器人名。
 * @param language zh 或 en。
 * @param identity 填的身份，可以是空。
 * @param model 平时用的模型，可以是空。
 */
function memoryIndex(botName: string, language: string, identity: string, model: string): string {
  if (language === 'en') {
    let who = `I am ${botName}, a bot in jmbots. My identity is not set yet.`;
    if (identity !== '') {
      who = `I am ${botName}, a bot in jmbots: ${identity}.`;
    }
    let modelNote = '';
    if (model !== '') {
      modelNote = ` I usually use ${model}.`;
    }
    return `# Who I am\n\n${who}${modelNote}\n\n# What my memory covers\n\n(nothing yet)\n`;
  }
  let who = `我是${botName}，jmbots 里的机器人。具体身份还没定——用户告诉我我是谁、做什么、平时用什么模型之后，我把它写在这一段。`;
  if (identity !== '') {
    who = `我是${botName}，jmbots 里的机器人：${identity}。`;
  }
  let modelNote = '';
  if (model !== '') {
    modelNote = `平时用 ${model}。`;
  }
  return `# 我是谁\n\n${who}${modelNote}\n\n# 记忆都涉及什么\n\n（还没有）\n`;
}


/**
 * 挂上设置页接口。
 * apply 是 Cordis 插件的入口：inject 里的 resources、http、bots 都就绪后 Cordis 调一次。没有配置。
 * @param ctx Cordis 给这个插件的 ctx。
 * 副作用：实例化 `Settings` 并向 `ctx.http.app` 挂载五条设置、机器人与重启接口。
 */
export function apply(ctx: cordis.Context): void {
  //M 实例化设置服务，向 HTTP 路由挂接配置读写、建机器人与重启五条接口。
  new Settings(ctx);
}
