/**
 * 鲸鱼娘的界面小图（docs/界面/鲸鱼动效/素材 里的原图缩成高 640 的 WebP，透明背景），由脚本按文件名生成，别手改。
 * 形象参考“鲸鱼娘开源资产库”（CC BY-NC-SA 4.0）：发布给别人之前要用户定怎么署名或换原创（docs/界面/鲸鱼动效/提示词.md）。
 */
import dispatch_captain_1 from './whale/dispatch_captain_1.webp';
import dispatch_captain_2 from './whale/dispatch_captain_2.webp';
import dispatch_judge_1 from './whale/dispatch_judge_1.webp';
import dispatch_judge_2 from './whale/dispatch_judge_2.webp';
import dispatch_judge_hit_1 from './whale/dispatch_judge_hit_1.webp';
import dispatch_judge_hit_2 from './whale/dispatch_judge_hit_2.webp';
import dispatch_map_1 from './whale/dispatch_map_1.webp';
import dispatch_map_2 from './whale/dispatch_map_2.webp';
import done_happy_1 from './whale/done_happy_1.webp';
import done_happy_2 from './whale/done_happy_2.webp';
import error_oops_1 from './whale/error_oops_1.webp';
import error_oops_2 from './whale/error_oops_2.webp';
import idle_bubble_1 from './whale/idle_bubble_1.webp';
import idle_bubble_2 from './whale/idle_bubble_2.webp';
import idle_float_1 from './whale/idle_float_1.webp';
import idle_float_2 from './whale/idle_float_2.webp';
import idle_sleepy_1 from './whale/idle_sleepy_1.webp';
import idle_sleepy_2 from './whale/idle_sleepy_2.webp';
import idle_think_1 from './whale/idle_think_1.webp';
import idle_think_2 from './whale/idle_think_2.webp';
import idle_watch_1 from './whale/idle_watch_1.webp';
import idle_watch_2 from './whale/idle_watch_2.webp';
import idle_watch_blink_1 from './whale/idle_watch_blink_1.webp';
import idle_watch_blink_2 from './whale/idle_watch_blink_2.webp';
import idle_wave_1 from './whale/idle_wave_1.webp';
import idle_wave_2 from './whale/idle_wave_2.webp';
import idle_wink_1 from './whale/idle_wink_1.webp';
import idle_wink_2 from './whale/idle_wink_2.webp';
import search_book_1 from './whale/search_book_1.webp';
import search_book_2 from './whale/search_book_2.webp';
import search_magnifier_1 from './whale/search_magnifier_1.webp';
import search_magnifier_2 from './whale/search_magnifier_2.webp';
import wait_approval_1 from './whale/wait_approval_1.webp';
import wait_approval_2 from './whale/wait_approval_2.webp';
import work_lead_1 from './whale/work_lead_1.webp';
import work_lead_2 from './whale/work_lead_2.webp';
import work_mini_1 from './whale/work_mini_1.webp';
import work_mini_2 from './whale/work_mini_2.webp';
import work_mini_typing_1 from './whale/work_mini_typing_1.webp';
import work_mini_typing_2 from './whale/work_mini_typing_2.webp';



/**
 * 打包后的图片地址统一写成 /assets/文件名。打包给出的是相对地址（./xxx.webp），浏览器会按网页的地址 / 去找，
 * 取回来的是网页、显示成裂图（0.2.6 就是这样）；不同机器上的 Bun 给的写法也不一样，这里只取文件名再拼，哪种写法都对。
 * @param url 打包给的地址。
 */
function assetUrl(url: string): string {
  return `/assets/${url.split('/').pop() ?? url}`;
}


/** 打包给的原始地址。 */
const RAW: Record<string, string> = {
  dispatch_captain_1,
  dispatch_captain_2,
  dispatch_judge_1,
  dispatch_judge_2,
  dispatch_judge_hit_1,
  dispatch_judge_hit_2,
  dispatch_map_1,
  dispatch_map_2,
  done_happy_1,
  done_happy_2,
  error_oops_1,
  error_oops_2,
  idle_bubble_1,
  idle_bubble_2,
  idle_float_1,
  idle_float_2,
  idle_sleepy_1,
  idle_sleepy_2,
  idle_think_1,
  idle_think_2,
  idle_watch_1,
  idle_watch_2,
  idle_watch_blink_1,
  idle_watch_blink_2,
  idle_wave_1,
  idle_wave_2,
  idle_wink_1,
  idle_wink_2,
  search_book_1,
  search_book_2,
  search_magnifier_1,
  search_magnifier_2,
  wait_approval_1,
  wait_approval_2,
  work_lead_1,
  work_lead_2,
  work_mini_1,
  work_mini_2,
  work_mini_typing_1,
  work_mini_typing_2,
};


/** 文件名 → 图片地址。 */
export const IMAGES: Record<string, string> = Object.fromEntries(Object.entries(RAW).map(([name, url]) => [name, assetUrl(url)]));
