/**
 * 网址里 # 后面的东西（深链接）：#preview=<绝对路径> 在右栏预览文件，#tab= 打开右栏标签（含只读 events），
 * #settings=<分类> 打开设置的某一类。纯函数好测；App.tsx 在打开和 # 变了时照它做。
 */
import * as attachments from './Chat/Attachments.ts';
import type * as storeModule from './Store.ts';


/** # 后面说要做什么。 */
export type HashAction =
  | { kind: 'preview'; target: storeModule.PanelTarget }
  | { kind: 'tab'; tab: storeModule.PanelTab }
  | { kind: 'settings'; category: string }
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
];


/**
 * 读 # 后面的东西。
 * @param hash location.hash（带不带 # 都行）。
 */
export function parseHash(hash: string): HashAction {
  /** 参数。 */
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  /** 要预览的文件。 */
  const preview = params.get('preview');
  if (preview) {
    return { kind: 'preview', target: { path: preview, name: attachments.baseName(preview) } };
  }
  /** 要打开的标签。 */
  const tab = params.get('tab');
  if (tab && (TABS as string[]).includes(tab)) {
    return { kind: 'tab', tab: tab as storeModule.PanelTab };
  }
  /** 要打开的设置分类。 */
  const settings = params.get('settings');
  if (settings !== null) {
    return { kind: 'settings', category: settings };
  }
  return { kind: 'none' };
}
