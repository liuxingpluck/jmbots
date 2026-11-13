/**
 * 记忆库 RAG 搜索（src/capabilities/Context.ts 的 ragSearch、MemorySearch.searchLibs、refreshLibs）的离线测试
 * （docs/界面/任务书/发0.3.1_DSH.md 第 1 步）：
 * RAG 命中格式、整句拆成两个一组再搜、没建索引时补老搜索并只催一次建索引、/rag/search 404 退回 /search、
 * 刷新索引先摄取再建 RAG、400 也照样建、连不上返回“连不上”。
 * 全部用本机假基地，不连真基地、不读真实配置。
 */
import * as bunTest from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as contextModule from '../src/capabilities/Context.ts';
import type * as resourcesModule from '../src/resources/Resources.ts';


/**
 * 建记忆库搜索：searchLibs 的地址和库名都当参数传、不读配置，所以资源给个空壳。
 * @returns 记忆库搜索。
 */
function memorySearchOf(): contextModule.MemorySearch {
  return new contextModule.MemorySearch({} as unknown as resourcesModule.Resources);
}


/** 假基地收到的一次请求。 */
interface RecordedRequest {
  /** 方法。 */
  method: string;
  /** 路径。 */
  path: string;
  /** 查询参数。 */
  query: URLSearchParams;
  /** 请求体。 */
  body?: unknown;
}


/** 假基地。 */
interface FakeBase {
  /** Bun 服务。 */
  server: ReturnType<typeof Bun.serve>;
  /** 地址。 */
  url: string;
  /** 收到的请求。 */
  requests: RecordedRequest[];
}


/**
 * 起一个假基地：每个请求先记下来，再交给处理函数回。
 * @param handler 处理函数。
 */
function startFakeBase(handler: (request: Request, url: URL, body: unknown) => Response | Promise<Response>): FakeBase {
  /** 收到的请求。 */
  const requests: RecordedRequest[] = [];
  /** 服务。 */
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      /** 地址。 */
      const url = new URL(request.url);
      /** 请求体。 */
      const body = request.method === 'POST' ? ((await request.json().catch(() => undefined)) as unknown) : undefined;
      requests.push({ method: request.method, path: url.pathname, query: url.searchParams, body });
      return handler(request, url, body);
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}`, requests };
}


bunTest.describe('searchLibs：RAG 搜索', () => {
  bunTest.test('RAG 命中：绝对路径、第 3–9 行 · 标题、片段', async () => {
    /** 假基地给的绝对路径。 */
    const abs = path.join(os.tmpdir(), '假基地', '飞书发件箱.md');
    /** 假基地。 */
    const fake = startFakeBase((_request, url) => {
      if (url.pathname === '/rag/search') {
        return Response.json({ hits: [{ lib: '资料', path: '飞书发件箱.md', abs_path: abs, title: '飞书发件箱', start_line: 3, end_line: 9, text: 'RAG 片段 RAG_SNIPPET', score: 1.2 }], not_indexed: [] });
      }
      return Response.json({ hits: [] });
    });
    try {
      /** 搜到的。 */
      const found = await memorySearchOf().searchLibs(fake.url, '飞书发件箱怎么用', 8, '资料');
      bunTest.expect(found).toHaveLength(1);
      bunTest.expect(found[0]!.path).toBe(abs);
      bunTest.expect(found[0]!.summary).toBe('第 3–9 行 · 飞书发件箱');
      bunTest.expect(found[0]!.snippet).toBe('RAG 片段 RAG_SNIPPET');
    } finally {
      await fake.server.stop(true);
    }
  });

  bunTest.test('整句第一次 0 条：第二次 q 是两个一组、空格隔开，第二次结果就用它', async () => {
    /** RAG 收到的 q。 */
    const queries: string[] = [];
    /** 假基地。 */
    const fake = startFakeBase((_request, url) => {
      if (url.pathname === '/rag/search') {
        /** 这次问的。 */
        const q = url.searchParams.get('q') ?? '';
        queries.push(q);
        if (q === '飞书发件箱') {
          return Response.json({ hits: [], not_indexed: [] });
        }
        return Response.json({ hits: [{ lib: '资料', path: '命中.md', title: '标题', start_line: 1, end_line: 2, text: '第二次命中 SPLIT_SNIPPET', score: 1 }], not_indexed: [] });
      }
      return Response.json({ hits: [] });
    });
    try {
      /** 搜到的。 */
      const found = await memorySearchOf().searchLibs(fake.url, '飞书发件箱', 8, '资料');
      bunTest.expect(queries).toEqual(['飞书发件箱', '飞书 书发 发件 件箱']);
      bunTest.expect(found).toHaveLength(1);
      bunTest.expect(found[0]!.snippet).toBe('第二次命中 SPLIT_SNIPPET');
      bunTest.expect(fake.requests.filter((item) => item.path === '/rag/search')).toHaveLength(2);
    } finally {
      await fake.server.stop(true);
    }
  });

  bunTest.test('not_indexed：POST /rag/index 一次，并用 /search?lib= 补；再搜不重复 POST', async () => {
    /** 建索引请求次数。 */
    let indexPosts = 0;
    /** 假基地。 */
    const fake = startFakeBase((_request, url) => {
      if (url.pathname === '/rag/search') {
        return Response.json({ hits: [], not_indexed: ['未建库A'] });
      }
      if (url.pathname === '/rag/index') {
        indexPosts += 1;
        return Response.json({ ok: true });
      }
      return Response.json({ hits: [{ lib: '未建库A', path: '旧.md', summary: '旧摘要', snippet: '旧片段' }] });
    });
    try {
      /** 同一个记忆库搜索（它记着催过哪些库）。 */
      const memorySearch = memorySearchOf();
      /** 第一次搜。 */
      const first = await memorySearch.searchLibs(fake.url, '关键词', 8, '未建库A');
      bunTest.expect(first.map((item) => item.path)).toContain('未建库A:旧.md');
      bunTest.expect(first.some((item) => item.snippet === '旧片段')).toBe(true);
      //M postJson 是不 await 的，等它发出去。
      await Bun.sleep(30);
      bunTest.expect(indexPosts).toBe(1);
      /** /rag/index 的请求体。 */
      const indexRequest = fake.requests.find((item) => item.path === '/rag/index');
      bunTest.expect(indexRequest?.body).toEqual({ lib: '未建库A' });
      //M 补搜用的 lib 只有未建索引的库。
      /** /search 的请求。 */
      const searchRequest = fake.requests.find((item) => item.path === '/search');
      bunTest.expect(searchRequest?.query.get('lib')).toBe('未建库A');
      //M 同一个库第二次不再催。
      await memorySearch.searchLibs(fake.url, '关键词', 8, '未建库A');
      await Bun.sleep(30);
      bunTest.expect(indexPosts).toBe(1);
    } finally {
      await fake.server.stop(true);
    }
  });

  bunTest.test('/rag/search 回 404：退回 /search，lib 是全部库', async () => {
    /** 假基地。 */
    const fake = startFakeBase((_request, url) => {
      if (url.pathname === '/rag/search') {
        return new Response('没有 RAG', { status: 404 });
      }
      return Response.json({ hits: [{ lib: '库A', path: '旧.md', summary: '旧摘要', snippet: '旧片段' }] });
    });
    try {
      /** 搜到的。 */
      const found = await memorySearchOf().searchLibs(fake.url, '关键词', 8, '库A,库B');
      bunTest.expect(found).toHaveLength(1);
      bunTest.expect(found[0]!.snippet).toBe('旧片段');
      /** /search 的请求。 */
      const searchRequest = fake.requests.find((item) => item.path === '/search');
      bunTest.expect(searchRequest?.query.get('lib')).toBe('库A,库B');
    } finally {
      await fake.server.stop(true);
    }
  });
});


bunTest.describe('refreshLibs：摄取和建索引', () => {
  bunTest.test('POST /ingest 200、GET /ingest 先 running 再 false，之后 POST /rag/index，返回空数组', async () => {
    /** GET /ingest 次数。 */
    let ingestGets = 0;
    /** 假基地。 */
    const fake = startFakeBase((_request, url) => {
      if (url.pathname === '/ingest' && _request.method === 'POST') {
        return Response.json({ ok: true });
      }
      if (url.pathname === '/ingest') {
        ingestGets += 1;
        return Response.json({ job: { running: ingestGets === 1 } });
      }
      return Response.json({ ok: true });
    });
    try {
      /** 问题。 */
      const problems = await contextModule.refreshLibs(fake.url, '库A', 10);
      bunTest.expect(problems).toEqual([]);
      bunTest.expect(ingestGets).toBe(2);
      bunTest.expect(fake.requests.some((item) => item.method === 'POST' && item.path === '/ingest')).toBe(true);
      /** /rag/index 的请求。 */
      const ragIndex = fake.requests.find((item) => item.path === '/rag/index');
      bunTest.expect(ragIndex?.body).toEqual({ lib: '库A' });
    } finally {
      await fake.server.stop(true);
    }
  });

  bunTest.test('POST /ingest 回 400（库没记着目录）也照样 POST /rag/index', async () => {
    /** 假基地。 */
    const fake = startFakeBase((request, url) => {
      if (url.pathname === '/ingest' && request.method === 'POST') {
        return new Response('没有目录', { status: 400 });
      }
      return Response.json({ ok: true });
    });
    try {
      /** 问题。 */
      const problems = await contextModule.refreshLibs(fake.url, '库A', 10);
      bunTest.expect(problems).toEqual([]);
      bunTest.expect(fake.requests.some((item) => item.method === 'POST' && item.path === '/rag/index')).toBe(true);
    } finally {
      await fake.server.stop(true);
    }
  });

  bunTest.test('连不上：返回一条含“连不上”的话，不再试后面的库', async () => {
    /** 连不上的地址。 */
    const problems = await contextModule.refreshLibs('http://127.0.0.1:1', '库A,库B', 10);
    bunTest.expect(problems).toHaveLength(1);
    bunTest.expect(problems[0]).toContain('连不上');
  });
});
