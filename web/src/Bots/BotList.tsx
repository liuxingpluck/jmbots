/**
 * 左栏（docs/界面/01_界面设计.md 第 6 节）：有几个机器人列几个，每个一张小卡片（头像、醒目的名字、可爱的状态框）；
 * 点卡片换机器人并在右栏打开它的工作区（详情还在右栏标签栏里）；左下角只保留设置、连接灯与版本号。
 * 机器人卡片与下面“正在做的事”会话清单合并放进 react-virtuoso 虚拟滚动列表，支持鼠标点击和 ↑/↓ 键上下切换。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as virtuoso from 'react-virtuoso';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import type * as types from '../Types.ts';
import './BotList.css';
import * as connections from './Connections.tsx';
import * as runningList from './RunningList.tsx';
import * as sprite from './Sprite.tsx';
import * as statusModule from './Status.ts';
import * as updateEntry from './UpdateEntry.tsx';


/** 左栏虚拟列表滚动到底部和顶部时上下各预渲染的像素缓冲。 */
const LIST_OVERSCAN_PX = 240;


/** 左栏虚拟列表中的单行数据模型。 */
type LeftVirtualRow =
  | {
      /** 机器人卡片行。 */
      kind: 'bot';
      /** react-virtuoso 稳定行键。 */
      key: string;
      /** 机器人视图；离线空占位时为 undefined。 */
      bot: types.BotView | undefined;
      /** 展示名称。 */
      name: string;
      /** 后端当前是否在线。 */
      online: boolean;
    }
  | {
      /** “正在做的事”分区小标题。 */
      kind: 'running-head';
      /** react-virtuoso 稳定行键。 */
      key: string;
    }
  | {
      /** 单条正在运行的任务/会话行。 */
      kind: 'running-item';
      /** react-virtuoso 稳定行键。 */
      key: string;
      /** 进度详情。 */
      item: types.ProgressView;
    }
  | {
      /** 待审核汇总跳转行。 */
      kind: 'running-approvals';
      /** react-virtuoso 稳定行键。 */
      key: string;
      /** 待审核条数。 */
      count: number;
    };


/**
 * 判断某一行是否可获得键盘焦点。
 * @param row 虚拟列表行。
 * @returns 可聚焦返回 true。
 */
function isFocusableRow(row: LeftVirtualRow): boolean {
  return row.kind !== 'running-head';
}


/**
 * 查找下一个或上一个可聚焦虚拟行的下标。
 * @param rows 虚拟行数组。
 * @param fromIndex 起始行下标。
 * @param step 步进方向（1 向下，-1 向上）。
 * @returns 找到的行下标；若到边界则 -1。
 */
function getNextFocusableIndex(rows: LeftVirtualRow[], fromIndex: number, step: 1 | -1): number {
  for (let index = fromIndex + step; index >= 0 && index < rows.length; index += step) {
    const candidate = rows[index];
    //G 按方向顺序检查候选行，跳过不可聚焦的分组小标题行，命中第一个可聚焦项即返回下标。
    if (candidate !== undefined && isFocusableRow(candidate)) return index;
  }

  return -1;
}


/**
 * 一个机器人的卡片。
 * @param props bot 机器人（还没拿到时是 undefined）；name 名字；online 连得上吗；selected 是不是正在聊的；onSelect 点了。
 * @returns 机器人卡片按钮。
 */
function BotCard(props: {
  bot: types.BotView | undefined;
  name: string;
  online: boolean;
  selected: boolean;
  onSelect: () => void;
}): react.JSX.Element {
  //M 订阅界面翻译函数，用于本地化机器人状态框的文字和悬停原因。
  const t = i18n.useT();

  /** 当前展示的机器人状态。 */
  //M 结合后端连通性与机器人状态算出最终显示态（断连时统一退为休假中）。
  const status = statusModule.getShownStatus(props.online, props.bot);

  /** 卡片样式类名，选中时附加高亮类。 */
  let cardClass = 'jm-bot-card';
  if (props.selected) {
    cardClass = 'jm-bot-card jm-selected';
  }

  /** 状态框短说明，用于胶囊右侧显示。 */
  //M 按当前状态与审核/运行/排队计数生成紧跟胶囊后的简短摘要。
  const shortDetail = statusModule.getStatusShort(status, props.bot, t);

  /** 状态框悬停说明，用于查看具体原因。 */
  //M 生成鼠标悬停在状态胶囊上时展示的完整原因说明。
  const hoverDetail = statusModule.getStatusDetail(status, props.bot, t);

  //M 渲染单张机器人卡片按钮，组合首字头像、名称与状态胶囊并绑定点击选中动作。
  return (
    <button type="button" className={cardClass} onClick={props.onSelect} aria-pressed={props.selected}>
      <sprite.Avatar name={props.name} size={44} />
      <span className="jm-bot-text">
        <span className="jm-bot-name">{props.name}</span>
        <sprite.StatusPill status={status} detail={shortDetail} title={hoverDetail} />
      </span>
    </button>
  );
}


/**
 * 左栏机器人列表与页脚设置区。
 * @returns 左栏内容容器。
 */
export function BotList(): react.JSX.Element {
  //M 订阅界面翻译函数，供品牌区、占位卡、运行中标题及页脚版本号文案使用。
  const t = i18n.useT();

  /** 壳子和后端的版本信息，异步从 /api/ui/info 拉取。 */
  const [info, setInfo] = react.useState<api.UiInfo | undefined>(undefined);

  //M 挂载后请求一次版本与编译时间，用于左下角展示与悬停提示。
  react.useEffect(() => {
    void api.uiInfo().then(setInfo, () => undefined);
  }, []);

  /** 后端版本号，取新版 server 字段或兼容根字段。 */
  const serverVersion = info?.server?.version ?? info?.version ?? '';

  /** 后端编译时间戳（毫秒）。 */
  const serverBuiltAt = info?.server?.builtAt ?? info?.builtAt ?? 0;

  /** 桌面壳子版本号。 */
  const shellVersion = info?.shell?.version ?? '';

  /** 桌面壳子编译时间戳（毫秒）。 */
  const shellBuiltAt = info?.shell?.builtAt ?? 0;

  /** 是否拿到了任意版本号，决定页脚右侧是否显示版本文本。 */
  const hasVersion = shellVersion !== '' || serverVersion !== '';

  /** 机器人清单与状态。 */
  //M 从全局状态仓库订阅全部机器人列表，用于组装左栏机器人卡片行。
  const bots = context.useUi((state) => state.bots);

  /** 连得上吗（还没问过算连得上，免得一打开就闪“休假中”）。 */
  //M 读取后端连通状态，决定卡片展示在线工作状态还是“休假中”。
  const online = context.useUi((state) => state.online) !== false;

  /** 当前正在聊的机器人名字。 */
  //M 读取当前选中机器人名称，用于高亮选中卡片并在切换时做差量跳转。
  const current = context.useUi((state) => state.currentBot);

  /** 状态仓库里的交互动作。 */
  //M 取出切换机器人、打开右栏以及开关设置/搜索/新建弹窗的动作供左栏按钮绑定。
  const selectBot = context.useUi((state) => state.selectBot);
  const openPanel = context.useUi((state) => state.openPanel);
  const setSettingsOpen = context.useUi((state) => state.setSettingsOpen);
  const setSearchOpen = context.useUi((state) => state.setSearchOpen);
  const setNewBotOpen = context.useUi((state) => state.setNewBotOpen);

  /** 正在做的事与待审核状态，用于合并进左栏虚拟列表。 */
  //M 订阅全部机器人的运行中任务与待审核条目，合入左栏虚拟列表底部展示。
  const runningState = runningList.useRunningState();

  /** 外层 .jm-bot-list 滚动容器（传给 react-virtuoso 的 customScrollParent）。 */
  const [listScroller, setListScroller] = react.useState<HTMLDivElement | null>(null);

  /** Virtuoso 实例引用，供键盘 ↑/↓ 定位到未挂载项。 */
  const virtuosoRef = react.useRef<virtuoso.VirtuosoHandle>(null);

  /** 待聚焦的目标行下标（等待虚拟列表滚动渲染完成后聚焦）。 */
  const pendingFocusIndexRef = react.useRef<number | null>(null);

  /**
   * 组装统一的左栏虚拟列表行集合。
   * 包括：所有机器人卡片（或离线占位卡）、以及（存在运行中会话或待审核时）“正在做的事”分组。
   */
  const rows = react.useMemo<LeftVirtualRow[]>(() => {
    const list: LeftVirtualRow[] = [];

    //M 写入机器人卡片行，暂无机器人时显示一张离线空卡。
    for (const bot of bots) {
      list.push({
        kind: 'bot',
        key: `bot:${bot.name}`,
        bot,
        name: bot.name,
        online,
      });
    }

    if (bots.length === 0) {
      list.push({
        kind: 'bot',
        key: 'bot:__empty__',
        bot: undefined,
        name: t('机器人'),
        online: false,
      });
    }

    //M 追加正在做的事和待审核条目。
    if (runningState.items.length > 0 || runningState.approvals.length > 0) {
      list.push({ kind: 'running-head', key: 'running-head' });

      for (const item of runningState.items) {
        list.push({
          kind: 'running-item',
          key: `run:${String(item.id)}`,
          item,
        });
      }

      if (runningState.approvals.length > 0) {
        list.push({
          kind: 'running-approvals',
          key: 'running-approvals',
          count: runningState.approvals.length,
        });
      }
    }

    return list;
  }, [bots, online, runningState.items, runningState.approvals.length, t]);

  /**
   * 聚焦左栏虚拟列表里指定行内的交互按钮。
   * @param targetIndex 目标行下标。
   * @returns 找到按钮并聚焦返回 true，未挂载返回 false。
   */
  const focusRowButton = react.useCallback((targetIndex: number): boolean => {
    if (listScroller === null) return false;

    const btn = listScroller.querySelector(`[data-left-row-index="${String(targetIndex)}"] button`);
    if (btn instanceof HTMLButtonElement) {
      btn.scrollIntoView({ block: 'nearest' });
      btn.focus();
      return true;
    }

    return false;
  }, [listScroller]);

  /** 列表容器键盘上下导航：在机器人卡片与正在运行的会话项之间移动焦点。 */
  const onListKeyDown = (event: react.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    const rowEl = target.closest('[data-left-row-index]');
    if (rowEl === null) return;

    const currentIndex = Number(rowEl.getAttribute('data-left-row-index'));
    if (!Number.isInteger(currentIndex)) return;

    let step: 1 | -1 = -1;
    let scrollAlign: 'start' | 'end' = 'start';
    if (event.key === 'ArrowDown') {
      step = 1;
      scrollAlign = 'end';
    }

    //M 在虚拟行数据中查找下一个可聚焦目标，若目标行已挂载则立即移动焦点。
    const nextIndex = getNextFocusableIndex(rows, currentIndex, step);
    if (nextIndex < 0) return;

    event.preventDefault();
    if (focusRowButton(nextIndex)) {
      pendingFocusIndexRef.current = null;
      return;
    }

    //M 目标行尚未挂载到 DOM 时，先滚到可见区再等虚拟滚动渲染一帧后聚焦。
    pendingFocusIndexRef.current = nextIndex;
    virtuosoRef.current?.scrollToIndex({ index: nextIndex, align: scrollAlign });
    window.requestAnimationFrame(() => {
      if (pendingFocusIndexRef.current === nextIndex && focusRowButton(nextIndex)) {
        pendingFocusIndexRef.current = null;
      }
    });
  };

  /**
   * 渲染左栏虚拟列表的单个行。
   * @param index 当前行下标。
   * @param row 行数据模型。
   * @returns 对应的列表行元素。
   */
  const renderRow = (index: number, row: LeftVirtualRow): react.JSX.Element => {
    if (row.kind === 'bot') {
      const botData = row.bot;
      return (
        <div className="jm-bot-vrow" data-left-row-index={index}>
          <BotCard
            bot={botData}
            name={row.name}
            online={row.online}
            selected={botData !== undefined && botData.name === current}
            onSelect={() => {
              //G 离线空占位卡不触发切机器人或开右栏。
              if (botData === undefined) return;

              //M 点没选中的先换机器人；点哪个都在右栏打开它的工作区（详情还在右栏标签栏里，G批设计 7.6）。
              if (botData.name !== current) {
                selectBot(botData.name);
              }

              openPanel('workspace');
            }}
          />
        </div>
      );
    }

    if (row.kind === 'running-head') {
      return <div className="jm-running-vhead">{t('正在做的事')}</div>;
    }

    if (row.kind === 'running-item') {
      return (
        <div className="jm-running-vrow" data-left-row-index={index}>
          <runningList.RunningItemButton item={row.item} />
        </div>
      );
    }

    return (
      <div className="jm-running-vrow" data-left-row-index={index}>
        <runningList.RunningApprovalsButton count={row.count} />
      </div>
    );
  };

  /** 页脚版本号短文本。 */
  //M 拼出桌面壳与后端服务的紧凑版本标签，展示在左下角设置栏右侧。
  const versionText = getVersionLabel(t, shellVersion, serverVersion);

  /** 页脚版本号悬停完整说明。 */
  //M 生成包含桌面壳与后端编译时刻的多行版本号悬停提示。
  const versionHint = getVersionTitle(t, shellVersion, shellBuiltAt, serverVersion, serverBuiltAt);

  //M 渲染左栏整体布局：顶栏新建入口、全局搜索按钮、虚拟列表、更新提示与页脚设置/连接灯/版本区。
  return (
    <div className="jm-left-inner">
      <header className="jm-brand">
        <span>jmbots</span>
        <antd.Tooltip title={t('新建机器人')}>
          <antd.Button
            type="text"
            size="small"
            className="jm-brand-add"
            aria-label={t('新建机器人')}
            icon={<icons.PlusOutlined />}
            onClick={() => setNewBotOpen(true)}
          />
        </antd.Tooltip>
      </header>
      <button type="button" className="jm-search-entry" onClick={() => setSearchOpen(true)}>
        <icons.SearchOutlined />
        <span>{t('搜索（Ctrl+K）')}</span>
      </button>
      <div className="jm-bot-list" ref={setListScroller} onKeyDown={onListKeyDown}>
        {listScroller !== null && (
          <virtuoso.Virtuoso
            ref={virtuosoRef}
            customScrollParent={listScroller}
            data={rows}
            computeItemKey={(_index, row) => row.key}
            overscan={LIST_OVERSCAN_PX}
            itemContent={renderRow}
          />
        )}
      </div>
      <updateEntry.UpdateEntry />
      <div className="jm-footer-row">
        <button type="button" className="jm-settings-entry" onClick={() => setSettingsOpen(true)}>
          <span className="jm-settings-main">
            <icons.SettingOutlined />
            <span>{t('设置')}</span>
          </span>
          <span className="jm-settings-meta">
            <connections.Connections />
            {hasVersion && (
              <span className="jm-version" title={versionHint}>
                {versionText}
              </span>
            )}
          </span>
        </button>
      </div>
    </div>
  );
}


/**
 * 把编译时刻格式化成美国东部时间（用户时区），例如 2026-11-14 13:02 EST。
 * @param at 毫秒时间戳；0 或无效则空字符串。
 * @returns 格式化后的时间字符串。
 */
function formatBuiltAt(at: number): string {
  //G 零或非法时间戳不显示编译时刻。
  if (!Number.isFinite(at) || at <= 0) return '';

  /** 按纽约时区拆解后的日期时间片段。 */
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(at));

  /** 按类型取出片段值。 */
  const pick = (type: Intl.DateTimeFormatPartTypes): string => {
    const matched = parts.find((part) => part.type === type);
    return matched?.value ?? '';
  };

  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')} EST`;
}


/**
 * 左下角看得见的短标签：壳 0.1.0 · 服 0.7.0。
 * @param t 翻译函数。
 * @param shellVersion 壳子版本号。
 * @param serverVersion 后端版本号。
 * @returns 拼接好的短版本文本。
 */
function getVersionLabel(t: i18n.Translate, shellVersion: string, serverVersion: string): string {
  /** 待拼接的短标签片段。 */
  const parts: string[] = [];

  if (shellVersion !== '') {
    parts.push(t('壳 {version}', { version: shellVersion }));
  }

  if (serverVersion !== '') {
    parts.push(t('服 {version}', { version: serverVersion }));
  }

  return parts.join(' · ');
}


/**
 * 鼠标放上去的完整说明，带编译时间。
 * @param t 翻译函数。
 * @param shellVersion 壳子版本号。
 * @param shellBuiltAt 壳子编译时间戳（毫秒）。
 * @param serverVersion 后端版本号。
 * @param serverBuiltAt 后端编译时间戳（毫秒）。
 * @returns 多行悬停说明。
 */
function getVersionTitle(
  t: i18n.Translate,
  shellVersion: string,
  shellBuiltAt: number,
  serverVersion: string,
  serverBuiltAt: number,
): string {
  /** 多行说明集合。 */
  const lines: string[] = [];

  //M 拼装桌面壳子版本与编译时刻。
  if (shellVersion !== '') {
    const time = formatBuiltAt(shellBuiltAt);
    if (time !== '') {
      lines.push(t('壳子 jmbots.exe {version}（编译于 {time}）', { version: shellVersion, time }));
    }

    if (time === '') {
      lines.push(t('壳子 jmbots.exe {version}（编译时间未知）', { version: shellVersion }));
    }
  }

  //M 拼装后端服务版本与编译时刻。
  if (serverVersion !== '') {
    const time = formatBuiltAt(serverBuiltAt);
    if (time !== '') {
      lines.push(t('服务 jmbots-server.exe {version}（编译于 {time}）', { version: serverVersion, time }));
    }

    if (time === '') {
      lines.push(t('服务 jmbots-server.exe {version}（编译时间未知）', { version: serverVersion }));
    }
  }

  return lines.join('\n');
}
