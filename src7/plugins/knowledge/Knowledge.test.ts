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
  Object.assign(ctx, {
    resources: { root: rootDir, db },
    http: {
      app,
      isVerified: () => verified,
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
