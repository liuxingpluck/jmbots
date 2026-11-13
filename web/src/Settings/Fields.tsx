/**
 * 设置页的各种输入项（docs/界面/01_界面设计.md 第 10 节）：每项都读草稿里某个路径上的值，改了就发一步改动（Edits.ts）。
 * 每项下面一句中文说明（照抄 config.example.yaml 的注释）。密钥和别的值一样明文显示、直接改（用户 11-05 定）。改过还没保存的项，名字变红。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as editsModule from './Edits.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import type * as api from '../Api.ts';


/** 判断某个路径改过没有（Settings.tsx 提供，Row 用它把名字变红）。 */
export const ChangedContext = react.createContext<(path: editsModule.Path) => boolean>(() => false);


/** 供应商下拉里“添加供应商”这一项的值。 */
const ADD_PROVIDER = '__add_provider__';


/** 每个输入项都有的属性。 */
export interface FieldProps {
  /** 名字。 */
  label: string;
  /** 一句话说明。 */
  hint?: string;
  /** 草稿。 */
  draft: unknown;
  /** 在 config.yaml 里的路径。 */
  path: editsModule.Path;
  /** 改了。 */
  onEdit: (edit: editsModule.Edit) => void;
}


/**
 * 一行：名字、输入、说明。
 * @param props label、hint、path（写在 data-path 上，自动测试靠它找到这一项）、children。
 */
export function Row(props: { label: string; hint?: string; path?: editsModule.Path; children: react.ReactNode }): react.JSX.Element {
  /** 判断改过没有。 */
  const isChanged = react.useContext(ChangedContext);
  return (
    <div className={props.path && isChanged(props.path) ? 'jm-field jm-field-changed' : 'jm-field'} data-path={props.path?.join('.')}>
      <label className="jm-field-label">{props.label}</label>
      <div className="jm-field-body">
        {props.children}
        {props.hint && <div className="jm-field-hint">{props.hint}</div>}
      </div>
    </div>
  );
}


/**
 * 一个值写成输入框里的字：文字原样，数字、真假转成字，别的（没写、对象）是空。
 * @param value 值。
 */
function textOf(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}


/**
 * 文字。空着就删掉这一项（用默认值）。
 * @param props 公共属性和占位文字。
 */
export function TextField(props: FieldProps & { placeholder?: string }): react.JSX.Element {
  /** 现在的值。 */
  const value = editsModule.getAt(props.draft, props.path);
  return (
    <Row label={props.label} hint={props.hint} path={props.path}>
      <antd.Input
        value={textOf(value)}
        placeholder={props.placeholder}
        onChange={(event) => props.onEdit(event.target.value === '' ? { path: props.path, delete: true } : { path: props.path, value: event.target.value })}
      />
    </Row>
  );
}


/**
 * 数字。空着就删掉这一项（用默认值）。
 * @param props 公共属性、范围、步长、占位文字。
 */
export function NumberField(props: FieldProps & { min?: number; max?: number; step?: number; placeholder?: string }): react.JSX.Element {
  const t = i18n.useT();
  /** 现在的值。 */
  const value = editsModule.getAt(props.draft, props.path);
  return (
    <Row label={props.label} hint={props.hint} path={props.path}>
      <antd.InputNumber
        className="jm-field-number"
        value={typeof value === 'number' ? value : null}
        min={props.min}
        max={props.max}
        step={props.step}
        placeholder={props.placeholder ?? t('用默认值')}
        onChange={(next) => props.onEdit(typeof next === 'number' ? { path: props.path, value: next } : { path: props.path, delete: true })}
      />
    </Row>
  );
}


/**
 * 开关。
 * @param props 公共属性和没写时算什么。
 */
export function BoolField(props: FieldProps & { fallback: boolean }): react.JSX.Element {
  /** 现在的值。 */
  const value = editsModule.getAt(props.draft, props.path);
  return (
    <Row label={props.label} hint={props.hint} path={props.path}>
      <antd.Switch checked={typeof value === 'boolean' ? value : props.fallback} onChange={(checked) => props.onEdit({ path: props.path, value: checked })} />
    </Row>
  );
}


/**
 * 从几项里选一项。空着就删掉这一项。
 * @param props 公共属性和选项。
 */
export function SelectField(props: FieldProps & { options: { value: string; label: string }[]; placeholder?: string }): react.JSX.Element {
  const t = i18n.useT();
  /** 现在的值。 */
  const value = editsModule.getAt(props.draft, props.path);
  return (
    <Row label={props.label} hint={props.hint} path={props.path}>
      <antd.Select
        className="jm-field-select"
        allowClear
        value={typeof value === 'string' ? value : undefined}
        placeholder={props.placeholder ?? t('用默认值')}
        options={props.options}
        onChange={(next: string | undefined) => props.onEdit(next ? { path: props.path, value: next } : { path: props.path, delete: true })}
      />
    </Row>
  );
}


/**
 * 全部供应商的名字。
 * @param draft 草稿。
 */
export function providerNames(draft: unknown): string[] {
  /** providers 这一段。 */
  const value = editsModule.getAt(draft, ['providers']);
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}


/** 选模型时的限制。 */
export interface ModelFilter {
  /** 只要哪一种（不写是全部）。 */
  kind?: 'chat' | 'decision';
  /** 只要看得懂图的。 */
  needVision?: boolean;
}


/**
 * 一家供应商能选的模型：后端认的，加上 config.yaml 里手写的（刚写的要重启后端才认）。
 * @param draft 草稿。
 * @param provider 供应商。
 * @param models 全部模型。
 * @param filter 限制。
 * @param t 翻译函数。
 * @returns 选项：值是不带供应商的模型 ID。
 */
function modelChoices(draft: unknown, provider: string, models: api.ModelInfo[], filter: ModelFilter, t: i18n.Translate): { value: string; label: string }[] {
  /** 模型 ID 的开头。 */
  const prefix = `${provider}/`;
  /** 选项。 */
  const options = models
    .filter((model) => model.id.startsWith(prefix) && (!filter.kind || model.kind === filter.kind) && (!filter.needVision || model.vision === true))
    .map((model) => ({
      value: model.id.slice(prefix.length),
      label: `${model.id.slice(prefix.length)}${model.contextWindow ? `  ·  ${Math.round(model.contextWindow / 1000)}K` : ''}${model.vision ? `  ·  ${t('看图')}` : ''}`,
    }));
  /** 手写的。 */
  const written = editsModule.getAt(draft, ['providers', provider, 'models']);
  if (filter.kind !== 'decision' && written && typeof written === 'object' && !Array.isArray(written)) {
    for (const [id, params] of Object.entries(written as Record<string, { vision?: unknown }>)) {
      if (!options.some((option) => option.value === id) && (!filter.needVision || params.vision === true)) {
        options.push({ value: id, label: id });
      }
    }
  }
  return options;
}


/**
 * 选一个模型：先选供应商（也能从这里去添加新供应商），再选它的模型。
 * @param props value 现在的值（供应商/模型 ID，空的是没选）；draft 草稿；models 全部模型；onChange 选好了（空的是清掉）；还有限制。
 */
export function ModelPicker(
  props: ModelFilter & {
    /** 当前供应商与模型的组合 ID。 */
    value: string;
    /** 设置页尚未保存的草稿。 */
    draft: unknown;
    /** 后端返回的可选模型目录。 */
    models: api.ModelInfo[];
    /** 由设置字段传入，将选择结果写回草稿。 */
    onChange: (next: string) => void;
  },
): react.JSX.Element {
  const t = i18n.useT();
  /** 去设置的某一类。 */
  const goTo = context.useUi((state) => state.setSettingsCategory);
  /** 只选了供应商、还没选模型时记在这里。 */
  const [picked, setPicked] = react.useState('');
  /** 第一个斜杠前面是供应商，后面是模型 ID（模型 ID 里还能有斜杠）。 */
  const cut = props.value.indexOf('/');
  const provider = cut > 0 ? props.value.slice(0, cut) : picked;
  const model = cut > 0 ? props.value.slice(cut + 1) : '';
  return (
    <div className="jm-model-picker">
      <antd.Select
        className="jm-model-provider"
        value={provider || undefined}
        placeholder={t('供应商')}
        options={[
          ...providerNames(props.draft).map((name) => ({
            value: name,
            label: name,
          })),
          { value: ADD_PROVIDER, label: t('＋ 添加供应商…') },
        ]}
        onChange={(next: string) => {
          if (next === ADD_PROVIDER) {
            goTo('providers');
            return;
          }
          setPicked(next);
          props.onChange('');
        }}
      />
      <antd.Select
        className="jm-model-name"
        allowClear
        showSearch={{ optionFilterProp: 'label' }}
        disabled={!provider}
        value={model || undefined}
        placeholder={provider ? t('选模型') : t('先选供应商')}
        options={
          provider
            ? modelChoices(props.draft, provider, props.models, props, t)
            : []
        }
        notFoundContent={t('这家还没有这种模型：去“模型供应商”里获取或手写')}
        onChange={(next: string | undefined) => {
          setPicked(provider);
          props.onChange(next ? `${provider}/${next}` : '');
        }}
      />
    </div>
  );
}


/**
 * 一项“用哪个模型”。
 * @param props 公共属性、全部模型、限制。
 */
export function ModelField(props: FieldProps & ModelFilter & { models: api.ModelInfo[] }): react.JSX.Element {
  /** 现在的值。 */
  const value = editsModule.getAt(props.draft, props.path);
  return (
    <Row label={props.label} hint={props.hint} path={props.path}>
      <ModelPicker
        value={typeof value === 'string' ? value : ''}
        draft={props.draft}
        models={props.models}
        kind={props.kind}
        needVision={props.needVision}
        onChange={(next) => props.onEdit(next ? { path: props.path, value: next } : { path: props.path, delete: true })}
      />
    </Row>
  );
}


/**
 * 模型的列表（能调顺序）：如 engine.fallback_chain。
 * @param props 公共属性、全部模型。
 */
export function ModelListField(
  props: FieldProps & { models: api.ModelInfo[] },
): react.JSX.Element {
  const t = i18n.useT();
  /** 现在的列表。 */
  const value = editsModule.getAt(props.draft, props.path);
  const list = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
  /** 要加的那一个。 */
  const [adding, setAdding] = react.useState('');
  /**
   * 换成新的列表。
   * @param next 新列表。
   */
  const save = (next: string[]): void => {
    /** 空列表删除配置键，非空列表写入选定的顺序。 */
    const edit: editsModule.Edit =
      next.length > 0
        ? {
            path: props.path,
            value: next,
          }
        : {
            path: props.path,
            delete: true,
          };

    props.onEdit(edit);
  };
  return (
    <Row label={props.label} hint={props.hint} path={props.path}>
      <div className="jm-list">
        {list.map((item, index) => (
          <div key={`${item}-${index}`} className="jm-list-row">
            <span className="jm-list-text">
              {index + 1}. {item}
            </span>
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
            <antd.Button
              size="small"
              type="text"
              danger
              icon={<icons.DeleteOutlined />}
              aria-label={t('删掉')}
              onClick={() => {
                const next = list.filter((_, at) => at !== index);

                save(next);
              }}
            />
          </div>
        ))}
        <div className="jm-list-add jm-model-add">
          <ModelPicker
            value={adding}
            draft={props.draft}
            models={props.models}
            kind="chat"
            onChange={setAdding}
          />
          <antd.Button
            icon={<icons.PlusOutlined />}
            disabled={!adding}
            onClick={() => {
              save([...list, adding]);
              setAdding('');
            }}
          >
            {t('加')}
          </antd.Button>
        </div>
      </div>
    </Row>
  );
}


/**
 * 逗号隔开的一串数字（如 engine.retry_delays_ms）。
 * @param props 公共属性。
 */
export function NumberListField(props: FieldProps): react.JSX.Element {
  const t = i18n.useT();
  /** 现在的值。 */
  const value = editsModule.getAt(props.draft, props.path);
  /** 输入框里的字（打到一半的也留着）。 */
  const [text, setText] = react.useState(Array.isArray(value) ? value.join(', ') : '');
  /** 打的字对不对。 */
  const parsed = editsModule.parseNumberList(text);
  return (
    <Row label={props.label} hint={props.hint} path={props.path}>
      <antd.Input
        value={text}
        status={text && !parsed ? 'error' : undefined}
        placeholder={t('用默认值，如 2000, 5000')}
        onChange={(event) => {
          setText(event.target.value);
          /** 换成数字。 */
          const numbers = editsModule.parseNumberList(event.target.value);
          if (event.target.value.trim() === '') {
            props.onEdit({ path: props.path, delete: true });
          } else if (numbers) {
            props.onEdit({ path: props.path, value: numbers });
          }
        }}
      />
    </Row>
  );
}


/**
 * 名字 → 数字的表（如 concurrency.models）。
 * @param props 公共属性、键的占位文字。
 */
export function NumberMapField(
  props: FieldProps & { keyPlaceholder: string },
): react.JSX.Element {
  const t = i18n.useT();
  /** 现在的表。 */
  const value = editsModule.getAt(props.draft, props.path);
  const entries =
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value as Record<string, unknown>)
      : [];
  /** 要加的那一项。 */
  const [key, setKey] = react.useState('');
  return (
    <Row label={props.label} hint={props.hint} path={props.path}>
      <div className="jm-list">
        {entries.map(([name, number]) => (
          <div key={name} className="jm-list-row">
            <span className="jm-list-text">{name}</span>
            <antd.InputNumber
              min={1}
              value={typeof number === 'number' ? number : null}
              onChange={(next) => {
                if (typeof next !== 'number') {
                  return;
                }
                const edit: editsModule.Edit = {
                  path: [...props.path, name],
                  value: next,
                };

                props.onEdit(edit);
              }}
            />
            <antd.Button
              size="small"
              type="text"
              danger
              icon={<icons.DeleteOutlined />}
              aria-label={t('删掉')}
              onClick={() => {
                const edit: editsModule.Edit = {
                  path: [...props.path, name],
                  delete: true,
                };

                props.onEdit(edit);
              }}
            />
          </div>
        ))}
        <antd.Space.Compact className="jm-list-add">
          <antd.Input
            value={key}
            placeholder={props.keyPlaceholder}
            onChange={(event) => setKey(event.target.value.trim())}
          />
          <antd.Button
            icon={<icons.PlusOutlined />}
            disabled={!key}
            onClick={() => {
              props.onEdit({ path: [...props.path, key], value: 1 });
              setKey('');
            }}
          >
            {t('加')}
          </antd.Button>
        </antd.Space.Compact>
      </div>
    </Row>
  );
}


/**
 * 一段 JSON（如 compat、model_compat）：失焦时认出来才算改了。
 * @param props 公共属性。
 */
export function JsonField(props: FieldProps): react.JSX.Element {
  const t = i18n.useT();
  /** 现在的值。 */
  const value = editsModule.getAt(props.draft, props.path);
  /** 输入框里的字。 */
  const [text, setText] = react.useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  /** 认不出时的原因。 */
  const [problem, setProblem] = react.useState('');
  return (
    <Row label={props.label} hint={props.hint} path={props.path}>
      <antd.Input.TextArea
        className="jm-field-json"
        value={text}
        autoSize={{ minRows: 2, maxRows: 10 }}
        status={problem ? 'error' : undefined}
        placeholder="{}"
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (text.trim() === '') {
            setProblem('');
            props.onEdit({ path: props.path, delete: true });
            return;
          }
          try {
            props.onEdit({ path: props.path, value: JSON.parse(text) as unknown });
            setProblem('');
          } catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
          }
        }}
      />
      {problem && <div className="jm-field-error">{t('不是合法的 JSON：{reason}', { reason: problem })}</div>}
    </Row>
  );
}
