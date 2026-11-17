/**
 * 飞书插件端到端测试：假模型 + 假飞书（15703）+ 测试服务（15694）。bun src7/tests/feishu/e2e.ts [步骤名...]
 * 一般不单跑，用 src7/tests/Feishu_Test.ts（自己起假飞书和测试服务、跑完关掉）。
 * 2026-11-14 17:50：从 cache/test-src7-feishu 挪到这里；测试数据目录还在 cache/test-src7-feishu。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
const F = 'http://127.0.0.1:15703', S = 'http://127.0.0.1:15694';
const DIR = path.resolve(import.meta.dir, '../../..', 'cache/test-src7-feishu');
const WS = path.join(DIR, 'bots', '助手', 'workspace');
const results: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const j = async (url: string, body?: unknown) => (await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
const log = () => j(`${F}/test/log`) as Promise<any[]>;
const sentTo = async (chat: string) => (await log()).filter((x) => x.method === 'POST' && (x.path.startsWith('/open-apis/im/v1/messages?') || /^\/open-apis\/im\/v1\/messages\/[^/?]+\/reply/.test(x.path)) && x.body?.receive_id === chat && x.status !== 429);
const textOf = (x: any) => { try { return JSON.parse(x.body.content).text ?? ''; } catch { return ''; } };
async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 90000): Promise<T | undefined> { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(1000); } return undefined; }
function check(name: string, ok: boolean, detail = '') { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`; results.push(line); console.log(line); }
let n = 0;
function msgEvent(id: string, chat: string, chatType: string, type: string, content: unknown, extra: any = {}) {
  return { schema: '2.0', header: { event_id: `ev_${id}_${++n}`, event_type: 'im.message.receive_v1', create_time: String(Date.now()), token: '', app_id: 'cli_a1b2c3d4e5f60789', tenant_key: 't' },
    event: { sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' }, message: { message_id: id, chat_id: chat, chat_type: chatType, message_type: type, content: JSON.stringify(content), create_time: String(Date.now()), ...extra } } };
}
function cardEvent(cardId: string, value: unknown) {
  return { schema: '2.0', header: { event_id: `ev_card_${++n}`, event_type: 'card.action.trigger', create_time: String(Date.now()), token: '', app_id: 'cli_a1b2c3d4e5f60789', tenant_key: 't' },
    event: { operator: { open_id: 'ou_user' }, token: 'c', action: { tag: 'button', value }, context: { open_message_id: cardId, open_chat_id: 'oc_p2p' } } };
}
async function replyAfter(chat: string, before: number, re: RegExp, ms = 90000) {
  return waitFor(async () => (await sentTo(chat)).slice(before).find((x) => re.test(textOf(x))), ms);
}
const push = (e: unknown) => j(`${F}/test/push`, e);
const steps = process.argv.slice(2);
const want = (s: string) => steps.length === 0 || steps.includes(s);

if (want('status')) {
  const st = await waitFor(async () => { const s = await j(`${S}/test/status`).catch(() => null); return s?.channels?.[0]?.connected ? s : undefined; }, 120000);
  check('连接状态：已连上', !!st, JSON.stringify(st?.channels));
}
if (want('p2p')) {
  const before = (await sentTo('oc_p2p')).length;
  await push(msgEvent('om_p1', 'oc_p2p', 'p2p', 'text', { text: '现在几点了' }));
  const r = await replyAfter('oc_p2p', before, /现在是/);
  check('私聊“现在几点了”→ 假飞书收到回复', !!r, r ? textOf(r) : '');
  const l = await log();
  const reacted = l.filter((x) => x.method === 'POST' && x.path === '/open-apis/im/v1/messages/om_p1/reactions');
  const removed = await waitFor(async () => (await log()).some((x) => x.method === 'DELETE' && x.path.startsWith('/open-apis/im/v1/messages/om_p1/reactions/')), 20000);
  check('挂“敲键盘”表情、回完撤掉', reacted.length === 1 && !!removed, `挂 ${reacted.length} 次，撤 ${removed ? '是' : '否'}`);
  // 去重：同一条再推一次
  const after = (await sentTo('oc_p2p')).length;
  await push(msgEvent('om_p1', 'oc_p2p', 'p2p', 'text', { text: '现在几点了' }));
  await sleep(12000);
  const again = (await sentTo('oc_p2p')).length;
  const reacted2 = (await log()).filter((x) => x.method === 'POST' && x.path === '/open-apis/im/v1/messages/om_p1/reactions').length;
  check('重复事件去重', again === after && reacted2 === 1, `再推后多发 ${again - after} 条，表情 ${reacted2} 次`);
}
if (want('group')) {
  const before = (await sentTo('oc_group')).length;
  await push(msgEvent('om_g1', 'oc_group', 'group', 'text', { text: '现在几点了' }));
  await sleep(15000);
  check('群里不 @ 不回', (await sentTo('oc_group')).length === before);
  await push(msgEvent('om_g2', 'oc_group', 'group', 'text', { text: '@_user_1 现在几点了' }, { mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '助手' }] }));
  const r = await replyAfter('oc_group', before, /现在是/);
  check('群里 @ 了回', !!r, r ? textOf(r) : '');
  await push(msgEvent('om_g3', 'oc_group', 'group', 'text', { text: '@_user_2 你好' }, { mentions: [{ key: '@_user_2', id: { open_id: 'ou_other' }, name: '别人' }] }));
  await sleep(12000);
  check('群里 @ 别人不回', (await sentTo('oc_group')).length === before + 1);
}
if (want('image')) {
  const before = (await sentTo('oc_p2p')).length;
  await push(msgEvent('om_i1', 'oc_p2p', 'p2p', 'image', { image_key: 'img_v3_abcdef12' }));
  const r = await replyAfter('oc_p2p', before, /现在是/);
  const day = new Date().toLocaleDateString('sv-SE');
  const dir = path.join(WS, 'inbox', day);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('image_abcdef12.png')) : [];
  const size = files[0] ? fs.statSync(path.join(dir, files[0])).size : 0;
  check('图片下载进工作区', files.length === 1 && size > 50, `${dir}/${files[0] ?? '（没有）'} ${size}B；回话 ${r ? '有' : '无'}`);
  const jsonl = fs.readFileSync(path.join(DIR, 'channels', 'feishu', `${day}.jsonl`), 'utf8');
  // 2026-11-14 18:25：jsonl 里反斜杠是转义过的，逐行解开再比；Windows 上分隔符是 \。
  const texts = jsonl.split('\n').filter((line) => line.trim() !== '').map((line) => { try { return String(JSON.parse(line).text ?? ''); } catch { return ''; } });
  check('给机器人的话里有 @绝对路径', texts.some((text) => text.includes(`@${dir}${path.sep}`) || text.includes(`@${dir}/`)));
}
if (want('forward')) {
  const before = (await sentTo('oc_p2p')).length;
  await push(msgEvent('om_fwd', 'oc_p2p', 'p2p', 'merge_forward', {}));
  await push(msgEvent('om_q1', 'oc_p2p', 'p2p', 'text', { text: '看这句' }, { parent_id: 'om_parent' }));
  await replyAfter('oc_p2p', before, /现在是/);
  const jsonl = fs.readFileSync(path.join(DIR, 'channels', 'feishu', `${new Date().toLocaleDateString('sv-SE')}.jsonl`), 'utf8');
  check('合并转发逐条取回', jsonl.includes('[合并转发]') && jsonl.includes('1. ') && jsonl.includes('转发第一条'));
  // 2026-11-14 17:40：插件把引用写成“【回复的消息：…】”（不再是 [引用] …），按现在的写法验。
  check('引用的那条取回', jsonl.includes('【回复的消息：被引用的那句】'));
}
if (want('429')) {
  await j(`${F}/test/fail`, { method: 'POST', path: '/open-apis/im/v1/messages', times: 2 });
  const before = (await sentTo('oc_p2p')).length;
  const t0 = Date.now();
  await push(msgEvent('om_p429', 'oc_p2p', 'p2p', 'text', { text: '现在几点了' }));
  const r = await replyAfter('oc_p2p', before, /现在是/);
  const limited = (await log()).filter((x) => x.status === 429 && x.at >= t0).length;
  check('429 退让重试后发出', !!r && limited === 2, `429 ${limited} 次后成功`);
}
if (want('outbox')) {
  const box = path.join(DIR, 'integrations', 'feishu', 'outbox');
  fs.mkdirSync(box, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'a.png'), fs.readFileSync(path.join(DIR, 'a-src.png')));
  const before = (await sentTo('oc_p2p')).length;
  fs.writeFileSync(path.join(box, '1.md'), `发件箱测试 你好 @${path.join(DIR, 'a.png')}`);
  fs.writeFileSync(path.join(box, '2.md'), '');
  const r = await replyAfter('oc_p2p', before, /发件箱测试/, 20000);
  await sleep(3000);
  const img = (await sentTo('oc_p2p')).slice(before).find((x) => x.body.msg_type === 'image');
  const moved = fs.existsSync(path.join(DIR, 'integrations', 'feishu', 'sent', '1.md')) && fs.existsSync(path.join(DIR, 'integrations', 'feishu', 'sent', '2.md')) && !fs.existsSync(path.join(box, '1.md'));
  check('发件箱发出、挪进 sent', !!r && moved, r ? textOf(r) : '');
  check('文字里的 @图片 换成「文件名」并发出图片', !!r && textOf(r).includes('「a.png」') && !!img);
}
if (want('doc')) {
  fs.mkdirSync(WS, { recursive: true });
  const rows = ['|' + Array.from({ length: 11 }, (_, i) => `列${i}`).join('|') + '|', '|' + Array(11).fill('-').join('|') + '|', ...Array.from({ length: 11 }, (_, r) => '|' + Array.from({ length: 11 }, (_, c) => `${r}-${c}`).join('|') + '|')];
  fs.writeFileSync(path.join(WS, 'test.md'), `# 测试\n\n段落 **粗** [相对](../a.md) [网](https://x.cn)\n\n- 一\n- 二\n1. 甲\n\n\`\`\`ts\nlet a = 1\n\`\`\`\n\n${rows.join('\n')}\n`);
  fs.copyFileSync(path.join(DIR, 'a-src.png'), path.join(WS, 'a.png'));
  const before = (await sentTo('oc_p2p')).length;
  const t0 = Date.now();
  await push(msgEvent('om_doc1', 'oc_p2p', 'p2p', 'text', { text: '调用 hand_session {"text":"调用 feishu_doc {\\"title\\":\\"测试文档\\",\\"markdown\\":\\"test.md\\",\\"images\\":[\\"a.png\\"]}"}' }));
  const r = await replyAfter('oc_p2p', before, /飞书文档/, 150000);
  const l = (await log()).filter((x) => x.at >= t0);
  const kinds = l.filter((x) => /\/children$/.test(x.path)).flatMap((x) => (x.body?.children ?? []).map((c: any) => c.block_type));
  const rowsAdded = l.filter((x) => x.body?.insert_table_row).length, colsAdded = l.filter((x) => x.body?.insert_table_column).length;
  check('飞书文档工具生成块', !!r && /已发布飞书文档《测试文档》/.test(textOf(r)) && [27, 3, 2, 12, 13, 14, 31].every((k) => kinds.includes(k)),
    `${r ? textOf(r) : '没有回话'}；块类型 ${[...new Set(kinds)].join(',')}；加行 ${rowsAdded} 加列 ${colsAdded}；传图 ${l.some((x) => x.path.includes('upload_all'))}；换图 ${l.some((x) => x.body?.replace_image)}；权限 ${l.some((x) => x.path.includes('/members'))}`);
  const docId = /docx\/(doc_\d+)/.exec(r ? textOf(r) : '')?.[1] ?? 'doc_0';
  const b2 = (await sentTo('oc_p2p')).length;
  await push(msgEvent('om_doc2', 'oc_p2p', 'p2p', 'text', { text: `调用 hand_session {"text":"调用 feishu_doc_delete {\\"documents\\":[\\"${docId}\\",\\"x\\"]}"}` }));
  const r2 = await replyAfter('oc_p2p', b2, /回收站|删不掉/, 150000);
  check('飞书文档删除', !!r2 && /已放进回收站 1 篇/.test(textOf(r2)) && /删不掉 1 篇：x/.test(textOf(r2)), r2 ? textOf(r2) : '');
}
if (want('card')) {
  const before = (await sentTo('oc_p2p')).length;
  await j(`${S}/test/ask`, { kind: 'exec', bot: '助手', title: '跑 dir', detail: 'dir' });
  const card = await waitFor(async () => (await sentTo('oc_p2p')).slice(before).find((x) => x.body.msg_type === 'interactive'), 20000);
  check('待确认卡片发出', !!card && card.body.content.includes('approve'), card?.id);
  const ev = await push(cardEvent(card?.id ?? 'none', { action: 'approve' }));
  const ack = await waitFor(async () => (await j(`${F}/test/acks`))[ev.id], 20000);
  const patched = await waitFor(async () => (await log()).find((x) => x.method === 'PATCH' && x.path === `/open-apis/im/v1/messages/${card?.id}`), 20000);
  check('点“同意执行”→ toast、卡片变灰', ack?.decoded?.toast?.content === '已同意执行' && !!patched && !patched.body.content.includes('approve'), JSON.stringify(ack?.decoded));
  const ev2 = await push(cardEvent(card?.id ?? 'none', { action: 'approve' }));
  const ack2 = await waitFor(async () => (await j(`${F}/test/acks`))[ev2.id], 20000);
  check('再点 → 已经处理过了', /已经处理过了/.test(ack2?.decoded?.toast?.content ?? ''), ack2?.decoded?.toast?.content);
  const ev3 = await push(cardEvent('om_unknown', { action: 'approve' }));
  const ack3 = await waitFor(async () => (await j(`${F}/test/acks`))[ev3.id], 20000);
  check('不认得的卡片 → 这个按钮没有用了', ack3?.decoded?.toast?.content === '这个按钮没有用了');
}
if (want('progress')) {
  const before = (await sentTo('oc_p2p')).length;
  const t0 = Date.now();
  const p = await j(`${S}/test/progress`, { stage: 'running' });
  const card = await waitFor(async () => (await sentTo('oc_p2p')).slice(before).find((x) => x.body.msg_type === 'interactive'), 20000);
  await j(`${S}/test/progress`, { stage: 'running' });
  const patched = await waitFor(async () => (await log()).find((x) => x.at >= t0 && x.method === 'PATCH' && x.path === `/open-apis/im/v1/messages/${card?.id}`), 20000);
  const ev = await push(cardEvent(card?.id ?? 'none', { action: 'stop' }));
  const ack = await waitFor(async () => (await j(`${F}/test/acks`))[ev.id], 20000);
  check('进度卡片：发、原地改、点终止', !!card && !!patched && ack?.decoded?.toast?.content === '收到，马上停', `会话 ${p.sessionId}；${JSON.stringify(ack?.decoded)}`);
}
if (want('reconnect')) {
  await j(`${F}/test/kick`, {});
  const st = await waitFor(async () => { const s = await j(`${S}/test/status`); return /已重连/.test(s.channels?.[0]?.detail ?? '') && s.channels[0].connected ? s : undefined; }, 60000);
  check('断线重连：状态“已重连”', !!st, JSON.stringify(st?.channels));
}
fs.writeFileSync(path.join(DIR, 'e2e-result.txt'), results.join('\n') + '\n');
console.log(`\n${results.filter((x) => x.startsWith('PASS')).length}/${results.length} 通过`);
// 有不通的就让退出码非 0，test:src7 才看得出来。
if (results.some((x) => !x.startsWith('PASS'))) process.exitCode = 1;
