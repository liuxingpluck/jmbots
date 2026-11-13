/**
 * 往渠道发东西的接口（docs/10 6.2）：只有类型，没有函数。渠道在最上层，下层要发消息、发卡片、发云文档都经 `Outlet`，
 * 不 import 渠道；渠道中心 ChannelHub（src/channels/index.ts）实现它，入口 src/entries/App.ts 最先建好，要发东西的对象构造时就拿着它。
 * 原来这里还有一包 `Deps`（各个模块从里面取东西），0.4.7 起各个类需要谁传谁，这一包删了；测试里那一包是 tests/Builders.ts 的 TestDeps。
 */
import type * as approvalsModule from './Approvals.ts';
import type * as progressModule from './Progress.ts';


/** 发一篇飞书云文档要给的东西。 */
export interface DocRequest {
  /** 哪个机器人发的（消息不是飞书来的时候，用这个机器人的飞书应用）。 */
  bot: string;
  /** 标题。 */
  title: string;
  /** Markdown 正文。 */
  markdown: string;
  /** 放在正文最前面的图片（绝对路径），按顺序。 */
  images: string[];
}


/** 往渠道发东西（入口装进来，渠道实现）。 */
export interface Outlet {
  /** 发文字，文字里的 @路径 一起发（飞书：图片发图片、别的发附件；HTTP 只记录）。输入渠道、回复地址、文字；发不出去时抛错。 */
  send(channel: string, address: Record<string, unknown>, text: string): Promise<void>;
  /** 撤掉这条消息上的“正在输入”（飞书的敲键盘表情）；渠道没有这回事就什么也不做。输入渠道、回复地址。 */
  stopTyping?(channel: string, address: Record<string, unknown>): Promise<void>;
  /** 发审核卡片（同意执行 / 拒绝）：这个机器人所有能发卡片的渠道都发，消息来的渠道发到回复地址，别的发给最近私聊的人；onlyHere 时只发这个渠道（用户要再看一次）。输入渠道、回复地址、待确认；返回发出去的渠道名。 */
  sendApproval(channel: string, address: Record<string, unknown>, pending: approvalsModule.PendingApproval, onlyHere?: boolean): Promise<string[]>;
  /** 发飞书云文档，编辑权限给这个地址的发送人；返回链接说明。没开飞书时抛错。 */
  publishDoc(channel: string, address: Record<string, unknown>, request: DocRequest): Promise<string>;
  /** 把机器人自己发的云文档放进回收站；返回结果说明。没开飞书时抛错。 */
  deleteDoc(channel: string, bot: string, ids: string[]): Promise<string>;
  /** 各渠道连着没有（界面左下角的小圆点用）。 */
  channelStatus?(): { name: string; bot?: string; connected: boolean; detail: string }[];
  /** 运行时加一个渠道（网页新建机器人时绑飞书应用，docs/界面/01_界面设计.md 6.2）：照登记表建、连上、加进路由。输入渠道种类和这一份设置；连不上时抛错（渠道照样加进去，状态里看得到）。 */
  addChannel?(kind: string, settings: Record<string, unknown>): Promise<void>;
  /** 发进度卡片：返回渠道里那张卡片的号；渠道画不了卡片时返回 undefined。 */
  sendProgress?(channel: string, address: Record<string, unknown>, view: progressModule.ProgressView): Promise<string | undefined>;
  /** 原地改进度卡片。 */
  updateProgress?(channel: string, handle: string, view: progressModule.ProgressView): Promise<void>;
}
