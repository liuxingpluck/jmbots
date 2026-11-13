/**
 * 斜杠命令的弹出列表（docs/界面/01_界面设计.md 第 7.3 节）：Tiptap 的 Suggestion 插件认出 /，这里画列表、管 ↑↓ Enter Esc。
 * 列表挂在 body 上，位置由 Suggestion 的 mount 跟着光标走。命令本身在 SlashCommands.ts 的登记表里。
 */
import * as react from 'react';
import * as reactDomClient from 'react-dom/client';
import * as tiptapReact from '@tiptap/react';
import * as suggestion from '@tiptap/suggestion';
import * as i18n from '../I18n.ts';
import * as slash from './SlashCommands.ts';


/**
 * 列表。
 * @param props items 过滤后的命令；selected 选中第几个；onPick 点了第几个；t 翻译函数（列表在独立 React 根里，不能 useT）。
 */
function SlashList(props: { items: slash.SlashCommand[]; selected: number; onPick: (index: number) => void; t: i18n.Translate }): react.JSX.Element {
  if (props.items.length === 0) {
    return <div className="jm-slash jm-slash-empty">{props.t('没有这个命令')}</div>;
  }
  return (
    <div className="jm-slash" role="listbox" aria-label={props.t('斜杠命令')}>
      {props.items.map((command, index) => (
        <button
          key={command.name}
          type="button"
          role="option"
          aria-selected={index === props.selected}
          className={index === props.selected ? 'jm-slash-item jm-active' : 'jm-slash-item'}
          onMouseDown={(event) => {
            //M 按下时就选，免得输入框先失焦、列表先关掉。
            event.preventDefault();
            props.onPick(index);
          }}
        >
          <span className="jm-slash-name">/{props.t(command.name)}</span>
          <span className="jm-slash-hint">{props.t(command.hint)}</span>
          <span className="jm-slash-group">{props.t(command.group)}</span>
        </button>
      ))}
    </div>
  );
}


/**
 * 斜杠命令的扩展。
 * @param getContext 执行命令时拿界面的几个动作（每次执行时现取，拿到的是最新的）。
 * @param t 翻译函数（列表在独立 React 根里，不能 useT，由调用方传进来）。
 * @returns Tiptap 扩展（优先级高于“Enter 发送”，列表开着时 Enter 是选命令）。
 */
export function createSlashExtension(getContext: () => slash.SlashActions, t: i18n.Translate): tiptapReact.Extension {
  return tiptapReact.Extension.create({
    name: 'slashCommand',
    priority: 1100,
    addProseMirrorPlugins() {
      return [
        suggestion.default<slash.SlashCommand, slash.SlashCommand>({
          editor: this.editor,
          char: '/',
          items: ({ query }) => slash.filterCommands(query),
          command: ({ editor, range, props }) => {
            editor.chain().focus().deleteRange(range).run();
            props.run({ ...getContext(), editor });
          },
          render: () => {
            /** 挂列表的元素和 React 根。 */
            let element: HTMLDivElement | null = null;
            let root: reactDomClient.Root | null = null;
            /** 撤掉位置跟随。 */
            let unmount: (() => void) | null = null;
            /** 现在的命令、选中第几个、执行函数。 */
            let items: slash.SlashCommand[] = [];
            let selected = 0;
            let pick: (command: slash.SlashCommand) => void = () => undefined;
            /** 重画。 */
            const paint = (): void => {
              root?.render(
                <SlashList
                  items={items}
                  selected={selected}
                  t={t}
                  onPick={(index) => {
                    /** 点的那条。 */
                    const command = items[index];
                    if (command) {
                      pick(command);
                    }
                  }}
                />,
              );
            };
            return {
              onStart: (props) => {
                element = document.createElement('div');
                element.className = 'jm-slash-host';
                root = reactDomClient.createRoot(element);
                items = props.items;
                selected = 0;
                pick = props.command;
                paint();
                unmount = props.mount(element);
              },
              onUpdate: (props) => {
                items = props.items;
                selected = Math.min(selected, Math.max(items.length - 1, 0));
                pick = props.command;
                paint();
              },
              onKeyDown: ({ event, view }) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  /** 挪一格（转圈）。 */
                  const step = event.key === 'ArrowDown' ? 1 : -1;
                  selected = items.length === 0 ? 0 : (selected + step + items.length) % items.length;
                  paint();
                  return true;
                }
                /** 选中的那条。 */
                const chosen = items[selected];
                if ((event.key === 'Enter' || event.key === 'Tab') && chosen) {
                  pick(chosen);
                  return true;
                }
                if (event.key === 'Escape') {
                  suggestion.exitSuggestion(view);
                  return true;
                }
                return false;
              },
              onExit: () => {
                unmount?.();
                root?.unmount();
                element?.remove();
                element = null;
                root = null;
                unmount = null;
              },
            };
          },
        }),
      ];
    },
  });
}
