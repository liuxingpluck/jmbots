/**
 * 单步真实事件载荷 Diff 卡、整条消息按需缓存与 Markdown / JSON 导出工具（工单乙）。
 *   PayloadDiff      ：展示本步采集到的事件参数对象（只看变化 / 完整对象切换，点改动行自动展开前后对象树对应路径并高亮；
 *                      改动行可按路径或值搜索、按增/改/删快切、单行复制路径/值；完整对象可全部展开/收起）；
 *   CopyButton / CopySiteButton：带「已复制」反馈的小复制按钮，DevMap、SpineCanvas 的「复制断点」也用它；
 *   usePayloadTrail  ：按消息号缓存整条消息的 PayloadTrail，切步零重复请求，404 或空 items 静默回退；
 *   PayloadExportBar ：一键复制整条消息的 Markdown 摘要、一键下载 PayloadItem[] JSON。
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import * as i18n from '../I18n.ts';
import { SiteLink } from '../VscodeLink.tsx';
import {
  TutorialApi,
  type PayloadDiff as DiffRow,
  type PayloadItem,
  type PayloadTrail,
  type Trail,
  type TrailDataFlow,
} from './TutorialApi.ts';
import './PayloadDiff.css';


/** 完成态载荷 FIFO 缓存上限（最多保留 30 条完整消息载荷，超限淘汰最早写入项）。 */
const MAX_CACHE_ENTRIES = 30;

/** 单个对象节点默认展开深度，与教程其他 JSON 面板保持一致。 */
const DEFAULT_OPEN_DEPTH = 2;

/** 单层数组或对象默认最多渲染前多少项，超出可点击展开全部。 */
const INITIAL_CHILD_LIMIT = 40;

/** 已完结消息的载荷缓存表（name -> PayloadTrail）。 */
const payloadCache = new Map<string, PayloadTrail>();

/** 正在请求中的载荷 Promise 表，防止同一消息多处挂载并发重拉。 */
const payloadInFlight = new Map<string, Promise<PayloadTrail>>();


/**
 * 从轨迹对象推导后端 payload 接口所需的消息标识（启动轨迹为 boot）。
 * @param trail 当前轨迹。
 */
export function getTrailPayloadName(trail: Trail): string {
  if (trail.message > 0) return String(trail.message);

  return 'boot';
}


/**
 * 按消息号读取并缓存整条消息的载荷；正在运行或尚为空/带缺失说明的结果合并在途请求但不固化进完成态缓存。
 * @param name 消息号或 boot。
 * @param cacheable 是否允许写入完成态缓存（running 态传 false）。
 */
export function loadPayloadCached(name: string, cacheable = true): Promise<PayloadTrail> {
  if (name === '' || name === 'boot') {
    return Promise.resolve({ ok: true, message: name || 'boot', note: '', items: [] });
  }
  if (cacheable) {
    const hit = payloadCache.get(name);
    if (hit !== undefined) return Promise.resolve(hit);
  }
  const existing = payloadInFlight.get(name);
  if (existing !== undefined) return existing;

  //M 发起单次 GET /api/tutorial/payload 请求；在 finally 中清理在途表，仅把完整非空结果写入 FIFO 上限缓存。
  const pending = TutorialApi.getPayload(name)
    .then((result) => {
      if (cacheable && result.items.length > 0 && !result.note) {
        if (payloadCache.size >= MAX_CACHE_ENTRIES && !payloadCache.has(name)) {
          const oldestKey = payloadCache.keys().next().value;
          if (oldestKey !== undefined) payloadCache.delete(oldestKey);
        }
        payloadCache.set(name, result);
      }
      return result;
    })
    .finally(() => {
      payloadInFlight.delete(name);
    });
  payloadInFlight.set(name, pending);
  return pending;
}


/**
 * 订阅当前轨迹的事件参数载荷，切换同消息不同步骤时直接命中内存缓存不发新请求。
 * @param trail 当前轨迹。
 */
export function usePayloadTrail(trail: Trail): PayloadTrail | null {
  const name = getTrailPayloadName(trail);
  const cacheable = trail.state !== 'running';
  const [data, setData] = useState<PayloadTrail | null>(() => {
    if (name === 'boot') return { ok: true, message: 'boot', note: '', items: [] };

    return payloadCache.get(name) ?? null;
  });

  useEffect(() => {
    if (name === 'boot') {
      setData({ ok: true, message: 'boot', note: '', items: [] });
      return undefined;
    }
    const cached = payloadCache.get(name);
    if (cacheable && cached !== undefined) {
      setData(cached);
      return undefined;
    }

    //M 没命中缓存：先清掉上一条消息的载荷，免得请求回来前按步号串到这条消息上（0.7.90 审计 P1-2）。
    setData((current) => {
      if (current?.message === name) return current;

      return null;
    });
    let alive = true;
    void loadPayloadCached(name, cacheable).then(
      (loaded) => {
        if (alive) setData(loaded);
      },
      () => {
        //G 请求异常时回退空清单，杜绝未捕获的 Promise rejection。
        if (alive) setData({ ok: true, message: name, note: '', items: [] });
      },
    );
    return () => {
      alive = false;
    };
  }, [cacheable, name, trail.steps.length]);

  //G 兜底：这一拍 effect 还没跑（刚切消息），手里是上一条的就当还没拿到。
  if (data !== null && data.message !== name) return null;

  return data;
}


/**
 * 复制按钮文案状态与剪贴板写入钩子：兼容 HTTPS 与局域网 HTTP，组件卸载时自动清理还原定时器。
 * @param resetWord 默认及还原后的按钮文字。
 */
function useCopyFeedback(resetWord: string): { label: string; copy: (text: string) => void } {
  const [label, setLabel] = useState(resetWord);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const copy = useCallback((text: string): void => {
    const finish = (ok: boolean): void => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      let tip = '复制失败，请手动选中';
      if (ok) tip = '已复制 ✓';
      setLabel(tip);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setLabel(resetWord);
      }, 1800);
    };
    if (window.isSecureContext && navigator.clipboard !== undefined) {
      void navigator.clipboard.writeText(text).then(() => finish(true), () => finish(false));
      return;
    }
    //G 局域网非 HTTPS 打开时回退隐藏 textarea 复制，确保本地调试一键可用。
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      finish(ok);
    } catch {
      finish(false);
    }
  }, [resetWord]);

  return { label, copy };
}


/**
 * 一个小复制按钮：点了复制 text，按钮上短暂显示「已复制 ✓」再还原（剪贴板容错见 useCopyFeedback）。
 * 载荷改动行的「复制路径 / 复制值」、DevMap 与 SpineCanvas 的「复制断点」共用。
 * @param props.text 要复制的文字。
 * @param props.word 按钮上平时的字。
 * @param props.title 鼠标悬停的说明。
 */
export function CopyButton(props: { text: string; word: string; title: string }): JSX.Element {
  const feedback = useCopyFeedback(props.word);
  return (
    <button
      type="button"
      className="tu-pd-act-btn tu-pd-copy-btn"
      title={props.title}
      onClick={(event) => {
        //G 放在可点的行或折叠头里时，不让点击冒上去触发定位或开合。
        event.stopPropagation();
        feedback.copy(props.text);
      }}
    >
      {feedback.label}
    </button>
  );
}


/**
 * 一个源码位置旁的「复制断点」：复制 `src7/Sessions.ts:890` 这样的 file:line，VS Code 里 Ctrl+P 粘贴直跳。
 * @param props.site 文件:行号。
 */
export function CopySiteButton(props: { site: string }): JSX.Element {
  const title = `复制 ${props.site}，VS Code 里 Ctrl+P 粘贴直跳`;
  return <CopyButton text={props.site} word="复制断点" title={title} />;
}


/**
 * 将后端 diff 路径（如 `messages[3].content` 或 `system[2]`）拆成规范段数组 `['messages', '3', 'content']`。
 * @param rawPath 原始路径文本。
 */
function parseDiffPath(rawPath: string): string[] {
  if (rawPath === '') return [];

  const normalized = rawPath.replace(/\[(\d+)\]/gu, '.$1').replace(/^\./u, '');
  return normalized.split('.').filter((seg) => seg !== '');
}


/**
 * 把段数组拼回标准比较键（用 `/` 连接，避免键名本身含点号冲突）。
 */
function toPathKey(segments: readonly string[]): string {
  return segments.join('\u001f');
}


/**
 * 为单棵对象树建立「变更路径颜色表」与「聚焦路径的全部祖先集合」。
 */
function buildTreeHighlightMeta(
  diffs: readonly DiffRow[],
  focusPath: string,
): { changedMap: Map<string, DiffRow['kind']>; focusKey: string; focusAncestors: Set<string> } {
  const changedMap = new Map<string, DiffRow['kind']>();
  for (const row of diffs) {
    if (row.kind === 'same') continue;

    const segs = parseDiffPath(row.path);
    if (segs.length > 0) {
      changedMap.set(toPathKey(segs), row.kind);
    }
  }
  const focusSegs = parseDiffPath(focusPath);
  const focusKey = toPathKey(focusSegs);
  const focusAncestors = new Set<string>();
  for (let len = 1; len < focusSegs.length; len += 1) {
    focusAncestors.add(toPathKey(focusSegs.slice(0, len)));
  }
  return { changedMap, focusKey, focusAncestors };
}


/**
 * 渲染基础标量值（字符串、数字、布尔、null、undefined）。
 */
function renderScalarValue(value: unknown): JSX.Element {
  if (typeof value === 'string') {
    return <span className="tu-pd-tree-str">{JSON.stringify(value)}</span>;
  }
  if (typeof value === 'number') {
    return <span className="tu-pd-tree-num">{String(value)}</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="tu-pd-tree-lit">{String(value)}</span>;
  }
  if (value === null) {
    return <span className="tu-pd-tree-lit">null</span>;
  }
  return <span className="tu-pd-tree-lit">{String(value)}</span>;
}


/** 「全部展开 / 全部收起」的指令：每点一次 tick 加一，树上每个节点照 open 开合一次。 */
interface TreeBulk {
  /** 这次是全部展开还是全部收起。 */
  open: boolean;
  /** 第几次点；0 表示还没点过，节点保持默认开合。 */
  tick: number;
}


/** 递归对象树单节点属性。 */
interface TreeNodeProps {
  label: string | null;
  value: unknown;
  segments: readonly string[];
  depth: number;
  changedMap: ReadonlyMap<string, DiffRow['kind']>;
  focusKey: string;
  focusAncestors: ReadonlySet<string>;
  /** 卡片顶上「全部展开 / 全部收起」发来的指令。 */
  bulk: TreeBulk;
}


/**
 * 可折叠 JSON 节点：默认展开前两层，点击「这一步改了」任意路径时自动沿祖先链展开并高亮目标键。
 */
function PayloadTreeNode(props: TreeNodeProps): JSX.Element {
  const { label, value, segments, depth, changedMap, focusKey, focusAncestors, bulk } = props;
  const nodeKey = toPathKey(segments);
  const mustOpen = focusAncestors.has(nodeKey) || (focusKey !== '' && nodeKey === focusKey);
  const [open, setOpen] = useState<boolean>(() => {
    //M 点过「全部展开 / 全部收起」之后新挂上的子节点照指令开合，不再回到默认深度。
    if (bulk.tick > 0) return bulk.open || mustOpen || depth === 0;

    return depth < DEFAULT_OPEN_DEPTH || mustOpen;
  });
  const [showAll, setShowAll] = useState(false);
  //M 这个节点已经照着办过的那次指令；挂上时算办过，新挂的子节点由上面的初始值管。
  const appliedTickRef = useRef(bulk.tick);

  useEffect(() => {
    if (mustOpen) setOpen(true);
  }, [mustOpen]);

  useEffect(() => {
    if (appliedTickRef.current === bulk.tick) return;

    //M 每点一次「全部展开 / 全部收起」，已挂着的节点照指令开合一次；根节点收起时保留一层，免得整块只剩一个括号。
    appliedTickRef.current = bulk.tick;
    setOpen(bulk.open || depth === 0);
  }, [bulk.open, bulk.tick, depth]);

  const changeKind = changedMap.get(nodeKey);
  let lineClass = 'tu-pd-tree-line';
  if (changeKind === 'add') lineClass += ' changed-add';
  if (changeKind === 'change') lineClass += ' changed-change';
  if (changeKind === 'remove') lineClass += ' changed-remove';
  if (focusKey !== '' && nodeKey === focusKey) lineClass += ' focused';

  const isObj = typeof value === 'object' && value !== null;
  if (!isObj) {
    return (
      <div className="tu-pd-tree-node">
        <div className={lineClass}>
          {label !== null && <span className="tu-pd-tree-key">{label}:</span>}
          {renderScalarValue(value)}
        </div>
      </div>
    );
  }

  const isArr = Array.isArray(value);
  let entries: [string, unknown][] = [];
  if (isArr) {
    entries = value.map((item, idx) => [String(idx), item]);
  }
  if (!isArr) {
    entries = Object.entries(value as Record<string, unknown>);
  }

  //M 若聚焦路径落在数组/对象较后位置，自动放开截断以便直接看到目标项。
  let visibleEntries = entries;
  const hasMore = !showAll && !mustOpen && entries.length > INITIAL_CHILD_LIMIT;
  if (hasMore) {
    visibleEntries = entries.slice(0, INITIAL_CHILD_LIMIT);
  }

  let openBracket = '{';
  let closeBracket = '}';
  let summaryUnit = `${String(entries.length)} 键`;
  if (isArr) {
    openBracket = '[';
    closeBracket = ']';
    summaryUnit = `${String(entries.length)} 项`;
  }
  let arrow = '▸';
  if (open) arrow = '▾';

  return (
    <div className="tu-pd-tree-node">
      <div className={lineClass}>
        <button
          type="button"
          className="tu-pd-tree-toggle"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          {arrow}
        </button>
        {label !== null && <span className="tu-pd-tree-key">{label}:</span>}
        <span className="tu-pd-tree-lit">
          {openBracket}
          {!open && ` ${summaryUnit} ${closeBracket}`}
          {open && entries.length === 0 && closeBracket}
        </span>
      </div>
      {open && entries.length > 0 && (
        <div>
          {visibleEntries.map(([childKey, childVal]) => {
            let childLabel = childKey;
            if (isArr) childLabel = `[${childKey}]`;
            return (
              <PayloadTreeNode
                key={childKey}
                label={childLabel}
                value={childVal}
                segments={[...segments, childKey]}
                depth={depth + 1}
                changedMap={changedMap}
                focusKey={focusKey}
                focusAncestors={focusAncestors}
                bulk={bulk}
              />
            );
          })}
          {hasMore && (
            <div className="tu-pd-tree-node">
              <button type="button" className="tu-pd-act-btn" onClick={() => setShowAll(true)}>
                展开其余 {String(entries.length - INITIAL_CHILD_LIMIT)} 项…
              </button>
            </div>
          )}
          <div className="tu-pd-tree-line">
            <span className="tu-pd-tree-lit">{closeBracket}</span>
          </div>
        </div>
      )}
    </div>
  );
}


/** 改动行默认先画几行，其余点「展开其余」再画（上千行的 diff 一次全画会卡）。 */
const ROW_LIMIT = 200;


/**
 * 单棵对象面板（支持一键复制整块格式化 JSON 与按路径展开高亮）。
 */
function ObjectTreeBox(props: {
  title: string;
  value: unknown;
  emptyText: string;
  diffs: readonly DiffRow[];
  focusPath: string;
  collapsible: boolean;
  forceOpen: boolean;
  bulk: TreeBulk;
}): JSX.Element {
  const copyJson = useCopyFeedback('复制 JSON');
  const meta = useMemo(
    () => buildTreeHighlightMeta(props.diffs, props.focusPath),
    [props.diffs, props.focusPath],
  );
  //M 整块 JSON 点复制时才序列化：256KB 的载荷每次渲染都 stringify 会让打字搜索卡（0.7.90 审计 P1-3）。
  const hasValue = props.value !== undefined && props.value !== null;
  const copyBtn = hasValue && (
    <button
      type="button"
      className="tu-pd-act-btn"
      onClick={(event) => {
        event.stopPropagation();
        const rawJson = JSON.stringify(props.value, null, 2);
        copyJson.copy(rawJson);
      }}
    >
      {copyJson.label}
    </button>
  );

  const treeContent = (
    <div className="tu-pd-box-body">
      {(props.value === undefined || props.value === null) && (
        <span className="tu-pd-listeners">{props.emptyText}</span>
      )}
      {props.value !== undefined && props.value !== null && (
        <div className="tu-pd-tree tu-pd-tree-root">
          <PayloadTreeNode
            label={null}
            value={props.value}
            segments={[]}
            depth={0}
            changedMap={meta.changedMap}
            focusKey={meta.focusKey}
            focusAncestors={meta.focusAncestors}
            bulk={props.bulk}
          />
        </div>
      )}
    </div>
  );

  if (props.collapsible) {
    return (
      <details className="tu-pd-box" open={props.forceOpen || (props.bulk.tick > 0 && props.bulk.open)}>
        <summary>
          <span>▸ {props.title}</span>
          {copyBtn}
        </summary>
        {treeContent}
      </details>
    );
  }

  return (
    <div className="tu-pd-box">
      <div className="tu-pd-box-head">
        <span>{props.title}</span>
        {copyBtn}
      </div>
      {treeContent}
    </div>
  );
}


/**
 * 生成整条消息的 Markdown 摘要（每步一行：步号、事件/阶段、对象，附前 3 条改动）。
 */
export function formatTrailMarkdownSummary(
  trail: Trail,
  dataFlow: TrailDataFlow | null,
  payload: PayloadTrail | null,
  t: i18n.Translate,
): string {
  const name = getTrailPayloadName(trail);
  const head = `# 消息 #${name} 数据流转摘要（${String(trail.steps.length)} 步 · ${String(trail.ms)}ms）`;
  const lines = [head, ''];
  if (trail.preview !== '') {
    lines.push(`> 原话：${trail.preview}`, '');
  }

  const itemsByStep = new Map<number, PayloadItem[]>();
  for (const item of payload?.items ?? []) {
    const bucket = itemsByStep.get(item.step) ?? [];
    bucket.push(item);
    itemsByStep.set(item.step, bucket);
  }

  for (const step of trail.steps) {
    const stepItems = itemsByStep.get(step.no) ?? [];
    if (stepItems.length > 0) {
      for (const pItem of stepItems) {
        const muts = pItem.diff.filter((row) => row.kind !== 'same').slice(0, 3);
        const parts = muts.map((row) => {
          if (row.kind === 'add') return `+${row.path}=${row.after ?? ''}`;
          if (row.kind === 'remove') return `-${row.path}`;
          return `~${row.path}: ${row.before ?? ''} → ${row.after ?? ''}`;
        });
        let detail = '透传无改写';
        if (parts.length > 0) detail = parts.join('；');
        lines.push(`- **#${String(step.no)}** \`${pItem.event}\` · \`${pItem.object}\`：${detail}`);
      }
      continue;
    }
    const flowStep = dataFlow?.steps.find((entry) => entry.step === step.no);
    let eventOrStage = step.node;
    if (flowStep !== undefined && flowStep.outgoing.via !== '') {
      eventOrStage = `${step.node} (${flowStep.outgoing.via})`;
    }
    const fallbackChanges = (flowStep?.changes ?? []).slice(0, 3).map(
      (ch) => `${ch.target}.${ch.field}: ${ch.before || '空'} → ${ch.after || '空'}`,
    );
    let summaryText = flowStep?.summary || step.title || t(step.node);
    if (fallbackChanges.length > 0) summaryText = fallbackChanges.join('；');
    lines.push(`- **#${String(step.no)}** \`${eventOrStage}\`：${summaryText}`);
  }
  return lines.join('\n');
}


/**
 * 将整条消息的 `PayloadItem[]` 打包成 `.payload.json` Blob 触发浏览器下载。
 */
export function triggerPayloadJsonDownload(name: string, items: readonly PayloadItem[]): void {
  const content = JSON.stringify(items, null, 2);
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = `${name}.payload.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}


/**
 * 供 DataFlowTable 顶栏与载荷卡共用的「复制摘要 / 下载 JSON」按钮组。
 */
export function PayloadExportBar(props: {
  trail: Trail;
  dataFlow: TrailDataFlow | null;
}): JSX.Element {
  const { trail, dataFlow } = props;
  const t = i18n.useT();
  const payload = usePayloadTrail(trail);
  const copySummary = useCopyFeedback('复制摘要');
  const name = getTrailPayloadName(trail);

  const onCopySummary = (): void => {
    //M 按需确保拿到最新缓存后生成整条消息的 Markdown 摘要并复制。
    void loadPayloadCached(name, trail.state !== 'running').then(
      (loaded) => {
        const md = formatTrailMarkdownSummary(trail, dataFlow, loaded, t);
        copySummary.copy(md);
      },
      () => {
        const md = formatTrailMarkdownSummary(trail, dataFlow, null, t);
        copySummary.copy(md);
      },
    );
  };

  const onDownloadJson = (): void => {
    void loadPayloadCached(name, trail.state !== 'running').then(
      (loaded) => {
        triggerPayloadJsonDownload(name, loaded.items);
      },
      () => {
        triggerPayloadJsonDownload(name, []);
      },
    );
  };

  let jsonTitle = '下载整条消息的 PayloadItem[] JSON';
  if (payload !== null && payload.items.length > 0) {
    jsonTitle = `下载 ${String(payload.items.length)} 条事件载荷 JSON`;
  }

  return (
    <div className="tu-dft-export-bar">
      <button
        type="button"
        className="tu-pd-act-btn"
        data-export-md
        onClick={onCopySummary}
      >
        {copySummary.label}
      </button>
      <button
        type="button"
        className="tu-pd-act-btn"
        data-export-json
        title={jsonTitle}
        onClick={onDownloadJson}
      >
        下载 JSON
      </button>
    </div>
  );
}


/** 改动行快切：全部，或只看增、改、删其中一类。 */
type KindFilter = 'all' | 'add' | 'change' | 'remove';

/** 快切胶囊的顺序和字。 */
const KIND_FILTERS: readonly { kind: KindFilter; word: string }[] = [
  { kind: 'all', word: '全部' },
  { kind: 'add', word: '+ 增' },
  { kind: 'change', word: '~ 改' },
  { kind: 'remove', word: '- 删' },
];


/**
 * 按快切类型和搜索词筛改动行：词不分大小写，路径、前值、后值任一含它就算命中。
 * @param rows 本张卡的改动行（不含 same）。
 * @param query 搜索框里的字；空白当没填。
 * @param kind 只看哪一类；all 不限。
 */
function filterDiffRows(rows: readonly DiffRow[], query: string, kind: KindFilter): DiffRow[] {
  const word = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (kind !== 'all' && row.kind !== kind) return false;

    if (word === '') return true;

    const haystack = `${row.path}\n${row.before ?? ''}\n${row.after ?? ''}`.toLowerCase();
    return haystack.includes(word);
  });
}


/**
 * 一条改动行「复制值」复制的那个值：删掉的取前值，增加和改动取后值。
 * @param row 改动行。
 */
function getRowValue(row: DiffRow): string {
  if (row.kind === 'remove') return row.before ?? '';

  return row.after ?? '';
}


/**
 * 一条改动行：主体可点（切完整对象并定位到这条路径），右侧「复制路径 / 复制值」两个小按钮。
 * @param props.row 改动行。
 * @param props.focused 是不是当前定位的那条。
 * @param props.onPick 点主体时调，实现是 SinglePayloadCard 的 pickDiffRow。
 */
function DiffRowView(props: { row: DiffRow; focused: boolean; onPick: (path: string) => void }): JSX.Element {
  const { row } = props;
  let opSymbol = '~';
  if (row.kind === 'add') opSymbol = '+';
  if (row.kind === 'remove') opSymbol = '-';
  let rowClass = `tu-pd-diff-row kind-${row.kind}`;
  if (props.focused) rowClass += ' focused';
  const value = getRowValue(row);

  return (
    <div className={rowClass}>
      <button
        type="button"
        className="tu-pd-diff-main"
        title="点击在前后完整对象树中展开并高亮此路径"
        onClick={() => props.onPick(row.path)}
      >
        <span className={`tu-pd-op ${row.kind}`}>{opSymbol}</span>
        <code className="tu-pd-path">{row.path}</code>
        {row.kind === 'add' && row.after !== undefined && (
          <span className="tu-pd-preview"><span className="after">{row.after}</span></span>
        )}
        {row.kind === 'remove' && row.before !== undefined && (
          <span className="tu-pd-preview"><span className="before">{row.before}</span></span>
        )}
        {row.kind === 'change' && (
          <span className="tu-pd-preview">
            <span className="before">{row.before ?? '空'}</span>
            {' → '}
            <span className="after">{row.after ?? '空'}</span>
          </span>
        )}
      </button>
      <span className="tu-pd-row-tools">
        <CopyButton text={row.path} word="复制路径" title={`复制路径 ${row.path}`} />
        {value !== '' && (
          <CopyButton
            text={value}
            word="复制值"
            title="复制这一行的值预览（最多 200 字；删掉的取前值，其余取后值）"
          />
        )}
      </span>
    </div>
  );
}


/**
 * 单张事件参数载荷对比卡（支持「只看变化」与「完整对象」切换）。
 */
function SinglePayloadCard(props: {
  item: PayloadItem;
  workspace: string;
  compact: boolean;
}): JSX.Element {
  const { item, workspace, compact } = props;
  const [mode, setMode] = useState<'diff' | 'full'>('diff');
  const [focusPath, setFocusPath] = useState('');
  //M 改动行筛选：搜索框里的字（按路径或前后值匹配，不分大小写）与增/改/删快切。
  const [query, setQuery] = useState('');
  //M 筛选用延后的搜索词：输入框照常跟手，上千行的筛选和重画放到空闲时（0.7.90 审计 P1-3）。
  const deferredQuery = useDeferredValue(query);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  //M 改动行先画前 ROW_LIMIT 行，点「展开其余」才画全。
  const [showAllRows, setShowAllRows] = useState(false);
  //M 完整对象视图「全部展开 / 全部收起」的指令，左右两棵树共用。
  const [bulk, setBulk] = useState<TreeBulk>({ open: true, tick: 0 });
  const isNarrowScreen = typeof window !== 'undefined' && window.innerWidth < 800;
  const collapsibleTrees = compact || isNarrowScreen;

  const mutations = useMemo(() => item.diff.filter((row) => row.kind !== 'same'), [item.diff]);
  const visibleMutations = useMemo(
    () => filterDiffRows(mutations, deferredQuery, kindFilter),
    [mutations, deferredQuery, kindFilter],
  );
  let shownMutations = visibleMutations;
  if (!showAllRows) {
    shownMutations = visibleMutations.slice(0, ROW_LIMIT);
  }
  const hiddenRows = visibleMutations.length - shownMutations.length;

  const pressBulk = (open: boolean): void => {
    //M 每点一次 tick 加一，树上已挂的节点据此开合一次（见 PayloadTreeNode）。
    setBulk((prev) => ({ open, tick: prev.tick + 1 }));
  };

  const sameKeys = useMemo(
    () => item.diff.filter((row) => row.kind === 'same').map((row) => row.path),
    [item.diff],
  );

  const pickDiffRow = (path: string): void => {
    //M 点击改动行：切到完整对象视图并自动展开左右两棵树定位到该路径。
    setFocusPath(path);
    setMode('full');
  };

  let listenersText = '无监听插件';
  if (item.listeners.length > 0) {
    listenersText = `听的：${item.listeners.join(', ')}`;
  }
  let gridClass = 'tu-pd-grid';
  if (mode === 'full') gridClass += ' full-mode';

  return (
    <article className="tu-pd-card" data-payload-seq={item.seq} data-payload-event={item.event}>
      <div className="tu-pd-head">
        <div className="tu-pd-head-meta">
          <span className="tu-pd-seq-pill">载荷 #{String(item.seq)}</span>
          <code className="tu-pd-event">{item.event}</code>
          {item.object !== '' && <span className="tu-pd-obj">{item.object}</span>}
          {item.site !== '' && <SiteLink workspace={workspace} site={item.site} />}
          {item.truncated && <span className="tu-pd-trunc-badge">已截断</span>}
          <span className="tu-pd-listeners">{listenersText}</span>
        </div>

        <div className="tu-pd-head-tools">
          <div className="tu-pd-seg" role="group" aria-label="载荷展示模式">
            <button
              type="button"
              className="tu-pd-seg-btn"
              data-payload-mode="diff"
              aria-pressed={mode === 'diff'}
              onClick={() => setMode('diff')}
            >
              只看变化 ({String(mutations.length)})
            </button>
            <button
              type="button"
              className="tu-pd-seg-btn"
              data-payload-mode="full"
              aria-pressed={mode === 'full'}
              onClick={() => setMode('full')}
            >
              完整对象
            </button>
          </div>
          {mode === 'full' && (
            <>
              <button
                type="button"
                className="tu-pd-act-btn"
                data-payload-bulk="open"
                onClick={() => pressBulk(true)}
              >
                全部展开
              </button>
              <button
                type="button"
                className="tu-pd-act-btn"
                data-payload-bulk="close"
                onClick={() => pressBulk(false)}
              >
                全部收起
              </button>
            </>
          )}
        </div>
      </div>

      <div className={gridClass}>
        {mode === 'full' && (
          <div className="tu-pd-col-before">
            <ObjectTreeBox
              title="进来的（dispatch 前）"
              value={item.before}
              emptyText="无入参"
              diffs={item.diff}
              focusPath={focusPath}
              collapsible={collapsibleTrees}
              forceOpen={focusPath !== ''}
              bulk={bulk}
            />
          </div>
        )}

        <div className="tu-pd-col-diff">
          <div className="tu-pd-box">
            <div className="tu-pd-box-head">
              <span>这一步改了</span>
              {focusPath !== '' && mode === 'full' && (
                <button type="button" className="tu-pd-act-btn" onClick={() => setFocusPath('')}>
                  取消定位
                </button>
              )}
            </div>
            <div className="tu-pd-box-body">
              {item.after === null && (
                <div className="tu-pd-same-bar">未采到后态（可能本轮尚未完结或已是末尾事件），可切「完整对象」查看进来的参数</div>
              )}
              {item.after !== null && mutations.length === 0 && (
                <div className="tu-pd-same-bar">监听插件未改动字段（全部原样透传）</div>
              )}
              {mutations.length > 0 && (
                <div className="tu-pd-filter-bar">
                  <input
                    type="search"
                    className="tu-pd-filter-input"
                    data-payload-filter
                    placeholder="按字段路径或值筛选，如 system / tools / messages / state"
                    aria-label="按字段路径或值筛选改动"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <div className="tu-pd-seg" role="group" aria-label="只看哪类改动">
                    {KIND_FILTERS.map((entry) => (
                      <button
                        key={entry.kind}
                        type="button"
                        className="tu-pd-seg-btn"
                        data-payload-kind={entry.kind}
                        aria-pressed={kindFilter === entry.kind}
                        onClick={() => setKindFilter(entry.kind)}
                      >
                        {entry.word}
                      </button>
                    ))}
                  </div>
                  <span className="tu-pd-listeners" data-payload-hits>
                    匹配 {String(visibleMutations.length)} / {String(mutations.length)}
                  </span>
                </div>
              )}
              {mutations.length > 0 && visibleMutations.length === 0 && (
                <div className="tu-pd-same-bar">没有匹配的改动，换个词或切回「全部」</div>
              )}
              {visibleMutations.length > 0 && (
                <div className="tu-pd-diff-list">
                  {shownMutations.map((row, idx) => (
                    <DiffRowView
                      key={`${row.path}-${String(idx)}`}
                      row={row}
                      focused={focusPath === row.path}
                      onPick={pickDiffRow}
                    />
                  ))}
                  {hiddenRows > 0 && (
                    <button type="button" className="tu-pd-act-btn" onClick={() => setShowAllRows(true)}>
                      展开其余 {String(hiddenRows)} 条
                    </button>
                  )}
                </div>
              )}
              {sameKeys.length > 0 && (
                <div className="tu-pd-same-bar">
                  <span className="tu-pd-op same">=</span> 透传顶层键：{sameKeys.join(', ')}
                </div>
              )}
            </div>
          </div>
        </div>

        {mode === 'full' && (
          <div className="tu-pd-col-after">
            <ObjectTreeBox
              title="交出去的（监听跑完后）"
              value={item.after}
              emptyText="尚无后态快照"
              diffs={item.diff}
              focusPath={focusPath}
              collapsible={collapsibleTrees}
              forceOpen={focusPath !== ''}
              bulk={bulk}
            />
          </div>
        )}
      </div>
    </article>
  );
}


/**
 * 挂载在 StepDataFlowPanel「状态变化」上方的真实事件载荷对比区：
 * 接口 404 或无载荷且无提示原因时完全静默不占高，保留下方原有胶囊展示。
 */
export function PayloadDiff(props: {
  trail: Trail;
  stepNo: number;
  workspace: string;
  dataFlow?: TrailDataFlow | null;
  compact?: boolean;
}): JSX.Element | null {
  const { trail, stepNo, workspace, dataFlow = null, compact = false } = props;
  const payload = usePayloadTrail(trail);
  if (payload === null) return null;

  const stepItems = payload.items.filter((item) => item.step === stepNo);
  if (payload.items.length === 0) {
    if (payload.note === '') return null;

    return (
      <div className="tu-pd-stack">
        <div className="tu-pd-empty-note">这条消息没有录到载荷：{payload.note}</div>
      </div>
    );
  }

  if (stepItems.length === 0) {
    return (
      <div className="tu-pd-stack">
        <div className="tu-pd-head">
          <span className="tu-pd-listeners">
            本步未发出白名单事件（整条消息已录到 {String(payload.items.length)} 处事件载荷）
          </span>
          <PayloadExportBar trail={trail} dataFlow={dataFlow} />
        </div>
      </div>
    );
  }

  return (
    <div className="tu-pd-stack" aria-label="本步真实事件载荷对比">
      <div className="tu-pd-head">
        <span className="tu-df-sec-label">真实事件载荷对比（进来的 → 这一步改了 → 交出去的）</span>
        <PayloadExportBar trail={trail} dataFlow={dataFlow} />
      </div>
      {payload.note !== '' && <div className="tu-pd-empty-note">{payload.note}</div>}
      {stepItems.map((item) => (
        <SinglePayloadCard
          key={item.seq}
          item={item}
          workspace={workspace}
          compact={compact}
        />
      ))}
    </div>
  );
}
