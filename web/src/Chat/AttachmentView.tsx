/**
 * 附件的样子（docs/界面/01_界面设计.md 第 7.1 节）：图片直接显示缩略图，音频、视频直接能播放，别的文件是小卡片（图标、名字、大小）。
 * 点图片、点卡片在右栏预览。音频、视频只是能放；模型现在还不会理解它们，界面不假装它听懂了。
 */
import * as icons from '@ant-design/icons';
import type * as react from 'react';
import * as api from '../Api.ts';
import * as attachments from './Attachments.ts';
import type * as types from '../Types.ts';


/** 附件的属性。 */
interface AttachmentViewProps {
  /** 路径、名字、类别（大小可能没有）。 */
  attachment: { path: string; name: string; kind: types.AttachmentKind; size?: number | null };
  /** 点了要在右栏打开。 */
  onOpen: (target: { path: string; name: string }) => void;
}


/**
 * 一个附件。
 * @param props 附件和点了怎么办。
 */
export function AttachmentView(props: AttachmentViewProps): react.JSX.Element {
  /** 附件。 */
  const item = props.attachment;
  /** 文件地址。 */
  const url = api.fileUrl(item.path);
  /** 打开预览。 */
  const open = (): void => props.onOpen({ path: item.path, name: item.name });
  if (item.kind === 'image') {
    return (
      <button type="button" className="jm-att jm-att-image" onClick={open} title={item.path}>
        <img src={url} alt={item.name} loading="lazy" />
      </button>
    );
  }
  if (item.kind === 'audio' || item.kind === 'video') {
    return (
      <span className={`jm-att jm-att-media jm-att-${item.kind}`}>
        {item.kind === 'audio' ? <audio controls preload="metadata" src={url} /> : <video controls preload="metadata" src={url} />}
        <button type="button" className="jm-att-caption" onClick={open} title={item.path}>
          {item.kind === 'audio' ? <icons.SoundOutlined /> : <icons.VideoCameraOutlined />}
          <span>{item.name}</span>
          <span className="jm-muted">{attachments.formatSize(item.size)}</span>
        </button>
      </span>
    );
  }
  return (
    <button type="button" className="jm-att jm-att-file" onClick={open} title={item.path}>
      <icons.FileTextOutlined />
      <span className="jm-att-name">{item.name}</span>
      <span className="jm-muted">{attachments.formatSize(item.size)}</span>
    </button>
  );
}
