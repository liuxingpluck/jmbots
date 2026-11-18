/**
 * 助手体验：三个工具，加一段回话规范（docs/src7插件设计/助手体验对照.md）。
 *   - react：给用户刚发的那条消息点个表情，代替一句“收到”。
 *   - ask：发一张带选项的问题卡片；用户点了哪个，网页就把那个选项当作用户的回复发回来。
 *   - todo：这场会话正在做的事的清单，整份替换（只动这场和它派出的后台子会话；clear 默认也只清这一家）；网页右栏“待办”看得见。
 * 回话规范：听 session/request，给前台、后台会话的系统提示词加一段（先给结论、简短、长活在关键节点用 reply 报一句进度）。
 * 都记在表 assist_items 里，网页轮询 GET /api/assist；点选项走 POST /api/assist/asks/:id；
 * 清待办走 POST /api/assist/todos/clear。不发新事件，飞书以后读同一张表。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChatRequest, Session } from '../../Sessions.ts';


/** 插件名。 */
export const name = 'assist';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
export const version = '1.0.0';

/** 用到的服务：resources 存表；tools 登记工具；http 开接口。 */
export const inject = ['resources', 'tools', 'http', 'sessions'];


/** 一项的种类。 */
type Kind = 'react' | 'ask' | 'todo';

/** 库里一行。 */
interface Row {
  id: number; bot: string; kind: Kind; session_id: string; message_id: number | null; data: string; updated_at: number;
}

/** 待办一项的状态。 */
const TODO_STATES = ['todo', 'doing', 'done'] as const;

/** 回话规范：前台、后台各一段。 */
const STYLE: Record<string, string> = {
  front: '回话规范：先给结论，一两句话。用户只是交代一句、不用答什么时，调 react 点个表情代替“收到/好的”。'
    + '用户明确说不用回话、点个表情就行时，不要交给后台，不要写文件，只调 react。'
    + '点完表情后这一轮对用户的最终回答必须完全空白，一个字都不要输出，包括不要说“已点表情”“已用表情回应”“不再发文字”这类说明。'
    + '要用户在几个选项里选时，调 ask 发一张新的选项卡片，不要让用户打字，也不要让用户去点已经选过的旧卡片；发完卡片后不要再解释，等用户点。',
  work: '回话规范：最后的回答先给结论，再按需简短展开。长活只在关键节点（开始干、做完一大步、遇到要用户决定的事）用 reply 工具发一句简短进度，'
    + '不要逐条叙述工具调用，不要用最后的回答代替中途的 reply。三步以上的活先用 todo 列出清单，做完一项更新一次；要用户选时用 ask 发一张新的选项卡片，不要让用户去点已经选过的旧卡片。',
};


/** 助手体验。 */
class Assist {
  /** 刚调过 react 的会话：下一步用空回答结束，不再让模型补字。 */
  private readonly quiet = new Set<string>();

  /**
   * 建表、登记工具和接口、挂上回话规范。
   * @param ctx Cordis 给这个插件的 ctx。
   */
  constructor(private readonly ctx: cordis.Context) {
    ctx.resources.db.exec('CREATE TABLE IF NOT EXISTS assist_items (id INTEGER PRIMARY KEY AUTOINCREMENT,'
      + ' bot TEXT NOT NULL, kind TEXT NOT NULL,'
      + ' session_id TEXT NOT NULL, message_id INTEGER, data TEXT NOT NULL,'
      + ' created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
    ctx.resources.db.exec('CREATE INDEX IF NOT EXISTS assist_items_bot ON assist_items (bot, id)');

    ctx.on('session/request', (request) => {
      //M 发给模型前把当前会话类型的回话规范追加到系统提示词。
      this.style(request);
      //M 刚点过表情：这一轮不再调模型，空回答直接结束，免得模型再补一句“已点表情”。
      if (this.quiet.delete(request.session.row.id)) request.answer = piAi.fauxAssistantMessage('');
    });

    //M react：给用户刚发的那条点表情。
    ctx.tools.register({
      definition: {
        name: 'react',
        description: '给用户刚发的那条消息点一个表情（比如 👍 ✅ 👀 ❤️ 😂），代替“收到”“好的”这种没内容的回话。点完后不要再发任何文字，不要说“已用表情回应”。',
        parameters: piAi.Type.Object({ emoji: piAi.Type.String({ description: '一个表情符号' }) }),
      },
      kinds: ['front', 'work'],
      run: (args, session) => {
        const emoji = String(args['emoji']).trim().slice(0, 8);
        if (emoji === '') throw new Error('emoji 不能是空的');
        this.add(session, 'react', { emoji });
        this.quiet.add(session.row.id);
        return `已点表情 ${emoji}。这一轮到此结束：不要再生成任何对用户可见的文字，最终回答留空。`;
      },
    });

    //M ask：发一张选项卡片。
    ctx.tools.register({
      definition: {
        name: 'ask',
        description: '发一张带选项的问题卡片给用户，用户点一个选项就当作他的回复发回来。选项 2～6 个，每个简短。即使用户先前回过一张卡，这次要选就再发一张新的，不要让用户去点旧卡。发完就结束这一轮，等用户点。',
        parameters: piAi.Type.Object({
          question: piAi.Type.String({ description: '问题，一句话' }),
          options: piAi.Type.Array(piAi.Type.String(), { description: '选项，2～6 个' }),
        }),
      },
      kinds: ['front', 'work'],
      run: (args, session) => {
        //G 过滤空白选项并校验数量在 2～6 个之间，避免发出无法选择的卡片。
        const options = (args['options'] as unknown[]).map((item) => String(item).trim()).filter((item) => item !== '');
        if (options.length < 2 || options.length > 6) throw new Error('选项要 2～6 个');

        //M 把问题与选项写入 assist_items 表并拿回卡片 id，告诉模型等待用户点击。
        const id = this.add(session, 'ask', { question: String(args['question']), options });
        return `已发出选项卡片 ${String(id)}，等用户点选。`;
      },
    });

    //M todo：整份替换这场会话的待办。
    ctx.tools.register({
      definition: {
        name: 'todo',
        description: '写这场会话正在做的事的清单（整份替换这场和它派出的后台子会话的待办，不动别的客户或会话）。'
          + '用户在网页右栏“待办”看得到。三步以上的活先列，做完一项改一次状态。'
          + '只要清空时把 clear 设为 true、items 留空数组（只清这一家）。',
        parameters: piAi.Type.Object({
          items: piAi.Type.Array(piAi.Type.Object({
            text: piAi.Type.String({ description: '一件事，简短' }),
            status: piAi.Type.Union(
              TODO_STATES.map((state) => piAi.Type.Literal(state)),
              { description: 'todo 没开始、doing 在做、done 做完' },
            ),
          })),
          clear: piAi.Type.Optional(piAi.Type.Boolean({ description: 'true：先清掉这场会话和它派出的后台子会话的待办；items 为空就是只清空' })),
        }),
      },
      kinds: ['front', 'work'],
      run: (args, session) => {
        //M 读取待办清单和清空标志，先查出当前会话及其子会话的 id 家族。
        const items = (args['items'] as { text: string; status: string }[] | undefined) ?? [];
        const clear = args['clear'] === true;
        const db = this.ctx.resources.db;
        const ids = this.familyIds(session);
        //M 只动这场会话和它派出的后台子会话，不动别的客户。
        this.deleteTodos(ids);
        if (clear && items.length === 0) return '待办已清空';
        this.add(session, 'todo', { items });
        const done = items.filter((item) => item.status === 'done').length;
        return `待办已更新：${String(done)}/${String(items.length)} 做完`;
      },
    });

    //M 接口：网页轮询取这个机器人最近的表情、卡片、待办；点选项记下答案。
    ctx.http.app.get<{ Querystring: { bot?: string } }>(
      '/api/assist',
      async (request) => this.list(String(request.query.bot ?? '')),
    );
    ctx.http.app.post<{
      Querystring: { bot?: string; session?: string };
    }>('/api/assist/todos/clear', async (request, reply) => {
      const bot = String(request.query.bot ?? '');
      const sessionId = String(request.query.session ?? '');
      if (bot === '') return reply.code(400).send({ error: 'bot 不能空' });
      if (sessionId === '') return reply.code(400).send({ error: 'session 不能空（只清当前会话及其子会话）' });
      const found = this.ctx.sessions.find({ id: sessionId, bot });
      if (found.length === 0) return reply.code(404).send({ error: '没有这场会话' });
      const session = this.ctx.sessions.open(sessionId);
      const deleted = this.deleteTodos(this.familyIds(session));
      return { ok: true, deleted };
    });
    ctx.http.app.post<{ Params: { id: string }; Body: unknown }>('/api/assist/asks/:id', async (request, reply) => {
      const answer = (request.body as { answer?: unknown } | null)?.answer;
      if (typeof answer !== 'string' || answer === '') return reply.code(400).send({ error: 'answer 要是非空字符串' });
      const row = this.ctx.resources.db
        .query("SELECT * FROM assist_items WHERE id = ? AND kind = 'ask'")
        .get(Number(request.params.id)) as Row | null;
      if (row === null) return reply.code(404).send({ error: '没有这张卡片' });
      const data = JSON.parse(row.data) as Record<string, unknown>;
      if (data['answer'] !== undefined) return reply.code(409).send({ error: '已经答过了' });
      this.ctx.resources.db
        .query('UPDATE assist_items SET data = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ ...data, answer }), Date.now(), row.id);
      return { ok: true };
    });
  }

  /** 前台、后台会话的请求加一段回话规范。 */
  private style(request: ChatRequest): void {
    const text = STYLE[request.session.row.kind];
    if (text !== undefined) request.system.push(text);
  }

  /**
   * 记一项，挂在这个机器人网页时间线最新那条消息上（web-api 的表 web_messages；没有这张表就不挂）。
   * @returns 新一项的号。
   */
  private add(session: Session, kind: Kind, data: Record<string, unknown>): number {
    const db = this.ctx.resources.db;
    const bot = session.row.bot;
    let messageId: number | null = null;
    try {
      //M 若挂了 web-api，查出该机器人最新一条网页消息 id，用来把助手卡片挂到对应消息下。
      const latest = db
        .query('SELECT id FROM web_messages WHERE bot = ? ORDER BY id DESC LIMIT 1')
        .get(bot) as { id: number } | null;
      messageId = latest?.id ?? null;
    } catch { /* 没挂 web-api：不挂消息 */ }
    //M 补齐时间戳并把助手项写入 assist_items 表，返回新生成的主键 id。
    const now = Date.now();
    const result = db
      .query('INSERT INTO assist_items (bot, kind, session_id, message_id, data, created_at, updated_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(bot, kind, session.row.id, messageId, JSON.stringify(data), now, now);
    //T 跟踪：记了一项助手体验。
    this.ctx.emit('trace', 'Assist.add', `记一项 ${kind}`, 'INSERT INTO assist_items',
      { 会话: session.row.id, 消息: messageId, 内容: data });
    return Number(result.lastInsertRowid);
  }

  /**
   * 这场会话和它派出的后台子会话的号（有 parent 的子会话算一家；没有 parent 就只算自己）。
   * @param session 当前这场（前台或后台都行）。
   */
  private familyIds(session: Session): string[] {
    //M 找出发起当前家族的根会话，再查出它派出的所有子会话并去重，限定待办操作范围。
    const root = session.row.parent ?? session.row.id;
    const kids = this.ctx.sessions.find({ parent: root }).map((row) => row.id);
    return [...new Set([root, session.row.id, ...kids])];
  }

  /**
   * 删掉这些会话的待办。
   * @returns 删了几行。
   */
  private deleteTodos(ids: string[]): number {
    //G 没有目标会话 id 时直接返回 0，避免拼出空的 SQL IN 条件。
    if (ids.length === 0) return 0;

    //M 按会话 id 批量删除旧待办记录并返回实际受影响行数。
    const placeholders = ids.map(() => '?').join(', ');
    const result = this.ctx.resources.db
      .query(`DELETE FROM assist_items WHERE kind = 'todo' AND session_id IN (${placeholders})`)
      .run(...ids);
    return Number(result.changes);
  }

  /** 一场会话的根：有父就是父，没有就是自己。 */
  private getRoot(sessionId: string): string {
    //M 查会话元数据取其父会话 id，把子会话待办归并到对应的前端根会话下。
    const meta = this.ctx.sessions.find({ id: sessionId })[0];
    return meta?.parent ?? sessionId;
  }

  /** GET /api/assist：最近 300 项，按种类分好。待办带 root（这场所属的前台会话号）。 */
  private list(bot: string): Record<string, unknown> {
    //M 按倒序拉取该机器人最近 300 条助手记录。
    const rows = this.ctx.resources.db
      .query('SELECT * FROM assist_items WHERE bot = ? ORDER BY id DESC LIMIT 300')
      .all(bot) as Row[];
    const of = (row: Row): Record<string, unknown> => ({
      id: row.id, sessionId: row.session_id, messageId: row.message_id, updatedAt: row.updated_at,
      ...JSON.parse(row.data) as object,
    });

    //M 展开 JSON 数据并按 react / ask / todo 分类，同时为待办补上所属根会话 id 供网页展示。
    return {
      reactions: rows.filter((row) => row.kind === 'react').map(of),
      asks: rows.filter((row) => row.kind === 'ask').map(of),
      todos: rows.filter((row) => row.kind === 'todo')
        .map((row) => ({ ...of(row), root: this.getRoot(row.session_id) })),
    };
  }
}


/**
 * 挂上助手体验。
 * apply 是 Cordis 插件的入口：inject 里的服务都就绪后调一次。没有配置。
 * @param ctx Cordis 给这个插件的 ctx。
 * 副作用：建 assist_items 表和索引、监听 session/request、登记 react/ask/todo 工具与 /api/assist 相关 HTTP 接口。
 */
export function apply(ctx: cordis.Context): void {
  //M 实例化 Assist，完成建表、事件订阅、工具登记和 HTTP 接口注册。
  new Assist(ctx);
}
