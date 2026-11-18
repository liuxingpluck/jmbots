/**
 * 路由登记簿：记下 Fastify 上实际登记了哪些路径，是谁登记的。教程页（tutorial 插件）按它分出每个插件的接口，不手写清单。
 * 谁登记的怎么知道：Fastify 的 onRoute 钩子在 app.get(...) 这一句里同步执行，这时候看调用栈，
 * 第一个落在 src7/plugins/<文件夹>/ 里的帧就是登记它的那个插件的文件和行号。
 * 认不出的归到“其他”（owner 是空串），原因有两种：
 *   1. 编译版（bun build --compile）调用栈里是打包后的路径，没有 src7/plugins/<文件夹>/，认不出；
 *   2. 骨架（src7/ 下 plugins/ 以外的文件）直接登记的，它不属于任何插件。
 */
import type * as fastify from 'fastify';
import { SOURCE_DIR, SOURCE_PREFIX } from '../../utils/SourceDir.ts';


/** 一条登记下来的路径。 */
export interface RouteInfo {
  /** 方法，大写：GET、POST…（Fastify 自动补的 HEAD 不记）。 */
  method: string;
  /** 路径，如 /api/health、/api/tutorial/state。 */
  url: string;
  /** 登记它的插件文件夹名，如 http、relay；认不出是空串。 */
  owner: string;
  /** 登记那一句的位置：src7/plugins/文件夹/文件.ts:行号；认不出是空串。 */
  site: string;
}

/** 调用栈里的一帧：src7/plugins/<文件夹>/<文件>.ts:<行号>。 */
const FRAME = new RegExp(`${SOURCE_DIR}/plugins/([^/:()\\s]+)/([^:()\\s]+\\.ts):(\\d+)`, 'u');

/** 本文件的名字：钩子自己那一帧要跳过。 */
const SELF = `${SOURCE_PREFIX}plugins/http/Routes.ts`;

/** 记调用栈时多留几帧：Fastify 内部要占好几帧。 */
const STACK_LIMIT = 40;


/**
 * 从调用栈里认出谁登记的路径。
 * @param stack Error 的 stack 文本。
 * @returns 文件夹名和位置；认不出是 undefined。
 */
export function getOwner(stack: string): { owner: string; site: string } | undefined {
  const frames = stack.replaceAll('\\', '/').split('\n');
  for (const frame of frames) {
    if (frame.includes(SELF)) continue;

    const found = FRAME.exec(frame);
    if (found === null) continue;

    const owner = found[1] ?? '';
    const site = `${SOURCE_PREFIX}plugins/${owner}/${found[2] ?? ''}:${found[3] ?? ''}`;
    return { owner, site };
  }
  return undefined;
}


/**
 * 让 app 每登记一条路径，就往 list 里记一条。要在登记任何路径之前调。
 * @param app Fastify 实例。
 * @param list 记到哪里。
 * 副作用：给 app 加 onRoute 钩子。
 */
export function watchRoutes(app: fastify.FastifyInstance, list: RouteInfo[]): void {
  app.addHook('onRoute', (options) => {
    //M 抓调用栈：临时放宽帧数，抓完还原。
    const before = Error.stackTraceLimit;
    Error.stackTraceLimit = STACK_LIMIT;
    const stack = new Error('route').stack ?? '';
    Error.stackTraceLimit = before;
    const found = getOwner(stack);
    let owner = '';
    let site = '';
    if (found !== undefined) {
      owner = found.owner;
      site = found.site;
    }

    //M method 可能是一个，也可能是一串；Fastify 给 GET 自动补的 HEAD 不记。
    const methods = [options.method].flat();
    for (const method of methods) {
      if (method === 'HEAD') continue;

      list.push({ method, url: options.url, owner, site });
    }
  });
}
