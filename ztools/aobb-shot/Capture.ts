/** AOBB 多开舱截图执行层：纯 Bun 原生 fetch 直调 /api/v1/ai/* 接口，零旧版 AOBB 依赖。 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as timers from 'node:timers/promises';
import * as options from './Options.ts';

/** 多开舱 /api/v1/ai/instances 返回的单条浏览器实例摘要。 */
export interface AiInstanceView {
  /** 浏览器配置唯一编号。 */
  id: string;
  /** 浏览器配置显示名称。 */
  name: string;
  /** 该实例当前是否处于运行状态。 */
  running: boolean;
  /** 远程调试端口（可选）。 */
  cdpPort?: number;
}

/** 列表接口响应体。 */
interface AiInstancesResponse {
  /** 请求是否成功。 */
  ok?: boolean;
  /** 全部配置实例列表。 */
  instances?: AiInstanceView[];
  /** 失败时的中文错误信息。 */
  error?: string;
}

/** 导航接口响应体。 */
interface NavigateResponse {
  /** 请求是否成功。 */
  ok?: boolean;
  /** 导航所用 AI 专属标签页编号。 */
  pageId?: string;
  /** 导航完成后的页面地址。 */
  url?: string;
  /** 导航完成后的页面标题。 */
  title?: string;
  /** 是否复用了既有 AI 标签页。 */
  reused?: boolean;
  /** 失败时的中文错误信息。 */
  error?: string;
}

/** 交互接口响应体。 */
interface ActResponse {
  /** 请求是否成功。 */
  ok?: boolean;
  /** 执行动作的标签页编号。 */
  pageId?: string;
  /** 执行的动作名。 */
  action?: string;
  /** 执行结果摘要。 */
  detail?: string;
  /** eval 动作的脚本返回值。 */
  value?: unknown;
  /** 失败时的中文错误信息。 */
  error?: string;
}

/** 截图接口响应体。 */
interface ScreenshotResponse {
  /** 请求是否成功。 */
  ok?: boolean;
  /** 截图对应的标签页编号。 */
  pageId?: string;
  /** 图片 MIME 类型。 */
  mimeType?: string;
  /** PNG 图片的 Base64 编码字符串。 */
  base64?: string;
  /** 失败时的中文错误信息。 */
  error?: string;
}

/** 页面状态与可见文字采集结果。 */
interface PageDetails {
  /** 最终地址，用于复验导航仍在回环范围。 */
  url: string;
  /** 页面标题。 */
  title: string;
  /** 主文档 HTTP 状态；浏览器未提供时为 0。 */
  status: number;
  /** 打开 --text 时取到的可见文字。 */
  text?: string;
}

/** CLI 的截图输出结构。 */
export interface ShotResult {
  /** 图片绝对路径。 */
  out: string;
  /** 指定 --text 时的文字文件绝对路径。 */
  text?: string;
  /** 当前文档标题。 */
  title: string;
  /** 当前主文档的 HTTP 状态。 */
  status: number;
  /** 按执行顺序列出的双动画帧耗时，单位毫秒。 */
  timings?: {
    /** 对应动作种类。 */
    action: options.ShotAction['kind'];
    /** 双动画帧耗时，单位毫秒。 */
    ms: number;
  }[];
  /** 实际使用的 AOBB 多开舱配置编号。 */
  profileId: string;
  /** 实际操作的 AI 专属标签页编号。 */
  pageId: string;
}

/** 截图执行层可注入依赖（供单测 mock 网络与等待，无需真实浏览器）。 */
export interface CaptureDeps {
  /** HTTP 请求函数；省略时使用全局 fetch。 */
  fetchFn?: typeof fetch;
  /** 延时等待函数；省略时使用 node:timers/promises 的 setTimeout。 */
  sleepFn?: (ms: number) => Promise<void>;
  /** 单次请求多开舱接口超时毫秒数；省略时默认 30000。 */
  timeoutMs?: number;
}

/** 敏感内容默认遮罩选择器，截图和可见文字沿用同一套规则。 */
const MASK = 'input,textarea,[contenteditable],[data-sensitive],[data-secret],[data-aobb-sensitive],'
  + '[class*="token" i],[class*="secret" i],[id*="token" i],[id*="secret" i]';

/** 临时遮罩样式节点 ID。 */
const MASK_STYLE_ID = '__aobb_shot_mask__';

/** 临时宽度约束样式节点 ID。 */
const WIDTH_STYLE_ID = '__aobb_shot_width__';

/** 单次 HTTP 请求默认超时时间（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 网页仍能在当前 AI 标签页导航，点击或脚本不得打开新标签或跳转非回环站点。 */
const SINGLE_TAB_SCRIPT = String.raw`(() => {
  if (window.__aobbShotSingleTabInstalled) return true;
  window.__aobbShotSingleTabInstalled = true;
  Object.defineProperty(window, 'open', { value: () => null, configurable: true });
  addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest('a,area');
    if (!link) return;
    const base = document.querySelector('base[target]');
    const destination = link.target || base?.target;
    const local = /^http:\/\/(?:127\.0\.0\.1|localhost)(?=[:/])/i.test(link.href);
    if (!local || link.hasAttribute('download') || (destination && destination !== '_self')) {
      event.preventDefault();
    }
  }, true);
  addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const base = document.querySelector('base[target]');
    const target = event.submitter?.formTarget || form.target || base?.target;
    if (!target || target === '_self') return;
    event.preventDefault();
  }, true);
  return true;
})()`;

/**
 * 面向 AOBB 多开舱 HTTP API（/api/v1/ai/*）的轻客户端。
 * 统一处理 URL 拼装、超时、非 JSON 响应与中文错误提取。
 */
export class DockClient {
  /** 规范化后的多开舱接口根地址（不带末尾斜杠）。 */
  private readonly baseUrl: string;
  /** HTTP 请求实现。 */
  private readonly fetchFn: typeof fetch;
  /** 单次请求超时毫秒数。 */
  private readonly timeoutMs: number;

  /**
   * 构造多开舱 HTTP 客户端。
   * @param baseUrl 已校验的多开舱根地址。
   * @param fetchFn HTTP 请求函数。
   * @param timeoutMs 单次请求超时毫秒数。
   */
  constructor(baseUrl: string, fetchFn: typeof fetch, timeoutMs: number) {
    this.baseUrl = baseUrl;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  /**
   * 拼装完整接口地址。
   * @param apiPath 以 / 开头的接口路径。
   * @returns 完整 HTTP URL。
   */
  buildUrl(apiPath: string): string {
    return `${this.baseUrl}${apiPath}`;
  }

  /**
   * 发送 JSON HTTP 请求并统一检查状态码与业务 ok 字段。
   * @param method HTTP 方法（GET 或 POST）。
   * @param apiPath 接口路径。
   * @param body 可选 JSON 请求体。
   * @returns 解析后的响应对象。
   */
  async requestJson<T extends { ok?: boolean; error?: string }>(
    method: 'GET' | 'POST',
    apiPath: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const endpoint = this.buildUrl(apiPath);
    const init: RequestInit = {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchFn(endpoint, init);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`请求 AOBB 多开舱超时（${method} ${endpoint}）`, { cause: error });
      }

      let reason = String(error);
      if (error instanceof Error) {
        reason = error.message;
      }
      throw new Error(`无法连接 AOBB 多开舱（${this.baseUrl}），请确认服务已启动：${reason}`, { cause: error });
    }

    const rawText = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (error: unknown) {
      const code = String(response.status);
      throw new Error(`AOBB 多开舱返回了非 JSON 响应（HTTP ${code}，${apiPath}）`, { cause: error });
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const code = String(response.status);
      throw new Error(`AOBB 多开舱响应格式异常（HTTP ${code}，${apiPath}）`);
    }

    const record = parsed as T;
    if (!response.ok || record.ok === false) {
      let detail = `HTTP ${String(response.status)}`;
      if (typeof record.error === 'string' && record.error.trim() !== '') {
        detail = record.error.trim();
      }
      throw new Error(`AOBB 多开舱接口报错（${apiPath}）：${detail}`);
    }

    return record;
  }

  /**
   * 查询多开舱全部浏览器配置及实时运行状态。
   * @returns 实例摘要数组。
   */
  async listInstances(): Promise<AiInstanceView[]> {
    const data = await this.requestJson<AiInstancesResponse>('GET', '/api/v1/ai/instances');
    if (!Array.isArray(data.instances)) {
      throw new Error('AOBB 多开舱 /api/v1/ai/instances 响应缺少 instances 数组');
    }

    return data.instances;
  }

  /**
   * 在 AI 专属单标签页上导航至目标网址（默认 reuseOwnTab=true，绝不劫持用户标签）。
   * @param profileId 目标浏览器配置编号。
   * @param targetUrl 已校验的回环网页地址。
   * @returns 导航结果（含标签页编号、落地地址与标题）。
   */
  async navigate(profileId: string, targetUrl: string): Promise<{ pageId: string; url: string; title: string }> {
    const encodedId = encodeURIComponent(profileId);
    const apiPath = `/api/v1/ai/instances/${encodedId}/navigate`;
    const payload = { url: targetUrl, reuseOwnTab: true };
    const data = await this.requestJson<NavigateResponse>('POST', apiPath, payload);
    if (typeof data.pageId !== 'string' || data.pageId.trim() === '') {
      throw new Error('AOBB 多开舱导航接口未返回有效的 pageId');
    }

    let landedUrl = targetUrl;
    if (typeof data.url === 'string' && data.url.trim() !== '') {
      landedUrl = data.url;
    }
    let title = '';
    if (typeof data.title === 'string') {
      title = data.title;
    }
    return { pageId: data.pageId, url: landedUrl, title };
  }

  /**
   * 在指定标签页上调用 /api/v1/ai/instances/:id/act 执行交互或脚本。
   * @param profileId 浏览器配置编号。
   * @param payload 动作请求体。
   * @returns 动作执行响应。
   */
  async act(profileId: string, payload: Record<string, unknown>): Promise<ActResponse> {
    const encodedId = encodeURIComponent(profileId);
    const apiPath = `/api/v1/ai/instances/${encodedId}/act`;
    return this.requestJson<ActResponse>('POST', apiPath, payload);
  }

  /**
   * 在指定标签页主上下文执行 JS 表达式并读取返回值。
   * @param profileId 浏览器配置编号。
   * @param pageId 目标标签页编号。
   * @param expression 要执行的 JS 表达式。
   * @returns 表达式返回值。
   */
  async evalValue<T>(profileId: string, pageId: string, expression: string): Promise<T> {
    const payload = { pageId, action: 'eval', expression };
    const data = await this.act(profileId, payload);
    if (data.value === undefined) {
      throw new Error('AOBB 多开舱页内动作未返回结果');
    }

    return data.value as T;
  }

  /**
   * 通过多开舱后台静默截图接口采集 PNG 二进制数据。
   * @param profileId 浏览器配置编号。
   * @param pageId 目标标签页编号。
   * @param fullPage 是否整页截图。
   * @returns 解码后的 PNG 字节缓冲。
   */
  async screenshot(profileId: string, pageId: string, fullPage: boolean): Promise<Buffer> {
    const encodedId = encodeURIComponent(profileId);
    const apiPath = `/api/v1/ai/instances/${encodedId}/screenshot`;
    const payload = { pageId, fullPage };
    const data = await this.requestJson<ScreenshotResponse>('POST', apiPath, payload);
    if (typeof data.base64 !== 'string' || data.base64.trim() === '') {
      throw new Error('AOBB 多开舱截图接口未返回有效的 base64 图像数据');
    }

    const encoded = data.base64.trim();
    if (!/^[A-Za-z0-9+/=\r\n]+$/u.test(encoded)) {
      throw new Error('AOBB 多开舱截图接口返回了非法 base64 数据');
    }

    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0) {
      throw new Error('AOBB 多开舱截图解码后为空文件');
    }

    return bytes;
  }
}

/**
 * 从多开舱实例列表中挑选可用的运行中配置；绝不擅自启动未运行的外部账号。
 * @param instances /api/v1/ai/instances 返回的全部配置摘要。
 * @param requestedProfile 可选的 --profile 参数（编号、精确名称或名称子串）。
 * @param baseUrl 多开舱根地址，用于报错提示定位。
 * @returns 选中的运行中实例。
 */
export function selectRunningInstance(
  instances: AiInstanceView[],
  requestedProfile: string | undefined,
  baseUrl: string,
): AiInstanceView {
  if (instances.length === 0) {
    throw new Error(`AOBB 多开舱（${baseUrl}）中没有任何浏览器配置，请先在多开舱创建并启动配置`);
  }

  //M 未指定 --profile 时，自动选用第一个已在运行的配置；无运行中配置则报错，不擅自拉起外部账号。
  if (requestedProfile === undefined) {
    const running = instances.find((item) => item.running);
    if (running !== undefined) return running;

    throw new Error(`AOBB 多开舱（${baseUrl}）当前没有运行中的浏览器配置；请先在多开舱手动启动一个配置`);
  }

  const target = requestedProfile.trim();
  const lower = target.toLowerCase();
  let matched = instances.find((item) => item.id === target);
  if (matched === undefined) {
    matched = instances.find((item) => item.name === target);
  }
  if (matched === undefined) {
    matched = instances.find((item) => item.name.toLowerCase() === lower);
  }
  if (matched === undefined) {
    const partial = instances.filter((item) => item.name.toLowerCase().includes(lower));
    if (partial.length > 1) {
      const names = partial.map((item) => `${item.name}(${item.id})`).join('、');
      throw new Error(`匹配到多个浏览器配置（${names}），请通过 --profile 指定精确编号或完整名称`);
    }
    matched = partial[0];
  }

  if (matched === undefined) {
    throw new Error(`AOBB 多开舱中找不到匹配「${target}」的浏览器配置`);
  }
  if (!matched.running) {
    const hint = `浏览器配置「${matched.name}」(${matched.id}) 当前未运行`;
    throw new Error(`${hint}；为避免擅自启动未授权账号，请先在 AOBB 多开舱手动启动该配置`);
  }

  return matched;
}

/** 将经过 win32 校验的路径转为当前宿主系统的原生路径（Windows 原样保留）。 */
function toNativePath(filePath: string): string {
  if (process.platform === 'win32') return filePath;

  return filePath.replace(/\\/gu, '/');
}

/** 复验落地网址仍在允许的回环 HTTP 范围内，防止站内重定向跳往外部域名。 */
function assertLocalUrl(address: string): void {
  //G 浏览器会省去显式的默认 80 端口，补齐后用与输入同一套回环规则校验。
  const normalized = address.replace(/^(http:\/\/(?:127\.0\.0\.1|localhost))(?=\/|$)/iu, '$1:80');
  options.getLocalUrl(normalized);
}

/** 向上寻找磁盘上已存在的最近父目录，作为逐级校验符号链接的起点。 */
async function findExistingAncestor(startDir: string): Promise<string> {
  let current = startDir;
  while (true) {
    try {
      await fs.access(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`找不到可用的输出根目录：${startDir}`);
      }
      current = parent;
    }
  }
}

/** 逐级建立输出目录，确保路径没有经过联接或符号链接跳出授权目录。 */
async function createDirectory(root: string, directory: string): Promise<void> {
  const base = await findExistingAncestor(path.dirname(root));
  const relative = path.relative(base, directory);
  const pieces = relative.split(path.sep);
  let current = base;
  for (const piece of pieces) {
    if (piece === '') {
      continue;
    }

    //G 在写下一级前核对上一级真实路径，阻断联接及符号链接。
    const actual = await fs.realpath(current);
    if (path.relative(current, actual) !== '') {
      throw new Error('输出目录经过了联接');
    }

    current = path.join(current, piece);
    //M 每次只创建一级，下一次创建前再复验真实路径。
    try {
      await fs.mkdir(current, { recursive: true });
    } catch (error: unknown) {
      let reason = String(error);
      if (error instanceof Error) {
        reason = error.message;
      }
      throw new Error(`无法创建截图输出目录（${current}）：${reason}`, { cause: error });
    }
  }

  const actual = await fs.realpath(current);
  if (path.relative(current, actual) !== '') {
    throw new Error('输出目录经过了联接');
  }
}

/** 独占写入磁盘文件，避免并行截图互相覆盖，并输出清晰中文错误。 */
async function writeExclusiveFile(filePath: string, data: Buffer | string, label: string): Promise<void> {
  try {
    if (typeof data === 'string') {
      await fs.writeFile(filePath, data, { encoding: 'utf8', flag: 'wx' });
      return;
    }
    await fs.writeFile(filePath, data, { flag: 'wx' });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new Error(`${label}文件已存在，为防覆盖未写入，请更换输出文件名：${filePath}`, { cause: error });
    }

    let reason = String(error);
    if (error instanceof Error) {
      reason = error.message;
    }
    throw new Error(`${label}写入磁盘失败（${filePath}）：${reason}`, { cause: error });
  }
}

/** 注入或更新临时页面样式（用于敏感内容遮罩或页面宽度约束），截图后统一移除。 */
async function injectStyle(
  client: DockClient,
  profileId: string,
  pageId: string,
  styleId: string,
  cssText: string,
): Promise<void> {
  const idJson = JSON.stringify(styleId);
  const cssJson = JSON.stringify(cssText);
  const expression = String.raw`((id, css) => {
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = css;
    return true;
  })(${idJson}, ${cssJson})`;
  await client.evalValue<boolean>(profileId, pageId, expression);
}

/** 清理截图过程中注入的临时页面样式，避免污染复用中的 AI 标签页。 */
async function removeStyles(
  client: DockClient,
  profileId: string,
  pageId: string,
  styleIds: string[],
): Promise<void> {
  if (styleIds.length === 0) return;

  const idsJson = JSON.stringify(styleIds);
  const expression = String.raw`((ids) => {
    for (const id of ids) {
      const node = document.getElementById(id);
      if (node) node.remove();
    }
    return true;
  })(${idsJson})`;
  await client.evalValue<boolean>(profileId, pageId, expression).catch(() => false);
}

/** 滚动指定容器或整个文档，返回滚动后的位置以确认动作生效。 */
async function runScroll(
  client: DockClient,
  profileId: string,
  pageId: string,
  action: Extract<options.ShotAction, { kind: 'scroll' }>,
): Promise<void> {
  const target = JSON.stringify(action.target);
  const distance = JSON.stringify(action.distance);
  const expression = String.raw`((target, distance) => {
    let element = document.scrollingElement;
    if (target !== 'page') {
      const nodes = document.querySelectorAll(target);
      if (nodes.length !== 1) return null;

      element = nodes[0];
    }
    if (!element) return null;
    let top = distance;
    if (distance === 'bottom') top = element.scrollHeight;
    if (distance !== 'bottom') top += element.scrollTop;
    element.scrollTo({ top, behavior: 'instant' });
    return element.scrollTop;
  })(${target}, ${distance})`;
  const position = await client.evalValue<number | null>(profileId, pageId, expression);
  if (position === null) {
    throw new Error('滚动目标必须恰好匹配一个元素');
  }
}

/** 精确选择一个启用的 antd Select 或 Segmented 文字选项。 */
async function runSelect(
  client: DockClient,
  profileId: string,
  pageId: string,
  action: Extract<options.ShotAction, { kind: 'select' }>,
  sleepFn: (ms: number) => Promise<void>,
): Promise<void> {
  const target = JSON.stringify(action.selector);
  const label = JSON.stringify(action.label);
  const detect = String.raw`(selector => {
    const nodes = document.querySelectorAll(selector);
    if (nodes.length !== 1) return 'missing';
    if (nodes[0].querySelector('.ant-segmented-item')) return 'segmented';
    if (nodes[0].matches('.ant-select') || nodes[0].querySelector('.ant-select')) return 'select';
    return 'unsupported';
  })(${target})`;
  const control = await client.evalValue<string>(profileId, pageId, detect);
  if (control === 'missing') {
    throw new Error('选择目标必须恰好匹配一个元素');
  }
  if (control === 'unsupported') {
    throw new Error('选择目标须为 antd Select 或 Segmented');
  }

  //M 下拉弹层由 antd 挂到页面上，先展开；分段控件直接在当前目标内找选项。
  if (control === 'select') {
    const clickPayload = { pageId, action: 'click', selector: action.selector, humanize: false };
    await client.act(profileId, clickPayload);
  }

  const controlType = JSON.stringify(control);
  const choose = String.raw`((selector, label, control) => {
    let root = document;
    let optionSelector = '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option';
    if (control === 'segmented') {
      root = document.querySelector(selector);
      optionSelector = '.ant-segmented-item';
    }
    const items = Array.from(root.querySelectorAll(optionSelector));
    const matches = items.filter(item => item.getClientRects().length > 0 && item.innerText.trim() === label);
    if (matches.length === 0) return 'missing';
    if (matches.length > 1) return 'ambiguous';
    const item = matches[0];
    const disabledSel = '[aria-disabled=true],.ant-select-item-option-disabled,.ant-segmented-item-disabled';
    if (item.matches(disabledSel) || item.querySelector('input:disabled')) return 'disabled';
    item.click();
    return 'selected';
  })(${target}, ${label}, ${controlType})`;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    //M 等待 antd 弹层完成挂载，选中后立即结束。
    const status = await client.evalValue<string>(profileId, pageId, choose);
    if (status === 'selected') return;

    if (status === 'disabled') {
      throw new Error('目标选项已禁用');
    }
    if (status === 'ambiguous') {
      throw new Error('有多个同名的可见选项');
    }

    await sleepFn(60);
  }
  throw new Error('未找到指定的可见选项');
}

/** 按命令顺序执行单个已校验的页面动作，全程保持极速无拟人延迟。 */
async function runAction(
  client: DockClient,
  profileId: string,
  pageId: string,
  action: options.ShotAction,
  sleepFn: (ms: number) => Promise<void>,
): Promise<void> {
  if (action.kind === 'scroll') return runScroll(client, profileId, pageId, action);
  if (action.kind === 'select') return runSelect(client, profileId, pageId, action, sleepFn);

  if (action.kind === 'click') {
    const payload = { pageId, action: 'click', selector: action.selector, humanize: false };
    await client.act(profileId, payload);
    return;
  }

  //M 交给多开舱向控件输入文本，可选随后在同一控件按回车。
  const typePayload = {
    pageId,
    action: 'type',
    selector: action.selector,
    text: action.value,
    humanize: false,
  };
  await client.act(profileId, typePayload);
  if (!action.enter) return;

  const pressPayload = {
    pageId,
    action: 'press',
    selector: action.selector,
    key: 'Enter',
    humanize: false,
  };
  await client.act(profileId, pressPayload);
}

/** 记录动作完成后页面跨过两次 requestAnimationFrame 的耗时。 */
async function getFrameTime(client: DockClient, profileId: string, pageId: string): Promise<number> {
  const expression = String.raw`new Promise(resolve => {
    const start = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
  })`;
  const elapsed = await client.evalValue<number>(profileId, pageId, expression);
  return Math.round(elapsed * 10) / 10;
}

/** 读取页面落地地址、标题、主文档 HTTP 状态及可选可见文字（按需遮罩敏感节点）。 */
async function getDetails(
  client: DockClient,
  profileId: string,
  pageId: string,
  shot: options.ShotOptions,
): Promise<PageDetails> {
  const mask = JSON.stringify(MASK);
  const expression = String.raw`(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const details = { url: location.href, title: document.title, status: navigation?.responseStatus || 0 };
    if (!${String(shot.text)}) return details;
    const hidden = [];
    try {
      if (${String(shot.mask)}) {
        for (const node of document.querySelectorAll(${mask})) {
          if (!node.style) continue;
          hidden.push([node, node.getAttribute('style')]);
          node.style.setProperty('display', 'none', 'important');
        }
      }
      details.text = document.body?.innerText.trim().slice(0, 200_000) ?? '';
      return details;
    } finally {
      for (const [node, style] of hidden) {
        if (style === null) node.removeAttribute('style');
        if (style !== null) node.setAttribute('style', style);
      }
    }
  })()`;
  const value = await client.evalValue<PageDetails>(profileId, pageId, expression);
  if (typeof value !== 'object' || value === null || typeof value.url !== 'string') {
    throw new Error('AOBB 多开舱未返回有效的页面状态');
  }

  //G 复验执行动作后的当前页面仍留在本地回环范围。
  assertLocalUrl(value.url);
  return value;
}

/**
 * 通过现役 AOBB 多开舱 HTTP API 截取本地网页并落盘。
 * 复用实例的单个 AI 专属标签页，绝不劫持用户标签页，也不擅自启动未运行配置。
 * @param shot 已通过入口边界校验的截图参数。
 * @param deps 可选执行依赖（单测注入 mock fetch / sleep）。
 * @returns 落盘路径、页面标题、HTTP 状态及可选耗时和文字路径。
 */
export async function takeShot(shot: options.ShotOptions, deps: CaptureDeps = {}): Promise<ShotResult> {
  let fetchFn = globalThis.fetch;
  if (deps.fetchFn !== undefined) {
    fetchFn = deps.fetchFn;
  }

  let sleepFn: (ms: number) => Promise<void> = async (ms: number): Promise<void> => {
    await timers.setTimeout(ms);
  };
  if (deps.sleepFn !== undefined) {
    sleepFn = deps.sleepFn;
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (deps.timeoutMs !== undefined) {
    timeoutMs = deps.timeoutMs;
  }

  //==========================================================
  //M 第一步：校验并逐级准备输出目录（阻断符号链接/联接越界）
  //==========================================================
  const outPath = toNativePath(shot.out);
  const outputRoot = toNativePath(shot.outputRoot);
  const directory = path.dirname(outPath);
  await createDirectory(outputRoot, directory);

  //==========================================================
  //M 第二步：发现运行中的浏览器实例并在 AI 专属单标签页导航
  //==========================================================
  const client = new DockClient(shot.baseUrl, fetchFn, timeoutMs);
  const instances = await client.listInstances();
  const instance = selectRunningInstance(instances, shot.profile, shot.baseUrl);
  const profileId = instance.id;

  const nav = await client.navigate(profileId, shot.url);
  const pageId = nav.pageId;
  assertLocalUrl(nav.url);

  //==========================================================
  //M 第三步：执行页面动作、采集状态、按需遮罩并静默截图落盘
  //==========================================================
  const injectedStyles: string[] = [];
  try {
    //M AOBB 多开舱 HTTP 接口未暴露 CDP 设备模拟，--width 通过临时页面宽度样式约束实现。
    if (shot.width !== undefined) {
      const widthCss = `html,body{width:${String(shot.width)}px !important;`
        + `max-width:${String(shot.width)}px !important;overflow-x:hidden !important;}`;
      await injectStyle(client, profileId, pageId, WIDTH_STYLE_ID, widthCss);
      injectedStyles.push(WIDTH_STYLE_ID);
    }

    const timings: NonNullable<ShotResult['timings']> = [];
    if (shot.actions.length > 0) {
      //G 动作执行前加单标签约束，禁止点击或表单提交新开标签或跳出回环地址。
      await client.evalValue<boolean>(profileId, pageId, SINGLE_TAB_SCRIPT);
      for (const action of shot.actions) {
        await runAction(client, profileId, pageId, action, sleepFn);
        if (shot.timing) {
          const ms = await getFrameTime(client, profileId, pageId);
          timings.push({ action: action.kind, ms });
        }
      }
    }

    if (shot.waitMs > 0) {
      await sleepFn(shot.waitMs);
    }

    const details = await getDetails(client, profileId, pageId, shot);

    if (shot.mask) {
      const maskCss = `${MASK}{filter:blur(8px) !important;color:transparent !important;text-shadow:none !important;}`;
      await injectStyle(client, profileId, pageId, MASK_STYLE_ID, maskCss);
      injectedStyles.push(MASK_STYLE_ID);
    }

    //M 静默整页截图并独占写入磁盘，确保并行任务互不覆盖。
    const pngBytes = await client.screenshot(profileId, pageId, true);
    await writeExclusiveFile(outPath, pngBytes, '截图');

    let safeTitle = nav.title;
    if (typeof details.title === 'string') {
      safeTitle = details.title;
    }
    const result: ShotResult = {
      out: outPath,
      title: safeTitle.slice(0, 300),
      status: details.status,
      profileId,
      pageId,
    };
    if (shot.timing) {
      result.timings = timings;
    }
    if (details.text === undefined) return result;

    //M 可见文字与图片同名，同样独占写入避免覆盖。
    const textPath = outPath.slice(0, -4) + '.txt';
    await writeExclusiveFile(textPath, details.text, '可见文字');
    return { ...result, text: textPath };
  } finally {
    await removeStyles(client, profileId, pageId, injectedStyles);
  }
}
