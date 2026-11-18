/**
 * 网址里 # 后面的东西（深链接）：#preview=<绝对路径> 在右栏预览文件，#tab= 打开右栏标签（含只读 events），
 * #settings=<分类> 打开设置的某一类，#session=<会话号> 打开右栏对应会话。纯函数好测；App.tsx 在打开和 # 变了时照它做。
 */
import * as attachments from './Chat/Attachments.ts';
import type * as storeModule from './Store.ts';


/** # 后面说要做什么。 */
export type HashAction =
  | { kind: 'preview'; target: storeModule.PanelTarget }
  | { kind: 'tab'; tab: storeModule.PanelTab }
  | { kind: 'settings'; category: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'none' };


/** 能用 #tab= 打开的标签。 */
const TABS: storeModule.PanelTab[] = [
  'preview',
  'workspace',
  'session',
  'messages',
  'approvals',
  'memory',
  'details',
  'usage',
  'events',
  'todo',
];


/**
 * 读 # 后面的东西。
 * @param hash location.hash（带不带 # 都行）。
 */
export function parseHash(hash: string): HashAction {
  /** 参数。 */
  //M 去掉前缀 # 后解析查询串，按优先级依次识别深链接指令。
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  /** 要预览的文件。 */
  //M 优先检查 #preview= 路径：拿到路径后交给右栏打开对应文件预览标签。
  const preview = params.get('preview');
  if (preview) {
    //M 从绝对路径末段取展示名作为预览标签页标题。
    return { kind: 'preview', target: { path: preview, name: attachments.getBaseName(preview) } };
  }

  /** 要打开的标签。 */
  //M 再检查 #tab=：只放行白名单内的右栏标签名，防止无效参数误切面板。
  const tab = params.get('tab');
  if (tab && (TABS as string[]).includes(tab)) {
    return { kind: 'tab', tab: tab as storeModule.PanelTab };
  }

  /** 要打开的设置分类。 */
  //M 再检查 #settings=：空串也算命中（打开设置默认页），非空则直接定位到对应分类。
  const settings = params.get('settings');
  if (settings !== null) {
    return { kind: 'settings', category: settings };
  }

  /** 要打开的会话。 */
  //M 最后检查 #session=：拿到会话号后交给 App.tsx 在右栏打开对应会话详情。
  const sessionId = params.get('session');
  if (sessionId) {
    return { kind: 'session', sessionId };
  }
  return { kind: 'none' };
}
