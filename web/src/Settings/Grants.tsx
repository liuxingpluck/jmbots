/**
 * 设置里的“目录授权”（用户 #301“目录授权向下延伸”）：把某个人、某个群绑到一个目录，
 * 这个目录和下面的子目录里机器人读写、跑命令、发文件都不用再问你；出了这个目录照旧。
 *   群：群里谁说话，机器人都在这个目录里干活（外人按 builder：能动手，只在授权目录里）。
 *   人：他在哪说话都能在这个目录里动手。
 * 在飞书里对机器人说“把这个群绑到某个目录”也行（工具 dir_grant），和这里是同一份数据（后端 approval 的 Grants.ts）。
 * 挑人：后端记着最近说过话的人和群（重启清空）；不在里面的可以直接填身份（飞书人 feishu:ou_…，群 feishu:group:oc_…）。
 * 不改 config.yaml：授权存在后端库里，加了、撤了马上生效。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as i18n from '../I18n.ts';
import * as fields from './Fields.tsx';


/**
 * 出错时给人看的一句。
 * @param error 接口抛的错。
 */
function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;

  return String(error);
}


/**
 * 人或群的叫法：群写“群”，人写“人”。
 * @param group 是不是群。
 * @param t 翻译。
 */
function getKindText(group: boolean, t: i18n.Translate): string {
  if (group) return t('群');

  return t('人');
}


/** “目录授权”分类。 */
export function Grants(): react.JSX.Element {
  //M 取当前界面语言的翻译函数。
  const t = i18n.useT();
  /** 已有的授权、最近说过话的人和群。 */
  const [items, setItems] = react.useState<api.GrantItem[]>([]);
  const [seen, setSeen] = react.useState<api.GrantSeen[]>([]);
  /** 正在填的：谁（身份）、目录。 */
  const [subject, setSubject] = react.useState('');
  const [dir, setDir] = react.useState('');
  /** 正在提交、出错的原因。 */
  const [busy, setBusy] = react.useState(false);
  const [error, setError] = react.useState('');

  /** 取一次清单。 */
  const load = react.useCallback(async (): Promise<void> => {
    try {
      //M 拉取授权清单和最近见过的人、群。
      const answer = await api.grants();
      setItems(answer.items);
      setSeen(answer.seen);
      setError('');
    } catch (caught) {
      //G 取不到（后端没挂 approval、连不上）：把原因显示在错误条里。
      setError(getErrorText(caught));
    }
  }, []);

  //M 打开这个分类时取一次。
  react.useEffect(() => {
    void load();
  }, [load]);

  /** 加一条：名字用挑中的人或群的名字，手填的身份就用身份本身。 */
  const add = async (): Promise<void> => {
    setBusy(true);
    try {
      const written = subject.trim();
      const picked = seen.find((item) => item.subject === written);
      let label = written;
      if (picked !== undefined) {
        label = picked.label;
      }

      //M 提交后清空目录框，再取一次清单。
      await api.addGrant({ subject: written, label, dir: dir.trim() });
      setDir('');
      await load();
    } catch (caught) {
      //G 目录写错（不是绝对路径、没有这个目录）：后端回 400，原因写在错误条里。
      setError(getErrorText(caught));
    } finally {
      setBusy(false);
    }
  };

  /** 撤一条。 */
  const remove = async (id: number): Promise<void> => {
    try {
      //M 撤完再取一次清单。
      await api.removeGrant(id);
      await load();
    } catch (caught) {
      setError(getErrorText(caught));
    }
  };

  /** 挑人下拉框：最近说过话的人和群，显示“群 · 名字”。 */
  const options = seen.map((item) => {
    const kind = getKindText(item.group, t);
    return { value: item.subject, label: `${kind} · ${item.label}` };
  });

  /** 授权表格的列。 */
  const columns: antd.TableColumnsType<api.GrantItem> = [
    { title: t('谁'), render: (_, item) => `${getKindText(item.group, t)} · ${item.label}` },
    { title: t('目录'), dataIndex: 'dir' },
    {
      title: '',
      render: (_, item) => (
        <antd.Popconfirm title={t('撤掉这条授权？')} okText={t('撤掉')} cancelText={t('取消')} onConfirm={() => void remove(item.id)}>
          <antd.Button size="small" danger>
            {t('撤掉')}
          </antd.Button>
        </antd.Popconfirm>
      ),
    },
  ];

  /** 两项都填了才能加。 */
  const ready = subject.trim() !== '' && dir.trim() !== '';

  //M 渲染“目录授权”：上面填谁和目录，下面列已有的授权。
  return (
    <div className="jm-section">
      <fields.Row
        label={t('人或群')}
        hint={t('从最近说过话的人和群里挑；也可以直接填身份（飞书人 feishu:ou_…，群 feishu:group:oc_…）')}
      >
        <antd.AutoComplete
          value={subject}
          options={options}
          onChange={(value: string) => setSubject(value)}
          placeholder={t('挑一个，或填身份')}
          style={{ width: '100%' }}
        />
      </fields.Row>
      <fields.Row
        label={t('目录')}
        hint={t('绝对路径。这个目录和下面的子目录里读写、跑命令、发文件都不用再问你；出了这个目录照旧')}
      >
        <antd.Input value={dir} onChange={(event) => setDir(event.target.value)} placeholder={t('绝对路径')} />
      </fields.Row>
      <antd.Button type="primary" loading={busy} disabled={!ready} onClick={() => void add()}>
        {t('加上授权')}
      </antd.Button>
      {error !== '' && <antd.Alert type="error" showIcon message={error} />}
      <antd.Table size="small" rowKey="id" pagination={false} columns={columns} dataSource={items} />
    </div>
  );
}
