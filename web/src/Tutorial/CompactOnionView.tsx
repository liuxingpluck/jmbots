/**
 * 教程页「极限压缩认知架构」第 3 页签：「🧅 洋葱圈」4 层同心圆依赖交互视图。
 * 采用左图右详双栏布局（窄屏自动上下折行）：
 *   - 左侧：纯 SVG 4 层同心洋葱圈（第 3 圈外部触角 → 第 2 圈调度与治理 → 第 1 圈底座与协议 → 圆心骨架核），
 *     支持点击任意圆环或下方快捷按钮高亮切换，并醒目标注「外圈依赖内圈，内圈零依赖外圈」；
 *   - 右侧：展示当前选中圈的一句话职责与全部条目胶囊；点击非核心圈插件弹出同一套 L2 极简 3 字段卡，
 *     点击圆心 4 个骨架文件展示对应的 ATOMS 原子锚点说明。
 */
import * as react from 'react';
import * as tokenModule from '../Token.ts';
import * as meta from './CompactMetaData.ts';

/** 单个 SVG 同心圆的几何坐标与深色配色定义。 */
interface RingVisualSpec {
  /** 对应 ONION_RINGS 中的圈层 ID。 */
  id: string;
  /** 圆环半径（像素，基于 460×460 画布）。 */
  radius: number;
  /** 圈名文字的纵坐标。 */
  labelY: number;
  /** 数量徽章文字的纵坐标。 */
  badgeY: number;
  /** 圆环边框与高亮主题色。 */
  stroke: string;
  /** 未选中时的柔和填充色。 */
  fill: string;
  /** 选中时的强调填充色。 */
  activeFill: string;
  /** 圈层文字主色。 */
  text: string;
}

/** 圆心 4 个骨架文件对应的说明与关联 ATOMS 锚点编号。 */
interface CoreFileAnchor {
  /** 骨架文件名（如 Main.ts）。 */
  file: string;
  /** 骨架文件相对源码路径。 */
  path: string;
  /** 一句话核心角色定位。 */
  role: string;
  /** 关联的 meta.ATOMS 中的原子 ID 列表。 */
  atomIds: readonly string[];
}

/** SVG 画布中心横纵坐标（基于 viewBox="0 0 460 460"）。 */
const SVG_CENTER = 230;

/** 由外到内绘制的 4 层同心圆视觉参数（外环先画、内环覆盖其上，确保点击命中精确）。 */
const RING_VISUALS: readonly RingVisualSpec[] = [
  {
    id: 'ring-3',
    radius: 212,
    labelY: 40,
    badgeY: 57,
    stroke: '#06b6d4',
    fill: 'rgba(6, 182, 212, 0.11)',
    activeFill: 'rgba(6, 182, 212, 0.25)',
    text: '#22d3ee',
  },
  {
    id: 'ring-2',
    radius: 160,
    labelY: 92,
    badgeY: 109,
    stroke: '#f97316',
    fill: 'rgba(249, 115, 22, 0.12)',
    activeFill: 'rgba(249, 115, 22, 0.26)',
    text: '#fb923c',
  },
  {
    id: 'ring-1',
    radius: 108,
    labelY: 144,
    badgeY: 161,
    stroke: '#a855f7',
    fill: 'rgba(168, 85, 247, 0.14)',
    activeFill: 'rgba(168, 85, 247, 0.29)',
    text: '#c084fc',
  },
  {
    id: 'core',
    radius: 56,
    labelY: 223,
    badgeY: 243,
    stroke: '#6366f1',
    fill: 'rgba(99, 102, 241, 0.24)',
    activeFill: 'rgba(99, 102, 241, 0.44)',
    text: '#a5b4fc',
  },
];

/** 圆心 4 个骨架核心文件到 ATOMS 锚点的显式映射。 */
const CORE_FILE_ANCHORS: Readonly<Record<string, CoreFileAnchor>> = {
  'Main.ts': {
    file: 'Main.ts',
    path: 'src7/Main.ts',
    role: '总装启动入口：初始化骨架并串联事件总线与插件挂载顺序',
    atomIds: ['events', 'plugins'],
  },
  'Resources.ts': {
    file: 'Resources.ts',
    path: 'src7/Resources.ts',
    role: '配置单次校验、主库连接与模型供应商聚合入口',
    atomIds: ['resources'],
  },
  'Tools.ts': {
    file: 'Tools.ts',
    path: 'src7/Tools.ts',
    role: '按会话种类登记、校验并统一分发工具执行',
    atomIds: ['tools'],
  },
  'Sessions.ts': {
    file: 'Sessions.ts',
    path: 'src7/Sessions.ts',
    role: '管理会话记录与模型⇄工具循环，驱动 4 道串行关口',
    atomIds: ['sessions', 'events'],
  },
};

/** 未挂载到运行名单（BUILT_IN / DEPENDENCY_PLUGINS）的插件目录名。 */
const UNMOUNTED_PLUGINS: ReadonlySet<string> = new Set(['people']);

/** 插件目录名与运行注册名不一致时的别名映射（wechat 目录注册为 wechat-kefu）。 */
const PLUGIN_DOC_ALIASES: Readonly<Record<string, string>> = {
  wechat: 'wechat-kefu',
};


/**
 * 构造插件说明页跳转链接；未挂载插件不输出无效跳转地址，别名插件映射到真实注册名。
 * @param pluginName src7/plugins/ 下的插件目录名。
 * @returns 可跳转的教程页链接；未挂载插件返回 undefined。
 */
function getPluginDocHref(pluginName: string): string | undefined {
  //G people 等未登记到 BUILT_IN 或依赖插件名单时，避免拼出跳转报错页的死链。
  if (UNMOUNTED_PLUGINS.has(pluginName)) return undefined;

  const routePlugin = PLUGIN_DOC_ALIASES[pluginName] ?? pluginName;
  return tokenModule.withToken(
    `/tutorial/?plugin=${encodeURIComponent(routePlugin)}&page=doc`,
    tokenModule.TOKEN,
  );
}


/**
 * 计算单圈在 SVG 和按钮上展示的紧凑数量徽章文案。
 * @param ring 洋葱圈单层数据。
 */
function getRingCountBadge(ring: meta.OnionRing): string {
  if (ring.isCore === true) return `${String(ring.items.length)} 文件 · 0 插件`;

  return `${String(ring.items.length)} 插件`;
}


/**
 * 计算单圈在 SVG 内显示的短标签名。
 * @param ring 洋葱圈单层数据。
 */
function getRingSvgLabel(ring: meta.OnionRing): string {
  if (ring.isCore === true) return '骨架核';

  return ring.name;
}


/**
 * 按骨架文件名取出其对应的 ATOMS 原子锚点列表。
 * @param fileName 圆心骨架文件名（如 Sessions.ts）。
 */
function getAtomsForCoreFile(fileName: string): meta.Atom[] {
  const anchor = CORE_FILE_ANCHORS[fileName];
  if (anchor === undefined) return [];

  const matched: meta.Atom[] = [];
  for (const atomId of anchor.atomIds) {
    const atom = meta.ATOMS.find((item) => item.id === atomId);
    if (atom !== undefined) {
      matched.push(atom);
    }
  }
  return matched;
}


/**
 * 根据圈层 ID 查找对应的 OnionRing 对象，找不到时回退到第 0 圈。
 * @param ringId 圈层 ID。
 */
function getRingById(ringId: string): meta.OnionRing | undefined {
  const found = meta.ONION_RINGS.find((item) => item.id === ringId);
  if (found !== undefined) return found;

  return meta.ONION_RINGS[0];
}


/** CompactPluginCard 组件入参。 */
export interface CompactPluginCardProps {
  /** 插件目录名（对应 meta.CARDS 键名）。 */
  pluginName: string;
  /** 可选附加根容器类名。 */
  className?: string;
  /** 标记所属视图的 data 属性位置，保留既有定位选择器。 */
  cardAttr?: 'cm' | 'on';
}


/**
 * 渲染单插件 L2 极简 3 字段卡（全景地图与洋葱圈共用）。
 * @param props 插件目录名、可选附加类名与定位属性标记。
 */
export function CompactPluginCard(props: CompactPluginCardProps): react.JSX.Element | null {
  const { pluginName, className, cardAttr } = props;
  const card = meta.CARDS[pluginName];
  if (card === undefined) return null;

  const pluginDocHref = getPluginDocHref(pluginName);
  let panelClass = 'tu-cm-card-panel';
  if (className !== undefined && className !== '') {
    panelClass = `${panelClass} ${className}`;
  }

  let cmCardAttr: string | undefined;
  let onCardAttr: string | undefined;
  if (cardAttr === 'cm') {
    cmCardAttr = pluginName;
  }
  if (cardAttr === 'on') {
    onCardAttr = pluginName;
  }

  return (
    <section
      className={panelClass}
      data-cm-card={cmCardAttr}
      data-on-plugin-card={onCardAttr}
      aria-label="单插件极简卡"
    >
      <div className="tu-cm-card-head">
        <div className="tu-cm-card-title-wrap">
          <span className="tu-cm-card-badge">L2 单插件极简卡</span>
          <span className="tu-cm-card-name">{pluginName}</span>
        </div>
        {pluginDocHref !== undefined && (
          <a className="tu-cm-doc-link" href={pluginDocHref}>
            查看该插件完整说明与源码 →
          </a>
        )}
        {pluginDocHref === undefined && (
          <span className="tu-cm-doc-unmounted" data-cm-unmounted={pluginName}>
            暂未挂载（源码在 src7/plugins/{pluginName}/）
          </span>
        )}
      </div>

      <div className="tu-cm-card-rows">
        <div className="tu-cm-card-field">
          <span className="tu-cm-field-key">① 职责（干什么）</span>
          <span className="tu-cm-field-val">{card.duty}</span>
        </div>
        <div className="tu-cm-card-field">
          <span className="tu-cm-field-key">② 挂点（挂哪儿）</span>
          <span className="tu-cm-field-val">{card.hook}</span>
        </div>
        <div className="tu-cm-card-field">
          <span className="tu-cm-field-key">③ 进 → 出（主链交换）</span>
          <span className="tu-cm-field-val">{card.io}</span>
        </div>
      </div>
    </section>
  );
}


/**
 * 渲染右侧底部：选中圆心骨架文件时的 ATOMS 原子锚点说明卡。
 */
function OnionCoreAtomCard(props: { fileName: string }): react.JSX.Element | null {
  const { fileName } = props;
  const anchor = CORE_FILE_ANCHORS[fileName];
  if (anchor === undefined) return null;

  const atoms = getAtomsForCoreFile(fileName);
  const coreDocHref = tokenModule.withToken(
    `/tutorial/?page=doc&rtab=reading&reading=${encodeURIComponent('01_第一块.md')}`,
    tokenModule.TOKEN,
  );

  return (
    <section
      className="tu-cm-card-panel tu-on-detail-card"
      data-on-core-card={fileName}
      aria-label="骨架文件原子锚点说明"
    >
      <div className="tu-cm-card-head">
        <div className="tu-cm-card-title-wrap">
          <span className="tu-on-core-badge">圆心骨架锚点</span>
          <span className="tu-cm-card-name">{anchor.path}</span>
        </div>
        <a className="tu-cm-doc-link" href={coreDocHref}>
          阅读《01_第一块》骨架拆解 →
        </a>
      </div>

      <div className="tu-on-core-role">{anchor.role}</div>

      <div className="tu-on-atom-list">
        {atoms.map((atom) => (
          <div key={atom.id} className="tu-cm-atom-card" data-on-atom={atom.id}>
            <div className="tu-cm-atom-top">
              <span className="tu-cm-atom-name">原子 · {atom.name}</span>
              <code className="tu-cm-atom-site" title={atom.site}>
                {atom.site}
              </code>
            </div>
            <div className="tu-cm-atom-line">{atom.line}</div>
          </div>
        ))}
      </div>
    </section>
  );
}


/**
 * 「🧅 洋葱圈」同心圆交互视图主组件。
 */
export function CompactOnionView(): react.JSX.Element | null {
  /** 当前选中的洋葱圈层 ID，默认聚焦圆心骨架核。 */
  const [activeRingId, setActiveRingId] = react.useState<string>('core');

  /** 当前选中的条目名（圆心骨架文件名或非核心圈插件目录名）。 */
  const [selectedItem, setSelectedItem] = react.useState<string>('Main.ts');

  const activeRing = getRingById(activeRingId);
  if (activeRing === undefined) return null;

  //M 切换选中圈层时自动联动选中该圈第 1 个条目，保证右侧卡片始终有内容。
  const handleSelectRing = (ringId: string): void => {
    const nextRing = getRingById(ringId);
    if (nextRing === undefined) return;

    setActiveRingId(nextRing.id);
    const firstItem = nextRing.items[0];
    if (firstItem !== undefined) {
      setSelectedItem(firstItem);
    }
  };

  //M 处理 SVG 圆环上的键盘 Enter / Space 选择，保持无障碍可用。
  const handleRingKeyDown = (event: react.KeyboardEvent<SVGGElement>, ringId: string): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleSelectRing(ringId);
    }
  };

  let itemsHeading = '🧩 本圈插件列表（点击胶囊弹出 L2 极简 3 字段卡）';
  if (activeRing.isCore === true) {
    itemsHeading = '🦴 骨架核 4 个核心文件（点击胶囊查看 ATOMS 原子锚点）';
  }

  let levelLabel = `第 ${String(activeRing.level)} 圈`;
  if (activeRing.isCore === true) {
    levelLabel = '圆心 · 第 0 圈';
  }

  return (
    <div className="tu-on-wrap" data-on-root>
      <div className="tu-cm-stage-head">
        <span className="tu-cm-stage-title">
          🧅 洋葱圈 4 层同心圆依赖图（点击任意圆环或下方快捷按钮高亮该圈，右侧按需查看卡片）
        </span>
        <span className="tu-on-principle-pill">🧭 外圈依赖内圈，内圈零依赖外圈</span>
      </div>

      <div className="tu-on-layout">
        {/* ==================== 左侧：纯 SVG 4 层同心圆 + 依赖原则 + 圈层快捷按钮 ==================== */}
        <section className="tu-on-visual-panel" aria-label="洋葱圈同心圆架构图">
          <div className="tu-on-svg-stage">
            <svg
              className="tu-on-svg"
              viewBox="0 0 460 460"
              role="img"
              aria-label="jmbots 4 层同心洋葱圈架构图"
            >
              <defs>
                <filter id="tu-on-glow" x="-15%" y="-15%" width="130%" height="130%">
                  <feDropShadow dx="0" dy="0" stdDeviation="5" floodColor="#38bdf8" floodOpacity="0.45" />
                </filter>
              </defs>

              {RING_VISUALS.map((visual) => {
                const ring = getRingById(visual.id);
                if (ring === undefined) return null;

                const isSelected = activeRing.id === ring.id;
                const svgLabel = getRingSvgLabel(ring);
                const countBadge = getRingCountBadge(ring);

                let fillColor = visual.fill;
                let strokeWidth = 1.6;
                let strokeOpacity = 0.68;
                let groupClass = 'tu-on-ring-group';
                let filterAttr: string | undefined = undefined;
                if (isSelected) {
                  fillColor = visual.activeFill;
                  strokeWidth = 3;
                  strokeOpacity = 1;
                  groupClass = 'tu-on-ring-group is-active';
                  filterAttr = 'url(#tu-on-glow)';
                }

                return (
                  <g
                    key={ring.id}
                    className={groupClass}
                    data-on-svg-ring={ring.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${ring.name}，${countBadge}`}
                    aria-pressed={isSelected}
                    onClick={() => handleSelectRing(ring.id)}
                    onKeyDown={(event) => handleRingKeyDown(event, ring.id)}
                  >
                    <circle
                      cx={SVG_CENTER}
                      cy={SVG_CENTER}
                      r={visual.radius}
                      fill={fillColor}
                      stroke={visual.stroke}
                      strokeWidth={strokeWidth}
                      strokeOpacity={strokeOpacity}
                      filter={filterAttr}
                    />
                    {isSelected && (
                      <circle
                        cx={SVG_CENTER}
                        cy={SVG_CENTER}
                        r={visual.radius - 4}
                        fill="none"
                        stroke={visual.stroke}
                        strokeWidth={1}
                        strokeDasharray="5 4"
                        strokeOpacity={0.75}
                      />
                    )}
                    <text
                      x={SVG_CENTER}
                      y={visual.labelY}
                      textAnchor="middle"
                      fill="#f8fafc"
                      fontSize={13}
                      fontWeight={800}
                    >
                      {svgLabel}
                    </text>
                    <text
                      x={SVG_CENTER}
                      y={visual.badgeY}
                      textAnchor="middle"
                      fill={visual.text}
                      fontSize={11}
                      fontWeight={700}
                    >
                      {countBadge}
                    </text>
                  </g>
                );
              })}

              {/* 底部环带标注单向向心依赖指示（pointer-events: none 不遮挡圆环点击） */}
              <g className="tu-on-svg-hint" pointerEvents="none">
                <text x={SVG_CENTER} y={316} textAnchor="middle" fill="#c084fc" fontSize={11} fontWeight={700}>
                  ▲ 依赖圆心
                </text>
                <text x={SVG_CENTER} y={368} textAnchor="middle" fill="#fb923c" fontSize={11} fontWeight={700}>
                  ▲ 依赖内圈
                </text>
                <text x={SVG_CENTER} y={420} textAnchor="middle" fill="#22d3ee" fontSize={11.5} fontWeight={700}>
                  ▲ 外圈依赖内圈 · 内圈零依赖外圈
                </text>
              </g>
            </svg>
          </div>

          <div className="tu-on-principle-banner">
            <strong>依赖铁律：</strong>外圈依赖内圈，内圈零依赖外圈（圆心 4 个骨架文件 0 依赖任何插件）
          </div>

          <div className="tu-on-ring-tabs" role="tablist" aria-label="洋葱圈层级快捷切换">
            {meta.ONION_RINGS.map((ring) => {
              const isSelected = activeRing.id === ring.id;
              let btnClass = 'tu-on-ring-btn';
              if (isSelected) {
                btnClass = 'tu-on-ring-btn is-active';
              }
              return (
                <button
                  key={ring.id}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  className={btnClass}
                  data-on-ring-btn={ring.id}
                  data-on-level={String(ring.level)}
                  onClick={() => handleSelectRing(ring.id)}
                >
                  <span className="tu-on-ring-btn-name">{ring.name}</span>
                  <span className="tu-cm-count-pill">{getRingCountBadge(ring)}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* ==================== 右侧：选中圈职责 + 全部条目胶囊 + 复用详情卡 ==================== */}
        <section className="tu-on-detail-panel" data-on-active-ring={activeRing.id} aria-label="当前洋葱圈详情">
          <div className="tu-on-ring-summary" data-on-level={String(activeRing.level)}>
            <div className="tu-cm-block-top">
              <div className="tu-cm-card-title-wrap">
                <span className="tu-on-level-badge">{levelLabel}</span>
                <span className="tu-on-ring-title">{activeRing.name}</span>
              </div>
              <span className="tu-cm-count-pill">{activeRing.tagline}</span>
            </div>
            <div className="tu-on-ring-desc">{activeRing.summary}</div>
          </div>

          <div className="tu-on-items-box">
            <div className="tu-cm-block-top">
              <span className="tu-on-items-title">{itemsHeading}</span>
              <span className="tu-cm-count-pill">共 {String(activeRing.items.length)} 项</span>
            </div>

            <div className="tu-cm-plugin-pills">
              {activeRing.items.map((itemName) => {
                let pillClass = 'tu-cm-plugin-btn';
                if (activeRing.isCore === true) {
                  pillClass = 'tu-cm-plugin-btn tu-on-core-pill';
                }
                if (selectedItem === itemName) {
                  pillClass = `${pillClass} is-active`;
                }
                return (
                  <button
                    key={itemName}
                    type="button"
                    className={pillClass}
                    data-on-item={itemName}
                    onClick={() => setSelectedItem(itemName)}
                  >
                    {itemName}
                  </button>
                );
              })}
            </div>
          </div>

          {activeRing.isCore === true && <OnionCoreAtomCard fileName={selectedItem} />}
          {activeRing.isCore !== true && (
            <CompactPluginCard pluginName={selectedItem} className="tu-on-detail-card" cardAttr="on" />
          )}
        </section>
      </div>
    </div>
  );
}
