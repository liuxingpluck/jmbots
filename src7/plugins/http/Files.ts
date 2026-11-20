/**
 * 文件接口：上传、看文件、列目录。四个接口都登记在 http 的 app 上；令牌由 http 统一查（本机不查，别的机器要带）。
 * 能看的只有运行时目录下的 bots/、skills/、memory/、knowledge/（机器人的工作区在 bots/<机器人>/workspace/，也在里面）；
 * 文件名是 config.yaml、secrets.yaml、.env* 的永远不给，列目录时也不列。
 * 上传先放 data/tmp/uploads/<上传号>_<文件名>；web-api 发话时按上传号找到它、搬进机器人工作区。
 * 两个插件不互相调用，只共用这个目录。
 * http 内的文件接口子模块（原 web 插件的 Files.ts），由 Static.registerStatic 在 ready 里创建，不另登记插件或服务。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as streamPromises from 'node:stream/promises';
import type * as cordis from 'cordis';
import type * as fastify from 'fastify';
import * as mime from '../../utils/Mime.ts';
import * as failureModule from '../../utils/Failure.ts';


/** 任何情况下都不给看的文件名。 */
const SECRET_FILES = /^(config\.yaml|secrets\.yaml|\.env(\..*)?)$/iu;

/** 能看的目录：运行时目录下的这四个。 */
const ROOT_NAMES = ['bots', 'skills', 'memory', 'knowledge'];


/** Range 请求头要的那一段，两头都含。 */
interface ByteRange {
  /** 从第几个字节开始。 */
  start: number;
  /** 到第几个字节为止（含）。 */
  end: number;
}


/** 文件接口。 */
export class FilesApi {
  /** 运行时目录。 */
  private readonly root: string;

  /** 能看的四个目录的绝对路径：目录固定，构造时算一次。 */
  private readonly roots: string[];

  /**
   * 登记四个接口。http 等 ready 才开始监听，这时已经登记好了。
   * @param ctx Cordis 给 http 插件的 ctx。
   * @param app http 的 Fastify 实例。
   * 副作用：在 app 上登记 PUT /api/uploads/:name、GET /api/files、GET /files/*、GET /api/files/list。
   */
  constructor(private readonly ctx: cordis.Context, app: fastify.FastifyInstance) {
    this.root = ctx.resources.root;
    this.roots = ROOT_NAMES.map((dir) => path.join(this.root, dir));

    //M 上传单独一个 Fastify 作用域（register 开出来的子作用域，里面的设置不影响外面）：
    //M 先去掉继承来的 JSON、纯文字解析器，再让任何类型的请求体都原样是流，边收边写盘，大文件不进内存。
    //M 别的插件的 JSON 接口不受影响。
    app.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('*', (_request, payload, done) => {
        done(null, payload);
      });
      //M 上传接口只使用这个子作用域的原始流解析器，不影响外面的 JSON 接口。
      scope.put<{ Params: { name: string } }>('/api/uploads/:name', (request) => {
        const body = request.body as NodeJS.ReadableStream | undefined;
        return this.upload(request.params.name, body);
      });
    });

    //M 登记按绝对路径读取文件的接口，支持 Range 分段传输。
    app.get<{ Querystring: { path?: unknown } }>('/api/files', (request, reply) => {
      return this.send(request.query.path, request, reply);
    });

    //M 路径相对运行时目录（用户 11-05：方便别的程序直接拿网址取），拼成绝对路径后和 /api/files 走同一条路。
    app.get<{ Params: { '*': string } }>('/files/*', (request, reply) => {
      const file = path.join(this.root, request.params['*']);
      return this.send(file, request, reply);
    });

    //M 登记列目录接口，返回受控目录下非敏感文件与子目录列表。
    app.get<{ Querystring: { path?: unknown } }>('/api/files/list', (request) => {
      return this.list(request.query.path);
    });
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
    //M 文件名整理成能落盘的样子：超过 10 个字的不算扩展名，扩展名只留 [.\w-]；
    //M 主体去掉控制字符和 \/:*?"<>|，空白换成 _，截 60 字，去掉结尾的 . 和 _，空了叫“未命名”。
    const extension = path.extname(raw);
    let kept = '';
    if (extension.length <= 10) {
      kept = extension.replace(/[^.\w-]/gu, '');
    }
    const hasExtension = kept.length > 1;
    let stem = raw;
    if (hasExtension) {
      stem = raw.slice(0, -extension.length);
    }
    const cleaned = [...stem]
      .filter((char) => char.charCodeAt(0) >= 32 && !'\\/:*?"<>|'.includes(char))
      .join('')
      .trim()
      .replace(/\s+/gu, '_')
      .slice(0, 60)
      .replace(/[._]+$/u, '');
    let baseName = cleaned;
    if (baseName === '') {
      baseName = '未命名';
    }
    let suffix = '';
    if (hasExtension) {
      suffix = kept;
    }
    const name = `${baseName}${suffix}`;

    //M 上传号：本地时间 yyyyMMddHHmmssSSS 加 3 位随机数，共 20 位（和 web-api 约定的）。
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
    const stamp = local.toISOString().replace(/\D/gu, '').slice(0, 17);
    const id = stamp + String(Math.floor(Math.random() * 1000)).padStart(3, '0');

    //M 有请求体就边收边写；没有就写一个空文件。
    const file = path.join(this.ctx.resources.ensureRuntimeDir('data', 'tmp', 'uploads'), `${id}_${name}`);
    const writeUpload = async (): Promise<void> => {
      if (body === undefined) {
        await fsp.writeFile(file, '');
        return;
      }
      await streamPromises.pipeline(body, fs.createWriteStream(file));
    };
    //M 执行写盘操作（无请求体写空文件，有流则管道落盘），写完再读实际字节数。
    await writeUpload();
    const size = (await fsp.stat(file)).size;

    //T 跟踪：收下一个上传。
    const vars = { uploadId: id, fileName: name, size: size };
    this.ctx.emit('trace', 'FilesApi.upload', 'trace.web.upload', 'pipeline(body, createWriteStream(file))', vars);
    return { id, name, size, kind: mime.getFileKind(name) };
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
    //G 先校验并规范化路径，再确认目标存在且是普通文件，不是则抛 404。
    const file = this.resolve(value);
    const stat = await fsp.stat(file).catch(() => undefined);
    if (stat?.isFile() !== true) {
      throw new failureModule.Failure(404, `没有这个文件：${file}`);
    }

    //M 解析 Range 请求头并设置响应头与 MIME 类型，范围非法时直接回 416。
    const range = this.range(request.headers.range, stat.size);
    reply.header('Accept-Ranges', 'bytes').type(mime.getMimeType(file));
    if (range === 'invalid') return reply.code(416).header('Content-Range', `bytes */${String(stat.size)}`).send();

    if (range !== undefined) {
      //M 命中合法分段请求，按起止字节创建部分读取流并回 206。
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
    //G 校验目录路径在允许范围内并读出目录项，打不开时抛 404。
    const dir = this.resolve(value);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) {
      throw new failureModule.Failure(404, `没有这个目录：${dir}`);
    }

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
    //G 入口路径必须是非空绝对路径，否则直接按 400 拒绝。
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new failureModule.Failure(400, 'path 要是绝对路径');
    }

    //G 密钥文件任何情况下都不给。
    const target = path.resolve(value);
    if (SECRET_FILES.test(path.basename(target))) {
      throw new failureModule.Failure(403, '这个文件不给看');
    }

    //G 要在四个目录之一里面（含目录本身）：path.relative 不往上走、也不是另一个盘。
    const inside = this.roots.some((root) => {
      const relative = path.relative(root, target);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    //G 路径落到允许的四个根目录之外时拒绝访问（403），防止越权读盘。
    if (!inside) {
      throw new failureModule.Failure(403, `不在能看的范围里（运行时目录的 bots、skills、memory、knowledge）：${target}`);
    }

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
    let start = Number(from);
    if (from === '') {
      start = Math.max(0, size - Number(to));
    }
    let end = Math.min(Number(to), size - 1);
    if (from === '' || to === '') {
      end = size - 1;
    }
    if (start >= size || start > end) return 'invalid';

    return { start, end };
  }
}

