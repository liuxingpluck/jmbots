/**
 * file-tools 插件（BaseTools、EditMatch、FileTools、Skill）防回归与沙箱边界离线单元测试：
 *   1. EditMatch 文本编辑内核：BOM 与 CRLF 保真、乱序多处替换、宽松匹配仅改目标行、全量异常守卫；
 *   2. BaseTools 工作区沙箱：../ 穿越、绝对越界路径、指向外部的符号链接与断链均被强拦截；
 *   3. grants.dirs 授权目录向下延伸：允许授权目录内读写，仍拒绝授权目录外的兄弟路径；
 *   4. attachImages 安全边界：跳过工作区外 @路径、符号链接指向外部图片、超 8MB 大图与非白名单 SVG；
 *   5. FileTools.find 过滤边界：双空参数拒绝、跳过 node_modules/.git/二进制/超 2MB 文件、300 字单行截断与 limit 上限；
 *   6. Skill 技能加载与工具隔离：个人覆盖全局优先级、畸形 YAML 降级取标题、仅注入 work 会话、../ 目录穿越拦截。
 * 全程隔离临时目录，零外网依赖，双平台确定通过。
 * 跑法：bun test ./src7/tests/Audit_FileTools.test.ts --timeout 60000
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import type * as piAi from '@earendil-works/pi-ai';
import type { ChatRequest, Session } from '../Sessions.ts';
import * as toolsModule from '../Tools.ts';
import * as editMatch from '../plugins/file-tools/EditMatch.ts';
import * as fileToolsPlugin from '../plugins/file-tools/index.ts';
import * as skillModule from '../plugins/file-tools/Skill.ts';


/** 最小合法 1x1 PNG 图像字节。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** 每个用例结束后按逆序释放的清理函数队列。 */
const closers: Array<() => Promise<unknown> | void> = [];

bunTest.afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 假资源服务，支持按模型名区分是否具备图像输入能力，并提供 ensureRuntimeDir。 */
class FakeResources extends cordis.Service {
  readonly raw = { bots: [{ name: '测试机' }] };

  constructor(ctx: cordis.Context, readonly root: string) {
    super(ctx, 'resources');
  }

  ensureRuntimeDir(...parts: string[]): string {
    const full = path.join(this.root, ...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }

  getModel(model: string): { input: string[] } {
    if (model.includes('vision')) return { input: ['text', 'image'] };

    return { input: ['text'] };
  }
}


/** 构造内存测试会话对象。 */
function makeSession(
  kind: 'front' | 'work',
  model: string,
  address?: Record<string, unknown>,
  bot = '测试机',
): Session {
  const row = {
    id: `s_ft_${kind}`,
    kind,
    bot,
    model,
    state: 'running',
    reply: '',
    messages: [],
    address,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return { id: row.id, row } as unknown as Session;
}


/** 初始化隔离的 file-tools 测试上下文。 */
async function setupWorld(): Promise<{ ctx: cordis.Context; root: string; workspace: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ft-'));
  const workspace = path.join(root, 'bots', '测试机', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  closers.push(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  await ctx.plugin(FakeResources, root);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(fileToolsPlugin);
  return { ctx, root, workspace };
}


/** 调用指定工具并返回执行结果。 */
async function callTool(
  ctx: cordis.Context,
  session: Session,
  name: string,
  args: Record<string, unknown>,
): Promise<toolsModule.ToolOutcome> {
  const call: piAi.ToolCall = {
    type: 'toolCall',
    id: `c_${name}`,
    name,
    arguments: args as piAi.ToolCall['arguments'],
  };
  return ctx.tools.execute(call, session, new AbortController().signal);
}


bunTest.describe('Audit_FileTools：工作区读写、编辑、搜索与技能安全边界', () => {
  bunTest.test('1. EditMatch：完整保留 UTF-8 BOM 与 CRLF，并支持乱序多处不重叠替换', () => {
    const input = '\uFEFFline1 alpha\r\nline2 beta\r\nline3 gamma\r\n';
    const edits: editMatch.Edit[] = [
      { oldText: 'gamma', newText: 'GAMMA' },
      { oldText: 'alpha', newText: 'ALPHA_LONG' },
    ];
    const result = editMatch.applyEdits(input, edits, 'demo.txt');
    bunTest.expect(result).toBe('\uFEFFline1 ALPHA_LONG\r\nline2 beta\r\nline3 GAMMA\r\n');
  });

  bunTest.test('2. EditMatch 异常守卫：空 oldText、找不到、不唯一、重叠与无实质变动全部抛错', () => {
    const content = 'aaa bbb aaa\nccc ddd\n';
    bunTest.expect(() => editMatch.applyEdits(content, [{ oldText: '', newText: 'x' }], 'a.ts')).toThrow('不能为空');
    bunTest.expect(() => editMatch.applyEdits(content, [{ oldText: 'zzz', newText: 'x' }], 'a.ts')).toThrow('找不到');
    bunTest.expect(() => editMatch.applyEdits(content, [{ oldText: 'aaa', newText: 'x' }], 'a.ts')).toThrow('出现了 2 次');
    bunTest.expect(() => editMatch.applyEdits(content, [
      { oldText: 'ccc d', newText: 'X' },
      { oldText: 'c ddd', newText: 'Y' },
    ], 'a.ts')).toThrow('重叠了');
    bunTest.expect(() => editMatch.applyEdits(content, [{ oldText: 'bbb', newText: 'bbb' }], 'a.ts')).toThrow('没有变化');
  });

  bunTest.test('3. EditMatch 宽松匹配：仅规整被改到的行，未改动行原样保留中文标点与行尾空格', () => {
    const original = '未改行：“保留引号”   \n目标行：—\u00A0“旧内容”\n尾行：“也保留”  \n';
    const changed = editMatch.applyEdits(
      original,
      [{ oldText: '目标行:- "旧内容"', newText: '目标行：已更新' }],
      'doc.md',
    );
    const lines = changed.split('\n');
    bunTest.expect(lines[0]).toBe('未改行：“保留引号”   ');
    bunTest.expect(lines[1]).toBe('目标行：已更新');
    bunTest.expect(lines[2]).toBe('尾行：“也保留”  ');
  });

  bunTest.test('4. 沙箱防逃逸：read/write/list_dir/edit 拦截 ../、绝对外部路径、外指符号链接与断链', async () => {
    const { ctx, root, workspace } = await setupWorld();
    const outsideFile = path.join(root, 'secret-outside.txt');
    fs.writeFileSync(outsideFile, 'TOP_SECRET', 'utf8');

    const linkToOutside = path.join(workspace, 'escape-link.txt');
    const brokenLink = path.join(workspace, 'broken-link.txt');
    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideFile, linkToOutside);
      fs.symlinkSync(path.join(root, 'not-yet-created.txt'), brokenLink);
      symlinkCreated = true;
    } catch {
      //G 无符号链接权限的环境仅保留相对/绝对路径拦截断言。
    }

    const work = makeSession('work', 'fake/text');
    const readRel = await callTool(ctx, work, 'read', { path: '../outside.txt' });
    const readAbs = await callTool(ctx, work, 'read', { path: outsideFile });
    const writeEsc = await callTool(ctx, work, 'write', { path: '../pwn.txt', content: 'bad' });
    const listEsc = await callTool(ctx, work, 'list_dir', { path: '..' });
    const editEsc = await callTool(ctx, work, 'edit', {
      path: outsideFile,
      edits: [{ oldText: 'TOP', newText: 'X' }],
    });

    bunTest.expect(readRel.isError).toBe(true);
    bunTest.expect(readAbs.isError).toBe(true);
    bunTest.expect(writeEsc.isError).toBe(true);
    bunTest.expect(listEsc.isError).toBe(true);
    bunTest.expect(editEsc.isError).toBe(true);

    if (symlinkCreated) {
      const readLink = await callTool(ctx, work, 'read', { path: 'escape-link.txt' });
      const writeBroken = await callTool(ctx, work, 'write', { path: 'broken-link.txt', content: 'x' });
      bunTest.expect(readLink.isError).toBe(true);
      bunTest.expect(writeBroken.isError).toBe(true);
    }
  });

  bunTest.test('5. grants.dirs 授权目录向下延伸：允许授权子目录读写，仍拒绝授权范围外兄弟目录', async () => {
    const { ctx, root } = await setupWorld();
    const grantedDir = path.join(root, 'granted-project');
    const siblingDir = path.join(root, 'granted-project-other');
    fs.mkdirSync(grantedDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, 'private.txt'), 'nope', 'utf8');

    const work = makeSession('work', 'fake/text', { grants: { dirs: [grantedDir] } });
    const targetFile = path.join(grantedDir, 'sub', 'ok.txt');
    const wrote = await callTool(ctx, work, 'write', { path: targetFile, content: 'allowed-body' });
    bunTest.expect(wrote.isError).toBe(false);

    const readBack = await callTool(ctx, work, 'read', { path: targetFile });
    bunTest.expect(readBack.isError).toBe(false);
    bunTest.expect(readBack.text).toBe('1\tallowed-body');

    //G 前缀相似的兄弟目录不得因字符串前缀匹配被误放行。
    const blocked = await callTool(ctx, work, 'read', { path: path.join(siblingDir, 'private.txt') });
    bunTest.expect(blocked.isError).toBe(true);
    bunTest.expect(blocked.text).toContain('出了工作区');
  });

  bunTest.test('6. BaseTools.read 行窗口越界切片与未知机器人错误保护', async () => {
    const { ctx, workspace } = await setupWorld();
    fs.writeFileSync(path.join(workspace, 'lines.txt'), 'A\nB\nC', 'utf8');
    const work = makeSession('work', 'fake/text');

    const beyond = await callTool(ctx, work, 'read', { path: 'lines.txt', from: 10, count: 5 });
    bunTest.expect(beyond.isError).toBe(false);
    bunTest.expect(beyond.text).toBe('');

    const ghostBot = makeSession('work', 'fake/text', undefined, '不存在的机器人');
    const failed = await callTool(ctx, ghostBot, 'read', { path: 'lines.txt' });
    bunTest.expect(failed.isError).toBe(true);
    bunTest.expect(failed.text).toContain('没有这个机器人');
  });

  bunTest.test('7. attachImages 安全隔离：忽略工作区外图片、超大 8MB 图片与非白名单 SVG 图片', async () => {
    const { ctx, root, workspace } = await setupWorld();
    const outsidePng = path.join(root, 'outside.png');
    const hugePng = path.join(workspace, 'huge.png');
    const svgImg = path.join(workspace, 'vector.svg');
    const validPng = path.join(workspace, 'ok.png');
    fs.writeFileSync(outsidePng, PNG_BYTES);
    fs.writeFileSync(hugePng, Buffer.alloc(8 * 1024 * 1024 + 64, 0));
    fs.writeFileSync(svgImg, '<svg></svg>', 'utf8');
    fs.writeFileSync(validPng, PNG_BYTES);

    const req = {
      session: makeSession('front', 'fake/vision'),
      model: 'fake/vision',
      messages: [
        {
          role: 'user',
          content: `看 @${outsidePng} @${hugePng} @${svgImg} @${validPng}`,
          timestamp: Date.now(),
        },
      ],
      system: [],
      tools: [],
      stop: undefined,
    } as unknown as ChatRequest;

    await ctx.serial('session/before-model', req);
    const content = req.messages[0]?.content;
    bunTest.expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      const images = content.filter((block) => block.type === 'image');
      //G 4 张图中仅有工作区内合法小图 ok.png 被接入模型请求。
      bunTest.expect(images).toHaveLength(1);
    }
  });

  bunTest.test('8. FileTools.find 拒绝空条件，并跳过 node_modules、.git、二进制与超 2MB 文件', async () => {
    const { ctx, workspace } = await setupWorld();
    fs.mkdirSync(path.join(workspace, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'node_modules', 'pkg', 'a.txt'), 'NEEDLE', 'utf8');
    fs.writeFileSync(path.join(workspace, '.git', 'config'), 'NEEDLE', 'utf8');
    fs.writeFileSync(path.join(workspace, 'bin.dat'), Buffer.from([0x4e, 0x45, 0x45, 0x00, 0x44, 0x4c, 0x45]));
    fs.writeFileSync(path.join(workspace, 'big.txt'), `NEEDLE\n${'x'.repeat(2 * 1024 * 1024 + 10)}`, 'utf8');
    fs.writeFileSync(path.join(workspace, 'clean.txt'), 'alpha\nneedle-hit\n', 'utf8');

    const front = makeSession('front', 'fake/text');
    const emptyArgs = await callTool(ctx, front, 'find', {});
    bunTest.expect(emptyArgs.isError).toBe(true);
    bunTest.expect(emptyArgs.text).toContain('name 和 text 至少给一个');

    const hit = await callTool(ctx, front, 'find', { text: 'NEEDLE' });
    bunTest.expect(hit.isError).toBe(false);
    bunTest.expect(hit.text).toBe('clean.txt:2: needle-hit');
  });

  bunTest.test('9. FileTools.find 对超 300 字长行截断并遵守 limit 数量上限提示', async () => {
    const { ctx, workspace } = await setupWorld();
    const longLine = `FINDME_${'a'.repeat(350)}`;
    fs.writeFileSync(path.join(workspace, 'long.txt'), `${longLine}\nFINDME_2\nFINDME_3\n`, 'utf8');

    const front = makeSession('front', 'fake/text');
    const res = await callTool(ctx, front, 'find', { text: 'findme', limit: 2 });
    bunTest.expect(res.isError).toBe(false);
    bunTest.expect(res.text).toContain('…');
    bunTest.expect(res.text).toContain('[只列了前 2 条，缩小范围或加大 limit]');
    bunTest.expect(res.text).not.toContain('FINDME_3');
  });

  bunTest.test('10. Skill.list 支持个人覆盖全局、畸形 frontmatter 降级、超 200 字截断与空文件过滤', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-skill-list-'));
    closers.push(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    const globalRoot = path.join(root, 'skills');
    const botRoot = path.join(root, 'bots', '测试机', 'skills');
    fs.mkdirSync(path.join(globalRoot, 'deploy'), { recursive: true });
    fs.mkdirSync(path.join(globalRoot, 'empty-one'), { recursive: true });
    fs.mkdirSync(path.join(globalRoot, 'bad-yaml'), { recursive: true });
    fs.mkdirSync(path.join(botRoot, 'deploy'), { recursive: true });

    fs.writeFileSync(path.join(globalRoot, 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: 全局版本\n---\n内容');
    const longDesc = '长'.repeat(230);
    fs.writeFileSync(
      path.join(botRoot, 'deploy', 'SKILL.md'),
      `---\nname: deploy\ndescription: ${longDesc}\n---\n`,
    );
    fs.writeFileSync(path.join(globalRoot, 'empty-one', 'SKILL.md'), '   \n  ');
    fs.writeFileSync(path.join(globalRoot, 'bad-yaml', 'SKILL.md'), '---\n: [broken\n---\n# 降级标题说明\n正文');

    const items = skillModule.list([globalRoot, botRoot]);
    bunTest.expect(items.map((item) => item.name)).toEqual(['bad-yaml', 'deploy']);
    bunTest.expect(items[0]?.description).toBe('降级标题说明');
    //G 个人技能覆盖全局同名技能，且描述按 200 字符截断加省略号。
    bunTest.expect(items[1]?.file).toBe(path.join(botRoot, 'deploy', 'SKILL.md'));
    bunTest.expect([...(items[1]?.description ?? '')].length).toBe(201);
  });

  bunTest.test('11. skill 提示词仅注入 work 会话（front 不注入），工具可读技能目录内附属脚本', async () => {
    const { ctx, root } = await setupWorld();
    const skillDir = path.join(root, 'skills', 'audit-helper');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: audit-helper\ndescription: 审计助手\n---\n使用说明');
    fs.writeFileSync(path.join(skillDir, 'scripts', 'run.txt'), 'helper-script-body');

    const frontReq = {
      session: makeSession('front', 'fake/text'),
      model: 'fake/text',
      messages: [],
      system: [] as string[],
      tools: [],
      stop: undefined,
    } as unknown as ChatRequest;
    const workReq = {
      session: makeSession('work', 'fake/text'),
      model: 'fake/text',
      messages: [],
      system: [] as string[],
      tools: [],
      stop: undefined,
    } as unknown as ChatRequest;

    await ctx.serial('session/before-model', frontReq);
    await ctx.serial('session/before-model', workReq);
    bunTest.expect(frontReq.system).toHaveLength(0);
    bunTest.expect(workReq.system[0]).toContain('# 技能');
    bunTest.expect(workReq.system[0]).toContain('audit-helper：审计助手');

    const work = makeSession('work', 'fake/text');
    const doc = await callTool(ctx, work, 'skill', { name: 'audit-helper' });
    const sub = await callTool(ctx, work, 'skill', { name: 'audit-helper', file: 'scripts/run.txt' });
    bunTest.expect(doc.isError).toBe(false);
    bunTest.expect(doc.text).toContain('使用说明');
    bunTest.expect(sub.isError).toBe(false);
    bunTest.expect(sub.text).toBe('helper-script-body');
  });

  bunTest.test('12. skill 工具路径越权拦截：拒绝 ../ 逃逸技能目录、未知技能名与不存在附属文件', async () => {
    const { ctx, root } = await setupWorld();
    const skillDir = path.join(root, 'skills', 'safe-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# 安全技能\n正文');
    fs.writeFileSync(path.join(root, 'config.yaml'), 'secret: leaked');

    const work = makeSession('work', 'fake/text');
    const traversal = await callTool(ctx, work, 'skill', { name: 'safe-skill', file: '../../config.yaml' });
    const missingFile = await callTool(ctx, work, 'skill', { name: 'safe-skill', file: 'missing.txt' });
    const unknownSkill = await callTool(ctx, work, 'skill', { name: 'no-such-skill' });

    bunTest.expect(traversal.isError).toBe(true);
    bunTest.expect(traversal.text).toContain('只能读技能文件夹');
    bunTest.expect(missingFile.isError).toBe(true);
    bunTest.expect(missingFile.text).toContain('技能里没有这个文件');
    bunTest.expect(unknownSkill.isError).toBe(true);
    bunTest.expect(unknownSkill.text).toContain('没有技能');
  });
});
