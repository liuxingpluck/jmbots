/**
 * 设置页的接口：看和改 config.yaml、新建机器人、重启。五条路径都登记在 ctx.http.app 上；令牌由 http 统一查。
 *   GET  /api/settings          白名单里的段，密钥换成代号
 *   PUT  /api/settings          照网页发来的改动改 config.yaml（注释、顺序都留着），重启后生效
 *   POST /api/bots              新建机器人：写进 bots 段（填了飞书再写 channels.feishu），建目录和记忆概要，当场加进名单
 *   POST /api/settings/apply    立即重启
 *   POST /api/service/restart   请基地重启（不是基地拉起的，同“立即重启”）
 * 骨架的 resources.raw 是启动时读的、只读，这里改的文件要重启才生效。
 * 设计：docs/src7插件设计/settings.md。
 */
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as configFile from './ConfigFile.ts';


/** 插件名。 */
export const name = 'settings';

/** 用到的服务。modelCatalog 是可选的，用 ctx.get 现取（写进 inject 就成了“必须有”）。 */
export const inject = ['resources', 'http', 'bots'];


/** model-catalog 里用到的：按“供应商/模型 ID”找。 */
interface CatalogLike {
  find(id: string): unknown;
}


/** 退出前等多久，让回应先发出去。 */
const EXIT_DELAY_MS = 300;
/** 源码模式重启时最多等 HTTP 关多久（毫秒）；在途的请求（比如网页长轮询）不等它们。 */
const CLOSE_WAIT_MS = 3000;

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
    this.file = new configFile.ConfigFile(path.join(ctx.resources.root, 'config.yaml'));
    const app = ctx.http.app;
    app.get('/api/settings', (_request, reply) => this.answer(reply, () => ({ config: this.file.masked() })));
    app.put<{ Body: unknown }>('/api/settings', (request, reply) => this.answer(reply, () => {
      const changed = this.file.edit(request.body);
      const count = Array.isArray(request.body) ? request.body.length : 0;

      //T 跟踪：存了配置（只带改了哪些段，不带值）。
      this.ctx.emit('trace', 'Settings.save', '改了 config.yaml', 'configFile.edit(edits)', { 段: changed.join('、'), 步数: count });
      return { ok: true, changed: count, note: `改了 ${changed.join('、')}：config.yaml 是启动时读的，重启后生效` };
    }));
    app.post<{ Body: unknown }>('/api/bots', (request, reply) => this.answer(reply, () => this.createBot(request.body)));
    app.post('/api/settings/apply', (_request, reply) => this.answer(reply, () => this.restart(false)));
    app.post('/api/service/restart', (_request, reply) => this.answer(reply, () => this.restart(true)));
  }

  /**
   * 五个接口共用的出错处理：Failure 照它的状态码回，别的回 400，都是 { error }。
   * @param reply 回应。
   * @param work 这个接口真正要做的事。
   */
  private async answer(reply: fastify.FastifyReply, work: () => unknown): Promise<unknown> {
    try {
      return await work();
    } catch (error) {
      const status = error instanceof configFile.Failure ? error.status : 400;
      return reply.code(status).send({ error: (error as Error).message });
    }
  }

  /**
   * POST /api/bots：新建机器人。
   * @param raw 请求体 { name, identity, language, model?, feishu?: { app_id, app_secret } }（外面进来的，这里校验一次）。
   * @returns { ok, bot: { name, language }, feishu?: 一句话 }。
   * @throws Failure(400)：名字不对、重名、模型不对、飞书只填一半或已被绑。
   */
  private createBot(raw: unknown): Record<string, unknown> {
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const botName = typeof body['name'] === 'string' ? body['name'].trim() : '';
    if (botName === '' || BAD_NAME.test(botName) || /[. ]$/u.test(botName)) {
      throw new configFile.Failure(400, '机器人名不能为空，不能有 \\ / < > : " | ? * 和控制字符，不能以点或空格结尾');
    }
    const document = this.file.read();
    const written = (document.toJSON() ?? {}) as Record<string, unknown>;
    const list = Array.isArray(written['bots']) ? (written['bots'] as { name?: unknown }[]) : [];
    if (list.some((item) => item.name === botName) || this.ctx.bots.get(botName) !== undefined) {
      throw new configFile.Failure(400, `已经有机器人「${botName}」了`);
    }
    const language = body['language'] ?? 'zh';
    if (language !== 'zh' && language !== 'en') throw new configFile.Failure(400, 'language 只能是 zh 或 en');

    const identity = typeof body['identity'] === 'string' ? body['identity'].trim() : '';
    const model = typeof body['model'] === 'string' ? body['model'].trim() : '';
    if (model !== '') this.checkModel(model);

    //M 飞书：两个都空当没填；只填一个、或这个应用已经绑给别的机器人 → 400。
    const feishu = (typeof body['feishu'] === 'object' && body['feishu'] !== null ? body['feishu'] : {}) as Record<string, unknown>;
    const appId = typeof feishu['app_id'] === 'string' ? feishu['app_id'].trim() : '';
    const appSecret = typeof feishu['app_secret'] === 'string' ? feishu['app_secret'].trim() : '';
    if ((appId === '') !== (appSecret === '')) throw new configFile.Failure(400, '飞书的 app_id 和 app_secret 要一起填');
    const channels = (written['channels'] ?? {}) as { feishu?: { app_id?: unknown }[] };
    const apps = Array.isArray(channels.feishu) ? channels.feishu : [];
    if (appId !== '' && apps.some((app) => app.app_id === appId)) throw new configFile.Failure(400, `飞书应用 ${appId} 已经绑给别的机器人了`);

    //M 写配置：bots 末尾加一项；填了飞书再往 channels.feishu 末尾加一项。
    const entry: Record<string, unknown> = { name: botName, language };
    if (model !== '') entry['model'] = model;
    const edits: configFile.Edit[] = [{ path: ['bots', list.length], value: entry }];
    if (appId !== '') edits.push({ path: ['channels', 'feishu', apps.length], value: { app_id: appId, app_secret: appSecret, bot: botName } });
    this.file.edit(edits);

    //M 记忆概要（照 0.4 的 src/capabilities/Files.ts:166-169）；已有就不动（flag 'wx' 是“没有才建”）。工作区、记忆目录由 bots.add 建。
    const bot = this.ctx.bots.add({ name: botName, language });
    const indexFile = path.join(bot.memory, language === 'en' ? 'index.md' : '索引.md');
    try {
      fs.writeFileSync(indexFile, memoryIndex(botName, language, identity, model), { encoding: 'utf8', flag: 'wx' });
    } catch {
      // 已经有了，不动。
    }

    //T 跟踪：建了机器人。
    this.ctx.emit('trace', 'Settings.createBot', '新建了机器人', 'bots.add({ name, language })', { 机器人: botName, 飞书: appId !== '' });
    const result: Record<string, unknown> = { ok: true, bot: { name: botName, language } };
    if (appId !== '') result['feishu'] = '飞书要重启后才连上：设置页点“立即重启”';
    return result;
  }

  /**
   * 核对模型：供应商要在 providers 里；挂了 model-catalog 的话，清单里要有它。
   * @param model 供应商名/模型 ID。
   * @throws Failure(400)。
   */
  private checkModel(model: string): void {
    const slash = model.indexOf('/');
    if (slash <= 0 || this.ctx.resources.config.providers[model.slice(0, slash)] === undefined) {
      throw new configFile.Failure(400, `模型 ${model} 的供应商不在 providers 里`);
    }
    const catalog = this.ctx.get('modelCatalog') as CatalogLike | undefined;
    if (catalog !== undefined && catalog.find(model) === undefined) throw new configFile.Failure(400, `模型清单里没有 ${model}`);
  }

  /**
   * 两个重启接口共用。
   * @param viaBase 是不是“请基地重启”。
   * @returns { ok, startedAt, note }。
   * @throws Failure(409)：已经在重启、基地不肯；Failure(503)：基地没响应。
   */
  private async restart(viaBase: boolean): Promise<Record<string, unknown>> {
    if (this.restarting) throw new configFile.Failure(409, '已经在重启了');

    const startedAt = await this.startedAt();
    const note = '正在重启：等 /api/ui/info 的 startedAt 变了就是新进程';

    //M 基地拉起的（有 JMBOTS_SUPERVISED）：请基地重启，或者自己退出由基地拉起新的。
    if (process.env['JMBOTS_SUPERVISED'] !== undefined) {
      //M 没挂基地服务或老基地不支持时，回退到本地退出，由守护进程拉起。
      if (viaBase && await this.askBase()) {
        this.restarting = true;
        return { ok: true, startedAt, note };
      }
      this.restarting = true;
      this.exitSoon('基地拉起的：退出后基地拉起新的');
      return { ok: true, startedAt, note };
    }

    //M 源码模式（bun src7/Main.ts）：先回应，再关掉自己的 HTTP 监听，再起一个一样的新进程（输出进 data/logs/restart.log），然后退出。
    //G 为什么先关监听再起新进程：Windows 上子进程会继承父进程的监听句柄，老进程退了端口还被新进程手里那个旧句柄占着，
    //G   新进程自己反而监听不上（实测 restart.log 一直“端口被占着”）。关掉以后再 spawn，就没有句柄可继承。
    this.restarting = true;
    this.exitSoon('源码模式：关掉监听、起新进程、自己退出', async () => {
      await Promise.race([this.ctx.http.app.close(), new Promise((resolve) => setTimeout(resolve, CLOSE_WAIT_MS))]);
      const log = fs.openSync(path.join(this.ctx.resources.dir('data', 'logs'), 'restart.log'), 'a');
      const child = childProcess.spawn(process.execPath, process.argv.slice(1), {
        cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env,
      });
      child.unref();
      fs.closeSync(log);
      //T 跟踪：新进程起了。
      this.ctx.emit('trace', 'Settings.restart', '起了新进程', 'childProcess.spawn(process.execPath, argv)', { 新进程: child.pid });
    });
    return { ok: true, startedAt, note };
  }

  /**
   * 请基地重启（POST <基地>/restart）。
   * @returns 基地答应了是 true；没挂基地服务或老基地返回 404 时是 false，退回本地退出。
   * @throws Failure(503)：基地没响应；Failure(409)：基地不肯。
   */
  private async askBase(): Promise<boolean> {
    //M 可选服务用时现取，不让基地依赖挡住读写设置、新建机器人等独立功能。
    const base = this.ctx.get('base');
    if (base === undefined) {
      return false;
    }
    let response: Awaited<ReturnType<typeof base.postJson>>;
    try {
      response = await base.postJson('/restart', {}, BASE_TIMEOUT_MS);
    } catch (error) {
      throw new configFile.Failure(503, (error as Error).message);
    }
    if (response.status === 404) return false;

    const answer = (response.body ?? {}) as { ok?: unknown; error?: unknown };
    if (answer.ok !== true) throw new configFile.Failure(409, typeof answer.error === 'string' ? answer.error : '基地没答应重启');
    return true;
  }

  /**
   * 过一会儿退出，让回应先发出去。
   * @param why 跟踪里写的原因。
   * @param before 退出前要做的事（源码模式：关监听、起新进程）；出错也照样退出。
   */
  private exitSoon(why: string, before?: () => Promise<void>): void {
    //T 跟踪：要重启了。
    this.ctx.emit('trace', 'Settings.restart', '要重启了', 'process.exit(0)', { 原因: why });
    setTimeout(() => {
      void (before?.() ?? Promise.resolve()).catch((error: unknown) => {
        this.ctx.emit('trace', 'Settings.restart', '退出前的事出错了', 'before()', { 错误: String(error) });
      }).finally(() => process.exit(0));
    }, EXIT_DELAY_MS);
  }

  /** @returns web-api 的 /api/ui/info 给的 startedAt（和网页拿到的是同一个数）；web-api 没挂是 0。 */
  private async startedAt(): Promise<number> {
    const response = await this.ctx.http.app.inject({ method: 'GET', url: '/api/ui/info' });
    if (response.statusCode !== 200) return 0;

    const info = JSON.parse(response.body) as { startedAt?: unknown };
    return typeof info.startedAt === 'number' ? info.startedAt : 0;
  }
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
    const who = identity === '' ? `I am ${botName}, a bot in jmbots. My identity is not set yet.` : `I am ${botName}, a bot in jmbots: ${identity}.`;
    return `# Who I am\n\n${who}${model === '' ? '' : ` I usually use ${model}.`}\n\n# What my memory covers\n\n(nothing yet)\n`;
  }
  const who = identity === ''
    ? `我是${botName}，jmbots 里的机器人。具体身份还没定——用户告诉我我是谁、做什么、平时用什么模型之后，我把它写在这一段。`
    : `我是${botName}，jmbots 里的机器人：${identity}。`;
  return `# 我是谁\n\n${who}${model === '' ? '' : `平时用 ${model}。`}\n\n# 记忆都涉及什么\n\n（还没有）\n`;
}


/**
 * 挂上设置页接口。
 * apply 是 Cordis 插件的入口：inject 里的 resources、http、bots 都就绪后 Cordis 调一次。没有配置。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  new Settings(ctx);
}
