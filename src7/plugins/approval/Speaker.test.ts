/**
 * 待确认只许发起人或用户本人处理。用假身份，不写真实用户标识。
 */
import { describe, expect, test } from 'bun:test';
import type { Pending } from './index.ts';
import { allowed, isOwner, speakerOf } from './index.ts';


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
    expect(isOwner({ openId: OWNER, owner: true })).toBe(true);
    expect(isOwner({ openId: OWNER, owner: false })).toBe(false);
    expect(isOwner({ openId: OWNER })).toBe(false);
  });

  test('用户飞书私聊：本人可以处理别人登记在自己机器人上的项', () => {
    const address = { openId: OWNER, chatType: 'p2p', customer: `feishu:${OWNER}`, owner: true };
    expect(isOwner(address)).toBe(true);
    expect(allowed(item('feishu:someone'), speakerOf('feishu', address), true)).toBe(true);
  });

  test('微信客户发“同意 1”：不是发起人就不能处理用户的项', () => {
    const address = { customer: 'wechat:chat_customer' };
    expect(isOwner(address)).toBe(false);
    expect(allowed(item(`feishu:${OWNER}`, `feishu:${OWNER}`), speakerOf('wechat', address), false)).toBe(false);
  });

  test('同一发起人可以处理自己登记的项', () => {
    const address = { customer: 'wechat:chat_customer' };
    expect(allowed(item('wechat:chat_customer', 'wechat:chat_customer'), speakerOf('wechat', address), false)).toBe(true);
  });

  test('飞书群里的其他人不能处理用户发起的项（即使客户号是同一个群）', () => {
    const address = { openId: STRANGER, chatType: 'group', customer: 'feishu:group:chat_x', owner: false };
    expect(isOwner(address)).toBe(false);
    expect(allowed(item(`feishu:${OWNER}`, 'feishu:group:chat_x'), speakerOf('feishu', address), false)).toBe(false);
  });

  test('旧记录没有发起人身份时，只许用户本人处理', () => {
    const address = { openId: STRANGER, chatType: 'group', customer: 'feishu:group:chat_x' };
    const speaker = speakerOf('feishu', address);
    expect(allowed(item(undefined, 'feishu:group:chat_x'), speaker, false)).toBe(false);
    expect(allowed(item(undefined, 'feishu:group:chat_x'), speaker, true)).toBe(true);
  });
});
