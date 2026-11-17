/**
 * 免令牌来源地址的单元测试（2026-11-14 23:50 EST，用户：本机和网关 192.168.200.1 访问不用令牌，别的局域网、外网地址要令牌）。
 * 跑法：bun test src7/plugins/http/Trusted.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { trustedIp } from './index.ts';

describe('免令牌的来源地址', () => {
  const trusted = ['127.0.0.1', '::1', '192.168.200.1'];
  test('本机免', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.2']) expect(trustedIp(ip, trusted)).toBe(true);
  });
  test('网关免（写在 trusted_ips 里）', () => {
    expect(trustedIp('192.168.200.1', trusted)).toBe(true);
    expect(trustedIp('::ffff:192.168.200.1', trusted)).toBe(true);
  });
  test('别的地址要令牌；不写 trusted_ips 时网关也要', () => {
    for (const ip of ['192.168.200.130', '192.168.1.5', '8.8.8.8', '10.0.0.1']) expect(trustedIp(ip, trusted)).toBe(false);
    expect(trustedIp('192.168.200.1', ['127.0.0.1', '::1'])).toBe(false);
  });
});
