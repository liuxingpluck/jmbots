/**
 * 左栏（docs/界面/01_界面设计.md 第 6 节）：有几个机器人列几个，每个一张小卡片（头像、醒目的名字、可爱的状态框）；
 * 点卡片换机器人并在右栏打开它的工作区（详情还在右栏标签栏里）；左下角是设置入口。连不上后端时状态一律显示休假中；一个机器人都还没拿到时，显示一张“休假中”的空卡片。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as sprite from './Sprite.tsx';
import * as statusModule from './Status.ts';
import * as connections from './Connections.tsx';
import * as runningList from './RunningList.tsx';
import * as updateEntry from './UpdateEntry.tsx';
import * as api from '../Api.ts';
import type * as types from '../Types.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';


/**
 * 一个机器人的卡片。
 * @param props bot 机器人（还没拿到时是 undefined）；name 名字；online 连得上吗；selected 是不是正在聊的；onSelect 点了。
 */
function BotCard(props: { bot: types.BotView | undefined; name: string; online: boolean; selected: boolean; onSelect: () => void }): react.JSX.Element {
  const t = i18n.useT();
  /** 显示的状态。 */
  const status = statusModule.shownStatus(props.online, props.bot);
  return (
    <button type="button" className={props.selected ? 'jm-bot-card jm-selected' : 'jm-bot-card'} onClick={props.onSelect} aria-pressed={props.selected}>
      <sprite.Avatar name={props.name} size={44} />
      <span className="jm-bot-text">
        <span className="jm-bot-name">{props.name}</span>
        <sprite.StatusPill status={status} detail={statusModule.statusShort(status, props.bot, t)} title={statusModule.statusDetail(status, props.bot, t)} />
      </span>
    </button>
  );
}


/** 左栏。 */
export function BotList(): react.JSX.Element {
  const t = i18n.useT();
  /** 后端的版本号（设置那一行右边的小字，用户 11-06 要的）。 */
  const [version, setVersion] = react.useState('');
  react.useEffect(() => {
    void api.uiInfo().then((info) => setVersion(info.version ?? ''), () => undefined);
  }, []);
  /** 机器人。 */
  const bots = context.useUi((state) => state.bots);
  /** 连得上吗（还没问过算连得上，免得一打开就闪“休假中”）。 */
  const online = context.useUi((state) => state.online) !== false;
  /** 正在聊的。 */
  const current = context.useUi((state) => state.currentBot);
  /** 换机器人、开工作区、开设置。 */
  const selectBot = context.useUi((state) => state.selectBot);
  const openPanel = context.useUi((state) => state.openPanel);
  const setSettingsOpen = context.useUi((state) => state.setSettingsOpen);
  /** 左上角的搜索和新建机器人（docs/界面/01_界面设计.md 6.1、6.2）。 */
  const setSearchOpen = context.useUi((state) => state.setSearchOpen);
  const setNewBotOpen = context.useUi((state) => state.setNewBotOpen);
  return (
    <div className="jm-left-inner">
      <header className="jm-brand">
        <span>jmbots</span>
        <antd.Tooltip title={t('新建机器人')}>
          <antd.Button type="text" size="small" className="jm-brand-add" aria-label={t('新建机器人')} icon={<icons.PlusOutlined />} onClick={() => setNewBotOpen(true)} />
        </antd.Tooltip>
      </header>
      <button type="button" className="jm-search-entry" onClick={() => setSearchOpen(true)}>
        <icons.SearchOutlined />
        <span>{t('搜索（Ctrl+K）')}</span>
      </button>
      <div className="jm-bot-list">
        {bots.map((bot) => (
          <BotCard
            key={bot.name}
            bot={bot}
            name={bot.name}
            online={online}
            selected={bot.name === current}
            onSelect={() => {
              //M 点没选中的先换机器人；点哪个都在右栏打开它的工作区（详情还在右栏标签栏里，G批设计 7.6）。
              if (bot.name !== current) {
                selectBot(bot.name);
              }
              openPanel('workspace');
            }}
          />
        ))}
        {bots.length === 0 && <BotCard bot={undefined} name={t('机器人')} online={false} selected={false} onSelect={() => undefined} />}
        <runningList.RunningList />
      </div>
      <updateEntry.UpdateEntry />
      <button type="button" className="jm-settings-entry" onClick={() => setSettingsOpen(true)}>
        <icons.SettingOutlined />
        <span>{t('设置')}</span>
        <connections.Connections />
        {version && <span className="jm-version">v{version}</span>}
      </button>
    </div>
  );
}
