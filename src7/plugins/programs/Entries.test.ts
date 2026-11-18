/** 顶栏外部状态边界的纯函数用例，不启动浏览器或读取主站令牌。 */
import { expect, test } from 'bun:test';
import * as entriesModule from '../../../web/src/Programs/Entries.ts';

/** 对照后端真实字段构造只读快照。 */
const READY = {
  name: 'fake',
  title: '演示程序',
  state: 'ready',
  ui: '/programs/fake/',
  licenseLabel: '过期',
};

test('只显示ready+对应程序UI，授权过期不阻止查询入口', () => {
  const programs = [
    READY,
    { ...READY, name: 'off', state: 'stopped', ui: '/programs/off/' },
    { ...READY, name: 'headless', ui: null },
    { ...READY, name: 'boot', state: 'starting', ui: '/programs/boot/' },
    { ...READY, name: 'sick', state: 'unhealthy', ui: '/programs/sick/' },
  ];
  expect(entriesModule.getEntries({ programs })).toEqual([{
    name: 'fake', title: '演示程序', ui: '/programs/fake/', licenseLabel: '过期',
  }]);
});

test('非法结构、任意端口、脚本、跨程序路径均不能生成可点击项', () => {
  const invalid: unknown[] = [null, undefined, 42, [], {}, { programs: null }];
  for (const value of invalid) {
    expect(entriesModule.getEntries(value)).toEqual([]);
  }
  const urls = [
    'http://127.0.0.1:9999/', 'javascript:alert(1)', '/programs/other/', '//evil.invalid/',
    '/programs/fake/../other/', '/programs/fake//evil.invalid/', '/programs/fake/\\x', '/programs/fakeother/',
  ];
  const programs = urls.map((ui) => ({ ...READY, ui }));
  expect(entriesModule.getEntries({ programs })).toEqual([]);
});

test('程序自报的界面路径接在 /programs/<名字> 后面也能出入口', () => {
  const programs = [{ ...READY, ui: '/programs/fake/ui/index.html' }];
  expect(entriesModule.getEntries({ programs })[0]?.ui).toBe('/programs/fake/ui/index.html');
});

test('重复名字去重，异常标签回未知，空显示名回配置名，未授权不误报', () => {
  const programs = [
    { ...READY, title: '', licenseLabel: '伪造批准' },
    READY,
    { ...READY, name: 'none', ui: '/programs/none/', licenseLabel: '未授权' },
  ];
  const entries = entriesModule.getEntries({ programs });
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({ name: 'fake', title: 'fake', licenseLabel: '未知' });
  expect(entries[1]?.licenseLabel).toBe('未授权');
});
