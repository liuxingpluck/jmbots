/** 验收微信独立入口的真实子进程、离线授权激活、客服页与退出协议。 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as stream from 'node:stream';
import { expect, test } from 'bun:test';
import * as licenseModule from './License.ts';


test('独立微信子进程：未授权阻断业务接口、在线激活许可证后开放客服页与退出协议', async () => {
  const temp = path.join(import.meta.dir, '.process-test-');
  const dir = fs.mkdtempSync(temp);
  const file = path.join(import.meta.dir, 'Main.ts');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubHex = licenseModule.exportPublicKeyHex(publicKey);
  const args = [process.execPath, file, '--data', dir, '--license-pubkey', pubHex];
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'inherit', windowsHide: true });
  const raw = child.stdout as unknown as Parameters<typeof stream.Readable.fromWeb>[0];
  const lines = readline.createInterface({ input: stream.Readable.fromWeb(raw) });
  try {
    const first = await Promise.race([
      new Promise<string>((resolve) => lines.once('line', resolve)),
      child.exited.then((status) => {
        throw new Error(`微信进程在报端口前退出，状态 ${String(status)}`);
      }),
    ]);
    const ready = JSON.parse(first) as { port: number };
    expect(ready).toMatchObject({ jmbots: 1, event: 'ready', name: 'wechat', version: '1.0.0' });
    const base = `http://127.0.0.1:${String(ready.port)}`;

    // 1. 初始无许可证：info/health/license/外壳放行，状态为 none，业务接口 402 未授权阻断。
    const infoBefore = await fetch(`${base}/jmbots/v1/info`);
    expect(await infoBefore.json()).toMatchObject({
      ok: true,
      protocol: 1,
      name: 'wechat',
      ui: '/',
      license: 'none',
    });
    const licBefore = await fetch(`${base}/jmbots/v1/license`);
    expect(await licBefore.json()).toMatchObject({ ok: true, state: 'none' });
    const health = await fetch(`${base}/jmbots/v1/health`);
    expect(await health.json()).toMatchObject({ ok: true, name: 'wechat' });
    const blockedStatus = await fetch(`${base}/api/wechat-kefu/status`);
    expect(blockedStatus.status).toBe(402);

    // 2. 现场签发临时 Ed25519 有效许可证并通过 PUT /jmbots/v1/license 激活。
    const validToken = licenseModule.signLicenseToken({
      product: licenseModule.LICENSE_PRODUCT_ID,
      licenseId: 'lic-main-test-01',
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 3_600_000,
      features: [licenseModule.REQUIRED_FEATURE],
    }, privateKey);
    const activated = await fetch(`${base}/jmbots/v1/license`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: validToken }),
    });
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({ ok: true, state: 'licensed' });

    const infoAfter = await fetch(`${base}/jmbots/v1/info`);
    expect(await infoAfter.json()).toMatchObject({ ok: true, license: 'licensed' });

    // 3. 激活后客服页与业务接口正常应答，最后优雅退出。
    const html = await fetch(base);
    expect(await html.text()).toContain('积木客服');
    const status = await fetch(`${base}/api/wechat-kefu/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ accounts: [] });
    const send = await fetch(`${base}/api/wechat-kefu/send`, { method: 'POST' });
    expect(send.status).toBe(409);
    const exit = await fetch(`${base}/jmbots/v1/exit`, { method: 'POST' });
    expect(await exit.json()).toEqual({ ok: true });
    expect(await child.exited).toBe(0);
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await child.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
