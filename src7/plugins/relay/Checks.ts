/**
 * 外部 AI 接入 relay 时进来的两样东西的校验：打招呼报的能力（hello 接口）、交回的结果（result 接口、result.json）。
 * 只有 relay 用，所以放在这里；字段怎么查借骨架 utils/Checks.ts 的 record、list、text、texts、oneOf。
 */
import * as path from 'node:path';
import * as checks from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';


/** 外部 AI 交回结果的两种办法：http 调 result 接口；file 写任务文件夹里的 result/result.json，jmbots 定时扫。 */
export const RETURN_MODES = ['http', 'file'] as const;
export type ReturnMode = typeof RETURN_MODES[number];

/** 外部 AI 会用的一个模型。 */
export interface AgentModel {
  /** 模型 ID，照它自己客户端里的写法。 */
  id: string;
  /** 这个模型在它那边能设的思考档，从低到高；次高档是去掉 off 以后的倒数第二个。 */
  efforts: string[];
}

/** 外部 AI 打招呼时报的能力。派活时照它定模型、思考档，查能不能开子代理。 */
export interface AgentAbilities {
  /** 会用的模型，第一个是它默认用的。 */
  models: AgentModel[];
  /** 能不能真的开子代理。 */
  subagents: boolean;
  /** 结果怎么交回。 */
  returnMode: ReturnMode;
}

/** POST /api/agents/:name/hello 的正文，校验后。 */
export interface AgentHello {
  /** 一句话说会做什么；空串是没写，留旧的。 */
  description: string;
  /** 报的能力；没写 models 是没报，留旧的。 */
  abilities?: AgentAbilities;
}


/**
 * 校验外部 AI 打招呼的正文。relay 任务通道的 hello 接口（relay/TaskRoutes.ts）调，查过以后 AgentTasks.hello 直接用。
 * @param body 请求正文，原样；没有正文当空的。
 * @returns 说明和能力；没写 models 就不带 abilities。
 * @throws 哪一项不对就抛错，说清是哪一项、该怎么写。
 */
export function checkAgentHello(body: unknown): AgentHello {
  //M 允许空请求体兜底为对象，校验描述文字和可选的模型能力列表。
  const item = checks.checkRecord(body ?? {}, 'hello 的正文');

  //M description：可以不写，写了要是文字。
  const description = item['description'] ?? '';
  if (typeof description !== 'string') {
    throw new failureModule.Failure(400, 'description 要写成文字（可以不写）');
  }

  //M 没写 models：只是打招呼，能力留旧的。
  if (item['models'] === undefined) return { description };

  //M models：每项 { id, efforts }，efforts 从低到高写。
  const models: AgentModel[] = [];
  const written = checks.checkArray(item['models'], 'models');
  for (const [index, raw] of written.entries()) {
    const label = `models[${String(index)}]`;
    const model = checks.checkRecord(raw, label);
    const id = checks.checkNonEmptyText(model['id'], `${label}.id`);
    const efforts = checks.checkNonEmptyTextList(model['efforts'], `${label}.efforts`);
    models.push({ id, efforts });
  }

  //M subagents：能不能开子代理，不写当不能；returnMode：不写是 http。
  const subagents = checks.checkFlag(item['subagents'] ?? false, 'subagents');
  //G 限制结果交回方式只取已知枚举值（默认 http）。
  const returnMode = checks.checkAllowedValue(item['returnMode'] ?? 'http', RETURN_MODES, 'returnMode');

  return { description, abilities: { models, subagents, returnMode } };
}


/** 外部 AI 交回的结论。completed 做完了；failed 没做成；capability_missing 缺能力（设不了模型、思考档，开不了子代理），没动手。 */
export const RESULT_STATUSES = ['completed', 'failed', 'capability_missing'] as const;

/** 一项检查跑出来怎样。 */
export const CHECK_OUTCOMES = ['passed', 'failed', 'not_run'] as const;

/** 实际开的一个子代理。核实不了的项写 unknown，不拿要求的值冒充。 */
export interface ActualSubagent {
  /** 子代理在执行端的真实 ID。 */
  id: string;
  /** 它负责什么。 */
  responsibility: string;
  /** 它实际用的模型。 */
  model: string;
  /** 它实际用的思考档。 */
  thinking: string;
}

/** 实际怎么执行的。核实不了的项写 unknown。 */
export interface ActualExecution {
  /** 哪个客户端执行的（Claude Code、Codex、DSH……）。 */
  host: string;
  /** 主会话 ID。 */
  sessionId: string;
  /** 任务要求的模型。 */
  requestedModel: string;
  /** 任务要求的思考档。 */
  requestedThinking: string;
  /** 实际用的模型。 */
  actualModel: string;
  /** 实际用的思考档。 */
  actualThinking: string;
  /** 实际开的子代理。 */
  subagents: ActualSubagent[];
}

/** 交回的一个文件。 */
export interface ResultArtifact {
  /** 相对任务文件夹 result/artifacts/ 的路径。 */
  path: string;
  /** 文件内容的 SHA-256，64 位小写十六进制。 */
  sha256: string;
  /** 这是什么。 */
  description: string;
}

/** 做过的一项检查。 */
export interface ResultCheck {
  /** 查的什么（命令、步骤）。 */
  check: string;
  /** 结果。 */
  outcome: typeof CHECK_OUTCOMES[number];
}

/** 外部 AI 交回的结果（result/result.json，或 POST result 正文里的 protocolResult），校验后。 */
export interface TaskResult {
  /** 协议版本，固定 1。 */
  version: 1;
  /** 固定 result。 */
  kind: 'result';
  /** 任务号。 */
  taskId: string;
  /** 领取时的 claimKey。 */
  claimKey: string;
  /** 结果键：<任务号>/<claimKey>/result。 */
  resultKey: string;
  /** 结论。 */
  status: typeof RESULT_STATUSES[number];
  /** 具体结论：做了什么、结果怎样，或为什么没做成。 */
  summary: string;
  /** 实际怎么执行的。 */
  actualExecution: ActualExecution;
  /** 交回的文件。 */
  artifacts: ResultArtifact[];
  /** 做过的检查。 */
  verification: ResultCheck[];
  /** 还没做完的事。 */
  remaining: string[];
  /** 缺的能力（status 是 capability_missing 时写）。 */
  capabilityMissing: string[];
}

/** SHA-256 的写法：64 位小写十六进制。 */
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;


/**
 * 校验外部 AI 交回的结果。relay 任务通道的 result 接口、定时扫 result.json 时调（relay/AgentTasks.ts），查过以后 AgentTasks.finish 直接用。
 * 只查形状和路径安全；任务号、claimKey 对不对得上，文件在不在、SHA-256 对不对，由 finish 对着任务查。
 * @param body result.json 的内容，或 protocolResult，原样。
 * @returns 结果；artifacts、verification、remaining、capabilityMissing 没写是空的，resultKey 没写照规则补。
 * @throws 哪一项不对就抛错，说清是哪一项、该怎么写。
 */
export function checkTaskResult(body: unknown): TaskResult {
  //M 先确认回传正文是键值对象，再核对协议版本、任务号与附件字段。
  const item = checks.checkRecord(body, '结果');

  //G 版本和种类：只认 v1 的 result。
  if (item['version'] !== 1 || item['kind'] !== 'result') {
    throw new failureModule.Failure(400, '结果要写 version: 1、kind: "result"');
  }

  //M 任务号、领取键、结论、具体结论。
  const taskId = checks.checkNonEmptyText(item['taskId'], 'taskId');
  const claimKey = checks.checkNonEmptyText(item['claimKey'], 'claimKey');
  const status = checks.checkAllowedValue(item['status'], RESULT_STATUSES, 'status');
  const summary = checks.checkNonEmptyText(item['summary'], 'summary');

  //G resultKey 只有一种写法；没写就补上。
  const resultKey = `${taskId}/${claimKey}/result`;
  const writtenKey = item['resultKey'] ?? resultKey;
  if (writtenKey !== resultKey) {
    throw new failureModule.Failure(400, `resultKey 要写成 ${resultKey}（任务号/claimKey/result）`);
  }

  //M actualExecution：每项都要写，核实不了写 unknown。
  const actual = checks.checkRecord(item['actualExecution'], 'actualExecution');
  const subagents: ActualSubagent[] = [];
  for (const [index, raw] of checks.checkArray(actual['subagents'] ?? [], 'actualExecution.subagents').entries()) {
    const label = `actualExecution.subagents[${String(index)}]`;
    const subagent = checks.checkRecord(raw, label);
    subagents.push({
      id: checks.checkNonEmptyText(subagent['id'], `${label}.id`),
      responsibility: checks.checkNonEmptyText(subagent['responsibility'], `${label}.responsibility`),
      model: checks.checkNonEmptyText(subagent['model'], `${label}.model`),
      thinking: checks.checkNonEmptyText(subagent['thinking'], `${label}.thinking`),
    });
  }
  //M 逐项校验执行端实际记录的主机、会话及请求/实际模型档字段是否为非空文字。
  const actualExecution: ActualExecution = {
    host: checks.checkNonEmptyText(actual['host'], 'actualExecution.host'),
    sessionId: checks.checkNonEmptyText(actual['sessionId'], 'actualExecution.sessionId'),
    requestedModel: checks.checkNonEmptyText(actual['requestedModel'], 'actualExecution.requestedModel'),
    requestedThinking: checks.checkNonEmptyText(actual['requestedThinking'], 'actualExecution.requestedThinking'),
    actualModel: checks.checkNonEmptyText(actual['actualModel'], 'actualExecution.actualModel'),
    actualThinking: checks.checkNonEmptyText(actual['actualThinking'], 'actualExecution.actualThinking'),
    subagents,
  };

  //M artifacts：路径只能是 result/artifacts/ 里的相对路径（不许绝对路径、不许 ..），SHA-256 写对格式。
  const artifacts: ResultArtifact[] = [];
  for (const [index, raw] of checks.checkArray(item['artifacts'] ?? [], 'artifacts').entries()) {
    const label = `artifacts[${String(index)}]`;
    const artifact = checks.checkRecord(raw, label);
    const file = checks.checkNonEmptyText(artifact['path'], `${label}.path`);
    const parts = file.split(/[\\/]/u);
    if (path.isAbsolute(file) || path.win32.isAbsolute(file) || parts.includes('..')) {
      throw new failureModule.Failure(400, `${label}.path 要写相对 result/artifacts/ 的路径，不能是绝对路径、不能有 ..`);
    }
    //G 校核交付物的校验和格式及一句话描述，随后登记到结果列表。
    const sha256 = checks.checkNonEmptyText(artifact['sha256'], `${label}.sha256`);
    if (!SHA256_PATTERN.test(sha256)) {
      throw new failureModule.Failure(400, `${label}.sha256 要写成 64 位小写十六进制`);
    }
    //M 校验交付物的一句话描述为非空文字，再写入结果数组。
    const description = checks.checkNonEmptyText(artifact['description'], `${label}.description`);
    artifacts.push({ path: file, sha256, description });
  }

  //M verification：每项 { check, outcome }。
  const verification: ResultCheck[] = [];
  for (const [index, raw] of checks.checkArray(item['verification'] ?? [], 'verification').entries()) {
    const label = `verification[${String(index)}]`;
    const check = checks.checkRecord(raw, label);
    verification.push({
      check: checks.checkNonEmptyText(check['check'], `${label}.check`),
      outcome: checks.checkAllowedValue(check['outcome'], CHECK_OUTCOMES, `${label}.outcome`),
    });
  }

  //M remaining、capabilityMissing：文字清单，可以不写。
  const remaining = checks.checkNonEmptyTextList(item['remaining'] ?? [], 'remaining');
  const capabilityMissing = checks.checkNonEmptyTextList(item['capabilityMissing'] ?? [], 'capabilityMissing');

  return {
    version: 1,
    kind: 'result',
    taskId,
    claimKey,
    resultKey,
    status,
    summary,
    actualExecution,
    artifacts,
    verification,
    remaining,
    capabilityMissing,
  };
}
