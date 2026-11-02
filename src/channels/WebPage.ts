/**
 * 网页托管：把 dist/web 里打包好的网页交给浏览器。
 * 由 Main.ts 注册。只读文件，不写任何东西；打包目录以外的路径、没登记类型的文件一律 404。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';


/** 允许交给浏览器的文件类型：扩展名 → Content-Type。没列出的扩展名一律 404。 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};


/** registerWebPage 的参数。 */
export interface WebPageOptions {
  /** 打包输出目录，一般是仓库下的 dist/web；相对路径按当前工作目录解析。目录不存在时页面请求都返回 404。 */
  webDir: string;
}


/** 一个可以返回的文件。 */
interface WebFile {
  /** 文件的绝对路径，一定在打包目录里面。 */
  filePath: string;
  /** 返回时用的 Content-Type。 */
  contentType: string;
}


/**
 * 注册网页路由：`/` 返回 index.html，其他路径按文件名返回打包目录里的文件。
 * `/api/` 开头但没注册的路径在这里统一回 404，不会被当成文件去找。只读，不写文件。
 */
export function registerWebPage(app: FastifyInstance, options: WebPageOptions): void {
  /** 打包目录的绝对路径；用来确认请求的文件没有借 `..` 跑出去。 */
  const webDir = path.resolve(options.webDir);

  /** 网页请求的处理函数，`/` 和其他路径共用。 */
  const sendWebFile = async (request: FastifyRequest, reply: FastifyReply) => {
    /** 去掉查询串后的请求路径，例如 `/chunk-a1b2.js`。 */
    const urlPath = request.url.split('?')[0] ?? '/';
    // g: 没注册的接口不当成文件去找。
    if (urlPath.startsWith('/api/')) {
      return reply.code(404).send({ error: '没有这个接口' });
    }
    /** 要返回的文件；null 表示不该返回任何文件。 */
    const webFile = resolveWebFile(webDir, urlPath);
    if (webFile === null) {
      return reply.code(404).send({ error: '没有这个文件' });
    }
    // m: 读文件原样返回。首页不缓存，这样重新打包后一刷新就能拿到新的文件名。
    try {
      /** 文件内容。 */
      const content = await fs.readFile(webFile.filePath);
      reply.type(webFile.contentType).header('X-Content-Type-Options', 'nosniff');
      if (webFile.contentType.startsWith('text/html')) {
        reply.header('Cache-Control', 'no-cache');
      }
      return reply.send(content);
    } catch {
      // g: 文件不存在（例如还没打包）时 404。
      return reply.code(404).send({ error: '没有这个文件；网页可能还没打包（bun run build:web）' });
    }
  };

  // r: `/` 单独登记一次，确保首页一定走这里；其余路径走通配。
  app.get('/', sendWebFile);
  app.get('/*', sendWebFile);
}


/**
 * 把请求路径换成打包目录里的文件。
 * 返回 null 表示不该返回任何文件：路径解码失败、跑出打包目录，或者扩展名没登记。
 */
function resolveWebFile(webDir: string, urlPath: string): WebFile | null {
  // g: 解码失败（例如只有半个 %xx）当作找不到。
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  // m: `/` 对应 index.html，其余按相对路径拼到打包目录下。
  /** 请求对应的绝对路径。 */
  const filePath = path.resolve(webDir, '.' + (decodedPath === '/' ? '/index.html' : decodedPath));
  /** 扩展名对应的 Content-Type；没登记时为 undefined。 */
  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  // g: 只认打包目录里面、扩展名登记过的文件。
  if (!filePath.startsWith(webDir + path.sep) || contentType === undefined) {
    return null;
  }
  return { filePath, contentType };
}
