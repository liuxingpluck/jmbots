/**
 * relay 接多个外部助手的离线测试（2026-11-16，按任务书 20261116_relay多助手和runs编译.md 第 2 步补）。
 * 跑法：bun test ./src7/plugins/relay/Relay.test.ts（test:src7 跑 ./src7/plugins 时一起跑到）。
 * 不起整个服务：用一个假的 ctx（内存库、假机器人、假会话），接口用真的 fastify inject 调；
 * A 的 webhook 是本机临时起的假服务，只记收到几次。
 * 查的是：前缀转给对的助手、回执和回信的署名、inbox 的 helper 筛选、webhook 只推配了的那个、
 * 旧库补 helper 栏、helpers 写错 apply 抛错、chat 主动发挂到对的助手上、带附件的话三处都给 files、
 * 前缀不分大小写且后面可跟标点或汉字；
 * 0.7.16：收件的 owner、sender、chat、chatName（入库、接口、jsonl、webhook、老库补栏；都读飞书写进地址的），
 * 飞书群登记了 relay: model 的会话才有 relay_send，机器人写的 relay 照旧，旧的按聊天种类写法抛错。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import fastify from 'fastify';
import * as relayModule from './index.ts';

/** 临时运行时目录。 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-relay-'));

/** A 的假 webhook：记下收到的每一次。 */
const hooks: Record<string, unknown>[] = [];
const hookServer = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    hooks.push(await request.json() as Record<string, unknown>);
    return Response.json({ ok: true });
  },
});

/** 测完要关的东西：假 webhook、relay 的定时器。 */
const closers: (() => void)[] = [() => { void hookServer.stop(true); }];
afterAll(() => {
  for (const close of closers) close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** 两个助手：A 配了假 webhook，B 不配。 */
const HELPERS = [
  { name: 'A', prefixes: ['a '], webhook_url: `http://127.0.0.1:${String(hookServer.port)}/hook` },
  { name: 'B', prefixes: ['b '] },
];

/** 测试机器人名：普通机器人（不是 relay 机器人），靠前缀转话。 */
const BOT = '测试机器人';

/** 一场假会话。 */
interface FakeSession {
  id: string;
  row: {
    id: string; bot: string; kind: string; parent?: string; state: string; channel?: string; address?: unknown;
    customer?: string; messages: { role: string; content: unknown; timestamp: number }[];
  };
  run: () => Promise<void>;
}

/** 一套假的运行环境。 */
interface World {
  ctx: cordis.Context;
  db: Database;
  app: ReturnType<typeof fastify>;
  sessions: Map<string, FakeSession>;
  /** 每一步填进 request.answer 的话，按先后。 */
  answers: string[];
  /** 用户发一句话：走 bot/receive，再推那场会话一步；回这一步的回答。 */
  say: (text: string, address?: unknown) => Promise<string>;
  /** 测试机器人；改它的 config 再 apply。 */
  bot: { name: string; config: Record<string, unknown> };
  /** relay 登记的工具。 */
  tools: { definition: { name: string; description: string }; run: (args: Record<string, unknown>, session: unknown) => unknown }[];
  /** 新开一场会话（不走 bot/receive）。 */
  open: (options: { bot: string; kind: string; customer?: string }) => FakeSession;
  /** 照骨架给这场会话备一步请求（带 relay_send 和别的工具），挨个问 session/request；回问完的工具名和系统提示词。 */
  ask: (session: FakeSession) => { tools: string[]; system: string[] };
}

/**
 * 搭一套假的 ctx。
 * @param db 用哪个库（旧库测试先在里面建好老表）。
 * @returns 假环境；还没 apply relay。
 */
function world(db = new Database(':memory:')): World {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const sessions = new Map<string, FakeSession>();
  const answers: string[] = [];
  const app = fastify();
  let serial = 0;

  /** 推一步：照骨架的样子发 session/request，插件填了 answer 就记成 assistant。 */
  const step = async (session: FakeSession): Promise<void> => {
    session.row.state = 'running';
    const request: { session: FakeSession; answer?: { content: { type: string; text: string }[] } } = { session };
    for (const handler of handlers.get('session/request') ?? []) handler(request);
    const said = request.answer?.content.map((part) => part.text).join('') ?? '';
    answers.push(said);
    session.row.messages.push({ role: 'assistant', content: request.answer?.content ?? [], timestamp: Date.now() });
    session.row.state = 'done';
    for (const handler of handlers.get('session/change') ?? []) handler(session);
    await Promise.resolve();
  };

  const make = (options: { bot: string; kind: string; customer?: string }): FakeSession => {
    serial += 1;
    const id = `s${String(serial)}`;
    const session: FakeSession = {
      id,
      row: { id, bot: options.bot, kind: options.kind, state: 'done', messages: [], ...(options.customer === undefined ? {} : { customer: options.customer }) },
      run: () => step(session),
    };
    sessions.set(id, session);
    return session;
  };

  const bot = { name: BOT, config: {} as Record<string, unknown>, hand: () => undefined };
  const tools: World['tools'] = [];
  const fake = {
    resources: {
      db,
      root,
      dir: (...parts: string[]): string => {
        const full = path.join(root, ...parts);
        fs.mkdirSync(full, { recursive: true });
        return full;
      },
    },
    tools: { register: (spec: World['tools'][number]) => { tools.push(spec); } },
    sessions: {
      find: (where: { bot: string; kind: string; customer?: string }) => [...sessions.values()]
        .filter((one) => one.row.bot === where.bot && one.row.kind === where.kind && one.row.customer === where.customer)
        .map((one) => one.row),
      create: make,
      open: (id: string) => {
        const found = sessions.get(id);
        if (found === undefined) throw new Error(`没有这场会话：${id}`);
        return found;
      },
    },
    bots: {
      list: () => [bot],
      get: (name: string) => (name === BOT ? bot : undefined),
      route: (session: FakeSession, origin: { channel?: string; address?: unknown }) => {
        if (origin.channel !== undefined) session.row.channel = origin.channel;
        if (origin.address !== undefined) session.row.address = origin.address;
      },
      say: () => undefined,
    },
    on: (name: string, handler: (...args: unknown[]) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    emit: () => undefined,
    effect: (open: () => () => void) => {
      closers.push(open());
    },
    get: (name: string) => (name === 'http' ? { app } : undefined),
    //M 没挂 flow：可选依赖不接。
    inject: () => Promise.resolve(),
  };

  const say = async (text: string, address: unknown = { chatId: 'oc_test', openId: 'ou_test' }): Promise<string> => {
    const event: { bot: typeof bot; message: { text: string; address: unknown }; session?: FakeSession } = {
      bot, message: { text, address },
    };
    for (const handler of handlers.get('bot/receive') ?? []) handler(event);
    const session = event.session;
    if (session === undefined) throw new Error('relay 没接这句话');
    session.row.channel = 'feishu';
    session.row.address = address;
    session.row.messages.push({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() + serial });
    await step(session);
    return answers.at(-1) ?? '';
  };

  const ask = (session: FakeSession): { tools: string[]; system: string[] } => {
    const request = { session, system: [] as string[], tools: [{ name: 'relay_send' }, { name: 'read' }] };
    for (const handler of handlers.get('session/request') ?? []) handler(request);
    return { tools: request.tools.map((tool) => tool.name), system: request.system };
  };

  return { ctx: fake as unknown as cordis.Context, db, app, sessions, answers, say, bot, tools, open: make, ask };
}

/** 头一次 fastify ready / inject 在 130 的共享盘上要加载很久（几十秒），两条走接口的测试放宽超时。 */
const SLOW = 180_000;

/** 等一会儿：webhook 是异步推的，回信送达是 setTimeout 0。 */
const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 挂好 relay 的一套环境。
 * @param helpers 配哪些助手；不写是 HELPERS。
 */
async function ready(helpers: unknown[] = HELPERS, more: Record<string, unknown> = {}): Promise<World> {
  const made = world();
  made.db.exec('CREATE TABLE web_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT, channel TEXT, address TEXT)');
  //M more：别的配置（bots 这类）；写了 relay 就是测试机器人名单项的 relay。
  const { relay, ...config } = more;
  if (relay !== undefined) made.bot.config['relay'] = relay;
  relayModule.apply(made.ctx, { helpers, ...config });
  await made.app.ready();
  closers.push(() => { void made.app.close(); });
  return made;
}

describe('relay 接两个助手', () => {
  test('发 b 你好：回执写 B，只进 B 的收件箱，不推 A 的 webhook；回“收到”署 B', async () => {
    const made = await ready();
    //M 两条测试共用一个假 webhook：只看这个聊天（oc_test）推来的。
    const mine = (): Record<string, unknown>[] => hooks.filter((hook) => hook['chat'] === 'oc_test');

    const receipt = await made.say('b 你好');
    expect(receipt).toBe('已转给 B（#1），等回复。');

    const forB = await made.app.inject({ method: 'GET', url: `/api/relay/inbox?helper=${encodeURIComponent('B')}` });
    expect(forB.statusCode).toBe(200);
    const listB = forB.json() as { items: { id: number; helper: string; text: string }[] };
    expect(listB.items.map((item) => [item.id, item.helper])).toEqual([[1, 'B']]);
    expect(listB.items[0]?.text).toBe('b 你好');

    const forA = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=A' });
    expect((forA.json() as { items: unknown[] }).items).toEqual([]);

    await settle();
    expect(mine()).toEqual([]);

    //M 对照：发给 A 的确实会推到 A 的 webhook（证明上面的“没推”不是假 webhook 坏了）。
    expect(await made.say('a 在吗')).toBe('已转给 A（#2），等回复。');
    await settle();
    expect(mine().length).toBe(1);
    expect(mine()[0]?.['id']).toBe(2);
    expect(mine()[0]?.['text']).toBe('a 在吗');

    //G 给了收件号又写了别的助手：对不上就 400，不悄悄照收件的助手署名。
    const mismatch = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { id: 1, helper: 'A', text: 'x' } });
    expect(mismatch.statusCode).toBe(400);

    //M B 回信：回给用户的话署 B。
    const replied = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { id: 1, text: '收到' } });
    expect(replied.statusCode).toBe(200);
    expect((replied.json() as { item: { helper: string; state: string } }).item).toMatchObject({ helper: 'B', state: 'replied' });
    await settle();
    expect(made.answers.at(-1)).toBe('B：收到');
  }, SLOW);

  test('chat 加 helper: B 主动发：挂在 B 的收件上，不挂到 A 的', async () => {
    const made = await ready();
    const address = { chatId: 'oc_both', openId: 'ou_test' };

    //M 这个聊天只有 A 的收件时：B 主动发要新开一条 B 的收件，不能挂到 A 的 #1 上。
    expect(await made.say('a 第一句', address)).toBe('已转给 A（#1），等回复。');
    made.db.query('INSERT INTO web_messages (bot, channel, address) VALUES (?, ?, ?)').run(BOT, 'feishu', JSON.stringify(address));
    const first = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { chat: 'oc_both', helper: 'B', text: 'B 主动说一句' } });
    expect(first.statusCode).toBe(200);
    const made1 = (first.json() as { item: { id: number; helper: string } }).item;
    expect(made1.helper).toBe('B');
    expect(made1.id).not.toBe(1);
    await settle();
    expect(made.answers.at(-1)).toBe('B：B 主动说一句');

    //M 再发一条 B 的，再主动发：挂到 B 最近的那条，A 的 #1 还是没回。
    const receipt = await made.say('b 第二句', address);
    const bId = Number(/#(\d+)/u.exec(receipt)?.[1]);
    const second = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { chat: 'oc_both', helper: 'B', text: '又来' } });
    expect((second.json() as { item: { id: number; helper: string } }).item).toMatchObject({ id: bId, helper: 'B' });

    const forA = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=A' });
    expect((forA.json() as { items: { id: number; state: string }[] }).items).toEqual([expect.objectContaining({ id: 1, state: 'pending' })]);

    //M helper 写了不认识的名字：400。
    const wrong = await made.app.inject({ method: 'POST', url: '/api/relay/reply', payload: { chat: 'oc_both', helper: 'C', text: 'x' } });
    expect(wrong.statusCode).toBe(400);
  }, SLOW);

  test('带附件的话转出去：inbox.jsonl、GET /api/relay/inbox、webhook 都带 files（相对运行时目录）', async () => {
    const made = await ready();
    const address = { chatId: 'oc_files', openId: 'ou_test' };
    const mine = (): Record<string, unknown>[] => hooks.filter((hook) => hook['chat'] === 'oc_files');

    //M 照渠道的写法：saveFile 存进工作区 inbox/，话里写 @绝对路径，有空白的写 @"路径"。
    const inbox = path.join(root, 'bots', BOT, 'workspace', 'inbox', '2026-11-16');
    fs.mkdirSync(inbox, { recursive: true });
    const image = path.join(inbox, '093005123_a.png');
    const spaced = path.join(inbox, '093005124_b c.pdf');
    fs.writeFileSync(image, 'png');
    fs.writeFileSync(spaced, 'pdf');
    const outside = path.join(os.tmpdir(), 'jm-relay-outside.png');
    const text = `a 看看这两个 @某人\n@${image}\n@"${spaced}"\n@${outside}\n@${image}`;
    const wanted = [
      `bots/${BOT}/workspace/inbox/2026-11-16/093005123_a.png`,
      `bots/${BOT}/workspace/inbox/2026-11-16/093005124_b c.pdf`,
    ];

    expect(await made.say(text, address)).toBe('已转给 A（#1），等回复。');
    await settle();

    //M 收件箱文件最后一行就是这条（几条测试共用一个运行时目录，按顺序跑）。
    const lines = fs.readFileSync(path.join(root, 'integrations', 'relay', BOT, 'inbox.jsonl'), 'utf8').trim().split('\n');
    expect((JSON.parse(lines.at(-1) ?? '{}') as { files?: unknown }).files).toEqual(wanted);

    const listed = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=A' });
    expect((listed.json() as { items: { files: string[] }[] }).items[0]?.files).toEqual(wanted);

    expect(mine().length).toBe(1);
    expect(mine()[0]?.['files']).toEqual(wanted);

    //M 不带附件的：files 是 []。
    expect(await made.say('a 没有附件', address)).toBe('已转给 A（#2），等回复。');
    await settle();
    expect(mine()[1]?.['files']).toEqual([]);
  }, SLOW);

  test('前缀不分大小写，后面可跟空白、标点、汉字；ccc、cctv 不算', async () => {
    //M 照 config.yaml 现在的写法：带空格的 'cc '、'CC '。
    const made = await ready([{ name: 'Claude', prefixes: ['cc ', 'CC '] }]);

    for (const text of ['cc 你好', 'CC你好', 'Cc，你好', 'cc：你好', 'cc,你好']) {
      expect(await made.say(text)).toMatch(/^已转给 Claude（#\d+），等回复。$/u);
    }
    for (const text of ['ccc 你好', 'cctv 好看']) {
      await expect(made.say(text)).rejects.toThrow('relay 没接这句话');
    }
  }, SLOW);

  test('飞书先贴图再写字：开头的附件标记跳过再认前缀', async () => {
    const made = await ready([{ name: 'Claude', prefixes: ['cc ', 'CC '] }]);

    for (const text of ['[图片]cc 你好', '[图片][图片]CC，你好']) {
      expect(await made.say(text)).toMatch(/^已转给 Claude（#\d+），等回复。$/u);
    }
  }, SLOW);

  test('只有附件标记、后面不是前缀的不转', async () => {
    const made = await ready([{ name: 'Claude', prefixes: ['cc ', 'CC '] }]);

    await expect(made.say('[图片]你好')).rejects.toThrow('relay 没接这句话');
  }, SLOW);

  test('引用后面的 cc 要转给对应助手，收件保留完整引用', async () => {
    const made = await ready([...HELPERS, { name: 'Claude', prefixes: ['cc '] }]);

    //M 引用可以跨行，前后也可以带附件标记；只按正文里的前缀选助手。
    const quote = '【回复的消息：【说明】上一条的第一行\n第二行里提到了 b 这个前缀】';
    const texts = [
      `${quote}\ncc 看一下这条回复`,
      `[图片]\n${quote}\n[图片]CC，再看这张图`,
    ];
    for (const text of texts) {
      expect(await made.say(text)).toMatch(/^已转给 Claude（#\d+），等回复。$/u);
    }

    //M 只在识别前缀时跳过引用，真正交给助手的收件仍是用户的完整原话。
    const listed = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=Claude' });
    const items = (listed.json() as { items: { text: string }[] }).items;
    expect(items.map((item) => item.text)).toEqual(texts);
  }, SLOW);

  test('只有引用里含 cc、正文不是前缀开头的不转', async () => {
    const made = await ready([{ name: 'Claude', prefixes: ['cc '] }]);

    //M 引用中的 cc 属于旧消息，普通正文、附件和 cctv 都不能被当成新指令。
    for (const text of [
      '【回复的消息：cc 这是上一条指令】\n这次只是在聊天',
      '【回复的消息：【说明】cc 仍然是引用里的旧指令】\n这次只是在聊天',
      '[图片]【回复的消息：第一行\nCC，上次说过的话】\n[图片]你好',
      '【回复的消息：cc 看一下】\ncctv 好看',
    ]) {
      await expect(made.say(text)).rejects.toThrow('relay 没接这句话');
    }

    const listed = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=Claude' });
    expect((listed.json() as { items: unknown[] }).items).toEqual([]);
  }, SLOW);
});

describe('收件记下谁、在哪说的', () => {
  test('群里本人、私聊别人：入库，inbox 接口、inbox.jsonl、webhook 都带 owner、sender、chat', async () => {
    const made = await ready();
    //M owner、名字、群名都是飞书插件照 people、groups 写进地址的，relay 只读。
    const group = {
      chatId: 'oc_who_g', openId: 'ou_owner', customer: 'feishu:group:oc_who_g', senderName: 'leon', chatName: '测试群', owner: true,
    };
    const p2p = { chatId: 'oc_who_p', openId: 'ou_friend123456', customer: 'feishu:ou_friend123456', owner: false };
    const noName = { chatId: 'oc_who_n', openId: 'ou_friend123456', customer: 'feishu:group:oc_who_n' };

    await made.say('a 群里说的', group);
    await made.say('a 私聊说的', p2p);
    await made.say('a 群名没查到', noName);
    await settle();

    const wanted = [
      { owner: true, sender: 'leon', chat: 'group', chatName: '测试群' },
      { owner: false, sender: '123456', chat: 'p2p', chatName: '' },
      { owner: false, sender: '123456', chat: 'group', chatName: 'oc_who_n' },
    ];
    const listed = await made.app.inject({ method: 'GET', url: '/api/relay/inbox?helper=A' });
    const items = (listed.json() as { items: Record<string, unknown>[] }).items;
    expect(items.map((item) => ({ owner: item['owner'], sender: item['sender'], chat: item['chat'], chatName: item['chatName'] })))
      .toEqual(wanted);

    const lines = fs.readFileSync(path.join(root, 'integrations', 'relay', BOT, 'inbox.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines.at(-3) ?? '{}')).toMatchObject(wanted[0] ?? {});

    const hook = hooks.find((one) => one['chat'] === 'oc_who_g');
    expect(hook).toMatchObject({ owner: true, sender: 'leon', chat_type: 'group', chat_name: '测试群', sender_open_id: 'ou_owner' });
  }, SLOW);
});

describe('飞书群登记的 relay、机器人的 relay', () => {
  const front = { bot: BOT, kind: 'front', customer: 'feishu:group:oc_g' };
  /** 飞书插件给登记了 relay: model 的群写的地址。 */
  const modelGroup = { chatId: 'oc_g', openId: 'ou_x', customer: 'feishu:group:oc_g', relay: 'model' };

  test('群登记了 relay: model：这个群的会话有 relay_send 和提示；没登记的群、私聊没有，调了也拒', async () => {
    const made = await ready([{ name: 'Claude', prefixes: ['cc '] }]);
    expect(made.tools.map((tool) => tool.definition.name)).toEqual(['relay_send']);
    expect(made.tools[0]?.definition.description).toContain('闲聊、打招呼不转');

    const inModel = made.open(front);
    inModel.row.address = modelGroup;
    const asked = made.ask(inModel);
    expect(asked.tools).toEqual(['relay_send', 'read']);
    expect(asked.system.join('\n')).toContain('这是群聊');
    expect(asked.system.join('\n')).toContain('以 cc 开头的话已经直接转给外部助手了');

    //M 群登记的 direct 和没登记一样：只认前缀，不给 relay_send。
    for (const address of [{ ...modelGroup, relay: 'direct' }, { chatId: 'oc_p', openId: 'ou_x', customer: 'feishu:ou_x' }]) {
      const other = made.open(front);
      other.row.address = address;
      expect(made.ask(other)).toEqual({ tools: ['read'], system: [] });
      expect(() => made.tools[0]?.run({ text: '查一下' }, other)).toThrow('不能用 relay_send');
    }

    //M 登记的群里调：登记一条收件，记成群里说的。
    expect(made.tools[0]?.run({ text: '查一下' }, inModel)).toMatch(/^已转给 Claude（#1）/u);
    const listed = await made.app.inject({ method: 'GET', url: '/api/relay/inbox' });
    expect((listed.json() as { items: Record<string, unknown>[] }).items[0]).toMatchObject({ chat: 'group', text: '查一下' });
  }, SLOW);

  test('机器人写 relay: model 照旧哪都有 relay_send；relay: direct 平常话也转，只听的话只认前缀', async () => {
    const model = await ready([{ name: 'Claude', prefixes: ['cc '] }], { relay: 'model' });
    expect(model.ask(model.open(front)).tools).toEqual(['relay_send', 'read']);

    const direct = await ready([{ name: 'Claude', prefixes: ['cc '] }], { relay: 'direct' });
    const group = { chatId: 'oc_g', openId: 'ou_x', customer: 'feishu:group:oc_g' };
    expect(await direct.say('你好', { chatId: 'oc_p', openId: 'ou_x', customer: 'feishu:ou_x' }))
      .toBe('已转给 Claude（#1），等回复。');
    await expect(direct.say('随便聊聊', { ...group, listenOnly: true })).rejects.toThrow('relay 没接这句话');
    expect(await direct.say('cc 看一下', { ...group, listenOnly: true })).toMatch(/^已转给 Claude/u);
  }, SLOW);

  test('名单项 relay 写错（含旧的按聊天种类写法）：apply 抛错', () => {
    for (const relay of ['auto', { group: 'model' }, ['model'], null]) {
      const made = world();
      made.bot.config['relay'] = relay;
      expect(() => relayModule.apply(made.ctx, { helpers: HELPERS })).toThrow('relay 只能写');
    }
  });
});

describe('relay 旧库和配置', () => {
  test('旧库 relay_items 没有 helper 栏：启动补上，旧收件都归第一个助手', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE relay_items (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT NOT NULL,'
      + ' session_id TEXT NOT NULL, channel TEXT NOT NULL, address TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,'
      + " last_msg_at INTEGER, state TEXT NOT NULL DEFAULT 'pending', reminded INTEGER NOT NULL DEFAULT 0, replied_at INTEGER)");
    for (const text of ['旧的一句', '旧的两句']) {
      db.query("INSERT INTO relay_items (bot, session_id, channel, address, text, at) VALUES (?, 's0', 'feishu', 'null', ?, 1)").run(BOT, text);
    }
    //M 群里的旧收件：谁、在哪说的照记的地址补。旧地址没有 owner 这项，算不是本人。
    const groupAddress = JSON.stringify({ chatId: 'oc_old', openId: 'ou_owner_abcdef', customer: 'feishu:group:oc_old' });
    db.query("INSERT INTO relay_items (bot, session_id, channel, address, text, at) VALUES (?, 's0', 'feishu', ?, '群里的', 1)")
      .run(BOT, groupAddress);
    const made = world(db);
    relayModule.apply(made.ctx, { helpers: HELPERS });

    const columns = db.query('PRAGMA table_info(relay_items)').all() as { name: string }[];
    for (const name of ['helper', 'owner', 'sender', 'chat', 'chat_name']) {
      expect(columns.some((column) => column.name === name)).toBe(true);
    }
    const rows = db.query('SELECT helper, owner, sender, chat, chat_name FROM relay_items ORDER BY id').all();
    expect(rows).toEqual([
      { helper: 'A', owner: 0, sender: '', chat: 'p2p', chat_name: '' },
      { helper: 'A', owner: 0, sender: '', chat: 'p2p', chat_name: '' },
      { helper: 'A', owner: 0, sender: 'abcdef', chat: 'group', chat_name: 'oc_old' },
    ]);
  });

  test('已经有 helper 栏的库（0.7.15）：只补谁、在哪说的几栏，helper 不动', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE relay_items (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT NOT NULL,'
      + ' session_id TEXT NOT NULL, channel TEXT NOT NULL, address TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,'
      + " last_msg_at INTEGER, state TEXT NOT NULL DEFAULT 'pending', reminded INTEGER NOT NULL DEFAULT 0, replied_at INTEGER,"
      + " helper TEXT NOT NULL DEFAULT '')");
    db.query("INSERT INTO relay_items (bot, session_id, channel, address, text, at, helper) VALUES (?, 's0', 'feishu', 'null', 'x', 1, 'B')")
      .run(BOT);
    relayModule.apply(world(db).ctx, { helpers: HELPERS });

    expect(db.query('SELECT helper, chat FROM relay_items').all()).toEqual([{ helper: 'B', chat: 'p2p' }]);
  });

  test('helpers 没写、名字重复、前缀有空串：apply 抛错', () => {
    const bad: unknown[] = [
      undefined,
      [],
      [{ name: 'A', prefixes: ['a '] }, { name: 'A', prefixes: ['b '] }],
      [{ name: 'A', prefixes: ['a ', ''] }],
      [{ name: 'A', prefixes: ['  '] }],
    ];
    for (const helpers of bad) {
      const made = world();
      expect(() => relayModule.apply(made.ctx, helpers === undefined ? {} : { helpers })).toThrow();
    }
    expect(() => relayModule.apply(world().ctx, undefined)).toThrow();
  });
});
