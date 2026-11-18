/**
 * 附件的样子（docs/界面/01_界面设计.md 第 7.1 节）：图片直接显示缩略图，音频、视频直接能播放，别的文件是小卡片（图标、名字、大小）。
 * 点图片、点卡片在右栏预览。音频、视频只是能放；模型现在还不会理解它们，界面不假装它听懂了。
 */
import * as icons from '@ant-design/icons';
import type * as react from 'react';
import * as api from '../Api.ts';
import * as privacy from '../Privacy/Mask.tsx';
import * as vscodeLink from '../VscodeLink.tsx';
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
 * @returns 按附件类别渲染的缩略图、音视频播放器或文件卡片元素。
 */
export function AttachmentView(props: AttachmentViewProps): react.JSX.Element {
  //M 读取演示打码开关，打码开启时隐藏直达 VSCode 路径的快捷按钮。
  const masked = privacy.useMask();
  /** 附件。 */
  const item = props.attachment;
  /** 文件地址。 */
  //M 生成带访问令牌的后端文件地址，供缩略图与音视频标签直接加载。
  const url = api.getFileUrl(item.path);
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
    let player = <video controls preload="metadata" src={url} />;
    let icon = <icons.VideoCameraOutlined />;
    if (item.kind === 'audio') {
      player = <audio controls preload="metadata" src={url} />;
      icon = <icons.SoundOutlined />;
    }
    //M 渲染音视频播放器、可点击右栏预览的标题与大小标签，以及未打码时的 VSCode 打开按钮。
    return (
      <span className={`jm-att jm-att-media jm-att-${item.kind}`}>
        {player}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
          <button type="button" className="jm-att-caption" onClick={open} title={item.path}>
            {icon}
            <span>{item.name}</span>
            <span className="jm-muted">{attachments.formatSize(item.size)}</span>
          </button>
          {!masked && <vscodeLink.VsCodeOpen site={item.path} />}
        </span>
      </span>
    );
  }
  //M 渲染普通文件卡片、格式化后的文件大小与未打码时的 VSCode 跳转入口。
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
      <button type="button" className="jm-att jm-att-file" onClick={open} title={item.path}>
        <icons.FileTextOutlined />
        <span className="jm-att-name">{item.name}</span>
        <span className="jm-muted">{attachments.formatSize(item.size)}</span>
      </button>
      {!masked && <vscodeLink.VsCodeOpen site={item.path} />}
    </span>
  );
}
