/**
 * 外置微信客服页自包含的多语言词条表与偏好解析（无外部 `../../web/` 依赖）。
 */


/** 外置客服页支持的界面语言标识。 */
export type Language = 'zh-CN' | 'zh-TW' | 'en' | 'fr';

/** 浏览器本地存储里共用的界面语言偏好键。 */
const LANGUAGE_KEY = 'jmbots.lang';

const zh = {
  title: '积木客服',
  legacy: '旧客服入口',
  connected: '外置程序已连接',
  offline: '外置程序离线',
  connectionError: '无法读取外置程序状态',
  connecting: '正在连接外置程序…',
  refresh: '刷新',
  mask: '演示打码',
  maskedText: '（已打码）',
  voiceUnplayable: '音频无法播放',
  account: '微信账号',
  noAccount: '没有已连接的微信账号',
  watch: '监听名单',
  noWatch: '暂无监听会话',
  chats: '会话',
  search: '搜索会话',
  noChats: '暂无会话',
  watching: '监听中',
  startWatch: '加入监听',
  stopWatch: '取消监听',
  chooseChat: '选择会话查看消息',
  noMessages: '暂无聊天记录',
  image: '图片',
  imageUnavailable: '图片无法显示',
  suggestions: 'AI 建议',
  noSuggestions: '暂无建议',
  makeDraft: '让 AI 起草建议',
  drafting: '正在起草…',
  draftFailed: '起草失败',
  copy: '复制',
  copied: '已复制',
  copyFailed: '复制失败，请手动选中',
  loadFailed: '读取失败',
  watchFailed: '更新监听失败',
} as const;

type Label = keyof typeof zh;

const packs: Partial<Record<Language, Record<Label, string>>> = {
  en: {
    title: 'WeChat support',
    legacy: 'Previous support page',
    connected: 'External program connected',
    offline: 'External program offline',
    connectionError: 'Unable to read program status',
    connecting: 'Connecting to external program…',
    refresh: 'Refresh',
    mask: 'Mask for demo',
    maskedText: '(Masked)',
    voiceUnplayable: 'Audio unavailable',
    account: 'WeChat account',
    noAccount: 'No connected WeChat account',
    watch: 'Watched chats',
    noWatch: 'No watched chats',
    chats: 'Chats',
    search: 'Search chats',
    noChats: 'No chats',
    watching: 'Watching',
    startWatch: 'Watch chat',
    stopWatch: 'Stop watching',
    chooseChat: 'Select a chat to see its messages',
    noMessages: 'No messages',
    image: 'Image',
    imageUnavailable: 'Image unavailable',
    suggestions: 'AI suggestions',
    noSuggestions: 'No suggestions yet',
    makeDraft: 'Draft an AI suggestion',
    drafting: 'Drafting…',
    draftFailed: 'Unable to draft',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Unable to copy. Select the text to copy it.',
    loadFailed: 'Unable to load',
    watchFailed: 'Unable to update watched chat',
  },
  'zh-TW': {
    title: '積木客服',
    legacy: '舊客服入口',
    connected: '外部程式已連線',
    offline: '外部程式離線',
    connectionError: '無法讀取外部程式狀態',
    connecting: '正在連線至外部程式…',
    refresh: '重新整理',
    mask: '示範遮罩',
    maskedText: '（已打碼）',
    voiceUnplayable: '音訊無法播放',
    account: '微信帳號',
    noAccount: '沒有已連線的微信帳號',
    watch: '監聽清單',
    noWatch: '暫無監聽對話',
    chats: '對話',
    search: '搜尋對話',
    noChats: '暫無對話',
    watching: '監聽中',
    startWatch: '加入監聽',
    stopWatch: '取消監聽',
    chooseChat: '選擇對話以檢視訊息',
    noMessages: '暫無聊天記錄',
    image: '圖片',
    imageUnavailable: '無法顯示圖片',
    suggestions: 'AI 建議',
    noSuggestions: '暫無建議',
    makeDraft: '讓 AI 起草建議',
    drafting: '正在起草…',
    draftFailed: '起草失敗',
    copy: '複製',
    copied: '已複製',
    copyFailed: '複製失敗，請手動選取文字',
    loadFailed: '讀取失敗',
    watchFailed: '更新監聽失敗',
  },
  fr: {
    title: 'Assistance WeChat',
    legacy: 'Ancienne page d’assistance',
    connected: 'Programme externe connecté',
    offline: 'Programme externe hors ligne',
    connectionError: 'État du programme indisponible',
    connecting: 'Connexion au programme externe…',
    refresh: 'Actualiser',
    mask: 'Masquer pour la démo',
    maskedText: '(Masqué)',
    voiceUnplayable: 'Audio indisponible',
    account: 'Compte WeChat',
    noAccount: 'Aucun compte WeChat connecté',
    watch: 'Conversations suivies',
    noWatch: 'Aucune conversation suivie',
    chats: 'Conversations',
    search: 'Rechercher une conversation',
    noChats: 'Aucune conversation',
    watching: 'Suivie',
    startWatch: 'Suivre',
    stopWatch: 'Ne plus suivre',
    chooseChat: 'Sélectionnez une conversation pour voir ses messages',
    noMessages: 'Aucun message',
    image: 'Image',
    imageUnavailable: 'Image indisponible',
    suggestions: 'Suggestions de l’IA',
    noSuggestions: 'Aucune suggestion',
    makeDraft: 'Créer une suggestion',
    drafting: 'Rédaction…',
    draftFailed: 'Rédaction impossible',
    copy: 'Copier',
    copied: 'Copié',
    copyFailed: 'Copie impossible. Sélectionnez le texte.',
    loadFailed: 'Chargement impossible',
    watchFailed: 'Impossible de modifier le suivi',
  },
};


/**
 * 将查询参数或浏览器语言代码匹配为受支持的语言枚举。
 * @param raw 原始语言标识。
 */
export function matchLanguage(raw: string | null | undefined): Language | undefined {
  if (!raw) return undefined;

  const lower = raw.trim().toLowerCase();
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant') return 'zh-TW';
  if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh-hans') return 'zh-CN';
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  if (lower === 'fr' || lower.startsWith('fr-')) return 'fr';
  return undefined;
}


/**
 * 按地址栏 `?lang=` 或本地存储偏好返回当前客服页词条表。
 */
export function getLabels(): Record<Label, string> {
  try {
    const params = new URLSearchParams(window.location.search);
    //M 地址栏指定的语言优先级最高。
    const explicit = matchLanguage(params.get('lang'));
    if (explicit !== undefined) return packs[explicit] ?? zh;

    const stored = matchLanguage(window.localStorage.getItem(LANGUAGE_KEY));
    if (stored !== undefined) return packs[stored] ?? zh;
  } catch {
    return zh;
  }
  return zh;
}
