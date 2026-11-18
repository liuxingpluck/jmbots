/**
 * 右栏的“会话”页（G批设计 8.2）：选一个会话，换模型（模型+思考档）、停下、看步骤和分派记录。
 * 数据：详情每 2 秒轮询（捕捉 idle→running），步骤只在 running 时轮询；空闲时步骤只在打开/刷新取一次。
 * 出错显示错误文字，不静默。会话 md 由顶部的“打开会话 md”按钮走预览。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';
import * as vscodeLink from '../VscodeLink.tsx';
import type * as types from '../Types.ts';
import * as stepsView from './StepsView.tsx';


/** 运行中的会话多久重取一次详情和步骤，毫秒。 */
const POLL_MS = 2000;


/** 停下时给后端记的原因（进 steps，是数据不是界面文字，不翻译）。 */
const STOP_REASON = '不想让它继续了';

/** 主网页里打分时默认写入的评价者名字。 */
const DEFAULT_RATER = '用户';


/**
 * 默认选中：从工作区带进来的 → 运行中的第一个 → 最近更新的第一个。
 * @param sessions 会话列表。
 * @param panelSessionId 从工作区点进来时设的会话号，可能没有。
 */
function getDefaultSession(sessions: api.SessionBrief[], panelSessionId: string | null): string | null {
  //M 从「正在运行」点进来时，后台子会话不在下拉清单里（列表只给没有 parent 的），也要能选中。
  if (panelSessionId !== null) {
    return panelSessionId;
  }
  /** 运行中的第一个。 */
  const running = sessions.find((item) => item.status === 'running');
  if (running) {
    return running.id;
  }
  /** 最近更新的第一个（不依赖后端的排序，自己按 updatedAt 排）。 */
  const latest = sessions.toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
  return latest?.id ?? null;
}


/**
 * 会话页。
 * @returns 会话控制、打分与步骤展示面板元素。
 * 副作用：轮询会话列表与选中会话详情/步骤，读取模型与评价列表，切换模型、停下或打分时提交后端请求。
 */
export function Session(): react.JSX.Element {
  //M 获取翻译函数与演示打码开关，供状态文字与错误信息脱敏使用。
  const t = i18n.useT();
  const masked = privacy.useMask();
  /** 正在聊的机器人。 */
  //M 订阅当前选中的机器人，用于加载对应的会话列表。
  const bot = context.useUi((state) => state.currentBot);
  /** 从工作区点进来时选的会话。 */
  //M 订阅外部带入的会话号以及选会话、打开预览面板的全局动作。
  const panelSessionId = context.useUi((state) => state.panelSessionId);
  const selectSession = context.useUi((state) => state.selectSession);
  const openPanel = context.useUi((state) => state.openPanel);
  /** 会话列表（顶部选择用）。 */
  const [list, setList] = react.useState<api.SessionBrief[]>([]);
  /** 能用的聊天模型（kind === 'chat'）。 */
  const [models, setModels] = react.useState<api.ModelInfo[]>([]);
  /** 现在选中的会话号。 */
  const [selected, setSelected] = react.useState<string | null>(null);
  react.useEffect(() => { if (selected) selectSession(selected); }, [selected, selectSession]);
  /** 用户自己在下拉里挑过（挑过就不再自动换到新跑起来的会话）。 */
  const picked = react.useRef(false);
  /** 选中会话的详情和步骤。 */
  const [detail, setDetail] = react.useState<types.SessionDetail | null>(null);
  const [steps, setSteps] = react.useState<types.SessionStep[]>([]);
  /** 控制条上用户改过还没应用的模型/思考档；null 是跟着详情走。 */
  const [pickModel, setPickModel] = react.useState<string | null>(null);
  const [pickThinking, setPickThinking] = react.useState<string | null>(null);
  /** 手动刷新用：变了详情和步骤重取一遍。 */
  const [reloadKey, setReloadKey] = react.useState(0);
  /** 整个会话标签的滚动元素（.jm-session）：交给 StepsView 当虚拟滚动的滚动元素；挂上前是 null。 */
  const [scroller, setScroller] = react.useState<HTMLDivElement | null>(null);
  /** 出错的原因、一句话提示。 */
  const [error, setError] = react.useState('');
  const [notice, setNotice] = react.useState('');
  /** 模型评价列表（判断当前会话是否已打过分）。 */
  const [notesList, setNotesList] = react.useState<api.ModelNoteItem[]>([]);
  /** 打分条里的一句话评语。 */
  const [rateNote, setRateNote] = react.useState('');
  /** 正在保存会话打分。 */
  const [savingRate, setSavingRate] = react.useState(false);
  const getErrorText = (problem: unknown): string => {
    if (problem instanceof Error) return problem.message;

    return String(problem);
  };

  //M 换机器人、从工作区带进新会话：重取列表和模型清单，定默认选中。
  react.useEffect(() => {
    setList([]);
    setSelected(null);
    picked.current = false;
    setDetail(null);
    setSteps([]);
    setError('');
    setNotice('');
    if (!bot) {
      return undefined;
    }
    /** 停了没有。 */
    let stopped = false;
    //M 并行拉取机器人会话列表与模型清单，用于初始化顶部下拉与可选模型。
    void Promise.all([api.sessions(bot), api.models()]).then(
      ([sessions, modelList]) => {
        if (stopped) {
          return;
        }
        //M 仅在尚未卸载时更新会话清单、聊天模型及默认选中会话。
        setList(sessions);
        setModels(modelList.filter((model) => model.kind === 'chat'));
        setSelected(getDefaultSession(sessions, panelSessionId));
      },
      (problem: unknown) => {
        //G 列表加载失败且未卸载时展示可读错误原因。
        if (!stopped) {
          setError(getErrorText(problem));
        }
      },
    );
    return () => {
      stopped = true;
    };
  }, [bot, panelSessionId]);

  //M 会话列表每 2 秒重取一次：新开的后台会话自己出现，停下的不再显示运行中。
  //  用户没挑过就跟着默认选中走（有在跑的选在跑的）；挑过的只要还在就不动。
  react.useEffect(() => {
    if (!bot) {
      return undefined;
    }
    /** 停了没有。 */
    let stopped = false;
    /** 定时器。 */
    const timer = setInterval(() => {
      //M 定时拉取最新会话列表，同步新出现的后台任务和运行状态变化。
      void api.sessions(bot).then((sessions) => {
        if (stopped) {
          return;
        }
        setList(sessions);
        setSelected((old) => {
          if (picked.current && old !== null && (sessions.some((item) => item.id === old) || old === panelSessionId)) {
            return old;
          }
          let fallbackId: string | null = panelSessionId;
          if (picked.current) {
            fallbackId = null;
          }
          //M 用户未手动固定或原会话已失效时，按默认优先级重选目标会话。
          return getDefaultSession(sessions, fallbackId) ?? old;
        });
      }, () => undefined);
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [bot, panelSessionId]);

  //M 选中会话的详情和步骤：详情每 2 秒必轮询（不然刚跑起来的会话面板看不到 running，停下按钮一直灰）；
  //  步骤只在 running 时跟着轮询，空闲时只在打开/手动刷新时取一次（重的部分仍门控）。
  react.useEffect(() => {
    setDetail(null);
    setSteps([]);
    setError('');
    setNotice('');
    setPickModel(null);
    setPickThinking(null);
    if (!selected) {
      return undefined;
    }
    /** 停了没有。 */
    let stopped = false;
    /** 下一次的定时器。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /**
     * 取一次详情；withSteps 为真或会话在跑时连步骤一起取。
     * @param withSteps 要不要强制取步骤（打开/手动刷新时真）。
     */
    const load = async (withSteps: boolean): Promise<void> => {
      try {
        /** 详情。 */
        //M 请求当前选中会话的最新详情，捕捉运行状态与模型切换。
        const nextDetail = await api.sessionDetail(selected);
        if (stopped) {
          return;
        }
        setDetail(nextDetail);
        setError('');
        if (withSteps || nextDetail.status === 'running') {
          /** 步骤。 */
          //M 在首次打开、手动刷新或运行中时拉取完整步骤列表，空闲轮询跳过。
          const nextSteps = await api.sessionSteps(selected);
          if (!stopped) {
            setSteps(nextSteps);
          }
        }
        //M 本轮详情读取结束后预约下一次定时轮询。
        timer = setTimeout(() => void load(false), POLL_MS);
      } catch (problem) {
        //G 未卸载且请求报错时显示可读错误原因。
        if (!stopped) {
          setError(getErrorText(problem));
        }
      }
    };
    //M 选中会话变化或手动刷新后立即执行首次详情与步骤加载。
    void load(true);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [selected, reloadKey]);

  //M 查一次模型评价汇总，看当前用户在当前会话有没有打过分。
  react.useEffect(() => {
    if (!selected) {
      setNotesList([]);
      return undefined;
    }
    let stopped = false;
    //M 拉取模型评价汇总以匹配当前用户对本会话的历史打分。
    void api.getModelNotes().then((result) => {
      if (!stopped) {
        setNotesList(result.list);
      }
    }, () => undefined);
    return () => {
      stopped = true;
    };
  }, [selected, reloadKey]);

  //M 找出当前用户在当前会话打过的分（没有时是 undefined）。
  let myRating: api.ModelRatingItem | undefined;
  if (selected !== null) {
    for (const noteItem of notesList) {
      const hit = noteItem.ratings.find((rating) => rating.session === selected && rating.by === DEFAULT_RATER);
      if (hit !== undefined) {
        myRating = hit;
        break;
      }
    }
  }
  const syncedRateNote = myRating?.note ?? '';
  react.useEffect(() => {
    setRateNote(syncedRateNote);
  }, [selected, syncedRateNote]);

  /** 给当前会话打分或改分，写进后端并更新本地状态。 */
  const submitRate = async (score: number, noteText: string): Promise<void> => {
    if (!selected) return;

    setSavingRate(true);
    setError('');
    try {
      //M 整理评语并提交当前会话评分，写回后用于更新本地模型评价汇总。
      const trimmedNote = noteText.trim();
      const result = await api.rateSession({ session: selected, by: DEFAULT_RATER, score, note: trimmedNote });
      //M 更新当前模型评价，并去掉其它模型里同一会话同一人的旧记录。
      setNotesList((previous) => {
        const cleaned = previous
          .filter((item) => item.model !== result.note.model)
          .map((item) => ({
            ...item,
            ratings: item.ratings.filter((rating) => !(rating.session === selected && rating.by === DEFAULT_RATER)),
          }));
        return [...cleaned, result.note];
      });
      setNotice(`已打 ${String(score)} 分`);
    } catch (problem: unknown) {
      let reason = String(problem);
      if (problem instanceof Error) {
        reason = problem.message;
      }
      setError(`打分没存上：${reason}`);
    } finally {
      setSavingRate(false);
    }
  };

  /** 控制条上的模型：用户挑的优先，其次是详情里的。 */
  const model = pickModel ?? detail?.model ?? '';
  /** 控制条上的思考档：'' 是默认（最高档）。 */
  const thinking = pickThinking ?? detail?.thinking ?? '';
  /** 现在这个模型支持的思考档。 */
  const thinkingLevels = models.find((item) => item.id === model)?.thinking ?? [];

  /** 手动刷新：重取列表（保留还存在的选中），详情和步骤跟着 reloadKey 重取。 */
  const refresh = (): void => {
    if (bot) {
      //M 手动刷新时重取机器人会话列表，同步校验当前选中会话是否仍存在。
      void api.sessions(bot).then(
        (sessions) => {
          setList(sessions);
          //G 选中的会话没了（比如被删）就退回默认选中。
          setSelected((old) => {
            if (old !== null && sessions.some((item) => item.id === old)) return old;

            //M 原选中会话已不在清单中时回退按默认规则挑选目标会话。
            return getDefaultSession(sessions, panelSessionId);
          });
        },
        //G 刷新会话列表失败时显示可读错误原因。
        (problem: unknown) => setError(getErrorText(problem)),
      );
    }
    setReloadKey((key) => key + 1);
  };

  /** 应用：换模型和思考档，下一步调模型就生效。 */
  const applyModel = (): void => {
    //G 还没选中会话就没得换。
    if (!selected) {
      return;
    }
    setNotice('');
    /** 发过去的思考档：空串发 null（让会话用最高档）。 */
    let nextThinking: string | null = thinking;
    if (thinking === '') {
      nextThinking = null;
    }
    //M 提交新的模型与思考档配置，成功后更新详情展示并提示下一步生效。
    void api.changeSessionModel(selected, model, nextThinking).then(
      (result) => {
        //M 用返回值更新这一行；轮询开着的话下一轮也会带回同样的值。
        setDetail((old) => {
          if (old === null) return old;

          return { ...old, model: result.model, thinking: result.thinking, status: result.status };
        });
        setPickModel(null);
        setPickThinking(null);
        setNotice(t('已换成 {model}，下一步生效', { model: result.model }));
      },
      //G 切换模型失败时格式化错误信息并提示用户。
      (problem: unknown) => {
        setNotice(t('没换成：{error}', { error: getErrorText(problem) }));
      },
    );
  };

  /** 停下：只有在跑的会话能停；没停下来把后端给的原因显示出来。 */
  const stop = (): void => {
    //G 还没选中会话就没得停。
    if (!selected) {
      return;
    }
    setNotice('');
    //M 向后端发送停下请求并记录操作原因，按返回结果显示等待提示或失败原因。
    void api.stopSession(selected, STOP_REASON).then(
      (result) => {
        if (result.stopped) {
          setNotice(t('已要求停下，等它到检查点结束'));
          return;
        }
        //G stopped:false 时后端带 reason（例如“会话没在跑”），原样显示。
        setNotice(result.reason ?? t('没停下来'));
      },
      (problem: unknown) => {
        setNotice(t('没停下来：{error}', { error: getErrorText(problem) }));
      },
    );
  };

  /** 打开会话 md：走现有的文件预览。 */
  const openMd = (): void => {
    //G 详情还没取到就没得开。
    if (detail === null) {
      return;
    }
    //M 在右栏预览面板中打开当前会话对应的 Markdown 日志文件（标题按演示状态脱敏）。
    openPanel('preview', { path: detail.files.md, name: privacy.name(detail.title, masked) });
  };

  /**
   * 状态的人话。
   * @param status idle、running、error。
   */
  const getStatusText = (status: string): string => {
    if (status === 'running') return t('运行中');

    if (status === 'error') return t('出错');

    return t('空闲');
  };

  /**
   * 状态标签的颜色。
   * @param status idle、running、error。
   */
  const getStatusColor = (status: string): string => {
    if (status === 'running') return 'green';

    if (status === 'error') return 'red';

    return 'default';
  };

  if (!bot) {
    return <div className="jm-empty">{t('还没有选中机器人')}</div>;
  }
  const extraOptions: { value: string; title: string; label: string }[] = [];
  if (selected !== null && !list.some((item) => item.id === selected)) {
    let rawTitle = selected;
    if (detail !== null && detail.id === selected && detail.title !== '') {
      rawTitle = detail.title;
    }
    extraOptions.push({
      value: selected,
      title: selected,
      label: `${privacy.name(rawTitle, masked)}（${getStatusText(detail?.status ?? 'running')}）`,
    });
  }
  let modelValue: string | undefined = model;
  if (model === '') {
    modelValue = undefined;
  }
  return (
    <div className="jm-session" ref={setScroller}>
      <div className="jm-session-bar">
        <antd.Select
          className="jm-session-pick"
          size="small"
          value={selected ?? undefined}
          placeholder={t('选一个会话')}
          optionLabelProp="label"
          onChange={(value) => {
            picked.current = true;
            setSelected(value);
          }}
          options={[
            ...list.map((item) => {
              let itemTitle = item.title;
              if (itemTitle === '') {
                itemTitle = item.id;
              }
              return {
                value: item.id,
                title: item.id,
                label: `${privacy.name(itemTitle, masked)}（${getStatusText(item.status)}）`,
              };
            }),
            //M 正在跑的后台子会话不在清单里，选中时补一项，免得下拉是空的。
            ...extraOptions,
          ]}
        />
        <antd.Button
          size="small"
          type="text"
          icon={<icons.ReloadOutlined />}
          aria-label={t('刷新')}
          title={t('刷新')}
          onClick={refresh}
        />
        {/* 会话 md 由 journal 插件写；还没写（没挂 journal、会话还没说过话）时路径是空的，按钮不显示。 */}
        {detail !== null && detail.files.md !== '' && (
          <>
            <antd.Button size="small" icon={<icons.FileTextOutlined />} onClick={openMd}>
              {t('打开会话 md')}
            </antd.Button>
            {!masked && <vscodeLink.VsCodeOpen site={detail.files.md} />}
          </>
        )}
      </div>
      {selected !== null && (
        <div className="jm-session-id" title={selected}>{t('会话号 {id}', { id: selected })}</div>
      )}
      {detail !== null && (
        <div className="jm-session-controls">
          <antd.Tag color={getStatusColor(detail.status)}>{getStatusText(detail.status)}</antd.Tag>
          <span className="jm-muted jm-session-workspace" title={privacy.text(detail.workspace, masked)}>{privacy.text(detail.workspace, masked)}</span>
          <antd.Select
            className="jm-session-model"
            size="small"
            value={modelValue}
            placeholder={t('模型')}
            onChange={(value) => setPickModel(value)}
            options={models.map((item) => ({ value: item.id, label: item.name }))}
          />
          <antd.Select
            className="jm-session-thinking"
            size="small"
            value={thinking}
            onChange={(value) => setPickThinking(value)}
            options={[
              { value: '', label: t('默认（最高档）') },
              ...thinkingLevels.map((level) => ({ value: level, label: level })),
            ]}
          />
          <antd.Button size="small" type="primary" onClick={applyModel}>
            {t('应用')}
          </antd.Button>
          <antd.Button size="small" danger disabled={detail.status !== 'running'} onClick={stop}>
            {t('停下')}
          </antd.Button>
        </div>
      )}
      {selected !== null && detail !== null && (
        <div className="jm-session-rate">
          {myRating !== undefined && (
            <span className="jm-session-rate-done">{`已打 ${String(myRating.score)} 分`}</span>
          )}
          {myRating === undefined && (
            <span className="jm-session-rate-label">给这场打分</span>
          )}
          <antd.Rate
            allowClear={false}
            value={myRating?.score ?? 0}
            disabled={savingRate}
            onChange={(score) => void submitRate(score, rateNote)}
          />
          <antd.Input
            size="small"
            className="jm-session-rate-note"
            placeholder="一句话评语（可选，回车保存）"
            value={rateNote}
            disabled={savingRate}
            onChange={(event) => setRateNote(event.target.value)}
            onPressEnter={() => {
              if (myRating !== undefined) {
                void submitRate(myRating.score, rateNote);
              }
            }}
          />
          {myRating !== undefined && rateNote.trim() !== myRating.note && (
            <antd.Button
              size="small"
              loading={savingRate}
              //M 点击“存评语”时沿用当前已选分数提交更新后的评语内容。
              onClick={() => void submitRate(myRating.score, rateNote)}
            >
              存评语
            </antd.Button>
          )}
        </div>
      )}
      {notice && <div className="jm-muted jm-session-notice">{privacy.text(notice, masked)}</div>}
      {error && <div className="jm-field-error">{privacy.text(error, masked)}</div>}
      <stepsView.StepsView
        steps={steps}
        scrollParent={scroller}
        runtimeRoot={vscodeLink.getRuntimeRoot(detail?.files.md ?? '')}
      />
    </div>
  );
}
