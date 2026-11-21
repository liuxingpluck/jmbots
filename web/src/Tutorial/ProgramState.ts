/**
 * 进程插件路由常量、状态圆点映射与程序清单读取钩子（不依赖 antd 或 Markdown 拆段组件）。
 */
import * as react from 'react';
import * as api from './TutorialApi.ts';


/** 左栏、导图和骨架逐行共用的模块名：选中它时骨架逐行打开三方握手图。 */
export const HANDSHAKE = '进程插件';

/** 路由里进程插件的前缀：plugin=program:<程序名>，不和普通插件重名。 */
export const PROGRAM_PREFIX = 'program:';


/**
 * 从路由的 plugin 取进程插件名。
 * @param plugin 路由里的 plugin。
 * @returns 程序名；不是进程插件是 undefined。
 */
export function getProgramName(plugin: string): string | undefined {
  if (!plugin.startsWith(PROGRAM_PREFIX)) return undefined;

  return plugin.slice(PROGRAM_PREFIX.length);
}


/** 左栏圆点颜色：ready 绿、blocked 和 unhealthy 红，其余黄。 */
export function getStateDot(state: string): string {
  if (state === 'ready') return 'ok';
  if (state === 'blocked' || state === 'unhealthy') return 'failed';

  return 'waiting';
}


/**
 * 拉 /api/programs 一次。
 * @returns 程序清单；没挂 programs 或读不到是空清单。
 */
export function usePrograms(): api.ProgramItem[] {
  const [programs, setPrograms] = react.useState<api.ProgramItem[]>([]);
  react.useEffect(() => {
    //M 教程打开时读一次托管程序清单，失败当作没有进程插件。
    const loading = api.TutorialApi.getPrograms();
    void loading.then((result) => setPrograms(result.programs), () => setPrograms([]));
  }, []);
  return programs;
}
