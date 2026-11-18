/**
 * 设置里的“重连”（用户 11-07）：不改 config.yaml，只有两个动作。
 *   重新测试模型连接：每家供应商重拉一次模型清单（不调用模型、不花钱），拉到了马上换上，不用重启；
 *     列出每家连上没有、几个模型，再把设置里用到的模型对一遍清单。聊天里报“清单里没有”时提醒用户来这里，测完回去重新发。
 *   重启服务：请基地停掉后端再拉起（POST /api/service/restart），等新进程起来。
 * 供应商、模型都是配置：这里只按 config.yaml 和后端回的结果显示，不认哪一家。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as i18n from '../I18n.ts';
import type * as types from '../Types.ts';
import * as editsModule from './Edits.ts';
import * as fields from './Fields.tsx';


/** 设置里用到模型的地方：名字（和“模型”“引擎”分类里的一样）、config.yaml 里的路径。 */
const USED_MODELS: { label: string; path: editsModule.Path }[] = [
  { label: '默认模型 default_model', path: ['default_model'] },
  { label: '决策模型 models.decision', path: ['models', 'decision', 'model'] },
  { label: '备用链 engine.fallback_chain', path: ['engine', 'fallback_chain'] },
  { label: '看图的模型 engine.vision_model', path: ['engine', 'vision_model'] },
  { label: '生图模型 image_model', path: ['engine', 'image_model'] },
  { label: '收尾模型 wrapup_model', path: ['engine', 'wrapup_model'] },
];


/** 测一次的结果：每家的结果和测完那一刻的模型清单（同一时刻的，免得对的是旧清单）。 */
interface TestResult {
  /** 每家重连的结果。 */
  results: types.ReconnectResult[];
  /** 测完拿到的模型清单。 */
  models: api.ModelInfo[];
}


/** 设置里用到的一个模型对清单的结果（表格的一行）。 */
interface UsedRow {
  /** 表格的键。 */
  key: string;
  /** 用在哪（设置里的名字；备用链带第几个）。 */
  where: string;
  /** 供应商/模型 ID。 */
  model: string;
  /** 在清单里。 */
  ok: boolean;
  /** 不在时的原因。 */
  reason: string;
}


/** 重启服务到哪一步了。 */
type RestartState = { kind: 'idle' } | { kind: 'restarting' } | { kind: 'done' } | { kind: 'failed'; reason: string };


/**
 * 一个模型在不在清单里；不在时说为什么。
 * @param model 供应商/模型 ID。
 * @param test 刚测的结果。
 * @param t 翻译。
 */
function checkModel(model: string, test: TestResult, t: i18n.Translate): { ok: boolean; reason: string } {
  //G 在清单里：能用。
  if (test.models.some((item) => item.id === model)) {
    return { ok: true, reason: '' };
  }
  /** 供应商名：第一段。 */
  const provider = model.split('/')[0] ?? model;
  /** 这家刚才的结果。 */
  const result = test.results.find((item) => item.provider === provider);
  if (!result) {
    return { ok: false, reason: t('config.yaml 的 providers 里没有 {provider}', { provider }) };
  }
  if (!result.ok) {
    return { ok: false, reason: t('{provider} 没连上', { provider }) };
  }
  return { ok: false, reason: t('{provider} 的清单里没有这个模型：模型 ID 写对了吗？', { provider }) };
}


/**
 * 设置里用到的模型，一个一个对清单。
 * @param draft 设置的草稿（config.yaml 加上还没保存的改动）；还没取到是 null，就没有行。
 * @param test 刚测的结果。
 * @param t 翻译。
 * @returns 检查结果行列表。
 */
function getUsedRows(draft: unknown, test: TestResult, t: i18n.Translate): UsedRow[] {
  /** 表格的行。 */
  const rows: UsedRow[] = [];
  for (const used of USED_MODELS) {
    /** 写的值：一个模型，或者一串（备用链）。 */
    //M 从当前设置草稿取出该用途配置的模型 ID 或备用链数组，准备逐项核对是否在最新清单内。
    const value = editsModule.getAt(draft, used.path);
    /** 当成一串看。 */
    let list: unknown[] = [value];
    if (Array.isArray(value)) {
      list = value;
    }
    list.forEach((item, index) => {
      if (typeof item !== 'string' || !item) {
        return;
      }
      /** 用在哪。 */
      let where = t(used.label);
      if (list.length > 1) {
        where = `${t(used.label)} #${index + 1}`;
      }
      /** 对的结果。 */
      //M 把配置里的模型 ID 对照本次拉取的供应商连接结果和模型清单，得出可用状态与失败原因。
      const checked = checkModel(item, test, t);
      rows.push({ key: `${used.path.join('.')}-${index}`, where, model: item, ...checked });
    });
  }
  return rows;
}


/**
 * 连上没有：绿的或红的标签。
 * @param props ok 是连上了（在清单里），text 是标签上的字。
 */
function OkTag(props: { ok: boolean; text: string }): react.JSX.Element {
  let color = 'error';
  if (props.ok) {
    color = 'success';
  }
  return <antd.Tag color={color}>{props.text}</antd.Tag>;
}


/** 把异常整理成可读文本。 */
function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;

  return String(error);
}


/**
 * “重连”分类。
 * @param props draft 是设置的草稿（还没取到是 null，这时不对用到的模型）；
 *   onReload 是 Settings.tsx 的 load（重新取配置和模型清单，别的分类的模型下拉框跟着换成新的）。
 */
export function Reconnect(props: { draft: unknown; onReload: () => void }): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于表格表头、连接状态标签和重启操作提示。
  const t = i18n.useT();
  /** 正在测、测的结果、出错的原因。 */
  const [testing, setTesting] = react.useState(false);
  const [test, setTest] = react.useState<TestResult | null>(null);
  const [testError, setTestError] = react.useState('');
  /** 重启服务到哪了。 */
  const [restart, setRestart] = react.useState<RestartState>({ kind: 'idle' });

  /** 重新测试模型连接：每家重连，再取一次清单。 */
  const testModels = async (): Promise<void> => {
    setTesting(true);
    setTestError('');
    try {
      /** 每家重连的结果。 */
      //M 通知后端向每家已配置供应商重新拉取模型清单（不发模型请求、不花钱），拿回各家连接结果。
      const answer = await api.reconnectModels();
      /** 测完的清单。 */
      //M 重连完成后紧接着拉取同一时刻的可用模型总表，避免拿旧清单核对当前配置。
      const fresh = await api.models();
      setTest({ results: answer.results, models: fresh });
      props.onReload();
    } catch (error) {
      //G 重连或取清单接口出错时把异常整理成可读文本展示在错误条里。
      setTestError(getErrorText(error));
    } finally {
      setTesting(false);
    }
  };

  /** 重启服务：请基地重启，等新进程起来。 */
  const restartService = async (): Promise<void> => {
    setRestart({ kind: 'restarting' });
    try {
      /** 旧进程起来的时间。 */
      //M 请基地重启后端服务并记下重启前的 startedAt，作为后续判定新进程是否拉起的基准。
      const { startedAt } = await api.restartService();
      /** 等到新进程没有。 */
      //M 持续轮询 /api/ui/info 直到 startedAt 改变或超时，确认新后端进程已经就绪。
      const restarted = await api.waitNewProcess(startedAt);
      if (restarted) {
        setRestart({ kind: 'done' });
        props.onReload();
        return;
      }
      /** 超时的提示。 */
      const reason = t('等了 3 分钟还没起来：看运行时 data/logs 里的 backend.log');
      setRestart({ kind: 'failed', reason });
    } catch (error) {
      //G 重启请求或等待新进程过程抛错时提取可读报错，更新为重启失败状态提示用户。
      setRestart({ kind: 'failed', reason: getErrorText(error) });
    }
  };

  /** 每家的表格列。 */
  const providerColumns: antd.TableColumnsType<types.ReconnectResult> = [
    { title: t('供应商'), dataIndex: 'provider' },
    {
      title: t('连上没有'),
      render: (_, item) => {
        let statusText = t('没连上');
        if (item.ok) {
          statusText = t('连上了');
        }
        return <OkTag ok={item.ok} text={statusText} />;
      },
    },
    { title: t('模型'), dataIndex: 'models', align: 'right' },
    { title: t('原因'), render: (_, item) => item.error ?? '' },
  ];
  /** 用到的模型的表格列。 */
  const usedColumns: antd.TableColumnsType<UsedRow> = [
    { title: t('用在哪'), dataIndex: 'where' },
    { title: t('模型'), dataIndex: 'model' },
    {
      title: t('能用吗'),
      render: (_, row) => {
        let statusText = row.reason;
        if (row.ok) {
          statusText = t('在清单里');
        }
        return <OkTag ok={row.ok} text={statusText} />;
      },
    },
  ];
  /** 用到的模型对清单的结果（测过、取到了配置才有）。 */
  let rows: UsedRow[] = [];
  if (test) {
    //M 测试结果返回后，把当前设置草稿里用到的模型逐项核对成下方排查表格的行数据。
    rows = getUsedRows(props.draft, test, t);
  }
  let failedReason = '';
  if (restart.kind === 'failed') {
    failedReason = restart.reason;
  }
  /** 重启服务的提示。 */
  const restartText = {
    idle: '',
    restarting: t('正在重启服务：基地停掉后端再拉起来……'),
    done: t('服务重启好了'),
    failed: t('没重启成：{reason}', { reason: failedReason }),
  }[restart.kind];
  //M 渲染“重连”设置区：上半区重新拉取并核对模型清单，下半区触发服务重启并反馈进度。
  return (
    <div className="jm-section">
      <fields.Row
        label={t('重新测试模型连接')}
        hint={t('每家供应商重新拉一次模型清单（不调用模型、不花钱），拉到了马上换上，不用重启。测完回聊天重新发一次消息')}
      >
        {
          //M 用户点击按钮后向各家重连拉清单并核对当前配置的模型是否可用。
        /**/}
        <antd.Button loading={testing} onClick={() => void testModels()}>
          {t('重新测试')}
        </antd.Button>
      </fields.Row>
      {testError && <antd.Alert type="error" showIcon message={testError} />}
      {test && (
        <antd.Table
          size="small"
          rowKey="provider"
          pagination={false}
          columns={providerColumns}
          dataSource={test.results}
        />
      )}
      {rows.length > 0 && (
        <antd.Table
          size="small"
          rowKey="key"
          pagination={false}
          columns={usedColumns}
          dataSource={rows}
        />
      )}
      <fields.Row
        label={t('重启服务')}
        hint={t('请基地停掉后端再拉起来：重新读 config.yaml、重新连每家供应商。这十几秒网页连不上，机器人正在做的事可能被打断')}
      >
        {
          //M 用户在二次确认框点确定后向基地发起服务重启并等待新进程就绪。
        /**/}
        <antd.Popconfirm
          title={t('现在重启服务？')}
          okText={t('重启')}
          cancelText={t('取消')}
          onConfirm={() => void restartService()}
        >
          <antd.Button danger loading={restart.kind === 'restarting'}>
            {t('重启服务')}
          </antd.Button>
        </antd.Popconfirm>
      </fields.Row>
      {restart.kind !== 'idle' && (
        <antd.Alert
          showIcon
          type={({ restarting: 'info', done: 'success', failed: 'error' } as const)[restart.kind]}
          message={restartText}
        />
      )}
    </div>
  );
}
