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
import type * as types from '../Types.ts';
import * as stepsView from './StepsView.tsx';


/** 运行中的会话多久重取一次详情和步骤，毫秒。 */
const POLL_MS = 2000;


/** 停下时给后端记的原因（进 steps，是数据不是界面文字，不翻译）。 */
const STOP_REASON = '不想让它继续了';


/**
 * 默认选中：从工作区带进来的 → 运行中的第一个 → 最近更新的第一个。
 * @param sessions 会话列表。
 * @param panelSessionId 从工作区点进来时设的会话号，可能没有。
 */
function defaultSession(sessions: api.SessionBrief[], panelSessionId: string | null): string | null {
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


/** 会话页。 */
export function Session(): react.JSX.Element {
  const t = i18n.useT();
  const masked = privacy.useMask();
  /** 正在聊的机器人。 */
  const bot = context.useUi((state) => state.currentBot);
  /** 从工作区点进来时选的会话。 */
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
  /** 出错的原因、一句话提示。 */
  const [error, setError] = react.useState('');
  const [notice, setNotice] = react.useState('');

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
    void Promise.all([api.sessions(bot), api.models()]).then(
      ([sessions, modelList]) => {
        if (stopped) {
          return;
        }
        setList(sessions);
        setModels(modelList.filter((model) => model.kind === 'chat'));
        setSelected(defaultSession(sessions, panelSessionId));
      },
      (problem: unknown) => {
        if (!stopped) {
          setError(problem instanceof Error ? problem.message : String(problem));
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
      void api.sessions(bot).then((sessions) => {
        if (stopped) {
          return;
        }
        setList(sessions);
        setSelected((old) => (
          picked.current && old !== null && (sessions.some((item) => item.id === old) || old === panelSessionId)
            ? old
            : defaultSession(sessions, picked.current ? null : panelSessionId) ?? old
        ));
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
        const nextDetail = await api.sessionDetail(selected);
        if (stopped) {
          return;
        }
        setDetail(nextDetail);
        setError('');
        if (withSteps || nextDetail.status === 'running') {
          /** 步骤。 */
          const nextSteps = await api.sessionSteps(selected);
          if (!stopped) {
            setSteps(nextSteps);
          }
        }
        timer = setTimeout(() => void load(false), POLL_MS);
      } catch (problem) {
        if (!stopped) {
          setError(problem instanceof Error ? problem.message : String(problem));
        }
      }
    };
    void load(true);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [selected, reloadKey]);

  /** 控制条上的模型：用户挑的优先，其次是详情里的。 */
  const model = pickModel ?? detail?.model ?? '';
  /** 控制条上的思考档：'' 是默认（最高档）。 */
  const thinking = pickThinking ?? detail?.thinking ?? '';
  /** 现在这个模型支持的思考档。 */
  const thinkingLevels = models.find((item) => item.id === model)?.thinking ?? [];

  /** 手动刷新：重取列表（保留还存在的选中），详情和步骤跟着 reloadKey 重取。 */
  const refresh = (): void => {
    if (bot) {
      void api.sessions(bot).then(
        (sessions) => {
          setList(sessions);
          //G 选中的会话没了（比如被删）就退回默认选中。
          setSelected((old) => (
            old !== null && sessions.some((item) => item.id === old)
              ? old
              : defaultSession(sessions, panelSessionId)
          ));
        },
        (problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem)),
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
    const nextThinking = thinking === '' ? null : thinking;
    void api.changeSessionModel(selected, model, nextThinking).then(
      (result) => {
        //M 用返回值更新这一行；轮询开着的话下一轮也会带回同样的值。
        setDetail((old) => (old === null
          ? old
          : { ...old, model: result.model, thinking: result.thinking, status: result.status }));
        setPickModel(null);
        setPickThinking(null);
        setNotice(t('已换成 {model}，下一步生效', { model: result.model }));
      },
      (problem: unknown) => {
        setNotice(t('没换成：{error}', { error: problem instanceof Error ? problem.message : String(problem) }));
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
        setNotice(t('没停下来：{error}', { error: problem instanceof Error ? problem.message : String(problem) }));
      },
    );
  };

  /** 打开会话 md：走现有的文件预览。 */
  const openMd = (): void => {
    //G 详情还没取到就没得开。
    if (detail === null) {
      return;
    }
    openPanel('preview', { path: detail.files.md, name: privacy.name(detail.title, masked) });
  };

  /**
   * 状态的人话。
   * @param status idle、running、error。
   */
  const statusText = (status: string): string => {
    if (status === 'running') {
      return t('运行中');
    }
    return status === 'error' ? t('出错') : t('空闲');
  };

  /**
   * 状态标签的颜色。
   * @param status idle、running、error。
   */
  const statusColor = (status: string): string => {
    if (status === 'running') {
      return 'green';
    }
    return status === 'error' ? 'red' : 'default';
  };

  if (!bot) {
    return <div className="jm-empty">{t('还没有选中机器人')}</div>;
  }
  return (
    <div className="jm-session">
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
            ...list.map((item) => ({
              value: item.id,
              title: item.id,
              label: `${privacy.name(item.title === '' ? item.id : item.title, masked)}（${statusText(item.status)}）`,
            })),
            //M 正在跑的后台子会话不在清单里，选中时补一项，免得下拉是空的。
            ...(selected !== null && !list.some((item) => item.id === selected)
              ? [{
                  value: selected,
                  title: selected,
                  label: `${privacy.name(detail !== null && detail.id === selected && detail.title !== '' ? detail.title : selected, masked)}（${statusText(detail?.status ?? 'running')}）`,
                }]
              : []),
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
          <antd.Button size="small" icon={<icons.FileTextOutlined />} onClick={openMd}>
            {t('打开会话 md')}
          </antd.Button>
        )}
      </div>
      {selected !== null && (
        <div className="jm-session-id" title={selected}>{t('会话号 {id}', { id: selected })}</div>
      )}
      {detail !== null && (
        <div className="jm-session-controls">
          <antd.Tag color={statusColor(detail.status)}>{statusText(detail.status)}</antd.Tag>
          <span className="jm-muted jm-session-workspace" title={privacy.text(detail.workspace, masked)}>{privacy.text(detail.workspace, masked)}</span>
          <antd.Select
            className="jm-session-model"
            size="small"
            value={model === '' ? undefined : model}
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
      {notice && <div className="jm-muted jm-session-notice">{privacy.text(notice, masked)}</div>}
      {error && <div className="jm-field-error">{privacy.text(error, masked)}</div>}
      <stepsView.StepsView steps={steps} />
    </div>
  );
}
