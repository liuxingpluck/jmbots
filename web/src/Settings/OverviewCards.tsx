/**
 * 设置中心运行态快照与快捷入口卡片组件集合：
 * 包含 ConsoleOverview（控制台总览）、ChannelsEntry（渠道与微信客服入口）、
 * KnowledgeEntry（记忆/VGR/知识库入口）和 FrpcEntry（外网隧道 FRPC 概览）。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as timeline from '../Chat/Timeline.ts';
import * as context from '../Context.ts';
import * as frpcApi from '../Frpc/FrpcApi.ts';
import * as i18n from '../I18n.ts';
import * as tokenModule from '../Token.ts';
import * as editsModule from './Edits.ts';


/** 托管子程序状态快照（对应 `GET /api/programs` 单条记录）。 */
export interface ManagedProgramBrief {
  /** 程序唯一标识。 */
  name: string;
  /** 展示标题。 */
  title: string;
  /** 运行状态，如 ready、starting、stopped。 */
  state: string;
  /** 可选状态补充说明。 */
  note?: string;
  /** 监听端口。 */
  port?: number;
  /** 进程号。 */
  pid?: number;
  /** 内存占用（MiB）。 */
  rssMb?: number;
  /** 是否有独立代理界面入口。 */
  ui?: string;
}


/** 设置中心聚合的运行态即时快照。 */
export interface RuntimeSnapshot {
  /** 是否正在拉取最新状态。 */
  loading: boolean;
  /** 最近一次刷新时间戳（毫秒）。 */
  updatedAt: number;
  /** 主服务与壳子版本信息（`/api/ui/info`）。 */
  uiInfo: api.UiInfo | null;
  /** 主服务启动时间与渠道在线状态（`/api/ui/status`）。 */
  uiStatus: api.UiStatus | null;
  /** 托管子服务列表（`/api/programs`）；未挂载或不可用时为 null。 */
  programs: ManagedProgramBrief[] | null;
  /** FRPC 外网隧道状态（`/api/frpc/status`）；未挂载或不可用时为 null。 */
  frpc: frpcApi.FrpcStatus | null;
  /** Rust 记忆服务探活与统计（`/api/memory/health`）；未挂载或不可用时为 null。 */
  memory: api.MemoryHealth | null;
}


/** 独立监控工作台快捷入口配置。 */
interface WorkbenchItem {
  /** 唯一键。 */
  key: string;
  /** 页面路由。 */
  href: string;
  /** 中文标题原文。 */
  title: string;
  /** 中文一句话说明。 */
  desc: string;
  /** 依赖后端插件名。 */
  plugin: string;
  /** 卡片左侧图标。 */
  icon: react.ReactNode;
}


/** 空快照初始值。 */
const EMPTY_SNAPSHOT: RuntimeSnapshot = {
  loading: false,
  updatedAt: 0,
  uiInfo: null,
  uiStatus: null,
  programs: null,
  frpc: null,
  memory: null,
};


/** 获取通用 `GET /api/programs` 并安全解析为数组。 */
async function fetchProgramsSnapshot(): Promise<ManagedProgramBrief[] | null> {
  const payload = await api.getJson<{ programs?: unknown }>('/api/programs');
  if (!Array.isArray(payload?.programs)) return null;

  const list: ManagedProgramBrief[] = [];
  for (const row of payload.programs) {
    if (row === null || typeof row !== 'object') {
      continue;
    }
    const item = row as Record<string, unknown>;
    if (typeof item['name'] !== 'string' || item['name'] === '') {
      continue;
    }
    let title = item['name'];
    if (typeof item['title'] === 'string' && item['title'].trim() !== '') {
      title = item['title'];
    }
    let state = 'unknown';
    if (typeof item['state'] === 'string') {
      state = item['state'];
    }
    let note: string | undefined;
    if (typeof item['note'] === 'string') {
      note = item['note'];
    }
    let port: number | undefined;
    if (typeof item['port'] === 'number') {
      port = item['port'];
    }
    let pid: number | undefined;
    if (typeof item['pid'] === 'number') {
      pid = item['pid'];
    }
    let rssMb: number | undefined;
    if (typeof item['rssMb'] === 'number') {
      rssMb = item['rssMb'];
    }
    let ui: string | undefined;
    if (typeof item['ui'] === 'string') {
      ui = item['ui'];
    }
    list.push({ name: item['name'], title, state, note, port, pid, rssMb, ui });
  }
  return list;
}


/**
 * 设置中心运行态统一拉取 Hook：并行查询主信息、渠道、托管进程、FRPC 与记忆服务，
 * 供控制台总览、渠道、知识库与 FRPC 卡片共享同一份数据，避免重复请求。
 * @param mountedPlugins 后端已挂载插件状态。
 * @returns 当前快照与手动刷新动作。
 */
export function useRuntimeSnapshot(mountedPlugins: api.MountedPlugins): {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
} {
  const [snapshot, setSnapshot] = react.useState<RuntimeSnapshot>(EMPTY_SNAPSHOT);
  const [tick, setTick] = react.useState(0);

  const programsMounted = api.isPluginMounted(mountedPlugins, 'programs', false);
  const frpcMounted = api.isPluginMounted(mountedPlugins, 'frpc', false);
  const memoryMounted = api.isPluginMounted(mountedPlugins, 'memory', false);

  const refresh = react.useCallback(() => {
    setTick((prev) => prev + 1);
  }, []);

  react.useEffect(() => {
    let disposed = false;
    setSnapshot((prev) => ({ ...prev, loading: true }));

    const safe = async <T,>(work: Promise<T>): Promise<T | null> => {
      try {
        return await work;
      } catch {
        return null;
      }
    };

    const loadAll = async (): Promise<void> => {
      let programsTask: Promise<ManagedProgramBrief[] | null> = Promise.resolve(null);
      if (programsMounted) {
        programsTask = safe(fetchProgramsSnapshot());
      }
      let frpcTask: Promise<frpcApi.FrpcStatus | null> = Promise.resolve(null);
      if (frpcMounted) {
        frpcTask = safe(frpcApi.fetchFrpcStatus());
      }
      let memoryTask: Promise<api.MemoryHealth | null> = Promise.resolve(null);
      if (memoryMounted) {
        memoryTask = safe(api.memoryHealth());
      }

      //M 并行拉取主站与已挂载子系统状态，任一子接口失败时降级为空而不阻塞设置中心展示。
      const [uiInfo, uiStatus, programs, frpc, memory] = await Promise.all([
        safe(api.uiInfo()),
        safe(api.uiStatus()),
        programsTask,
        frpcTask,
        memoryTask,
      ]);
      if (disposed) return;

      setSnapshot({
        loading: false,
        updatedAt: Date.now(),
        uiInfo,
        uiStatus,
        programs,
        frpc,
        memory,
      });
    };

    void loadAll();
    return () => {
      disposed = true;
    };
  }, [programsMounted, frpcMounted, memoryMounted, tick]);

  return { snapshot, refresh };
}


/** 构建所有独立重监控工作台卡片清单。 */
function getWorkbenches(t: i18n.Translate): WorkbenchItem[] {
  return [
    {
      key: 'work-decision',
      href: '/work-decision/?tab=tick',
      title: t('工作决策与任务看板'),
      desc: t('多视图任务队列、四象限与控制面锁状态'),
      plugin: 'work-decision',
      icon: <icons.ProjectOutlined />,
    },
    {
      key: 'frpc',
      href: '/frpc/',
      title: t('外网隧道 FRPC 控制台'),
      desc: t('隧道启停、开机自启、公网域名与代理日志'),
      plugin: 'frpc',
      icon: <icons.GlobalOutlined />,
    },
    {
      key: 'wechat-kefu',
      href: '/wechat-kefu/',
      title: t('微信客服工作台'),
      desc: t('客户会话列表、自动回复队列与演示打码'),
      plugin: 'wechat-kefu',
      icon: <icons.WechatOutlined />,
    },
    {
      key: 'knowledge',
      href: '/knowledge/',
      title: t('积木知识库'),
      desc: t('目录树、双链笔记、标签云与融合检索'),
      plugin: 'knowledge',
      icon: <icons.BookOutlined />,
    },
    {
      key: 'memory',
      href: '/memory/',
      title: t('统一记忆检索'),
      desc: t('历史聊天、知识与记忆卡片混合向量搜索'),
      plugin: 'memory',
      icon: <icons.DatabaseOutlined />,
    },
    {
      key: 'graph',
      href: '/graph/',
      title: t('实体关系图谱'),
      desc: t('客户与知识实体多跳关系可视化'),
      plugin: 'memory',
      icon: <icons.ApartmentOutlined />,
    },
    {
      key: 'tutorial',
      href: '/tutorial/',
      title: t('执行链路与插件地图'),
      desc: t('消息生命周期、插件说明与运行时快照'),
      plugin: 'tutorial',
      icon: <icons.NodeIndexOutlined />,
    },
    {
      key: 'model-notes',
      href: '/model-notes/',
      title: t('模型评价与能力手册'),
      desc: t('各模型历史打分、上下文限制与使用评价'),
      plugin: 'model-catalog',
      icon: <icons.StarOutlined />,
    },
  ];
}


/** 渲染单个状态胶囊块。 */
function StatusCard(props: {
  title: string;
  tone: 'ok' | 'warn' | 'err' | 'muted';
  statusText: string;
  meta: string;
}): react.JSX.Element {
  return (
    <div className="jm-sc-stat-card">
      <div className="jm-sc-stat-top">
        <span className="jm-sc-stat-label">{props.title}</span>
        <span className={`jm-sc-pill jm-sc-pill-${props.tone}`}>
          <span className="jm-sc-pill-dot" />
          <span>{props.statusText}</span>
        </span>
      </div>
      <div className="jm-sc-stat-meta">{props.meta}</div>
    </div>
  );
}


/** 渲染带安全令牌的独立工作台外链卡片。 */
function WorkbenchCard(props: {
  item: WorkbenchItem;
  mounted: boolean;
  t: i18n.Translate;
}): react.JSX.Element {
  if (!props.mounted) {
    return (
      <div className="jm-sc-wb-card jm-sc-wb-disabled">
        <div className="jm-sc-wb-icon">{props.item.icon}</div>
        <div className="jm-sc-wb-body">
          <div className="jm-sc-wb-title">
            <span>{props.item.title}</span>
            <span className="jm-sc-pill jm-sc-pill-muted">{props.t('未挂载')}</span>
          </div>
          <div className="jm-sc-wb-desc">{props.item.desc}</div>
        </div>
      </div>
    );
  }

  const href = tokenModule.withToken(props.item.href, tokenModule.TOKEN);
  return (
    <a className="jm-sc-wb-card" href={href} target="_blank" rel="noopener noreferrer">
      <div className="jm-sc-wb-icon">{props.item.icon}</div>
      <div className="jm-sc-wb-body">
        <div className="jm-sc-wb-title">
          <span>{props.item.title}</span>
          <icons.ExportOutlined className="jm-sc-wb-arrow" />
        </div>
        <div className="jm-sc-wb-desc">{props.item.desc}</div>
      </div>
    </a>
  );
}


/**
 * 1.1 运行态总览面板。
 * @param props 统一运行态快照、刷新方法、插件挂载状态及内部节点跳转回调。
 */
export function ConsoleOverview(props: {
  snapshot: RuntimeSnapshot;
  onRefresh: () => void;
  onNavigate: (sectionId: string) => void;
}): react.JSX.Element {
  const t = i18n.useT();
  const online = context.useUi((state) => state.online);
  const bots = context.useUi((state) => state.bots);
  const mountedPlugins = context.useUi((state) => state.mountedPlugins);

  //M 整理主服务在线与版本胶囊文本。
  let serverTone: 'ok' | 'warn' | 'err' | 'muted' = 'warn';
  let serverStatus = t('连接检查中');
  if (online === true) {
    serverTone = 'ok';
    serverStatus = t('运行中');
  }
  if (online === false) {
    serverTone = 'err';
    serverStatus = t('连接断开');
  }
  const serverVersion = props.snapshot.uiInfo?.server?.version
    ?? props.snapshot.uiInfo?.version
    ?? '—';
  let startedText = t('未知');
  const startedAt = props.snapshot.uiInfo?.startedAt ?? props.snapshot.uiStatus?.startedAt;
  if (typeof startedAt === 'number' && startedAt > 0) {
    startedText = timeline.formatTime(startedAt);
  }
  const serverMeta = t('版本 v{ver} · 启动 {time} · {count} 个机器人', {
    ver: serverVersion,
    time: startedText,
    count: bots.length,
  });

  //M 整理桌面壳子连接态。
  const shell = props.snapshot.uiInfo?.shell ?? null;
  let shellTone: 'ok' | 'warn' | 'err' | 'muted' = 'muted';
  let shellStatus = t('未连接壳子');
  let shellMeta = t('当前经浏览器独立访问，或基地壳子未启动');
  if (shell !== null) {
    shellTone = 'ok';
    shellStatus = t('已连接');
    shellMeta = t('基地壳子 v{ver}', { ver: shell.version });
  }

  //M 整理托管子程序（如 jmbots-memory）状态摘要。
  const programsMounted = api.isPluginMounted(mountedPlugins, 'programs', false);
  const programs = props.snapshot.programs;
  let progTone: 'ok' | 'warn' | 'err' | 'muted' = 'muted';
  let progStatus = t('未挂载');
  let progMeta = t('programs 插件未启用');
  if (programsMounted && programs !== null) {
    const readyList = programs.filter((item) => item.state === 'ready');
    if (readyList.length > 0) {
      progTone = 'ok';
      progStatus = t('{ready}/{total} 就绪', { ready: readyList.length, total: programs.length });
      progMeta = readyList
        .map((item) => {
          let rssText = '';
          if (typeof item.rssMb === 'number') {
            rssText = ` ${Math.round(item.rssMb)}MB`;
          }
          return `${item.title}${rssText}`;
        })
        .join(' · ');
    }
    if (readyList.length === 0) {
      progTone = 'warn';
      progStatus = t('0/{total} 就绪', { total: programs.length });
      progMeta = t('托管子程序尚未全部就绪');
    }
  }

  //M 整理 FRPC 外网隧道状态摘要。
  const frpcMounted = api.isPluginMounted(mountedPlugins, 'frpc', false);
  const frpc = props.snapshot.frpc;
  let frpcTone: 'ok' | 'warn' | 'err' | 'muted' = 'muted';
  let frpcStatus = t('未挂载');
  let frpcMeta = t('frpc 插件未启用');
  if (frpcMounted && frpc !== null) {
    if (frpc.connected) {
      frpcTone = 'ok';
      frpcStatus = t('隧道已连通');
      frpcMeta = t('{count} 条规则 · 公网入口 {urls} 个', {
        count: frpc.proxies.length,
        urls: frpc.publicUrls.length,
      });
    }
    if (!frpc.connected && frpc.running) {
      frpcTone = 'warn';
      frpcStatus = t('进程运行中');
      frpcMeta = frpc.detail || t('正在尝试连接远端 frps');
    }
    if (!frpc.connected && !frpc.running) {
      frpcTone = 'muted';
      frpcStatus = t('已停止');
      frpcMeta = frpc.detail || t('可在 FRPC 控制台一键启动');
    }
  }

  const workbenches = getWorkbenches(t);
  let refreshedLabel = t('尚未刷新');
  if (props.snapshot.updatedAt > 0) {
    refreshedLabel = t('更新于 {time}', { time: timeline.formatTime(props.snapshot.updatedAt) });
  }

  return (
    <div className="jm-section">
      <div className="jm-sc-toolbar">
        <span className="jm-muted">{refreshedLabel}</span>
        <div className="jm-sc-inline-row">
          <antd.Button
            size="small"
            icon={<icons.SyncOutlined />}
            onClick={() => props.onNavigate('reconnect')}
          >
            {t('模型重连体检')}
          </antd.Button>
          <antd.Button
            size="small"
            icon={<icons.ReloadOutlined />}
            loading={props.snapshot.loading}
            onClick={props.onRefresh}
          >
            {t('刷新运行态')}
          </antd.Button>
        </div>
      </div>

      <div className="jm-sc-status-grid">
        <StatusCard title={t('主后端服务')} tone={serverTone} statusText={serverStatus} meta={serverMeta} />
        <StatusCard title={t('桌面基地壳子')} tone={shellTone} statusText={shellStatus} meta={shellMeta} />
        <StatusCard title={t('托管子服务')} tone={progTone} statusText={progStatus} meta={progMeta} />
        <StatusCard title={t('外网隧道 FRPC')} tone={frpcTone} statusText={frpcStatus} meta={frpcMeta} />
      </div>

      <div className="jm-sc-subhead">{t('独立重监控工作台（新标签打开并自动携带令牌）')}</div>
      <div className="jm-sc-wb-grid">
        {workbenches.map((item) => {
          const mounted = api.isPluginMounted(mountedPlugins, item.plugin, true);
          return <WorkbenchCard key={item.key} item={item} mounted={mounted} t={t} />;
        })}
      </div>
    </div>
  );
}


/**
 * 3.2 渠道与外部工作台快捷卡片：展示飞书/微信渠道实时状态，直达 `/wechat-kefu/`。
 */
export function ChannelsEntry(props: {
  draft: unknown;
  snapshot: RuntimeSnapshot;
  onNavigate: (sectionId: string) => void;
}): react.JSX.Element {
  const t = i18n.useT();
  const mountedPlugins = context.useUi((state) => state.mountedPlugins);
  const channels = props.snapshot.uiStatus?.channels ?? [];
  const feishuConfig = editsModule.getAt(props.draft, ['channels', 'feishu']);
  let feishuCount = 0;
  if (Array.isArray(feishuConfig)) {
    feishuCount = feishuConfig.length;
  }
  const wechatMounted = api.isPluginMounted(mountedPlugins, 'wechat-kefu', true);
  const wechatHref = tokenModule.withToken('/wechat-kefu/', tokenModule.TOKEN);

  return (
    <div className="jm-section">
      <div className="jm-sc-entry-card">
        <div className="jm-sc-entry-head">
          <div>
            <strong>{t('当前接入渠道实时状态')}</strong>
            <div className="jm-field-hint">
              {t('已配置 {count} 个飞书应用；微信客服与多渠道消息可进入独立工作台精细管理', {
                count: feishuCount,
              })}
            </div>
          </div>
          <div className="jm-sc-inline-row">
            <antd.Button size="small" onClick={() => props.onNavigate('bots-list')}>
              {t('编辑飞书应用')}
            </antd.Button>
            {wechatMounted && (
              <antd.Button
                size="small"
                type="primary"
                icon={<icons.ExportOutlined />}
                href={wechatHref}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('打开微信客服工作台')}
              </antd.Button>
            )}
          </div>
        </div>
        {channels.length === 0 && (
          <div className="jm-muted">{t('暂无运行中渠道状态数据（后端未返回或未启用外接渠道）')}</div>
        )}
        {channels.length > 0 && (
          <div className="jm-sc-channel-list">
            {channels.map((ch) => {
              let tone: 'ok' | 'err' = 'err';
              let label = t('未连上');
              if (ch.connected) {
                tone = 'ok';
                label = t('已连上');
              }
              let botText = '';
              if (ch.bot) {
                botText = ` → ${ch.bot}`;
              }
              return (
                <div key={`${ch.name}-${ch.bot ?? ''}`} className="jm-sc-channel-row">
                  <span className="jm-sc-mono">{ch.name}{botText}</span>
                  <span className={`jm-sc-pill jm-sc-pill-${tone}`}>
                    <span className="jm-sc-pill-dot" />
                    <span>{label}</span>
                  </span>
                  <span className="jm-muted">{ch.detail}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}


/**
 * 4.2 记忆 / VGR / 知识库入口卡片：展示记忆服务健康指标并直达三大知识工作台。
 */
export function KnowledgeEntry(props: { snapshot: RuntimeSnapshot }): react.JSX.Element {
  const t = i18n.useT();
  const mountedPlugins = context.useUi((state) => state.mountedPlugins);
  const mem = props.snapshot.memory;
  const counts = mem?.counts;

  let tone: 'ok' | 'warn' | 'muted' = 'muted';
  let statusText = t('未检查 / 未挂载');
  let detailText = t('memory 插件或 jmbots-memory 服务尚未就绪');
  if (mem !== null && mem.ok) {
    tone = 'ok';
    let msSuffix = '';
    if (typeof mem.ms === 'number') {
      msSuffix = ` · ${mem.ms}ms`;
    }
    statusText = t('记忆服务在线{ms}', { ms: msSuffix });
    detailText = t('文档 {docs} · 向量 {embedded} · 实体 {entities} · 关系 {relations}', {
      docs: counts?.docs ?? 0,
      embedded: counts?.embedded ?? 0,
      entities: counts?.entities ?? 0,
      relations: counts?.relations ?? 0,
    });
  }
  if (mem !== null && !mem.ok) {
    tone = 'warn';
    statusText = t('记忆服务未就绪');
    detailText = mem.error ?? t('请检查 programs 中的 jmbots-memory 是否启动');
  }

  const entries: WorkbenchItem[] = [
    {
      key: 'knowledge',
      href: '/knowledge/',
      title: t('积木知识库（/knowledge/）'),
      desc: t('Markdown 笔记目录树、标签云、双向链接与本地同步'),
      plugin: 'knowledge',
      icon: <icons.BookOutlined />,
    },
    {
      key: 'memory',
      href: '/memory/',
      title: t('统一记忆检索（/memory/）'),
      desc: t('历史对话、渠道消息与知识库 RRF 混合语义检索'),
      plugin: 'memory',
      icon: <icons.DatabaseOutlined />,
    },
    {
      key: 'graph',
      href: '/graph/',
      title: t('实体关系图谱（/graph/）'),
      desc: t('多跳知识关联探索与实体图谱画布'),
      plugin: 'memory',
      icon: <icons.ApartmentOutlined />,
    },
  ];

  return (
    <div className="jm-section">
      <div className="jm-sc-entry-card">
        <div className="jm-sc-entry-head">
          <div>
            <strong>{t('记忆与向量检索服务（VGR / jmbots-memory）')}</strong>
            <div className="jm-field-hint">{detailText}</div>
          </div>
          <span className={`jm-sc-pill jm-sc-pill-${tone}`}>
            <span className="jm-sc-pill-dot" />
            <span>{statusText}</span>
          </span>
        </div>
        <div className="jm-sc-wb-grid">
          {entries.map((item) => {
            const mounted = api.isPluginMounted(mountedPlugins, item.plugin, true);
            return <WorkbenchCard key={item.key} item={item} mounted={mounted} t={t} />;
          })}
        </div>
      </div>
    </div>
  );
}


/**
 * 5.2 外网隧道 FRPC 概览卡片：实时展示 `/api/frpc/status` 在线、开机自启与公网域名入口。
 */
export function FrpcEntry(props: {
  snapshot: RuntimeSnapshot;
  onRefresh: () => void;
}): react.JSX.Element {
  const t = i18n.useT();
  const mountedPlugins = context.useUi((state) => state.mountedPlugins);
  const frpcMounted = api.isPluginMounted(mountedPlugins, 'frpc', false);
  const frpc = props.snapshot.frpc;
  const consoleHref = tokenModule.withToken('/frpc/', tokenModule.TOKEN);

  let tone: 'ok' | 'warn' | 'muted' = 'muted';
  let statusText = t('未挂载');
  if (frpcMounted && frpc === null) {
    statusText = t('读取中或不可用');
  }
  if (frpc !== null && frpc.connected) {
    tone = 'ok';
    statusText = t('已连接远端 frps');
  }
  if (frpc !== null && !frpc.connected && frpc.running) {
    tone = 'warn';
    statusText = t('进程运行中（重连中）');
  }
  if (frpc !== null && !frpc.connected && !frpc.running) {
    tone = 'muted';
    statusText = t('已停止');
  }

  let autoStartLabel = t('未开启');
  if (frpc?.autoStart) {
    autoStartLabel = t('已开启');
  }

  return (
    <div className="jm-section">
      <div className="jm-sc-entry-card">
        <div className="jm-sc-entry-head">
          <div className="jm-sc-inline-row">
            <strong>{t('外网穿透隧道状态')}</strong>
            <span className={`jm-sc-pill jm-sc-pill-${tone}`}>
              <span className="jm-sc-pill-dot" />
              <span>{statusText}</span>
            </span>
          </div>
          <div className="jm-sc-inline-row">
            <antd.Button
              size="small"
              icon={<icons.ReloadOutlined />}
              loading={props.snapshot.loading}
              onClick={props.onRefresh}
            >
              {t('刷新')}
            </antd.Button>
            {frpcMounted && (
              <antd.Button
                size="small"
                type="primary"
                icon={<icons.ExportOutlined />}
                href={consoleHref}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('打开 FRPC 控制台')}
              </antd.Button>
            )}
          </div>
        </div>

        {frpc !== null && (
          <div className="jm-sc-frpc-meta">
            <div>
              <span className="jm-muted">{t('远端服务：')}</span>
              <span className="jm-sc-mono">{frpc.serverAddr || '—'}:{frpc.serverPort || '—'}</span>
            </div>
            <div>
              <span className="jm-muted">{t('开机自启：')}</span>
              <span>{autoStartLabel}</span>
            </div>
            <div>
              <span className="jm-muted">{t('映射规则：')}</span>
              <span>{t('{count} 条', { count: frpc.proxies.length })}</span>
            </div>
            {frpc.publicUrls.length > 0 && (
              <div className="jm-sc-frpc-urls">
                <span className="jm-muted">{t('公网访问入口：')}</span>
                <div className="jm-sc-inline-row">
                  {frpc.publicUrls.slice(0, 6).map((url) => (
                    <a
                      key={url}
                      className="jm-sc-url-chip"
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {url}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
