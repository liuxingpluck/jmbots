/** 现有壳子中的桌面能力面板；定位、预览、滚动都通过 AOBW 能力调用完成。 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as i18n from '../I18n.ts';
import * as sessionModule from './Session.ts';

/** 框选区域在内存中裁剪显示，不写文件，也不改变实际窗口。 */
function RegionPreview(props: {
  /** 当前完整帧。 */
  frame: sessionModule.Frame;
  /** 客户区比例区域。 */
  region: sessionModule.Region;
}): react.JSX.Element {
  const canvas = react.useRef<HTMLCanvasElement>(null);
  react.useEffect(() => {
    let disposed = false;
    const image = new Image();
    image.onload = () => {
      if (disposed || !canvas.current) { return; }
      const region = props.region;
      const width = Math.max(1, Math.round(image.width * region.width));
      const height = Math.max(1, Math.round(image.height * region.height));
      canvas.current.width = width;
      canvas.current.height = height;
      const drawing = canvas.current.getContext('2d');
      drawing?.drawImage(image, region.x * image.width, region.y * image.height,
        width, height, 0, 0, width, height);
    };
    image.src = props.frame.image;
    return () => { disposed = true; };
  }, [props.frame.image, props.region]);
  return <canvas ref={canvas} aria-label="框选区域预览" style={{ maxWidth: '100%', maxHeight: 240, display: 'block' }} />;
}

/** 设置中的窗口操控页；只在用户按下定位点或滚动按钮时操作桌面。 */
export function Desktop(): react.JSX.Element {
  const t = i18n.useT();
  const [session] = react.useState(() => new sessionModule.DesktopSession());
  const state = react.useSyncExternalStore(session.subscribe, session.snapshot);
  const [steps, setSteps] = react.useState(3);
  const [drag, setDrag] = react.useState<sessionModule.Region | null>(null);
  const dragStart = react.useRef<sessionModule.Point | null>(null);

  react.useEffect(() => {
    void session.initialize();
    return () => session.dispose();
  }, [session]);

  react.useEffect(() => {
    dragStart.current = null;
    setDrag(null);
  }, [state.target?.handle]);

  /** 指针在实际显示图片中的比例，而非整页/屏幕中的位置。 */
  const point = (event: react.PointerEvent<HTMLImageElement>): sessionModule.Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return sessionModule.Geometry.point(event.clientX, event.clientY, rect);
  };

  const region = drag ?? state.region;
  const target = state.target;
  const frame = state.frame;
  const hasAction = state.busy !== null;

  return (
    <antd.Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {state.available === null && <antd.Spin tip={t('正在检查窗口能力')} />}
      {state.available === false && (
        <antd.Alert type="warning" showIcon message={t('窗口能力暂不可用')} description={state.reason} />
      )}
      <antd.Space wrap>
        <antd.Button
          type="primary"
          size="large"
          icon={<icons.AimOutlined />}
          disabled={!state.available || hasAction}
          style={{ cursor: 'crosshair', touchAction: 'none', userSelect: 'none' }}
          onPointerDown={(event) => {
            if (event.button !== 0) { return; }
            event.preventDefault();
            void session.pick();
          }}
          onDragStart={(event) => event.preventDefault()}
        >
          {state.busy === 'pick' ? t('拖到目标后松开') : t('按住定位点拖出')}
        </antd.Button>
        <antd.Button disabled={!target && !hasAction} onClick={() => session.clear()}>
          {t('清除目标')}
        </antd.Button>
        <antd.Switch
          checked={state.preview}
          disabled={!target || hasAction}
          checkedChildren={t('实时预览')}
          unCheckedChildren={t('暂停预览')}
          onChange={(enabled) => session.preview(enabled)}
        />
      </antd.Space>
      <div className="jm-muted">
        {t('保持鼠标左键按住，拖到其他窗口后松开。边框标出候选窗口，Esc 取消。')}
      </div>
      {state.error && <antd.Alert type="error" showIcon message={state.error} />}
      {state.notice && <antd.Alert type="info" showIcon message={state.notice} />}
      {target && (
        <>
          <antd.Select
            aria-label={t('选中的窗口或子窗口')}
            value={target.handle}
            disabled={hasAction}
            style={{ width: '100%' }}
            options={state.targets.map((item) => ({
              value: item.handle,
              label: `${item.title || t('无标题')} · ${item.className} · ${item.handle}`,
            }))}
            onChange={(handle: string) => { void session.select(handle); }}
          />
          <div className="jm-muted" style={{ overflowWrap: 'anywhere' }}>
            {t('进程')} {target.pid} · {target.className} · {target.handle}
            {' · '}{target.rect.width} × {target.rect.height}
          </div>
          <antd.Space wrap>
            <antd.Button
              icon={<icons.ArrowUpOutlined />}
              disabled={hasAction || !frame}
              onClick={() => { void session.scroll('up', steps); }}
            >{t('向上滚动')}</antd.Button>
            <antd.Button
              icon={<icons.ArrowDownOutlined />}
              disabled={hasAction || !frame}
              onClick={() => { void session.scroll('down', steps); }}
            >{t('向下滚动')}</antd.Button>
            <label>{t('滚动步数')}{' '}
              <antd.InputNumber min={1} max={10} precision={0} value={steps}
                disabled={hasAction}
                onChange={(value) => setSteps(Math.max(1, Math.min(10, Math.round(value ?? 1))))} />
            </label>
            <span className="jm-muted">
              {t('滚动位置')} {Math.round(state.point.x * 100)}% / {Math.round(state.point.y * 100)}%
            </span>
          </antd.Space>
          <div className="jm-muted">
            {t('点击图像指定滚动位置，拖动框选区域后使用区域中心。只有点击滚动按钮才发送指令。')}
          </div>
        </>
      )}
      {frame && (
        <>
          <div className="jm-muted">
            {state.preview ? t('持续更新中') : t('已暂停，下面是最后一帧')}
            {' · '}{frame.capturedAt} · {frame.width} × {frame.height}
          </div>
          {frame.warning && <antd.Alert type="warning" showIcon message={frame.warning} />}
          <div>
            <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', lineHeight: 0 }}>
              <img
                src={frame.image}
                alt={t('所选窗口实时预览')}
                draggable={false}
                style={{ display: 'block', maxWidth: '100%', maxHeight: 480, cursor: 'crosshair', touchAction: 'none' }}
                onPointerDown={(event) => {
                  if (event.button !== 0 || hasAction) { return; }
                  event.preventDefault();
                  dragStart.current = point(event);
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (!dragStart.current) { return; }
                  setDrag(sessionModule.Geometry.region(dragStart.current, point(event)));
                }}
                onPointerUp={(event) => {
                  if (!dragStart.current) { return; }
                  session.locate(dragStart.current, point(event));
                  dragStart.current = null;
                  setDrag(null);
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => { dragStart.current = null; setDrag(null); }}
              />
              {region && (
                <div style={{ position: 'absolute', pointerEvents: 'none', boxSizing: 'border-box',
                  left: `${region.x * 100}%`, top: `${region.y * 100}%`,
                  width: `${region.width * 100}%`, height: `${region.height * 100}%`,
                  border: '2px solid #1677ff', background: '#1677ff22' }} />
              )}
              <div style={{ position: 'absolute', pointerEvents: 'none', width: 12, height: 12,
                left: `${state.point.x * 100}%`, top: `${state.point.y * 100}%`,
                transform: 'translate(-50%, -50%)', border: '2px solid #fa541c', borderRadius: '50%' }} />
            </div>
          </div>
          {state.region && (
            <antd.Card size="small" title={t('框选区域预览')}>
              <RegionPreview frame={frame} region={state.region} />
            </antd.Card>
          )}
        </>
      )}
      {target && !frame && !state.error && state.preview && <antd.Spin tip={t('等待窗口画面')} />}
      {target && !frame && !state.error && !state.preview && !hasAction && (
        <div className="jm-muted">{t('预览已暂停，打开实时预览获取画面。')}</div>
      )}
      <div className="jm-muted">
        {t('当前阶段只预览和滚动，不自动读取消息。最小化、遮挡或硬件加速可能影响画面；滚动发送成功仍需观察结果。')}
      </div>
    </antd.Space>
  );
}
