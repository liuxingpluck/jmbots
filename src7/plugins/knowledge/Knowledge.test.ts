/**
 * 积木知识库（knowledge）离线单测：
 * 覆盖三组表 CRUD、目录树环路防护与安全删目录、专题 topicId 挂载、标签去重与孤儿清理、
 * 磁盘镜像导出、写接口 403/200 鉴权、memory 搜索桥接（未挂载平滑退化 + 已挂载融合）及 kb_search 工具；
 * 1.2.0 起加上别名（CRUD、搜索排序、双链唯一别名命中与歧义不连）、消歧接口与工具、本地目录只读同步。
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


/**
 * 构造一套独立内存数据库 + 临时运行时目录 + Fastify + Cordis 的测试夹具。
 * @param config 可选插件配置（如 localWatchDirs）。
 */
async function createKnowledgeHarness(config?: unknown) {
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
      isLocal: () => true,
      isVerified: () => verified,
      requireVerified: (_req: unknown, what: string) => {
        if (verified) return;

        throw new failureModule.Failure(403, `${what}需要先完成身份核验`);
      },
    },
    tools,
  });

  knowledgePlugin.apply(ctx, config);
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

  test('新库：五版迁移建齐五张表，账本记五版；重启只核对摘要', async () => {
    const h = await createKnowledgeHarness();
    try {
      const names = h.db.query<{ name: string }, []>(TABLES).all().map((row) => row.name);
      expect(names).toEqual(['kb_dirs', 'kb_doc_tags', 'kb_docs', 'kb_links', 'kb_tags']);
      const versions = [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }];
      expect(h.db.query<{ version: number }, []>(LEDGER).all()).toEqual(versions);

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

  test('老库（0.7.90 记过第 1 版、表由旧构造函数建齐、有数据）：升到第 5 版，数据原样', () => {
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
      const versions = [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }];
      expect(db.query<{ version: number }, []>(LEDGER).all()).toEqual(versions);
      const store = new knowledgePlugin.KnowledgeStore(db);
      expect(store.getDoc('kb_old')?.title).toBe('老文档');
      expect(store.getDoc('kb_old')?.isSystemRule).toBe(false);
    } finally {
      db.close();
    }
  });
});



describe('knowledge 1.1.0：[[双链]]、图谱、多标签 all/any、硬性系统规则', () => {
  const LEDGER = "SELECT version FROM db_migrations WHERE plugin = 'knowledge' ORDER BY version";

  /** 新建一篇，交回 ID。 */
  const make = async (
    h: Awaited<ReturnType<typeof createKnowledgeHarness>>,
    payload: Record<string, unknown>,
  ): Promise<string> => {
    const res = await h.app.inject({ method: 'POST', url: '/api/knowledge/docs', payload });
    expect(res.statusCode).toBe(200);
    return res.json().doc.id as string;
  };

  /** 一条没有歧义的引出链接：targetId 是 null 就是悬空。 */
  const getOutlink = (targetTitle: string, targetId: string | null): knowledgePlugin.KnowledgeOutlink => ({
    targetTitle,
    targetId,
    exists: targetId !== null,
    ambiguous: false,
  });

  /** 读一篇的引出和反向链接。 */
  const getLinks = async (h: Awaited<ReturnType<typeof createKnowledgeHarness>>, id: string) => {
    const res = await h.app.inject({ method: 'GET', url: `/api/knowledge/docs/${id}/links` });
    expect(res.statusCode).toBe(200);
    return res.json<knowledgePlugin.KnowledgeLinksResponse>();
  };

  test('parseWikiLinks：别名、去重、跳过围栏代码块和行内代码', () => {
    const content = [
      '先看 [[甲]]，再看 [[乙|第二篇]]，[[ 甲 ]] 和 [[A]]、[[a]] 都算重复。',
      '行内 `[[代码里]]` 不算，``[[双反引号]]`` 也不算。',
      '```ts',
      'const x = "[[围栏里]]";',
      '```',
      '~~~',
      '[[波浪围栏]]',
      '~~~',
      '空的 [[ ]] 不算，[[丙]] 算。',
    ].join('\n');
    const links = knowledgePlugin.parseWikiLinks(content);
    expect(links).toEqual([
      { title: '甲', alias: undefined },
      { title: '乙', alias: '第二篇' },
      { title: 'A', alias: undefined },
      { title: '丙', alias: undefined },
    ]);
  });

  test('正反链：建文档时连上已有的，悬空的在目标新建、改名后回填，删目标后置空', async () => {
    const h = await createKnowledgeHarness();
    try {
      const target = await make(h, { title: '飞书接入', content: '正文' });
      const source = await make(h, { title: '总览', content: '见 [[飞书接入]] 和 [[还没写|待写]]，`[[代码]]` 不算。' });

      //M 引出：一条连上、一条悬空；反链：飞书接入被总览引用。
      const out = await getLinks(h, source);
      expect(out.outgoing).toEqual([
        getOutlink('飞书接入', target),
        getOutlink('还没写', null),
      ]);
      expect(out.backlinks).toEqual([]);
      const back = await getLinks(h, target);
      expect(back.backlinks.map((item) => item.id)).toEqual([source]);
      expect(back.backlinks[0]?.title).toBe('总览');

      //M 新建同名（大小写不敏感也算）：悬空的自动连上。
      const later = await make(h, { title: '还没写', content: '补上了' });
      expect((await getLinks(h, source)).outgoing[1]).toEqual(getOutlink('还没写', later));

      //M 改名：旧标题的链接断开，指向新标题的悬空链接连上。
      const waiting = await make(h, { title: '等改名', content: '指向 [[新名字]]' });
      expect((await getLinks(h, waiting)).outgoing[0]?.exists).toBe(false);
      const renamed = await h.app.inject({ method: 'PUT', url: `/api/knowledge/docs/${later}`, payload: { title: '新名字' } });
      expect(renamed.statusCode).toBe(200);
      expect((await getLinks(h, waiting)).outgoing[0]).toEqual(getOutlink('新名字', later));
      expect((await getLinks(h, source)).outgoing[1]).toEqual(getOutlink('还没写', null));

      //M 改正文：引出链接跟着重写。
      await h.app.inject({ method: 'PUT', url: `/api/knowledge/docs/${source}`, payload: { content: '只剩 [[新名字]]' } });
      expect((await getLinks(h, source)).outgoing).toEqual([getOutlink('新名字', later)]);
      expect((await getLinks(h, target)).backlinks).toEqual([]);

      //M 删目标：指向它的链接留着、置空；删源头：它写出去的一起删。
      await h.app.inject({ method: 'DELETE', url: `/api/knowledge/docs/${later}` });
      expect((await getLinks(h, source)).outgoing).toEqual([getOutlink('新名字', null)]);
      await h.app.inject({ method: 'DELETE', url: `/api/knowledge/docs/${source}` });
      const left = h.db.query<{ cnt: number }, [string]>('SELECT COUNT(*) AS cnt FROM kb_links WHERE source_id = ?');
      expect(left.get(source)?.cnt).toBe(0);
      expect((await h.app.inject({ method: 'GET', url: '/api/knowledge/docs/nope/links' })).statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });

  test('图谱：全库节点带度数；centerId 只要一跳邻居；自链和悬空不画；中心不存在 404', async () => {
    const h = await createKnowledgeHarness();
    try {
      const a = await make(h, { title: 'A', content: '[[B]] [[C]] [[A]] [[不存在]]', tags: ['核心'] });
      const b = await make(h, { title: 'B', content: '[[C]]' });
      const c = await make(h, { title: 'C', content: '' });
      const d = await make(h, { title: 'D', content: '[[C]]' });
      const lone = await make(h, { title: '孤立', content: '' });

      const all = (await h.app.inject({ method: 'GET', url: '/api/knowledge/graph' })).json<knowledgePlugin.KnowledgeGraphResponse>();
      expect(all.nodes.map((node) => node.id).sort()).toEqual([a, b, c, d, lone].sort());
      const degreeOf = (graph: knowledgePlugin.KnowledgeGraphResponse, id: string) =>
        graph.nodes.find((node) => node.id === id)?.degree;
      expect(degreeOf(all, a)).toBe(2);
      expect(degreeOf(all, c)).toBe(3);
      expect(degreeOf(all, lone)).toBe(0);
      expect(all.nodes.find((node) => node.id === a)?.tags).toEqual(['核心']);
      expect(all.nodes.find((node) => node.id === a)?.dirId).toBeNull();
      expect(typeof all.nodes.find((node) => node.id === a)?.summary).toBe('string');
      expect(all.edges.length).toBe(4);
      expect(all.edges).toContainEqual({ source: a, target: b, targetTitle: 'B' });

      //M 以 B 为中心：A→B、B→C 两条边，节点 A、B、C；D 只连 C，不算 B 的一跳邻居。
      const centered = await h.app.inject({ method: 'GET', url: `/api/knowledge/graph?centerId=${b}` });
      const graph = centered.json<knowledgePlugin.KnowledgeGraphResponse>();
      expect(graph.nodes.map((node) => node.id).sort()).toEqual([a, b, c].sort());
      expect(graph.edges.length).toBe(2);
      expect(degreeOf(graph, b)).toBe(2);
      expect((await h.app.inject({ method: 'GET', url: '/api/knowledge/graph?centerId=nope' })).statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });

  test('多标签 tagMode：all 取交集（默认）、any 取并集，列表和搜索都生效，写错 400', async () => {
    const h = await createKnowledgeHarness();
    try {
      await make(h, { title: '隧道 A', content: '正文', tags: ['安全', 'FRPC'] });
      await make(h, { title: '隧道 B', content: '正文', tags: ['安全'] });
      await make(h, { title: '隧道 C', content: '正文', tags: ['FRPC', 'ASR'] });
      await make(h, { title: '隧道 D', content: '正文', tags: ['别的'] });

      const listTitles = async (search: string): Promise<string[]> => {
        const res = await h.app.inject({ method: 'GET', url: `/api/knowledge/docs?${search}` });
        expect(res.statusCode).toBe(200);
        return res.json<{ items: knowledgePlugin.KnowledgeDocSummary[] }>().items.map((item) => item.title).sort();
      };
      const safe = encodeURIComponent('安全');
      expect(await listTitles(`tags=${safe},FRPC`)).toEqual(['隧道 A']);
      expect(await listTitles(`tags=${safe},FRPC&tagMode=all`)).toEqual(['隧道 A']);
      expect(await listTitles(`tags=${safe},FRPC&tagMode=any`)).toEqual(['隧道 A', '隧道 B', '隧道 C']);
      expect(await listTitles(`tags=${safe},asr&tagMode=any`)).toEqual(['隧道 A', '隧道 B', '隧道 C']);
      expect(await listTitles(`tag=${safe}&tagMode=any`)).toEqual(['隧道 A', '隧道 B']);

      const found = await h.app.inject({
        method: 'GET',
        url: `/api/knowledge/search?q=${encodeURIComponent('隧道')}&tags=${safe},asr&tagMode=any&includeMemory=0`,
      });
      const hits = found.json<{ hits: knowledgePlugin.KnowledgeSearchHit[] }>().hits;
      expect(hits.map((hit) => hit.title).sort()).toEqual(['隧道 A', '隧道 B', '隧道 C']);

      const bad = await h.app.inject({ method: 'GET', url: `/api/knowledge/docs?tags=${safe}&tagMode=xor` });
      expect(bad.statusCode).toBe(400);
    } finally {
      await h.close();
    }
  });

  test('硬性系统规则：网页可建可改可筛，kb_save 不能建、不能追加替换，kb_search 照常读', async () => {
    const h = await createKnowledgeHarness();
    try {
      const rule = await make(h, { title: '回复规则', content: '不准透露价格', isSystemRule: true });
      const normal = await make(h, { title: '普通笔记', content: '随便写' });
      const ruleDoc = (await h.app.inject({ method: 'GET', url: `/api/knowledge/docs/${rule}` })).json().doc;
      expect(ruleDoc.isSystemRule).toBe(true);
      expect(readMirrorMeta(h.mirrorRoot, rule)).toEqual(expect.objectContaining({ isSystemRule: true }));

      //M 筛选与统计：systemRule=1 只看规则，树里有篇数。
      const only = (await h.app.inject({ method: 'GET', url: '/api/knowledge/docs?systemRule=1' })).json();
      expect(only.items.map((item: { id: string }) => item.id)).toEqual([rule]);
      expect((await h.app.inject({ method: 'GET', url: '/api/knowledge/tree' })).json().systemRuleDocs).toBe(1);

      //M kb_save：建带标记的、追加、替换、只改标题都拒，原文不动。
      const denied = '该文档为硬性系统规则，AI 仅可读不可修改，请由用户本人在知识库网页操作';
      const tries = [
        { title: '偷建', content: 'x', isSystemRule: true },
        { docId: rule, content: '追加一句' },
        { docId: rule, mode: 'replace', content: '全改', baseUpdatedAt: ruleDoc.updatedAt },
        { docId: rule, title: '改个标题' },
      ];
      for (const args of tries) {
        const result = await callSave(h, args);
        expect(result.isError).toBe(true);
        expect(result.text).toContain(denied);
      }
      const after = (await h.app.inject({ method: 'GET', url: `/api/knowledge/docs/${rule}` })).json().doc;
      expect(after.content).toBe('不准透露价格');
      expect(after.title).toBe('回复规则');
      expect((await callSave(h, { docId: normal, content: '普通的照常追加' })).isError).toBe(false);

      //M kb_search 照常读，并标明只读。
      const read = await h.tools.execute(
        { type: 'toolCall', id: 'read-rule', name: 'kb_search', arguments: { docId: rule } },
        { id: 's', row: { id: 's', kind: 'front', state: 'running', bot: 'main', messages: [] } } as unknown as Session,
        new AbortController().signal,
      );
      expect(read.text).toContain('不准透露价格');
      expect(read.text).toContain('硬性系统规则');

      //M 网页（已核验）可以改、可以取消；未核验 403；isSystemRule 写错类型 400。
      const edit = await h.app.inject({ method: 'PUT', url: `/api/knowledge/docs/${rule}`, payload: { content: '新规则' } });
      expect(edit.statusCode).toBe(200);
      expect(edit.json().doc.isSystemRule).toBe(true);
      const unset = await h.app.inject({ method: 'PUT', url: `/api/knowledge/docs/${rule}`, payload: { isSystemRule: false } });
      expect(unset.json().doc.isSystemRule).toBe(false);
      const wrongType = await h.app.inject({ method: 'POST', url: '/api/knowledge/docs', payload: { title: 'x', isSystemRule: 'yes' } });
      expect(wrongType.statusCode).toBe(400);
      h.setVerified(false);
      const locked = await h.app.inject({ method: 'PUT', url: `/api/knowledge/docs/${rule}`, payload: { isSystemRule: true } });
      expect(locked.statusCode).toBe(403);
    } finally {
      await h.close();
    }
  });

  test('老库升 1.1.0：is_system_rule 已有时 adoptColumn 只登记；kb_links 按已有正文回填', async () => {
    const db = new Database(':memory:');
    try {
      //M 模拟老库：记过两版，表建齐，已有两篇互相链接的文档，且已经手动加过 is_system_rule 列。
      const old = new dbModule.Db(new cordis.Context(), db);
      const firstTwo = knowledgePlugin.knowledgeMigrations.migrations.slice(0, 2);
      old.migrate({ plugin: 'knowledge', migrations: firstTwo });
      db.exec("INSERT INTO kb_docs (id, title, content, created_at, updated_at) VALUES ('d1', '甲', '见 [[乙]]', 1, 1)");
      db.exec("INSERT INTO kb_docs (id, title, content, created_at, updated_at) VALUES ('d2', '乙', '', 2, 2)");
      db.exec('ALTER TABLE kb_docs ADD COLUMN is_system_rule INTEGER NOT NULL DEFAULT 0');

      //M 新插件挂上：第 3 版接管已有列，第 4 版建 kb_links，apply 时回填。
      const ctx = new cordis.Context();
      const app = fastify.default({ logger: false });
      Object.assign(ctx, {
        db: new dbModule.Db(new cordis.Context(), db),
        resources: { root: makeTempDir('kb-old-'), db },
        http: { app, isLocal: () => true, requireVerified: () => undefined },
        tools: new toolsServiceModule.Tools(ctx),
      });
      knowledgePlugin.apply(ctx);
      await app.ready();
      const versions = [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }];
      expect(db.query<{ version: number }, []>(LEDGER).all()).toEqual(versions);
      const links = (await app.inject({ method: 'GET', url: '/api/knowledge/docs/d2/links' })).json();
      expect(links.backlinks.map((item: { id: string }) => item.id)).toEqual(['d1']);
      await app.close();
      await ctx.fiber.dispose();
    } finally {
      db.close();
    }
  });
});


describe('knowledge 1.2.0：实体别名、同名消歧与本地目录只读同步', () => {
  const LEDGER = "SELECT version FROM db_migrations WHERE plugin = 'knowledge' ORDER BY version";
  type Harness = Awaited<ReturnType<typeof createKnowledgeHarness>>;

  /** 新建一篇，交回整篇。 */
  const make = async (h: Harness, payload: Record<string, unknown>): Promise<knowledgePlugin.KnowledgeDoc> => {
    const res = await h.app.inject({ method: 'POST', url: '/api/knowledge/docs', payload });
    expect(res.statusCode).toBe(200);
    return res.json().doc as knowledgePlugin.KnowledgeDoc;
  };

  /** 改一篇，交回响应。 */
  const update = (h: Harness, id: string, payload: Record<string, unknown>) => {
    return h.app.inject({ method: 'PUT', url: `/api/knowledge/docs/${id}`, payload });
  };

  /** 读一篇的引出链接。 */
  const getOutgoing = async (h: Harness, id: string): Promise<knowledgePlugin.KnowledgeOutlink[]> => {
    const res = await h.app.inject({ method: 'GET', url: `/api/knowledge/docs/${id}/links` });
    expect(res.statusCode).toBe(200);
    return res.json<knowledgePlugin.KnowledgeLinksResponse>().outgoing;
  };

  /** 调一次同步。 */
  const sync = (h: Harness, payload?: Record<string, unknown>) => {
    return h.app.inject({ method: 'POST', url: '/api/knowledge/sync-folders', payload });
  };

  /** 用本人会话调一次工具。 */
  const callTool = async (h: Harness, name: string, args: Record<string, unknown>) => {
    const owner = {
      id: 's-owner',
      row: { id: 's-owner', kind: 'front', state: 'running', bot: 'main', messages: [] },
    } as unknown as Session;
    const toolArgs = args as Parameters<typeof h.tools.execute>[0]['arguments'];
    const call = { type: 'toolCall' as const, id: `${name}-${String(Date.now())}`, name, arguments: toolArgs };
    return await h.tools.execute(call, owner, new AbortController().signal);
  };

  /** 工具结果里的文字。 */
  const getToolText = (out: Awaited<ReturnType<typeof callTool>>): string => out.text;

  test('v5 迁移无损：老库记过四版、已有 24 篇，升级后一篇不少，别名为空、哈希为空', () => {
    const db = new Database(':memory:');
    try {
      //M 模拟 0.7.98 的库：四版迁移都记过，24 篇文档带标签和系统规则。
      const old = new dbModule.Db(new cordis.Context(), db);
      const firstFour = knowledgePlugin.knowledgeMigrations.migrations.slice(0, 4);
      old.migrate({ plugin: 'knowledge', migrations: firstFour });
      for (let i = 1; i <= 24; i += 1) {
        const id = `old_${String(i)}`;
        const insert = 'INSERT INTO kb_docs (id, title, content, source_path, is_system_rule, created_at, updated_at)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?)';
        db.query(insert).run(id, `老文档${String(i)}`, `正文${String(i)}`, `p${String(i)}`, i % 2, i, i);
      }
      const before = db.query<{ id: string; title: string; content: string }, []>(
        'SELECT id, title, content FROM kb_docs ORDER BY id',
      ).all();

      //M 新代码挂上：第 5 版只加两列。
      const upgraded = new dbModule.Db(new cordis.Context(), db);
      upgraded.migrate(knowledgePlugin.knowledgeMigrations);
      const versions = [1, 2, 3, 4, 5].map((version) => ({ version }));
      expect(db.query<{ version: number }, []>(LEDGER).all()).toEqual(versions);
      const after = db.query<{ id: string; title: string; content: string }, []>(
        'SELECT id, title, content FROM kb_docs ORDER BY id',
      ).all();
      expect(after).toEqual(before);
      const columns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('kb_docs')").all();
      expect(columns.map((col) => col.name)).toEqual(expect.arrayContaining(['aliases', 'content_hash', 'source_path']));

      //M 读出来：别名空数组、系统规则和来源路径原样。
      const store = new knowledgePlugin.KnowledgeStore(db);
      const doc = store.getDoc('old_3');
      expect(doc?.aliases).toEqual([]);
      expect(doc?.isSystemRule).toBe(true);
      expect(doc?.sourcePath).toBe('p3');
      expect(store.listDocs({}).total).toBe(24);
      expect(store.listImported()).toEqual([]);

      //M 再挂一次只核对。
      new dbModule.Db(new cordis.Context(), db).migrate(knowledgePlugin.knowledgeMigrations);
    } finally {
      db.close();
    }
  });

  test('别名 CRUD：去空白、去重、去空；全量替换；不带不动；超 20 个或超 60 字 400；镜像带别名', async () => {
    const h = await createKnowledgeHarness();
    try {
      const doc = await make(h, { title: '积木', aliases: ['  JM ', 'jm', '', '积木AI'] });
      expect(doc.aliases).toEqual(['JM', '积木AI']);
      expect(readMirrorMeta(h.mirrorRoot, doc.id)).toEqual(expect.objectContaining({ aliases: ['JM', '积木AI'] }));

      const replaced = await update(h, doc.id, { aliases: ['jmbots'] });
      expect(replaced.json().doc.aliases).toEqual(['jmbots']);
      const untouched = await update(h, doc.id, { content: '只改正文' });
      expect(untouched.json().doc.aliases).toEqual(['jmbots']);
      const read = await h.app.inject({ method: 'GET', url: `/api/knowledge/docs/${doc.id}` });
      expect(read.json().doc.aliases).toEqual(['jmbots']);

      const tooMany = Array.from({ length: 21 }, (_, i) => `别名${String(i)}`);
      expect((await update(h, doc.id, { aliases: tooMany })).statusCode).toBe(400);
      expect((await update(h, doc.id, { aliases: ['长'.repeat(61)] })).statusCode).toBe(400);
      expect((await update(h, doc.id, { aliases: 'JM' })).statusCode).toBe(400);
      const exactTwenty = Array.from({ length: 20 }, (_, i) => `名${String(i)}`);
      expect((await update(h, doc.id, { aliases: exactTwenty })).statusCode).toBe(200);
    } finally {
      await h.close();
    }
  });

  test('别名搜索：精确标题 > 精确别名 > 包含；matchedIn 带 alias；kb_search 也能按别名找到', async () => {
    const h = await createKnowledgeHarness();
    try {
      const contains = await make(h, { title: '积木机器人说明', content: '正文' });
      const byAlias = await make(h, { title: '项目总览', aliases: ['积木'], content: '另一篇' });
      const byTitle = await make(h, { title: '积木', content: '本体' });

      const res = await h.app.inject({ method: 'GET', url: `/api/knowledge/search?q=${encodeURIComponent('积木')}&includeMemory=0` });
      const hits = res.json<knowledgePlugin.KnowledgeSearchResponse>().hits;
      expect(hits.map((hit) => hit.id)).toEqual([byTitle.id, byAlias.id, contains.id]);
      expect(hits[1]?.matchedIn).toContain('alias');

      //M 只有别名里有的词也能搜到。
      await update(h, byAlias.id, { aliases: ['积木', 'Overview'] });
      const onlyAlias = await h.app.inject({ method: 'GET', url: '/api/knowledge/search?q=overview&includeMemory=0' });
      expect(onlyAlias.json<knowledgePlugin.KnowledgeSearchResponse>().hits.map((hit) => hit.id)).toEqual([byAlias.id]);

      const out = await callTool(h, 'kb_search', { query: 'Overview' });
      expect(getToolText(out)).toContain(byAlias.id);
      expect(getToolText(out)).toContain('[别名:积木、Overview]');
    } finally {
      await h.close();
    }
  });

  test('双链按唯一别名连上；两篇共用别名算歧义不连；删掉一篇恢复；同名标题优先于别名', async () => {
    const h = await createKnowledgeHarness();
    try {
      const target = await make(h, { title: '周小灵', aliases: ['小灵'] });
      const source = await make(h, { title: '日记', content: '今天和 [[小灵]] 聊了，还提到 [[JM]]。' });
      let out = await getOutgoing(h, source.id);
      expect(out[0]).toEqual({ targetTitle: '小灵', targetId: target.id, exists: true, ambiguous: false });
      expect(out[1]?.exists).toBe(false);
      const back = await h.app.inject({ method: 'GET', url: `/api/knowledge/docs/${target.id}/links` });
      expect(back.json().backlinks.map((item: { id: string }) => item.id)).toEqual([source.id]);

      //M 后来给别的文档加上悬空链接要的别名：连上。
      const jm = await make(h, { title: '积木', aliases: [] });
      await update(h, jm.id, { aliases: ['JM'] });
      out = await getOutgoing(h, source.id);
      expect(out[1]?.targetId).toBe(jm.id);

      //M 第二篇也叫「小灵」（别名）：不知道指哪篇，不连，标 ambiguous。
      const other = await make(h, { title: '另一个小灵', aliases: ['小灵'] });
      out = await getOutgoing(h, source.id);
      expect(out[0]).toEqual({ targetTitle: '小灵', targetId: null, exists: false, ambiguous: true });

      //M 删掉第二篇：又只剩一篇，连回原来的。
      await h.app.inject({ method: 'DELETE', url: `/api/knowledge/docs/${other.id}` });
      out = await getOutgoing(h, source.id);
      expect(out[0]?.targetId).toBe(target.id);

      //M 有篇标题就叫「小灵」：标题优先。
      const titled = await make(h, { title: '小灵', content: '同名标题' });
      out = await getOutgoing(h, source.id);
      expect(out[0]?.targetId).toBe(titled.id);

      //M 去掉别名：JM 又悬空。
      await update(h, jm.id, { aliases: [] });
      out = await getOutgoing(h, source.id);
      expect(out[1]?.exists).toBe(false);
    } finally {
      await h.close();
    }
  });

  test('消歧接口与 kb_disambiguate：同名加同别名算歧义，带分类、别名、摘要；单篇不歧义；空词 400', async () => {
    const h = await createKnowledgeHarness();
    try {
      const dirRes = await h.app.inject({ method: 'POST', url: '/api/knowledge/dirs', payload: { name: '人物' } });
      const dirId = dirRes.json().dir.id as string;
      const first = await make(h, { title: '张三', dirId, aliases: ['老张'], content: '同事张三' });
      const second = await make(h, { title: '张三', content: '客户张三' });
      const third = await make(h, { title: '张三丰', aliases: ['张三'], content: '武当' });

      const url = `/api/knowledge/disambiguate?q=${encodeURIComponent('张三')}`;
      const body = (await h.app.inject({ method: 'GET', url })).json<knowledgePlugin.KnowledgeDisambiguateResponse>();
      expect(body.query).toBe('张三');
      expect(body.exact.map((item) => item.id)).toEqual([first.id, second.id]);
      expect(body.aliasMatches.map((item) => item.id)).toEqual([third.id]);
      expect(body.candidates.map((item) => item.id)).toEqual([first.id, second.id, third.id]);
      expect(body.ambiguous).toBe(true);
      expect(body.exact[0]).toEqual({
        id: first.id,
        title: '张三',
        category: '人物',
        aliases: ['老张'],
        summary: '同事张三',
        matchedBy: 'title',
      });
      expect(body.aliasMatches[0]?.matchedBy).toBe('alias');

      const single = await h.app.inject({ method: 'GET', url: `/api/knowledge/disambiguate?q=${encodeURIComponent('老张')}` });
      const singleBody = single.json<knowledgePlugin.KnowledgeDisambiguateResponse>();
      expect(singleBody.exact).toEqual([]);
      expect(singleBody.candidates.map((item) => item.id)).toEqual([first.id]);
      expect(singleBody.ambiguous).toBe(false);
      expect((await h.app.inject({ method: 'GET', url: '/api/knowledge/disambiguate?q=%20' })).statusCode).toBe(400);

      //M 工具：前后台都有；歧义时列出三篇 docId 并提醒先选定；查不到给提示。
      expect(h.tools.listToolsForSessionKind('front').map((t) => t.name)).toContain('kb_disambiguate');
      expect(h.tools.listToolsForSessionKind('work').map((t) => t.name)).toContain('kb_disambiguate');
      const text = getToolText(await callTool(h, 'kb_disambiguate', { query: '张三' }));
      expect(text).toContain('有歧义');
      expect(text).toContain(`docId=${first.id}`);
      expect(text).toContain(`docId=${third.id}`);
      expect(text).toContain('[分类:人物]');
      const none = getToolText(await callTool(h, 'kb_disambiguate', { query: '李四' }));
      expect(none).toContain('没有标题或别名叫「李四」');
    } finally {
      await h.close();
    }
  });

  test('kb_save 可写别名；硬性系统规则照旧不能改', async () => {
    const h = await createKnowledgeHarness();
    try {
      const out = await callTool(h, 'kb_save', { title: '飞书', content: '渠道', aliases: ['Lark', 'lark'] });
      expect(out.isError).toBe(false);
      expect(getToolText(out)).toContain('- 别名: Lark');
      const id = /docId=(\S+)/u.exec(getToolText(out))?.[1] ?? '';
      expect((await h.app.inject({ method: 'GET', url: `/api/knowledge/docs/${id}` })).json().doc.aliases).toEqual(['Lark']);
    } finally {
      await h.close();
    }
  });

  /** 建一个源目录：两个能导的、一个超大的，加上该跳过的隐藏目录、node_modules、dist 和别的扩展名。 */
  const makeSource = (): string => {
    const src = makeTempDir('kb-sync-src-');
    fs.writeFileSync(path.join(src, 'a.md'), '# 甲笔记\n内容一');
    fs.mkdirSync(path.join(src, 'sub'));
    fs.writeFileSync(path.join(src, 'sub', 'b.txt'), '纯文本');
    fs.writeFileSync(path.join(src, 'big.md'), 'x'.repeat(256 * 1024 + 1));
    fs.writeFileSync(path.join(src, 'g.json'), '{}');
    for (const skip of ['.git', '.hidden', 'node_modules', 'dist']) {
      fs.mkdirSync(path.join(src, skip));
      fs.writeFileSync(path.join(src, skip, 'skip.md'), '# 不该导入');
    }
    return src;
  };

  /** 源目录下全部文件和内容（递归），用来确认同步没动过源文件。 */
  const snapshot = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const name of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isFile()) {
        out[name] = fs.readFileSync(full, 'utf8');
      }
    }
    return out;
  };

  test('本地目录同步：新建、未变跳过、内容更新、系统规则不覆盖、源文件一个字不动', async () => {
    const h = await createKnowledgeHarness();
    try {
      const src = makeSource();
      const before = snapshot(src);

      //M 第一次：a.md、sub/b.txt 新建，big.md 超限记问题，跳过的目录和扩展名不算。
      const first = await sync(h, { dirs: [src] });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json<knowledgePlugin.KnowledgeSyncResponse>();
      expect([firstBody.scanned, firstBody.created, firstBody.updated, firstBody.skipped]).toEqual([3, 2, 0, 0]);
      expect(firstBody.errors.length).toBe(1);
      expect(firstBody.errors[0]?.path.endsWith('big.md')).toBe(true);
      expect(firstBody.lastSyncedAt).toBeGreaterThan(0);
      expect(snapshot(src)).toEqual(before);

      //M 导进来的：标题取 # 或文件名，#本地导入，来源 file，放进「外部学习」。
      const list = (await h.app.inject({ method: 'GET', url: '/api/knowledge/docs' })).json();
      const docs = list.items as knowledgePlugin.KnowledgeDocSummary[];
      expect(docs.map((doc) => doc.title).sort()).toEqual(['b', '甲笔记']);
      const tree = (await h.app.inject({ method: 'GET', url: '/api/knowledge/tree' })).json();
      const syncDir = tree.flatDirs.find((dir: { name: string }) => dir.name === '外部学习');
      expect(syncDir).toBeDefined();
      for (const doc of docs) {
        expect(doc.tags).toEqual(['本地导入']);
        expect(doc.sourceType).toBe('file');
        expect(doc.dirId).toBe(syncDir.id);
      }
      const docA = docs.find((doc) => doc.title === '甲笔记')!;
      const docB = docs.find((doc) => doc.title === 'b')!;
      expect(docA.sourcePath.endsWith('a.md')).toBe(true);

      //M 第二次：都没变，跳过。
      const second = (await sync(h, { dirs: [src] })).json<knowledgePlugin.KnowledgeSyncResponse>();
      expect([second.created, second.updated, second.skipped]).toEqual([0, 0, 2]);

      //M 改了 a.md：原位更新正文，标题、标签不动。
      fs.writeFileSync(path.join(src, 'a.md'), '# 甲笔记\n内容二');
      const third = (await sync(h, { dirs: [src] })).json<knowledgePlugin.KnowledgeSyncResponse>();
      expect([third.created, third.updated, third.skipped]).toEqual([0, 1, 1]);
      const docARead = (await h.app.inject({ method: 'GET', url: `/api/knowledge/docs/${docA.id}` })).json().doc;
      expect(docARead.content).toBe('# 甲笔记\n内容二');
      expect(docARead.tags).toEqual(['本地导入']);

      //M b 被本人标成硬性系统规则，再改源文件：不覆盖，记一条问题。
      expect((await update(h, docB.id, { isSystemRule: true })).statusCode).toBe(200);
      fs.writeFileSync(path.join(src, 'sub', 'b.txt'), '被改了');
      const fourth = (await sync(h, { dirs: [src] })).json<knowledgePlugin.KnowledgeSyncResponse>();
      expect([fourth.created, fourth.updated, fourth.skipped]).toEqual([0, 0, 1]);
      expect(fourth.errors.some((item) => item.reason.includes('硬性系统规则'))).toBe(true);
      const docBRead = (await h.app.inject({ method: 'GET', url: `/api/knowledge/docs/${docB.id}` })).json().doc;
      expect(docBRead.content).toBe('纯文本');

      //M 指定分类：新文件进「资料」。
      fs.writeFileSync(path.join(src, 'c.md'), '新的');
      const fifth = (await sync(h, { dirs: [src], category: '资料' })).json<knowledgePlugin.KnowledgeSyncResponse>();
      expect(fifth.created).toBe(1);
      const treeAfter = (await h.app.inject({ method: 'GET', url: '/api/knowledge/tree' })).json();
      expect(treeAfter.flatDirs.map((dir: { name: string }) => dir.name).sort()).toEqual(['外部学习', '资料']);

      //M 源目录里只多了测试自己写的 c.md：同步没新建、没删任何源文件。
      expect(Object.keys(snapshot(src)).sort()).toEqual([...Object.keys(before), 'c.md'].sort());
    } finally {
      await h.close();
    }
  });

  test('本地目录同步：非法路径、系统根目录、没有目录 400；不存在记问题；超过 200 个截断；未核验 403', async () => {
    const h = await createKnowledgeHarness();
    try {
      expect((await sync(h, { dirs: ['relative/path'] })).statusCode).toBe(400);
      const root = path.parse(os.tmpdir()).root;
      const rootRes = await sync(h, { dirs: [root] });
      expect(rootRes.statusCode).toBe(400);
      expect(rootRes.json().error).toContain('系统根目录');
      const systemDir = path.join(root, 'Windows');
      expect((await sync(h, { dirs: [systemDir] })).statusCode).toBe(400);
      expect((await sync(h)).statusCode).toBe(400);
      expect((await sync(h, { dirs: 'x' })).statusCode).toBe(400);

      const missing = path.join(makeTempDir('kb-sync-missing-'), '没有这个');
      const missingBody = (await sync(h, { dirs: [missing] })).json<knowledgePlugin.KnowledgeSyncResponse>();
      expect(missingBody.errors[0]?.reason).toBe('目录不存在');

      //M 201 个文件：只扫 200 个，记一条超限。
      const many = makeTempDir('kb-sync-many-');
      for (let i = 0; i < 201; i += 1) {
        fs.writeFileSync(path.join(many, `n${String(i).padStart(3, '0')}.txt`), `第 ${String(i)} 个`);
      }
      const manyBody = (await sync(h, { dirs: [many] })).json<knowledgePlugin.KnowledgeSyncResponse>();
      expect(manyBody.scanned).toBe(200);
      expect(manyBody.created).toBe(200);
      expect(manyBody.errors.some((item) => item.reason.includes('超过 200 个文件'))).toBe(true);

      h.setVerified(false);
      expect((await sync(h, { dirs: [many] })).statusCode).toBe(403);
    } finally {
      await h.close();
    }
  }, 30000);

  test('配置 localWatchDirs：sync-status 列出配置的目录；不带 dirs 用配置的；状态记最近一次', async () => {
    const src = makeSource();
    const h = await createKnowledgeHarness({ localWatchDirs: [src] });
    try {
      const status = (await h.app.inject({ method: 'GET', url: '/api/knowledge/sync-status' })).json();
      expect(status.localWatchDirs.length).toBe(1);
      expect(path.resolve(status.localWatchDirs[0]).toLowerCase()).toBe(path.resolve(src).toLowerCase());
      expect(status.lastSync).toBeNull();

      const done = (await sync(h)).json<knowledgePlugin.KnowledgeSyncResponse>();
      expect(done.created).toBe(2);
      const after = (await h.app.inject({ method: 'GET', url: '/api/knowledge/sync-status' })).json();
      expect(after.lastSync.created).toBe(2);
      expect(after.lastSync.lastSyncedAt).toBe(done.lastSyncedAt);
    } finally {
      await h.close();
    }
  });
});
