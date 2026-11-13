/**
 * 模型被限流时依次换模型的离线测试（2026-11-04：WorkBuddy 的 deepseek 被限流到第二天，分派和新任务全断了；
 * 用户要求“一直换到不能用为止，然后才提示模型额度不够，并告知尝试过多少个模型”）。
 * 假的 Pi 模型集合：被点名的模型返回指定的错误，其余正常回话。不联网。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as piAi from '@earendil-works/pi-ai';
import * as modelModule from '../src/capabilities/Model.ts';
import * as resourcesModule from '../src/resources/Resources.ts';


/** 被限流的模型。 */
const LIMITED = 'magpie/workbuddy/deepseek-v4.1-flash';

/** WorkBuddy 真实返回的限流错误。 */
const RATE_LIMIT = '429: {"message":"WorkBuddy: 您的使用量已超出频率限制，将在 2026-11-05 01:44:31 UTC+8 重置"}';

/** 一次最简单的调用。 */
const INPUT: modelModule.ChatInput = { model: LIMITED, system: {}, messages: [], tools: [] };


/** 清单里的一个模型：ID（不带供应商）、价格、能读多少 token。 */
interface FakeModel {
  id: string;
  price?: number;
  window?: number;
}


/**
 * 建临时运行时目录。
 * @param engine config.yaml 里 engine 段多写的行。
 * @returns 目录；调用方负责删。
 */
function makeDir(engine: string[] = []): string {
  /** 临时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-fallback-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), [
    'providers:',
    '  magpie:',
    '    base_url: http://127.0.0.1:1/v1',
    '    api_key: fake-key-abcdefgh',
    `default_model: ${LIMITED}`,
    'engine:',
    '  max_steps: 10',
    ...engine.map((line) => `  ${line}`),
  ].join('\n'));
  return dir;
}


/**
 * 假的 Pi 模型集合。
 * @param known 清单里有的模型。
 * @param errorOf 模型 ID → 它要回的错误（列表就按调用次序一次一个）；没写的正常回话。
 * @param called 每次调用的模型 ID 记在这里。
 * @returns 假的集合。
 */
function fakeModels(known: FakeModel[], errorOf: Record<string, string | (string | undefined)[]>, called: string[]): piAi.MutableModels {
  /** 按 Pi 的样子造的模型。 */
  const models = known.map((item) => ({ id: item.id, name: item.id, provider: 'magpie', reasoning: false, input: ['text'], contextWindow: item.window ?? 8000, cost: { input: item.price ?? 0, output: item.price ?? 0 } }));
  return {
    getModel: (_provider: string, id: string) => models.find((item) => item.id === id),
    getModels: () => models,
    getModelsOfType: () => [],
    completeSimple: (model: { id: string }) => {
      called.push(model.id);
      /** 这个模型要回的错误；给的是列表就按调用次序一次取一个。 */
      const plan = errorOf[model.id];
      /** 这一次的错误。 */
      const error = Array.isArray(plan) ? plan.shift() : plan;
      return Promise.resolve({ role: 'assistant', content: error ? [] : [{ type: 'text', text: `${model.id} 回话` }], stopReason: error ? 'error' : 'stop', errorMessage: error });
    },
  } as unknown as piAi.MutableModels;
}


/**
 * 建好模型库，调一次，收拾临时目录。
 * @param engine config.yaml 的 engine 多写的行。
 * @param known 清单里的模型。
 * @param errorOf 各模型要回的错误。
 * @param input 这次调用。
 * @returns 结果和调过的模型。
 */
async function run(engine: string[], known: FakeModel[], errorOf: Record<string, string | (string | undefined)[]>, input = INPUT): Promise<{ output: modelModule.ChatOutput; called: string[] }> {
  /** 临时目录。 */
  const dir = makeDir(engine);
  try {
    /** 调过的模型。 */
    const called: string[] = [];
    /** 模型库。 */
    const ai = await modelModule.Ai.connect(await resourcesModule.Resources.load(dir), fakeModels(known, errorOf, called));
    return { output: await ai.chat(input), called };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


bunTest.test('被限流：换默认备用（MiniMax）再试，成功就接着干，记下原来要的和试过的', async () => {
  const { output, called } = await run([], [{ id: 'workbuddy/deepseek-v4.1-flash' }, { id: 'minimax-code/MiniMax-M3.1-Flash' }], { 'workbuddy/deepseek-v4.1-flash': RATE_LIMIT });
  bunTest.expect(called).toEqual(['workbuddy/deepseek-v4.1-flash', 'minimax-code/MiniMax-M3.1-Flash']);
  bunTest.expect(output.error).toBeUndefined();
  bunTest.expect(output.text).toBe('minimax-code/MiniMax-M3.1-Flash 回话');
  bunTest.expect(output.request.fallbackFrom).toBe(LIMITED);
  bunTest.expect(output.request.tried).toEqual([LIMITED, 'magpie/minimax-code/MiniMax-M3.1-Flash']);
});


bunTest.test('一串里前几个也被限流：按顺序接着换，角色自己的备用排最前', async () => {
  const { output, called } = await run(
    ['fallback_chain: [magpie/a, magpie/b]'],
    [{ id: 'workbuddy/deepseek-v4.1-flash' }, { id: 'own' }, { id: 'a' }, { id: 'b' }],
    { 'workbuddy/deepseek-v4.1-flash': RATE_LIMIT, own: RATE_LIMIT, a: '429 Too Many Requests' },
    { ...INPUT, fallbacks: ['magpie/own'] },
  );
  bunTest.expect(called).toEqual(['workbuddy/deepseek-v4.1-flash', 'own', 'a', 'b']);
  bunTest.expect(output.text).toBe('b 回话');
  bunTest.expect(output.request.tried?.length).toBe(4);
});


bunTest.test('全都被限流：提示“模型额度不够”，说清试了几个、哪些', async () => {
  const { output } = await run(['fallback_chain: [magpie/a]', 'fallback_include_siblings: false'], [{ id: 'workbuddy/deepseek-v4.1-flash' }, { id: 'a' }], { 'workbuddy/deepseek-v4.1-flash': RATE_LIMIT, a: RATE_LIMIT });
  bunTest.expect(output.error).toContain('模型额度不够');
  bunTest.expect(output.error).toContain('试了 2 个模型');
  bunTest.expect(output.error).toContain('magpie/a');
  bunTest.expect(output.request.tried).toEqual([LIMITED, 'magpie/a']);
});


bunTest.test('同供应商的其他模型只自动试不收费的：收费的不碰（会花用户的钱）', async () => {
  const { called } = await run(['fallback_chain: [magpie/gone]'], [{ id: 'workbuddy/deepseek-v4.1-flash' }, { id: 'paid', price: 3 }, { id: 'free' }], { 'workbuddy/deepseek-v4.1-flash': RATE_LIMIT });
  //G 链里的 gone 不在清单里，跳过；收费的 paid 不试；免费的 free 成功。
  bunTest.expect(called).toEqual(['workbuddy/deepseek-v4.1-flash', 'free']);
});


bunTest.test('别的错误不换模型；fallback_model 写 off 就不换', async () => {
  /** 参数错。 */
  const bad = await run([], [{ id: 'workbuddy/deepseek-v4.1-flash' }, { id: 'minimax-code/MiniMax-M3.1-Flash' }], { 'workbuddy/deepseek-v4.1-flash': '400: 参数不对' });
  bunTest.expect(bad.called).toEqual(['workbuddy/deepseek-v4.1-flash']);
  bunTest.expect(bad.output.error).toContain('参数不对');
  /** 关掉兜底。 */
  const off = await run(['fallback_model: off'], [{ id: 'workbuddy/deepseek-v4.1-flash' }, { id: 'minimax-code/MiniMax-M3.1-Flash' }], { 'workbuddy/deepseek-v4.1-flash': RATE_LIMIT });
  bunTest.expect(off.called).toEqual(['workbuddy/deepseek-v4.1-flash']);
  bunTest.expect(off.output.request.fallbackFrom).toBeUndefined();
});


bunTest.test('上下文超长：换能读得更多的模型，大的先试；都装不下就说清楚', async () => {
  /** 超长的报错（gpt-6.1-sol 真实返回）。 */
  const overflow = 'error：Your input exceeds the context window of this model. Please adjust your input and try again.';
  /** Sol 51 万，MiniMax 100 万，另一个 20 万（比它小，不试）。 */
  const known = [{ id: 'codex/gpt-6.1-sol', window: 512_000 }, { id: 'minimax-code/MiniMax-M3.1-Flash', window: 1_000_000 }, { id: 'small', window: 200_000 }];
  const ok = await run([], known, { 'codex/gpt-6.1-sol': overflow }, { ...INPUT, model: 'magpie/codex/gpt-6.1-sol' });
  bunTest.expect(ok.called).toEqual(['codex/gpt-6.1-sol', 'minimax-code/MiniMax-M3.1-Flash']);
  bunTest.expect(ok.output.request.fallbackFrom).toBe('magpie/codex/gpt-6.1-sol');
  /** 大的也装不下。 */
  const bad = await run([], known, { 'codex/gpt-6.1-sol': overflow, 'minimax-code/MiniMax-M3.1-Flash': overflow }, { ...INPUT, model: 'magpie/codex/gpt-6.1-sol' });
  bunTest.expect(bad.output.error).toContain('上下文太长');
  bunTest.expect(bad.output.error).toContain('试了 2 个模型');
});


bunTest.test('连接出错：先隔一会儿重试同一个模型，好了就不换', async () => {
  const { output, called } = await run(['retry_delays_ms: [1, 1]'], [{ id: 'workbuddy/deepseek-v4.1-flash' }, { id: 'minimax-code/MiniMax-M3.1-Flash' }], { 'workbuddy/deepseek-v4.1-flash': ['error：Connection error.', undefined] });
  bunTest.expect(called).toEqual(['workbuddy/deepseek-v4.1-flash', 'workbuddy/deepseek-v4.1-flash']);
  bunTest.expect(output.error).toBeUndefined();
  bunTest.expect(output.request.fallbackFrom).toBeUndefined();
});


bunTest.test('认得出限流的几种说法', () => {
  bunTest.expect(modelModule.isTransient('error：Connection error.')).toBe(true);
  bunTest.expect(modelModule.isTransient(RATE_LIMIT)).toBe(false);
  bunTest.expect(modelModule.isContextOverflow('Your input exceeds the context window of this model')).toBe(true);
  bunTest.expect(modelModule.isContextOverflow(RATE_LIMIT)).toBe(false);
  bunTest.expect(modelModule.isRateLimited(RATE_LIMIT)).toBe(true);
  bunTest.expect(modelModule.isRateLimited('error: Rate limit reached')).toBe(true);
  bunTest.expect(modelModule.isRateLimited('400: bad request')).toBe(false);
});


bunTest.test('没写备用链：退到 default_model，链里就它一个', async () => {
  /** 临时运行时目录：engine 里不写 fallback_chain / fallback_model。 */
  const dir = makeDir();
  /** 加载后的资源（只读）。 */
  const resources = await resourcesModule.Resources.load(dir);
  bunTest.expect(resources.getSetting('fallbackChain')).toEqual([LIMITED]);
});


bunTest.test('fallback_model 写 off：备用链是空的', async () => {
  /** 临时运行时目录：engine 里写 fallback_model: off。 */
  const dir = makeDir(['fallback_model: off']);
  /** 加载后的资源（只读）。 */
  const resources = await resourcesModule.Resources.load(dir);
  bunTest.expect(resources.getSetting('fallbackChain')).toEqual([]);
});


/**
 * 按 UTC+8 写一个时间（WorkBuddy 报错里的写法）。
 * @param ms 毫秒时间戳。
 * @returns 如 2026-11-07 02:20:26。
 */
function utc8(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
}


bunTest.test('读恢复时间：WorkBuddy 的 UTC+8、带时区的 ISO、retry after、try again in；读不出来是 undefined', () => {
  /** 现在。 */
  const now = Date.parse('2026-11-06T12:00:00Z');
  bunTest.expect(modelModule.resetTimeOf(RATE_LIMIT, now)).toBe(Date.parse('2026-11-05T01:44:31+08:00'));
  bunTest.expect(modelModule.resetTimeOf('reset at 2026-11-07T02:20:26+08:00', now)).toBe(Date.parse('2026-11-06T18:20:26Z'));
  bunTest.expect(modelModule.resetTimeOf('429 Too Many Requests, retry after 30 seconds', now)).toBe(now + 30_000);
  bunTest.expect(modelModule.resetTimeOf('Rate limit reached. Please try again in 6m0s.', now)).toBe(now + 360_000);
  bunTest.expect(modelModule.resetTimeOf('429 Too Many Requests', now)).toBeUndefined();
});


bunTest.test('被限流、报错里写了几点恢复：冷却到那时，下一次直接用备用的，不再先撞一次；清单里带上 limitedUntil', async () => {
  /** 临时目录。 */
  const dir = makeDir();
  try {
    /** 调过的模型。 */
    const called: string[] = [];
    /** 一小时后恢复（报错里只写到秒）。 */
    const resetAt = Math.floor((Date.now() + 3_600_000) / 1000) * 1000;
    /** 写了恢复时间的限流报错。 */
    const limit = `429: {"message":"WorkBuddy: 您的使用量已超出频率限制，将在 ${utc8(resetAt)} UTC+8 重置"}`;
    /** 模型库：同一个，调两次。 */
    const ai = await modelModule.Ai.connect(await resourcesModule.Resources.load(dir), fakeModels([{ id: 'workbuddy/deepseek-v4.1-flash' }, { id: 'minimax-code/MiniMax-M3.1-Flash' }], { 'workbuddy/deepseek-v4.1-flash': limit }, called));
    await ai.chat(INPUT);
    /** 第二次。 */
    const second = await ai.chat(INPUT);
    bunTest.expect(called).toEqual(['workbuddy/deepseek-v4.1-flash', 'minimax-code/MiniMax-M3.1-Flash', 'minimax-code/MiniMax-M3.1-Flash']);
    bunTest.expect(second.text).toBe('minimax-code/MiniMax-M3.1-Flash 回话');
    bunTest.expect(second.request.fallbackFrom).toBe(LIMITED);
    bunTest.expect(ai.listModels().find((item) => item.id === LIMITED)?.limitedUntil).toBe(resetAt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test('报错里没写几点恢复：按 engine.rate_limit_cooldown_minutes 冷却；全在冷却时照旧按顺序都试一遍', async () => {
  /** 临时目录。 */
  const dir = makeDir(['fallback_chain: [magpie/a]', 'fallback_include_siblings: false', 'rate_limit_cooldown_minutes: 10']);
  try {
    /** 调过的模型。 */
    const called: string[] = [];
    /** 模型库：两个都一直被限流。 */
    const ai = await modelModule.Ai.connect(await resourcesModule.Resources.load(dir), fakeModels([{ id: 'workbuddy/deepseek-v4.1-flash' }, { id: 'a' }], { 'workbuddy/deepseek-v4.1-flash': '429 Too Many Requests', a: '429 Too Many Requests' }, called));
    /** 调之前。 */
    const before = Date.now();
    await ai.chat(INPUT);
    /** a 冷却到什么时候。 */
    const until = ai.listModels().find((item) => item.id === 'magpie/a')?.limitedUntil ?? 0;
    bunTest.expect(until).toBeGreaterThanOrEqual(before + 600_000);
    bunTest.expect(until).toBeLessThanOrEqual(Date.now() + 600_000);
    called.length = 0;
    /** 两个都在冷却时再调一次。 */
    const output = await ai.chat(INPUT);
    //G 要的那个排最前，照旧都试了一遍，回“模型额度不够”。
    bunTest.expect(called).toEqual(['workbuddy/deepseek-v4.1-flash', 'a']);
    bunTest.expect(output.error).toContain('模型额度不够');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test('用量（docs/15）：每真调一次记一行，被限流失败的那次也记；带上供应商、种类、谁调的', async () => {
  /** 临时目录。 */
  const dir = makeDir();
  try {
    /** 调过的模型。 */
    const called: string[] = [];
    /** 模型库。 */
    const ai = await modelModule.Ai.connect(await resourcesModule.Resources.load(dir), fakeModels([{ id: 'workbuddy/deepseek-v4.1-flash' }, { id: 'minimax-code/MiniMax-M3.1-Flash' }], { 'workbuddy/deepseek-v4.1-flash': RATE_LIMIT }, called));
    /** 记下的用量。 */
    const rows: modelModule.UsageRecord[] = [];
    ai.onUsage((row) => rows.push(row));
    await ai.chat({ ...INPUT, purpose: 'session', bot: '小测', sessionId: 's1' });
    bunTest.expect(rows.map((row) => `${row.model}|${String(row.ok)}`)).toEqual([`${LIMITED}|false`, 'magpie/minimax-code/MiniMax-M3.1-Flash|true']);
    bunTest.expect(rows.every((row) => row.provider === 'magpie' && row.kind === 'chat' && row.purpose === 'session' && row.sessionId === 's1')).toBe(true);
    bunTest.expect(rows[0]!.error).toContain('429');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
