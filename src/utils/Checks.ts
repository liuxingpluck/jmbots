/**
 * 守卫函数：检查命令行参数这类外部输入、配置文件里的值，合格就返回检查过的值，不合格直接抛错。
 * 这样调用方只留主线（用户 2026-10 认可的写法，旧版见 bak/src_bak/utils/Checks.ts）。
 */


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
export function readListenOptions(defaults: ListenOptions, args: string[] = process.argv.slice(2)): ListenOptions {
  // m: 读端口；没给就用默认值。
  /** 命令行里端口的原文；报错时原样带出，一眼看出写错了什么。 */
  const portText = readArg('port', args);
  /** 转成数字的端口。 */
  const port = Number(portText ?? defaults.port);
  // g: 端口必须是 1–65535 的整数。
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port 需要 1–65535 的整数，收到：${portText}`);
  }
  // m: 读地址；没给就用默认值。
  return { port, host: readArg('host', args) ?? defaults.host };
}


/** 取 `--name value` 或 `--name=value` 的值；没给这个参数时返回 undefined。 */
function readArg(name: string, args: string[]): string | undefined {
  /** 参数名，例如 `--port`。 */
  const flag = `--${name}`;
  for (let index = 0; index < args.length; index += 1) {
    /** 当前这一项。 */
    const arg = args[index];
    if (arg === flag) {
      return args[index + 1];
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
 * @param model 如 magpie/workbuddy/deepseek-v4.1-flash。
 * @returns 拆开的供应商和模型 ID。
 * @throws 没有斜杠，或斜杠在开头、结尾时抛错。
 */
export function splitModel(model: string): { providerId: string; modelId: string } {
  /** 第一个斜杠的位置。 */
  const slash = model.indexOf('/');
  if (slash < 1 || slash === model.length - 1) {
    throw new Error(`模型要写成“供应商/模型 ID”，现在是：${model}`);
  }
  return { providerId: model.slice(0, slash), modelId: model.slice(slash + 1) };
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
