/**
 * 后端回 401 时弹一次输入框：填 config.yaml 的 server.token 或设置页建的访问令牌，存进浏览器后刷新。
 * 监听 window 的 'jmbots:unauthorized'（Api.ts 的 getJson 在 401 时发），自己管开关，不进 Store。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as i18n from '../I18n.ts';


/** 令牌在浏览器里存的键（和 Api.ts 的 TOKEN_KEY 同一个）。 */
const TOKEN_KEY = 'jmbots.token';


/**
 * 令牌输入弹框：确定 = 存进浏览器并刷新页面；取消 = 只关框，下次请求 401 会再弹。
 * @returns 弹框（关着时也挂着，open 控制显示）。
 */
export function TokenPrompt(): react.JSX.Element | null {
  const t = i18n.useT();
  /** 弹框开着没有。 */
  const [open, setOpen] = react.useState(false);
  /** 填的令牌。 */
  const [value, setValue] = react.useState('');

  react.useEffect(() => {
    //M 同一时间多个请求 401 会连着发事件，setOpen(true) 幂等，不用去重。
    const onUnauthorized = (): void => {
      setOpen(true);
    };
    window.addEventListener('jmbots:unauthorized', onUnauthorized);
    return () => window.removeEventListener('jmbots:unauthorized', onUnauthorized);
  }, []);

  /** 存进浏览器再刷新：Api.ts 的 TOKEN 是模块加载时读一次的常量，刷新才用得上新令牌。 */
  const save = (): void => {
    window.localStorage.setItem(TOKEN_KEY, value.trim());
    window.location.reload();
  };

  return (
    <antd.Modal
      open={open}
      title={t('要带访问令牌')}
      okText={t('存下并刷新')}
      cancelText={t('先不填')}
      okButtonProps={{ disabled: !value.trim() }}
      onOk={save}
      onCancel={() => setOpen(false)}
    >
      <p>{t('访问令牌在 config.yaml 的 server.token，或设置页「访问令牌」里建。填一次存在浏览器里。')}</p>
      <antd.Input.Password
        value={value}
        placeholder={t('粘贴令牌')}
        onChange={(event) => setValue(event.target.value)}
      />
    </antd.Modal>
  );
}
