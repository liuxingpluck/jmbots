/**
 * 待确认只许发起人或用户本人处理。用假身份，不写真实用户标识。
 */
import { describe, expect, test } from 'bun:test';
import type { Pending } from './index.ts';
import * as protocol from '../channels/index.ts';
import { allowed, isMarkedOwner } from './index.ts';
import { getSpeaker } from './Rules.ts';


const OWNER = 'ou_test_owner';
const STRANGER = 'ou_test_stranger';


function item(actor?: string, customer?: string): Pending {
  return {
    id: 1, kind: 'exec', title: '要执行一条命令', detail: '', payload: null, bot: '助手',
    state: 'waiting', askedAt: 0, card: { kind: 'approval', title: '要执行一条命令', reason: '', items: [], state: 'waiting', buttons: [] },
    ...(actor === undefined ? {} : { actor }),
    ...(customer === undefined ? {} : { customer }),
  };
}


describe('approval 核对说话人', () => {
  test('本人只看回话地址里的 owner（飞书插件照 people 写），这里不另存名单', () => {
    expect(isMarkedOwner({ openId: OWNER, owner: true })).toBe(true);
    expect(isMarkedOwner({ openId: OWNER, owner: false })).toBe(false);
    expect(isMarkedOwner({ openId: OWNER })).toBe(false);
  });

  test('批复比 isOwnerTurn 严：命令行、没有渠道的内部会话默认算本人，可没明写 owner: true 不能批', () => {
    const cli = { customer: 'cli:本机' };
    expect(protocol.isOwnerTurn('cli', cli)).toBe(true);
    expect(isMarkedOwner(cli)).toBe(false);

    expect(protocol.isOwnerTurn(undefined, {})).toBe(true);
    expect(isMarkedOwner({})).toBe(false);
  });

  test('用户飞书私聊：本人可以处理别人登记在自己机器人上的项', () => {
    const address = { openId: OWNER, chatType: 'p2p', customer: `feishu:${OWNER}`, owner: true };
    expect(isMarkedOwner(address)).toBe(true);
    expect(allowed(item('feishu:someone'), getSpeaker('feishu', address), true)).toBe(true);
  });

  test('微信客户发“同意 1”：不是发起人就不能处理用户的项', () => {
    const address = { customer: 'wechat:chat_customer' };
    expect(isMarkedOwner(address)).toBe(false);
    expect(allowed(item(`feishu:${OWNER}`, `feishu:${OWNER}`), getSpeaker('wechat', address), false)).toBe(false);
  });

  test('同一发起人可以处理自己登记的项', () => {
    const address = { customer: 'wechat:chat_customer' };
    expect(allowed(item('wechat:chat_customer', 'wechat:chat_customer'), getSpeaker('wechat', address), false)).toBe(true);
  });

  test('飞书群里的其他人不能处理用户发起的项（即使客户号是同一个群）', () => {
    const address = { openId: STRANGER, chatType: 'group', customer: 'feishu:group:chat_x', owner: false };
    expect(isMarkedOwner(address)).toBe(false);
    expect(allowed(item(`feishu:${OWNER}`, 'feishu:group:chat_x'), getSpeaker('feishu', address), false)).toBe(false);
  });

  test('旧记录没有发起人身份时，只许用户本人处理', () => {
    const address = { openId: STRANGER, chatType: 'group', customer: 'feishu:group:chat_x' };
    const speaker = getSpeaker('feishu', address);
    expect(allowed(item(undefined, 'feishu:group:chat_x'), speaker, false)).toBe(false);
    expect(allowed(item(undefined, 'feishu:group:chat_x'), speaker, true)).toBe(true);
  });
});
