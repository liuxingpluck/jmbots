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

/** 跳到设置中心某个二级节点（由 Settings.tsx 提供，优先用于平滑定位）。 */
export const NavigateSectionContext = react.createContext<((sectionId: string) => void) | null>(null);


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
  /** 可选读取回退路径（如优先读 `shell.*`、未配时回落旧 `local.*`）。 */
  fallbackPath?: editsModule.Path;
  /** 改了。 */
  onEdit: (edit: editsModule.Edit) => void;
}


/** 读取字段值；主路径未定义时可回退旧配置路径。 */
function readFieldValue(
  draft: unknown,
  path: editsModule.Path,
  fallbackPath?: editsModule.Path,
): unknown {
  const primary = editsModule.getAt(draft, path);
  if (primary !== undefined || fallbackPath === undefined) return primary;

  return editsModule.getAt(draft, fallbackPath);
}


/** 有有效值就写入，否则删掉该配置项。 */
function getValueOrDeleteEdit(path: editsModule.Path, value: unknown, present: boolean): editsModule.Edit {
  if (present) return { path, value };

  return { path, delete: true };
}


/**
 * 一行：名字、输入、说明。
 * @param props label、hint、path（写在 data-path 上，自动测试靠它找到这一项）、children。
 */
export function Row(props: {
  label: string;
  hint?: string;
  path?: editsModule.Path;
  fallbackPath?: editsModule.Path;
  children: react.ReactNode;
}): react.JSX.Element {
  /** 判断改过没有。 */
  const isChanged = react.useContext(ChangedContext);
  const primaryChanged = props.path !== undefined && isChanged(props.path);
  const fallbackChanged = props.fallbackPath !== undefined && isChanged(props.fallbackPath);
  let rowClass = 'jm-field';
  if (primaryChanged || fallbackChanged) {
    rowClass = 'jm-field jm-field-changed';
  }
  return (
    <div className={rowClass} data-path={props.path?.join('.')}>
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
function getText(value: unknown): string {
  if (typeof value === 'string') return value;

  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  return '';
}


/**
 * 文字。空着就删掉这一项（用默认值）。
 * @param props 公共属性和占位文字。
 */
export function TextField(props: FieldProps & { placeholder?: string }): react.JSX.Element {
  /** 现在的值。 */
  //M 从设置草稿读取该配置项当前值（优先主路径，必要时回落旧路径），用于输入框回显。
  const value = readFieldValue(props.draft, props.path, props.fallbackPath);
  //M 渲染文本输入框：草稿值转文本显示，清空输入时删除该键，非空则写入新字符串。
  return (
    <Row label={props.label} hint={props.hint} path={props.path} fallbackPath={props.fallbackPath}>
      <antd.Input
        value={getText(value)}
        placeholder={props.placeholder}
        onChange={(event) => {
          const nextText = event.target.value;
          props.onEdit(getValueOrDeleteEdit(props.path, nextText, nextText !== ''));
        }}
      />
    </Row>
  );
}


/**
 * 数字。空着就删掉这一项（用默认值）。
 * @param props 公共属性、范围、步长、占位文字。
 */
export function NumberField(
  props: FieldProps & { min?: number; max?: number; step?: number; placeholder?: string },
): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于“用默认值”占位提示。
  const t = i18n.useT();
  /** 现在的值。 */
  //M 从设置草稿读取该路径当前值（支持回退路径），供下方过滤出合法数字回显。
  const value = readFieldValue(props.draft, props.path, props.fallbackPath);
  let numericValue: number | null = null;
  if (typeof value === 'number') {
    numericValue = value;
  }

  //M 渲染数值输入框：仅有效数字写入草稿，清空输入框则删键改用默认值。
  return (
    <Row label={props.label} hint={props.hint} path={props.path} fallbackPath={props.fallbackPath}>
      <antd.InputNumber
        className="jm-field-number"
        value={numericValue}
        min={props.min}
        max={props.max}
        step={props.step}
        placeholder={props.placeholder ?? t('用默认值')}
        onChange={(next) => props.onEdit(getValueOrDeleteEdit(props.path, next, typeof next === 'number'))}
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
  //M 从设置草稿读取布尔配置值，未配置时回退到调用方提供的 fallback 默认值。
  const value = editsModule.getAt(props.draft, props.path);
  let checked = props.fallback;
  if (typeof value === 'boolean') {
    checked = value;
  }

  //M 渲染布尔开关：切换状态后显式写入 true 或 false 覆盖默认开关。
  return (
    <Row label={props.label} hint={props.hint} path={props.path}>
      <antd.Switch checked={checked} onChange={(next) => props.onEdit({ path: props.path, value: next })} />
    </Row>
  );
}


/**
 * 从几项里选一项。空着就删掉这一项。
 * @param props 公共属性和选项。
 */
export function SelectField(
  props: FieldProps & { options: { value: string; label: string }[]; placeholder?: string },
): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于默认的“用默认值”占位文本。
  const t = i18n.useT();
  /** 现在的值。 */
  //M 从设置草稿读取当前选中的字符串选项值，非字符串时按未选处理。
  const value = editsModule.getAt(props.draft, props.path);
  let selectedValue: string | undefined;
  if (typeof value === 'string') {
    selectedValue = value;
  }

  //M 渲染可清除的下拉选择框：选中有效选项时写入草稿，清空则删除该配置键。
  return (
    <Row label={props.label} hint={props.hint} path={props.path}>
      <antd.Select
        className="jm-field-select"
        allowClear
        value={selectedValue}
        placeholder={props.placeholder ?? t('用默认值')}
        options={props.options}
        onChange={(next: string | undefined) => props.onEdit(getValueOrDeleteEdit(props.path, next, Boolean(next)))}
      />
    </Row>
  );
}


/**
 * 全部供应商的名字。
 * @param draft 草稿。
 * @returns 供应商名称列表。
 */
export function getProviderNames(draft: unknown): string[] {
  /** providers 这一段。 */
  //M 从设置草稿取出 providers 配置对象，提取全部已定义供应商名称供选择器复用。
  const value = editsModule.getAt(draft, ['providers']);
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.keys(value);

  return [];
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
function getModelChoices(
  draft: unknown,
  provider: string,
  models: api.ModelInfo[],
  filter: ModelFilter,
  t: i18n.Translate,
): { value: string; label: string }[] {
  /** 模型 ID 的开头。 */
  const prefix = `${provider}/`;
  /** 选项。 */
  const options = models
    .filter((model) => {
      if (!model.id.startsWith(prefix)) return false;
      if (filter.kind && model.kind !== filter.kind) return false;
      if (filter.needVision && model.vision !== true) return false;

      return true;
    })
    .map((model) => {
      let contextSuffix = '';
      if (model.contextWindow) {
        contextSuffix = `  ·  ${Math.round(model.contextWindow / 1000)}K`;
      }
      let visionSuffix = '';
      if (model.vision) {
        visionSuffix = `  ·  ${t('看图')}`;
      }
      return {
        value: model.id.slice(prefix.length),
        label: `${model.id.slice(prefix.length)}${contextSuffix}${visionSuffix}`,
      };
    });
  /** 手写的。 */
  //M 再从草稿读取该供应商下手写的 models 配置，把后端清单未收录或自定义的模型补进选项。
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
  //M 取当前界面语言的翻译函数，用于供应商和模型选择器占位提示与引导文案。
  const t = i18n.useT();
  /** 去设置的某一类。 */
  //M 从界面状态仓库取得切分类动作，并优先使用设置中心平滑跳转上下文，以便用户点“添加供应商”时直达供应商区。
  const goTo = context.useUi((state) => state.setSettingsCategory);
  const navigateSection = react.useContext(NavigateSectionContext);
  /** 只选了供应商、还没选模型时记在这里。 */
  const [picked, setPicked] = react.useState('');
  /** 第一个斜杠前面是供应商，后面是模型 ID（模型 ID 里还能有斜杠）。 */
  const cut = props.value.indexOf('/');
  let provider = picked;
  let model = '';
  if (cut > 0) {
    provider = props.value.slice(0, cut);
    model = props.value.slice(cut + 1);
  }
  let modelPlaceholder = t('先选供应商');
  let choices: { value: string; label: string }[] = [];
  if (provider) {
    modelPlaceholder = t('选模型');
    //M 选定供应商后合并后端清单与草稿手写模型，并按用途和看图要求筛选可选模型。
    choices = getModelChoices(props.draft, provider, props.models, props, t);
  }

  //M 渲染“供应商 + 模型”两级选择器：从草稿汇总可选供应商列表，先定供应商再选其模型。
  return (
    <div className="jm-model-picker">
      <antd.Select
        className="jm-model-provider"
        value={provider || undefined}
        placeholder={t('供应商')}
        options={[
          ...getProviderNames(props.draft).map((name) => ({
            value: name,
            label: name,
          })),
          { value: ADD_PROVIDER, label: t('＋ 添加供应商…') },
        ]}
        onChange={(next: string) => {
          if (next === ADD_PROVIDER) {
            //M 选择“添加供应商”入口时直接切去供应商管理分类。
            if (navigateSection !== null) {
              navigateSection('providers');
              return;
            }
            goTo('providers');
            return;
          }

          //M 切换供应商时暂存新供应商名并清空已选模型，等待右侧重新选定模型。
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
        placeholder={modelPlaceholder}
        options={choices}
        notFoundContent={t('这家还没有这种模型：去“模型供应商”里获取或手写')}
        onChange={(next: string | undefined) => {
          setPicked(provider);
          let fullId = '';
          if (next) {
            fullId = `${provider}/${next}`;
          }

          //M 选定模型后拼出“供应商/模型 ID”交回外层字段，清空时传回空串。
          props.onChange(fullId);
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
  //M 从设置草稿取出当前保存的模型组合 ID，传给模型选择器回显。
  const value = editsModule.getAt(props.draft, props.path);
  let stringValue = '';
  if (typeof value === 'string') {
    stringValue = value;
  }

  //M 渲染单模型配置行：选中有效模型时写入草稿，清空选择则删除该配置键。
  return (
    <Row label={props.label} hint={props.hint} path={props.path}>
      <ModelPicker
        value={stringValue}
        draft={props.draft}
        models={props.models}
        kind={props.kind}
        needVision={props.needVision}
        onChange={(next) => props.onEdit(getValueOrDeleteEdit(props.path, next, Boolean(next)))}
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
  //M 取当前界面语言的翻译函数，用于调序、删除、添加按钮及无障碍标签。
  const t = i18n.useT();
  /** 现在的列表。 */
  //M 从设置草稿取出模型链数组并过滤非字符串元素，作为顺序列表的渲染数据。
  const value = editsModule.getAt(props.draft, props.path);
  let list: string[] = [];
  if (Array.isArray(value)) {
    list = value.filter((item): item is string => typeof item === 'string');
  }
  /** 要加的那一个。 */
  const [adding, setAdding] = react.useState('');
  /**
   * 换成新的列表。
   * @param next 新列表。
   */
  const save = (next: string[]): void => {
    /** 空列表删除配置键，非空列表写入选定的顺序。 */
    //M 列表删空时删除配置键改用默认行为，非空时把新顺序写回草稿。
    props.onEdit(getValueOrDeleteEdit(props.path, next, next.length > 0));
  };

  //M 渲染可重排的模型列表：逐行提供上移、下移、删除操作，底部提供追加模型选择器。
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

                //M 把上移交换后的模型顺序写回草稿。
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

                //M 把下移交换后的模型顺序写回草稿。
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

                //M 把剔除当前项后的模型列表写回草稿。
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
              //M 把底部待加模型追加到列表末尾并写回草稿，随后清空待加选择。
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
 * 名字 → 数字的表（如 concurrency.models）。
 * @param props 公共属性、键的占位文字。
 */
export function NumberMapField(
  props: FieldProps & { keyPlaceholder: string },
): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于删除按钮无障碍标签与新增按钮文案。
  const t = i18n.useT();
  /** 现在的表。 */
  //M 从设置草稿取出“名称 → 数字”映射表，展开为逐行可编辑的键值对数组。
  const value = editsModule.getAt(props.draft, props.path);
  let entries: [string, unknown][] = [];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    entries = Object.entries(value as Record<string, unknown>);
  }
  /** 要加的那一项。 */
  const [key, setKey] = react.useState('');

  //M 渲染键值数字映射表单：逐行修改数值或删除条目，并在底部支持追加新键。
  return (
    <Row label={props.label} hint={props.hint} path={props.path}>
      <div className="jm-list">
        {entries.map(([name, number]) => {
          let numericValue: number | null = null;
          if (typeof number === 'number') {
            numericValue = number;
          }
          return (
            <div key={name} className="jm-list-row">
              <span className="jm-list-text">{name}</span>
              <antd.InputNumber
                min={1}
                value={numericValue}
                onChange={(next) => {
                  if (typeof next !== 'number') {
                    return;
                  }
                  const edit: editsModule.Edit = {
                    path: [...props.path, name],
                    value: next,
                  };

                  //M 把调整后的正整数上限写入该键对应的配置路径。
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

                  //M 点击删除后向草稿提交该子键的删除改动。
                  props.onEdit(edit);
                }}
              />
            </div>
          );
        })}
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
              //M 新增键名默认写入最小合法值 1 到草稿，并清空输入框等待继续添加。
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
  //M 取当前界面语言的翻译函数，用于 JSON 语法错误提示。
  const t = i18n.useT();
  /** 现在的值。 */
  //M 从设置草稿读取当前对象或值，序列化成缩进 JSON 文本初始化编辑框。
  const value = editsModule.getAt(props.draft, props.path);
  /** 输入框里的字。 */
  let initialText = '';
  if (value !== undefined) {
    initialText = JSON.stringify(value, null, 2);
  }
  const [text, setText] = react.useState(initialText);
  /** 认不出时的原因。 */
  const [problem, setProblem] = react.useState('');
  let inputStatus: 'error' | undefined;
  if (problem) {
    inputStatus = 'error';
  }

  //M 渲染 JSON 多行编辑框：编辑时保留原始输入文本，失焦校验通过后才同步草稿。
  return (
    <Row label={props.label} hint={props.hint} path={props.path}>
      <antd.Input.TextArea
        className="jm-field-json"
        value={text}
        autoSize={{ minRows: 2, maxRows: 10 }}
        status={inputStatus}
        placeholder="{}"
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (text.trim() === '') {
            //G 失焦时内容为空则清除报错并删除该配置项。
            setProblem('');
            props.onEdit({ path: props.path, delete: true });
            return;
          }
          try {
            //M 失焦时仅当 JSON 解析成功才把解析后的对象写回草稿。
            props.onEdit({ path: props.path, value: JSON.parse(text) as unknown });
            setProblem('');
          } catch (error) {
            let message = String(error);
            if (error instanceof Error) {
              message = error.message;
            }
            setProblem(message);
          }
        }}
      />
      {problem && <div className="jm-field-error">{t('不是合法的 JSON：{reason}', { reason: problem })}</div>}
    </Row>
  );
}
