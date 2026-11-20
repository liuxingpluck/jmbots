/** AOBB 截图执行层。连接本地已运行的浏览器，不限所在显示器。 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as timers from 'node:timers/promises';
import * as url from 'node:url';
import * as options from './Options.ts';

/** AOBB 本地执行接口，只用连接、页面和关闭方法。 */
interface Aobb {
  /** 运行一个 AOBB 动作，必要时附上自己标签页的 bindingId。 */
  execute(command: string, params: Record<string, unknown>): Promise<unknown>;
  /** 释放此次 CDP 连接。 */
  close(): Promise<unknown>;
}

/** 页面结果，按需包含可见文字。 */
interface PageDetails {
  /** 最终地址，用于复验导航还在回环范围。 */
  url: string;
  /** 页面标题。 */
  title: string;
  /** 主文档 HTTP 状态。浏览器无状态时为 0。 */
  status: number;
  /** 打开 --text 时取到的可见文字。 */
  text?: string;
}

/** CLI 的截图输出。 */
interface ShotResult {
  /** 图片绝对路径。 */
  out: string;
  /** 指定 --text 时的文字文件绝对路径。 */
  text?: string;
  /** 当前文档标题。 */
  title: string;
  /** 当前主文档的 HTTP 状态。 */
  status: number;
  /** 按执行顺序列出的双动画帧耗时，单位毫秒。 */
  timings?: { action: options.ShotAction['kind']; ms: number }[];
}

/** 与 AOBB 截图默认遮罩相同，可见文字也按此遮住。 */
const MASK = 'input,textarea,[contenteditable],[data-sensitive],[data-secret],[data-aobb-sensitive],'
  + '[class*="token" i],[class*="secret" i],[id*="token" i],[id*="secret" i]';

/** 网页仍能在自己的标签页导航，点击或脚本不得打开新标签。 */
const SINGLE_TAB = String.raw`
  Object.defineProperty(window, 'open', { value: () => null });
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
`;

/** 从清单找到可连接的本地 CDP 端口，找不到时退出。 */
async function getEndpoint(project: string): Promise<string> {
  const catalog = path.resolve(project, '..', '..', 'AITools', 'CloakBrowser', 'Browser_Catalog.json');
  //M 每次读当前清单，避免浏览器重建或端口变化之后还连旧地址。
  const raw = await fs.readFile(catalog, 'utf8');
  const config = JSON.parse(raw) as { profiles?: { port: number }[] };
  if (!Array.isArray(config.profiles)) throw new Error('AOBB 浏览器清单里没有 profiles');

  const profiles = [...config.profiles].reverse();
  for (const profile of profiles) {
    const port = profile.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;

    const endpoint = 'http://127.0.0.1:' + String(port);
    try {
      const request = { redirect: 'error' as const, signal: AbortSignal.timeout(1200) };
      //M 直接探测本地 CDP 服务，不限制浏览器窗口所在屏幕。
      const response = await fetch(endpoint + '/json/version', request);
      if (response.ok) return endpoint;
    } catch {
      //G 清单里可能留着已关的实例，继续试下一个候选端口。
      continue;
    }
  }
  throw new Error('没有可连接的 AOBB 浏览器');
}

/** 逐级建立输出目录，确保路径没有经过联接跳出授权目录。 */
async function createDirectory(root: string, directory: string): Promise<void> {
  const parent = path.dirname(root);
  const relative = path.relative(parent, directory);
  const pieces = relative.split(path.sep);
  let current = parent;
  for (const piece of pieces) {
    //G 在写下一级前核对上一级真实路径，阻断联接及符号链接。
    const actual = await fs.realpath(current);
    if (path.relative(current, actual) !== '') throw new Error('输出目录经过了联接');

    current = path.join(current, piece);
    //M 每次只创建一级，下一次创建前再复验真实路径。
    await fs.mkdir(current, { recursive: true });
  }
  const actual = await fs.realpath(current);
  if (path.relative(current, actual) !== '') throw new Error('输出目录经过了联接');
}

/** 在 AOBB 已绑定的标签页上调用 CDP。 */
async function pageCdp(
  aobb: Aobb, bindingId: string, method: string, params: Record<string, unknown> = {},
): Promise<unknown> {
  const call = { bindingId, scope: 'page', method, params, maxBytes: 2_000_000 };
  //M CDP 请求绑定此标签页，AOBB 保留连接和清理控制。
  return aobb.execute('cdp.send', call);
}

/** 运行固定的页内计算，参数只作为 JSON 数据传到已绑定标签页。 */
async function getPageValue<T>(aobb: Aobb, bindingId: string, expression: string): Promise<T> {
  const params = { expression, returnByValue: true, awaitPromise: true };
  const call = await pageCdp(aobb, bindingId, 'Runtime.evaluate', params) as {
    result?: { result?: { value?: T }; exceptionDetails?: unknown };
  };
  const value = call.result?.result?.value;
  if (call.result?.exceptionDetails !== undefined || value === undefined) throw new Error('AOBB 页内动作未返回结果');

  return value;
}

/** 滚动元素或整个文档，返回滚动后的位置以确认动作执行。 */
async function scroll(aobb: Aobb, bindingId: string, action: Extract<options.ShotAction, { kind: 'scroll' }>) {
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
  const position = await getPageValue<number | null>(aobb, bindingId, expression);
  if (position === null) throw new Error('滚动目标必须恰好匹配一个元素');
}

/** 精确选择一个启用的 antd Select 或 Segmented 文字选项。 */
async function select(aobb: Aobb, bindingId: string, action: Extract<options.ShotAction, { kind: 'select' }>) {
  const target = JSON.stringify(action.selector);
  const label = JSON.stringify(action.label);
  const detect = String.raw`(selector => {
    const nodes = document.querySelectorAll(selector);
    if (nodes.length !== 1) return 'missing';
    if (nodes[0].querySelector('.ant-segmented-item')) return 'segmented';
    if (nodes[0].matches('.ant-select') || nodes[0].querySelector('.ant-select')) return 'select';
    return 'unsupported';
  })(${target})`;
  const control = await getPageValue<string>(aobb, bindingId, detect);
  if (control === 'missing') throw new Error('选择目标必须恰好匹配一个元素');
  if (control === 'unsupported') throw new Error('选择目标须为 antd Select 或 Segmented');

  //M 下拉弹层由 antd 挂到页面上。分段控件直接在当前目标内找选项。
  if (control === 'select') {
    const selector = 'css=' + action.selector;
    const click = { bindingId, selector };
    await aobb.execute('page.click', click);
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
    if (item.matches('[aria-disabled=true],.ant-select-item-option-disabled,.ant-segmented-item-disabled') ||
        item.querySelector('input:disabled')) return 'disabled';
    item.click();
    return 'selected';
  })(${target}, ${label}, ${controlType})`;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    //M 等待 antd 弹层完成挂载，选中后立即结束。
    const result = await getPageValue<string>(aobb, bindingId, choose);
    if (result === 'selected') return;
    if (result === 'disabled') throw new Error('目标选项已禁用');
    if (result === 'ambiguous') throw new Error('有多个同名的可见选项');

    await timers.setTimeout(60);
  }
  throw new Error('未找到指定的可见选项');
}

/** 执行一个已经校验过的动作，保持独立标签绑定及命令顺序。 */
async function runAction(aobb: Aobb, bindingId: string, action: options.ShotAction): Promise<void> {
  if (action.kind === 'scroll') return scroll(aobb, bindingId, action);
  if (action.kind === 'select') return select(aobb, bindingId, action);

  const selector = 'css=' + action.selector;
  const target = { bindingId, selector };
  if (action.kind === 'click') {
    //M 点击保留原来传给 AOBB 的 CSS 定位规则。
    await aobb.execute('page.click', target);
    return;
  }

  const input = { ...target, value: action.value };
  //M 交给 AOBB 填写控件，输入后可选在同一控件按回车。
  await aobb.execute('page.type', input);
  if (!action.enter) return;

  const press = { ...target, key: 'Enter' };
  await aobb.execute('page.press', press);
}

/** 记录动作完成后页面跨过两次 requestAnimationFrame 的耗时。 */
async function getFrameTime(aobb: Aobb, bindingId: string): Promise<number> {
  const expression = String.raw`new Promise(resolve => {
    const start = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
  })`;
  const elapsed = await getPageValue<number>(aobb, bindingId, expression);
  return Math.round(elapsed * 10) / 10;
}

/** 在导航前限制外部请求和弹窗，按需设置自己的截图宽度。 */
async function preparePage(aobb: Aobb, bindingId: string, width: number | undefined): Promise<void> {
  //M 只在这一页允许回环 HTTP。导航重定向和点击也使用这条规则。
  const urls = ['http://*', 'https://*', 'file://*', 'ftp://*'];
  const urlPatterns = [
    { urlPattern: 'http://127.0.0.1:*/*', block: false },
    { urlPattern: 'http://localhost:*/*', block: false },
  ];
  const network = { urls, urlPatterns };
  await pageCdp(aobb, bindingId, 'Network.setBlockedURLs', network);

  //M 页内脚本在站点脚本之前运行，把点击约束在自己的标签页。
  await pageCdp(aobb, bindingId, 'Page.enable');
  const script = { source: SINGLE_TAB };
  await pageCdp(aobb, bindingId, 'Page.addScriptToEvaluateOnNewDocument', script);
  if (width === undefined) return;

  //M 手机宽按 CSS 像素设置，无需调整用户的桌面窗口。
  const viewport = { width, height: 844, deviceScaleFactor: 1, mobile: false };
  await pageCdp(aobb, bindingId, 'Emulation.setDeviceMetricsOverride', viewport);
}

/** 读取页面状态和可见文字；敏感节点的显示状态在同一段脚本里恢复。 */
async function getDetails(aobb: Aobb, bindingId: string, shot: options.ShotOptions): Promise<PageDetails> {
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
          //M 恢复前保留整段内联样式。隐藏整个敏感节点及其后代的文字。
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
  const args = { expression, returnByValue: true };
  //G 读取结果只接受当前页的标题、状态和文字，失败时不导出。
  const result = await pageCdp(aobb, bindingId, 'Runtime.evaluate', args) as {
    result?: { result?: { value?: PageDetails } };
  };
  const value = result.result?.result?.value;
  if (value === undefined) throw new Error('AOBB 未返回页面状态');

  //G 浏览器会省去显式的默认 80 端口，补齐后用与输入同一套回环规则。
  const address = value.url.replace(/^(http:\/\/(?:127\.0\.0\.1|localhost))(?=\/)/iu, '$1:80');
  options.getLocalUrl(address);
  return value;
}

/** 通过 AOBB 截取本地网页，成功或失败都只关闭自己的标签页。 */
export async function takeShot(project: string, shot: options.ShotOptions): Promise<ShotResult> {
  const endpoint = await getEndpoint(project);
  const directory = path.dirname(shot.out);
  const cache = path.resolve(options.CACHE_ROOT);
  const tempDir = path.join(cache, '临时');

  //M 截图目录和 AOBB 临时目录都限定在任务授权的位置。
  await createDirectory(shot.outputRoot, directory);
  await createDirectory(cache, tempDir);
  const library = path.resolve(project, '..', 'AOBB', 'src', 'index.ts');
  const moduleUrl = url.pathToFileURL(library).href;
  const module = await import(moduleUrl);
  const settings = { screenshotDir: directory, tempDir, downloadDir: tempDir, timeout: 15_000 };
  const aobb: Aobb = new module.LocalAobb(settings);

  let bindingId = '';
  try {
    //M 连接已探测的本地浏览器，从空白页开始准备此任务的标签。
    await aobb.execute('browser.connect', { endpoint });
    const page = await aobb.execute('page.new', {}) as { bindingId: string };
    bindingId = page.bindingId;
    await preparePage(aobb, bindingId, shot.width);
    const navigation = { bindingId, url: shot.url, waitUntil: 'domcontentloaded' };
    await aobb.execute('page.navigate', navigation);
    const timings: NonNullable<ShotResult['timings']> = [];
    for (const action of shot.actions) {
      //M 动作按命令行顺序执行，按需记录同一次操作之后的双帧时间。
      await runAction(aobb, bindingId, action);
      if (shot.timing) {
        const ms = await getFrameTime(aobb, bindingId);
        timings.push({ action: action.kind, ms });
      }
    }
    await timers.setTimeout(shot.waitMs);
    const details = await getDetails(aobb, bindingId, shot);
    const filename = path.basename(shot.out);
    const screenshot = { bindingId, filename, fullPage: true, allowSensitive: !shot.mask };

    //M AOBB 独占创建 PNG，避免并行任务的同名输出互相覆盖。
    await aobb.execute('page.screenshot', screenshot);
    const title = details.title.slice(0, 300);
    const result: ShotResult = { out: shot.out, title, status: details.status };
    if (shot.timing) {
      result.timings = timings;
    }
    if (details.text === undefined) return result;

    //M 可见文字与图片同名，独占创建确保并行任务互不覆盖。
    const text = shot.out.slice(0, -4) + '.txt';
    await fs.writeFile(text, details.text, { encoding: 'utf8', flag: 'wx' });
    return { ...result, text };
  } finally {
    try {
      //M 关闭本次拿到绑定的页面。连接失败或未建页时直接断开。
      if (bindingId !== '') await aobb.execute('page.close', { bindingId });
    } finally {
      await aobb.close();
    }
  }
}
