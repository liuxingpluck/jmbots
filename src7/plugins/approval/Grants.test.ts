/**
 * 目录授权向下延伸（用户 #292、#297、#301）：本人把人、群绑到目录，目录和子目录里读写、跑命令、发文件不用再问。
 * 跑法：bun test ./src7/plugins/approval/Grants.test.ts
 * 真的 Cordis + 真的 approval、file-tools、exec 插件和飞书的 feishu_send_file 工具（media.setup）；
 * resources、sessions、tools 是只够它们挂上的假服务。sessions.find 照 METAS 给会话记录，审核小会话照 review.reply 回。
 * 不挂 decision：decision/judge 没人答，当场退回拿不准。命令只用 echo，cmd.exe 和 sh 都能跑。
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import type { ToolGate, ToolSpec } from '../../Tools.ts';
import type { ChatRequest } from '../../Sessions.ts';
import type * as protocol from '../channels/index.ts';
import type { Feishu } from '../feishu/index.ts';
import * as checks from '../../utils/Checks.ts';
import * as requestEvents from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as fileTools from '../file-tools/index.ts';
import * as execModule from '../exec/index.ts';
import * as media from '../feishu/Media.ts';
import * as approvalModule from './index.ts';


/** 临时运行时目录：机器人的工作区、guest 目录；外面另有授权目录（带子目录）和不授权的目录。 */
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-grants-'));
const ROOT = path.join(base, 'jmbotsData');
const BOT_WORKSPACE = path.join(ROOT, 'bots', '周小灵', 'workspace');
const GUEST_DIR = path.join(ROOT, 'guests', '_guest');
const GRANTED = path.join(fs.realpathSync.native(base), 'outwork', 'zlt');
const SUB = path.join(GRANTED, 'sub');
const OUTSIDE = path.join(base, 'elsewhere');
for (const dir of [BOT_WORKSPACE, GUEST_DIR, SUB, OUTSIDE]) {
  fs.mkdirSync(dir, { recursive: true });
}
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});


/** 审核小会话这次回什么。 */
const review = { reply: '{"safe": false, "risk": "出了目录"}' };

/** 假会话记录：id → 记录（tool run 用的 row 就是这个对象，find 也交回它）。 */
const METAS = new Map<string, Record<string, unknown>>();


/** 假的 resources：approval 建表、exec、文件工具算路径用到的几项。 */
class FakeResources extends cordis.Service {
  db = new Database(':memory:');
  root = ROOT;
  raw = { bots: [{ name: '周小灵' }] };
  config = { providers: {} };
  constructor(ctx: cordis.Context) {
    super(ctx, 'resources');
  }
  ensureRuntimeDir(...parts: string[]): string {
    const full = path.join(ROOT, ...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }
  getModel(): { input: string[] } {
    return { input: ['text'] };
  }
}

/** 假的 sessions：find 照 METAS 给；审核小会话照 review.reply 回。 */
class FakeSessions extends cordis.Service {
  constructor(ctx: cordis.Context) {
    super(ctx, 'sessions');
  }
  find(where: { id?: string }): unknown[] {
    if (where.id === undefined) return [];

    const meta = METAS.get(where.id);
    if (meta === undefined) return [];

    return [meta];
  }
  /** 审核小会话前 getWhy 取会话里最后一句用户的话：交回同一份记录。 */
  open(id: string): { row: Record<string, unknown> } {
    const row = METAS.get(id);
    if (row === undefined) throw new Error(`没有会话 ${id}`);

    return { row };
  }
  ask(): Promise<{ ok: boolean; reply: string }> {
    return Promise.resolve({ ok: true, reply: review.reply });
  }
}

/** 假的 tools：只记下登记的工具，测试直接调 run。 */
class FakeTools extends cordis.Service {
  specs = new Map<string, ToolSpec>();
  constructor(ctx: cordis.Context) {
    super(ctx, 'tools');
  }
  register(spec: ToolSpec): void {
    this.specs.set(spec.definition.name, spec);
  }
}


/** 群「周-论文实现」里的三种人（飞书照 people 写的样子；群没登记 trusted）。 */
const GROUP = { appId: 'cli_x', chatId: 'oc_paper', chatType: 'group', customer: 'feishu:group:oc_paper', chatName: '周-论文实现' };
const OWNER = { ...GROUP, openId: 'ou_owner', owner: true, role: 'owner' };
const GUEST = { ...GROUP, openId: 'ou_zz', senderName: '周周', owner: false, role: 'guest', workspace: GUEST_DIR };
/** 别的群里的 guest：群没绑目录。 */
const OTHER_GUEST = { ...GUEST, chatId: 'oc_other', customer: 'feishu:group:oc_other', chatName: '别的群', openId: 'ou_x', senderName: '小李' };


let app: cordis.Context;
let specs: Map<string, ToolSpec>;

beforeEach(async () => {
  //M 每个测试一套新的：库是内存里的，当轮授权、见过的人也从空开始。
  METAS.clear();
  app = new cordis.Context();
  await app.plugin(FakeResources);
  await app.plugin(FakeSessions);
  await app.plugin(FakeTools);
  await app.plugin(approvalModule, {});
  await app.plugin(fileTools);
  await app.plugin(execModule);
  media.setup({} as unknown as Feishu, app);
  specs = (app.get('tools') as unknown as FakeTools).specs;
});


/**
 * 照渠道发一条“群里叫了机器人”的话，交回 approval 改过的回话地址和档位。
 * @param address 渠道写的回话地址（会复制一份再发）。
 */
async function inbound(address: Record<string, unknown>): Promise<{ address: Record<string, unknown>; role: string }> {
  const origin = { channel: 'feishu', address: structuredClone(address) };
  const message = { channel: 'feishu', text: '帮我把论文抽成文字', role: address['role'], origin, routing: {}, targetBots: ['周小灵'] };
  await app.serial('channel/mention', message as unknown as protocol.ChannelMessage);
  return { address: origin.address, role: String(message.role) };
}


/**
 * 记一场会话（find、工具 run 都用这个对象）。
 * @param id 会话号。
 * @param address 回话地址。
 * @param extra 别的字段（来源快照、frontTask）。
 */
function addSession(id: string, address: unknown, extra: Record<string, unknown> = {}): { id: string; row: Record<string, unknown> } {
  const row = { id, kind: 'work', bot: '周小灵', channel: 'feishu', address, messages: [], ...extra };
  METAS.set(id, row);
  return { id, row };
}


/**
 * 直接调一个工具。
 * @returns 工具交回的话；抛错时交回 “错：原因”。
 */
async function run(name: string, args: Record<string, unknown>, session: { id: string; row: Record<string, unknown> }): Promise<string> {
  const spec = specs.get(name);
  if (spec === undefined) throw new Error(`没登记 ${name}`);

  try {
    const result = await spec.run(args, session as unknown as Parameters<ToolSpec['run']>[1], new AbortController().signal, 'c1');
    return String(result);
  } catch (error) {
    return `错：${String(error)}`;
  }
}


/** 经 approval/request 审一条命令（不跑）。 */
async function reviewCommand(command: string, cwd: string, session: string, confined?: string): Promise<approvalModule.Verdict | undefined> {
  const input = { command, cwd, session, confined, kind: 'exec', payload: null, ask: false };
  const options = { prefix: 'apr' };
  const asked = await requestEvents.requestEvent(app, 'approval/request', 'approval/result', { action: 'review', input }, options);
  if (asked.why !== undefined) throw new Error(`没人答：${asked.why}`);

  return asked.reply.verdict;
}


describe('群绑目录：群里谁说话都在群的目录里有 builder 权限', () => {
  test('绑了群：guest 升 builder、工作区换成群的目录、地址带授权目录；没绑的群照旧', async () => {
    app.approval.grants.add(GROUP.customer, GROUP.chatName, GRANTED, 'http');

    const bound = await inbound(GUEST);
    expect(bound.role).toBe('builder');
    expect(bound.address['role']).toBe('builder');
    expect(bound.address['workspace']).toBe(GRANTED);
    expect(bound.address['grants']).toEqual({ dirs: [GRANTED] });

    const other = await inbound(OTHER_GUEST);
    expect(other.role).toBe('guest');
    expect(other.address['workspace']).toBe(GUEST_DIR);
    expect(other.address['grants']).toBeUndefined();
  });

  test('外人地址里自己带的 grants 不认：没有库里的授权就删掉', async () => {
    const forged = await inbound({ ...OTHER_GUEST, grants: { dirs: [OUTSIDE] } });
    expect(forged.address['grants']).toBeUndefined();
    expect(forged.role).toBe('guest');
  });

  test('本人在绑了的群里：档位不动，地址带上授权目录', async () => {
    app.approval.grants.add(GROUP.customer, GROUP.chatName, GRANTED, 'http');
    const owner = await inbound(OWNER);
    expect(owner.address['role']).toBe('owner');
    expect(owner.address['workspace']).toBeUndefined();
    expect(owner.address['grants']).toEqual({ dirs: [GRANTED] });
  });
});


describe('查库出错：不挡 bots 认领，外人自带的授权照样删', () => {
  test('库锁住了：后面挂的监听（假 bots）照样收到；外人地址里自带的 grants 删掉，按 guest 走', async () => {
    //M 假 bots：和真的一样不 prepend，排在 approval 后面；收到就记下。
    const claimed: string[] = [];
    app.on('channel/mention', (message) => {
      claimed.push(message.text);
    });

    //M 库锁住了：approval_grants 查不了。
    const resources = app.get('resources') as unknown as FakeResources;
    resources.db.query = () => {
      throw new Error('database is locked');
    };

    const forged = await inbound({ ...GUEST, grants: { dirs: [OUTSIDE] } });
    expect(claimed).toEqual(['帮我把论文抽成文字']);
    expect(forged.address['grants']).toBeUndefined();
    expect(forged.role).toBe('guest');
    expect(forged.address['workspace']).toBe(GUEST_DIR);
  });
});


describe('授权目录往下延伸：子目录放行、出目录拒绝、.. 绕不出去', () => {
  test('外人（confined）命令：授权目录和子目录里程序规则放行；出了目录、.. 跳出去照旧审（审不过直接拒）', async () => {
    const guest = (await inbound({ ...GUEST })).address;
    addSession('w-guest', guest);
    app.approval.grants.add(GROUP.customer, GROUP.chatName, GRANTED, 'http');
    const upgraded = (await inbound(GUEST)).address;
    addSession('w-bound', upgraded);

    const inside = await reviewCommand('echo hi > out.txt', SUB, 'w-bound', GRANTED);
    expect(inside).toEqual({ result: 'pass', by: 'rule', reason: '授权目录' });
    const cdInside = await reviewCommand(`cd "${SUB}" && echo hi > out.txt`, GRANTED, 'w-bound', GRANTED);
    expect(cdInside?.result).toBe('pass');

    //M 出了授权目录：规则直接拒（by: rule），不问模型、不出卡片。
    const outside = await reviewCommand(`echo hi > "${path.join(OUTSIDE, 'x.txt')}"`, GRANTED, 'w-bound', GRANTED);
    expect(outside).toMatchObject({ result: 'reject', by: 'rule' });
    const escape = await reviewCommand(`echo hi > ${path.join('..', 'escape.txt')}`, GRANTED, 'w-bound', GRANTED);
    expect(escape).toMatchObject({ result: 'reject', by: 'rule' });
    const cdUp = await reviewCommand(`cd .. && echo hi > out.txt`, GRANTED, 'w-bound', GRANTED);
    expect(cdUp).toMatchObject({ result: 'reject', by: 'rule' });

    //M 没绑之前的那一轮（地址里没有授权）：照旧交给审核小会话，审不过拒。
    const before = await reviewCommand('echo hi > out.txt', GUEST_DIR, 'w-guest', GUEST_DIR);
    expect(before).toMatchObject({ result: 'reject', by: 'review' });
  });

  test('write、read：授权目录和子目录里能写能读；.. 出去、别的目录被拒', async () => {
    app.approval.grants.add(GROUP.customer, GROUP.chatName, GRANTED, 'http');
    const session = addSession('w-file', (await inbound(GUEST)).address);

    await run('write', { path: 'sub/a.txt', content: 'hello' }, session);
    expect(fs.readFileSync(path.join(SUB, 'a.txt'), 'utf8')).toBe('hello');
    expect(await run('read', { path: path.join(SUB, 'a.txt') }, session)).toContain('hello');

    expect(await run('write', { path: '../escape.txt', content: 'x' }, session)).toContain('工作区');
    expect(await run('write', { path: path.join(OUTSIDE, 'b.txt'), content: 'x' }, session)).toContain('工作区');
    expect(fs.existsSync(path.join(GRANTED, '..', 'escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(OUTSIDE, 'b.txt'))).toBe(false);
  });

  test('exec：外人在群绑的目录里跑，不问模型直接跑', async () => {
    app.approval.grants.add(GROUP.customer, GROUP.chatName, GRANTED, 'http');
    const session = addSession('w-exec', (await inbound(GUEST)).address);
    review.reply = '{"safe": false, "risk": "不该走到审核小会话"}';

    const output = await run('exec', { command: 'echo granted-ran' }, session);
    expect(output).toContain('granted-ran');
    expect(app.approval.list()).toEqual([]);
  });

  test('feishu_send_file：授权目录里的文件过了目录检查（空文件到发送那步才拒）；外面的挡住', async () => {
    app.approval.grants.add(GROUP.customer, GROUP.chatName, GRANTED, 'http');
    const session = addSession('w-send', (await inbound(GUEST)).address);
    fs.writeFileSync(path.join(SUB, 'empty.txt'), '');
    fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'x');

    expect(await run('feishu_send_file', { path: 'sub/empty.txt' }, session)).toContain('空文件');
    expect(await run('feishu_send_file', { path: path.join(OUTSIDE, 'secret.txt') }, session)).toContain('只能发送这一轮工作区里的文件');
  });
});


describe('设授权：只有本人那一轮能设，本人说的当轮就生效', () => {
  test('外人拿不到 dir_grant，执行前也挡；硬调 run 也拒', async () => {
    const session = addSession('w-guest', GUEST);
    const request = { session, model: 'fake/text', messages: [], system: [] as string[], tools: [{ name: 'dir_grant' }, { name: 'read' }] };
    await app.serial('session/before-model', request as unknown as ChatRequest);
    expect(request.tools.map((tool) => tool.name)).toEqual(['read']);

    const gate = { session, call: { type: 'toolCall', id: 'c1', name: 'dir_grant', arguments: { action: 'grant', dir: GRANTED } } };
    await app.serial('session/before-tool', gate as unknown as ToolGate);
    expect((gate as { deny?: string }).deny).toContain('不是用户本人');

    expect(await run('dir_grant', { action: 'grant', dir: GRANTED }, session)).toContain('只有用户本人');
    expect(app.approval.grants.list()).toEqual([]);
  });

  test('本人 once：只这一轮（和这一轮交办的后台）有，不存表；下一轮没有', async () => {
    const front = addSession('f1', { ...OWNER }, { kind: 'front', activeSourceSnapshot: { replyRoundKey: 'r1' } });
    const answer = await run('dir_grant', { action: 'grant', dir: GRANTED, once: true }, front);
    expect(answer).toContain('"once":true');
    expect(app.approval.grants.list()).toEqual([]);
    expect(front.row['address']).toMatchObject({ grants: { dirs: [GRANTED] } });

    //M 这一轮交办的后台：地址里没有，before-model 补上；审命令也认（照库里的会话记录 + 当轮表）。
    const work = addSession('w1', { ...OWNER }, { frontTask: { sourceSnapshot: { replyRoundKey: 'r1' } } });
    const request = { session: work, model: 'fake/text', messages: [], system: [] as string[], tools: [] };
    await app.serial('session/before-model', request as unknown as ChatRequest);
    expect(work.row['address']).toMatchObject({ grants: { dirs: [GRANTED] } });
    expect(request.system.join('\n')).toContain(GRANTED);
    addSession('w1-db', { ...OWNER }, { frontTask: { sourceSnapshot: { replyRoundKey: 'r1' } } });
    expect(await reviewCommand(`cd "${SUB}" && echo hi > out.txt`, BOT_WORKSPACE, 'w1-db')).toEqual({ result: 'pass', by: 'rule', reason: '可信目录' });

    //M 下一轮（别的 replyRoundKey）：没有。
    addSession('w2', { ...OWNER }, { frontTask: { sourceSnapshot: { replyRoundKey: 'r2' } } });
    expect((await reviewCommand(`cd "${SUB}" && echo hi > out.txt`, BOT_WORKSPACE, 'w2'))?.result).toBe('reject');

    //M 这一轮里换成外人说话了：当轮授权不给他。
    addSession('w3', { ...GUEST }, { frontTask: { sourceSnapshot: { replyRoundKey: 'r1' } } });
    expect(app.approval.grants.getTurnDirs(METAS.get('w3') as never)).toEqual([]);
  });

  test('本人按名字授权给群里说过话的人：存表，当轮也生效；他下次私聊进来升 builder', async () => {
    await inbound(GUEST);
    const front = addSession('f1', { ...OWNER }, { kind: 'front', activeSourceSnapshot: { replyRoundKey: 'r1' } });
    const answer = JSON.parse(await run('dir_grant', { action: 'grant', dir: GRANTED, person: '周周' }, front)) as { grant: { subject: string } };
    expect(answer.grant.subject).toBe('feishu:ou_zz');
    expect(front.row['address']).toMatchObject({ grants: { dirs: [GRANTED] } });

    const privateChat = { ...GUEST, chatId: 'oc_p', chatType: 'p2p', customer: 'feishu:ou_zz' };
    const upgraded = await inbound(privateChat);
    expect(upgraded.role).toBe('builder');
    expect(upgraded.address['workspace']).toBe(GRANTED);

    expect(await run('dir_grant', { action: 'grant', dir: GRANTED, person: '没见过的人' }, front)).toContain('最近没见过');
  });

  test('目录写错：相对路径、没有的目录都拒；list、revoke 能用', async () => {
    const front = addSession('f1', { ...OWNER }, { kind: 'front' });
    expect(await run('dir_grant', { action: 'grant', dir: 'outwork/zlt' }, front)).toContain('绝对路径');
    expect(await run('dir_grant', { action: 'grant', dir: path.join(base, 'nope') }, front)).toContain('没有这个目录');

    await run('dir_grant', { action: 'grant', dir: GRANTED }, front);
    const listed = JSON.parse(await run('dir_grant', { action: 'list' }, front)) as { items: { id: number; label: string; group: boolean }[] };
    expect(listed.items[0]).toMatchObject({ label: '周-论文实现', group: true });

    const id = listed.items[0]?.id;
    expect(await run('dir_grant', { action: 'revoke', id }, front)).toContain('"removed"');
    expect(app.approval.grants.list()).toEqual([]);
  });
});


describe('网页 /api/grants', () => {
  test('设、列、撤；目录写错 400；不是本人 403', async () => {
    const server = fastify.default();
    let verified = true;
    app.approval.grants.mountRoutes(server, () => verified);

    const added = await server.inject({ method: 'POST', url: '/api/grants', payload: { action: 'add', subject: 'feishu:ou_zz', label: '周周', dir: GRANTED } });
    expect(added.statusCode).toBe(200);
    const listed = (await server.inject({ method: 'GET', url: '/api/grants' })).json() as { items: { id: number; dir: string }[] };
    expect(listed.items[0]?.dir).toBe(GRANTED);

    const wrong = await server.inject({ method: 'POST', url: '/api/grants', payload: { action: 'add', subject: 'x', dir: 'relative' } });
    expect(wrong.statusCode).toBe(400);

    verified = false;
    const forbidden = await server.inject({ method: 'POST', url: '/api/grants', payload: { action: 'remove', id: listed.items[0]?.id } });
    expect(forbidden.statusCode).toBe(403);

    verified = true;
    const removed = await server.inject({ method: 'POST', url: '/api/grants', payload: { action: 'remove', id: listed.items[0]?.id } });
    expect(removed.statusCode).toBe(200);
    await server.close();
  });
});


describe('入口校验和群里隐去本机路径', () => {
  test('checkGrantDir：绝对路径、目录要在；交回真实路径', () => {
    expect(() => checks.checkGrantDir('relative/dir')).toThrow('绝对路径');
    expect(() => checks.checkGrantDir(path.join(base, 'nope'))).toThrow('没有这个目录');
    expect(checks.checkGrantDir(path.join(SUB, '..'))).toBe(GRANTED);
  });

  test('hideLocalPaths：盘符路径、共享路径换成最后一段；网址、时间不动', () => {
    expect(textModule.hideLocalPaths('文件在 D:\\work\\zlt\\论文.pdf ，看看')).toBe('文件在 论文.pdf ，看看');
    expect(textModule.hideLocalPaths('目录 D:/work/zlt/ 下')).toBe('目录 zlt 下');
    expect(textModule.hideLocalPaths('放 \\\\nas\\share\\a.txt')).toBe('放 a.txt');
    expect(textModule.hideLocalPaths('盘根 D:\\')).toBe('盘根 （本机目录）');
    expect(textModule.hideLocalPaths('见 https://example.com/a，10:30 开会')).toBe('见 https://example.com/a，10:30 开会');
  });
});
