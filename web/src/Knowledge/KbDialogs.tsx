/**
 * 知识库应用内轻量模态框（确认框 + 输入框），彻底替代原生 window.alert / window.confirm / window.prompt。
 * 支持 Esc 关闭、Enter 提交、焦点自动落位与危险操作警示配色。
 */
import * as react from 'react';


/** 确认弹窗配置。 */
export interface ConfirmDialogOptions {
  /** 弹窗标题。 */
  title: string;
  /** 说明正文。 */
  message: string;
  /** 确认按钮文字（默认「确定」）。 */
  confirmText?: string;
  /** 取消按钮文字（默认「取消」）。 */
  cancelText?: string;
  /** 是否属于删除等高危操作（使用红色警示按钮）。 */
  danger?: boolean;
}

/** 输入弹窗配置。 */
export interface PromptDialogOptions {
  /** 弹窗标题。 */
  title: string;
  /** 辅助说明文字。 */
  message?: string;
  /** 初始默认值。 */
  initialValue?: string;
  /** 占位提示词。 */
  placeholder?: string;
  /** 确认按钮文字（默认「确定」）。 */
  confirmText?: string;
  /** 取消按钮文字（默认「取消」）。 */
  cancelText?: string;
}

type ActiveDialog =
  | ({ kind: 'confirm'; resolve: (ok: boolean) => void } & ConfirmDialogOptions)
  | ({ kind: 'prompt'; resolve: (value: string | null) => void } & PromptDialogOptions);


/** 应用内弹窗 Hook 返回接口。 */
export interface KbDialogController {
  /** 弹出确认框，用户点确定回 true，取消或遮罩回 false。 */
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  /** 弹出单行输入框，提交回字符串，取消回 null。 */
  prompt: (options: PromptDialogOptions) => Promise<string | null>;
  /** 挂载在组件树末尾的弹窗节点。 */
  modalElement: react.JSX.Element | null;
}


/**
 * 提供无阻塞 Promise 化的应用内确认框与输入框。
 */
export function useKbDialog(): KbDialogController {
  const [dialog, setDialog] = react.useState<ActiveDialog | undefined>(undefined);
  const [inputValue, setInputValue] = react.useState('');
  const activeRef = react.useRef<ActiveDialog | undefined>(undefined);
  activeRef.current = dialog;

  //M 组件卸载时若仍有挂起弹窗，按取消结算，防止悬挂 Promise。
  react.useEffect(() => {
    return () => {
      const pending = activeRef.current;
      if (pending === undefined) return;

      if (pending.kind === 'confirm') {
        pending.resolve(false);
      } else {
        pending.resolve(null);
      }
    };
  }, []);

  const closeCancel = react.useCallback(() => {
    const current = activeRef.current;
    if (current === undefined) return;

    setDialog(undefined);
    if (current.kind === 'confirm') {
      current.resolve(false);
    } else {
      current.resolve(null);
    }
  }, []);

  const submitDialog = react.useCallback(() => {
    const current = activeRef.current;
    if (current === undefined) return;

    if (current.kind === 'confirm') {
      setDialog(undefined);
      current.resolve(true);
      return;
    }
    const trimmed = inputValue.trim();
    if (trimmed === '') return;

    setDialog(undefined);
    current.resolve(trimmed);
  }, [inputValue]);

  const confirm = react.useCallback((options: ConfirmDialogOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      const prev = activeRef.current;
      if (prev !== undefined) {
        if (prev.kind === 'confirm') {
          prev.resolve(false);
        } else {
          prev.resolve(null);
        }
      }
      setDialog({ kind: 'confirm', ...options, resolve });
    });
  }, []);

  const prompt = react.useCallback((options: PromptDialogOptions): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      const prev = activeRef.current;
      if (prev !== undefined) {
        if (prev.kind === 'confirm') {
          prev.resolve(false);
        } else {
          prev.resolve(null);
        }
      }
      setInputValue(options.initialValue ?? '');
      setDialog({ kind: 'prompt', ...options, resolve });
    });
  }, []);

  react.useEffect(() => {
    if (dialog === undefined) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dialog, closeCancel]);

  let modalElement: react.JSX.Element | null = null;
  if (dialog !== undefined) {
    const confirmLabel = dialog.confirmText ?? '确定';
    const cancelLabel = dialog.cancelText ?? '取消';
    const isDanger = dialog.kind === 'confirm' && dialog.danger === true;
    const canSubmit = dialog.kind === 'confirm' || inputValue.trim() !== '';

    let confirmBtnClass = 'kb-primary-btn';
    if (isDanger) {
      confirmBtnClass = 'kb-danger-btn kb-danger-solid';
    }

    modalElement = (
      <div className="kb-modal-layer" role="dialog" aria-modal="true" aria-label={dialog.title}>
        <div className="kb-modal-scrim" onClick={closeCancel} />
        <div className="kb-modal-card">
          <h3 className="kb-modal-title">{dialog.title}</h3>
          {dialog.message !== undefined && dialog.message !== '' && (
            <p className="kb-modal-desc">{dialog.message}</p>
          )}
          {dialog.kind === 'prompt' && (
            <input
              className="kb-modal-input"
              type="text"
              value={inputValue}
              placeholder={dialog.placeholder ?? '请输入…'}
              autoFocus
              onChange={(event) => setInputValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitDialog();
                }
              }}
            />
          )}
          <div className="kb-modal-actions">
            <button type="button" className="kb-link-btn" onClick={closeCancel}>
              {cancelLabel}
            </button>
            <button
              type="button"
              className={confirmBtnClass}
              disabled={!canSubmit}
              autoFocus={dialog.kind === 'confirm'}
              onClick={submitDialog}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return { confirm, prompt, modalElement };
}
