/**
 * 第一批插件（journal、approval、exec、file-tools、web-search、model-catalog 用量、settings）的验收脚本。Windows 上用 bun 跑：
 *   bun src7/tests/Batch1_Test.ts
 * 自己起测试服务（data1 端口 15723）和一个假搜索服务（15725）（data2 真模型那段 2026-11-14 20:10 搬到 Live_Approval.ts），用 HTTP 跑一遍，读库核对，最后只按自己起的 PID 关进程。
 * 结果写进 cache\test-src7-batch1\result.txt，一行一项：通过 / 不通 名称 细节。
 */
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '../..');
const HERE = path.join(ROOT, 'cache/test-src7-batch1');
const RESULT = path.join(HERE, 'result.txt');
const TEST_CONFIG = path.join(HERE, 'data1/config.yaml');
const lines: string[] = [];
let passed = 0;
let failed = 0;
let originalConfig: string | undefined;

function note(text: string): void {
  console.log(text);
  lines.push(text);
  fs.writeFileSync(RESULT, lines.join('\n') + '\n', 'utf8');
}
function check(title: string, ok: boolean, detail: unknown = ''): void {
  if (ok) passed += 1; else failed += 1;
  note(`${ok ? '通过' : '不通'} ${title}${detail === '' ? '' : ' │ ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`.slice(0, 1500));
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

// ———— 假搜索服务 ————
const search = Bun.serve({
  port: 15725, hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json() as { input?: { content?: { text?: string }[] }[] };
    const query = body.input?.[0]?.content?.[0]?.text ?? '';
    const auth = request.headers.get('authorization') ?? '';
    if (query.includes('慢')) { await sleep(30_000); return Response.json({ output: '慢慢地搜到了很多很多很多很多很多东西' }); }
    if (url.pathname.startsWith('/a') && query.includes('失败')) return new Response(`网关出错，收到的请求头 ${auth}`, { status: 500 });
    return Response.json({ output: `${url.pathname.startsWith('/a') ? 'A' : 'B'} 搜到了：${query} 的结果，网址 https://example.com/x ，这里是足够长的一段内容。` });
  },
});

// ———— 测试服务 ————
interface Service { child: childProcess.ChildProcess; port: number; dir: string; }
const started: number[] = [];
async function start(dir: string, port: number, label: string): Promise<Service> {
  const log = fs.openSync(path.join(dir, `serve_${label}.log`), 'a');
  //M 测试服务是源码模式，不归基地管：去掉 JMBOTS_SUPERVISED。从 jmbots 的 /api/run 跑本脚本时，
  //M   这个变量从基地 → jmbots-server → exec → 本脚本一路继承下来；留着它，settings 的“立即重启”只退出、不起新进程。
  const env = { ...process.env };
  delete env['JMBOTS_SUPERVISED'];
  const child = childProcess.spawn(process.execPath, ['src7/Main.ts', '--data', dir], { cwd: ROOT, stdio: ['ignore', log, log], windowsHide: true, env });
  started.push(child.pid ?? 0);
  const t0 = Date.now();
  const ok = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/ui/info`)).ok || undefined, 300_000, 1000);
  note(`（起服务 ${label} pid ${child.pid} 端口 ${port}：${ok ? '就绪' : '没起来'}，用了 ${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  return { child, port, dir };
}
function kill(pid: number): void {
  if (pid > 0) childProcess.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
}
async function api(s: Service, method: string, url: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const response = await fetch(`http://127.0.0.1:${s.port}${url}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, json, text };
}
function db(s: Service): Database { return new Database(path.join(s.dir, 'data/jmbots7.db')); }
function sessionsOf(s: Service, kind: string): { id: string; state: string; messages: any[]; updatedAt: number }[] {
  const d = db(s);
  try {
    const rows = d.query('SELECT meta, messages FROM sessions').all() as { meta: string; messages: string }[];
    return rows.map((row) => ({ ...JSON.parse(row.meta), messages: JSON.parse(row.messages) })).filter((row) => row.kind === kind)
      .sort((a, b) => a.updatedAt - b.updatedAt);
  } finally { d.close(); }
}
const textOf = (m: any): string => typeof m.content === 'string' ? m.content : (m.content ?? []).map((b: any) => b.text ?? '').join('');
const lastTool = (row: { messages: any[] }) => [...row.messages].reverse().find((m) => m.role === 'toolResult');

/** 让前台把一句“调用 工具 {参数}”交给一场新的后台会话；交回那场会话号。 */
async function work(s: Service, tool: string, args: unknown): Promise<string> {
  const before = new Set(sessionsOf(s, 'work').map((row) => row.id));
  const inner = `调用 ${tool} ${JSON.stringify(args)}`;
  await api(s, 'POST', '/api/message', { text: `调用 hand_session ${JSON.stringify({ text: inner })}` });
  const id = await waitFor(() => sessionsOf(s, 'work').find((row) => !before.has(row.id))?.id, 30_000);
  return id ?? '';
}
/** 等一场会话出现第 n 条工具结果（从 1 数），交回它的文字。 */
async function toolResult(s: Service, id: string, n = 1, ms = 60_000): Promise<string> {
  return (await waitFor(() => {
    const row = sessionsOf(s, 'work').find((item) => item.id === id);
    const results = row?.messages.filter((m) => m.role === 'toolResult') ?? [];
    return results.length >= n ? textOf(results[n - 1]) : undefined;
  }, ms)) ?? '（等不到工具结果）';
}
function pendingRows(s: Service): any[] {
  const d = db(s); try { return d.query('SELECT * FROM approval_pending ORDER BY id').all(); } finally { d.close(); }
}

async function main(): Promise<void> {
  note(`第一批验收开始 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  const dir1 = path.join(HERE, 'data1');
  for (const name of ['data', 'bots']) fs.rmSync(path.join(dir1, name), { recursive: true, force: true });
  //M 让旧缓存配置挂上现行计量插件，保留本轮设置校验要检查的 YAML 注释。
  originalConfig = fs.readFileSync(TEST_CONFIG, 'utf8');
  const current = originalConfig.replace(/^(  - name:) usage(?=\r?$)/mu, '$1 model-catalog');
  fs.writeFileSync(TEST_CONFIG, current, 'utf8');
  let s = await start(dir1, 15723, 'a');

  // ———— journal ————
  const sent = await api(s, 'POST', '/api/message', { text: '现在几点了' });
  const messageId = sent.json?.id;
  const front = await waitFor(() => sessionsOf(s, 'front').find((row) => row.state === 'done' && row.messages.length >= 4), 30_000);
  check('journal：发“现在几点了”前台答完', front !== undefined, front ? textOf(front.messages.at(-1)) : sent.text);
  await sleep(500);
  const d1 = db(s);
  //M 按 journal_lines 的 kind 和 name 核对记录，函数名、事件名都用全名。
  const lines = d1.query('SELECT kind, name FROM journal_lines WHERE session_id = ? ORDER BY id').all(front?.id ?? '') as { kind: string; name: string }[];
  const byMessage = d1.query('SELECT kind, name, message_id FROM journal_lines WHERE message_id = ?').all(messageId ?? -1) as any[];
  d1.close();
  check('journal：前台会话有跟踪行（函数）和事件行（session/*）', lines.some((r) => r.kind === '函数') && lines.some((r) => r.kind === '事件' && r.name.startsWith('session/')), lines.slice(0, 12));
  check('journal：有带这条消息号的行', byMessage.length > 0, byMessage.slice(0, 6));
  const ev1 = await api(s, 'GET', `/api/events?message=${messageId}`);
  check('journal：/api/events?message= 只有这条消息的', ev1.status === 200 && ev1.json.length >= 1 && ev1.json.every((e: any) => e.messageId === messageId), ev1.json?.map((e: any) => e.name));
  const ev2 = await api(s, 'GET', '/api/events?name=session/*&limit=5');
  check('journal：?name=session/*&limit=5', ev2.status === 200 && ev2.json.length > 0 && ev2.json.length <= 5 && ev2.json.every((e: any) => String(e.name).startsWith('session/')), ev2.json?.map((e: any) => e.name));
  const ev3 = await api(s, 'GET', '/api/events?limit=abc');
  check('journal：?limit=abc 回 400', ev3.status === 400, ev3.text);
  const detail = await api(s, 'GET', `/api/sessions/${front?.id}`);
  const md = detail.json?.files?.md ?? '';
  check('journal：会话详情 files.md 有路径、文件在', md !== '' && fs.existsSync(md), md);
  const mdText = md !== '' ? fs.readFileSync(md, 'utf8') : '';
  check('journal：对话.md 有用户、模型、工具结果、结束', ['【用户 · ', '### 第 1 步', '【结果】time：', '【这一轮】做完了'].every((k) => mdText.includes(k)), mdText.slice(0, 600));
  const trace = await api(s, 'GET', `/api/messages/${messageId}/trace?reply=0`);
  check('journal+usage：回话追溯里有事件和用量', trace.status === 200 && (trace.json?.events?.length ?? 0) > 0 && Array.isArray(trace.json?.usage) && trace.json.usage.length > 0, { events: trace.json?.events?.length, usage: trace.json?.usage?.length, notes: trace.json?.notes });

  // ———— approval + exec（假模型的审核答不出 JSON → 问用户）————
  const w1 = await work(s, 'exec', { command: 'echo hi' });
  const r1 = await toolResult(s, w1);
  check('exec：echo hi 去问用户（待确认 #1）', r1.includes('已提交给用户确认') && r1.includes('#1'), r1);
  const list1 = await api(s, 'GET', '/api/approvals');
  check('approval：/api/approvals 有 #1，command、sessionId 对', list1.status === 200 && list1.json?.[0]?.id === 1 && list1.json[0].command === 'echo hi' && list1.json[0].sessionId === w1, list1.json);
  const ok1 = await api(s, 'POST', '/api/approvals/1', { approve: true });
  check('approval：POST 同意 #1', ok1.status === 200 && ok1.json?.ok === true, ok1.text);
  const back1 = await waitFor(() => sessionsOf(s, 'work').find((row) => row.id === w1)?.messages.find((m) => m.role === 'user' && textOf(m).includes('用户同意了')), 30_000);
  check('exec：同意后跑了，结果交回会话（含 hi）', back1 !== undefined && textOf(back1).includes('hi') && textOf(back1).includes('退出码 0'), back1 ? textOf(back1) : '');
  const again = await api(s, 'POST', '/api/approvals/1', { approve: true });
  check('approval：再同意一次 404 已经定过了', again.status === 404 && again.text.includes('已经定过了'), again.text);
  const bad = await api(s, 'POST', '/api/approvals/1', {});
  check('approval：{} 回 400', bad.status === 400, bad.text);
  const none = await api(s, 'POST', '/api/approvals/99', { approve: true });
  check('approval：#99 回 404 没有待确认', none.status === 404 && none.text.includes('没有待确认 #99'), none.text);

  const w2 = await work(s, 'exec', { command: 'echo no' });
  const r2 = await toolResult(s, w2);
  const id2 = Number(/#(\d+)/u.exec(r2)?.[1] ?? 0);
  await api(s, 'POST', '/api/message', { text: `拒绝 ${id2}` });
  const row2 = await waitFor(() => pendingRows(s).find((row) => row.id === id2 && row.state === 'rejected'), 15_000);
  check('approval：文字“拒绝 N”认出来，decided_by 是 http 文字回复', row2?.decided_by === 'http 文字回复', row2);
  const back2 = await waitFor(() => sessionsOf(s, 'work').find((row) => row.id === w2)?.messages.find((m) => m.role === 'user' && textOf(m).includes('没有执行')), 15_000);
  check('exec：拒绝后会话收到“命令没有执行”', back2 !== undefined, back2 ? textOf(back2) : '');
  const frontAfter = sessionsOf(s, 'front').at(-1);
  check('approval：“拒绝 N”没进前台', !(frontAfter?.messages ?? []).some((m) => m.role === 'user' && textOf(m) === `拒绝 ${id2}`));
  await api(s, 'POST', '/api/message', { text: '待确认有哪些' });
  await sleep(800);

  const countBefore = pendingRows(s).length;
  const w3 = await work(s, 'exec', { command: 'type config.yaml' });
  const r3 = await toolResult(s, w3);
  check('approval 规则：碰 config.yaml 直接拒绝、不建待确认', r3.includes('不准执行：命令碰了密钥文件 config.yaml') && pendingRows(s).length === countBefore, r3);

  const w4 = await work(s, 'exec', { command: 'echo {"safe":true}' });
  const r4 = await toolResult(s, w4);
  check('approval 审核放行：直接执行、退出码 0', r4.startsWith('退出码 0') && r4.includes('{"safe":true}') && pendingRows(s).length === countBefore, r4);

  let t0 = Date.now();
  const w5 = await work(s, 'exec', { command: 'echo {"safe":true}& ping -n 8 127.0.0.1', timeout: 2 });
  const r5 = await toolResult(s, w5);
  check('exec：超时 2 秒结束、写“超时，已结束”', r5.includes('超时，已结束') && Date.now() - t0 < 7000, `${r5.split('\n')[0]}（整轮 ${Date.now() - t0} 毫秒）`);

  const w6 = await work(s, 'exec', { command: 'echo {"safe":true}& for /L %i in (1,1,3000) do @echo %i' });
  const r6 = await toolResult(s, w6);
  check('exec：输出太长只留最后 2000 行', r6.includes('[输出太长，只留最后 2000 行'), r6.split('\n').slice(0, 2).join(' / '));

  const pingBefore = childProcess.spawnSync('tasklist', ['/FI', 'IMAGENAME eq PING.EXE', '/NH']).stdout.toString().split('\n').filter((l) => /ping/i.test(l)).length;
  const w7 = await work(s, 'exec', { command: 'echo {"safe":true}& ping -n 40 127.0.0.1', timeout: 120 });
  const running = await waitFor(() => {
    const row = sessionsOf(s, 'work').find((item) => item.id === w7);
    const called = row?.messages.some((m) => m.role === 'assistant' && (m.content ?? []).some((b: any) => b.type === 'toolCall'));
    return called && !row?.messages.some((m) => m.role === 'toolResult') ? true : undefined;
  }, 30_000);
  await sleep(1500);
  t0 = Date.now();
  const stop = await api(s, 'POST', `/api/sessions/${w7}/stop`, {});
  const r7 = await toolResult(s, w7, 1, 10_000);
  const stopMs = Date.now() - t0;
  await sleep(500);
  const pingAfter = childProcess.spawnSync('tasklist', ['/FI', 'IMAGENAME eq PING.EXE', '/NH']).stdout.toString().split('\n').filter((l) => /ping/i.test(l)).length;
  check('exec：长命令点停止 2 秒内结束、写“被停下了”', running === true && stop.status === 200 && stopMs < 2000 && r7.includes('被停下了'), `${r7.split('\n')[0]}（停止到结束 ${stopMs} 毫秒）`);
  check('exec：停止后 ping 子进程没留下', pingAfter <= pingBefore, { pingBefore, pingAfter });

  // ———— file-tools ————
  const wf = await work(s, 'write', { path: 'docs/a.txt', content: 'hello world\r\nline2 “引号”\r\n' });
  await toolResult(s, wf);
  const we = await work(s, 'edit', { path: 'docs/a.txt', edits: [{ oldText: 'hello world', newText: 'hello there' }] });
  const re = await toolResult(s, we);
  const aFile = path.join(dir1, 'bots/助手/workspace/docs/a.txt');
  check('file-tools edit：已修改 1 处，\\r\\n 保留', re === '已修改 docs/a.txt（1 处）' && fs.readFileSync(aFile, 'utf8') === 'hello there\r\nline2 “引号”\r\n', re);
  const wz = await work(s, 'edit', { path: 'docs/a.txt', edits: [{ oldText: 'line2 "引号"', newText: 'line2 改好' }] });
  const rz = await toolResult(s, wz);
  check('file-tools edit：中文引号宽松匹配', rz.includes('已修改') && fs.readFileSync(aFile, 'utf8').includes('line2 改好'), rz);
  const wn = await work(s, 'edit', { path: 'docs/a.txt', edits: [{ oldText: '不存在的字', newText: 'x' }] });
  const rn = await toolResult(s, wn);
  check('file-tools edit：找不到原文报错', rn.includes('里找不到'), rn);
  const wo = await work(s, 'edit', { path: '../x.txt', edits: [{ oldText: 'a', newText: 'b' }] });
  const ro = await toolResult(s, wo);
  check('file-tools edit：出工作区报错', ro.includes('出了工作区'), ro);
  const wd = await work(s, 'find', { text: 'HELLO' });
  const rd = await toolResult(s, wd);
  check('file-tools find：按内容找（不分大小写）', rd.includes('docs/a.txt:1: hello there'), rd);
  const wg = await work(s, 'find', { name: '*.txt' });
  const rg = await toolResult(s, wg);
  check('file-tools find：按名字找', rg.split('\n').includes('docs/a.txt'), rg);
  const wx = await work(s, 'find', { name: '*.nothing' });
  const rx = await toolResult(s, wx);
  check('file-tools find：没找到的说法', rx.includes('没找到'), rx);

  // ———— web-search ————
  const ws1 = await work(s, 'web_search', { query: '普通' });
  const rs1 = await toolResult(s, ws1);
  check('web-search：第一家搜到', rs1.startsWith('（用 假搜索A 搜的）') && rs1.includes('A 搜到了'), rs1.slice(0, 120));
  const ws2 = await work(s, 'web_search', { query: '失败' });
  const rs2 = await toolResult(s, ws2);
  check('web-search：第一家出错换第二家、密钥换成 ***', rs2.startsWith('（用 假搜索B 搜的；前面没成：假搜索A：HTTP 500') && rs2.includes('***') && !rs2.includes('test-search-key'), rs2.slice(0, 200));
  const ws3 = await work(s, 'web_search', { query: '慢' });
  await waitFor(() => sessionsOf(s, 'work').find((row) => row.id === ws3)?.messages.some((m) => m.role === 'assistant') || undefined, 20_000);
  await sleep(1500);
  t0 = Date.now();
  await api(s, 'POST', `/api/sessions/${ws3}/stop`, {});
  const rs3 = await toolResult(s, ws3, 1, 10_000);
  check('web-search：慢搜索点停止 2 秒内断开（记“已停止”）', rs3.includes('已停止') && Date.now() - t0 < 2000, `${rs3}（${Date.now() - t0} 毫秒）`);

  // ———— usage ————
  const u1 = await api(s, 'GET', '/api/usage');
  check('usage：/api/usage 默认按天按模型，有 faux/faux-1（假模型回答里记的名字）', u1.status === 200 && u1.json.by === 'day' && u1.json.rows.some((r: any) => r.key === 'faux/faux-1') && u1.json.totals.calls > 0, u1.json?.totals);
  const u2 = await api(s, 'GET', '/api/usage?by=hour&group=purpose');
  check('usage：按小时、按用途（session、dispatch）', u2.status === 200 && u2.json.rows.some((r: any) => r.key === 'dispatch') && u2.json.rows.some((r: any) => r.key === 'session'), u2.json?.rows?.map((r: any) => `${r.period}/${r.key}/${r.calls}`));
  const u3 = await api(s, 'GET', '/api/usage?by=year');
  check('usage：by 不对回 400', u3.status === 400, u3.text);

  // ———— 重启后待确认还在 ————
  const w8 = await work(s, 'exec', { command: 'echo again' });
  const r8 = await toolResult(s, w8);
  const id8 = Number(/#(\d+)/u.exec(r8)?.[1] ?? 0);
  kill(s.child.pid ?? 0);
  await sleep(1500);
  s = await start(dir1, 15723, 'b');
  const list8 = await api(s, 'GET', '/api/approvals');
  check('approval：重启后待确认还在', list8.json?.some((p: any) => p.id === id8), list8.json?.map((p: any) => p.id));
  await api(s, 'POST', `/api/approvals/${id8}`, { approve: true });
  const back8 = await waitFor(() => sessionsOf(s, 'work').find((row) => row.id === w8)?.messages.find((m) => m.role === 'user' && textOf(m).includes('用户同意了')), 30_000);
  check('exec：重启后同意照样跑、交回会话', back8 !== undefined && textOf(back8).includes('again'), back8 ? textOf(back8).slice(0, 200) : '');

  // ———— settings ————
  const g1 = await api(s, 'GET', '/api/settings');
  check('settings：GET 不含密钥原文、有代号、没有 plugins', g1.status === 200 && !g1.text.includes('test-key-1') && !g1.text.includes('test-secret-1') && !g1.text.includes('test-token-1') && g1.text.includes('‹已设置:') && g1.json.config.plugins === undefined, g1.text.slice(0, 200));
  const cfg = TEST_CONFIG;
  //M 校验骨架实际读取的重试设置，兼容旧 engine 路径的读法已经退役。
  const retryWait = ['models', 'retry', 'wait_ms'];
  const putRetryWait = [{ path: retryWait, value: 50 }];
  const p1 = await api(s, 'PUT', '/api/settings', putRetryWait);
  const after1 = fs.readFileSync(cfg, 'utf8');
  check('settings：PUT models.retry.wait_ms=50，注释都在', p1.status === 200 && p1.json.changed === 1 && after1.includes('wait_ms: 50') && after1.includes('# 假搜索：测试脚本自己起的服务'), p1.text);
  const p2 = await api(s, 'PUT', '/api/settings', [{ path: ['channels', 'feishu'], value: g1.json.config.channels.feishu }]);
  check('settings：带代号写回飞书表，文件里还是原密钥', p2.status === 200 && fs.readFileSync(cfg, 'utf8').includes('test-secret-1'), p2.text);
  const p3 = await api(s, 'PUT', '/api/settings', [{ path: ['providers', 'fake', 'api_key'], value: '‹已设置:00000000›' }]);
  check('settings：乱编的代号 400', p3.status === 400, p3.text);
  const p4 = await api(s, 'PUT', '/api/settings', [{ path: ['plugins'], value: [] }]);
  check('settings：改 plugins 400', p4.status === 400, p4.text);
  const before5 = fs.readFileSync(cfg, 'utf8');
  //M 对同一个现行字段写错类型，验证骨架拒绝整次写入。
  const invalidRetryWait = [{ path: retryWait, value: 'abc' }];
  const p5 = await api(s, 'PUT', '/api/settings', invalidRetryWait);
  check('settings：models.retry.wait_ms=abc 400、文件没变', p5.status === 400 && fs.readFileSync(cfg, 'utf8') === before5, p5.text);
  const p6 = await api(s, 'PUT', '/api/settings', [{ path: ['models', 'decision', 'model'], value: 'fake/fake' }]);
  const g6 = await api(s, 'GET', '/api/settings');
  check('settings：网页的 models.decision.model 写成 decision.models', p6.status === 200 && /decision:\s*\n\s*models:\s*\n\s*- fake\/fake/u.test(fs.readFileSync(cfg, 'utf8')) && g6.json?.config?.models?.decision?.model === 'fake/fake', p6.text);
  const b1 = await api(s, 'POST', '/api/bots', { name: '测试2', identity: '看日志', language: 'zh' });
  const indexMd = path.join(dir1, 'bots/测试2/memory/索引.md');
  const botsNow = await api(s, 'GET', '/api/bots');
  check('settings：新建机器人 测试2：写进配置、建记忆概要、当场在名单里', b1.status === 200 && fs.existsSync(indexMd) && fs.readFileSync(indexMd, 'utf8').includes('看日志') && fs.readFileSync(cfg, 'utf8').includes('测试2') && botsNow.json?.some((b: any) => b.name === '测试2'), b1.text);
  const b2 = await api(s, 'POST', '/api/bots', { name: '测试2' });
  const b3 = await api(s, 'POST', '/api/bots', { name: 'a/b' });
  const b4 = await api(s, 'POST', '/api/bots', { name: '测试3', feishu: { app_id: 'x' } });
  check('settings：重名、a/b、飞书只填一半都 400', b2.status === 400 && b3.status === 400 && b4.status === 400, [b2.text, b3.text, b4.text]);
  const info0 = (await api(s, 'GET', '/api/ui/info')).json?.startedAt;
  const a1 = await api(s, 'POST', '/api/settings/apply', {});
  const a2 = await api(s, 'POST', '/api/settings/apply', {});
  check('settings：立即重启回 startedAt，连点第二次 409', a1.status === 200 && a1.json?.startedAt === info0 && a2.status === 409, [a1.text, a2.text]);
  const changed = await waitFor(async () => {
    const now = (await api(s, 'GET', '/api/ui/info')).json?.startedAt;
    return typeof now === 'number' && now !== info0 ? now : undefined;
  }, 300_000, 1000);
  const pidFile = path.join(dir1, 'data/serve_15723.pid');
  const newPid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : 0);
  check('settings：几秒后 startedAt 变了，pid 文件是新进程', changed !== undefined && newPid > 0 && newPid !== s.child.pid, { changed, newPid, old: s.child.pid });
  if (newPid > 0 && newPid !== s.child.pid) started.push(newPid);

  // 2026-11-14 20:10：真模型审核（data2：echo hi 放行、rmdir 去问用户）搬到 src7/tests/Live_Approval.ts，test:src7 全部离线（Claude 19:58 第 6 节第 1 条）。
}

try {
  await main();
} catch (error) {
  check('脚本自己出错', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  for (const pid of started) kill(pid);
  if (originalConfig !== undefined) {
    //M 隔离服务停止后还原缓存模板，异常途中也不会留下已改过的设置。
    fs.writeFileSync(TEST_CONFIG, originalConfig, 'utf8');
  }
  //M 等假搜索服务关闭后再退出，确保端口已经释放。
  const closeActiveConnections = true;
  await search.stop(closeActiveConnections);
  note(`合计：通过 ${passed}，不通 ${failed}`);
  // 2026-11-14 17:55：有不通就退出码 1，test:src7 的退出码才算数（原来总是 0）。
  process.exit(failed > 0 ? 1 : 0);
}
