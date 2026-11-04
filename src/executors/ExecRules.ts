/**
 * exec 审核前程序先判的规则（不问模型）。用户 11-03：发个文档也要他放行，嫌提示词没写好；
 * 同一天周小灵用 findstr 读 config.yaml，决策模型给了 0.94 直接放行，飞书 app_secret 泄露。所以：
 *   碰密钥文件的命令   直接拒绝（要能力就用现成工具，没有就找 Claude 加）
 *   jmai 自己的检查    typecheck、lint、测试、构建网页、换版本：直接执行
 *   跑本地脚本         把脚本内容读出来交给决策模型（按脚本实际做的事判断，不只看文件名）
 * 都是纯函数，测试见 tests/ExecRules.test.ts。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';


/** 去掉命令前面不影响判断的部分后的样子。 */
export interface ParsedCommand {
  /** 命令里 cd 到的目录；没有 cd 时是 undefined。 */
  cdDir?: string;
  /** 去掉 chcp、cd 之后剩下的命令。 */
  rest: string;
}


/**
 * 去掉开头的 “chcp 65001 >nul &” 和 “cd [/d] 目录 &&”。
 * @param command 原命令。
 */
export function parseCommand(command: string): ParsedCommand {
  /** 剩下的。 */
  let rest = command.trim().replace(/^chcp\s+\d+\s*>\s*nul\s*&&?\s*/i, '');
  /** cd 的目录。 */
  let cdDir: string | undefined;
  /** cd 那段。 */
  const cd = /^cd\s+(?:\/d\s+)?("[^"]+"|\S+)\s*&&\s*/i.exec(rest);
  if (cd) {
    cdDir = cd[1]!.replace(/^"|"$/g, '');
    rest = rest.slice(cd[0].length);
  }
  return { cdDir, rest: rest.trim() };
}


/**
 * 命令碰没碰密钥文件（运行时 config.yaml、.env、secrets.yaml、credentials）。config.example.yaml 不算。
 * @param command 原命令。
 * @returns 碰到的文件名；没碰时是 undefined。
 */
export function touchesSecret(command: string): string | undefined {
  /** 匹配。 */
  const found = /(?:^|[\\/\s"'=])(config\.ya?ml|\.env(?!\.example)(?:\.[\w-]+)?|secrets\.ya?ml|\.credentials\.\w+|credentials\.json)(?=$|[\s"'&|;>)])/i.exec(command);
  return found?.[1];
}


/**
 * 是不是 jmai 自己的检查或换版本（bun run typecheck / lint / test / build:web、bun test …、bun scripts/Swap_Serve.ts …），
 * 而且没有用 &、|、; 接别的命令（末尾的 2>&1 可以有）。
 * @param command 原命令。
 */
export function isProjectCheck(command: string): boolean {
  /** 去掉 2>&1 之后剩下的。 */
  const rest = parseCommand(command).rest.replace(/\s*2>&1\s*$/, '');
  if (/[&|;<>`]/.test(rest)) {
    return false;
  }
  return /^bun(?:\.cmd)?\s+(?:run\s+(?:typecheck|lint|test|build:web)|test(?:\s+[\w./\\-]+)*|scripts[\\/]Swap_Serve\.ts(?:\s+--[\w_]+\s+[\w.:-]+)*)$/i.test(rest);
}


/**
 * 命令要跑的本地脚本（bun/node/python/py/pwsh -File/powershell -File 后面跟的 .ts/.js/.mjs/.py/.ps1，或直接 .cmd/.bat），
 * 读出前 4000 个字交给决策模型。找不到、读不了时是 undefined。
 * @param command 原命令。
 * @param workDir 执行目录（命令里有 cd 时以 cd 的目录为准）。
 * @returns 脚本路径和内容。
 */
export function readScript(command: string, workDir: string): { file: string; content: string } | undefined {
  const { cdDir, rest } = parseCommand(command);
  /** 脚本路径原文。 */
  const target =
    /^(?:bun(?:\.cmd)?|node|python3?|py|tsx)\s+(?:run\s+)?("[^"]+\.(?:ts|js|mjs|cjs|py)"|\S+\.(?:ts|js|mjs|cjs|py))(?:\s|$)/i.exec(rest)?.[1] ??
    /^(?:pwsh|powershell)(?:\.exe)?\s+(?:-\w+\s+)*-File\s+("[^"]+"|\S+)/i.exec(rest)?.[1] ??
    /^("[^"]+\.(?:cmd|bat)"|\S+\.(?:cmd|bat))(?:\s|$)/i.exec(rest)?.[1];
  if (!target) {
    return undefined;
  }
  /** 完整路径。 */
  const file = path.resolve(cdDir ? path.resolve(workDir, cdDir) : workDir, target.replace(/^"|"$/g, ''));
  try {
    return { file, content: fs.readFileSync(file, 'utf8').slice(0, 4000) };
  } catch {
    return undefined;
  }
}

