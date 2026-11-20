/** 合成数据验证外置微信的媒体接口范围、WAV 复用和客服页产物，不连真微信。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import * as sqlite from 'bun:sqlite';
import * as fastify from 'fastify';
import * as silk from 'silk-wasm';
import * as pageModule from './ReadRoutes.ts';
import * as storeModule from './read/Store.ts';
import * as voiceModule from './read/VoiceCache.ts';
import * as webModule from './Web.ts';

/** 当前用例需要执行的清理。 */
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 一秒 24 kHz 合成语音，去掉头字节后与引擎交出的 SILK 形状一致。 */
async function getSample(): Promise<Buffer> {
  const rate = 24_000;
  const pcm = new Int16Array(rate);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.round(8_000 * Math.sin(2 * Math.PI * 440 * i / rate));
  const encoded = await silk.encode(pcm, rate);
  return Buffer.from(encoded.data.subarray(1));
}

/** 假引擎记录取音、取图次数；库里只有一条 a/chat 的语音和图片。 */
async function getRoutes(seconds: number) {
  const dir = fs.mkdtempSync(path.join(import.meta.dir, '.safety-test-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new sqlite.Database(':memory:');
  const store = new storeModule.Store(db);
  const common = { source: 's', create_time: 1, at_me: false, from_self: false };
  store.save('a', 'chat', { ...common, local_id: 7, local_type: 34, view: { kind: 'voice', sender: '甲', seconds } });
  store.save('a', 'chat', { ...common, local_id: 8, local_type: 3, view: { kind: 'image', sender: '甲' } });
  store.save('a', 'chat', { ...common, local_id: 9, local_type: 1, view: { sender: '甲', text: '文字' } });
  const sample = await getSample();
  const calls = { voice: 0, image: 0 };
  const reader = {
    accounts: () => [],
    voice: async () => {
      calls.voice += 1;
      return sample;
    },
    image: async () => {
      calls.image += 1;
      throw new Error('合成：没有图片');
    },
  };
  const source = { reader, status: {}, config: { intervalMs: 3000, chatLimit: 10 } };
  const voice = new voiceModule.VoiceAudio(reader as never, dir);
  const app = fastify.default();
  cleanups.push(async () => { await app.close(); });
  pageModule.mountReadRoutes(app, db, source as never, voice);
  await app.ready();
  return { app, calls, dir };
}

/** 拼出语音接口地址。 */
function voiceUrl(query: Record<string, string>): string {
  return `/api/wechat-kefu/voice?${new URLSearchParams(query).toString()}`;
}

test('语音只认账号、会话、分片、消息号都对得上的语音消息，WAV 落盘后复用', async () => {
  const { app, calls, dir } = await getRoutes(1);
  const full = { account: 'a', chat: 'chat', source: 's', local_id: '7' };

  //G 缺字段、非数字消息号、别的会话或账号、不是语音的消息，都不碰引擎。
  const incomplete = await app.inject(voiceUrl({ account: 'a', chat: 'chat', source: 's' }));
  expect(incomplete.statusCode).toBe(400);
  const badId = await app.inject(voiceUrl({ ...full, local_id: '7abc' }));
  expect(badId.statusCode).toBe(400);
  for (const wrong of [{ chat: 'other' }, { account: 'b' }, { source: 'x' }, { local_id: '8' }, { local_id: '9' }]) {
    const response = await app.inject(voiceUrl({ ...full, ...wrong }));
    expect(response.statusCode).toBe(404);
  }
  expect(calls.voice).toBe(0);

  //M 第一次经引擎取音并解码，第二次读缓存，引擎只被问一次；音频不缓存，带 no-store。
  const first = await app.inject(voiceUrl(full));
  expect(first.statusCode).toBe(200);
  expect(first.headers['content-type']).toBe('audio/wav');
  expect(first.headers['cache-control']).toBe('private, no-store');
  expect(first.rawPayload.toString('ascii', 0, 4)).toBe('RIFF');
  const second = await app.inject(voiceUrl(full));
  expect(second.rawPayload.equals(first.rawPayload)).toBe(true);
  expect(calls.voice).toBe(1);

  //M 缓存目录只用哈希命名，不带账号、会话名。
  const folders = fs.readdirSync(dir).filter((name) => name.startsWith('wechat_voice_'));
  expect(folders).toHaveLength(1);
  expect(folders[0]).toMatch(/^wechat_voice_[0-9a-f]{64}$/u);
  expect(fs.readdirSync(path.join(dir, folders[0]!))).toEqual(['voice.wav']);
});

test('语音时长和聊天记录对不上时不出声音也不留缓存，并给出原因', async () => {
  const { app, calls, dir } = await getRoutes(5);
  const response = await app.inject(voiceUrl({ account: 'a', chat: 'chat', source: 's', local_id: '7' }));
  expect(response.statusCode).toBe(404);
  expect(response.json<{ error: string; code: string }>()).toEqual({
    error: '音频时长与聊天记录不符',
    code: 'duration_mismatch',
  });
  expect(calls.voice).toBe(1);
  const folders = fs.readdirSync(dir).filter((name) => name.startsWith('wechat_voice_'));
  expect(folders).toHaveLength(0);
});

test('图片只给库里这条图片消息，别的会话、别的类型不去扫微信目录', async () => {
  const { app, calls } = await getRoutes(1);
  const base = { account: 'a', chat: 'chat', source: 's', local_id: '8' };
  for (const wrong of [{ chat: 'other' }, { account: 'b' }, { local_id: '7' }, { local_id: '9' }, { local_id: '99' }]) {
    const query = new URLSearchParams({ ...base, ...wrong }).toString();
    const response = await app.inject(`/api/wechat-kefu/image?${query}`);
    expect(response.statusCode).toBe(404);
  }
  expect(calls.image).toBe(0);

  //M 对得上才问引擎；未知引擎异常统一脱敏为固定原因与 unavailable 码，不带路径或内部报错。
  const found = await app.inject(`/api/wechat-kefu/image?${new URLSearchParams(base).toString()}`);
  expect(found.statusCode).toBe(404);
  expect(found.json<{ error: string; code: string }>()).toEqual({
    error: '取不到图片：读取失败',
    code: 'unavailable',
  });
  expect(calls.image).toBe(1);
});

test('外置客服页产物：相对接口、虚拟列表、AI 建议和打码，不包含发送入口', async () => {
  const html = await webModule.buildPage();
  expect(html).toContain('./api/wechat-kefu/');
  //G 绝对的 /api/wechat-kefu/ 会跳出 /programs/<名字>/ 前缀，绕开转发。
  expect(html).not.toMatch(/["'`]\/api\/wechat-kefu\//u);
  expect(html).toContain('capabilities');
  expect(html).toContain('AI 建议');
  expect(html).toContain('让 AI 起草建议');
  expect(html).toContain('复制');
  expect(html).toContain('data-virtuoso-scroller');
  expect(html).not.toContain('outbox/send');
  expect(html).not.toMatch(/确认发送|可逐条确认发送|草稿与发送记录|Confirm send/u);
  expect(html).not.toContain('.wk-page .wk-compose');
  expect(html).toContain('jmbots.wechat.mask');
  expect(html).toContain('已打码');
}, 60_000);
