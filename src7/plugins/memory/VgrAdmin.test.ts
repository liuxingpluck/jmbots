/**
 * 记忆库 VGR 配置（memory.yaml 脱敏读写）、索引重建与长期记忆条管理接口单元测试。
 * 跑法：bun test src7/plugins/memory/VgrAdmin.test.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as failureModule from '../../utils/Failure.ts';
import * as textModule from '../../utils/Text.ts';
import * as backendModule from './Backend.ts';
import * as storeModule from './Store.ts';
import * as vgrAdminModule from './VgrAdmin.ts';


const tempDirs: string[] = [];

function makeTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-vgr-admin-'));
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


async function createVgrHarness() {
  const root = makeTempRoot();
  const db = new Database(':memory:');
  const localBackend = new backendModule.LocalBackend(db);
  const store = new storeModule.Store(localBackend, root, db);

  let verified = true;
  let retryCalls = 0;
  const app = fastify.default({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    let status = 500;
    if (error instanceof failureModule.Failure) {
      status = error.status;
    }
    return reply.code(status).send({ error: textModule.getErrorMessage(error) });
  });

  const ctx = new cordis.Context();
  Object.assign(ctx, {
    resources: {
      root,
      db,
      raw: {
        bots: [{ name: '小灵' }],
      },
      ensureRuntimeDir: (...parts: string[]) => {
        const target = path.join(root, ...parts);
        fs.mkdirSync(target, { recursive: true });
        return target;
      },
    },
    http: {
      app,
      isLocal: () => verified,
      requireVerified: () => {
        if (!verified) {
          throw new failureModule.Failure(403, '需要本人核验');
        }
      },
    },
  });

  const gateway: vgrAdminModule.VgrServiceGateway = {
    url: () => 'http://127.0.0.1:30087',
    health: async () => ({
      ok: true,
      version: '0.1.0',
      embedding: { ready: true, model: 'bge-m3-int8', dim: 1024 },
      counts: { docs: 12, embedded: 12, entities: 8, relations: 16 },
    }),
    retryGraph: async () => {
      retryCalls += 1;
      return { ok: true, retry: 3 };
    },
  };

  vgrAdminModule.mountVgrAdminRoutes(ctx, store, gateway);
  await app.ready();

  return {
    root,
    db,
    app,
    getRetryCalls: () => retryCalls,
    setVerified: (next: boolean) => {
      verified = next;
    },
    close: async () => {
      await app.close();
      db.close();
    },
  };
}


describe('VgrAdmin：memory.yaml 配置脱敏读写与重建索引', () => {
  test('默认配置读取、明文 api_key 严禁回显、修改配置保留原注释和 api_key、未核验 403', async () => {
    const h = await createVgrHarness();
    try {
      //M 1. memory.yaml 尚未创建时返回默认值与引擎状态
      const initial = await h.app.inject({ method: 'GET', url: '/api/memory/vgr-config' });
      expect(initial.statusCode).toBe(200);
      const initBody = initial.json();
      expect(initBody.fileExists).toBe(false);
      expect(initBody.config.modelDir).toBe('program/models/bge-m3-int8');
      expect(initBody.config.retrieval.defaultMode).toBe('hybrid');
      expect(initBody.config.llm.hasApiKey).toBe(false);
      expect(initBody.health.embedding.dim).toBe(1024);

      //M 2. 写入带注释与敏感 api_key 的 memory.yaml，验证 GET 绝不泄露明文密钥
      const secretKey = 'sk-super-secret-do-not-leak-9988';
      fs.mkdirSync(path.join(h.root, 'models', 'bge-custom'), { recursive: true });
      fs.writeFileSync(
        path.join(h.root, 'memory.yaml'),
        [
          '# 重要头部注释',
          'model_dir: models/bge-custom',
          'llm:',
          '  base_url: https://llm.example.com/v1',
          `  api_key: ${secretKey}`,
          '  model: deepseek-chat',
        ].join('\n'),
        'utf8',
      );

      const loaded = await h.app.inject({ method: 'GET', url: '/api/memory/vgr-config' });
      expect(loaded.statusCode).toBe(200);
      expect(loaded.body).not.toContain(secretKey);
      const loadedJson = loaded.json();
      expect(loadedJson.fileExists).toBe(true);
      expect(loadedJson.config.modelDir).toBe('models/bge-custom');
      expect(loadedJson.config.modelDirExists).toBe(true);
      expect(loadedJson.config.llm.hasApiKey).toBe(true);

      //M 3. PUT 更新模型路径与检索策略，保留原有注释与 api_key
      const updated = await h.app.inject({
        method: 'PUT',
        url: '/api/memory/vgr-config',
        payload: {
          modelDir: 'models/bge-custom',
          storeDir: 'data/memory-v2',
          retrieval: {
            graph: true,
            defaultMode: 'graph',
            rerank: false,
            finalTopK: 15,
          },
          llm: {
            extractModel: 'qwen-turbo',
            extractConcurrency: 4,
          },
        },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.body).not.toContain(secretKey);
      const updatedJson = updated.json();
      expect(updatedJson.config.storeDir).toBe('data/memory-v2');
      expect(updatedJson.config.retrieval.defaultMode).toBe('graph');
      expect(updatedJson.config.retrieval.rerank).toBe(false);
      expect(updatedJson.config.retrieval.finalTopK).toBe(15);
      expect(updatedJson.config.llm.extractModel).toBe('qwen-turbo');
      expect(updatedJson.config.llm.extractConcurrency).toBe(4);
      expect(updatedJson.config.llm.hasApiKey).toBe(true);

      const diskYaml = fs.readFileSync(path.join(h.root, 'memory.yaml'), 'utf8');
      expect(diskYaml).toContain('# 重要头部注释');
      expect(diskYaml).toContain(secretKey);

      //M 4. 非法参数 400、未核验 403
      const badMode = await h.app.inject({
        method: 'PUT',
        url: '/api/memory/vgr-config',
        payload: { retrieval: { defaultMode: 'unknown' } },
      });
      expect(badMode.statusCode).toBe(400);

      h.setVerified(false);
      const forbidden = await h.app.inject({
        method: 'PUT',
        url: '/api/memory/vgr-config',
        payload: { storeDir: 'data/x' },
      });
      expect(forbidden.statusCode).toBe(403);
    } finally {
      await h.close();
    }
  });

  test('长期记忆条 CRUD、路径越界拦截与知识库 DiskMirror 镜像保护、重建索引', async () => {
    const h = await createVgrHarness();
    try {
      //M 模拟一篇知识库 SQLite 导出的 DiskMirror 镜像文档（带 meta.json）
      const mirrorDir = path.join(h.root, 'knowledge', '20261122', 'kb_doc_1_架构规范');
      fs.mkdirSync(mirrorDir, { recursive: true });
      fs.writeFileSync(path.join(mirrorDir, 'meta.json'), JSON.stringify({ id: 'kb_doc_1', title: '架构规范' }), 'utf8');
      fs.writeFileSync(path.join(mirrorDir, 'content.md'), '# 架构规范\n不可在记忆面板误删', 'utf8');

      //M 新增一条公共记忆卡片 + 一条独立知识切片
      const createCard = await h.app.inject({
        method: 'POST',
        url: '/api/memory/items',
        payload: {
          scope: 'card',
          path: '偏好/沟通风格.md',
          content: '# 沟通风格\n结论先行，简明扼要。',
        },
      });
      expect(createCard.statusCode).toBe(200);
      expect(createCard.json().item.title).toBe('沟通风格');

      const createKn = await h.app.inject({
        method: 'POST',
        url: '/api/memory/items',
        payload: {
          scope: 'knowledge',
          path: '术语表.md',
          content: '# 内部术语\nVGR 表示向量与关系图混合检索。',
        },
      });
      expect(createKn.statusCode).toBe(200);

      //M 列表只包含独立记忆卡片和独立知识切片，绝不混入 DiskMirror 镜像文件
      const listRes = await h.app.inject({ method: 'GET', url: '/api/memory/items' });
      expect(listRes.statusCode).toBe(200);
      const items = listRes.json().items as vgrAdminModule.MemoryItemSummary[];
      expect(items.map((item) => item.path).sort()).toEqual(['偏好/沟通风格.md', '术语表.md'].sort());

      //M 读取单条全文
      const detailRes = await h.app.inject({
        method: 'GET',
        url: `/api/memory/items/detail?scope=card&path=${encodeURIComponent('偏好/沟通风格.md')}`,
      });
      expect(detailRes.statusCode).toBe(200);
      expect(detailRes.json().item.content).toContain('结论先行');

      //M 保护 DiskMirror 镜像：禁止读取、覆盖或删除
      const mirrorRel = '20261122/kb_doc_1_架构规范/content.md';
      const delMirror = await h.app.inject({
        method: 'DELETE',
        url: `/api/memory/items?scope=knowledge&path=${encodeURIComponent(mirrorRel)}`,
      });
      expect(delMirror.statusCode).toBe(400);
      expect(fs.existsSync(path.join(mirrorDir, 'content.md'))).toBe(true);

      //M 拦截目录穿越与非法扩展名
      const escapeRes = await h.app.inject({
        method: 'POST',
        url: '/api/memory/items',
        payload: { scope: 'card', path: '../outside.md', content: 'bad' },
      });
      expect(escapeRes.statusCode).toBe(400);

      const badExt = await h.app.inject({
        method: 'POST',
        url: '/api/memory/items',
        payload: { scope: 'card', path: 'bad.json', content: '{}' },
      });
      expect(badExt.statusCode).toBe(400);

      //M 重建索引并触发关系图重抽
      const reindexRes = await h.app.inject({
        method: 'POST',
        url: '/api/memory/reindex',
        payload: { retryGraph: true },
      });
      expect(reindexRes.statusCode).toBe(200);
      expect(reindexRes.json().ok).toBe(true);
      expect(reindexRes.json().graphRetry).toEqual({ ok: true, retry: 3 });
      expect(h.getRetryCalls()).toBe(1);

      //M 删除长期记忆条
      const delRes = await h.app.inject({
        method: 'DELETE',
        url: `/api/memory/items?scope=knowledge&path=${encodeURIComponent('术语表.md')}`,
      });
      expect(delRes.statusCode).toBe(200);
      const afterList = (await h.app.inject({ method: 'GET', url: '/api/memory/items' })).json().items as vgrAdminModule.MemoryItemSummary[];
      expect(afterList.map((item) => item.path)).toEqual(['偏好/沟通风格.md']);
    } finally {
      await h.close();
    }
  });
});
