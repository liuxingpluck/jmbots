/**
 * 说话的是谁（Message.ts 的 isOwnerTurn、getSpeakerRole、isGroup）：各渠道真实写法的地址逐个过一遍。
 * 地址照各渠道现在写的样子造（飞书 Inbound.ts、微信 getWechatAddress、网页 web-api、命令行 cli），用假身份。
 */
import { describe, expect, test } from 'bun:test';
import * as protocol from './index.ts';


/** 飞书私聊本人：飞书照 people 写 role 和 owner。 */
const FEISHU_OWNER_P2P = {
  appId: 'cli_test', chatId: 'oc_p2p', chatType: 'p2p', openId: 'ou_owner',
  customer: 'feishu:ou_owner', owner: true, role: 'owner',
};

/** 飞书群里本人。 */
const FEISHU_OWNER_GROUP = {
  appId: 'cli_test', chatId: 'oc_group', chatType: 'group', openId: 'ou_owner',
  customer: 'feishu:group:oc_group', owner: true, role: 'owner',
};

/** 飞书群里外人：没登记的人是 guest。 */
const FEISHU_GUEST_GROUP = {
  appId: 'cli_test', chatId: 'oc_group', chatType: 'group', openId: 'ou_friend',
  customer: 'feishu:group:oc_group', owner: false, role: 'guest',
};

/** 飞书群里登记了目录的 builder。 */
const FEISHU_BUILDER_GROUP = { ...FEISHU_GUEST_GROUP, role: 'builder', workspace: 'builder-dir' };

/** 微信：地址一律 owner: false，不写 role。 */
const WECHAT = { account: 'wxid_me', chat: 'wxid_customer', name: '客户', customer: 'wechat:wxid_customer', owner: false };

/** 网页：http 插件核过本机或令牌，写 owner: true。 */
const WEB = { messageId: 1, customer: 'http:本机', owner: true, verifiedOwner: true };

/** 命令行：只写 customer。 */
const CLI = { customer: 'cli:本机' };


describe('isOwnerTurn：谁是本人只在渠道协议里判', () => {
  test('飞书私聊本人、群里本人是本人', () => {
    expect(protocol.isOwnerTurn('feishu', FEISHU_OWNER_P2P)).toBe(true);
    expect(protocol.isOwnerTurn('feishu', FEISHU_OWNER_GROUP)).toBe(true);
  });

  test('飞书群里外人（guest、builder）不是本人', () => {
    expect(protocol.isOwnerTurn('feishu', FEISHU_GUEST_GROUP)).toBe(false);
    expect(protocol.isOwnerTurn('feishu', FEISHU_BUILDER_GROUP)).toBe(false);
  });

  test('微信一律外人：地址写的 owner: false，什么身份都没写也是外人', () => {
    expect(protocol.isOwnerTurn('wechat', WECHAT)).toBe(false);
    expect(protocol.isOwnerTurn('wechat', { customer: 'wechat:wxid_customer' })).toBe(false);
  });

  test('网页、命令行本机是本人；没有渠道的内部会话也是', () => {
    expect(protocol.isOwnerTurn('http', WEB)).toBe(true);
    expect(protocol.isOwnerTurn('cli', CLI)).toBe(true);
    expect(protocol.isOwnerTurn('web', {})).toBe(true);
    expect(protocol.isOwnerTurn(undefined, undefined)).toBe(true);
    expect(protocol.isOwnerTurn('', {})).toBe(true);
  });

  test('宁严勿松：别的渠道地址一个身份字段都没写，算外人；本机渠道写了 guest 也算外人', () => {
    expect(protocol.isOwnerTurn('feishu', { chatType: 'p2p', openId: 'ou_owner' })).toBe(false);
    expect(protocol.isOwnerTurn('cli', { role: 'guest' })).toBe(false);
    expect(protocol.isOwnerTurn('http', { owner: false })).toBe(false);
  });
});


describe('getSpeakerRole：地址上的档位', () => {
  test('飞书照 role；微信只写 owner: false 当 guest；本机没写是空串', () => {
    expect(protocol.getSpeakerRole(FEISHU_OWNER_P2P)).toBe('owner');
    expect(protocol.getSpeakerRole(FEISHU_GUEST_GROUP)).toBe('guest');
    expect(protocol.getSpeakerRole(FEISHU_BUILDER_GROUP)).toBe('builder');
    expect(protocol.getSpeakerRole(WECHAT)).toBe('guest');
    expect(protocol.getSpeakerRole(CLI)).toBe('');
    expect(protocol.getSpeakerRole(WEB)).toBe('');
  });
});


describe('isGroup：是不是群', () => {
  test('飞书群按 chatType 认；点卡片时 chatType 空，按客户号 feishu:group: 认', () => {
    expect(protocol.isGroup(FEISHU_OWNER_GROUP)).toBe(true);
    expect(protocol.isGroup({ chatType: '', customer: 'feishu:group:oc_group' })).toBe(true);
  });

  test('私聊、微信、网页、命令行不是群', () => {
    expect(protocol.isGroup(FEISHU_OWNER_P2P)).toBe(false);
    expect(protocol.isGroup(WECHAT)).toBe(false);
    expect(protocol.isGroup(WEB)).toBe(false);
    expect(protocol.isGroup(CLI)).toBe(false);
    expect(protocol.isGroup(undefined)).toBe(false);
  });
});
