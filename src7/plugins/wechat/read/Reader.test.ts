/** 用 CLI 的合成 stdout 和 stderr 回执复现媒体失败，无需读取真实微信。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sqlite from 'bun:sqlite';
import * as test from 'bun:test';
import * as fastify from 'fastify';
import type * as httpModule from '../../http/index.ts';
import type * as wechatModule from '../index.ts';
import * as routes from '../page/Routes.ts';
import * as readerModule from './Reader.ts';
import * as voiceModule from './Voice.ts';

function makeRoot(): string {
  const prefix = path.join(import.meta.dir, '.media-test-');
  return fs.mkdtempSync(prefix);
}

function cleanRoot(root: string): void {
  //G 仅清理本测试生成的目录。
  test.expect(path.dirname(root)).toBe(import.meta.dir);
  test.expect(path.basename(root)).toMatch(/^\.media-test-\w+$/u);
  fs.rmSync(root, { recursive: true });
}

function mockEngine(out: string, err = '', code = 1) {
  //M 照 Bun 子进程返回的三个结果复现 CLI 对媒体请求的回执。
  return test.spyOn(Bun, 'spawn').mockImplementation(() => ({
    stdout: new Blob([out]).stream(),
    stderr: new Blob([err]).stream(),
    exited: Promise.resolve(code),
  }) as never);
}

test.test('同一图片并发和连续失败只调用一次引擎，保留脱敏原因', async () => {
  const root = makeRoot();
  const raw = JSON.stringify({ ok: false, error: 'not_found', detail: 'SYNTHETIC_SECRET' });
  const spawn = mockEngine(raw);
  const errors = test.spyOn(console, 'error').mockImplementation(() => undefined);
  const reader = new readerModule.Reader(root, 'synthetic-python', '');
  const read = () => reader.image('account', 'chat', 'message_0.db', 7);
  try {
    //M 模拟三个并发缩略图请求，紧接着再开一次同一张图。
    const results = await Promise.allSettled([read(), read(), read()]);
    const separate = await Promise.allSettled([read()]);
    const count = spawn.mock.calls.length;
    const lines = errors.mock.calls.flat().join('\n');
    console.log(`媒体失败复现：引擎 ${String(count)} 次，错误日志 ${String(errors.mock.calls.length)} 条`);
    test.expect(count).toBe(1);
    test.expect(errors.mock.calls).toHaveLength(1);
    test.expect(lines).toContain('image');
    test.expect(lines).toContain('not_found');
    test.expect(lines).not.toContain('SYNTHETIC_SECRET');
    for (const result of [...results, ...separate]) {
      test.expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') continue;

      test.expect(result.reason).toMatchObject({ code: 'not_found', message: '取不到图片：微信未保存这张图片' });
    }
  } finally {
    spawn.mockRestore();
    errors.mockRestore();
    cleanRoot(root);
  }
});

test.test('失败缓存按会话隔开，30 秒后允许再取图', async () => {
  const root = makeRoot();
  const spawn = mockEngine('{"ok":false,"error":"need_image_key"}');
  const errors = test.spyOn(console, 'error').mockImplementation(() => undefined);
  const now = test.spyOn(Date, 'now').mockReturnValue(100_000);
  const reader = new readerModule.Reader(root, 'synthetic-python', '');
  try {
    const first = reader.image('account', 'chat-a', 'message_0.db', 7);
    await test.expect(first).rejects.toMatchObject({ code: 'need_image_key' });
    const repeat = reader.image('account', 'chat-a', 'message_0.db', 7);
    await test.expect(repeat).rejects.toMatchObject({ code: 'need_image_key' });
    const other = reader.image('account', 'chat-b', 'message_0.db', 7);
    await test.expect(other).rejects.toMatchObject({ code: 'need_image_key' });
    test.expect(spawn).toHaveBeenCalledTimes(2);

    now.mockReturnValue(130_000);
    const retry = reader.image('account', 'chat-a', 'message_0.db', 7);
    await test.expect(retry).rejects.toMatchObject({ code: 'need_image_key' });
    test.expect(spawn).toHaveBeenCalledTimes(3);
    const metadata = path.join(root, 'runtime', 'data', 'account', 'media', 'jmbots', 'message_0_db_7.img.mime');
    test.expect(fs.existsSync(metadata)).toBe(false);
  } finally {
    now.mockRestore();
    spawn.mockRestore();
    errors.mockRestore();
    cleanRoot(root);
  }
});

test.test('客服页图片和语音接口返回 404 及具体原因，各只读引擎一次', async () => {
  const root = makeRoot();
  const app = fastify.default();
  const db = new sqlite.Database(':memory:');
  const spawn = mockEngine('{"ok":false,"error":"not_found"}');
  const errors = test.spyOn(console, 'error').mockImplementation(() => undefined);
  const reader = new readerModule.Reader(root, 'synthetic-python', '');
  const cache = path.join(root, 'audio');
  const audio = new voiceModule.VoiceAudio(reader, cache);
  try {
    //M 仅在内存库登记两条合成媒体消息，使用客服页的实际路由。
    db.run(`CREATE TABLE wechat_messages (
      account TEXT, chat TEXT, source TEXT, local_id INTEGER, kind TEXT, view TEXT
    )`);
    const sql = 'INSERT INTO wechat_messages VALUES (?, ?, ?, ?, ?, NULL)';
    db.run(sql, ['account', 'chat', 'message_0.db', 7, 'image']);
    db.run(sql, ['account', 'chat', 'message_0.db', 8, 'voice']);
    const http = { app } as unknown as httpModule.Http;
    const wechat = { reader } as wechatModule.Wechat;
    routes.routes(http, db, wechat, audio);

    const query = 'account=account&chat=chat&source=message_0.db';
    const image = `/api/wechat-kefu/image?${query}&local_id=7`;
    const voice = `/api/wechat-kefu/voice?${query}&local_id=8`;
    const endpoints = [
      [image, '取不到图片：微信未保存这张图片'],
      [voice, '微信未保存原音频'],
    ] as const;
    for (const [url, reason] of endpoints) {
      for (let at = 0; at < 2; at += 1) {
        const response = await app.inject(url);
        test.expect(response.statusCode).toBe(404);
        test.expect(response.headers['cache-control']).toBe('private, no-store');
        const body = response.json<{ error: string; code: string }>();
        test.expect(body).toEqual({ error: reason, code: 'not_found' });
      }
    }
    test.expect(spawn).toHaveBeenCalledTimes(2);
    test.expect(errors.mock.calls).toHaveLength(2);
  } finally {
    await app.close();
    db.close();
    spawn.mockRestore();
    errors.mockRestore();
    cleanRoot(root);
  }
});

test.test('未知错误码、坏回执和不一致的退出码都按固定类别报错', async () => {
  const root = makeRoot();
  const errors = test.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const samples = [
      ['{"ok":false,"error":"SYNTHETIC_SECRET"}', 'unknown_media_error'],
      ['SYNTHETIC_SECRET', 'invalid_response'],
      ['{"ok":true}', 'invalid_response'],
    ];
    for (const [stdout, code] of samples) {
      const spawn = mockEngine(stdout!, 'SYNTHETIC_STDERR');
      try {
        const reader = new readerModule.Reader(root, 'synthetic-python', '');
        const image = reader.image('account', 'chat', 'message_0.db', 7);
        const result = await Promise.allSettled([image]);
        test.expect(result[0]?.status).toBe('rejected');
        if (result[0]?.status !== 'rejected') continue;

        const failure = result[0].reason;
        test.expect(failure.code).toBe(code);
        test.expect(failure.message).not.toContain('SYNTHETIC');
      } finally {
        spawn.mockRestore();
      }
    }
    test.expect(errors.mock.calls.flat().join('\n')).not.toContain('SYNTHETIC');
  } finally {
    errors.mockRestore();
    cleanRoot(root);
  }
});
