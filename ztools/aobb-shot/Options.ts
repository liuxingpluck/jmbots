/** AOBB 多开舱截图的参数边界，命令审核与 CLI 入口共用。 */
import * as path from 'node:path';

/** 专用缓存目录是任务板约定的另一处输出根。 */
export const CACHE_ROOT = 'F:/aidata/cache/aobb-shot';

/** AOBB 多开舱默认本机回环 HTTP API 根地址。 */
export const DEFAULT_DOCK_URL = 'http://127.0.0.1:30098';

/** 只接受一个 data 属性，可带元素名和等值。单引号在 Windows cmd 中按原样传递。 */
const ATTRIBUTE_SELECTOR =
  /^(?:[a-z][a-z0-9-]*)?\[data-[a-z][a-z0-9-]*(?:=(?:[a-z_][a-z0-9_-]*|'[a-z0-9_-]+'))?\]$/iu;

/** 能在一次截图内按参数顺序执行的页面动作。 */
export type ShotAction =
  | {
      /** 动作类型：点击目标元素。 */
      kind: 'click';
      /** CSS 选择器。 */
      selector: string;
    }
  | {
      /** 动作类型：滚动页面或指定容器。 */
      kind: 'scroll';
      /** 滚动目标，page 或单个 data 属性选择器。 */
      target: string;
      /** 相对滚动像素数或直接滚到底部的 bottom。 */
      distance: number | 'bottom';
    }
  | {
      /** 动作类型：向输入框写入文字。 */
      kind: 'type';
      /** 单个 data 属性选择器。 */
      selector: string;
      /** 输入的纯文本内容。 */
      value: string;
      /** 输入后是否在同一控件按回车。 */
      enter: boolean;
    }
  | {
      /** 动作类型：在 antd Select 或 Segmented 中按文字选中一项。 */
      kind: 'select';
      /** 单个 data 属性选择器。 */
      selector: string;
      /** 完整可见选项文字。 */
      label: string;
    };

/** 支持重复出现的动作参数名。 */
const ACTION_FLAGS = ['--click', '--scroll', '--type', '--type-enter', '--select'] as const;

/** 允许重复的动作开关联合类型。 */
type ActionFlag = (typeof ACTION_FLAGS)[number];

/** 截图任务已经校验的参数。 */
export interface ShotOptions {
  /** 只允许指定端口的 HTTP 回环目标页面地址。 */
  url: string;
  /** 指定目录内的 PNG 文件绝对路径。 */
  out: string;
  /** 输出路径命中的授权根目录。 */
  outputRoot: string;
  /** AOBB 多开舱接口根地址（不带末尾斜杠）。 */
  baseUrl: string;
  /** 可选指定的浏览器配置编号或名称；省略时自动选用已运行实例。 */
  profile?: string;
  /** 可选页面宽度约束（像素）；省略时沿用浏览器当前窗口宽度。 */
  width?: number;
  /** 导航和动作完成后等待页面稳定的毫秒数。 */
  waitMs: number;
  /** 按命令行顺序执行的页面动作列表。 */
  actions: ShotAction[];
  /** 是否记录每个动作后的双动画帧耗时。 */
  timing: boolean;
  /** 是否同时保存可见文字到同名 .txt 文件。 */
  text: boolean;
  /** 是否遮住页面敏感内容。 */
  mask: boolean;
}

/** 识别可重复的动作开关；普通截图参数仍只接受一次。 */
function getActionFlag(flag: string | undefined): ActionFlag | undefined {
  return ACTION_FLAGS.find((name) => name === flag);
}

/** 从命令实参取出一个值，缺省时报告具体缺少哪个选项的值。 */
function getValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value === '' || value.startsWith('--')) {
    throw new Error(`${flag} 缺少值`);
  }

  return value;
}

/** 解码 Base64url 文本；解码后仍须走各自的参数校验。 */
function getDecoded(value: string): string {
  if (!/^[a-z0-9_-]{0,8192}$/iu.test(value)) {
    throw new Error('Base64url 编码无效');
  }

  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) {
    throw new Error('Base64url 编码无效');
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  return decoder.decode(bytes);
}

/** 检查字符串是否包含 ASCII 控制字符（0x00–0x1F 或 0x7F）。 */
function hasControlChar(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** 解析输入文字或选项名；用 b64= 表示空输入，含空格或特殊字符时可编码。 */
function getActionText(value: string): string {
  let decoded = value;
  if (value.startsWith('b64=')) {
    const encoded = value.slice(4);
    decoded = getDecoded(encoded);
  }
  if (decoded.length > 2000 || hasControlChar(decoded)) {
    throw new Error('动作文字须为单行且不超过 2000 字');
  }

  return decoded;
}

/** 校验 --profile 参数，支持明文或 b64= 编码的单行配置编号/名称。 */
function getProfileValue(value: string): string {
  let decoded = value;
  if (value.startsWith('b64=')) {
    const encoded = value.slice(4);
    decoded = getDecoded(encoded);
  }
  const trimmed = decoded.trim();
  if (trimmed === '' || trimmed.length > 128 || hasControlChar(trimmed)) {
    throw new Error('配置编号或名称须为 1 到 128 字的单行文本');
  }

  return trimmed;
}

/** 校验动作目标和实参，执行层只接收结构化动作。 */
function getAction(flag: ActionFlag, selector: string, value: string): ShotAction {
  //G 原点击的 CSS 语法继续可用，新动作限定为单个 data 属性目标。
  if (flag === '--click') {
    if (selector.length > 256 || /[\r\n]|>>/u.test(selector)) {
      throw new Error('点击选择器不超过 256 字');
    }

    return { kind: 'click', selector };
  }

  const element = ATTRIBUTE_SELECTOR.test(selector) && selector.length <= 256;
  if (flag === '--scroll') {
    if (!element && selector !== 'page') {
      throw new Error('滚动目标须为 page 或单个 data 属性选择器');
    }
    if (value === 'bottom') return { kind: 'scroll', target: selector, distance: value };

    //G 允许负数向上滚，保留可控的像素范围。
    const distance = Number(value);
    if (!/^-?\d{1,6}$/u.test(value) || Math.abs(distance) > 100_000) {
      throw new Error('滚动像素须为 ±100000 以内整数');
    }

    return { kind: 'scroll', target: selector, distance };
  }
  if (!element) {
    throw new Error('输入和选择需要单个 data 属性选择器');
  }

  //M 文字按值传给页面，可包含标点、空格及中文。
  const text = getActionText(value);
  if (flag === '--select') {
    if (text.trim() === '') {
      throw new Error('下拉选项文字不能为空');
    }

    return { kind: 'select', selector, label: text };
  }
  return { kind: 'type', selector, value: text, enter: flag === '--type-enter' };
}

/**
 * 校验目标网页回环地址，保留 URL 的原始端口和百分号编码。
 * @param value 待校验的网页 URL。
 * @returns 校验通过的原始 URL 字符串。
 */
export function getLocalUrl(value: string): string {
  const raw = /^http:\/\/(?:127\.0\.0\.1|localhost):([0-9]{1,5})(?=[/?#]|$)/iu.exec(value);
  if (raw === null || /[\s\\]/u.test(value)) {
    throw new Error('URL 只允许带端口的 http://127.0.0.1 或 http://localhost');
  }

  const port = Number(raw[1]);
  if (port < 1 || port > 65535) {
    throw new Error('URL 的端口要在 1 到 65535 之间');
  }

  //G URL 解析器再确认它确实是 HTTP 回环，避免错误的主机写法被浏览器规范化。
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')) {
    throw new Error('URL 必须是 HTTP 回环地址');
  }

  return value;
}

/**
 * 校验 AOBB 多开舱根地址（仅限带端口的本机回环 HTTP origin，去掉末尾斜杠）。
 * @param value CLI --base-url 或环境变量 AOBB_DOCK_URL 的原始值。
 * @returns 规范化后的多开舱根地址，如 http://127.0.0.1:30098。
 */
export function getDockBaseUrl(value: string): string {
  const raw = /^http:\/\/(?:127\.0\.0\.1|localhost):([0-9]{1,5})\/?$/iu.exec(value);
  if (raw === null || /[\s\\]/u.test(value)) {
    throw new Error('AOBB 多开舱地址只允许带端口的 http://127.0.0.1 或 http://localhost');
  }

  const port = Number(raw[1]);
  if (port < 1 || port > 65535) {
    throw new Error('AOBB 多开舱端口要在 1 到 65535 之间');
  }

  const parsed = new URL(value);
  const validHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  const cleanOrigin = parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
  if (parsed.protocol !== 'http:' || !validHost || !cleanOrigin || parsed.username !== '' || parsed.password !== '') {
    throw new Error('AOBB 多开舱地址须为不含路径与查询串的本机 HTTP 根地址');
  }

  return parsed.origin;
}

/**
 * 判断 Windows 路径是否严格落在授权目录内。
 * @param root 授权根目录。
 * @param file 待检查的文件绝对路径。
 * @returns 严格落在目录内时返回 true。
 */
export function isUnder(root: string, file: string): boolean {
  const relative = path.win32.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative);
}

/** 校验输出文件路径并解析命中的授权根目录。 */
function resolveOutputPath(file: string, projectRoot: string): { out: string; outputRoot: string } {
  const drive = path.win32.parse(file).root;
  if (/^[/\\]|(?:^|[/\\])\.\.(?=[/\\]|$)/u.test(file)) {
    throw new Error('输出路径不得回退或从盘根起算');
  }

  const tail = file.slice(drive.length);
  if (/[<>:"|?*]/u.test(tail) || hasControlChar(tail) || /^[a-z]:(?![\\/])/iu.test(file)) {
    throw new Error('输出路径包含无效字符');
  }

  const segments = tail.split(/[\\/]/u);
  for (const segment of segments) {
    //G Windows 会规范化末尾空格和句点，拒绝可能被解释成别的路径或设备名的段。
    if (/[. ]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment)) {
      throw new Error('输出路径包含 Windows 保留名称或不规范的目录段');
    }
  }

  const out = path.win32.resolve(projectRoot, file);
  if (!out.toLowerCase().endsWith('.png')) {
    throw new Error('输出文件必须是 PNG');
  }

  const docs = path.win32.join(projectRoot, 'docs', '开发进度');
  const roots = [docs, CACHE_ROOT];
  //G 只承认两个目录内的文件，路径前缀恰好相同的兄弟目录也挡掉。
  const outputRoot = roots.find((root) => isUnder(root, out));
  if (outputRoot === undefined) {
    throw new Error('输出路径不在开发进度或 aobb-shot 缓存目录');
  }

  return { out, outputRoot };
}

/**
 * 校验必填项、唯一开关、多开舱地址及输出目录，返回结构化参数。
 * @param args 命令行参数数组（不含程序名和脚本路径）。
 * @param projectRoot 仓库根目录，用于解析相对输出路径。
 * @param env 可选环境变量源（支持 AOBB_DOCK_URL）；省略时不读宿主环境。
 * @returns 已通过全部边界校验的截图参数对象。
 */
export function getShotOptions(
  args: string[],
  projectRoot: string,
  env: Record<string, string | undefined> = {},
): ShotOptions {
  const seen = new Set<string>();
  const actions: ShotAction[] = [];
  let url = '';
  let file = '';
  let baseUrl = '';
  let profile: string | undefined;
  let width: number | undefined;
  let waitMs = 800;
  let text = false;
  let timing = false;
  let mask = true;

  //==========================================================
  //M 逐项解析命令行参数：动作可重复，其他开关均只接受一次
  //==========================================================
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) {
      break;
    }

    const actionFlag = getActionFlag(flag);
    if (actionFlag !== undefined) {
      //G 动作可重复，所有种类合计最多十个。
      if (actions.length === 10) {
        throw new Error('每次截图最多十个动作');
      }

      const selector = getValue(args, index + 1, flag);
      index += 1;
      let value = '';
      if (actionFlag !== '--click') {
        value = getValue(args, index + 1, flag);
        index += 1;
      }
      //M 按出现顺序保存，各动作消费各自的参数。
      const action = getAction(actionFlag, selector, value);
      actions.push(action);
      continue;
    }

    if (seen.has(flag)) {
      throw new Error('重复的截图选项');
    }

    seen.add(flag);
    if (flag === '--text') {
      text = true;
      continue;
    }
    if (flag === '--timing') {
      timing = true;
      continue;
    }

    //G 其它选项都要跟一个值，禁止把后面的开关吞成参数值。
    const value = getValue(args, index + 1, flag);
    index += 1;
    if (flag === '--url' || flag === '--url-b64') {
      if (url !== '') {
        throw new Error('只给一种 URL 参数');
      }

      //M Base64url 解码后仍用回环 URL 校验。
      let address = value;
      if (flag === '--url-b64') {
        address = getDecoded(value);
      }
      url = getLocalUrl(address);
      continue;
    }
    if (flag === '--out') {
      file = value;
      continue;
    }
    if (flag === '--base-url') {
      baseUrl = getDockBaseUrl(value);
      continue;
    }
    if (flag === '--profile') {
      profile = getProfileValue(value);
      continue;
    }
    if (flag === '--width') {
      const size = Number(value);
      if (!/^\d{1,4}$/u.test(value) || size < 240 || size > 3840) {
        throw new Error('宽度要在 240 到 3840 之间');
      }

      width = size;
      continue;
    }
    if (flag === '--wait-ms') {
      const delay = Number(value);
      if (!/^\d{1,5}$/u.test(value) || delay > 10_000) {
        throw new Error('等待毫秒数要在 0 到 10000 之间');
      }

      waitMs = delay;
      continue;
    }
    if (flag === '--mask') {
      if (value !== 'off' && value !== 'on') {
        throw new Error('遮罩参数只允许 on 或 off');
      }

      mask = value === 'on';
      continue;
    }
    throw new Error('不认识的截图选项');
  }

  //==========================================================
  //M 收尾校验：必填项、多开舱地址优先级及输出路径授权根
  //==========================================================
  if (url === '' || file === '') {
    throw new Error('要给 --url 和 --out');
  }

  //M 优先级：CLI --base-url > 环境变量 AOBB_DOCK_URL > 默认 127.0.0.1:30098。
  if (baseUrl === '') {
    const envDockUrl = env['AOBB_DOCK_URL']?.trim() ?? '';
    if (envDockUrl !== '') {
      baseUrl = getDockBaseUrl(envDockUrl);
    }
  }
  if (baseUrl === '') {
    baseUrl = DEFAULT_DOCK_URL;
  }

  const resolved = resolveOutputPath(file, projectRoot);
  return {
    url,
    out: resolved.out,
    outputRoot: resolved.outputRoot,
    baseUrl,
    profile,
    width,
    waitMs,
    actions,
    timing,
    text,
    mask,
  };
}

/**
 * 识别单独调用固定截图脚本的命令，供审批白名单使用。
 * @param command 原始命令字符串。
 * @param projectRoot 仓库根目录。
 * @returns 完全满足白名单约束时返回 true。
 */
export function isAobbShotCommand(command: string, projectRoot: string): boolean {
  if (/[\r\n\v\f]/u.test(command) || command.includes('\0')) return false;

  //G 不接受 cd、chcp、其他 wrapper、重定向或第二条命令。
  const prefix = /^bun(?:\.cmd)?[ \t]+ztools[\\/]aobb-shot[\\/]Aobb_Shot\.ts[ \t]+/iu.exec(command);
  if (prefix === null) return false;

  const raw = command.slice(prefix[0].length).trim();
  const tokens = raw.split(/[ \t]+/u);
  const args: string[] = [];
  for (const token of tokens) {
    //G 只有 --url 后允许一对完整双引号，且 & 只准出现在该引号内。
    if (/^"[\p{L}\p{N}_.:/=?&#-]+"$/u.test(token) && args.at(-1) === '--url') {
      const value = token.slice(1, -1);
      args.push(value);
      continue;
    }

    //G 方括号只在动作目标位置进入命令，且只接受单个 data 属性。
    const previous = args.at(-1);
    const actionFlag = getActionFlag(previous);
    if (actionFlag !== undefined && ATTRIBUTE_SELECTOR.test(token)) {
      args.push(token);
      continue;
    }
    if (!/^[\p{L}\p{N}_.:/\\=?#-]+$/u.test(token)) return false;

    //G cmd 即使在引号里也会展开百分号，带百分号的 URL 通过 --url-b64。
    args.push(token);
  }
  try {
    //M 白名单和程序共用参数解释，未知选项、越界输出和外部 URL 都不能直通审核。
    getShotOptions(args, projectRoot, {});
    return true;
  } catch {
    return false;
  }
}
