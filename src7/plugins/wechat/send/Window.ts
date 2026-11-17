/**
 * 找微信窗口、后台截一张图、算出列表和标题区在哪：发送前交给 Python worker 的 frame。
 * 全靠 AOBW（本机 http://127.0.0.1:30010，Windows 上的大漠能力服务）：后台绑定 gdi2 + windows 消息，不切前台、不动真实键鼠。
 * 改写自 jimukefu src/services/WxLocate.ts:587-720、893-958（找字、字库那一大块不要了：定位交给 worker 里的 OCR）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';


/** 一个矩形。 */
export interface Rect { x1: number; y1: number; x2: number; y2: number }

/** 交给 worker 的一帧（worker 用到的字段见 jimukefu python/wxcontrol/controller.py:264-300、723-737）。 */
export interface Frame {
  hwnd: string;
  width: number;
  height: number;
  dpi: number;
  layout: { list: Rect; title: Rect; scale: number };
}


/** 微信主窗口的标题。 */
const MAIN_TITLES = new Set(['微信', 'Weixin', 'WeChat']);

/** 本插件在 AOBW 里用的大漠对象名：不和积木客服的 wxlocate、wxcontrol 共用。 */
const OBJECT = 'jmbots-wechat';


/** AOBW 的调用方。 */
export class Window {
  /**
   * @param url AOBW 地址。
   * @param lockFile 绑定锁：和积木客服用同一个文件，谁在操作微信窗口另一边就等着（jimukefu WxLocate.ts:640-668）。
   */
  constructor(readonly url: string, readonly lockFile: string) {}

  /**
   * 找到微信主窗口，后台绑定、截一张客户区、解绑，算出布局。
   * @throws 大漠没注册、找不到可见的主窗口、截图全黑、锁被别人占着时抛错。
   */
  async frame(): Promise<Frame> {
    const status = await this.request('/api/engine/status?engine=dm');
    if (status['registered'] !== true) throw new Error('AOBW 里大漠引擎还没注册');

    this.lock();
    let bound = false;
    try {
      const hwnd = await this.findWindow();
      if ((await this.call('BindWindow', [hwnd, 'gdi2', 'windows', 'windows', 0]))['result'] !== 1) throw new Error('后台绑定微信窗口失败');

      bound = true;
      const size = ((await this.call('GetClientSize', [hwnd]))['out'] ?? {}) as Record<string, unknown>;
      const width = Number(size['width']), height = Number(size['height']);
      const shot = ((await this.call('Capture', [0, 0, width - 1, height - 1, `jmbots_${String(Date.now())}.bmp`]))['capture'] ?? {}) as Record<string, unknown>;
      const response = await fetch(new URL(String(shot['preview_url']), `${this.url}/`).href);
      const image = parseBmp(new Uint8Array(await response.arrayBuffer()));
      if (isBlack(image)) throw new Error('后台截图是全黑的');

      const dpi = dpiOf(hwnd);
      return { hwnd, width, height, dpi, layout: detectLayout(image, dpi / 96) };
    } finally {
      if (bound) await this.call('UnBindWindow', []).catch(() => undefined);
      fs.rmSync(this.lockFile, { force: true });
    }
  }

  /** 占锁：别人的锁 4 分钟内动过就报错；更早的是崩掉留下的，清掉。 */
  private lock(): void {
    if (fs.existsSync(this.lockFile) && Date.now() - fs.statSync(this.lockFile).mtimeMs < 240_000) {
      throw new Error('另一个任务正在操作微信窗口（锁文件在），稍后再试');
    }
    fs.mkdirSync(path.dirname(this.lockFile), { recursive: true });
    fs.writeFileSync(this.lockFile, JSON.stringify({ owner: OBJECT, pid: process.pid, at: new Date().toISOString() }));
  }

  /** 按进程名列窗口，挑可见、没最小化、够大的；标题是“微信”的优先，再挑最大的。 */
  private async findWindow(): Promise<string> {
    const raw = String((await this.call('EnumWindowByProcess', ['Weixin.exe', '', '', 0]))['result'] ?? '');
    const found: { handle: string; area: number; main: boolean }[] = [];
    for (const id of raw.split(/[,;|\s]+/u).filter((x) => /^\d+$/u.test(x) && x !== '0')) {
      const handle = `0x${BigInt(id).toString(16)}`;
      if (!String((await this.call('GetWindowClass', [handle]))['result'] ?? '').startsWith('Qt')) continue;
      if ((await this.call('GetWindowState', [handle, 2]))['result'] !== 1) continue;
      if ((await this.call('GetWindowState', [handle, 3]))['result'] === 1) continue;

      const out = ((await this.call('GetClientSize', [handle]))['out'] ?? {}) as Record<string, unknown>;
      const area = Number(out['width']) * Number(out['height']);
      if (!(Number(out['width']) > 300 && Number(out['height']) > 300)) continue;

      const title = String((await this.call('GetWindowTitle', [handle]))['result'] ?? '').trim();
      found.push({ handle, area, main: MAIN_TITLES.has(title) });
    }
    const pool = found.some((f) => f.main) ? found.filter((f) => f.main) : found;
    pool.sort((a, b) => b.area - a.area);
    if (pool[0] === undefined) throw new Error('没有找到可见的微信主窗口（最小化时后台截图不可用）');

    return pool[0].handle;
  }

  /** 调一个大漠方法。 */
  private async call(name: string, args: unknown[]): Promise<Record<string, unknown>> {
    const payload = await this.request('/api/call?engine=dm', { name, args, object: OBJECT });
    if (payload['ok'] !== true) throw new Error(`AOBW 调用 ${name} 没成功`);

    return payload;
  }

  /** GET（没有 body）或 POST JSON。 */
  private async request(pathname: string, body?: unknown): Promise<Record<string, unknown>> {
    const init: RequestInit = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const response = await fetch(new URL(pathname, `${this.url}/`).href, { ...init, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`AOBW 返回 HTTP ${String(response.status)}`);

    return await response.json() as Record<string, unknown>;
  }
}


/** BMP 的宽高和取像素。 */
interface Image { width: number; height: number; pixel: (x: number, y: number) => [number, number, number] }

/** 读 24/32 位 BMP（jimukefu WxLocate.ts:840-857）。 */
export function parseBmp(bytes: Uint8Array): Image {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error('截图不是 BMP');

  const offset = v.getUint32(10, true), width = v.getInt32(18, true), raw = v.getInt32(22, true), step = v.getUint16(28, true) / 8;
  const height = Math.abs(raw), stride = Math.ceil((width * step) / 4) * 4;
  return {
    width, height,
    pixel: (x, y) => {
      const i = offset + (raw > 0 ? height - 1 - y : y) * stride + x * step;
      return [bytes[i + 2] ?? 0, bytes[i + 1] ?? 0, bytes[i] ?? 0];
    },
  };
}

/** 隔 7 个像素抽查，全都接近黑就是黑图。 */
function isBlack(image: Image): boolean {
  for (let y = 0; y < image.height; y += 7) for (let x = 0; x < image.width; x += 7) {
    const [r, g, b] = image.pixel(x, y);
    if (r + g + b > 30) return false;
  }
  return true;
}

/** 两个颜色差多少（各通道最大差）。 */
function distance(a: number[], b: number[]): number {
  return Math.max(Math.abs((a[0] ?? 0) - (b[0] ?? 0)), Math.abs((a[1] ?? 0) - (b[1] ?? 0)), Math.abs((a[2] ?? 0) - (b[2] ?? 0)));
}

/**
 * 算布局：左边导航栏右沿、会话列表右沿（几条水平线投票），再推出列表区和标题区（jimukefu WxLocate.ts:893-921）。
 * @param scale DPI / 96。
 */
export function detectLayout(image: Image, scale: number): Frame['layout'] {
  const { width, height } = image;
  const midY = Math.round(height * 0.55);
  const navBg = image.pixel(2, midY);
  let navRight = Math.round(58 * scale);
  for (let x = 1; x < width / 3; x += 1) {
    if (distance(image.pixel(x, midY), navBg) > 6) { navRight = x; break; }
  }

  const votes = new Map<number, number>();
  for (const fy of [0.55, 0.7, 0.85, 0.95]) {
    const y = Math.min(height - 1, Math.round(height * fy));
    const bg = image.pixel(navRight + 6, y);
    for (let x = navRight + Math.round(150 * scale); x < width - 20; x += 1) {
      const c = image.pixel(x, y);
      if (distance(c, bg) <= 10) continue;

      let uniform = true;
      for (let k = 1; k <= 6; k += 1) if (distance(image.pixel(x + k, y), c) > 3) { uniform = false; break; }
      if (uniform) { votes.set(x, (votes.get(x) ?? 0) + 1); break; }
    }
  }
  let listRight = Math.round(420 * scale), best = 0;
  for (const [x, n] of votes) if (n > best || (n === best && x < listRight)) { best = n; listRight = x; }

  return {
    list: { x1: navRight, y1: Math.round(70 * scale), x2: listRight, y2: height - Math.round(45 * scale) },
    title: { x1: listRight + Math.round(10 * scale), y1: Math.round(30 * scale), x2: Math.max(listRight + 50, width - Math.round(150 * scale)), y2: Math.round(72 * scale) },
    scale,
  };
}

/** 窗口的 DPI：Windows 上问 user32 的 GetDpiForWindow，别的系统（离线测试）当 96。 */
function dpiOf(hwnd: string): number {
  if (process.platform !== 'win32') return 96;

  const lib = dlopen('user32.dll', { GetDpiForWindow: { args: [FFIType.u64], returns: FFIType.u32 } });
  const dpi = lib.symbols.GetDpiForWindow(BigInt(hwnd));
  lib.close();
  return dpi > 0 ? dpi : 96;
}
