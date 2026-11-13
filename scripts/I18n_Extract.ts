/**
 * 提取界面要翻译的原文（docs/界面/02_一个程序跑起来的规划.md 第 2 步）。
 * 扫 web/src 里所有 t('…')，再加上几张在显示处过 t() 的表里的文字（表在下面列明）。
 * 把缺的键写进 web/src/locales/{zh-TW,en,fr}.json：值先是空字符串，已有的不动；多余的键只列出来。
 * 按键排序、UTF-8、两格缩进。用法：bun scripts/I18n_Extract.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';


/** 仓库根目录（脚本在 scripts/ 下）。 */
const ROOT = path.resolve(import.meta.dirname, '..');

/** 网页源码目录。 */
const SRC = path.join(ROOT, 'web', 'src');

/** 语言包目录。 */
const LOCALES = path.join(SRC, 'locales');

/** 有语言包的语言（简体中文是原文，没有包）。 */
const PACKS = ['zh-TW', 'en', 'fr'] as const;


/**
 * 不在 t('…') 里、但显示时过 t() 的表里的文字（表里留原文）。
 * 改了这些表要同步改这里，提取脚本才认得出。
 */
export const TABLE_TEXTS: readonly string[] = [
  // Bots/Status.ts 的 STATUS_LOOKS：四种状态的名字。
  '等待中',
  '正在干活',
  '休闲中',
  '休假中',
  // Chat/SlashCommands.ts 的 SLASH_COMMANDS：名字、一句话说明、分组。
  '标题',
  '二级标题',
  '列表',
  '圆点列表',
  '编号',
  '编号列表',
  '引用',
  '引用一段',
  '代码块',
  '等宽的代码块',
  '分割线',
  '一条横线',
  '图片',
  '选图片发送',
  '文件',
  '选文件发送：音频、视频、文档都行',
  '会话',
  '选一个会话，这条直接发给它，不分派',
  '机器人',
  '换和谁聊',
  '设置',
  '打开设置',
  '帮助',
  '快捷键和用法',
  '清空',
  '清空输入框和附件',
  '格式',
  '附件',
  '功能',
  // Chat/HelpModal.tsx 的 SHORTCUTS：按键那一列和说明那一列。
  '发送',
  'Shift+Enter 或 Alt+Enter',
  '换行（中文输入法选字时按 Enter 不会发送）',
  '在行首或空格后打，弹出命令',
  '粗体 / 斜体 / 行内代码',
  '**字**、`代码`、- 列表、> 引用、```',
  'Markdown 写法，边写边变',
  '粘贴：剪贴板里是图片或文件就当附件',
  '拖文件进窗口',
  '当附件发：图片、音频、视频、文档都行',
  '收起右栏、关掉弹出的东西',
  '打开这份帮助（不在输入框里时）',
  // Settings/Settings.tsx 的 CATEGORIES：分类的名字和说明。
  '模型供应商',
  '左边选一家，右边配它的密钥、地址、协议和模型；想接几家接几家',
  '模型',
  '每个用途先选供应商，再选模型',
  '有几个列几个，每个的语言和渠道都在它下面',
  '搜索',
  '网页搜索按顺序试',
  '引擎',
  '轮询、步数、压缩、审核门槛、记忆搜索地址',
  '并发',
  '同一时间最多几个调用，超了排队',
  '服务',
  '后端的端口和 token',
  '基地',
  '基地的端口、窗口打开哪个后端、记忆库和 RAG 目录',
  '界面',
  '主题（存在这个浏览器里，不进 config.yaml）',
  '重连',
  '模型连不上、服务不对劲时用：重新测试模型连接、重启服务，不改 config.yaml',
  // Settings/Reconnect.tsx 的 USED_MODELS：设置里用到模型的地方（和“模型”“引擎”分类里的名字一样）。
  '默认模型 default_model',
  '决策模型 models.decision',
  '备用链 engine.fallback_chain',
  '看图的模型 engine.vision_model',
  '生图模型 image_model',
  '收尾模型 wrapup_model',
  // Panel/RightPanel.tsx 的 TABS：右栏各内容入口。
  '事件',
  '预览',
  '工作区',
  '消息',
  '待审核',
  '记忆',
  '详情',
  '用量',
  // Theme.ts 的 THEMES：主题的名字。
  '深色',
  '浅色',
  '科技',
  '护眼',
];


/**
 * 列出一个目录里所有 .ts、.tsx 文件。
 * @param dir 目录。
 * @returns 文件路径（顺序稳定）。
 */
function walk(dir: string): string[] {
  /** 收集到的文件。 */
  const files: string[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    /** 这一项。 */
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}


/**
 * 一个文件里 t('…') 的原文。
 * @param file 文件。
 * @returns 原文（按出现顺序，可能重复）。
 */
function keysInFile(file: string): string[] {
  /** 文件内容。 */
  const text = fs.readFileSync(file, 'utf8');
  /** 语法树（注释会被丢掉，注释里写的 t(...) 不算）。 */
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  /** 找到的原文。 */
  const keys: string[] = [];
  /**
   * 往下找 t('…')。
   * @param node 当前节点。
   */
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
      /** 第一个参数。 */
      const first = node.arguments[0];
      if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
        keys.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
}


/**
 * 全部要翻译的原文：t('…') 里的，加上表里的。
 * @returns 排好序、去过重。
 */
export function collectKeys(): string[] {
  /** 全部原文。 */
  const keys = new Set<string>();
  for (const file of walk(SRC)) {
    for (const key of keysInFile(file)) {
      keys.add(key);
    }
  }
  for (const text of TABLE_TEXTS) {
    keys.add(text);
  }
  return [...keys].sort();
}


/**
 * 读一个语言包；还没有就是空表。
 * @param language 语言代码。
 */
function readPack(language: string): Record<string, string> {
  /** 文件。 */
  const file = path.join(LOCALES, `${language}.json`);
  if (!fs.existsSync(file)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
}


/**
 * 写一个语言包：按键排序、两格缩进、结尾换行。
 * @param language 语言代码。
 * @param pack 语言包。
 */
function writePack(language: string, pack: Record<string, string>): void {
  /** 排好序的表。 */
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(pack).sort()) {
    sorted[key] = pack[key]!;
  }
  fs.writeFileSync(path.join(LOCALES, `${language}.json`), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}


/**
 * 提取并把缺的键写进三个语言包。
 * @returns 键、每个包新增的键、每个包多余的键。
 */
export function extract(): { keys: string[]; added: Record<string, string[]>; extra: Record<string, string[]> } {
  /** 全部原文。 */
  const keys = collectKeys();
  /** 每个包的新增和多余。 */
  const added: Record<string, string[]> = {};
  const extra: Record<string, string[]> = {};
  for (const language of PACKS) {
    /** 现在的包。 */
    const pack = readPack(language);
    /** 缺的。 */
    const missing = keys.filter((key) => !(key in pack));
    for (const key of missing) {
      pack[key] = '';
    }
    added[language] = missing;
    extra[language] = Object.keys(pack).filter((key) => !keys.includes(key));
    writePack(language, pack);
  }
  return { keys, added, extra };
}


if (import.meta.main) {
  /** 提取结果。 */
  const result = extract();
  console.log(`提取到 ${result.keys.length} 个键。`);
  for (const language of PACKS) {
    console.log(`${language}：新增 ${result.added[language]!.length} 个，多余 ${result.extra[language]!.length} 个${result.extra[language]!.length > 0 ? `（${result.extra[language]!.join('、')}）` : ''}`);
  }
}
