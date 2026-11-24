/** AOBB 多开舱截图 CLI 入口：纯 Bun 原生 fetch 直调多开舱 HTTP API，只输出一行 JSON。 */
import * as path from 'node:path';
import * as capture from './Capture.ts';
import * as options from './Options.ts';

/** 仓库根目录（本文件位于 ztools/aobb-shot/ 下）。 */
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** CLI 执行返回结构。 */
export interface CliOutcome {
  /** 进程退出码：0 为成功，1 为失败。 */
  exitCode: number;
  /** 单行 JSON 输出对象。 */
  reply: Record<string, unknown>;
}

/**
 * 解析命令行参数并调用多开舱截图执行层，返回统一单行 JSON 结构与退出码。
 * @param args 命令行实参（不含运行时与脚本路径）。
 * @param projectRoot 仓库根目录，用于解析相对输出路径。
 * @param env 环境变量映射，默认读取 process.env（支持 AOBB_DOCK_URL）。
 * @param deps 可选执行依赖（单测注入 mock fetch / sleep）。
 * @returns 退出码及可序列化结果对象。
 */
export async function runCli(
  args: string[],
  projectRoot: string,
  env: Record<string, string | undefined> = process.env,
  deps?: capture.CaptureDeps,
): Promise<CliOutcome> {
  const started = Date.now();
  try {
    //G 无效参数在请求多开舱接口之前即失败返回。
    const shot = options.getShotOptions(args, projectRoot, env);

    //M 纯 Bun 原生 fetch 直调现役 AOBB 多开舱（默认 http://127.0.0.1:30098）。
    const result = await capture.takeShot(shot, deps);
    const reply: Record<string, unknown> = { ok: true, ...result, ms: Date.now() - started };
    return { exitCode: 0, reply };
  } catch (error: unknown) {
    let reason = String(error);
    if (error instanceof Error) {
      reason = error.message;
    }
    const reply: Record<string, unknown> = {
      ok: false,
      out: '',
      title: '',
      status: 0,
      ms: Date.now() - started,
      error: reason,
    };
    return { exitCode: 1, reply };
  }
}

//G 被单测 import 时不自动运行；直接以 bun 执行时输出一行 JSON 并设置退出码。
if (import.meta.main) {
  const outcome = await runCli(process.argv.slice(2), PROJECT_ROOT, process.env);
  console.log(JSON.stringify(outcome.reply));
  process.exitCode = outcome.exitCode;
}
