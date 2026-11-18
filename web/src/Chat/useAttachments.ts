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
 * @returns 提取出的文件数组；没有数据时返回空数组。
 */
export function getFilesFrom(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];

  return [...data.files];
}


/**
 * 输入框上方的附件管理 Hook。
 * @returns 待发附件状态及 add、remove、clear 控制动作。
 * 副作用：add 时生成图片本地 blob 预览地址并立即 PUT 上传文件；remove 与 clear 时释放对应的 blob 对象地址。
 */
export function useAttachments(): AttachmentsState {
  //M 订阅界面翻译函数，用来给无文件名的剪贴板图片补默认名称。
  const t = i18n.useT();
  /** 待发的附件。 */
  const [items, setItems] = react.useState<PendingAttachment[]>([]);

  /** 改一个。 */
  const patch = react.useCallback((key: string, change: Partial<PendingAttachment>) => {
    setItems((old) =>
      old.map((item) => {
        if (item.key !== key) return item;

        return { ...item, ...change };
      }),
    );
  }, []);

  /** 加几个文件。 */
  const add = react.useCallback(
    (files: File[]) => {
      for (const file of files) {
        /** 键。 */
        const key = `a${nextKey}`;
        nextKey += 1;
        /** 类别：先看浏览器给的类型，再看扩展名。 */
        //M 先按文件名后缀判别附件类型，若是浏览器识别的 image/* 再归为图片以生成本地缩略图。
        let kind = attachments.getAttachmentKind(file.name);
        if (file.type.startsWith('image/')) {
          kind = 'image';
        }
        let preview: string | undefined;
        if (kind === 'image') {
          preview = URL.createObjectURL(file);
        }
        //M 先把待发附件放进列表占位，再立即以原始字节上传并回写进度、上传号或失败原因。
        setItems((old) => [...old, { key, name: file.name || t('粘贴的图片.png'), size: file.size, kind, progress: 0, preview }]);
        api.uploadFile(file, (ratio) => patch(key, { progress: ratio })).then(
          (result) => patch(key, { progress: 1, uploadId: result.id }),
          (error: unknown) => {
            let message = String(error);
            if (error instanceof Error) {
              message = error.message;
            }
            patch(key, { error: message });
          },
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
  const uploadIds = items.flatMap((item) => {
    if (!item.uploadId) return [];

    return [item.uploadId];
  });
  return { items, add, remove, clear, uploading, uploadIds };
}
