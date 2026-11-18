/** screen v1 的配置和 HTTP 输入边界：校验原始数据，并准备私有模型请求。 */

export const VERSION = 1;
export const LEASE_MS = 10_000;
export const STATE_LIMIT = 16 * 1024;
export const CLICK_LIMIT = 512 * 1024;

const IMAGE_LIMIT = 256 * 1024;
const IMAGE_WIDTH = 1280;
const IMAGE_HEIGHT = 720;
const MIB = 1024 * 1024;
const PROCESSES = [
  'WeChat.exe', 'Weixin.exe', 'WeChatAppEx.exe', 'KeePass.exe', 'KeePassXC.exe',
  '1Password.exe', 'Bitwarden.exe',
];
const TITLES = ['微信', 'WeChat', 'Weixin', '密码', 'password', '验证码', 'verification code'];
const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const OMIT_REASONS = ['no_preclick_frame', 'stale_frame', 'too_large', 'not_needed'];

const ERRORS = {
  invalid_request: [400, '点击参数无效'],
  unsupported_version: [400, '不支持的录屏协议版本'],
  disabled: [403, '录屏讲解未开启'],
  inactive: [409, '录屏会话未激活'],
  stale_epoch: [409, '录屏会话已切换'],
  stale_click: [409, '点击已过期'],
  busy: [409, '正在处理点击'],
  cancelled: [409, '点击已取消'],
  payload_too_large: [413, '截图或请求超过大小上限'],
  privacy_blocked: [422, '当前内容受隐私保护'],
  no_evidence: [422, '缺少可以解释的控件或截图'],
  invalid_model_output: [422, '模型没有返回有效的讲解'],
  model_failed: [502, '模型讲解失败'],
  model_timeout: [504, '模型讲解超时'],
} as const;

export type ErrorCode = keyof typeof ERRORS;

/** 可回给 HTTP 的固定错误，不接收输入正文或供应商异常。 */
export class ScreenError extends Error {
  /** HTTP 状态码。 */
  readonly status: number;

  /** 按错误码构造固定消息，无副作用。 */
  constructor(readonly code: ErrorCode) {
    const [status, message] = ERRORS[code];
    super(message);
    this.status = status;
  }
}

/** 验证后留给后端使用的配置。 */
export interface ScreenConfig {
  /** 配置允许启用录屏讲解。 */
  enabled: boolean;
  /** 状态接口给基地的采集帧率。 */
  fps: number;
  /** 状态接口给基地的缓存秒数。 */
  bufferSeconds: number;
  /** 裁图的物理宽度。 */
  cropWidth: number;
  /** 裁图的物理高度。 */
  cropHeight: number;
  /** 上传 JPEG 编码宽度上限。 */
  frameWidth: number;
  /** 上传 JPEG 编码高度上限。 */
  frameHeight: number;
  /** JPEG 解码前字节上限。 */
  imageMaxBytes: number;
  /** 允许的点击前帧龄。 */
  maxFrameAgeMs: number;
  /** 显式配置的多模态模型。 */
  model: string;
  /** 模型请求的思考档。 */
  thinking: 'off' | 'low';
  /** 一次模型请求的最长等待。 */
  timeoutMs: number;
  /** 一次模型回答的 token 上限。 */
  maxTokens: number;
  /** 建议基地展示的时间。 */
  displayForMs: number;
  /** 配置允许语音播报。 */
  speak: boolean;
  /** 归一为小写的禁止进程名。 */
  processes: Set<string>;
  /** 归一为小写的禁止标题片段。 */
  titles: string[];
}

/** 与基地内存状态对应的身份字段。 */
export interface Identity {
  /** 基地进程实例。 */
  clientId: string;
  /** 用户本次启用产生的会话。 */
  sessionId: string;
  /** 同一客户端内递增的代号。 */
  epoch: number;
}

/** 状态动作。 */
type StateReason = 'user_start' | 'heartbeat' | 'privacy_pause' | 'user_stop' | 'resume';

/** 已验证的控制输入。 */
export interface StateInput extends Identity {
  /** 控制动作之后期望的激活状态。 */
  active: boolean;
  /** 状态动作。 */
  reasonCode: StateReason;
}

/** 点击回执共用的身份。 */
export interface ClickIdentity extends Identity {
  /** 基地生成的点击编号。 */
  clickId: string;
  /** 点击顺序。 */
  seq: number;
}

export type PresentedInput = Omit<ClickIdentity, 'seq'>;

/** 已验证的点击和仅用于本次模型调用的输入。 */
export interface ClickInput extends ClickIdentity {
  /** 用于窗口变化时清缓存，不含标题或控件。 */
  windowKey: string;
  /** 净化后的模型上下文。 */
  contextText: string;
  /** 经验证的临时 JPEG base64。 */
  image: string | null;
}

interface Point {
  /** 物理像素横坐标。 */
  x: number;
  /** 物理像素纵坐标。 */
  y: number;
}

interface Rect extends Point {
  /** 物理像素宽度。 */
  width: number;
  /** 物理像素高度。 */
  height: number;
}

/** 读取 JSON 对象，拒绝空值、数组和基本类型。 */
export function getRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  //G 对象形状错误才统一报给调用方，避免暴露原始值。
  throw new ScreenError('invalid_request');
}

/** 读取有限范围内的数字，默认要求安全整数。 */
function getNumber(value: unknown, min: number, max: number, integer = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    //G 拒绝非数字和越界值，后续计算可直接使用。
    throw new ScreenError('invalid_request');
  }
  if (integer && !Number.isSafeInteger(value)) {
    //G 序号、尺寸和时间戳等字段要求安全整数。
    throw new ScreenError('invalid_request');
  }
  return value;
}

/** 读取有限长度的文字并保留原文以核对黑名单。 */
function getText(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max * 2
    || [...value].length > max || (!allowEmpty && !value.trim())) {
    //G 限制外部文字大小，避免模型收到超长元数据。
    throw new ScreenError('invalid_request');
  }
  return value;
}

/** 读取可安全回显的 GUID 形式标识。 */
export function getId(value: unknown): string {
  if (typeof value === 'string' && ID.test(value)) return value;

  //G 只有范围内的安全标识可回显给调用方。
  throw new ScreenError('invalid_request');
}

/** 只接受 v1，区分缺字段和不支持的版本。 */
function checkVersion(value: unknown): void {
  if (value === VERSION) return;

  if (value === undefined) {
    //G 缺协议字段属于请求不完整。
    throw new ScreenError('invalid_request');
  }

  //G 已提供的未知版本单独报错，供基地识别协议不匹配。
  throw new ScreenError('unsupported_version');
}

/** 提取客户端、会话和 epoch 供租约与回执使用。 */
function getIdentity(body: Record<string, unknown>): Identity {
  //G 三个身份字段都合法才进入租约处理。
  const clientId = getId(body['clientId']);
  const sessionId = getId(body['sessionId']);
  const epoch = getNumber(body['epoch'], 1, Number.MAX_SAFE_INTEGER);
  return { clientId, sessionId, epoch };
}

/** 校验控制请求，拒绝动作与 active 矛盾的组合。 */
export function getStateInput(value: unknown): StateInput {
  //G 版本正确才能提交状态变更。
  const body = getRecord(value);
  checkVersion(body['protocolVersion']);
  const identity = getIdentity(body);
  const reasonCode = body['reasonCode'];
  const active = body['active'];
  if (typeof active !== 'boolean') {
    throw new ScreenError('invalid_request');
  }
  if (reasonCode === 'heartbeat') return { ...identity, reasonCode, active };

  if (reasonCode === 'user_start' || reasonCode === 'resume') {
    if (active) return { ...identity, reasonCode, active };
  }
  if (reasonCode === 'privacy_pause' || reasonCode === 'user_stop') {
    if (!active) return { ...identity, reasonCode, active };
  }

  //G 其他动作或不匹配的状态标记不能修改租约。
  throw new ScreenError('invalid_request');
}

/** 校验点击身份，后续字段出错时仍可安全关联到点击。 */
export function getClickIdentity(body: Record<string, unknown>): ClickIdentity {
  //G 身份全部有效才回显。
  const identity = getIdentity(body);
  const clickId = getId(body['clickId']);
  const seq = getNumber(body['seq'], 1, Number.MAX_SAFE_INTEGER);
  return { ...identity, clickId, seq };
}

/** 读取带符号的物理像素坐标。 */
function getPoint(body: Record<string, unknown>): Point {
  //G 虚拟桌面允许负坐标，范围与基地 i32 一致。
  const x = getNumber(body['x'], -2147483648, 2147483647);
  const y = getNumber(body['y'], -2147483648, 2147483647);
  return { x, y };
}

/** 读取正尺寸矩形供裁图包含检查。 */
function getRect(value: unknown): Rect {
  //G 矩形要有坐标和正尺寸。
  const body = getRecord(value);
  const origin = getPoint(body);
  const width = getNumber(body['width'], 1, 2147483647);
  const height = getNumber(body['height'], 1, 2147483647);
  return { ...origin, width, height };
}

/** 判断裁图是否完全在窗口或显示器内。 */
function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

/** 读取 JPEG 的 SOF 尺寸，拒绝越界头部和不匹配的图片。 */
function checkJpeg(data: Buffer, width: number, height: number): void {
  //G 要求 JPEG 的起止标记；进入扫描数据之前应能读到有效的尺寸。
  if (data[0] !== 0xff || data[1] !== 0xd8 || data.at(-2) !== 0xff || data.at(-1) !== 0xd9) {
    throw new ScreenError('invalid_request');
  }
  let offset = 2;
  let foundFrame = false;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) break;

    const marker = data[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0x00) break;

    const length = data.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) break;

    //G 扫描启动前必须已经找到且只找到一个匹配的帧。
    if (marker === 0xda) {
      if (foundFrame && length >= 6) return;

      break;
    }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 11 || foundFrame) break;

      const encodedHeight = data.readUInt16BE(offset + 5);
      const encodedWidth = data.readUInt16BE(offset + 7);
      const components = data[offset + 9] ?? 0;
      if (encodedWidth !== width || encodedHeight !== height
        || components < 1 || components > 4 || length !== 8 + 3 * components) {
        break;
      }
      foundFrame = true;
    }
    offset += 2 + length;
  }

  //G 图片未提供匹配的有效 JPEG 尺寸。
  throw new ScreenError('invalid_request');
}

/** 验证图像并把点击点换算到 JPEG 像素坐标。 */
function getImage(
  value: unknown,
  config: ScreenConfig,
  position: Point,
  monitor: Rect,
  window: Rect,
  clickedAtMs: number,
): { data: string; point: Point } {
  //G 只接受规定范围的 JPEG 预点击裁图。
  const image = getRecord(value);
  if (image['mimeType'] !== 'image/jpeg') {
    throw new ScreenError('invalid_request');
  }

  //G 检查实际要送给模型的图片尺寸、帧时刻和物理范围。
  const width = getNumber(image['width'], 1, config.frameWidth);
  const height = getNumber(image['height'], 1, config.frameHeight);
  const capturedAt = getNumber(image['capturedAtMs'], 0, Number.MAX_SAFE_INTEGER);
  getNumber(image['ageBeforeClickMs'], 0, config.maxFrameAgeMs);
  const crop = getRect(image['sourceRect']);
  const dx = position.x - crop.x;
  const dy = position.y - crop.y;
  if (capturedAt > clickedAtMs || !contains(monitor, crop) || !contains(window, crop)
    || dx < 0 || dx >= crop.width || dy < 0 || dy >= crop.height) {
    throw new ScreenError('invalid_request');
  }

  //G 字节数超限回 413；拒绝非标准编码及声明与 JPEG 头不一致的图片。
  const encoded = image['data'];
  if (typeof encoded !== 'string' || encoded === '') {
    throw new ScreenError('invalid_request');
  }
  if (encoded.length > 4 * Math.ceil(config.imageMaxBytes / 3)) {
    throw new ScreenError('payload_too_large');
  }
  if (encoded.length % 4 !== 0 || !BASE64.test(encoded)) {
    throw new ScreenError('invalid_request');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > config.imageMaxBytes) {
    throw new ScreenError('payload_too_large');
  }
  if (bytes.toString('base64') !== encoded) {
    throw new ScreenError('invalid_request');
  }

  //G 验明尺寸再把图像交给模型。
  checkJpeg(bytes, width, height);
  const x = Math.floor(dx * width / crop.width);
  const y = Math.floor(dy * height / crop.height);
  return { data: encoded, point: { x, y } };
}

/** 将控制字符替换为空白，供私有模型请求使用。 */
function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
}

/** 从已提取身份的点击请求中校验其余字段，返回私有模型输入。 */
export function getClickInput(
  body: Record<string, unknown>,
  identity: ClickIdentity,
  config: ScreenConfig,
): ClickInput {
  //G 校验版本和点击坐标。有些观测字段只验证，不向下传。
  checkVersion(body['protocolVersion']);
  const clickedAtMs = getNumber(body['clickedAtMs'], 0, Number.MAX_SAFE_INTEGER);
  getNumber(body['ageAtSendMs'], 0, 1500);
  const button = body['button'];
  if (button !== 'left' && button !== 'right') {
    throw new ScreenError('invalid_request');
  }

  //G 读取显示器和窗口几何，用于裁图边界和窗口变化判断。
  const coordinates = getRecord(body['position']);
  const position = getPoint(coordinates);
  const monitor = getRecord(body['monitor']);
  const monitorId = getText(monitor['id'], 128);
  const monitorRect = getRect(monitor['rect']);
  const dpiX = getNumber(monitor['dpiX'], Number.MIN_VALUE, Number.MAX_VALUE, false);
  const dpiY = getNumber(monitor['dpiY'], Number.MIN_VALUE, Number.MAX_VALUE, false);
  const window = getRecord(body['window']);
  const pid = getNumber(window['pid'], 1, Number.MAX_SAFE_INTEGER);
  const startedAt = getNumber(window['processStartedAtMs'], 0, Number.MAX_SAFE_INTEGER);
  const windowId = getText(window['windowId'], 32);
  const windowRect = getRect(window['rect']);
  getNumber(window['observedAtMs'], 0, Number.MAX_SAFE_INTEGER);
  const processName = getText(window['processName'], 128);
  if (/[\\/:]/u.test(processName) || clean(processName) !== processName) {
    throw new ScreenError('invalid_request');
  }

  //G 隐私检查在净化标题或抽取图片前完成，失败时只给固定错误。
  const title = getText(window['title'], 160, true);
  const control = getRecord(body['control']);
  const name = getText(control['name'], 160, true);
  const type = getText(control['type'], 64, true);
  getText(control['automationId'], 128, true);
  getNumber(control['observedAtMs'], 0, Number.MAX_SAFE_INTEGER);
  if (control['rect'] !== null) {
    getRect(control['rect']);
  }
  if (typeof control['privacyChecked'] !== 'boolean' || typeof control['isPassword'] !== 'boolean') {
    throw new ScreenError('invalid_request');
  }
  const lowered = title.toLowerCase();
  if (!control['privacyChecked'] || control['isPassword']
    || config.processes.has(processName.toLowerCase())
    || config.titles.some((word) => lowered.includes(word))) {
    throw new ScreenError('privacy_blocked');
  }

  //G 无图须说明省略原因且仍有控件证据。
  const omitted = body['imageOmittedReason'];
  if (omitted !== undefined && (typeof omitted !== 'string' || !OMIT_REASONS.includes(omitted))) {
    throw new ScreenError('invalid_request');
  }
  let image: { data: string; point: Point } | undefined;
  if (body['image'] !== null) {
    image = getImage(body['image'], config, position, monitorRect, windowRect, clickedAtMs);
  }
  if (image === undefined && omitted === undefined) {
    throw new ScreenError('invalid_request');
  }

  //M 只提取模型所需的界面文字及图片内相对位置。
  const controlName = clean(name);
  const controlType = clean(type);
  if (image === undefined && controlName === '' && controlType === '') {
    throw new ScreenError('no_evidence');
  }
  const windowKey = JSON.stringify([pid, startedAt, windowId, windowRect, monitorId, monitorRect, dpiX, dpiY]);
  const contextText = JSON.stringify({
    processName,
    title: clean(title),
    controlName,
    controlType,
    button,
    clickInImage: image?.point,
  });
  return { ...identity, windowKey, contextText, image: image?.data ?? null };
}

/** 读取 screen 段，默认关闭。配置错误仅报告字段，返回后端需要的字段。 */
export function getConfig(value: unknown): ScreenConfig {
  //G 配置缺失时使用默认值，根字段有误时给出配置名称。
  let body: Record<string, unknown> = {};
  if (value !== undefined) {
    try {
      body = getRecord(value);
    } catch {
      throw new Error('screen 要是对象');
    }
  }

  const flag = (key: string, fallback: boolean): boolean => {
    const input = body[key];
    if (input === undefined) return fallback;

    if (typeof input === 'boolean') return input;

    throw new Error('screen.' + key + ' 要是布尔值');
  };
  const number = (key: string, fallback: number, min: number, max: number, int = true): number => {
    const input = body[key];
    if (input === undefined) return fallback;

    try {
      //G 保留错误字段名，避免将配置原值放入日志。
      return getNumber(input, min, max, int);
    } catch {
      throw new Error('screen.' + key + ' 超出允许的数值范围');
    }
  };

  const configuredModel = body['model'];
  let model = '';
  if (configuredModel !== undefined) {
    if (typeof configuredModel !== 'string') {
      throw new Error('screen.model 要是字符串');
    }
    model = configuredModel.trim();
    if (model !== '' && !/^[^/\s]+\/\S+$/u.test(model)) {
      throw new Error('screen.model 要是供应商名/模型 ID');
    }
  }
  let thinking = body['thinking'];
  if (thinking === undefined) {
    thinking = 'off';
  }
  if (thinking !== 'off' && thinking !== 'low') {
    throw new Error('screen.thinking 只支持 off 或 low');
  }

  //G 锁屏保护属于协议前提，配置不能关闭。
  if (!flag('pause_on_lock', true)) {
    throw new Error('screen.pause_on_lock 必须为 true');
  }

  //G 控制基地采集的配置也在入口拒绝不合法值。
  number('ring_max_bytes', 64 * MIB, MIB, 64 * MIB);
  number('jpeg_quality', 75, 1, 95);
  number('click_debounce_ms', 250, 0, 1000);
  flag('pause_on_fullscreen', true);

  //G 禁止关闭密码保护，用户配置仅追加黑名单。
  const configuredBlacklist = body['blacklist'];
  let blacklist: Record<string, unknown> = {};
  if (configuredBlacklist !== undefined) {
    try {
      blacklist = getRecord(configuredBlacklist);
    } catch {
      throw new Error('screen.blacklist 要是对象');
    }
  }
  const passwordControls = blacklist['password_controls'];
  if (passwordControls !== undefined && passwordControls !== true) {
    throw new Error('screen.blacklist.password_controls 必须为 true');
  }
  const blockList = (key: string, defaults: string[]): string[] => {
    const extra = blacklist[key];
    let all = defaults;
    if (extra !== undefined) {
      if (!Array.isArray(extra) || !extra.every((item) => typeof item === 'string' && item.trim() !== '')) {
        throw new Error('screen.blacklist.' + key + ' 要是非空字符串数组');
      }
      all = [...defaults, ...extra];
    }
    return all.map((item) => item.trim().toLowerCase());
  };

  //M 保存状态接口、边界校验和模型调用实际使用的值。
  const processes = blockList('processes', PROCESSES);
  const titles = blockList('title_contains', TITLES);
  const overlaySeconds = number('overlay_seconds', 6, 1, 10, false);
  return {
    enabled: flag('enabled', false),
    fps: number('fps', 2, 1, 5),
    bufferSeconds: number('buffer_seconds', 3, 0.5, 3, false),
    cropWidth: number('crop_width', 480, 64, IMAGE_WIDTH),
    cropHeight: number('crop_height', 320, 64, IMAGE_HEIGHT),
    frameWidth: number('frame_max_width', IMAGE_WIDTH, 1, IMAGE_WIDTH),
    frameHeight: number('frame_max_height', IMAGE_HEIGHT, 1, IMAGE_HEIGHT),
    imageMaxBytes: number('image_max_bytes', IMAGE_LIMIT, 1, IMAGE_LIMIT),
    maxFrameAgeMs: number('max_frame_age_ms', 1000, 1, 1000),
    model,
    thinking,
    timeoutMs: number('model_timeout_ms', 8000, 1000, 8000),
    maxTokens: number('max_output_tokens', 160, 64, 256),
    displayForMs: Math.round(overlaySeconds * 1000),
    speak: flag('speak', false),
    processes: new Set(processes),
    titles,
  };
}
