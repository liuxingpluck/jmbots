/**
 * 内容区顶上的渠道标签栏与聊天下拉：默认显示「全部」，按 GET /api/channels 列出各渠道；
 * 每个渠道标签可下拉搜索并虚拟滚动选择具体群或私聊，并把选中状态同步到网址 ?channel=&chat=。
 */
import * as icons from '@ant-design/icons';
import * as react from 'react';
import * as virtuoso from 'react-virtuoso';
import * as api from '../Api.ts';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';
import * as timeline from './Timeline.ts';
import './ChannelTabs.css';
import type * as types from '../Types.ts';


/** 渠道下拉列表一行的预估高度，像素。 */
const CHAT_ROW_HEIGHT = 36;

/** 渠道下拉虚拟列表最大高度，像素。 */
const CHAT_LIST_MAX_HEIGHT = 240;


/** 网页当前正在查看的渠道与聊天。 */
export interface ChannelViewState {
  /** 渠道基础名：空串表示全部。 */
  channel: string;
  /** 具体聊天标识：空串表示该渠道全部聊天。 */
  chat: string;
  /** 给横幅和胶囊展示用的可读聊天名。 */
  chatLabel: string;
}

/** 渠道下单个聊天的摘要。 */
export interface ChannelChatItem {
  /** 聊天唯一标识。 */
  id: string;
  /** 去掉冗余前缀后的展示名。 */
  label: string;
  /** 消息条数（已知时显示）。 */
  count: number;
  /** 最近一条消息时间，毫秒。 */
  updatedAt: number;
}

/** 单个渠道标签的汇总。 */
export interface ChannelSummaryItem {
  /** 渠道 ID（如 http、feishu、wechat、cli）。 */
  id: string;
  /** 显示名。 */
  label: string;
  /** 消息总条数。 */
  count: number;
  /** 最近活跃时间，毫秒。 */
  updatedAt: number;
  /** 该渠道下的具体群/私聊列表。 */
  chats: ChannelChatItem[];
}

/** GET /api/channels 返回体（对应 src7/plugins/web-api/Timeline.ts:430, 581）。 */
export interface ChannelsResponse {
  /** 当前挂着的渠道清单及各渠道下的聊天摘要（新的在前）。 */
  channels: ChannelSummaryItem[];
}

/** GET /api/messages 与 /api/messages/resolve 单条消息附带的聊天字段（对应 web-api/Timeline.ts:394-395）。 */
export interface ChannelMessageFields {
  /** 属于哪个聊天（飞书 chatId、微信 chat、命令行 cli:本机、网页 http:本机）。 */
  chat?: string;
  /** 聊天展示名（如 飞书·群·客户外部群、网页）。 */
  chatLabel?: string;
}

/** ChannelTabs 组件的属性。 */
interface ChannelTabsProps {
  /** 当前选中的机器人名。 */
  bot: string;
  /** 当前选中的渠道与聊天视图。 */
  value: ChannelViewState;
  /** 切换渠道或具体聊天时回调。 */
  onChange: (next: ChannelViewState) => void;
}


/** 取渠道的基础前缀（如 feishu:app1 → feishu）。 */
function getBaseChannel(channelId: string): string {
  const head = channelId.split(':')[0];
  if (head !== undefined) return head;

  return channelId;
}


/**
 * 根据渠道 ID 取显示名。
 * @param channelId 渠道基础 ID。
 * @param t 翻译函数。
 * @returns 翻译后的渠道显示名；未匹配已知渠道时原样返回 channelId。
 */
export function getChannelName(channelId: string, t: i18n.Translate = i18n.source): string {
  //M 剥离应用后缀（如 feishu:app1 → feishu）后再映射本地化渠道名称。
  const base = getBaseChannel(channelId);
  if (base === '') return t('全部');

  if (base === 'http') return t('网页');

  if (base === 'feishu') return t('飞书');

  if (base === 'wechat') return t('微信');

  if (base === 'cli') return t('命令行');

  //M 用网页标签的本地化名字显示语音渠道。
  if (base === 'voice') return t('语音');

  return channelId;
}


/**
 * 从后端返回的对话展示名里去掉重复的渠道前缀（如「飞书·群·客户外部群」→「群·客户外部群」）。
 * @param rawLabel 原始聊天名。
 * @param channelId 渠道基础 ID。
 * @returns 去掉冗余渠道前缀后的简短聊天名。
 */
export function getChatShortLabel(rawLabel: string, channelId: string): string {
  //M 先提取基础渠道名，只剔除对应渠道自身的重复前缀。
  const base = getBaseChannel(channelId);
  if (base === 'feishu' && rawLabel.startsWith('飞书·')) return rawLabel.slice('飞书·'.length);

  if (base === 'wechat' && rawLabel.startsWith('微信·')) return rawLabel.slice('微信·'.length);

  return rawLabel;
}


/**
 * 从 URL 查询串里读当前渠道与聊天参数。
 * @returns 网址中的 channel 与 chat 参数；非浏览器环境或未指定渠道时两者均为空串。
 */
export function getChannelViewFromUrl(): { channel: string; chat: string } {
  if (typeof window === 'undefined') return { channel: '', chat: '' };

  //M 从地址栏查询串提取初始渠道与聊天筛选条件。
  const params = new URLSearchParams(window.location.search);
  const channel = (params.get('channel') ?? '').trim();
  const chat = (params.get('chat') ?? '').trim();
  if (!channel) return { channel: '', chat: '' };

  return { channel, chat };
}


/**
 * 把选中的渠道与聊天写回地址栏（保留其它查询参数），只在实际变化时推进历史记录。
 * @param channel 渠道 ID，空串清除。
 * @param chat 聊天 ID，空串清除。
 * @returns 无返回值。
 * 副作用：查询参数与当前地址不一致时调用 window.history.pushState 更新浏览器历史记录。
 */
export function writeChannelViewToUrl(channel: string, chat: string): void {
  if (typeof window === 'undefined') return;

  const url = new URL(window.location.href);
  if (channel) {
    url.searchParams.set('channel', channel);
  }
  if (!channel) {
    url.searchParams.delete('channel');
  }
  if (channel && chat) {
    url.searchParams.set('chat', chat);
  }
  if (!channel || !chat) {
    url.searchParams.delete('chat');
  }
  const nextHref = `${url.pathname}${url.search}${url.hash}`;
  const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextHref === currentHref) return;

  window.history.pushState(null, '', nextHref);
}


/**
 * 判断一条消息是否匹配当前选中的渠道与具体聊天（供跨视图补取按号核对边界）。
 * @param message 消息对象。
 * @param channel 渠道过滤，空串或 undefined 不过滤。
 * @param chat 聊天过滤，空串或 undefined 不过滤。
 * @returns 消息属于指定渠道和聊天时返回 true，否则返回 false。
 */
export function matchesChannelView(
  message: types.MessageView & ChannelMessageFields,
  channel?: string,
  chat?: string,
): boolean {
  //G 先剥离渠道实例后缀核对基础渠道，不匹配当前渠道筛选则直接排除。
  const base = getBaseChannel(message.channel);
  if (channel && base !== channel) return false;

  if (!chat) return true;

  //G 直接比对后端返回的标准聊天号 chat。
  return message.chat === chat;
}


/**
 * 按后端 GET /api/channels 标准响应结构映射渠道摘要列表，并对聊天展示名去冗余前缀。
 * @param response 后端返回的 { channels } 对象。
 * @param t 翻译函数。
 * @throws 当 response.channels 不是数组时抛出错误。
 */
function getChannelsFromResponse(response: ChannelsResponse, t: i18n.Translate): ChannelSummaryItem[] {
  if (!Array.isArray(response.channels)) {
    throw new Error(t('渠道列表格式错误'));
  }
  const result: ChannelSummaryItem[] = [];
  for (const channel of response.channels) {
    //M 归一化渠道 ID，优先使用前端已知译名，未知渠道沿用后端给的显示名。
    const baseId = getBaseChannel(channel.id);
    let label = getChannelName(baseId, t);
    if (label === baseId && channel.label) {
      label = channel.label;
    }
    const chats: ChannelChatItem[] = [];
    for (const chatItem of channel.chats) {
      //M 后端用同一个语音渠道名描述各浏览器，在下拉里用聊天号区分。
      let chatLabel = getChatShortLabel(chatItem.label, baseId);
      if (baseId === 'voice') {
        chatLabel = chatItem.id.slice(0, 8);
      }
      //M 把可读聊天标签和完整筛选号都保留给下拉菜单。
      chats.push({
        id: chatItem.id,
        label: chatLabel,
        count: chatItem.count,
        updatedAt: chatItem.updatedAt,
      });
    }
    result.push({
      id: baseId,
      label,
      count: channel.count,
      updatedAt: channel.updatedAt,
      chats,
    });
  }
  return result;
}


/** 按钮或选项拼类名，避免在 JSX 里写三目表达式。 */
function getClassName(base: string, active: boolean, extraClass: string): string {
  if (active) return `${base} ${extraClass}`;

  return base;
}


/**
 * 内容区顶上的渠道标签条：支持按渠道筛、按具体群/私聊下拉筛选，并搜索虚拟滚动长列表。
 * @param props 组件属性，包含当前机器人名、选中渠道与聊天状态以及切换回调 onChange。
 * @returns 渠道标签栏与聊天下拉弹窗的 JSX 元素。
 * 副作用：请求 GET /api/channels 加载渠道与聊天列表、监听全局点击与 Esc 关闭下拉，并在渠道列表就绪后回写 chatLabel。
 */
export function ChannelTabs(props: ChannelTabsProps): react.JSX.Element {
  //M 订阅界面翻译与演示打码状态；初始清单为空，请求失败时直接显示错误提示。
  const t = i18n.useT();
  const masked = privacy.useMask();
  const [channels, setChannels] = react.useState<ChannelSummaryItem[]>([]);
  const [loadError, setLoadError] = react.useState('');
  const [openChannelId, setOpenChannelId] = react.useState<string | null>(null);
  const [search, setSearch] = react.useState('');
  const rootRef = react.useRef<HTMLDivElement>(null);
  const onChangeRef = react.useRef(props.onChange);
  onChangeRef.current = props.onChange;

  //M 切换机器人或语言时重新请求 GET /api/channels，失败就写明错误提示。
  react.useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        //M 按当前机器人请求标准渠道清单接口。
        const raw = await api.getJson<ChannelsResponse>(`/api/channels?bot=${encodeURIComponent(props.bot)}`);
        if (cancelled) return;

        //M 校验并将后端渠道清单转换为界面摘要结构，清除旧错误提示。
        const items = getChannelsFromResponse(raw, t);
        setChannels(items);
        setLoadError('');
      } catch (error) {
        if (cancelled) return;

        //G 接口报错或返回异常结构时清空渠道列表，并把原因直接展示给用户。
        let reason = String(error);
        if (error instanceof Error && error.message !== '') {
          reason = error.message;
        }
        setChannels([]);
        setLoadError(t('加载渠道列表失败：{reason}', { reason }));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [props.bot, t]);

  //M 换机器人时收起已打开的下拉面板。
  react.useEffect(() => {
    setOpenChannelId(null);
    setSearch('');
  }, [props.bot]);

  //M 从地址栏恢复 chat 参数时，渠道列表就绪后补上友好的 chatLabel 传给横幅。
  react.useEffect(() => {
    if (!props.value.channel || !props.value.chat) return;

    const owner = channels.find((item) => item.id === props.value.channel);
    const matched = owner?.chats.find((item) => item.id === props.value.chat);
    if (!matched || matched.label === props.value.chatLabel) return;

    onChangeRef.current({ channel: props.value.channel, chat: props.value.chat, chatLabel: matched.label });
  }, [channels, props.value.channel, props.value.chat, props.value.chatLabel]);

  //M 点击外部区域或按 Escape 关闭聊天下拉。
  react.useEffect(() => {
    if (!openChannelId) return undefined;

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (rootRef.current && target instanceof Node && !rootRef.current.contains(target)) {
        setOpenChannelId(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpenChannelId(null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openChannelId]);

  const keyword = search.trim().toLowerCase();

  /** 选某个渠道的主点击行为：不同渠道直接切过去看全部，已在当前渠道就展开/收起下拉。 */
  const onClickChannel = (channelId: string): void => {
    if (props.value.channel !== channelId) {
      //M 切到未选中的渠道时先清空具体聊天并收起下拉，再通知外层更新当前渠道筛选。
      props.onChange({ channel: channelId, chat: '', chatLabel: '' });
      setOpenChannelId(null);
      setSearch('');
      return;
    }
    if (openChannelId === channelId) {
      setOpenChannelId(null);
      return;
    }
    setOpenChannelId(channelId);
    setSearch('');
  };

  /** 点右侧箭头单独展开/收起指定渠道的聊天下拉。 */
  const onToggleDropdown = (channelId: string): void => {
    if (openChannelId === channelId) {
      setOpenChannelId(null);
      return;
    }
    setOpenChannelId(channelId);
    setSearch('');
  };

  //M 渲染「全部」渠道胶囊、失败提示以及各渠道标签与聊天下拉弹窗，点击「全部」时重置筛选条件。
  return (
    <div ref={rootRef} className="jm-channel-tabs jm-channel-filter" role="tablist" aria-label={t('按渠道筛选消息')}>
      <div className={getClassName('jm-channel-pill', props.value.channel === '', 'is-active')}>
        <button
          type="button"
          role="tab"
          aria-selected={props.value.channel === ''}
          className="jm-channel-tab-btn"
          onClick={() => {
            setOpenChannelId(null);
            setSearch('');
            props.onChange({ channel: '', chat: '', chatLabel: '' });
          }}
        >
          {t('全部')}
        </button>
      </div>

      {loadError !== '' && (
        <span className="jm-channel-error" role="alert">
          {loadError}
        </span>
      )}

      {channels.map((item) => {
        const active = props.value.channel === item.id;
        const expanded = openChannelId === item.id;
        //M 当前渠道已选中具体聊天时生成副标题；缺少可读名称时对 chat 裁剪渠道前缀兜底。
        let subLabel = '';
        if (active && props.value.chat) {
          subLabel = props.value.chatLabel || getChatShortLabel(props.value.chat, item.id);
        }
        const filteredChats = item.chats.filter((chatItem) => {
          if (!keyword) return true;

          return chatItem.label.toLowerCase().includes(keyword) || chatItem.id.toLowerCase().includes(keyword);
        });
        const listHeight = Math.min(CHAT_LIST_MAX_HEIGHT, Math.max(CHAT_ROW_HEIGHT, filteredChats.length * CHAT_ROW_HEIGHT));

        //M 渲染单个渠道胶囊（含激活态、打码副标题、点击与下拉箭头事件），以及按渠道命名的展开弹窗。
        return (
          <div key={item.id} className={getClassName('jm-channel-pill has-dropdown', active, 'is-active')} data-channel={item.id}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="jm-channel-tab-btn"
              onClick={() => onClickChannel(item.id)}
            >
              <span>{getChannelName(item.id, t) || item.label}</span>
              {item.count > 0 && <span className="jm-channel-tab-count">{item.count}</span>}
              {subLabel && <span className="jm-channel-tab-sub">· {privacy.name(subLabel, masked)}</span>}
            </button>
            <button
              type="button"
              className="jm-channel-tab-arrow"
              aria-label={t('选择 {channel} 的聊天', { channel: getChannelName(item.id, t) || item.label })}
              aria-expanded={expanded}
              onClick={() => onToggleDropdown(item.id)}
            >
              <icons.DownOutlined />
            </button>

            {expanded && (
              //M 展开下拉后渲染搜索输入框、「全部聊天」重置按钮以及虚拟滚动聊天列表。
              <div className="jm-channel-dropdown" role="dialog" aria-label={t('{channel} 聊天列表', { channel: getChannelName(item.id, t) })}>
                <input
                  type="text"
                  className="jm-channel-search"
                  placeholder={t('搜索聊天…')}
                  value={search}
                  autoFocus
                  onChange={(event) => setSearch(event.target.value)}
                />
                <button
                  type="button"
                  className={getClassName('jm-channel-chat-item jm-channel-chat-all', active && !props.value.chat, 'is-selected')}
                  onClick={() => {
                    props.onChange({ channel: item.id, chat: '', chatLabel: '' });
                    setOpenChannelId(null);
                  }}
                >
                  <span className="jm-channel-chat-name">{t('全部聊天')}</span>
                  {item.count > 0 && <span className="jm-channel-chat-meta">{item.count}</span>}
                </button>
                {filteredChats.length === 0 && <div className="jm-channel-chat-empty">{t('暂无聊天记录')}</div>}
                {filteredChats.length > 0 && (
                  <div className="jm-channel-chat-list" style={{ height: listHeight }}>
                    <virtuoso.Virtuoso
                      style={{ height: listHeight }}
                      data={filteredChats}
                      itemContent={(_, chatItem) => {
                        const selected = active && props.value.chat === chatItem.id;
                        //M 仅在消息条数或最近活跃时间有效时格式化副信息文本，缺省项留空。
                        let metaText = '';
                        if (chatItem.count > 0 && chatItem.updatedAt > 0) {
                          metaText = `${chatItem.count} · ${timeline.formatTime(chatItem.updatedAt)}`;
                        }
                        if (chatItem.count > 0 && chatItem.updatedAt <= 0) {
                          metaText = String(chatItem.count);
                        }
                        if (chatItem.count <= 0 && chatItem.updatedAt > 0) {
                          metaText = timeline.formatTime(chatItem.updatedAt);
                        }
                        //M 渲染单条聊天按钮，选中态高亮并在点击后切换到该聊天并收起下拉。
                        return (
                          <button
                            type="button"
                            className={getClassName('jm-channel-chat-item', selected, 'is-selected')}
                            onClick={() => {
                              props.onChange({ channel: item.id, chat: chatItem.id, chatLabel: chatItem.label });
                              setOpenChannelId(null);
                            }}
                          >
                            <span className="jm-channel-chat-name">{
                              //M 对聊天名称做演示打码保护后再显示，避免暴露真实人名或群名。
                              privacy.name(chatItem.label, masked)
                            }</span>
                            {metaText && <span className="jm-channel-chat-meta">{metaText}</span>}
                          </button>
                        );
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
