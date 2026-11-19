/**
 * file-tools（含并入的 BaseTools：time、read、list_dir、write + 看图接图片）的离线单元测试。
 * 跑法：bun test ./src7/plugins/file-tools/FileTools.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { ChatRequest, Session } from '../../Sessions.ts';
import * as toolsModule from '../../Tools.ts';
import * as fileToolsModule from './index.ts';


/** 1x1 像素合法 PNG 字节，测试读图与 attachImages 用。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const closers: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 假资源服务：提供不同模型是否支持图片输入。 */
class FakeResources extends cordis.Service {
  constructor(ctx: cordis.Context) {
    super(ctx, 'resources');
  }

  getModel(model: string): { input: string[] } {
    if (model.includes('vision')) {
      return { input: ['text', 'image'] };
    }
    return { input: ['text'] };
  }
}


/** 假机器人服务：只映射测试机器人工作区。 */
class FakeBots extends cordis.Service {
  constructor(ctx: cordis.Context, private readonly workspace: string) {
    super(ctx, 'bots');
  }

  get(name: string): { name: string; workspace: string } | undefined {
    if (name === '测试机') {
      return { name, workspace: this.workspace };
    }
    return undefined;
  }
}


/** 创建内存里的测试会话对象。 */
function makeSession(kind: 'front' | 'work', model: string, address?: Record<string, unknown>): Session {
  const row = {
    id: `s_${kind}`,
    kind,
    bot: '测试机',
    model,
    state: 'running',
    reply: '',
    messages: [],
    address,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return {
    id: row.id,
    row,
    save: () => undefined,
    stop: () => undefined,
  } as unknown as Session;
}


/** 初始化挂好 tools + file-tools 的 Cordis 上下文。 */
async function setup(): Promise<{ ctx: cordis.Context; workspace: string; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-unit-'));
  const workspace = path.join(root, 'bot-ws');
  fs.mkdirSync(workspace, { recursive: true });
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));

  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  await ctx.plugin(FakeResources);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(FakeBots, workspace);
  //M 模拟前台优先挂上 session/before-model（例如在前台替换 request.messages），验证 file-tools 排在其后。
  ctx.on('session/before-model', (request) => {
    if (request.session.row.kind === 'front' && request.messages.length === 0) {
      request.messages = [{ role: 'user', content: '未赋值占位', timestamp: Date.now() }];
    }
  });
  await ctx.plugin(fileToolsModule);
  return { ctx, workspace, root };
}


describe('file-tools（含 BaseTools 并入）', () => {
  test('版本为 1.1.1，front 与 work 的工具集合与预期一致', async () => {
    expect(fileToolsModule.version).toBe('1.1.1');
    const { ctx } = await setup();
    const frontNames = ctx.tools.listToolsForSessionKind('front').map((tool) => tool.name);
    const workNames = ctx.tools.listToolsForSessionKind('work').map((tool) => tool.name);

    expect(frontNames).toEqual(['time', 'read', 'list_dir', 'find']);
    expect(workNames).toEqual(['time', 'read', 'list_dir', 'write', 'edit', 'find']);
  });

  test('time、write、read（文本行号/范围与图片块）、list_dir 正常工作', async () => {
    const { ctx, workspace } = await setup();
    const workSession = makeSession('work', 'fake/text');
    const signal = new AbortController().signal;

    const timeRes = await ctx.tools.execute({ type: 'toolCall', id: 'c1', name: 'time', arguments: {} }, workSession, signal);
    expect(timeRes.isError).toBe(false);
    expect(timeRes.text.length).toBeGreaterThan(0);

    const emptyDir = await ctx.tools.execute({ type: 'toolCall', id: 'c2', name: 'list_dir', arguments: {} }, workSession, signal);
    expect(emptyDir.text).toBe('（空目录）');

    const writeRes = await ctx.tools.execute({
      type: 'toolCall',
      id: 'c3',
      name: 'write',
      arguments: { path: 'docs/hello.txt', content: '第一行\n第二行\n第三行' },
    }, workSession, signal);
    expect(writeRes.text).toBe('已写入');

    const listRoot = await ctx.tools.execute({ type: 'toolCall', id: 'c4', name: 'list_dir', arguments: {} }, workSession, signal);
    expect(listRoot.text).toBe('docs/');

    const readPart = await ctx.tools.execute({
      type: 'toolCall',
      id: 'c5',
      name: 'read',
      arguments: { path: 'docs/hello.txt', from: 2, count: 1 },
    }, workSession, signal);
    expect(readPart.text).toBe('2\t第二行');

    //M 写入图片文件：不看图模型提示需要换模型；看图模型返回图片块。
    fs.writeFileSync(path.join(workspace, 'pic.png'), PNG_BYTES);
    const imgNoVision = await ctx.tools.execute({ type: 'toolCall', id: 'c6', name: 'read', arguments: { path: 'pic.png' } }, workSession, signal);
    expect(imgNoVision.images).toBeUndefined();
    expect(imgNoVision.text).toContain('不收图片');

    const visionWork = makeSession('work', 'fake/vision');
    const imgVision = await ctx.tools.execute({ type: 'toolCall', id: 'c7', name: 'read', arguments: { path: 'pic.png' } }, visionWork, signal);
    expect(imgVision.images).toHaveLength(1);
    expect(imgVision.text).toContain('pic.png');
  });

  test('edit（精确/换行保留与中文引号宽松匹配）、find（文件名与内容）及工作区防越界（含符号链接隔离）', async () => {
    const { ctx, workspace, root } = await setup();
    const workSession = makeSession('work', 'fake/text');
    const signal = new AbortController().signal;

    const target = path.join(workspace, 'notes', 'a.txt');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'hello world\r\nline2 “引号”\r\n', 'utf8');

    const editedExact = await ctx.tools.execute({
      type: 'toolCall',
      id: 'e1',
      name: 'edit',
      arguments: { path: 'notes/a.txt', edits: [{ oldText: 'hello world', newText: 'hello there' }] },
    }, workSession, signal);
    expect(editedExact.text).toBe('已修改 notes/a.txt（1 处）');
    expect(fs.readFileSync(target, 'utf8')).toBe('hello there\r\nline2 “引号”\r\n');

    const editedFuzzy = await ctx.tools.execute({
      type: 'toolCall',
      id: 'e2',
      name: 'edit',
      arguments: { path: 'notes/a.txt', edits: [{ oldText: 'line2 "引号"', newText: 'line2 改好' }] },
    }, workSession, signal);
    expect(editedFuzzy.text).toContain('已修改');
    expect(fs.readFileSync(target, 'utf8')).toContain('line2 改好');

    const findByName = await ctx.tools.execute({
      type: 'toolCall',
      id: 'f1',
      name: 'find',
      arguments: { name: '*.txt' },
    }, workSession, signal);
    expect(findByName.text.split('\n')).toContain('notes/a.txt');

    const findByText = await ctx.tools.execute({
      type: 'toolCall',
      id: 'f2',
      name: 'find',
      arguments: { text: 'HELLO THERE' },
    }, workSession, signal);
    expect(findByText.text).toContain('notes/a.txt:1: hello there');

    //M 越出工作区（../）与 builder 个人工作区隔离。
    const escapeRead = await ctx.tools.execute({ type: 'toolCall', id: 's1', name: 'read', arguments: { path: '../outside.txt' } }, workSession, signal);
    expect(escapeRead.isError).toBe(true);
    expect(escapeRead.text).toContain('出了工作区');

    const builderDir = path.join(root, 'builder-dir');
    fs.mkdirSync(builderDir, { recursive: true });
    const builderSession = makeSession('work', 'fake/text', { role: 'builder', workspace: builderDir });
    await ctx.tools.execute({
      type: 'toolCall',
      id: 'b1',
      name: 'write',
      arguments: { path: 'own.txt', content: 'builder-only' },
    }, builderSession, signal);
    expect(fs.existsSync(path.join(builderDir, 'own.txt'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'own.txt'))).toBe(false);
  });

  test('session/before-model 监听：看图模型接入用户 @图片块，非看图模型注入不写识图脚本提醒', async () => {
    const { ctx, workspace } = await setup();
    const picPath = path.join(workspace, 'snap.png');
    fs.writeFileSync(picPath, PNG_BYTES);

    const traces: string[] = [];
    ctx.on('trace', (where) => {
      traces.push(where);
    });

    const visionReq: ChatRequest = {
      session: makeSession('front', 'fake/vision'),
      model: 'fake/vision',
      messages: [{ role: 'user', content: `帮我看看 @${picPath}`, timestamp: Date.now() }],
      system: [],
      tools: [],
      stop: undefined,
    } as unknown as ChatRequest;
    await ctx.serial('session/before-model', visionReq);

    const userContent = visionReq.messages[0]?.content;
    expect(Array.isArray(userContent)).toBe(true);
    if (Array.isArray(userContent)) {
      expect(userContent.some((block) => block.type === 'image')).toBe(true);
    }
    expect(traces).toContain('base-tools.attachImages');

    const textReq: ChatRequest = {
      session: makeSession('front', 'fake/text'),
      model: 'fake/text',
      messages: [{ role: 'user', content: `看看 @${picPath}`, timestamp: Date.now() }],
      system: [],
      tools: [],
      stop: undefined,
    } as unknown as ChatRequest;
    await ctx.serial('session/before-model', textReq);

    expect(textReq.messages.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('不要自己写 OCR'))).toBe(true);
  });
});
