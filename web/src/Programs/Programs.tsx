/** 顶栏动态显示已就绪进程插件；单请求轮询，卸载即取消，不产生进程控制操作。 */
import * as react from 'react';
import * as tokenModule from '../Token.ts';
import * as entriesModule from './Entries.ts';
import './Programs.css';

/** 显示名字与商业授权标签；空列表完全不占位，界面在新标签打开。 */
export function Programs(): react.JSX.Element | null {
  //M 只保存接口核对后的可点击项，不把过期快照永久留在顶栏。
  const [entries, setEntries] = react.useState<entriesModule.ProgramEntry[]>([]);
  react.useEffect(() => {
    /** 卸载后禁止继续setState或安排下一轮请求。 */
    let disposed = false;
    /** 同一个取消源覆盖所有轮次，卸载时中止在途请求。 */
    const controller = new AbortController();
    /** 只有上一轮结束才安排下一轮，不重叠发送请求。 */
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** 拉取只读快照；失败清空旧入口，前台1.5秒、后台5秒后重试。 */
    const poll = async (): Promise<void> => {
      const path = '/api/programs';
      //M 通过既有工具拼当前令牌，不读取或修改任何运行时密钥。
      const url = tokenModule.withToken(path, tokenModule.TOKEN);
      const timeout = AbortSignal.timeout(5000);
      const signals = [controller.signal, timeout];
      const signal = AbortSignal.any(signals);
      const options = { signal, cache: 'no-store' as const };
      try {
        //M 复用主站令牌规则，不新增批准流程、不读写运行时配置。
        const response = await fetch(url, options);
        if (!response.ok) throw new Error('程序状态接口暂不可用');

        const data: unknown = await response.json();
        //G 在接口边界一次筛掉离线、无UI和错误地址，不把坏数据交给链接。
        const available = entriesModule.getEntries(data);
        if (!disposed) {
          setEntries(available);
        }
      } catch {
        //G HTTP未挂载、网络失败、超时均撤掉旧入口，不输出令牌或刷通知。
        if (!disposed) {
          setEntries([]);
        }
      } finally {
        if (!disposed) {
          let delay = 1500;
          if (document.hidden) {
            delay = 5000;
          }
          //M 本轮彻底结束后才启动下一轮，避免慢接口堆积请求。
          timer = setTimeout(() => { void poll(); }, delay);
        }
      }
    };
    //M 挂载即取一次，程序动态上线后不需要刷新整个聊天页。
    void poll();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  if (entries.length === 0) return null;

  //M 同源代理沿用主站鉴权；新页与当前聊天页隔离opener。
  return (
    <nav className="jm-top-pages" aria-label="进程插件">
      {entries.map((entry) => {
        const href = tokenModule.withToken(entry.ui, tokenModule.TOKEN);
        //M 只有已授权、过期才显示授权标签；不需要、未授权、未知都不显示，免得免费程序看着像出错。
        const showLicense = entry.licenseLabel === '已授权' || entry.licenseLabel === '过期';
        let title = entry.title;
        if (showLicense) {
          title = `${entry.title}（${entry.licenseLabel}；程序自报商业授权）`;
        }
        return (
          <a key={entry.name} className="jm-top-page-link jm-program-link"
            href={href} title={title} target="_blank" rel="noopener noreferrer">
            <span>{entry.title}</span>
            {showLicense && <small className="jm-program-license">{entry.licenseLabel}</small>}
          </a>
        );
      })}
    </nav>
  );
}
