/**
 * 审核用的程序规则和“同意 3”这类说法的认法。都是纯函数，不问模型。
 * 正则照 0.4 原样搬（src/executors/ExecRules.ts、src/capabilities/Approvals.ts:60-104），这套正则踩过坑，不重写。
 * 规则的来历（用户 11-03）：发个文档也要他放行，嫌烦；同一天有机器人用 findstr 读 config.yaml，决策模型给了 0.94 直接放行，
 * 飞书密钥泄露。所以：碰密钥文件的命令直接拒绝；项目自己的检查直接放行；跑本地脚本的，把脚本内容读出来一起给审核看。
 * 用户 11-18 #169：任务写明了、目录可信的也直接放行（getUntrusted），删系统、删注册表、删数据、格式化（mustAsk）照旧人审。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as aobbShot from '../../../ztools/aobb-shot/Options.ts';
import * as embedded from '../../utils/Embedded.ts';
import * as sourceDirModule from '../../utils/SourceDir.ts';
import * as workspaceModule from '../../utils/Workspace.ts';


/**
 * guest（飞书上没登记、或登记成 guest 的人，比如群里用户的朋友）说的那一轮只能用的工具：查、读、搜、答。
 * 不在表里的一律不给，新插件登记的工具默认算动手，要放给别人用得在这里加。每个工具做什么、为什么这么分，
 * 见 docs/开发进度/131_群聊转话_20261117.md。
 * 不给的：exec、write、edit、feishu_send_file、feishu_doc、feishu_doc_delete、image_generate、memory（会写记忆）、
 * reply（话里 @路径 会把本机文件发出去）、note_claude、notify_user、agent_task、stop_session。
 * 也不给 list_sessions（列这个机器人干活的会话和总结，旧的没记客户的后台会话会一起列出来）、
 * wechat_history（读用户微信里这场会话的原文，是用户的私人聊天）。
 * history、history_search、history_get 给：只查这场前台（飞书群是这个群、私聊是这个人）和它交办的后台；非本人那一轮不带旧后台（bots/FrontDesk.ts 的 scopeIds）。
 * hand_session 给：交出去的后台会话带着同一个回话地址，在那边一样只有这些工具，工作区也是他的目录。
 * workspace 给（11-17）：外人看自己范围里的工作区（workspaces 插件按范围挡）；只许 OTHERS_WORKSPACE_ACTIONS 里的动作，
 *   建、改名、归档在 approval 的 session/before-tool 关口拦下。
 * channel_search 给（11-18）：memory 插件的渠道消息查询，外人只查得到这一轮这个聊天（ChannelIndex.ts 照来源快照挡）。
 */
export const READ_ONLY_TOOLS = new Set([
  'time', 'read', 'list_dir', 'find', 'web_search', 'skill',
  'history', 'history_search', 'history_get', 'hand_session',
  'memory_search', 'memory_get',
  'channel_reply', 'channel_history', 'channel_mentions', 'channel_visible_history',
  'react', 'ask', 'todo', 'relay_send', 'workspace', 'channel_search',
]);

/** 外人（guest、builder）用 workspace 工具只许这几个动作：看清单、看一个。 */
export const OTHERS_WORKSPACE_ACTIONS = new Set(['list', 'get']);

/**
 * builder（登记了能让机器人写代码、跑程序的人）说的那一轮能用的：只读的那些，加上在他自己目录里动手的
 * exec、write、edit、feishu_send_file。目录由飞书写进回话地址的 workspace，这几个工具照它落路径（utils/Workspace.ts 的 of）。
 * 别的动手的（memory、reply、notify_user、agent_task、stop_session、note_claude、image_generate、feishu_doc）照样不给。
 */
export const BUILDER_TOOLS = new Set([...READ_ONLY_TOOLS, 'exec', 'write', 'edit', 'feishu_send_file']);


/**
 * 这一档能用哪些工具。
 * @param role 回话地址里的 role（飞书照插件配置的 people 写）；没写（网页、命令行、微信、小会话）当本人。
 * @returns 能用的工具名；undefined 是不限。
 */
export function toolsFor(role: string): Set<string> | undefined {
  if (role === 'guest') return READ_ONLY_TOOLS;
  if (role === 'builder') return BUILDER_TOOLS;
  return undefined;
}


/** 去掉命令前面不影响判断的部分后的样子。 */
export interface ParsedCommand {
  /** 命令里 cd 到的目录；没有 cd 时是 undefined。 */
  cdDir?: string;
  /** 去掉 chcp、cd 之后剩下的命令。 */
  rest: string;
}


/** 用户打字回答待确认：同意或拒绝（可以点号、可以说全部），或者问还有哪些在等。 */
export type Reply = { approve: boolean; id?: number; all?: boolean } | { list: true };


/** 算“同意”的说法：只收说得明确的；“好”“可以”这种可能在答别的。 */
const APPROVE_WORDS = new Set(['同意', '同意执行', '同意執行', '放行', '批准', '执行', '執行', '确认执行', '確認執行', 'approve', 'approved', 'allow', 'approuver', 'autoriser']);

/** 算“拒绝”的说法：拒绝错了只是多问一句，可以宽一点。 */
const REJECT_WORDS = new Set(['拒绝', '拒絕', '不同意', '不行', '不要', '别执行', '別執行', '不要执行', '不要執行', '取消', 'reject', 'rejected', 'deny', 'no', 'refuser', 'non']);

/** 说的是待确认。 */
const CARD_WORDS = /待审核|待審核|待确认|待確認|审核卡|審核卡|审批|審批|确认卡|確認卡|approvals?|validations?/;

/** 要再看一次（0.4 是“再发一次卡片”，这里改成列出还在等的）。 */
const LIST_WORDS = /再发|再發|重发|重發|再来|再來|发一下|發一下|发一次|發一次|发我|發我|看看|有哪些|resend|again|show|renvoyer|renvoie/;

/** 比这长的话不当成在回答待确认。 */
const MAX_REPLY_CHARS = 60;


/**
 * 去掉开头的 “chcp 65001 >nul &” 和 “cd [/d] 目录 &&”。
 * @param command 原命令。
 */
export function parseCommand(command: string): ParsedCommand {
  //M 先去掉开头的 chcp，再认开头的 cd：认到了就记下目录、把这一段从命令里切掉。
  let rest = command.trim().replace(/^chcp\s+\d+\s*>\s*nul\s*&&?\s*/i, '');
  let cdDir: string | undefined;
  const cd = /^cd\s+(?:\/d\s+)?("[^"]+"|\S+)\s*&&\s*/i.exec(rest);
  if (cd !== null) {
    cdDir = (cd[1] ?? '').replace(/^"|"$/g, '');
    rest = rest.slice(cd[0].length);
  }

  //M 交回 cd 的目录和剩下的命令，调用方只看剩下的。
  return { cdDir, rest: rest.trim() };
}


/**
 * 命令碰没碰密钥文件（config.yaml、.env、secrets.yaml、credentials）。config.example.yaml、.env.example 不算。
 * @param command 原命令。
 * @returns 碰到的文件名；没碰是 undefined。
 */
export function touchesSecret(command: string): string | undefined {
  //M 在命令里找密钥文件名（前后要是分隔符，免得把 config.example.yaml 当成 config.yaml）。
  const found = /(?:^|[\\/\s"'=])(config\.ya?ml|\.env(?!\.example)(?:\.[\w-]+)?|secrets\.ya?ml|\.credentials\.\w+|credentials\.json)(?=$|[\s"'&|;>)])/i.exec(command);
  return found?.[1];
}


/**
 * 是不是项目自己的检查、编译、发布或换版本，而且没用 &、|、; 接别的命令（末尾的 2>&1 可以有）：
 *   bun run typecheck、typecheck:src7、lint、test、test:src7、release；bun test …；
 *   bun scripts/Swap_Serve.ts、Build_Release.ts、Build_Src7.ts，参数只许“--键 值”，值可以是带中文的路径。
 * 外面的程序（比如在别的机器上写代码的 AI）经 POST /api/run 让 jmbots 编译 src7，靠这条不问人直接跑（用户 11-16 定）。
 * @param command 原命令。
 * @param cwd 真实执行目录，AOBB 相对脚本必须在源码根运行。
 * @param runtimeRoot 运行时根，用于编译版定位宿主上的源码。
 */
export function isProjectCheck(command: string, cwd?: string, runtimeRoot?: string): boolean {
  //M AOBB 只匹配原始单条命令，避免原规则的 cd 前缀解析扩大它的边界。
  if (cwd !== undefined && isProjectShot(command, cwd, runtimeRoot)) return true;

  //G 先去掉开头的 cd 和末尾的 2>&1；还带 &、|、; 这类接别的命令的符号，就不算项目自己的检查。
  const rest = parseCommand(command).rest.replace(/\s*2>&1\s*$/, '');
  if (/[&|;<>`]/.test(rest)) return false;

  //M 拼出允许的几种命令的样子，整条对得上才算。typecheck:src7、test:src7 的后缀是源码根目录名（src7/utils/SourceDir.ts）。
  const suffix = sourceDirModule.SOURCE_DIR;
  const run = String.raw`run\s+(?:typecheck(?::${suffix})?|lint|test(?::${suffix})?|release)`;
  const test = String.raw`test(?:\s+[\w./\\-]+)*`;
  const script = String.raw`scripts[\\/](?:Swap_Serve|Build_Release|Build_Src7)\.ts(?:\s+--\w+\s+[\p{L}\p{N}_.:\\/-]+)*`;
  const pattern = new RegExp(String.raw`^bun(?:\.cmd)?\s+(?:${run}|${test}|${script})$`, 'iu');
  return pattern.test(rest);
}

/** 校验 AOBB 审核的精确执行目录及真实脚本位置。 */
function isProjectShot(command: string, cwd: string, runtimeRoot: string | undefined): boolean {
  let root = path.resolve(import.meta.dir, '..', '..', '..');
  //M 源码用当前仓库。编译版则从实际运行时的配置目录还原源码布局。
  if (embedded.isCompiled()) {
    if (runtimeRoot === undefined) return false;

    //M 打包版不从 bunfs 取源码，按运行时配置根找到 aidata 里的 source/jmbots。
    root = path.resolve(runtimeRoot, '..', '..', 'source', 'jmbots');
  }
  //G 保留旧项目检查行为，AOBB 只在真实源码根放行。
  if (path.relative(root, cwd) !== '' || !aobbShot.isAobbShotCommand(command, root)) return false;

  const file = path.join(root, 'ztools', 'aobb-shot', 'Aobb_Shot.ts');
  try {
    //G 同名脚本或目录链接不能指向项目树外的同名入口。
    const actual = fs.realpathSync(file);
    return path.relative(file, actual) === '';
  } catch {
    return false;
  }
}


/**
 * 命令要跑的本地脚本（bun/node/python/py/tsx 后面的 .ts/.js/.mjs/.cjs/.py，pwsh -File 后面的，或直接 .cmd/.bat），读前 4000 字。
 * @param command 原命令。
 * @param cwd 执行目录（命令里有 cd 时以 cd 的目录为准）。
 * @returns 脚本路径和内容；找不到、读不了是 undefined。
 */
export function readScript(command: string, cwd: string): { file: string; content: string } | undefined {
  //M 去掉开头的 cd，再按 bun/node/pwsh/.cmd 几种写法认出要跑的脚本名。
  const { cdDir, rest } = parseCommand(command);
  const target =
    /^(?:bun(?:\.cmd)?|node|python3?|py|tsx)\s+(?:run\s+)?("[^"]+\.(?:ts|js|mjs|cjs|py)"|\S+\.(?:ts|js|mjs|cjs|py))(?:\s|$)/i.exec(rest)?.[1] ??
    /^(?:pwsh|powershell)(?:\.exe)?\s+(?:-\w+\s+)*-File\s+("[^"]+"|\S+)/i.exec(rest)?.[1] ??
    /^("[^"]+\.(?:cmd|bat)"|\S+\.(?:cmd|bat))(?:\s|$)/i.exec(rest)?.[1];
  if (target === undefined) return undefined;

  //M 命令里 cd 过的，脚本的相对路径照 cd 后的目录算。
  let baseDir = cwd;
  if (cdDir !== undefined) {
    baseDir = path.resolve(cwd, cdDir);
  }

  //M 脚本解成绝对路径，读前 4000 字交回；读不了当没有。
  const file = path.resolve(baseDir, target.replace(/^"|"$/g, ''));
  try {
    return { file, content: fs.readFileSync(file, 'utf8').slice(0, 4000) };
  } catch {
    return undefined;
  }
}


/**
 * 认出用户打字说的是不是在回答待确认。
 * @param text 用户的原话。
 * @returns 同意/拒绝（带号、全部），或者“有哪些”；不是就 undefined。
 */
export function parseReply(text: string): Reply | undefined {
  //M 去掉结尾的标点、转小写；太长的、带 @ 的都不算。
  const plain = text.trim().toLowerCase().replace(/[\s。．.!！~～,，、;；?？]+$/u, '');
  if (plain === '' || plain.length > MAX_REPLY_CHARS || plain.includes('@')) return undefined;

  //M 说的是“待确认有哪些”：直接交回 list，不用再认同意、拒绝。
  if (CARD_WORDS.test(plain) && (LIST_WORDS.test(plain) || plain.length <= 6)) return { list: true };

  //M 号在后面（同意 3、同意#3）或前面（3 同意）。
  const tail = /^(.+?)[\s#＃]*(\d+)$/u.exec(plain);
  const head = /^[#＃]?(\d+)\s*(.+)$/u.exec(plain);
  const idText = tail?.[2] ?? head?.[1];
  const words = tail?.[1] ?? head?.[2] ?? plain;

  //M 再去掉“全部”。
  const core = words.replace(/^(全部|全都|都|所有)/u, '').replace(/^all\s+|\s+all$/u, '').trim();
  if (!APPROVE_WORDS.has(core) && !REJECT_WORDS.has(core)) return undefined;

  //M 拼回复：同意还是拒绝，有号带号，说了“全部”带 all。
  const reply: { approve: boolean; id?: number; all?: boolean } = { approve: APPROVE_WORDS.has(core) };
  if (idText !== undefined) {
    reply.id = Number(idText);
  }
  if (core !== words) {
    reply.all = true;
  }
  return reply;
}



/** 删东西的命令（rd/rmdir、del/erase、rm -r/-f、Remove-Item）。 */
const DELETE = /\b(?:rd|rmdir|del|erase)\b|\brm\b[^&|;\n]*\s-[a-z]*[rf]|\b(?:Remove-Item|ri)\b/i;

/** 删注册表（reg delete、Remove-ItemProperty、Remove-Item HKLM:\…）。 */
const REGISTRY_DELETE = /\breg(?:\.exe)?\s+delete\b|\bRemove-ItemProperty\b|\b(?:Remove-Item|ri)\b[^&|;\n]*\bHK(?:LM|CU|CR|U|CC):/i;

/** 格式化磁盘。 */
const FORMAT = /\bformat(?:\.com)?\s+[a-z]:/i;

/** 系统目录（盘符根、Windows、Program Files、ProgramData、System32；/etc、/usr……）。 */
const SYSTEM_DIR = /^(?:[a-z]:[\\/]*(?:\*[^\\/]*)?$|[a-z]:[\\/]+(?:windows|program files(?: \(x86\))?|programdata)(?:[\\/]|$)|.*[\\/]system32(?:[\\/]|$)|\/(?:$|etc|usr|bin|sbin|boot|lib|lib64|sys|proc|System|Library)(?:\/|$))/i;

/** 命令里的绝对路径（Windows 盘符、带引号的带空格路径、POSIX 根）。 */
const ABS_PATH = /"[a-z]:[\\/][^"]*"|[a-z]:[\\/][^\s"'|&<>;]*|(?<=^|[\s"'=])\/[^\s"'|&<>;]*/gi;

/** Windows 命令的开关（/s、/q、/f:x）：长得像 POSIX 绝对路径，不算路径。 */
const SWITCH = /^\/[a-z?]{1,3}(?::\S*)?$/i;

/** 写了环境变量、~ 的路径（%TEMP%、$HOME、$env:TEMP、${X}、~/x）：算不出落在哪。 */
const ENV_REF = /%[^%\s]+%|\$(?:env:)?\w|\$\{|(?:^|[\s"'=])~(?=$|[\\/\s])/i;

/** 往上走（有 .. 这一段）、从当前盘根算（\ 开头，含 \\共享）、只写盘符不带斜杠（D:x）的相对路径。 */
const UP_OR_ROOTED = /^\\|^[a-z]:(?![\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/i;

/** 把命令拆成一段段：按空白、引号、管道、重定向、分号、等号切开。 */
const TOKEN_SPLIT = /[\s"'|&<>;=]+/;


/**
 * 命令里写的绝对路径（去掉引号）。mustAsk、getUntrusted、审批卡片的“动哪些”共用。
 * Windows 的开关不算；/etc 这种系统目录照算。网址（https://）里的“s:/”前面紧挨着字母，不是盘符，不算。
 * @param command 原命令。
 * @returns 绝对路径，照命令里出现的先后。
 */
export function getAbsPaths(command: string): string[] {
  //M 在命令里逐个找绝对路径，滤掉网址、Windows 开关，剩下的收进 found。
  const found: string[] = [];
  for (const match of command.matchAll(ABS_PATH)) {
    //G 前面紧挨着字母、数字：是网址的协议名（https://），不是盘符。
    const index = match.index ?? 0;
    const before = command.charAt(index - 1);
    if (/\w/.test(before)) continue;

    //G Windows 的开关不算路径（系统目录照算）。
    const item = match[0].replace(/^"|"$/g, '');
    const isSwitch = !SYSTEM_DIR.test(item) && SWITCH.test(item);
    if (isSwitch) continue;

    //M 剩下的是真路径，记下来。
    found.push(item);
  }
  return found;
}


/**
 * 命令是不是只动可信目录里的东西（用户 11-18 #169）：执行目录、命令开头 cd 到的目录、命令里写的每个绝对路径、
 * 带 .. 往上走的和从盘根算的相对路径，解开后都要落在 dirs 里。写了环境变量、~ 的算不出落在哪，不算。
 * 只看路径，不看命令做什么：删系统、删注册表、删数据、格式化由调用方先用 mustAsk 拦下。
 * @param command 原命令。
 * @param cwd 执行目录，绝对路径。
 * @param dirs 可信目录（Workspace.ts 的 getPathKey 算过的）；空的就一个都不信。
 * @returns 都在里面是 undefined；不算可信时交回一句具体原因（写进审批卡片的“为什么问你”，用户 #172）。
 */
export function getUntrusted(command: string, cwd: string, dirs: string[]): string | undefined {
  if (dirs.length === 0) return '没配可信目录';

  //G 环境变量、~ 开头的路径算不出落在哪：不算可信，照原来的流程审。
  if (ENV_REF.test(command)) return '命令里写了环境变量或 ~，算不出动到哪里';

  //M 命令开头 cd 过去的目录算这条命令的执行目录（相对的照 cwd 解开）。
  const { cdDir } = parseCommand(command);
  let base = cwd;
  if (cdDir !== undefined) {
    base = path.resolve(cwd, cdDir);
  }

  //M 要查的：执行目录、cd 到的目录、绝对路径，和往上走、从盘根算的相对路径（照 cd 后的目录解开）。
  const relatives = command.split(TOKEN_SPLIT).filter((token) => UP_OR_ROOTED.test(token));
  const absolutes = getAbsPaths(command);
  const targets = [cwd, base, ...absolutes, ...relatives];

  //M 每一个都要落在某个可信目录里；.. 跳出去的、换了盘的都不算，交回第一个不在里面的。
  for (const target of targets) {
    const full = path.resolve(base, target);
    const key = workspaceModule.getPathKey(full);
    if (!workspaceModule.isUnder(dirs, key)) return `${full} 不在可信目录里`;
  }
  return undefined;
}


/**
 * 必须人审的很小一块（用户 11-14：不做通用的命令行防御，只管这三样）：删系统级文件或目录、删注册表、删数据（数据目录里的，机器人工作区除外）。
 * 命中就不交给决策模型、审核小会话自动放行；别的照原来的流程。
 * @param command 原命令。
 * @param dataRoot 数据目录（绝对路径）。
 * @param cwd 执行目录：命令里没写绝对路径时，删的就是这里的东西。
 * @returns 要人审的原因；不归这里管的是 undefined。
 */
export function mustAsk(command: string, dataRoot: string, cwd: string): string | undefined {
  //G 删注册表、格式化直接要人审；根本不是删东西的命令，不归这里管。
  if (REGISTRY_DELETE.test(command)) return '删注册表，要你亲自确认';
  if (FORMAT.test(command)) return '格式化磁盘，要你亲自确认';
  if (!DELETE.test(command)) return undefined;

  //M 路径统一成小写、反斜杠、不带结尾斜杠，好和数据目录比。
  const norm = (value: string): string => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const root = norm(dataRoot);

  //M 命令里写的绝对路径（getAbsPaths：Windows 的开关、网址不算，/etc 这种系统目录照算）。
  const found = getAbsPaths(command);
  let targets = [cwd];
  if (found.length > 0) {
    targets = found;
  }
  for (const target of targets) {
    //G 删的是系统目录里的东西：直接要人审。
    if (SYSTEM_DIR.test(target)) return `删系统目录里的东西（${target}），要你亲自确认`;

    //G 删的是数据目录里的东西（机器人工作区除外）：要人审。
    const t = norm(target);
    const inData = t === root || t.startsWith(root + '\\');
    const inWorkspace = /^bots\\[^\\]+\\workspace(?:\\|$)/.test(t.slice(root.length + 1));
    if (inData && !inWorkspace) return `删数据目录里的东西（${target}），要你亲自确认`;
  }
  return undefined;
}
