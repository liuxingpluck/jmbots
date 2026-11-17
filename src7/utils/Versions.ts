/**
 * 版本表：编译出来的程序跑 `version` 时打印这份 JSON，给基地认版本、列更新说明。
 */
import * as embedded from './Embedded.ts';


/** 现在的版本号。 */
export const VERSION = '0.7.19';

/** 版本说明，新的在前。 */
export const VERSIONS = [
  { version: '0.7.19', date: '2026-11-17', changes: ['飞书群可以设 listen: judge：不 @ 也听，由决策模型判断要不要主动接话', '飞书群里机器人回话开头 @ 最后说话的人，话里的 @名字 自动变成真的 @（先查 people 登记，再查群成员、流水里见过的人）；Claude、Codex 等的 relay 回信也 @ 原来发 cc 的人'] },
  { version: '0.7.18', date: '2026-11-17', changes: ['网页的演示打码改成默认关，只在 /graph/、/memory/、/wechat-kefu/ 手动打开时才打码', '飞书群里不发待确认、进度卡片，改发本人私聊，群里只回文字；点卡片、回“同意 N”只认本人', '飞书里引用一条消息再写 cc、jm 开头的话，也能转给外部助手（以前开头的引用块挡住了认前缀）', '基地地址 engine.index_url 只在 base-bridge 读一次，各插件经 ctx.base 调基地；没配或基地没响应时，接口回 503 并写明原因，后台定时的静默跳过；没配基地时重启照旧本地退出，由基地拉起'] },
  { version: '0.7.17', date: '2026-11-17', changes: ['群聊默认不带私人记忆（groups 里 trusted: true 的群本人说话才带）', '人设单放 bots/<机器人>/persona.md，任何一轮都带', '/flow/ 画布“用到的函数”能点开看实现、看“谁调它”（调用处文件:行和那句注释）', '调试插件并进 /flow/', '骨架注释整理（一行一件事、登记插件的说法）'] },
  { version: '0.7.16', date: '2026-11-17', changes: ['飞书插件配置可以登记认得的人（people：名字、哪一档）和专门设过的群（groups：listen、relay）', '登记了 listen: all 的群，不 @ 机器人的话也听：cc 开头的照转，别的只记下当上下文、不回；登记了 relay: model 的群，@ 机器人时由它判断要不要转给外部助手', '飞书收到的每条消息都记进来往流水 data/logs/feishu-contacts.jsonl，GET /api/feishu/contacts 看最近的', '转给外部助手的收件带上谁说的（是不是用户本人、哪一档、名字）和在哪说的（私聊，或群和群名）', '飞书上的人按登记分三档：本人什么都能用；builder 能让机器人写代码、跑程序，但只在他自己的目录里（读写、跑命令、发文件）；别人（没登记的也是）只给查、读、搜、答的工具'] },
  { version: '0.7.15', date: '2026-11-17', changes: ['/flow/ 快照写成文件：启动走完写 data/flow/boot.json（每次启动覆盖），带 #调试 的消息停拍后写 data/flow/<消息号>.json（轨迹、每步快照、diff、notes），后台写、不挡回复', '消息快照文件只留最近 snapshot_files 个（flow 配置，默认 20），多了删最旧的', '修：回话写回（web-api/replied）的事件行认不出消息号，带过一次 #调试 后快照一直撤不掉'] },
  { version: '0.7.14', date: '2026-11-17', changes: ['/flow/ 运行时快照只给话里带 #调试（flow 配置 snapshot_keyword）的那条消息拍，平常消息不拍、不拖慢回复；关键词拍完从话里去掉，模型看不到', '/flow/ 发测试请求自动带上关键词；没快照的步右栏写明并显示现在的值', '网页接着已有会话发也认 #调试；快照加起来不超过 snapshot_max_mb（默认 200MB），超了扔最旧的；快照标明是“事件发出时”的'] },
  { version: '0.7.13', date: '2026-11-17', changes: ['/flow/ 关键变量和运行时变量的键改用代码里的英文名，键名后灰字跟中文解释', '/flow/ 运行时变量和快照全量原样显示（调试用，不打码、不截断）', '/flow/ JSON 改用 @uiw/react-json-view 显示：节点能点着展开收起、能复制，变了的键标黄'] },
  { version: '0.7.12', date: '2026-11-17', changes: ['/flow/ 运行时变量自动读出每个服务对象的全部字段（密钥、聊天内容、用户号、微信资料、本机路径照样打码）', '/flow/ 启动和请求轨迹点中一步，右栏看那一步当时的运行时变量快照，比上一步变了的标黄，能切回现在'] },
  { version: '0.7.11', date: '2026-11-17', changes: ['飞书上先贴图再写 cc 也能转给外部助手', '/flow/ 点左栏骨架或插件，右栏直接看它的运行时变量；新增 main 组（启动参数、端口、进程号）'] },
  { version: '0.7.10', date: '2026-11-17', changes: ['/flow/ 右栏上面固定、下面单独滚动，分「这一步」和「运行时变量」两个标签页', '/flow/ 运行时变量：每 3 秒现场看资源、工具、会话、机器人、插件的状态（密钥、路径、聊天内容都打码），relay 露出待回几条'] },
  { version: '0.7.9', date: '2026-11-17', changes: ['/flow/ 画布铺满，左右两栏浮在画布上，能拖宽也能收起成窄边'] },
  { version: '0.7.8', date: '2026-11-17', changes: ['/flow/ 点中一步，右栏显示这一步的关键变量（JSON，可复制）和函数原型', '/flow/ 左右两栏能拖边框改宽度，宽度记在浏览器里'] },
  { version: '0.7.7', date: '2026-11-17', changes: ['飞书上 cc 前缀不分大小写，后面可以带标点', '/flow/ 结构图加了 main 节点，去掉了用不上的回放接口'] },
  { version: '0.7.6', date: '2026-11-16', changes: ['/flow/ 能看启动过程：每一步走过的文件、函数、关键变量和代码注释', '转话带上附件路径，回信的助手名对不上时报错', '编译可以直接编进运行时的 updates/，由基地换版'] },
  { version: '0.7.5', date: '2026-11-16', changes: ['转话可以接多个外部助手，每个助手按前缀收话、回信署自己的名', '命令审核直接放行 src7 的类型检查、测试和打包'] },
  { version: '0.7.4', date: '2026-11-16', changes: ['函数位置旁增加 VS Code 图标，点了在已打开的项目里跳到那一行'] },
  { version: '0.7.3', date: '2026-11-16', changes: ['新增开发用调试插件：/flow/ 右栏可看每步对话、变量、听的人和用量', '聊天页左下角设置旁增加刷新', '结构图可隐藏只听不动的插件'] },
  { version: '0.7.2', date: '2026-11-14', changes: ['插件页面优先于聊天页兜底，子路径下的 ./assets 能找到（修 /wechat-kefu/ 空白）', '新增 /memory/ 记忆检索演示页（React，带演示引导）'] },
  { version: '0.7.1', date: '2026-11-14', changes: ['壳子 Job Object 管理进程树，memory 插件托管内部服务并统一路径入口'] },
  {
    version: '0.7.0',
    date: '2026-11-14',
    changes: ['基地提供本机通知接口和右下角 toast', 'src7 可编译成 Windows 二进制（version / serve --runtime）'],
  },
];


/**
 * 打印版本 JSON 到标准输出。
 * 副作用：写一行 JSON。
 */
export function print(): void {
  const payload = {
    version: VERSION,
    builtAt: embedded.builtTime() || Date.now(),
    versions: VERSIONS,
  };
  console.log(JSON.stringify(payload));
}
