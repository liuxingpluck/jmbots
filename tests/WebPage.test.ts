/** 网页托管的离线测试：用临时目录当打包产物，核对首页、文件类型、越界路径和未注册接口。 */
import * as test from 'bun:test';
import Fastify from 'fastify';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as webPage from '../src/channels/WebPage.ts';


/** 每个用例自己的临时打包目录；用例结束后删除。 */
let webDir = '';


test.beforeEach(async () => {
  webDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jmai-web-'));
  await fs.writeFile(path.join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
  await fs.writeFile(path.join(webDir, 'chunk-a1.js'), 'console.log(1);');
  await fs.writeFile(path.join(webDir, 'notes.txt'), '没登记的类型');
});


test.afterEach(async () => {
  await fs.rm(webDir, { recursive: true, force: true });
});


/** 建一个只注册了网页路由的服务，供 inject 直接发请求。 */
function createApp() {
  /** 测试用的 Fastify 实例，不监听端口。 */
  const app = Fastify();
  webPage.registerWebPage(app, { webDir });
  return app;
}


test.test('首页返回 index.html，并且不缓存', async () => {
  const response = await createApp().inject({ method: 'GET', url: '/' });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /text\/html/);
  assert.equal(response.headers['cache-control'], 'no-cache');
  assert.match(response.body, /id="root"/);
});


test.test('按文件名返回打包产物，查询串不影响', async () => {
  const response = await createApp().inject({ method: 'GET', url: '/chunk-a1.js?v=1' });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /javascript/);
  assert.equal(response.body, 'console.log(1);');
});


test.test('没登记的类型、越界路径、不存在的文件和未注册接口都是 404', async () => {
  /** 共用一个服务，逐个路径检查。 */
  const app = createApp();
  for (const url of ['/notes.txt', '/../package.json', '/%2e%2e/package.json', '/..%5c..%5cpackage.json', '/missing.js', '/api/nothing']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 404, url);
  }
});


test.test('解码失败的路径不会返回文件', async () => {
  const response = await createApp().inject({ method: 'GET', url: '/%E0%A4%A' });
  assert.notEqual(response.statusCode, 200);
});
