/** 挑上下文（Context.ts）的离线测试：搜不到不报错、三路判断、只把 keep 拼进提示词。 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as context from '../src/capabilities/Context.ts';
import type * as modelModule from '../src/capabilities/Model.ts';


/**
 * 起一个假的 jmindex：按给的内容回一次 /search，用完关掉。
 * @param body 返回的正文。
 * @param ok 是不是 200。
 * @returns 地址和关闭函数。
 */
function fakeIndex(body: string, ok = true): { baseUrl: string; close: () => void } {
  /** 假的 jmindex。 */
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(body, { status: ok ? 200 : 500 }),
  });
  return { baseUrl: `http://127.0.0.1:${String(server.port)}`, close: () => { void server.stop(true); } };
}


/**
 * 建一个假决策模型：按文件路径给概率和选择，没列的文件当成"出错"。
 * @param verdicts 路径 → 概率和选择。
 * @returns 假的 Ai。
 */
function fakeAi(verdicts: Record<string, { helpful: number; choice: string } | undefined>): modelModule.Ai {
  return {
    chat: () => Promise.reject(new Error('不该调常规模型')),
    decide: (input) => {
      //M 情况里的文件路径是调用方塞的字符串，不是就当空（决策模型不该收到别的类型）。
      const raw = input.state.文件;
      /** 这次判的文件。 */
      const path = typeof raw === 'string' ? raw : '';
      /** 预先定的结论。 */
      const verdict = verdicts[path];
      if (!verdict) {
        return Promise.resolve({
          answers: {},
          error: '决策模型出错',
          ms: 1,
          request: { model: 'fake/d1', state: input.state, questions: input.questions },
        });
      }
      return Promise.resolve({
        answers: {
          context_useful: { type: 'choice', choice: verdict.choice, probabilities: { keep: verdict.helpful, drop: 1 - verdict.helpful, look: 0 } },
        } as unknown as modelModule.DecideOutput['answers'],
        ms: 1,
        request: { model: 'fake/d1', state: input.state, questions: input.questions },
      });
    },
    hasDecision: () => true,
    listModels: () => [],
  };
}


test.test('jmindex 没起来：当成没搜到，不抛错', async () => {
  //M 用一个几乎肯定没人监听的端口，模拟 jmindex 没启动。
  assert.deepEqual(await context.search('http://127.0.0.1:1', '随便', 5), []);
});


test.test('返回看不懂、或者报 500：也当成没搜到', async () => {
  /** 不是 JSON。 */
  const garbage = fakeIndex('这不是 JSON');
  try {
    assert.deepEqual(await context.search(garbage.baseUrl, '随便', 5), []);
  } finally {
    garbage.close();
  }
  /** 报 500。 */
  const failing = fakeIndex('{"results":[]}', false);
  try {
    assert.deepEqual(await context.search(failing.baseUrl, '随便', 5), []);
  } finally {
    failing.close();
  }
});


test.test('正常搜到：没有路径的条目丢掉，摘要和片段缺了给空串', async () => {
  /** 假的 jmindex。 */
  const index = fakeIndex(JSON.stringify({
    results: [
      { path: 'src/a.ts', summary: '讲 A', snippet: '代码 A' },
      { summary: '没有路径' },
      { path: 'docs/b.md', text: '正文 B' },
    ],
  }));
  try {
    assert.deepEqual(await context.search(index.baseUrl, '找点什么', 5), [
      { path: 'src/a.ts', summary: '讲 A', snippet: '代码 A' },
      { path: 'docs/b.md', summary: '', snippet: '正文 B' },
    ]);
  } finally {
    index.close();
  }
});


test.test('jmindex 真身返回 hits + snippets：按 hits 解析，命中片段拼起来', async () => {
  /** 假的 jmindex：和真身一样的形状（hits、tags、snippets）。 */
  const index = fakeIndex(JSON.stringify({
    hits: [
      { path: 'src/events/Loop.ts', summary: '事件循环和执行链', tags: ['core'], snippets: [{ text: '第一段片段' }, { text: '第二段片段' }] },
      { path: 'src/a.ts', summary: '', snippets: [] },
      { summary: '没有路径，丢掉' },
    ],
  }));
  try {
    //M 这是刚修过的 bug：真身返回 hits，不是 results；按 results 解析会一条都搜不到。
    assert.deepEqual(await context.search(index.baseUrl, '事件循环', 5), [
      { path: 'src/events/Loop.ts', summary: '事件循环和执行链', snippet: '第一段片段\n第二段片段' },
      { path: 'src/a.ts', summary: '', snippet: '' },
    ]);
  } finally {
    index.close();
  }
});


test.test('返回看不懂的 JSON：当成没搜到，不抛错', async () => {
  /** 假的 jmindex：既没有 results 也没有 hits。 */
  const index = fakeIndex('{"foo":"bar"}');
  try {
    assert.deepEqual(await context.search(index.baseUrl, '随便', 5), []);
  } finally {
    index.close();
  }
});


test.test('三路判断：概率够高是 keep，模型说拿不准是 look，其余是 drop', async () => {
  /** 搜到的几条。 */
  const found: context.Found[] = [
    { path: 'keep.ts', summary: '', snippet: '' },
    { path: 'look.ts', summary: '', snippet: '' },
    { path: 'drop.ts', summary: '', snippet: '' },
    { path: 'error.ts', summary: '', snippet: '' },
  ];
  /** 筛过的。 */
  const picked = await context.judgeFound({
    task: '改代码',
    found,
    ai: fakeAi({ 'keep.ts': { helpful: 0.9, choice: 'keep' }, 'look.ts': { helpful: 0.4, choice: 'look' }, 'drop.ts': { helpful: 0.4, choice: 'drop' } }),
    keepAbove: 0.6,
  });
  //M 1. 按有帮助的概率从高到低排。
  assert.deepEqual(picked.map((item) => [item.path, item.verdict]), [
    ['keep.ts', 'keep'],
    ['look.ts', 'look'],
    ['drop.ts', 'drop'],
    //M 2. 决策出错的文件不扔，标成拿不准。
    ['error.ts', 'look'],
  ]);
});


test.test('没配决策模型：不筛，全部标成拿不准，也不调模型', async () => {
  /** 假的 Ai，一调 decide 就炸。 */
  const ai: modelModule.Ai = {
    ...fakeAi({}),
    hasDecision: () => false,
  };
  /** 筛过的。 */
  const picked = await context.judgeFound({ task: '改代码', found: [{ path: 'a.ts', summary: '', snippet: '' }], ai, keepAbove: 0.6 });
  assert.deepEqual(picked.map((item) => item.verdict), ['look']);
});


test.test('没配地址：什么都不挑', async () => {
  assert.deepEqual(await context.pickContext({ task: '改代码', ai: fakeAi({}), options: {} }), { text: '', picked: [] });
});


test.test('拼好的提示词里只有 keep 的文件，片段按上限截短', async () => {
  /** 假的 jmindex。 */
  const index = fakeIndex(JSON.stringify({
    results: [
      { path: 'src/a.ts', summary: '讲 A', snippet: 'x'.repeat(50) },
      { path: 'src/b.ts', summary: '讲 B', snippet: '' },
    ],
  }));
  try {
    /** 挑上下文的结果。 */
    const result = await context.pickContext({
      task: '改 a.ts',
      ai: fakeAi({ 'src/a.ts': { helpful: 0.8, choice: 'keep' }, 'src/b.ts': { helpful: 0.1, choice: 'drop' } }),
      options: { baseUrl: index.baseUrl, limit: 8, keepAbove: 0.6, maxSnippetChars: 10 },
    });
    //M 1. 搜到两份都记在 picked 里（流水要报"搜到 N 份"）。
    assert.equal(result.picked.length, 2);
    //M 2. 提示词里只有 keep 的那份，drop 的不出现。
    assert.match(result.text, /src\/a\.ts/);
    assert.doesNotMatch(result.text, /src\/b\.ts/);
    assert.match(result.text, /80% 相关/);
    assert.match(result.text, /讲 A/);
  } finally {
    index.close();
  }
});


test.test('一份都没判成 keep：不给提示词，但 picked 留着给流水用', async () => {
  /** 假的 jmindex。 */
  const index = fakeIndex(JSON.stringify({ results: [{ path: 'src/a.ts', summary: '', snippet: '' }] }));
  try {
    /** 挑上下文的结果。 */
    const result = await context.pickContext({
      task: '改 b.ts',
      ai: fakeAi({ 'src/a.ts': { helpful: 0.1, choice: 'drop' } }),
      options: { baseUrl: index.baseUrl },
    });
    assert.equal(result.text, '');
    assert.equal(result.picked.length, 1);
  } finally {
    index.close();
  }
});
