/**
 * 主页顶栏右侧快捷入口：把原本挤在左下角的各独立功能页面（教程、记忆、图谱、工作决策、知识库、模型、客服）
 * 挪到聊天顶栏右侧，按已挂载插件过滤显示；带当前访问令牌跳转，全部未挂载时不占位。
 */
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as tokenModule from '../Token.ts';
import * as programsModule from '../Programs/Programs.tsx';
import './QuickPages.css';


/** 单个快捷页面配置项。 */
interface QuickPageItem {
  /** 页面路由地址。 */
  href: string;
  /** 翻译后的中文或当前语言标签。 */
  label: string;
  /** 对应后端插件名，用于判断该页面是否已挂载。 */
  plugin: string;
}


/**
 * 构造主页顶栏右侧快捷功能页面清单。
 * @param t 翻译函数（直接用字面量调用以便 I18n_Extract 静态提取）。
 * @returns 快捷页面清单。
 */
function getQuickPageItems(t: i18n.Translate): QuickPageItem[] {
  return [
    { href: '/tutorial/', label: t('教程'), plugin: 'tutorial' },
    { href: '/memory/', label: t('记忆'), plugin: 'memory' },
    { href: '/graph/', label: t('图谱'), plugin: 'memory' },
    { href: '/work-decision/', label: t('工作决策'), plugin: 'work-decision' },
    { href: '/knowledge/', label: t('知识库'), plugin: 'knowledge' },
    { href: '/frpc/', label: t('外网隧道'), plugin: 'frpc' },
    { href: '/model-notes/', label: t('模型'), plugin: 'model-catalog' },
    { href: '/wechat-kefu/', label: t('客服'), plugin: 'wechat-kefu' },
  ];
}


/**
 * 主页顶栏右侧的快捷页面导航栏。
 * @returns 导航栏元素；若没有任何已挂载页面则返回 null。
 */
export function QuickPages(): react.JSX.Element | null {
  //M 订阅界面翻译函数，用于生成快捷页面标签与顶栏导航无障碍说明。
  const t = i18n.useT();

  /** 后端汇报的已挂载插件集合，用于隐藏未开启功能的入口。 */
  //M 从全局状态订阅已挂载插件列表，只展示后端实际开启的独立功能页面入口。
  const mountedPlugins = context.useUi((state) => state.mountedPlugins);

  /** 当前已挂载且需要展示在顶栏的页面。 */
  //M 构造快捷页面清单并按已挂载插件过滤，只保留当前可用入口。
  const visiblePages = getQuickPageItems(t).filter((page) => api.isPluginMounted(mountedPlugins, page.plugin, false));

  /** 挂了 programs 插件才显示进程插件入口。 */
  //M 没挂 programs 时不渲染进程插件入口，免得它每 1.5 秒请求一次不存在的状态接口。
  const showPrograms = api.isPluginMounted(mountedPlugins, 'programs', false);

  //M 在聊天顶栏右侧渲染各已挂载独立页面的快捷跳转导航栏。
  return (
    <>
      {visiblePages.length > 0 && (
        <nav className="jm-top-pages" aria-label={t('功能页面')}>
          {visiblePages.map((page) => {
            /** 拼好访问令牌后的跳转地址，保证外部地址打开新页不断鉴权。 */
            //M 为快捷页面路由拼接当前访问令牌，避免从局域网打开独立页时鉴权丢失。
            const targetHref = tokenModule.withToken(page.href, tokenModule.TOKEN);
            return (
              <a key={page.href} className="jm-top-page-link" href={targetHref}>
                {page.label}
              </a>
            );
          })}
        </nav>
      )}
      {showPrograms && <programsModule.Programs />}
    </>
  );
}
