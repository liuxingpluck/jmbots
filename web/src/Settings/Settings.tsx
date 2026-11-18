/**
 * 设置：config 的配置界面（docs/界面/01_界面设计.md 第 10 节）。左下角进入（或 #settings=分类），全屏覆盖，左边分类，右边表单。
 *   打开时取一次配置和模型清单；改动记成一步一步（Edits.ts），保存时按顺序发给后端，只改动过的那几项，注释留着。
 *   config.yaml 是后端启动时读的：保存后提示“重启后生效”，带一个“立即重启”（后台换版本，等新进程起来）。
 *   “重连”分类不改配置：重新测试模型连接、重启服务（Reconnect.tsx）。
 *   不做订阅、不做账号连接。Esc 关（有没保存的改动时先问）。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as desktop from '../Desktop/Desktop.tsx';
import * as i18n from '../I18n.ts';
import * as theme from '../Theme.ts';
import * as editsModule from './Edits.ts';
import * as fields from './Fields.tsx';
import * as reconnect from './Reconnect.tsx';
import * as sections from './Sections.tsx';
import './Settings.css';


/** 分类：键、名字、一句话说明、表单、管 config.yaml 里哪几段（改过了就在分类上加个点）。 */
const CATEGORIES: { key: string; label: string; hint: string; form?: (props: sections.SectionProps) => react.JSX.Element; paths: editsModule.Path[] }[] = [
  { key: 'providers', label: '模型供应商', hint: '左边选一家，右边配它的密钥、地址、协议和模型；想接几家接几家', form: sections.Providers, paths: [['providers']] },
  {
    key: 'models',
    label: '模型',
    hint: '每个用途先选供应商，再选模型',
    form: sections.Models,
    paths: [
      ['default_model'],
      ['models'],
      editsModule.PLUGIN_PATHS.fallbackChain,
      editsModule.PLUGIN_PATHS.fallbackMaxTries,
      ['engine', 'vision_model'],
    ],
  },
  { key: 'bots', label: '机器人', hint: '有几个列几个，每个的语言和渠道都在它下面', form: sections.Bots, paths: [['bots'], ['channels']] },
  { key: 'search', label: '搜索', hint: '网页搜索按顺序试', form: sections.Search, paths: [['search']] },
  {
    key: 'engine',
    label: '引擎',
    hint: '轮询、压缩、审核门槛、记忆搜索地址',
    form: sections.Engine,
    paths: [
      ['engine', 'poll_ms'],
      ['engine', 'compress_at'],
      ['engine', 'exec_pass'],
      ['engine', 'wrapup_model'],
      ['engine', 'memory_libs'],
      ['engine', 'retry_delays_ms'],
      editsModule.PLUGIN_PATHS.indexUrl,
      editsModule.PLUGIN_PATHS.imageModel,
      editsModule.PLUGIN_PATHS.fallbackSiblings,
    ],
  },
  { key: 'concurrency', label: '并发', hint: '同一时间最多几个调用，超了排队', form: sections.Concurrency, paths: [['concurrency']] },
  { key: 'http', label: '服务', hint: '后端的端口和 token', form: sections.Http, paths: [['http']] },
  { key: 'local', label: '基地', hint: '基地的端口、窗口打开哪个后端、记忆库和 RAG 目录', form: sections.Local, paths: [['local']] },
  { key: 'ui', label: '界面', hint: '主题（存在这个浏览器里，不进 config.yaml）', paths: [] },
  { key: 'desktop', label: '窗口操控', hint: '拖动定位点选中窗口，预览指定区域并定向滚动', paths: [] },
  { key: 'reconnect', label: '重连', hint: '模型连不上、服务不对劲时用：重新测试模型连接、重启服务，不改 config.yaml', paths: [] },
];

/** 重启到哪一步了。 */
type RestartState = { kind: 'idle' } | { kind: 'saved' } | { kind: 'restarting' } | { kind: 'done' } | { kind: 'failed'; reason: string };


/** 仅影响当前浏览器的面板尺寸，不写入服务配置。 */
const MAXIMIZED_KEY = 'jmbots.settings.maximized';


/** 设置页：全屏配置与重连界面，管理未保存改动、保存落盘与立即重启流程。 */
export function Settings(): react.JSX.Element {
  //M 取当前界面语言的翻译函数，用于设置页导航、按钮状态和保存重启提示文案。
  const t = i18n.useT();
  /** 尺寸切换只改变 CSS，设置草稿和窗口预览组件继续保留。 */
  const [maximized, setMaximized] = react.useState(() => {
    try {
      return window.localStorage.getItem(MAXIMIZED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const toggleMaximized = (): void => {
    const next = !maximized;
    setMaximized(next);
    try {
      window.localStorage.setItem(MAXIMIZED_KEY, String(next));
    } catch {
      //M 浏览器不允许存储时，当前面板仍可正常最大化和还原。
    }
  };
  /** 选中的分类（#settings=分类 也能打开）；没挂 desktop 插件时隐藏“窗口操控”避免打开打 404。 */
  //M 从界面状态仓库取出后端已挂载插件列表，用于判断“窗口操控”分类是否展示。
  const mountedPlugins = context.useUi((state) => state.mountedPlugins);
  //G 检查 desktop 插件是否可用（加载中暂不显示），避免在未挂载时点开报 404。
  const desktopEnabled = api.isPluginMounted(mountedPlugins, 'desktop', false);
  const visibleCategories = react.useMemo(() => {
    if (desktopEnabled) return CATEGORIES;

    return CATEGORIES.filter((item) => item.key !== 'desktop');
  }, [desktopEnabled]);

  //M 从界面状态仓库获取当前分类、切分类动作和关闭弹窗动作，供导航点击与关闭校验使用。
  const category = context.useUi((state) => state.settingsCategory);
  const setCategory = context.useUi((state) => state.setSettingsCategory);
  const setSettingsOpen = context.useUi((state) => state.setSettingsOpen);
  /** 主题。 */
  //M 从界面状态仓库读取和更新当前配色主题，供“界面”分类单选按钮实时切换。
  const themeName = context.useUi((state) => state.themeName);
  const setThemeName = context.useUi((state) => state.setThemeName);
  /** 语言。 */
  //M 从界面状态仓库读取和更新当前界面语言，供“界面”分类下拉实时切换。
  const language = context.useUi((state) => state.language);
  const setLanguage = context.useUi((state) => state.setLanguage);
  /** 拿到的配置、模型；出错的原因。 */
  const [config, setConfig] = react.useState<Record<string, unknown> | null>(null);
  const [models, setModels] = react.useState<api.ModelInfo[]>([]);
  const [loadError, setLoadError] = react.useState('');
  /** 还没保存的改动。 */
  const [edits, setEdits] = react.useState<editsModule.Edit[]>([]);
  /** 保存中、重启到哪了、提示。 */
  const [saving, setSaving] = react.useState(false);
  const [restart, setRestart] = react.useState<RestartState>({ kind: 'idle' });
  const [notice, setNotice] = react.useState('');
  /** 表单换一份（保存后、撤销后重画输入框，免得输入框里留着旧字）。 */
  const [formKey, setFormKey] = react.useState(0);
  const getErrorText = (error: unknown): string => {
    if (error instanceof Error) return error.message;

    return String(error);
  };

  /** 取配置和模型。 */
  const load = react.useCallback(() => {
    setLoadError('');
    //M 拉取当前 config.yaml 脱敏配置作为编辑基准，成功更新表单、失败展示报错。
    void api.settings().then(
      (result) => setConfig(result.config),
      //G 取配置失败时将异常整理为可读文字展示在右侧面板。
      (error: unknown) => setLoadError(getErrorText(error)),
    );
    //M 同步拉取后端可用模型清单供模型选择器和“重连”核对使用，拉取失败时退回空数组。
    void api.models().then(setModels, () => setModels([]));
  }, []);

  react.useEffect(load, [load]);

  /** 关设置（右上角的关闭）：有没保存的改动也不要了（用户 11-06：关闭按钮强行取消）。 */
  const close = react.useCallback(() => setSettingsOpen(false), [setSettingsOpen]);

  /** 点空白处、按 Esc：没有改动才关；有改动要先保存或撤销，或者点右上角的关闭放弃（用户 11-06）。 */
  const closeIfClean = react.useCallback(() => {
    if (edits.length > 0) {
      void antd.message.warning(t('有 {count} 处改动还没保存：先保存或撤销，或者点右上角的关闭放弃改动', { count: edits.length }));
      return;
    }
    setSettingsOpen(false);
  }, [edits.length, setSettingsOpen, t]);

  react.useEffect(() => {
    /** Esc 关设置。 */
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeIfClean();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeIfClean]);

  /** 草稿。 */
  const draft = react.useMemo(() => {
    if (!config) return null;

    //M 按顺序把未保存改动叠到原始配置上生成实时草稿，传给右侧表单渲染。
    return editsModule.getDraft(config, edits);
  }, [config, edits]);
  /** 改了一项。 */
  //M 把单步配置改动合入待保存队列（连续修改同一值时折叠为最后一步）。
  const onEdit = react.useCallback((edit: editsModule.Edit) => setEdits((old) => editsModule.addEdit(old, edit)), []);
  /** 某个路径改过没有。 */
  //M 对比原始配置与草稿在指定路径的值，用于导航栏改过小圆点与字段名称变红高亮。
  const isChanged = react.useCallback((path: editsModule.Path) => editsModule.changedAt(config, draft, path), [config, draft]);

  /** 保存。 */
  const save = (): void => {
    setSaving(true);
    setNotice('');
    //M 按顺序把改动提交到后端写回 config.yaml，成功后清空改动、重置表单并提示重启生效。
    void api.saveSettings(edits).then(
      () => {
        setSaving(false);
        setEdits([]);
        setFormKey((key) => key + 1);
        setRestart({ kind: 'saved' });
        load();
      },
      (error: unknown) => {
        setSaving(false);
        //G 保存请求失败时把异常格式化为可读提示显示在底部操作区。
        setNotice(t('没保存成：{reason}', { reason: getErrorText(error) }));
      },
    );
  };

  /** 立即重启：后端在后台换版本；等 /api/ui/info 的起来时间变了就是新进程。 */
  const restartNow = async (): Promise<void> => {
    setRestart({ kind: 'restarting' });
    try {
      /** 旧进程起来的时间。 */
      //M 通知后端在后台按新配置启动并切换版本，记下旧进程 startedAt 作为就绪比对基准。
      const { startedAt } = await api.applySettings();
      /** 等到新进程没有。 */
      //M 轮询 /api/ui/info 直到 startedAt 改变或超时，确认新进程已接管服务。
      const restarted = await api.waitNewProcess(startedAt);
      if (restarted) {
        setRestart({ kind: 'done' });
        load();
        return;
      }
      setRestart({ kind: 'failed', reason: t('等了 3 分钟还没换好：看运行时 data 里最新的 swap_*.log') });
    } catch (error) {
      //G 重启触发或等待新进程期间抛错时格式化原因，更新重启卡片为失败态。
      setRestart({ kind: 'failed', reason: getErrorText(error) });
    }
  };

  /** 选中的那一类。 */
  const current = visibleCategories.find((item) => item.key === category) ?? visibleCategories[0]!;
  /** 那一类的表单。 */
  const Form = current.form;
  let dialogClass = 'jm-settings';
  if (maximized) {
    dialogClass = 'jm-settings jm-settings-maximized';
  }
  let failedReason = '';
  if (restart.kind === 'failed') {
    failedReason = restart.reason;
  }
  let restartAction: react.ReactNode = undefined;
  if (restart.kind === 'saved') {
    //M 保存成功待重启时提供“立即重启”按钮，点击后触发后台换版本并等待新进程就绪。
    restartAction = (
      <antd.Button size="small" type="primary" onClick={() => void restartNow()}>
        {t('立即重启')}
      </antd.Button>
    );
  }
  let editsStatus = t('没有没保存的改动');
  if (edits.length > 0) {
    editsStatus = t('有 {count} 处改动还没保存', { count: edits.length });
  }
  let maxIcon = <icons.FullscreenOutlined />;
  let maxLabel = t('最大化设置面板');
  if (maximized) {
    maxIcon = <icons.FullscreenExitOutlined />;
    maxLabel = t('还原设置面板');
  }

  //M 渲染设置全屏弹窗：左侧呈现分类导航与保存/撤销栏，右侧展示当前分类界面与表单。
  return (
    <div
      className="jm-settings-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeIfClean();
        }
      }}
    >
      <div className={dialogClass} role="dialog" aria-label={t('设置')}>
        <nav className="jm-settings-nav">
          <header className="jm-settings-title">{t('设置')}</header>
          {visibleCategories.map((item) => {
            let catClass = 'jm-settings-cat';
            if (item.key === current.key) {
              catClass = 'jm-settings-cat jm-active';
            }
            return (
              <button key={item.key} type="button" className={catClass} onClick={() => setCategory(item.key)}>
                <span>{t(item.label)}</span>
                {item.paths.some(isChanged) && <span className="jm-settings-dot" title={t('改过，还没保存')} />}
              </button>
            );
          })}
          <footer className="jm-settings-save">
            {restart.kind !== 'idle' && (
              <antd.Alert
                className="jm-settings-alert"
                type={({ saved: 'info', restarting: 'info', done: 'success', failed: 'error' } as const)[restart.kind]}
                message={
                  {
                    saved: t('已保存，重启后生效'),
                    restarting: t('正在重启：先试运行新进程，没问题再换掉正在跑的……'),
                    done: t('重启好了，新的设置已经生效'),
                    failed: t('没重启成：{reason}', { reason: failedReason }),
                  }[restart.kind]
                }
                action={restartAction}
              />
            )}
            <span className="jm-muted">{editsStatus}</span>
            {notice && <span className="jm-field-error">{notice}</span>}
            <div className="jm-settings-buttons">
              <antd.Button
                disabled={edits.length === 0}
                onClick={() => {
                  setEdits([]);
                  setFormKey((key) => key + 1);
                }}
              >
                {t('撤销')}
              </antd.Button>
              <antd.Button type="primary" disabled={edits.length === 0} loading={saving} onClick={save}>
                {t('保存')}
              </antd.Button>
            </div>
          </footer>
        </nav>
        <section className="jm-settings-body">
          <header className="jm-settings-head">
            <div>
              <h2>{t(current.label)}</h2>
              <p className="jm-muted">{t(current.hint)}</p>
            </div>
            <div className="jm-settings-head-actions">
              <antd.Button
                type="text"
                icon={maxIcon}
                aria-label={maxLabel}
                title={maxLabel}
                aria-pressed={maximized}
                onClick={toggleMaximized}
              />
              <antd.Button type="text" icon={<icons.CloseOutlined />} aria-label={t('关闭设置（Esc）')} onClick={close} />
            </div>
          </header>
          <div className="jm-settings-content">
              {current.key === 'ui' && (
                <fields.Row label={t('语言')} hint={t('界面的文字；机器人说什么语言在“机器人”里设。切了马上生效，存进 config.yaml 的 ui.language')}>
                  <antd.Select
                    className="jm-field-select"
                    value={language}
                    options={i18n.LANGUAGES.map((item) => ({ value: item.code, label: item.label }))}
                    onChange={(next: i18n.Language) => {
                      setLanguage(next);
                      //M 把新选语言写入浏览器本地存储，并同步保存回 config.yaml 的 ui.language 确保刷新一致。
                      i18n.saveLanguage(window.localStorage, next);
                      void api.saveSettings([{ path: ['ui', 'language'], value: next }]);
                    }}
                  />
                </fields.Row>
              )}
              {current.key === 'ui' && (
                <antd.Radio.Group
                  value={themeName}
                  onChange={(event) => {
                    /** 选的主题。 */
                    const name = event.target.value as theme.ThemeName;
                    setThemeName(name);
                    //M 把选中的配色主题名存入浏览器本地存储，供下次打开页面直接读取应用。
                    theme.saveThemeName(window.localStorage, name);
                  }}
                >
                  {Object.values(theme.THEMES).map((spec) => {
                    let previewSuffix = '';
                    if (!spec.ready) {
                      previewSuffix = t('（预览）');
                    }
                    return (
                      <antd.Radio.Button key={spec.name} value={spec.name}>
                        {t(spec.label)}
                        {previewSuffix}
                      </antd.Radio.Button>
                    );
                  })}
                </antd.Radio.Group>
              )}
              {current.key === 'reconnect' && <reconnect.Reconnect draft={draft} onReload={load} />}
              {current.key === 'desktop' && <desktop.Desktop />}
              {Form && loadError && <antd.Alert type="error" showIcon message={t('取不到配置：{reason}', { reason: loadError })} />}
              {Form && !loadError && !draft && <antd.Spin />}
              {Form && draft !== null && (
                <fields.ChangedContext.Provider value={isChanged}>
                  <Form key={`${current.key}-${formKey}`} draft={draft} onEdit={onEdit} models={models} />
                </fields.ChangedContext.Provider>
              )}
          </div>
        </section>
      </div>
    </div>
  );
}
