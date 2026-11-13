/** 窗口操控页的请求与预览生命周期；所有桌面能力都交给同源后端。 */
import * as api from '../Api.ts';

/** 本机窗口身份；回传完整对象，不能只凭会被复用的句柄操作。 */
export interface Target {
  /** 十六进制窗口句柄。 */
  handle: string;
  /** 所属进程。 */
  pid: number;
  /** 窗口类。 */
  className: string;
  /** 显示标题。 */
  title: string;
  /** 顶层窗口句柄。 */
  rootHandle: string;
  /** 进程启动标识，防止 PID 复用。 */
  processStartedAt: string;
  /** 屏幕物理像素边界，仅用于展示，不作为滚动坐标。 */
  rect: { x: number; y: number; width: number; height: number };
}

/** 客户区归一化位置；与屏幕坐标无关。 */
export interface Point {
  /** 横向比例，0 到 1。 */
  x: number;
  /** 纵向比例，0 到 1。 */
  y: number;
}

/** 框选区域，以原始预览图的比例存储。 */
export interface Region extends Point {
  /** 宽度比例。 */
  width: number;
  /** 高度比例。 */
  height: number;
}

/** 窗口选择/检查结果。 */
interface Selection {
  /** 成功标志。 */
  ok: boolean;
  /** 本次选中的窗口。 */
  target: Target;
  /** 顶层窗口，可选兼容早期插件。 */
  root?: Target;
  /** 可供切换的子窗口。 */
  children: Target[];
}

/** 一帧预览及其实际来源。 */
export interface Frame {
  /** 成功标志。 */
  ok: boolean;
  /** 此帧窗口身份。 */
  target: Target;
  /** 内存 PNG，不写入用户磁盘。 */
  image: string;
  /** 客户区图像宽度。 */
  width: number;
  /** 客户区图像高度。 */
  height: number;
  /** 捕获时间。 */
  capturedAt: string;
  /** 捕获方式。 */
  captureMode?: string;
  /** 遮挡、硬件加速等捕获限制。 */
  warning?: string;
}

/** 供 React 订阅的不可变快照。 */
export interface State {
  /** null 表示正在检测安装状态。 */
  available: boolean | null;
  /** 不可用原因。 */
  reason: string;
  /** 当前窗口。 */
  target: Target | null;
  /** 已发现的窗口，包括顶层窗口及子窗口。 */
  targets: Target[];
  /** 当前图像；出错或切换目标时清除。 */
  frame: Frame | null;
  /** 是否持续预览。 */
  preview: boolean;
  /** 正在进行的操作。 */
  busy: 'pick' | 'inspect' | 'scroll' | null;
  /** 真实错误。 */
  error: string;
  /** 最近操作的结果。 */
  notice: string;
  /** 区域中心或点击位置，用于定向滚动。 */
  point: Point;
  /** 可选框选区域。 */
  region: Region | null;
}

/** 将图片上的指针位置转为客户区比例；矩形必须是图片自身而非外层留白。 */
export class Geometry {
  /** 从显示图像位置计算比例，边界以外夹回图像边界。 */
  static point(clientX: number, clientY: number, rect: DOMRect): Point {
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  }

  /** 反向拖动也使用左上角加宽高表示。 */
  static region(start: Point, end: Point): Region {
    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(start.x - end.x),
      height: Math.abs(start.y - end.y),
    };
  }
}

/** 请求、目标身份和串行截图由同一个对象管理，避免旧帧覆盖新目标。 */
export class DesktopSession {
  private state: State = {
    available: null, reason: '', target: null, targets: [], frame: null,
    preview: false, busy: null, error: '', notice: '',
    point: { x: 0.5, y: 0.5 }, region: null,
  };

  /** React 订阅者；仅通知当前快照变化。 */
  private readonly listeners = new Set<() => void>();
  /** 目标变化或离开页面时增长，所有旧请求结果随之失效。 */
  private generation = 0;
  /** 页签当前是否仍挂载。 */
  private mounted = false;
  /** 下一帧的定时器，上一帧结束后才安排。 */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 当前请求，可在页面卸载或目标切换时停止等待。 */
  private readonly requests = new Set<AbortController>();

  /** React 获取稳定快照。 */
  readonly snapshot = (): State => this.state;

  /** 注册视图订阅；返回取消订阅函数。 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** 挂载时只检查能力是否已安装，不启动桌面应用。 */
  async initialize(): Promise<void> {
    this.mounted = true;
    const generation = this.generation;
    try {
      const result = await api.getJson<{ available: boolean; reason?: string }>('/api/desktop/status');
      if (!this.current(generation)) { return; }
      this.update({ available: result.available, reason: result.reason ?? '' });
    } catch (error) {
      if (!this.current(generation)) { return; }
      this.update({ available: false, reason: this.message(error) });
    }
  }

  /** 离开页面停止请求与轮询；不操作已选窗口。 */
  dispose(): void {
    this.mounted = false;
    this.invalidate();
    this.update({ preview: false, busy: null });
  }

  /** 按住定位点时启动系统拾取；松键由能力程序识别。 */
  async pick(): Promise<void> {
    if (this.state.busy || !this.state.available) { return; }
    this.invalidate();
    const generation = this.generation;
    this.update({ target: null, targets: [], preview: false, busy: 'pick', error: '',
      frame: null, region: null, notice: '保持左键按住，拖到目标窗口后松开；Esc 取消。' });
    try {
      const result = await this.request<Selection>({ op: 'pick' });
      if (!this.current(generation)) { return; }
      this.accept(result);
    } catch (error) {
      if (this.current(generation)) {
        this.update({ busy: null, error: this.message(error), notice: '' });
      }
    }
  }

  /** 在已发现的窗口间切换，先清掉旧图像和区域再核验身份。 */
  async select(handle: string): Promise<void> {
    const target = this.state.targets.find((item) => item.handle === handle);
    if (!target || this.state.busy) { return; }
    this.invalidate();
    const generation = this.generation;
    this.update({ target, frame: null, preview: false, busy: 'inspect', error: '', region: null });
    try {
      const result = await this.request<Selection>({ op: 'inspect', target });
      if (!this.current(generation)) { return; }
      this.accept(result);
    } catch (error) {
      if (this.current(generation)) {
        this.update({ busy: null, error: this.message(error) });
      }
    }
  }

  /** 清除选择且停止一切后续预览。 */
  clear(): void {
    this.invalidate();
    this.update({ target: null, targets: [], frame: null, preview: false, busy: null, region: null, error: '', notice: '' });
  }

  /** 暂停保留最后帧；恢复时立即获取一帧。 */
  preview(enabled: boolean): void {
    if (this.state.busy || !this.state.target) { return; }
    this.invalidate();
    this.update({ preview: enabled, error: '' });
    if (enabled) { void this.capture(this.generation); }
  }

  /** 保存点击位置；拖出可见区域时保存区域并将滚动点放在其中心。 */
  locate(start: Point, end: Point): void {
    const region = Geometry.region(start, end);
    const hasRegion = region.width > 0.01 && region.height > 0.01;
    const point = hasRegion
      ? { x: region.x + region.width / 2, y: region.y + region.height / 2 }
      : end;
    this.update({ region: hasRegion ? region : null, point });
  }

  /** 用户明确点击后向所选客户区发送滚轮，返回值不等于实际滚动已生效。 */
  async scroll(direction: 'up' | 'down', steps: number): Promise<void> {
    const target = this.state.target;
    if (!target || this.state.busy || !this.state.frame) { return; }
    const wasPreviewing = this.state.preview;
    this.invalidate();
    const generation = this.generation;
    const body = { op: 'scroll', target, direction, steps, ...this.state.point };
    this.update({ busy: 'scroll', error: '', preview: false });
    try {
      await this.request(body);
      if (!this.current(generation)) { return; }
      this.update({ busy: null, preview: wasPreviewing, notice: '滚动指令已发送，请观察画面确认目标是否实际滚动。' });
      await this.capture(generation);
    } catch (error) {
      if (this.current(generation)) {
        this.update({ busy: null, preview: false, frame: null, error: this.message(error) });
      }
    }
  }

  /** 合并顶层与子窗清单；以完整身份对象保留所有能力端字段。 */
  private accept(result: Selection): void {
    const targets = new Map(this.state.targets.map((target) => [target.handle, target]));
    for (const target of [result.root, result.target, ...result.children]) {
      if (target) { targets.set(target.handle, target); }
    }
    this.update({ target: result.target, targets: [...targets.values()], frame: null,
      preview: true, busy: null, point: { x: 0.5, y: 0.5 }, region: null,
      notice: '已选定窗口；在预览里点击滚动位置，或拖动框选区域。' });
    void this.capture(this.generation);
  }

  /** 串行捕获；失败立刻清除图像，避免旧图被误认成实时画面。 */
  private async capture(generation: number): Promise<void> {
    const target = this.state.target;
    if (!target || !this.current(generation)) { return; }
    try {
      const frame = await this.request<Frame>({ op: 'capture', target });
      if (!this.current(generation)) { return; }
      this.update({ frame, target: frame.target, error: '' });
      if (this.state.preview) {
        this.timer = setTimeout(() => { void this.capture(generation); }, 1000);
      }
    } catch (error) {
      if (this.current(generation)) {
        this.update({ frame: null, preview: false, error: this.message(error) });
      }
    }
  }

  /** 可取消的同源 JSON 请求；沿用 Api 的令牌和错误解释。 */
  private async request<T>(body: unknown): Promise<T> {
    const controller = new AbortController();
    this.requests.add(controller);
    const options = {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    };
    try {
      return await api.getJson<T>('/api/desktop/action', options);
    } finally {
      this.requests.delete(controller);
    }
  }

  /** 撤销旧请求、定时器及结果写回资格。 */
  private invalidate(): void {
    this.generation += 1;
    if (this.timer !== null) { clearTimeout(this.timer); }
    this.timer = null;
    for (const request of this.requests) { request.abort(); }
    this.requests.clear();
  }

  /** 只允许当前挂载页面的当前目标更新状态。 */
  private current(generation: number): boolean {
    return this.mounted && generation === this.generation;
  }

  /** 发布一份新快照。 */
  private update(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) { listener(); }
  }

  /** 保留后端错误说明。 */
  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
