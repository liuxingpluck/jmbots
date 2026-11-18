/**
 * 按人分档收工具：owner 全有，builder 只在自己目录里动手，guest 只读（2026-11-17，0.7.16）。
 * 跑法：bun test ./src7/plugins/approval/NotOwner.test.ts
 * 真的 Cordis + 真的 approval、file-tools（含原 base-tools）、exec 插件和飞书的 feishu_send_file 工具（media.setup），
 * resources、bots、sessions、tools 是只够它们挂上的假服务；审核小会话的回答由假 sessions.ask 给。
 * 照骨架发 session/request（工具清单）和 session/before-tool（执行前），再直接调工具的 run，看落在哪个目录。
 * 哪一档只看回话地址里的 role、workspace（飞书插件照 people 写）；没写的渠道（网页）照旧全有。
 * 群里带不带私人记忆看地址的 trusted（飞书插件照 groups 写）；人设 persona.md 任何一轮都带（2026-11-17，0.7.17）。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import type { ToolGate, ToolSpec } from '../../Tools.ts';
import type { AskInput, ChatRequest } from '../../Sessions.ts';
import type { Feishu } from '../feishu/index.ts';
import * as fileTools from '../file-tools/index.ts';
import * as execModule from '../exec/index.ts';
import * as media from '../feishu/Media.ts';
import * as promptModule from '../bots/Prompt.ts';
import * as approvalModule from './index.ts';
import * as rules from './Rules.ts';


/** 临时运行时目录：机器人的工作区、builder 的目录都在里面。 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-roles-'));
const BOT_WORKSPACE = path.join(root, 'bots', '周小灵', 'workspace');
const BUILDER_DIR = path.join(root, 'guests', '小王');
const GUEST_DIR = path.join(root, 'guests', '_guest');
/** 用户的私人记忆（prompt 插件每一步整篇拼进系统提示词的那种）。 */
const MEMORY_TEXT = '用户的私人记忆：下周三去医院复查';
/** 机器人的人设（bots/周小灵/persona.md，任何一轮都带）。 */
const PERSONA_TEXT = '我是周小灵，说话简洁、直接、友好。';
fs.mkdirSync(BOT_WORKSPACE, { recursive: true });
fs.mkdirSync(BUILDER_DIR, { recursive: true });
fs.mkdirSync(GUEST_DIR, { recursive: true });
fs.mkdirSync(path.join(root, 'bots', '周小灵', 'memory'), { recursive: true });
fs.writeFileSync(path.join(root, 'bots', '周小灵', 'memory', '用户.md'), MEMORY_TEXT);
fs.writeFileSync(path.join(root, 'bots', '周小灵', 'persona.md'), PERSONA_TEXT);
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});


/** 审核小会话这次回什么（假 sessions.ask 交回），和它收到的话。 */
const review = { reply: '{"safe": false, "risk": "出了目录"}', asked: [] as string[] };


/** 假的 resources：approval 建表、exec 读 paths、文件工具算路径用到的几项。 */
class FakeResources extends cordis.Service {
  db = new Database(':memory:');
  root = root;
  raw = {};
  config = { providers: {} };
  constructor(ctx: cordis.Context) {
    super(ctx, 'resources');
  }
  /** prompt 插件读提示词、记忆目录：照 Resources.dir，没有就建。 */
  dir(...parts: string[]): string {
    const full = path.join(root, ...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }
  /** base-tools 问模型收不收图：都不收。 */
  getModel(): { input: string[] } {
    return { input: ['text'] };
  }
}


/** 假的 bots：一个机器人周小灵，工作区在临时目录里。 */
class FakeBots extends cordis.Service {
  constructor(ctx: cordis.Context) {
    super(ctx, 'bots');
  }
  list(): unknown[] {
    return [{ name: '周小灵' }];
  }
  get(name: string): unknown {
    return name === '周小灵' ? { name, workspace: BOT_WORKSPACE, config: {} } : undefined;
  }
}


/** 假的 sessions：什么都找不到；审核小会话照 review.reply 回。 */
class FakeSessions extends cordis.Service {
  constructor(ctx: cordis.Context) {
    super(ctx, 'sessions');
  }
  find(): unknown[] {
    return [];
  }
  ask(input: AskInput): Promise<{ ok: boolean; reply: string }> {
    review.asked.push(input.text);
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


/** 一步请求里原本的工具：动手的、只读的都有。 */
const TOOLS = ['exec', 'write', 'edit', 'feishu_send_file', 'reply', 'memory', 'read', 'find', 'web_search', 'hand_session', 'relay_send', 'list_sessions', 'wechat_history'];

/** 三档的回话地址（飞书照 people 写的样子）；群是登记了 trusted: true 的（飞书照 groups 写）。 */
const OWNER = { appId: 'cli_x', chatId: 'oc_g', openId: 'ou_owner', chatType: 'group', customer: 'feishu:group:oc_g', owner: true, role: 'owner', trusted: true };
const BUILDER = { ...OWNER, openId: 'ou_builder', owner: false, role: 'builder', workspace: BUILDER_DIR };
const GUEST = { ...OWNER, openId: 'ou_friend', owner: false, role: 'guest', workspace: GUEST_DIR };


/** 挂好的 Cordis 和登记的工具。 */
async function ready(): Promise<{ app: cordis.Context; specs: Map<string, ToolSpec> }> {
  const app = new cordis.Context();
  await app.plugin(FakeResources);
  await app.plugin(FakeBots);
  await app.plugin(FakeSessions);
  await app.plugin(FakeTools);
  await app.plugin(approvalModule, {});
  await app.plugin(fileTools);
  await app.plugin(execModule);

  //M 系统提示词 11-17 并进 bots（bots/Prompt.ts）：这里不挂整个 bots，只把 Prompt 挂成一个小插件（要 resources、bots，和 bots 里一样）。
  const promptPlugin = {
    name: 'prompt-test',
    inject: ['resources', 'bots'],
    apply: (ctx: cordis.Context): void => {
      new promptModule.Prompt(ctx);
    },
  };
  await app.plugin(promptPlugin);
  media.setup({} as unknown as Feishu, app);
  return { app, specs: (app.get('tools') as unknown as FakeTools).specs };
}


/** 一场飞书会话，回话地址是 address。 */
function getSession(address: unknown): { id: string; row: Record<string, unknown> } {
  return { id: 's1', row: { id: 's1', kind: 'work', bot: '周小灵', channel: 'feishu', address, messages: [] } };
}


/**
 * 照骨架问一步：这一步拿到哪些工具、执行 call 时让不让。
 * @param app 挂好的 Cordis。
 * @param address 会话现在记的回话地址。
 * @param call 要执行的工具名。
 * @param args 这次调用的参数；不写是空的。
 */
async function ask(
  app: cordis.Context,
  address: unknown,
  call = 'exec',
  args: Record<string, unknown> = {},
): Promise<{ tools: string[]; system: string[]; denied?: string }> {
  const session = getSession(address);
  const request = { session, model: 'fake/text', messages: [], system: [] as string[], tools: TOOLS.map((name) => ({ name })) };
  await app.serial('session/request', request as unknown as ChatRequest);

  const gate = { session, call: { type: 'toolCall', id: 'c1', name: call, arguments: args } };
  await app.serial('session/before-tool', gate as unknown as ToolGate);
  return { tools: request.tools.map((tool) => tool.name), system: request.system, denied: (gate as { deny?: string }).deny };
}


/**
 * 直接调一个工具。
 * @param specs 登记的工具。
 * @param name 工具名。
 * @param args 参数。
 * @param address 会话的回话地址。
 * @returns 工具交回的话；抛错时交回 “错：原因”。
 */
async function run(specs: Map<string, ToolSpec>, name: string, args: Record<string, unknown>, address: unknown): Promise<string> {
  const session = getSession(address) as unknown as Parameters<ToolSpec['run']>[1];
  try {
    const result = await specs.get(name)!.run(args, session, new AbortController().signal, 'call-1');
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (error) {
    return `错：${String(error)}`;
  }
}


describe('owner：什么都能用', () => {
  test('本人在群里、私聊：工具全有，exec 不拦；写文件落在机器人的工作区', async () => {
    const { app, specs } = await ready();
    for (const address of [OWNER, { ...OWNER, chatId: 'oc_p', chatType: 'p2p', customer: 'feishu:ou_owner', trusted: undefined }]) {
      const result = await ask(app, address);
      expect(result.tools).toEqual(TOOLS);
      expect(result.denied).toBeUndefined();
      expect(result.system).toContain(MEMORY_TEXT);
    }

    await run(specs, 'write', { path: 'owner.txt', content: 'x' }, OWNER);
    expect(fs.existsSync(path.join(BOT_WORKSPACE, 'owner.txt'))).toBe(true);
  });

  test('没写 role 的渠道（网页）照旧全有', async () => {
    const { app } = await ready();
    const result = await ask(app, { messageId: 'm1' });
    expect(result.tools).toEqual(TOOLS);
    expect(result.denied).toBeUndefined();
  });
});


describe('builder：只在自己的目录里动手', () => {
  test('工具只多 exec、write、edit、feishu_send_file；memory、reply 不给，执行前也拦', async () => {
    const { app } = await ready();
    const result = await ask(app, BUILDER, 'memory');
    expect(result.tools).toEqual(['exec', 'write', 'edit', 'feishu_send_file', 'read', 'find', 'web_search', 'hand_session', 'relay_send']);
    expect(result.system.join('\n')).toContain(BUILDER_DIR);
    expect(result.denied).toContain('自己的目录');
    expect((await ask(app, BUILDER, 'exec')).denied).toBeUndefined();
  });

  test('write、read 落在他的目录；出了目录被拒', async () => {
    const { specs } = await ready();
    await run(specs, 'write', { path: 'src/a.txt', content: 'hello' }, BUILDER);
    expect(fs.readFileSync(path.join(BUILDER_DIR, 'src', 'a.txt'), 'utf8')).toBe('hello');
    expect(await run(specs, 'read', { path: 'src/a.txt' }, BUILDER)).toContain('hello');

    expect(await run(specs, 'write', { path: '../escape.txt', content: 'x' }, BUILDER)).toContain('工作区');
    expect(await run(specs, 'write', { path: path.join(BOT_WORKSPACE, 'b.txt'), content: 'x' }, BUILDER)).toContain('工作区');
    expect(fs.existsSync(path.join(root, 'guests', 'escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(BOT_WORKSPACE, 'b.txt'))).toBe(false);
  });

  test('exec：在他的目录里跑，审核带上目录约束；审过了就跑', async () => {
    const { specs } = await ready();
    review.reply = '{"safe": true, "what": "打印一句"}';
    review.asked.length = 0;

    const output = await run(specs, 'exec', { command: 'echo builder-ran' }, BUILDER);
    expect(output).toContain('builder-ran');
    expect(review.asked[0]).toContain(`执行目录：${BUILDER_DIR}`);
    expect(review.asked[0]).toContain(`只能在 ${BUILDER_DIR} 里动`);
  });

  test('exec：审不过直接拒，不登记待确认（免得他自己说“同意 N”）；项目检查也不直接放行', async () => {
    const { app, specs } = await ready();
    review.reply = '{"safe": false, "risk": "出了目录"}';

    for (const command of ['cat ../../other.txt', 'bun run test:src7']) {
      const output = await run(specs, 'exec', { command }, BUILDER);
      expect(output).toContain('未执行');
      expect(output).toContain(BUILDER_DIR);
    }
    expect(app.approval.list()).toEqual([]);
  });

  test('feishu_send_file：只能发他目录里的', async () => {
    const { specs } = await ready();
    fs.writeFileSync(path.join(BOT_WORKSPACE, 'secret.txt'), 'x');
    fs.writeFileSync(path.join(BUILDER_DIR, 'empty.txt'), '');

    //M 机器人工作区里的：挡在目录检查。
    const outside = await run(specs, 'feishu_send_file', { path: path.join(BOT_WORKSPACE, 'secret.txt') }, BUILDER);
    expect(outside).toContain('只能发送这一轮工作区里的文件');

    //M 他目录里的：过了目录检查，到发送那步（空文件飞书不收，不用真发）。
    const inside = await run(specs, 'feishu_send_file', { path: 'empty.txt' }, BUILDER);
    expect(inside).toContain('空文件');
  });
});


describe('guest：只读', () => {
  test('群里朋友、没登记的：拿不到动手的，执行 exec 也被拦', async () => {
    const { app } = await ready();
    for (const address of [GUEST, { ...OWNER, owner: false, role: undefined }]) {
      const result = await ask(app, address);
      expect(result.tools).toEqual(['read', 'find', 'web_search', 'hand_session', 'relay_send']);
      expect(result.system.join('\n')).toContain('不是用户本人');
      expect(result.denied).toContain('不是用户本人');
    }
  });

  test('同一场会话里换了人：工具、工作区都跟着最后说话的人走', async () => {
    const { app, specs } = await ready();
    expect((await ask(app, BUILDER)).denied).toBeUndefined();
    expect((await ask(app, GUEST)).denied).toContain('不是用户本人');

    await run(specs, 'write', { path: 'switch.txt', content: 'b' }, BUILDER);
    await run(specs, 'write', { path: 'switch.txt', content: 'o' }, OWNER);
    expect(fs.readFileSync(path.join(BUILDER_DIR, 'switch.txt'), 'utf8')).toBe('b');
    expect(fs.readFileSync(path.join(BOT_WORKSPACE, 'switch.txt'), 'utf8')).toBe('o');
  });

  //M 第 3 条：list_sessions（列干活的会话）、wechat_history（用户微信原文）对非本人拿掉。
  test('guest、builder 调 list_sessions、wechat_history 拿不到，执行前也拦', async () => {
    const { app } = await ready();
    for (const address of [GUEST, BUILDER]) {
      for (const call of ['list_sessions', 'wechat_history']) {
        const result = await ask(app, address, call);
        expect(result.tools).not.toContain(call);
        expect(result.denied).toBeDefined();
      }
    }
  });

  //M 11-17：外人能用 workspace 看自己的工作区，只能 list、get；建、改名、归档执行前拦下。本人都能用。
  test('guest、builder 用 workspace 只能 list、get；create、rename、archive 执行前拦，理由写清；本人不拦', async () => {
    const { app } = await ready();
    expect(rules.toolsFor('guest')?.has('workspace')).toBe(true);
    expect(rules.toolsFor('builder')?.has('workspace')).toBe(true);

    for (const address of [GUEST, BUILDER]) {
      for (const action of ['list', 'get']) {
        expect((await ask(app, address, 'workspace', { action })).denied).toBeUndefined();
      }
      for (const action of ['create', 'rename', 'archive']) {
        const denied = (await ask(app, address, 'workspace', { action })).denied;
        expect(denied).toContain('workspace 只能 list、get');
        expect(denied).toContain(`${action} 只有本人能用`);
      }
    }

    expect((await ask(app, OWNER, 'workspace', { action: 'create' })).denied).toBeUndefined();
  });

  //M 第 4 条：prompt 插件每一步拼的记忆目录，非本人那一轮不拼。
  test('guest、builder 那一轮提示词里没有用户记忆；本人有', async () => {
    const { app } = await ready();
    for (const address of [GUEST, BUILDER, { ...OWNER, owner: false, role: undefined }]) {
      const result = await ask(app, address);
      expect(result.system.join('\n')).not.toContain(MEMORY_TEXT);
    }
    expect((await ask(app, OWNER)).system).toContain(MEMORY_TEXT);
  });

  //M 第 1 条：guest 读的是他自己的目录，机器人工作区里的文件读不到。
  test('guest 的 read 落在他的目录；机器人工作区里的读不到', async () => {
    const { specs } = await ready();
    fs.writeFileSync(path.join(BOT_WORKSPACE, 'inbox.txt'), '用户的收件');
    fs.writeFileSync(path.join(GUEST_DIR, 'hello.txt'), 'guest-hello');
    expect(await run(specs, 'read', { path: 'hello.txt' }, GUEST)).toContain('guest-hello');
    expect(await run(specs, 'read', { path: 'inbox.txt' }, GUEST)).not.toContain('用户的收件');
    expect(await run(specs, 'read', { path: path.join(BOT_WORKSPACE, 'inbox.txt') }, GUEST)).toContain('工作区');
  });
});


describe('群聊记忆和人设（0.7.17）', () => {
  //M 第 1、2 条：不受信的群（没登记、trusted: false、只认得出客户号是群的）本人说话也不带记忆；trusted 群里带。
  test('本人在不受信的群里没有记忆，在 trusted 群里有', async () => {
    const { app } = await ready();
    const untrusted = [
      { ...OWNER, trusted: false },
      { ...OWNER, trusted: undefined },
      { appId: 'cli_x', chatId: 'oc_c', openId: 'ou_owner', chatType: '', customer: 'feishu:group:oc_c', owner: true, role: 'owner' },
    ];
    for (const address of untrusted) {
      const result = await ask(app, address);
      expect(result.system.join('\n')).not.toContain(MEMORY_TEXT);
      expect(result.tools).toEqual(TOOLS);
    }
    expect((await ask(app, OWNER)).system).toContain(MEMORY_TEXT);
  });

  //M 第 3 条：人设任何一轮都带，在记忆前面。
  test('persona.md 在 guest 那一轮、不受信的群里也带；本人那一轮排在记忆前面', async () => {
    const { app } = await ready();
    for (const address of [GUEST, BUILDER, { ...OWNER, trusted: false }]) {
      expect((await ask(app, address)).system).toContain(PERSONA_TEXT);
    }
    const owner = (await ask(app, OWNER)).system;
    expect(owner.indexOf(PERSONA_TEXT)).toBeGreaterThan(-1);
    expect(owner.indexOf(PERSONA_TEXT)).toBeLessThan(owner.indexOf(MEMORY_TEXT));
  });
});
