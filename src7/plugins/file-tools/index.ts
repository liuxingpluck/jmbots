/**
 * 文件工具：edit（改文件里的一处或几处）、find（按文件名、内容找文件）。路径都相对机器人的工作区，出不去。
 * 读、写整个文件是 base-tools 的 read、write；这里只补这两个。find 自己走目录（Bun.Glob），不依赖机器上装了 rg。
 * 设计：docs/src7插件设计/file-tools.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as cut from '../../utils/Cut.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import * as editMatch from './EditMatch.ts';


/** 插件名。 */
export const name = 'file-tools';

/** 用到的服务：tools 登记工具；bots 找机器人的工作区。 */
export const inject = ['tools', 'bots'];


/** find 默认最多几条。 */
const FIND_DEFAULT = 200;

/** find 找内容时跳过多大的文件（2MB，同 0.4）。 */
const FIND_MAX_BYTES = 2 * 1024 * 1024;

/** find 一行最多给几个字。 */
const LINE_MAX_CHARS = 300;

/** 前多少字节里有 \0 就当二进制跳过。 */
const BINARY_PROBE_BYTES = 8192;

/** 路径里有这几层就跳过。 */
const SKIP_DIRS = new Set(['node_modules', '.git']);


/** 文件工具。 */
class FileTools {
  /**
   * 登记 edit、find。
   * @param ctx Cordis 给这个插件的 ctx。
   */
  constructor(private readonly ctx: cordis.Context) {
    //M edit：会改东西，只给干活的会话（和 base-tools 的 write 一样）。说明照 0.4 原文。
    ctx.tools.register({
      definition: {
        name: 'edit',
        description: '改文件里的一处或几处：每处 oldText 必须和文件原文一字不差、在文件里只出现一次，'
          + '几处之间不能重叠，都对照改之前的原文找。oldText 尽量短但要唯一；改之前先 read 看原文。',
        parameters: piAi.Type.Object({
          path: piAi.Type.String({ description: '相对工作区的路径' }),
          edits: piAi.Type.Array(
            piAi.Type.Object({
              oldText: piAi.Type.String({ description: '要替换的原文，必须唯一' }),
              newText: piAi.Type.String({ description: '换成什么' }),
            }),
            { minItems: 1, description: '替换列表' },
          ),
        }),
      },
      kinds: ['work'],
      run: (args, session) => this.edit(args, session),
    });

    //M find：只读，前台也能用。
    ctx.tools.register({
      definition: {
        name: 'find',
        description: '按文件名和 / 或内容找文件。name 是文件名通配（如 *.ts、**/*.md、src/**/Main.ts）；'
          + 'text 是内容里的关键字（不分大小写，按原文）。都给就在名字对得上的文件里找内容。'
          + '跳过 node_modules、.git、二进制和 2MB 以上的文件。',
        parameters: piAi.Type.Object({
          path: piAi.Type.Optional(piAi.Type.String({ description: '从哪个目录找（相对工作区），默认工作区' })),
          name: piAi.Type.Optional(piAi.Type.String({ description: '文件名通配' })),
          text: piAi.Type.Optional(piAi.Type.String({ description: '内容关键字' })),
          limit: piAi.Type.Optional(piAi.Type.Integer({ minimum: 1, description: `最多几条，默认 ${String(FIND_DEFAULT)}` })),
        }),
      },
      kinds: ['front', 'work'],
      run: (args, session) => this.find(args, session),
    });
  }

  /**
   * edit：读文件 → 换 → 写回。出错就抛（原因给模型看），文件不动。
   * @param args 模型给的参数（Tools.ts 照定义校验过）。
   * @param session 哪场会话。
   */
  private edit(args: Record<string, unknown>, session: Session): string {
    const relative = args['path'] as string;
    const edits = args['edits'] as editMatch.Edit[];
    const file = this.fileOf(session, relative);
    const original = fs.readFileSync(file, 'utf8');
    const changed = editMatch.applyEdits(original, edits, relative);
    fs.writeFileSync(file, changed, 'utf8');

    //T 跟踪：改了文件。
    const vars = { 会话: session.id, 文件: relative, 几处: edits.length };
    this.ctx.emit('trace', 'FileTools.edit', '改了文件', 'editMatch.applyEdits(original, edits, path)', vars);
    return `已修改 ${relative}（${String(edits.length)} 处）`;
  }

  /**
   * find：走目录、比内容、拼结果、截断。
   * @param args 模型给的参数（Tools.ts 照定义校验过）。
   * @param session 哪场会话。
   */
  private async find(args: Record<string, unknown>, session: Session): Promise<string> {
    const name = args['name'] as string | undefined;
    const text = (args['text'] as string | undefined)?.toLowerCase();
    if ((name ?? '') === '' && (text ?? '') === '') throw new Error('name 和 text 至少给一个');

    const from = (args['path'] as string | undefined) ?? '.';
    const root = this.fileOf(session, from);
    const limit = (args['limit'] as number | undefined) ?? FIND_DEFAULT;

    //M 文件名通配：带斜杠或以 ** 开头就原样用，否则在任意一层找（**/名字）。
    const pattern = name === undefined || name === '' ? '**/*' : name.includes('/') || name.startsWith('**') ? name : `**/${name}`;
    const found: string[] = [];
    let full = false;
    for await (const rel of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true, dot: true })) {
      const parts = rel.split(/[\\/]/u);
      if (parts.some((part) => SKIP_DIRS.has(part))) continue;

      const shown = parts.join('/');
      if (text === undefined || text === '') {
        found.push(shown);
      } else {
        found.push(...matchLines(path.join(root, rel), shown, text, limit - found.length));
      }
      if (found.length >= limit) {
        full = true;
        break;
      }
    }

    //T 跟踪：找完了。
    const vars = { 会话: session.id, 起点: from, 几条: found.length };
    this.ctx.emit('trace', 'FileTools.find', '找完了', 'new Bun.Glob(pattern).scan({ cwd: root })', vars);
    if (found.length === 0) {
      const what = [name ? `名字像 ${name}` : '', text ? `内容含 ${String(args['text'])}` : ''].filter((item) => item !== '').join(' ');
      return `${from} 下没找到 ${what} 的文件`;
    }

    //M 太长按 2000 行 / 50KB 截（从头留），末尾说清截了多少。
    const kept = cut.head(found.join('\n'));
    let result = kept.text;
    if (kept.cut) result += `\n[输出太长，只留前 ${String(kept.kept)} 行（共 ${String(kept.total)} 行）]`;
    if (full) result += `\n[只列了前 ${String(limit)} 条，缩小范围或加大 limit]`;
    return result;
  }

  /**
   * 相对工作区的路径落成绝对路径。
   * @param session 哪场会话：用它的机器人的工作区；飞书上 builder 说话的这一轮用他的目录（workspaceModule.of）。
   * @param relative 模型给的路径。
   * @throws 没有这个机器人、出了工作区时抛错。
   */
  private fileOf(session: Session, relative: string): string {
    const botWorkspace = this.ctx.bots.get(session.row.bot)?.workspace;
    if (botWorkspace === undefined) throw new Error(`没有这个机器人：${session.row.bot}`);

    const workspace = workspaceModule.of(botWorkspace, session.row.address);
    return workspaceModule.inside(workspace, relative);
  }
}


/**
 * 在一个文件里找含关键字的行。空文件、太大、二进制的跳过。
 * @param file 绝对路径。
 * @param shown 给模型看的相对路径。
 * @param text 关键字，已经是小写。
 * @param room 还能放几条。
 * @returns 每条 `相对路径:行号: 那一行`。
 */
function matchLines(file: string, shown: string, text: string, room: number): string[] {
  const size = fs.statSync(file).size;
  if (size === 0 || size > FIND_MAX_BYTES) return [];

  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) return [];

  const lines = buffer.toString('utf8').split(/\r?\n/u);
  const hits: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (hits.length >= room) break;

    if (!line.toLowerCase().includes(text)) continue;

    const shortened = line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS)}…` : line;
    hits.push(`${shown}:${String(index + 1)}: ${shortened}`);
  }
  return hits;
}


/**
 * 挂上文件工具。
 * apply 是 Cordis 插件的入口：inject 里的 tools、bots 都就绪后 Cordis 调一次。没有配置。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  new FileTools(ctx);
}
