/**
 * 设置的各个分类（docs/界面/01_界面设计.md 第 10 节）：把 config.yaml 里的东西都做成能填的表单，说明照抄 config.example.yaml 的注释。
 * 供应商支持任意多家、任意地址，哪一家都不特殊对待；模型参数（能不能看图、上下文、最大输出、思考档、价格）在这里看得到、改得了，
 * 也能直接问供应商有哪些模型、写进 config.yaml（写进去以后以 config.yaml 为准）。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as virtuoso from 'react-virtuoso';
import * as editsModule from './Edits.ts';
import * as fields from './Fields.tsx';
import * as webAuthField from './WebAuthField.tsx';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as timeline from '../Chat/Timeline.ts';


/** 每个分类拿到的东西。 */
export interface SectionProps {
  /** 草稿。 */
  draft: unknown;
  /** 改了。 */
  onEdit: (edit: editsModule.Edit) => void;
  /** 全部模型（GET /api/models）。 */
  models: api.ModelInfo[];
}


/** 思考档。 */
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value }));

/** 协议。 */
const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'].map((value) => ({ value, label: value }));


/** 列表里一项的一个字段。 */
interface ColumnSpec {
  /** 键。 */
  key: string;
  /** 名字。 */
  label: string;
  /** 输入的样子。 */
  kind: 'text' | 'select';
  /** 选项（select 用）。 */
  options?: { value: string; label: string }[];
  /** 占位文字。 */
  placeholder?: string;
}


/**
 * 一列对象（bots、channels.feishu、search、relay 的直通规则）：每项一行，能改、能加、能删、能挪顺序。
 * 改字段只改那一项的那个键；加、删、挪是整列换掉。whole 时改字段也整列换掉（插件字段后端只认整列）。
 * @param props 公共属性、列、新项的样子。
 */
function ObjectListField(
  props: fields.FieldProps & {
    columns: ColumnSpec[];
    blank: Record<string, unknown>;
    orderable?: boolean;
    whole?: boolean;
  },
): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于移动、删除和追加条目的按钮文案。
  const t = i18n.useT();
  /** 现在的列表。 */
  //M 从设置草稿取出对象数组当前值，非数组时按空列表兜底展示。
  const value = editsModule.getAt(props.draft, props.path);
  let list: Record<string, unknown>[] = [];
  if (Array.isArray(value)) {
    list = value as Record<string, unknown>[];
  }
  /**
   * 整列换掉。
   * @param next 新列表。
   */
  //M 增删或重排条目时无法局部打补丁，把整列新对象数组提交到草稿。
  const save = (next: Record<string, unknown>[]): void =>
    props.onEdit({ path: props.path, value: next });

  //M 渲染对象列表编辑器：逐行展示列字段、可选排序和删除按钮，并在末尾提供新增入口。
  return (
    <fields.Row label={props.label} hint={props.hint} path={props.path}>
      <div className="jm-objects">
        {list.map((item, index) => (
          <div key={index} className="jm-object-row">
            {props.columns.map((column) => {
              /** 这一格的值。 */
              const cell = item[column.key];
              /** 改这一格。 */
              const edit = (next: string): void => {
                //M 整列模式：换掉这一格（清空就删掉这个键）后整列写回。
                if (props.whole === true) {
                  const row: Record<string, unknown> = { ...item, [column.key]: next };
                  if (next === '') {
                    delete row[column.key];
                  }
                  const nextList = [...list];
                  nextList[index] = row;
                  save(nextList);
                  return;
                }

                /** 当前单元格在配置草稿中的位置。 */
                const path = [...props.path, index, column.key];
                if (next === '') {
                  //G 单元格内容清空时删除该子键，回退未配置状态。
                  props.onEdit({ path, delete: true });
                  return;
                }

                //M 单元格填了非空内容时只改写这一项这一个键的草稿值。
                props.onEdit({ path, value: next });
              };
              if (column.kind === 'select') {
                let selectVal: string | undefined;
                if (typeof cell === 'string') {
                  selectVal = cell;
                }

                //M 下拉列渲染选择框，选中值变更时只更新当前单元格对应的配置键。
                return (
                  <antd.Select
                    key={column.key}
                    className="jm-object-cell"
                    value={selectVal}
                    placeholder={column.label}
                    options={column.options}
                    onChange={(next: string) => edit(next)}
                  />
                );
              }
              let inputVal = '';
              if (typeof cell === 'string') {
                inputVal = cell;
              }

              //M 文本列渲染输入框，输入变更时只更新当前单元格对应的配置键。
              return (
                <antd.Input
                  key={column.key}
                  className="jm-object-cell"
                  value={inputVal}
                  placeholder={column.placeholder ?? column.label}
                  onChange={(event) => edit(event.target.value)}
                />
              );
            })}
            {props.orderable && (
              <>
                <antd.Button
                  size="small"
                  type="text"
                  icon={<icons.ArrowUpOutlined />}
                  aria-label={t('往前挪')}
                  disabled={index === 0}
                  onClick={() => {
                    /** 交换当前项与上一项，保留其他项的顺序。 */
                    const next = [...list];
                    next[index] = list[index - 1]!;
                    next[index - 1] = item;

                    //M 把上移交换后的对象数组写回草稿。
                    save(next);
                  }}
                />
                <antd.Button
                  size="small"
                  type="text"
                  icon={<icons.ArrowDownOutlined />}
                  aria-label={t('往后挪')}
                  disabled={index === list.length - 1}
                  onClick={() => {
                    /** 交换当前项与下一项。 */
                    const next = [...list];
                    next[index] = list[index + 1]!;
                    next[index + 1] = item;

                    //M 把下移交换后的对象数组写回草稿。
                    save(next);
                  }}
                />
              </>
            )}
            <antd.Button
              size="small"
              type="text"
              danger
              icon={<icons.DeleteOutlined />}
              aria-label={t('删掉这一项')}
              onClick={() => {
                const next = list.filter((_, at) => at !== index);

                //M 把剔除当前行后的对象数组写回草稿。
                save(next);
              }}
            />
          </div>
        ))}
        {
          //M 在列表末尾追加一项空白对象模板并把新数组写回草稿。
        /**/}
        <antd.Button
          className="jm-list-add"
          icon={<icons.PlusOutlined />}
          onClick={() => save([...list, { ...props.blank }])}
        >
          {t('加一项')}
        </antd.Button>
      </div>
    </fields.Row>
  );
}


/** 新手写一个模型时的参数（与后端未配置时的默认值一致）。 */
const BLANK_MODEL = { context_window: 128_000, max_output_tokens: 8192, vision: false };

/** 设置页虚拟滚动上下预渲染像素缓冲，减少快速滚动露白。 */
const SETTINGS_OVERSCAN_PX = 240;


/** 模型目录的一行。 */
interface ModelRow {
  /** 模型 ID（不带供应商）。 */
  id: string;
  /** 参数（键名和 config.yaml 一样）。 */
  params: Record<string, unknown>;
  /** 写在 config.yaml 里的（false 是供应商清单给的）。 */
  written: boolean;
}


/** 交给 TableVirtuoso 的表格外框组件（置于模块顶层保持引用稳定，避免重建）。 */
const MODEL_TABLE_COMPONENTS: virtuoso.TableComponents<ModelRow> = {
  Table: ({ style, ...rest }) => (
    <table className="jm-models-table" style={{ ...style, width: '100%' }} {...rest} />
  ),
};


/** 把异常整理成可读文本。 */
function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;

  return String(error);
}


/**
 * 清单里的模型写进 config.yaml 的样子。
 * @param model 清单里的模型。
 * @returns 写入配置的参数对象。
 */
function getModelParams(model: api.ModelInfo): Record<string, unknown> {
  const params: Record<string, unknown> = {
    context_window: model.contextWindow,
    vision: model.vision === true,
    thinking: model.thinking,
    price: model.price,
  };
  if (model.maxOutputTokens) {
    params.max_output_tokens = model.maxOutputTokens;
  }
  return params;
}


/**
 * 一个值是数字就用，不是就当没写。
 * @param value 原始字段值。
 * @returns 数值或 null。
 */
function getNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return value;

  return null;
}


/**
 * 一家供应商的模型目录：每个模型一行（上下文、最大输出、能不能看图、思考档、价格）。
 * 手写的优先；清单给的改了哪一项，就把这个模型整个写进 config.yaml。“获取可用模型”直接问供应商，用还没保存的地址和密钥。
 * @param props 草稿、改动、全部模型、供应商名。
 */
function ProviderModels(props: SectionProps & { provider: string }): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于模型目录表头、工具栏和批量导入弹窗文案。
  const t = i18n.useT();
  /** 路径。 */
  const base: editsModule.Path = ['providers', props.provider, 'models'];
  /** 手写的。 */
  //M 从草稿读取该供应商下用户手写的 models 配置，作为最高优先级参数来源。
  const own = editsModule.getAt(props.draft, base);
  let written: Record<string, Record<string, unknown>> = {};
  if (own && typeof own === 'object' && !Array.isArray(own)) {
    written = own as Record<string, Record<string, unknown>>;
  }
  /** 模型 ID 的开头。 */
  const prefix = `${props.provider}/`;
  /** 刚取到的；弹窗开着时不是 null。 */
  const [fetched, setFetched] = react.useState<api.ModelInfo[] | null>(null);
  /** 取的过程、勾了哪些、筛选、要手写的、提示。 */
  const [fetching, setFetching] = react.useState(false);
  const [picked, setPicked] = react.useState<string[]>([]);
  /** “获取可用模型”弹窗里勾选列表的滚动元素（.jm-pull-list，限高 50vh）：一家几百个模型，交给 react-virtuoso 当 customScrollParent。 */
  const [pullScroller, setPullScroller] = react.useState<HTMLDivElement | null>(null);
  /** 模型目录虚拟表格的外层滚动容器。 */
  const [modelsScroller, setModelsScroller] = react.useState<HTMLDivElement | null>(null);
  const [filter, setFilter] = react.useState('');
  const [adding, setAdding] = react.useState('');
  const [notice, setNotice] = react.useState('');
  /** 全部模型：手写的在前，清单给的在后。 */
  //M 把手写模型和后端清单模型拼成目录表格行，后者转成与 config.yaml 一致的参数格式供编辑。
  const rows: ModelRow[] = [
    ...Object.entries(written).map(([id, params]) => ({ id, params, written: true })),
    ...props.models
      .filter((model) => {
        const shortId = model.id.slice(prefix.length);
        return model.kind === 'chat' && model.id.startsWith(prefix) && !(shortId in written);
      })
      .map((model) => ({
        id: model.id.slice(prefix.length),
        params: getModelParams(model),
        written: false,
      })),
  ];
  /** 筛过的。 */
  const shown = rows.filter((row) => row.id.toLowerCase().includes(filter.trim().toLowerCase()));
  /**
   * 改一个模型的一个参数。
   * @param row 这一行。
   * @param key 参数。
   * @param value 新值；undefined 是删掉。
   */
  const set = (row: ModelRow, key: editsModule.Path, value: unknown): void => {
    /** 这一步改动（相对这个模型）。 */
    if (row.written) {
      const path = [...base, row.id, ...key];
      if (value === undefined) {
        //G 已有手写配置的模型清空某项参数时，删除该子键恢复默认。
        props.onEdit({ path, delete: true });
        return;
      }

      //M 已有手写配置的模型改参数时，按具体子路径增量写回草稿。
      props.onEdit({ path, value });
      return;
    }
    let step: editsModule.Edit = { path: key, value };
    if (value === undefined) {
      step = { path: key, delete: true };
    }

    //M 清单模型首次被改动时，把当前行参数应用本步改动后整行落盘成手写配置。
    props.onEdit({ path: [...base, row.id], value: editsModule.applyEdit(row.params, step) });
  };
  /** 问供应商有哪些模型。 */
  const fetchModels = (): void => {
    setFetching(true);
    setNotice('');
    /** 文字配置。 */
    const getTextAt = (key: string): string => {
      /** 这一项。 */
      //M 从当前草稿取出未保存的供应商连接参数（地址、密钥、协议），供拉取模型接口直接使用。
      const value = editsModule.getAt(props.draft, ['providers', props.provider, key]);
      if (typeof value === 'string') return value;

      return '';
    };

    //M 用草稿里的当前连接参数向供应商拉取最新模型清单，并筛出尚未手写的对话模型供勾选导入。
    const queryInput = {
      provider: props.provider,
      base_url: getTextAt('base_url'),
      api_key: getTextAt('api_key'),
      api: getTextAt('api'),
    };
    void api.providerModels(queryInput).then(
      (result) => {
        setFetching(false);
        /** 还没写进 config.yaml 的。 */
        const fresh = result.models.filter((model) => {
          const shortId = model.id.slice(prefix.length);
          return model.kind === 'chat' && !(shortId in written);
        });
        setPicked(fresh.map((model) => model.id));
        setFetched(fresh);
        setNotice(t('这家一共 {count} 个模型', { count: result.models.length }));
      },
      (error: unknown) => {
        setFetching(false);
        //G 拉取供应商清单失败时把异常格式化为可读提示，展示在工具栏下方。
        setNotice(t('没取到：{reason}', { reason: getErrorText(error) }));
      },
    );
  };

  //M 渲染供应商模型目录：提供拉取与手写入口、虚拟表格行内直改以及导入勾选弹窗。
  return (
    <div className="jm-provider-models">
      <div className="jm-provider-models-head">
        <strong>{t('模型目录')}</strong>
        <span className="jm-muted">
          {t('手写的优先；清单只给 ID 时，没写的用保守值（上下文 128000、最大输出 8192、看不了图）')}
        </span>
        <antd.Button size="small" icon={<icons.CloudDownloadOutlined />} loading={fetching} onClick={fetchModels}>
          {t('获取可用模型')}
        </antd.Button>
      </div>
      {notice && <div className="jm-muted">{notice}</div>}
      <div className="jm-model-tools">
        <antd.Input
          size="small"
          allowClear
          placeholder={t('筛选（共 {count} 个）', { count: rows.length })}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <antd.Space.Compact size="small">
          <antd.Input
            placeholder={t('手写一个模型 ID')}
            value={adding}
            onChange={(event) => setAdding(event.target.value.trim())}
          />
          <antd.Button
            icon={<icons.PlusOutlined />}
            disabled={!adding || adding in written}
            onClick={() => {
              //M 按保守默认参数把用户手写的模型 ID 加入草稿目录，并清空输入框。
              props.onEdit({ path: [...base, adding], value: { ...BLANK_MODEL } });
              setAdding('');
            }}
          >
            {t('加')}
          </antd.Button>
        </antd.Space.Compact>
      </div>
      {shown.length > 0 && (
        <div className="jm-models-scroll" ref={setModelsScroller}>
          {modelsScroller !== null && (
            <virtuoso.TableVirtuoso
              customScrollParent={modelsScroller}
              components={MODEL_TABLE_COMPONENTS}
              data={shown}
              computeItemKey={(_index, row) => row.id}
              overscan={SETTINGS_OVERSCAN_PX}
              fixedHeaderContent={() => (
                <tr>
                  <th>{t('模型')}</th>
                  <th>{t('上下文')}</th>
                  <th>{t('最大输出')}</th>
                  <th>{t('看图')}</th>
                  <th>{t('思考档')}</th>
                  <th>{t('价格（入 / 出，美元每百万）')}</th>
                  <th />
                </tr>
              )}
              itemContent={(_index, row) => {
                /** 价格。 */
                const price = (row.params.price ?? {}) as { input?: unknown; output?: unknown };
                let thinkingSelected: string[] = [];
                if (Array.isArray(row.params.thinking)) {
                  thinkingSelected = row.params.thinking as string[];
                }

                //M 渲染单个模型行：回显上下文、最大输出、看图、思考档与价格，并在修改时写回草稿（手写行可删除）。
                return (
                  <>
                    <td className="jm-models-id" title={row.id}>
                      {row.id}
                      {!row.written && <antd.Tag className="jm-models-tag">{t('清单')}</antd.Tag>}
                    </td>
                    <td>
                      <antd.InputNumber
                        size="small"
                        min={1}
                        value={getNumberOrNull(row.params.context_window)}
                        onChange={(next) => set(row, ['context_window'], next ?? undefined)}
                      />
                    </td>
                    <td>
                      <antd.InputNumber
                        size="small"
                        min={1}
                        value={getNumberOrNull(row.params.max_output_tokens)}
                        onChange={(next) => set(row, ['max_output_tokens'], next ?? undefined)}
                      />
                    </td>
                    <td>
                      <antd.Switch
                        size="small"
                        checked={row.params.vision === true}
                        onChange={(checked) => set(row, ['vision'], checked)}
                      />
                    </td>
                    <td>
                      <antd.Select
                        size="small"
                        mode="multiple"
                        className="jm-models-thinking"
                        value={thinkingSelected}
                        options={THINKING}
                        onChange={(next: string[]) => {
                          let thinkingValue: string[] | undefined;
                          if (next.length > 0) {
                            thinkingValue = next;
                          }

                          //M 已选思考档为空时传 undefined 删键，非空时把档位数组写入该模型配置。
                          set(row, ['thinking'], thinkingValue);
                        }}
                      />
                    </td>
                    <td className="jm-models-price">
                      <antd.InputNumber
                        size="small"
                        min={0}
                        step={0.01}
                        value={getNumberOrNull(price.input)}
                        onChange={(next) => set(row, ['price', 'input'], next ?? undefined)}
                      />
                      <antd.InputNumber
                        size="small"
                        min={0}
                        step={0.01}
                        value={getNumberOrNull(price.output)}
                        onChange={(next) => set(row, ['price', 'output'], next ?? undefined)}
                      />
                    </td>
                    <td>
                      {row.written && (
                        <antd.Button
                          size="small"
                          type="text"
                          danger
                          icon={<icons.DeleteOutlined />}
                          aria-label={t('删掉 {name} 的手写参数', { name: row.id })}
                          onClick={() => props.onEdit({ path: [...base, row.id], delete: true })}
                        />
                      )}
                    </td>
                  </>
                );
              }}
            />
          )}
        </div>
      )}
      <antd.Modal
        open={fetched !== null}
        title={t('{name} 有这些模型还没写进 config.yaml', { name: props.provider })}
        okText={t('写进 config.yaml（{count} 个）', { count: picked.length })}
        cancelText={t('不要了')}
        onCancel={() => setFetched(null)}
        onOk={() => {
          for (const model of (fetched ?? []).filter((item) => picked.includes(item.id))) {
            //M 把用户勾选的拉取模型逐个转成 config.yaml 参数格式写进该供应商的 models 草稿。
            props.onEdit({ path: [...base, model.id.slice(prefix.length)], value: getModelParams(model) });
          }
          setFetched(null);
        }}
      >
        <p className="jm-muted">{t('写进去以后以 config.yaml 为准，改上下文就是改那一行。不写进去也能用，用的是清单给的值。')}</p>
        {fetched?.length === 0 && <p>{t('都写过了。')}</p>}
        {/* //M 一家几百个模型：虚拟滚动，借勾选组自己限高滚动；勾了哪些由 picked 记着，滚出去的照旧算勾上。 */}
        <antd.Checkbox.Group
          className="jm-pull-list"
          ref={setPullScroller}
          value={picked}
          onChange={(next) => setPicked(next)}
        >
          {pullScroller && (
            <virtuoso.Virtuoso
              customScrollParent={pullScroller}
              data={fetched ?? []}
              computeItemKey={(_index, model) => model.id}
              itemContent={(_index, model) => {
                let visionText = t('不看图');
                if (model.vision) {
                  visionText = t('看图');
                }
                const summaryText = t('{id} · 上下文 {context} · 最大输出 {output} · {vision}', {
                  id: model.id.slice(prefix.length),
                  context: model.contextWindow,
                  output: model.maxOutputTokens ?? '?',
                  vision: visionText,
                });
                return (
                  <div className="jm-pull-row">
                    <antd.Checkbox value={model.id}>{summaryText}</antd.Checkbox>
                  </div>
                );
              }}
            />
          )}
        </antd.Checkbox.Group>
      </antd.Modal>
    </div>
  );
}


/**
 * 一家供应商的配置：密钥、地址、协议、模型目录；不常用的收在“高级”里。
 * @param props 草稿、改动、全部模型、供应商名。
 */
function ProviderForm(props: SectionProps & { name: string }): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于供应商表单字段名称、提示及删除确认弹窗。
  const t = i18n.useT();
  /**
   * 这一家某一项的路径。
   * @param key 键。
   */
  const getPathAt = (key: string): editsModule.Path => ['providers', props.name, key];
  //M 渲染单家供应商配置表单：提供整家删除确认、基础连接项、模型目录及高级兼容设置。
  return (
    <div className="jm-provider-form">
      <header className="jm-provider-head">
        <strong>{props.name}</strong>
        <antd.Popconfirm
          title={t('删掉供应商 {name}？', { name: props.name })}
          okText={t('删掉')}
          cancelText={t('不删')}
          onConfirm={() => props.onEdit({ path: ['providers', props.name], delete: true })}
        >
          <antd.Button size="small" type="text" danger icon={<icons.DeleteOutlined />}>
            {t('删掉')}
          </antd.Button>
        </antd.Popconfirm>
      </header>
      {
        //M 渲染该供应商基础连接字段（密钥、地址、协议、启动拉清单开关），经 getPathAt 拼出草稿路径。
      /**/}
      <fields.TextField
        label={t('API 密钥 api_key')}
        hint={t('本地不要密钥的服务可以不写')}
        draft={props.draft}
        path={getPathAt('api_key')}
        onEdit={props.onEdit}
      />
      <fields.TextField
        label={t('API 地址 base_url')}
        hint={t('如 https://api.deepseek.com/v1；本地的服务写本机地址')}
        draft={props.draft}
        path={getPathAt('base_url')}
        onEdit={props.onEdit}
      />
      <fields.SelectField
        label={t('API 协议 api')}
        options={APIS}
        placeholder={t('openai-completions（默认）')}
        draft={props.draft}
        path={getPathAt('api')}
        onEdit={props.onEdit}
      />
      <fields.BoolField
        label={t('启动时拉模型清单 list_models')}
        hint={t('启动时向 <base_url>/models 拉清单（默认开）；没有清单接口就关掉，只用手写的')}
        fallback
        draft={props.draft}
        path={getPathAt('list_models')}
        onEdit={props.onEdit}
      />
      <ProviderModels {...props} provider={props.name} />
      <antd.Collapse
        size="small"
        ghost
        items={[
          {
            key: 'advanced',
            label: t('高级：兼容设置'),
            children: (
              <>
                {
                  //M 渲染供应商级与单模型级兼容性 JSON 覆盖字段，经 getPathAt 拼出高级兼容配置路径。
                /**/}
                <fields.JsonField
                  label={t('兼容设置 compat')}
                  hint={t('发请求时的兼容设置，原样交给 Pi（OpenAICompletionsCompat），如 { "maxTokensField": "max_tokens" }')}
                  draft={props.draft}
                  path={getPathAt('compat')}
                  onEdit={props.onEdit}
                />
                <fields.JsonField
                  label={t('个别模型的兼容 model_compat')}
                  hint={t('模型 ID → 再加的兼容设置，如 DeepSeek 思考模式下调工具要带回上一步的思考')}
                  draft={props.draft}
                  path={getPathAt('model_compat')}
                  onEdit={props.onEdit}
                />
              </>
            ),
          },
        ]}
      />
    </div>
  );
}


/**
 * 模型供应商：左边选一家（或加一家），右边配它和它的模型。任意多家，哪一家都不特殊对待。
 * @param props 草稿、改动回调与全部模型清单。
 */
export function Providers(props: SectionProps): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于未保存标记提示和添加供应商按钮无障碍标签。
  const t = i18n.useT();
  /** 全部供应商。 */
  //M 从草稿提取全部供应商名，用于渲染左侧导航列表并决定右侧默认展示哪一家。
  const names = fields.getProviderNames(props.draft);
  /** 判断改过没有。 */
  const isChanged = react.useContext(fields.ChangedContext);
  /** 选的那一家、要加的那一家的名字。 */
  const [selected, setSelected] = react.useState('');
  const [adding, setAdding] = react.useState('');

  /** 现在看的那一家。 */
  let current = names[0];
  if (names.includes(selected)) {
    current = selected;
  }

  let providerPane: react.ReactNode = <div className="jm-muted">{t('还没有供应商：在左边加一家')}</div>;
  if (current) {
    providerPane = <ProviderForm key={current} {...props} name={current} />;
  }

  //M 渲染供应商双栏页面：左侧切换或新增供应商并展示改过红点，右侧呈现选中供应商表单。
  return (
    <div className="jm-providers">
      <nav className="jm-provider-list">
        {names.map((name) => {
          let itemClass = 'jm-settings-cat';
          if (name === current) {
            itemClass = 'jm-settings-cat jm-active';
          }

          return (
            <button key={name} type="button" className={itemClass} onClick={() => setSelected(name)}>
              <span>{name}</span>
              {isChanged(['providers', name]) && <span className="jm-settings-dot" title={t('改过，还没保存')} />}
            </button>
          );
        })}
        <antd.Space.Compact className="jm-provider-add">
          <antd.Input
            value={adding}
            placeholder={t('新供应商的名字')}
            onChange={(event) => setAdding(event.target.value.trim())}
          />
          <antd.Button
            icon={<icons.PlusOutlined />}
            aria-label={t('添加供应商')}
            disabled={!adding || names.includes(adding)}
            onClick={() => {
              //M 为新供应商写入默认协议与启动拉清单开关到草稿，并立即选中它便于继续编辑。
              props.onEdit({
                path: ['providers', adding],
                value: { base_url: '', api: 'openai-completions', list_models: true },
              });
              setSelected(adding);
              setAdding('');
            }}
          />
        </antd.Space.Compact>
      </nav>
      {providerPane}
    </div>
  );
}


/**
 * 模型：默认模型、决策模型、备用链、看图的模型。
 * @param props 草稿、改动回调与全部模型清单。
 */
export function Models(props: SectionProps): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于各模型用途字段的标题和说明文案。
  const t = i18n.useT();
  //M 渲染“模型”分类表单：分别配置默认模型、决策模型、备用链、重试上限与看图模型。
  return (
    <div className="jm-section">
      <fields.ModelField
        label={t('默认模型 default_model')}
        hint={t('新开会话和 exec 审核的小循环用它。写成“供应商/模型 ID”。会话要换模型在会话页换')}
        models={props.models}
        kind="chat"
        draft={props.draft}
        path={['default_model']}
        onEdit={props.onEdit}
      />
      <fields.ModelField
        label={t('决策模型 models.decision')}
        hint={t('分派、压缩、exec 审核先问它（只回每个选项的概率）；可以不配')}
        models={props.models}
        kind="decision"
        draft={props.draft}
        path={['models', 'decision', 'model']}
        onEdit={props.onEdit}
      />
      <fields.ModelListField
        label={t('备用链 fallback.chain')}
        hint={t('模型被限流时依次换着试（能调顺序）')}
        models={props.models}
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.fallbackChain}
        onEdit={props.onEdit}
      />
      <fields.NumberField
        label={t('最多再试几个 fallback.max_tries')}
        hint={t('被限流后最多再试几个模型（默认 5）')}
        min={0}
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.fallbackMaxTries}
        onEdit={props.onEdit}
      />
      <fields.ModelField
        label={t('看图的模型 vision_model')}
        hint={t('看不了图的模型读到图片时，先交给它转成文字；不写就不转')}
        models={props.models}
        needVision
        kind="chat"
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.visionModel}
        onEdit={props.onEdit}
      />
    </div>
  );
}


/** 语言。 */
const LANGUAGES = [{ value: 'zh', label: '中文 zh' }, { value: 'en', label: 'English en' }];


/** 一个飞书应用（config.yaml 的 channels.feishu 的一项）。 */
interface FeishuApp {
  /** 应用 ID。 */
  app_id?: unknown;
  /** 应用密钥。 */
  app_secret?: unknown;
  /** 对应的机器人。 */
  bot?: unknown;
}


/**
 * 一行飞书应用。
 * @param props 第几项、这一项、改一个键、删掉、能选的机器人（没绑机器人的那几项才有）。
 */
function FeishuRow(props: {
  index: number;
  app: FeishuApp;
  onEdit: (edit: editsModule.Edit) => void;
  onDelete: () => void;
  bots?: { value: string; label: string }[];
}): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于机器人下拉占位符和删除按钮无障碍标签。
  const t = i18n.useT();
  /**
   * 改一个键。
   * @param key 键。
   * @param value 新值。
   */
  const set = (key: string, value: string): void => {
    props.onEdit({ path: ['channels', 'feishu', props.index, key], value });
  };
  let appId = '';
  if (typeof props.app.app_id === 'string') {
    appId = props.app.app_id;
  }
  let appSecret = '';
  if (typeof props.app.app_secret === 'string') {
    appSecret = props.app.app_secret;
  }
  let botValue: string | undefined;
  if (typeof props.app.bot === 'string') {
    botValue = props.app.bot;
  }

  //M 渲染单行飞书应用表单：输入 app_id 与 app_secret，并在未绑定行允许选择关联机器人。
  return (
    <div className="jm-object-row">
      <antd.Input
        className="jm-object-cell"
        placeholder="app_id"
        value={appId}
        onChange={(event) => set('app_id', event.target.value)}
      />
      <antd.Input
        className="jm-object-cell"
        placeholder="app_secret"
        value={appSecret}
        onChange={(event) => set('app_secret', event.target.value)}
      />
      {props.bots && (
        <antd.Select
          className="jm-object-cell"
          placeholder={t('对应的机器人')}
          value={botValue}
          options={props.bots}
          onChange={(next: string) => set('bot', next)}
        />
      )}
      <antd.Button
        size="small"
        type="text"
        danger
        icon={<icons.DeleteOutlined />}
        aria-label={t('删掉这个飞书应用')}
        onClick={props.onDelete}
      />
    </div>
  );
}


/**
 * 机器人：有几个列几个（运行时 bots/ 下的文件夹和 config.yaml 的 bots 合起来），每个的语言和它的渠道都在它下面。
 * 渠道跟机器人绑在一起：飞书应用写在 config.yaml 的 channels.feishu，每项记着对应哪个机器人。
 * @param props 草稿、改动回调与全部模型清单。
 */
export function Bots(props: SectionProps): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于机器人卡片字段标签、游离应用卡片标题和新增控件。
  const t = i18n.useT();
  /** 后端认的机器人。 */
  //M 从界面状态仓库取出运行时已存在的机器人及语言，作为合并名单的底表。
  const live = context.useUi((state) => state.bots);
  /** config.yaml 里写的。 */
  //M 从设置草稿取出配置文件里写下的机器人列表，后续与运行时机器人合并并覆盖语言设置。
  const written = editsModule.getAt(props.draft, ['bots']);
  /** 全部机器人：名字 → 语言。 */
  const all = new Map<string, string>(live.map((bot) => [bot.name, bot.language]));
  let writtenBots: { name?: unknown; language?: unknown }[] = [];
  if (Array.isArray(written)) {
    writtenBots = written as { name?: unknown; language?: unknown }[];
  }
  for (const bot of writtenBots) {
    if (typeof bot.name === 'string' && bot.name) {
      let lang = all.get(bot.name) ?? 'zh';
      if (typeof bot.language === 'string') {
        lang = bot.language;
      }
      all.set(bot.name, lang);
    }
  }

  /** 飞书应用。 */
  //M 从设置草稿取出 channels.feishu 列表，按 bot 字段归入对应机器人卡片下展示。
  const feishu = editsModule.getAt(props.draft, ['channels', 'feishu']);
  let apps: FeishuApp[] = [];
  if (Array.isArray(feishu)) {
    apps = feishu as FeishuApp[];
  }
  /** 要加的机器人的名字。 */
  const [adding, setAdding] = react.useState('');
  /**
   * 把机器人的名单整个写进 config.yaml。
   * @param next 新名单。
   */
  const saveBots = (next: Map<string, string>): void => {
    props.onEdit({ path: ['bots'], value: [...next].map(([name, language]) => ({ name, language })) });
  };
  /**
   * 整列换掉飞书应用。
   * @param next 新列表。
   */
  const saveApps = (next: FeishuApp[]): void => props.onEdit({ path: ['channels', 'feishu'], value: next });
  /** 没绑到现有机器人的飞书应用。 */
  const loose = apps.flatMap((app, index) => {
    if (typeof app.bot === 'string' && all.has(app.bot)) return [];

    return [{ app, index }];
  });

  //M 渲染机器人设置区：按合并后的机器人逐卡管理语言与绑定飞书应用，并展示游离应用与新增入口。
  return (
    <div className="jm-section">
      {[...all].map(([name, language]) => (
        <antd.Card key={name} size="small" className="jm-provider" title={name}>
          {
            //M 切换该机器人提示词语言时，把合并后的完整机器人名单写回草稿。
          /**/}
          <fields.Row label={t('语言')} hint={t('选提示词用哪种语言')} path={['bots']}>
            <antd.Select
              className="jm-field-select"
              value={language}
              options={LANGUAGES}
              onChange={(next: string) => saveBots(new Map(all).set(name, next))}
            />
          </fields.Row>
          <fields.Row
            label={t('飞书应用')}
            hint={t('这个机器人接哪几个飞书应用；回复从收到消息的那个应用发回去')}
            path={['channels', 'feishu']}
          >
            <div className="jm-objects">
              {apps.map((app, index) => {
                if (app.bot !== name) return null;

                //M 只渲染绑定到当前机器人的飞书应用行，并在删除时从整列应用中过滤掉该下标。
                return (
                  <FeishuRow
                    key={index}
                    index={index}
                    app={app}
                    onEdit={props.onEdit}
                    onDelete={() => saveApps(apps.filter((_, at) => at !== index))}
                  />
                );
              })}
              {
                //M 在当前机器人卡片下追加一条预先绑定 bot 名的空白飞书应用记录。
              /**/}
              <antd.Button
                className="jm-list-add"
                icon={<icons.PlusOutlined />}
                onClick={() => saveApps([...apps, { app_id: '', app_secret: '', bot: name }])}
              >
                {t('加一个飞书应用')}
              </antd.Button>
            </div>
          </fields.Row>
        </antd.Card>
      ))}
      {loose.length > 0 && (
        <antd.Card size="small" className="jm-provider" title={t('没绑机器人的飞书应用')}>
          <div className="jm-objects">
            {
              //M 列出尚未关联到有效机器人的游离飞书应用，供用户补选机器人或清理删除。
            /**/}
            {loose.map(({ app, index }) => (
              <FeishuRow
                key={index}
                index={index}
                app={app}
                onEdit={props.onEdit}
                onDelete={() => saveApps(apps.filter((_, at) => at !== index))}
                bots={[...all.keys()].map((name) => ({ value: name, label: name }))}
              />
            ))}
          </div>
        </antd.Card>
      )}
      <fields.Row
        label={t('加一个机器人')}
        hint={t('名字可以是中文，就是运行时 bots/ 下的文件夹名；保存、重启后生效。直接往 bots/ 里放一个文件夹，重启后也会出现')}
      >
        <antd.Space.Compact>
          <antd.Input
            value={adding}
            placeholder={t('名字')}
            onChange={(event) => setAdding(event.target.value.trim())}
          />
          <antd.Button
            icon={<icons.PlusOutlined />}
            disabled={!adding || all.has(adding)}
            onClick={() => {
              //M 把新增机器人按默认中文语言加入名单并写回草稿，再清空输入名称。
              saveBots(new Map(all).set(adding, 'zh'));
              setAdding('');
            }}
          >
            {t('加')}
          </antd.Button>
        </antd.Space.Compact>
      </fields.Row>
    </div>
  );
}


/**
 * 搜索：web_search 工具按顺序试。
 * @param props 草稿、改动回调与全部模型清单。
 */
export function Search(props: SectionProps): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于搜索配置项说明和表格列标题。
  const t = i18n.useT();
  /** 配了的供应商：magpie 种类从哪一家借地址和密钥。 */
  //M 从设置草稿读取已配置的供应商名，填入 magpie 搜索行的供应商下拉选项。
  const providers = editsModule.getAt(props.draft, ['providers']);
  /** 供应商下拉的选项。 */
  let providerMap: Record<string, unknown> = {};
  if (providers !== null && typeof providers === 'object') {
    providerMap = providers as Record<string, unknown>;
  }
  const providerOptions = Object.keys(providerMap).map((name) => ({ value: name, label: name }));

  const searchHint = t(
    '按顺序试，前一个出错或搜不到就用下一个；一个都不写就不能搜网页。'
    + 'magpie：Magpie 网关的搜索接口，供应商选用“模型供应商”里哪一家的地址和密钥，'
    + 'model 写网关里的模型 ID；zhipu_mcp：智谱 MCP 搜索，api_key 填智谱的密钥',
  );
  //M 渲染网页搜索配置列表：允许按优先级增删排序各种搜索后端。
  return (
    <div className="jm-section">
      <ObjectListField
        label={t('网页搜索 search')}
        hint={searchHint}
        columns={[
          {
            key: 'kind',
            label: t('方式'),
            kind: 'select',
            options: [{ value: 'magpie', label: 'magpie' }, { value: 'zhipu_mcp', label: 'zhipu_mcp' }],
          },
          { key: 'provider', label: t('供应商'), kind: 'select', options: providerOptions },
          { key: 'model', label: 'model', kind: 'text', placeholder: t('model（magpie 用：网关里的模型 ID）') },
          { key: 'api_key', label: 'api_key', kind: 'text' },
          { key: 'url', label: 'url', kind: 'text', placeholder: t('url（不写用默认）') },
        ]}
        blank={{}}
        orderable
        draft={props.draft}
        path={['search']}
        onEdit={props.onEdit}
      />
    </div>
  );
}


/**
 * 引擎：记忆搜索、生图、收尾与重试配置。
 * @param props 草稿、改动回调与全部模型清单。
 */
export function Engine(props: SectionProps): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于引擎各参数字段的标签、说明和占位文字。
  const t = i18n.useT();
  //M 渲染引擎参数表单：集中绑定记忆搜索、生图、收尾与重试配置。
  return (
    <div className="jm-section">
      <fields.TextField
        label={t('记忆搜索 index_url')}
        hint={t('基地的地址，记忆搜索用；不写就只按关键字找')}
        placeholder={t('如 http://127.0.0.1:30090')}
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.indexUrl}
        onEdit={props.onEdit}
      />
      <fields.TextField
        label={t('生图模型 image_model')}
        hint={t('写成“供应商/模型 ID”（供应商是“模型供应商”里配的名字）；机器人的 image_generate 工具用它，不写就没有生图')}
        placeholder={t('供应商/模型 ID')}
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.imageModel}
        onEdit={props.onEdit}
      />
      <fields.TextField
        label={t('收尾模型 wrapup_model')}
        hint={t('限时到点时写收尾总结的模型，不带工具、最低思考档；不写就用会话自己的模型')}
        placeholder={t('供应商/模型 ID')}
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.wrapupModel}
        onEdit={props.onEdit}
      />
      <fields.NumberField
        label={t('重试等待 models.retry.wait_ms')}
        hint={t('连接出错时同一个模型首次重试前等多久（毫秒，默认 3000）')}
        min={0}
        draft={props.draft}
        path={['models', 'retry', 'wait_ms']}
        onEdit={props.onEdit}
      />
      <fields.BoolField
        label={t('试同家别的模型 fallback_include_siblings')}
        hint={t('备用链用完后，要不要接着试同一个供应商里不收费的其他模型（默认要）')}
        fallback
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.fallbackSiblings}
        onEdit={props.onEdit}
      />
    </div>
  );
}


/**
 * 并发：全局默认、单模型和单供应商同时调用上限。
 * @param props 草稿、改动回调与全部模型清单。
 */
export function Concurrency(props: SectionProps): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于并发上限字段的名称、说明和键名占位符。
  const t = i18n.useT();
  //M 渲染并发上限配置表单：分别配置全局默认、单模型与单供应商总并发。
  return (
    <div className="jm-section">
      <fields.NumberField
        label={t('每个模型 default')}
        hint={t('同一时间每个模型默认最多几个调用，超了排队（不报错，默认 3）')}
        min={1}
        draft={props.draft}
        path={['concurrency', 'default']}
        onEdit={props.onEdit}
      />
      <fields.NumberMapField
        label={t('单独设的模型 models')}
        hint={t('“供应商/模型 ID” → 上限')}
        keyPlaceholder={t('供应商/模型 ID')}
        draft={props.draft}
        path={['concurrency', 'models']}
        onEdit={props.onEdit}
      />
      <fields.NumberMapField
        label={t('供应商合计 providers')}
        hint={t('供应商名 → 它所有模型加起来最多几个；不写不限')}
        keyPlaceholder={t('供应商名')}
        draft={props.draft}
        path={['concurrency', 'providers']}
        onEdit={props.onEdit}
      />
    </div>
  );
}


/**
 * 服务：后端端口、server.token、外网反代鉴权（server.web_auth）与多访问令牌管理。
 * @param props 草稿、改动回调与全部模型清单。
 */
export function Http(props: SectionProps): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于服务端口与 server.token 字段文案。
  const t = i18n.useT();
  //M 渲染服务配置表单：绑定 server.port、server.token、server.web_auth 与动态访问令牌管理。
  return (
    <div className="jm-section">
      <fields.NumberField
        label={t('端口 server.port')}
        hint={t('一律监听 0.0.0.0（换版本时的试运行也一样）')}
        min={1}
        max={65535}
        draft={props.draft}
        path={['server', 'port']}
        onEdit={props.onEdit}
      />
      <fields.TextField
        label={t('token server.token')}
        hint={t('老的单个 token，照样认、当成永久的；以后用下面的“访问令牌”，可以建多个')}
        draft={props.draft}
        path={['server', 'token']}
        onEdit={props.onEdit}
      />
      <webAuthField.WebAuthField draft={props.draft} onEdit={props.onEdit} />
      <TokenManager />
    </div>
  );
}


/** 新建临时令牌时能选的分钟数。 */
const TOKEN_MINUTES = [10, 60, 240, 1440];


/**
 * 访问令牌（用户 11-06 原话第 66 节）：别的 AI、手机来访问要带一个；可以建多个，永久的或临时的，能刷新、能删。
 * 直接调后端，不写进 config.yaml；带 server.token 的请求才能管令牌。
 */
function TokenManager(): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于令牌列表状态、有效期文案和二次确认弹窗。
  const t = i18n.useT();
  /** 全部令牌；还没取到是 null。 */
  const [list, setList] = react.useState<api.TokenInfo[] | null>(null);
  /** 出错的原因。 */
  const [error, setError] = react.useState('');
  /** 新建：名字和分钟数（0 是永久）。 */
  const [name, setName] = react.useState('');
  const [minutes, setMinutes] = react.useState(0);
  /** 取一次。 */
  const load = react.useCallback((): void => {
    //M 向后端请求全部访问令牌列表，成功更新展示并清空报错。
    void api.tokens().then(
      (next) => {
        setList(next);
        setError('');
      },

      //G 拉取令牌失败时整理异常为可读提示，在区域顶部报错。
      (reason: unknown) => setError(getErrorText(reason)),
    );
  }, []);
  react.useEffect(load, [load]);
  /**
   * 做一件事，做完重取。
   * @param work 要做的事。
   */
  const run = (work: Promise<unknown>): void => {
    //M 等待令牌创建、刷新或删除请求完成后重载列表，出错时格式化异常显示。
    void work.then(load, (reason: unknown) => setError(getErrorText(reason)));
  };
  /** 接入说明的地址（别的 AI 要把前面换成这台电脑的局域网地址）。 */
  const guide = `${window.location.origin}/api/agents/guide`;

  const tokenGuideHint = t(
    '所有请求都要带令牌（网址后面 ?token=，或请求头 Authorization: Bearer）。'
    + '接入说明：{url}?token=…（把前面换成这台电脑的局域网地址，token 换成有效令牌）',
    { url: guide },
  );

  //M 渲染访问令牌管理区：展示报错、已有令牌条目和底部新建令牌表单。
  return (
    <fields.Row label={t('访问令牌')} hint={tokenGuideHint}>
      <div className="jm-tokens">
        {error && <div className="jm-muted">{error}</div>}
        {list?.length === 0 && <div className="jm-muted">{t('还没有令牌')}</div>}
        {list?.map((token) => {
          /** 过期了没有。 */
          const expired = token.expiresAt !== undefined && token.expiresAt <= Date.now();

          /** 永久还是临时、什么时候到期。 */
          let kind = t('永久');
          if (expired) {
            kind = t('已过期');
          }
          if (!expired && token.expiresAt !== undefined) {
            //M 未过期的临时令牌把到期时间戳转成可读时间展示。
            kind = t('临时 {minutes} 分钟，{time} 到期', {
              minutes: token.minutes ?? 0,
              time: timeline.formatTime(token.expiresAt),
            });
          }

          let tokenClass = 'jm-token';
          if (expired) {
            tokenClass = 'jm-token jm-token-expired';
          }

          let usedText = t('还没用过');
          if (token.usedAt) {
            //M 记录过使用时刻的令牌把时间戳格式化为最近使用时间展示。
            usedText = t('最近用：{time}', { time: timeline.formatTime(token.usedAt) });
          }

          //M 渲染单条令牌信息：展示名称、可复制值和到期/使用时间。
          return (
            <div key={token.id} className={tokenClass}>
              <span className="jm-token-name">{token.name}</span>
              <antd.Typography.Text className="jm-token-value" copyable={{ text: token.value }}>
                {token.value}
              </antd.Typography.Text>
              <span className="jm-muted">
                {kind}
                {' · '}
                {usedText}
              </span>
              {
                //M 二次确认后通知后端换发新令牌值并重载列表，旧值立即失效。
              /**/}
              <antd.Popconfirm
                title={t('换一个新值？旧的马上失效，用它的 AI 要换成新的')}
                okText={t('换')}
                cancelText={t('不换')}
                onConfirm={() => run(api.refreshToken(token.id))}
              >
                <antd.Button size="small">{t('刷新')}</antd.Button>
              </antd.Popconfirm>
              {
                //M 二次确认后通知后端删掉该令牌并重载列表。
              /**/}
              <antd.Popconfirm
                title={t('删掉 {name} 的令牌？用它的 AI 马上进不来', { name: token.name })}
                okText={t('删掉')}
                cancelText={t('不删')}
                onConfirm={() => run(api.deleteToken(token.id))}
              >
                <antd.Button size="small" danger>{t('删除')}</antd.Button>
              </antd.Popconfirm>
            </div>
          );
        })}
        {list && (
          <antd.Space.Compact className="jm-token-new">
            <antd.Input
              size="small"
              placeholder={t('给谁用的，比如 grokbots')}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <antd.Select
              size="small"
              value={minutes}
              onChange={setMinutes}
              options={[
                { value: 0, label: t('永久') },
                ...TOKEN_MINUTES.map((value) => ({
                  value,
                  label: t('临时 {minutes} 分钟', { minutes: value }),
                })),
              ]}
            />
            <antd.Button
              size="small"
              type="primary"
              disabled={!name.trim()}
              onClick={() => {
                //M 按输入用途名和有效分钟数（0 转 undefined 表示永久）新建令牌并重置输入框。
                run(api.createToken(name.trim(), minutes || undefined));
                setName('');
              }}
            >
              {t('新建')}
            </antd.Button>
          </antd.Space.Compact>
        )}
      </div>
    </fields.Row>
  );
}


/** 开机自启的开关：拨一下马上生效，不写进 config.yaml（基地在“启动”文件夹放一个快捷方式）。无法读取自启状态时隐藏开关。 */
function AutostartSwitch(): react.JSX.Element | null {
  //M 取当前界面语言的翻译函数，用于开机自启开关名称和默认提示。
  const t = i18n.useT();
  /** 开着没有；还不知道是 null。 */
  const [enabled, setEnabled] = react.useState<boolean | null>(null);
  /** 正在改。 */
  const [saving, setSaving] = react.useState(false);
  /** 改失败的原因。 */
  const [error, setError] = react.useState('');

  react.useEffect(() => {
    //M 挂载时查询后端当前开机自启状态；请求失败时保持 null 并隐藏开关。
    void api.autostart().then((info) => setEnabled(info.enabled), () => setEnabled(null));
  }, []);

  if (enabled === null) {
    return null;
  }
  /**
   * 拨了开关。
   * @param next 想要的状态。
   */
  const change = (next: boolean): void => {
    setSaving(true);
    setError('');
    void api
      .setAutostart(next)
      .then(
        //M 切换成功后用后端返回的真实状态同步页面开关。
        (info) => setEnabled(info.enabled),
        //G 切换开机自启失败时把异常格式化为可读文字替换默认提示。
        (reason: unknown) => setError(getErrorText(reason)),
      )
      .finally(() => setSaving(false));
  };

  //M 渲染开机自启开关行：显示当前开关态、保存加载态或失败报错信息。
  return (
    <fields.Row label={t('开机自启')} hint={error || t('登录 Windows 时自动起基地和后端，只有托盘，不开窗口')}>
      <antd.Switch checked={enabled} loading={saving} onChange={change} />
    </fields.Row>
  );
}


/** 判定值是否为非空普通对象。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}


/**
 * 基地壳子（Rust 写的本地程序 jmbots.exe）：
 * 默认读写 `shell.*`；config.yaml 只有旧 `local.*` 时照旧写 `local.*`（基地见到 shell 段会整段盖过 local，
 * 只写一半会丢掉 local 里的其他项，见 local/src/config.rs），并给一个按钮把整段迁到 `shell.*`。
 * @param props 草稿、改动回调与全部模型清单。
 */
export function Local(props: SectionProps): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于基地配置字段名称、说明和占位示例。
  const t = i18n.useT();
  const shellSection = editsModule.getAt(props.draft, ['shell']);
  const localSection = editsModule.getAt(props.draft, ['local']);
  const hasShell = isPlainRecord(shellSection);
  const hasLocal = isPlainRecord(localSection);

  //M 默认写 shell.*（读取回落 local.*）；只有旧 local 段时写回 local.*。
  let writeRoot: 'shell' | 'local' = 'shell';
  let fallbackRoot: 'shell' | 'local' = 'local';
  let sourceTag = t('尚未显式配置（使用默认 30085），保存后写进 shell.*');
  if (hasShell) {
    sourceTag = t('当前配置源：shell.*（推荐）');
  }
  const onlyLocal = !hasShell && hasLocal;
  if (onlyLocal) {
    writeRoot = 'local';
    fallbackRoot = 'shell';
    sourceTag = t('当前配置源：旧版 local.*（平滑兼容）');
  }

  /** 把整段 local 搬到 shell：先写 shell，再删 local，保存后基地照读。 */
  const migrate = (): void => {
    props.onEdit({ path: ['shell'], value: localSection });
    props.onEdit({ path: ['local'], delete: true });
  };

  //M 渲染“基地”配置表单：包含开机自启开关与端口、监听地址、试跑端口、后端地址、记忆库及 RAG 目录。
  return (
    <div className="jm-section">
      <div className="jm-sc-shell-source">
        <antd.Tag>{sourceTag}</antd.Tag>
        {onlyLocal && (
          <antd.Button size="small" onClick={migrate}>
            {t('整段迁到 shell.*')}
          </antd.Button>
        )}
      </div>
      <AutostartSwitch />
      <fields.NumberField
        label={t('基地的端口 shell.port')}
        hint={t('壳子的 HTTP 接口，默认 30085；后端 base-bridge 插件的 index_url 指到这里')}
        min={1}
        max={65535}
        placeholder="30085"
        draft={props.draft}
        path={[writeRoot, 'port']}
        fallbackPath={[fallbackRoot, 'port']}
        onEdit={props.onEdit}
      />
      <fields.TextField
        label={t('壳子监听地址 shell.host')}
        hint={t('默认 0.0.0.0；仅本机调试可写 127.0.0.1')}
        placeholder="0.0.0.0"
        draft={props.draft}
        path={[writeRoot, 'host']}
        fallbackPath={[fallbackRoot, 'host']}
        onEdit={props.onEdit}
      />
      <fields.NumberField
        label={t('更新试跑端口 shell.trial_port')}
        hint={t('平滑换版试跑新后端时使用的端口；留空则从主端口 +1 往后自动寻找空闲端口')}
        min={1}
        max={65535}
        placeholder={t('自动分配（如 30089）')}
        draft={props.draft}
        path={[writeRoot, 'trial_port']}
        fallbackPath={[fallbackRoot, 'trial_port']}
        onEdit={props.onEdit}
      />
      <fields.TextField
        label={t('窗口打开哪个后端 shell.server')}
        hint={t('不写就是本机的 server.port；后端在别的机器上时填它的地址')}
        placeholder={t('如 http://192.168.1.5:30086')}
        draft={props.draft}
        path={[writeRoot, 'server']}
        fallbackPath={[fallbackRoot, 'server']}
        onEdit={props.onEdit}
      />
      <fields.TextField
        label={t('记忆库目录 shell.libs')}
        hint={t('相对运行时目录；下面每个子目录一个 index.db，子目录名是库名（默认 data/index/libs）')}
        draft={props.draft}
        path={[writeRoot, 'libs']}
        fallbackPath={[fallbackRoot, 'libs']}
        onEdit={props.onEdit}
      />
      <fields.TextField
        label={t('RAG 目录 shell.rag')}
        hint={t('RAG 索引放哪，相对运行时目录（默认 data/index/rag）')}
        draft={props.draft}
        path={[writeRoot, 'rag']}
        fallbackPath={[fallbackRoot, 'rag']}
        onEdit={props.onEdit}
      />
    </div>
  );
}


//==========================================================
// Phase 2：插件配置表单（转话与群策略、FRPC 目录、可信目录、记忆收录召回与回填）
//==========================================================


/**
 * config.yaml 的 plugins 里登记了这个插件没有。
 * 后端只给登记了的插件回一项（src7/plugins/settings/ConfigFile.ts 的 getEditablePlugins），没写字段的也回空的 config。
 * @param draft 草稿。
 * @param plugin 插件名。
 * @returns 登记了是 true。
 */
function isPluginListed(draft: unknown, plugin: string): boolean {
  const entry = editsModule.getAt(draft, ['plugins', plugin]);
  return isPlainRecord(entry);
}


/**
 * 插件没登记时的提示：不给输入框，免得改了保存时报错。
 * @param props 插件名。
 */
function PluginMissing(props: { plugin: string }): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于提示文字。
  const t = i18n.useT();
  return (
    <antd.Alert
      type="info"
      showIcon
      message={t('config.yaml 的 plugins 里还没登记 {name} 插件', { name: props.plugin })}
      description={t('先在 plugins 里加上它（写法见 config.example.yaml），重启后再来这里改')}
    />
  );
}


/**
 * 一组字符串变成下拉选项（值和显示一样）。
 * @param names 名字列表。
 */
function getNameOptions(names: string[]): { value: string; label: string }[] {
  return names.map((name) => ({ value: name, label: name }));
}


/**
 * 草稿里机器人的名字（直通规则的 bot 下拉用）。
 * @param draft 草稿。
 */
function getBotNames(draft: unknown): string[] {
  const bots = editsModule.getAt(draft, ['bots']);
  if (!Array.isArray(bots)) return [];

  const names: string[] = [];
  for (const bot of bots) {
    const botName = editsModule.getAt(bot, ['name']);
    if (typeof botName === 'string' && botName !== '') {
      names.push(botName);
    }
  }
  return names;
}


/**
 * relay 已登记的外部助手名字：后端只给名字（webhook 等凭据不给），见 ConfigFile.ts 的 PluginView.helpers。
 * @param draft 草稿。
 */
function getHelperNames(draft: unknown): string[] {
  const helpers = editsModule.getAt(draft, ['plugins', 'relay', 'helpers']);
  if (!Array.isArray(helpers)) return [];

  return helpers.filter((item): item is string => typeof item === 'string');
}


/** 飞书群的监听方式（照 src7/plugins/feishu/Config.ts 的 getGroups）。 */
const GROUP_LISTENS = [
  { value: 'mention', label: 'mention：只收 @ 机器人的' },
  { value: 'all', label: 'all：不 @ 也收，只记不回' },
  { value: 'judge', label: 'judge：不 @ 也收，记完问决策模型要不要接话' },
];


/**
 * 飞书群策略卡片：每个已登记的群一张，改监听方式和受不受信。
 * 只改这两项，同群的 relay、judge_threshold、daily 等后端原样留着；新群要先在 config.yaml 里登记 chat_id。
 * @param props 草稿和改动回调。
 */
function FeishuGroups(props: { draft: unknown; onEdit: (edit: editsModule.Edit) => void }): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于卡片文字和监听方式选项。
  const t = i18n.useT();
  const groupsPath = editsModule.PLUGIN_PATHS.feishuGroups;
  const groups = editsModule.getAt(props.draft, groupsPath);
  let chatIds: string[] = [];
  if (isPlainRecord(groups)) {
    chatIds = Object.keys(groups);
  }

  //G 还没登记群：说清怎么加。
  if (chatIds.length === 0) {
    return <div className="jm-muted">{t('feishu 插件的 groups 里还没登记群；新群先在 config.yaml 里写上 chat_id')}</div>;
  }

  const listenOptions = GROUP_LISTENS.map((option) => ({ value: option.value, label: t(option.label) }));

  //M 每个群一张卡片：群名和群号，下面是监听方式和受信开关。
  return (
    <div className="jm-sc-feishu-groups">
      {chatIds.map((chatId) => {
        const groupName = editsModule.getAt(groups, [chatId, 'name']);
        let title = chatId;
        if (typeof groupName === 'string' && groupName !== '') {
          title = groupName;
        }
        return (
          <div key={chatId} className="jm-sc-feishu-group">
            <div className="jm-sc-feishu-group-head">
              <strong>{title}</strong>
              <span className="jm-sc-mono jm-muted">{chatId}</span>
            </div>
            <fields.SelectField
              label={t('监听方式 listen')}
              hint={t('清空回默认：写了 daily 日报的群是 all，别的是 mention')}
              options={listenOptions}
              draft={props.draft}
              path={[...groupsPath, chatId, 'listen']}
              onEdit={props.onEdit}
            />
            <fields.BoolField
              label={t('受信 trusted')}
              hint={t('开了以后本人在这个群里说话照旧带私人记忆；群里的回复大家都看得到，默认关')}
              fallback={false}
              draft={props.draft}
              path={[...groupsPath, chatId, 'trusted']}
              onEdit={props.onEdit}
            />
          </div>
        );
      })}
    </div>
  );
}


/**
 * 转话与飞书群策略：relay 的催促、过期和三张免前缀直通规则表，feishu 各群的监听方式和受不受信。
 * 规则表的 helper 只能选 relay 已登记的外部助手；helpers 本身（带 webhook 凭据）不在这里改。改了要重启才生效。
 * @param props 草稿、改动回调与全部模型清单。
 */
export function ChannelPolicy(props: SectionProps): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于字段名称、说明和列名。
  const t = i18n.useT();
  const relayListed = isPluginListed(props.draft, 'relay');
  const feishuListed = isPluginListed(props.draft, 'feishu');

  //M 规则表的三种列：机器人、外部助手从草稿里取选项，群号手填。
  const botColumn: ColumnSpec = {
    key: 'bot',
    label: t('机器人 bot'),
    kind: 'select',
    options: getNameOptions(getBotNames(props.draft)),
  };
  const helperColumn: ColumnSpec = {
    key: 'helper',
    label: t('外部助手 helper'),
    kind: 'select',
    options: getNameOptions(getHelperNames(props.draft)),
  };
  const chatColumn: ColumnSpec = { key: 'chat_id', label: t('群号 chat_id'), kind: 'text' };

  //M 渲染两块：relay 转话（没登记就提示），飞书群策略（没登记就提示）。
  return (
    <div className="jm-section">
      <div className="jm-sc-subhead">{t('外部助手转话 relay（改了要重启才生效）')}</div>
      {!relayListed && <PluginMissing plugin="relay" />}
      {relayListed && (
        <>
          <fields.NumberField
            label={t('多久催一次 remind_minutes')}
            hint={t('转给外部助手的话过了这么多分钟还没回，提醒一次（分钟，默认 0：不催）')}
            min={0}
            draft={props.draft}
            path={editsModule.PLUGIN_PATHS.relayRemind}
            onEdit={props.onEdit}
          />
          <fields.NumberField
            label={t('多久算过期 expire_minutes')}
            hint={t('过了这么多分钟还没回就放下这件（分钟，默认 0：不过期）')}
            min={0}
            draft={props.draft}
            path={editsModule.PLUGIN_PATHS.relayExpire}
            onEdit={props.onEdit}
          />
          <ObjectListField
            label={t('本人私聊直通 owner_p2p_direct')}
            hint={t('本人私聊这个机器人、又没写别的助手前缀时，直接转给指定的外部助手；一个机器人只写一条')}
            columns={[botColumn, helperColumn]}
            blank={{}}
            whole
            draft={props.draft}
            path={editsModule.PLUGIN_PATHS.relayOwnerP2p}
            onEdit={props.onEdit}
          />
          <ObjectListField
            label={t('受信群直通 owner_group_direct')}
            hint={t('本人在这个群里对这个机器人说话，不写前缀也转给指定的外部助手；同群同机器人只写一条')}
            columns={[chatColumn, botColumn, helperColumn]}
            blank={{}}
            whole
            draft={props.draft}
            path={editsModule.PLUGIN_PATHS.relayOwnerGroup}
            onEdit={props.onEdit}
          />
          <ObjectListField
            label={t('机器人独占直通 exclusive_bots')}
            hint={t('发给这个机器人的话全部直接转给指定的外部助手，机器人自己不接；一个机器人只写一条')}
            columns={[botColumn, helperColumn]}
            blank={{}}
            whole
            draft={props.draft}
            path={editsModule.PLUGIN_PATHS.relayExclusive}
            onEdit={props.onEdit}
          />
        </>
      )}
      <div className="jm-sc-subhead">{t('飞书群策略 feishu.groups（改了要重启才生效）')}</div>
      {!feishuListed && <PluginMissing plugin="feishu" />}
      {feishuListed && <FeishuGroups draft={props.draft} onEdit={props.onEdit} />}
    </div>
  );
}


/**
 * FRPC 客户端目录：写进 plugins.frpc.config.dir，留空删掉这一项、自动定位默认目录。
 * @param props 草稿、改动回调与全部模型清单。
 */
export function FrpcConfig(props: SectionProps): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于字段名称和说明。
  const t = i18n.useT();

  //G frpc 没登记：只给提示。
  if (!isPluginListed(props.draft, 'frpc')) return <PluginMissing plugin="frpc" />;

  //M 渲染客户端目录输入框。
  return (
    <div className="jm-section">
      <fields.TextField
        label={t('客户端目录 frpc.dir')}
        hint={t('frpc.exe、frpc.toml 和托盘脚本所在的目录，绝对路径或相对运行时目录；留空自动定位 works/frp-clients/windows。改了要重启才生效')}
        placeholder={t('留空自动定位')}
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.frpcDir}
        onEdit={props.onEdit}
      />
    </div>
  );
}


/**
 * 可信目录：写进 plugins.approval.config.trusted_dirs，本人的会话在这些目录里执行免确认。
 * @param props 草稿、改动回调与全部模型清单。
 */
export function TrustedDirs(props: SectionProps): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于字段名称和说明。
  const t = i18n.useT();

  //G approval 没登记：只给提示。
  if (!isPluginListed(props.draft, 'approval')) return <PluginMissing plugin="approval" />;

  //M 渲染可信目录列表。
  return (
    <div className="jm-section">
      <fields.TextListField
        label={t('可信目录 approval.trusted_dirs')}
        hint={t('本人的会话里，执行目录和命令里写的路径都在这些目录里时不用再确认；每项写绝对路径，只对本人生效。改了要重启才生效')}
        placeholder={t('绝对路径')}
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.trustedDirs}
        onEdit={props.onEdit}
      />
    </div>
  );
}


/**
 * 记忆的收录、召回与回填：写进 plugins.memory.config（backend_token 不在这里改）。
 * @param props 草稿、改动回调与全部模型清单。
 */
export function MemoryConfig(props: SectionProps): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于字段名称和说明。
  const t = i18n.useT();

  //G memory 没登记：只给提示。
  if (!isPluginListed(props.draft, 'memory')) return <PluginMissing plugin="memory" />;

  //M 渲染收录、召回、服务地址、超时和回填几项。
  return (
    <div className="jm-section">
      <div className="jm-sc-subhead">{t('记忆插件 memory（改了要重启才生效）')}</div>
      <fields.BoolField
        label={t('收聊天记录 history')}
        hint={t('用户看得到的会话每来一条就收进记忆库的聊天记录（默认开）')}
        fallback
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.memoryHistory}
        onEdit={props.onEdit}
      />
      <fields.NumberField
        label={t('召回聊天记录条数 recall_history')}
        hint={t('每轮从聊天记录里召回几条放进上下文（默认 3，0 不召回）')}
        min={0}
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.memoryRecallHistory}
        onEdit={props.onEdit}
      />
      <fields.NumberField
        label={t('召回知识库条数 recall_knowledge')}
        hint={t('每轮从知识库里召回几段放进上下文（默认 3，0 不召回）')}
        min={0}
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.memoryRecallKnowledge}
        onEdit={props.onEdit}
      />
      <fields.TextField
        label={t('记忆服务地址 service_url')}
        hint={t('Rust 记忆服务 jmbots-memory 的 http(s) 地址；不写用默认的本机 30087，换了地址或端口才写')}
        placeholder="http://127.0.0.1:30087"
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.memoryServiceUrl}
        onEdit={props.onEdit}
      />
      <fields.NumberField
        label={t('记忆服务超时 backend_timeout_ms')}
        hint={t('调记忆服务最多等多久（毫秒，默认 8000，写 0 也按 8000）')}
        min={0}
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.memoryTimeout}
        onEdit={props.onEdit}
      />
      <fields.BoolField
        label={t('启动就回填 backfill.enabled')}
        hint={t('启动后自动把渠道归档补进记忆库；默认关，可在记忆页手动开始或暂停')}
        fallback={false}
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.memoryBackfillEnabled}
        onEdit={props.onEdit}
      />
      <fields.NumberField
        label={t('每批条数 backfill.batch_size')}
        hint={t('回填每批最多补多少条（1 到 100，默认 25）')}
        min={1}
        max={100}
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.memoryBackfillBatch}
        onEdit={props.onEdit}
      />
      <fields.NumberField
        label={t('两批间隔 backfill.interval_ms')}
        hint={t('两批回填之间至少等多久（毫秒，1 到 600000，默认 2000）')}
        min={1}
        max={600000}
        draft={props.draft}
        path={editsModule.PLUGIN_PATHS.memoryBackfillInterval}
        onEdit={props.onEdit}
      />
    </div>
  );
}
