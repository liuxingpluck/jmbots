/**
 * 外包执行者示例：向 jmbots 打招呼、长轮询领任务、把对话交给外部命令、交回复。
 * 领取循环在 src6/utils/WorkerClient.ts，以后连云端的客户端也可以用那一份。
 *
 * 用法（在仓库根目录）：
 *   bun scripts/worker-example.ts
 * Windows 上 bun 在 D:/dev/nodejsnpm/node_modules/bun/bin/bun.exe
 *
 * 环境变量（都不写死）：
 *   JMBOTS_URL      后端地址，默认 http://127.0.0.1:30097
 *   JMBOTS_TOKEN    执行者令牌（本机可不写）
 *   JMBOTS_WORKER   执行者名字，默认 local
 *   JMBOTS_CMD      干活的命令；不写则把用户最后一句话前面加「（示例执行者原样回）」交回去，方便先试通接口
 *                   例如：claude -p
 *   JMBOTS_TAGS     能力标签，逗号分隔，默认空
 *   JMBOTS_DESC     打招呼时说会做什么
 *
 * 命令在任务的 workspace 目录里跑，标准输入是一份 JSON（system、messages、workspace、sessionId、bot、title），
 * 标准输出的全文当作回复。
 */
import * as childProcess from 'node:child_process';
import * as workerClient from '../src6/utils/WorkerClient.ts';
import type * as workers from '../src6/services/Workers.ts';


/** 后端地址。 */
const base = process.env.JMBOTS_URL?.replace(/\/$/u, '') || 'http://127.0.0.1:30097';
/** 执行者名字。 */
const name = process.env.JMBOTS_WORKER || 'local';
/** 干活的命令；不写就走示例回显。 */
const command = process.env.JMBOTS_CMD?.trim() || '';
/** 能力标签。 */
const tags = (process.env.JMBOTS_TAGS ?? '').split(',').map((item) => item.trim()).filter((item) => item !== '');


await workerClient.runWorkerLoop({
  base,
  name,
  token: process.env.JMBOTS_TOKEN,
  description: process.env.JMBOTS_DESC ?? (command === '' ? '示例执行者（原样回用户最后一句话）' : command),
  tags,
  handle: async (task) => {
    if (command === '') {
      return { ok: true, text: echoReply(task) };
    }
    return runCommand(command, task);
  },
});


/**
 * 没有配命令时：把用户最后一句话原样回回去，前面标明这是示例。
 * @param task 任务。
 * @returns 回复。
 */
function echoReply(task: workers.WorkerTask): string {
  /** 对话里最后一条用户话。 */
  const last = lastUserText(task.payload.messages);
  return last === '' ? '（示例执行者：对话里没有用户的话）' : `（示例执行者原样回）\n${last}`;
}


/**
 * 把任务交给外部命令：在 workspace 里跑，stdin 是 JSON，stdout 当回复。
 * @param command 命令行（按空格拆，不走 shell，避免特殊字符被解释）。
 * @param task 任务。
 * @returns 回复；命令非 0 退出是失败。
 */
function runCommand(command: string, task: workers.WorkerTask): Promise<{ ok: boolean; text: string }> {
  /** 按空格拆开的参数。 */
  const parts = command.split(/\s+/u).filter((item) => item !== '');
  /** 程序。 */
  const file = parts[0];
  if (file === undefined) {
    return Promise.resolve({ ok: false, text: 'JMBOTS_CMD 是空的' });
  }
  return new Promise((resolve) => {
    /** 子进程。 */
    const child = childProcess.spawn(file, parts.slice(1), {
      cwd: task.payload.workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** 标准输出。 */
    let stdout = '';
    /** 标准错误。 */
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({ ok: false, text: `命令没跑起来：${error.message}` });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, text: stdout.trim() === '' ? '（命令没有输出）' : stdout.trim() });
        return;
      }
      resolve({
        ok: false,
        text: `命令退出码 ${String(code)}${stderr.trim() === '' ? '' : `：${stderr.trim()}`}`,
      });
    });
    child.stdin.write(`${JSON.stringify({
      system: task.payload.system,
      messages: task.payload.messages,
      workspace: task.payload.workspace,
      sessionId: task.payload.sessionId,
      bot: task.payload.bot,
      title: task.payload.title,
    }, null, 2)}\n`);
    child.stdin.end();
  });
}


/**
 * 对话里最后一条用户文字。
 * @param messages 对话。
 * @returns 文字；没有是空串。
 */
function lastUserText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    /** 这一条。 */
    const item = messages[index] as { role?: string; content?: unknown } | undefined;
    if (item?.role !== 'user') {
      continue;
    }
    if (typeof item.content === 'string') {
      return item.content;
    }
    if (Array.isArray(item.content)) {
      /** 文字块。 */
      const texts = item.content
        .filter((block): block is { type: string; text: string } =>
          typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
        .map((block) => block.text);
      return texts.join('');
    }
  }
  return '';
}
