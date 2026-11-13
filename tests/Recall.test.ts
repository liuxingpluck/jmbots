/**
 * 记忆预搜（src/capabilities/Recall.ts）的离线测试：grams 把中英文分开切、recall 扫临时目录、
 * describeRecall 把命中写成开场消息里的一段。功能代码只读，测试自己在系统临时目录造 .md，
 * afterAll 删掉。
 * 覆盖：英文/数字整词与中文相邻双字组、短整词不收的边界；跨根扫描、相关度排序（短文件优先）、
 * MIN_HITS、SKIP_NAMES、MAX_FILE_BYTES、根不存在不报错、不相关查询返回空；
 * 中英文标题、@绝对路径、"  …" 开头的行、空数组返回空串。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as recallModule from '../src/capabilities/Recall.ts';


/** 查询用这句话：grams 是 claude（2 分）+ 留话（1 分），正好过 MIN_HITS=3。 */
const QUERY = '给Claude留话';

/** 不相关的问句：它的中文双字组一个都不出现在造的文件里。 */
const OTHER_QUERY = '今天天气怎么样';

/** 整个 describe 共用的临时目录，afterAll 删掉。 */
let tmp = '';

/** 记忆根。 */
let memoryRoot = '';

/** 技能根：放长文件，验跨根扫描。 */
let skillsRoot = '';

/** 短且高度相关的文件：应该排第一。 */
let shortFile = '';

/** 相关但塞了 500 个 x 的长文件：应该排第二。 */
let longFile = '';

/** 超过 MAX_FILE_BYTES 的相关文件。 */
let hugeFile = '';

/** 完全无关的文件。 */
let fillerFile = '';

/** 不该出现在命中里的文件名：SKIP_NAMES、超大文件、只有一个词、纯无关内容。 */
const SKIPPED_NAMES = ['索引.md', 'index.md', 'huge.md', 'onlyclaude.md', 'filler.md', 'other.md'];


/**
 * 在某个根下写一个 .md 文件（子目录不存在就建）。
 * @param root 根文件夹的绝对路径。
 * @param name 相对文件名。
 * @param content 文件全文。
 * @returns 写好的文件绝对路径。
 * 副作用：在系统临时目录建文件夹并写文件。
 */
function writeMd(root: string, name: string, content: string): string {
  /** 目标文件。 */
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}


/**
 * 手造一条命中，只给 describeRecall 用。
 * @param file 绝对路径。
 * @param lines 最相关的几行。
 * @returns 一条 RecallHit。
 * 副作用：无。
 */
function hitOf(file: string, lines: string[]): recallModule.RecallHit {
  return { file, score: 1, lines };
}


bunTest.describe('grams：中英文分开切', () => {
  bunTest.test('给Claude留话：英文整词小写、中文双字组，不混切也不拆碎英文', () => {
    /** 切出来的字组。 */
    const found = recallModule.grams(QUERY);
    //M 英文和数字按整词收（小写），中文按相邻两个字一组收。
    bunTest.expect(found.size).toBe(2);
    bunTest.expect(found.has('claude')).toBe(true);
    bunTest.expect(found.has('留话')).toBe(true);
    //G 不能把英文拆成两字母碎片、不能把汉字和字母拼成一组、不能把词粘连。
    bunTest.expect(found.has('cl')).toBe(false);
    bunTest.expect(found.has('la')).toBe(false);
    bunTest.expect(found.has('给c')).toBe(false);
    bunTest.expect(found.has('eclaude')).toBe(false);
    //G 每组要么纯英数整词、要么纯中文，不许中英文混在一组。
    for (const gram of found) {
      /** 组里有没有 ASCII 的英数字。 */
      const hasAscii = /[a-z0-9]/.test(gram);
      /** 组里有没有非 ASCII 的字（汉字）。 */
      const hasWide = [...gram].some((char) => char.charCodeAt(0) > 127);
      bunTest.expect(hasAscii && hasWide).toBe(false);
    }
  });

  bunTest.test('边界：小于 3 个字符的英文/数字整词不收，≥3 的收', () => {
    //G ab、cd 各只有两个字符，空格本身不成组：一个字组都不该有。
    bunTest.expect(recallModule.grams('ab cd').size).toBe(0);
    //M Claude 转小写、2026 是纯数字整词，都该收。
    /** 切出来的字组。 */
    const found = recallModule.grams('Claude 2026');
    bunTest.expect(found.size).toBe(2);
    bunTest.expect(found.has('claude')).toBe(true);
    bunTest.expect(found.has('2026')).toBe(true);
  });

  bunTest.test('matchScore：英文整词 2 分、两个字一组 1 分', () => {
    /** 问的话的字组：claude（2 分）+ 留话（1 分）。 */
    const wanted = recallModule.grams(QUERY);
    bunTest.expect(recallModule.matchScore(wanted, 'claude 留话')).toBe(3);
    bunTest.expect(recallModule.matchScore(wanted, 'claude')).toBe(2);
    bunTest.expect(recallModule.matchScore(wanted, '留话')).toBe(1);
    bunTest.expect(recallModule.matchScore(wanted, 'cl claude 留话')).toBe(3);
  });
});


bunTest.describe('recall：临时目录里扫记忆', () => {
  bunTest.beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-recall-'));
    memoryRoot = path.join(tmp, 'memory');
    skillsRoot = path.join(tmp, 'skills');
    fs.mkdirSync(memoryRoot, { recursive: true });
    fs.mkdirSync(skillsRoot, { recursive: true });
    //M 短文件：对上 claude + 留话 共 3 分，text 最短，score=matched/sqrt(length+100) 最高。
    shortFile = writeMd(memoryRoot, 'claude.md', 'claude 留话\nclaude 留话\n');
    //M 长文件放另一个根：同样 3 分，但被 500 个 x 拉长，应排在短文件之后，顺便验跨根扫描。
    longFile = writeMd(skillsRoot, 'long.md', `claude 留话\n${'x'.repeat(500)}`);
    //G 索引.md / index.md 内容高度相关，但 SKIP_NAMES 应该把它们挡在门外。
    writeMd(memoryRoot, '索引.md', 'claude 留话\nclaude 留话\n');
    writeMd(memoryRoot, 'index.md', 'claude 留话\nclaude 留话\n');
    //G 超过 256*1024 字节的相关文件：MAX_FILE_BYTES 应该跳过。
    hugeFile = writeMd(memoryRoot, 'huge.md', `claude 留话\n${'x'.repeat(300_000)}`);
    //G 只有一个 claude（2 分）到不了 MIN_HITS=3；纯无关内容 0 分。
    writeMd(memoryRoot, 'onlyclaude.md', 'claude\nclaude\n');
    fillerFile = writeMd(memoryRoot, 'filler.md', `random filler\n${'x'.repeat(500)}`);
    writeMd(skillsRoot, 'other.md', `nothing useful\n${'x'.repeat(200)}`);
  });

  bunTest.afterAll(() => {
    //G beforeAll 没跑成功时 tmp 还是空串，别拿它去删；Windows 上刚写完的文件可能还被占着，多重试几次。
    if (tmp) {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  bunTest.test('相关文件：短文件排第一、带相关行、最多 3 条，且跨根扫描', async () => {
    /** 两个根一起搜的结果。 */
    const hits = await recallModule.recall([memoryRoot, skillsRoot], QUERY);
    //M 短文件分最高，该排第一。
    bunTest.expect(hits.length).toBeGreaterThan(0);
    bunTest.expect(hits[0]!.file).toBe(shortFile);
    //M 最相关的几行非空，且含 claude 或 留话。
    bunTest.expect(hits[0]!.lines.length).toBeGreaterThan(0);
    bunTest.expect(hits[0]!.lines.some((line) => line.includes('claude') || line.includes('留话'))).toBe(true);
    //G MAX_FILES=3，结果不能超。
    bunTest.expect(hits.length).toBeLessThanOrEqual(3);
    //M 另一个根里的长文件也被扫到，但排在短文件后面。
    bunTest.expect(hits.some((hit) => hit.file === longFile)).toBe(true);
    //G 所有命中都不是 索引.md / index.md、超大文件、无关文件。
    bunTest.expect(hits.every((hit) => !SKIPPED_NAMES.includes(path.basename(hit.file)))).toBe(true);
    bunTest.expect(hits.every((hit) => hit.file !== hugeFile && hit.file !== fillerFile)).toBe(true);
  });

  bunTest.test('不相关的话一个都不给（今天天气怎么样 → []）', async () => {
    /** 不相关查询的结果。 */
    const hits = await recallModule.recall([memoryRoot, skillsRoot], OTHER_QUERY);
    //G 造文件时避开了「今天/天天/天气/气怎/怎么/么样」，谁都到不了 MIN_HITS=3。
    bunTest.expect(hits).toEqual([]);
  });

  bunTest.test('SKIP_NAMES：索引.md / index.md 内容再相关也不给', async () => {
    /** 两个根一起搜的结果。 */
    const hits = await recallModule.recall([memoryRoot, skillsRoot], QUERY);
    bunTest.expect(hits.some((hit) => path.basename(hit.file) === '索引.md')).toBe(false);
    bunTest.expect(hits.some((hit) => path.basename(hit.file) === 'index.md')).toBe(false);
  });

  bunTest.test('MAX_FILE_BYTES：超过 256*1024 字节的相关文件被跳过', async () => {
    //G 先确认造的文件确实超限，免得用例本来就失效。
    bunTest.expect(fs.statSync(hugeFile).size).toBeGreaterThan(256 * 1024);
    /** 两个根一起搜的结果。 */
    const hits = await recallModule.recall([memoryRoot, skillsRoot], QUERY);
    bunTest.expect(hits.some((hit) => hit.file === hugeFile)).toBe(false);
  });

  bunTest.test('根文件夹不存在：不抛错、返回 []；和真根混在一起也不影响', async () => {
    /** 根本没建过的文件夹。 */
    const missing = path.join(tmp, '根本不存在');
    //G Bun.Glob 扫不到目录时 markdownFiles 内部 catch 返回空，这是设计要求：不能抛错。
    const alone = await recallModule.recall([missing], QUERY);
    bunTest.expect(alone).toEqual([]);
    //M 混着真根：不存在的那个不该把真结果带没。
    const mixed = await recallModule.recall([missing, memoryRoot], QUERY);
    bunTest.expect(mixed.length).toBeGreaterThan(0);
    bunTest.expect(mixed[0]!.file).toBe(shortFile);
  });

  bunTest.test('maxFiles：9 个相关文件最多出 8 个（loose 短话也算）', async () => {
    /** 单独一个根，免得和上面的文件混在一起。 */
    const manyRoot = path.join(tmp, 'many');
    fs.mkdirSync(manyRoot, { recursive: true });
    for (let index = 1; index <= 9; index += 1) {
      writeMd(manyRoot, `相关${String(index)}.md`, `飞书发件箱：往 outbox 放一份 md，第 ${String(index)} 份\n`);
    }
    /** 搜到的。 */
    const hits = await recallModule.recall([manyRoot], '飞书发件箱', { maxFiles: 8, loose: true });
    bunTest.expect(hits).toHaveLength(8);
  });
});


bunTest.describe('describeRecall：写成开场消息里的一段', () => {
  /** 手造命中用的绝对路径（不落盘，describeRecall 只拼字符串）。 */
  const absolute = path.join(os.tmpdir(), 'jmbots-recall-hit.md');

  bunTest.test('空数组：zh 和 en 都返回空字符串', () => {
    bunTest.expect(recallModule.describeRecall([], 'zh')).toBe('');
    bunTest.expect(recallModule.describeRecall([], 'en')).toBe('');
  });

  bunTest.test('非空：中文标题、@绝对路径、"  …" 开头的行', () => {
    //G 断言里要的确实是绝对路径。
    bunTest.expect(path.isAbsolute(absolute)).toBe(true);
    /** 写好的一段。 */
    const text = recallModule.describeRecall([hitOf(absolute, ['claude 留话'])], 'zh');
    bunTest.expect(text).toContain('# 可能相关的记忆');
    bunTest.expect(text).toContain(`@${absolute}`);
    bunTest.expect(text.split('\n').some((line) => line.startsWith('  …'))).toBe(true);
  });

  bunTest.test('英文：标题是 # Possibly relevant memory', () => {
    /** 写好的一段。 */
    const text = recallModule.describeRecall([hitOf(absolute, ['claude 留话'])], 'en');
    bunTest.expect(text).toContain('# Possibly relevant memory');
    bunTest.expect(text).toContain(`@${absolute}`);
    bunTest.expect(text.split('\n').some((line) => line.startsWith('  …'))).toBe(true);
  });
});
