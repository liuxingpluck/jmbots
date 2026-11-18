/**
 * 右栏的“详情”（docs/界面/01_界面设计.md 第 9 节）：头像、名字、状态、语言、目录、记忆概要（memory/索引.md）。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as sprite from '../Bots/Sprite.tsx';
import * as statusModule from '../Bots/Status.ts';
import * as markdown from '../Chat/Markdown.tsx';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as vscodeLink from '../VscodeLink.tsx';


/**
 * 右栏“详情”标签页：展示当前机器人的头像、状态、语言、目录及记忆概要（memory/索引.md）。
 * @returns 机器人详情面板；尚未选中机器人时返回空状态提示节点。
 * 副作用：订阅当前机器人与在线状态；切换机器人时发起 `api.botInfo` 请求更新本地状态，点击按钮时打开右栏预览页签。
 */
export function Details(): react.JSX.Element {
  //M 取当前语言翻译函数，用于格式化字段标签、空状态与预览标签名。
  const t = i18n.useT();
  /** 正在聊的机器人。 */
  //M 从全局 UI 状态订阅当前机器人名称、配置、在线状态与面板跳转方法，供详情展示与跳转使用。
  const name = context.useUi((state) => state.currentBot);
  const bot = context.useUi((state) => state.bots.find((item) => item.name === state.currentBot));
  const online = context.useUi((state) => state.online) !== false;
  const openPanel = context.useUi((state) => state.openPanel);
  /** 目录、记忆概要。 */
  const [info, setInfo] = react.useState<api.BotInfo | null>(null);

  react.useEffect(() => {
    setInfo(null);
    if (name) {
      //M 切换机器人后请求目录与记忆概要，失败时清空旧数据避免串台。
      void api.botInfo(name).then(setInfo, () => setInfo(null));
    }
  }, [name]);

  if (!name) {
    return <div className="jm-empty">{t('还没有机器人')}</div>;
  }
  const hasMemoryIndex = Boolean(info && info.memoryIndex.trim() !== '');
  let memoryIndexView: react.ReactNode = <antd.Spin />;
  if (info && hasMemoryIndex) {
    memoryIndexView = <markdown.Markdown text={info.memoryIndex} onOpen={() => undefined} />;
  }
  if (info && !hasMemoryIndex) {
    memoryIndexView = <div className="jm-muted">{t('还没有记忆概要文件（memory/索引.md）')}</div>;
  }
  let botDirNode: react.ReactNode = '';
  if (info?.paths.botDir) {
    botDirNode = <vscodeLink.SiteLink site={info.paths.botDir} />;
  }
  //M 结合全局在线状态计算机器人实时展示状态，供状态胶囊与简短说明复用。
  const status = statusModule.getShownStatus(online, bot);
  //M 渲染详情头部、状态胶囊、属性及记忆概要。
  return (
    <div className="jm-details">
      <header className="jm-details-head">
        <sprite.Avatar name={name} size={56} />
        <div>
          <div className="jm-details-name">{name}</div>
          <sprite.StatusPill status={status} detail={statusModule.getStatusShort(status, bot, t)} />
        </div>
      </header>
      <dl className="jm-preview-facts">
        <dt>{t('语言')}</dt>
        <dd>{bot?.language ?? info?.language ?? ''}</dd>
        <dt>{t('目录')}</dt>
        <dd>{botDirNode}</dd>
      </dl>
      <h4 className="jm-details-title">
        {t('记忆概要')}
        {hasMemoryIndex && info && (
          <antd.Button type="link" size="small" onClick={() => {
            let sep = '/';
            if (info.paths.memoryDir.includes('\\')) {
              sep = '\\';
            }
            let fileName = '索引.md';
            if (info.language === 'en') {
              fileName = 'index.md';
            }
            //M 按运行环境路径分隔符与机器人语言拼接记忆概要文件绝对路径并在右栏预览中打开。
            openPanel('preview', { path: `${info.paths.memoryDir}${sep}${fileName}`, name: t('记忆概要') });
          }}>
            {t('在预览里看')}
          </antd.Button>
        )}
      </h4>
      {memoryIndexView}
    </div>
  );
}