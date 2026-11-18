/**
 * 教程页右栏插件的两个标签（说明、状态在 TutorialPage.tsx）：
 *   「代码」CodeTab：这个插件的对外函数、HTTP 接口、模型工具；点一项展开，看实现（函数体）和谁调它（文件:行加那句注释），
 *             实现、谁调它用的是画布点格子同一套（Code.tsx 的 SourceView、CallerList），不另写一份；
 *   「试一试」TryTab：这个插件登记的 HTTP 接口，每个一个小表单，填查询串或 JSON 正文，点“发送”，原样显示状态码和返回。
 * 数据都来自 GET /api/tutorial/code?name=（后端 Code.ts），接口列表是 http 插件实际登记的路径按插件分出来的，没有手写清单；
 * 认不出是哪个插件登记的归在页面底下的“其他”。
 */
import { useContext, useEffect, useState, type JSX } from 'react';
import * as antd from 'antd';
import * as virtuoso from 'react-virtuoso';
import { CallerList, SiteLink, SourceToggle, SourceView, TutorialScrollContext, VIRTUAL_THRESHOLD, getSiteParts } from './Code.tsx';
import { TutorialApi, type CodeRoute, type PluginCodeInfo, type TryResult } from './TutorialApi.ts';


/**
 * 读一个插件的代码信息。
 * @param name 插件名。
 * @returns 信息、出错原因（两个里只有一个有值；都没有是还在读）。
 */
function useCodeInfo(name: string): { info: PluginCodeInfo | null; error: string } {
  const [info, setInfo] = useState<PluginCodeInfo | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setInfo(null);
    setError('');
    //M 向后端查询指定插件的导出函数、已注册 HTTP 接口及模型工具索引。
    const loading = TutorialApi.get<PluginCodeInfo>(`/api/tutorial/code?name=${encodeURIComponent(name)}`);
    loading.then(setInfo, (failed: unknown) => setError((failed as Error).message));
  }, [name]);

  return { info, error };
}


/**
 * 「代码」里的一项：标题和一句话，点“展开”才看实现和谁调它。
 * @param props.title 标题（函数名、方法加路径、工具名）。
 * @param props.summary 一句话；空串不显示。
 * @param props.site 文件:行号；空串是找不到位置。
 * @param props.callers 谁调它：函数用 CallerList 现查；接口自己给列表；工具不给。
 */
function CodeEntry(props: { title: string; summary: string; site: string; callers: 'function' | CodeRoute['callers'] | null }): JSX.Element {
  const [open, setOpen] = useState(false);
  //M 解析代码位置字符串的文件与行号，用以控制“展开”按钮和源码查看器。
  const parts = getSiteParts(props.site);

  //M 按钮上的字：展开或收起。
  let word = '展开';
  if (open) {
    word = '收起';
  }

  return (
    <div className="tu-entry">
      <div className="tu-head-row">
        <span>
          <code className="tu-fn-name">{props.title}</code>
          {props.summary !== '' && <span className="tu-muted"> {props.summary}</span>}
        </span>
        {parts !== undefined && <button type="button" className="tu-link" onClick={() => setOpen(!open)}>{word}</button>}
      </div>
      <div className="tu-site">
        {props.site === '' && <span>位置：没找到</span>}
        {props.site !== '' && <SiteLink site={props.site} />}
      </div>
      {open && parts !== undefined && <SourceView file={parts.file} line={parts.line} />}
      {open && parts !== undefined && props.callers === 'function' && <CallerList site={props.site} />}
      {open && props.callers !== null && props.callers !== 'function' && <UrlCallers callers={props.callers} />}
    </div>
  );
}


/**
 * 谁调了这个接口的一条展示内容。
 * @param caller 调用处。
 */
function UrlCallerItem(caller: CodeRoute['callers'][number]): JSX.Element {
  return (
    <>
      <div className="tu-site">
        <SiteLink site={caller.site} />
        <SourceToggle site={caller.site} label="看调用段" />
      </div>
      {caller.why === '' && <span className="tu-caller-why tu-error">调用处没写注释</span>}
      {caller.why !== '' && <span className="tu-caller-why">为什么：{caller.why}</span>}
      <code className="tu-signature">{caller.code}</code>
    </>
  );
}


/**
 * 谁调了这个接口：src7 里写了这条路径的地方。网页那边的调用这里查不到。
 * @param props.callers 后端给的调用处。
 */
function UrlCallers(props: { callers: CodeRoute['callers'] }): JSX.Element {
  const scrollParent = useContext(TutorialScrollContext);
  if (props.callers.length === 0) return <p className="tu-muted">谁调它：src7 里没有写这条路径的地方（网页或外部程序调的，这里查不到）。</p>;

  const useVirtual = props.callers.length >= VIRTUAL_THRESHOLD && scrollParent !== null;
  return (
    <div className="tu-callers">
      <p className="tu-muted">谁调它（{props.callers.length} 处写了这条路径）：</p>
      {useVirtual && (
        <div className="tu-caller-virt">
          <virtuoso.Virtuoso
            customScrollParent={scrollParent}
            data={props.callers}
            computeItemKey={(_index, caller) => caller.site}
            itemContent={(_index, caller) => (
              <div className="tu-caller-row">
                {UrlCallerItem(caller)}
              </div>
            )}
          />
        </div>
      )}
      {!useVirtual && (
        <ul>
          {props.callers.map((caller) => (
            <li key={caller.site}>
              {UrlCallerItem(caller)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


/**
 * 「代码」标签：对外函数、HTTP 接口、模型工具，超过 30 项时走虚拟滚动。
 * @param props.name 插件名。
 */
export function CodeTab(props: { name: string }): JSX.Element {
  //M 拉取当前插件的代码索引数据（含导出函数、接口与工具）以及加载错误状态。
  const { info, error } = useCodeInfo(props.name);
  const scrollParent = useContext(TutorialScrollContext);
  if (error !== '') return <p className="tu-error">读不到代码信息：{error}</p>;
  if (info === null) return <p className="tu-muted">正在读…</p>;

  const virtFunctions = info.functions.length >= VIRTUAL_THRESHOLD && scrollParent !== null;
  const virtRoutes = info.routes.length >= VIRTUAL_THRESHOLD && scrollParent !== null;
  const virtTools = info.tools.length >= VIRTUAL_THRESHOLD && scrollParent !== null;

  return (
    <div className="tu-code-tab">
      <h3>对外函数（{info.functions.length}）</h3>
      <p className="tu-muted">模块源码里导出的函数、类与公开方法，不含测试。</p>
      {info.functions.length === 0 && <antd.Empty description="没有找到" />}
      {virtFunctions && (
        <div className="tu-entries">
          <virtuoso.Virtuoso
            customScrollParent={scrollParent}
            data={info.functions}
            computeItemKey={(_index, item) => item.site}
            itemContent={(_index, item) => (
              <CodeEntry title={item.name} summary={item.summary} site={item.site} callers="function" />
            )}
          />
        </div>
      )}
      {!virtFunctions && info.functions.length > 0 && (
        <div className="tu-entries">
          {info.functions.map((item) => (
            <CodeEntry key={item.site} title={item.name} summary={item.summary} site={item.site} callers="function" />
          ))}
        </div>
      )}

      <h3>HTTP 接口（{info.routes.length}）</h3>
      <p className="tu-muted">http 插件实际登记的路径里，登记的位置落在这个插件文件夹里的。</p>
      {info.routes.length === 0 && <antd.Empty description="这个插件没有登记接口" />}
      {virtRoutes && (
        <div className="tu-entries">
          <virtuoso.Virtuoso
            customScrollParent={scrollParent}
            data={info.routes}
            computeItemKey={(_index, item) => `${item.method} ${item.url}`}
            itemContent={(_index, item) => (
              <CodeEntry title={`${item.method} ${item.url}`} summary="" site={item.site} callers={item.callers} />
            )}
          />
        </div>
      )}
      {!virtRoutes && info.routes.length > 0 && (
        <div className="tu-entries">
          {info.routes.map((item) => (
            <CodeEntry key={`${item.method} ${item.url}`} title={`${item.method} ${item.url}`} summary="" site={item.site} callers={item.callers} />
          ))}
        </div>
      )}

      <h3>模型工具（{info.tools.length}）</h3>
      <p className="tu-muted">挂这个插件的那一刻多出来的工具；挂完以后才登记的这里看不到。</p>
      {info.tools.length === 0 && <antd.Empty description="这个插件没有登记工具" />}
      {virtTools && (
        <div className="tu-entries">
          <virtuoso.Virtuoso
            customScrollParent={scrollParent}
            data={info.tools}
            computeItemKey={(_index, item) => item.name}
            itemContent={(_index, item) => (
              <CodeEntry title={item.name} summary={`${item.summary}（会话：${item.kinds.join('、')}）`} site={item.site} callers={null} />
            )}
          />
        </div>
      )}
      {!virtTools && info.tools.length > 0 && (
        <div className="tu-entries">
          {info.tools.map((item) => (
            <CodeEntry key={item.name} title={item.name} summary={`${item.summary}（会话：${item.kinds.join('、')}）`} site={item.site} callers={null} />
          ))}
        </div>
      )}
    </div>
  );
}


/**
 * 「试一试」里的一个接口：路径可以改（带 :参数的要换成真值）、查询串、JSON 正文；发送后显示状态码和返回原文。
 * @param props.route 接口。
 */
function TryForm(props: { route: CodeRoute }): JSX.Element {
  const { route } = props;
  const [path, setPath] = useState(route.url);
  const [query, setQuery] = useState('');
  const [body, setBody] = useState('');
  const [result, setResult] = useState<TryResult | null>(null);
  const [failed, setFailed] = useState('');
  const [sending, setSending] = useState(false);

  //M 点发送：路径加查询串，原样发出去；返回的状态码和正文原样记下。
  const send = (): void => {
    let url = path;
    if (query.trim() !== '') {
      url = `${path}?${query.trim()}`;
    }
    setSending(true);
    setFailed('');
    //M 携带查询串和可选 JSON 正文发起真实接口调用以展示响应状态码与原文。
    const request = TutorialApi.send(route.method, url, body);
    request.then((done) => {
      setResult(done);
      setSending(false);
    }, (error: unknown) => {
      setResult(null);
      setFailed((error as Error).message);
      setSending(false);
    });
  };

  //M 返回正文是空的写一句，免得看不出有没有返回。
  let shown = '';
  if (result !== null) {
    shown = result.text;
  }
  if (result !== null && result.text === '') {
    shown = '（空）';
  }

  return (
    <div className="tu-entry tu-try">
      <div className="tu-head-row">
        <span>
          <antd.Tag>{route.method}</antd.Tag>
          <code className="tu-fn-name">{route.url}</code>
        </span>
      </div>
      <div className="tu-try-grid">
        <label>路径</label>
        <antd.Input size="small" value={path} onChange={(event) => setPath(event.target.value)} />
        <label>查询串</label>
        <antd.Input size="small" placeholder="如 name=http&step=1（不带问号）" value={query} onChange={(event) => setQuery(event.target.value)} />
        {route.method !== 'GET' && <label>JSON 正文</label>}
        {route.method !== 'GET' && (
          <antd.Input.TextArea size="small" rows={3} placeholder='如 {"name":"x"}' value={body} onChange={(event) => setBody(event.target.value)} />
        )}
      </div>
      <antd.Button size="small" type="primary" loading={sending} onClick={send}>发送</antd.Button>
      {failed !== '' && <p className="tu-error">发不出去：{failed}</p>}
      {result !== null && (
        <div className="tu-try-result">
          <p className="tu-muted">状态码 <b>{result.status}</b></p>
          <pre className="tu-json">{shown}</pre>
        </div>
      )}
    </div>
  );
}


/**
 * 「试一试」标签：自己的接口与“其他”接口列表，超过 30 项时用虚拟滚动。
 * @param props.name 插件名。
 */
export function TryTab(props: { name: string }): JSX.Element {
  //M 拉取当前插件所属 HTTP 接口与未识别归属的“其他”接口列表。
  const { info, error } = useCodeInfo(props.name);
  const [othersOpen, setOthersOpen] = useState(false);
  const scrollParent = useContext(TutorialScrollContext);
  if (error !== '') return <p className="tu-error">读不到接口列表：{error}</p>;
  if (info === null) return <p className="tu-muted">正在读…</p>;

  const virtRoutes = info.routes.length >= VIRTUAL_THRESHOLD && scrollParent !== null;
  const virtOthers = info.others.length >= VIRTUAL_THRESHOLD && scrollParent !== null;

  return (
    <div className="tu-try-tab">
      <p className="tu-muted">每个接口填好查询串或 JSON 正文，点“发送”，下面原样显示状态码和返回。发的是真请求，会真的改数据。</p>
      {info.routes.length === 0 && <antd.Empty description="这个插件没有登记 HTTP 接口" />}
      {virtRoutes && (
        <div className="tu-entries">
          <virtuoso.Virtuoso
            customScrollParent={scrollParent}
            data={info.routes}
            computeItemKey={(_index, item) => `${props.name}:${item.method} ${item.url}`}
            itemContent={(_index, item) => <TryForm route={item} />}
          />
        </div>
      )}
      {!virtRoutes && info.routes.length > 0 && (
        <div className="tu-entries">
          {info.routes.map((item) => (
            <TryForm key={`${props.name}:${item.method} ${item.url}`} route={item} />
          ))}
        </div>
      )}
      {info.others.length > 0 && (
        <details className="tu-others" open={othersOpen} onToggle={(event) => setOthersOpen(event.currentTarget.open)}>
          <summary>其他（{info.others.length}）：分不出是哪个插件登记的接口</summary>
          <p className="tu-muted">登记时看调用栈认插件；编译版里调用栈没有源码路径、骨架直接登记的也没有，认不出的都放这里（各插件页底下都显示同一份）。</p>
          {othersOpen && virtOthers && (
            <div className="tu-entries">
              <virtuoso.Virtuoso
                customScrollParent={scrollParent}
                data={info.others}
                computeItemKey={(_index, item) => `other:${item.method} ${item.url}`}
                itemContent={(_index, item) => <TryForm route={item} />}
              />
            </div>
          )}
          {othersOpen && !virtOthers && (
            <div className="tu-entries">
              {info.others.map((item) => (
                <TryForm key={`other:${item.method} ${item.url}`} route={item} />
              ))}
            </div>
          )}
        </details>
      )}
    </div>
  );
}
