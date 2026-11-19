/**
 * 动态审批卡片、长跑提醒卡片、客服记忆库的验收脚本。Windows 上用 bun 跑：
 *   bun src7/tests/Cards_Test.ts
 * data1（15731，假模型）：卡片数据、长跑提醒（3 秒）、统一记忆检索；data3（15733）：旧检索接口的本地回落。记忆服务使用本机的假 Rust 接口（15732）。
 * 全部假模型、离线、每次结果一样。真模型（data2，magpie）那条 2026-11-14 19:30 搬到 Live_Cards.ts（跑前先问用户）。只按自己起的 PID 关进程。结果写 result.txt。
 */
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import * as render from '../plugins/feishu/cards/Render.ts';
import type { MemoryDoc, MemoryQuery } from '../plugins/memory/Backend.ts';

const ROOT = path.resolve(import.meta.dir, '../..');
const HERE = path.join(ROOT, 'cache/test-src7-cards');
const RESULT = path.join(HERE, 'result.txt');
const lines: string[] = [];
const originalConfigs = new Map<string, string>();
let passed = 0;
let failed = 0;

function note(text: string): void {
  console.log(text);
  lines.push(text);
  fs.writeFileSync(RESULT, lines.join('\n') + '\n', 'utf8');
}
function check(title: string, ok: boolean, detail: unknown = ''): void {
  if (ok) passed += 1; else failed += 1;
  note(`${ok ? '通过' : '不通'} ${title}${detail === '' ? '' : ' │ ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`.slice(0, 2500));
}
// 2026-11-14 18:10：memory 12:46 起做了客户隔离，查聊天记录（history、all）必须带客户号，不带回 400；网页渠道的客户号是 http:本机。
const ME = encodeURIComponent('http:本机');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, step = 200): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const value = await fn(); if (value !== undefined && value !== false) return value; } catch { /* 还没好 */ }
    await sleep(step);
  }
  return undefined;
}


// ———— 假搜索（慢的给长跑提醒用）————
const search = Bun.serve({
  port: 15735, hostname: '127.0.0.1',
  async fetch(request) {
    const body = await request.json() as { input?: { content?: { text?: string }[] }[] };
    const query = body.input?.[0]?.content?.[0]?.text ?? '';
    const wait = /慢(\d+)/u.exec(query);
    if (wait) await sleep(Number(wait[1]) * 1000);
    return Response.json({ output: `搜到了：${query} 的结果，网址 https://example.com/x ，这里是足够长的一段内容。` });
  },
});

// ———— 假 Rust 记忆服务：只有实际入库的片段才能从检索和原文接口读回 ————
const passages = new Map<number, MemoryDoc>();
let nextPassage = 1;
let externalDown = false;
const memory = Bun.serve({
  port: 15732, hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (externalDown) return new Response('挂了', { status: 503 });
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname === '/ingest') {
      const body = await request.json() as { docs: MemoryDoc[] };
      for (const doc of body.docs) {
        passages.set(nextPassage, doc);
        nextPassage += 1;
      }
      return Response.json({ ok: true, count: body.docs.length });
    }
    if (url.pathname === '/remove') {
      const body = await request.json() as { source: string };
      for (const [id, doc] of passages) {
        if (doc.source === body.source) passages.delete(id);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/search') {
      const query = await request.json() as MemoryQuery & { not_session?: string };
      const terms = query.query.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1);
      const hits = [];
      for (const [id, doc] of passages) {
        if (query.scope !== 'all' && doc.scope !== query.scope) continue;
        if (query.bot && doc.bot && doc.bot !== query.bot) continue;
        if (doc.scope === 'history' && query.customer && doc.customer !== query.customer) continue;
        if (query.session && doc.session !== query.session) continue;
        if (doc.session === query.not_session || doc.session === query.notSession) continue;
        if (!terms.some((word) => doc.text.includes(word))) continue;

        hits.push({ ...doc, id, snippet: doc.text, score: 0.93, via: ['keyword'] });
      }
      return Response.json({ hits: hits.slice(0, query.limit) });
    }
    if (url.pathname.startsWith('/passages/')) {
      const id = Number(url.pathname.slice('/passages/'.length));
      const doc = passages.get(id);
      if (doc === undefined) return Response.json({ error: '无此片段' }, { status: 404 });
      return Response.json({ passage: { ...doc, id, snippet: doc.text, via: ['keyword'] } });
    }
    return Response.json({ error: '未实现的假服务接口' }, { status: 404 });
  },
});

// ———— 测试服务 ————
interface Service { child: childProcess.ChildProcess; port: number; dir: string; }
const started: number[] = [];
async function start(dir: string, port: number, label: string): Promise<Service> {
  //M 旧隔离模板仍用 engine 阈值及 memory.services。按现行插件配置启动，所有记忆请求只去本机假服务。
  const config = path.join(dir, 'config.yaml');
  const original = fs.readFileSync(config, 'utf8');
  originalConfigs.set(config, original);
  const current = original
    .replace(/^  - name: (?:usage|bot-front-desk|prompt|base-tools|files-api)\r?\n/gmu, '')
    .replace(/^  - name: progress\r?\n/mu, '  - name: progress\n    config: { long_run_card_minutes: 0.05 }\n')
    .replace(/^  - name: memory(?:\r?\n {4}[^\r\n]*)*/mu, '  - name: memory\n    config: { service_url: "http://127.0.0.1:15732", backend_url: memory, backend_timeout_ms: 2000 }');
  fs.writeFileSync(config, current, 'utf8');
  const log = fs.openSync(path.join(dir, `serve_${label}.log`), 'a');
  const child = childProcess.spawn(process.execPath, ['src7/Main.ts', '--data', dir], { cwd: ROOT, stdio: ['ignore', log, log], windowsHide: true });
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
// 2026-11-14 20:10：删了没用到的 pendingRows、work2（Claude 19:58 第 6 节第 2 条）。

const approvals = async (s: Service) => (await api(s, 'GET', '/api/approvals')).json as any[];
const runState = (s: Service, id: string) => sessionsOf(s, 'work').find((row) => row.id === id)?.state;

async function main(): Promise<void> {
  note(`卡片、长跑提醒、记忆库验收开始 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  for (const d of ['data1', 'data3']) for (const name of ['data', 'bots', 'knowledge']) fs.rmSync(path.join(HERE, d, name), { recursive: true, force: true });
  const s = await start(path.join(HERE, 'data1'), 15731, 'a');

  // ———— 审批卡片（假模型审核答不出 JSON → 照命令拼的卡片）————
  const w1 = await work(s, 'exec', { command: 'rmdir /s /q C:\\jmbots_test_nonexistent_dir' });
  const r1 = await toolResult(s, w1);
  const list1 = await approvals(s);
  const c1 = list1.find((p) => p.sessionId === w1)?.card;
  check('审批卡片：/api/approvals 带 card，kind approval、在等', c1?.kind === 'approval' && c1?.state === 'waiting', c1);
  check('审批卡片：items 有命令（等宽）、目录；有风险；有工具数据可展开', c1?.items?.some((i: any) => i.label === '命令' && i.code && i.value.includes('rmdir')) && c1?.items?.some((i: any) => i.label === '目录') && c1?.risk?.level !== undefined && c1?.details?.data?.命令?.includes('rmdir'), c1?.items);
  check('审批卡片：按钮“同意执行”“拒绝”', c1?.buttons?.map((b: any) => b.label).join('/') === '同意执行/拒绝', c1?.buttons);
  const id1 = list1.find((p) => p.sessionId === w1)?.id;
  await api(s, 'POST', `/api/approvals/${id1}`, { approve: false });
  const d1 = db(s); const row1 = d1.query('SELECT card FROM approval_pending WHERE id = ?').get(id1) as any; d1.close();
  const c1b = JSON.parse(row1?.card ?? '{}');
  check('审批卡片：拒绝后 card.state rejected、result 写了点了什么', c1b.state === 'rejected' && String(c1b.result).includes('拒绝'), c1b.result);
  note(`（假模型审核时的卡片：${JSON.stringify(c1)}）`);

  // ———— 飞书画同一份卡片 ————
  const high = { ...c1, risk: { level: 'high', text: '会删整个目录' }, buttons: [{ action: 'approve', label: '同意执行', style: 'danger' }, { action: 'reject', label: '拒绝', style: 'default' }] };
  const f1 = JSON.stringify(render.approval({ id: 7, kind: 'exec', title: 't', detail: 'd', bot: '助手', state: 'waiting', askedAt: 0, card: high } as any));
  check('飞书卡片：风险高标题红、同意按钮 danger、折叠面板放工具数据', f1.includes('"template":"red"') && f1.includes('"type":"danger"') && f1.includes('collapsible_panel') && f1.includes('rmdir'), f1.slice(0, 600));
  const f2 = JSON.stringify(render.approval({ id: 7, kind: 'exec', title: 't', detail: 'd', bot: '助手', state: 'rejected', askedAt: 0, card: c1b } as any));
  check('飞书卡片：定了变灰、没按钮、写结果', f2.includes('"template":"grey"') && !f2.includes('"tag":"button"') && f2.includes('结果'), f2.slice(0, 400));

  // ———— 长跑提醒：点“继续” → 一直做、不再问 ————
  const l1 = await work(s, 'web_search', { query: '慢15' });
  const card1 = await waitFor(async () => (await approvals(s)).find((p) => p.sessionId === l1 && p.card?.kind === 'long-run'), 15_000);
  check('长跑提醒：3 秒后发卡片（kind long-run）', card1 !== undefined, card1?.card);
  check('长跑提醒：卡片写已运行、现在在做；“终止”危险色、“继续”普通', card1?.card?.items?.some((i: any) => i.label === '已运行') && card1?.card?.items?.some((i: any) => i.label === '现在在做')
    && card1?.card?.buttons?.[0]?.label === '终止' && card1?.card?.buttons?.[0]?.style === 'danger' && card1?.card?.buttons?.[1]?.label === '继续', card1?.card);
  //G 缺卡时报告具体失败，不把空对象传给渲染器或访问不存在的审批号。
  if (card1 === undefined) throw new Error('继续场景没有收到长跑提醒卡片');
  const fl = JSON.stringify(render.approval(card1));
  note(`（飞书长跑提醒卡片：${fl.slice(0, 500)}）`);
  await api(s, 'POST', `/api/approvals/${card1.id}`, { approve: false });
  await sleep(6000);
  const cards1 = (await approvals(s)).filter((p) => p.sessionId === l1);
  check('长跑提醒：点继续后还在跑、没有第二张、卡片灰着（rejected）', runState(s, l1) === 'running' && cards1.length === 1 && cards1[0]?.card?.state === 'rejected', { state: runState(s, l1), cards: cards1.map((p) => p.card?.state) });
  const done1 = await waitFor(() => runState(s, l1) === 'done' || undefined, 30_000);
  check('长跑提醒：点继续的一直做到完', done1 === true, runState(s, l1));

  // ———— 长跑提醒：点“终止” → 停 ————
  const l2 = await work(s, 'web_search', { query: '慢20' });
  const card2 = await waitFor(async () => (await approvals(s)).find((p) => p.sessionId === l2 && p.card?.kind === 'long-run' && p.card.state === 'waiting'), 15_000);
  //G 只有已登记的长跑卡片才能验证点终止。
  if (card2 === undefined) throw new Error('终止场景没有收到长跑提醒卡片');
  const t2 = Date.now();
  await api(s, 'POST', `/api/approvals/${card2.id}`, { approve: true });
  const stopped = await waitFor(() => (runState(s, l2) !== 'running' ? runState(s, l2) : undefined), 10_000);
  check('长跑提醒：点终止几秒内停下', stopped === 'stopped' && Date.now() - t2 < 5000, `${stopped}（${Date.now() - t2} 毫秒）`);

  // ———— 长跑提醒：不点 → 一直做，做完卡片变灰写“会话已结束” ————
  const l3 = await work(s, 'web_search', { query: '慢8' });
  await waitFor(async () => (await approvals(s)).find((p) => p.sessionId === l3 && p.card?.kind === 'long-run'), 15_000);
  const done3 = await waitFor(() => runState(s, l3) === 'done' || undefined, 30_000);
  await sleep(500);
  const card3 = (await approvals(s)).find((p) => p.sessionId === l3);
  check('长跑提醒：不点也做完；卡片变 ended，写会话已结束', done3 === true && card3?.card?.state === 'ended' && String(card3?.card?.result).includes('会话已结束'), card3?.card);
  const text3 = sessionsOf(s, 'work').find((row) => row.id === l3);
  void text3;

  // ———— 没点号的“同意”不会终止长跑 ————
  const l4 = await work(s, 'web_search', { query: '慢10' });
  await waitFor(async () => (await approvals(s)).find((p) => p.sessionId === l4 && p.card?.kind === 'long-run'), 15_000);
  await api(s, 'POST', '/api/message', { text: '同意' });
  await sleep(2500);
  check('长跑提醒：随口一句“同意”不会停会话', runState(s, l4) === 'running', runState(s, l4));
  await waitFor(() => runState(s, l4) === 'done' || undefined, 30_000);

  // ———— 记忆库：聊天记录 ————
  await api(s, 'POST', '/api/message', { text: '我的订单号是 A123，买的蓝色水杯想退货' });
  await sleep(4000);
  const h1 = await api(s, 'GET', '/api/memory/recall?q=' + encodeURIComponent('订单号 A123') + '&scope=history&customer=' + ME);
  const hit1 = h1.json?.hits?.[0];
  check('记忆库：聊天记录收了，按客户 http:本机能搜到，带会话号和片段', h1.json?.backend === 'http' && hit1?.customer === 'http:本机' && hit1?.source?.startsWith('session:') && hit1?.snippet?.includes('A123'), h1.json);
  const h2 = await api(s, 'GET', '/api/memory/recall?q=A123&scope=history&customer=feishu:ou_x');
  check('记忆库：别的客户搜不到这个客户的', h2.json?.hits?.length === 0, h2.json);

  // ———— 记忆库：知识库 ————
  const k1 = await api(s, 'POST', '/api/memory/knowledge', { name: '售后/退货政策.md', content: '# 退货政策\n\n买了七天内可以无理由退货，运费由买家出。\n\n质量问题十五天内包换，运费我们出。\n' });
  check('记忆库：POST /api/memory/knowledge 写成文件', k1.status === 200 && fs.existsSync(k1.json?.file ?? ''), k1.text);
  //M 统一检索从 Rust 读知识库，验证写入的文件和行号能随引用返回。
  const knowledgeUrl = '/api/memory/search?sources=knowledge&q=';
  const k2 = await api(s, 'GET', knowledgeUrl + encodeURIComponent('七天'));
  const kh = k2.json?.hits?.[0];
  check('记忆库：知识库搜到，带文件和行号、片段', kh?.source === 'knowledge' && kh?.file?.endsWith('退货政策.md') && kh?.start >= 1 && kh?.snippet?.includes('七天'), k2.json);
  fs.writeFileSync(path.join(HERE, 'data1/knowledge/发货.txt'), '下单后四十八小时内发货，偏远地区顺延。\n', 'utf8');
  await sleep(31_000);
  const k3 = await api(s, 'GET', knowledgeUrl + encodeURIComponent('发货'));
  check('记忆库：直接放进 knowledge/ 的文件收进来', k3.json?.hits?.some((h: any) => h.file?.endsWith('发货.txt')), k3.json?.hits);
  const k4 = await api(s, 'GET', '/api/memory/recall?q=');
  check('记忆库：q 空回 400', k4.status === 400, k4.text);
  const k5 = await api(s, 'POST', '/api/memory/knowledge', { name: '../越界.md', content: 'x' });
  check('记忆库：知识库文件越界回 400', k5.status === 400, k5.text);

  // ———— 记忆库：统一检索工具、读取引用原文、开场先搜 ————
  const knowledgeQuery = { sources: 'knowledge', q: '运费' };
  const m1 = await work(s, 'memory_search', knowledgeQuery);
  const mr1 = await toolResult(s, m1);
  check('memory_search 工具：命中知识库文件并带 ref', mr1.includes('退货政策.md') && mr1.includes('/api/memory-graph/passage/'), mr1.slice(0, 400));
  //M 通过检索得到的引用读回整段原文。
  const quoted = { ref: kh?.ref ?? '' };
  const original = await work(s, 'memory_get', quoted);
  const originalText = await toolResult(s, original);
  check('memory_get 工具：从引用读回知识库原文', originalText.includes('七天内可以无理由退货'), originalText.slice(0, 400));
  const historyQuery = { sources: 'history', q: '蓝色水杯' };
  const m2 = await work(s, 'memory_search', historyQuery);
  const mr2 = await toolResult(s, m2);
  check('memory_search 工具：按这个客户搜到以前的订单原话', mr2.includes('"source":"history"') && mr2.includes('我的订单号是 A123，买的蓝色水杯想退货'), mr2.slice(0, 400));
  const meta2 = sessionsOf(s, 'work').find((row) => row.id === m2) as any;
  check('开场先搜：带上这个客户以前说的和知识库', String(meta2?.recall ?? '').includes('可能相关的聊天记录和知识库') && String(meta2?.recall).includes('[1]'), String(meta2?.recall ?? '').slice(0, 500));
  const b1 = await api(s, 'GET', '/api/memory/backend');
  check('记忆库：/api/memory/backend 有 Rust 状态、本地备份片段数、知识库文件数', b1.json?.remote?.ok === true && b1.json?.local?.chunks?.history > 0 && b1.json?.knowledgeFiles === 2, b1.json);
  const ev = await api(s, 'GET', '/api/events?name=Memory.*&limit=20');
  check('journal：Memory.recall 函数行记下了', Array.isArray(ev.json) && ev.json.some((e: any) => e.name === 'Memory.recall'), ev.json?.slice?.(0, 3));
  kill(s.child.pid ?? 0);

  // ———— 独立数据目录验证旧接口的 Rust 请求及本地回落（data3）————
  passages.clear();
  const s3 = await start(path.join(HERE, 'data3'), 15733, 'c');
  await api(s3, 'POST', '/api/message', { text: '我想问一下退货的事' });
  await sleep(4000);
  check('外部后端：聊天记录也送去 /ingest', [...passages.values()].some((doc) => doc.scope === 'history' && doc.text.includes('退货的事')));
  const x1 = await api(s3, 'GET', '/api/memory/recall?q=' + encodeURIComponent('退货的事') + '&scope=history&customer=' + ME);
  check('外部后端：旧检索接口返回假服务的结果', x1.json?.backend === 'http' && x1.json?.hits?.[0]?.score === 0.93 && x1.json?.hits?.[0]?.snippet?.includes('退货的事'), x1.json);
  externalDown = true;
  const x2 = await api(s3, 'GET', '/api/memory/recall?q=' + encodeURIComponent('退货的事') + '&scope=history&customer=' + ME);
  const x3 = await api(s3, 'GET', '/api/memory/backend');
  check('外部后端挂了：退回本地结果，lastError 写原因', x2.json?.hits?.[0]?.snippet?.includes('退货') && String(x3.json?.lastError).includes('503'), { hits: x2.json?.hits?.length, err: x3.json?.lastError });
  const unavailable = await api(s3, 'GET', '/api/memory/search?q=退货&sources=history&customer=' + ME);
  check('统一检索：记忆服务离线，明确标出 history 不可用', unavailable.json?.unavailable?.includes('history') && unavailable.json?.hits?.length === 0, unavailable.json);
  kill(s3.child.pid ?? 0);
}

try {
  await main();
} catch (error) {
  check('脚本自己出错', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  for (const pid of started) kill(pid);
  for (const [config, original] of originalConfigs) {
    //M 隔离服务停止后还原缓存模板。
    fs.writeFileSync(config, original, 'utf8');
  }
  //M 等两个假服务都收尾，再汇总结果和退出。
  const closeActiveConnections = true;
  const stopSearch = search.stop(closeActiveConnections);
  const stopMemory = memory.stop(closeActiveConnections);
  const stops = [stopSearch, stopMemory] as const;
  const [searchResult, memoryResult] = await Promise.allSettled(stops);
  if (searchResult.status === 'rejected') {
    //G 假搜索服务收尾失败也计入验收结果。
    check('关闭假搜索服务', false, searchResult.reason);
  }
  if (memoryResult.status === 'rejected') {
    //G 假检索服务收尾失败也计入验收结果。
    check('关闭假检索服务', false, memoryResult.reason);
  }
  note(`合计：通过 ${passed}，不通 ${failed}`);
  // 2026-11-14 17:55：有不通就退出码 1，test:src7 的退出码才算数（原来总是 0）。
  process.exit(failed > 0 ? 1 : 0);
}
