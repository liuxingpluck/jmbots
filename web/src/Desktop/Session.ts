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
  /**
   * 从显示图像位置计算比例，边界以外夹回图像边界；无副作用。
   * @param clientX 鼠标或指针在视口中的横坐标。
   * @param clientY 鼠标或指针在视口中的纵坐标。
   * @param rect 预览图片元素自身的矩形边界。
   * @returns 归一化客户区坐标（0～1）。
   */
  static point(clientX: number, clientY: number, rect: DOMRect): Point {
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  }

  /**
   * 反向拖动也使用左上角加宽高表示；无副作用。
   * @param start 拖拽起点比例坐标。
   * @param end 拖拽终点比例坐标。
   * @returns 以左上角坐标和宽高比例表示的归一化矩形。
   */
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
  /** 当前桌面会话状态的最新不可变快照，由 update 替换并通知订阅者。 */
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

  /**
   * React 获取稳定快照；无副作用。
   * @returns 当前只读状态快照。
   */
  readonly snapshot = (): State => this.state;

  /**
   * 注册视图订阅；返回取消订阅函数。
   * @param listener 状态变更回调。
   * @returns 用于取消本次订阅的清理函数。
   * 副作用：向 listeners 集合增删回调引用。
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    //M 登记 React 订阅回调并返回注销函数，确保状态快照每次替换都能驱动界面刷新且卸载时不泄漏。
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /**
   * 挂载时只检查能力是否已安装，不启动桌面应用。
   * 副作用：标记已挂载、请求 /api/desktop/status 并更新状态快照。
   */
  async initialize(): Promise<void> {
    this.mounted = true;
    const generation = this.generation;
    try {
      //M 探查后端桌面窗口能力是否可用，确认操作代次未失效后将可用性与原因写入快照。
      const result = await api.getJson<{ available: boolean; reason?: string }>('/api/desktop/status');
      //G 异步请求期间若页面已卸载或开启新操作代次，直接丢弃过期响应。
      if (!this.current(generation)) { return; }
      this.update({ available: result.available, reason: result.reason ?? '' });
    } catch (error) {
      //G 状态探查失败时仅在当前代次仍有效时展示不可用原因。
      if (!this.current(generation)) { return; }
      this.update({ available: false, reason: this.message(error) });
    }
  }

  /**
   * 离开页面停止请求与轮询；不操作已选窗口。
   * 副作用：标记卸载、递增代次并中止全部在途请求、清除定时器并复位预览和忙碌标志。
   */
  dispose(): void {
    this.mounted = false;
    //M 离开页面时先作废所有在途请求和抓帧定时器，再复位预览与忙碌态防止残留回调回写状态。
    this.invalidate();
    this.update({ preview: false, busy: null });
  }

  /**
   * 按住定位点时启动系统拾取；松键由能力程序识别。
   * 副作用：作废旧请求与轮询、发起 op=pick 桌面请求并在成功后接管选中窗口与开启实时预览。
   */
  async pick(): Promise<void> {
    if (this.state.busy || !this.state.available) { return; }
    //M 开始新一轮跨窗口拾取前作废旧请求和抓帧定时器，清空旧窗口与画面并提示拖动松开操作。
    this.invalidate();
    const generation = this.generation;
    this.update({ target: null, targets: [], preview: false, busy: 'pick', error: '',
      frame: null, region: null, notice: '保持左键按住，拖到目标窗口后松开；Esc 取消。' });
    try {
      //M 请求后端启动桌面拾取并在当前代次有效时接管选中的目标窗口及子窗清单。
      const result = await this.request<Selection>({ op: 'pick' });
      if (!this.current(generation)) { return; }
      this.accept(result);
    } catch (error) {
      //G 拾取报错且代次仍有效时解除忙碌态并回显错误，被主动取消的旧请求静默忽略。
      if (this.current(generation)) {
        this.update({ busy: null, error: this.message(error), notice: '' });
      }
    }
  }

  /**
   * 在已发现的窗口间切换，先清掉旧图像和区域再核验身份。
   * @param handle 要切换到的目标窗口十六进制句柄。
   * 副作用：作废旧轮询、清空旧帧与框选、发起 op=inspect 请求并开启新窗口预览。
   */
  async select(handle: string): Promise<void> {
    const target = this.state.targets.find((item) => item.handle === handle);
    if (!target || this.state.busy) { return; }
    //M 切换窗口前先停止旧轮询并清空旧帧与框选，避免新旧窗口画面混看。
    this.invalidate();
    const generation = this.generation;
    this.update({ target, frame: null, preview: false, busy: 'inspect', error: '', region: null });
    try {
      //M 请求后端核验目标窗口身份和最新子窗清单，确认代次有效后接管并开始抓帧。
      const result = await this.request<Selection>({ op: 'inspect', target });
      if (!this.current(generation)) { return; }
      this.accept(result);
    } catch (error) {
      //G 核验失败且代次未作废时解除忙碌态并回显错误提示。
      if (this.current(generation)) {
        this.update({ busy: null, error: this.message(error) });
      }
    }
  }

  /**
   * 清除选择且停止一切后续预览。
   * 副作用：作废在途请求与抓帧定时器，清空已选目标、预览画面、框选和提示。
   */
  clear(): void {
    //M 撤销进行中的请求与定时器，把窗口、画面、框选和提示全部恢复为初始空态。
    this.invalidate();
    this.update({ target: null, targets: [], frame: null, preview: false, busy: null, region: null, error: '', notice: '' });
  }

  /**
   * 暂停保留最后帧；恢复时立即获取一帧。
   * @param enabled true 恢复持续抓帧，false 暂停轮询。
   * 副作用：停掉旧定时器、更新 preview 标志，并在开启时立刻触发一次抓帧。
   */
  preview(enabled: boolean): void {
    if (this.state.busy || !this.state.target) { return; }
    //M 先停掉已有轮询再更新开关；恢复预览时立即抓一帧，暂停时保留最后一帧画面。
    this.invalidate();
    this.update({ preview: enabled, error: '' });
    if (enabled) { void this.capture(this.generation); }
  }

  /**
   * 保存点击位置；拖出可见区域时保存区域并将滚动点放在其中心。
   * @param start 鼠标按下时的归一化起点。
   * @param end 鼠标松开时的归一化终点。
   * 副作用：更新 state 中的 region 与 point 并通知视图重绘。
   */
  locate(start: Point, end: Point): void {
    //M 计算起止点构成的规范矩形；宽高超过最小阈值视为框选并取中心作滚动点，否则作为单点定位清除框选。
    const region = Geometry.region(start, end);
    const hasRegion = region.width > 0.01 && region.height > 0.01;
    let point = end;
    let nextRegion: Region | null = null;
    if (hasRegion) {
      point = { x: region.x + region.width / 2, y: region.y + region.height / 2 };
      nextRegion = region;
    }

    //M 将算出的框选区域与定向滚动点写入状态快照通知界面。
    this.update({ region: nextRegion, point });
  }

  /**
   * 用户明确点击后向所选客户区发送滚轮，返回值不等于实际滚动已生效。
   * @param direction 滚动方向（向上或向下）。
   * @param steps 滚动步数。
   * 副作用：暂停预览轮询、发起 op=scroll 请求，并在成功后补抓一帧核对画面。
   */
  async scroll(direction: 'up' | 'down', steps: number): Promise<void> {
    const target = this.state.target;
    if (!target || this.state.busy || !this.state.frame) { return; }
    const wasPreviewing = this.state.preview;
    //M 发送滚轮前暂停抓帧轮询避免与滚动并发干扰，并标记忙碌态防止重复提交。
    this.invalidate();
    const generation = this.generation;
    const body = { op: 'scroll', target, direction, steps, ...this.state.point };
    this.update({ busy: 'scroll', error: '', preview: false });
    try {
      //M 向客户区指定比例发送滚轮指令，有效期内恢复原预览状态并立即抓一帧供用户观察是否生效。
      await this.request(body);
      if (!this.current(generation)) { return; }
      this.update({ busy: null, preview: wasPreviewing, notice: '滚动指令已发送，请观察画面确认目标是否实际滚动。' });
      await this.capture(generation);
    } catch (error) {
      //G 滚动指令失败且仍在当前代次时清空旧画面并报错，防止误以为目标窗口已滚动。
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

    //M 保存去重后的窗口列表并将选中对象切换为新目标，同时清空旧帧并启动抓帧预览。
    this.update({ target: result.target, targets: [...targets.values()], frame: null,
      preview: true, busy: null, point: { x: 0.5, y: 0.5 }, region: null,
      notice: '已选定窗口；在预览里点击滚动位置，或拖动框选区域。' });
    void this.capture(this.generation);
  }

  /** 串行捕获；失败立刻清除图像，避免旧图被误认成实时画面。 */
  private async capture(generation: number): Promise<void> {
    const target = this.state.target;
    //G 抓帧前校验存在有效目标且仍在同一操作代次，防止切走目标后仍发旧抓帧请求。
    if (!target || !this.current(generation)) { return; }
    try {
      //M 向后端抓取一帧内存 PNG 并同步刷新窗口身份；若仍开着实时预览则在 1 秒后串行调度下一帧。
      const frame = await this.request<Frame>({ op: 'capture', target });
      if (!this.current(generation)) { return; }
      this.update({ frame, target: frame.target, error: '' });
      if (this.state.preview) {
        this.timer = setTimeout(() => { void this.capture(generation); }, 1000);
      }
    } catch (error) {
      //G 抓帧出错且仍在当前代次时立刻清除旧图并暂停预览，避免静态旧图被误认成实时画面。
      if (this.current(generation)) {
        this.update({ frame: null, preview: false, error: this.message(error) });
      }
    }
  }

  /** 可取消的同源 JSON 请求；沿用 Api 的令牌和错误解释。 */
  private async request<T>(body: unknown): Promise<T> {
    const controller = new AbortController();
    //M 登记本次请求的 AbortController，以便卸载或切换窗口时主动中止等待。
    this.requests.add(controller);
    const options = {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    };
    try {
      //M 通过同源桌面操作接口提交 JSON 指令并携带鉴权与取消信号。
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
    //M 全部在途请求中止后清空跟踪集合，配合代次自增确保旧异步回调不再写回状态。
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
    if (error instanceof Error) return error.message;

    return String(error);
  }
}
