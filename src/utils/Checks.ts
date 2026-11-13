/**
 * 守卫函数：检查命令行参数这类外部输入、配置文件里的值，合格就返回检查过的值，不合格直接抛错。
 * 这样调用方只留主线（用户 2026-10 认可的写法，旧版见 bak/src_bak/utils/Checks.ts）。
 */
import * as path from 'node:path';
import * as embedded from '../resources/Embedded.ts';
import type * as runsModule from '../executors/Runs.ts';


/** 入口已经确定的运行目录和启动模式。 */
export interface StartupOptions {
  /** 已补默认值的绝对运行目录。 */
  runtime: string;
  /** 是否仅启动 HTTP 供更新试运行。 */
  candidate: boolean;
}


/** 外部入口调用：空目录用默认值，编译版用 EXE 目录，源码版用仓库 jmbotsData。 */
export function resolveRuntimeDirectory(value: string | undefined): string {
  /** 默认目录仅在外部入口补齐，内部资源加载不再兜底。 */
  const defaultDirectory = embedded.isCompiled()
    ? path.dirname(process.execPath)
    : path.resolve(import.meta.dir, '..', '..', 'jmbotsData');
  /** 空白显式目录与未给目录都使用默认值。 */
  const selectedDirectory = value?.trim() || defaultDirectory;
  return path.resolve(selectedDirectory);
}


/** 校验启动入口的目录和模式；环境变量由入口显式传入，非法模式或缺参数值直接报错。 */
export function readStartupOptions(
  args: string[],
  environmentRuntime: string | undefined,
): StartupOptions {
  /** 命令行目录优先；未传才使用既有环境变量。 */
  const runtimeText = readArgument('runtime', args) ?? environmentRuntime;
  /** 未给模式时正常运行。 */
  const mode = readArgument('mode', args) ?? 'normal';
  if (mode !== 'normal' && mode !== 'candidate') {
    throw new Error(`--mode 需要 normal 或 candidate，收到：${mode}`);
  }
  /** 入口将缺省目录转为明确路径，内部不再决定目录。 */
  const runtime = resolveRuntimeDirectory(runtimeText);
  return {
    runtime,
    candidate: mode === 'candidate',
  };
}


/** 服务的监听参数。 */
export interface ListenOptions {
  /** 监听端口，1–65535 的整数。 */
  port: number;
  /** 监听地址；127.0.0.1 只给本机用，0.0.0.0 对局域网开放。 */
  host: string;
}


/**
 * 从命令行读 `--port` 和 `--host`（`--port 30086` 和 `--port=30086` 两种写法都认），没给就用 defaults。
 * 端口不是 1–65535 的整数时抛错，错误信息带上原文。
 */
export function readListenOptions(
  defaults: ListenOptions,
  args: string[],
): ListenOptions {
  // m: 读端口；没给就用默认值。
  /** 命令行里端口的原文；报错时原样带出，一眼看出写错了什么。 */
  const portText = readArgument('port', args);
  /** 转成数字的端口。 */
  const port = Number(portText ?? defaults.port);
  // g: 端口必须是 1–65535 的整数。
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port 需要 1–65535 的整数，收到：${portText}`);
  }
  // m: 读地址；没给就用默认值。
  const host = readArgument('host', args) ?? defaults.host;
  return {
    port,
    host,
  };
}


/** 取 `--name value` 或 `--name=value` 的值；没给这个参数时返回 undefined。 */
export function readArgument(
  name: string,
  args: string[],
): string | undefined {
  /** 参数名，例如 `--port`。 */
  const flag = `--${name}`;
  for (let index = 0; index < args.length; index += 1) {
    /** 当前这一项。 */
    const arg = args[index];
    if (arg === flag) {
      /** 显式写了参数名就必须给值，不能把下一个选项误当成值。 */
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} 后面需要参数值`);
      }
      return value;
    }
    if (arg?.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}


/**
 * 检查 YAML 或 JSON 里的一项是不是映射（对象）。空文档（null）当作空映射。
 * @param value 原样的值。
 * @param where 出错时报的位置，如 “config.yaml 的 engine”。
 * @returns 检查过的映射。
 * @throws 不是映射（是数组、字符串、数字）时抛错。
 */
export function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} 应该是映射（键: 值），现在是 ${Array.isArray(value) ? '列表' : typeof value}`);
  }
  return value as Record<string, unknown>;
}


/**
 * 检查可选的字符串：没写（undefined、null、空白）返回 undefined，写了就必须是字符串。
 * @param value 原样的值。
 * @param where 出错时报的位置。
 * @throws 写了但不是字符串时抛错。
 */
export function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${where} 应该是字符串，现在是 ${typeof value}`);
  }
  return value.trim() ? value.trim() : undefined;
}


/**
 * 检查可选的字符串列表：没写返回 undefined，写了就必须每项都是字符串。
 * @param value 原样的值。
 * @param where 出错时报的位置。
 * @throws 写了但不是字符串列表时抛错。
 */
export function optionalStringList(value: unknown, where: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${where} 应该是字符串列表，如 [read, find]`);
  }
  return value as string[];
}


/**
 * 必填的非空字符串（工具参数、接口参数用）。
 * @param value 原样的值。
 * @param where 出错时报的位置。
 * @throws 不是非空字符串时抛错。
 */
export function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${where} 要写，而且是非空字符串`);
  }
  return value;
}


/**
 * 名字只能当一层文件夹名：不能含斜杠、反斜杠，不能是 . 或 ..。机器人、工作区名字都用它检查。
 * @param name 名字。
 * @param where 出错时报的位置。
 * @throws 名字为空或含路径时抛错。
 */
export function safeName(name: string, where: string): string {
  if (!name.trim() || /[\\/]/.test(name) || name === '.' || name === '..') {
    throw new Error(`${where} 只能是一层文件夹名，不能含路径：${name}`);
  }
  return name;
}


/**
 * 给 fs.writeFile(..., { flag: 'wx' }) 的 catch 用：文件已存在不算错（本来就是“没有才写”），别的错误照常抛。
 * @param error 写文件的错误。
 */
export function ignoreExists(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
    throw error;
  }
}


/**
 * 模型写法必须是“供应商/模型 ID”，模型 ID 自己还可以带斜杠。
 * @param model 如 供应商/分组/模型（第一个斜杠前是供应商）。
 * @returns 拆开的供应商和模型 ID。
 * @throws 没有斜杠，或斜杠在开头、结尾时抛错。
 */
export function splitModel(model: string): { providerId: string; modelId: string } {
  /** 第一个斜杠的位置。 */
  const slash = model.indexOf('/');
  if (slash < 1 || slash === model.length - 1) {
    throw new Error(`模型要写成“供应商/模型 ID”，现在是：${model}`);
  }
  return {
    providerId: model.slice(0, slash),
    modelId: model.slice(slash + 1),
  };
}


/**
 * 从模型的回复里取出 JSON 对象：取第一个 { 到最后一个 } 之间的部分（模型有时会在 JSON 前后多说几句）。
 * @param text 模型的回复。
 * @returns 读出的对象；没有 JSON、不是对象、解析失败时是 undefined，由调用方决定怎么兜底。
 */
export function extractJson(text: string): Record<string, unknown> | undefined {
  /** 第一个 {。 */
  const start = text.indexOf('{');
  /** 最后一个 }。 */
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    /** 解析结果。 */
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}


/** 飞书外部入口已经校验的配置，内部构造直接使用。 */
export interface FeishuSettings {
  /** 应用标识。 */
  app_id: string;
  /** 应用凭证；不输出到日志。 */
  app_secret: string;
  /** 已由统一渠道入口确认启用的机器人名。 */
  bot: string;
}


/**
 * 完成飞书特有字段检查；机器人名由统一渠道入口检查过。
 * @param settings 已带有效机器人名的原始渠道配置。
 * @returns 飞书内部必填配置。
 * @throws 应用标识或凭证缺失时抛错。
 */
export function readFeishuSettings(
  settings: Record<string, unknown> & {
    /** 统一渠道入口已经验证的机器人。 */
    bot: string;
  },
): FeishuSettings {
  /** 飞书专有字段仅在此入口检查。 */
  const appId = requireString(settings.app_id, 'app_id');
  const appSecret = requireString(settings.app_secret, 'app_secret');
  return {
    app_id: appId,
    app_secret: appSecret,
    bot: settings.bot,
  };
}


/**
 * 检查外部数字，兼容非空数字字符串，不接受空白、布尔值或非有限数。
 * @param value 配置或请求中的原始值。
 * @param where 出错位置。
 * @returns 有限数字。
 */
export function requireFiniteNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) {
    throw new Error(where + ' 要是有限数字');
  }
  /** 将外部数字字符串一次转为内部数值。 */
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(where + ' 要是有限数字');
  }
  return number;
}


/**
 * 外部入口检查正整数；内部直接使用返回值。
 * @param value 配置或请求中的原始数字，可为数字字符串。
 * @param where 出错位置。
 * @returns 大于零的整数。
 */
export function requirePositiveInteger(value: unknown, where: string): number {
  const number = requireFiniteNumber(value, where);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(where + ' 要是正整数');
  }
  return number;
}


/** HTTP命令缺省超时，秒。 */
export const RUN_TIMEOUT_SEC = 600;

/** HTTP命令最长超时，秒。 */
export const RUN_TIMEOUT_MAX_SEC = 3600;


/** 审核和执行共享的已校验命令。 */
export interface ExecInput {
  /** 待审核并执行的命令原文。 */
  command: string;
  /** 执行超时，毫秒。 */
  timeoutMs: number;
}


/**
 * 解析模型工具输入，先拒绝无效命令，再交给审核与执行。
 * @param value 工具的原始参数。
 * @returns 有效命令和确定的超时；缺省为120秒。
 * @throws 命令缺失或显式超时不是正整数时抛错。
 */
export function readExecInput(value: unknown): ExecInput {
  /** 模型提交的原始对象，仅在工具入口解析。 */
  const args = asRecord(value, 'exec 的参数');
  /** 审核展示与最终执行共用同一命令。 */
  const command = requireString(args.command, 'command');
  /** 外部秒数先补默认值，再统一转成执行器使用的毫秒。 */
  const timeoutSeconds = args.timeout === undefined || args.timeout === null
    ? 120
    : requirePositiveInteger(args.timeout, 'timeout');
  return {
    command,
    timeoutMs: timeoutSeconds * 1000,
  };
}


/**
 * HTTP命令入口一次准备完整输入，执行器不再补默认值或修正参数。
 * @param value HTTP原始请求体。
 * @param runtimeDir 入口已经确定的默认执行目录。
 * @returns 审核与运行需要的所有字段。
 * @throws 命令或显式超时不合法时抛错。
 */
export function readRunInput(
  value: unknown,
  runtimeDir: string,
): runsModule.RunInput {
  /** HTTP 外部请求的字段集合。 */
  const body = asRecord(value, '命令请求');
  const command = requireString(body.command, 'command');
  /** 目录、说明和来源在边界补齐，内部不再猜测调用意图。 */
  const cwd = optionalString(body.cwd, 'cwd') ?? runtimeDir;
  const why = optionalString(body.why, 'why') ?? '';
  const from = optionalString(body.from, 'from') ?? 'api';
  /** HTTP 合同使用秒数，未填写时沿用命令窗口的默认时限。 */
  const timeout = body.timeout === undefined || body.timeout === null
    ? RUN_TIMEOUT_SEC
    : requireFiniteNumber(body.timeout, 'timeout');
  if (timeout <= 0) {
    throw new Error('timeout 要是正数（秒）');
  }
  /** 秒数在外部入口归一化，内部执行器直接使用。 */
  const roundedTimeout = Math.max(1, Math.round(timeout));
  const timeoutSec = Math.min(roundedTimeout, RUN_TIMEOUT_MAX_SEC);
  return {
    command,
    cwd,
    why,
    from,
    timeoutSec,
    askUser: body.ask_user === true,
  };
}


/**
 * 配置边界检查数字列表，保留原顺序。
 * @param value 外部配置中的列表。
 * @param where 配置字段位置，用于错误信息。
 * @returns 每一项都已检查的有限数字列表。
 * @throws 非数组或任一项不是有限数字时抛错。
 */
export function requireFiniteNumberList(value: unknown, where: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(where + ' 要是数字列表');
  }
  return value.map((item, index) => {
    const itemPath = where + '[' + index + ']';
    return requireFiniteNumber(item, itemPath);
  });
}
