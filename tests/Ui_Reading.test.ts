/** 长文件阅读的离线边界：层级、围栏、UTF-8、分段预算与旧异步响应，不起浏览器。 */
import * as bunTest from 'bun:test';
import * as api from '../web/src/Api.ts';
import * as documentModule from '../web/src/Panel/Document.ts';
import * as kinds from '../web/src/Panel/PreviewKind.ts';


/** 给当前测试临时替换 fetch；finally 恢复，绝不访问网络。 */
function rangeFetch(text: string, requests: string[]): typeof fetch {
  const bytes = new TextEncoder().encode(text);
  return ((_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const range = new Headers(init?.headers).get('range') ?? '';
    requests.push(range);
    const bounds = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start = Number(bounds[1]);
    const end = Math.min(bytes.length - 1, Number(bounds[2]));
    return Promise.resolve(new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` },
    }));
  }) as typeof fetch;
}


bunTest.test('会话运行真正包含步骤与角色；围栏里的假标题和假用户不进入结构', () => {
  const text = [
    '# 会话',
    '## 第 1 次运行 · 10:00:00 开始',
    '【用户 · http · 10:00:00】问题',
    '### 第 1 步 · 10:00:01 · fake/model',
    '【思考】长思考默认收起',
    '【助手】回答',
    '【调用】read file',
    '【结果】工具结果',
    '```md',
    '## 假运行',
    '【用户】并非真实用户',
    '```',
    '## 第 2 次运行 · 10:01:00',
    '【用户】下一问',
  ].join('\n');
  const page = new documentModule.DocumentReader().read(text);
  bunTest.expect(page.outline.map((block) => block.title)).toEqual([
    '会话', '第 1 次运行 · 10:00:00 开始', '第 1 步 · 10:00:01 · fake/model', '第 2 次运行 · 10:01:00',
  ]);
  const root = page.nodes[0]!;
  const run = root.children[0]!;
  const step = run.children.find((node) => node.block.kind === 'step')!;
  bunTest.expect(run.children[0]!.block.kind).toBe('user');
  bunTest.expect(step.children.map((node) => node.block.kind)).toEqual(['thinking', 'assistant', 'tool-call', 'tool-result']);
  bunTest.expect(step.children[0]!.block.collapsed).toBe(true);
  bunTest.expect(step.children.at(-1)!.block.collapsed).toBe(true);
  bunTest.expect(root.children[1]!.block.kind).toBe('run');
  bunTest.expect(page.blocks.map((block) => block.raw).join('\n')).toBe(text);
});


bunTest.test('跨段围栏不误认代码标题；未知中段或无换行长行后续保守保留原文', () => {
  const reader = new documentModule.DocumentReader();
  const first = '# 标题\n```ts\nconst text = 1;\n';
  const offset = new TextEncoder().encode(first).length;
  const part = reader.read(first, 0, offset);
  bunTest.expect(part.endingFence).toBe('```');
  const next = reader.read('## 代码里的伪标题\n```\n## 真正章节\n正文', offset);
  bunTest.expect(next.structureKnown).toBe(true);
  bunTest.expect(next.outline.map((block) => block.title)).toEqual(['真正章节']);

  const direct = new documentModule.DocumentReader().read('## 可能在代码里\n正文', offset);
  bunTest.expect(direct.structureKnown).toBe(false);
  bunTest.expect(direct.outline).toEqual([]);
  const longLineReader = new documentModule.DocumentReader();
  longLineReader.read('```ts\nvery-long-unfinished-line', 0, 100);
  const longLineTail = longLineReader.read('## 仍可能是一行中的文字\n```', 100);
  bunTest.expect(longLineTail.structureKnown).toBe(false);
  bunTest.expect(longLineTail.outline).toEqual([]);
});


bunTest.test('普通 Markdown 也按标题分层，key稳定，非标题段保留原始顺序', () => {
  const reader = new documentModule.DocumentReader();
  const text = '# 文档\n简介\n## 安装\n步骤\n### 选项\n说明\n## 使用\n结束';
  const first = reader.read(text);
  const second = reader.read(text);
  bunTest.expect(first.blocks.map((block) => block.key)).toEqual(second.blocks.map((block) => block.key));
  bunTest.expect(first.nodes[0]!.children.map((node) => node.block.title)).toEqual(['安装', '使用']);
  bunTest.expect(first.nodes[0]!.children[0]!.children[0]!.block.title).toBe('选项');
});


bunTest.test('相对文档链接以当前目录解析；外链和纯锚点不改变原聊天行为', () => {
  bunTest.expect(kinds.documentLink('F:\\docs\\folder\\source.md', '../next%20file.md#part'))
    .toBe('F:/docs/next file.md');
  bunTest.expect(kinds.documentLink('/docs/folder/source.md', './child.md')).toBe('/docs/folder/child.md');
  bunTest.expect(kinds.documentLink('F:/docs/source.md', 'F:\\other\\file.md')).toBe('F:/other/file.md');
  bunTest.expect(kinds.documentLink('F:/docs/source.md', 'https://example.com/doc.md')).toBeNull();
  bunTest.expect(kinds.documentLink('F:/docs/source.md', '#part')).toBeNull();
});


bunTest.test('UTF-8 跨小分段连续读取完整中文与emoji，下一起点不会漏字或产生替换字符', async () => {
  const original = globalThis.fetch;
  const text = 'abc你好😀世界🧭xyz尾巴';
  const requests: string[] = [];
  globalThis.fetch = rangeFetch(text, requests);
  try {
    const pieces: string[] = [];
    let offset: number | null = 0;
    for (let guard = 0; guard < 30 && offset !== null; guard += 1) {
      const page = await api.fileText('F:/fake.txt', 7, offset);
      pieces.push(page.text);
      bunTest.expect(page.end - page.start).toBe(new TextEncoder().encode(page.text).length);
      offset = page.nextOffset;
    }
    bunTest.expect(offset).toBeNull();
    bunTest.expect(pieces.join('')).toBe(text);
    bunTest.expect(pieces.join('')).not.toContain('\uFFFD');
    bunTest.expect(requests.length).toBeGreaterThan(3);
  } finally {
    globalThis.fetch = original;
  }
});


bunTest.test('超过1MB可继续下一段，单次预算封顶且有换行时不拆标题或围栏', async () => {
  const original = globalThis.fetch;
  const text = `${'a'.repeat(kinds.MAX_TEXT_BYTES - 5)}\n## 后续章节\n最后一行`;
  const requests: string[] = [];
  globalThis.fetch = rangeFetch(text, requests);
  try {
    const first = await api.fileText('F:/large.md', kinds.MAX_TEXT_BYTES * 3);
    const second = await api.fileText('F:/large.md', kinds.MAX_TEXT_BYTES, first.nextOffset!);
    bunTest.expect(requests[0]).toBe(`bytes=0-${kinds.MAX_TEXT_BYTES - 1}`);
    bunTest.expect(first.text.endsWith('\n')).toBe(true);
    bunTest.expect(first.partial).toBe(true);
    bunTest.expect(second.text.startsWith('## 后续章节')).toBe(true);
    bunTest.expect(second.nextOffset).toBeNull();
    bunTest.expect(first.text + second.text).toBe(text);
  } finally {
    globalThis.fetch = original;
  }
});


bunTest.test('服务器忽略Range也只保留预算内正文，非零继续请求明确失败', async () => {
  const original = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = (() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('abcdefghi'));
    },
    cancel() {
      cancelled = true;
    },
  }), { headers: { 'content-length': '9' } }))) as unknown as typeof fetch;
  try {
    const first = await api.fileText('F:/fake.txt', 4);
    bunTest.expect(first.text).toBe('abcd');
    bunTest.expect(first.nextOffset).toBe(4);
    bunTest.expect(cancelled).toBe(true);
    const error = await api.fileText('F:/fake.txt', 4, 4).catch((problem: unknown) => problem);
    bunTest.expect(String(error)).toContain('没有返回请求的分段');
  } finally {
    globalThis.fetch = original;
  }
});


bunTest.test('快速切换时旧异步成功和旧错误都丢弃，不覆盖当前目标', async () => {
  const original = globalThis.fetch;
  let resolveOld: (response: Response) => void = () => undefined;
  const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
  globalThis.fetch = ((url: string | URL | Request) => {
    const address = url instanceof Request ? url.url : url.toString();
    if (address.includes('old')) {
      return oldResponse;
    }
    return Promise.resolve(new Response('new', { status: 206, headers: { 'content-range': 'bytes 0-2/3' } }));
  }) as typeof fetch;
  try {
    const loader = new api.FilePreviewLoader(kinds.MAX_TEXT_BYTES);
    const old = loader.read('F:/old.md', 0);
    const current = await loader.read('F:/new.md', 0);
    resolveOld(new Response('old', { status: 206, headers: { 'content-range': 'bytes 0-2/3' } }));
    bunTest.expect(current?.text).toBe('new');
    bunTest.expect(await old).toBeUndefined();

    let rejectOld: (error: Error) => void = () => undefined;
    globalThis.fetch = (() => new Promise<Response>((_resolve, reject) => {
      rejectOld = reject;
    })) as unknown as typeof fetch;
    const stale = loader.read('F:/old.md', 0);
    loader.cancel();
    rejectOld(new Error('旧文件读取失败'));
    bunTest.expect(await stale).toBeUndefined();
  } finally {
    globalThis.fetch = original;
  }
});
