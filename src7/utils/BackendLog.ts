/** 给后端控制台错误加本机时间与源码来源，由基地原样追加到 backend.log。 */
import * as text from './Text.ts';
import * as trace from './Trace.ts';

/** 已有日期头使用 Text.formatLocalTime 的 date 格式，保留发出方记录的时刻。 */
const DATED_HEAD = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?=[ \t\r\n]|$)/u;
const LOG_HOME = ['utils/BackendLog.ts'];

/** 从项目相对栈位置取插件目录或模块名，不把完整路径写进日志。 */
function getSource(site: string): string {
  const plugin = /(?:^|\/)plugins\/([a-zA-Z0-9_-]+)\//u.exec(site)?.[1];
  if (plugin !== undefined) return plugin;

  const module = /(?:^|\/)([a-zA-Z0-9_.-]+)\.[cm]?[jt]sx?:\d+$/u.exec(site)?.[1];
  return module ?? 'backend';
}

/**
 * 安装后端报错格式器。
 * @param output 后端使用的控制台。
 * 副作用：包装该控制台的 error，保留原 formatter 处理占位符、对象和多行栈。
 */
export function installBackendErrorLogger(output: Pick<Console, 'error'> = console): void {
  //M 保留控制台原有的写入方式，基地已经负责把标准错误收进文件。
  const writeError = output.error.bind(output);
  output.error = (...args: unknown[]): void => {
    const now = Date.now();

    //M 复用跟踪点的栈位置规则，跳过日志工具本身。
    const site = trace.getCallSite(LOG_HOME);
    const source = getSource(site);
    let first = args[0];
    let time = text.formatLocalTime(now, 'date');

    if (typeof first === 'string') {
      const existing = DATED_HEAD.exec(first)?.[0];
      if (existing !== undefined) {
        time = existing;
        first = first.slice(existing.length).replace(/^[ \t]+/u, '');
      }

      //M 前缀和原格式串交给同一次调用，多行栈紧跟报错头。
      const format = `${time} [${source}] ${first}`;
      const rest = args.slice(1);
      writeError(format, ...rest);
      return;
    }

    //M Error 或其他对象留给控制台原样展开。
    const prefix = `${time} [${source}]`;
    writeError(prefix, ...args);
  };
}
