#!/usr/bin/env node
/**
 * dsh-control 技能的脚本：jmbots 的后台会话用 exec 显式跑它，把一件活交给 Windows 上的 DSH 去做、等结果、喊停。
 * 读技能（skill 工具）不会跑它。它也不自己连 DSH：每一步都调现有的 DSH 客户端 Dsh_Control.mjs（路径写在 settings.json），
 * DSH 的地址和令牌由客户端自己从它的 .env 读，本脚本不读、不打印。
 *
 * 用法（工作目录就是机器人工作区，不要 cd 到别处）：
 *   node dsh.mjs models                                  DSH 能用的模型和各自的思考档（带次高档）
 *   node dsh.mjs send --task 任务号 --text-file 任务书.md [--model 供应商/模型] [--effort 档] [--wait-ms 毫秒] [--steer]
 *   node dsh.mjs status --task 任务号 [--wait-ms 毫秒]
 *   node dsh.mjs cancel --task 任务号
 *
 * 每次只往标准输出打一份 JSON，state 是：
 *   ok 查到了（models）/ accepted 交出去了 / running 还在做 / needs_input 等人回答或审批 / completed 做完 / failed 没做成 /
 *   unknown 说不清（交没交上、建没建成，不自动重发） / capability_missing DSH 没有这个模型或档位 / stopped 停了 / pause_unconfirmed 喊了停但确认不了停妥。
 * 记录：工作区的 .dispatch/<任务号>/dsh.json（DSH 会话号、发过的 requestId、模型和档）。同一个任务号接着用同一场 DSH 会话；
 *   换模型、换档就换个任务号开新的一场。交没交上说不清时，原样重发同一份任务书会沿用原来的 requestId，DSH 不会派两次。
 * 只认 settings.json 登记过的工作区（和当前目录精确相同）：别的目录跑回 workspace_mismatch，不回退到默认工作区。
 * 设计：docs/开发进度/前台派后台和技能_细节_Codex_20261117.md 第五节。
 */
import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as timers from 'node:timers/promises';
import * as url from 'node:url';
import * as util from 'node:util';


/** 技能目录：本脚本在 <技能>/scripts/ 下，往上一层。settings.json 放在这里。 */
const SKILL_DIR = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

/** 任务号：字母、数字、. _ -，1 到 80 字。用作 .dispatch/ 下的文件夹名，也写进 DSH 会话标题。 */
const TASK_ID = /^[A-Za-z0-9_.-]{1,80}$/u;

/** dsh-result 里认的三种结论。 */
const RESULT_STATES = ['completed', 'failed', 'capability_missing'];

/** 喊停以后看几次状态、每次隔多久，确认 DSH 停妥。 */
const STOP_CHECKS = 5;
const STOP_INTERVAL_MS = 2000;

/** 等客户端的子进程，比它自己的等待多给这么久（登录、读状态要时间）。 */
const CLIENT_SLACK_MS = 60_000;

/** 不等结果的客户端调用（查模型、建会话、发消息、喊停、看状态）最多给多久。 */
const CLIENT_SHORT_MS = 120_000;

/** 输出里的回复最多留多少字；全文另存进 .dispatch/<任务号>/ 的文件。 */
const REPLY_MAX = 3000;

/** 附在每份任务书后面：要 DSH 真开子代理、在回复最后交一段 dsh-result。status、send 等到结果时从回复里取它。 */
const RESULT_RULE = [
  '',
  '---',
  'jmbots 的要求：',
  '- 照上面写的模型、子代理去做。要开子代理就用你的子代理工具真的开出来；开不了就直说，不要主代理自己做完冒充开过。',
  '- 做完在回复最后附一个 ```dsh-result 代码块，里面是一份 JSON：',
  '  {"status": "completed 或 failed 或 capability_missing", "summary": "结论",',
  '   "subagents": [{"id": "子代理的真实 ID", "responsibility": "负责什么", "model": "模型", "thinking": "思考档"}],',
  '   "artifacts": [{"path": "交回文件的路径", "description": "是什么"}],',
  '   "verification": [{"check": "查了什么", "outcome": "passed 或 failed 或 not_run"}], "remaining": ["没做完的"]}',
  '- 核实不了的值写 unknown，不拿要求的值冒充实际的。',
].join('\n');

/** 命令行选项；没列的直接报错（util.parseArgs 的 strict），拼错的参数不会被悄悄忽略。 */
const OPTIONS = {
  task: { type: 'string' },
  'text-file': { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  'wait-ms': { type: 'string' },
  steer: { type: 'boolean', default: false },
};

/** 这次在处理的任务号和 DSH 会话号：查到就填上，出错时也带进输出，调用方拿它接着 status。 */
const context = {};


/** 交给调用方看的失败：state 是输出的状态，code 是原因代号。 */
class Failure extends Error {
  /**
   * @param {string} state 输出的 state：failed、unknown、capability_missing。
   * @param {string} code 原因代号，比如 workspace_mismatch。
   * @param {string} message 一句话原因。
   */
  constructor(state, code, message) {
    super(message);
    this.state = state;
    this.code = code;
  }
}


/**
 * 比较目录用的键：绝对路径；Windows 不分大小写，转小写。
 * @param {string} dir 目录。
 * @returns {string}
 */
function getDirKey(dir) {
  const full = path.resolve(dir);
  if (process.platform === 'win32') return full.toLowerCase();

  return full;
}


/**
 * 读 settings.json（外面写的配置，在这里查一次），找出当前目录对应的 DSH 工作区。
 * settings.json 的样子见同目录的 settings.example.json：client 客户端路径、workspaces 登记的工作区、waitMs send 默认等多久。
 * @returns {{ client: string, workspace: string, waitMs: number }} 客户端路径、DSH 工作区标题、send 默认等多久（毫秒）。
 * @throws configuration_missing：没有 settings.json、写得不对、客户端不在；workspace_mismatch：当前目录没登记或登记了不止一次。
 */
function getSettings() {
  const file = path.join(SKILL_DIR, 'settings.json');
  if (!fs.existsSync(file)) throw new Failure('failed', 'configuration_missing', `没有 ${file}：照同目录的 settings.example.json 写一份`);

  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));

  //G client：DSH 客户端 Dsh_Control.mjs 的路径，要在。
  const client = settings.client;
  if (typeof client !== 'string' || !fs.existsSync(client)) {
    throw new Failure('failed', 'configuration_missing', `settings.json 的 client 要写 DSH 客户端 Dsh_Control.mjs 的路径（现在是 ${String(client)}）`);
  }

  //G workspaces：[{ dir: 机器人工作区, dsh: DSH 里的工作区标题 }]。
  const workspaces = settings.workspaces;
  const goodList = Array.isArray(workspaces) && workspaces.every((item) => typeof item?.dir === 'string' && typeof item?.dsh === 'string');
  if (!goodList) throw new Failure('failed', 'configuration_missing', 'settings.json 的 workspaces 要写成 [{ "dir": 机器人工作区, "dsh": DSH 里的工作区标题 }]');

  //G waitMs：可以不写（不等）；写了要是不小于 0 的整数。
  const waitMs = settings.waitMs ?? 0;
  if (!Number.isInteger(waitMs) || waitMs < 0) throw new Failure('failed', 'configuration_missing', 'settings.json 的 waitMs 要写不小于 0 的整数毫秒');

  //M 当前目录：exec 在机器人工作区里跑本脚本，就是这个目录。只认精确相同的，子目录、别人的目录都不算。
  const here = getDirKey(process.cwd());
  const matched = workspaces.filter((item) => getDirKey(item.dir) === here);
  if (matched.length !== 1) {
    throw new Failure('failed', 'workspace_mismatch', `当前目录 ${process.cwd()} 不是 settings.json 里登记的唯一一个工作区：只在登记过的机器人工作区里跑，不回退到默认工作区`);
  }

  return { client, workspace: matched[0].dsh, waitMs };
}


/**
 * 调一次 DSH 客户端：用跑本脚本的同一个运行时（node 或 bun）跑 Dsh_Control.mjs <命令> [参数]，等它退出。
 * @param {string} client 客户端路径（getSettings 查过）。
 * @param {string[]} args 命令和参数。
 * @param {number} timeoutMs 子进程最多跑多久。
 * @returns {{ code: number | null, value: any, error: string }} 退出码、标准输出解析出的 JSON（不是 JSON 是 undefined）、出错原因。
 * 副作用：起子进程。DSH 用自签证书：Node 的客户端自己会信任它；bun 没有 tls.setDefaultCACertificates，
 *   要靠 NODE_EXTRA_CA_CERTS，所以只在这个子进程的环境里设上，不碰系统和别的进程。
 */
function callClient(client, args, timeoutMs) {
  const env = { ...process.env };
  const certificate = path.join(path.dirname(client), 'dsh-desktop-ca.pem');
  if (env.NODE_EXTRA_CA_CERTS === undefined && fs.existsSync(certificate)) {
    env.NODE_EXTRA_CA_CERTS = certificate;
  }

  //M maxBuffer：模型目录、长回复可能超过默认的 1 MB。
  const spawnOptions = {
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  };
  const child = childProcess.spawnSync(process.execPath, [client, ...args], spawnOptions);

  //M 标准输出：客户端 print 打的一份 JSON；不是 JSON 就当没有。
  let value;
  try {
    value = JSON.parse(child.stdout ?? '');
  } catch {
    value = undefined;
  }

  //M 出错原因：客户端写在标准错误（已经去掉了令牌）；没有就是子进程本身的错（超时、起不来）。
  let error = (child.stderr ?? '').trim();
  if (error === '' && child.error !== undefined) {
    error = child.error.message;
  }
  return { code: child.status, value, error };
}


/**
 * 次高档：去掉 off 以后从低到高的倒数第二个（和 relay 插件 TaskProtocol.ts 的 getSecondEffort 一样）。
 * @param {string[]} efforts 档位，从低到高。
 * @returns {string | undefined} 不到两档是 undefined。
 */
function getSecond(efforts) {
  const real = efforts.filter((item) => item !== 'off');
  return real[real.length - 2];
}


/**
 * DSH 能用的模型：调客户端 models（session/modelCatalog），摊平成“供应商/模型 ID”和它的档位（照 DSH 给的顺序，从低到高）。
 * 目录的形状照 DSH 接口文档 groups[].models[].reasoning.efforts[].id；供应商取模型自己的 provider，没有取分组的 provider 或 id。
 * @param {string} client 客户端路径。
 * @returns {{ model: string, efforts: string[] }[]}
 * @throws unknown：客户端出错。
 */
function getCatalog(client) {
  const listed = callClient(client, ['models'], CLIENT_SHORT_MS);
  if (listed.code !== 0 || listed.value === undefined) throw new Failure('unknown', 'catalog_failed', `读不到 DSH 的模型目录：${listed.error}`);

  const models = [];
  for (const group of listed.value.groups ?? []) {
    for (const item of group.models ?? []) {
      const provider = item.provider ?? group.provider ?? group.id;
      const id = item.model ?? item.id;
      const efforts = (item.reasoning?.efforts ?? []).map((effort) => effort.id);
      models.push({ model: `${provider}/${id}`, efforts });
    }
  }
  return models;
}


/**
 * 定思考档：写了就要是 DSH 这个模型有的；没写取次高档。定不了就报错，不猜档、不换模型。
 * @param {{ model: string, efforts: string[] }[]} catalog DSH 的模型目录（getCatalog）。
 * @param {string} model 供应商/模型 ID。
 * @param {string | undefined} given 调用方写的档。
 * @returns {string} 思考档。
 * @throws capability_missing：模型没有（model_unavailable）、档没有（thinking_unsupported）、定不了次高档（effort_unverifiable）。
 */
function getEffort(catalog, model, given) {
  const found = catalog.find((item) => item.model === model);
  if (found === undefined) throw new Failure('capability_missing', 'model_unavailable', `DSH 没有模型 ${model}：用 models 看有哪些，不换别的模型`);

  //M 写了档：要是它有的。
  if (given !== undefined) {
    if (!found.efforts.includes(given)) {
      throw new Failure('capability_missing', 'thinking_unsupported', `DSH 的 ${model} 没有思考档 ${given}（有：${found.efforts.join('、')}）`);
    }
    return given;
  }

  //M 没写：取次高档；去掉 off 不到两档就定不了，要调用方写 --effort。
  const second = getSecond(found.efforts);
  if (second === undefined) {
    throw new Failure('capability_missing', 'effort_unverifiable', `DSH 的 ${model} 只有 ${found.efforts.join('、') || '（没有）'}，定不了次高档，要写 --effort`);
  }
  return second;
}


/**
 * 任务的记录目录 .dispatch/<任务号>/，在当前工作区里。
 * @param {string | undefined} taskId 命令行的 --task。
 * @returns {string} 目录的绝对路径（还没建）。
 * @throws bad_args：没写或不合规矩。
 */
function getTaskFolder(taskId) {
  if (taskId === undefined || !TASK_ID.test(taskId)) throw new Failure('failed', 'bad_args', '--task 要写任务号：字母、数字、. _ -，1 到 80 字');

  context.taskId = taskId;
  return path.join(process.cwd(), '.dispatch', taskId);
}


/**
 * 读任务的记录 dsh.json；没有是 undefined。
 * 记录的样子：{ taskId, workspace DSH 工作区标题, model 供应商/模型, effort 思考档, sessionId? DSH 会话号,
 *   creating 在建会话还没拿到会话号, requests: [{ requestId, hash 内容摘要, mode queue|steer, accepted true|false|null, afterTurn? }] }。
 * @param {string} folder getTaskFolder 的目录。
 */
function readState(folder) {
  const file = path.join(folder, 'dsh.json');
  if (!fs.existsSync(file)) return undefined;

  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  context.sessionId = state.sessionId;
  return state;
}


/**
 * 存任务的记录：先写临时文件再改名，写到一半断了也不留半截。
 * @param {string} folder getTaskFolder 的目录。
 * @param {object} state 记录。
 * 副作用：写 .dispatch/<任务号>/dsh.json。
 */
function saveState(folder, state) {
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'dsh.json');
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, file);
  context.sessionId = state.sessionId;
}


/**
 * 建会话那次客户端记下的会话号（create 的 --trace-file，一行一个 JSON：phase、sessionId、time）。
 * @param {string} trace 记录文件。
 * @returns {string | undefined} 最后记下的会话号；没有是 undefined。
 */
function getTracedSession(trace) {
  if (!fs.existsSync(trace)) return undefined;

  const lines = fs.readFileSync(trace, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const ids = lines.map((line) => JSON.parse(line).sessionId).filter((id) => typeof id === 'string');
  return ids.at(-1);
}


/**
 * 保证这件任务有一场 DSH 会话：有了直接用；上次建到一半，从记录里找回来；都没有就新建（先记“在建”再建）。
 * @param {{ client: string }} settings getSettings 的。
 * @param {object} state 任务的记录（readState 的样子），会改它。
 * @param {string} folder 任务的记录目录。
 * @throws unknown：上次建到一半又找不回会话号（说不清建没建成，不再建）、这次建或补设模型出错。
 * 副作用：可能在 DSH 建会话、选模型（DSH 会顺带改它的全局默认模型）、设完全权限；写记录。
 */
function ensureSession(settings, state, folder) {
  if (state.sessionId !== undefined) return;

  const trace = path.join(folder, 'create.trace');

  //M 上次建到一半：客户端记下了会话号就接着用，补设一遍模型和权限（上次可能没设上），设好了才记进记录。
  if (state.creating) {
    const found = getTracedSession(trace);
    if (found === undefined) {
      const message = `上次给任务 ${state.taskId} 建 DSH 会话没拿到会话号，说不清建没建成，不再建。`
        + `到 DSH 的 ${state.workspace} 工作区找标题带「jmbots ${state.taskId}」的会话；确认没有，再删掉 ${path.join(folder, 'dsh.json')} 重发`;
      throw new Failure('unknown', 'create_unconfirmed', message);
    }

    const modelArgs = ['model', '--session', found, '--model', state.model, '--effort', state.effort];
    const modelSet = callClient(settings.client, modelArgs, CLIENT_SHORT_MS);
    const permissionSet = callClient(settings.client, ['permission', '--session', found], CLIENT_SHORT_MS);
    if (modelSet.code !== 0 || permissionSet.code !== 0) {
      throw new Failure('unknown', 'adopt_failed', `找回了 DSH 会话 ${found}，但补设模型或权限出错：${modelSet.error}${permissionSet.error}`);
    }

    state.sessionId = found;
    state.creating = false;
    saveState(folder, state);
    return;
  }

  //M 先记下“在建”再建：建到一半出了事，下次走上面那段找回来，不会建第二场。
  //  旧的建会话记录（删了 dsh.json 重来时会有）先删掉，免得找回到上一次的会话。
  state.creating = true;
  saveState(folder, state);
  fs.rmSync(trace, { force: true });

  //M 建：标题带任务号（客户端自动补 claude 前缀），选定模型和档，设完全权限（客户端 create 一起做）。
  const createArgs = [
    'create',
    '--title', `jmbots ${state.taskId}`,
    '--model', state.model,
    '--effort', state.effort,
    '--workspace', state.workspace,
    '--trace-file', trace,
  ];
  const created = callClient(settings.client, createArgs, CLIENT_SHORT_MS);
  const sessionId = created.value?.sessionId;
  if (created.code !== 0 || typeof sessionId !== 'string') {
    throw new Failure('unknown', 'create_unconfirmed', `建 DSH 会话出错，说不清建没建成（再发同一个任务号会先找回来）：${created.error}`);
  }

  state.sessionId = sessionId;
  state.creating = false;
  saveState(folder, state);
}


/**
 * 这件任务最后一条排队发出、DSH 收下了的消息：等结果、确认停妥都看它之后的那一轮。
 * @param {object} state 任务的记录。
 * @returns {object | undefined} 没有是 undefined。
 */
function getLastQueued(state) {
  const queued = state.requests.filter((item) => item.mode === 'queue' && item.accepted === true);
  return queued.at(-1);
}


/**
 * 从回复里取 dsh-result：最后一个 ```dsh-result 代码块里的 JSON。
 * @param {string} reply DSH 这一轮的全部文字回复。
 * @returns {object | undefined} 没有、不是 JSON 对象是 undefined。
 */
function getResultBlock(reply) {
  const blocks = [...reply.matchAll(/```dsh-result\s*\n([\s\S]*?)```/gu)];
  const last = blocks.at(-1);
  if (last === undefined) return undefined;

  try {
    const value = JSON.parse(last[1]);
    if (typeof value !== 'object' || value === null) return undefined;

    return value;
  } catch {
    return undefined;
  }
}


/**
 * 一轮做完了：配上 DSH 记的实际模型，从回复里取 dsh-result，回复全文另存一份。
 * @param {object} base 输出的公共部分：taskId、sessionId、requestId。
 * @param {object} turn 客户端 wait --json 打的：model、turn、endReason、replies。
 * @param {string} folder 任务的记录目录。
 * @returns {object} 输出。
 * 副作用：写 .dispatch/<任务号>/reply-<轮>.md。
 */
function getFinished(base, turn, folder) {
  //M 实际模型：DSH 记的这场会话最近实际用的“供应商 / 模型 ID / 档”；没有（DSH 写“未知”）就是 unknown。
  const parts = String(turn.model ?? '').split(' / ');
  let actualModel = 'unknown';
  let actualThinking = 'unknown';
  if (parts.length >= 2) {
    actualModel = `${parts[0]}/${parts[1]}`;
  }
  if (parts.length >= 3) {
    actualThinking = parts[2];
  }

  //M 回复全文另存，输出里只留开头一段。
  const reply = (turn.replies ?? []).join('\n\n');
  const replyFile = path.join(folder, `reply-${String(turn.turn)}.md`);
  fs.writeFileSync(replyFile, reply);
  const result = getResultBlock(reply);

  //M 结论：这一轮没正常结束（出错、被停）算没做成；正常结束照 dsh-result 的 status；没交 dsh-result 算做完，子代理说不清。
  let state = 'completed';
  if (turn.endReason !== 'completed') {
    state = 'failed';
  }
  const claimed = result?.status;
  if (turn.endReason === 'completed' && RESULT_STATES.includes(claimed)) {
    state = claimed;
  }

  return {
    ...base,
    state,
    endReason: turn.endReason,
    actualModel,
    actualThinking,
    summary: result?.summary ?? '',
    subagents: result?.subagents ?? 'unknown',
    artifacts: result?.artifacts ?? [],
    verification: result?.verification ?? [],
    remaining: result?.remaining ?? [],
    reply: reply.slice(0, REPLY_MAX),
    replyFile,
  };
}


/**
 * 等这件任务最后一条排队消息的那一轮：等到做完、等人回答，或者时候到了。
 * @param {{ client: string }} settings getSettings 的。
 * @param {object} state 任务的记录（有 sessionId）。
 * @param {string} folder 任务的记录目录。
 * @param {number} waitMs 最多等多久；0 是只看一眼。
 * @returns {object} 输出：needs_input、running，或 getFinished 的。
 * @throws failed：还没发过任务书；unknown：客户端出错。
 */
function waitTurn(settings, state, folder, waitMs) {
  const last = getLastQueued(state);
  if (last === undefined) throw new Failure('failed', 'not_started', `任务 ${state.taskId} 还没往 DSH 交过任务书（或者都没收下），先 send`);

  const waitArgs = [
    'wait',
    '--session', state.sessionId,
    '--after-turn', String(last.afterTurn),
    '--timeout-ms', String(waitMs),
    '--json',
  ];
  const waited = callClient(settings.client, waitArgs, waitMs + CLIENT_SLACK_MS);
  const base = { taskId: state.taskId, sessionId: state.sessionId, requestId: last.requestId };

  //M 退出码 2：DSH 在等人回答问题或等审批。不代答，原样交回调用方。
  if (waited.code === 2) return { ...base, state: 'needs_input', waiting: waited.value };

  //M 退出码 3：时候到了还在做。会话号、requestId 都记着，过会儿再 status，不重发。
  if (waited.code === 3) return { ...base, state: 'running' };

  //G 别的出错：说不清做到哪了。
  if (waited.code !== 0 || waited.value === undefined) throw new Failure('unknown', 'wait_failed', `等 DSH 的结果出错：${waited.error}`);

  return getFinished(base, waited.value, folder);
}


/**
 * 命令行的 --wait-ms；没写用 fallback。
 * @param {string | undefined} text 命令行写的。
 * @param {number} fallback 没写时用的。
 * @returns {number} 毫秒。
 * @throws bad_args：不是不小于 0 的整数。
 */
function getWaitMs(text, fallback) {
  if (text === undefined) return fallback;

  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) throw new Failure('failed', 'bad_args', '--wait-ms 要写不小于 0 的整数毫秒');

  return value;
}


/**
 * send：交一份任务书。头一回定模型和档、建会话；以后接着同一场。先记 requestId 再发，发完按 --wait-ms 等结果。
 * @param {{ client: string, workspace: string, waitMs: number }} settings getSettings 的。
 * @param {object} options 命令行选项。
 * @returns {object} 输出：accepted（不等或插话），或 waitTurn 的。
 * @throws bad_args、model_conflict、not_accepted（failed）；capability_missing；unknown（说不清交没交上）。
 * 副作用：写 .dispatch/<任务号>/；DSH 里可能建会话、发消息。
 */
function sendTask(settings, options) {
  const folder = getTaskFolder(options.task);

  //G 任务书：要有、不空。
  const textFile = options['text-file'];
  if (textFile === undefined || !fs.existsSync(textFile)) throw new Failure('failed', 'bad_args', '--text-file 要写任务书文件的路径');

  const body = fs.readFileSync(textFile, 'utf8').trim();
  if (body === '') throw new Failure('failed', 'bad_args', `任务书 ${textFile} 是空的`);

  //M 记录：头一回新起一份，要写 --model；档不写取 DSH 这个模型的次高档。
  let state = readState(folder);
  if (state === undefined && options.model === undefined) throw new Failure('failed', 'bad_args', '头一回发要写 --model 供应商/模型（用 models 看有哪些）');

  if (state === undefined) {
    const catalog = getCatalog(settings.client);
    const effort = getEffort(catalog, options.model, options.effort);
    state = { taskId: options.task, workspace: settings.workspace, model: options.model, effort, creating: false, requests: [] };
    saveState(folder, state);
  }

  //G 接着发：模型、档、工作区要和头一回一样；要换就换个任务号开新的一场（不同模型用不同的 DSH 会话）。
  const changedModel = options.model !== undefined && options.model !== state.model;
  const changedEffort = options.effort !== undefined && options.effort !== state.effort;
  const changedWorkspace = settings.workspace !== state.workspace;
  if (changedModel || changedEffort || changedWorkspace) {
    const message = `任务 ${state.taskId} 用的是 ${state.workspace} 工作区的 ${state.model} / ${state.effort}，不能换；要换就换个任务号开新的一场`;
    throw new Failure('failed', 'model_conflict', message);
  }

  ensureSession(settings, state, folder);

  //M 消息：任务书加上交回要求；--steer 是插进正在跑的那一轮，平常排队。
  const text = `${body}\n${RESULT_RULE}`;
  let mode = 'queue';
  let command = 'send';
  if (options.steer) {
    mode = 'steer';
    command = 'steer';
  }
  const hash = crypto.createHash('sha256').update(`${mode}\n${text}`).digest('hex').slice(0, 16);

  //M requestId：同样的内容上次说不清交没交上，沿用它的（DSH 认同一个 requestId 是同一条，不会派两次）；不然新起一个。先记下再发。
  let request = state.requests.find((item) => item.hash === hash && item.accepted === null);
  if (request === undefined) {
    request = { requestId: crypto.randomUUID(), hash, mode, accepted: null };
    state.requests.push(request);
  }
  saveState(folder, state);

  //M 发：正文写进文件交给客户端（长文放不进命令行）。
  const promptFile = path.join(folder, `${request.requestId}.md`);
  fs.writeFileSync(promptFile, text);
  const sendArgs = [
    command,
    '--session', state.sessionId,
    '--text-file', promptFile,
    '--request-id', request.requestId,
  ];
  const sent = callClient(settings.client, sendArgs, CLIENT_SHORT_MS);

  //G 客户端出错：说不清交没交上（网络断了不代表没收）。requestId 留着，原样重发会沿用它。
  if (sent.code !== 0 || sent.value === undefined) {
    throw new Failure('unknown', 'send_unconfirmed', `往 DSH 发任务书出错，说不清交没交上（原样重发会沿用 requestId ${request.requestId}）：${sent.error}`);
  }

  //M 记下 DSH 收没收、发之前已有几轮（等的就是它之后那一轮）。
  request.accepted = sent.value.accepted === true;
  request.afterTurn = sent.value.afterTurn;
  saveState(folder, state);
  if (!request.accepted) throw new Failure('failed', 'not_accepted', `DSH 没收下这条消息（requestId ${request.requestId}）`);

  //M 插话、不等：交出去就回。accepted 只表示 DSH 收下了，不表示子代理开了。
  const waitMs = getWaitMs(options['wait-ms'], settings.waitMs);
  if (mode === 'steer' || waitMs === 0) {
    return { state: 'accepted', taskId: state.taskId, sessionId: state.sessionId, requestId: request.requestId, model: state.model, effort: state.effort };
  }

  return waitTurn(settings, state, folder, waitMs);
}


/**
 * status：看这件任务到哪了；--wait-ms 给了就等这么久，不给只看一眼。
 * @param {{ client: string }} settings getSettings 的。
 * @param {object} options 命令行选项。
 * @returns {object} waitTurn 的输出。
 * @throws not_started：这件还没在 DSH 建会话。
 */
function statusTask(settings, options) {
  const folder = getTaskFolder(options.task);
  const state = readState(folder);
  if (state?.sessionId === undefined) throw new Failure('failed', 'not_started', `任务 ${options.task} 还没在 DSH 建会话，先 send`);

  const waitMs = getWaitMs(options['wait-ms'], 0);
  return waitTurn(settings, state, folder, waitMs);
}


/**
 * cancel：叫 DSH 停下这件任务的会话，再看几次状态确认。已经做了的不回滚。
 * 停妥要两样：DSH 不在跑；这件任务最后排队发的那条已经做过（队列里没有它排着）。确认不了就是 pause_unconfirmed。
 * @param {{ client: string, workspace: string }} settings getSettings 的。
 * @param {object} options 命令行选项。
 * @returns {Promise<object>} 输出：stopped 或 pause_unconfirmed。
 * @throws not_started；unknown：喊停出错。
 * 副作用：DSH 的 session/cancel。
 */
async function cancelTask(settings, options) {
  const folder = getTaskFolder(options.task);
  const state = readState(folder);
  if (state?.sessionId === undefined) throw new Failure('failed', 'not_started', `任务 ${options.task} 还没在 DSH 建会话，没什么可停的`);

  const cancelled = callClient(settings.client, ['cancel', '--session', state.sessionId], CLIENT_SHORT_MS);
  if (cancelled.code !== 0) throw new Failure('unknown', 'cancel_failed', `叫 DSH 停下出错：${cancelled.error}`);

  //M 喊了停不等于停妥：隔一会儿看一次状态，看几次。
  const base = { taskId: state.taskId, sessionId: state.sessionId };
  const last = getLastQueued(state);
  const statusArgs = ['status', '--session', state.sessionId, '--workspace', state.workspace];
  for (let index = 0; index < STOP_CHECKS; index += 1) {
    await timers.setTimeout(STOP_INTERVAL_MS);
    const checked = callClient(settings.client, statusArgs, CLIENT_SHORT_MS);
    const status = checked.value;
    const idle = checked.code === 0 && status?.running === false;
    const consumed = last === undefined || (status?.endedTurn ?? 0) > last.afterTurn;
    if (idle && consumed) return { ...base, state: 'stopped', note: '已经停下；已经做了的不回滚' };
  }

  return { ...base, state: 'pause_unconfirmed', note: '喊了停，但确认不了 DSH 已经停下、队列里没有这件任务排着的消息；已经做了的不回滚，过会儿用 status 再看' };
}


/**
 * 照命令行的动作做一件事。
 * @returns {Promise<object>} 要打出去的输出。
 * @throws Failure：见各动作；parseArgs 认不出的选项抛它自己的错。
 */
async function main() {
  const parsed = util.parseArgs({ options: OPTIONS, allowPositionals: true, strict: true });
  const action = parsed.positionals[0];
  const options = parsed.values;
  const settings = getSettings();

  //M models：DSH 能用的模型和档位，带次高档。
  if (action === 'models') {
    const catalog = getCatalog(settings.client);
    const models = catalog.map((item) => ({ ...item, second: getSecond(item.efforts) ?? '定不了' }));
    return { state: 'ok', workspace: settings.workspace, models };
  }

  //M send、status、cancel：交任务书、看到哪了、喊停。
  if (action === 'send') return sendTask(settings, options);

  if (action === 'status') return statusTask(settings, options);

  if (action === 'cancel') return cancelTask(settings, options);

  throw new Failure('failed', 'bad_args', `不认识的动作 ${String(action)}：用 models、send、status、cancel`);
}


/**
 * 出错时的输出：带上已知的任务号、会话号，和原因代号、原因。
 * @param {unknown} error 抛出来的错。
 * @returns {object}
 */
function getFailureOutput(error) {
  if (error instanceof Failure) {
    return { state: error.state, ...context, error: { code: error.code, message: error.message } };
  }

  //M 别的错（参数认不出、记录文件坏了）：算没做成，原样说原因。
  return { state: 'failed', ...context, error: { code: 'script_error', message: String(error?.message ?? error) } };
}


//M 跑一次，只打一份 JSON。
let output;
try {
  output = await main();
} catch (error) {
  output = getFailureOutput(error);
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
