/** 网址选中状态的离线测试：几种正常写法、写错的网址，以及写成 hash 后能原样解析回来。 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as route from '../web/src/Route.ts';


/** 网址认不出来时应得到的默认状态：还没选目录，也没选文档。 */
const DEFAULT_ROUTE: route.Route = { baseId: null, documentId: null };


test.test('解析几种正常写法', () => {
  assert.deepEqual(route.parseRoute('#/kb/all'), { baseId: 'all', documentId: null });
  assert.deepEqual(route.parseRoute('#/kb/3'), { baseId: 3, documentId: null });
  assert.deepEqual(route.parseRoute('#/kb/3/doc/12'), { baseId: 3, documentId: 12 });
  assert.deepEqual(route.parseRoute('#/kb/all/doc/7'), { baseId: 'all', documentId: 7 });
});


test.test('没写目录或写错的网址回到默认状态', () => {
  for (const hash of ['', '#', '#/', '#/chat', '#/kb', '#/kb/', '#/kb/abc', '#/kb/0', '#/kb/-1', '#/kb/1.5', '#/kb/1e3']) {
    assert.deepEqual(route.parseRoute(hash), DEFAULT_ROUTE, hash);
  }
});


test.test('文档段写错时只保留目录', () => {
  assert.deepEqual(route.parseRoute('#/kb/3/doc/x'), { baseId: 3, documentId: null });
  assert.deepEqual(route.parseRoute('#/kb/3/doc/0'), { baseId: 3, documentId: null });
  assert.deepEqual(route.parseRoute('#/kb/3/foo/12'), { baseId: 3, documentId: null });
});


test.test('写成 hash 后能原样解析回来', () => {
  /** 要来回转换的几种状态。 */
  const routes: route.Route[] = [
    { baseId: null, documentId: null },
    { baseId: 'all', documentId: null },
    { baseId: 'all', documentId: 7 },
    { baseId: 3, documentId: null },
    { baseId: 3, documentId: 12 },
  ];
  for (const value of routes) {
    assert.deepEqual(route.parseRoute(route.formatRoute(value)), value);
  }
});


test.test('选了文档却没选目录时，目录按“全部文档”写', () => {
  assert.equal(route.formatRoute({ baseId: null, documentId: 7 }), '#/kb/all/doc/7');
  assert.equal(route.formatRoute({ baseId: null, documentId: null }), '#/kb');
});
