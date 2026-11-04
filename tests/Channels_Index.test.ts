/**
 * 渠道装配（src/channels/index.ts）的离线测试：临时运行时目录 + 内存数据库。
 *
 * 盯三件事：
 *   1. listChannels() 把“一个对象”和“对象数组”两种写法都摊平成一份份设置；
 *   2. enabled: false 的渠道不返回；
 *   3. 没开任何渠道时 buildChannelHooks() 返回 undefined（引擎只有默认工具，不装任何渠道本事）。
 *
 * 不联网、不读真实 config.yaml、不建真渠道；密钥用假的。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as channelsModule from '../src/channels/index.ts';
import * as events from '../src/events/Events.ts';
import * as resourcesModule from '../src/resources/Resources.ts';


/**
 * 在临时目录里写好 config.yaml，再用 Resources 打开。
 * @param yaml config.yaml 的内容。
 * @returns 打开的运行时和临时目录；调用方负责删目录和关数据库。
 */
async function openRuntime(yaml: string): Promise<{ runtime: resourcesModule.Resources; dir: string }> {
  /** 临时运行时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-channels-index-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), yaml);
  return { runtime: await resourcesModule.Resources.load(dir), dir };
}


bunTest.test('listChannels()：一个对象和对象数组都摊平，enabled: false 的不返回', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime(
    [
      'channels:',
      '  feishu:',
      '    enabled: true',
      '    app_id: cli_fake',
      '    app_secret: fake-secret-abcdefgh',
      '  http:',
      '    - enabled: true',
      '      port: 30086',
      '    - enabled: false',
      '      port: 30087',
      '  webpage:',
      '    enabled: false',
    ].join('\n'),
  );
  try {
    //M 同一家渠道可以接好几个号（数组），关掉的不能混进来；这是渠道装配遍历的唯一入口。
    bunTest.expect(runtime.listChannels()).toEqual([
      { name: 'feishu', settings: { enabled: true, app_id: 'cli_fake', app_secret: 'fake-secret-abcdefgh' } },
      { name: 'http', settings: { enabled: true, port: 30086 } },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test('buildChannelHooks()：一个渠道都没开时返回 undefined', async () => {
  /** 打开的运行时：没有 channels 段。 */
  const { runtime, dir } = await openRuntime('default_model: fake/m1\n');
  /** 数据库。 */
  const store = events.openEventStore(':memory:');
  try {
    //M 没开渠道就该返回 undefined，引擎才会只给默认工具、不挂任何渠道能力。
    bunTest.expect(channelsModule.buildChannelHooks(runtime, store)).toBeUndefined();
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test('buildChannelHooks()：渠道全写着 enabled: false 时也返回 undefined', async () => {
  /** 打开的运行时：两家都关着。 */
  const { runtime, dir } = await openRuntime(
    ['channels:', '  feishu:', '    enabled: false', '  http:', '    enabled: false'].join('\n'),
  );
  /** 数据库。 */
  const store = events.openEventStore(':memory:');
  try {
    //G 关着的渠道不能被当成“开了但没配好”，更不能提供任何本事。
    bunTest.expect(channelsModule.buildChannelHooks(runtime, store)).toBeUndefined();
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test('buildChannelHooks()：开了飞书但缺 app_secret，不提供任何本事', async () => {
  /** 打开的运行时：飞书只填了 app_id，缺密钥。 */
  const { runtime, dir } = await openRuntime(
    ['channels:', '  feishu:', '    enabled: true', '    app_id: cli_fake'].join('\n'),
  );
  /** 数据库。 */
  const store = events.openEventStore(':memory:');
  try {
    //G 配置不全时返回 undefined，不能建出一个发不出消息的假渠道能力。
    bunTest.expect(channelsModule.buildChannelHooks(runtime, store)).toBeUndefined();
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
