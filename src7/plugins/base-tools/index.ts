/**
 * 自带工具：系统默认带的几个工具，都登记进工具模块。
 * 读取类的（time、read、list_dir）前台对话也能用；会改东西的（write）只给干活的会话。
 * 以后要加工具（搜索、跑命令、看图……）：另写一个插件，调 ctx.tools.register 就行，不用改这里。
 * 工具收到的参数已经由 Tools.execute 照 parameters 校验过，这里直接用。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChatRequest } from '../../Chat.ts';
import type { Session } from '../../Sessions.ts';
import * as imageModule from '../../utils/Image.ts';
import * as workspaceModule from '../../utils/Workspace.ts';


/** 看不到图的模型收到图时的提醒。 */
const NO_SCRIPT_HINT = '用户发了图片，但你这个模型看不到图片。不要自己写 OCR、裁图、识图之类的脚本，也不要装这类工具；图片会以 base64 直接交给看图模型。前台就调 hand_session 转给后台；后台就直接告诉用户需要换成能看图的模型。';

/** 插件名。 */
export const name = 'base-tools';

/** 用到的服务。 */
export const inject = ['resources', 'tools', 'bots'];


/** 自带工具。 */
class BaseTools {
  /**
   * 登记下面这几个工具。
   * @param ctx Cordis 给的 ctx。
   */
  constructor(private readonly ctx: cordis.Context) {
    //M time：查现在的本地时间和时区。最短链路用它跑通“模型要工具 → 执行 → 再回答”。
    this.ctx.tools.register({
      definition: {
        name: 'time',
        description: '返回当前本地时间和时区。不需要参数。',
        parameters: piAi.Type.Object({}),
      },
      kinds: ['front', 'work'],
      run: () => {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return `${new Date().toLocaleString('zh-CN', { hour12: false })}（${zone}）`;
      },
    });

    //M read：读一个文件，每行前面带行号。
    this.ctx.tools.register({
      definition: {
        name: 'read',
        description: '读工作区里的一个文件。路径相对这场会话的工作区。',
        parameters: piAi.Type.Object({
          path: piAi.Type.String({ description: '相对工作区的路径' }),
          from: piAi.Type.Optional(piAi.Type.Integer({ minimum: 1, description: '从第几行开始，从 1 数' })),
          count: piAi.Type.Optional(piAi.Type.Integer({ minimum: 1, description: '读几行；不写就读到末尾' })),
        }),
      },
      kinds: ['front', 'work'],
      run: (args, session) => {
        const file = this.fileOf(session, args['path'] as string);
        //M 图片：看图模型给它图片块；不收图片的模型只告诉它这是图片。
        if (imageModule.imagePaths(`@${file}`).length > 0) {
          const block = this.sees(session.row.model) ? imageModule.imageBlock(file) : undefined;
          if (block === undefined) return `${args['path'] as string} 是图片，当前模型 ${session.row.model} 不收图片（或图片太大）；要看图得换看图模型。`;
          return [{ type: 'text', text: `图片 ${args['path'] as string}` }, block];
        }
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        const from = (args['from'] as number | undefined) ?? 1;
        const count = (args['count'] as number | undefined) ?? lines.length;
        const wanted = lines.slice(from - 1, from - 1 + count);
        return wanted.map((line, index) => `${String(from + index)}\t${line}`).join('\n');
      },
    });

    //M 看图模型：用户的话里 @ 了工作区里的图片，就把图片块接在这句话后面一起发（只改请求副本，库里存的还是原话）。
    this.ctx.on('session/request', (request) => {
      this.attachImages(request);
    });

    //M list_dir：列一个目录，文件夹名后面带斜杠。
    this.ctx.tools.register({
      definition: {
        name: 'list_dir',
        description: '列工作区里的一个目录。路径相对这场会话的工作区。不写路径就列工作区根目录。',
        parameters: piAi.Type.Object({
          path: piAi.Type.Optional(piAi.Type.String({ description: '相对工作区的路径' })),
        }),
      },
      kinds: ['front', 'work'],
      run: (args, session) => {
        const dir = this.fileOf(session, (args['path'] as string | undefined) ?? '.');
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const names = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
        return names.length === 0 ? '（空目录）' : names.sort().join('\n');
      },
    });

    //M write：写一个文件，目录没有就建。会改东西，只给干活的会话。
    this.ctx.tools.register({
      definition: {
        name: 'write',
        description: '往工作区里写一个文件。路径相对这场会话的工作区。目录没有就建。',
        parameters: piAi.Type.Object({
          path: piAi.Type.String({ description: '相对工作区的路径' }),
          content: piAi.Type.String({ description: '要写的全部内容' }),
        }),
      },
      kinds: ['work'],
      run: (args, session) => {
        const file = this.fileOf(session, args['path'] as string);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, args['content'] as string, 'utf8');
        return '已写入';
      },
    });
  }

  /**
   * 这个模型收不收图片：看 config.yaml 里手写的 vision。
   * @param model 供应商名/模型 ID。
   */
  private sees(model: string): boolean {
    return this.ctx.resources.modelOf(model).input.includes('image');
  }

  /**
   * 响应 session/request：看图模型的请求里，用户的话 @ 了工作区里的图片 → 这句话换成“原话 + 图片块”。
   * @param request 这一步的请求；改它的 messages（副本）。
   */
  private attachImages(request: ChatRequest): void {
    if (!this.sees(request.model)) {
      //G 看不到图却收到图：提醒别自己写 OCR、识图脚本（图片只走 base64 交给看图模型）。
      const has = request.messages.some((message) => message.role === 'user' && typeof message.content === 'string' && imageModule.imagePaths(message.content).length > 0);
      if (has) request.messages = [...request.messages, { role: 'system', content: NO_SCRIPT_HINT, timestamp: Date.now() }];
      return;
    }

    request.messages = request.messages.map((message) => {
      if (message.role !== 'user' || typeof message.content !== 'string') return message;

      const blocks: piAi.ImageContent[] = [];
      for (const file of imageModule.imagePaths(message.content)) {
        //G 不在工作区里的路径不读（渠道存的附件都在工作区里）。
        let full: string;
        try { full = this.fileOf(request.session, file); } catch { continue; }
        const block = imageModule.imageBlock(full);
        if (block !== undefined) blocks.push(block);
      }
      if (blocks.length === 0) return message;

      //T 跟踪：把图片接进用户的话。
      const vars = { 会话: request.session.id, 模型: request.model, 几张图: blocks.length };
      this.ctx.emit('trace', 'base-tools.attachImages', '把用户 @ 的图片接进这句话', 'message.content = [文字, 图片…]', vars);
      return { ...message, content: [{ type: 'text', text: message.content }, ...blocks] };
    });
  }

  /**
   * 把模型给的相对路径落到这场会话的工作区里。工作区是机器人的；飞书上 builder 说话的这一轮是他的目录
   * （回话地址的 workspace，utils/Workspace.ts 的 of）。
   * @param session 这场会话。
   * @param relative 相对工作区的路径。
   * @returns 绝对路径。
   * @throws 没有这个机器人、路径跑到工作区外面时抛错。
   */
  private fileOf(session: Session, relative: string): string {
    const botWorkspace = this.ctx.bots.get(session.row.bot)?.workspace;
    if (botWorkspace === undefined) {
      throw new Error(`没有这个机器人：${session.row.bot}`);
    }
    const workspace = workspaceModule.of(botWorkspace, session.row.address);
    const full = path.resolve(workspace, relative);
    if (full !== workspace && !full.startsWith(`${workspace}${path.sep}`)) {
      throw new Error('路径必须在工作区里');
    }
    return full;
  }
}


/**
 * 登记自带工具。
 * apply 是 Cordis 插件的入口函数：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 先等 inject 里写的服务都就绪，
 * 再调一次 apply(ctx, 配置)。插件在 apply 里通过 ctx 听事件、登记工具；插件被拔掉时，这些登记自动撤掉。
 * 详见 plugins/Index.ts 的 PluginModule。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  new BaseTools(ctx);
}
