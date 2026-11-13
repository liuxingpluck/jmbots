/**
 * 自带工具：系统默认带的几个工具，都登记进工具模块。
 * 读取类的默认对话也能用；会改东西的只给干活的会话。
 * 另外带一个 time 工具（查现在的时间），默认对话和干活的会话都能用，方便最短链路跑通。
 * 以后要加工具（搜索、跑命令、看图……）：另写一个插件，调 ctx.tools.register 就行，不用改这里。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';


/** 插件名。 */
export const name = 'base-tools';

/** 用到的服务。 */
export const inject = ['resources', 'tools'];


/** 自带工具。 */
class BaseTools {
  /**
   * 登记下面这几个工具。
   * @param ctx Cordis 给的 ctx。
   */
  constructor(ctx: cordis.Context) {
    //M 读取类，kinds: ['default', 'work']：
    //M   time     查现在的本地时间和时区。没有参数。最短链路用它跑通“模型要工具 → 执行 → 再回答”。
    ctx.tools.register({
      definition: {
        name: 'time',
        description: '返回当前本地时间和时区。不需要参数。',
        parameters: piAi.Type.Object({}),
      },
      kinds: ['default', 'work'],
      run: () => {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return `${new Date().toLocaleString('zh-CN', { hour12: false })}（${zone}）`;
      },
    });
    //M   read      读一个文件（参数：路径、从第几行、读几行）。路径相对这场会话的工作区。
    ctx.tools.register({
      definition: {
        name: 'read',
        description: '读工作区里的一个文件。路径相对这场会话的工作区。',
        parameters: piAi.Type.Object({
          path: piAi.Type.String({ description: '相对工作区的路径' }),
          from: piAi.Type.Optional(piAi.Type.Number({ description: '从第几行开始，从 1 数' })),
          count: piAi.Type.Optional(piAi.Type.Number({ description: '读几行；不写就读到末尾' })),
        }),
      },
      kinds: ['default', 'work'],
      run: (call, session) => readFile(call, session),
    });
    //M   list_dir  列一个目录。
    ctx.tools.register({
      definition: {
        name: 'list_dir',
        description: '列工作区里的一个目录。路径相对这场会话的工作区。不写路径就列工作区根目录。',
        parameters: piAi.Type.Object({
          path: piAi.Type.Optional(piAi.Type.String({ description: '相对工作区的路径' })),
        }),
      },
      kinds: ['default', 'work'],
      run: (call, session) => listDir(call, session),
    });
    //M 会改东西的，kinds: ['work']：
    //M   write     写一个文件（参数：路径、内容）。
    ctx.tools.register({
      definition: {
        name: 'write',
        description: '往工作区里写一个文件。路径相对这场会话的工作区。目录没有就建。',
        parameters: piAi.Type.Object({
          path: piAi.Type.String({ description: '相对工作区的路径' }),
          content: piAi.Type.String({ description: '要写的全部内容' }),
        }),
      },
      kinds: ['work'],
      run: (call, session) => writeFile(call, session),
    });
    //M 总结，kinds: ['work']：
    //M   summary   写这场对话的一句总结（参数：文字）→ session.summarize(文字)，返回“已记下”。
    //M             每场干活的会话做完前都该调它；没调的话，会话的循环会催一次。
    ctx.tools.register({
      definition: {
        name: 'summary',
        description: '用一两句话写下这场对话做了什么、结果在哪。做完前都该调它。',
        parameters: piAi.Type.Object({
          text: piAi.Type.String({ description: '一两句总结' }),
        }),
      },
      kinds: ['work'],
      run: (call, session) => {
        const text = str(call.arguments['text']);
        session.summarize(text);
        return '已记下';
      },
    });
    //M 每个都调 ctx.tools.register({ definition, kinds, run })。
  }
}


/**
 * 读工作区里的文件。
 * @param call 模型的调用。
 * @param session 这场会话（取工作区）。
 */
function readFile(call: { arguments: Record<string, unknown> }, session: Session): string {
  const full = resolveIn(session.row.workspace, str(call.arguments['path']));
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new Error('没有这个文件');
  }
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  const fromRaw = call.arguments['from'];
  const countRaw = call.arguments['count'];
  const from = typeof fromRaw === 'number' && fromRaw >= 1 ? fromRaw : 1;
  const count = typeof countRaw === 'number' && countRaw >= 1 ? countRaw : lines.length;
  const slice = lines.slice(from - 1, from - 1 + count);
  return slice.map((line, i) => `${String(from + i)}\t${line}`).join('\n');
}


/**
 * 列工作区里的目录。
 * @param call 模型的调用。
 * @param session 这场会话。
 */
function listDir(call: { arguments: Record<string, unknown> }, session: Session): string {
  const rel = call.arguments['path'] === undefined ? '.' : str(call.arguments['path']);
  const full = resolveIn(session.row.workspace, rel);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
    throw new Error('没有这个目录');
  }
  const names = fs.readdirSync(full).sort();
  if (names.length === 0) {
    return '（空目录）';
  }
  return names.map((name) => {
    const isDir = fs.statSync(path.join(full, name)).isDirectory();
    return isDir ? `${name}/` : name;
  }).join('\n');
}


/**
 * 写工作区里的文件。
 * @param call 模型的调用。
 * @param session 这场会话。
 */
function writeFile(call: { arguments: Record<string, unknown> }, session: Session): string {
  const full = resolveIn(session.row.workspace, str(call.arguments['path']));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, str(call.arguments['content']), 'utf8');
  return '已写入';
}


/**
 * 把相对路径落到工作区里，不允许逃出去。
 * @param workspace 工作区绝对路径。
 * @param rel 相对路径。
 */
function resolveIn(workspace: string, rel: string): string {
  if (rel === '') {
    throw new Error('路径不能是空的');
  }
  const root = path.resolve(workspace);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
    throw new Error('路径必须在工作区里');
  }
  return full;
}


/**
 * 把工具参数收成字符串。
 * @param value 模型给的值。
 */
function str(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}


/**
 * 登记自带工具。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  new BaseTools(ctx);
}
