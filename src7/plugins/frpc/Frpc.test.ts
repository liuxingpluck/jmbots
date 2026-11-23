/**
 * frpc 外网隧道插件单测：覆盖 TOML 零损解析与回写、auth.token 零泄漏、
 * 30086 回环地址安全拦截、POST/PUT 403/200 身份核验、Windows 开机自启脚本与日志脱敏。
 */
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as failureModule from '../../utils/Failure.ts';
import { registerHttpErrorHandler } from '../http/index.ts';
import * as frpcPlugin from './index.ts';
import * as processModule from './Process.ts';
import * as tomlModule from './Toml.ts';


const SAMPLE_SECRET = 'SUPER_SECRET_TOKEN_NEVER_LEAK_998877';

const SAMPLE_TOML = [
  '# ============================================================================',
  '# LeonFRPS Windows 隧道客户端配置',
  '# 头部注释必须 100% 原样保留',
  '# ============================================================================',
  '',
  'serverAddr = "203.0.113.10"',
  'serverPort = 17000',
  'user = "leon-windows"',
  '',
  'auth.method = "token"',
  `auth.token = "${SAMPLE_SECRET}"`,
  '',
  'transport.tls.enable = true',
  'loginFailExit = false',
  '',
  'log.to = "./frpc.log"',
  'log.level = "info"',
  'log.maxDays = 7',
  '',
  '# Web 应用隧道',
  '[[proxies]]',
  'name = "jmbots-web"',
  'type = "http"',
  'localIP = "192.168.200.1"',
  'localPort = 30086',
  'customDomains = ["app.xuanguiyl.top"]',
  '',
].join('\r\n');


const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});


describe('frpc TOML 零损解析与无损回写', () => {
  test('解析连接信息与 proxies，且结果对象绝不含 auth.token 明文', () => {
    const parsed = tomlModule.parseFrpcToml(`\uFEFF${SAMPLE_TOML}`);
    expect(parsed.serverAddr).toBe('203.0.113.10');
    expect(parsed.serverPort).toBe(17000);
    expect(parsed.user).toBe('leon-windows');
    expect(parsed.tlsEnabled).toBe(true);
    expect(parsed.hasAuthToken).toBe(true);
    expect(parsed.proxies).toEqual([
      {
        name: 'jmbots-web',
        type: 'http',
        localIP: '192.168.200.1',
        localPort: 30086,
        customDomains: ['app.xuanguiyl.top'],
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain(SAMPLE_SECRET);
  });

  test('无损回写 [[proxies]]：100% 保留头部注释、auth.token、TLS 与 log.*，且多次回写幂等', () => {
    const nextProxies: tomlModule.FrpcProxy[] = [
      {
        name: 'jmbots-web',
        type: 'http',
        localIP: '192.168.200.1',
        localPort: 30086,
        customDomains: ['app.xuanguiyl.top', 'bot.xuanguiyl.top'],
      },
      {
        name: 'dev-ssh',
        type: 'tcp',
        localIP: '127.0.0.1',
        localPort: 22,
        remotePort: 16022,
      },
    ];
    const once = tomlModule.rewriteFrpcTomlProxies(SAMPLE_TOML, nextProxies);
    const twice = tomlModule.rewriteFrpcTomlProxies(once, nextProxies);

    expect(twice).toBe(once);
    expect(once).toContain('# 头部注释必须 100% 原样保留');
    expect(once).toContain(`auth.token = "${SAMPLE_SECRET}"`);
    expect(once).toContain('transport.tls.enable = true');
    expect(once).toContain('log.to = "./frpc.log"');
    expect(once).toContain('log.maxDays = 7');

    const reparsed = tomlModule.parseFrpcToml(once);
    expect(reparsed.hasAuthToken).toBe(true);
    expect(reparsed.proxies).toEqual(nextProxies);
  });

  test('没写 localIP 的隧道照 frpc 默认记成 127.0.0.1，不悄悄丢掉', () => {
    const raw = ['[[proxies]]', 'name = "no-ip"', 'type = "http"', 'localPort = 30086', ''].join('\r\n');
    const parsed = tomlModule.parseFrpcToml(raw);
    expect(parsed.proxies).toEqual([{ name: 'no-ip', type: 'http', localIP: '127.0.0.1', localPort: 30086 }]);
  });

  test('getProxyWarnings 和 PUT 校验同一个判断：主站端口接回环才告警，别的端口不管', () => {
    const proxies: tomlModule.FrpcProxy[] = [
      { name: 'safe-web', type: 'http', localIP: '192.168.200.1', localPort: 30086 },
      { name: 'loop-web', type: 'http', localIP: '127.0.0.1', localPort: 30086 },
      { name: 'loop-custom', type: 'http', localIP: 'localhost', localPort: 30099 },
      { name: 'dev-ssh', type: 'tcp', localIP: '127.0.0.1', localPort: 22, remotePort: 16022 },
    ];
    const warnings = tomlModule.getProxyWarnings(proxies, 30099);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('loop-web');
    expect(warnings[1]).toContain('loop-custom');
    expect(tomlModule.getProxyWarnings([proxies[0]!, proxies[3]!], 30099)).toEqual([]);
  });
});


describe('frpc 托盘 BOM 兼容与 Windows 开机自启脚本', () => {
  test('readTrayStatusSnapshot 兼容 PowerShell UTF-8 BOM', () => {
    const dir = makeTempDir('frpc-bom-');
    const statusPayload = {
      trayPid: 43760,
      frpcPid: 49540,
      frpcRunning: true,
      frpcConnected: true,
      detail: '在线',
      updatedAt: '2026-11-21 12:39:07',
    };
    fs.writeFileSync(path.join(dir, 'tray-status.json'), `\uFEFF${JSON.stringify(statusPayload)}`, 'utf8');

    const snap = processModule.readTrayStatusSnapshot(dir);
    expect(snap).toBeDefined();
    expect(snap?.trayPid).toBe(43760);
    expect(snap?.frpcPid).toBe(49540);
    expect(snap?.frpcConnected).toBe(true);
    expect(snap?.detail).toBe('在线');
  });

  test('createDefaultRunner 在模拟 APPDATA 下写入与幂等删除 LeonFRPS-Tray.vbs', () => {
    const clientDir = makeTempDir('frpc-client-');
    const appdataDir = makeTempDir('frpc-appdata-');
    const startTrayPath = path.join(clientDir, 'start-tray.vbs');
    fs.writeFileSync(startTrayPath, 'Set ws = CreateObject("WScript.Shell")\r\n', 'utf8');

    const runner = processModule.createDefaultRunner(appdataDir);
    expect(runner.readAutoStart()).toBe(false);

    expect(runner.writeAutoStart(clientDir, true)).toBe(true);
    expect(runner.readAutoStart()).toBe(true);

    const vbsFile = processModule.getStartupVbsPath(appdataDir);
    const vbsContent = fs.readFileSync(vbsFile, 'utf8');
    expect(vbsContent).toContain('CreateObject("WScript.Shell")');
    expect(vbsContent).toContain('wscript.exe //B //NoLogo');
    expect(vbsContent).toContain(startTrayPath);
    expect(vbsContent.endsWith('\r\n')).toBe(true);

    expect(runner.writeAutoStart(clientDir, false)).toBe(false);
    expect(runner.readAutoStart()).toBe(false);
    // 再次删除保持幂等
    expect(runner.writeAutoStart(clientDir, false)).toBe(false);
  });

  test('Startup 目录已在时不走 mkdir：模拟 Windows Bun 对它抛 EEXIST 也照样写好 LeonFRPS-Tray.vbs', () => {
    const clientDir = makeTempDir('frpc-client-');
    const appdataDir = makeTempDir('frpc-appdata-');
    const startTrayPath = path.join(clientDir, 'start-tray.vbs');
    fs.writeFileSync(startTrayPath, 'rem tray\r\n', 'utf8');
    const vbsFile = processModule.getStartupVbsPath(appdataDir);
    fs.mkdirSync(path.dirname(vbsFile), { recursive: true });

    // 模拟 Windows 上的 Bun：对已存在的 Startup 目录 mkdirSync(recursive) 抛 EEXIST
    const mkdirSpy = spyOn(fs, 'mkdirSync').mockImplementation(() => {
      const error = new Error('EEXIST: file already exists, mkdir') as NodeJS.ErrnoException;
      error.code = 'EEXIST';
      throw error;
    });
    try {
      // 反证桩确实打到 Process.ts：Startup 目录不在的 APPDATA 要 mkdir，就会抛出 EEXIST
      const missingRunner = processModule.createDefaultRunner(makeTempDir('frpc-appdata-missing-'));
      expect(() => missingRunner.writeAutoStart(clientDir, true)).toThrow('EEXIST');
      expect(mkdirSpy).toHaveBeenCalledTimes(1);
      mkdirSpy.mockClear();

      const runner = processModule.createDefaultRunner(appdataDir);
      expect(runner.writeAutoStart(clientDir, true)).toBe(true);
      // 目标已在时再写一次：改名盖过去，照样成功
      expect(runner.writeAutoStart(clientDir, true)).toBe(true);
      expect(mkdirSpy).not.toHaveBeenCalled();
    } finally {
      mkdirSpy.mockRestore();
    }

    expect(fs.readFileSync(vbsFile, 'utf8')).toContain(startTrayPath);
    const leftovers = fs.readdirSync(path.dirname(vbsFile)).filter((item) => item.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});


describe('frpc 启动脱离 jmbots-server 进程树（WMI 拉起）与 start 状态收敛', () => {
  /** 在客户端目录写一份新鲜的 tray-status.json，模拟托盘或 frpc 已经起来。PID 用本进程，保证存活。 */
  function writeFreshTrayStatus(dir: string, trayPid: number): void {
    const status = {
      trayPid,
      frpcPid: process.pid,
      frpcRunning: true,
      frpcConnected: true,
      detail: '在线',
      updatedAt: '2026-11-23 08:30:00',
    };
    fs.writeFileSync(path.join(dir, 'tray-status.json'), JSON.stringify(status), 'utf8');
  }

  /** 建一个带 frpc.exe、frpc.toml 的假客户端目录；withTray 时再放 start-tray.vbs。 */
  function makeClientDir(withTray: boolean): string {
    const dir = makeTempDir('frpc-start-');
    fs.writeFileSync(path.join(dir, 'frpc.exe'), '', 'utf8');
    fs.writeFileSync(path.join(dir, 'frpc.toml'), SAMPLE_TOML, 'utf8');
    if (withTray) {
      fs.writeFileSync(path.join(dir, 'start-tray.vbs'), 'rem tray\r\n', 'utf8');
    }
    return dir;
  }

  test('有托盘脚本：只经启动器拉起托盘，托盘带起 frpc 后不再重复拉 frpc，状态收敛为在线', async () => {
    const clientDir = makeClientDir(true);
    const launches: string[][] = [];
    const fakeLaunch: processModule.DetachedLauncher = async (command, args, cwd) => {
      launches.push([command, ...args, cwd]);
      writeFreshTrayStatus(clientDir, process.pid);
      return process.pid;
    };

    const runner = processModule.createDefaultRunner(makeTempDir('frpc-appdata-'), fakeLaunch);
    const state = await runner.control(clientDir, 'start');

    const startTrayVbs = path.join(clientDir, 'start-tray.vbs');
    expect(launches).toEqual([['wscript.exe', '//B', '//NoLogo', startTrayVbs, clientDir]]);
    expect(state.running).toBe(true);
    expect(state.connected).toBe(true);
    expect(state.trayRunning).toBe(true);
    expect(state.pid).toBe(process.pid);
  }, 20_000);

  test('没有托盘脚本：经启动器直接拉起 frpc.exe -c frpc.toml，状态收敛为在线', async () => {
    const clientDir = makeClientDir(false);
    const launches: string[][] = [];
    const fakeLaunch: processModule.DetachedLauncher = async (command, args, cwd) => {
      launches.push([command, ...args, cwd]);
      writeFreshTrayStatus(clientDir, 0);
      return process.pid;
    };

    const runner = processModule.createDefaultRunner(makeTempDir('frpc-appdata-'), fakeLaunch);
    const state = await runner.control(clientDir, 'start');

    const frpcExe = path.join(clientDir, 'frpc.exe');
    const frpcToml = path.join(clientDir, 'frpc.toml');
    expect(launches).toEqual([[frpcExe, '-c', frpcToml, clientDir]]);
    expect(state.running).toBe(true);
    expect(state.connected).toBe(true);
  }, 20_000);

  test('WMI 启动参数：命令行给带空格的路径加引号，脚本只经环境变量取命令行和目录，Windows 上语法可解析', () => {
    const exe = path.join('frp clients', 'frpc.exe');
    const toml = path.join('frp clients', 'frpc.toml');
    const line = processModule.buildWindowsCommandLine(exe, ['-c', toml]);
    expect(line).toBe(`"${exe}" -c "${toml}"`);
    expect(processModule.buildWindowsCommandLine('wscript.exe', ['//B', '//NoLogo'])).toBe('wscript.exe //B //NoLogo');

    const script = processModule.WMI_LAUNCH_SCRIPT;
    expect(script).toContain("[wmiclass]'Win32_Process'");
    expect(script).toContain('$startup.ShowWindow = 0');
    expect(script).toContain('$env:FRPC_LAUNCH_CMD');
    expect(script).toContain('$env:FRPC_LAUNCH_CWD');
    if (process.platform !== 'win32') return;

    // Windows 上只做 PowerShell AST 语法解析，不真的拉起任何进程
    const parseCmd = [
      '$tokens = $null; $errors = $null',
      '[void][System.Management.Automation.Language.Parser]::ParseInput($env:WMI_SCRIPT, [ref]$tokens, [ref]$errors)',
      'if ($errors.Count -gt 0) { Write-Error ($errors | Out-String); exit 1 }',
      'Write-Output "PS_AST_OK"',
    ].join('; ');
    const proc = childProcess.spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', parseCmd],
      {
        windowsHide: true,
        env: { ...process.env, WMI_SCRIPT: script },
        encoding: 'utf8',
      },
    );
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('PS_AST_OK');
  });
});


describe('frpc HTTP 路由契约、403 鉴权、30086 防绕过拦截与日志脱敏', () => {
  async function createHarness() {
    const rootDir = makeTempDir('frpc-root-');
    const clientDir = makeTempDir('frpc-dir-');
    const appdataDir = makeTempDir('frpc-startup-');
    fs.writeFileSync(path.join(clientDir, 'frpc.toml'), SAMPLE_TOML, 'utf8');
    fs.writeFileSync(path.join(clientDir, 'start-tray.vbs'), 'rem tray\r\n', 'utf8');

    let verified = true;
    const actions: string[] = [];
    let liveState: processModule.LiveFrpcState = {
      running: true,
      connected: true,
      pid: 49540,
      trayRunning: true,
      trayPid: 43760,
      detail: '在线',
      updatedAt: '2026-11-21 12:40:00',
    };

    const defaultAutoRunner = processModule.createDefaultRunner(appdataDir);
    const mockRunner: processModule.FrpcRunner = {
      async readLiveState() {
        return { ...liveState };
      },
      async control(_dir, action) {
        actions.push(action);
        if (action === 'stop') {
          liveState = { ...liveState, running: false, connected: false, pid: 0, detail: '已停止' };
          return { ...liveState };
        }
        liveState = { ...liveState, running: true, connected: true, pid: 51234, detail: '在线' };
        return { ...liveState };
      },
      readAutoStart: () => defaultAutoRunner.readAutoStart(),
      writeAutoStart: (dir, enabled) => defaultAutoRunner.writeAutoStart(dir, enabled),
    };

    const app = fastify.default({ logger: false });
    registerHttpErrorHandler(app);
    const fakeCtx = {
      resources: { root: rootDir, raw: { server: { port: 30099 } } },
      http: {
        app,
        port: 30099,
        isVerified: () => verified,
        requireVerified: (_req: unknown, what: string) => {
          if (verified) return;

          throw new failureModule.Failure(403, `${what}需要先完成身份核验`);
        },
      },
    } as unknown as cordis.Context;

    frpcPlugin.apply(fakeCtx, { dir: clientDir }, mockRunner);
    await app.ready();

    return {
      app,
      clientDir,
      actions,
      setVerified(v: boolean) {
        verified = v;
      },
    };
  }

  test('GET /api/frpc/status 返回完整契约且绝不泄漏 auth.token', async () => {
    const h = await createHarness();
    try {
      const res = await h.app.inject({ method: 'GET', url: '/api/frpc/status' });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(SAMPLE_SECRET);

      const data = res.json<frpcPlugin.FrpcStatus>();
      expect(data.configured).toBe(true);
      expect(data.running).toBe(true);
      expect(data.connected).toBe(true);
      expect(data.pid).toBe(49540);
      expect(data.trayRunning).toBe(true);
      expect(data.trayPid).toBe(43760);
      expect(data.hasAuthToken).toBe(true);
      expect(data.tlsEnabled).toBe(true);
      expect(data.publicUrls).toContain('https://app.xuanguiyl.top/work-decision/');
      expect(data.publicUrls).toContain('https://app.xuanguiyl.top/knowledge/');
      expect(data.publicUrls).toContain('https://app.xuanguiyl.top/tutorial/');
      expect(data.publicUrls).toContain('https://app.xuanguiyl.top/wechat-kefu/');
      expect(data.publicUrls).toContain('https://app.xuanguiyl.top/graph/');
      expect(data.publicUrls).toContain('https://app.xuanguiyl.top/memory/');
      expect(data.publicUrls).toContain('https://app.xuanguiyl.top/frpc/');
      expect(data.publicUrls).toContain('https://app.xuanguiyl.top/');
      expect(data.warnings).toEqual([]);
    } finally {
      await h.app.close();
    }
  });

  test('GET /api/frpc/status 对手改 frpc.toml 接回环的隧道带告警（PUT 校验拦不到的那条路）', async () => {
    const h = await createHarness();
    try {
      //M 绕开 PUT，直接手改 frpc.toml：一条写明回环地址，一条干脆不写 localIP（frpc 默认回环）。
      const handEdited = [
        SAMPLE_TOML,
        '[[proxies]]',
        'name = "hand-loop"',
        'type = "http"',
        'localIP = "127.0.0.1"',
        'localPort = 30099',
        '',
        '[[proxies]]',
        'name = "hand-no-ip"',
        'type = "http"',
        'localPort = 30086',
        '',
      ].join('\r\n');
      fs.writeFileSync(path.join(h.clientDir, 'frpc.toml'), handEdited, 'utf8');

      const res = await h.app.inject({ method: 'GET', url: '/api/frpc/status' });
      expect(res.statusCode).toBe(200);
      const data = res.json<frpcPlugin.FrpcStatus>();
      expect(data.warnings).toHaveLength(2);
      expect(data.warnings[0]).toContain('hand-loop');
      expect(data.warnings[1]).toContain('hand-no-ip');
      expect(res.body).not.toContain(SAMPLE_SECRET);
    } finally {
      await h.app.close();
    }
  });

  test('所有 POST/PUT 写路由在未核验请求下统一返回 403，核验后正常返回 200', async () => {
    const h = await createHarness();
    try {
      h.setVerified(false);

      const r1 = await h.app.inject({
        method: 'POST',
        url: '/api/frpc/control',
        payload: { action: 'restart' },
      });
      expect(r1.statusCode).toBe(403);

      const r2 = await h.app.inject({
        method: 'POST',
        url: '/api/frpc/autostart',
        payload: { enabled: true },
      });
      expect(r2.statusCode).toBe(403);

      const r3 = await h.app.inject({
        method: 'PUT',
        url: '/api/frpc/proxies',
        payload: { proxies: [] },
      });
      expect(r3.statusCode).toBe(403);

      // 恢复核验后正常执行控制与开机自启
      h.setVerified(true);
      const okAuto = await h.app.inject({
        method: 'POST',
        url: '/api/frpc/autostart',
        payload: { enabled: true },
      });
      expect(okAuto.statusCode).toBe(200);
      expect(okAuto.json<{ ok: boolean; autoStart: boolean }>()).toEqual({ ok: true, autoStart: true });

      const okStop = await h.app.inject({
        method: 'POST',
        url: '/api/frpc/control',
        payload: { action: 'stop' },
      });
      expect(okStop.statusCode).toBe(200);
      expect(okStop.json<{ ok: boolean; status: frpcPlugin.FrpcStatus }>().status.running).toBe(false);
    } finally {
      await h.app.close();
    }
  });

  test('PUT /api/frpc/proxies 严格白名单拦截全部回环绕过变体与高级字段覆盖风险', async () => {
    const h = await createHarness();
    try {
      const bypassAttempts = [
        '127.0.0.1',
        '127.0.0.2',
        '0.0.0.0',
        '0.1.2.3',
        'localhost',
        'localhost.',
        'foo.localhost',
        'ip6-localhost',
        '::1',
        '::',
        '[::]',
        '::ffff:127.0.0.1',
        '0:0:0:0:0:0:0:1',
        '0x7f.0.0.1',
        '0177.0.0.1',
        '2130706433',
      ];
      for (const badIp of bypassAttempts) {
        const badRes = await h.app.inject({
          method: 'PUT',
          url: '/api/frpc/proxies',
          payload: {
            proxies: [
              {
                name: 'jmbots-web',
                type: 'http',
                localIP: badIp,
                localPort: 30086,
                customDomains: ['app.xuanguiyl.top'],
              },
            ],
          },
        });
        expect(badRes.statusCode).toBe(400);
        expect(badRes.json<{ error: string }>().error).toBe(tomlModule.LOOPBACK_30086_ERROR);
      }

      // 同时保护注入的 server.port（如 30099）
      const customPortBad = await h.app.inject({
        method: 'PUT',
        url: '/api/frpc/proxies',
        payload: {
          proxies: [
            {
              name: 'jmbots-alt',
              type: 'http',
              localIP: '127.0.0.1',
              localPort: 30099,
              customDomains: ['app.xuanguiyl.top'],
            },
          ],
        },
      });
      expect(customPortBad.statusCode).toBe(400);

      const goodRes = await h.app.inject({
        method: 'PUT',
        url: '/api/frpc/proxies',
        payload: {
          restart: true,
          proxies: [
            {
              name: 'jmbots-web',
              type: 'http',
              localIP: '192.168.200.1',
              localPort: 30086,
              customDomains: ['app.xuanguiyl.top'],
            },
            {
              name: 'rdp-tunnel',
              type: 'tcp',
              localIP: '127.0.0.1',
              localPort: 3389,
              remotePort: 13389,
            },
          ],
        },
      });
      expect(goodRes.statusCode).toBe(200);
      expect(goodRes.body).not.toContain(SAMPLE_SECRET);
      expect(h.actions).toContain('restart');

      // 检查备份与回写后的磁盘文件均完整保留 token
      const bakToml = fs.readFileSync(path.join(h.clientDir, 'frpc.toml.bak'), 'utf8');
      const savedToml = fs.readFileSync(path.join(h.clientDir, 'frpc.toml'), 'utf8');
      expect(bakToml).toBe(SAMPLE_TOML);
      expect(savedToml).toContain(`auth.token = "${SAMPLE_SECRET}"`);
      expect(savedToml).toContain('name = "rdp-tunnel"');
      expect(savedToml).toContain('remotePort = 13389');

      // 若磁盘 frpc.toml 含高级字段/子表/跨行数组，PUT 必须返回 409 拒绝静默覆盖
      const advancedSamples = [
        `${SAMPLE_TOML}\r\ntransport.useEncryption = true\r\n`,
        `${SAMPLE_TOML}\r\nhttpUser = "admin"\r\n`,
        `${SAMPLE_TOML}\r\n[proxies.transport]\r\nuseCompression = true\r\n`,
        `${SAMPLE_TOML.replace('customDomains = ["app.xuanguiyl.top"]', 'customDomains = [\r\n  "app.xuanguiyl.top"\r\n]')}`,
      ];
      for (const advToml of advancedSamples) {
        fs.writeFileSync(path.join(h.clientDir, 'frpc.toml'), advToml, 'utf8');
        const conflictRes = await h.app.inject({
          method: 'PUT',
          url: '/api/frpc/proxies',
          payload: {
            proxies: [
              {
                name: 'jmbots-web',
                type: 'http',
                localIP: '192.168.200.1',
                localPort: 30086,
                customDomains: ['app.xuanguiyl.top'],
              },
            ],
          },
        });
        expect(conflictRes.statusCode).toBe(409);
        expect(conflictRes.json<{ error: string }>().error).toBe(tomlModule.UNSUPPORTED_TOML_ERROR);
        expect(fs.readFileSync(path.join(h.clientDir, 'frpc.toml'), 'utf8')).toBe(advToml);
      }
    } finally {
      await h.app.close();
    }
  });

  test('GET /api/frpc/logs 兼容 JSON 引号键与 authToken 脱敏，且无连接关键字日志默认判未知', async () => {
    const h = await createHarness();
    try {
      // 无连接成功关键字时 inspectLogConnection 不盲目判在线
      fs.writeFileSync(path.join(h.clientDir, 'frpc.log'), '2026-11-21 12:00:00 [I] booting...\r\n', 'utf8');
      expect(processModule.inspectLogConnection(h.clientDir)).toEqual({ connected: false, detail: '未知' });

      const logLines = [
        `2026-11-21 12:00:02 [W] auth.token = "${SAMPLE_SECRET}"`,
        '2026-11-21 12:00:03 [I] json={"token":"json_tok_999","password":\'single_pw_888\'} authToken=camel_777',
        '2026-11-21 12:00:04 [I] header Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 credential: cred_666',
        '2026-11-21 12:00:05 [I] [jmbots-web] start proxy success',
      ];
      fs.writeFileSync(path.join(h.clientDir, 'frpc.log'), `\uFEFF${logLines.join('\r\n')}\r\n`, 'utf8');

      const res = await h.app.inject({ method: 'GET', url: '/api/frpc/logs?lines=4' });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(SAMPLE_SECRET);
      expect(res.body).not.toContain('json_tok_999');
      expect(res.body).not.toContain('single_pw_888');
      expect(res.body).not.toContain('camel_777');
      expect(res.body).not.toContain('cred_666');
      expect(res.body).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');

      const payload = res.json<{ ok: boolean; lines: string[]; totalBytes: number }>();
      expect(payload.ok).toBe(true);
      expect(payload.lines.length).toBe(4);
      expect(payload.totalBytes).toBeGreaterThan(0);
      expect(payload.lines[3]).toContain('start proxy success');
    } finally {
      await h.app.close();
    }
  });

  test('resolveFrpcDir 默认定位客户端目录，且 Windows 托盘脚本通过 PowerShell AST 语法校验', () => {
    const simulatedRuntimeRoot = path.resolve(import.meta.dirname, '..', '..', '..', 'jmbotsData');
    const resolvedDir = frpcPlugin.resolveFrpcDir(simulatedRuntimeRoot);
    expect(resolvedDir.endsWith(path.join('works', 'frp-clients', 'windows'))).toBe(true);

    const trayPs1 = path.join(resolvedDir, 'frpc-tray.ps1');
    if (process.platform !== 'win32' || !fs.existsSync(trayPs1)) return;

    const rawBytes = fs.readFileSync(trayPs1);
    expect(rawBytes[0]).toBe(0xef);
    expect(rawBytes[1]).toBe(0xbb);
    expect(rawBytes[2]).toBe(0xbf);

    const trayText = rawBytes.toString('utf8');
    expect(trayText).toContain('打开外网隧道控制台 (Web)');
    expect(trayText).toContain('打开工作决策台（外网）');
    expect(trayText).toContain('http://127.0.0.1:30086/frpc/');
    expect(trayText).toContain('Add_MouseDoubleClick');

    const parseCmd = [
      '$tokens = $null; $errors = $null',
      '[void][System.Management.Automation.Language.Parser]::ParseFile($env:TRAY_PS1_PATH, [ref]$tokens, [ref]$errors)',
      'if ($errors.Count -gt 0) { Write-Error ($errors | Out-String); exit 1 }',
      'Write-Output "PS_AST_OK"',
    ].join('; ');
    const proc = childProcess.spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', parseCmd],
      {
        windowsHide: true,
        env: { ...process.env, TRAY_PS1_PATH: trayPs1 },
        encoding: 'utf8',
      },
    );
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('PS_AST_OK');
  });
});
