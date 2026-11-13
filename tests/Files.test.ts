/**
 * 文件库（src/capabilities/Files.ts）的离线测试：在临时运行时目录里建机器人文件夹，
 * 写消息文件（原话、分派、结果）、会话的三个文件（每一步之间一行等号、标题变了跟着改名）、记忆变化、技能、机器人设置。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as filesModule from '../src/capabilities/Files.ts';
import * as store from '../src/capabilities/Store.ts';
import type * as dispatchModule from '../src/dispatch/Dispatch.ts';
import * as resourcesModule from '../src/resources/Resources.ts';


/**
 * 建一个临时运行时目录，里面有一个机器人“周小灵”。
 * @returns 资源和文件库。
 */
async function setup(): Promise<{ resources: resourcesModule.Resources; files: filesModule.Files; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-files-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'providers: {}\nbots:\n  - name: 周小灵\n    language: zh\n');
  const resources = await resourcesModule.Resources.load(dir);
  const files = new filesModule.Files(resources);
  await files.ensureBot('周小灵');
  return { resources, files, dir };
}


/**
 * 一条助手消息。
 * @param content 内容块。
 * @returns Pi 的助手消息。
 */
function assistant(content: piAi.AssistantMessage['content']): piAi.AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'magpie',
    model: 'workbuddy/hy3',
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}


bunTest.describe('机器人文件夹', () => {
  bunTest.test('ensureBot 建好目录、记忆概要和“日常”工作区', async () => {
    const { files } = await setup();
    const dirs = files.paths('周小灵');
    bunTest.expect(fs.existsSync(dirs.messageDir)).toBe(true);
    bunTest.expect(fs.readFileSync(path.join(dirs.memoryDir, '索引.md'), 'utf8')).toContain('我是周小灵');
    const workspaces = await files.listWorkspaces('周小灵');
    bunTest.expect(workspaces.map((item) => item.name)).toEqual(['日常']);
    bunTest.expect(workspaces[0]!.dir).toBe(path.join(dirs.workspaceRoot, '日常', 'files'));
    bunTest.expect(fs.existsSync(workspaces[0]!.dir)).toBe(true);
  });

  bunTest.test('saveIncoming 存图、原话里接上 @绝对路径', async () => {
    const { files } = await setup();
    const saved = await files.saveIncoming('周小灵', 'feishu:cli_a', '看看这张图', [{ name: 'x.png', data: new Uint8Array([1, 2, 3]) }]);
    bunTest.expect(path.basename(saved.file)).toMatch(/^feishu_\d{17}\.md$/);
    const image = path.join(path.dirname(saved.file), '1.png');
    //M 文件夹名是消息文件主干后面再接说明。
    bunTest.expect(path.basename(path.dirname(saved.file))).toBe(`${path.basename(saved.file, '.md')}_看看这张图`);
    bunTest.expect(fs.existsSync(image)).toBe(true);
    bunTest.expect(saved.text).toBe(`看看这张图 @${image}`);
    const second = await files.saveIncoming('周小灵', 'feishu:cli_a', '再来', []);
    bunTest.expect(second.file).not.toBe(saved.file);
  });

  bunTest.test('机器人设置读写', async () => {
    const { files } = await setup();
    bunTest.expect(files.readBotSettings('周小灵')).toEqual({});
    await files.writeBotSettings('周小灵', { mergeMs: 1500 });
    bunTest.expect(files.readBotSettings('周小灵')).toEqual({ mergeMs: 1500 });
  });

  bunTest.test('listMemoryChanges 只列 since 之后改过的，带开头一句', async () => {
    const { files } = await setup();
    const since = Date.now() + 1000;
    const dir = files.paths('周小灵').memoryDir;
    fs.writeFileSync(path.join(dir, '偏好.md'), '# 回复风格\n先说结论');
    fs.utimesSync(path.join(dir, '偏好.md'), new Date(since + 5000), new Date(since + 5000));
    const changes = await files.listMemoryChanges('周小灵', since);
    bunTest.expect(changes.map((item) => [path.basename(item.path), item.head])).toEqual([['偏好.md', '回复风格']]);
  });

  bunTest.test('listSkills 读 SKILL.md 开头的 name 和 description', async () => {
    const { files, dir } = await setup();
    fs.mkdirSync(path.join(dir, 'skills', 'feishu-send-file'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'feishu-send-file', 'SKILL.md'), '---\nname: 发飞书文件\ndescription: 把本地文件发到飞书\n---\n# 怎么做\n...');
    fs.mkdirSync(path.join(dir, 'skills', '没开头'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', '没开头', 'SKILL.md'), '# 第一行就是说明\n正文');
    const skills = await files.listSkills();
    bunTest.expect(skills.map((item) => [item.name, item.description])).toEqual([
      ['发飞书文件', '把本地文件发到飞书'],
      ['没开头', '第一行就是说明'],
    ]);
  });
});


bunTest.describe('消息文件和会话文件', () => {
  bunTest.test('消息文件：原话、分派（带会话 @路径）、结果；分派记录 md 和 json', async () => {
    const { files } = await setup();
    const db = new store.Store(':memory:');
    const saved = await files.saveIncoming('周小灵', 'http', '你好', []);
    let message = db.addMessage({ bot: '周小灵', channel: 'http', source: '命令行', address: {}, file: saved.file, text: saved.text });
    await files.writeMessage(message);
    bunTest.expect(fs.readFileSync(saved.file, 'utf8')).toContain('## 原话\n\n你好');
    const session = db.createSession({ bot: '周小灵', workspace: '日常', title: '打招呼', model: 'magpie/workbuddy/hy3', thinking: null });
    const record: dispatchModule.DispatchRecord = {
      messageIds: [message.id],
      startedAt: Date.now(),
      ms: 1200,
      checks: [],
      result: { interrupt: [], workspace: '日常', workspaceDescription: '', session: 'new', title: '打招呼', model: 'magpie/workbuddy/hy3', thinking: '', reason: '新的事', by: 'fallback' },
    };
    db.queueMessages([message.id], session.id, record);
    db.addReply(message.id, { at: Date.now(), session: { id: session.id, title: session.title, file: files.sessionFiles(session).md }, text: '你好呀' });
    message = db.getMessage(message.id)!;
    await files.writeMessage(message, session);
    await files.writeDispatch(message, record, session);
    const text = fs.readFileSync(saved.file, 'utf8');
    bunTest.expect(text).toContain('**新开会话**「打招呼」');
    bunTest.expect(text).toContain(`会话文件：@${files.sessionFiles(session).md}`);
    bunTest.expect(text).toContain('## 结果');
    bunTest.expect(text).toContain('回复：你好呀');
    bunTest.expect(fs.readFileSync(saved.file.replace(/\.md$/, '_分派.md'), 'utf8')).toContain('谁定的：程序兜底');
    bunTest.expect(JSON.parse(fs.readFileSync(saved.file.replace(/\.md$/, '_分派.json'), 'utf8'))).toEqual(record);
  });

  bunTest.test('会话：md 每一步之间一行等号、图片只写路径、长结果放头尾；json 是 OpenAI 格式；压缩版；改标题跟着改名', async () => {
    const { files } = await setup();
    const db = new store.Store(':memory:');
    let session = db.createSession({ bot: '周小灵', workspace: '日常', title: '看图', model: 'magpie/workbuddy/hy3', thinking: null });
    db.beginRun(session.id);
    const long = '字'.repeat(4000);
    const messages: store.StoredMessage[] = [
      { message: { role: 'user', content: '[HTTP · 2026-11-05 10:00:00 · 消息 #1]\n看看', timestamp: Date.now() }, run: 1, messageIds: [1] },
      { message: assistant([{ type: 'thinking', thinking: '先读图' }, { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.png' } }]), run: 1 },
      { message: { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: '图片 a.png' }], isError: false, timestamp: Date.now() }, run: 1, images: ['F:/x/a.png'] },
      { message: assistant([{ type: 'toolCall', id: 'c2', name: 'find', arguments: { text: 'x' } }]), run: 1 },
      { message: { role: 'toolResult', toolCallId: 'c2', toolName: 'find', content: [{ type: 'text', text: long }], isError: false, timestamp: Date.now() }, run: 1 },
      { message: assistant([{ type: 'text', text: '看完了' }]), run: 1 },
    ];
    session = db.updateSession(session.id, { messages, tokens: 110, runs: [{ n: 1, startedAt: Date.now(), steps: 3 }] });
    const view: filesModule.SessionView = { promptFiles: ['F:/p/00_base_dsh.md'], skills: 2, system: '系统提示词', tools: [], model: { vision: true, contextWindow: 192000 }, workDir: 'F:/w', incoming: [] };
    await files.writeSession(session, view);
    const target = files.sessionFiles(session);
    const md = fs.readFileSync(target.md, 'utf8');
    bunTest.expect(md).toContain('| 系统提示词 | @F:/p/00_base_dsh.md + 技能清单（2 个） |');
    bunTest.expect(md).toContain(`\n\n${'='.repeat(68)}\n\n### 第 1 步`);
    bunTest.expect(md).toContain('图片 @F:/x/a.png');
    bunTest.expect(md).toContain('全文在 .json 的 messages[5]');
    bunTest.expect(md).not.toContain(long);
    const json = JSON.parse(fs.readFileSync(target.json, 'utf8')) as { status: string; messages: { role: string; model?: string; content?: string }[] };
    bunTest.expect(json.status).toBe('running');
    bunTest.expect(json.messages[0]).toEqual({ role: 'system', content: '系统提示词' });
    bunTest.expect(json.messages[2]!.model).toBe('magpie/workbuddy/hy3');
    bunTest.expect(json.messages[5]!.content).toBe(long);
    const compact = fs.readFileSync(target.compact, 'utf8');
    bunTest.expect(compact).toContain('【工具】read a.png（成功）');
    bunTest.expect(compact).toContain('【助手】看完了');
    //M 改标题：三个文件跟着改名，旧的不留。
    session = db.updateSession(session.id, { title: '看截图' });
    await files.writeSession(session, view);
    const renamed = files.sessionFiles(session);
    bunTest.expect([renamed.md, renamed.json, renamed.compact].every((file) => fs.existsSync(file))).toBe(true);
    bunTest.expect([target.md, target.json, target.compact].some((file) => fs.existsSync(file))).toBe(false);
  });
});


/**
 * 造一份分派记录（测试里按需补上决策模型、常规模型那两档）。
 * @param messageIds 这一批的消息号。
 * @param by 谁定的。
 * @returns 分派记录。
 */
function recordOf(messageIds: number[], by: dispatchModule.Decision['by']): dispatchModule.DispatchRecord {
  return {
    messageIds,
    startedAt: Date.now(),
    ms: 1200,
    checks: [],
    result: { interrupt: [], workspace: '日常', workspaceDescription: '', session: 'new', title: '打招呼', model: 'magpie/workbuddy/hy3', thinking: '', reason: '新的事', by },
  };
}


bunTest.describe('人看的 md 文案', () => {
  bunTest.test('消息文件：响应bots、飞书单聊、单条分派、全过程用时', async () => {
    const { files } = await setup();
    const db = new store.Store(':memory:');
    const saved = await files.saveIncoming('周小灵', 'feishu:cli_a1b2c3', '你好，帮我看看', []);
    const added = db.addMessage({ bot: '周小灵', channel: 'feishu:cli_a1b2c3', source: 'ou_9f8b7c6d5e4f3a2b1', address: { chatType: 'p2p' }, file: saved.file, text: saved.text });
    const session = db.createSession({ bot: '周小灵', workspace: '日常', title: '打招呼', model: 'magpie/workbuddy/hy3', thinking: null });
    const record = recordOf([added.id], 'fallback');
    db.queueMessages([added.id], session.id, record);
    const message = db.getMessage(added.id)!;
    await files.writeMessage(message, session);
    const text = fs.readFileSync(saved.file, 'utf8');
    bunTest.expect(text).toContain('- 响应bots：周小灵');
    //M 飞书只写应用和单聊，不把 source 里的原始 ID 抄进来。
    bunTest.expect(text).toContain('飞书（应用「周小灵」），单聊');
    bunTest.expect(text).not.toContain('ou_9f8b7c6d5e4f3a2b1');
    bunTest.expect(text).not.toContain('cli_a1b2c3');
    //M 单条分派既没有「单独分派」，也没有合批那一句。
    bunTest.expect(text).not.toContain('单独分派');
    bunTest.expect(text).not.toContain('合成一批分派');
    bunTest.expect(text).toContain('全过程：');
    bunTest.expect(text).toMatch(/\d{2}:\d{2}:\d{2} 开始 本次分派 用了 \d+\.\d 秒/);
    bunTest.expect(text).toMatch(/全过程：[^\n]*\n\n\d{2}:\d{2}:\d{2} 开始 本次分派 用了/);
  });

  bunTest.test('消息文件：合批写「#1、#2 合成一批分派。」', async () => {
    const { files } = await setup();
    const db = new store.Store(':memory:');
    const one = await files.saveIncoming('周小灵', 'http', '第一条', []);
    const two = await files.saveIncoming('周小灵', 'http', '第二条', []);
    const first = db.addMessage({ bot: '周小灵', channel: 'http', source: '命令行', address: {}, file: one.file, text: one.text });
    const second = db.addMessage({ bot: '周小灵', channel: 'http', source: '命令行', address: {}, file: two.file, text: two.text });
    const session = db.createSession({ bot: '周小灵', workspace: '日常', title: '打招呼', model: 'magpie/workbuddy/hy3', thinking: null });
    const record = recordOf([first.id, second.id], 'fallback');
    db.queueMessages([first.id, second.id], session.id, record);
    const message = db.getMessage(first.id)!;
    await files.writeMessage(message, session);
    const text = fs.readFileSync(one.file, 'utf8');
    bunTest.expect(text).toContain(`#${first.id}、#${second.id} 合成一批分派。`);
  });

  bunTest.test('分派记录：决策模型的状态原文、题面、选项概率、打断题，常规模型不重复状态', async () => {
    const { files } = await setup();
    const db = new store.Store(':memory:');
    const saved = await files.saveIncoming('周小灵', 'http', '新消息', []);
    const added = db.addMessage({ bot: '周小灵', channel: 'http', source: '命令行', address: {}, file: saved.file, text: saved.text });
    const session = db.createSession({ bot: '周小灵', workspace: '日常', title: '打招呼', model: 'magpie/workbuddy/hy3', thinking: null });
    /** 决策模型填入的状态（多行，md 里进代码块）。 */
    const state = '机器人：周小灵\n新消息 1 条\n可用模型 2 个';
    /** 常规模型的第一条输入（和状态不同，验证不会被重复写进文件）。 */
    const input = '常规模型看到的现状（另一份）\n第二行';
    const record = recordOf([added.id], 'decision');
    record.decisionModel = {
      model: 'magpie/workbuddy/decider',
      ms: 800,
      question: '这条消息该去哪个会话？',
      options: [
        { label: '新开会话', session: 'new', probability: 0.72 },
        { label: '追加到「旧事」', session: 's1', probability: 0.28 },
      ],
      interruptQuestion: '要不要停下正在跑的会话？',
      interrupt: 0.15,
      used: true,
      why: '新消息和旧会话无关',
      state,
    };
    record.llm = {
      steps: [{ at: Date.now(), ms: 500, effort: 'low', text: '{"session":"new"}', thinking: '', calls: [] }],
      reruns: 0,
      request: { model: 'magpie/workbuddy/hy3', system: '系统提示词', input, tools: [] },
    };
    db.queueMessages([added.id], session.id, record);
    const message = db.getMessage(added.id)!;
    await files.writeDispatch(message, record, session);
    const text = fs.readFileSync(saved.file.replace(/\.md$/, '_分派.md'), 'utf8');
    bunTest.expect(text).toContain('填入的状态（原文）');
    bunTest.expect(text).toContain('```text\n' + state + '\n```');
    bunTest.expect(text).toContain('去向（选择题）：这条消息该去哪个会话？');
    bunTest.expect(text).toContain('- 新开会话：0.72');
    bunTest.expect(text).toContain('- 追加到「旧事」：0.28');
    bunTest.expect(text).toContain('打断（是非题）：要不要停下正在跑的会话？');
    bunTest.expect(text).toContain('判定：新消息和旧会话无关');
    bunTest.expect(text).toContain('常规模型的第一条输入：就是上面决策模型填入的状态。');
    bunTest.expect(text).toContain('（思考强度：low）');
    //M 状态原文只出现一次：常规模型那一段不再抄一遍。
    bunTest.expect(text.split(state).length - 1).toBe(1);
    bunTest.expect(text).not.toContain(input);
  });

  bunTest.test('分派记录：决策模型出错时选项写「没回」，不写 0.00', async () => {
    const { files } = await setup();
    const db = new store.Store(':memory:');
    const saved = await files.saveIncoming('周小灵', 'http', '新消息', []);
    const added = db.addMessage({ bot: '周小灵', channel: 'http', source: '命令行', address: {}, file: saved.file, text: saved.text });
    const session = db.createSession({ bot: '周小灵', workspace: '日常', title: '打招呼', model: 'magpie/workbuddy/hy3', thinking: null });
    const record = recordOf([added.id], 'fallback');
    record.decisionModel = {
      model: 'magpie/workbuddy/decider',
      ms: 800,
      error: '决策模型超时',
      question: '这条消息该去哪个会话？',
      options: [
        { label: '新开会话', session: 'new', probability: 0.72 },
        { label: '追加到「旧事」', session: 's1', probability: 0.28 },
      ],
      used: false,
      why: '没用上决策模型',
      state: '机器人：周小灵\n新消息 1 条',
    };
    db.queueMessages([added.id], session.id, record);
    const message = db.getMessage(added.id)!;
    await files.writeDispatch(message, record, session);
    const text = fs.readFileSync(saved.file.replace(/\.md$/, '_分派.md'), 'utf8');
    bunTest.expect(text).toContain('出错：决策模型超时');
    bunTest.expect(text).toContain('- 新开会话：没回');
    bunTest.expect(text).toContain('- 追加到「旧事」：没回');
    bunTest.expect(text).not.toContain('0.00');
  });

  bunTest.test('分派记录：没有决策模型时写「常规模型的第一条输入（原文）」', async () => {
    const { files } = await setup();
    const db = new store.Store(':memory:');
    const saved = await files.saveIncoming('周小灵', 'http', '新消息', []);
    const added = db.addMessage({ bot: '周小灵', channel: 'http', source: '命令行', address: {}, file: saved.file, text: saved.text });
    const session = db.createSession({ bot: '周小灵', workspace: '日常', title: '打招呼', model: 'magpie/workbuddy/hy3', thinking: null });
    /** 常规模型的第一条输入（多行，md 里进代码块）。 */
    const input = '常规模型看到的现状\n第二行';
    const record = recordOf([added.id], 'llm');
    record.llm = {
      steps: [{ at: Date.now(), ms: 500, effort: 'high', text: '{}', thinking: '', calls: [] }],
      reruns: 0,
      request: { model: 'magpie/workbuddy/hy3', system: '系统提示词', input, tools: [] },
    };
    db.queueMessages([added.id], session.id, record);
    const message = db.getMessage(added.id)!;
    await files.writeDispatch(message, record, session);
    const text = fs.readFileSync(saved.file.replace(/\.md$/, '_分派.md'), 'utf8');
    bunTest.expect(text).toContain('常规模型的第一条输入（原文）');
    bunTest.expect(text).toContain('```text\n' + input + '\n```');
    bunTest.expect(text).not.toContain('常规模型的第一条输入：就是上面决策模型填入的状态。');
    bunTest.expect(text).toContain('（思考强度：high）');
  });

  bunTest.test('会话 md：第一条输入只留原话、用户标题、步骤标题、多行结果围栏、压缩摘要去开头', async () => {
    const { files } = await setup();
    const db = new store.Store(':memory:');
    let session = db.createSession({ bot: '周小灵', workspace: '日常', title: '查文件', model: 'magpie/workbuddy/hy3', thinking: null });
    /** 结果本身带三个反引号，外层围栏得比它更长。 */
    const result = '第一行\n```json\n{"a":1}\n```\n最后一行';
    const messages: store.StoredMessage[] = [
      { message: { role: 'user', content: '# 这个会话\n\n给模型看的说明。\n\n# 记忆概要\n\n我是周小灵。\n\n# 用户的消息\n\n[飞书 · 2026-11-05 10:00:00 · 消息 #1]\n你好，帮我查个东西', timestamp: Date.now() }, run: 1, messageIds: [1] },
      { message: assistant([{ type: 'text', text: '我来查' }, { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.md' } }]), run: 1 },
      { message: { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: result }], isError: false, timestamp: Date.now() }, run: 1 },
      { message: { role: 'user', content: '# 这个会话\n\n（以下是前面对话的摘要）\n前面我们聊过天气，用户说想看文件。', timestamp: Date.now() }, run: 1, summary: true },
    ];
    session = db.updateSession(session.id, { messages, tokens: 110, runs: [{ n: 1, startedAt: Date.now(), steps: 1 }] });
    const view: filesModule.SessionView = { promptFiles: ['F:/p/00_base_dsh.md'], skills: 0, system: '系统提示词', tools: [], workDir: 'F:/w', incoming: [] };
    await files.writeSession(session, view);
    const md = fs.readFileSync(files.sessionFiles(session).md, 'utf8');
    bunTest.expect(md).toContain('【用户 · 飞书 · 10:00:00 · 消息 #1】');
    bunTest.expect(md).toContain('原文在 .json 的 messages[');
    bunTest.expect(md).toContain('你好，帮我查个东西');
    //M 开头那些说明、标题都被去掉，只留原话。
    bunTest.expect(md).not.toContain('# 这个会话');
    bunTest.expect(md).not.toContain('# 记忆概要');
    bunTest.expect(md).not.toContain('给模型看的说明');
    bunTest.expect(md).toContain('### 第 1 步');
    bunTest.expect(md).toContain('````text\n第一行\n```json');
    bunTest.expect(md).toContain('最后一行\n````');
    bunTest.expect(md).toContain('【压缩摘要】\n\n前面我们聊过天气，用户说想看文件。');
    bunTest.expect(md).not.toContain('（以下是前面对话的摘要）');
  });

  bunTest.test('压缩版：用户原话、运行标题，自动感应和程序提醒不写进去', async () => {
    const { files } = await setup();
    const db = new store.Store(':memory:');
    let session = db.createSession({ bot: '周小灵', workspace: '日常', title: '查文件', model: 'magpie/workbuddy/hy3', thinking: null });
    const messages: store.StoredMessage[] = [
      { message: { role: 'user', content: '# 这个会话\n\n# 记忆概要\n\n我是周小灵。\n\n# 用户的消息\n\n[飞书 · 2026-11-05 10:00:00 · 消息 #1]\n帮我看下文件\n（系统）自动感应：memory/偏好.md 改过了', timestamp: Date.now() }, run: 1, messageIds: [1] },
      { message: assistant([{ type: 'text', text: '好的' }]), run: 1 },
      { message: { role: 'user', content: '（程序）这是没有消息号的程序提醒，别写进压缩版', timestamp: Date.now() }, run: 1 },
    ];
    session = db.updateSession(session.id, { messages, tokens: 110, runs: [{ n: 1, startedAt: Date.now(), steps: 1, ending: 'done', endedAt: Date.now() + 1000 }] });
    const view: filesModule.SessionView = { promptFiles: ['F:/p/00_base_dsh.md'], skills: 0, system: '系统提示词', tools: [], workDir: 'F:/w', incoming: [] };
    await files.writeSession(session, view);
    const compact = fs.readFileSync(files.sessionFiles(session).compact, 'utf8');
    bunTest.expect(compact).toContain('【用户 #1】帮我看下文件');
    bunTest.expect(compact).not.toContain('# 这个会话');
    bunTest.expect(compact).not.toContain('[飞书 ·');
    bunTest.expect(compact).not.toContain('自动感应');
    bunTest.expect(compact).toContain('因为消息 #1');
    bunTest.expect(compact).not.toContain('这是没有消息号的程序提醒');
  });
});


/**
 * 建一个名字里带空格的临时运行时目录，里面有一个机器人“周小灵”。
 * 这样消息文件夹的绝对路径含空格，用来测 at() 把 @路径 写成 @"绝对路径"。
 * @returns 文件库和运行时目录。
 */
async function setupWithSpaceInDir(): Promise<{ files: filesModule.Files; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots files '));
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'providers: {}\nbots:\n  - name: 周小灵\n    language: zh\n');
  const resources = await resourcesModule.Resources.load(dir);
  const files = new filesModule.Files(resources);
  await files.ensureBot('周小灵');
  return { files, dir };
}


bunTest.describe('消息文件夹（saveIncoming 离线补测）', () => {
  bunTest.test('消息文件夹名是 <渠道>_<17 位时间>_<说明>，里面的消息文件是 <渠道>_<17 位时间>.md', async () => {
    const { files } = await setup();
    const saved = await files.saveIncoming('周小灵', 'feishu:cli_a', '看看', []);
    //M 父目录就在 message/ 下，名字是渠道前缀 + 17 位时间 + 说明；里面的消息文件不带说明。
    const folder = path.dirname(saved.file);
    bunTest.expect(path.dirname(folder)).toBe(files.paths('周小灵').messageDir);
    bunTest.expect(path.basename(saved.file)).toMatch(/^feishu_\d{17}\.md$/);
    bunTest.expect(path.basename(folder)).toMatch(/^feishu_\d{17}_看看$/);
    bunTest.expect(path.basename(folder)).toBe(`${path.basename(saved.file, '.md')}_看看`);
    bunTest.expect(fs.existsSync(saved.file)).toBe(true);
  });

  bunTest.test('同一毫秒连发两条：文件夹不重复，撞名带 _2 再拼说明，名字都合规', async () => {
    const { files } = await setup();
    //M 固定时间，保证两次 saveIncoming 落在同一毫秒、且说明完全相同（必然撞名）。
    const realNow = Date.now;
    Date.now = () => 1762345678901;
    /** 两条消息。 */
    let first: filesModule.Incoming;
    let second: filesModule.Incoming;
    try {
      first = await files.saveIncoming('周小灵', 'feishu:cli_a', '第一条', []);
      second = await files.saveIncoming('周小灵', 'feishu:cli_a', '第一条', []);
    } finally {
      Date.now = realNow;
    }
    /** 两个消息文件夹。 */
    const folder1 = path.dirname(first.file);
    const folder2 = path.dirname(second.file);
    bunTest.expect(folder1).not.toBe(folder2);
    bunTest.expect(fs.existsSync(folder1)).toBe(true);
    bunTest.expect(fs.existsSync(folder2)).toBe(true);
    bunTest.expect(fs.existsSync(first.file)).toBe(true);
    bunTest.expect(fs.existsSync(second.file)).toBe(true);
    //M 第一条 feishu_<17 位>_第一条；第二条撞名，base 变 feishu_<17 位>_2，再拼说明。
    bunTest.expect(path.basename(folder1)).toMatch(/^feishu_\d{17}_第一条$/);
    bunTest.expect(path.basename(folder2)).toMatch(/^feishu_\d{17}_\d+_第一条$/);
    bunTest.expect(path.basename(first.file)).toMatch(/^feishu_\d{17}\.md$/);
    bunTest.expect(path.basename(second.file)).toMatch(/^feishu_\d{17}_\d+\.md$/);
  });

  bunTest.test('说明最多 20 个字：超长按 words.join 后的字符截断', async () => {
    const { files } = await setup();
    /** 24 个字，只留前 20 个。 */
    const saved = await files.saveIncoming('周小灵', 'http', '一二三四五六七八九十一二三四五六七八九十多出来的字', []);
    /** 消息文件主干。 */
    const base = path.basename(saved.file, '.md');
    bunTest.expect(path.basename(path.dirname(saved.file))).toBe(`${base}_一二三四五六七八九十一二三四五六七八九十`);
    //M 多个词先 join 再按字截：截在连接下划线上时，末尾的下划线不留。
    const cut = await files.saveIncoming('周小灵', 'http', `${'甲'.repeat(19)} 乙`, []);
    bunTest.expect(path.basename(path.dirname(cut.file))).toBe(`${path.basename(cut.file, '.md')}_${'甲'.repeat(19)}`);
  });

  bunTest.test('说明只留文字和数字：标点、空白、@路径过滤，多个词用下划线连接', async () => {
    const { files } = await setup();
    const saved = await files.saveIncoming('周小灵', 'http', '你好，世界！ 123  abc @C:/x/a.png 结束', []);
    bunTest.expect(path.basename(path.dirname(saved.file))).toBe(`${path.basename(saved.file, '.md')}_你好_世界_123_abc_结束`);
  });

  bunTest.test('纯附件：原话为空或只有 @路径时说明写“附件”', async () => {
    const { files } = await setup();
    const empty = await files.saveIncoming('周小灵', 'http', '', [{ name: 'x.png', data: new Uint8Array([1, 2, 3]) }]);
    bunTest.expect(path.basename(path.dirname(empty.file))).toBe(`${path.basename(empty.file, '.md')}_附件`);
    const atOnly = await files.saveIncoming('周小灵', 'http', '@C:/x/a.png', [{ name: 'y.png', data: new Uint8Array([1, 2, 3]) }]);
    bunTest.expect(path.basename(path.dirname(atOnly.file))).toBe(`${path.basename(atOnly.file, '.md')}_附件`);
  });

  bunTest.test('无文字无附件：文件夹名就是 <渠道>_<17 位时间>，不带说明', async () => {
    const { files } = await setup();
    const saved = await files.saveIncoming('周小灵', 'http', '', []);
    /** 文件夹名。 */
    const folder = path.basename(path.dirname(saved.file));
    bunTest.expect(folder).toBe(path.basename(saved.file, '.md'));
    bunTest.expect(folder).toMatch(/^http_\d{17}$/);
  });

  bunTest.test('分派记录 md 和 json 都写在消息文件同一个文件夹', async () => {
    const { files } = await setup();
    const db = new store.Store(':memory:');
    const saved = await files.saveIncoming('周小灵', 'http', '你好', []);
    const added = db.addMessage({ bot: '周小灵', channel: 'http', source: '命令行', address: {}, file: saved.file, text: saved.text });
    const session = db.createSession({ bot: '周小灵', workspace: '日常', title: '打招呼', model: 'magpie/workbuddy/hy3', thinking: null });
    const record: dispatchModule.DispatchRecord = recordOf([added.id], 'fallback');
    db.queueMessages([added.id], session.id, record);
    const message = db.getMessage(added.id)!;
    await files.writeDispatch(message, record, session);
    const folder = path.dirname(message.file);
    const base = `${path.basename(message.file, '.md')}_分派`;
    const md = path.join(folder, `${base}.md`);
    const json = path.join(folder, `${base}.json`);
    bunTest.expect(path.dirname(md)).toBe(folder);
    bunTest.expect(path.dirname(json)).toBe(folder);
    bunTest.expect(fs.existsSync(md)).toBe(true);
    bunTest.expect(fs.existsSync(json)).toBe(true);
  });

  bunTest.test('图片扩展名按内容魔数认：JPEG/PNG/GIF/WEBP', async () => {
    const { files } = await setup();
    //M 名字都不叫图片（第一个还故意叫 image.png），只有认出内容才会存成 1.jpg/2.png/3.gif/4.webp。
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const saved = await files.saveIncoming('周小灵', 'http', '四张图', [
      { name: 'image.png', data: jpeg },
      { name: 'photo.dat', data: png },
      { name: 'photo.dat', data: gif },
      { name: 'photo.dat', data: webp },
    ]);
    const folder = path.dirname(saved.file);
    bunTest.expect(fs.existsSync(path.join(folder, '1.jpg'))).toBe(true);
    bunTest.expect(fs.existsSync(path.join(folder, '2.png'))).toBe(true);
    bunTest.expect(fs.existsSync(path.join(folder, '3.gif'))).toBe(true);
    bunTest.expect(fs.existsSync(path.join(folder, '4.webp'))).toBe(true);
    bunTest.expect(fs.existsSync(path.join(folder, '1.png'))).toBe(false);
  });

  bunTest.test('文档留原名：2_报告.pdf 存成 1_2_报告.pdf', async () => {
    const { files } = await setup();
    const saved = await files.saveIncoming('周小灵', 'http', '看下报告', [{ name: '2_报告.pdf', data: new Uint8Array([1, 2, 3]) }]);
    const folder = path.dirname(saved.file);
    bunTest.expect(fs.existsSync(path.join(folder, '1_2_报告.pdf'))).toBe(true);
    bunTest.expect(fs.readdirSync(folder).some((name) => name.endsWith('2_报告.pdf'))).toBe(true);
  });

  bunTest.test('消息文件夹路径含空格时，原话里的 @路径 用 @"绝对路径" 包住', async () => {
    const { files } = await setupWithSpaceInDir();
    //M safeFolderName 会把附件名里的空格换成下划线，所以让临时目录名带空格，整条绝对路径才有空白。
    const saved = await files.saveIncoming('周小灵', 'http', '看这个文件', [{ name: 'my report.pdf', data: new Uint8Array([1, 2, 3]) }]);
    bunTest.expect(saved.text).toContain('看这个文件');
    bunTest.expect(saved.text).toContain('@"');
    /** 引号里那个附件绝对路径。 */
    const quoted = saved.text.match(/@"([^"]+)"/);
    if (!quoted) {
      throw new Error(`原话里没有带引号的 @路径：${saved.text}`);
    }
    bunTest.expect(fs.existsSync(quoted[1]!)).toBe(true);
  });

  bunTest.test('语音默认名 audio.opus 存成 1.opus', async () => {
    const { files } = await setup();
    const saved = await files.saveIncoming('周小灵', 'http', '听这段', [{ name: 'audio.opus', data: new Uint8Array([1, 2, 3]) }]);
    const folder = path.dirname(saved.file);
    bunTest.expect(fs.existsSync(path.join(folder, '1.opus'))).toBe(true);
  });
});


/**
 * 写一份只有「一条用户消息 + 一条助手消息」的会话，助手消息按需带 effort，返回 md、压缩版全文和 .json 里的消息。
 * @param effort 助手消息这一步的思考强度；不写模拟没有 effort 的旧数据。
 * @returns md、压缩版全文和 .json 的 messages 数组。
 */
async function writeEffortSession(effort?: string): Promise<{ md: string; compact: string; messages: { role: string; effort?: string }[] }> {
  const { files } = await setup();
  const db = new store.Store(':memory:');
  let session = db.createSession({ bot: '周小灵', workspace: '日常', title: '想事情', model: 'magpie/workbuddy/hy3', thinking: null });
  /** 一条用户输入、一条助手回复，助手消息可选带 effort。 */
  const stored: store.StoredMessage[] = [
    { message: { role: 'user', content: '[HTTP · 2026-11-05 10:00:00 · 消息 #1]\n帮我想想', timestamp: Date.now() }, run: 1, messageIds: [1] },
    { message: assistant([{ type: 'text', text: '想好了' }]), run: 1, ...(effort === undefined ? {} : { effort }) },
  ];
  session = db.updateSession(session.id, { messages: stored, tokens: 110, runs: [{ n: 1, startedAt: Date.now(), steps: 1, ending: 'done', endedAt: Date.now() + 1000 }] });
  const view: filesModule.SessionView = { promptFiles: [], skills: 0, system: '系统提示词', tools: [], workDir: 'F:/w', incoming: [] };
  await files.writeSession(session, view);
  const target = files.sessionFiles(session);
  const json = JSON.parse(fs.readFileSync(target.json, 'utf8')) as { messages: { role: string; effort?: string }[] };
  return {
    md: fs.readFileSync(target.md, 'utf8'),
    compact: fs.readFileSync(target.compact, 'utf8'),
    messages: json.messages,
  };
}


bunTest.describe('会话文件里的思考强度', () => {
  bunTest.test('助手消息带 effort：步骤标题、表格模型行、压缩版、.json 都写出「（思考强度：high）」', async () => {
    const { md, compact, messages } = await writeEffortSession('high');
    bunTest.expect(md).toMatch(/### 第 1 步[^\n]*（思考强度：high）/);
    bunTest.expect(md).toMatch(/\| 模型 \|[^\n]*（思考强度：high）/);
    //M 压缩版开头的会话信息行也写思考强度。
    bunTest.expect(compact).toContain('（思考强度：high）');
    /** .json 里那条助手消息。 */
    const reply = messages.find((item) => item.role === 'assistant')!;
    bunTest.expect(reply.effort).toBe('high');
  });

  bunTest.test('旧数据没有 effort：不写思考强度、.json 不带这个字段，文件照常写出不报错', async () => {
    const { md, compact, messages } = await writeEffortSession();
    bunTest.expect(md).toContain('### 第 1 步');
    bunTest.expect(md).not.toContain('（思考强度：');
    bunTest.expect(compact).not.toContain('（思考强度：');
    /** .json 里那条助手消息。 */
    const reply = messages.find((item) => item.role === 'assistant')!;
    bunTest.expect(reply.effort).toBeUndefined();
  });
});
