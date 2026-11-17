/**
 * 网页：托管我们自己的网页 dist/web（单页应用）。
 * 在 ctx.http.app 上登记一条兜底路由 GET /*：有这个文件就给它，没有就给 index.html，前端自己认路径；
 * /api 开头、又没被别的插件对上的回 404 { error }，写错的接口看得出来。
 * 2026-11-14：dist/web/<名字>.html 当作插件页面挂在 /<名字>/（如 /memory/）；子路径下的 ./assets/… 也认；带扩展名找不到回 404。
 * 自己不开任何 /api/ 接口，也不是渠道：网页上发的话从 web-api 进来。网页不用令牌（http 只查 /api/、/files/）。
 * 读网页文件走骨架 utils/Embedded.ts 的 readAsset（源码读磁盘，编译版读内嵌的；原来同文件夹的 Assets.ts 只是转发，2026-11-14 已删）。
 * 设计：docs/src7插件设计/web.md。
 */
import type * as cordis from 'cordis';
import * as mime from '../../utils/Mime.ts';
//M 2026-11-14 jm开发：网页文件直接从骨架 utils/Embedded.ts 取（Claude 16:02 意见），原 web/Assets.ts 只是转发，已删（备份 cache/src7备份/20261114-1625EST-删Page和Assets/）。
import * as assets from '../../utils/Embedded.ts';


/** 插件名。 */
export const name = 'web';

/** 用到的服务：http 的 app；resources 读 plugins 名单，按插件名登记插件页面（2026-11-14）。 */
export const inject = ['http', 'resources'];


/** dist/web 里连 index.html 都没有时回的话。 */
const NOT_BUILT = '网页还没打包：在代码目录跑 bun run build:web';

/** assets/ 下的文件名带哈希，换版本就换名字，可以长缓存。 */
const LONG_CACHE = 'public, max-age=31536000, immutable';


/**
 * 挂上网页：登记兜底路由 GET /*。
 * apply 是 Cordis 插件的入口：inject 里的 http 就绪后 Cordis 调一次。http 等事件 ready（全部插件挂完）才开始监听，
 * 所以这里登记的路由赶得上。Fastify 按路径的具体程度匹配，/* 永远排在别的路由后面，不用管谁先登记。
 * 对 GET 登记的路由，Fastify 自动也接 HEAD。
 * @param ctx Cordis 给这个插件的 ctx。
 * 副作用：在 ctx.http.app 上登记一条路由；发一个跟踪点。
 */
export async function apply(ctx: cordis.Context): Promise<void> {
  //M 2026-11-14 jm开发：插件页面按约定挂在 /<插件名>/。config.yaml 里挂了的插件，dist/web 里有同名 <插件名>.html 的（如 memory.html），
  //M   在这里登记成具体路由：具体路由永远先于别的插件的通配（memory 插件的 /memory/* 转发），也先于下面的 /*。
  //M   插件自己登记了 /<名字>/ 的（wechat-kefu），dist/web 里没有同名 html，不会重复登记。
  for (const entry of ctx.resources.config.plugins) {
    const name = entry.name;
    if (!/^[a-z][a-z0-9-]*$/u.test(name) || name === 'index' || (await assets.readAsset(`${name}.html`)) === undefined) continue;
    ctx.http.app.get(`/${name}`, (_request, reply) => reply.redirect(`/${name}/`, 301));
    ctx.http.app.get(`/${name}/`, async (_request, reply) => {
      const html = await assets.readAsset(`${name}.html`);
      return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(html ?? NOT_BUILT);
    });
  }

  ctx.http.app.get<{ Params: { '*': string } }>('/*', async (request, reply) => {
    //M Fastify 已经把路径里的 %xx 解开了，这里拿到的就是相对 dist/web 的路径。
    const relative = request.params['*'];

    //G 没被别的插件对上的接口回 404，不回网页。
    if (relative === 'api' || relative.startsWith('api/')) {
      return reply.code(404).send({ error: `没有这个接口：${request.method} /${relative}` });
    }

    //M 2026-11-14 jm开发：插件页面。打包出来的 <名字>.html（如 memory.html）挂在 /<名字>/，不带斜杠的 301 过去。
    //M   插件自己在 /<名字>/ 登记了路由的（如 /wechat-kefu/），Fastify 先对上具体路由，轮不到这里。
    const page = /^([a-z][a-z0-9-]*)\/?$/u.exec(relative);
    if (page !== null && page[1] !== 'index') {
      const html = await assets.readAsset(`${page[1]}.html`);
      if (html !== undefined) {
        if (!relative.endsWith('/')) return reply.redirect(`/${relative}/`, 301);
        return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(html);
      }
    }

    //M 有这个文件就给它。
    let file = relative;
    let found = await assets.readAsset(file);
    //G 2026-11-14 jm开发：页面挂在子路径（/wechat-kefu/、/memory/）时，HTML 里的 ./assets/… 会被浏览器拼成 /<子路径>/assets/…；
    //G   取 assets/ 之后那段再找一次。以前这里会回 index.html，浏览器报 “Expected a JavaScript module … text/html”，页面空白。
    const at = relative.indexOf('/assets/');
    if (found === undefined && at >= 0) {
      file = relative.slice(at + 1);
      found = await assets.readAsset(file);
    }
    //G 带扩展名的文件（.js、.css、.png…）找不到就回 404，不回 index.html，免得脚本被当成网页。
    if (found === undefined && /\.[a-z0-9]{1,8}$/iu.test(relative)) {
      return reply.code(404).type('text/plain; charset=utf-8').send(`没有这个文件：/${relative}`);
    }

    //M 没有就给 index.html（前端的路径，比如 /sessions/abc）。
    const data = found ?? (await assets.readAsset('index.html'));
    if (data === undefined) return reply.code(404).type('text/plain; charset=utf-8').send(NOT_BUILT);

    //M assets/ 下的长缓存；别的（主要是 index.html）每次都问，换版本马上生效。
    if (found === undefined) file = 'index.html';
    const cache = found !== undefined && file.startsWith('assets/') ? LONG_CACHE : 'no-cache';
    return reply.header('Cache-Control', cache).type(mime.typeOf(file)).send(data);
  });

  //T 跟踪：网页路由登记好了。
  const vars = { 路由: 'GET /*' };
  ctx.emit('trace', 'web.apply', '登记网页的兜底路由', "ctx.http.app.get('/*', …)", vars);
}
