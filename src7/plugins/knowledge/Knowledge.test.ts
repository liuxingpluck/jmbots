/**
 * 积木知识库（knowledge）离线单测：
 * 覆盖三组表 CRUD、目录树环路防护与安全删目录、专题 topicId 挂载、标签去重与孤儿清理、
 * 磁盘镜像导出、写接口 403/200 鉴权、memory 搜索桥接（未挂载平滑退化 + 已挂载融合）及 kb_search 工具。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import type { Session } from '../../Sessions.ts';
import * as toolsServiceModule from '../../Tools.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as textModule from '../../utils/Text.ts';
import * as dbModule from '../db/index.ts';
import * as knowledgePlugin from './index.ts';


const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});


/** 构造一套独立内存数据库 + 临时运行时目录 + Fastify + Cordis 的测试夹具。 */
async function createKnowledgeHarness() {
  const rootDir = makeTempDir('kb-test-');
  const db = new Database(':memory:');
  const ctx = new cordis.Context();

  const tools = new toolsServiceModule.Tools(ctx);
  const app = fastify.default({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    let status = 500;
    if (error instanceof failureModule.Failure) {
      status = error.status;
    }
    return reply.code(status).send({ error: textModule.getErrorMessage(error) });
  });

  let verified = true;
  //M 和正式 db 插件一样的迁移服务，包同一个连接：知识库建表只走它的账本。
  const migrations = new dbModule.Db(new cordis.Context(), db);
  Object.assign(ctx, {
    db: migrations,
    resources: { root: rootDir, db },
    http: {
      app,
      isVerified: () => verified,
      requireVerified: (_req: unknown, what: string) => {
        if (verified) return;

        throw new failureModule.Failure(403, `${what}需要先完成身份核验`);
      },
    },
    tools,
  });

  knowledgePlugin.apply(ctx);
  await app.ready();

  return {
    ctx,
    db,
    app,
    tools,
    rootDir,
    mirrorRoot: path.join(rootDir, 'knowledge'),
    setVerified(v: boolean) {
      verified = v;
    },
    async close() {
      await app.close();
      await ctx.fiber.dispose();
      db.close();
    },
  };
}


describe('knowledge 三表 CRUD、目录环路防护、专题挂载与磁盘镜像', () => {
  test('虚拟目录建树、防环路移动，且删除目录绝不误删下属文档', async () => {
    const h = await createKnowledgeHarness();
    try {
      const rRoot = await h.app.inject({
        method: 'POST',
        url: '/api/knowledge/dirs',
        payload: { id: 'dir_arch', name: '系统架构', sortOrder: 1 },
      });
      expect(rRoot.statusCode).toBe(200);

      const rChild = await h.app.inject({
        method: 'POST',
        url: '/api/knowledge/dirs',
        payload: { id: 'dir_aobb', parentId: 'dir_arch', name: 'AOBB 浏览器方案', sortOrder: 2 },
      });
      expect(rChild.statusCode).toBe(200);

      // 尝试将父目录移入子目录 -> 400 环路拦截
      const badCycle = await h.app.inject({
        method: 'PUT',
        url: '/api/knowledge/dirs/dir_arch',
        payload: { parentId: 'dir_aobb' },
      });
      expect(badCycle.statusCode).toBe(400);

      // 在子目录下创建一篇挂载到工作台专题的文档
      const docRes = await h.app.inject({
        method: 'POST',
        url: '/api/knowledge/docs',
        payload: {
          dirId: 'dir_aobb',
          topicId: 'h60-aobb-aaa',
          title: 'AOBB 内嵌浏览器定法纪要',
          content: '# 核心结论\n采用 A1+A2+A3 零弹窗按需连接 CDP 方案。',
          sourceType: 'note',
          tags: ['#AOBB', '浏览器', 'aobb'],
        },
      });
      expect(docRes.statusCode).toBe(200);
      const createdDoc = docRes.json<{ ok: boolean; doc: knowledgePlugin.KnowledgeDoc }>().doc;
      expect(createdDoc.tags).toEqual(['AOBB', '浏览器']);
      expect(createdDoc.summary).toContain('核心结论');

      // 检查磁盘镜像 YYYYMMDD/<id>_<标题>/{content.md, meta.json} 已导出
      const dayFolder = knowledgePlugin.formatDateFolder(createdDoc.createdAt);
      const dayPath = path.join(h.mirrorRoot, dayFolder);
      const exportedDirs = fs.readdirSync(dayPath);
      expect(exportedDirs.length).toBe(1);
      const docMirrorDir = path.join(dayPath, exportedDirs[0]!);
      expect(fs.readFileSync(path.join(docMirrorDir, 'content.md'), 'utf8')).toContain('A1+A2+A3');

      // 检查 tree 接口：层级结构、标签计数与专题计数
      const treeRes = await h.app.inject({ method: 'GET', url: '/api/knowledge/tree' });
      expect(treeRes.statusCode).toBe(200);
      const tree = treeRes.json<knowledgePlugin.KnowledgeTreeResponse>();
      expect(tree.totalDocs).toBe(1);
      expect(tree.dirs.length).toBe(1);
      expect(tree.dirs[0]?.children.length).toBe(1);
      expect(tree.dirs[0]?.children[0]?.docCount).toBe(1);
      expect(tree.topics).toEqual([{ topicId: 'h60-aobb-aaa', docCount: 1 }]);
      expect(tree.tags.map((t) => t.name)).toEqual(['AOBB', '浏览器']);

      // 先删父目录 dir_arch -> 子目录 dir_aobb 自动上提到顶层
      const delRoot = await h.app.inject({ method: 'DELETE', url: '/api/knowledge/dirs/dir_arch' });
      expect(delRoot.statusCode).toBe(200);

      // 再删子目录 dir_aobb -> 原文档绝不被删，自动变为未归目录（dirId: null）
      const delChild = await h.app.inject({ method: 'DELETE', url: '/api/knowledge/dirs/dir_aobb' });
      expect(delChild.statusCode).toBe(200);

      const checkDoc = await h.app.inject({
        method: 'GET',
        url: `/api/knowledge/docs/${createdDoc.id}`,
      });
      expect(checkDoc.statusCode).toBe(200);
      expect(checkDoc.json<{ doc: knowledgePlugin.KnowledgeDoc }>().doc.dirId).toBeNull();
    } finally {
      await h.close();
    }
  });

  test('多维筛选（topicId / tag / q / 分页）、更新改名同步清理旧镜像及孤儿标签回收', async () => {
    const h = await createKnowledgeHarness();
    try {
      const d1 = (await h.app.inject({
        method: 'POST',
        url: '/api/knowledge/docs',
        payload: {
          topicId: 'topic-frpc',
          title: '外网隧道安全门禁规范',
          content: '30086 端口必须映射到 192.168.200.1，严禁用 127.0.0.1。',
          tags: ['安全', 'FRPC'],
        },
      })).json<{ doc: knowledgePlugin.KnowledgeDoc }>().doc;

      await h.app.inject({
        method: 'POST',
        url: '/api/knowledge/docs',
        payload: {
          topicId: 'topic-voice',
          title: '离线语音 SenseVoice 转写笔记',
          content: '使用 sherpa-onnx-node 本地 INT8 推理。',
          sourceType: 'transcript',
          tags: ['ASR'],
        },
      });

      // 按 topicId 筛选
      const byTopic = await h.app.inject({
        method: 'GET',
        url: '/api/knowledge/docs?topicId=topic-frpc',
      });
      expect(byTopic.json<{ total: number }>().total).toBe(1);

      // 按带 # 的标签筛选（大小写不敏感）
      const byTag = await h.app.inject({
        method: 'GET',
        url: `/api/knowledge/docs?tag=${encodeURIComponent('#frpc')}`,
      });
      expect(byTag.json<{ total: number }>().total).toBe(1);

      // 更新 d1 标题并去掉 '安全' 标签 -> 验证孤儿标签被自动清理且旧镜像目录被替换
      const upd = await h.app.inject({
        method: 'PUT',
        url: `/api/knowledge/docs/${d1.id}`,
        payload: {
          title: 'FRPC 外网隧道终版守则',
          tags: ['FRPC'],
        },
      });
      expect(upd.statusCode).toBe(200);

      const dayPath = path.join(h.mirrorRoot, knowledgePlugin.formatDateFolder(d1.createdAt));
      const matchingFolders = fs.readdirSync(dayPath).filter((name) => name.startsWith(`${d1.id}_`));
      expect(matchingFolders.length).toBe(1);
      expect(matchingFolders[0]).toContain('FRPC-外网隧道终版守则');

      const treeAfterUpdate = (await h.app.inject({ method: 'GET', url: '/api/knowledge/tree' }))
        .json<knowledgePlugin.KnowledgeTreeResponse>();
      expect(treeAfterUpdate.tags.map((t) => t.name)).toEqual(['ASR', 'FRPC']);

      // 删除 d1 -> 磁盘镜像与 FRPC 孤儿标签一并清理
      const del = await h.app.inject({ method: 'DELETE', url: `/api/knowledge/docs/${d1.id}` });
      expect(del.statusCode).toBe(200);
      const remainingFolders = fs.readdirSync(dayPath).filter((name) => name.startsWith(`${d1.id}_`));
      expect(remainingFolders.length).toBe(0);
    } finally {
      await h.close();
    }
  });

  test('G1 乐观锁：baseUpdatedAt 对得上才保存，过期回 409 带最新文档，不传照常保存', async () => {
    const h = await createKnowledgeHarness();
    try {
      const created = (await h.app.inject({
        method: 'POST',
        url: '/api/knowledge/docs',
        payload: { title: '并发编辑样例', content: '第一版' },
      })).json<{ doc: knowledgePlugin.KnowledgeDoc }>().doc;

      //M 带上看到的 updatedAt：对得上，保存成功。
      const matched = await h.app.inject({
        method: 'PUT',
        url: `/api/knowledge/docs/${created.id}`,
        payload: { content: '电脑上改的第二版', baseUpdatedAt: created.updatedAt },
      });
      expect(matched.statusCode).toBe(200);
      const fresh = matched.json<{ doc: knowledgePlugin.KnowledgeDoc }>().doc;
      expect(fresh.content).toBe('电脑上改的第二版');

      //M 拿过期的 updatedAt 再存（同一毫秒内两次保存时间戳可能相同，所以减 1 保证一定过期）：回 409，带回库里最新的。
      const stale = await h.app.inject({
        method: 'PUT',
        url: `/api/knowledge/docs/${created.id}`,
        payload: { content: '手机上改的旧版', baseUpdatedAt: fresh.updatedAt - 1 },
      });
      expect(stale.statusCode).toBe(409);
      const conflict = stale.json<{ ok: boolean; error: string; doc: knowledgePlugin.KnowledgeDoc }>();
      expect(conflict.ok).toBe(false);
      expect(conflict.error).toContain('已在别处更新');
      expect(conflict.doc.content).toBe('电脑上改的第二版');

      //M 不带 baseUpdatedAt：照旧直接保存。
      const legacy = await h.app.inject({
        method: 'PUT',
        url: `/api/knowledge/docs/${created.id}`,
        payload: { content: '不带版本的第三版' },
      });
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json<{ doc: knowledgePlugin.KnowledgeDoc }>().doc.content).toBe('不带版本的第三版');

      //G baseUpdatedAt 不是整数：入口拒绝。
      const bad = await h.app.inject({
        method: 'PUT',
        url: `/api/knowledge/docs/${created.id}`,
        payload: { content: 'x', baseUpdatedAt: '123' },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await h.close();
    }
  });

  test('G3 多标签交集：单标签兼容、双标签交集命中与不命中、空与重复标签归一，搜索同样生效', async () => {
    const h = await createKnowledgeHarness();
    try {
      //M 三篇：A 带 安全+FRPC，B 只带 安全，C 带 FRPC+ASR。
      const seeds = [
        { title: '隧道 A', tags: ['安全', 'FRPC'] },
        { title: '隧道 B', tags: ['安全'] },
        { title: '隧道 C', tags: ['FRPC', 'ASR'] },
      ];
      for (const payload of seeds) {
        await h.app.inject({ method: 'POST', url: '/api/knowledge/docs', payload: { ...payload, content: '正文' } });
      }

      /** 列表接口按某个查询串筛，交回命中的标题（排好序）。 */
      const listTitles = async (search: string): Promise<string[]> => {
        const res = await h.app.inject({ method: 'GET', url: `/api/knowledge/docs?${search}` });
        expect(res.statusCode).toBe(200);
        const body = res.json<{ items: knowledgePlugin.KnowledgeDocSummary[]; total: number }>();
        expect(body.total).toBe(body.items.length);
        return body.items.map((item) => item.title).sort();
      };
      const safe = encodeURIComponent('安全');
      const asr = encodeURIComponent('ASR');

      //M 单个 tag 照旧；重复 tag、tags 逗号都是交集，大小写不敏感。
      expect(await listTitles(`tag=${safe}`)).toEqual(['隧道 A', '隧道 B']);
      expect(await listTitles(`tag=${safe}&tag=frpc`)).toEqual(['隧道 A']);
      expect(await listTitles(`tags=${safe},FRPC`)).toEqual(['隧道 A']);
      expect(await listTitles(`tags=${safe},${asr}`)).toEqual([]);

      //M 空项、带 # 的重复项归成一个。
      const messy = encodeURIComponent(',安全,#安全, ');
      expect(await listTitles(`tags=${messy}`)).toEqual(['隧道 A', '隧道 B']);

      //M 搜索接口也按交集筛。
      const found = await h.app.inject({
        method: 'GET',
        url: `/api/knowledge/search?q=${encodeURIComponent('隧道')}&tags=${safe},frpc&includeMemory=0`,
      });
      expect(found.statusCode).toBe(200);
      const hits = found.json<{ hits: knowledgePlugin.KnowledgeSearchHit[] }>().hits;
      expect(hits.map((hit) => hit.title)).toEqual(['隧道 A']);

      //G 云端 30 #1：标签名带逗号（中英文）写入时拒绝；筛选标签超过 20 个拒绝，20 个照常。
      for (const bad of ['a,b', '甲，乙']) {
        const payload = { title: 'x', tags: [bad] };
        const res = await h.app.inject({ method: 'POST', url: '/api/knowledge/docs', payload });
        expect(res.statusCode).toBe(400);
        expect(res.json<{ error: string }>().error).toContain('标签名不能包含逗号');
      }
      //G 0.7.90 审计：纯点号标签名拼进路径会被规范化吃掉，写入时拒绝；带点的普通名字照常。
      for (const bad of ['.', '..', '...']) {
        const payload = { title: 'x', tags: [bad] };
        const res = await h.app.inject({ method: 'POST', url: '/api/knowledge/docs', payload });
        expect(res.statusCode).toBe(400);
        expect(res.json<{ error: string }>().error).toContain('标签名不能只有点号');
      }
      const dottedPayload = { title: 'x', tags: ['v0.7'] };
      const dotted = await h.app.inject({ method: 'POST', url: '/api/knowledge/docs', payload: dottedPayload });
      expect(dotted.statusCode).toBe(200);
      const many = Array.from({ length: 21 }, (_, index) => `t${String(index)}`);
      const tooMany = await h.app.inject({ method: 'GET', url: `/api/knowledge/docs?tags=${many.join(',')}` });
      expect(tooMany.statusCode).toBe(400);
      expect(tooMany.json<{ error: string }>().error).toContain('最多 20 个');
      const twenty = many.slice(0, 20).join(',');
      const enough = await h.app.inject({ method: 'GET', url: `/api/knowledge/docs?tags=${twenty}` });
      expect(enough.statusCode).toBe(200);
    } finally {
      await h.close();
    }
  });

  test('安全边界回归：镜像防 kb/kb_2 前缀误删、禁冒号 ID、LIKE 通配符转义与自动摘要重算', async () => {
    const h = await createKnowledgeHarness();
    try {
      // 1) 禁止含冒号的自定义 ID（防 Windows 目录名报错）
      const colonRes = await h.app.inject({
        method: 'POST',
        url: '/api/knowledge/docs',
        payload: { id: 'bad:id', title: '非法冒号' },
      });
      expect(colonRes.statusCode).toBe(400);

      // 2) 创建 kb 与 kb_2 两篇前缀重叠文档，更新/删除 kb 绝不误删 kb_2_ 目录
      const resKb = await h.app.inject({
        method: 'POST',
        url: '/api/knowledge/docs',
        payload: { id: 'kb', title: '第一篇', content: '初始正文，覆盖率 50 点' },
      });
      expect(resKb.statusCode).toBe(200);
      const docKb = resKb.json<{ doc: knowledgePlugin.KnowledgeDoc }>().doc;

      const resKb2 = await h.app.inject({
        method: 'POST',
        url: '/api/knowledge/docs',
        payload: { id: 'kb_2', title: '第二篇', content: '压测通过率达到 100% 且含 key_val 字段' },
      });
      expect(resKb2.statusCode).toBe(200);

      // 更新 kb 正文（未手动传 summary） -> 自动摘要应同步重算，且 kb_2 镜像目录完好
      const updKb = await h.app.inject({
        method: 'PUT',
        url: '/api/knowledge/docs/kb',
        payload: { title: '第一篇改名', content: '全新改写后的正文内容' },
      });
      expect(updKb.statusCode).toBe(200);
      expect(updKb.json<{ doc: knowledgePlugin.KnowledgeDoc }>().doc.summary).toBe('全新改写后的正文内容');

      // 3) LIKE 通配符转义：搜 '100%' 与 'key_val' 只精确命中 kb_2，不误扫全表
      const pctSearch = await h.app.inject({
        method: 'GET',
        url: `/api/knowledge/search?q=${encodeURIComponent('100%')}`,
      });
      const pctHits = pctSearch.json<knowledgePlugin.KnowledgeSearchResponse>().hits;
      expect(pctHits.map((x) => x.id)).toEqual(['kb_2']);

      // 删除 kb 后，kb_2 的磁盘镜像目录与 meta.json 依然完好无损
      await h.app.inject({ method: 'DELETE', url: '/api/knowledge/docs/kb' });
      const dayPath = path.join(h.mirrorRoot, knowledgePlugin.formatDateFolder(docKb.createdAt));
      const dirsLeft = fs.readdirSync(dayPath);
      expect(dirsLeft).toEqual(['kb_2_第二篇']);

      // 4) 即使磁盘镜像写抛异常，Store 入库仍以 SQLite 事务为准正常成功不抛错
      const brokenStore = new knowledgePlugin.KnowledgeStore(h.db, {
        rootDir: h.mirrorRoot,
        writeDoc() {
          throw new Error('模拟磁盘只读异常');
        },
        removeDoc() {
          throw new Error('模拟磁盘删除异常');
        },
      } as unknown as knowledgePlugin.DiskMirror);
      const savedDespiteIo = brokenStore.createDoc({ id: 'kb_io_ok', title: '事务优先入库' });
      expect(savedDespiteIo.id).toBe('kb_io_ok');
      expect(brokenStore.getDoc('kb_io_ok')?.title).toBe('事务优先入库');
    } finally {
      await h.close();
    }
  });
});


describe('knowledge 写操作 403 身份核验、memory 搜索桥接与 kb_search 模型工具', () => {
  test('所有 POST/PUT/DELETE 路由在未核验时一律返回 403，核验通过返回 200', async () => {
    const h = await createKnowledgeHarness();
    try {
      h.setVerified(false);

      const checks = [
        h.app.inject({ method: 'POST', url: '/api/knowledge/dirs', payload: { name: 'x' } }),
        h.app.inject({ method: 'PUT', url: '/api/knowledge/dirs/d1', payload: { name: 'y' } }),
        h.app.inject({ method: 'DELETE', url: '/api/knowledge/dirs/d1' }),
        h.app.inject({ method: 'POST', url: '/api/knowledge/docs', payload: { title: 't' } }),
        h.app.inject({ method: 'PUT', url: '/api/knowledge/docs/doc1', payload: { title: 't2' } }),
        h.app.inject({ method: 'DELETE', url: '/api/knowledge/docs/doc1' }),
      ];
      const results = await Promise.all(checks);
      for (const res of results) {
        expect(res.statusCode).toBe(403);
      }

      h.setVerified(true);
      const okRes = await h.app.inject({
        method: 'POST',
        url: '/api/knowledge/dirs',
        payload: { name: '已核验目录' },
      });
      expect(okRes.statusCode).toBe(200);
    } finally {
      await h.close();
    }
  });

  test('GET /api/knowledge/search 与 kb_search 工具：未挂载 memory 零报错退化，挂载后融合记忆片段', async () => {
    const h = await createKnowledgeHarness();
    try {
      const created = (await h.app.inject({
        method: 'POST',
        url: '/api/knowledge/docs',
        payload: {
          topicId: 'h60-kb-s23',
          title: '积木知识库三原子设计原稿',
          summary: '文档原子、标签速搜、虚拟目录三大基石',
          content: 'SQLite 做唯一事务真源，外部机器通过 30086 HTTP API 协同读写。',
          tags: ['知识库', '架构'],
        },
      })).json<{ doc: knowledgePlugin.KnowledgeDoc }>().doc;

      // 1) 未挂载 memory 插件时：平滑退化仅返本地命中，零报错
      const degraded = await h.app.inject({
        method: 'GET',
        url: `/api/knowledge/search?q=${encodeURIComponent('三原子')}`,
      });
      expect(degraded.statusCode).toBe(200);
      const degradedBody = degraded.json<knowledgePlugin.KnowledgeSearchResponse>();
      expect(degradedBody.memoryAvailable).toBe(false);
      expect(degradedBody.memoryHits).toEqual([]);
      expect(degradedBody.hits.length).toBe(1);
      expect(degradedBody.hits[0]?.id).toBe(created.id);

      // 2) 模拟挂载 memory/request 响应器：验证融合返回记忆命中
      const disposeMem = requestEventModule.onRequestEvent(
        h.ctx,
        'memory/request',
        'memory/result',
        async (req) => {
          if (req.action !== 'search') return { ok: false, error: 'unsupported' };
          return {
            ok: true,
            search: {
              mode: 'hybrid' as const,
              unavailable: [],
              skipped: [],
              total_ms: 3,
              hits: [
                {
                  source: 'knowledge' as const,
                  id: 'mem_1',
                  title: 'jdai 历史记忆卡片',
                  snippet: '单进程持有 SQLite 写库，杜绝跨盘 WAL 锁冲突。',
                  score: 0.95,
                  at: 1700000000000,
                  ref: 'projects/jdai.md:37',
                  via: ['hybrid'],
                  customer: '',
                  bot: 'main',
                },
              ],
            },
          };
        },
      );

      const fused = await h.app.inject({
        method: 'GET',
        url: `/api/knowledge/search?q=${encodeURIComponent('SQLite')}`,
      });
      expect(fused.statusCode).toBe(200);
      const fusedBody = fused.json<knowledgePlugin.KnowledgeSearchResponse>();
      expect(fusedBody.memoryAvailable).toBe(true);
      expect(fusedBody.hits.length).toBe(1);
      expect(fusedBody.memoryHits.length).toBe(1);
      expect(fusedBody.memoryHits[0]?.ref).toBe('projects/jdai.md:37');

      // 3) 验证模型工具 kb_search（front 与 work 均可用：总览、检索、按 docId 读正文）
      const frontTools = h.tools.listToolsForSessionKind('front').map((t) => t.name);
      const workTools = h.tools.listToolsForSessionKind('work').map((t) => t.name);
      expect(frontTools).toContain('kb_search');
      expect(workTools).toContain('kb_search');

      const fakeSession = {
        id: 's1',
        row: { id: 's1', kind: 'front', state: 'running', bot: 'main', messages: [] },
      } as unknown as Session;
      const overviewOut = await h.tools.execute(
        { type: 'toolCall', id: 'c1', name: 'kb_search', arguments: {} },
        fakeSession,
        new AbortController().signal,
      );
      expect(overviewOut.isError).toBe(false);
      expect(overviewOut.text).toContain('h60-kb-s23(1篇)');

      const searchOut = await h.tools.execute(
        { type: 'toolCall', id: 'c2', name: 'kb_search', arguments: { query: 'SQLite' } },
        fakeSession,
        new AbortController().signal,
      );
      expect(searchOut.isError).toBe(false);
      expect(searchOut.text).toContain(`docId=${created.id}`);
      expect(searchOut.text).toContain('projects/jdai.md:37');

      const detailOut = await h.tools.execute(
        { type: 'toolCall', id: 'c3', name: 'kb_search', arguments: { docId: created.id } },
        fakeSession,
        new AbortController().signal,
      );
      expect(detailOut.isError).toBe(false);
      expect(detailOut.text).toContain('唯一事务真源');

      disposeMem();
    } finally {
      await h.close();
    }
  });
});

/** 按文档 ID 在镜像目录里找 meta.json 读出来（YYYYMMDD/<id>_<标题>/meta.json）。 */
function readMirrorMeta(mirrorRoot: string, id: string): { tags: string[] } | undefined {
  for (const day of fs.readdirSync(mirrorRoot)) {
    const dayDir = path.join(mirrorRoot, day);
    const folder = fs.readdirSync(dayDir).find((name) => name.startsWith(`${id}_`));
    if (folder !== undefined) return JSON.parse(fs.readFileSync(path.join(dayDir, folder, 'meta.json'), 'utf8'));
  }
  return undefined;
}


/** 用本人会话调一次 kb_save，交回工具结果。 */
async function callSave(h: Awaited<ReturnType<typeof createKnowledgeHarness>>, args: Record<string, unknown>, session?: Session) {
  const owner = {
    id: 's-owner',
    row: { id: 's-owner', kind: 'front', state: 'running', bot: 'main', messages: [] },
  } as unknown as Session;
  const toolArgs = args as Parameters<typeof h.tools.execute>[0]['arguments'];
  const call = { type: 'toolCall' as const, id: `save-${String(Date.now())}`, name: 'kb_save', arguments: toolArgs };
  return await h.tools.execute(call, session ?? owner, new AbortController().signal);
}


describe('knowledge 1.0.2：kb_save 写工具、标签治理与相关文档推荐', () => {
  test('kb_save：前后台都有；新建要标题正文；追加不盖原文；替换要 baseUpdatedAt，过期给最新时间；外人拒绝', async () => {
    const h = await createKnowledgeHarness();
    try {
      expect(h.tools.listToolsForSessionKind('front').map((t) => t.name)).toContain('kb_save');
      expect(h.tools.listToolsForSessionKind('work').map((t) => t.name)).toContain('kb_save');

      //M 新建：缺正文报错；齐了建出来，标签去 # 去重。
      const missing = await callSave(h, { title: '只有标题' });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('title 和 content');
      const created = await callSave(h, { title: 'AOBB 方案', content: '第一段', tags: ['#AOBB', 'aobb', '浏览器'] });
      expect(created.isError).toBe(false);
      const docId = /docId=(\S+)/u.exec(created.text)?.[1] ?? '';
      const fresh = (await h.app.inject({ method: 'GET', url: `/api/knowledge/docs/${docId}` })).json().doc;
      expect(fresh.sourceType).toBe('note');
      expect(fresh.tags.sort()).toEqual(['AOBB', '浏览器'].sort());

      //M 追加（默认）：原文原样留着，新内容空一行接在后面。
      const appended = await callSave(h, { docId, content: '第二段' });
      expect(appended.isError).toBe(false);
      const afterAppend = (await h.app.inject({ method: 'GET', url: `/api/knowledge/docs/${docId}` })).json().doc;
      expect(afterAppend.content).toBe('第一段\n\n第二段');

      //M 替换：不带 baseUpdatedAt 拒绝；带旧的拒绝并给出最新 updatedAt；带对的才替换。
      const noBase = await callSave(h, { docId, mode: 'replace', content: '全新' });
      expect(noBase.isError).toBe(true);
      expect(noBase.text).toContain(String(afterAppend.updatedAt));
      const stale = await callSave(h, { docId, mode: 'replace', content: '全新', baseUpdatedAt: afterAppend.updatedAt - 1 });
      expect(stale.isError).toBe(true);
      expect(stale.text).toContain(`最新 updatedAt 是 ${String(afterAppend.updatedAt)}`);
      const replaced = await callSave(h, { docId, mode: 'replace', content: '全新', baseUpdatedAt: afterAppend.updatedAt });
      expect(replaced.isError).toBe(false);
      expect((await h.app.inject({ method: 'GET', url: `/api/knowledge/docs/${docId}` })).json().doc.content).toBe('全新');

      //M 标签超 20 个、文档不存在都报错。
      const many = Array.from({ length: 21 }, (_v, i) => `t${String(i)}`);
      expect((await callSave(h, { title: 'x', content: 'y', tags: many })).text).toContain('最多 20 个');
      expect((await callSave(h, { docId: 'nope', content: 'y' })).text).toContain('没有这篇');

      //M 外人（飞书 guest）那一轮：拒绝写。
      const guest = {
        id: 's-guest',
        row: { id: 's-guest', kind: 'front', state: 'running', bot: 'main', messages: [], channel: 'feishu',
          address: { role: 'guest' } },
      } as unknown as Session;
      const denied = await callSave(h, { title: '外人写的', content: '内容' }, guest);
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('只有本人');
    } finally {
      await h.close();
    }
  });

  test('标签治理：改名、并进已有标签、删除都刷镜像；不存在回 404，未核验回 403', async () => {
    const h = await createKnowledgeHarness();
    try {
      const make = async (title: string, tags: string[]) => {
        const res = await h.app.inject({ method: 'POST', url: '/api/knowledge/docs', payload: { title, content: '正文', tags } });
        return res.json().doc.id as string;
      };
      const a = await make('甲', ['旧名', '公共']);
      const b = await make('乙', ['旧名']);
      const c = await make('丙', ['公共']);

      //M 改名：新名字没有 → 原地改名。
      const renamed = await h.app.inject({ method: 'PUT', url: `/api/knowledge/tags/${encodeURIComponent('旧名')}`, payload: { newName: '新名' } });
      const renamedBody: unknown = renamed.json();
      expect(renamedBody).toEqual({ ok: true, oldName: '旧名', newName: '新名', merged: false, affectedDocs: 2 });
      expect(readMirrorMeta(h.mirrorRoot, b)?.tags).toEqual(['新名']);

      //M 合并：新名字已存在 → 甲两个都挂着（主键冲突忽略），乙、丙都并到「公共」。
      const merged = await h.app.inject({ method: 'PUT', url: `/api/knowledge/tags/${encodeURIComponent('新名')}`, payload: { newName: '公共' } });
      const mergedBody: unknown = merged.json();
      expect(mergedBody).toEqual({ ok: true, oldName: '新名', newName: '公共', merged: true, affectedDocs: 2 });
      expect(readMirrorMeta(h.mirrorRoot, a)?.tags).toEqual(['公共']);
      expect(readMirrorMeta(h.mirrorRoot, b)?.tags).toEqual(['公共']);
      const tree = (await h.app.inject({ method: 'GET', url: '/api/knowledge/tree' })).json();
      expect(tree.tags).toEqual([expect.objectContaining({ name: '公共', docCount: 3 })]);

      //M 删除：解除关联、文档还在、镜像里标签清空。
      const removed = await h.app.inject({ method: 'DELETE', url: `/api/knowledge/tags/${encodeURIComponent('公共')}` });
      const removedBody: unknown = removed.json();
      expect(removedBody).toEqual({ ok: true, name: '公共', affectedDocs: 3 });
      expect(readMirrorMeta(h.mirrorRoot, c)?.tags).toEqual([]);
      expect((await h.app.inject({ method: 'GET', url: `/api/knowledge/docs/${c}` })).statusCode).toBe(200);

      //M 边界：不存在 404；新名字带逗号 400；缺 newName 400；未核验 403。
      expect((await h.app.inject({ method: 'DELETE', url: '/api/knowledge/tags/nothing' })).statusCode).toBe(404);
      await make('丁', ['某'] );
      expect((await h.app.inject({ method: 'PUT', url: '/api/knowledge/tags/%E6%9F%90', payload: { newName: 'a,b' } })).statusCode).toBe(400);
      expect((await h.app.inject({ method: 'PUT', url: '/api/knowledge/tags/%E6%9F%90', payload: {} })).statusCode).toBe(400);
      h.setVerified(false);
      expect((await h.app.inject({ method: 'PUT', url: '/api/knowledge/tags/%E6%9F%90', payload: { newName: 'x' } })).statusCode).toBe(403);
      expect((await h.app.inject({ method: 'DELETE', url: '/api/knowledge/tags/%E6%9F%90' })).statusCode).toBe(403);
    } finally {
      await h.close();
    }
  });

  test('相关文档：同专题 +3、共同标签各 +2、同目录 +1，排除自己和 0 分，同分新的在前，limit 生效，不存在 404', async () => {
    const h = await createKnowledgeHarness();
    try {
      await h.app.inject({ method: 'POST', url: '/api/knowledge/dirs', payload: { id: 'dir_x', name: '目录' } });
      const make = async (payload: Record<string, unknown>) => {
        const res = await h.app.inject({ method: 'POST', url: '/api/knowledge/docs', payload: { content: '正文', ...payload } });
        return res.json().doc.id as string;
      };
      const self = await make({ title: '本篇', topicId: 'h60-aobb', dirId: 'dir_x', tags: ['AOBB', '浏览器'] });
      const topicAndTag = await make({ title: '同专题同标签', topicId: 'h60-aobb', tags: ['AOBB'] });
      const twoTags = await make({ title: '两个共同标签', tags: ['AOBB', '浏览器'] });
      const dirOnlyOld = await make({ title: '同目录旧', dirId: 'dir_x' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const dirOnlyNew = await make({ title: '同目录新', dirId: 'dir_x' });
      await make({ title: '无关', tags: ['别的'] });

      const res = await h.app.inject({ method: 'GET', url: `/api/knowledge/docs/${self}/related` });
      const body = res.json();
      expect(body.docId).toBe(self);
      expect(body.items.map((item: { id: string }) => item.id)).toEqual([topicAndTag, twoTags, dirOnlyNew, dirOnlyOld]);
      expect(body.items.map((item: { score: number }) => item.score)).toEqual([5, 4, 1, 1]);
      expect(body.items[0].reasons).toEqual(['同专题', '共同标签: AOBB']);
      expect(body.items[1].reasons).toEqual(['共同标签: AOBB、浏览器']);
      expect(body.items[2].reasons).toEqual(['同目录']);

      const limited = await h.app.inject({ method: 'GET', url: `/api/knowledge/docs/${self}/related?limit=2` });
      expect(limited.json().items.length).toBe(2);
      expect((await h.app.inject({ method: 'GET', url: '/api/knowledge/docs/nope/related' })).statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });
});


describe('建表走 db 迁移账本（云端 36 第 1 条）', () => {
  const TABLES = "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kb_%' ORDER BY name";
  const LEDGER = "SELECT version FROM db_migrations WHERE plugin = 'knowledge' ORDER BY version";

  test('新库：两版迁移建齐四张表，账本记两版；重启只核对摘要', async () => {
    const h = await createKnowledgeHarness();
    try {
      const names = h.db.query<{ name: string }, []>(TABLES).all().map((row) => row.name);
      expect(names).toEqual(['kb_dirs', 'kb_doc_tags', 'kb_docs', 'kb_tags']);
      expect(h.db.query<{ version: number }, []>(LEDGER).all()).toEqual([{ version: 1 }, { version: 2 }]);

      //M 第 2 版把整串语句按分隔符拆开，第 1 版原样不动（老库账本的哈希要对得上）。
      expect(knowledgePlugin.knowledgeMigrations.migrations[0]?.sql).toBe(knowledgePlugin.SCHEMA_SQL);
      const parts = knowledgePlugin.knowledgeMigrations.migrations[1]?.sql.split('--> statement-breakpoint') ?? [];
      expect(parts.length).toBe(9);

      //M 同一连接再挂一次：已登记的两版只核对，不报错。
      const again = new dbModule.Db(new cordis.Context(), h.db);
      again.migrate(knowledgePlugin.knowledgeMigrations);
    } finally {
      await h.close();
    }
  });

  test('老库（0.7.90 记过第 1 版、表由旧构造函数建齐、有数据）：升到第 2 版，数据原样', () => {
    const db = new Database(':memory:');
    try {
      //M 模拟老库：旧代码记了第 1 版账本（只建出 kb_dirs），又靠构造函数 exec 把四张表建齐、写了一篇。
      const old = new dbModule.Db(new cordis.Context(), db);
      old.migrate({ plugin: 'knowledge', migrations: [{ version: 1, sql: knowledgePlugin.SCHEMA_SQL }] });
      db.exec(knowledgePlugin.SCHEMA_SQL);
      const insert = "INSERT INTO kb_docs (id, title, created_at, updated_at) VALUES ('kb_old', '老文档', 1, 1)";
      db.exec(insert);

      //M 新代码挂上：第 1 版哈希对得上只核对，第 2 版全是 IF NOT EXISTS，不动已有数据。
      const upgraded = new dbModule.Db(new cordis.Context(), db);
      upgraded.migrate(knowledgePlugin.knowledgeMigrations);
      expect(db.query<{ version: number }, []>(LEDGER).all()).toEqual([{ version: 1 }, { version: 2 }]);
      const store = new knowledgePlugin.KnowledgeStore(db);
      expect(store.getDoc('kb_old')?.title).toBe('老文档');
    } finally {
      db.close();
    }
  });
});

