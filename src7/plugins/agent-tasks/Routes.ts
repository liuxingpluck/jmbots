/**
 * 任务通道的 7 个接口和接入说明 GUIDE（照 0.4 src/channels/Http.ts:372-531、src/capabilities/AgentTasks.ts:70-95）。
 * 除了说明页都要令牌（本机来的不查，http 插件统一查）；出错一律 { error: 一句话 }。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import { type AgentTasks, NAME, STATUSES, type Task, TaskError, type TaskStatus } from './index.ts';


/** 接入说明：GET /api/agents/guide 原样给外部 AI 看（照 0.4 原文，改了地址、任务号、上传要 files-api 三处）。 */
export const GUIDE = `# jmbots 接入说明（给别的 AI 看）

<地址> 是 jmbots 后端，局域网里是 http://<那台电脑的局域网 IP>:<端口> 这类（问用户）。
**每个请求都带 token**：网址后面加 ?token=<token>，或请求头 Authorization: Bearer <token>。token 问用户要，用户在 jmbots 设置页“访问令牌”里给你建一个（可能是临时的，过期了再要）。只有 jmbots 本机来的请求不用带；这份说明不用带也能读。

## 一、领 jmbots 派给你的活（你是干活的）

<名字> 是你在这里的名字，只用字母、数字、- 和 _（比如 image-bot）。

1. 打招呼（启动时一次，之后每天一次就行）：POST <地址>/api/agents/<名字>/hello，JSON {"description": "一句话说你会做什么，比如：会用 Grok 生短视频（图生视频）、生图"}。机器人派活前会看这句话。
2. 领活：每 30 秒 GET <地址>/api/agents/<名字>/tasks?status=new。回一个数组，每件有 id（任务号，数字写成的字符串）、title、text（要做什么、要交回什么）、files（附件：name 和下载用的 url，url 是相对 <地址> 的路径）、bot（谁派的）。
3. 认领：POST <地址>/api/agents/<名字>/tasks/<id>/take。回 409 就是已经被领了，跳过。
4. 下载附件：GET <地址><files 里的 url>（也要带 token）。
5. 做完交回：
   - 先传文件（要 jmbots 挂了 files-api），一个文件一次：PUT <地址>/api/uploads/<文件名>，请求体就是文件的原始字节，回 {"id": ...}。
   - 再交结果：POST <地址>/api/agents/<名字>/tasks/<id>/result，JSON {"ok": true, "text": "做了什么、文件是什么", "uploads": ["上一步的 id", ...]}。没做成就 "ok": false，text 写原因。
   结果会作为一条消息送回派活的那个会话，机器人接着往下做。
6. 有事要问用户：用你自己的渠道（比如你的飞书机器人）直接问，不要卡着任务不交。

## 二、给 jmbots 的机器人派活（你是派活的）

1. 发一句话：POST <地址>/api/message，JSON {"text": "要它做什么", "bot": "机器人名，不写给第一个", "from": "你的名字", "session": "接着某个会话时写会话号，不写由它自己分派"}。回 {"id": 消息号}。
2. 看结果：GET <地址>/api/messages/<消息号>，看 status、sessionId 和 replies（机器人的回复）。机器人一般几十秒到几分钟做完；status 是 taken、会话不在跑了就是做完了。
3. 看它怎么做的：GET <地址>/api/sessions/<会话号>，md 是给人看的全过程。
4. 有哪些机器人：GET <地址>/api/bots。
`;


/** 任务给外部 AI 看的样子：files 换成 { name, url }。 */
function shown(task: Task): Omit<Task, 'files'> & { files: { name: string; url: string }[] } {
  return { ...task, files: task.files.map((file) => ({ name: file, url: `/api/agents/${task.agent}/tasks/${task.id}/files/${encodeURIComponent(file)}` })) };
}


/**
 * 登记 7 个接口；说明页不要令牌。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param tasks 任务通道。
 */
export function registerRoutes(ctx: cordis.Context, tasks: AgentTasks): void {
  const app = ctx.http.app;
  //M http.allow：把说明页放进“不查令牌”的名单。
  ctx.http.allow('/api/agents/guide');

  type Named = { Params: { name: string; id?: string; '*'?: string } };
  /** 查名字和任务号；不对回 undefined（已回 400）。 */
  const check = (params: Named['Params'], reply: { code(n: number): { send(body: unknown): unknown } }): { agent: string; id: number } | undefined => {
    if (!NAME.test(params.name)) { reply.code(400).send({ error: '名字只能是字母、数字、- 和 _，1 到 40 字' }); return undefined; }
    if (params.id !== undefined && !/^\d+$/u.test(params.id)) { reply.code(400).send({ error: '任务号要是数字' }); return undefined; }
    return { agent: params.name, id: Number(params.id ?? 0) };
  };

  app.get('/api/agents/guide', async (_request, reply) => reply.type('text/markdown; charset=utf-8').send(GUIDE));
  app.get('/api/agents', async () => tasks.agents());

  app.post<Named & { Body: unknown }>('/api/agents/:name/hello', async (request, reply) => {
    const checked = check(request.params, reply);
    if (checked === undefined) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body['description'] !== undefined && typeof body['description'] !== 'string') return reply.code(400).send({ error: 'description 要是字符串' });
    return tasks.hello(checked.agent, (body['description'] as string | undefined) ?? '');
  });

  app.get<Named & { Querystring: { status?: string } }>('/api/agents/:name/tasks', async (request, reply) => {
    const checked = check(request.params, reply);
    if (checked === undefined) return reply;
    const status = request.query.status;
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) return reply.code(400).send({ error: `status 只能是 ${STATUSES.join('、')}` });
    return tasks.list(checked.agent, status as TaskStatus | undefined, true).map(shown);
  });

  app.post<Named>('/api/agents/:name/tasks/:id/take', async (request, reply) => {
    const checked = check(request.params, reply);
    if (checked === undefined) return reply;
    try {
      return shown(tasks.take(checked.agent, checked.id));
    } catch (error) {
      return reply.code(error instanceof TaskError ? error.status : 400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<Named>('/api/agents/:name/tasks/:id/files/*', async (request, reply) => {
    const checked = check(request.params, reply);
    if (checked === undefined) return reply;
    if (tasks.get(checked.agent, checked.id) === undefined) return reply.code(404).send({ error: `没有任务 ${String(checked.id)}` });
    const folder = tasks.dir(checked.agent, checked.id);
    const wanted = request.params['*'] ?? '';
    const file = path.resolve(folder, wanted);
    const back = path.relative(folder, file);
    //G 越出任务文件夹、不在、是文件夹的，一律 404。
    if (wanted === '' || back.startsWith('..') || path.isAbsolute(back) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return reply.code(404).send({ error: `没有这个文件：${wanted}` });
    }
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
    return reply.send(fs.createReadStream(file));
  });

  app.post<Named & { Body: unknown }>('/api/agents/:name/tasks/:id/result', async (request, reply) => {
    const checked = check(request.params, reply);
    if (checked === undefined) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const ok = body['ok'] ?? true;
    const text = body['text'] ?? '';
    const uploads = body['uploads'] ?? [];
    if (typeof ok !== 'boolean' || typeof text !== 'string' || !Array.isArray(uploads) || !uploads.every((item) => typeof item === 'string')) {
      return reply.code(400).send({ error: '要 { ok?: true/false, text?: 字符串, uploads?: 上传号[] }' });
    }
    try {
      return { ok: true, task: shown(tasks.finish(checked.agent, checked.id, ok, text, uploads as string[])) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
