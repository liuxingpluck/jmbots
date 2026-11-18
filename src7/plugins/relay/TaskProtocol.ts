/**
 * 外部 AI 任务协议 v1（relay 插件的任务通道用）：
 * 任务单 TaskSpec（写成任务文件夹里的 task.json）、存在 agent_tasks.protocol 列里的 Protocol，
 * 和派活时定执行配置（模型、次高思考档、子代理）、拼可读任务书、算内容摘要这几样没状态的小函数。
 * 交回结果的形状 TaskResult、打招呼报的能力 AgentAbilities 在 Checks.ts（外面进来的东西在那里查）。
 * 设计见同目录 说明.md 的「设计要点」一节（外部任务协议 v1）。
 */
import * as crypto from 'node:crypto';
import type { ReturnMode, TaskResult } from './Checks.ts';
import type { Origin } from '../bots/index.ts';
import type { AgentInfo } from './AgentTasks.ts';


/** 任务单里的一个子代理：执行者必须真的开出来，交回时报真实 ID。 */
export interface SubagentSpec {
  /** 子代理叫什么。 */
  name: string;
  /** 它负责什么。 */
  responsibility: string;
  /** 它用的模型。 */
  model: string;
  /** 它的思考档。 */
  thinking: string;
  /** 它负责改的文件；没分就是空的。 */
  ownership: string[];
}


/** 任务单怎么执行：模型、思考档、子代理，以及这些是照什么定的。 */
export interface ExecutionSpec {
  /** 主执行的模型 ID，照执行端的写法。 */
  model: string;
  /** 主执行的思考档。 */
  thinking: string;
  /** second-highest：照执行端登记的档位取的次高档；explicit：派活方写明的。 */
  effortPolicy: 'second-highest' | 'explicit';
  /** 能力是照什么定的：执行端打招呼时登记的（带时间），或执行端没登记、派活方写的。 */
  capabilityBasis: string;
  /** 要不要开子代理：subagents 不空就是要。 */
  subagentsRequired: boolean;
  /** 要开的子代理。 */
  subagents: SubagentSpec[];
  /** 设不了就交 capability_missing，没明确授权不换模型（尤其不换付费的）。 */
  fallback: 'none-without-explicit-authority';
}


/** v1 任务单：派活端写，存进表的 protocol 列，也原子写成任务文件夹里的 task.json；task.md 是它的可读副本。 */
interface TaskSpecBase {
  /** 协议版本，固定 1。 */
  version: 1;
  /** 固定 task。 */
  kind: 'task';
  /** 任务号。 */
  taskId: string;
  /** 交给谁：已登记的外部 AI 名。 */
  assignedTo: string;
  /** 谁派的：机器人、原前台、实际派活的会话。 */
  source: {
    /** 机器人名。 */
    bot: string;
    /** 原前台会话号：前台自己派的就是它自己。 */
    frontSessionId: string;
    /** 实际派活的会话号：结果交回这里。 */
    sessionId: string;
  };
  /** 机器人的工作区：派活会话用的那个，相对机器人工作区的路径。 */
  workspace: {
    /** 机器人名。 */
    bot: string;
    /** 相对路径或登记的名字；'.' 是工作区本身。 */
    path: string;
  };
  /** 固定 new：追加、暂停要执行端声明支持才用，第一版不做。 */
  operation: 'new';
  /** 要做什么。 */
  task: {
    /** 一句话标题。 */
    title: string;
    /** 目标、约束、怎么算做完。 */
    goal: string;
    /** 输入文件：任务文件夹里的文件名，用 files 的下载地址取。 */
    inputs: string[];
    /** 交回物：要交回哪些东西，每项一句。 */
    deliverables: string[];
  };
}

/** 需回信的任务丢掉 reply 字段仍按 v1 旧配置处理。 */
interface ReplyTaskSpec extends TaskSpecBase {
  /** 默认需要交回。 */
  reply?: true;
  /** 怎么执行。 */
  execution: ExecutionSpec;
  /** 怎么交回。 */
  result: {
    /** 交回的格式。 */
    format: 'result.json + result.md + artifacts/';
    /** 交回的目录，相对 jmbots 数据根。 */
    root: string;
    /** http 调 result 接口；file 写 result/result.json，jmbots 定时扫。 */
    returnMode: ReturnMode;
  };
}

/** 单向任务供执行端领取，已经没有要求的模型和交回结构。 */
interface OneWayTaskSpec extends TaskSpecBase {
  /** 领取即送达，无需交回。 */
  reply: false;
}

/** v1 任务单的两种回信方式，共用同一个领取入口。 */
export type TaskSpec = ReplyTaskSpec | OneWayTaskSpec;


/** 新协议任务存在 agent_tasks.protocol 列里的：任务单、回话地址、领取键、交回的结果。旧任务这一列是 NULL。 */
export interface Protocol {
  /** 任务单。 */
  spec: TaskSpec;
  /** 派活那一刻会话的渠道和地址：结果回到这里，执行者选不了。不给外部 AI 看。 */
  origin: Origin;
  /** 派活调用键：<派活会话号>/<模型这次工具调用的 callId>。同一个键再调 send 回原来那件，不派第二件；表上有唯一索引。 */
  requestKey: string;
  /** 领取键：领走时记下，交回要带同一个。 */
  claimKey?: string;
  /** 交回的结果。 */
  result?: TaskResult;
  /** 交回内容的摘要（getHash）：同一份重交交回原样，不同的报冲突。 */
  hash?: string;
  /** 结果送回会话的情况：排进结果队列了，或送不回的原因。 */
  delivery?: string;
}


/** send 收到的一个子代理要求（模型给的工具参数）。 */
export interface SubagentInput {
  /** 子代理叫什么。 */
  name: string;
  /** 它负责什么。 */
  responsibility: string;
  /** 它用的模型；不写同主执行。 */
  model?: string;
  /** 它的思考档；不写取执行端登记的次高档。 */
  thinking?: string;
  /** 它负责改的文件。 */
  files?: string[];
}


/** send 收到的执行要求（模型给的工具参数）。 */
export interface ExecutionInput {
  /** 主执行的模型；不写用执行端登记的第一个。 */
  model?: string;
  /** 主执行的思考档；不写取次高档。 */
  thinking?: string;
  /** 要开的子代理；空是不开。 */
  subagents: SubagentInput[];
}


/** 定下来的一个思考档。 */
interface ThinkingChoice {
  /** 思考档。 */
  thinking: string;
  /** 照什么定的。 */
  policy: ExecutionSpec['effortPolicy'];
}


/**
 * 定一个模型的思考档：写了就用写的（执行端登记过这个模型的档位，就要在里面）；没写取执行端登记的次高档。
 * 定不了就抛错，不猜档。
 * @param agent 执行端的登记。
 * @param model 模型 ID。
 * @param given 派活方写的思考档；没写是 undefined。
 * @returns 思考档和照什么定的。
 * @throws model_unavailable：执行端登记了模型清单，这个不在里面；thinking_unsupported：写的档它没登记；
 *   effort_unverifiable：没写，它也没登记档位，或者只登记了一档。
 */
function getThinking(agent: AgentInfo, model: string, given: string | undefined): ThinkingChoice {
  const abilities = agent.abilities;
  //M 从已登记的模型清单取对应能力，用于验证或推算思考档。
  const registered = abilities?.models.find((item) => item.id === model);

  //G 它登记过模型清单，这个却不在里面：不能用，也不换别的。
  if (abilities !== undefined && registered === undefined) {
    const known = abilities.models.map((item) => item.id).join('、');
    throw new Error(`model_unavailable：${agent.name} 登记的模型里没有 ${model}（有：${known}）`);
  }

  //M 写了思考档：它登记过这个模型的档位，就要在里面。
  if (given !== undefined) {
    if (registered !== undefined && !registered.efforts.includes(given)) {
      const known = registered.efforts.join('、');
      throw new Error(`thinking_unsupported：${agent.name} 的 ${model} 没有思考档 ${given}（有：${known}）`);
    }
    return { thinking: given, policy: 'explicit' };
  }

  //G 没写，它也没登记档位：不猜。
  if (registered === undefined) {
    throw new Error(`effort_unverifiable：${agent.name} 没登记 ${model} 能设哪些思考档，send 要写 thinking`);
  }

  //M 次高档；只剩一档定不了。
  const second = getSecondEffort(registered.efforts);
  if (second === undefined) {
    const known = registered.efforts.join('、') || '没有';
    throw new Error(`effort_unverifiable：${agent.name} 的 ${model} 只登记了 ${known}，定不了次高档，send 要写 thinking`);
  }
  return { thinking: second, policy: 'second-highest' };
}


/**
 * 次高档：去掉 off 以后从低到高的倒数第二个。派活定档（getThinking）、list 列能力时用。
 * @param efforts 执行端登记的档位，从低到高。
 * @returns 次高档；去掉 off 以后不到两档是 undefined。
 */
export function getSecondEffort(efforts: string[]): string | undefined {
  const real = efforts.filter((item) => item !== 'off');
  return real[real.length - 2];
}


/**
 * 照执行端登记的能力定执行配置：主模型、主思考档、每个子代理的模型和思考档。agent_task send 调。
 * @param agent 执行端的登记。
 * @param input 派活方写的要求。
 * @returns 任务单的 execution。
 * @throws capability_missing：没写模型它也没登记；要开子代理它报了开不了。别的见 getThinking。错误给模型看，它可以改了再交。
 */
export function getExecution(agent: AgentInfo, input: ExecutionInput): ExecutionSpec {
  const abilities = agent.abilities;

  //M 主模型：写了用写的；没写用它登记的第一个；都没有就交不了（不猜，也不换付费模型）。
  let model = input.model;
  if (model === undefined) {
    model = abilities?.models[0]?.id;
  }
  if (model === undefined) {
    throw new Error(`capability_missing：${agent.name} 没登记会用的模型，send 要写 model`);
  }

  //M 按选定主模型的档位确定实际思考档和选择规则。
  const main = getThinking(agent, model, input.thinking);

  //G 要开子代理，它却报了开不了：交不了，免得主代理自己做完冒充开过。
  if (input.subagents.length > 0 && abilities?.subagents === false) {
    throw new Error(`capability_missing：${agent.name} 报的是开不了子代理；不开就别写 subagents`);
  }

  //M 每个子代理：模型不写同主执行，思考档照样不写取次高。
  const subagents: SubagentSpec[] = [];
  for (const item of input.subagents) {
    const subModel = item.model ?? model;
    const choice = getThinking(agent, subModel, item.thinking);
    subagents.push({
      name: item.name,
      responsibility: item.responsibility,
      model: subModel,
      thinking: choice.thinking,
      ownership: item.files ?? [],
    });
  }

  //M 能力照什么定的：它打招呼时登记的（带时间）；它没登记就是派活方写的，由它领活时自己核对。
  let basis = '执行端没登记能力：模型和思考档是派活方写的，执行端领活时自己核对，做不到交 capability_missing';
  if (abilities !== undefined) {
    basis = `${agent.name} 打招呼时登记（${new Date(agent.hello).toISOString()}）`;
  }

  return {
    model,
    thinking: main.thinking,
    effortPolicy: main.policy,
    capabilityBasis: basis,
    subagentsRequired: subagents.length > 0,
    subagents,
    fallback: 'none-without-explicit-authority',
  };
}


/**
 * 拼 task.md：任务单的可读副本，给人和执行端的模型看。以 task.json 为准。
 * @param spec 任务单。
 * @returns Markdown 全文。
 */
export function getTaskMarkdown(spec: TaskSpec): string {
  const lines = [
    `# 任务 #${spec.taskId}：${spec.task.title}`,
    '',
    `交给 ${spec.assignedTo}，由机器人 ${spec.source.bot} 派。机器读的任务单是同目录的 task.json，以它为准；这份是可读副本。`,
    '',
    '## 要做什么',
    '',
    spec.task.goal,
  ];

  //M 两种任务的附件都在同一个 input/，可读单先列输入再写动作。
  if (spec.task.inputs.length > 0) {
    lines.push('', '## 输入文件', '', ...spec.task.inputs.map((item) => `- ${item}`));
  }
  const base = `/api/agents/${spec.assignedTo}/tasks/${spec.taskId}`;
  const take = `- 先领：POST ${base}/take，正文 {"claimKey": "你定的一个键"}；回 409 是别人领了。`;
  if (spec.reply === false) {
    //M 单向任务的同一张单不再显示模型或交回步骤。
    lines.push('', '## 领取', '', take, '- 领取即送达，不用交回。');
    return lines.join('\n');
  }

  //M 要求交回的任务列出交回物和主执行配置。
  const execution = spec.execution;
  lines.push(
    '',
    '## 交回物',
    '',
    ...spec.task.deliverables.map((item) => `- ${item}`),
    '',
    '## 怎么执行',
    '',
    `- 主执行：${execution.model}，思考档 ${execution.thinking}（${execution.effortPolicy}）。`,
  );

  //M 子代理：要开的每个一行；不开写明不开。
  if (execution.subagents.length === 0) {
    lines.push('- 不开子代理。');
  }
  for (const item of execution.subagents) {
    const owned = item.ownership.join('、') || '没分文件';
    lines.push(`- 子代理 ${item.name}：${item.responsibility}；${item.model}，思考档 ${item.thinking}；负责 ${owned}。`);
  }
  //M 要求执行端如实上报缺失的能力，保持任务单选择的模型和子代理约束。
  const capability = '- 设不了指定的模型、思考档，或开不了要求的子代理：交 status capability_missing，写明缺什么；'
    + '不换模型（尤其不换付费的），不让主代理自己做完冒充开过子代理。';
  lines.push(capability);

  //M 怎么交回：领取带 claimKey，交回照 returnMode。
  lines.push('', '## 领取和交回', '', take);
  if (spec.result.returnMode === 'http') {
    lines.push(`- 交回：文件先 PUT /api/uploads/<文件名>，再 POST ${base}/result，正文 {"protocolResult": 结果, "uploads": [上传号]}。`);
  }
  if (spec.result.returnMode === 'file') {
    const root = spec.result.root;
    lines.push(`- 交回：文件放进 ${root}/artifacts/，结论写 ${root}/result.md，最后先写临时文件再改名成 ${root}/result.json。`);
  }
  //M 给执行端结果字段的查询入口，避免任务单重复写完整协议。
  lines.push('- 结果的字段见 GET /api/agents/guide 的“新协议”一节。');
  return lines.join('\n');
}


/**
 * 一份内容的摘要：JSON 的 SHA-256 前 16 位。同一个结果键重交时比对内容。
 * @param value 要比的内容（校验过的结果，或旧格式的 { ok, text, uploads }）。
 * @returns 16 位十六进制。
 */
export function getHash(value: unknown): string {
  const json = JSON.stringify(value);
  const digest = crypto.createHash('sha256').update(json).digest('hex');
  return digest.slice(0, 16);
}
