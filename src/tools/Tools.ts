/**
 * 默认工具（用户 11-02 定的 6 个，后来加了 taskdbread）：
 *   read          读文件（照 Pi：分段读、截断后告诉模型从哪行接着读）
 *   edit          改文件（照 Pi：几处唯一替换，精确找不到再宽松找；另可 content 整篇写入）
 *   exec          执行命令（照 Pi 的 bash：输出留结尾）：由 Engine 先审核（决策模型或用户确认），这里只管执行
 *   find          按文件名找文件
 *   grep          按内容搜文件（中文文档正文也能搜），只读，不用审核
 *   codegraph     查代码关系：声明在哪、谁调用它、它调用谁、文件依赖（实现在 CodeGraph.ts，用 TypeScript 语言服务；
 *                 用户 11-02 要类似 graphify 的工具，三个 graphify 实测都漏边，改成自己做）
 *   taskdbsearch  查数据库里的会话和执行：可按机器人、工作区、智能体、来源、状态、种类查
 *   taskdbread    读一个会话的完整对话：每次的输入、每一步的回复、调了什么工具、结果（先不管权限，所有会话都能读）
 *   taskdbinsert  插入一个任务事件：插进当前会话就在后面接着做，也可以新开会话交给别的机器人
 *   judge_batch   批量快速判断：一个问题、一组条目，决策模型逐个判“是不是”（几百毫秒一个，按模型并发上限排队）
 *                 用户 11-02 的“分派模型”设想：要从很多文件、事情里挑时，先这样快速筛一遍，再细看
 *   note_claude   给 Claude 留话（写进运行时 integrations\claude\给Claude\，Claude 定时看）：卡住了、发现 jmbots 自己的问题、想让 Claude 改代码
 * 外加渠道工具（渠道开着才有）：
 *   feishu_send   通过飞书给用户发消息（会话来自飞书就发回那个聊天，否则发给最近私聊过的人）
 *
 * 路径：相对路径以工作区目录为准，绝对路径直接用。第一版先不做沙箱（用户：“第一版你不要老是考虑安全，先把最小闭环做了”）。
 * 工具定义（名字、说明、参数格式）和实现放在一起，改一处不会忘另一处。
 * read、edit、exec、find 的做法抄自 Pi（F:\aidata\source\Pi\packages\coding-agent\src\core\tools），
 * 只抄了工具本身的逻辑，截断在 Truncate.ts，edit 的匹配在 EditMatch.ts。grep 参数照 Pi，实现自己写（不依赖 rg）。
 */
import * as piAi from '@earendil-works/pi-ai';
import * as child from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as checks from '../utils/Checks.ts';
import * as utils from '../utils/Utils.ts';
import * as codeGraph from './CodeGraph.ts';
import * as editMatch from './EditMatch.ts';
import * as truncate from './Truncate.ts';
import type * as modelModule from '../core/Model.ts';
import type * as eventsModule from '../store/Events.ts';


/** 默认工具名；机器人、智能体没写 tools 时全给。 */
export const DEFAULT_TOOLS = ['read', 'edit', 'exec', 'find', 'grep', 'codegraph', 'taskdbsearch', 'taskdbread', 'taskdbinsert', 'judge_batch', 'note_claude'];


/** taskdbread 一次最多返回多少字。 */
const READ_SESSION_MAX_CHARS = 20_000;


/** grep 跳过超过这么大的文件（多半是数据或打包产物）。 */
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** grep 每行最多显示多少字。 */
const GREP_MAX_LINE_CHARS = 300;

/** judge_batch 一次最多判断几个条目。 */
const JUDGE_MAX_ITEMS = 200;


/** 插入任务时要给的东西（Engine 的 submit 收的就是它）。 */
export interface SubmitInput {
  /** 要做的事。 */
  input: string;
  /** 来源，如“命令行”“飞书私聊 oc_xxx”“AI（会话 X）”。 */
  source: string;
  /** 接着哪个会话；不写就新开。 */
  sessionId?: string;
  /** 交给哪个机器人。 */
  bot?: string;
  /** 交给哪个智能体。 */
  agent?: string;
  /** 直接用哪个模型。 */
  model?: string;
  /** 放在哪个工作区。 */
  workspace?: string;
  /** 新会话的标题（分派时 AI 起的）；不写用输入的开头。 */
  title?: string;
  /** 交给机器人、智能体时，这个会话用的模型（覆盖角色自己的；分派按模型能力评价选）。 */
  useModel?: string;
  /** 交给机器人、智能体时，这个会话用的思考强度。 */
  useThinking?: string;
  /** 新会话的种类：task 执行对话（默认），route 分派对话。 */
  kind?: 'task' | 'route';
  /** 这次执行额外加的系统提示词积木（分派对话用它放分派规矩和现状）。 */
  system?: Record<string, string>;
  /** 这次执行只给这些工具（不写按角色的设置）。 */
  tools?: string[];
  /** 这次执行用什么判断下一步（不写按角色的设置）。 */
  judge?: string;
}


/** 工具执行时能用的东西，由 Engine 每步准备好传进来。 */
export interface ToolContext {
  /** 工作区目录：相对路径以它为准，exec 在这里执行。 */
  workDir: string;
  /** 当前会话。 */
  sessionId: string;
  /** 数据库。 */
  store: eventsModule.EventStore;
  /** 插入任务事件（Engine.submit）。 */
  submit(input: SubmitInput): { sessionId: string; eventId: number };
  /** 通过飞书发消息；飞书没开时没有。 */
  sendFeishu?: (sessionId: string, text: string) => Promise<string>;
  /** exec 的默认超时，毫秒。 */
  execTimeoutMs: number;
  /** 运行时目录（note_claude 往 integrations\claude\给Claude 写文件）。 */
  runtimeDir: string;
  /** 调决策模型（judge_batch 用）；没配决策模型时没有。 */
  decide?: (input: modelModule.DecideInput) => Promise<modelModule.DecideOutput>;
}


/** 一个工具：给模型看的定义，加上执行函数。 */
interface ToolEntry {
  /** 给模型看的名字、说明、参数格式。 */
  definition: piAi.Tool;
  /**
   * 执行。
   * @param args 模型给的参数（已经是对象）。
   * @param context 执行环境。
   * @returns 结果，原样记进数据库、交给模型。
   * @throws 参数不对、执行失败时抛错，由 Engine 记成失败并告诉模型。
   */
  run(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}


/**
 * 相对路径以工作区为准，绝对路径直接用。模型有时在路径前加 @，去掉。
 * @param context 执行环境。
 * @param value 模型给的路径。
 */
function resolvePath(context: ToolContext, value: unknown): string {
  return path.resolve(context.workDir, checks.requireString(value, 'path').replace(/^@/, ''));
}


/**
 * 可选的正整数参数：没给是 undefined，给了必须是正整数。
 * @param value 模型给的值。
 * @param name 参数名（报错用）。
 */
function optionalPositive(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  /** 数字。 */
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} 要是正整数`);
  }
  return number;
}


/**
 * 结束一个进程和它启动的子进程（Windows 上 cmd.exe 下面的命令不会跟着 cmd.exe 一起退出，要用 taskkill /T）。
 * @param processHandle 进程。
 */
function killTree(processHandle: child.ChildProcess): void {
  if (process.platform === 'win32' && processHandle.pid) {
    child.spawn('taskkill', ['/pid', String(processHandle.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  processHandle.kill('SIGKILL');
}


/** 全部工具：名字 → 定义和实现。 */
const TOOLS: Record<string, ToolEntry> = {
  // 照 Pi 的 read：offset 从 1 数，先按 limit 取行，再按 2000 行 / 50KB 截断，并告诉模型从哪行接着读。
  read: {
    definition: {
      name: 'read',
      description:
        `读文本文件。相对路径以工作区目录为准。一次最多 ${truncate.DEFAULT_MAX_LINES} 行或 ${truncate.DEFAULT_MAX_BYTES / 1024}KB，` +
        '超出时结果末尾会写从哪行接着读；大文件用 offset、limit 分段读。',
      parameters: piAi.Type.Object({
        path: piAi.Type.String({ description: '文件路径（相对或绝对）' }),
        offset: piAi.Type.Optional(piAi.Type.Number({ description: '从第几行开始读，从 1 数' })),
        limit: piAi.Type.Optional(piAi.Type.Number({ description: '最多读几行' })),
      }),
    },
    async run(args, context) {
      /** 文件路径。 */
      const file = resolvePath(context, args.path);
      /** 起始行（从 1 数）。 */
      const offset = optionalPositive(args.offset, 'offset') ?? 1;
      /** 行数上限（模型给的）。 */
      const limit = optionalPositive(args.limit, 'limit');
      /** 全部行。 */
      const lines = (await fs.readFile(file, 'utf8')).split('\n');
      //G 起始行超出文件。
      if (offset > lines.length) {
        throw new Error(`offset ${offset} 超出了文件末尾（一共 ${lines.length} 行）`);
      }

      //M 先按 offset、limit 取行，再按行数和字节数截断。
      /** 取到第几行（不含，下标）。 */
      const end = limit === undefined ? lines.length : Math.min(offset - 1 + limit, lines.length);
      /** 截断的结果。 */
      const result = truncate.truncateHead(lines.slice(offset - 1, end).join('\n'));

      //M 告诉模型还有没有、从哪行接着读。
      if (result.firstLineTooLong) {
        return `[第 ${offset} 行太长（${truncate.formatSize(Buffer.byteLength(lines[offset - 1] ?? '', 'utf8'))}），超过 ${truncate.formatSize(truncate.DEFAULT_MAX_BYTES)} 上限，读不出来；用 exec 截取这一行的一部分]`;
      }
      if (result.truncated) {
        /** 读到的最后一行（从 1 数）。 */
        const last = offset + result.outputLines - 1;
        return `${result.content}\n\n[显示第 ${offset}-${last} 行，共 ${lines.length} 行。用 offset=${last + 1} 接着读]`;
      }
      if (end < lines.length) {
        return `${result.content}\n\n[文件后面还有 ${lines.length - end} 行。用 offset=${end + 1} 接着读]`;
      }
      return result.content;
    },
  },

  // 照 Pi 的 edit：edits 里每处原文必须唯一、互不重叠，精确找不到再宽松找（见 EditMatch.ts）。
  // 另加 content：整篇写入（新建或覆盖），因为默认工具里没有单独的 write。
  edit: {
    definition: {
      name: 'edit',
      description:
        '改文件。两种用法：\n' +
        '1. edits：一处或几处替换，每处 oldText 必须和文件原文一字不差、在文件里只出现一次，几处之间不能重叠；都对照改之前的原文找。\n' +
        '2. content：整篇写入，文件不存在就新建（会建上级目录），存在就覆盖。\n' +
        'oldText 尽量短，但要足够唯一；改之前先用 read 看原文。',
      parameters: piAi.Type.Object({
        path: piAi.Type.String({ description: '文件路径（相对或绝对）' }),
        edits: piAi.Type.Optional(
          piAi.Type.Array(
            piAi.Type.Object({
              oldText: piAi.Type.String({ description: '要替换的原文，必须唯一' }),
              newText: piAi.Type.String({ description: '换成什么' }),
            }),
            { description: '替换列表' },
          ),
        ),
        content: piAi.Type.Optional(piAi.Type.String({ description: '整篇写入的内容；给了它就不看 edits' })),
      }),
    },
    async run(args, context) {
      /** 文件路径。 */
      const file = resolvePath(context, args.path);

      //M 整篇写入。
      if (typeof args.content === 'string') {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, args.content, 'utf8');
        return `已写入 ${file}（${truncate.formatSize(Buffer.byteLength(args.content, 'utf8'))}）`;
      }

      //M 替换：读修改列表，在原文上改好，再整篇写回。
      /** 修改列表。 */
      const edits = editMatch.readEdits(args);
      /** 改好的内容。 */
      const changed = editMatch.applyEdits(await fs.readFile(file, 'utf8'), edits, file);
      await fs.writeFile(file, changed, 'utf8');
      return `已修改 ${file}（${edits.length} 处）`;
    },
  },

  // 照 Pi 的 bash：stdout、stderr 合在一起，按 2000 行 / 50KB 留结尾。Engine 先审核，这里只管执行。
  exec: {
    definition: {
      name: 'exec',
      description:
        `在工作区目录执行一条命令（Windows 上是 cmd.exe，其他系统是 sh）。返回退出码和输出（stdout、stderr 合在一起），` +
        `输出超过 ${truncate.DEFAULT_MAX_LINES} 行或 ${truncate.DEFAULT_MAX_BYTES / 1024}KB 时只留最后一段。执行前会先审核，可能要等用户确认。`,
      parameters: piAi.Type.Object({
        command: piAi.Type.String({ description: '命令' }),
        timeout: piAi.Type.Optional(piAi.Type.Number({ description: '超时秒数，默认 120' })),
      }),
    },
    async run(args, context) {
      /** 命令。 */
      const command = checks.requireString(args.command, 'command');
      /** 超时毫秒。 */
      const timeoutMs = (optionalPositive(args.timeout, 'timeout') ?? context.execTimeoutMs / 1000) * 1000;
      await fs.mkdir(context.workDir, { recursive: true });
      /** 开始时间。 */
      const startedAt = Date.now();

      //M 起进程，收输出，等它结束或超时。
      /** 收到的输出块。 */
      const chunks: Buffer[] = [];
      /** 退出码和是否超时。 */
      const ended = await new Promise<{ code: number | null; timedOut: boolean; error?: string }>((resolve) => {
        // Windows 的 cmd.exe 默认按 GBK 输出中文，先切到 UTF-8（chcp 失败也不影响后面的命令）。
        /** 真正交给 shell 的命令。 */
        const shellCommand = process.platform === 'win32' ? `chcp 65001 >nul & ${command}` : command;
        /** 进程。 */
        // 环境变量 JMBOTS_SESSION_ID 告诉命令是哪个会话跑的（scripts/Swap_Serve.ts 换完版本后接着这个会话报结果）。
        const processHandle = child.spawn(shellCommand, { cwd: context.workDir, shell: true, windowsHide: true, env: { ...process.env, JMBOTS_SESSION_ID: context.sessionId } });
        /** 超时了没有。 */
        let timedOut = false;
        /** 超时计时器。 */
        const timer = setTimeout(() => {
          timedOut = true;
          killTree(processHandle);
        }, timeoutMs);
        processHandle.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        processHandle.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
        processHandle.on('error', (error) => {
          clearTimeout(timer);
          resolve({ code: null, timedOut, error: error.message });
        });
        processHandle.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, timedOut });
        });
      });

      //M 输出留结尾；截了就在前面说明。不管成败都交回去，退出码不是 0 由模型自己判断。
      /** 截断的结果。 */
      const result = truncate.truncateTail(Buffer.concat(chunks).toString('utf8'));
      /** 交给模型的输出。 */
      let output = result.content || '（没有输出）';
      if (result.truncated) {
        output = `[输出太长，只留最后 ${result.outputLines} 行（共 ${result.totalLines} 行）]\n${output}`;
      }
      return {
        exit_code: ended.code,
        timed_out: ended.timedOut,
        wall_time_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
        output,
        ...(ended.error ? { error: ended.error } : {}),
      };
    },
  },

  // 参数照 Pi 的 find（pattern、path、limit）；用 Bun 自带的通配符，跳过 node_modules 和 .git。
  find: {
    definition: {
      name: 'find',
      description: '按文件名找文件，支持通配符，如 *.ts、**/*.json、src/**/Main.ts。返回相对于起点目录的路径，跳过 node_modules 和 .git。',
      parameters: piAi.Type.Object({
        pattern: piAi.Type.String({ description: '通配符，如 **/*.md' }),
        path: piAi.Type.Optional(piAi.Type.String({ description: '从哪个目录找，默认工作区目录' })),
        limit: piAi.Type.Optional(piAi.Type.Number({ description: '最多几个，默认 1000' })),
      }),
    },
    async run(args, context) {
      /** 起点目录。 */
      const root = args.path === undefined ? context.workDir : resolvePath(context, args.path);
      /** 最多几个。 */
      const limit = optionalPositive(args.limit, 'limit') ?? 1000;
      /** 通配符。 */
      const glob = new Bun.Glob(checks.requireString(args.pattern, 'pattern'));
      /** 找到的文件（相对起点，统一用 /）。 */
      const matches: string[] = [];
      for await (const file of glob.scan({ cwd: root, onlyFiles: true, dot: true })) {
        if (/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(file)) {
          continue;
        }
        matches.push(file.replace(/\\/g, '/'));
        if (matches.length >= limit) {
          return `${matches.join('\n')}\n\n[只列了前 ${limit} 个，缩小范围或加大 limit]`;
        }
      }
      if (matches.length === 0) {
        return `${root} 下没有匹配 ${String(args.pattern)} 的文件`;
      }
      return matches.join('\n');
    },
  },

  // 参数照 Pi 的 grep（pattern、path、glob、ignoreCase、literal、limit）；自己逐个文件读，跳过 node_modules、.git、二进制和大文件。
  grep: {
    definition: {
      name: 'grep',
      description: '按内容搜文件，返回“文件:行号: 那一行”。默认把 pattern 当正则；搜中文或带符号的原文时加 literal。跳过 node_modules、.git、二进制文件和 2MB 以上的文件。',
      parameters: piAi.Type.Object({
        pattern: piAi.Type.String({ description: '要搜的内容（正则，或 literal 时的原文）' }),
        path: piAi.Type.Optional(piAi.Type.String({ description: '从哪个目录或文件搜，默认工作区目录' })),
        glob: piAi.Type.Optional(piAi.Type.String({ description: '只搜这些文件，如 **/*.md、src/**/*.ts' })),
        ignoreCase: piAi.Type.Optional(piAi.Type.Boolean({ description: '不分大小写，默认分' })),
        literal: piAi.Type.Optional(piAi.Type.Boolean({ description: '把 pattern 当原文，不当正则' })),
        limit: piAi.Type.Optional(piAi.Type.Number({ description: '最多几处，默认 100' })),
      }),
    },
    async run(args, context) {
      /** 要搜的内容。 */
      const pattern = checks.requireString(args.pattern, 'pattern');
      /** 正则（literal 时把特殊字符转义掉）。 */
      const regex = new RegExp(args.literal === true ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, args.ignoreCase === true ? 'i' : '');
      /** 最多几处。 */
      const limit = optionalPositive(args.limit, 'limit') ?? 100;
      /** 起点（目录或文件）。 */
      const start = args.path === undefined ? context.workDir : resolvePath(context, args.path);
      /** 起点是单个文件时只搜它。 */
      const single = (await fs.stat(start)).isFile();
      /** 起点目录。 */
      const root = single ? path.dirname(start) : start;
      /** 要搜的文件（相对起点目录）。 */
      const files = single
        ? [path.basename(start)]
        : await Array.fromAsync(new Bun.Glob(typeof args.glob === 'string' ? args.glob : '**/*').scan({ cwd: root, onlyFiles: true, dot: true }));
      /** 找到的行。 */
      const matches: string[] = [];
      for (const file of files) {
        if (/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(file)) {
          continue;
        }
        /** 完整路径。 */
        const full = path.join(root, file);
        if ((await fs.stat(full)).size > GREP_MAX_FILE_BYTES) {
          continue;
        }
        /** 文件内容（原始字节，先看是不是二进制）。 */
        const bytes = await fs.readFile(full);
        if (bytes.subarray(0, 8192).includes(0)) {
          continue;
        }
        /** 按行分开。 */
        const lines = bytes.toString('utf8').split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          /** 这一行。 */
          const line = lines[index] ?? '';
          if (!regex.test(line)) {
            continue;
          }
          matches.push(`${file.replace(/\\/g, '/')}:${index + 1}: ${line.length > GREP_MAX_LINE_CHARS ? `${line.slice(0, GREP_MAX_LINE_CHARS)}…` : line}`);
          if (matches.length >= limit) {
            return `${matches.join('\n')}\n\n[只列了前 ${limit} 处，缩小范围或加大 limit]`;
          }
        }
      }
      if (matches.length === 0) {
        return `${start} 下没有找到 ${pattern}`;
      }
      return matches.join('\n');
    },
  },

  codegraph: {
    definition: {
      name: 'codegraph',
      description: [
        '查 TypeScript/JavaScript 代码关系（用 TypeScript 语言服务，和编辑器“查找所有引用”一样准，嵌套函数、经对象属性转出去的调用都能查到）。',
        'action：find 按名字找声明；callers 谁用到它；callees 它调用了谁；deps 文件导入了什么；users 谁导入了这个文件；path 两个文件之间的导入路径。',
        'find、callers、callees 给 name（可写“外层.名字”，如 createEngine.handleMessage），可用 file 限定文件；deps、users 给 file；path 给 file 和 to。',
        '项目按 path（不给就用 file 或工作区目录）往上找最近的 tsconfig.json。查文档正文用 grep。',
      ].join(''),
      parameters: piAi.Type.Object({
        action: piAi.Type.Union(['find', 'callers', 'callees', 'deps', 'users', 'path'].map((value) => piAi.Type.Literal(value)), { description: '查什么' }),
        name: piAi.Type.Optional(piAi.Type.String({ description: '函数、方法、类等的名字' })),
        file: piAi.Type.Optional(piAi.Type.String({ description: '文件，相对 path（没给 path 时相对工作区）或绝对路径' })),
        to: piAi.Type.Optional(piAi.Type.String({ description: 'path 查询的终点文件' })),
        path: piAi.Type.Optional(piAi.Type.String({ description: '项目目录，默认工作区目录' })),
      }),
    },
    run(args, context) {
      /** 相对路径以它为准。 */
      const base = args.path === undefined ? context.workDir : resolvePath(context, args.path);
      /**
       * 把模型给的文件变成绝对路径。
       * @param value 模型给的值。
       */
      const toFile = (value: unknown): string | undefined => (value === undefined ? undefined : path.resolve(base, checks.requireString(value, 'file').replace(/^@/, '')));
      /** 文件。 */
      const file = toFile(args.file);
      return Promise.resolve(codeGraph.queryGraph({
        action: checks.requireString(args.action, 'action') as codeGraph.GraphQuery['action'],
        start: args.path === undefined ? (file ?? base) : base,
        name: typeof args.name === 'string' ? args.name : undefined,
        file,
        to: toFile(args.to),
      }));
    },
  },

  taskdbsearch: {
    definition: {
      name: 'taskdbsearch',
      description: '查数据库里的会话和它们最近的执行：可按会话 ID、机器人、智能体、工作区、来源、状态查，条件都可选。',
      parameters: piAi.Type.Object({
        session_id: piAi.Type.Optional(piAi.Type.String()),
        bot: piAi.Type.Optional(piAi.Type.String()),
        agent: piAi.Type.Optional(piAi.Type.String()),
        workspace: piAi.Type.Optional(piAi.Type.String()),
        source: piAi.Type.Optional(piAi.Type.String()),
        status: piAi.Type.Optional(piAi.Type.String({ description: '空闲、执行中、等待确认、出错' })),
        kind: piAi.Type.Optional(piAi.Type.String({ description: 'task 执行对话，route 分派对话；不写两种都列' })),
        limit: piAi.Type.Optional(piAi.Type.Number({ description: '最多几条，默认 20' })),
      }),
    },
    run(args, context) {
      /** 符合条件的会话。 */
      const sessions = context.store.listSessions({
        sessionId: args.session_id as string | undefined,
        bot: args.bot as string | undefined,
        agent: args.agent as string | undefined,
        workspace: args.workspace as string | undefined,
        source: args.source as string | undefined,
        status: args.status as string | undefined,
        kind: args.kind === 'task' || args.kind === 'route' ? args.kind : undefined,
        limit: args.limit === undefined ? undefined : Number(args.limit),
      });
      //M 每个会话附上最近 5 次执行的输入和状态。
      return Promise.resolve(
        sessions.map((session) => ({
          ...session,
          executions: context.store
            .listEvents(session.id, 'execution')
            .slice(-5)
            .map((event) => ({ id: event.id, status: event.status, input: (event.payload as SubmitInput).input, error: event.error })),
        })),
      );
    },
  },

  taskdbread: {
    definition: {
      name: 'taskdbread',
      description:
        '读一个会话的完整对话：每次执行的输入、每一步模型的回复、调了哪些工具和结果、最后的回复。' +
        '会话 ID 用 taskdbsearch 查。太长时只给前面的部分，可以用 offset 接着读。',
      parameters: piAi.Type.Object({
        session_id: piAi.Type.String(),
        offset: piAi.Type.Optional(piAi.Type.Number({ description: '从第几个字开始，默认 0' })),
      }),
    },
    run(args, context) {
      /** 会话 ID。 */
      const sessionId = checks.requireString(args.session_id, 'session_id');
      /** 会话。 */
      const session = context.store.getSession(sessionId);
      if (!session) {
        throw new Error(`没有会话 ${sessionId}`);
      }
      //M 拼成一篇文字：会话信息，然后每次执行、每一步。
      /** 各行。 */
      const lines = [
        `会话 ${session.id}「${session.title}」（${session.kind === 'route' ? '分派对话' : '执行对话'}，${session.status}，来源 ${session.source}，工作区 ${session.workspace}）`,
      ];
      for (const execution of context.store.listEvents(session.id, 'execution')) {
        lines.push('', `## 执行 ${execution.id}（${execution.status}）`, `用户：${(execution.payload as SubmitInput).input}`);
        /** 这次执行的工具结果。 */
        const results = context.store.listToolResults(execution.id);
        for (const step of context.store.listModelRequests(execution.id)) {
          /** 回复。 */
          const response = (step.response ?? {}) as { text?: string; toolCalls?: { id: string; name: string; arguments: unknown }[] };
          if (response.text) {
            lines.push(`第 ${step.step} 步回复：${response.text}`);
          }
          for (const call of response.toolCalls ?? []) {
            /** 这次调用的结果。 */
            const row = results.find((item) => item.step === step.step && item.callId === call.id);
            /** 结果文字。 */
            const output = row ? (row.error ?? JSON.stringify(row.output ?? null)) : '（没有结果）';
            lines.push(`第 ${step.step} 步调用 ${call.name} ${JSON.stringify(call.arguments)} → ${output.slice(0, 500)}`);
          }
        }
        if (execution.error) {
          lines.push(`出错：${execution.error}`);
        }
      }
      if (session.lastReply) {
        lines.push('', `最后的回复：${session.lastReply}`);
      }
      /** 全文。 */
      const text = lines.join('\n');
      /** 从哪开始。 */
      const offset = Math.max(0, Number(args.offset ?? 0) || 0);
      /** 这一段。 */
      const part = text.slice(offset, offset + READ_SESSION_MAX_CHARS);
      /** 还有没读的。 */
      const rest = text.length - offset - part.length;
      return Promise.resolve(rest > 0 ? `${part}\n\n[还有 ${rest} 字没给，用 offset=${offset + part.length} 接着读]` : part);
    },
  },

  taskdbinsert: {
    definition: {
      name: 'taskdbinsert',
      description:
        '插入一个任务事件。不写 session_id 就插进当前会话：当前这轮做完后接着做它，可以用来给后面的步骤留话。' +
        '写 new_session: true 就新开一个会话，可以指定交给哪个机器人、智能体或模型；都不写就由分派智能体决定。',
      parameters: piAi.Type.Object({
        text: piAi.Type.String({ description: '要做的事，写清楚前因后果' }),
        session_id: piAi.Type.Optional(piAi.Type.String({ description: '插进哪个会话，默认当前会话' })),
        new_session: piAi.Type.Optional(piAi.Type.Boolean({ description: '新开会话' })),
        bot: piAi.Type.Optional(piAi.Type.String()),
        agent: piAi.Type.Optional(piAi.Type.String()),
        model: piAi.Type.Optional(piAi.Type.String()),
        workspace: piAi.Type.Optional(piAi.Type.String()),
      }),
    },
    run(args, context) {
      /** 插进哪个会话；新开时是 undefined。 */
      const sessionId = args.new_session === true ? undefined : ((args.session_id as string | undefined) ?? context.sessionId);
      /** 插入的事件。 */
      const created = context.submit({
        input: checks.requireString(args.text, 'text'),
        source: `AI（会话 ${context.sessionId}）`,
        sessionId,
        bot: args.bot as string | undefined,
        agent: args.agent as string | undefined,
        model: args.model as string | undefined,
        workspace: args.workspace as string | undefined,
      });
      return Promise.resolve({ ...created, note: '已排进队列，轮到时会执行' });
    },
  },

  judge_batch: {
    definition: {
      name: 'judge_batch',
      description: [
        '批量快速判断：给一个是非问题和一组条目（文件名、任务、消息……），决策模型逐个判断，几百毫秒一个，同一模型同时最多几个（排队）。',
        `返回每个条目“是”的概率，从高到低。适合从很多条目里先挑出相关的，再用 read 等细看。最多 ${JUDGE_MAX_ITEMS} 个。`,
      ].join(''),
      parameters: piAi.Type.Object({
        question: piAi.Type.String({ description: '对每个条目问的是非问题，如“这个文件和飞书消息处理有关吗”' }),
        items: piAi.Type.Array(piAi.Type.String(), { description: '要判断的条目' }),
        context: piAi.Type.Optional(piAi.Type.String({ description: '背景（每个条目都带上），如用户的任务' })),
      }),
    },
    async run(args, context) {
      if (!context.decide) {
        throw new Error('没配决策模型（config.yaml 的 models.decision），用不了 judge_batch');
      }
      /** 调决策模型。 */
      const decide = context.decide;
      /** 问题。 */
      const question: piAi.ClassifierQuestion = { type: 'bool', instructions: checks.requireString(args.question, 'question'), criteria: { true: '是', false: '不是' } };
      /** 条目原样。 */
      const rawItems: unknown[] = Array.isArray(args.items) ? (args.items as unknown[]) : [];
      if (rawItems.length === 0) {
        throw new Error('items 要是非空的字符串数组');
      }
      if (rawItems.length > JUDGE_MAX_ITEMS) {
        throw new Error(`items 最多 ${JUDGE_MAX_ITEMS} 个，现在 ${rawItems.length} 个；先按名字缩小范围`);
      }
      /** 条目。 */
      const items = rawItems.map((item) => utils.toText(item));
      /** 背景。 */
      const background = typeof args.context === 'string' ? args.context : '';
      /** 开始时间。 */
      const startedAt = performance.now();
      /** 每个条目的结果。 */
      const results = await Promise.all(
        items.map(async (item) => {
          /** 决策模型的输出。 */
          const output = await decide({ state: { 背景: background, 条目: item }, questions: { fit: question } });
          /** 回答。 */
          const answer = output.answers.fit;
          return { item, probability: answer?.type === 'bool' ? answer.probability : undefined, error: output.error };
        }),
      );
      results.sort((left, right) => (right.probability ?? -1) - (left.probability ?? -1));
      /** 每行一个条目。 */
      const lines = results.map((result) => (result.probability === undefined ? `出错  ${result.item}：${result.error ?? '没回答'}` : `${result.probability.toFixed(2)}  ${result.item}`));
      return `${items.length} 个，用时 ${((performance.now() - startedAt) / 1000).toFixed(1)} 秒（概率越高越“是”）：\n${lines.join('\n')}`;
    },
  },

  note_claude: {
    definition: {
      name: 'note_claude',
      description: '给 Claude（在虚拟机里帮用户写 jmbots 代码的 AI）留话：发现 jmbots 自己的问题、卡住了、想让 Claude 改代码或看一眼时用。写成一个文件，Claude 定时看；不会马上有回复。',
      parameters: piAi.Type.Object({
        title: piAi.Type.String({ description: '一句话标题' }),
        text: piAi.Type.String({ description: '要说的话：发生了什么、在哪个会话、希望 Claude 做什么' }),
      }),
    },
    async run(args, context) {
      /** 标题（去掉不能做文件名的字符）。 */
      const title = utils.safeFolderName(checks.requireString(args.title, 'title'));
      /** 文件。 */
      const file = path.join(context.runtimeDir, 'integrations', 'claude', '给Claude', `${utils.createSessionId()}_${title}.md`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `# ${String(args.title)}\n\n- 会话：${context.sessionId}\n- 时间：${utils.formatTime()}\n\n${checks.requireString(args.text, 'text')}\n`);
      return `已留给 Claude：${file}`;
    },
  },

  feishu_send: {
    definition: {
      name: 'feishu_send',
      description: '通过飞书给用户发一条文字消息（会话来自飞书就发回那个聊天，否则发给最近私聊过机器人的人）。',
      parameters: piAi.Type.Object({ text: piAi.Type.String({ description: '要发的话' }) }),
    },
    async run(args, context) {
      if (!context.sendFeishu) {
        throw new Error('飞书渠道没开');
      }
      return `已发出，消息 ID：${await context.sendFeishu(context.sessionId, checks.requireString(args.text, 'text'))}`;
    },
  },
};


/**
 * 按名字取给模型看的工具定义。
 * @param names 工具名。
 * @throws 有不认识的工具名时抛错（多半是机器人配置写错了）。
 */
export function toolDefinitions(names: string[]): piAi.Tool[] {
  return names.map((name) => {
    /** 这个工具。 */
    const entry = TOOLS[name];
    if (!entry) {
      throw new Error(`没有工具 ${name}；现有：${Object.keys(TOOLS).join('、')}`);
    }
    return entry.definition;
  });
}


/**
 * 执行一个工具。
 * @param name 工具名。
 * @param args 模型给的参数。
 * @param context 执行环境。
 * @returns 结果。
 * @throws 工具不存在、参数不是对象、执行失败时抛错。
 */
export async function runTool(name: string, args: unknown, context: ToolContext): Promise<unknown> {
  /** 这个工具。 */
  const entry = TOOLS[name];
  if (!entry) {
    throw new Error(`没有工具 ${name}`);
  }
  return entry.run(checks.asRecord(args, `${name} 的参数`), context);
}
