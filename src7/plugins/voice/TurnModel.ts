/** 用中文短句与截断句训练轻量字符尾部分类器，直接对实时字幕打分。 */

export const LOCAL_TURN_MODEL = 'builtin:zh-tail-v1';

//M 独立的有意图和陈述样本覆盖问句、请求与回答；中断样本覆盖续接词和缺宾语。
const COMPLETE = [
  '现在什么天气', '查查周末深圳的天气', '看看本周的日程', '让我看看今天的日程',
  '给我一份清单', '整理一下采购清单', '提醒我带门禁卡', '提醒我关窗',
  '打开浏览器', '重新打开浏览器', '把备忘录发给我', '给同事的邮件也发给我',
  '我已经收到文件了', '下载任务结束了', '声音开小一点', '屏幕亮一点',
  '把标题改成合同审核', '把名字改成年度总结', '把文件名换成会议纪要', '这是周会的会议纪要',
  '请先读取说明文件', '重新打开日程文件', '搜索上个月的记录', '留一份操作记录',
  '你能听清吗', '现在方便说话吗', '这周还有空位吗', '这个方法可以吗',
  '下一步该怎么做', '这个按钮怎么用', '我要怎么操作', '这份报表怎么打开',
  '给我最新的下载地址', '发一下会议的地址', '帮忙看一下设备状态', '显示当前运行状态',
  '总结刚才的讨论', '概括一下这段内容', '查询订阅的余额', '帮我看看还剩多少余额',
  '关闭语音播报', '先停止自动播报', '恢复原来的配置', '保存这次修改的配置',
  '把报告存到桌面', '把收据保存到桌面', '检查本机的网络', '刷新一下页面',
  '直接发送消息', '只显示未读消息', '列一下项目依赖', '查查软件的版本',
  '这次先这样吧', '可以结束了', '好的谢谢', '我知道了',
];

const INCOMPLETE = [
  '麻烦你先把', '我想让你把', '你能不能帮', '麻烦帮我',
  '这次我需要你', '你可不可以', '先帮我找一下', '我想查一下',
  '请查一查这个', '你把那个', '帮我看下明天的', '发给负责审核的',
  '帮我下载一个', '我想打开一份', '记得给他发一条', '只保留其中一项的',
  '准备好以后就', '等到下班之后', '如果系统启动了就', '检查完之后再',
  '我这次说的是', '刚才那一段是', '请替我确认一下是不是', '你想要知道什么叫',
  '完成这项任务之前', '先记下来然后', '找完资料以后', '把那个按钮打开并且',
  '帮我设置会议时间和', '我还想加一点但是', '今天没去公司因为', '这个工具可以用不过',
  '在电脑上找到那个', '发一份给', '现在给我一个', '先不要改这个的',
  '检查我弹出来的', '我要把它放到', '把备份移动到', '你能帮我把它改成',
  '换成我喜欢用的', '那个文件里面有', '我准备先删除', '我这次想整理',
  '这边还有一个问题是', '你能告诉我', '我之所以选它是因为', '再打开一个叫',
  '给项目增加一个叫作', '先打开设置中的', '如果云端切换到', '请帮我查看位于',
  '你现在记一下关于', '我本来想要', '好像遇到了一个', '请把刚刚那个',
];

/** 从句尾提取位置敏感的一到三个字符，用于训练和预测。 */
function getTail(text: string): string[] {
  const normalized = text.normalize('NFKC').replace(/[\s\p{P}]+/gu, '');
  const tail = [...normalized].slice(-3);
  return [tail.slice(-1).join(''), tail.slice(-2).join(''), tail.join('')];
}

/** 等量正负样本的平滑频数比，只在有足够句尾证据时提前断句。 */
export class TurnModel {
  private readonly counts = new Map<string, number[]>();

  /** 在资源准入后一次建立模型词表，后续评分只查三个特征。 */
  constructor() {
    const groups = [INCOMPLETE, COMPLETE];
    for (const [label, samples] of groups.entries()) {
      for (const sample of samples) {
        //M 正负样本共享特征形式，每个特征保留两类频数。
        const tails = getTail(sample);
        for (const tail of tails) {
          const count = this.counts.get(tail) ?? [0, 0];
          count[label] = count[label]! + 1;
          this.counts.set(tail, count);
        }
      }
    }
  }

  /** 中文证据不足时返回 false，由原有端点规则继续等待。 */
  isComplete(text: string): boolean {
    if (!/\p{Script=Han}/u.test(text)) return false;

    let odds = 0;
    //M 罕见或未见的短句尾保持静音兜底，连续多个现有特征才能提高把握。
    const tails = getTail(text);
    for (const [index, tail] of tails.entries()) {
      const count = this.counts.get(tail);
      if (count === undefined) continue;

      //M 单字和更长的词尾共享样本，降低单字权重，避免一个名词就触发提前断句。
      let weight = 1;
      if (index === 0) {
        weight = 0.5;
      }
      const ratio = (count[1]! + 0.5) / (count[0]! + 0.5);
      odds += weight * Math.log(ratio);
    }
    return odds >= 2.6;
  }
}
