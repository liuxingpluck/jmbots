/**
 * 资源（src/resources/Resources.ts）的离线测试：在临时运行时目录里自己写 config.yaml，
 * 验证 Resources.load 把缺的 engine/concurrency/http/local 默认项补进 config.yaml、
 * 原注释和没见过的键保留、已经写的值不被覆盖；listBots 严格使用 config 的启用名单，历史文件夹保留。
 * 全部在临时目录里做，不读真实运行时里的 config.yaml，不联网、不调模型。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as resourcesModule from '../src/resources/Resources.ts';

/** 加载边界拒绝无效数值，避免运行到 getter 才发现配置错误。 */
bunTest.test('无效数值在 Resources.load 首次读取时失败', async () => {
  const fragments = [
    'concurrency:\n  default: false\n',
    'http:\n  port: "不是端口"\n',
    'engine:\n  poll_ms: " "\n',
    'engine:\n  retry_delays_ms: [1, false]\n',
  ];
  for (const fragment of fragments) {
    const dir = tempRuntimeDir();
    try {
      const configFile = path.join(dir, 'config.yaml');
      const configText = `providers: {}\nbots: []\n${fragment}`;
      fs.writeFileSync(configFile, configText);

      const failure = await resourcesModule.Resources.load(dir).catch((error: unknown) => error);
      bunTest.expect(failure).toBeInstanceOf(Error);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** 配置只规范化一次；渠道目标在首次创建机器人时仍能确定。 */
bunTest.test('数值字符串在加载时转数字，空名单渠道随首个机器人确定目标', async () => {
  const dir = tempRuntimeDir();
  try {
    const configFile = path.join(dir, 'config.yaml');
    const configText = [
      'providers: {}',
      'bots: []',
      'concurrency:',
      '  default: "5"',
      'http:',
      '  port: "30086"',
      'channels:',
      '  example:',
      '    enabled: true',
    ].join('\n');
    fs.writeFileSync(configFile, configText);

    const runtime = await resourcesModule.Resources.load(dir);
    bunTest.expect(runtime.getConcurrency().perModel).toBe(5);
    bunTest.expect(runtime.getHttp().port).toBe(30086);
    bunTest.expect(runtime.listChannels()[0]?.settings.bot).toBeUndefined();

    runtime.addBot({ name: '新机器人', language: 'zh' });
    bunTest.expect(runtime.listChannels()[0]?.settings.bot).toBe('新机器人');

    /** 调用方改渠道副本，不污染资源持有的配置。 */
    const channels = runtime.listChannels();
    channels[0]!.settings.bot = '改掉的名字';
    bunTest.expect(runtime.listChannels()[0]?.settings.bot).toBe('新机器人');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


/**
 * 建一个空的临时运行时目录。
 * @returns 目录路径；用完调用方自己删。
 */
function tempRuntimeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-resources-'));
}


/** 一份带注释、未知键、已有 merge_ms 和一项机器人的 config.yaml 原文。 */
const CONFIG = `# 头上的注释
engine:
  merge_ms: 3000 # 合批等多久
unknown_key: 留着
providers: {}
default_model: magpie/workbuddy/hy3
bots:
  - name: 配置机器人
    language: zh
`;


bunTest.test('load 把缺的默认项补进 config.yaml，原注释、未知键和已写值都保留', async () => {
  /** 临时运行时目录。 */
  const dir = tempRuntimeDir();
  try {
    fs.writeFileSync(path.join(dir, 'config.yaml'), CONFIG);
    const runtime = await resourcesModule.Resources.load(dir);
    /** 补过默认值之后的 config.yaml 原文。 */
    const text = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
    //M 原注释和没见过的键都还在。
    bunTest.expect(text).toContain('# 头上的注释');
    bunTest.expect(text).toContain('unknown_key: 留着');
    //M 已经写的值和它后面的行内注释都不被覆盖。
    bunTest.expect(text).toContain('merge_ms: 3000 # 合批等多久');
    bunTest.expect(text).not.toContain('merge_ms: 2000');
    //M engine 缺的项补齐（键都在文件里）。
    for (const key of ['poll_ms', 'max_rounds', 'compress_at', 'exec_pass', 'fallback_max_tries', 'retry_delays_ms', 'fallback_include_siblings']) {
      bunTest.expect(text).toContain(`${key}:`);
    }
    bunTest.expect(text).toMatch(/poll_ms:\s*300\b/);
    bunTest.expect(text).toMatch(/max_rounds:\s*300\b/);
    bunTest.expect(text).toMatch(/compress_at:\s*200000\b/);
    bunTest.expect(text).toMatch(/exec_pass:\s*0\.2\b/);
    bunTest.expect(text).toMatch(/fallback_max_tries:\s*5\b/);
    bunTest.expect(text).toMatch(/fallback_include_siblings:\s*true\b/);
    bunTest.expect(text).toMatch(/retry_delays_ms:\s*\n\s+- 2000\n\s+- 5000/);
    //M concurrency/http/local 也补进文件。
    bunTest.expect(text).toMatch(/concurrency:\s*\n\s+default:\s*3\b/);
    bunTest.expect(text).toMatch(/http:\s*\n\s+port:\s*30086\b/);
    bunTest.expect(text).toMatch(/local:\s*\n\s+port:\s*30090\b/);
    bunTest.expect(text).toMatch(/local:[\s\S]*?\n\s+libs:\s*data\/index\/libs\b/);
    bunTest.expect(text).toMatch(/local:[\s\S]*?\n\s+rag:\s*data\/index\/rag\b/);
    //M 读配置的函数拿到的就是文件里这些值。
    bunTest.expect(runtime.getSetting('mergeMs')).toBe(3000);
    bunTest.expect(runtime.getSetting('pollMs')).toBe(300);
    bunTest.expect(runtime.getSetting('maxRounds')).toBe(300);
    bunTest.expect(runtime.getSetting('compressAt')).toBe(200_000);
    bunTest.expect(runtime.getSetting('execPass')).toBe(0.2);
    bunTest.expect(runtime.getSetting('fallbackMaxTries')).toBe(5);
    bunTest.expect(runtime.getSetting('retryDelaysMs')).toEqual([2000, 5000]);
    bunTest.expect(runtime.getSetting('fallbackSiblings')).toBe(true);
    bunTest.expect(runtime.getConcurrency().perModel).toBe(3);
    bunTest.expect(runtime.getHttp().port).toBe(30086);
    //M 再 load 一次：已经补齐就不重写，文本一个字都不变。
    await resourcesModule.Resources.load(dir);
    bunTest.expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toBe(text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test('listBots 只启用 config 名单，历史机器人文件夹和文件保留', async () => {
  /** 临时运行时目录。 */
  const dir = tempRuntimeDir();
  try {
    fs.writeFileSync(path.join(dir, 'config.yaml'), CONFIG);
    //M 文件夹里只有历史资料，没有写进 bots 就不启用。
    fs.mkdirSync(path.join(dir, 'bots', '文件夹机器人'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bots', '文件夹机器人', '历史.md'), '必须保留');
    const runtime = await resourcesModule.Resources.load(dir);
    bunTest.expect(runtime.listBots()).toEqual([
      { name: '配置机器人', language: 'zh' },
    ]);
    bunTest.expect(() => runtime.getBot('文件夹机器人')).toThrow('未启用');
    bunTest.expect(fs.readFileSync(path.join(dir, 'bots', '文件夹机器人', '历史.md'), 'utf8')).toBe('必须保留');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
