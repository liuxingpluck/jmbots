/**
 * 顶栏的“动效”开关：开着时播装饰动效（光斑、模糊入场、磁吸），关掉后页面全部静止；选择记在浏览器里。
 * 系统要求减少动态效果，或者没有鼠标、触控板时，开关变灰并显示为关，鼠标移上去说明原因。
 */
import * as antd from 'antd';
import * as prefsStore from '../PrefsStore.ts';


/** 动效开关。 */
export default function MotionToggle() {
  /** 用户是否开着动效。 */
  const enabled = prefsStore.usePrefsStore((state) => state.motionEnabled);
  /** 改开关的动作。 */
  const setEnabled = prefsStore.usePrefsStore((state) => state.setMotionEnabled);
  /** 系统不让播的原因；系统允许时为 null。 */
  const blockedReason = prefsStore.usePrefsStore(prefsStore.blockedReason);

  /** 鼠标移上去时的说明。 */
  const tip =
    blockedReason === null ? '装饰动效：光斑、模糊入场和磁吸；关掉后页面全部静止' : `${blockedReason}，动效不播`;
  // r: 提示挂在外面这层 span 上：开关变灰后不接鼠标事件（见 App.css 的 .motion-toggle），鼠标落在 span 上。
  return (
    <antd.Tooltip title={tip}>
      <span className="motion-toggle">
        <antd.Switch
          size="small"
          checked={enabled && blockedReason === null}
          disabled={blockedReason !== null}
          checkedChildren="动效"
          unCheckedChildren="静止"
          onChange={setEnabled}
        />
      </span>
    </antd.Tooltip>
  );
}
