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


/** 详情。 */
export function Details(): react.JSX.Element {
  const t = i18n.useT();
  /** 正在聊的机器人。 */
  const name = context.useUi((state) => state.currentBot);
  const bot = context.useUi((state) => state.bots.find((item) => item.name === state.currentBot));
  const online = context.useUi((state) => state.online) !== false;
  const openPanel = context.useUi((state) => state.openPanel);
  /** 目录、记忆概要。 */
  const [info, setInfo] = react.useState<api.BotInfo | null>(null);

  react.useEffect(() => {
    setInfo(null);
    if (name) {
      void api.botInfo(name).then(setInfo, () => setInfo(null));
    }
  }, [name]);

  if (!name) {
    return <div className="jm-empty">{t('还没有机器人')}</div>;
  }
  return (
    <div className="jm-details">
      <header className="jm-details-head">
        <sprite.Avatar name={name} size={56} />
        <div>
          <div className="jm-details-name">{name}</div>
          <sprite.StatusPill status={statusModule.shownStatus(online, bot)} detail={statusModule.statusShort(statusModule.shownStatus(online, bot), bot, t)} />
        </div>
      </header>
      <dl className="jm-preview-facts">
        <dt>{t('语言')}</dt>
        <dd>{bot?.language ?? info?.language ?? ''}</dd>
        <dt>{t('目录')}</dt>
        <dd>{info?.paths.botDir ?? ''}</dd>
      </dl>
      <h4 className="jm-details-title">
        {t('记忆概要')}
        {info && (
          <antd.Button type="link" size="small" onClick={() => openPanel('preview', { path: `${info.paths.memoryDir}${info.paths.memoryDir.includes('\\') ? '\\' : '/'}${info.language === 'en' ? 'index.md' : '索引.md'}`, name: t('记忆概要') })}>
            {t('在预览里看')}
          </antd.Button>
        )}
      </h4>
      {info ? <markdown.Markdown text={info.memoryIndex} onOpen={() => undefined} /> : <antd.Spin />}
    </div>
  );
}