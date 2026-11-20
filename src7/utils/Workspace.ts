/**
 * 工作区里的路径：模型给的相对路径落成绝对路径，不许跑出工作区（符号链接解开再比）。base-tools、file-tools 用。
 * 这一轮用哪个工作区（getWorkspace）：bots、workspaces、utils/Bots.ts 用。说话的是谁（是不是本人、哪一档、是不是群）不在这里，
 * 由渠道协议判：plugins/channels/Message.ts 的 isOwnerTurn、getSpeakerRole、isGroup。
 * 比路径（getPathKey、isPathInDirectories）：approval 的可信目录、Checks.ts 的 checkDirs 用。
 * 这一轮的授权目录（getGrantDirs，回话地址的 grants.dirs）：工作区之外也能读写、跑命令、发文件的目录，file-tools、飞书、approval 用。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as utils from './index.ts';


/**
 * 这场会话这一轮的工作区：回话地址里写了 workspace（飞书给 builder、guest 写的他自己的目录）就用它，没写用机器人的。
 * 地址跟着最后一句带渠道的话换，群里换了人，工作区跟着换。
 * @param botWorkspace 机器人的默认工作区（utils/Bots.ts 的 getBotDir）。
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
 * 这一轮的授权目录（用户 #301“目录授权向下延伸”）：回话地址里的 grants.dirs。
 * 谁写进去的：网页、中控发消息时带的（web-api 入口 Checks.ts 的 checkGrants 查过）；
 * 渠道进来的话按人、按群从库里查到的，和本人这一轮说的“当轮授权”（approval 的 Grants.ts）。
 * 这些目录和下面的子目录里读写、跑命令、发文件不用再问用户：file-tools、飞书发文件、approval 审命令都读它。
 * @param address 会话现在记的回话地址。
 * @returns 授权目录（绝对路径）；没写是空数组。
 */
export function getGrantDirs(address: unknown): string[] {
  //M 地址里 grants.dirs 是入口校验过的绝对路径数组，直接取。
  const grants = utils.getField(address, 'grants');
  const dirs = utils.getField(grants, 'dirs');
  if (!Array.isArray(dirs)) return [];

  return dirs as string[];
}


/**
 * 把相对工作区的路径落成绝对路径。工作区、授权目录和目标都先解开符号链接再比，链接指到外面的算出了范围。
 * @param workspace 这一轮的工作区，绝对路径；相对路径照它解开。
 * @param relative 模型给的路径，相对工作区；写成绝对路径也行，但要在工作区或授权目录里面。
 * @param grantDirs 这一轮的授权目录（getGrantDirs）；落在这些目录和子目录里也算在范围内。没有传空数组。
 * @returns 解开链接后的绝对路径。
 * @throws 出了工作区和授权目录、断了的链接解不开时抛错。
 */
export function resolveWorkspacePath(workspace: string, relative: string, grantDirs: string[]): string {
  //M 目标路径照工作区解开，再解开符号链接，得到真正落在哪。
  const full = getReal(path.resolve(workspace, relative));

  //M 工作区和授权目录也解开链接，目标落在其中一个里面（目录本身也算）就行。
  const roots = [workspace, ...grantDirs].map((dir) => getReal(dir));
  if (isPathInDirectories(roots, full)) return full;

  //G 落到外面（../ 出去了、换了盘符、链接指出去）→ 不许。
  throw new Error(`路径出了工作区：${relative}（只能用工作区和授权目录里的路径）`);
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
