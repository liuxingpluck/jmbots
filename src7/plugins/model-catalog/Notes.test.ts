/**
 * 模型介绍和评价（Notes.ts，11-18 由 model-notes 并进 model-catalog）：解析 MD、按会话打分、同人同会话改分、按会话算平均分、入口校验拒绝、拼提示词。
 * 真实 Cordis + Fastify inject，数据放临时目录，不碰运行时目录。
 * 跑法：bun test ./src7/plugins/model-catalog
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import fastify, { type FastifyInstance } from 'fastify';
import * as checks from '../../utils/Checks.ts';
import * as textModule from '../../utils/Text.ts';
import * as notesModule from './Notes.ts';


//M 每个用例收拾自己的 ctx、HTTP 实例和临时目录。
const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


//M 假会话表：只提供 open(id) 返回 { row: { id, model, thinking } }。
class FakeSessions extends cordis.Service {
  constructor(
    ctx: cordis.Context,
    private readonly rows: Record<string, { model: string; thinking?: string }>,
  ) {
    super(ctx, 'sessions');
  }

  open(id: string): { row: { id: string; model: string; thinking: string } } {
    const found = this.rows[id];
    if (found === undefined) {
      throw new Error(`没有这场会话：${id}`);
    }
    return { row: { id, model: found.model, thinking: found.thinking ?? '' } };
  }
}


/** 一行评价的样子：时间是 年-月-日 时:分 时区缩写。 */
const NEW_LINE = /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Z][A-Za-z0-9+-]* · /u;


/**
 * 建好 ModelNotes 和两个接口。
 * @param files 先放进 models/ 的文件：文件名 → 内容。
 * @param sessions 假会话表：会话号 → { model, thinking? }。
 * @returns models 目录、Fastify 实例、ModelNotes 和假会话记录（可在测试里改模型测换模型）。
 */
async function world(
  files: Record<string, string>,
  sessions: Record<string, { model: string; thinking?: string }> = {},
): Promise<{ dir: string; app: FastifyInstance; notes: notesModule.ModelNotes; sessions: Record<string, { model: string; thinking?: string }> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-notes-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'models');
  fs.mkdirSync(dir);
  textModule.eachEntry(files, (name, text) => {
    fs.writeFileSync(path.join(dir, name), text, 'utf8');
  });

  const ctx = new cordis.Context();
  const app = fastify();
  closers.push(() => app.close());
  closers.push(() => ctx.fiber.dispose());
  await ctx.plugin(FakeSessions, sessions);

  //M 入口查配置（相对运行时目录），再建 ModelNotes、登记两个接口：和 model-catalog 的 apply 一样。
  const settings = notesModule.readNotesSettings(root, {});
  const notes = new notesModule.ModelNotes(ctx, settings);
  notes.routes(app);
  return { dir, app, notes, sessions };
}


describe('model-catalog 的模型介绍和评价', () => {
  //M 介绍原样读；新旧评价都能解析，同场会话多人打分只算一场，平均分按场算；坏行和下一个标题之后的不算。
  test('解析：新旧格式、同场多人去重算场数与平均分', async () => {
    const text = [
      '# magpie/workbuddy/deepseek-v4.1-flash',
      '',
      '便宜、快，适合跑命令、查进程。',
      '第二行介绍。',
      '',
      '## 擅长',
      '简单的活。',
      '',
      '## 评价',
      '- 2026-11-17 10:20 EST · Claude · 4/5 · 任务：插件盘点 · 分析细，但慢',
      '- 2026-11-17 13:50 EST · 用户 · 4/5 · 会话 202611171350001（high） · 稳',
      '- 2026-11-17 13:55 EST · Claude · 2/5 · 会话 202611171350001（high）',
      '- 这一行写乱了',
      '- 2026-11-17 11:00 EST · 用户 · 7/5 · 会话 202611171100001 · 超分跳过',
      '- 2026-11-17 12:00 EST · Codex · 5/5 · 会话 202611171200001 ·',
      '',
      '## 别的',
      '- 2026-11-17 13:00 EST · Grok · 1/5 · 会话 202611171300001 · 不在评价节',
    ].join('\r\n');
    const { notes } = await world({
      'magpie__workbuddy__deepseek-v4.1-flash.md': text,
      'grok.md': '# grok\n\n（待补介绍）\n',
      'readme.txt': '不是 md',
    });

    const list = notes.getList();
    expect(list.map((item) => item.model)).toEqual(['grok', 'magpie/workbuddy/deepseek-v4.1-flash']);
    expect(list[0]).toEqual({ model: 'grok', intro: '（待补介绍）', ratings: [], sessionCount: 0, average: 0 });

    const deepseek = list[1];
    expect(deepseek?.intro).toBe('便宜、快，适合跑命令、查进程。\n第二行介绍。\n\n## 擅长\n简单的活。');
    expect(deepseek?.ratings).toEqual([
      { at: '2026-11-17 10:20 EST', by: 'Claude', score: 4, session: '', thinking: '', task: '插件盘点', note: '分析细，但慢' },
      { at: '2026-11-17 13:50 EST', by: '用户', score: 4, session: '202611171350001', thinking: 'high', task: '', note: '稳' },
      { at: '2026-11-17 13:55 EST', by: 'Claude', score: 2, session: '202611171350001', thinking: 'high', task: '', note: '' },
      { at: '2026-11-17 12:00 EST', by: 'Codex', score: 5, session: '202611171200001', thinking: '', task: '', note: '' },
    ]);
    //M 旧行(4) + 会话1350001均值(3) + 会话1200001(5) = 12 / 3 = 4。
    expect(deepseek?.sessionCount).toBe(3);
    expect(deepseek?.average).toBe(4);
  });

  //M 按会话查出模型与思考档；插在评价节末尾不动后面的标题，保留 \r\n；无评价节补上，无文件新建。
  test('打分：按会话查模型与思考档，追加与新建 MD', async () => {
    const text = ['# gpt-6-astra', '', '写代码。', '', '## 评价', '- 2026-11-17 10:20 EST · Claude · 3/5 · 会话 s0 · 旧评', '', '## 备注', '别动我', ''].join('\r\n');
    const { dir, notes } = await world(
      { 'gpt-6-astra.md': text, 'grok.md': '# grok\n\n快。\n\n' },
      {
        s1: { model: 'gpt-6-astra', thinking: 'xhigh' },
        s2: { model: 'grok', thinking: '' },
        s3: { model: 'magpie/new-model', thinking: 'medium' },
      },
    );

    const note = notes.rate({ session: 's1', by: 'Grok', score: 5, note: '快' });
    const lines = fs.readFileSync(path.join(dir, 'gpt-6-astra.md'), 'utf8').split('\r\n');
    expect(lines.slice(0, 6)).toEqual(['# gpt-6-astra', '', '写代码。', '', '## 评价', '- 2026-11-17 10:20 EST · Claude · 3/5 · 会话 s0 · 旧评']);
    expect(lines[6]).toMatch(NEW_LINE);
    expect(lines[6]?.endsWith(' · Grok · 5/5 · 会话 s1（xhigh） · 快')).toBe(true);
    expect(lines.slice(7)).toEqual(['', '## 备注', '别动我', '']);
    expect(note.sessionCount).toBe(2);
    expect(note.average).toBe(4);

    notes.rate({ session: 's2', by: '用户', score: 2, note: '' });
    const grokLines = fs.readFileSync(path.join(dir, 'grok.md'), 'utf8').split('\n');
    expect(grokLines.slice(0, 5)).toEqual(['# grok', '', '快。', '', '## 评价']);
    expect(grokLines[5]).toMatch(NEW_LINE);
    expect(grokLines[5]?.endsWith(' · 用户 · 2/5 · 会话 s2')).toBe(true);

    const created = notes.rate({ session: 's3', by: 'Codex', score: 4, note: '还行' });
    const file = path.join(dir, 'magpie__new-model.md');
    expect(fs.readFileSync(file, 'utf8').startsWith('# magpie/new-model\n\n（待补介绍）\n\n## 评价\n- ')).toBe(true);
    expect(created).toMatchObject({ model: 'magpie/new-model', intro: '（待补介绍）', sessionCount: 1, average: 4 });
  });

  //M 同一个人给同一场会话再打一次算改分不算两次；会话换过模型也会清掉旧模型里的旧记录。
  test('改分：同人同会话覆盖旧分，换模型自动迁移', async () => {
    const { dir, notes, sessions } = await world(
      {},
      { s100: { model: 'codex/gpt-6-astra', thinking: 'high' } },
    );

    const first = notes.rate({ session: 's100', by: '用户', score: 2, note: '跑偏了' });
    expect(first.sessionCount).toBe(1);
    expect(first.average).toBe(2);

    const updated = notes.rate({ session: 's100', by: '用户', score: 5, note: '后来修好了' });
    expect(updated.sessionCount).toBe(1);
    expect(updated.average).toBe(5);
    expect(updated.ratings).toHaveLength(1);
    expect(updated.ratings[0]).toMatchObject({ by: '用户', score: 5, session: 's100', thinking: 'high', note: '后来修好了' });

    const mdLines = fs.readFileSync(path.join(dir, 'codex__gpt-6-astra.md'), 'utf8').split('\n').filter((l) => l.startsWith('- '));
    expect(mdLines).toHaveLength(1);

    //M 换另一个人评同一场会话：场数 N 仍为 1，均分 (5 + 3) / 2 = 4。
    const twoRaters = notes.rate({ session: 's100', by: 'Claude', score: 3, note: '代码稳' });
    expect(twoRaters.sessionCount).toBe(1);
    expect(twoRaters.average).toBe(4);
    expect(twoRaters.ratings).toHaveLength(2);

    //M 若这场会话改用新模型且用户改分：旧模型里用户的评价删掉，只留 Claude 的；新模型收用户的新分。
    sessions['s100'] = { model: 'gemini-4-carbon', thinking: 'medium' };
    const moved = notes.rate({ session: 's100', by: '用户', score: 4, note: '换模型后行' });
    expect(moved.model).toBe('gemini-4-carbon');
    expect(moved.sessionCount).toBe(1);
    expect(moved.average).toBe(4);

    const oldAfter = notes.getList().find((item) => item.model === 'codex/gpt-6-astra');
    expect(oldAfter?.ratings.map((r) => r.by)).toEqual(['Claude']);
    expect(oldAfter?.average).toBe(3);
  });

  //M 入口校验：session 合法字符；分数 1..5 整数；不能换行；by 非空且不含 ·；modelId 校验；notes 配置写错抛错。
  test('校验：checkRating、checkModelId 与 notes 配置拒绝不对的输入', () => {
    const good = { session: '202611171350001', by: 'Claude', score: 4, note: '细' };
    expect(checks.checkRating({ ...good, by: ' Claude ', note: undefined })).toEqual({
      session: '202611171350001', by: 'Claude', score: 4, note: '',
    });

    const bad: [unknown, string][] = [
      [null, '评价'],
      [[], '评价'],
      [{ ...good, session: '' }, 'session'],
      [{ ...good, session: '../etc' }, 'session'],
      [{ ...good, session: 'a b' }, 'session'],
      [{ ...good, session: 123 }, 'session'],
      [{ ...good, score: 0 }, 'score'],
      [{ ...good, score: 6 }, 'score'],
      [{ ...good, score: 4.5 }, 'score'],
      [{ ...good, score: '4' }, 'score'],
      [{ ...good, by: '   ' }, 'by'],
      [{ ...good, by: 'A · B' }, 'by'],
      [{ ...good, note: '一\n二' }, '换行'],
      [{ ...good, note: 3 }, 'note'],
    ];
    for (const [body, word] of bad) {
      expect(() => checks.checkRating(body)).toThrow(word);
    }

    expect(() => checks.checkModelId('../config')).toThrow('model');
    expect(() => checks.checkModelId('a__b')).toThrow('model');

    //M notes 配置：不是一节、dir 空串、时区认不得都在入口抛错。
    expect(() => notesModule.readNotesSettings(os.tmpdir(), [])).toThrow('notes');
    expect(() => notesModule.readNotesSettings(os.tmpdir(), { dir: '' })).toThrow('notes.dir');
    expect(() => notesModule.readNotesSettings(os.tmpdir(), { time_zone: 'Mars/Base' })).toThrow('notes.time_zone');
  });

  //M HTTP：GET 交回列表；POST 坏正文回 400、无会话回 404；对了回 200 并支持改分。
  test('接口：GET 列表、POST 会话打分、400 与 404', async () => {
    const { dir, app } = await world(
      { 'grok.md': '# grok\n\n（待补介绍）\n' },
      { s1: { model: 'grok', thinking: 'low' } },
    );

    const rejected = await app.inject({ method: 'POST', url: '/api/model-notes/rate', payload: { session: 's1', by: 'Claude', score: 9 } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: string }>().error).toContain('score');
    expect(fs.readFileSync(path.join(dir, 'grok.md'), 'utf8')).toBe('# grok\n\n（待补介绍）\n');

    const missing = await app.inject({ method: 'POST', url: '/api/model-notes/rate', payload: { session: 'no-such', by: 'Claude', score: 3 } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: string }>().error).toContain('no-such');

    const rated = await app.inject({ method: 'POST', url: '/api/model-notes/rate', payload: { session: 's1', by: 'Claude', score: 3, note: '一般' } });
    expect(rated.statusCode).toBe(200);
    const body = rated.json<{ ok: boolean; note: notesModule.ModelNote }>();
    expect(body.ok).toBe(true);
    expect(body.note).toMatchObject({
      model: 'grok',
      sessionCount: 1,
      average: 3,
      ratings: [{ by: 'Claude', score: 3, session: 's1', thinking: 'low', note: '一般' }],
    });

    const listed = await app.inject({ method: 'GET', url: '/api/model-notes' });
    expect(listed.json<{ list: notesModule.ModelNote[] }>().list).toEqual([body.note]);
  });

  //M 提示词：每个模型写介绍第一段、平均分和会话数、最近 3 条（新的在前）；没评价写一句；没有模型是空串。
  test('提示词：介绍第一段、平均分、N 场会话、最近 3 条', async () => {
    const ratings = [1, 2, 3, 4].map((score) => `- 2026-11-1${String(score)} 10:00 EST · Claude · ${String(score)}/5 · 会话 s${String(score)}（high） · 好`);
    const text = ['# gpt-6.1-sol', '', '第一段', '接着第一段', '', '第二段不要', '', '## 评价', ...ratings, ''].join('\n');
    const { notes } = await world({ 'gpt-6.1-sol.md': text, 'grok.md': '# grok\n' });

    const prompt = notes.getPrompt(notes.getList());
    expect(prompt).toContain('- gpt-6.1-sol：第一段 接着第一段\n');
    expect(prompt).not.toContain('第二段不要');
    expect(prompt).toContain('平均 2.5 分，4 场会话。最近：2026-11-14 10:00 EST · Claude · 4/5 · 会话 s4（high） · 好；2026-11-13');
    expect(prompt).not.toContain('会话 s1');
    expect(prompt).toContain('- grok：（没写介绍）\n  还没有评价。');

    const empty = await world({});
    expect(empty.notes.getPrompt(empty.notes.getList())).toBe('');
  });
});
