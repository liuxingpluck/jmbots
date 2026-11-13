/**
 * 设置的各个分类（docs/界面/01_界面设计.md 第 10 节）：把 config.yaml 里的东西都做成能填的表单，说明照抄 config.example.yaml 的注释。
 * 供应商支持任意多家、任意地址，哪一家都不特殊对待；模型参数（能不能看图、上下文、最大输出、思考档、价格）在这里看得到、改得了，
 * 也能直接问供应商有哪些模型、写进 config.yaml（写进去以后以 config.yaml 为准）。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as editsModule from './Edits.ts';
import * as fields from './Fields.tsx';
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
 * 一列对象（bots、channels.feishu、search）：每项一行，能改、能加、能删、能挪顺序。
 * 改字段只改那一项的那个键；加、删、挪是整列换掉。
 * @param props 公共属性、列、新项的样子。
 */
function ObjectListField(
  props: fields.FieldProps & {
    columns: ColumnSpec[];
    blank: Record<string, unknown>;
    orderable?: boolean;
  },
): react.JSX.Element {
  const t = i18n.useT();
  /** 现在的列表。 */
  const value = editsModule.getAt(props.draft, props.path);
  const list = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  /**
   * 整列换掉。
   * @param next 新列表。
   */
  const save = (next: Record<string, unknown>[]): void =>
    props.onEdit({ path: props.path, value: next });
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
                /** 当前单元格在配置草稿中的位置。 */
                const path = [...props.path, index, column.key];
                const change: editsModule.Edit =
                  next === ''
                    ? {
                        path,
                        delete: true,
                      }
                    : {
                        path,
                        value: next,
                      };

                props.onEdit(change);
              };
              if (column.kind === 'select') {
                return (
                  <antd.Select
                    key={column.key}
                    className="jm-object-cell"
                    value={typeof cell === 'string' ? cell : undefined}
                    placeholder={column.label}
                    options={column.options}
                    onChange={(next: string) => edit(next)}
                  />
                );
              }
              return (
                <antd.Input
                  key={column.key}
                  className="jm-object-cell"
                  value={typeof cell === 'string' ? cell : ''}
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

                save(next);
              }}
            />
          </div>
        ))}
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


/** 新手写一个模型时的参数（和后端没写时的保守值一样：src/capabilities/Model.ts）。 */
const BLANK_MODEL = { context_window: 128_000, max_output_tokens: 8192, vision: false };

/** 模型目录一次最多显示多少行（多了靠筛选）。 */
const MAX_MODEL_ROWS = 60;


/** 模型目录的一行。 */
interface ModelRow {
  /** 模型 ID（不带供应商）。 */
  id: string;
  /** 参数（键名和 config.yaml 一样）。 */
  params: Record<string, unknown>;
  /** 写在 config.yaml 里的（false 是供应商清单给的）。 */
  written: boolean;
}


/**
 * 清单里的模型写进 config.yaml 的样子。
 * @param model 清单里的模型。
 */
function paramsOf(model: api.ModelInfo): Record<string, unknown> {
  return { context_window: model.contextWindow, ...(model.maxOutputTokens ? { max_output_tokens: model.maxOutputTokens } : {}), vision: model.vision === true, thinking: model.thinking, price: model.price };
}


/**
 * 一个值是数字就用，不是就当没写。
 * @param value 值。
 */
function numberOf(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}


/**
 * 一家供应商的模型目录：每个模型一行（上下文、最大输出、能不能看图、思考档、价格）。
 * 手写的优先；清单给的改了哪一项，就把这个模型整个写进 config.yaml。“获取可用模型”直接问供应商，用还没保存的地址和密钥。
 * @param props 草稿、改动、全部模型、供应商名。
 */
function ProviderModels(props: SectionProps & { provider: string }): react.JSX.Element {
  const t = i18n.useT();
  /** 路径。 */
  const base: editsModule.Path = ['providers', props.provider, 'models'];
  /** 手写的。 */
  const own = editsModule.getAt(props.draft, base);
  const written = own && typeof own === 'object' && !Array.isArray(own) ? (own as Record<string, Record<string, unknown>>) : {};
  /** 模型 ID 的开头。 */
  const prefix = `${props.provider}/`;
  /** 刚取到的；弹窗开着时不是 null。 */
  const [fetched, setFetched] = react.useState<api.ModelInfo[] | null>(null);
  /** 取的过程、勾了哪些、筛选、要手写的、提示。 */
  const [fetching, setFetching] = react.useState(false);
  const [picked, setPicked] = react.useState<string[]>([]);
  const [filter, setFilter] = react.useState('');
  const [adding, setAdding] = react.useState('');
  const [notice, setNotice] = react.useState('');
  /** 全部模型：手写的在前，清单给的在后。 */
  const rows: ModelRow[] = [
    ...Object.entries(written).map(([id, params]) => ({ id, params, written: true })),
    ...props.models
      .filter((model) => model.kind === 'chat' && model.id.startsWith(prefix) && !(model.id.slice(prefix.length) in written))
      .map((model) => ({ id: model.id.slice(prefix.length), params: paramsOf(model), written: false })),
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
    const step: editsModule.Edit = value === undefined ? { path: key, delete: true } : { path: key, value };
    if (row.written) {
      props.onEdit('delete' in step ? { path: [...base, row.id, ...key], delete: true } : { path: [...base, row.id, ...key], value });
    } else {
      props.onEdit({ path: [...base, row.id], value: editsModule.applyEdit(row.params, step) });
    }
  };
  /** 问供应商有哪些模型。 */
  const fetchModels = (): void => {
    setFetching(true);
    setNotice('');
    /** 文字配置。 */
    const textAt = (key: string): string => {
      /** 这一项。 */
      const value = editsModule.getAt(props.draft, ['providers', props.provider, key]);
      return typeof value === 'string' ? value : '';
    };
    void api.providerModels({ provider: props.provider, base_url: textAt('base_url'), api_key: textAt('api_key'), api: textAt('api') }).then(
      (result) => {
        setFetching(false);
        /** 还没写进 config.yaml 的。 */
        const fresh = result.models.filter((model) => model.kind === 'chat' && !(model.id.slice(prefix.length) in written));
        setPicked(fresh.map((model) => model.id));
        setFetched(fresh);
        setNotice(t('这家一共 {count} 个模型', { count: result.models.length }));
      },
      (error: unknown) => {
        setFetching(false);
        setNotice(t('没取到：{reason}', { reason: error instanceof Error ? error.message : String(error) }));
      },
    );
  };
  return (
    <div className="jm-provider-models">
      <div className="jm-provider-models-head">
        <strong>{t('模型目录')}</strong>
        <span className="jm-muted">{t('手写的优先；清单只给 ID 时，没写的用保守值（上下文 128000、最大输出 8192、看不了图）')}</span>
        <antd.Button size="small" icon={<icons.CloudDownloadOutlined />} loading={fetching} onClick={fetchModels}>
          {t('获取可用模型')}
        </antd.Button>
      </div>
      {notice && <div className="jm-muted">{notice}</div>}
      <div className="jm-model-tools">
        <antd.Input size="small" allowClear placeholder={t('筛选（共 {count} 个）', { count: rows.length })} value={filter} onChange={(event) => setFilter(event.target.value)} />
        <antd.Space.Compact size="small">
          <antd.Input placeholder={t('手写一个模型 ID')} value={adding} onChange={(event) => setAdding(event.target.value.trim())} />
          <antd.Button
            icon={<icons.PlusOutlined />}
            disabled={!adding || adding in written}
            onClick={() => {
              props.onEdit({ path: [...base, adding], value: { ...BLANK_MODEL } });
              setAdding('');
            }}
          >
            {t('加')}
          </antd.Button>
        </antd.Space.Compact>
      </div>
      {shown.length > 0 && (
        <div className="jm-models-scroll">
          <table className="jm-models-table">
            <thead>
              <tr>
                <th>{t('模型')}</th>
                <th>{t('上下文')}</th>
                <th>{t('最大输出')}</th>
                <th>{t('看图')}</th>
                <th>{t('思考档')}</th>
                <th>{t('价格（入 / 出，美元每百万）')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, MAX_MODEL_ROWS).map((row) => {
                /** 价格。 */
                const price = (row.params.price ?? {}) as { input?: unknown; output?: unknown };
                return (
                  <tr key={row.id}>
                    <td className="jm-models-id" title={row.id}>
                      {row.id}
                      {!row.written && <antd.Tag className="jm-models-tag">{t('清单')}</antd.Tag>}
                    </td>
                    <td>
                      <antd.InputNumber size="small" min={1} value={numberOf(row.params.context_window)} onChange={(next) => set(row, ['context_window'], next ?? undefined)} />
                    </td>
                    <td>
                      <antd.InputNumber size="small" min={1} value={numberOf(row.params.max_output_tokens)} onChange={(next) => set(row, ['max_output_tokens'], next ?? undefined)} />
                    </td>
                    <td>
                      <antd.Switch size="small" checked={row.params.vision === true} onChange={(checked) => set(row, ['vision'], checked)} />
                    </td>
                    <td>
                      <antd.Select size="small" mode="multiple" className="jm-models-thinking" value={Array.isArray(row.params.thinking) ? (row.params.thinking as string[]) : []} options={THINKING} onChange={(next: string[]) => set(row, ['thinking'], next.length > 0 ? next : undefined)} />
                    </td>
                    <td className="jm-models-price">
                      <antd.InputNumber size="small" min={0} step={0.01} value={numberOf(price.input)} onChange={(next) => set(row, ['price', 'input'], next ?? undefined)} />
                      <antd.InputNumber size="small" min={0} step={0.01} value={numberOf(price.output)} onChange={(next) => set(row, ['price', 'output'], next ?? undefined)} />
                    </td>
                    <td>
                      {row.written && <antd.Button size="small" type="text" danger icon={<icons.DeleteOutlined />} aria-label={t('删掉 {name} 的手写参数', { name: row.id })} onClick={() => props.onEdit({ path: [...base, row.id], delete: true })} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {shown.length > MAX_MODEL_ROWS && <div className="jm-muted">{t('还有 {count} 个没显示，筛选一下', { count: shown.length - MAX_MODEL_ROWS })}</div>}
      <antd.Modal
        open={fetched !== null}
        title={t('{name} 有这些模型还没写进 config.yaml', { name: props.provider })}
        okText={t('写进 config.yaml（{count} 个）', { count: picked.length })}
        cancelText={t('不要了')}
        onCancel={() => setFetched(null)}
        onOk={() => {
          for (const model of (fetched ?? []).filter((item) => picked.includes(item.id))) {
            props.onEdit({ path: [...base, model.id.slice(prefix.length)], value: paramsOf(model) });
          }
          setFetched(null);
        }}
      >
        <p className="jm-muted">{t('写进去以后以 config.yaml 为准，改上下文就是改那一行。不写进去也能用，用的是清单给的值。')}</p>
        {fetched?.length === 0 && <p>{t('都写过了。')}</p>}
        <antd.Checkbox.Group className="jm-pull-list" value={picked} onChange={(next) => setPicked(next)}>
          {(fetched ?? []).map((model) => (
            <antd.Checkbox key={model.id} value={model.id}>
              {t('{id} · 上下文 {context} · 最大输出 {output} · {vision}', { id: model.id.slice(prefix.length), context: model.contextWindow, output: model.maxOutputTokens ?? '?', vision: model.vision ? t('看图') : t('不看图') })}
            </antd.Checkbox>
          ))}
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
  const t = i18n.useT();
  /**
   * 这一家某一项的路径。
   * @param key 键。
   */
  const at = (key: string): editsModule.Path => ['providers', props.name, key];
  return (
    <div className="jm-provider-form">
      <header className="jm-provider-head">
        <strong>{props.name}</strong>
        <antd.Popconfirm title={t('删掉供应商 {name}？', { name: props.name })} okText={t('删掉')} cancelText={t('不删')} onConfirm={() => props.onEdit({ path: ['providers', props.name], delete: true })}>
          <antd.Button size="small" type="text" danger icon={<icons.DeleteOutlined />}>
            {t('删掉')}
          </antd.Button>
        </antd.Popconfirm>
      </header>
      <fields.TextField label={t('API 密钥 api_key')} hint={t('本地不要密钥的服务可以不写')} draft={props.draft} path={at('api_key')} onEdit={props.onEdit} />
      <fields.TextField label={t('API 地址 base_url')} hint={t('如 https://api.deepseek.com/v1；本地的服务写本机地址')} draft={props.draft} path={at('base_url')} onEdit={props.onEdit} />
      <fields.SelectField label={t('API 协议 api')} options={APIS} placeholder={t('openai-completions（默认）')} draft={props.draft} path={at('api')} onEdit={props.onEdit} />
      <fields.BoolField label={t('启动时拉模型清单 list_models')} hint={t('启动时向 <base_url>/models 拉清单（默认开）；没有清单接口就关掉，只用手写的')} fallback draft={props.draft} path={at('list_models')} onEdit={props.onEdit} />
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
                <fields.JsonField label={t('兼容设置 compat')} hint={t('发请求时的兼容设置，原样交给 Pi（OpenAICompletionsCompat），如 { "maxTokensField": "max_tokens" }')} draft={props.draft} path={at('compat')} onEdit={props.onEdit} />
                <fields.JsonField label={t('个别模型的兼容 model_compat')} hint={t('模型 ID → 再加的兼容设置，如 DeepSeek 思考模式下调工具要带回上一步的思考')} draft={props.draft} path={at('model_compat')} onEdit={props.onEdit} />
              </>
            ),
          },
        ]}
      />
    </div>
  );
}


/** 模型供应商：左边选一家（或加一家），右边配它和它的模型。任意多家，哪一家都不特殊对待。 */
export function Providers(props: SectionProps): react.JSX.Element {
  const t = i18n.useT();
  /** 全部供应商。 */
  const names = fields.providerNames(props.draft);
  /** 判断改过没有。 */
  const isChanged = react.useContext(fields.ChangedContext);
  /** 选的那一家、要加的那一家的名字。 */
  const [selected, setSelected] = react.useState('');
  const [adding, setAdding] = react.useState('');
  /** 现在看的那一家。 */
  const current = names.includes(selected) ? selected : names[0];
  return (
    <div className="jm-providers">
      <nav className="jm-provider-list">
        {names.map((name) => (
          <button key={name} type="button" className={name === current ? 'jm-settings-cat jm-active' : 'jm-settings-cat'} onClick={() => setSelected(name)}>
            <span>{name}</span>
            {isChanged(['providers', name]) && <span className="jm-settings-dot" title={t('改过，还没保存')} />}
          </button>
        ))}
        <antd.Space.Compact className="jm-provider-add">
          <antd.Input value={adding} placeholder={t('新供应商的名字')} onChange={(event) => setAdding(event.target.value.trim())} />
          <antd.Button
            icon={<icons.PlusOutlined />}
            aria-label={t('添加供应商')}
            disabled={!adding || names.includes(adding)}
            onClick={() => {
              props.onEdit({ path: ['providers', adding], value: { base_url: '', api: 'openai-completions', list_models: true } });
              setSelected(adding);
              setAdding('');
            }}
          />
        </antd.Space.Compact>
      </nav>
      {current ? <ProviderForm key={current} {...props} name={current} /> : <div className="jm-muted">{t('还没有供应商：在左边加一家')}</div>}
    </div>
  );
}


/** 模型：默认模型、决策模型、备用链、看图的模型。 */
export function Models(props: SectionProps): react.JSX.Element {
  const t = i18n.useT();
  return (
    <div className="jm-section">
      <fields.ModelField label={t('默认模型 default_model')} hint={t('新开会话和 exec 审核的小循环用它。写成“供应商/模型 ID”。会话要换模型在会话页换')} models={props.models} kind="chat" draft={props.draft} path={['default_model']} onEdit={props.onEdit} />
      <fields.ModelField label={t('决策模型 models.decision')} hint={t('分派、压缩、exec 审核先问它（只回每个选项的概率）；可以不配')} models={props.models} kind="decision" draft={props.draft} path={['models', 'decision', 'model']} onEdit={props.onEdit} />
      <fields.ModelListField label={t('备用链 engine.fallback_chain')} hint={t('模型被限流时依次换着试（能调顺序）')} models={props.models} draft={props.draft} path={['engine', 'fallback_chain']} onEdit={props.onEdit} />
      <fields.NumberField label={t('最多再试几个 engine.fallback_max_tries')} hint={t('被限流后最多再试几个模型（默认 5）')} min={0} draft={props.draft} path={['engine', 'fallback_max_tries']} onEdit={props.onEdit} />
      <fields.ModelField label={t('看图的模型 engine.vision_model')} hint={t('看不了图的模型读到图片时，先交给它转成文字；不写就不转')} models={props.models} needVision kind="chat" draft={props.draft} path={['engine', 'vision_model']} onEdit={props.onEdit} />
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
function FeishuRow(props: { index: number; app: FeishuApp; onEdit: (edit: editsModule.Edit) => void; onDelete: () => void; bots?: { value: string; label: string }[] }): react.JSX.Element {
  const t = i18n.useT();
  /**
   * 改一个键。
   * @param key 键。
   * @param value 新值。
   */
  const set = (key: string, value: string): void => props.onEdit({ path: ['channels', 'feishu', props.index, key], value });
  return (
    <div className="jm-object-row">
      <antd.Input className="jm-object-cell" placeholder="app_id" value={typeof props.app.app_id === 'string' ? props.app.app_id : ''} onChange={(event) => set('app_id', event.target.value)} />
      <antd.Input className="jm-object-cell" placeholder="app_secret" value={typeof props.app.app_secret === 'string' ? props.app.app_secret : ''} onChange={(event) => set('app_secret', event.target.value)} />
      {props.bots && <antd.Select className="jm-object-cell" placeholder={t('对应的机器人')} value={typeof props.app.bot === 'string' ? props.app.bot : undefined} options={props.bots} onChange={(next: string) => set('bot', next)} />}
      <antd.Button size="small" type="text" danger icon={<icons.DeleteOutlined />} aria-label={t('删掉这个飞书应用')} onClick={props.onDelete} />
    </div>
  );
}


/**
 * 机器人：有几个列几个（运行时 bots/ 下的文件夹和 config.yaml 的 bots 合起来），每个的语言和它的渠道都在它下面。
 * 渠道跟机器人绑在一起：飞书应用写在 config.yaml 的 channels.feishu，每项记着对应哪个机器人。
 */
export function Bots(props: SectionProps): react.JSX.Element {
  const t = i18n.useT();
  /** 后端认的机器人。 */
  const live = context.useUi((state) => state.bots);
  /** config.yaml 里写的。 */
  const written = editsModule.getAt(props.draft, ['bots']);
  /** 全部机器人：名字 → 语言。 */
  const all = new Map<string, string>(live.map((bot) => [bot.name, bot.language]));
  for (const bot of Array.isArray(written) ? (written as { name?: unknown; language?: unknown }[]) : []) {
    if (typeof bot.name === 'string' && bot.name) {
      all.set(bot.name, typeof bot.language === 'string' ? bot.language : (all.get(bot.name) ?? 'zh'));
    }
  }
  /** 飞书应用。 */
  const feishu = editsModule.getAt(props.draft, ['channels', 'feishu']);
  const apps = Array.isArray(feishu) ? (feishu as FeishuApp[]) : [];
  /** 要加的机器人的名字。 */
  const [adding, setAdding] = react.useState('');
  /**
   * 把机器人的名单整个写进 config.yaml。
   * @param next 新名单。
   */
  const saveBots = (next: Map<string, string>): void => props.onEdit({ path: ['bots'], value: [...next].map(([name, language]) => ({ name, language })) });
  /**
   * 整列换掉飞书应用。
   * @param next 新列表。
   */
  const saveApps = (next: FeishuApp[]): void => props.onEdit({ path: ['channels', 'feishu'], value: next });
  /** 没绑到现有机器人的飞书应用。 */
  const loose = apps.flatMap((app, index) => (typeof app.bot === 'string' && all.has(app.bot) ? [] : [{ app, index }]));
  return (
    <div className="jm-section">
      {[...all].map(([name, language]) => (
        <antd.Card key={name} size="small" className="jm-provider" title={name}>
          <fields.Row label={t('语言')} hint={t('选提示词用哪种语言')} path={['bots']}>
            <antd.Select className="jm-field-select" value={language} options={LANGUAGES} onChange={(next: string) => saveBots(new Map(all).set(name, next))} />
          </fields.Row>
          <fields.Row label={t('飞书应用')} hint={t('这个机器人接哪几个飞书应用；回复从收到消息的那个应用发回去')} path={['channels', 'feishu']}>
            <div className="jm-objects">
              {apps.map((app, index) => (app.bot === name ? <FeishuRow key={index} index={index} app={app} onEdit={props.onEdit} onDelete={() => saveApps(apps.filter((_, at) => at !== index))} /> : null))}
              <antd.Button className="jm-list-add" icon={<icons.PlusOutlined />} onClick={() => saveApps([...apps, { app_id: '', app_secret: '', bot: name }])}>
                {t('加一个飞书应用')}
              </antd.Button>
            </div>
          </fields.Row>
        </antd.Card>
      ))}
      {loose.length > 0 && (
        <antd.Card size="small" className="jm-provider" title={t('没绑机器人的飞书应用')}>
          <div className="jm-objects">
            {loose.map(({ app, index }) => (
              <FeishuRow key={index} index={index} app={app} onEdit={props.onEdit} onDelete={() => saveApps(apps.filter((_, at) => at !== index))} bots={[...all.keys()].map((name) => ({ value: name, label: name }))} />
            ))}
          </div>
        </antd.Card>
      )}
      <fields.Row label={t('加一个机器人')} hint={t('名字可以是中文，就是运行时 bots/ 下的文件夹名；保存、重启后生效。直接往 bots/ 里放一个文件夹，重启后也会出现')}>
        <antd.Space.Compact>
          <antd.Input value={adding} placeholder={t('名字')} onChange={(event) => setAdding(event.target.value.trim())} />
          <antd.Button
            icon={<icons.PlusOutlined />}
            disabled={!adding || all.has(adding)}
            onClick={() => {
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


/** 搜索：web_search 工具按顺序试。 */
export function Search(props: SectionProps): react.JSX.Element {
  const t = i18n.useT();
  /** 配了的供应商：magpie 种类从哪一家借地址和密钥。 */
  const providers = editsModule.getAt(props.draft, ['providers']);
  /** 供应商下拉的选项。 */
  const providerOptions = Object.keys(providers !== null && typeof providers === 'object' ? providers : {}).map((name) => ({ value: name, label: name }));
  return (
    <div className="jm-section">
      <ObjectListField
        label={t('网页搜索 search')}
        hint={t('按顺序试，前一个出错或搜不到就用下一个；一个都不写就不能搜网页。magpie：Magpie 网关的搜索接口，供应商选用“模型供应商”里哪一家的地址和密钥，model 写网关里的模型 ID；zhipu_mcp：智谱 MCP 搜索，api_key 填智谱的密钥')}
        columns={[
          { key: 'kind', label: t('方式'), kind: 'select', options: [{ value: 'magpie', label: 'magpie' }, { value: 'zhipu_mcp', label: 'zhipu_mcp' }] },
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


/** 引擎。 */
export function Engine(props: SectionProps): react.JSX.Element {
  const t = i18n.useT();
  return (
    <div className="jm-section">
      <fields.NumberField label={t('轮询 poll_ms')} hint={t('机器人循环多久看一次新消息（毫秒，默认 300）')} min={10} draft={props.draft} path={['engine', 'poll_ms']} onEdit={props.onEdit} />
      <fields.NumberField label={t('最多步数 max_rounds')} hint={t('一次运行最多多少步（调多少次模型，默认 300）')} min={1} draft={props.draft} path={['engine', 'max_rounds']} onEdit={props.onEdit} />
      <fields.NumberField label={t('压缩 compress_at')} hint={t('上下文到多少 token 就考虑压缩（模型上限不到 250K 时用上限的 80%，默认 200000）')} min={1000} step={1000} draft={props.draft} path={['engine', 'compress_at']} onEdit={props.onEdit} />
      <fields.NumberField label={t('审核门槛 exec_pass')} hint={t('exec 审核：决策模型给的“安全”概率不低于它就直接执行（默认 0.2）')} min={0} max={1} step={0.05} draft={props.draft} path={['engine', 'exec_pass']} onEdit={props.onEdit} />
      <fields.TextField label={t('记忆搜索 index_url')} hint={t('基地（取代 memorycli 服务）的地址，记忆搜索用；不写就只按关键字找')} placeholder={t('如 http://127.0.0.1:30090')} draft={props.draft} path={['engine', 'index_url']} onEdit={props.onEdit} />
      <fields.TextField label={t('生图模型 image_model')} hint={t('写成“供应商/模型 ID”（供应商是“模型供应商”里配的名字）；机器人的 image_generate 工具用它，不写就没有生图')} placeholder={t('供应商/模型 ID')} draft={props.draft} path={['engine', 'image_model']} onEdit={props.onEdit} />
      <fields.TextField label={t('收尾模型 wrapup_model')} hint={t('限时到点时写收尾总结的模型，不带工具、最低思考档；不写就用会话自己的模型')} placeholder={t('供应商/模型 ID')} draft={props.draft} path={['engine', 'wrapup_model']} onEdit={props.onEdit} />
      <fields.TextField label={t('记忆库 memory_libs')} hint={t('memory 工具还搜基地里的哪些库，逗号连着写；不写就不搜')} placeholder={t('如 memory,aiskills')} draft={props.draft} path={['engine', 'memory_libs']} onEdit={props.onEdit} />
      <fields.NumberListField label={t('重试间隔 retry_delays_ms')} hint={t('连接出错时同一个模型隔多久重试（毫秒，默认 2000, 5000）')} draft={props.draft} path={['engine', 'retry_delays_ms']} onEdit={props.onEdit} />
      <fields.BoolField label={t('试同家别的模型 fallback_include_siblings')} hint={t('备用链用完后，要不要接着试同一个供应商里不收费的其他模型（默认要）')} fallback draft={props.draft} path={['engine', 'fallback_include_siblings']} onEdit={props.onEdit} />
    </div>
  );
}


/** 并发。 */
export function Concurrency(props: SectionProps): react.JSX.Element {
  const t = i18n.useT();
  return (
    <div className="jm-section">
      <fields.NumberField label={t('每个模型 default')} hint={t('同一时间每个模型默认最多几个调用，超了排队（不报错，默认 3）')} min={1} draft={props.draft} path={['concurrency', 'default']} onEdit={props.onEdit} />
      <fields.NumberMapField label={t('单独设的模型 models')} hint={t('“供应商/模型 ID” → 上限')} keyPlaceholder={t('供应商/模型 ID')} draft={props.draft} path={['concurrency', 'models']} onEdit={props.onEdit} />
      <fields.NumberMapField label={t('供应商合计 providers')} hint={t('供应商名 → 它所有模型加起来最多几个；不写不限')} keyPlaceholder={t('供应商名')} draft={props.draft} path={['concurrency', 'providers']} onEdit={props.onEdit} />
    </div>
  );
}


/** 服务。 */
export function Http(props: SectionProps): react.JSX.Element {
  const t = i18n.useT();
  return (
    <div className="jm-section">
      <fields.NumberField label={t('端口 server.port')} hint={t('一律监听 0.0.0.0（换版本时的试运行也一样）')} min={1} max={65535} draft={props.draft} path={['server', 'port']} onEdit={props.onEdit} />
      <fields.TextField label={t('token server.token')} hint={t('老的单个 token，照样认、当成永久的；以后用下面的“访问令牌”，可以建多个')} draft={props.draft} path={['server', 'token']} onEdit={props.onEdit} />
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
    void api.tokens().then(
      (next) => {
        setList(next);
        setError('');
      },
      (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, []);
  react.useEffect(load, [load]);
  /**
   * 做一件事，做完重取。
   * @param work 要做的事。
   */
  const run = (work: Promise<unknown>): void => {
    void work.then(load, (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  /** 接入说明的地址（别的 AI 要把前面换成这台电脑的局域网地址）。 */
  const guide = `${window.location.origin}/api/agents/guide`;
  return (
    <fields.Row label={t('访问令牌')} hint={t('所有请求都要带令牌（网址后面 ?token=，或请求头 Authorization: Bearer）。接入说明：{url}?token=…（把前面换成这台电脑的局域网地址，token 换成有效令牌）', { url: guide })}>
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
          } else if (token.expiresAt !== undefined) {
            kind = t('临时 {minutes} 分钟，{time} 到期', { minutes: token.minutes ?? 0, time: timeline.formatTime(token.expiresAt) });
          }
          return (
            <div key={token.id} className={expired ? 'jm-token jm-token-expired' : 'jm-token'}>
              <span className="jm-token-name">{token.name}</span>
              <antd.Typography.Text className="jm-token-value" copyable={{ text: token.value }}>{token.value}</antd.Typography.Text>
              <span className="jm-muted">
                {kind}
                {' · '}
                {token.usedAt ? t('最近用：{time}', { time: timeline.formatTime(token.usedAt) }) : t('还没用过')}
              </span>
              <antd.Popconfirm title={t('换一个新值？旧的马上失效，用它的 AI 要换成新的')} okText={t('换')} cancelText={t('不换')} onConfirm={() => run(api.refreshToken(token.id))}>
                <antd.Button size="small">{t('刷新')}</antd.Button>
              </antd.Popconfirm>
              <antd.Popconfirm title={t('删掉 {name} 的令牌？用它的 AI 马上进不来', { name: token.name })} okText={t('删掉')} cancelText={t('不删')} onConfirm={() => run(api.deleteToken(token.id))}>
                <antd.Button size="small" danger>{t('删除')}</antd.Button>
              </antd.Popconfirm>
            </div>
          );
        })}
        {list && (
          <antd.Space.Compact className="jm-token-new">
            <antd.Input size="small" placeholder={t('给谁用的，比如 grokbots')} value={name} onChange={(event) => setName(event.target.value)} />
            <antd.Select
              size="small"
              value={minutes}
              onChange={setMinutes}
              options={[{ value: 0, label: t('永久') }, ...TOKEN_MINUTES.map((value) => ({ value, label: t('临时 {minutes} 分钟', { minutes: value }) }))]}
            />
            <antd.Button
              size="small"
              type="primary"
              disabled={!name.trim()}
              onClick={() => {
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


/** 开机自启的开关：拨一下马上生效，不写进 config.yaml（基地在“启动”文件夹放一个快捷方式）。基地没开、是老版本时不显示。 */
function AutostartSwitch(): react.JSX.Element | null {
  const t = i18n.useT();
  /** 开着没有；还不知道是 null。 */
  const [enabled, setEnabled] = react.useState<boolean | null>(null);
  /** 正在改。 */
  const [saving, setSaving] = react.useState(false);
  /** 改失败的原因。 */
  const [error, setError] = react.useState('');

  react.useEffect(() => {
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
        (info) => setEnabled(info.enabled),
        (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setSaving(false));
  };
  return (
    <fields.Row label={t('开机自启')} hint={error || t('登录 Windows 时自动起基地和后端，只有托盘，不开窗口')}>
      <antd.Switch checked={enabled} loading={saving} onChange={change} />
    </fields.Row>
  );
}


/** 基地（Rust 写的本地程序 jmbots.exe）。 */
export function Local(props: SectionProps): react.JSX.Element {
  const t = i18n.useT();
  return (
    <div className="jm-section">
      <AutostartSwitch />
      <fields.NumberField label={t('基地的端口 local.port')} hint={t('基地的 HTTP 接口（记忆搜索、RAG），一律监听 0.0.0.0；后端的 engine.index_url 指到这里（默认 30090）')} min={1} max={65535} draft={props.draft} path={['local', 'port']} onEdit={props.onEdit} />
      <fields.TextField label={t('窗口打开哪个后端 local.server')} hint={t('不写就是本机的 http.port；后端在别的机器上时填它的地址')} placeholder={t('如 http://192.168.1.5:30086')} draft={props.draft} path={['local', 'server']} onEdit={props.onEdit} />
      <fields.TextField label={t('记忆库目录 local.libs')} hint={t('相对运行时目录；下面每个子目录一个 index.db，子目录名是库名（默认 data/index/libs）')} draft={props.draft} path={['local', 'libs']} onEdit={props.onEdit} />
      <fields.TextField label={t('RAG 目录 local.rag')} hint={t('RAG 索引放哪，相对运行时目录（默认 data/index/rag）')} draft={props.draft} path={['local', 'rag']} onEdit={props.onEdit} />
    </div>
  );
}
