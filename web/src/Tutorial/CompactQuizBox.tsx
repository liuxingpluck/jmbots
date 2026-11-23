/**
 * 教程页「4段路线」单块 10 秒自测页内直答交互框。
 * 不硬编码任何机器人名：目标批改机器人完全由上层从 GET /api/bots 动态拉取并自由切换，
 * 支持一键发送、有界轮询原地展示评语与过关状态、超时/失效自动停表重试，并一键跳转下一块。
 */
import * as react from 'react';
import type * as meta from './CompactMetaData.ts';
import * as quizModule from './QuizSubmit.ts';


/** CompactQuizBox 入参。 */
export interface CompactQuizBoxProps {
  /** 当前小块元数据。 */
  chunk: meta.StageChunk;
  /** 从 GET /api/bots 动态拉取的可用机器人列表。 */
  availableBots: readonly string[];
  /** 是否正在首次或重新拉取机器人列表。 */
  botsLoading: boolean;
  /** 拉取机器人列表失败时的中文报错；无错时为空串。 */
  botsError: string;
  /** 重新拉取机器人列表回调。 */
  onRetryBots: () => void;
  /** 当前选中的批改机器人名。 */
  selectedBot: string;
  /** 切换批改机器人回调。 */
  onSelectBot: (bot: string) => void;
  /** 本地持久化记录；尚未作答时为 undefined。 */
  record?: quizModule.QuizRecord;
  /** 本段内的下一学习小块；已是最后一块时为 undefined。 */
  nextChunk?: meta.StageChunk;
  /** 更新并持久化当前小块的自测记录。 */
  onUpdateRecord: (chunkId: string, next: quizModule.QuizRecord) => void;
  /** 过关后一键展开并聚焦下一块。 */
  onJumpNext?: (chunkId: string) => void;
}


/**
 * 渲染单块 10 秒自测交互区：题目 + 答题框 + 机器人选择 + 提交按钮 + 原地评语卡。
 */
export function CompactQuizBox(props: CompactQuizBoxProps): react.JSX.Element {
  const {
    chunk,
    availableBots,
    botsLoading,
    botsError,
    onRetryBots,
    selectedBot,
    onSelectBot,
    record,
    nextChunk,
    onUpdateRecord,
    onJumpNext,
  } = props;

  const [draft, setDraft] = react.useState<string>(record?.answer ?? '');
  const [syncFeishu, setSyncFeishu] = react.useState<boolean>(record?.syncFeishu === true);

  const status: quizModule.QuizStatus = record?.status ?? 'idle';
  const messageId = record?.messageId ?? null;
  const replyText = record?.replyText ?? '';
  const passed = record?.passed === true;
  const errorText = record?.error ?? '';
  const recordBot = record?.bot ?? '';
  const recordUpdatedAt = record?.updatedAt ?? 0;

  //M 优先采用用户当前选中机器人；列表刚到达且未选定时兜底取第一项。
  let activeBot = selectedBot;
  if (activeBot === '' && availableBots.length > 0) {
    activeBot = availableBots[0] ?? '';
  }

  //M 批改卡片署名优先展示发件时绑定的机器人，避免中途切下拉框篡改旧评语署名。
  let displayBot = recordBot;
  if (displayBot === '') {
    displayBot = activeBot;
  }
  if (displayBot === '') {
    displayBot = '批改机器人';
  }

  //M 轮询回调读取最新上下文的 ref，避免 pending 期间打字/切下拉/勾选触发 useEffect 重建风暴。
  const latestRef = react.useRef({
    recordBot,
    activeBot,
    draft,
    recordAnswer: record?.answer,
    recordUpdatedAt,
    syncFeishu,
    onUpdateRecord,
  });
  latestRef.current = {
    recordBot,
    activeBot,
    draft,
    recordAnswer: record?.answer,
    recordUpdatedAt,
    syncFeishu,
    onUpdateRecord,
  };

  /** 防重入守卫：记录当前正在请求中的消息号，避免慢网络/FRPC 高延迟时 setInterval 叠加并发 fetch。 */
  const inFlightRef = react.useRef<number | null>(null);

  //M 当处于待批改状态且有消息号时，启动有界定时轮询（上限 120 次 / 5 分钟，遇永久错误立刻停表）。
  react.useEffect(() => {
    if (status !== 'pending' || messageId === null) return;

    let cancelled = false;
    let attempts = 0;
    let timer = 0;
    const startedAt = Date.now();

    const stopTimer = (): void => {
      if (timer !== 0) {
        window.clearInterval(timer);
        timer = 0;
      }
    };

    const failWith = (reason: string, clearMessageId: boolean): void => {
      stopTimer();
      const latest = latestRef.current;
      let keptMessageId: number | null = messageId;
      if (clearMessageId) {
        keptMessageId = null;
      }
      latest.onUpdateRecord(chunk.id, {
        chunkId: chunk.id,
        bot: latest.recordBot || latest.activeBot,
        answer: latest.recordAnswer ?? latest.draft,
        messageId: keptMessageId,
        status: 'error',
        replyText: '',
        passed: false,
        error: reason,
        syncFeishu: latest.syncFeishu,
        updatedAt: Date.now(),
      });
    };

    const checkOnce = async (): Promise<void> => {
      //G 卸载后直接退出；同一消息号已有在途请求时跳过本次触发，避免叠加并发请求。
      if (cancelled || inFlightRef.current === messageId) return;

      //G 进入请求前先校验总次数与总超时上限，超限立刻停表转超时提示态。
      const now = Date.now();
      const latestBefore = latestRef.current;
      const reachedLimit =
        attempts >= quizModule.MAX_POLL_ATTEMPTS ||
        now - startedAt >= quizModule.MAX_POLL_MS ||
        quizModule.isPendingExpired(latestBefore.recordUpdatedAt, now);
      if (reachedLimit) {
        failWith(quizModule.PENDING_TIMEOUT_ERROR, false);
        return;
      }

      attempts += 1;
      inFlightRef.current = messageId;
      let outcome: quizModule.PollQuizResult;
      try {
        outcome = await quizModule.pollQuizReply(messageId);
      } finally {
        if (inFlightRef.current === messageId) {
          inFlightRef.current = null;
        }
      }

      //G 等待期间组件卸载或消息号已切换时放弃旧结果，防止脏写。
      if (cancelled) return;

      //M 收到真实评语：立刻停表、写入评语与过关判定。
      if (outcome.kind === 'reply') {
        stopTimer();
        const latest = latestRef.current;
        latest.onUpdateRecord(chunk.id, {
          chunkId: chunk.id,
          bot: latest.recordBot || latest.activeBot,
          answer: latest.recordAnswer ?? latest.draft,
          messageId,
          status: 'replied',
          replyText: outcome.text,
          passed: quizModule.detectQuizPassed(outcome.text),
          error: '',
          syncFeishu: latest.syncFeishu,
          updatedAt: Date.now(),
        });
        return;
      }

      //G 遇到 401/403/404/410 等永久性错误：立刻停表并给出清晰提示，绝不空转。
      if (outcome.kind === 'fatal') {
        failWith(outcome.reason, outcome.clearMessageId);
        return;
      }

      //G 本次仍是 pending 且已打满轮询上限：当场停表，不再空等下一个周期。
      const afterNow = Date.now();
      const reachedAfter =
        attempts >= quizModule.MAX_POLL_ATTEMPTS ||
        afterNow - startedAt >= quizModule.MAX_POLL_MS;
      if (reachedAfter) {
        failWith(quizModule.PENDING_TIMEOUT_ERROR, false);
      }
    };

    void checkOnce();
    timer = window.setInterval(() => {
      void checkOnce();
    }, quizModule.POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (inFlightRef.current === messageId) {
        inFlightRef.current = null;
      }
      stopTimer();
    };
  }, [status, messageId, chunk.id]);

  /** 提交回答给当前选中的机器人批改。 */
  const handleSubmit = async (): Promise<void> => {
    const trimmed = draft.trim();
    //G 空白回答、无可用机器人或正在发送中时忽略重复点击。
    if (trimmed === '' || activeBot === '' || status === 'sending') return;

    //M 先切入 sending 瞬态锁定按钮并持久化草稿，防止刷新丢字。
    onUpdateRecord(chunk.id, {
      chunkId: chunk.id,
      bot: activeBot,
      answer: trimmed,
      messageId: null,
      status: 'sending',
      replyText: '',
      passed: false,
      error: '',
      syncFeishu,
      updatedAt: Date.now(),
    });

    try {
      //M 发往 POST /api/message，拿到消息号后切入 pending 启动有界轮询。
      const sent = await quizModule.submitQuizAnswer(activeBot, chunk, trimmed, syncFeishu);
      onUpdateRecord(chunk.id, {
        chunkId: chunk.id,
        bot: activeBot,
        answer: trimmed,
        messageId: sent.messageId,
        status: 'pending',
        replyText: '',
        passed: false,
        error: '',
        syncFeishu,
        updatedAt: Date.now(),
      });
    } catch (err) {
      //G 提交失败回落到 error 态，展示服务端或网络原因供重试。
      let message = '发送失败，请稍后重试';
      if (err instanceof Error && err.message !== '') {
        message = err.message;
      }
      onUpdateRecord(chunk.id, {
        chunkId: chunk.id,
        bot: activeBot,
        answer: trimmed,
        messageId: null,
        status: 'error',
        replyText: '',
        passed: false,
        error: message,
        syncFeishu,
        updatedAt: Date.now(),
      });
    }
  };

  /** 超时或临时鉴权修复后，针对原消息号重新开启一轮有界查询。 */
  const handleRetryPoll = (): void => {
    if (messageId === null) return;

    //M 重置 updatedAt 与 error 并切回 pending，触发新一轮有界查询。
    onUpdateRecord(chunk.id, {
      chunkId: chunk.id,
      bot: recordBot || activeBot,
      answer: record?.answer ?? draft,
      messageId,
      status: 'pending',
      replyText: '',
      passed: false,
      error: '',
      syncFeishu,
      updatedAt: Date.now(),
    });
  };

  /** 支持 Ctrl+Enter / Cmd+Enter 快捷键直接发送。 */
  const handleKeyDown = (event: react.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void handleSubmit();
    }
  };

  //M 按当前提交状态拼装主按钮文案。
  let submitLabel = `🚀 发给 ${activeBot || '机器人'} 批改`;
  if (status === 'sending') {
    submitLabel = '⏳ 发送中...';
  }
  if (status === 'pending') {
    submitLabel = `🔄 重发给 ${activeBot || '机器人'}`;
  }
  if (status === 'replied') {
    submitLabel = `🔄 再发给 ${activeBot || '机器人'}`;
  }

  //M 机器人列表尚未就绪时区分加载中、加载失败与空清单占位文案。
  let emptyBotOption = '暂无可用机器人';
  if (botsLoading) {
    emptyBotOption = '加载机器人列表...';
  }
  if (!botsLoading && botsError !== '') {
    emptyBotOption = '机器人列表加载失败';
  }

  let replyCardCls = 'tu-cm-quiz-reply';
  if (passed) {
    replyCardCls = 'tu-cm-quiz-reply is-passed';
  }

  let verdictText = '🔁 继续巩固';
  if (passed) {
    verdictText = '✅ 已过关';
  }

  const canSubmit = draft.trim() !== '' && activeBot !== '' && status !== 'sending';
  const showBotsRetry = !botsLoading && (botsError !== '' || availableBots.length === 0);

  return (
    <div className="tu-cm-quiz-box" data-cm-quiz-body={chunk.id}>
      <div className="tu-cm-quiz-question">❓ {chunk.quiz}</div>

      <textarea
        className="tu-cm-quiz-input"
        rows={2}
        value={draft}
        placeholder="用大白话写下你的回答，选好右侧批改机器人直接发送（Ctrl+Enter 快捷键）..."
        data-cm-quiz-input={chunk.id}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />

      <div className="tu-cm-quiz-actions">
        <div className="tu-cm-quiz-controls">
          <label className="tu-cm-quiz-bot-picker">
            <span>批改机器人：</span>
            <select
              className="tu-cm-quiz-bot-select"
              value={activeBot}
              disabled={availableBots.length === 0}
              data-cm-quiz-bot={chunk.id}
              onChange={(event) => onSelectBot(event.target.value)}
            >
              {availableBots.length === 0 && <option value="">{emptyBotOption}</option>}
              {availableBots.map((botName) => (
                <option key={botName} value={botName}>
                  {botName}
                </option>
              ))}
            </select>
          </label>

          {showBotsRetry && (
            <button
              type="button"
              className="tu-cm-quiz-retry-btn"
              title={botsError || '重新拉取机器人列表'}
              data-cm-quiz-bots-retry={chunk.id}
              onClick={onRetryBots}
            >
              ↻ 重试加载
            </button>
          )}

          <label
            className="tu-cm-quiz-sync"
            title="勾选后，批改机器人会用它自己的机器人身份把评语顺手私聊发到你飞书（绝不模拟你发言）"
          >
            <input
              type="checkbox"
              checked={syncFeishu}
              onChange={(event) => setSyncFeishu(event.target.checked)}
            />
            <span>让机器人同步发飞书</span>
          </label>
        </div>

        <button
          type="button"
          className="tu-cm-quiz-submit"
          disabled={!canSubmit}
          data-cm-quiz-submit={chunk.id}
          onClick={() => {
            void handleSubmit();
          }}
        >
          {submitLabel}
        </button>
      </div>

      {!botsLoading && botsError !== '' && (
        <div className="tu-cm-quiz-error" role="alert">
          ⚠️ {botsError}
        </div>
      )}

      {status === 'pending' && messageId !== null && (
        <div className="tu-cm-quiz-pending" data-cm-quiz-pending={chunk.id}>
          ⏳ 已发给 {displayBot}（#{String(messageId)}），正在批改中，评语将自动显示在这里…
        </div>
      )}

      {status === 'error' && errorText !== '' && (
        <div className="tu-cm-quiz-error tu-cm-quiz-error-row" role="alert">
          <span>⚠️ {errorText}</span>
          {messageId !== null && (
            <button
              type="button"
              className="tu-cm-quiz-retry-btn"
              data-cm-quiz-poll-retry={chunk.id}
              onClick={handleRetryPoll}
            >
              🔍 重新查询
            </button>
          )}
        </div>
      )}

      {status === 'replied' && replyText !== '' && (
        <div className={replyCardCls} data-cm-quiz-reply={chunk.id}>
          <div className="tu-cm-quiz-reply-head">
            <span>🛡️ {displayBot} 批改</span>
            <span className="tu-cm-quiz-verdict">{verdictText}</span>
          </div>
          <div className="tu-cm-quiz-reply-body">{replyText}</div>
          {passed && nextChunk !== undefined && onJumpNext !== undefined && (
            <div className="tu-cm-quiz-next-row">
              <button
                type="button"
                className="tu-cm-quiz-next-btn"
                onClick={() => onJumpNext(nextChunk.id)}
              >
                👉 进入下一块：{nextChunk.title}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
