/**
 * 快捷键帮助（docs/界面/01_界面设计.md 第 5、7 节）：? 打开（输入框里打字时不触发），或者 /帮助。
 */
import * as antd from 'antd';
import type * as react from 'react';
import * as i18n from '../I18n.ts';
import * as slash from './SlashCommands.ts';


/** 快捷键：按键、做什么。 */
const SHORTCUTS: [string, string][] = [
  ['Enter', '发送'],
  ['Shift+Enter 或 Alt+Enter', '换行（中文输入法选字时按 Enter 不会发送）'],
  ['/', '在行首或空格后打，弹出命令'],
  ['Ctrl+B / Ctrl+I / Ctrl+E', '粗体 / 斜体 / 行内代码'],
  ['**字**、`代码`、- 列表、> 引用、```', 'Markdown 写法，边写边变'],
  ['Ctrl+V', '粘贴：剪贴板里是图片或文件就当附件'],
  ['拖文件进窗口', '当附件发：图片、音频、视频、文档都行'],
  ['Esc', '收起右栏、关掉弹出的东西'],
  ['?', '打开这份帮助（不在输入框里时）'],
];


/**
 * 帮助弹窗。
 * @param props open 开着没有；onClose 关。
 */
export function HelpModal(props: { open: boolean; onClose: () => void }): react.JSX.Element {
  const t = i18n.useT();
  return (
    <antd.Modal open={props.open} onCancel={props.onClose} footer={null} title={t('快捷键和用法')} width={620}>
      <table className="jm-help">
        <tbody>
          {SHORTCUTS.map(([keys, text]) => (
            <tr key={keys}>
              <td>
                <kbd>{t(keys)}</kbd>
              </td>
              <td>{t(text)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4 className="jm-help-title">{t('斜杠命令')}</h4>
      <div className="jm-help-commands">
        {slash.SLASH_COMMANDS.map((command) => (
          <span key={command.name} className="jm-help-command">
            /{t(command.name)} <span className="jm-muted">{t(command.hint)}</span>
          </span>
        ))}
      </div>
    </antd.Modal>
  );
}
