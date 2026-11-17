/**
 * 真模型审批（Live）：审核小会话用真模型 magpie，起一次服务跑两段——
 *   一、审核：echo hi 放行并执行、rmdir /s /q 去问用户；二、卡片：rmdir 生成的审批卡片（标题、原因、风险、按钮颜色）。
 * 要连本机 magpie、可能花钱，判断也会变，所以不进 test:src7；按 CLAUDE.md，Live_* 不经用户同意不跑。Windows 上用 bun 跑：
 *   bun src7/tests/Live_Approval.ts
 * 用 cache/test-src7-cards/data2（15736，只听 127.0.0.1；前台、后台假模型，只有审核走真模型）。只按自己起的 PID 关进程。
 * 2026-11-14 19:30 从 Cards_Test.ts 搬来（Claude 18:44 第 4 条、19:20 第 3 条），名叫 Live_Cards.ts；
 * 2026-11-14 20:10 并进 Batch1_Test.ts 的真模型审核段，改名 Live_Approval.ts（Claude 19:58 第 6 节第 1 条）。
 */
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import * as render from '../plugins/feishu/cards/Render.ts';

const ROOT = path.resolve(import.meta.dir, '../..');
const HERE = path.join(ROOT, 'cache/test-src7-cards');
const DIR = path.join(HERE, 'data2');
const PORT = 15736;
const RESULT = path.join(HERE, 'live_result.txt');
const lines: string[] = [];
let passed = 0;
let failed = 0;
let pid = 0;

function note(text: string): void {
  console.log(text);
  lines.push(text);
  fs.writeFileSync(RESULT, lines.join('\n') + '\n', 'utf8');
}
function check(title: string, ok: boolean, detail: unknown = ''): void {
  if (ok) passed += 1; else failed += 1;
  note(`${ok ? '通过' : '不通'} ${title}${detail === '' ? '' : ' │ ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`.slice(0, 2500));
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, step = 200): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const value = await fn(); if (value !== undefined && value !== false) return value; } catch { /* 还没好 */ }
    await sleep(step);
  }
  return undefined;
}
const kill = (id: number) => { if (id > 0) childProcess.spawnSync('taskkill', ['/pid', String(id), '/T', '/F'], { windowsHide: true }); };
async function api(method: string, url: string, body?: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${PORT}${url}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}
function sessions(kind: string): { id: string; messages: any[] }[] {
  const d = new Database(path.join(DIR, 'data/jmbots7.db'));
  try {
    return (d.query('SELECT meta, messages FROM sessions').all() as { meta: string; messages: string }[])
      .map((row) => ({ ...JSON.parse(row.meta), messages: JSON.parse(row.messages) })).filter((row) => row.kind === kind);
  } finally { d.close(); }
}
/** 让前台把一句“调用 工具 {参数}”交给一场新的后台会话；交回那场会话号。 */
async function work(tool: string, args: unknown): Promise<string> {
  const before = new Set(sessions('work').map((row) => row.id));
  const inner = `调用 ${tool} ${JSON.stringify(args)}`;
  await api('POST', '/api/message', { text: `调用 hand_session ${JSON.stringify({ text: inner })}` });
  return await waitFor(() => sessions('work').find((row) => !before.has(row.id))?.id, 30_000) ?? '';
}
/** 等这场会话的第一条工具结果（真模型审核最多等 180 秒）。 */
async function firstResult(id: string): Promise<string> {
  return await waitFor(() => {
    const result = sessions('work').find((row) => row.id === id)?.messages.find((m) => m.role === 'toolResult');
    return result ? textOf(result) : undefined;
  }, 180_000) ?? '（等不到工具结果）';
}
const textOf = (m: any): string => typeof m.content === 'string' ? m.content : (m.content ?? []).map((b: any) => b.text ?? '').join('');

async function main(): Promise<void> {
  note(`真模型审批（Live）开始 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  for (const name of ['data', 'bots', 'knowledge']) fs.rmSync(path.join(DIR, name), { recursive: true, force: true });
  const log = fs.openSync(path.join(DIR, 'serve_b.log'), 'a');
  const child = childProcess.spawn(process.execPath, ['src7/Main.ts', '--data', DIR], { cwd: ROOT, stdio: ['ignore', log, log], windowsHide: true });
  pid = child.pid ?? 0;
  //G 起来 10 秒内健康检查不通就关掉自己起的这个、记原因（规则：每次启动设超时）。
  const up = await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/api/ui/info`)).ok || undefined, 10_000, 500);
  note(`（起服务 pid ${pid} 端口 ${PORT}：${up ? '就绪' : '10 秒内没起来，见 data2/serve_b.log'}）`);
  if (!up) throw new Error('测试服务 10 秒内没起来');

  //M 一、审核（原 Batch1 data2 那段）
  const w1 = await work('exec', { command: 'echo hi' });
  const r1 = await firstResult(w1);
  check('真模型审核：echo hi 放行并执行', r1.startsWith('退出码 0') && r1.includes('hi'), r1.slice(0, 200));
  const w2 = await work('exec', { command: 'rmdir /s /q C:\\jmbots_test_nonexistent_dir' });
  const r2 = await firstResult(w2);
  check('真模型审核：rmdir /s /q 去问用户', r2.includes('已提交给用户确认'), r2.slice(0, 200));
  const review = sessions('exec-review').map((row) => row.messages.filter((m) => m.role === 'assistant').map(textOf).join(' ').slice(0, 300));
  note(`（真模型审核小会话的回答：${JSON.stringify(review)}）`);

  //M 二、卡片：上面 rmdir 那场的待确认卡片
  const wr = w2;
  const rr = r2;
  const pending = ((await api('GET', '/api/approvals')) as any[]).find((p) => p.sessionId === wr);
  const real = pending?.card;
  check('真模型卡片：rmdir 去问用户', rr.includes('已提交给用户确认'), rr.slice(0, 200));
  check('真模型卡片：标题按内容写（不是“要执行一条命令”）、有原因', real !== undefined && real.title !== '要执行一条命令' && real.reason !== '', { title: real?.title, reason: real?.reason });
  // 删的是不存在的目录，真模型有时判 high、有时判 medium（理由都写对了）：验至少 medium，按钮颜色跟等级对得上（high 才是危险色）。
  const level = real?.risk?.level;
  check('真模型卡片：风险至少中、“同意执行”颜色跟等级对得上', (level === 'high' || level === 'medium') && ((level === 'high') === (real?.buttons?.[0]?.style === 'danger')), { risk: real?.risk, style: real?.buttons?.[0]?.style });
  fs.writeFileSync(path.join(HERE, 'real_card.json'), JSON.stringify(real, null, 2), 'utf8');
  fs.writeFileSync(path.join(HERE, 'real_card_feishu.json'), JSON.stringify(render.approval({ ...pending, card: real }), null, 2), 'utf8');
}

try {
  await main();
} catch (error) {
  check('脚本自己出错', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  kill(pid);
  note(`合计：通过 ${passed}，不通 ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}
