/**
 * 日志库 Log 的“人看的流水”（会话目录下的 流水.log）的离线测试：
 * 追加一行、整份读回、谁左对齐补到 30 字且长名字不截断、文件不存在时是空字符串、写不进去时 note 不抛错。
 * 全部在临时目录里做，不读真实的 F:\aidata\AIJMBots，不联网、不调模型。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as resourcesModule from '../src/resources/Resources.ts';
import * as logModule from '../src/capabilities/Log.ts';


/** 测试用的会话：不走机器人，流水放 logs/general/<会话ID>_<标题>/ 下。 */
const SESSION: logModule.TimelineSession = { id: 'S100', bot: null, title: '测流水' };


/**
 * 建一个空的临时运行时目录，再用 Resources 打开它。
 * @returns 打开的资源、临时目录；调用方负责删目录。
 */
async function openRuntime(): Promise<{ resources: resourcesModule.Resources; dir: string }> {
  /** 临时运行时目录；mkdtemp 保证每次都是新的空目录，不碰真实的运行时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-log-'));
  return { resources: await resourcesModule.Resources.load(dir), dir };
}


/**
 * 删掉临时运行时目录。
 * @param dir 目录。
 */
function removeRuntime(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}


/**
 * 一段文字在等宽字体里占几格（中日韩占两格）。测试里照同样的规则算，用来验证各行对齐。
 * @param text 文字。
 * @returns 占几格。
 */
function width(text: string): number {
  /** 累计宽度。 */
  let total = 0;
  for (const character of text) {
    total += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(character) ? 2 : 1;
  }
  return total;
}


bunTest.test('note()：连写三行，读回来三行、顺序对、每行都有时间和谁', async () => {
  /** 打开的运行时。 */
  const { resources, dir } = await openRuntime();
  try {
    //G 连会话目录都还不存在：note 要自己建好，不能指望调用方先建目录。
    bunTest.expect(fs.existsSync(resources.sessionDir(SESSION))).toBe(false);
    await logModule.note(resources, SESSION, '飞书渠道.onMessage()', '来源 飞书/ou_7f3a  记下 #101「把 docs/05 发成云文档」');
    await logModule.note(resources, SESSION, '事件循环(飞书).claimNext()', '领走 #101');
    await logModule.note(resources, SESSION, '干活执行器.run()', '第 1 步 开始');
    //M 流水是追加写的：三次写完是三条、按写的顺序排，不是覆盖成最后一条。
    /** 读回来的流水。 */
    const text = await logModule.readTimeline(resources, SESSION);
    /** 去掉末尾换行后的各行。 */
    const lines = text.split('\n').filter((line) => line !== '');
    bunTest.expect(lines).toHaveLength(3);
    //M 每行开头是本地时间 HH:MM:SS，后面两空格接“模块.函数”。
    bunTest.expect(lines.every((line) => /^\d{2}:\d{2}:\d{2} {2}/u.test(line))).toBe(true);
    //M 三行的“谁”里有中文，宽窄不一；要的是**显示上对齐**——说明都从同一格开始。
    //  （不去比对 padEnd(30) 这种实现细节：中文占两格，按字符数补出来反而是歪的。）
    //G 不能用 lastIndexOf('  ') 去找分界：说明里本来就有连续两个空格。按已知的说明文字反推。
    /** 每行的说明原文。 */
    const whats = ['来源 飞书/ou_7f3a  记下 #101「把 docs/05 发成云文档」', '领走 #101', '第 1 步 开始'];
    /** 每行“说明”前面那段（时间 + 两空格 + 谁 + 两空格）占几格。 */
    const columns = lines.map((line, index) => width(line.slice(0, line.length - (whats[index] ?? '').length)));
    //M 时间 8 格 + 2 + 谁补到 30 格 + 2 = 42：三行都该从第 42 格开始写说明。
    bunTest.expect(columns).toEqual([42, 42, 42]);
    //M 内容本身也要对。
    bunTest.expect(lines[0]).toContain('飞书渠道.onMessage()');
    bunTest.expect(lines[0]).toContain('记下 #101「把 docs/05 发成云文档」');
    bunTest.expect(lines[1]).toContain('事件循环(飞书).claimNext()');
    bunTest.expect(lines[1]).toContain('领走 #101');
    bunTest.expect(lines[2]).toContain('干活执行器.run()');
    bunTest.expect(lines[2]).toContain('第 1 步 开始');
    //M 读回来的就是 timelineFile 指的那个文件。
    bunTest.expect(fs.readFileSync(logModule.timelineFile(resources, SESSION), 'utf8')).toBe(text);
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('note()：模块名很长时也不截断，说明照样完整写出', async () => {
  /** 打开的运行时。 */
  const { resources, dir } = await openRuntime();
  try {
    /** 短的模块名。 */
    const shortWho = '模型库.chat()';
    /** 长的：刻意超过对齐用的宽度，不能被切断。 */
    const longWho = '事件循环(飞书).claimNext()超过三十个字符的模块函数名';
    //G 先确认长名字真的超过对齐宽度，否则这条测试测不到不截断。
    bunTest.expect(width(longWho)).toBeGreaterThan(30);
    await logModule.note(resources, SESSION, shortWho, '短说明');
    await logModule.note(resources, SESSION, longWho, '长说明');
    /** 两行。 */
    const lines = (await logModule.readTimeline(resources, SESSION)).split('\n').filter((line) => line !== '');
    bunTest.expect(lines).toHaveLength(2);
    //M 短的这边只要求说明完整跟在后面；对齐由前一条用例按显示宽度验证。
    bunTest.expect(lines[0]?.endsWith('  短说明')).toBe(true);
    //M 超过对齐宽度的模块名照原样写，别把模块名切断得看不懂。
    bunTest.expect(lines[1]?.slice(8)).toBe(`  ${longWho}  长说明`);
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('readTimeline()：文件不存在时返回空字符串', async () => {
  /** 打开的运行时。 */
  const { resources, dir } = await openRuntime();
  try {
    //G 会话还没写过流水时（连会话目录都没有）是空字符串，调用方不用先判文件在不在。
    bunTest.expect(await logModule.readTimeline(resources, SESSION)).toBe('');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('timelineFile()：是会话目录下的 流水.log，跟着会话目录走', async () => {
  /** 打开的运行时。 */
  const { resources, dir } = await openRuntime();
  try {
    //M 机器人和不走机器人的会话目录不同，流水都放各自会话目录里。
    bunTest.expect(logModule.timelineFile(resources, SESSION)).toBe(path.join(resources.sessionDir(SESSION), '流水.log'));
    bunTest.expect(logModule.timelineFile(resources, { id: 'S200', bot: '小助手', title: '机器人会话' })).toBe(
      path.join(dir, 'logs', 'bots', '小助手', 'S200_机器人会话', '流水.log'),
    );
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('note()：流水写不进去时不抛错', async () => {
  /** 打开的运行时。 */
  const { resources, dir } = await openRuntime();
  try {
    //M Windows 上 chmod 造不出真正不可写的目录（只读属性对目录不生效，管理员还能绕过 ACL），
    //M 所以换个造法：先把 流水.log 这个位置占成一个目录，appendFile 打开它必然失败。
    fs.mkdirSync(logModule.timelineFile(resources, SESSION), { recursive: true });
    /** note 抛出来的错；没有抛错时是 undefined。 */
    let failure: unknown = undefined;
    try {
      await logModule.note(resources, SESSION, '干活执行器.run()', '写不进去也不能把正事弄挂');
    } catch (error) {
      failure = error;
    }
    //G 日志写不进去时要吞掉错误，调用方看到的是正常返回，执行流程不能因此失败。
    bunTest.expect(failure).toBeUndefined();
  } finally {
    removeRuntime(dir);
  }
});
