/** 教程右栏的「进程插件」：programs 托管的外部程序的说明、运行状态和它与主程序之间的接口。 */
import * as react from 'react';
import * as antd from 'antd';
import * as api from './TutorialApi.ts';
import * as readme from './ReadmeTabs.tsx';

/** 左栏、导图和骨架逐行共用的模块名：选中它时骨架逐行打开三方握手图。 */
export const HANDSHAKE = '进程插件';
/** 路由里进程插件的前缀：plugin=program:<程序名>，不和普通插件重名。 */
export const PROGRAM_PREFIX = 'program:';

/**
 * 从路由的 plugin 取进程插件名。
 * @param plugin 路由里的 plugin。
 * @returns 程序名；不是进程插件是 undefined。
 */
export function getProgramName(plugin: string): string | undefined {
  if (!plugin.startsWith(PROGRAM_PREFIX)) return undefined;

  return plugin.slice(PROGRAM_PREFIX.length);
}

/** 左栏圆点颜色：ready 绿、blocked 和 unhealthy 红，其余黄。 */
export function getStateDot(state: string): string {
  if (state === 'ready') return 'ok';
  if (state === 'blocked' || state === 'unhealthy') return 'failed';

  return 'waiting';
}

/**
 * 拉 /api/programs 一次。
 * @returns 程序清单；没挂 programs 或读不到是空清单。
 */
export function usePrograms(): api.ProgramItem[] {
  const [programs, setPrograms] = react.useState<api.ProgramItem[]>([]);
  react.useEffect(() => {
    //M 教程打开时读一次托管程序清单，失败当作没有进程插件。
    const loading = api.TutorialApi.getPrograms();
    void loading.then((result) => setPrograms(result.programs), () => setPrograms([]));
  }, []);
  return programs;
}

interface ViewProps {
  /** 要看的程序名；空串看总览。 */
  name: string;
  /** /api/programs 的清单。 */
  programs: readonly api.ProgramItem[];
  /** 打开骨架逐行的三方握手图（TutorialPage 传进来，切到思维导图的骨架逐行）。 */
  onOpenHandshake: () => void;
  /** 选中一个进程插件（TutorialPage 的 onSelectPlugin 加前缀）。 */
  onSelectProgram: (name: string) => void;
}

/** 一个进程插件：状态、说明、接口；name 为空时列出全部和三方握手图入口。 */
export function ProgramView({ name, programs, onOpenHandshake, onSelectProgram }: ViewProps): react.JSX.Element {
  const handshake = (
    <antd.Button size="small" onClick={onOpenHandshake}>看三方握手图（骨架逐行）</antd.Button>
  );
  if (name === '') {
    //M 总览：一句话说明，再列出 config 里登记的程序。
    return (
      <div className="tu-program">
        <h3>进程插件</h3>
        <p>收费插件编成二进制，由系统插件 programs 按 config.yaml 拉起，主程序和它之间只隔一层本机 HTTP。讲解见组块阅读第七块。</p>
        <p>{handshake}</p>
        {programs.length === 0 && <p className="tu-muted">config.yaml 里 programs 还没登记程序，或 programs 插件没挂。</p>}
        <ul>
          {programs.map((program) => (
            <li key={program.name}>
              <button type="button" className="tu-program-link" onClick={() => onSelectProgram(program.name)}>
                {program.title}（{program.name}）
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const program = programs.find((item) => item.name === name);
  return (
    <div className="tu-program">
      <h3>{program?.title ?? name}</h3>
      <p>{handshake}</p>
      <ProgramStatus program={program} />
      <ProgramRoutes name={name} channels={program?.channels ?? []} />
      <ProgramReadme name={name} />
    </div>
  );
}

/** /api/programs 里的运行状态：状态、端口、健康、版本、授权、界面。 */
function ProgramStatus({ program }: { program: api.ProgramItem | undefined }): react.JSX.Element {
  if (program === undefined) return <antd.Alert type="warning" message="/api/programs 里没有这个程序" />;

  //M 没就绪时端口、版本是 null，显示成横线。
  let port = '—';
  if (program.port !== null) port = String(program.port);
  let version = '—';
  if (program.version !== null) version = program.version;
  const items = [
    { key: 'state', label: '状态', children: program.state },
    { key: 'port', label: '端口', children: port },
    { key: 'health', label: '健康', children: program.note },
    { key: 'version', label: '版本', children: version },
    { key: 'restarts', label: '自动重启', children: `${String(program.restarts)} 次` },
    { key: 'license', label: '授权', children: program.licenseLabel },
  ];
  return (
    <section>
      <h4>运行状态</h4>
      <antd.Descriptions size="small" column={1} bordered items={items} />
      {program.ui !== null && <p><a href={program.ui} target="_blank" rel="noreferrer">打开它的界面</a></p>}
    </section>
  );
}

/** 它和主程序之间的接口：两个方向各列一组，回调只有登记了渠道才有。 */
function ProgramRoutes({ name, channels }: { name: string; channels: readonly string[] }): react.JSX.Element {
  const hasChannels = channels.length > 0;
  const callback = `/api/programs/${name}/channel`;
  return (
    <section>
      <h4>和主程序之间的接口</h4>
      <p>主程序 → 它（programs 发 HTTP 到它报的本机端口）：</p>
      <ul>
        <li><code>GET /jmbots/v1/health</code>、<code>GET /jmbots/v1/info</code>：健康和身份</li>
        <li><code>GET /jmbots/v1/license</code>：授权</li>
        <li><code>POST /jmbots/v1/exit</code>：请它自己退出</li>
        {hasChannels && <li><code>POST /jmbots/v1/channel/reply</code>：回复，头里带 <code>x-jmbots-key</code></li>}
        {hasChannels && <li><code>POST /jmbots/v1/channel/history</code>：历史，头里带 <code>x-jmbots-key</code></li>}
      </ul>
      <p>它 → 主程序（回调，头里带这次启动的 <code>x-jmbots-key</code>）：</p>
      {!hasChannels && <p className="tu-muted">没登记渠道，不给回调前缀。</p>}
      {hasChannels && (
        <ul>
          <li><code>POST {callback}/message</code>：交来渠道消息，转成 <code>channel/message</code></li>
          <li><code>POST {callback}/draft</code>：客服页手动起草</li>
          <li><code>POST {callback}/approval</code>：发件确认</li>
          <li>登记的渠道：{channels.join('、')}</li>
        </ul>
      )}
    </section>
  );
}

/** 程序目录下的 说明.md，运行时现读。 */
function ProgramReadme({ name }: { name: string }): react.JSX.Element {
  const [text, setText] = react.useState<string | null>(null);
  const [failed, setFailed] = react.useState('');
  react.useEffect(() => {
    //M 换程序时重读它目录下的说明。
    setText(null);
    setFailed('');
    const loading = api.TutorialApi.getProgramReadme(name);
    void loading.then((result) => setText(result.text), (error: unknown) => setFailed((error as Error).message));
  }, [name]);

  if (failed !== '') return <antd.Alert type="warning" message={`读不到说明：${failed}`} />;
  if (text === null) return <antd.Spin />;
  if (text === '') return <p className="tu-muted">程序目录下还没有 说明.md。</p>;

  return (
    <section>
      <h4>说明</h4>
      <readme.MarkdownContent body={text} />
    </section>
  );
}
