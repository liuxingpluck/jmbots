/** 经 ask.execute 做三模式真实验收；仅在显式 --live 时运行，保留会话，不读真实配置，不自动重发。 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as relay from '../src/Relay.ts';
import * as dsh from '../src/DshSession.ts';
import * as bounded from '../src/BoundedProcess.ts';
import type * as runtime from '../src/Runtime.ts';
import * as utils from '../src/Utils.ts';


/** 真实验收只接受固定的 jmai 内证据目录，不触碰活动角色或配置。 */
const evidenceDir = utils.getArg(process.argv, 'evidence-dir');
if (!process.argv.includes('--live') || !evidenceDir) {
  throw new Error('真实验收需用户授权，并显式传 --live --evidence-dir 项目内新目录。');
}
const root = path.resolve('F:/aidata/source/jmai/runtime');
const target = path.resolve(evidenceDir);
assert.ok(target.startsWith(`${root}${path.sep}`));
await fs.mkdir(target, { recursive: true });
const stamp = dsh.beijingStamp();
const summaryFile = path.join(target, `live_${stamp}.json`);
/** 这份锁不删除：同一个证据目录绝不重新建立验收请求。 */
await fs.writeFile(path.join(target, 'started.json'), JSON.stringify({ stamp, summaryFile }), { flag: 'wx' });
/** 代码在 zbots/tests 下，控制 CLI 位于项目根 ztools。 */
const actualControl = path.resolve(import.meta.dir, '../../ztools/dsh-control/Dsh_Control.mjs');
/** 无真实配置的运行时，只将任务与回执留在验收证据目录。 */
const zbots: runtime.Runtime = {
  configFile: '', config: { runtime_dir: target, providers: {}, models: {}, workspaces: {} }, dir: target,
  sharedDir: target, rolesDir: target, workspacesDir: target, evaluationsDir: target,
};
const results: unknown[] = [];
/** 创建状态经独立只读核实后，允许宿主显式指定已有测试会话；不自动从 unknown 恢复。 */
let sessionId = utils.getArg(process.argv, 'existing-session');
const modes: ('new' | 'specified' | 'current')[] = sessionId ? ['specified', 'current'] : ['new', 'specified', 'current'];
for (const mode of modes) {
  /** 只经过工具参数接线，rawTask 为宿主验收选项，不向模型开放。 */
  const tools = relay.createRelayTools(zbots, sessionId, { controlScript: actualControl, env: process.env, rawTask: true });
  const ask = tools.find((tool) => tool.definition.name === 'ask_dsh');
  assert.ok(ask);
  const args: Record<string, string> = {
    task: '这是无副作用会话验收。只回一句“会话验收收到”。不要调用任何工具，不要读写文件，不要飞书，不要转发，不要联系其他会话。',
    session_mode: mode, request_id: `acceptance-${mode}-${stamp}`,
  };
  if (mode === 'specified') {
    assert.ok(sessionId);
    args.session_id = sessionId;
  }
  const submitted = JSON.parse(await ask.execute(args)) as dsh.SubmissionReceipt;
  results.push({ mode, stage: 'submitted', submitted });
  await fs.writeFile(summaryFile, JSON.stringify({ stamp, results }, null, 2));
  console.log(JSON.stringify({ mode, stage: 'submitted', submitted }));
  assert.equal(submitted.accepted, true, '受理不明或失败立即停验，不自动新建重试');
  assert.equal(submitted.completed, false);
  assert.ok(submitted.sessionId);
  assert.notEqual(submitted.sessionId, 'session-f7691c06-a496-41dc-babc-2700ef5611ed');
  assert.notEqual(submitted.sessionId, 'session-57ee4f48-fda9-4265-9dbe-6a778255c361');
  if (mode !== 'new') {
    assert.equal(submitted.sessionId, sessionId);
  }
  sessionId = submitted.sessionId;
  /** 等待专用测试会话完成也包在有界客户端内，最多 90 秒，不发送额外消息。 */
  const waited = await bounded.runBounded('node', [actualControl, 'wait', '--session', sessionId, '--after-turn', String(submitted.afterTurn),
    '--timeout-ms', '80000', '--interval-ms', '1000', '--json'], { timeoutMs: 90000, maxOutputBytes: 64 * 1024, env: process.env });
  assert.equal(waited.status, 'exited');
  assert.equal(waited.exitCode, 0);
  const reply = JSON.parse(waited.stdout) as Record<string, unknown>;
  assert.equal(reply.sessionId, sessionId);
  assert.equal(reply.endReason, 'completed');
  assert.deepEqual(reply.toolCounts, {});
  assert.deepEqual(reply.replies, ['会话验收收到']);
  results.push({ mode, stage: 'completed', reply });
  await fs.writeFile(summaryFile, JSON.stringify({ stamp, sessionId, results }, null, 2));
  console.log(JSON.stringify({ mode, stage: 'completed', reply }));
}
console.log(JSON.stringify({ passed: true, sessionId, summaryFile, note: '三模式均走 ask.execute；会话保留，没有上线，也不是飞书入站模型选参验收。' }));
