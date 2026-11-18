/**
 * 右栏的“用量”标签（docs/15_用量表.md 第 4 节；用户 11-07 原话第 105 节，照 magpie 的“观测 / 用量 / 概览”）：
 * 上面一排筛选（多长时间、按什么切时间段、按什么分组、刷新），下面合计、按时间段的柱状图、按分组的列表（点开看每个时间段）。
 * 数据来自后端 GET /api/usage（Api.ts 的 usage）；合计、换算、柱子形状在 UsageData.ts。
 * 柱子颜色是主题的 --jm-chart（Theme.ts），文字一律用 --jm-text、--jm-muted。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as i18n from '../I18n.ts';
import * as data from './UsageData.ts';
import type * as types from '../Types.ts';


/** 柱状图的宽（SVG 里的单位，实际按右栏宽度缩放）。 */
const CHART_WIDTH = 320;
/** 柱状图的高。 */
const CHART_HEIGHT = 120;

/** 一根柱子最宽多少。 */
const BAR_MAX_WIDTH = 24;
/** 柱子之间留的空。 */
const BAR_GAP = 2;
/** 选择器允许的最大时间桶数。 */
const MAX_CHART_BARS = 400;
const HOURS_PER_DAY = 24;

/** 柱子顶上的圆角半径。 */
const BAR_RADIUS = 4;

/** 点开一行后时间段表最高多少像素：用 antd Table 自带的 virtual 虚拟滚动（用户 11-17）。 */
const PERIOD_TABLE_HEIGHT = 320;
/** 时间段表的总宽：antd 虚拟表的 scroll.x 必须是数，比右栏宽时左右滚。 */
const PERIOD_TABLE_WIDTH = 760;
/** 时间段那一列的宽，放得下“2026-11-17 13:00”；其余列平分剩下的。 */
const PERIOD_COLUMN_WIDTH = 150;


/** 合计的一格。 */
function Tile(props: {
  /** 名字。 */
  label: string;
  /** 值。 */
  value: string;
  /** 下面一行小字（没有就不写）。 */
  hint?: string;
}): react.JSX.Element {
  return (
    <div className="jm-usage-tile">
      <span className="jm-usage-tile-label">{props.label}</span>
      <strong className="jm-usage-tile-value">{props.value}</strong>
      {props.hint && <span className="jm-usage-tile-hint">{props.hint}</span>}
    </div>
  );
}


/** 柱状图：每个时间段一根，高是 token 总数；指上去看这一段的明细。 */
function Bars(props: {
  /** 按时间段加好的行，从早到晚。 */
  periods: types.UsageRow[];
}): react.JSX.Element {
  //M 获取翻译函数，用于图表提示和读屏无障碍说明文案。
  const t = i18n.useT();
  /** 最高那根的 token 数（至少 1，免得除以 0）。 */
  //M 找出各时间段中的最大 token 总量，用作柱高的归一化基准。
  const max = Math.max(1, ...props.periods.map((row) => data.getTokens(row)));
  /** 每个时间段占多宽。 */
  const slot = CHART_WIDTH / Math.max(1, props.periods.length);
  //M 桶密集时缩小间距，让柱子宽度始终小于自己的槽位。
  const gap = Math.min(BAR_GAP, slot / 4);
  const barWidth = Math.min(BAR_MAX_WIDTH, slot - gap);
  /**
   * 一根柱子指上去显示的字。
   * @param row 这个时间段。
   */
  const getTip = (row: types.UsageRow): string => {
    /** token 那一行。 */
    const tokens = [
      `${t('输入')} ${data.formatTokens(row.input)}`,
      `${t('输出')} ${data.formatTokens(row.output)}`,
      `${t('缓存读')} ${data.formatTokens(row.cacheRead)}`,
    ].join(' · ');
    /** 调用那一行。 */
    const calls = [
      `${t('调用')} ${String(row.calls)}`,
      `${t('失败')} ${String(row.failures)}`,
      `${t('钱')} ${data.formatCost(row.cost)}`,
    ].join(' · ');
    return [row.period, tokens, calls].join('\n');
  };
  /** 图的说明（读屏用）。 */
  //M 格式化最大 token 峰值并拼接图表无障碍说明。
  const label = t('每个时间段的 token 总数，最高 {max}', { max: data.formatTokens(max) });
  /** 第一个时间段（写在图下面左边）。 */
  const first = props.periods[0]?.period ?? '';
  /** 最后一个时间段（写在图下面右边）。 */
  const last = props.periods[props.periods.length - 1]?.period ?? '';
  return (
    <figure className="jm-usage-chart">
      <figcaption>{label}</figcaption>
      <svg viewBox={`0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`} role="img" aria-label={label}>
        <line className="jm-usage-axis" x1={0} y1={CHART_HEIGHT} x2={CHART_WIDTH} y2={CHART_HEIGHT} />
        {props.periods.map((row, index) => {
          /** 柱子高。 */
          //M 按当前时间段 token 数占峰值的比例换算柱子像素高度。
          const height = (data.getTokens(row) / max) * (CHART_HEIGHT - BAR_RADIUS);
          /** 柱子的形状。 */
          const shape = {
            x: index * slot + (slot - barWidth) / 2,
            y: CHART_HEIGHT - height,
            width: barWidth,
            height,
          };
          //M 渲染单根时间段柱子：生成悬停明细标题与顶部圆角的 SVG 路径。
          return (
            <g key={row.period} className="jm-usage-column">
              <title>{getTip(row)}</title>
              <rect className="jm-usage-hit" x={index * slot} y={0} width={slot} height={CHART_HEIGHT} />
              <path className="jm-usage-bar" d={data.getBarPath(shape, BAR_RADIUS)} />
            </g>
          );
        })}
      </svg>
      <div className="jm-usage-ticks">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </figure>
  );
}


/** 查询首尾可能各占一个不满一小时的桶，预算多留一个。 */
function getHourlyDisabled(days: number): boolean {
  return days * HOURS_PER_DAY + 1 > MAX_CHART_BARS;
}


/**
 * 用量标签。
 * @returns 用量筛选栏、汇总卡片、柱状图与分组明细表元素。
 * 副作用：按天数、时间粒度与分组维度请求用量统计接口并更新本地状态。
 */
export function Usage(): react.JSX.Element {
  //M 获取翻译函数，用于筛选标签、指标名称及报错提示。
  const t = i18n.useT();
  /** 看最近多少天。 */
  const [days, setDays] = react.useState(7);
  /** 按什么切时间段。 */
  const [by, setBy] = react.useState<types.UsageBy>('day');
  /** 按什么分组。 */
  const [group, setGroup] = react.useState<types.UsageGroup>('model');
  /** 点了几次刷新（变了就重取）。 */
  const [refreshes, setRefreshes] = react.useState(0);
  /** 后端的回答；null 是还没取到。 */
  const [report, setReport] = react.useState<types.UsageReport | null>(null);
  /** 取不到时的原因。 */
  const [error, setError] = react.useState('');

  react.useEffect(() => {
    /** 这次要的时间范围。 */
    //M 根据选中的天数换算起止时间戳，作为查询条件。
    const range = data.getRange(days, Date.now());
    /** 查询条件。 */
    const query = {
      by,
      group,
      ...range,
    };
    /** 换了条件以后，旧的回答回来了就不要了。 */
    let current = true;
    //M 按筛选条件请求后端用量统计，仅在未切走时更新报表或错误提示。
    void api.usage(query).then(
      (answer) => {
        if (current) {
          setReport(answer);
          setError('');
        }
      },
      (reason: Error) => {
        if (current) {
          setError(reason.message);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [days, by, group, refreshes]);

  /** 用途的名字（docs/15 第 1 节 purpose）。 */
  const purposeNames: Record<string, string> = {
    session: t('会话'),
    compact: t('压缩'),
    dispatch: t('分派'),
    'exec-review': t('命令审核'),
    approval: t('批准判断'),
    limit: t('限时判断'),
    wrapup: t('收尾总结'),
    'limit-review': t('限时审核'),
    review: t('复盘'),
    vision: t('看图'),
    other: t('其他'),
  };
  /**
   * 列表第一列写什么：用途换成名字，空的写“没写”。
   * @param key 分组的值。
   */
  const getName = (key: string): string => {
    if (!key) return t('（没写）');

    if (group === 'purpose') return purposeNames[key] ?? key;

    return key;
  };
  /** 看多长时间的选项（值是天数）。 */
  const rangeOptions = [
    { value: 1, label: t('24 小时') },
    { value: 7, label: t('7 天') },
    { value: 30, label: t('30 天') },
    { value: 365, label: t('一年') },
  ];
  /** 按什么切时间段的选项。 */
  const byOptions: { value: types.UsageBy; label: string; disabled?: boolean }[] = [
    { value: 'hour', label: t('每小时'), disabled: getHourlyDisabled(days) },
    { value: 'day', label: t('每天') },
    { value: 'week', label: t('每周') },
    { value: 'month', label: t('每月') },
  ];
  /** 切换范围时把已选的超限小时粒度切到每天，再按新条件查询。 */
  const changeRange = (nextDays: number): void => {
    setDays(nextDays);
    if (by !== 'hour' || !getHourlyDisabled(nextDays)) return;

    //M 选中实际提交的粒度，筛选栏、图和明细展示同一个时间单位。
    setBy('day');
  };
  /** 按什么分组的选项。 */
  const groupOptions: { value: types.UsageGroup; label: string }[] = [
    { value: 'provider', label: t('供应商') },
    { value: 'model', label: t('模型') },
    { value: 'purpose', label: t('用途') },
    { value: 'bot', label: t('机器人') },
  ];
  /** 分组那一列的标题。 */
  const groupLabel = groupOptions.find((item) => item.value === group)?.label ?? '';
  /**
   * 列表的列：第一列给足固定宽以对齐表头和表体（antd 虚拟表要求每列/首列宽度明确），后面是数。
   * @param first 第一列写分组（key）还是时间段（period）。
   */
  const getColumns = (first: 'key' | 'period'): antd.TableColumnsType<types.UsageRow> => {
    let firstTitle = t('时间段');
    if (first === 'key') {
      firstTitle = groupLabel;
    }
    return [
      {
        title: firstTitle,
        dataIndex: first,
        width: PERIOD_COLUMN_WIDTH,
        render: (value: string) => {
          //M 分组列将内部键名映射为可读中文名称，时间段列保留原字符串。
          if (first === 'key') return getName(value);

          return value;
        },
      },
      { title: t('调用'), dataIndex: 'calls', align: 'right' },
      { title: t('失败'), dataIndex: 'failures', align: 'right' },
      { title: t('输入'), dataIndex: 'input', align: 'right', render: data.formatTokens },
      { title: t('输出'), dataIndex: 'output', align: 'right', render: data.formatTokens },
      { title: t('缓存读'), dataIndex: 'cacheRead', align: 'right', render: data.formatTokens },
      { title: t('命中率'), dataIndex: 'hitRate', align: 'right', render: data.formatRate },
      { title: t('钱'), dataIndex: 'cost', align: 'right', render: data.formatCost },
    ];
  };
  /**
   * 点开一行：这个分组每个时间段的数。
   * @param record 列表里的一行。
   */
  const getPeriods = (record: types.UsageRow): react.JSX.Element => {
    /** 这个分组的行。 */
    const rows = (report?.rows ?? []).filter((row) => row.key === record.key);
    /** 虚拟表要的宽和高，都得是数。 */
    const scroll = {
      x: PERIOD_TABLE_WIDTH,
      y: PERIOD_TABLE_HEIGHT,
    };

    return (
      <antd.Table
        size="small"
        rowKey="period"
        pagination={false}
        virtual
        //M 按时间段维度生成展开子表的列配置。
        columns={getColumns('period')}
        dataSource={rows}
        scroll={scroll}
      />
    );
  };

  /** 合计与主分组表（始终开启虚拟滚动，不再按行数切换两套写法）。 */
  const totals = report?.totals;
  //M 按当前分组维度聚合原始用量行，供主表格按分组展示与排序。
  const groupedRows = data.getByKey(report?.rows ?? []);
  const groupScroll = {
    x: PERIOD_TABLE_WIDTH,
    y: 400,
  };
  return (
    <div className="jm-usage">
      <div className="jm-usage-filters">
        <antd.Segmented
          size="small"
          value={days}
          options={rangeOptions}
          onChange={changeRange}
        />
        <antd.Segmented
          size="small"
          value={by}
          options={byOptions}
          onChange={(value) => setBy(value)}
        />
        <antd.Segmented
          size="small"
          value={group}
          options={groupOptions}
          onChange={(value) => setGroup(value)}
        />
        <antd.Button
          size="small"
          type="text"
          icon={<icons.ReloadOutlined />}
          aria-label={t('刷新')}
          onClick={() => setRefreshes((count) => count + 1)}
        />
      </div>
      {error && <div className="jm-empty">{t('取不到用量：{reason}', { reason: error })}</div>}
      {!error && !report && <div className="jm-empty">{t('正在取用量…')}</div>}
      {
        //M 将总用量、命中率与费用换算为紧凑可读字符串，渲染顶部汇总格。
        totals && (
        <div className="jm-usage-tiles">
          <Tile label={t('输入')} value={data.formatTokens(totals.input)} />
          <Tile label={t('输出')} value={data.formatTokens(totals.output)} />
          <Tile label={t('缓存读')} value={data.formatTokens(totals.cacheRead)} />
          <Tile label={t('命中率')} value={data.formatRate(totals.hitRate)} />
          <Tile
            label={t('调用')}
            value={String(totals.calls)}
            hint={t('失败 {count}', { count: totals.failures })}
          />
          <Tile label={t('钱')} value={data.formatCost(totals.cost)} />
        </div>
      )}
      {report && report.rows.length === 0 && <div className="jm-empty">{t('这段时间没有调用模型')}</div>}
      {
        //M 有用量明细时按时间段聚合绘制柱状图，并按分组维度配置主表列。
        report && report.rows.length > 0 && (
        <>
          <Bars periods={data.getByPeriod(report.rows)} />
          <antd.Table
            size="small"
            rowKey="key"
            pagination={false}
            virtual
            //M 按当前分组维度生成主明细表的列配置。
            columns={getColumns('key')}
            dataSource={groupedRows}
            expandable={{ expandedRowRender: getPeriods }}
            scroll={groupScroll}
          />
        </>
      )}
    </div>
  );
}
