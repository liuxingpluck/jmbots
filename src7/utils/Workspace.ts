/**
 * 工作区里的路径：模型给的相对路径落成绝对路径，不许跑出工作区（符号链接解开再比）。base-tools、file-tools 用。
 * 这一轮说话人是哪一档（getSpeakerRole）、用哪个工作区（getWorkspace）：approval、base-tools、file-tools、exec、feishu、memory、prompt、前台共用。
 * 这一轮能不能带用户的私人记忆（isPrivateMemoryAllowed）：prompt、memory、前台共用。是不是群（isGroup）：再加 approval、飞书卡片。
 * 比路径（getPathKey、isPathInDirectories）：approval 的可信目录、Checks.ts 的 checkDirs 用。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as utils from './index.ts';


/**
 * 这一轮说话人是哪一档：渠道写在地址里的 role（飞书照插件配置的 people 写：owner、builder、guest）。
 * 只写了 owner: false、没写 role 的地址当 guest；都没写的渠道（网页、命令行、微信）和小会话是 ''，照旧不限。
 * @param address 会话现在记的回话地址：最后一句带渠道的话从哪来。
 * @returns owner、builder、guest 或 ''。
 */
export function getSpeakerRole(address: unknown): string {
  //M 先读地址上标明的角色，没标再看 owner: false 判定为 guest，其余不限。
  const role = utils.getStringField(address, 'role');
  if (role !== '') return role;
  if (utils.getField(address, 'owner') === false) return 'guest';

  return '';
}


/**
 * 这一轮是不是别人（builder、guest）在说：用户的私人记忆、别的客户的记录不给他。
 * @param address 会话现在记的回话地址。
 */
export function isNonOwnerSpeaker(address: unknown): boolean {
  //M 按回话地址识别出说话人档位，再判断是不是限制查看私人记忆的外人角色。
  const role = getSpeakerRole(address);
  return role === 'builder' || role === 'guest';
}


/**
 * 这一轮能不能带用户的私人记忆（记忆目录、开场先搜、提示去查 memory）：本人、且不在不受信的群里才 true。
 * 群里机器人的回复所有人都看得到，所以群聊默认不带，飞书 groups 里登记了 trusted: true 的群（地址带 trusted）本人说话才带。
 * 没写 role 的渠道（网页、命令行、微信）和小会话不是群，照旧带。
 * @param address 会话现在记的回话地址。
 */
export function isPrivateMemoryAllowed(address: unknown): boolean {
  //G 非本人（builder、guest）不带。
  if (isNonOwnerSpeaker(address)) return false;

  //G 群里只有登记了 trusted: true 的才带。
  return !isGroup(address) || utils.getField(address, 'trusted') === true;
}


/**
 * 是不是群：地址的 chatType 是 group，或客户号是 feishu:group:…（飞书插件 feishuCustomer 的写法）。
 * isPrivateMemoryAllowed、approval（群里“同意 N”只认本人）、飞书卡片（群里不发卡片）共用。
 * @param address 回话地址；带 customer 的别的对象（approval 的说话人、待确认）也行。
 */
export function isGroup(address: unknown): boolean {
  //M chatType 是 group，或客户号是 feishu:group: 开头。
  const byType = utils.getStringField(address, 'chatType') === 'group';
  return byType || utils.getStringField(address, 'customer').startsWith('feishu:group:');
}


/**
 * 这场会话这一轮的工作区：回话地址里写了 workspace（飞书给 builder、guest 写的他自己的目录）就用它，没写用机器人的。
 * 地址跟着最后一句带渠道的话换，群里换了人，工作区跟着换。
 * @param botWorkspace 机器人的工作区（ctx.bots.get(bot).workspace）。
 * @param address 会话现在记的回话地址（session.row.address）。
 * @returns 绝对路径。
 */
export function getWorkspace(botWorkspace: string, address: unknown): string {
  //M 优先采用回话地址绑定的隔离工作区（builder/guest 场景），未配时回落机器人默认工作区。
  const assigned = utils.getStringField(address, 'workspace');
  if (assigned !== '') return assigned;

  return botWorkspace;
}


/**
 * 把相对工作区的路径落成绝对路径。工作区和目标都先解开符号链接再比，链接指到外面的算出了工作区。
 * @param workspace 这一轮的工作区，绝对路径。
 * @param relative 模型给的路径，相对工作区；写成绝对路径也行，但要在工作区里面。
 * @returns 解开链接后的绝对路径。
 * @throws 出了工作区、断了的链接解不开时抛错。
 */
export function resolveWorkspacePath(workspace: string, relative: string): string {
  //M 分别解析目标路径与工作区根路径的真实物理位置，再检验相对路径不能跳出根边界。
  const full = getReal(path.resolve(workspace, relative));
  const back = path.relative(getReal(workspace), full);

  //G 落到工作区外面（../ 出去了、换了盘符、链接指出去）→ 不许。
  if (back.startsWith('..') || path.isAbsolute(back)) {
    throw new Error(`路径出了工作区：${relative}（只能用工作区里的路径）`);
  }
  return full;
}


/**
 * 比路径用的样子：path.resolve 解开 .、..、多余和末尾的分隔符；Windows 上再转小写（盘符、目录名不分大小写）。
 * approval 比可信目录时，配置和消息里的目录（入口 Checks.ts 的 checkDirs）、命令里的路径（Rules.ts 的 getUntrusted）都照它算。
 * @param file 路径；相对的照进程当前目录解开，调用方要先自己拼成绝对路径。
 * @returns 规范化后的绝对路径。
 */
export function getPathKey(file: string): string {
  //M 先解开 ..，跳出去的就落在目录外面，后面比较时自然不算在里面。
  const full = path.resolve(file);
  if (process.platform !== 'win32') return full;

  //M Windows 不分大小写：统一转小写再比。
  return full.toLowerCase();
}


/**
 * 一个路径在不在这几个目录里（目录本身也算）。两边都要是 getPathKey 算过的。
 * @param dirs 目录。
 * @param key 要查的路径。
 * @returns 在其中一个里面是 true。
 */
export function isPathInDirectories(dirs: string[], key: string): boolean {
  return dirs.some((dir) => {
    //G 换了盘符：path.relative 交回绝对路径，不在里面。
    const back = path.relative(dir, key);
    if (path.isAbsolute(back)) return false;

    //M 要往上走（.. 开头）的在外面，别的都在里面。
    return back !== '..' && !back.startsWith(`..${path.sep}`);
  });
}


/**
 * 解开符号链接后的路径；还不存在的（要新写的文件），解开最近存在的上一级，后面几段原样接上。
 * 用 lstat 认“存在”：断了的链接也算存在，交给 realpath 抛错，不当成新文件往链接外面写。
 * @param file 绝对路径。
 */
function getReal(file: string): string {
  let existing = file;
  while (fs.lstatSync(existing, { throwIfNoEntry: false }) === undefined) {
    const parent = path.dirname(existing);
    if (parent === existing) return file;

    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), path.relative(existing, file));
}
