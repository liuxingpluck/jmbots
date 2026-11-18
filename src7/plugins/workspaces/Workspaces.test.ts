/**
 * workspaces 插件：同名两个工作区 ID 不同；旧默认目录登记前后是同一个目录、重复登记（含重启）不出第二条；
 * 外人拿本人的工作区 ID 被拒、工具不泄露名字；归档的不能新派；hand_session 的 workspaceId 和 workspace 同时给报冲突；
 * 按 ID 派的后台绑定工作区，append 不换。
 * 真实 Cordis + 骨架 Sessions、Tools + workspaces、bots 插件；模型是测试里的假回答，库是临时目录里的文件库（测重启）。
 * 跑法：bun test ./src7/plugins/workspaces
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as sessionsModule from '../../Sessions.ts';
import * as toolsModule from '../../Tools.ts';
import * as botsPlugin from '../bots/index.ts';
import * as workspacesPlugin from './index.ts';


//M 每个用例收拾自己的插件和临时目录（倒着来：先拔插件、关库，再删目录）。
const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


//M 假资源：临时目录里的文件库（同一个目录再起一套就是重启）、默认模型 fake/fake、一个机器人“助手”。
class FakeResources extends cordis.Service {
  readonly db: Database;
  readonly raw = { bots: [{ name: '助手' }] };
  readonly config = {
    defaultModel: 'fake/fake',
    thinking: 'low',
    retry: { times: 0, waitMs: 0, timeoutMs: 1000 },
    providers: {},
  };

  constructor(ctx: cordis.Context, readonly root: string) {
    super(ctx, 'resources');
    this.db = new Database(path.join(root, 'test.db'), { create: true });
    this.ctx.effect(() => {
      return () => {
        this.db.close();
      };
    });
  }

  dir(...parts: string[]): string {
    const full = path.join(this.root, ...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }

  getModel(): { input: string[] } {
    return { input: ['text'] };
  }
}


/**
 * 假模型：最后是工具结果就照结果回一句；是交回的结果就回“整理好了”；话写成“调用 工具 {JSON}”就调那个工具；别的回“做完了：话”。
 * @param request 这一步的请求。
 */
function fakeAnswer(request: sessionsModule.ChatRequest): void {
  const last = request.messages.findLast((item) => (item.role as string) !== 'system');
  if (last?.role === 'toolResult') {
    request.answer = piAi.fauxAssistantMessage(`工具说：${piAi.contentText(last.content)}`);
    return;
  }

  let said = '';
  if (last?.role === 'user') {
    said = piAi.contentText(last.content);
  }
  if (said.includes('交回的结果')) {
    request.answer = piAi.fauxAssistantMessage('整理好了：后台做完了');
    return;
  }

  const asked = /^调用\s+(\S+)\s*(\{.*\})$/su.exec(said.trim());
  if (asked !== null) {
    const args = JSON.parse(asked[2] ?? '{}') as Parameters<typeof piAi.fauxToolCall>[1];
    const call = piAi.fauxToolCall(asked[1] ?? '', args);
    request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
    return;
  }
  request.answer = piAi.fauxAssistantMessage(`做完了：${said}`);
}


/**
 * 挂上骨架、workspaces、bots，登记渠道 test（发的话记进 sent）。
 * @param root 运行时目录；不给就新建一个临时目录（用例结束删掉）。给了是在同一个目录上再起一套（重启）。
 * @returns ctx、运行时目录、渠道发出去的话。
 */
async function world(root?: string): Promise<{ ctx: cordis.Context; root: string; sent: string[] }> {
  let dir = root ?? '';
  if (root === undefined) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspaces-'));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  }
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());
  await ctx.plugin(FakeResources, dir);
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  ctx.on('session/request', fakeAnswer);

  const sent: string[] = [];
  ctx.bots.channel('test', (reply) => {
    sent.push(reply);
    return { status: 'accepted', reason: '' };
  });
  return { ctx, root: dir, sent };
}


/**
 * 等到条件成立，最多 3 秒。
 * @param check 条件。
 */
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;

    await Bun.sleep(10);
  }
  throw new Error('等了 3 秒条件还不成立');
}


/**
 * 在一场前台里直接执行一次工具 workspace（不经模型）。
 * @param ctx 挂好的 ctx。
 * @param address 说话人的回话地址。
 * @param args 工具参数。
 * @returns 工具交回的文字。
 */
async function callTool(ctx: cordis.Context, address: unknown, args: Record<string, unknown>): Promise<string> {
  const front = ctx.sessions.create({ kind: 'front', bot: '助手' });
  front.row.address = address;
  front.row.state = 'running';
  const call = piAi.fauxToolCall('workspace', args as Parameters<typeof piAi.fauxToolCall>[1]);
  const signal = new AbortController().signal;
  const outcome = await ctx.tools.execute(call, front, signal);
  return outcome.text;
}


/** 本人的回话地址（网页、命令行这类不写 role 的都当本人）。 */
const OWNER_ADDRESS = { customer: 'test:u1' };


test('同名两个工作区：ID、目录都不同，list 都列出来；改名只改名字', async () => {
  const { ctx, root } = await world();
  const changes: workspacesPlugin.WorkspaceChange[] = [];
  ctx.on('workspaces/changed', (change) => {
    changes.push(change);
  });
  const owner = ctx.workspaces.getAccess('助手', OWNER_ADDRESS);

  //M 两个都叫“项目”（第二个带空白，存的时候去掉）。
  const first = ctx.workspaces.create({ name: '项目' }, owner);
  const second = ctx.workspaces.create({ name: ' 项目 ' }, owner);
  expect(first.id).not.toBe(second.id);
  expect(second.name).toBe('项目');
  expect(first.directory).not.toBe(second.directory);
  expect(first.directory).toBe(`bots/助手/workspaces/${first.id}`);
  expect(fs.existsSync(path.join(root, first.directory))).toBe(true);

  //M list 两个都在；按名字查不出唯一的一个。
  const named = ctx.workspaces.list(owner).filter((item) => item.name === '项目');
  expect(named.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());

  //M 改名：ID、目录不变；改成同名不发事件。
  const renamed = ctx.workspaces.rename(first.id, '前端', owner);
  expect(renamed.id).toBe(first.id);
  expect(renamed.directory).toBe(first.directory);
  ctx.workspaces.rename(first.id, '前端', owner);
  const actions = changes.filter((change) => change.workspaceId === first.id).map((change) => change.action);
  expect(actions).toEqual(['created', 'renamed']);

  //M 没名字的不让建。
  expect(() => ctx.workspaces.create({ name: '  ' }, owner)).toThrow('workspace_invalid_name');

  //M 工具：本人 list 交回 { ok: true, items }，带默认工作区。
  const listText = await callTool(ctx, OWNER_ADDRESS, { action: 'list' });
  const listed = JSON.parse(listText) as { ok: boolean; items: workspacesPlugin.Workspace[] };
  expect(listed.ok).toBe(true);
  expect(listed.items.some((item) => item.isDefault && item.directory === 'bots/助手/workspace')).toBe(true);
});


test('旧默认目录：登记前后是同一个目录，重复登记、重启都不出第二条；旧写法相对路径两次落到同一个 ID', async () => {
  const { ctx, root, sent } = await world();
  const botWorkspace = ctx.bots.get('助手')?.workspace ?? '';
  const owner = ctx.workspaces.getAccess('助手', OWNER_ADDRESS);

  //M 默认工作区就是原来的 bots/助手/workspace/（Bot.workspace），建机器人时已经登记。
  const resolved = ctx.workspaces.resolve(owner);
  expect(resolved.directory).toBe(botWorkspace);
  expect(resolved.workspace.directory).toBe('bots/助手/workspace');
  expect(resolved.workspace.isDefault).toBe(true);
  expect(resolved.workspace.scopeKey).toBe('private');

  //M 再登记一次：同一条。
  expect(ctx.workspaces.ensureDefault('助手').id).toBe(resolved.workspace.id);
  const countSql = "SELECT COUNT(*) AS n FROM workspaces WHERE bot = '助手' AND is_default = 1";
  expect((ctx.resources.db.query(countSql).get() as { n: number }).n).toBe(1);

  //M 重启（同一个目录再起一套，建机器人时又调 ensureDefault）：还是同一个 ID，不出第二条。
  const restarted = await world(root);
  expect(restarted.ctx.workspaces.ensureDefault('助手').id).toBe(resolved.workspace.id);
  expect((restarted.ctx.resources.db.query(countSql).get() as { n: number }).n).toBe(1);

  //M hand_session 旧写法 workspace: 'sub'：落成默认工作区下的 sub，登记一条；再派一次还是同一个 ID。
  const hand = JSON.stringify({ text: '做事', workspace: 'sub' });
  await ctx.bots.receive('test', '助手', `调用 hand_session ${hand}`, OWNER_ADDRESS);
  await waitFor(() => sent.filter((reply) => reply === '整理好了：后台做完了').length === 1);
  await ctx.bots.receive('test', '助手', `调用 hand_session ${hand}`, OWNER_ADDRESS);
  await waitFor(() => ctx.sessions.find({ kind: 'work' }).length === 2);

  const works = ctx.sessions.find({ kind: 'work' });
  const ids = new Set(works.map((row) => row.workspaceId));
  expect(ids.size).toBe(1);
  expect([...ids][0]).not.toBe(resolved.workspace.id);
  const expected = fs.realpathSync.native(path.join(botWorkspace, 'sub'));
  for (const row of works) {
    const dir = String((row.address as Record<string, unknown>)['workspace']);
    expect(fs.realpathSync.native(dir)).toBe(expected);
  }
});


test('外人：拿本人的工作区 ID 被拒，工具不说名字；只看得到自己范围的，默认是他自己的目录', async () => {
  const { ctx, root } = await world();
  const guestDir = path.join(root, 'guests', '_guest');
  fs.mkdirSync(guestDir, { recursive: true });
  const guestAddress = { customer: 'test:g1', role: 'guest', workspace: guestDir };
  const owner = ctx.workspaces.getAccess('助手', OWNER_ADDRESS);
  const guest = ctx.workspaces.getAccess('助手', guestAddress);
  const mine = ctx.workspaces.create({ name: '私事' }, owner);

  //M 本人的 ID：取、派活都被拒；外人也不能新建、改名、归档。
  expect(() => ctx.workspaces.get(mine.id, guest)).toThrow('workspace_forbidden');
  expect(() => ctx.workspaces.resolve(guest, { workspaceId: mine.id })).toThrow('workspace_forbidden');
  expect(() => ctx.workspaces.create({ name: '我的' }, guest)).toThrow('workspace_forbidden');
  expect(() => ctx.workspaces.rename(mine.id, '改掉', guest)).toThrow('workspace_forbidden');

  //M 工具：错误码和一句话，不带名字、目录。
  const text = await callTool(ctx, guestAddress, { action: 'get', id: mine.id });
  const failed = JSON.parse(text) as { ok: boolean; error: { code: string; message: string } };
  expect(failed.ok).toBe(false);
  expect(failed.error.code).toBe('workspace_forbidden');
  expect(text.includes('私事')).toBe(false);
  expect(text.includes(mine.directory)).toBe(false);

  //M 外人不写工作区：他自己的目录，登记成他那个范围的默认；list 只有它。
  const guestDefault = ctx.workspaces.resolve(guest);
  expect(guestDefault.directory).toBe(guestDir);
  expect(guestDefault.workspace.scopeKey).toBe('dir:guests/_guest');
  expect(guestDefault.workspace.isDefault).toBe(true);
  expect(ctx.workspaces.list(guest).map((item) => item.id)).toEqual([guestDefault.workspace.id]);

  //M 本人看得到外人范围的。
  expect(ctx.workspaces.get(guestDefault.workspace.id, owner).id).toBe(guestDefault.workspace.id);
});


test('归档：不能新派（hand_session 报 workspace_archived、不开后台），绑定过的照样能取；默认的不能归档', async () => {
  const { ctx, sent } = await world();
  const owner = ctx.workspaces.getAccess('助手', OWNER_ADDRESS);
  const temp = ctx.workspaces.create({ name: '临时' }, owner);

  //M 归档：再归档一次原样交回。
  const archived = ctx.workspaces.archive(temp.id, owner);
  expect(archived.status).toBe('archived');
  expect(ctx.workspaces.archive(temp.id, owner).updatedAt).toBe(archived.updatedAt);

  //M 新选择不给；绑定过的后台（allowArchived）照样给。默认列表不列，includeArchived 才列。
  expect(() => ctx.workspaces.resolve(owner, { workspaceId: temp.id })).toThrow('workspace_archived');
  expect(ctx.workspaces.resolve(owner, { workspaceId: temp.id, allowArchived: true }).workspace.id).toBe(temp.id);
  expect(ctx.workspaces.list(owner).some((item) => item.id === temp.id)).toBe(false);
  expect(ctx.workspaces.list(owner, { includeArchived: true }).some((item) => item.id === temp.id)).toBe(true);

  //M 默认工作区不能归档。
  const home = ctx.workspaces.ensureDefault('助手');
  expect(() => ctx.workspaces.archive(home.id, owner)).toThrow('workspace_default_protected');

  //M hand_session 派到归档的：报错，不开后台。
  const hand = JSON.stringify({ text: '做事', workspaceId: temp.id });
  await ctx.bots.receive('test', '助手', `调用 hand_session ${hand}`, OWNER_ADDRESS);
  await waitFor(() => sent.some((reply) => reply.includes('workspace_archived')));
  expect(ctx.sessions.find({ kind: 'work' }).length).toBe(0);
});


test('hand_session：workspaceId 和 workspace 同时给报冲突；按 ID 派的后台绑定工作区，append 不换', async () => {
  const { ctx, sent } = await world();
  const owner = ctx.workspaces.getAccess('助手', OWNER_ADDRESS);
  const project = ctx.workspaces.create({ name: '项目' }, owner);

  //M 两个都写：报 workspace_selection_conflict，不开后台。
  const both = JSON.stringify({ text: '做事', workspaceId: project.id, workspace: 'sub' });
  await ctx.bots.receive('test', '助手', `调用 hand_session ${both}`, OWNER_ADDRESS);
  await waitFor(() => sent.some((reply) => reply.includes('workspace_selection_conflict')));
  expect(ctx.sessions.find({ kind: 'work' }).length).toBe(0);

  //M 按 ID 派：后台绑上 ID，回话地址里的目录是它的目录；frontTask.workspace 记名字。
  const byId = JSON.stringify({ text: '做事', workspaceId: project.id });
  await ctx.bots.receive('test', '助手', `调用 hand_session ${byId}`, OWNER_ADDRESS);
  await waitFor(() => sent.includes('整理好了：后台做完了'));
  const work = ctx.sessions.find({ kind: 'work' })[0];
  const directory = ctx.workspaces.resolve(owner, { workspaceId: project.id }).directory;
  expect(work?.workspaceId).toBe(project.id);
  expect(work?.frontTask?.workspace).toBe('项目');
  expect((work?.address as Record<string, unknown>)['workspace']).toBe(directory);

  //M append：绑定不变，目录照旧。
  const workId = work?.id ?? '';
  const append = JSON.stringify({ action: 'append', sessionId: workId, text: '接着做' });
  await ctx.bots.receive('test', '助手', `调用 hand_session ${append}`, OWNER_ADDRESS);
  await waitFor(() => sent.filter((reply) => reply === '整理好了：后台做完了').length === 2);
  const after = ctx.sessions.open(workId).row;
  expect(after.workspaceId).toBe(project.id);
  expect((after.address as Record<string, unknown>)['workspace']).toBe(directory);
});
