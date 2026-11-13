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

/** 柱子顶上的圆角半径。 */
const BAR_RADIUS = 4;


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
  const t = i18n.useT();
  /** 最高那根的 token 数（至少 1，免得除以 0）。 */
  const max = Math.max(1, ...props.periods.map((row) => data.tokensOf(row)));
  /** 每个时间段占多宽。 */
  const slot = CHART_WIDTH / Math.max(1, props.periods.length);
  /** 柱子宽。 */
  const barWidth = Math.max(1, Math.min(BAR_MAX_WIDTH, slot - BAR_GAP));
  /**
   * 一根柱子指上去显示的字。
   * @param row 这个时间段。
   */
  const tipOf = (row: types.UsageRow): string => {
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
          const height = (data.tokensOf(row) / max) * (CHART_HEIGHT - BAR_RADIUS);
          /** 柱子的形状。 */
          const shape = {
            x: index * slot + (slot - barWidth) / 2,
            y: CHART_HEIGHT - height,
            width: barWidth,
            height,
          };
          return (
            <g key={row.period} className="jm-usage-column">
              <title>{tipOf(row)}</title>
              <rect className="jm-usage-hit" x={index * slot} y={0} width={slot} height={CHART_HEIGHT} />
              <path className="jm-usage-bar" d={data.barPath(shape, BAR_RADIUS)} />
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


/** 用量标签。 */
export function Usage(): react.JSX.Element {
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
    const range = data.rangeOf(days, Date.now());
    /** 查询条件。 */
    const query = {
      by,
      group,
      ...range,
    };
    /** 换了条件以后，旧的回答回来了就不要了。 */
    let current = true;
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
  const nameOf = (key: string): string => {
    if (!key) {
      return t('（没写）');
    }
    return group === 'purpose' ? (purposeNames[key] ?? key) : key;
  };
  /** 看多长时间的选项（值是天数）。 */
  const rangeOptions = [
    { value: 1, label: t('24 小时') },
    { value: 7, label: t('7 天') },
    { value: 30, label: t('30 天') },
    { value: 365, label: t('一年') },
  ];
  /** 按什么切时间段的选项。 */
  const byOptions: { value: types.UsageBy; label: string }[] = [
    { value: 'hour', label: t('每小时') },
    { value: 'day', label: t('每天') },
    { value: 'week', label: t('每周') },
    { value: 'month', label: t('每月') },
  ];
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
   * 列表的列：第一列是分组或时间段，后面是数。
   * @param first 第一列写分组（key）还是时间段（period）。
   */
  const columnsFor = (first: 'key' | 'period'): antd.TableColumnsType<types.UsageRow> => [
    {
      title: first === 'key' ? groupLabel : t('时间段'),
      dataIndex: first,
      render: (value: string) => (first === 'key' ? nameOf(value) : value),
    },
    { title: t('调用'), dataIndex: 'calls', align: 'right' },
    { title: t('失败'), dataIndex: 'failures', align: 'right' },
    { title: t('输入'), dataIndex: 'input', align: 'right', render: data.formatTokens },
    { title: t('输出'), dataIndex: 'output', align: 'right', render: data.formatTokens },
    { title: t('缓存读'), dataIndex: 'cacheRead', align: 'right', render: data.formatTokens },
    { title: t('命中率'), dataIndex: 'hitRate', align: 'right', render: data.formatRate },
    { title: t('钱'), dataIndex: 'cost', align: 'right', render: data.formatCost },
  ];
  /**
   * 点开一行：这个分组每个时间段的数。
   * @param record 列表里的一行。
   */
  const periodsOf = (record: types.UsageRow): react.JSX.Element => {
    /** 这个分组的行。 */
    const rows = (report?.rows ?? []).filter((row) => row.key === record.key);
    return (
      <antd.Table
        size="small"
        rowKey="period"
        pagination={false}
        columns={columnsFor('period')}
        dataSource={rows}
        scroll={{ x: true }}
      />
    );
  };

  /** 合计。 */
  const totals = report?.totals;
  return (
    <div className="jm-usage">
      <div className="jm-usage-filters">
        <antd.Segmented
          size="small"
          value={days}
          options={rangeOptions}
          onChange={(value) => setDays(value)}
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
      {totals && (
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
      {report && report.rows.length > 0 && (
        <>
          <Bars periods={data.byPeriod(report.rows)} />
          <antd.Table
            size="small"
            rowKey="key"
            pagination={false}
            columns={columnsFor('key')}
            dataSource={data.byKey(report.rows)}
            expandable={{ expandedRowRender: periodsOf }}
            scroll={{ x: true }}
          />
        </>
      )}
    </div>
  );
}
