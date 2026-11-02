/**
 * zbots 的命令行入口。依赖都在这里创建一次，再当参数传下去。
 *
 * 用法（--config 不写就用 F:\aidata\AIZbots\config.yaml，从哪个目录启动都一样）：
 *   bun zbots/src/Main.ts run "文字" [--bot 名字] [--workspace 名字] [--conversation ID]
 *                                              把一句话交给 bot 跑一轮，打印回复（真实调用模型）。不写 --conversation
 *                                              就接着命令行最近的对话；文字以“新对话”开头就新开一个
 *   bun zbots/src/Main.ts feishu               连上飞书收消息（长连接），普通文字交给 bot 跑一轮，把回复发回去；Ctrl+C 退出
 *                                              bot 可用项目内 read/find/grep 自己查文件；需要开发助手时选 ask_dsh 或 note_for_claude，不要求固定开头
 *   bun zbots/src/Main.ts feishu-send "文字"   通过飞书机器人发给最近私聊过它的人（或 --open-id 指定的人）；
 *                                              还没人私聊过，就先存起来，等对方下次发消息时先发出去；
 *                                              多行文字写进文件，用 feishu-send --file 文件
 *   bun zbots/src/Main.ts feishu-scope         列出飞书应用可用范围里的人（要通讯录权限）
 * 还没接上的命令（list、serve）见 docs/01_规划.md。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as agent from './Agent.ts';
import * as bot from './Bot.ts';
import * as dispatcher from './Dispatch.ts';
import * as feishu from './Feishu.ts';
import * as model from './Model.ts';
import * as relay from './Relay.ts';
import * as runtime from './Runtime.ts';
import * as tools from './Tools.ts';
import * as utils from './Utils.ts';


/** 飞书渠道在运行时目录里的文件。 */
interface FeishuFiles {
  /** 文件夹：运行时目录下的 feishu/。 */
  dir: string;

  /** 最近私聊过机器人的人：open_id、会话 ID、时间。 */
  contact: string;

  /** 还没送出去的消息：对方下次发消息时先发出去，送出后删掉。 */
  pending: string;

  /** 收件箱：收到的每条消息和周小灵的回复都记一行，接手的 AI（Claude 或 DSH）从这里看用户说了什么。 */
  inbox: string;
}


/**
 * 算出飞书渠道的文件路径。
 * @param zbots 运行时。
 */
function feishuFiles(zbots: runtime.Runtime): FeishuFiles {
  /** 飞书渠道的文件夹。 */
  const dir = path.join(zbots.dir, 'feishu');
  return { dir, contact: path.join(dir, '最近私聊.yaml'), pending: path.join(dir, '待发.md'), inbox: path.join(dir, '收件箱.md') };
}


/**
 * 取飞书渠道的设置。
 * @param zbots 运行时。
 * @throws 没打开，或没填 app_id、app_secret 时抛错。
 */
function feishuConfig(zbots: runtime.Runtime): feishu.FeishuConfig {
  /** config.yaml 的 channels.feishu。 */
  const config = zbots.config.channels?.feishu;
  if (!config?.enabled || !config.app_id || !config.app_secret) {
    throw new Error(`${zbots.configFile} 的 channels.feishu 没打开（enabled），或没填 app_id、app_secret。`);
  }
  return config;
}


/**
 * 建分派要用的东西：连上模型（向 magpie 拉清单）、读全部角色、接上开发助手工具、读执行设置。
 * @param zbots 运行时。
 * @throws 连不上 magpie、bot 写错、配置缺段时抛错。
 */
async function createDeps(zbots: runtime.Runtime): Promise<dispatcher.DispatchDeps> {
  return {
    zbots,
    ai: await model.connect(zbots.config),
    bots: await bot.loadBots(zbots),
    // r: 只读根按代码位置固定，不采用模型参数、启动目录或配置扩大文件范围。
    tools: [
      ...await tools.createReadOnlyTools(path.resolve(import.meta.dir, '..', '..')),
      ...relay.createRelayTools(zbots, zbots.config.channels?.feishu?.dsh_session),
    ],
    settings: agent.readSettings(zbots.config),
  };
}


/**
 * 命令行跑一轮：把一句话交给 bot，打印回复。真实调用模型。
 * @param zbots 运行时。
 * @param argv 命令行参数：第二个是要说的话（紧跟在 run 后面）；--bot 不写就用飞书渠道的 bot；--workspace、--conversation 可选。
 */
async function runOnce(zbots: runtime.Runtime, argv: readonly string[]): Promise<void> {
  /** 要说的话。 */
  const text = argv[1];
  if (!text || text.startsWith('--')) {
    throw new Error('要写说什么，紧跟在 run 后面：run "文字"');
  }
  const dispatch = dispatcher.createDispatcher(await createDeps(zbots));
  const handled = await dispatch({
    text,
    from: '命令行',
    botName: utils.getArg(argv, 'bot') ?? zbots.config.channels?.feishu?.bot ?? '周小灵',
    workspace: utils.getArg(argv, 'workspace'),
    conversationId: utils.getArg(argv, 'conversation'),
  });
  console.log(handled.reply);
  console.log(`\n（对话 ${handled.conversation.info.id}，${handled.ending}，走了 ${handled.steps} 步；记录在 ${handled.conversation.dir}）`);
}


/**
 * 连上飞书收消息：私聊、群聊文字都交给 bot 跑一轮，由模型决定是否调用开发助手工具。
 * 回复发回原来的聊天并记进收件箱；私聊的人记进“最近私聊”；有待发的消息就先发出去。
 * @param zbots 运行时。
 */
async function listenFeishu(zbots: runtime.Runtime): Promise<void> {
  const config = feishuConfig(zbots);
  const files = feishuFiles(zbots);
  const dispatch = dispatcher.createDispatcher(await createDeps(zbots));
  /** 飞书机器人。 */
  const feishuBot = feishu.createFeishu(config);
  await feishuBot.listen(async (message) => {
    console.log(`${utils.formatTime()} 收到飞书消息（${message.chatType}，${message.messageType}）：${message.text}`);
    await fs.mkdir(files.dir, { recursive: true });
    await fs.appendFile(files.inbox, `- ${utils.formatTime()} 收到（${message.chatType} ${message.chatId}）：${oneLine(message.text)}\n`);
    if (message.chatType === 'p2p') {
      await utils.writeYaml(files.contact, { open_id: message.openId, chat_id: message.chatId, time: utils.formatTime() });
    }

    // r: 先把还没送出去的消息发出去。
    /** 还没送出去的消息；没有时是空字符串。 */
    const pending = (await fs.readFile(files.pending, 'utf8').catch(() => '')).trim();
    if (pending) {
      await feishuBot.sendText({ chatId: message.chatId }, pending);
      await fs.rm(files.pending, { force: true });
    }
    // g: 现在只认文字。
    if (message.messageType !== 'text' || !message.text.trim()) {
      await feishuBot.sendText({ chatId: message.chatId }, '现在只认文字消息。');
      return;
    }

    // m: 交给分派跑一轮，把回复发回去；出错也回一句，免得对方干等。
    /** 开始时间。 */
    const startedAt = performance.now();
    try {
      const handled = await dispatch({
        text: message.text,
        from: `${message.chatType === 'p2p' ? '飞书私聊' : '飞书群'} ${message.chatId}`,
        botName: config.bot,
      });
      await feishuBot.sendText({ chatId: message.chatId }, handled.reply);
      await fs.appendFile(files.inbox, `  - ${utils.formatTime()} ${config.bot}回：${oneLine(handled.reply).slice(0, 300)}\n`);
      console.log(
        `${utils.formatTime()} 已回复（对话 ${handled.conversation.info.id}，${handled.ending}，走了 ${handled.steps} 步，` +
          `${Math.round(performance.now() - startedAt)} 毫秒）`,
      );
    } catch (error) {
      /** 出错原因。 */
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`${utils.formatTime()} 出错：${reason}`);
      await feishuBot.sendText({ chatId: message.chatId }, `出错了：${reason}`);
    }
  });
  console.log(`${utils.formatTime()} 飞书长连接已连上，机器人：${config.bot}。等消息中，Ctrl+C 退出。`);
}


/**
 * 多行文字压成一行，记进收件箱。
 * @param text 原文。
 */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ⏎ ');
}


/**
 * 通过飞书机器人发一条文字：发给 --open-id 指定的人，没写就发给最近私聊过它的人；
 * 还没人私聊过，就追加进待发消息，等对方下次发消息时先发出去。
 * @param zbots 运行时。
 * @param argv 命令行参数：第二个是要发的文字；写了 --file 就改发这个文件的内容（UTF-8）。多行文字用文件，命令行里不好写换行。
 */
async function sendFeishu(zbots: runtime.Runtime, argv: readonly string[]): Promise<void> {
  /** 装着要发的文字的文件；没写 --file 时是 undefined。 */
  const textFile = utils.getArg(argv, 'file');
  /** 要发的文字。 */
  const text = textFile ? (await fs.readFile(textFile, 'utf8')).trim() : argv[1];
  if (!text) {
    throw new Error('要写发什么：feishu-send "文字"，或 feishu-send --file 文件');
  }
  const files = feishuFiles(zbots);
  /** 最近私聊过的人；文件不存在时是 undefined。 */
  const contact = (await utils.readYaml(files.contact).catch(() => undefined)) as { open_id?: string } | undefined;
  /** 发给谁。 */
  const openId = utils.getArg(argv, 'open-id') ?? contact?.open_id;
  if (!openId) {
    await fs.mkdir(files.dir, { recursive: true });
    await fs.appendFile(files.pending, `${text}\n\n`);
    console.log(`还没人私聊过机器人，消息先存进 ${files.pending}，对方下次发消息时先发出去。`);
    return;
  }
  /** 飞书给这条消息的 ID。 */
  const messageId = await feishu.createFeishu(feishuConfig(zbots)).sendText({ openId }, text);
  console.log(`已发出，消息 ID：${messageId}`);
}


/**
 * 列出飞书应用可用范围里的人。
 * @param zbots 运行时。
 */
async function showFeishuScope(zbots: runtime.Runtime): Promise<void> {
  /** 可用范围里的人的 open_id。 */
  const users = await feishu.createFeishu(feishuConfig(zbots)).listScopeUsers();
  console.log(`可用范围里有 ${users.length} 人：${users.join('、')}`);
}


/** 命令行参数（不含 bun 和脚本路径）；第一个是命令。 */
const argv = process.argv.slice(2);
/** 运行时：配置和目录，下面的命令都用它。 */
const zbots = await runtime.loadRuntime(argv);
switch (argv[0]) {
  case 'run':
    await runOnce(zbots, argv);
    break;
  case 'feishu':
    await listenFeishu(zbots);
    break;
  case 'feishu-send':
    await sendFeishu(zbots, argv);
    break;
  case 'feishu-scope':
    await showFeishuScope(zbots);
    break;
  default:
    console.log(
      '用法：bun zbots/src/Main.ts run "文字" [--bot 名字] [--workspace 名字] [--conversation ID]' +
        ' | feishu | feishu-send "文字"（或 --file 文件）[--open-id ID] | feishu-scope  [--config 配置文件]',
    );
}
