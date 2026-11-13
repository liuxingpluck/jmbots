/**
 * 输入框上方的附件（docs/界面/01_界面设计.md 第 7.2 节）：选中（拖进来、粘贴、选文件）就开始上传，原始字节，带进度；
 * 能删；发送时只发传完的上传号。图片在本地先做缩略图（blob 地址），删掉或发完时放掉。
 */
import * as react from 'react';
import * as api from '../Api.ts';
import * as i18n from '../I18n.ts';
import * as attachments from './Attachments.ts';
import type * as types from '../Types.ts';


/** 一个待发的附件。 */
export interface PendingAttachment {
  /** 列表里的键。 */
  key: string;
  /** 文件名。 */
  name: string;
  /** 大小，字节。 */
  size: number;
  /** 类别。 */
  kind: types.AttachmentKind;
  /** 上传进度，0～1。 */
  progress: number;
  /** 传完以后的上传号。 */
  uploadId?: string;
  /** 传失败的原因。 */
  error?: string;
  /** 图片的本地缩略图地址。 */
  preview?: string;
}


/** 附件的数据和动作。 */
export interface AttachmentsState {
  /** 待发的附件。 */
  items: PendingAttachment[];
  /** 加几个文件（马上开始上传）。 */
  add: (files: File[]) => void;
  /** 删一个。 */
  remove: (key: string) => void;
  /** 全部清掉（发完、/清空）。 */
  clear: () => void;
  /** 还有没传完的。 */
  uploading: boolean;
  /** 传完的上传号。 */
  uploadIds: string[];
}


/** 下一个键的编号。 */
let nextKey = 1;


/**
 * 从剪贴板或拖放里取出文件。
 * @param data ClipboardEvent.clipboardData 或 DragEvent.dataTransfer。
 */
export function filesFrom(data: DataTransfer | null | undefined): File[] {
  return data ? [...data.files] : [];
}


/** 输入框上方的附件。 */
export function useAttachments(): AttachmentsState {
  const t = i18n.useT();
  /** 待发的附件。 */
  const [items, setItems] = react.useState<PendingAttachment[]>([]);

  /** 改一个。 */
  const patch = react.useCallback((key: string, change: Partial<PendingAttachment>) => {
    setItems((old) => old.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }, []);

  /** 加几个文件。 */
  const add = react.useCallback(
    (files: File[]) => {
      for (const file of files) {
        /** 键。 */
        const key = `a${nextKey}`;
        nextKey += 1;
        /** 类别：先看浏览器给的类型，再看扩展名。 */
        const kind = file.type.startsWith('image/') ? 'image' : attachments.attachmentKind(file.name);
        setItems((old) => [...old, { key, name: file.name || t('粘贴的图片.png'), size: file.size, kind, progress: 0, preview: kind === 'image' ? URL.createObjectURL(file) : undefined }]);
        api.uploadFile(file, (ratio) => patch(key, { progress: ratio })).then(
          (result) => patch(key, { progress: 1, uploadId: result.id }),
          (error: unknown) => patch(key, { error: error instanceof Error ? error.message : String(error) }),
        );
      }
    },
    [patch, t],
  );

  /** 删一个。 */
  const remove = react.useCallback((key: string) => {
    setItems((old) => {
      /** 要删的。 */
      const gone = old.find((item) => item.key === key);
      if (gone?.preview) {
        URL.revokeObjectURL(gone.preview);
      }
      return old.filter((item) => item.key !== key);
    });
  }, []);

  /** 全部清掉。 */
  const clear = react.useCallback(() => {
    setItems((old) => {
      for (const item of old) {
        if (item.preview) {
          URL.revokeObjectURL(item.preview);
        }
      }
      return [];
    });
  }, []);

  /** 还有没传完的（传失败的不算，会被提示删掉）。 */
  const uploading = items.some((item) => !item.uploadId && !item.error);
  /** 传完的上传号。 */
  const uploadIds = items.flatMap((item) => (item.uploadId ? [item.uploadId] : []));
  return { items, add, remove, clear, uploading, uploadIds };
}
