/**
 * 任务通道的 7 个接口和接入说明 GUIDE（照 0.4 src/channels/Http.ts:372-531、src/capabilities/AgentTasks.ts:70-95，11-17 加新协议 v1）。
 * 11-17 由原 agent-tasks/Routes.ts 挪进 relay（relay 自己转话的两条接口在 Routes.ts）。
 * 除了说明页都要令牌（本机来的不查，http 插件统一查）；出错一律 { error: 一句话 }，状态码照 Failure（utils/Failure.ts），别的 400。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as checksModule from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as textModule from '../../utils/Text.ts';
import { type AgentTasks, type FinishInput, NAME, STATUSES, type Task, type TaskStatus } from './AgentTasks.ts';
import type * as protocolModule from './TaskProtocol.ts';


/** 接入说明：GET /api/agents/guide 原样给外部 AI 看（照 0.4 原文，改了地址、任务号、上传要 files-api 三处；11-17 加第三节新协议）。 */
export const GUIDE = `# jmbots 接入说明（给别的 AI 看）

<地址> 是 jmbots 后端，局域网里是 http://<那台电脑的局域网 IP>:<端口> 这类（问用户）。
**每个请求都带 token**：网址后面加 ?token=<token>，或请求头 Authorization: Bearer <token>。token 问用户要，用户在 jmbots 设置页“访问令牌”里给你建一个（可能是临时的，过期了再要）。只有 jmbots 本机来的请求不用带；这份说明不用带也能读。

## 一、领 jmbots 派给你的活（你是干活的）

<名字> 是你在这里的名字，只用字母、数字、- 和 _（比如 image-bot）。

1. 打招呼（启动时一次，之后每天一次就行）：POST <地址>/api/agents/<名字>/hello，JSON {"description": "一句话说你会做什么，比如：会用 Grok 生短视频（图生视频）、生图"}。机器人派活前会看这句话。要领新协议的活，同时报能力，见第三节。
2. 领活：每 30 秒 GET <地址>/api/agents/<名字>/tasks?status=new。回一个数组，每件有 id（任务号，数字写成的字符串）、title、text（要做什么、要交回什么）、files（附件：name 和下载用的 url，url 是相对 <地址> 的路径）、bot（谁派的）。带 spec 的是新协议的任务，照第三节做。
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

## 三、新协议 v1（任务带 spec 的照这里做）

1. 打招呼时报能力：hello 的 JSON 再加
   {"models": [{"id": "模型 ID，照你客户端的写法", "efforts": ["从低到高", "你能设的思考档"]}], "subagents": true/false（能不能真的开子代理）, "returnMode": "http" 或 "file"}。
   机器人照它定模型，思考档默认取你登记的次高档（去掉 off 以后的倒数第二个）。不报就只能领派活方自己写明模型和思考档的活。
2. 任务单：任务里的 spec，也是任务文件夹里的 task.json（task.md 是可读副本，以 task.json 为准）。看 spec.execution：
   model、thinking 是主执行要用的；subagents 是必须真的开出来的子代理（各自的负责范围、模型、思考档）；
   设不了指定的模型、思考档，或开不了子代理，就交 status 为 capability_missing 的结果写明缺什么——**不换模型（尤其不换付费模型），不让主代理自己做完冒充开过子代理**。
   spec.task.deliverables 是要交回的东西；附件在 files 里（在任务文件夹的 input/ 下）。
3. 认领带领取键：POST .../take，JSON {"claimKey": "你定的键，比如 主机名-任务号-时间"}。网络断了不知道领没领上，拿同一个键再领一次：回原样就是领上了；回 409 是别人领了。不带键也能领，回的任务里 claimKey 是替你定的，交回时照填。
4. 结果（result.json 的样子）：
   {"version": 1, "kind": "result", "taskId": "任务号", "claimKey": "领取键", "resultKey": "任务号/领取键/result（可不写）",
    "status": "completed | failed | capability_missing", "summary": "具体结论",
    "actualExecution": {"host": "哪个客户端", "sessionId": "主会话 ID", "requestedModel": "...", "requestedThinking": "...", "actualModel": "...", "actualThinking": "...",
      "subagents": [{"id": "子代理真实 ID", "responsibility": "...", "model": "...", "thinking": "..."}]},
    "artifacts": [{"path": "相对 result/artifacts/ 的路径", "sha256": "64 位小写十六进制", "description": "..."}],
    "verification": [{"check": "查了什么", "outcome": "passed | failed | not_run"}], "remaining": ["没做完的"], "capabilityMissing": ["缺的能力"]}
   核实不了的值写 unknown，不拿要求的值冒充实际的。
5. 交回，照 spec.result.returnMode 选一种：
   - http：产物一个一个 PUT /api/uploads/<文件名>，再 POST .../result，JSON {"protocolResult": 上面的结果, "uploads": [上传号]}；
   - file：产物放进任务文件夹的 result/artifacts/，结论写 result/result.md，最后先写临时文件再改名成 result/result.json（jmbots 每 10 秒左右扫一次，只认 result.json）。
   同一份结果重交回原样；内容不一样回 409 result_conflict，不覆盖。结果会排进派活的会话：前台整理后回给用户，后台看了接着做。
`;


/** 任务给外部 AI 看的样子：files 换成 { name, url }；新协议带任务单、领取键、交回的结果，回话地址不给看。 */
type ShownTask = Omit<Task, 'files' | 'protocol'> & {
  /** 附件：文件名和下载地址。 */
  files: { name: string; url: string }[];
  /** 新协议的任务单。 */
  spec?: protocolModule.TaskSpec;
  /** 领取键。 */
  claimKey?: string;
  /** 交回的结果。 */
  protocolResult?: checksModule.TaskResult;
};


/** 路由里回话用到的那点 reply。 */
interface Reply {
  code(n: number): { send(body: unknown): unknown };
}


/** 任务给外部 AI 看的样子。 */
function shown(task: Task): ShownTask {
  const { protocol, ...rest } = task;

  //M 下载地址：路径每一段分别编码（新协议的附件在 input/ 下）。
  const files = task.files.map((file) => {
    const encoded = file.split('/').map(encodeURIComponent).join('/');
    return { name: file, url: `/api/agents/${task.agent}/tasks/${task.id}/files/${encoded}` };
  });
  const view: ShownTask = { ...rest, files };

  //M 新协议：带上任务单、领取键、交回的结果；protocol 里的回话地址（用户的渠道和地址）不给。
  if (protocol !== undefined) {
    view.spec = protocol.spec;
    view.claimKey = protocol.claimKey;
    view.protocolResult = protocol.result;
  }
  return view;
}


/**
 * 出错回 { error }：Failure 照它的状态码，别的 400。
 * @param reply 路由的 reply。
 * @param error 抛出来的错。
 */
function fail(reply: Reply, error: unknown): unknown {
  let status = 400;
  if (error instanceof failureModule.Failure) {
    status = error.status;
  }

  //M 把异常整理成统一的 HTTP 错误正文，保留任务服务给出的状态码。
  return reply.code(status).send({ error: textModule.getMessage(error) });
}


/**
 * 交回的正文 → finish 要的。新协议的 protocolResult 交给 Checks.ts 的 checkTaskResult 查；旧格式查 ok、text。uploads 两种都能带。
 * @param body 请求正文。
 * @throws 正文不对时抛错（路由回 400）。
 */
function getFinishInput(body: Record<string, unknown>): FinishInput {
  //G uploads：上传号清单，可以不带。
  const uploads = body['uploads'] ?? [];
  if (!Array.isArray(uploads) || !uploads.every((item) => typeof item === 'string')) {
    throw new Error('uploads 要是上传号清单（PUT /api/uploads/<文件名> 回的 id）');
  }

  //M 新协议：protocolResult 就是 result.json 的内容。
  if (body['protocolResult'] !== undefined) {
    const result = checksModule.checkTaskResult(body['protocolResult']);
    return { uploads, result };
  }

  //M 旧格式：{ ok?: true/false, text?: 字符串 }。
  const ok = body['ok'] ?? true;
  const text = body['text'] ?? '';
  if (typeof ok !== 'boolean' || typeof text !== 'string') {
    throw new Error('要 { ok?: true/false, text?: 字符串, uploads?: 上传号[] }；新协议交 { protocolResult, uploads? }');
  }
  return { ok, text, uploads };
}


/**
 * 登记 7 个接口；说明页不要令牌。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param tasks 任务通道。
 * 副作用：登记任务接口，并将接入说明加入 HTTP 免令牌路径。
 */
export function registerRoutes(ctx: cordis.Context, tasks: AgentTasks): void {
  const app = ctx.http.app;
  //M http.allow：把说明页放进“不查令牌”的名单。
  ctx.http.allow('/api/agents/guide');

  type Named = { Params: { name: string; id?: string; '*'?: string } };
  /** 查名字和任务号；不对回 undefined（已回 400）。 */
  const check = (params: Named['Params'], reply: Reply): { agent: string; id: number } | undefined => {
    //G 把执行端名称和任务号限定在接口支持的格式内。
    if (!NAME.test(params.name)) { reply.code(400).send({ error: '名字只能是字母、数字、- 和 _，1 到 40 字' }); return undefined; }
    if (params.id !== undefined && !/^\d+$/u.test(params.id)) { reply.code(400).send({ error: '任务号要是数字' }); return undefined; }
    return { agent: params.name, id: Number(params.id ?? 0) };
  };

  //M 让新执行端能读取 Markdown 接入说明。
  app.get('/api/agents/guide', async (_request, reply) => reply.type('text/markdown; charset=utf-8').send(GUIDE));

  //M 向派活端公开当前已登记的执行端和它们的能力。
  app.get('/api/agents', async () => tasks.agents());

  //M 打招呼：说明和能力由 Checks.ts 的 checkAgentHello 查。
  app.post<Named & { Body: unknown }>('/api/agents/:name/hello', async (request, reply) => {
    const checked = check(request.params, reply);
    if (checked === undefined) return reply;

    try {
      //M 校验执行端提交的说明和能力，再登记上线并返回登记结果。
      const said = checksModule.checkAgentHello(request.body);
      return tasks.hello(checked.agent, said);
    } catch (error) {
      //G 将无效登记或服务错误转成接口约定的错误响应。
      return fail(reply, error);
    }
  });

  //M 提供按执行端及可选状态筛选的任务列表。
  app.get<Named & { Querystring: { status?: string } }>('/api/agents/:name/tasks', async (request, reply) => {
    //G 验证路径参数，避免把错误的执行端名传给任务查询。
    const checked = check(request.params, reply);
    if (checked === undefined) return reply;
    const status = request.query.status;
    //G 只接受已有任务状态，给请求方返回可选值。
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) return reply.code(400).send({ error: `status 只能是 ${STATUSES.join('、')}` });

    //M 记录这次轮询并按接口格式返回该执行端的任务。
    return tasks.list(checked.agent, status as TaskStatus | undefined, true).map(shown);
  });

  //M 认领：正文可以带 { claimKey }（新协议），不带也能领。
  app.post<Named & { Body: unknown }>('/api/agents/:name/tasks/:id/take', async (request, reply) => {
    const checked = check(request.params, reply);
    if (checked === undefined) return reply;

    //G claimKey：可以不带；带了要是 1 到 200 字的文字。
    const body = (request.body ?? {}) as Record<string, unknown>;
    const claimKey = body['claimKey'];
    const badKey = claimKey !== undefined && (typeof claimKey !== 'string' || claimKey === '' || claimKey.length > 200);
    if (badKey) return reply.code(400).send({ error: 'claimKey 要是 1 到 200 字的文字（可以不带）' });

    try {
      //M 用领取键登记或重取任务，把任务按 HTTP 约定返回给执行端。
      const task = tasks.take(checked.agent, checked.id, claimKey as string | undefined);
      return shown(task);
    } catch (error) {
      //G 将任务缺失或领取冲突返回给执行端。
      return fail(reply, error);
    }
  });

  //M 执行端按任务号下载输入附件或该任务内的其他文件。
  app.get<Named>('/api/agents/:name/tasks/:id/files/*', async (request, reply) => {
    //G 先校验任务标识，并确认它归属于请求中指定的执行端。
    const checked = check(request.params, reply);
    if (checked === undefined) return reply;
    if (tasks.get(checked.agent, checked.id) === undefined) return reply.code(404).send({ error: `没有任务 ${String(checked.id)}` });

    //M 用任务目录作为相对路径解析及判界的基准。
    const folder = tasks.dir(checked.agent, checked.id);
    const wanted = request.params['*'] ?? '';
    const file = path.resolve(folder, wanted);
    const back = path.relative(folder, file);
    //G 越出任务文件夹、不在、是文件夹的，一律 404。
    if (wanted === '' || back.startsWith('..') || path.isAbsolute(back) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return reply.code(404).send({ error: `没有这个文件：${wanted}` });
    }

    //M 附上文件名并流式回传文件内容，避免整份附件载入内存。
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
    return reply.send(fs.createReadStream(file));
  });

  //M 交回：旧格式 { ok, text, uploads }，新协议 { protocolResult, uploads }；都走 AgentTasks.finish。
  app.post<Named & { Body: unknown }>('/api/agents/:name/tasks/:id/result', async (request, reply) => {
    const checked = check(request.params, reply);
    if (checked === undefined) return reply;

    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      //M 把新旧格式转成任务服务的输入，落库后按接口格式返回结果。
      const input = getFinishInput(body);
      const task = tasks.finish(checked.agent, checked.id, input);
      return { ok: true, task: shown(task) };
    } catch (error) {
      //G 把校验失败或交回冲突转换为执行端可处理的错误响应。
      return fail(reply, error);
    }
  });
}
