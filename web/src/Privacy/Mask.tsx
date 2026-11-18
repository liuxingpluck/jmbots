/**
 * 网页共用的演示打码：默认关，演示时在 /graph/、/memory/、/wechat-kefu/ 手动打开。
 * 只有 localStorage 里明确写了 on 才打码；原始 API 数据不改，在渲染边界生成打码副本，同页与同源标签同步。
 */
import * as react from 'react';
import * as i18n from '../I18n.ts';


/** 客服、聊天、记忆和关系图共用的持久化键。 */
export const KEY = 'jmbots.wechat.mask';
/** 当前页面主动切换时通知所有订阅组件。 */
const CHANGE = 'jmbots-mask-change';


/**
 * 读演示状态；默认关，只有明确写了 on 才开，读不到存储也算关；无副作用。
 * @returns 是否开启演示打码。
 */
export function getMask(): boolean {
  try {
    //M 只认 on，旧逻辑写下的 off 和没写都算关
    return window.localStorage.getItem(KEY) === 'on';
  } catch {
    //M 存储不可用时按默认关
    return false;
  }
}


/**
 * 设置打码并同步当前页面；打开写 on，关闭删掉键。
 * @param enabled true 开启打码，false 关闭打码。
 * 副作用：修改 localStorage 中的 KEY 键并向 window 派发 CHANGE 自定义事件。
 */
export function setMask(enabled: boolean): void {
  try {
    //M 打开写 on，关闭删键回到默认关
    if (enabled) {
      window.localStorage.setItem(KEY, 'on');
    }
    if (!enabled) {
      window.localStorage.removeItem(KEY);
    }
  } catch {
    //M 存储不可用时 getMask 返回关，演示时打不开就算了
  }
  window.dispatchEvent(new Event(CHANGE));
}


/** 订阅本页切换、其他同源标签和页面恢复；不缓存过期的开关值。 */
function subscribe(notify: () => void): () => void {
  const storage = (event: StorageEvent): void => {
    if (event.key === KEY || event.key === null) {
      notify();
    }
  };
  window.addEventListener(CHANGE, notify);
  window.addEventListener('storage', storage);
  window.addEventListener('pageshow', notify);
  return () => {
    window.removeEventListener(CHANGE, notify);
    window.removeEventListener('storage', storage);
    window.removeEventListener('pageshow', notify);
  };
}


/**
 * React 页面共用订阅；首屏读真实持久化值，服务端快照按默认关；无副作用。
 * @returns 当前演示打码是否开启。
 */
export function useMask(): boolean {
  //M 服务端快照也是默认关
  return react.useSyncExternalStore(subscribe, getMask, () => false);
}


/**
 * 姓名或客户号只留第一个 Unicode 字符，不在 title 中保留原值；无副作用。
 * @param value 原始姓名或客户号。
 * @param enabled 是否开启演示打码。
 * @returns 脱敏后的前缀或原字符串。
 */
export function name(value: string, enabled: boolean): string {
  if (!enabled || value === '') return value;

  return `${Array.from(value)[0]}**`;
}


/**
 * 正文、错误、工具结果等整段隐藏，避免只替换账号却留下客户谈话；无副作用。
 * @param value 原始正文或提示文本。
 * @param enabled 是否开启演示打码。
 * @returns 遮罩占位文本或原字符串。
 */
export function text(value: string, enabled: boolean): string {
  //G 原文可见或为空时直接返回，避免每次渲染都读取语言设置。
  if (!enabled || value === '') return value;

  //M 独立网页和聊天共用打码函数，优先读地址语言，其次读浏览器设置。
  let language: i18n.Language = 'zh-CN';
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('lang');
    const explicit = i18n.matchLanguage(requested);
    try {
      language = explicit ?? i18n.loadLanguage(window.localStorage);
    } catch {
      //G 浏览器禁止访问本地存储时保留默认语言。
    }
  }

  //M 只翻译遮罩文本，保留打码对原文的遮蔽。
  const t: i18n.Translate = (label) => i18n.translate(language, label);
  return t('（已打码）');
}


/**
 * 对不依赖字符串状态的展示数据递归打码；不修改输入对象或数组，无副作用。
 * @param value 任意展示数据（字符串、数组或普通对象）。
 * @param enabled 是否开启演示打码。
 * @returns 脱敏后的只读副本或原值。
 */
export function data<T>(value: T, enabled: boolean): T {
  if (!enabled) return value;

  //M 按值类型递归脱敏：裸字符串整段替换，数组逐项递归生成新副本，不改动原始 API 数据。
  if (typeof value === 'string') return text(value, true) as T;
  if (Array.isArray(value)) return value.map((item) => data(item, true)) as T;
  if (value !== null && typeof value === 'object') {
    //M 对象自身剥离原引用并递归遮罩全部属性值，确保任意键名的展示字段都不透出原文。
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, data(item, true)])) as T;
  }
  return value;
}


/** 只保留展示和导航必需的技术字段，未知字符串默认按正文隐藏。 */
const TECHNICAL = new Set([
  'id', 'key', 'type', 'kind', 'channel', 'state', 'status', 'row', 'seq',
  'at', 'time', 'createdAt', 'updatedAt', 'startedAt', 'endedAt',
  'model', 'thinking', 'effort', 'bot', 'sessionId', 'session_id', 'parent',
  'scope', 'endSource', 'source', 'sourceKind', 'eventType', 'category',
  'role', 'level', 'action', 'used', 'provider', 'api', 'finishReason',
]);
/** 身份字段与正文分开，便于会话列表仍能区分人。 */
const IDENTITIES = new Set(['name', 'title', 'peer', 'customer', 'nickname', 'sender', 'chat', 'username', 'wxid', 'account']);
/** 原始负载即使包含技术字段也不能继续白名单放行。 */
const PAYLOADS = new Set(['event', 'stored', 'triggered', 'args', 'result', 'address', 'vars', 'payload', 'context', 'messages']);


/**
 * 生成步骤、追溯等结构化视图副本：保留技术判别，隐藏身份与所有未知正文；无副作用。
 * 原始 event/stored/triggered、参数、上下文整段递归隐藏，避免嵌套任意字段绕过。
 * @param value 任意结构化展示数据。
 * @param enabled 是否开启演示打码。
 * @returns 脱敏后的结构化副本或原值。
 */
export function record<T>(value: T, enabled: boolean): T {
  if (!enabled) return value;

  //M 数组逐项沿用结构化分级规则递归脱敏，保持列表长度与结构供界面渲染。
  if (Array.isArray(value)) return value.map((item) => record(item, true)) as T;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => {
      //M 原始负载字段内部可能带有技术字段名，必须整体走 data 彻底遮罩以免绕过白名单。
      if (PAYLOADS.has(key)) return [key, data(item, true)];
      //M 嵌套对象或数组继续按结构化白名单逐层递归脱敏。
      if (typeof item !== 'string') return [key, record(item, true)];
      //M 身份字段只留首字便于列表辨识不同对象，技术字段原样保留，其余未知字段按正文整段隐藏。
      if (IDENTITIES.has(key)) return [key, name(item, true)];
      if (TECHNICAL.has(key)) return [key, item];
      return [key, text(item, true)];
    });
    return Object.fromEntries(entries) as T;
  }

  //M 顶层或递归末尾遇到裸字符串时直接按正文整段遮罩，防止未标注键名泄密。
  if (typeof value === 'string') return text(value, true) as T;

  return value;
}


/**
 * 从渠道标记、客户号或嵌套引用识别微信数据；只读，不打印负载，无副作用。
 * @param value 待检测的渠道值、会话记录或任意嵌套对象。
 * @returns 命中微信来源标识时返回 true。
 */
export function wechat(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith('wechat:');
  if (Array.isArray(value)) return value.some(wechat);
  if (value !== null && typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    return fields['channel'] === 'wechat' || Object.values(fields).some(wechat);
  }
  return false;
}


/**
 * 演示打码开着时在页面顶端提示，点一下关掉；平常（关）不显示；不包含任何用户数据。
 * @returns 顶部提示横幅按钮，未开启打码时返回 null。
 * 副作用：点击横幅时调用 setMask(false) 清除持久化打码开关并通知页面重绘。
 */
export function MaskBanner(): react.JSX.Element | null {
  //M 订阅全局演示打码开关状态，开关变更时同步显示或隐藏顶部警示横幅。
  const enabled = useMask();
  //M 默认关，关着不占位，只在演示打开时提示
  if (!enabled) return null;

  //M 演示打码开启时在页面最顶端置顶提示，点击后立即关闭打码以免后续日常使用误留遮罩。
  return (
    <button type="button" role="alert" data-mask-banner="on"
      onClick={() => setMask(false)}
      style={{ position: 'fixed', top: 0, left: 0, right: 0, width: '100%',
        zIndex: 2147483647, minHeight: 42, border: 0, borderRadius: 0,
        background: '#b91c1c', color: '#fff', fontSize: 17, fontWeight: 800,
        padding: '10px 16px', cursor: 'pointer', boxShadow: '0 2px 8px #7f1d1d66' }}>
      演示打码已开 · 点击关闭打码
    </button>
  );
}
