/** 有界运行单个控制客户端：限制时间和合并输出，超限时终止并等待回收；不代表取消远端任务，不启动 shell。 */
import * as childProcess from 'node:child_process';


/** 控制客户端的资源预算，均只作用于本地子进程。 */
export interface ProcessLimits {
  /** 正常运行最长毫秒数。 */
  timeoutMs: number;
  /** stdout 与 stderr 合计字节上限；默认 64 KiB。 */
  maxOutputBytes?: number;
  /** 温和终止后等待毫秒数；默认 250。 */
  graceMs?: number;
  /** 强制终止后的回收上限毫秒数；默认 2000。 */
  reapMs?: number;
  /** 子进程环境；省略则继承，不输出其内容。 */
  env?: NodeJS.ProcessEnv;
}


/** 不包含 stderr 或异常原文，避免控制端错误泄露认证配置。 */
export interface ProcessResult {
  /** 客户端状态；cleanup_failed 表示未观察到回收，不能宣称进程已取消。 */
  status: 'exited' | 'timeout' | 'output_limit' | 'spawn_error' | 'cleanup_failed';
  /** 正常退出码；被信号终止或未启动时为 null。 */
  exitCode: number | null;
  /** 仅正常退出时返回预算内 stdout；调用方仍须检查退出码和业务回执。 */
  stdout: string;
  /** 本地子进程 ID，用于回收验收；未启动时为 null。 */
  pid: number | null;
  /** 是否观察到 close，证明子进程与管道已关闭。 */
  reaped: boolean;
}


/**
 * 用 exe + argv 运行一个无子孙进程的控制客户端，绝不拼 shell。
 * @param executable 可执行文件，不是命令字符串。
 * @param args 参数逐项传入，不做 shell 展开。
 * @param limits 时间、输出和回收预算。
 * @returns 明确的退出/超限结果；客户端终止不等于服务端任务取消。
 */
export function runBounded(executable: string, args: readonly string[], limits: ProcessLimits): Promise<ProcessResult> {
  /** 本次本地客户端的输出与终止预算。 */
  const maxBytes = limits.maxOutputBytes ?? 64 * 1024;
  const graceMs = limits.graceMs ?? 250;
  const reapMs = limits.reapMs ?? 2000;
  for (const value of [limits.timeoutMs, maxBytes, graceMs, reapMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error('控制进程预算必须是正整数。');
    }
  }
  return new Promise((resolve) => {
    /** 唯一子进程；不经过 shell，不允许控制工具再起常驻进程。 */
    let child: childProcess.ChildProcessWithoutNullStreams;
    try {
      child = childProcess.spawn(executable, [...args], { shell: false, windowsHide: true, env: limits.env, stdio: 'pipe' });
    } catch {
      resolve({ status: 'spawn_error', exitCode: null, stdout: '', pid: null, reaped: false });
      return;
    }
    /** 只在本次调用内收集输出，达到合并预算立刻停止缓存并终止客户端。 */
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let stopped: ProcessResult['status'] | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;

    /** 单次收尾，取消全部定时器，超限路径不暴露半截输出。 */
    function finish(exitCode: number | null, reaped: boolean): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(reapTimer);
      const status = stopped ?? 'exited';
      resolve({ status, exitCode, stdout: status === 'exited' ? Buffer.concat(chunks).toString('utf8') : '', pid: child.pid ?? null, reaped });
    }

    /** 超时/输出超限先 TERM，再 KILL；一直不 close 也须有界返回且明确回收失败。 */
    function stop(reason: ProcessResult['status']): void {
      if (stopped || settled) {
        return;
      }
      stopped = reason;
      chunks.length = 0;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reapTimer = setTimeout(() => {
          stopped = 'cleanup_failed';
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish(null, false);
        }, reapMs);
      }, graceMs);
    }

    /** 两条输出流共用字节预算，stderr 只计数、不返回。 */
    function collect(chunk: Buffer, stdout: boolean): void {
      if (stopped || settled) {
        return;
      }
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        stop('output_limit');
        return;
      }
      if (stdout) {
        chunks.push(chunk);
      }
    }

    // m: 计时涵盖启动、网络、状态读取和退出；不以 Promise.race 留下底层进程。
    const deadline = setTimeout(() => stop('timeout'), limits.timeoutMs);
    child.stdin.end();
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, false));
    child.on('error', () => {
      if (!child.pid) {
        stopped = 'spawn_error';
        finish(null, false);
        return;
      }
      stop('spawn_error');
    });
    child.on('close', (code) => finish(code, true));
  });
}
