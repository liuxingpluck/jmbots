/**
 * 斜杠命令的登记表（docs/界面/01_界面设计.md 第 7.3 节）：在行首或空格后打 / 弹出，接着打字过滤（中文名、拼音、英文都认）。
 * 加命令只在 SLASH_COMMANDS 里加一条：名字、别名、一句话说明、分组、执行函数。执行时拿到 SlashContext（输入框和界面的几个动作）。
 */
import type * as tiptapCore from '@tiptap/core';
// 列表、引用、代码块、分割线这些命令是 StarterKit 里的扩展加到编辑器上的；只引类型，让它们的命令声明生效。
import type {} from '@tiptap/starter-kit';


/** 命令执行时能用的东西。 */
export interface SlashContext {
  /** 输入框。 */
  editor: tiptapCore.Editor;
  /** 打开选文件；accept 是 input[type=file] 的 accept（不写是全部文件）。 */
  pickFiles: (accept?: string) => void;
  /** 选一个会话：下一条直接发给它，不分派。 */
  chooseSession: () => void;
  /** 换和谁聊。 */
  chooseBot: () => void;
  /** 打开设置。 */
  openSettings: () => void;
  /** 打开快捷键帮助。 */
  openHelp: () => void;
  /** 清空输入框和附件。 */
  clearAll: () => void;
}


/** 命令执行时能用的界面动作（不含输入框；输入框由插件在执行时补上）。 */
export type SlashActions = Omit<SlashContext, 'editor'>;


/** 一条命令。 */
export interface SlashCommand {
  /** 名字（中文，列表里显示）。 */
  name: string;
  /** 别名：拼音、拼音首字母、英文。 */
  aliases: string[];
  /** 一句话说明。 */
  hint: string;
  /** 分组。 */
  group: '格式' | '附件' | '功能';
  /** 执行。 */
  run: (context: SlashContext) => void;
}


/** 这期的命令。 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '标题', aliases: ['bt', 'biaoti', 'heading', 'h2'], hint: '二级标题', group: '格式', run: ({ editor }) => void editor.chain().focus().toggleHeading({ level: 2 }).run() },
  { name: '列表', aliases: ['lb', 'liebiao', 'list', 'ul'], hint: '圆点列表', group: '格式', run: ({ editor }) => void editor.chain().focus().toggleBulletList().run() },
  { name: '编号', aliases: ['bh', 'bianhao', 'ordered', 'ol'], hint: '编号列表', group: '格式', run: ({ editor }) => void editor.chain().focus().toggleOrderedList().run() },
  { name: '引用', aliases: ['yy', 'yinyong', 'quote'], hint: '引用一段', group: '格式', run: ({ editor }) => void editor.chain().focus().toggleBlockquote().run() },
  { name: '代码块', aliases: ['dmk', 'daimakuai', 'code'], hint: '等宽的代码块', group: '格式', run: ({ editor }) => void editor.chain().focus().toggleCodeBlock().run() },
  { name: '分割线', aliases: ['fgx', 'fengexian', 'hr', 'line'], hint: '一条横线', group: '格式', run: ({ editor }) => void editor.chain().focus().setHorizontalRule().run() },
  { name: '图片', aliases: ['tp', 'tupian', 'image', 'img'], hint: '选图片发送', group: '附件', run: ({ pickFiles }) => pickFiles('image/*') },
  { name: '文件', aliases: ['wj', 'wenjian', 'file', 'attach'], hint: '选文件发送：音频、视频、文档都行', group: '附件', run: ({ pickFiles }) => pickFiles() },
  { name: '会话', aliases: ['hh', 'huihua', 'session'], hint: '选一个会话，这条直接发给它，不分派', group: '功能', run: ({ chooseSession }) => chooseSession() },
  { name: '机器人', aliases: ['jqr', 'jiqiren', 'bot'], hint: '换和谁聊', group: '功能', run: ({ chooseBot }) => chooseBot() },
  { name: '设置', aliases: ['sz', 'shezhi', 'settings', 'config'], hint: '打开设置', group: '功能', run: ({ openSettings }) => openSettings() },
  { name: '帮助', aliases: ['bz', 'bangzhu', 'help'], hint: '快捷键和用法', group: '功能', run: ({ openHelp }) => openHelp() },
  { name: '清空', aliases: ['qk', 'qingkong', 'clear'], hint: '清空输入框和附件', group: '功能', run: ({ clearAll }) => clearAll() },
];


/**
 * 按打的字过滤命令：名字或别名以它开头的排前面，包含它的排后面；没打字时全部。
 * @param query / 后面打的字。
 * @param commands 命令表（测试用；默认是 SLASH_COMMANDS）。
 */
export function filterCommands(query: string, commands: SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  /** 小写、去空白。 */
  const wanted = query.trim().toLowerCase();
  if (!wanted) {
    return commands;
  }
  /** 打分：0 开头对上，1 包含，undefined 不要。 */
  const score = (command: SlashCommand): number | undefined => {
    /** 名字和别名。 */
    const names = [command.name, ...command.aliases].map((name) => name.toLowerCase());
    if (names.some((name) => name.startsWith(wanted))) {
      return 0;
    }
    return names.some((name) => name.includes(wanted)) ? 1 : undefined;
  };
  return commands
    .map((command, index) => ({ command, index, rank: score(command) }))
    .filter((entry): entry is { command: SlashCommand; index: number; rank: number } => entry.rank !== undefined)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.command);
}
