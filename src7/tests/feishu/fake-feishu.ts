/**
 * 假飞书：离线测 src7 飞书插件用。bun 跑，端口 15703。
 * 开放接口（令牌、发消息、表情、资源、上传、云文档、权限、删除）照飞书的样子回；长连接走真的 WebSocket，
 * 帧照 SDK 的 pbbp2.Frame 手写 protobuf 编解码，所以插件收事件走的是 SDK 真实的那条路。
 * 测试控制：POST /test/push 推一个事件；POST /test/fail 让接下来几次某个接口回 429；POST /test/kick 断开长连接；
 * GET /test/log 看收到的调用；GET /test/acks 看插件对推送事件的回应（卡片 toast）。
 */
const PORT = 15703;
const log: { at: number; method: string; path: string; body: unknown; id?: string; status?: number }[] = [];
const acks: Record<string, unknown> = {};
const fails: { method: string; path: string; times: number }[] = [];
// 2026-11-14 17:40：插件先用“回复”接口（/messages/:id/reply）发，回复体里没有 receive_id；推事件时记下消息号 → 会话，回复记日志时补上，测试照会话找。
const chatOf: Record<string, string> = {};
const sockets = new Set<any>();
let seq = 0;
const tables: Record<string, string[]> = {};
const tableSize: Record<string, { rows: number; cols: number }> = {};
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

// ---------- protobuf（pbbp2.Frame / Header） ----------
function varint(n: number): number[] { const out: number[] = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v > 0n) b |= 0x80; out.push(b); } while (v > 0n); return out; }
function bytesField(no: number, data: Uint8Array): number[] { return [...varint((no << 3) | 2), ...varint(data.length), ...data]; }
const enc = new TextEncoder(); const dec = new TextDecoder();
function encodeFrame(f: { seq: number; log: number; service: number; method: number; headers: [string, string][]; payload?: Uint8Array }): Uint8Array {
  const out: number[] = [8, ...varint(f.seq), 16, ...varint(f.log), 24, ...varint(f.service), 32, ...varint(f.method)];
  for (const [k, v] of f.headers) out.push(...bytesField(5, Uint8Array.from([...bytesField(1, enc.encode(k)), ...bytesField(2, enc.encode(v))])));
  if (f.payload) out.push(...bytesField(8, f.payload));
  return Uint8Array.from(out);
}
function readVarint(b: Uint8Array, i: number): [number, number] { let r = 0n, s = 0n; for (;;) { const x = b[i++]!; r |= BigInt(x & 0x7f) << s; s += 7n; if (!(x & 0x80)) break; } return [Number(r), i]; }
function decodeMsg(b: Uint8Array): Record<number, (number | Uint8Array)[]> {
  const out: Record<number, (number | Uint8Array)[]> = {}; let i = 0;
  while (i < b.length) { let key; [key, i] = readVarint(b, i); const no = key >> 3, wt = key & 7; let val: number | Uint8Array;
    if (wt === 0) { [val, i] = readVarint(b, i); } else if (wt === 2) { let len; [len, i] = readVarint(b, i); val = b.slice(i, i + len); i += len; } else throw new Error('wire ' + wt);
    (out[no] ??= []).push(val); }
  return out;
}
function decodeFrame(b: Uint8Array) {
  const m = decodeMsg(b);
  const headers: Record<string, string> = {};
  for (const h of (m[5] ?? []) as Uint8Array[]) { const hm = decodeMsg(h); headers[dec.decode(hm[1]![0] as Uint8Array)] = dec.decode(hm[2]![0] as Uint8Array); }
  return { method: (m[4]?.[0] as number) ?? 0, headers, payload: m[8]?.[0] as Uint8Array | undefined };
}

// ---------- 工具 ----------
const ok = (data: unknown = {}) => Response.json({ code: 0, msg: 'success', data });
function shouldFail(method: string, path: string): boolean {
  const f = fails.find((x) => x.method === method && path.startsWith(x.path) && x.times > 0);
  if (!f) return false; f.times--; return true;
}

const server = Bun.serve({
  port: PORT, hostname: '127.0.0.1',
  async fetch(req, srv) {
    const url = new URL(req.url); const path = url.pathname; const method = req.method;
    if (path === '/ws') { return srv.upgrade(req) ? undefined : new Response('no', { status: 400 }); }
    // ---- 测试控制 ----
    if (path === '/test/log') return Response.json(log);
    if (path === '/test/acks') return Response.json(acks);
    if (path === '/test/clear') { log.length = 0; return Response.json({ ok: true }); }
    if (path === '/test/fail') { const b = await req.json() as any; fails.push(b); return Response.json({ ok: true }); }
    if (path === '/test/kick') { for (const s of sockets) s.close(1006 > 0 ? 4000 : 1000, 'kick'); return Response.json({ ok: true, n: sockets.size }); }
    if (path === '/test/push') {
      const event = await req.json() as any; const id = `evt_${++seq}`;
      const pushed = event?.event?.message; if (pushed?.message_id) chatOf[pushed.message_id] = pushed.chat_id;
      const frame = encodeFrame({ seq, log: seq, service: 1, method: 1, headers: [['type', 'event'], ['message_id', id], ['sum', '1'], ['seq', '0'], ['trace_id', id]], payload: enc.encode(JSON.stringify(event)) });
      for (const s of sockets) s.send(frame);
      return Response.json({ ok: true, id, sockets: sockets.size });
    }
    // ---- 开放接口 ----
    let body: unknown = null;
    const type = req.headers.get('content-type') ?? '';
    if (type.includes('json')) body = await req.json().catch(() => null);
    else if (type.includes('multipart')) { const f = await req.formData(); body = Object.fromEntries([...f.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<file ${(v as Blob).size}B>`])); }
    if (!path.startsWith('/open-apis/auth')) log.push({ at: Date.now(), method, path: path + url.search, body });
    if (shouldFail(method, path)) { log[log.length - 1]!.status = 429; return Response.json({ code: 99991400, msg: 'request trigger frequency limit' }, { status: 429 }); }

    if (path === '/callback/ws/endpoint') return Response.json({ code: 0, data: { URL: `ws://127.0.0.1:${PORT}/ws?device_id=d1&service_id=1`, ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 2, ReconnectNonce: 1 } } });
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') return Response.json({ code: 0, msg: 'ok', tenant_access_token: 't-fake', expire: 7200 });
    if (path === '/open-apis/bot/v3/info') return Response.json({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot', app_name: '假机器人' } });
    if (path === '/open-apis/im/v1/messages' && method === 'POST') { const id = `om_out_${++seq}`; log[log.length - 1]!.id = id; return ok({ message_id: id }); }
    let m;
    if ((m = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(path)) && method === 'POST') { const id = `om_out_${++seq}`; const entry = log[log.length - 1]!; entry.id = id; entry.body = { ...(body as object), receive_id: chatOf[m[1]!] }; return ok({ message_id: id }); }
    if ((m = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reactions$/.exec(path))) return ok({ reaction_id: `r_${++seq}` });
    if ((m = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reactions\/([^/]+)$/.exec(path))) return ok({});
    if ((m = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/resources\/([^/]+)$/.exec(path))) return new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } });
    if ((m = /^\/open-apis\/im\/v1\/messages\/([^/]+)$/.exec(path))) {
      if (method === 'PATCH') return ok({});
      if (m[1] === 'om_fwd') return ok({ items: [
        { message_id: 'om_fwd', msg_type: 'merge_forward', body: { content: '{}' } },
        { message_id: 'om_f1', upper_message_id: 'om_fwd', msg_type: 'text', create_time: '1763100000000', body: { content: '{"text":"转发第一条"}' } },
        { message_id: 'om_f2', upper_message_id: 'om_fwd', msg_type: 'image', create_time: '1763100060000', body: { content: '{"image_key":"img_fwd_00000002"}' } } ] });
      return ok({ items: [{ message_id: m[1], msg_type: 'text', body: { content: '{"text":"被引用的那句"}' } }] });
    }
    if (path === '/open-apis/im/v1/images') return ok({ image_key: `img_up_${++seq}` });
    if (path === '/open-apis/im/v1/files') return ok({ file_key: `file_up_${++seq}` });
    if (path === '/open-apis/docx/v1/documents' && method === 'POST') return ok({ document: { document_id: `doc_${++seq}`, revision_id: 1, title: (body as any)?.title } });
    if ((m = /^\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks\/([^/]+)\/children$/.exec(path))) {
      const children = ((body as any)?.children ?? []) as any[];
      return ok({ children: children.map((c) => { const id = `blk_${++seq}`; if (c.block_type === 31) { const p = c.table.property; tableSize[id] = { rows: p.row_size, cols: p.column_size }; } return { block_id: id, block_type: c.block_type }; }) });
    }
    if ((m = /^\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks\/([^/]+)$/.exec(path))) {
      const id = m[2]!;
      if (method === 'PATCH') { const b = body as any; if (b?.insert_table_row) tableSize[id]!.rows++; if (b?.insert_table_column) tableSize[id]!.cols++; return ok({ block: { block_id: id } }); }
      const t = tableSize[id]!; tables[id] = Array.from({ length: t.rows * t.cols }, (_, i) => `${id}_c${i}`);
      return ok({ block: { block_id: id, block_type: 31, children: tables[id], table: { property: { row_size: t.rows, column_size: t.cols } } } });
    }
    if (path === '/open-apis/drive/v1/medias/upload_all') return ok({ file_token: `ft_${++seq}` });
    if ((m = /^\/open-apis\/drive\/v1\/permissions\/([^/]+)\/members$/.exec(path))) return ok({ member: {} });
    if ((m = /^\/open-apis\/drive\/v1\/permissions\/([^/]+)\/public$/.exec(path))) return ok({});
    if ((m = /^\/open-apis\/drive\/v1\/files\/([^/]+)$/.exec(path))) {
      if (m[1]!.startsWith('doc_')) return ok({ task_id: '' });
      return Response.json({ code: 1061007, msg: 'file has been delete.' }, { status: 400 });
    }
    return Response.json({ code: 404, msg: `假飞书没有这个接口 ${method} ${path}` }, { status: 404 });
  },
  websocket: {
    open(ws) { sockets.add(ws); console.log(new Date().toISOString(), 'ws open', sockets.size); },
    close(ws) { sockets.delete(ws); console.log(new Date().toISOString(), 'ws close', sockets.size); },
    message(ws, data) {
      // 挪进 src7 后吃 tsc：帧是二进制（Buffer），文本帧不会来。
      const f = decodeFrame(typeof data === 'string' ? enc.encode(data) : new Uint8Array(data));
      if (f.method === 1 && f.headers['message_id']) {
        const p = f.payload ? JSON.parse(dec.decode(f.payload)) : null;
        if (p?.data) p.decoded = JSON.parse(Buffer.from(p.data, 'base64').toString('utf8'));
        acks[f.headers['message_id']] = p;
      }
    },
  },
});
console.log('假飞书在', server.port);
