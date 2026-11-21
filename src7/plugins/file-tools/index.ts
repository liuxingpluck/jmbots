/**
 * 提供工作区文件读写、编辑搜索与技能工具。
 * 含基础读写与看图接图（BaseTools.ts）、编辑与查找（EditMatch.ts）及技能（Skill.ts），路径按当前轮工作区与授权目录判界。
 * 设计见同目录 说明.md 的「设计要点」一节。
 */
import * as botUtils from '../../utils/Bots.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as cut from '../../utils/Cut.ts';
import { BaseTools } from './BaseTools.ts';
import * as editMatch from './EditMatch.ts';
import * as skillModule from './Skill.ts';

export { BaseTools } from './BaseTools.ts';


/** 插件名。 */
export const name = 'file-tools';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.1.0：并入原 base-tools（time、read、list_dir、write 与看图接图片 session/before-model 监听）。
//M 1.1.1：读图片文件的 getImageBlock 从骨架 utils/Image.ts 挪进 BaseTools.ts，只有这里用。
//M 1.2.0：并入原 skills 插件（Skill.ts：技能清单注入 work 会话、skill 工具；技能默认可用，config.yaml 不再单列 skills）。
//M 1.2.1：读写的路径除了工作区，这一轮的授权目录（回话地址 grants.dirs）里的也行（utils/Bots.ts 的 resolveSessionPath，用户 #301）。
//M 1.2.2：路径解析直接接收机器人和回话地址。
export const version = '1.2.2';

/** 用到的服务：resources 查模型是否收图；tools 登记六个工具；bots 找机器人的工作区。 */
export const inject = ['resources', 'tools'];


/** find 默认最多几条。 */
const FIND_DEFAULT = 200;

/** find 找内容时跳过多大的文件（2 MB）。 */
const FIND_MAX_BYTES = 2 * 1024 * 1024;

/** find 一行最多给几个字。 */
const LINE_MAX_CHARS = 300;

/** 前多少字节里有 \0 就当二进制跳过。 */
const BINARY_PROBE_BYTES = 8192;

/** 路径里有这几层就跳过。 */
const SKIP_DIRS = new Set(['node_modules', '.git']);


/** 文件编辑与搜索工具。 */
export class FileTools {
  /**
   * 登记 edit、find。
   * @param ctx Cordis 给这个插件的 ctx。
   */
  constructor(private readonly ctx: cordis.Context) {
    //M edit：会改东西，只给干活的会话（和 write 一样）。
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
      sessionKinds: ['work'],
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
      sessionKinds: ['front', 'work'],
      //M 将已校验的查找参数交给工作区搜索，结果直接返回给模型。
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
    //G 把待编辑路径解析到本轮工作区后才读取原文。
    const file = this.getFile(session, relative);
    const original = fs.readFileSync(file, 'utf8');

    //M 先验证并应用所有替换，完整生成新内容后才写盘。
    const changed = editMatch.applyEdits(original, edits, relative);
    fs.writeFileSync(file, changed, 'utf8');

    //T 跟踪：改了文件。
    const vars = { session: session.id, file: relative, editCount: edits.length };
    this.ctx.emit('trace', 'FileTools.edit', 'trace.fileTools.edit', 'editMatch.applyEdits(original, edits, path)', vars);
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
    //M 用本轮工作区内的指定目录作为文件通配的起点。
    const root = this.getFile(session, from);
    const limit = (args['limit'] as number | undefined) ?? FIND_DEFAULT;

    //M 文件名通配：带斜杠或以 ** 开头就原样用，否则在任意一层找（**/名字）。
    let pattern = '**/*';
    if (name !== undefined && name !== '') {
      pattern = `**/${name}`;
      if (name.includes('/') || name.startsWith('**')) {
        pattern = name;
      }
    }
    const found: string[] = [];
    let full = false;
    for await (const rel of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true, dot: true })) {
      const parts = rel.split(/[\\/]/u);
      if (parts.some((part) => SKIP_DIRS.has(part))) continue;

      const shown = parts.join('/');
      if (text === undefined || text === '') {
        found.push(shown);
      }
      if (text !== undefined && text !== '') {
        found.push(...matchLines(path.join(root, rel), shown, text, limit - found.length));
      }
      if (found.length >= limit) {
        full = true;
        break;
      }
    }

    //T 跟踪：找完了。
    const vars = { session: session.id, start: from, matchCount: found.length };
    this.ctx.emit('trace', 'FileTools.find', 'trace.fileTools.find', 'new Bun.Glob(pattern).scan({ cwd: root })', vars);
    if (found.length === 0) {
      const whatParts: string[] = [];
      if (name) {
        whatParts.push(`名字像 ${name}`);
      }
      if (text) {
        whatParts.push(`内容含 ${String(args['text'])}`);
      }
      return `${from} 下没找到 ${whatParts.join(' ')} 的文件`;
    }

    //M 太长按 2000 行 / 50KB 截（从头留），末尾说清截了多少。
    const kept = cut.keepLeadingLines(found.join('\n'));
    let result = kept.text;
    if (kept.cut) {
      result += `\n[输出太长，只留前 ${String(kept.kept)} 行（共 ${String(kept.total)} 行）]`;
    }
    if (full) {
      result += `\n[只列了前 ${String(limit)} 条，缩小范围或加大 limit]`;
    }
    return result;
  }

  /**
   * 相对工作区的路径落成绝对路径。
   * @param session 哪场会话：用它的机器人的工作区；飞书上 builder 说话的这一轮用他的目录（botUtils.getSessionWorkspace）；
   *   这一轮的授权目录（回话地址的 grants.dirs）里的也行。
   * @param relative 模型给的路径。
   * @throws 没有这个机器人、出了工作区和授权目录时抛错。
   */
  private getFile(session: Session, relative: string): string {
    const { bot, address } = session.row;
    //M 按本轮来源选择目录，把目标路径限制在工作区和授权目录里（utils/Bots.ts 的 resolveSessionPath）。
    return botUtils.resolveSessionPath(this.ctx.resources, bot, address, relative);
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

    let shortened = line;
    if (line.length > LINE_MAX_CHARS) {
      shortened = `${line.slice(0, LINE_MAX_CHARS)}…`;
    }
    hits.push(`${shown}:${String(index + 1)}: ${shortened}`);
  }
  return hits;
}


/**
 * 挂上统一后的工作区文件工具（含原 base-tools 的 time/read/list_dir/write + 接图片，以及 edit/find）。
 * apply 是 Cordis 插件的入口：inject 里的 resources、tools、bots 都就绪后 Cordis 调一次。没有配置。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  //M 一起登记基础文件工具和编辑、搜索工具，组成同一个插件入口。
  new BaseTools(ctx);
  new FileTools(ctx);
  //M 技能默认可用：原 skills 插件并进来，行为不变。
  skillModule.applySkills(ctx);
}
