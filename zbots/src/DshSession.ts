/** ask_dsh 会话提交：三模式、工作区归属、请求留证和有界 CLI；不保存“最近会话”，不自动重试外部副作用。 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as bounded from './BoundedProcess.ts';


/** 已校验的工具输入；current 永远表示调用方传入的配置默认会话。 */
export interface SessionRequest {
  /** 任务正文，非空且不超过 64 KiB UTF-8。 */
  task: string;
  /** 会话选择方式；缺省 current。 */
  session_mode?: 'current' | 'new' | 'specified';
  /** specified 必填，其余模式禁止填写。 */
  session_id?: string;
  /** 同一请求的重试必须沿用；省略则首次生成并在回执返回。 */
  request_id?: string;
}


/** 只由宿主装配，模型不能传入可执行文件、环境或时限。 */
export interface SessionOptions {
  /** CLI 路径；默认项目 ztools/dsh-control/Dsh_Control.mjs。 */
  controlScript?: string;
  /** 可执行文件；默认 node，不经过 shell。 */
  executable?: string;
  /** 整次 create/status/send 的总运行预算，默认 90000 毫秒，另加最多 2250 毫秒回收。 */
  timeoutMs?: number;
  /** 状态/发送命令上限，默认 15000 毫秒。 */
  commandTimeoutMs?: number;
  /** 创建会话需等待 DSH 初始化，上限默认 60000 毫秒，仍受整体预算限制。 */
  createTimeoutMs?: number;
  /** 隔离验收使用的进程环境；不记录、不输出。 */
  env?: NodeJS.ProcessEnv;
  /** 离线测试注入有界客户端；生产默认 runBounded。 */
  run?: typeof bounded.runBounded;
  /** 仅受信任验收入口使用原始无副作用任务，模型工具不暴露此参数。 */
  rawTask?: boolean;
}


/** 可留盘的提交事实，不等于任务执行结果。 */
export interface SubmissionReceipt {
  /** 受理、拒绝、忙、输入错误、控制失败或外部状态不明。 */
  status: 'accepted' | 'rejected' | 'busy' | 'invalid' | 'control_error' | 'creation_unknown' | 'submission_unknown';
  /** 稳定机器错误码或 queued。 */
  code: string;
  /** 只有验证过 accepted=true 且 ID 一致才为 true。 */
  accepted: boolean;
  /** 提交接口不证明执行完成，固定 false。 */
  completed: false;
  /** 本地记录和 DSH prompt 共用的请求标识。 */
  requestId: string;
  /** 真实创建成功或本次指定的会话 ID；尚不明确时为 null。 */
  sessionId: string | null;
  /** 实际选择模式。 */
  sessionMode: 'current' | 'new' | 'specified';
  /** 安全中文说明，不拼接控制器 stderr/异常原文。 */
  message: string;
  /** 北京时间 17 位时间戳。 */
  timestamp: string;
  /** 任务文件绝对路径；尚未落盘时为 null。 */
  taskFile: string | null;
  /** 持久回执绝对路径；尚未落盘时为 null。 */
  receiptFile: string | null;
  /** 本地输入指纹，防止相同请求 ID 用于另一项任务。 */
  fingerprint: string;
  /** 新建阶段安全留证文件，只有阶段、时间及 create 返回的 ID。 */
  traceFile?: string;
  /** 创建过程中最后写下的阶段，不包含 RPC 或认证原文。 */
  createPhase?: string;
  /** 正常受理返回 queue；其他情况不填写。 */
  mode?: 'queue';
  /** CLI 提交前观察到的轮数，不是本任务完成轮数。 */
  afterTurn?: number;
}


/** 严格限制为 DSH 实际 session UUID，避免路径和 shell 字符混入。 */
const sessionPattern = /^session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** 请求 ID 用于目录名，只允许 UUID 或简单关联标识。 */
const requestPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;


/** 将工具输入校验为三模式请求；错误在写文件及启动控制器前抛出。 */
export function parseRequest(args: Record<string, unknown>): SessionRequest {
  if (typeof args.task !== 'string' || !args.task.trim()) {
    throw new Error('ask_dsh 的 task 要写非空文字。');
  }
  if (Buffer.byteLength(args.task) > 64 * 1024) {
    throw new Error('ask_dsh 的 task 超过 64 KiB。');
  }
  const mode = args.session_mode ?? 'current';
  if (mode !== 'current' && mode !== 'new' && mode !== 'specified') {
    throw new Error('session_mode 只能是 current、new 或 specified。');
  }
  if (mode === 'specified') {
    if (typeof args.session_id !== 'string' || !sessionPattern.test(args.session_id)) {
      throw new Error('specified 必须填写合法的 session_id。');
    }
  } else if (args.session_id !== undefined) {
    throw new Error('只有 specified 可以填写 session_id。');
  }
  if (args.request_id !== undefined && (typeof args.request_id !== 'string' || !requestPattern.test(args.request_id))) {
    throw new Error('request_id 需要 8–96 位字母、数字、下划线或连字符。');
  }
  return { task: args.task, session_mode: mode, session_id: args.session_id, request_id: args.request_id };
}


/** 输出文件的时间显式固定北京时间，不依赖进程所在时区。 */
export function beijingStamp(date = new Date()): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().replace(/[-T:.Z]/g, '');
}


/** 只接受 JSON 对象，忽略控制器输出的未知字段，不回传原文。 */
function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}


/** 对外只渲染白名单字段，unknown 明确不允许换会话或换 ID 重发。 */
export function describeReceipt(receipt: SubmissionReceipt): string {
  return JSON.stringify(receipt);
}


/**
 * 提交一次 ask_dsh；先落请求证据，再执行有界 create/status/send，最后保存回执。
 * @param runtimeDir 运行目录，只有 feishu/dsh_requests 会产生文件。
 * @param defaultSession 已配置默认会话，不写回配置，不因 new/specified 改变。
 * @param input 工具参数；兼容仅 task。
 * @param options 宿主依赖与验收选项，模型无法覆盖。
 * @returns 提交事实。未知提交不会自动重试，重复 request_id 仅返回保存的事实。
 */
export async function submitTask(runtimeDir: string, defaultSession: string | undefined, input: SessionRequest, options: SessionOptions = {}): Promise<SubmissionReceipt> {
  const request = parseRequest(input as unknown as Record<string, unknown>);
  /** 本次请求不可变的关联 ID、时间及目标，不使用跨聊天共享的“最近会话”。 */
  const requestId = request.request_id ?? crypto.randomUUID();
  const timestamp = beijingStamp();
  const sessionMode = request.session_mode ?? 'current';
  let sessionId: string | null = null;
  if (sessionMode === 'current') {
    sessionId = defaultSession || null;
  } else if (sessionMode === 'specified') {
    sessionId = request.session_id ?? null;
  }
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([request.task, sessionMode, sessionId, options.rawTask === true])).digest('hex');
  /** 回执只保存业务白名单，不含配置、环境、stderr 或远端异常原文。 */
  let receipt: SubmissionReceipt = {
    status: 'invalid', code: 'invalid_session', accepted: false, completed: false, requestId, sessionId, sessionMode,
    message: '', timestamp, taskFile: null, receiptFile: null, fingerprint,
  };
  if (sessionMode !== 'new' && (!sessionId || !sessionPattern.test(sessionId))) {
    receipt.message = '尚未配置合法 DSH 默认会话，或 session_id 无效；未转发。可显式选择 new。';
    receipt.code = sessionId ? 'invalid_session' : 'missing_default';
    return receipt;
  }

  // g: 每个请求 ID 独占一个目录；重放只读回执，绝不再次 create/send。
  const requestDir = path.resolve(runtimeDir, 'feishu', 'dsh_requests', requestId);
  await fs.mkdir(path.dirname(requestDir), { recursive: true });
  /** mkdir 是请求占用的原子动作；错误只取代码，不把潜在敏感路径带进异常链。 */
  let reserveError: string | undefined;
  try {
    await fs.mkdir(requestDir);
  } catch (error) {
    reserveError = (error as NodeJS.ErrnoException).code ?? 'filesystem_error';
  }
  if (reserveError && reserveError !== 'EEXIST') {
    throw new Error('无法建立 DSH 请求记录，未提交。');
  }
  if (reserveError === 'EEXIST') {
    const names = await fs.readdir(requestDir);
    const recorded = names.find((name) => /^receipt_\d{17}\.json$/.test(name));
    if (recorded) {
      try {
        const file = path.join(requestDir, recorded);
        if ((await fs.stat(file)).size > 64 * 1024) {
          throw new Error('记录过大');
        }
        const previous = objectValue(JSON.parse(await fs.readFile(file, 'utf8')));
        if (previous.fingerprint !== fingerprint) {
          return { ...receipt, code: 'request_conflict', message: 'request_id 已用于不同任务或会话；未重新提交。' };
        }
        if (previous.requestId === requestId && previous.receiptFile === file && typeof previous.message === 'string') {
          return previous as unknown as SubmissionReceipt;
        }
      } catch {
        // g: 损坏或半写记录不能触发重发，下面统一返回状态不明。
      }
    }
    return { ...receipt, status: 'submission_unknown', code: 'request_in_progress_or_interrupted',
      message: '相同 request_id 正在提交或记录曾中断，状态不明；未重发，不要换 ID 或换会话重试。' };
  }

  const taskFile = path.join(requestDir, `task_${timestamp}.md`);
  const receiptFile = path.join(requestDir, `receipt_${timestamp}.json`);
  receipt = { ...receipt, taskFile, receiptFile, status: 'submission_unknown', code: 'reserved',
    message: '请求已留证，提交状态尚不明确；禁止自动新建或重发。' };
  /** 每个外部副作用之前保存保守状态，崩溃恢复只能读取它，不猜测未提交。 */
  async function save(): Promise<SubmissionReceipt> {
    try {
      await fs.writeFile(receiptFile, JSON.stringify(receipt, null, 2));
    } catch {
      throw new Error(`DSH 回执保存失败；请求 ${requestId}、会话 ${receipt.sessionId ?? '未知'} 状态不明，禁止自动重发。`);
    }
    return receipt;
  }
  await save();
  const prompt = options.rawTask ? request.task : [
    '用户在飞书里找周小灵，周小灵判断下面这件事该你（DSH）做：',
    '先读 F:/aidata/source/jmai/zbots/docs/03_交接.md 第2节；做完或需用户拿主意时，用 feishu-send 回用户。不要联系 Claude。',
    '硬约束：不得删除 jmai 以外的数据；F:/aidata/AIZbots 是运行时可写。禁止打开、打印或复制 F:/aidata/AIZbots/config.yaml 和 F:/aidata/source/jmai/ztools/dsh-control/.env。',
    '', '任务和用户原话：', request.task,
  ].join('\n');
  await fs.writeFile(taskFile, prompt, { flag: 'wx' });

  /** 整体截止时间不因命令阶段变化而重新计时；回收另有固定上限。 */
  const deadline = performance.now() + (options.timeoutMs ?? 90_000);
  const run = options.run ?? bounded.runBounded;
  const controlScript = options.controlScript ?? path.resolve(import.meta.dir, '../../ztools/dsh-control/Dsh_Control.mjs');
  /** 控制器单次结果；失败只保留状态码，丢弃任意 stdout/stderr 原文。 */
  async function control(args: string[]): Promise<Record<string, unknown>> {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) {
      throw new Error('timeout');
    }
    const commandBudget = args[0] === 'create' ? options.createTimeoutMs ?? 60_000 : options.commandTimeoutMs ?? 15_000;
    const result = await run(options.executable ?? 'node', [controlScript, ...args, '--workspace', 'jmai'], {
      timeoutMs: Math.min(remaining, commandBudget), maxOutputBytes: 64 * 1024, env: options.env,
    });
    if (result.status !== 'exited') {
      throw new Error(result.status);
    }
    if (result.exitCode !== 0) {
      throw new Error('control_exit');
    }
    try {
      return objectValue(JSON.parse(result.stdout));
    } catch {
      throw new Error('invalid_receipt');
    }
  }

  /** 当前处于哪类外部动作，用于决定超时是否可能已产生副作用。 */
  let phase: 'create' | 'status' | 'send' = 'status';
  try {
    if (sessionMode === 'new') {
      phase = 'create';
      receipt = { ...receipt, status: 'creation_unknown', code: 'creating', message: '新建请求已发起，结果不明时禁止自动再建。' };
      await save();
      receipt.traceFile = path.join(requestDir, `create_${timestamp}.jsonl`);
      const created = await control(['create', '--title', `ask_dsh ${timestamp} ${requestId}`, '--model', 'astra', '--effort', 'max', '--trace-file', receipt.traceFile]);
      if (typeof created.sessionId !== 'string' || !sessionPattern.test(created.sessionId) || created.workspace !== 'jmai') {
        throw new Error('invalid_create_receipt');
      }
      sessionId = created.sessionId;
      receipt = { ...receipt, sessionId, status: 'submission_unknown', code: 'created', message: '已新建会话，任务尚未确认受理。' };
      await save();
    }
    if (!sessionId) {
      throw new Error('invalid_session');
    }
    phase = 'status';
    const state = await control(['status', '--session', sessionId]);
    if (state.sessionId !== sessionId || state.workspace !== 'jmai' || state.belongs !== true) {
      receipt = { ...receipt, status: 'rejected', code: 'session_not_owned', message: '无法确认会话属于 jmai 且未归档；未发送任务。' };
      return await save();
    }
    if (typeof state.running !== 'boolean' || typeof state.questions !== 'number' || typeof state.approvals !== 'number') {
      throw new Error('invalid_status');
    }
    if (state.running || state.questions > 0 || state.approvals > 0) {
      receipt = { ...receipt, status: 'busy', code: 'session_busy', message: '会话忙碌或等待交互，未发送任务；忙不等于卡死。需要并行处理请明确选择 new。' };
      return await save();
    }
    // m: 状态检查与提交有竞态，send 使用 queue，回执只能确认受理，不能宣称开始或完成。
    phase = 'send';
    receipt = { ...receipt, status: 'submission_unknown', code: 'sending', message: '正在提交；如通信中断，任务可能已受理，禁止自动重发。' };
    await save();
    const sent = await control(['send', '--session', sessionId, '--text-file', taskFile, '--request-id', requestId]);
    if (sent.sessionId !== sessionId || sent.requestId !== requestId || sent.mode !== 'queue') {
      throw new Error('receipt_id_mismatch');
    }
    if (sent.accepted === false) {
      receipt = { ...receipt, status: 'rejected', code: 'not_accepted', message: 'DSH 明确返回 accepted=false，未确认受理；不冒充成功。' };
    } else if (sent.accepted === true && Number.isSafeInteger(sent.afterTurn) && (sent.afterTurn as number) >= 0) {
      receipt = { ...receipt, status: 'accepted', code: 'queued', accepted: true, mode: 'queue', afterTurn: sent.afterTurn as number,
        message: 'DSH 已排队受理，仅确认提交，未确认开始或执行完成；完成后另行回报。' };
    } else {
      throw new Error('invalid_receipt');
    }
  } catch (error) {
    const allowed = new Set(['timeout', 'output_limit', 'spawn_error', 'cleanup_failed', 'control_exit', 'invalid_receipt', 'invalid_create_receipt', 'invalid_status', 'receipt_id_mismatch']);
    const code = error instanceof Error && allowed.has(error.message) ? error.message : 'control_error';
    let status: SubmissionReceipt['status'] = 'control_error';
    let message = '会话状态读取失败或超时，未发送任务；未自动重试。';
    if (phase === 'create') {
      // g: 只从本请求的有界白名单阶段记录恢复已返回的 ID，绝不根据时间或其他空会话推测。
      if (receipt.traceFile) {
        try {
          if ((await fs.stat(receipt.traceFile)).size <= 8192) {
            const trace = await fs.readFile(receipt.traceFile, 'utf8');
            for (const line of trace.trim().split('\n')) {
              const record = objectValue(JSON.parse(line));
              if (typeof record.phase === 'string' && ['workspace', 'create', 'rename', 'model', 'permission', 'ready'].includes(record.phase)) {
                receipt.createPhase = record.phase;
                if (typeof record.sessionId === 'string' && sessionPattern.test(record.sessionId)) {
                  receipt.sessionId = record.sessionId;
                }
              }
            }
          }
        } catch {
          // g: 阶段证据读取失败也保持 unknown，不能启动新的控制请求。
        }
      }
      status = 'creation_unknown';
      message = '新建控制请求失败或超时，可能已建立会话；任务未发送，禁止自动新建并重发。';
    } else if (phase === 'send') {
      status = 'submission_unknown';
      message = '提交状态不明，任务可能已受理；已停止等待本地客户端不等于取消 DSH 任务。保留 requestId，禁止自动换会话或换 ID 重发。';
    }
    receipt = { ...receipt, status, code, message };
  }
  return save();
}
