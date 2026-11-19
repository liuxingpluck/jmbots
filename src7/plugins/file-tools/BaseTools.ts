/**
 * 基础工作区工具：time、read、list_dir、write，以及将用户 @图片接入模型请求的 session/before-model 监听。
 * 由原 base-tools 插件并入 file-tools；工具名、参数、会话范围与跟踪名均保持不变，便于无缝兼容。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChatRequest, Session } from '../../Sessions.ts';
import * as imageModule from '../../utils/Image.ts';
import * as filesModule from '../../utils/Files.ts';
import * as mimeModule from '../../utils/Mime.ts';
import * as workspaceModule from '../../utils/Workspace.ts';


/** 一张图最大多少字节；再大就不发给模型（请求太大，供应商会拒）。 */
const MAX_BYTES = 8 * 1024 * 1024;

/** 看图模型认得的图片类型；svg、ico 这类不发（和 utils/Image.ts 的 getImagePaths 认的一致）。 */
const SENDABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);


/**
 * 把一个图片文件读成图片块。
 * @param file 绝对路径。
 * @returns 图片块 ImageContent，含 type 为 image、Base64 的 data 和 mimeType。图片不可发送时返回 undefined。
 */
function getImageBlock(file: string): piAi.ImageContent | undefined {
  //G 不是能发的图片类型、文件不在、太大 → 不发。
  const mimeType = mimeModule.getMimeType(file);
  if (!SENDABLE.has(mimeType) || !fs.existsSync(file)) return undefined;
  if (fs.statSync(file).size > MAX_BYTES) return undefined;

  //M 读成 base64，装进 pi 的图片块。
  const data = fs.readFileSync(file).toString('base64');
  return { type: 'image', data, mimeType };
}


/** 看不到图的模型收到图时的提醒。 */
const NO_SCRIPT_HINT = '用户发了图片，但你这个模型看不到图片。不要自己写 OCR、裁图、识图之类的脚本，也不要装这类工具；'
  + '图片会以 base64 直接交给看图模型。前台就调 hand_session 转给后台；后台就直接告诉用户需要换成能看图的模型。';


/** 基础工作区工具（原 base-tools）。 */
export class BaseTools {
  /**
   * 登记 time、read、list_dir、write 四个工具，并挂上把用户 @ 图片接进请求的监听。
   * @param ctx Cordis 给 file-tools 插件的 ctx。
   */
  constructor(private readonly ctx: cordis.Context) {
    //M time：查现在的本地时间和时区。最短链路用它跑通“模型要工具 → 执行 → 再回答”。
    this.ctx.tools.register({
      definition: {
        name: 'time',
        description: '返回当前本地时间和时区。不需要参数。',
        parameters: piAi.Type.Object({}),
      },
      sessionKinds: ['front', 'work'],
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
      sessionKinds: ['front', 'work'],
      run: (args, session) => {
        const relative = args['path'] as string;
        //G 在读文件前，把模型路径解析到本轮工作区并判界。
        const file = this.getFile(session, relative);
        //M 图片：看图模型给它图片块；不收图片的模型只告诉它这是图片。
        if (imageModule.getImagePaths(`@${file}`).length > 0) {
          let block: piAi.ImageContent | undefined;
          if (this.sees(session.row.model)) {
            block = getImageBlock(file);
          }
          if (block === undefined) return `${relative} 是图片，当前模型 ${session.row.model} 不收图片（或图片太大）；要看图得换看图模型。`;

          return [{ type: 'text', text: `图片 ${relative}` }, block];
        }
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        const from = (args['from'] as number | undefined) ?? 1;
        const count = (args['count'] as number | undefined) ?? lines.length;
        const wanted = lines.slice(from - 1, from - 1 + count);
        return wanted.map((line, index) => `${String(from + index)}\t${line}`).join('\n');
      },
    });

    //M 看图模型：用户的话里 @ 了工作区里的图片，就把图片块接在这句话后面一起发（只改请求副本，库里存的还是原话）。
    this.ctx.on('session/before-model', (request) => {
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
      sessionKinds: ['front', 'work'],
      run: (args, session) => {
        //G 将目标目录限制在本轮工作区，未指定时从根目录列出。
        const dir = this.getFile(session, (args['path'] as string | undefined) ?? '.');
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const names = entries.map((entry) => {
          if (entry.isDirectory()) {
            return `${entry.name}/`;
          }
          return entry.name;
        });
        if (names.length === 0) return '（空目录）';

        return names.sort().join('\n');
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
      sessionKinds: ['work'],
      run: (args, session) => {
        //G 写文件前确认目标属于本轮工作区。
        const file = this.getFile(session, args['path'] as string);
        const parentDir = path.dirname(file);
        //M 写入前确保已校验的目标文件有上层目录。
        filesModule.ensureDir(parentDir);
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
    //M 用已注册模型的输入类型决定能否给它发送图片数据。
    return this.ctx.resources.getModel(model).input.includes('image');
  }

  /**
   * 响应 session/before-model：看图模型的请求里，用户的话 @ 了工作区里的图片 → 这句话换成“原话 + 图片块”。
   * @param request 这一步的请求；改它的 messages（副本）。
   */
  private attachImages(request: ChatRequest): void {
    //G 模型没有图像能力时转到提示分支。
    if (!this.sees(request.model)) {
      //G 看不到图却收到图：提醒别自己写 OCR、识图脚本（图片只走 base64 交给看图模型）。
      const has = request.messages.some(
        (message) => message.role === 'user' && typeof message.content === 'string'
          && imageModule.getImagePaths(message.content).length > 0,
      );
      if (has) {
        request.messages = [...request.messages, { role: 'system', content: NO_SCRIPT_HINT, timestamp: Date.now() }];
      }
      return;
    }

    request.messages = request.messages.map((message) => {
      if (message.role !== 'user' || typeof message.content !== 'string') return message;

      const blocks: piAi.ImageContent[] = [];
      //M 从用户原话提取图片引用，逐张构建本轮模型请求的附件。
      for (const file of imageModule.getImagePaths(message.content)) {
        //G 不在工作区里的路径不读（渠道存的附件都在工作区里，符号链接也照工作区判界）。
        let full: string;
        try {
          full = this.getFile(request.session, file);
        } catch {
          continue;
        }
        //M 读取工作区内图片文件为图片块；无法发送或超限时跳过。
        const block = getImageBlock(full);
        if (block !== undefined) {
          blocks.push(block);
        }
      }
      if (blocks.length === 0) return message;

      //T 跟踪：把图片接进用户的话。
      const vars = { session: request.session.id, model: request.model, imageCount: blocks.length };
      this.ctx.emit('trace', 'base-tools.attachImages', 'trace.fileTools.attachImages', 'message.content = [文字, 图片…]', vars);
      return { ...message, content: [{ type: 'text', text: message.content }, ...blocks] };
    });
  }

  /**
   * 把模型给的相对路径落到这场会话的工作区里（解开符号链接再比）。
   * 工作区是机器人的；飞书上 builder / guest 说话的这一轮是他的目录（utils/Workspace.ts 的 getWorkspace）。
   * @param session 这场会话。
   * @param relative 相对工作区的路径。
   * @returns 解开符号链接后的绝对路径。
   * @throws 没有这个机器人、路径跑到工作区外面时抛错。
   */
  private getFile(session: Session, relative: string): string {
    //M 先以当前机器人的工作区作为本轮路径解析的起点。
    const botWorkspace = this.ctx.bots.get(session.row.bot)?.workspace;
    if (botWorkspace === undefined) {
      throw new Error(`没有这个机器人：${session.row.bot}`);
    }
    //M 按回话地址取本轮隔离工作区，再做符号链接物理越界校验。
    const workspace = workspaceModule.getWorkspace(botWorkspace, session.row.address);
    return workspaceModule.resolveWorkspacePath(workspace, relative);
  }
}
