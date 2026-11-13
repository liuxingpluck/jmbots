/**
 * 把运行时搬进 jmbotsData/（docs/界面/02_一个程序跑起来的规划.md 第 3 步）。只搬一次，真搬之前要停基地、看门狗、后端。
 * 用户 11-05：“就干脆读取jmbotsData目录吧，不要那么麻烦了，存在就读取，不存在就创建”；
 * “我们后面改成了全部变成文件夹形式，之前的对话还是一个文件……在文件夹名称后面加一个下划线，再接一个最多 20 个字的简短说明”。
 *
 * 用法（在 jmbots 目录）：
 *   bun scripts/Move_To_JmbotsData.ts --from <旧的运行时目录>      先看：只打印要做什么，什么也不动，服务开着也能看
 *   bun scripts/Move_To_JmbotsData.ts --from <旧的运行时目录> --run yes  真搬
 *   --old_root  文件里写的老路径，默认就是 --from；在复制出来的目录上试时写原来那个运行时目录
 *   --new_root  文件里要写成的新路径，默认是老路径下的 jmbotsData；在复制出来的目录上试时写复制品的 jmbotsData，附件才找得到
 *   --port      后端端口，默认 30086：还连得上就不搬
 *
 * 真搬做这些事：
 *   1. 备份 bots/ 和数据库到 bak/before_jmbotsData_<时间>/，config.yaml 备份在它旁边；
 *   2. 旧的平铺消息收进文件夹，还没带说明的文件夹加上说明；
 *   3. 顶层的东西挪进 jmbotsData/：knowledge/ 并进 memory/，memorycli/、rag/ 进 data/index/，日志进 data/logs/；
 *   4. 把数据库所有文字列、文字文件、config.yaml 里的绝对路径改成新位置（不打印内容）；
 *   5. 写报告到 data/logs/，列出没挪的东西和还留着老路径的文件；老路径就是真实运行时的话，把 .env 的 JMBOTS_RUNTIME 改过去。
 * 不搬 bak/、截图/、jmbots.exe；不认识的东西留在原地，写进报告。中途出错就停下，写明停在哪，从备份和移动记录恢复。
 */
import * as bunSqlite from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as filesModule from '../src/capabilities/Files.ts';
import * as serveProcess from './Serve_Process.ts';


/** 新运行时的文件夹名。 */
const DATA_DIR = 'jmbotsData';

/** 顶层要搬的：老名字 → jmbotsData 里的位置。jmbots-server 开头的文件另外加。 */
const TOP_MOVES: [string, string][] = [
  ['config.yaml', 'config.yaml'],
  ['bots', 'bots'],
  ['skills', 'skills'],
  ['memory', 'memory'],
  ['knowledge', 'memory'],
  ['prompts', 'prompts'],
  ['integrations', 'integrations'],
  ['data', 'data'],
  ['updates', 'updates'],
  ['memorycli', 'data/index/libs'],
  ['rag', 'data/index/rag'],
  ['runtimes', 'runtimes'],
  ['program', 'program'],
  ['model', 'model'],
];

/** 明确不搬的。 */
const NOT_MOVED = new Set(['bak', '截图', 'jmbots.exe', DATA_DIR]);

/** 消息文件和消息文件夹的名字：主干是 <渠道>_<17 位时间>，后面的是说明或后缀。 */
const MESSAGE_NAME = /^([a-z]+_\d{17})(.*)$/su;

/** 要改路径的文字文件。 */
const TEXT_FILE = /\.(md|json|jsonl|txt|ya?ml)$/i;

/** 比这大的文件不改路径，写进报告。 */
const MAX_TEXT_BYTES = 20 * 1024 * 1024;

/** 不进去改路径的文件夹。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'index', 'logs']);

/** 路径在文字里的几种写法：普通、JSON 转义一层、转义两层、正斜杠。 */
const SEPARATORS = ['\\', '\\\\', '\\\\\\\\', '/'];


/** 一次移动，路径相对运行时。 */
interface Move {
  /** 从哪。 */
  from: string;
  /** 到哪。 */
  to: string;
  /** 是文件夹吗。 */
  folder: boolean;
}


/**
 * 有文字列的一行怎么改。
 * @param value 这一列的值。
 * @param rewrite 改路径的函数。
 * @returns 改过的文字；不用改是 undefined。
 */
function changedText(value: unknown, rewrite: (text: string) => string): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  /** 改完的。 */
  const next = rewrite(value);
  return next === value ? undefined : next;
}


/**
 * 从数据库读每条消息的原话，按文件名的主干放。
 * @param dbFile 数据库文件。
 * @returns 主干 → 原话；读不了是空的。
 */
function readMessageTexts(dbFile: string): Map<string, string> {
  /** 主干 → 原话。 */
  const texts = new Map<string, string>();
  try {
    /** 数据库。 */
    const db = new bunSqlite.Database(dbFile, { readonly: true });
    /** 消息原文件和对应正文。 */
    const rows = db.query('SELECT file, text FROM messages ORDER BY id').all() as {
      /** 消息文件路径。 */
      file: string;
      /** 收件正文。 */
      text: string;
    }[];
    for (const row of rows) {
      /** 主干。 */
      const stem = MESSAGE_NAME.exec(path.win32.basename(row.file))?.[1];
      if (stem && !texts.has(stem)) {
        texts.set(stem, row.text);
      }
    }
    db.close();
  } catch (error) {
    console.log(`消息的原话没读到，文件夹名不带说明：${String(error)}`);
  }
  return texts;
}


/**
 * 算消息文件夹要怎么动：平铺的收进文件夹，还没带说明的文件夹加上说明。
 * @param runtime 老运行时目录。
 * @param texts 主干 → 原话。
 * @returns 要做的移动，文件夹在前。
 */
function planMessages(runtime: string, texts: Map<string, string>): Move[] {
  /** 文件夹的移动。 */
  const folders: Move[] = [];
  /** 文件的移动。 */
  const files: Move[] = [];
  /** 机器人的文件夹。 */
  const botsDir = path.join(runtime, 'bots');
  for (const bot of fs.existsSync(botsDir) ? fs.readdirSync(botsDir) : []) {
    /** 这个机器人的消息文件夹。 */
    const dir = path.join(botsDir, bot, 'message');
    /** 相对运行时的前缀。 */
    const prefix = `bots/${bot}/message`;
    /** 主干 → 平铺的文件。 */
    const groups = new Map<string, string[]>();
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      /** 名字拆开。 */
      const match = MESSAGE_NAME.exec(entry.name);
      if (!match) {
        continue;
      }
      if (!entry.isDirectory()) {
        groups.set(match[1]!, [...(groups.get(match[1]!) ?? []), entry.name]);
      } else if (!match[2]) {
        /** 说明。 */
        const note = filesModule.messageNote(texts.get(entry.name) ?? '', true);
        if (note) {
          folders.push({ from: `${prefix}/${entry.name}`, to: `${prefix}/${entry.name}_${note}`, folder: true });
        }
      }
    }
    for (const [stem, names] of groups) {
      /** 说明：有 .md、.json 以外的文件才算带附件。 */
      const note = filesModule.messageNote(texts.get(stem) ?? '', names.some((name) => !/\.(md|json)$/i.test(name)));
      /** 文件夹名。 */
      const folder = note ? `${stem}_${note}` : stem;
      for (const name of names) {
        files.push({ from: `${prefix}/${name}`, to: `${prefix}/${folder}/${name}`, folder: false });
      }
    }
  }
  return [...folders, ...files];
}


/**
 * 做一个改路径的函数：老路径的几种写法，一次替换成新位置。
 * @param oldRoot 文字里写的老运行时路径，反斜杠。
 * @param messageMoves 消息的移动。
 * @param newRoot 文字里要写成的新运行时路径，反斜杠。
 * @param tops 顶层的移动。
 * @returns 改路径的函数。
 */
function buildRewriter(
  oldRoot: string,
  newRoot: string,
  messageMoves: Move[],
  tops: [string, string][],
): (text: string) => string {
  /** 老写法 → 新写法。 */
  const pairs = new Map<string, string>();
  for (const separator of SEPARATORS) {
    /** 这种写法的老根目录。 */
    const oldText = oldRoot.replaceAll('\\', separator);
    /** 这种写法的新根目录。 */
    const newText = newRoot.replaceAll('\\', separator);
    for (const move of messageMoves) {
      /** 文件夹要带结尾的分隔符，免得碰到名字开头一样的别的文件夹。 */
      const tail = move.folder ? separator : '';
      const source = `${oldText}${separator}${move.from.replaceAll('/', separator)}${tail}`;
      const destination = `${newText}${separator}${move.to.replaceAll('/', separator)}${tail}`;
      pairs.set(source, destination);
    }
    for (const [from, to] of tops) {
      /** 同上；带扩展名的是文件。 */
      const tail = from.includes('.') ? '' : separator;
      const source = `${oldText}${separator}${from}${tail}`;
      const destination = `${newText}${separator}${to.replaceAll('/', separator)}${tail}`;
      pairs.set(source, destination);
    }
  }
  /** 长的在前：一次替换，不会替换两遍。 */
  const keysByLength = [...pairs.keys()].sort((left, right) => right.length - left.length);
  const escapedKeys = keysByLength.map((key) => key.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'));
  const alternation = escapedKeys.join('|');
  const pattern = new RegExp(alternation, 'g');
  /** 文字里没有它就不用看。 */
  const needle = path.win32.basename(oldRoot);
  return (text) => (text.includes(needle) ? text.replace(pattern, (found) => pairs.get(found) ?? found) : text);
}


/**
 * 改数据库所有文字列里的路径。
 * @param dbFile 数据库文件。
 * @param rewrite 改路径的函数。
 * @param run true 真改，false 只数。
 * @returns 要改（改了）多少格。
 */
function rewriteDatabase(
  dbFile: string,
  rewrite: (text: string) => string,
  run: boolean,
): number {
  /** 数据库。 */
  const db = new bunSqlite.Database(dbFile, run ? undefined : { readonly: true });
  /** 改了多少格。 */
  let count = 0;
  /** 真改的语句。 */
  const updates: {
    /** 要执行的更新SQL。 */
    sql: string;
    /** 改写后的路径文字。 */
    value: string;
    /** 原记录的行号。 */
    rowid: number;
  }[] = [];
  const tableSql = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'";
  const tables = db.query(tableSql).all() as { name: string }[];
  for (const table of tables) {
    /** 文字列。 */
    const columnSql = `PRAGMA table_info("${table.name}")`;
    const tableColumns = db.query(columnSql).all() as { name: string; type: string }[];
    const textColumns = tableColumns.filter((column) => /text/i.test(column.type));
    const columns = textColumns.map((column) => column.name);
    if (columns.length === 0) {
      continue;
    }
    const columnNames = columns.map((name) => '"' + name + '"').join(', ');
    const rowSql = `SELECT rowid AS jm_rowid, ${columnNames} FROM "${table.name}"`;
    const rows = db.query(rowSql).all() as Record<string, unknown>[];
    for (const row of rows) {
      for (const column of columns) {
        /** 改完的。 */
        const next = changedText(row[column], rewrite);
        if (next !== undefined) {
          count += 1;
          const updateSql = `UPDATE "${table.name}" SET "${column}" = ? WHERE rowid = ?`;
          const update = {
            sql: updateSql,
            value: next,
            rowid: row.jm_rowid as number,
          };
          updates.push(update);
        }
      }
    }
  }
  if (run) {
    db.transaction(() => {
      for (const update of updates) {
        db.run(update.sql, [update.value, update.rowid]);
      }
    })();
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  db.close();
  return count;
}


/**
 * 一个文件夹下所有要看的文字文件。
 * @param dir 文件夹。
 * @returns 文件路径；太大的放进 tooBig。
 */
function listTextFiles(dir: string, tooBig: string[]): string[] {
  /** 找到的。 */
  const found: string[] = [];
  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    /** 完整路径。 */
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        found.push(...listTextFiles(full, tooBig));
      }
    } else if (TEXT_FILE.test(entry.name)) {
      if (fs.statSync(full).size > MAX_TEXT_BYTES) {
        tooBig.push(full);
      } else {
        found.push(full);
      }
    }
  }
  return found;
}


/** 改名遇到“被占着”最多试几次（第 n 次前等 n×100 毫秒，一共最多等 4.5 秒）。 */
const RENAME_TRIES = 10;

/** 改名时表示“被别的程序短暂占着”的错误：Windows 上刚写的文件常被杀毒软件、索引服务扫一下。 */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);


/**
 * 改名；被短暂占着时等一下再试（11-06 发 0.3.2 时测试在 Windows 上偶发 EPERM，单独跑又过）。
 * @param from 从哪。
 * @param to 到哪。
 * @throws 试够次数还不行，或者别的错误，原样抛出。
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= RENAME_TRIES || !BUSY_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
        throw error;
      }
      Bun.sleepSync(100 * attempt);
    }
  }
}


/**
 * 把一个东西挪过去；目标已经有了就把里面的东西并进去，同名的留在原地。
 * @param from 从哪。
 * @param to 到哪。
 * @param conflicts 同名没挪的记在这里。
 * @param log 记一笔移动。
 */
function moveInto(from: string, to: string, conflicts: string[], log: (text: string) => void): void {
  if (!fs.existsSync(to)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    renameWithRetry(from, to);
    log(`${from} -> ${to}`);
    return;
  }
  if (!fs.statSync(from).isDirectory() || !fs.statSync(to).isDirectory()) {
    conflicts.push(from);
    return;
  }
  for (const name of fs.readdirSync(from)) {
    moveInto(path.join(from, name), path.join(to, name), conflicts, log);
  }
  if (fs.readdirSync(from).length === 0) {
    fs.rmdirSync(from);
  }
}


/**
 * 后端还开着吗。
 * @param port 端口。
 * @returns 连得上就是 true。
 */
async function isServing(port: number): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/api/health`;
  const options = { signal: AbortSignal.timeout(3000) };

  return fetch(url, options).then(
    () => true,
    () => false,
  );
}


/** 主流程。 */
async function main(): Promise<void> {
  /** 老运行时目录。 */
  const from = serveProcess.option('from', '');
  //G 目录要写明：搬家不猜。
  if (!from || !fs.existsSync(path.join(from, 'bots'))) {
    console.log('用法：bun scripts/Move_To_JmbotsData.ts --from 运行时目录 [--run yes] [--old_root 文字里的老路径] [--port 30086]。这个目录下要有 bots/。');
    process.exit(2);
  }
  /** 新运行时目录。 */
  const target = path.join(from, DATA_DIR);
  /** 文字里写的老路径：反斜杠，结尾不带分隔符。 */
  const oldRoot = serveProcess.option('old_root', from).replaceAll('/', '\\').replace(/\\+$/, '');
  /** 文字里要写成的新路径。 */
  const newRoot = serveProcess.option('new_root', `${oldRoot}\\${DATA_DIR}`).replaceAll('/', '\\').replace(/\\+$/, '');
  /** 真搬吗。 */
  const run = serveProcess.option('run', 'no') === 'yes';
  //G 已经搬过了。
  if (fs.existsSync(path.join(target, 'config.yaml')) || fs.existsSync(path.join(target, 'bots'))) {
    console.log(`${target} 里已经有东西了，不再搬。`);
    process.exit(1);
  }
  /** 老数据库。 */
  const oldDb = path.join(from, 'data', 'jmbots.db');
  /** 顶层要搬的，加上 jmbots-server 开头的文件。 */
  const serverFiles = fs.readdirSync(from)
    .filter((name) => name.startsWith('jmbots-server'))
    .map((name): [string, string] => [name, name]);
  const tops = [...TOP_MOVES, ...serverFiles];
  /** 消息的移动。 */
  const messageTexts = readMessageTexts(oldDb);
  const messageMoves = planMessages(from, messageTexts);
  /** 改路径的函数。 */
  const rewrite = buildRewriter(oldRoot, newRoot, messageMoves, tops);
  /** 留在原地的顶层东西。 */
  const left = fs.readdirSync(from).filter((name) => !tops.some(([top]) => top === name) && !NOT_MOVED.has(name));

  /** 两种消息搬迁数量，供预览和报告。 */
  const folderCount = messageMoves.filter((move) => move.folder).length;
  const flatCount = messageMoves.filter((move) => !move.folder).length;
  console.log(`消息：${folderCount} 个文件夹加说明，${flatCount} 个平铺文件收进文件夹`);
  for (const move of messageMoves.slice(0, 5)) {
    console.log(`  ${move.from} -> ${move.to}`);
  }
  const topDescriptions = tops
    .filter(([name]) => fs.existsSync(path.join(from, name)))
    .map(([name, to]) => (name === to ? name : `${name} -> ${to}`))
    .join('，');
  console.log(`顶层要搬：${topDescriptions}`);
  console.log(`留在原地（不认识的，看一眼）：${left.join('，') || '没有'}`);

  if (!run) {
    /** 太大没看的文件。 */
    const tooBig: string[] = [];
    /** 要改路径的文件数。 */
    const roots = ['bots', 'integrations', 'memory', 'knowledge', 'data'];
    const candidates = roots.flatMap((name) => {
      const directory = path.join(from, name);
      return listTextFiles(directory, tooBig);
    });
    const files = candidates.filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return rewrite(text) !== text;
    }).length;
    const cells = fs.existsSync(oldDb) ? rewriteDatabase(oldDb, rewrite, false) : 0;
    console.log(`要改路径：数据库 ${cells} 格，文字文件 ${files} 个，太大没看 ${tooBig.length} 个`);
    /** 配置文件。 */
    const config = path.join(from, 'config.yaml');
    /** 配置里的 local.libs、local.rag 这两行（这两行没有密钥）。 */
    const configText = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '';
    const dirLines = configText.split(/\r?\n/)
      .filter((line) => /^\s+(libs|rag):/.test(line));
    console.log(`config.yaml 里写死的索引目录：${dirLines.join(' ; ') || '没有'}`);
    console.log('这次只是看，什么也没动。真搬加 --run yes，要先停基地、看门狗、后端。');
    return;
  }

  //G 服务开着不搬。
  const portText = serveProcess.option('port', '30086');
  const port = Number(portText);
  const serving = await isServing(port);
  if (serving) {
    console.log('后端还连得上，先停基地、看门狗、后端再搬。什么也没动。');
    process.exit(1);
  }

  //M 1. 备份。
  /** 这次的时间。 */
  const id = serveProcess.timeId();
  /** 备份目录。 */
  const backup = path.join(from, 'bak', `before_jmbotsData_${id}`);
  fs.cpSync(path.join(from, 'bots'), path.join(backup, 'bots'), { recursive: true });
  /** 数据库及其旁文件一并备份。 */
  const oldDataDir = path.join(from, 'data');
  const oldDataFiles = fs.existsSync(oldDataDir) ? fs.readdirSync(oldDataDir) : [];
  const databaseFiles = oldDataFiles.filter((item) => item.startsWith('jmbots.db'));
  for (const name of databaseFiles) {
    fs.cpSync(path.join(from, 'data', name), path.join(backup, 'data', name), { recursive: true });
  }
  if (fs.existsSync(path.join(from, 'config.yaml'))) {
    fs.copyFileSync(path.join(from, 'config.yaml'), path.join(from, `config.yaml.before_jmbotsData_${id}`));
  }
  console.log(`已备份到 ${backup}`);

  /** 移动记录：中途出错时靠它恢复。 */
  const moveLog = path.join(backup, '移动记录.txt');
  /** 记一笔。 */
  const log = (text: string): void => fs.appendFileSync(moveLog, `${text}\n`);
  /** 同名没挪的。 */
  const conflicts: string[] = [];

  //M 2. 整理消息（这时还在老位置）。
  for (const move of messageMoves) {
    moveInto(path.join(from, move.from), path.join(from, move.to), conflicts, log);
  }

  //M 3. 顶层挪进 jmbotsData；日志进 data/logs。
  for (const [name, to] of tops) {
    if (fs.existsSync(path.join(from, name))) {
      moveInto(path.join(from, name), path.join(target, to), conflicts, log);
    }
  }
  /** 新的 data。 */
  const dataDir = path.join(target, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  for (const name of fs.readdirSync(dataDir).filter((item) => item.endsWith('.log'))) {
    moveInto(path.join(dataDir, name), path.join(dataDir, 'logs', name), conflicts, log);
  }

  //M 4. 改路径。
  /** 改了多少格。 */
  const database = path.join(dataDir, 'jmbots.db');
  const cells = fs.existsSync(database) ? rewriteDatabase(database, rewrite, true) : 0;
  /** 太大没改的。 */
  const tooBig: string[] = [];
  /** 改了的文件数。 */
  let changed = 0;
  /** 还留着老路径的文件。 */
  const stale: string[] = [];
  /** 收集需要改写的文本，再逐个处理。 */
  const textRoots = ['bots', 'integrations', 'memory', 'data'];
  const textFiles = textRoots.flatMap((name) => {
    const directory = path.join(target, name);
    return listTextFiles(directory, tooBig);
  });
  textFiles.push(path.join(target, 'config.yaml'));
  const existingFiles = textFiles.filter((item) => fs.existsSync(item));
  for (const file of existingFiles) {
    /** 原文。 */
    const text = fs.readFileSync(file, 'utf8');
    /** 改完的。 */
    const next = rewrite(text);
    if (next !== text) {
      fs.writeFileSync(file, next);
      changed += 1;
    }
    if (next.replaceAll(newRoot, '').includes(oldRoot)) {
      stale.push(file);
    }
  }

  //M 5. 写 .env 和报告。
  /** 是不是在真实运行时上搬（不是复制出来试的）。 */
  const real = path.resolve(from).replaceAll('/', '\\').toLowerCase() === oldRoot.toLowerCase();
  if (real) {
    const envFile = path.join(serveProcess.ROOT, '.env');
    const envText = `JMBOTS_RUNTIME=${oldRoot.replaceAll('\\', '/')}/${DATA_DIR}\n`;
    fs.writeFileSync(envFile, envText);
  }
  /** 报告。 */
  const report = [
    `# 搬进 jmbotsData（${id}）`,
    '',
    `- 备份：${backup}`,
    `- 消息：${messageMoves.length} 次移动`,
    `- 改路径：数据库 ${cells} 格，文字文件 ${changed} 个`,
    `- .env：${real ? '已改' : '这次是在复制品上试，没动'}`,
    `- 同名没挪的：${conflicts.join('，') || '没有'}`,
    `- 留在原地的：${left.join('，') || '没有'}`,
    `- 太大没改路径的：${tooBig.join('，') || '没有'}`,
    `- 还写着老路径的文件（要人看一眼）：${stale.length}`,
    ...stale.slice(0, 40).map((file) => `  - ${file}`),
  ].join('\n');
  fs.writeFileSync(path.join(dataDir, 'logs', `搬家报告_${id}.md`), `${report}\n`);
  console.log(report);
  console.log(`接下来：把新编的 jmbots.exe 放到 ${from}，再启动它。它会读 ${target}。`);
}


await main();
