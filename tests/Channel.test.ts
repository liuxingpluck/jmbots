/**
 * Channel 登记表的离线测试：用假渠道和假资源，验证只建 config.yaml 里 enabled 为 true 的渠道、
 * 没登记的渠道名报错、can() 和可选能力对得上、清空登记表后报"没有登记"。
 * 不联网、不读真实 config.yaml、不建任何真渠道。
 */
import * as bunTest from 'bun:test';
import * as channelModule from '../src/channels/Channel.ts';
import type * as resourcesModule from '../src/resources/Resources.ts';


/**
 * 造一个假资源：只实现登记表用到的 getChannel。
 * @param channels config.yaml 里的 channels：渠道名 → 设置。
 * @returns 假资源；类型对不上时强行断言，测试只走 getChannel。
 */
function fakeResources(channels: Record<string, Record<string, unknown>>): resourcesModule.Resources {
  return { getChannel: (name: string) => channels[name] } as unknown as resourcesModule.Resources;
}


/**
 * 造一个最小的假渠道。
 * @param name 渠道名。
 * @param abilities 声明的可选能力。
 * @returns 假渠道；声明了某项能力时补上对应的函数。
 */
function fakeChannel(name: string, abilities: channelModule.ChannelAbility[] = []): channelModule.Channel {
  /** 假渠道。 */
  const channel: channelModule.Channel = {
    name: () => name,
    start: () => Promise.resolve(() => undefined),
    send: (_sourceId, text) => Promise.resolve(`已经发出：${text}`),
    can: (ability) => abilities.includes(ability),
  };
  if (abilities.includes('选项')) {
    channel.ask = () => Promise.resolve('choice_1');
  }
  if (abilities.includes('文档')) {
    channel.publishDoc = () => Promise.resolve('doc_1');
    channel.deleteDoc = () => Promise.resolve('已删');
  }
  return channel;
}


/**
 * 取渠道上某个可选方法的值。
 * @param channel 渠道。
 * @param name 方法名。
 * @returns 那个方法；没实现时是 undefined。
 */
function optionalMethod(channel: channelModule.Channel, name: string): unknown {
  //M 转成普通映射再取，免得把方法引用直接拎出来（eslint 的 unbound-method 会报）。
  return (channel as unknown as Record<string, unknown>)[name];
}


//M 每个用例先清空登记表，测试之间互不影响；clearChannels 本来就是给测试用的。
bunTest.beforeEach(() => {
  channelModule.clearChannels();
});


bunTest.test('buildChannels：只建 config.yaml 里 enabled 为 true 的渠道', () => {
  /** 建渠道时收到的设置。 */
  const received: Record<string, unknown>[] = [];
  channelModule.registerChannel('http', (settings) => {
    received.push(settings);
    return fakeChannel('http');
  });
  channelModule.registerChannel('webpage', () => fakeChannel('webpage'));
  channelModule.registerChannel('没配的', () => fakeChannel('没配的'));
  /** 假资源：http 开着，webpage 关着，没配的没有设置。 */
  const resources = fakeResources({ http: { enabled: true, token: 'abc' }, webpage: { enabled: false } });
  /** 建出来的渠道。 */
  const channels = channelModule.buildChannels(resources, ['http', 'webpage', '没配的']);
  bunTest.expect(channels.map((channel) => channel.name())).toEqual(['http']);
  //M 设置要原样交给建渠道的函数，不然渠道拿不到自己的配置。
  bunTest.expect(received[0]).toEqual({ enabled: true, token: 'abc' });
});


bunTest.test('buildChannels：config.yaml 里开了没登记的渠道，报错并带上渠道名', () => {
  channelModule.registerChannel('http', () => fakeChannel('http'));
  /** 假资源：开了一个没登记过的渠道。 */
  const resources = fakeResources({ 新渠道: { enabled: true } });
  //G 不许悄悄跳过：错误里要一眼看出是哪个渠道。
  bunTest.expect(() => channelModule.buildChannels(resources, ['新渠道'])).toThrow('config.yaml 里开了渠道 新渠道，但代码里没有登记它');
});


bunTest.test('can() 和可选能力：声明支持“文档”的才有 publishDoc 和 deleteDoc', () => {
  /** 声明支持选项和文档的渠道。 */
  const full = fakeChannel('全的', ['选项', '文档']);
  bunTest.expect(full.can('选项')).toBe(true);
  bunTest.expect(optionalMethod(full, 'ask')).toBeDefined();
  bunTest.expect(full.can('文档')).toBe(true);
  bunTest.expect(optionalMethod(full, 'publishDoc')).toBeDefined();
  bunTest.expect(optionalMethod(full, 'deleteDoc')).toBeDefined();
  /** 什么可选能力都没声明的渠道。 */
  const bare = fakeChannel('光的');
  bunTest.expect(bare.can('选项')).toBe(false);
  bunTest.expect(optionalMethod(bare, 'ask')).toBeUndefined();
  bunTest.expect(bare.can('文档')).toBe(false);
  bunTest.expect(optionalMethod(bare, 'publishDoc')).toBeUndefined();
  bunTest.expect(optionalMethod(bare, 'deleteDoc')).toBeUndefined();
});


bunTest.test('clearChannels() 之后登记表为空，再建就报没有登记', () => {
  channelModule.registerChannel('http', () => fakeChannel('http'));
  channelModule.clearChannels();
  /** 假资源：配置里还开着。 */
  const resources = fakeResources({ http: { enabled: true } });
  //G 空表时要有清楚的报错，而不是什么都不建。
  bunTest.expect(() => channelModule.buildChannels(resources, ['http'])).toThrow('config.yaml 里开了渠道 http，但代码里没有登记它');
});


bunTest.test('registerChannel：同一个名字登记两次报错', () => {
  channelModule.registerChannel('http', () => fakeChannel('http'));
  bunTest.expect(() => channelModule.registerChannel('http', () => fakeChannel('http'))).toThrow('渠道 http 已经登记过了');
});
