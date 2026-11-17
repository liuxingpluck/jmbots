/**
 * 文件接口：上传、看文件、列目录。四个接口都登记在 ctx.http.app 上；令牌由 http 统一查（本机不查，别的机器要带）。
 * 能看的只有运行时目录下的 bots/、skills/、memory/、knowledge/（机器人的工作区在 bots/<机器人>/workspace/，也在里面）；
 * 文件名是 config.yaml、secrets.yaml、.env* 的永远不给，列目录时也不列。
 * 上传先放 data/tmp/uploads/<上传号>_<文件名>；web-api 发话时按上传号找到它、搬进机器人工作区。
 * 两个插件不互相调用，只共用这个目录。
 * 设计：docs/src7插件设计/files-api.md。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as streamPromises from 'node:stream/promises';
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as mime from '../../utils/Mime.ts';
import * as text from '../../utils/Text.ts';


/** 插件名。 */
export const name = 'files-api';

/** 用到的服务：http 的 app 登记接口；resources 拿运行时目录。 */
export const inject = ['http', 'resources'];


/** 任何情况下都不给看的文件名。 */
const SECRET_FILES = /^(config\.yaml|secrets\.yaml|\.env(\..*)?)$/iu;

/** 能看的目录：运行时目录下的这四个。 */
const ROOT_NAMES = ['bots', 'skills', 'memory', 'knowledge'];


/** 带状态码的错误：处理函数里抛它，answer 照状态码回 { error }。只在这个文件里用。 */
class Failure extends Error {
  /**
   * @param status HTTP 状态码。
   * @param message 回给网页的一句话。
   */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}


/** Range 请求头要的那一段，两头都含。 */
interface ByteRange {
  /** 从第几个字节开始。 */
  start: number;
  /** 到第几个字节为止（含）。 */
  end: number;
}


/** 文件接口。 */
class FilesApi {
  /** 运行时目录。 */
  private readonly root: string;

  /** 能看的四个目录的绝对路径：目录固定，构造时算一次。 */
  private readonly roots: string[];

  /**
   * 登记四个接口。http 等 ready 才开始监听，这时已经登记好了。
   * @param ctx Cordis 给这个插件的 ctx。
   * 副作用：在 ctx.http.app 上登记 PUT /api/uploads/:name、GET /api/files、GET /files/*、GET /api/files/list。
   */
  constructor(private readonly ctx: cordis.Context) {
    this.root = ctx.resources.root;
    this.roots = ROOT_NAMES.map((dir) => path.join(this.root, dir));
    const app = ctx.http.app;

    //M 上传单独一个 Fastify 作用域（register 开出来的子作用域，里面的设置不影响外面）：
    //M 先去掉继承来的 JSON、纯文字解析器，再让任何类型的请求体都原样是流，边收边写盘，大文件不进内存。
    //M 别的插件的 JSON 接口不受影响。
    app.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('*', (_request, payload, done) => {
        done(null, payload);
      });
      scope.put<{ Params: { name: string } }>('/api/uploads/:name', (request, reply) => {
        const body = request.body as NodeJS.ReadableStream | undefined;
        return this.answer(reply, () => this.upload(request.params.name, body));
      });
    });

    app.get<{ Querystring: { path?: unknown } }>('/api/files', (request, reply) => {
      return this.answer(reply, () => this.send(request.query.path, request, reply));
    });

    //M 路径相对运行时目录（用户 11-05：方便别的程序直接拿网址取），拼成绝对路径后和 /api/files 走同一条路。
    app.get<{ Params: { '*': string } }>('/files/*', (request, reply) => {
      const file = path.join(this.root, request.params['*']);
      return this.answer(reply, () => this.send(file, request, reply));
    });

    app.get<{ Querystring: { path?: unknown } }>('/api/files/list', (request, reply) => {
      return this.answer(reply, () => this.list(request.query.path));
    });
  }

  /**
   * 四个接口共用的出错处理：Failure 照它的状态码回，别的错误回 400（同 0.4），都是 { error: 一句话 }。
   * @param reply 回应。
   * @param work 这个接口真正要做的事。
   * @returns work 的结果；出错时是已经发出去的 reply。
   */
  private async answer(reply: fastify.FastifyReply, work: () => Promise<unknown>): Promise<unknown> {
    try {
      return await work();
    } catch (error) {
      const status = error instanceof Failure ? error.status : 400;
      return reply.code(status).send({ error: text.messageOf(error) });
    }
  }

  /**
   * PUT /api/uploads/:name：收下一个上传，写到 data/tmp/uploads/<上传号>_<文件名>。
   * @param raw 网址里的原文件名（Fastify 已经解开了 %xx）。
   * @param body 请求体的原始流；没有请求体时是 undefined。
   * @returns 上传号、清理过的文件名、字节数、附件类别。
   * 副作用：写一个暂存文件；发一个跟踪点。
   */
  private async upload(
    raw: string,
    body: NodeJS.ReadableStream | undefined,
  ): Promise<{ id: string; name: string; size: number; kind: mime.FileKind }> {
    //M 文件名整理成能落盘的样子（同 0.4）：超过 10 个字的不算扩展名，扩展名只留 [.\w-]；
    //M 主体去掉控制字符和 \/:*?"<>|，空白换成 _，截 60 字，去掉结尾的 . 和 _，空了叫“未命名”。
    const extension = path.extname(raw);
    const kept = extension.length <= 10 ? extension.replace(/[^.\w-]/gu, '') : '';
    const hasExtension = kept.length > 1;
    const stem = hasExtension ? raw.slice(0, -extension.length) : raw;
    const cleaned = [...stem]
      .filter((char) => char.charCodeAt(0) >= 32 && !'\\/:*?"<>|'.includes(char))
      .join('')
      .trim()
      .replace(/\s+/gu, '_')
      .slice(0, 60)
      .replace(/[._]+$/u, '');
    const name = `${cleaned === '' ? '未命名' : cleaned}${hasExtension ? kept : ''}`;

    //M 上传号：本地时间 yyyyMMddHHmmssSSS 加 3 位随机数，共 20 位（和 web-api 约定的）。
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
    const stamp = local.toISOString().replace(/\D/gu, '').slice(0, 17);
    const id = stamp + String(Math.floor(Math.random() * 1000)).padStart(3, '0');

    //M 有请求体就边收边写；没有就写一个空文件。
    const file = path.join(this.ctx.resources.dir('data', 'tmp', 'uploads'), `${id}_${name}`);
    if (body === undefined) {
      await fsp.writeFile(file, '');
    } else {
      await streamPromises.pipeline(body, fs.createWriteStream(file));
    }
    const size = (await fsp.stat(file)).size;

    //T 跟踪：收下一个上传。
    const vars = { 上传号: id, 文件名: name, 大小: size };
    this.ctx.emit('trace', 'FilesApi.upload', '收下一个上传，写进暂存目录', 'pipeline(body, createWriteStream(file))', vars);
    return { id, name, size, kind: mime.kindOf(name) };
  }

  /**
   * 回一个文件（GET /api/files、GET /files/* 共用）：支持 Range，网页里放音频、视频要用。
   * @param value 外面给的绝对路径。
   * @param request 请求：看 Range 请求头。
   * @param reply 回应。
   * @returns 发出去的 reply：整份 200、一段 206、超出文件 416，都是流。
   * @throws Failure：路径不对 400、不给看 403、没有这个文件 404。
   */
  private async send(
    value: unknown,
    request: fastify.FastifyRequest,
    reply: fastify.FastifyReply,
  ): Promise<fastify.FastifyReply> {
    const file = this.resolve(value);
    const stat = await fsp.stat(file).catch(() => undefined);
    if (stat?.isFile() !== true) throw new Failure(404, `没有这个文件：${file}`);

    const range = this.range(request.headers.range, stat.size);
    reply.header('Accept-Ranges', 'bytes').type(mime.typeOf(file));
    if (range === 'invalid') return reply.code(416).header('Content-Range', `bytes */${String(stat.size)}`).send();

    if (range !== undefined) {
      const contentRange = `bytes ${String(range.start)}-${String(range.end)}/${String(stat.size)}`;
      const length = range.end - range.start + 1;
      const part = fs.createReadStream(file, range);
      return reply.code(206).header('Content-Range', contentRange).header('Content-Length', length).send(part);
    }

    return reply.header('Content-Length', stat.size).send(fs.createReadStream(file));
  }

  /**
   * GET /api/files/list：列一个目录。
   * @param value 外面给的绝对路径。
   * @returns 每一项的名字、绝对路径、是不是文件夹、大小、修改时间；文件夹在前，再按名字（zh-CN）排；密钥文件不列。
   * @throws Failure：路径不对 400、不给看 403、没有这个目录 404。
   */
  private async list(
    value: unknown,
  ): Promise<{ name: string; path: string; dir: boolean; size: number; mtime: number }[]> {
    const dir = this.resolve(value);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) throw new Failure(404, `没有这个目录：${dir}`);

    //M 每项 stat 一次；stat 不出来（比如坏掉的链接）大小、修改时间记 0。
    const shown = entries.filter((entry) => !SECRET_FILES.test(entry.name));
    const items = await Promise.all(
      shown.map(async (entry) => {
        const full = path.join(dir, entry.name);
        const stat = await fsp.stat(full).catch(() => undefined);
        return {
          name: entry.name,
          path: full,
          dir: entry.isDirectory(),
          size: stat?.size ?? 0,
          mtime: stat?.mtimeMs ?? 0,
        };
      }),
    );
    return items.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'zh-CN'));
  }

  /**
   * 外面给的路径进来先过这里，只查这一次。
   * @param value 网址里的 path（/files/* 是拼好的绝对路径）。
   * @returns 规范化以后的绝对路径。
   * @throws Failure：不是绝对路径 400；是密钥文件、不在能看的四个目录里 403。
   */
  private resolve(value: unknown): string {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Failure(400, 'path 要是绝对路径');

    //G 密钥文件任何情况下都不给。
    const target = path.resolve(value);
    if (SECRET_FILES.test(path.basename(target))) throw new Failure(403, '这个文件不给看');

    //G 要在四个目录之一里面（含目录本身）：path.relative 不往上走、也不是另一个盘。
    const inside = this.roots.some((root) => {
      const relative = path.relative(root, target);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!inside) throw new Failure(403, `不在能看的范围里（运行时目录的 bots、skills、memory、knowledge）：${target}`);

    return target;
  }

  /**
   * 解析 Range 请求头：bytes=a-b、bytes=a-、bytes=-n 三种。
   * @param header 请求头的值。
   * @param size 文件大小。
   * @returns 要的那一段；没写或认不出是 undefined（给整份）；超出文件是 'invalid'（回 416）。
   */
  private range(header: string | undefined, size: number): ByteRange | 'invalid' | undefined {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(header?.trim() ?? '');
    const from = match?.[1] ?? '';
    const to = match?.[2] ?? '';
    if (from === '' && to === '') return undefined;

    //M bytes=-n 是最后 n 个字节；bytes=a- 到文件末尾；结束超出文件的截到末尾。
    const start = from === '' ? Math.max(0, size - Number(to)) : Number(from);
    const end = from === '' || to === '' ? size - 1 : Math.min(Number(to), size - 1);
    return start >= size || start > end ? 'invalid' : { start, end };
  }
}


/**
 * 挂上文件接口。
 * apply 是 Cordis 插件的入口：inject 里的 http、resources 都就绪后 Cordis 调一次。没有配置。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  new FilesApi(ctx);
}
