/**
 * 关系图与命中出处单元测试（原 memory-graph/Sources.test.ts 迁入）：
 * 仅使用临时合成文件与假网关，不碰正式数据。
 * 跑法：bun test src7/plugins/memory/GraphSources.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type { ChatRequest } from '../../Sessions.ts';
import { Sources } from './GraphSources.ts';
import { buildLinkHint, GraphRoutes, readGraphSettings, type MemoryGateway } from './GraphRoutes.ts';


const roots: string[] = [];

/** 构造包含测试文档的临时根目录。 */
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-sources-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'memory', 'ainit'), { recursive: true });
  for (const fileName of ['功能.xlsx', '交付.docx']) {
    fs.writeFileSync(path.join(root, 'memory', 'ainit', fileName), 'fake');
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


describe('命中出处 Sources', () => {
  test('老导入 source 带客户冒号：按文件名定位原文件、Sheet 行来自正文而非 start/end', () => {
    const root = fixture();
    const sources = new Sources(root, () => '【功能 · Sheet1 第10行】合成\n【功能 · Sheet1 第14行】合成');
    expect(sources.describe({ id: 1, source: 'doc-import:demo:出版ERP:功能.xlsx', customer: 'demo:出版ERP', start: 24, end: 35 })).toEqual({
      file: path.join(root, 'memory', 'ainit', '功能.xlsx'),
      where: 'Sheet1 第 10–14 行',
      origin: '',
    });
  });

  test('docx 行号明确是转换后，从1数', () => {
    const root = fixture();
    const sources = new Sources(root, () => '');
    expect(sources.describe({ source: 'doc-import:demo:出版ERP:交付.docx', customer: 'demo:出版ERP', start: 0, end: 15 })).toEqual({
      file: path.join(root, 'memory', 'ainit', '交付.docx'),
      where: '转成文字后第 1–16 行',
      origin: '',
    });
  });

  test('找不到不编造路径', () => {
    const sources = new Sources(fixture(), () => '');
    const result = sources.describe({ source: 'doc-import:demo:x:不存在.xlsx', customer: 'demo:x' });
    expect(result.file).toBe('');
    expect(result.origin).toContain('没找到');
  });

  test('会话来源不是文件', () => {
    const sources = new Sources(fixture(), () => '');
    expect(sources.describe({ source: 'session:s1', customer: 'fake:客户' })).toEqual({
      file: '',
      where: '',
      origin: '聊天记录 · 客户 fake:客户 · 会话 s1',
    });
  });

  test('相对数据目录 source 直接拼，绝对来源保持原样', () => {
    const root = fixture();
    const sources = new Sources(root, () => '');
    expect(sources.describe({ source: 'doc-import:c:memory/ainit/交付.docx', customer: 'c' }).file).toBe(path.join(root, 'memory', 'ainit', '交付.docx'));
    expect(sources.describe({ source: path.join(root, 'memory', 'ainit', '交付.docx') }).file).toBe(path.join(root, 'memory', 'ainit', '交付.docx'));
  });
});


describe('关系图配置与路由合并回归', () => {
  test('readGraphSettings 默认开启、支持 false 关闭并校验字段类型', () => {
    const root = fixture();
    expect(readGraphSettings(root, undefined)).toEqual({
      enabled: true,
      db: path.resolve(root, 'data/memory/memory.db'),
      mode: 'hybrid',
      link: true,
    });
    expect(readGraphSettings(root, false).enabled).toBe(false);
    expect(readGraphSettings(root, { db: 'custom/graph.db', mode: 'graph', link: false })).toEqual({
      enabled: true,
      db: path.resolve(root, 'custom/graph.db'),
      mode: 'graph',
      link: false,
    });
    expect(readGraphSettings(root, { public_url: 'https://jm.example.com/' }).publicUrl).toBe('https://jm.example.com');
    expect(() => readGraphSettings(root, 'bad')).toThrow();
    expect(() => readGraphSettings(root, { link: 'yes' })).toThrow();
    expect(() => readGraphSettings(root, { public_url: '/relative' })).toThrow();
  });

  test('buildLinkHint：网页会话输出相对链接且 q 截断 40 字以内；飞书等外部渠道未配公网前缀时不附链接', () => {
    const longSpeech = '这是一段超过四十个汉字的超长语音输入，包含很多很多背景描述和工作安排细节，用来验证链接查询参数绝对不会拼成几千字的刷屏雷霆网址。';
    const webReq = {
      session: {
        row: {
          kind: 'work',
          bot: '助手',
          channel: 'http',
          customer: 'http:本机',
          recall: '# 可能相关的聊天记录和知识库\n[1] ...',
          messages: [{ role: 'user', content: longSpeech, timestamp: 1 }],
        },
      },
    } as unknown as ChatRequest;
    const webHint = buildLinkHint(webReq);
    expect(webHint).toContain('/graph/?customer=http%3A%E6%9C%AC%E6%9C%BA&bot=%E5%8A%A9%E6%89%8B&q=');
    const webUrlMatch = /\((\/graph\/\?[^)]+)\)/u.exec(webHint ?? '');
    expect(webUrlMatch).not.toBeNull();
    const webParams = new URLSearchParams(webUrlMatch![1]!.split('?')[1]);
    expect([...(webParams.get('q') ?? '')].length).toBe(40);

    //M 外部渠道（飞书、微信）未配公网前缀时不输出相对路径 /graph/?...
    const feishuReq = {
      session: {
        row: {
          kind: 'work',
          bot: '助手',
          customer: 'feishu:ou_1',
          recall: '# 可能相关的聊天记录和知识库\n[1] ...',
          messages: [{ role: 'user', content: longSpeech, timestamp: 1 }],
        },
      },
    } as unknown as ChatRequest;
    expect(buildLinkHint(feishuReq)).toBeUndefined();

    //M 配了公网前缀后，外部渠道输出完整公网链接，且 q 同样截断在 40 字以内
    const pubHint = buildLinkHint(feishuReq, 'https://jm.example.com/');
    expect(pubHint).toContain('https://jm.example.com/graph/?customer=feishu%3Aou_1&bot=%E5%8A%A9%E6%89%8B&q=');
    const pubUrlMatch = /\((https:\/\/jm\.example\.com\/graph\/\?[^)]+)\)/u.exec(pubHint ?? '');
    expect(pubUrlMatch).not.toBeNull();
    const pubParams = new URLSearchParams(pubUrlMatch![1]!.split('?')[1]);
    expect([...(pubParams.get('q') ?? '')].length).toBe(40);
  });

  test('GraphRoutes 保留 /graph/ 与 /api/memory-graph/* 路由登记', () => {
    const root = fixture();
    const routes: string[] = [];
    let onRequest: ((req: ChatRequest) => void) | undefined;
    const fakeCtx = {
      on(event: string, listener: (req: ChatRequest) => void): void {
        if (event === 'session/before-model') {
          onRequest = listener;
        }
      },
    } as unknown as cordis.Context;
    const fakeGateway: MemoryGateway = {
      url: () => 'http://127.0.0.1:30087',
      health: async () => ({ ok: true }),
    };
    const graphRoutes = new GraphRoutes(fakeCtx, root, fakeGateway, readGraphSettings(root, undefined));
    const fakeApp = {
      get(route: string): void {
        routes.push(route);
      },
    } as unknown as cordis.Context['http']['app'];
    graphRoutes.mountRoutes(fakeApp);
    expect(routes).toEqual([
      '/api/memory-graph/passage/:id',
      '/graph',
      '/graph/',
      '/api/memory-graph/status',
      '/api/memory-graph/customers',
      '/api/memory-graph/graph',
      '/api/memory-graph/entity/:id',
      '/api/memory-graph/edge/:id',
    ]);
    expect(onRequest).toBeDefined();
  });
});
