/**
 * 教程页「糖葫芦 + 列间事件菱形」全屏交互画布组件（/tutorial/?view=tanghulu）。
 * - 4 列垂直糖葫芦职责串：Channels（抽象渠道层）、Bots（机器人调度层）、骨架核心（Sessions/Tools）、Knowledge+Memory；
 * - 2 列间核心事件菱形区（Channels ⇄ Bots、Bots ⇄ 骨架/记忆）：展示真实 Cordis 事件流向与回执；
 * - 顶部 9 步「一条飞书消息的完整旅程」自动/手动分步点亮动画 + 5 大链路滤镜；
 * - 底部 4 栏「白话讲透面板」：一句话人话讲透、真实事件名与谁发谁听、真实 TS 载荷结构、对应源码目录与函数。
 */
import * as react from 'react';
import * as compactView from './CompactMetaView.tsx';
import * as tanghuluData from './TanghuluData.ts';
import './TanghuluCanvas.css';

/** 快捷链路筛选按钮配置。 */
const FILTER_BUTTONS: ReadonlyArray<{ key: tanghuluData.TanghuluFilterKey; label: string }> = [
  { key: 'all', label: '🌟 全景总览' },
  { key: 'inbound', label: '📨 入站分派链' },
  { key: 'gates', label: '🛡️ 会话四关口' },
  { key: 'memory', label: '🧠 记忆与知识双链' },
  { key: 'outbound', label: '📤 出站回执链' },
];

/** 各滤镜默认代表节点。 */
const FILTER_REP_NODE: Readonly<Record<Exclude<tanghuluData.TanghuluFilterKey, 'all'>, string>> = {
  inbound: 'ev-ch-msg',
  gates: 'ev-sess-turn',
  memory: 'ev-mem-recall',
  outbound: 'ev-ch-reply',
};

/**
 * 「糖葫芦 + 列间事件菱形」28 节点全屏详图组件。
 * @param props.onClose 关闭画布返回教程主视图。
 * @param props.onCompact 可选回调：切回极限压缩认知全景。
 */
function TanghuluDetail(props: { onClose: () => void; onCompact?: () => void }): react.JSX.Element {
  const [selectedId, setSelectedId] = react.useState<string>('ev-ch-msg');
  const [focusMode, setFocusMode] = react.useState<'none' | 'node' | 'filter' | 'journey'>('none');
  const [activeFilter, setActiveFilter] = react.useState<tanghuluData.TanghuluFilterKey>('all');
  const [journeyIdx, setJourneyIdx] = react.useState<number>(-1);
  const [isPlaying, setIsPlaying] = react.useState<boolean>(false);
  const [thTheme, setThTheme] = react.useState<'dark' | 'light'>('dark');
  const [dockCollapsed, setDockCollapsed] = react.useState<boolean>(false);

  //M 画布缩放与拖拽平移状态
  const [scale, setScale] = react.useState<number>(1);
  const [pan, setPan] = react.useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = react.useState<boolean>(false);
  const panStartRef = react.useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const viewportRef = react.useRef<HTMLDivElement | null>(null);

  /** 根据当前视口宽高自动计算完整容纳 1400×564 舞台的缩放比。 */
  const autoFitViewport = react.useCallback((): void => {
    const vp = viewportRef.current;
    if (vp === null) return;

    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    if (vw <= 0 || vh <= 0) return;

    const sx = (vw - 16) / 1400;
    const sy = (vh - 12) / 564;
    const nextScale = Math.min(1.05, Math.max(0.52, Math.min(sx, sy)));
    setScale(nextScale);
    setPan({ x: 0, y: 0 });
  }, []);

  react.useEffect(() => {
    autoFitViewport();
    window.addEventListener('resize', autoFitViewport);
    return () => window.removeEventListener('resize', autoFitViewport);
  }, [autoFitViewport, dockCollapsed]);

  //M 自动播放「一条飞书消息的完整旅程」定时器
  react.useEffect(() => {
    if (!isPlaying) return;

    const timer = window.setInterval(() => {
      setJourneyIdx((prev) => {
        const next = (prev + 1) % tanghuluData.TANGHULU_JOURNEY.length;
        const stepSpec = tanghuluData.TANGHULU_JOURNEY[next];
        if (stepSpec !== undefined) {
          setSelectedId(stepSpec.focusNode);
        }
        return next;
      });
    }, 2400);

    return () => window.clearInterval(timer);
  }, [isPlaying]);

  //M 按 Escape 退出全屏糖葫芦画布
  react.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props]);

  //M 计算当前选中节点的上下游关联集合
  const chainInfo = react.useMemo(
    () => tanghuluData.getConnectedTanghuluChain(selectedId),
    [selectedId],
  );

  //M 计算当前高亮的节点与连线集合
  const highlightState = react.useMemo(() => {
    const highlightedNodes = new Set<string>();
    const activeEdges = new Set<string>();
    const roleMap = new Map<string, { text: string; cls: string }>();

    if (focusMode === 'node') {
      highlightedNodes.add(selectedId);
      roleMap.set(selectedId, { text: '🎯 当前选中', cls: 'role-selected' });
      for (const uid of chainInfo.upstreamNodes) {
        highlightedNodes.add(uid);
        roleMap.set(uid, { text: '⬅ 上游来源', cls: 'role-up' });
      }
      for (const did of chainInfo.downstreamNodes) {
        highlightedNodes.add(did);
        roleMap.set(did, { text: '下游去向 ➡', cls: 'role-down' });
      }
      for (const eid of chainInfo.activeEdgeIds) {
        activeEdges.add(eid);
      }
      return { hasFocus: true, highlightedNodes, activeEdges, roleMap };
    }

    if (focusMode === 'filter' && activeFilter !== 'all') {
      for (const edge of tanghuluData.TANGHULU_EDGES) {
        if (edge.tags.includes(activeFilter)) {
          highlightedNodes.add(edge.from);
          highlightedNodes.add(edge.to);
          activeEdges.add(edge.id);
        }
      }
      roleMap.set(selectedId, { text: '🎯 链路核心', cls: 'role-selected' });
      return { hasFocus: true, highlightedNodes, activeEdges, roleMap };
    }

    if (focusMode === 'journey' && journeyIdx >= 0) {
      const stepObj = tanghuluData.TANGHULU_JOURNEY[journeyIdx];
      if (stepObj !== undefined) {
        for (const nid of stepObj.activeNodes) {
          highlightedNodes.add(nid);
          roleMap.set(nid, { text: `Step ${String(stepObj.step)}`, cls: 'role-up' });
        }
        highlightedNodes.add(stepObj.focusNode);
        roleMap.set(stepObj.focusNode, {
          text: `🚀 Step ${String(stepObj.step)}/9 主角`,
          cls: 'role-selected',
        });
        for (const eid of stepObj.activeEdges) {
          activeEdges.add(eid);
        }
        return { hasFocus: true, highlightedNodes, activeEdges, roleMap };
      }
    }

    return { hasFocus: false, highlightedNodes, activeEdges, roleMap };
  }, [activeFilter, chainInfo, focusMode, journeyIdx, selectedId]);

  /** 点击画布中任意糖葫芦模块或事件菱形。 */
  const handleSelectNode = (nodeId: string): void => {
    setIsPlaying(false);
    setActiveFilter('all');
    setSelectedId(nodeId);
    setFocusMode('node');
  };

  /** 点击顶部 5 大链路滤镜。 */
  const handleSelectFilter = (filterKey: tanghuluData.TanghuluFilterKey): void => {
    setIsPlaying(false);
    setActiveFilter(filterKey);
    if (filterKey === 'all') {
      setFocusMode('none');
      return;
    }
    const repNode = FILTER_REP_NODE[filterKey];
    setSelectedId(repNode);
    setFocusMode('filter');
  };

  /** 跳到飞书消息旅程指定步骤（0~8）。 */
  const handleJumpJourneyStep = (idx: number): void => {
    const stepObj = tanghuluData.TANGHULU_JOURNEY[idx];
    if (stepObj === undefined) return;

    setActiveFilter('all');
    setJourneyIdx(idx);
    setSelectedId(stepObj.focusNode);
    setFocusMode('journey');
  };

  /** 切换自动播放飞书消息完整旅程。 */
  const handleTogglePlayJourney = (): void => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    let nextIdx = 0;
    if (journeyIdx >= 0 && journeyIdx < tanghuluData.TANGHULU_JOURNEY.length - 1) {
      nextIdx = journeyIdx + 1;
    }
    handleJumpJourneyStep(nextIdx);
    setIsPlaying(true);
  };

  /** 上一步飞书旅程。 */
  const handlePrevStep = (): void => {
    setIsPlaying(false);
    let prev = tanghuluData.TANGHULU_JOURNEY.length - 1;
    if (journeyIdx > 0) {
      prev = journeyIdx - 1;
    }
    handleJumpJourneyStep(prev);
  };

  /** 下一步飞书旅程。 */
  const handleNextStep = (): void => {
    setIsPlaying(false);
    const next = (journeyIdx + 1) % tanghuluData.TANGHULU_JOURNEY.length;
    handleJumpJourneyStep(next);
  };

  /** 重置画布缩放、视角与高亮。 */
  const handleResetView = (): void => {
    setIsPlaying(false);
    setActiveFilter('all');
    setFocusMode('none');
    autoFitViewport();
  };

  /** 画布空白处按下开始拖拽平移。 */
  const handleMouseDown = (event: react.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (target.closest('.tu-th-node') !== null || target.closest('.tu-th-diamond') !== null) return;

    setIsPanning(true);
    panStartRef.current = { x: event.clientX - pan.x, y: event.clientY - pan.y };
  };

  const handleMouseMove = (event: react.MouseEvent<HTMLDivElement>): void => {
    if (!isPanning) return;

    setPan({
      x: event.clientX - panStartRef.current.x,
      y: event.clientY - panStartRef.current.y,
    });
  };

  const handleMouseUp = (): void => {
    if (isPanning) {
      setIsPanning(false);
    }
  };

  const handleWheel = (event: react.WheelEvent<HTMLDivElement>): void => {
    let delta = -0.08;
    if (event.deltaY < 0) {
      delta = 0.08;
    }
    setScale((prev) => Math.min(1.85, Math.max(0.5, prev + delta)));
  };

  const currentNode = tanghuluData.TANGHULU_NODES[selectedId] ?? tanghuluData.TANGHULU_NODES['ev-ch-msg']!;
  const currentJourneyStep = tanghuluData.TANGHULU_JOURNEY[journeyIdx];

  let liveMsgText = '💬 飞书群消息：@周小灵 帮我查一下语舱AI的授权方案';
  if (focusMode === 'journey' && currentJourneyStep !== undefined) {
    liveMsgText = currentJourneyStep.liveMsg;
  }

  let stepBadgeText = '核心枢纽';
  if (focusMode === 'journey' && currentJourneyStep !== undefined) {
    stepBadgeText = `飞书旅程 Step ${String(currentJourneyStep.step)}/9`;
  }

  let playBtnClass = 'tu-th-btn-play';
  let playIcon = '▶';
  let playLabel = '一键演示：一条飞书消息的完整旅程';
  if (isPlaying) {
    playBtnClass = 'tu-th-btn-play playing';
    playIcon = '⏸';
    playLabel = '正在演示飞书消息旅程 (点击暂停)';
  }

  let viewportClass = 'tu-th-viewport';
  if (isPanning) {
    viewportClass = 'tu-th-viewport panning';
  }

  let stageClass = 'tu-th-stage';
  if (highlightState.hasFocus) {
    stageClass = 'tu-th-stage has-focus';
  }

  let dockClass = 'tu-th-dock';
  let dockToggleLabel = '▼ 讲透面板';
  if (dockCollapsed) {
    dockClass = 'tu-th-dock collapsed';
    dockToggleLabel = '▲ 讲透面板';
  }

  let themeToggleLabel = '☀️ 浅色';
  if (thTheme === 'light') {
    themeToggleLabel = '🌙 深色';
  }

  const stageTransform = `translate(calc(-50% + ${String(pan.x)}px), calc(-50% + ${String(pan.y)}px)) scale(${String(scale)})`;
  const nodeList = Object.values(tanghuluData.TANGHULU_NODES);

  return (
    <div
      className="tu-th-overlay"
      data-th-theme={thTheme}
      role="dialog"
      aria-label="糖葫芦插件架构交互画布"
    >
      {/* ==================== 1. TOP HEADER BAR ==================== */}
      <header className="tu-th-header">
        <div className="tu-th-brand-group">
          <div className="tu-th-brand-logo" title="积木 AI 糖葫芦插件架构">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#fff"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="2" x2="12" y2="22" />
              <circle cx="12" cy="6" r="3" fill="#fff" />
              <circle cx="12" cy="12" r="3" fill="#fde047" />
              <circle cx="12" cy="18" r="3" fill="#fff" />
            </svg>
          </div>
          <div className="tu-th-brand-title-wrap">
            <div className="tu-th-brand-title">
              <span>积木 AI (jmbots src7) · 插件架构「糖葫芦 + 列间事件菱形」交互画布</span>
              <span className="tu-th-brand-tag">100% 真实源码事件</span>
            </div>
            <div className="tu-th-brand-subtitle">
              channels v1.8.3 ⇄ bots v1.6.11 ⇄ 骨架四模块 (Sessions/Tools) ⇄ memory v1.11.6 + knowledge v1.2.0
            </div>
          </div>
        </div>

        <div className="tu-th-filter-bar" role="group" aria-label="事件链路滤镜">
          {FILTER_BUTTONS.map((item) => {
            let btnCls = 'tu-th-filter-btn';
            if (activeFilter === item.key && focusMode !== 'node' && focusMode !== 'journey') {
              btnCls = 'tu-th-filter-btn active';
            }
            return (
              <button
                key={item.key}
                type="button"
                className={btnCls}
                data-th-filter={item.key}
                onClick={() => handleSelectFilter(item.key)}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        <div className="tu-th-toolbar-right">
          <div className="tu-th-ctrl-group">
            <button
              type="button"
              className="tu-th-ctrl-btn"
              title="缩小画布"
              onClick={() => setScale((prev) => Math.max(0.5, prev - 0.1))}
            >
              －
            </button>
            <span className="tu-th-zoom-readout">{String(Math.round(scale * 100))}%</span>
            <button
              type="button"
              className="tu-th-ctrl-btn"
              title="放大画布"
              onClick={() => setScale((prev) => Math.min(1.85, prev + 0.1))}
            >
              ＋
            </button>
            <button
              type="button"
              className="tu-th-ctrl-btn"
              title="重置视角与高亮"
              onClick={handleResetView}
            >
              重置视角
            </button>
          </div>
          <div className="tu-th-ctrl-group">
            <button
              type="button"
              className="tu-th-ctrl-btn"
              title="切换深色/浅色主题"
              onClick={() => {
                if (thTheme === 'dark') {
                  setThTheme('light');
                  return;
                }
                setThTheme('dark');
              }}
            >
              {themeToggleLabel}
            </button>
            <button
              type="button"
              className="tu-th-ctrl-btn"
              title="折叠/展开底部白话讲透面板"
              onClick={() => setDockCollapsed((prev) => !prev)}
            >
              {dockToggleLabel}
            </button>
          </div>
          {props.onCompact !== undefined && (
            <button
              type="button"
              className="tu-cm-detail-btn"
              data-th-compact
              onClick={props.onCompact}
            >
              ⚡ 回到极限压缩
            </button>
          )}
          <button
            type="button"
            className="tu-th-close-btn"
            data-th-close
            onClick={props.onClose}
          >
            ← 返回教程
          </button>
        </div>
      </header>

      {/* ==================== 2. ONE-CLICK FEISHU JOURNEY STRIP ==================== */}
      <section className="tu-th-journey-strip" aria-label="一条飞书消息的完整旅程">
        <div className="tu-th-demo-actions">
          <button
            type="button"
            className={playBtnClass}
            data-th-play-journey
            onClick={handleTogglePlayJourney}
          >
            <span>{playIcon}</span>
            <span>{playLabel}</span>
          </button>
          <button
            type="button"
            className="tu-th-btn-step-nav"
            title="上一步"
            onClick={handlePrevStep}
          >
            ◀
          </button>
          <button
            type="button"
            className="tu-th-btn-step-nav"
            title="下一步"
            onClick={handleNextStep}
          >
            ▶
          </button>
        </div>

        <div className="tu-th-steps-track">
          {tanghuluData.TANGHULU_JOURNEY.map((item, idx) => {
            let pillCls = 'tu-th-step-pill';
            if (focusMode === 'journey' && idx === journeyIdx) {
              pillCls = 'tu-th-step-pill active';
            }
            if (focusMode === 'journey' && idx < journeyIdx) {
              pillCls = 'tu-th-step-pill visited';
            }
            const hasNext = idx < tanghuluData.TANGHULU_JOURNEY.length - 1;
            return (
              <react.Fragment key={item.step}>
                <button
                  type="button"
                  className={pillCls}
                  data-th-step={item.step}
                  onClick={() => {
                    setIsPlaying(false);
                    handleJumpJourneyStep(idx);
                  }}
                >
                  <span className="tu-th-step-num">{String(item.step)}</span>
                  <span>{item.label.slice(2)}</span>
                </button>
                {hasNext && <span className="tu-th-step-sep">→</span>}
              </react.Fragment>
            );
          })}
        </div>

        <div className="tu-th-live-msg" title={liveMsgText}>
          {liveMsgText}
        </div>
      </section>

      {/* ==================== 3. MAIN INTERACTIVE CANVAS VIEWPORT ==================== */}
      <main
        className={viewportClass}
        ref={viewportRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onClick={(event) => {
          if (event.target === viewportRef.current) {
            setIsPlaying(false);
            setActiveFilter('all');
            setFocusMode('none');
          }
        }}
      >
        <div className={stageClass} style={{ transform: stageTransform }}>
          {/* Column Tracks */}
          <div className="tu-th-col-track track-ch" />
          <div className="tu-th-col-track track-bot" />
          <div className="tu-th-col-track track-sk" />
          <div className="tu-th-col-track track-mem" />

          {/* Inter-column Event Zone Headers */}
          <div className="tu-th-ez-label" style={{ left: '258px', width: '202px' }}>
            <span className="tu-th-ez-title">◇ 列间事件区 A (Channels ⇄ Bots)</span>
            <span className="tu-th-ez-sub">向右入站 message · 向左回指 reply</span>
          </div>
          <div className="tu-th-ez-label" style={{ left: '715px', width: '202px' }}>
            <span className="tu-th-ez-title">◇ 列间事件区 B (Bots ⇄ 骨架/记忆)</span>
            <span className="tu-th-ez-sub">会话四关口 · 工具调用 · 记忆召回</span>
          </div>

          {/* 4 Vertical Glowing Tanghulu Bamboo Skewers */}
          <div className="tu-th-skewer skewer-ch" />
          <div className="tu-th-skewer skewer-bot" />
          <div className="tu-th-skewer skewer-sk" />
          <div className="tu-th-skewer skewer-mem" />

          {/* 4 Column Header Cards (2-Row Non-Overlapping Structure) */}
          <div className="tu-th-col-header header-ch">
            <div className="tu-th-col-h-top">
              <div className="tu-th-col-h-title" style={{ color: 'var(--th-col-ch-text)' }}>
                <span>🍡 Channels · 抽象渠道层</span>
              </div>
              <span className="tu-th-col-h-badge">v1.8.3</span>
            </div>
            <div className="tu-th-col-h-sub">plugins/channels + feishu / wechat</div>
          </div>

          <div className="tu-th-col-header header-bot">
            <div className="tu-th-col-h-top">
              <div className="tu-th-col-h-title" style={{ color: 'var(--th-col-bot-text)' }}>
                <span>🍡 Bots · 机器人调度层</span>
              </div>
              <span className="tu-th-col-h-badge">v1.6.11</span>
            </div>
            <div className="tu-th-col-h-sub">plugins/bots + approval / relay</div>
          </div>

          <div className="tu-th-col-header header-sk">
            <div className="tu-th-col-h-top">
              <div className="tu-th-col-h-title" style={{ color: 'var(--th-col-sk-text)' }}>
                <span>🍡 骨架核心 · 会话/工具</span>
              </div>
              <span className="tu-th-col-h-badge">四模块</span>
            </div>
            <div className="tu-th-col-h-sub">src7/&#123;Main,Resources,Sessions,Tools&#125;</div>
          </div>

          <div className="tu-th-col-header header-mem">
            <div className="tu-th-col-h-top">
              <div className="tu-th-col-h-title" style={{ color: 'var(--th-col-mem-text)' }}>
                <span>🍡 Knowledge + Memory</span>
              </div>
              <span className="tu-th-col-h-badge">VGR+双链</span>
            </div>
            <div className="tu-th-col-h-sub">plugins/memory + knowledge v1.2.0</div>
          </div>

          {/* SVG Layer for All Inter-Column & Skewer Event Connections */}
          <svg className="tu-th-connections-svg" viewBox="0 0 1400 564">
            <defs>
              <marker id="th-arrow-amber" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#f59e0b" />
              </marker>
              <marker id="th-arrow-emerald" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#10b981" />
              </marker>
              <marker id="th-arrow-rose" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#f43f5e" />
              </marker>
              <marker id="th-arrow-violet" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#a855f7" />
              </marker>
              <marker id="th-arrow-cyan" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#0ea5e9" />
              </marker>
            </defs>
            <g>
              {tanghuluData.TANGHULU_EDGES.map((edge) => {
                const d = tanghuluData.buildTanghuluEdgePath(edge);
                const isActive = highlightState.activeEdges.has(edge.id);
                let baseCls = 'tu-th-edge-base';
                let flowCls = 'tu-th-edge-flow';
                if (isActive) {
                  baseCls = 'tu-th-edge-base edge-active';
                  flowCls = 'tu-th-edge-flow edge-active';
                }
                return (
                  <react.Fragment key={edge.id}>
                    <path d={d} stroke={edge.color} className={baseCls} />
                    <path d={d} stroke={edge.color} className={flowCls} markerEnd={`url(#${edge.marker})`} />
                  </react.Fragment>
                );
              })}
            </g>
          </svg>

          {/* 20 Tanghulu Cards + 8 Inter-Column Event Diamonds */}
          {nodeList.map((node) => {
            const isSelected = node.id === selectedId;
            const isHighlighted = highlightState.highlightedNodes.has(node.id);
            const roleBadge = highlightState.roleMap.get(node.id);

            if (node.type === 'tanghulu') {
              let cardCls = `tu-th-node ${node.col ?? 'col-ch'}`;
              if (isSelected) {
                cardCls += ' is-selected';
              }
              if (isHighlighted) {
                cardCls += ' is-highlighted';
              }
              const extraChips = (node.chips ?? []).slice(0, 2);
              return (
                <div
                  key={node.id}
                  className={cardCls}
                  style={{ top: `${String(node.y)}px` }}
                  data-th-node={node.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleSelectNode(node.id);
                  }}
                >
                  {roleBadge !== undefined && (
                    <span className={`tu-th-role-badge ${roleBadge.cls}`}>{roleBadge.text}</span>
                  )}
                  <div className="tu-th-node-top">
                    <span className="tu-th-hawthorn-ball">{node.num}</span>
                    <span className="tu-th-node-title">{node.title}</span>
                  </div>
                  <div className="tu-th-node-desc">{node.desc}</div>
                  <div className="tu-th-node-chips">
                    {node.fileTag !== undefined && (
                      <span className="tu-th-mini-chip" style={{ fontWeight: 700 }}>
                        {node.fileTag}
                      </span>
                    )}
                    {extraChips.map((chip) => (
                      <span key={chip} className="tu-th-mini-chip">
                        {chip}
                      </span>
                    ))}
                  </div>
                </div>
              );
            }

            let diamondCls = `tu-th-diamond ${node.color ?? 'ev-amber'}`;
            if (isSelected) {
              diamondCls += ' is-selected';
            }
            if (isHighlighted) {
              diamondCls += ' is-highlighted';
            }
            return (
              <div
                key={node.id}
                className={diamondCls}
                style={{ left: `${String(node.x ?? 258)}px`, top: `${String(node.y)}px` }}
                data-th-node={node.id}
                onClick={(event) => {
                  event.stopPropagation();
                  handleSelectNode(node.id);
                }}
              >
                {roleBadge !== undefined && (
                  <span className={`tu-th-role-badge ${roleBadge.cls}`}>{roleBadge.text}</span>
                )}
                <svg className="tu-th-diamond-svg" viewBox="0 0 202 84">
                  <polygon
                    className="tu-th-diamond-poly"
                    points="101,2 178,23 200,42 178,61 101,82 24,61 2,42 24,23"
                  />
                  <polygon
                    className="tu-th-diamond-inner"
                    points="101,7 173,27 192,42 173,57 101,77 29,57 10,42 29,27"
                  />
                </svg>
                <div className="tu-th-diamond-content">
                  <span className="tu-th-diamond-dir">{node.dirText}</span>
                  <div className="tu-th-diamond-title">{node.title}</div>
                  <div className="tu-th-diamond-sub">{node.sub}</div>
                </div>
              </div>
            );
          })}
        </div>
      </main>

      {/* ==================== 4. BOTTOM PLAIN-LANGUAGE DEEP-DIVE PANEL ==================== */}
      <footer className={dockClass}>
        <div className="tu-th-dock-header">
          <div className="tu-th-dock-title-area">
            <span className="tu-th-dock-badge">📖 白话讲透面板</span>
            <span className="tu-th-dock-name">
              {currentNode.title} ({currentNode.fileTag ?? currentNode.sub ?? ''})
            </span>
            <span className="tu-th-dock-kind">{currentNode.kindLabel}</span>
          </div>
          <span className="tu-th-dock-hint">
            💡 点击画布任意「糖葫芦模块」或「◇ 事件菱形」自动高亮上下游全链路；点击下方胶囊可顺藤摸瓜跳转
          </span>
        </div>

        <div className="tu-th-dock-grid">
          {/* Card 1: 一句话人话说明 + 上下游跳转 */}
          <div className="tu-th-dock-card">
            <div className="tu-th-dock-card-title">
              <span>💬 一句话人话讲透 &amp; 上下游链路</span>
              <span style={{ color: '#fb923c' }}>{stepBadgeText}</span>
            </div>
            <div className="tu-th-dock-human">{currentNode.human}</div>
            <div className="tu-th-chain-pills">
              {[...chainInfo.upstreamNodes].map((uid) => {
                const upNode = tanghuluData.TANGHULU_NODES[uid];
                if (upNode === undefined) return null;
                return (
                  <button
                    key={`up-${uid}`}
                    type="button"
                    className="tu-th-jump-pill up"
                    onClick={() => handleSelectNode(uid)}
                  >
                    ⬅ 上游: {upNode.title}
                  </button>
                );
              })}
              {[...chainInfo.downstreamNodes].map((did) => {
                const downNode = tanghuluData.TANGHULU_NODES[did];
                if (downNode === undefined) return null;
                return (
                  <button
                    key={`down-${did}`}
                    type="button"
                    className="tu-th-jump-pill down"
                    onClick={() => handleSelectNode(did)}
                  >
                    下游: {downNode.title} ➡
                  </button>
                );
              })}
            </div>
          </div>

          {/* Card 2: 真实事件名 & 触发机制 */}
          <div className="tu-th-dock-card">
            <div className="tu-th-dock-card-title">
              <span>⚡ 真实 Cordis 事件名 &amp; 谁发谁听</span>
              <span style={{ color: '#38bdf8' }}>{currentNode.dispatchMode.split(' ')[0]}</span>
            </div>
            <div className="tu-th-meta-list">
              <div className="tu-th-meta-row">
                <span className="tu-th-meta-key">真实事件</span>
                <span className="tu-th-meta-val highlight-ev">{currentNode.realEvents}</span>
              </div>
              <div className="tu-th-meta-row">
                <span className="tu-th-meta-key">派发机制</span>
                <span className="tu-th-meta-val">{currentNode.dispatchMode}</span>
              </div>
              <div className="tu-th-meta-row">
                <span className="tu-th-meta-key">发出方</span>
                <span className="tu-th-meta-val">{currentNode.senders}</span>
              </div>
              <div className="tu-th-meta-row">
                <span className="tu-th-meta-key">监听方</span>
                <span className="tu-th-meta-val">{currentNode.listeners}</span>
              </div>
            </div>
          </div>

          {/* Card 3: 真实载荷字段结构 */}
          <div className="tu-th-dock-card">
            <div className="tu-th-dock-card-title">
              <span>🧬 字段结构与载荷定义 (真实 TS 类型)</span>
              <span style={{ color: '#c084fc' }}>{currentNode.typeName}</span>
            </div>
            <pre className="tu-th-schema-box">{currentNode.schemaText}</pre>
          </div>

          {/* Card 4: 对应源码目录 & 核心函数/工具 */}
          <div className="tu-th-dock-card">
            <div className="tu-th-dock-card-title">
              <span>📂 对应源码目录 &amp; 核心函数/工具</span>
              <span style={{ color: '#34d399' }}>src7/</span>
            </div>
            <div className="tu-th-meta-list">
              <div className="tu-th-meta-row">
                <span className="tu-th-meta-key">源码目录</span>
                <span className="tu-th-meta-val highlight-ev">{currentNode.sourceDir}</span>
              </div>
              <div className="tu-th-meta-row">
                <span className="tu-th-meta-key">核心函数</span>
                <span className="tu-th-meta-val">{currentNode.keyFunctions}</span>
              </div>
              <div className="tu-th-meta-row">
                <span className="tu-th-meta-key">工具/接口</span>
                <span className="tu-th-meta-val">{currentNode.toolsOrRoutes}</span>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}


/**
 * 教程页「糖葫芦架构」入口：默认进入符合 4~6 工作记忆组块的极限压缩全景，可随时切换 28 节点原详图。
 * @param props.onClose 关闭画布返回教程主视图。
 */
export function TanghuluCanvas(props: { onClose: () => void }): react.JSX.Element {
  //M 独立外层包装持有视图切换开关，确保子组件内部 React Hooks 顺序恒定不崩。
  const [compact, setCompact] = react.useState<boolean>(true);
  if (compact) return <compactView.CompactMetaView onDetail={() => setCompact(false)} onClose={props.onClose} />;

  return <TanghuluDetail onClose={props.onClose} onCompact={() => setCompact(true)} />;
}
