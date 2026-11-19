/** 处理渠道撤回，停止被撤的前后台轮次并拦截迟到回复。 */
import type * as cordis from 'cordis';
import * as protocol from '../../Channels.ts';
import * as textModule from '../../utils/Text.ts';
import * as dispatch from './DispatchResults.ts';
import type { DispatchResults } from './DispatchResults.ts';
import type { FrontDesk } from './FrontDesk.ts';

/** 保存已经确认的撤回及其渠道监听。 */
export class DispatchRecall {
  /** 拦截撤回瞬间在途的回复与后台回传，最多留 500 条。 */
  private readonly recalledMessages = new Set<string>();

  /** 在机器人插件的上下文处理撤回，向前台清理待判断消息。 */
  constructor(
    private readonly home: cordis.Context,
    private readonly desk: FrontDesk,
  ) {}

  /** 拦截一条迟到的消息或结果。 */
  has(messageId: string): boolean {
    //G 只拒绝已经通过授权检查并登记的撤回消息。
    return this.recalledMessages.has(messageId);
  }

  /** 以原来的顺序登记两个撤回关口。 */
  listen(queue: DispatchResults): void {
    //M 收到渠道撤回事件时移除未跑的排队项并喊停正在跑的前台与派生后台会话。
    this.home.on('channel/recall', (event) => {
      this.onChannelRecall(event, queue);
    });

    //M 拦截原消息已撤回但在途的 channel/reply 请求，直接回传 rejected 回执，不再外发。
    this.home.on('channel/reply', (request) => {
      if (!this.recalledMessages.has(request.sourceSnapshot.messageId)) return;

      request.handled = true;
      const receipt: protocol.ReplyReceipt = {
        v: 2,
        ok: false,
        status: 'rejected',
        replyRequestKey: request.replyRequestKey,
        replyRoundKey: request.replyRoundKey,
        replyIndex: request.replyIndex,
        kind: request.kind,
        parts: request.parts.map((part) => ({
          partId: part.partId,
          kind: part.kind,
          status: 'rejected',
          reason: 'recalled：原消息已撤回，不再发送回复',
        })),
        reason: 'recalled：原消息已撤回，不再发送回复',
        at: Date.now(),
      };

      //M 发一个 channel/replied 回执（rejected）：让发的一方知道这条没发出去，别一直等。
      this.home.emit('channel/replied', {
        requestId: request.requestId,
        replyRoundKey: request.replyRoundKey,
        receipt,
      });
    }, { prepend: true });
  }

  /**
   * 登记已撤回的标准消息号（最多保留 500 条），用于拦截撤回瞬间在途的回复与延迟回传。
   * @param messageId 标准消息 ID。
   */
  private rememberRecalled(messageId: string): void {
    //M 将撤回消息号记入有限缓存集合，超过上限时删掉最早一条防内存增长。
    this.recalledMessages.add(messageId);
    if (this.recalledMessages.size <= 500) return;

    const oldest = this.recalledMessages.values().next().value;
    if (oldest !== undefined) {
      this.recalledMessages.delete(oldest);
    }
  }

  /**
   * 校验撤回事件是否有权停掉该来源快照对应的任务：须同一消息号与账号，且撤回人是本人或原发送人。
   * @param event 渠道撤回事件。
   * @param snapshot 排队或活动项持有的不可变来源快照。
   * @returns 有权撤停返回 true，否则 false。
   */
  private canRecallSnapshot(
    event: protocol.ChannelRecallEvent,
    snapshot: protocol.SourceSnapshot | undefined,
  ): boolean {
    if (snapshot === undefined) return false;
    if (snapshot.messageId !== event.messageId) return false;
    if (snapshot.channel !== event.channel || snapshot.accountId !== event.accountId) return false;

    //G 本人（owner）允许撤停本人或同来源会话里的该条任务。
    if (event.recalledBy.isOwner) return true;

    //G 非本人只允许原发信人撤回自己的消息，且必须与快照发送人一致。
    if (event.recalledBy.kind !== 'sender') return false;
    if (event.recalledBy.id === '') return true;

    return event.recalledBy.id === snapshot.senderId;
  }

  /**
   * 响应 channel/recall：清理未开跑的排队项与待判断列表，喊停正在跑的前台轮与派出的后台会话，且不外发“已停止”。
   * @param event 渠道撤回事件。
   */
  private onChannelRecall(event: protocol.ChannelRecallEvent, queue: DispatchResults): void {
    //M 清掉排在 judgeLater 里等待当前轮结束才判断接话的同源消息。
    this.desk.cancelRecall(event);

    const ownerRecall = event.recalledBy.isOwner;
    const claimTargetPrefix = event.messageId;

    //M 1. 扫描所有前台会话：从队列移走未开始的被撤回项，并停掉正在跑该消息的当前轮。
    const matchedFront = this.recallFront(event, queue);

    //M 2. 清理派出的后台，阻止结果再交回前台。
    const matchedWork = this.recallWork(event);

    //M 3. 处理直接投给指定会话的消息。
    const matchedDirect = this.recallDirect(event, claimTargetPrefix);
    if (ownerRecall || matchedFront || matchedWork || matchedDirect) {
      //M 记住已授权撤回的消息号，拦截随后几毫秒内可能晚到的在途回复或后台 acceptResult。
      this.rememberRecalled(event.messageId);
    }
  }

  /** 清掉前台排队项，并停止这一条消息正在进行的轮次。 */
  private recallFront(event: protocol.ChannelRecallEvent, queue: DispatchResults): boolean {
    let matchedAuthorized = false;
    //M 扫描前台的活动轮与队列，找到这条撤回消息对应的会话。
    for (const meta of this.home.sessions.find({ kind: 'front' })) {
      const maybeActive = meta.activeSourceSnapshot?.messageId === event.messageId;
      const queueItems = meta.resultQueue ?? [];
      const maybeQueued = queueItems.some((item) => item.payload.sourceSnapshot?.messageId === event.messageId);
      if (!maybeActive && !maybeQueued) {
        continue;
      }

      //M 打开命中会话并取出队列，准备清理尚未开跑的被撤回排队项。
      const front = this.home.sessions.open(meta.id);
      const beforeQueue = front.row.resultQueue ?? [];
      //M 剔除所有尚在排队（stage 为 queued）且属于同一授权撤回消息的条目。
      const nextQueue = beforeQueue.filter((item) => {
        if (item.stage !== 'queued') return true;
        if (!this.canRecallSnapshot(event, item.payload.sourceSnapshot)) return true;

        matchedAuthorized = true;
        return false;
      });
      if (nextQueue.length !== beforeQueue.length) {
        //M 将删去被撤回排队项后的队列存盘。
        front.row.resultQueue = nextQueue;
        front.save();
      }

      //M 检查当前正在处理的那一项是否就是被撤回的原消息。
      const activeItem = dispatch.getActive(front.row);
      const activeSnap = activeItem?.payload.sourceSnapshot ?? front.row.activeSourceSnapshot;
      if (this.canRecallSnapshot(event, activeSnap)) {
        //M 登记该撤回消息号并清理可能等待触发的零次回复修补定时器。
        matchedAuthorized = true;
        this.rememberRecalled(event.messageId);
        queue.cancelRepairTimer(front.id);

        if (activeItem?.replyControl !== undefined) {
          //M 将本轮回复控制标为已撤回，避免触发修复轮或直接发最后的话并持久化。
          activeItem.replyControl.reminder = 'used';
          activeItem.replyControl.outcome = 'recalled';
        }
        if (front.row.state === 'running') {
          //M 先落盘结构化撤停标记供 Bots.onChange 识别并阻止外发“已停止”，再立即喊停该前台轮。
          front.row.recalledStop = true;
          front.save();
          front.stop('用户撤回了消息');
        }
        if (front.row.state !== 'running') {
          //M 非运行中但更新过 replyControl 时落盘持久化。
          front.save();
        }
        if (front.row.state !== 'running' && activeItem !== undefined && activeItem.stage === 'working') {
          //M 若卡在首轮刚结束待修复定时器的间隙，主动收尾释放 activeKey 并继续处理队列里别人的话。
          queue.finishChannelFront(front, activeItem);
        }
      }
    }
    return matchedAuthorized;
  }

  /** 扫描后台会话，停止正在跑或还有待处理队列的任务。 */
  private recallWork(event: protocol.ChannelRecallEvent): boolean {
    let matchedAuthorized = false;
    //M 通过后台继承的来源快照找到从该条消息派出的任务。
    for (const meta of this.home.sessions.find({ kind: 'work' })) {
      const workSnap = meta.frontTask?.sourceSnapshot ?? meta.activeSourceSnapshot;
      //G 后台也按原消息与发送人核对撤回权限。
      if (!this.canRecallSnapshot(event, workSnap)) {
        continue;
      }

      //M 登记撤回消息号防止并发交回并检查该后台会话是否仍在跑或有排队项。
      matchedAuthorized = true;
      this.rememberRecalled(event.messageId);
      const hasWaiting = dispatch.getWaiting(meta.resultQueue ?? []).length > 0;
      if (meta.state !== 'running' && !hasWaiting) {
        continue;
      }

      //M 先移除队列里未开始的项并将 frontTask.paused 与 recalledStop 落盘，防止 stop 后 returnWork 或外发“已停止”。
      const work = this.home.sessions.open(meta.id);
      work.row.resultQueue = (work.row.resultQueue ?? []).filter((item) => item.stage !== 'queued');
      if (work.row.frontTask !== undefined) {
        work.row.frontTask.paused = true;
      }
      if (work.row.state === 'running') {
        work.row.recalledStop = true;
      }
      //M 持久化清理后的后台队列与停跑标记，防止紧接的 stop 回传前台。
      work.save();

      if (work.row.state === 'running') {
        //M 掐断正在等待的模型请求与工具信号，彻底停下该派出后台任务，随即清掉瞬时撤停标记。
        work.stop('用户撤回了消息');
        delete work.row.recalledStop;
        work.save();
      }
    }
    return matchedAuthorized;
  }

  /** 检查直接投递到其他种类会话的撤回。 */
  private recallDirect(event: protocol.ChannelRecallEvent, claimTargetPrefix: string): boolean {
    let matchedAuthorized = false;
    //M 直接投递可进入前后台之外的会话，用认领记录定位。
    for (const meta of this.home.sessions.find({})) {
      if (meta.kind === 'front' || meta.kind === 'work' || meta.state !== 'running') {
        continue;
      }

      //M 核对会话是否确实认领过该标准消息号。
      const claimKey = protocol.getClaimKey(claimTargetPrefix, meta.bot);
      if (!(meta.sourceClaims ?? []).includes(claimKey)) {
        continue;
      }

      //M 核对渠道与账号是否匹配撤回事件。
      const sameChannel = meta.channel === event.channel;
      const addrAccount = textModule.getText(meta.address, 'appId');
      const sameAccount = addrAccount === '' || addrAccount === event.accountId;
      if (!sameChannel || !sameAccount) {
        continue;
      }

      //M 非本人时只允许原发送人撤回自己触发的会话，绝不越权停别人。
      const addrSender = textModule.getText(meta.address, 'openId');
      let allowedOther = event.recalledBy.isOwner;
      if (!allowedOther && event.recalledBy.kind === 'sender') {
        allowedOther = event.recalledBy.id === '' || addrSender === '' || event.recalledBy.id === addrSender;
      }
      if (!allowedOther) {
        continue;
      }

      matchedAuthorized = true;
      //M 先记下结构化撤停标记再停掉该直接投递会话，由 Bots.onChange 拦截外发“已停止”后随即清除瞬时标记。
      const target = this.home.sessions.open(meta.id);
      target.row.recalledStop = true;
      target.save();
      target.stop('用户撤回了消息');
      delete target.row.recalledStop;
      target.save();
    }

    return matchedAuthorized;
  }
}
