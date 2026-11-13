/**
 * 新建机器人（docs/界面/01_界面设计.md 6.2）：左上角 ＋ 打开；填名字、一句话身份、语言、默认模型、飞书应用（可选）。
 * 建好不用重启：刷新机器人列表、切到新机器人；飞书没连上时写明原因（机器人照样建好）。
 * 密钥明文显示，和设置页一样（用户 11-05：能进设置页的人本来就有权限）。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';


/** 表单里的东西。 */
interface FormValues {
  /** 名字（bots/ 下的文件夹名）。 */
  name: string;
  /** 一句话身份。 */
  identity?: string;
  /** 语言。 */
  language: 'zh' | 'en';
  /** 默认模型。 */
  model?: string;
  /** 飞书应用的 app_id。 */
  appId?: string;
  /** 飞书应用的 app_secret。 */
  appSecret?: string;
}


/** 新建机器人的弹窗：开没开由状态仓库的 newBotOpen 管（左上角 ＋ 改它）。 */
export function NewBotModal(): react.JSX.Element {
  const t = i18n.useT();
  const open = context.useUi((state) => state.newBotOpen);
  const setNewBotOpen = context.useUi((state) => state.setNewBotOpen);
  const setPolled = context.useUi((state) => state.setPolled);
  const selectBot = context.useUi((state) => state.selectBot);
  const [form] = antd.Form.useForm<FormValues>();
  const [toast, toastHolder] = antd.message.useMessage();
  /** 能选的模型。 */
  const [models, setModels] = react.useState<string[]>([]);
  /** 正在建。 */
  const [saving, setSaving] = react.useState(false);
  /** 后端说哪里不对。 */
  const [error, setError] = react.useState('');

  //M 每次打开都是空表单，顺手取一次模型清单。
  react.useEffect(() => {
    if (!open) {
      return;
    }
    form.resetFields();
    setError('');
    void api.models().then(
      (list) => setModels(list.map((item) => item.id)),
      () => setModels([]),
    );
  }, [open, form]);

  /** 建：后端建好就刷新机器人列表、切过去。 */
  const submit = async (): Promise<void> => {
    /** 填的东西（没过校验时 antd 自己标红，这里直接返回）。 */
    const values = await form.validateFields().catch(() => undefined);
    if (!values) {
      return;
    }
    setSaving(true);
    setError('');
    try {
      /** 飞书的两项。 */
      const appId = values.appId?.trim() ?? '';
      const appSecret = values.appSecret?.trim() ?? '';
      /** 后端回的。 */
      const result = await api.createBot({
        name: values.name.trim(),
        identity: values.identity?.trim() ?? '',
        language: values.language,
        ...(values.model ? { model: values.model } : {}),
        ...(appId || appSecret ? { feishu: { app_id: appId, app_secret: appSecret } } : {}),
      });
      setPolled({ online: true, bots: await api.bots() });
      selectBot(result.bot.name);
      setNewBotOpen(false);
      /** 建好了的那句话。 */
      const done = t('建好了：{name}', { name: result.bot.name });
      if (result.feishu && result.feishu !== '已连上') {
        void toast.warning(`${done}；${t('飞书：{state}', { state: result.feishu })}`, 8);
      } else {
        void toast.success(result.feishu ? `${done}；${t('飞书：{state}', { state: t('已连上') })}` : done);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {toastHolder}
      <antd.Modal open={open} title={t('新建机器人')} okText={t('新建')} cancelText={t('取消')} confirmLoading={saving} onOk={() => void submit()} onCancel={() => setNewBotOpen(false)}>
        <antd.Form form={form} layout="vertical" initialValues={{ language: 'zh' }}>
          <antd.Form.Item name="name" label={t('名字')} extra={t('就是 bots/ 下的文件夹名，建好不能改')} rules={[{ required: true, whitespace: true, message: t('要填名字') }]}>
            <antd.Input maxLength={40} autoFocus />
          </antd.Form.Item>
          <antd.Form.Item name="identity" label={t('一句话身份')}>
            <antd.Input maxLength={120} placeholder={t('比如：对接外部各种人员')} />
          </antd.Form.Item>
          <antd.Form.Item name="language" label={t('语言')}>
            <antd.Radio.Group
              optionType="button"
              options={[
                { label: '中文', value: 'zh' },
                { label: 'English', value: 'en' },
              ]}
            />
          </antd.Form.Item>
          <antd.Form.Item name="model" label={t('默认模型')}>
            <antd.Select allowClear showSearch placeholder={t('可以不选')} options={models.map((id) => ({ label: id, value: id }))} />
          </antd.Form.Item>
          <antd.Form.Item label={t('飞书应用（可选）')} extra={t('两个都填才绑；不填以后在设置页加')}>
            <antd.Space.Compact block>
              <antd.Form.Item name="appId" noStyle>
                <antd.Input placeholder="app_id" />
              </antd.Form.Item>
              <antd.Form.Item name="appSecret" noStyle>
                <antd.Input placeholder="app_secret" />
              </antd.Form.Item>
            </antd.Space.Compact>
          </antd.Form.Item>
          {error && <antd.Alert type="error" showIcon message={error} />}
        </antd.Form>
      </antd.Modal>
    </>
  );
}
