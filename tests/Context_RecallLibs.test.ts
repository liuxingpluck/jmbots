/**
 * 开会话先搜记忆库（src/capabilities/Context.ts 的 MemorySearch.recall）的离线测试（发0.3.1 第二段第 1 步）：
 * 没配不发请求；RAG 回的 8 条里只留和原话字组对上至少 3 分的、最多 5 条；原话超过 300 字时 q 只带前 300 字。
 * 全部用本机假基地，不读真实配置。
 */
import * as bunTest from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as contextModule from '../src/capabilities/Context.ts';
import type * as resourcesModule from '../src/resources/Resources.ts';


/**
 * 假资源：只实现 getSetting。
 * @param indexUrl 基地地址。
 * @param memoryLibs 库名。
 */
function resourcesOf(indexUrl?: string, memoryLibs?: string): resourcesModule.Resources {
  /**
   * 一项设置。
   * @param name 设置名。
   */
  const getSetting = (name: string): string | undefined => {
    if (name === 'indexUrl') {
      return indexUrl;
    }
    if (name === 'memoryLibs') {
      return memoryLibs;
    }
    return undefined;
  };
  return { getSetting } as unknown as resourcesModule.Resources;
}


/** 假基地。 */
interface FakeBase {
  /** 服务。 */
  server: ReturnType<typeof Bun.serve>;
  /** 地址。 */
  url: string;
  /** 收到的 q。 */
  queries: string[];
}


/**
 * 起一个只回 /rag/search 的假基地。
 * @param hits 回给的 hits。
 */
function startFake(hits: unknown[]): FakeBase {
  /** 收到的 q。 */
  const queries: string[] = [];
  /** 服务。 */
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      /** 地址。 */
      const url = new URL(request.url);
      if (url.pathname === '/rag/search') {
        queries.push(url.searchParams.get('q') ?? '');
        return Response.json({ hits, not_indexed: [] });
      }
      return Response.json({ hits: [] });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}`, queries };
}


/**
 * 造一条 RAG 命中。
 * @param index 编号。
 * @param matching 对不对得上原话。
 */
function hitOf(index: number, matching: boolean): Record<string, unknown> {
  return matching
    ? { lib: '库A', path: `飞书${String(index)}.md`, abs_path: path.join(os.tmpdir(), '假基地', `飞书${String(index)}.md`), title: '飞书发件箱', start_line: 3, end_line: 9, text: '飞书发件箱：往 outbox 放一份 md', score: 1 }
    : { lib: '库A', path: `无关${String(index)}.md`, title: '天气记录', start_line: 1, end_line: 2, text: '今天天气晴朗，适合散步', score: 0.5 };
}


bunTest.describe('recallLibs', () => {
  bunTest.test('没配 indexUrl/memoryLibs：空数组，不发请求', async () => {
    /** 假基地。 */
    const fake = startFake([hitOf(1, true)]);
    try {
      /** 结果。 */
      const found = await new contextModule.MemorySearch(resourcesOf(undefined, undefined)).recall('飞书发件箱怎么用');
      bunTest.expect(found).toEqual([]);
      bunTest.expect(fake.queries).toHaveLength(0);
    } finally {
      await fake.server.stop(true);
    }
  });

  bunTest.test('8 条里只留对得上的（至少 3 分），最多 5 条', async () => {
    /** 假基地：6 条对得上、2 条无关。 */
    const hits = [...Array.from({ length: 6 }, (_, index) => hitOf(index, true)), ...Array.from({ length: 2 }, (_, index) => hitOf(index, false))];
    /** 假基地。 */
    const fake = startFake(hits);
    try {
      /** 结果。 */
      const found = await new contextModule.MemorySearch(resourcesOf(fake.url, '库A')).recall('飞书发件箱怎么用');
      bunTest.expect(found).toHaveLength(5);
      bunTest.expect(found.every((item) => item.file.includes('飞书'))).toBe(true);
      bunTest.expect(found.every((item) => item.lines.some((line) => line.includes('第 3–9 行 · 飞书发件箱')))).toBe(true);
    } finally {
      await fake.server.stop(true);
    }
  });

  bunTest.test('原话超过 300 字：q 只带前 300 字', async () => {
    /** 长原话。 */
    const longQuery = `飞书发件箱${'啊'.repeat(400)}`;
    /** 假基地。 */
    const fake = startFake([hitOf(1, true)]);
    try {
      await new contextModule.MemorySearch(resourcesOf(fake.url, '库A')).recall(longQuery);
      bunTest.expect(fake.queries[0]).toHaveLength(300);
      bunTest.expect(fake.queries[0]?.startsWith('飞书发件箱')).toBe(true);
    } finally {
      await fake.server.stop(true);
    }
  });
});
