/**
 * 左下角的更新提醒（docs/界面/02_一个程序跑起来的规划.md 第 6 步）：基地发现新版本时这里亮起来，点开看每个版本做了什么，用户点“更新”才换。
 * 换的时候后端会断一下，网页照常等它回来。换好了弹一下提示；换失败的原因留在这里。基地没开、没有新版本时什么也不显示。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as i18n from '../I18n.ts';


/** 多久问一次，毫秒。 */
const REFRESH_MS = 30_000;

/** 换版本的时候多久问一次，毫秒。 */
const APPLYING_REFRESH_MS = 2000;

/** 基地说换成功时的话（local/src/supervisor.rs）。 */
const SWAPPED = '换好了';

/** 浏览器本地记下提示过换到哪个版本用的键。 */
const NOTICED_KEY = 'jmbots.updateNoticed';


/** 更新提醒。 */
export function UpdateEntry(): react.JSX.Element | null {
  //M 订阅界面翻译函数，用于格式化更新徽章、变更日志弹窗及结果提示文案。
  const t = i18n.useT();
  /** 基地说的状态。 */
  const [info, setInfo] = react.useState<api.UpdateInfo | null>(null);
  /** 弹窗开着没有。 */
  const [open, setOpen] = react.useState(false);
  /** 提示。 */
  const [notice, setNotice] = react.useState('');
  /** 弹一下的提示。 */
  const [toast, toastHolder] = antd.message.useMessage();
  /** 正在换吗。 */
  const applying = info?.applying === true;

  react.useEffect(() => {
    /** 停了没有。 */
    let stopped = false;
    /** 下一次的定时器。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 问一次。 */
    const load = async (): Promise<void> => {
      /** 问到的；问不到（基地没开，或者后端正在换）就留着上一次的。 */
      //M 向本地守护接口查询更新状态与版本说明；后端重启替换期间问不到时静默保留旧状态。
      const next = await api.updateInfo().catch(() => undefined);
      if (!stopped) {
        if (next) {
          setInfo(next);
        }
        let delay = REFRESH_MS;
        if (applying) {
          delay = APPLYING_REFRESH_MS;
        }

        //M 根据是否正在切换版本选择 2 秒或 30 秒间隔，调度下一轮更新状态查询。
        timer = setTimeout(() => void load(), delay);
      }
    };

    //M 挂载或进入/退出更新态时立即发起首次查询，启动轮询链。
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [applying]);

  //M 换好了只弹一次，不常驻；每个版本只弹一次，刷新网页不会再弹。
  react.useEffect(() => {
    /** 现在的版本。 */
    const version = info?.current?.version;
    if (info?.message === SWAPPED && version && window.localStorage.getItem(NOTICED_KEY) !== version) {
      window.localStorage.setItem(NOTICED_KEY, version);
      void toast.success(t('已更新到 {version}', { version }));
    }
  }, [info, toast, t]);

  if (!info?.available && !applying) {
    //M 换失败的原因留在左下角，要让用户看见。
    return (
      <>
        {toastHolder}
        {info?.message && info.message !== SWAPPED && <div className="jm-update-note">{t('版本更新：{message}', { message: info.message })}</div>}
      </>
    );
  }
  /** 新版本。 */
  const available = info?.available;
  let badgeText = t('有新版本 {version}', { version: available?.version ?? '' });
  if (applying) {
    badgeText = t('正在更新…');
  }
  let modalTitle = t('正在更新');
  if (available) {
    modalTitle = t('新版本 {version}（现在是 {current}）', { version: available.version, current: info?.current?.version ?? t('还没有') });
  }
  return (
    <>
      {toastHolder}
      <button type="button" className="jm-update-entry" onClick={() => setOpen(true)}>
        <icons.CloudDownloadOutlined />
        <span>{badgeText}</span>
      </button>
      <antd.Modal
        open={open}
        title={modalTitle}
        okText={t('更新')}
        cancelText={t('先不更新')}
        okButtonProps={{ disabled: applying || !available }}
        onCancel={() => setOpen(false)}
        onOk={() => {
          //M 用户确认更新后通知守护进程试运行并替换新版本，成功后切入更新中状态，失败则在弹窗内保留报错。
          void api.applyUpdate().then(
            () => {
              setInfo((old) => {
                if (!old) return old;

                return { ...old, applying: true };
              });
              setNotice(t('正在换：先试运行新版本，通过才替换，失败会退回旧版本。后端会断一下，等它回来。'));
            },
            (error: unknown) => {
              let reason = String(error);
              if (error instanceof Error) {
                reason = error.message;
              }
              setNotice(t('没开始：{reason}', { reason }));
            },
          );
        }}
      >
        {available?.changes.map((item) => (
          <section key={item.version} className="jm-update-version">
            <h4>
              {item.version} <span className="jm-muted">{item.date}</span>
            </h4>
            <ul>
              {item.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          </section>
        ))}
        {notice && <p className="jm-muted">{notice}</p>}
      </antd.Modal>
    </>
  );
}
