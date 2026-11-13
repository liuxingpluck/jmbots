/**
 * 标题栏里的鲸鱼娘（用户 11-06 原话第 46、48～50 节）：跟着机器人在做什么换图，静态图加 CSS 动起来。
 * 闲着：在几种样子里随机换，看着你那张会眨眼；分派：法官（敲锤）、船长、看海图；干活：领头的她；查资料：放大镜、看书；
 * 等审核、做完、出错各有一张。标题栏小，平时只露上半身；鼠标放上去弹出整张图。数据和进度卡片同一份（/api/progress）。
 * 干活条（用户 11-06 原话第 62 节：“顶部标题栏 一定要有特效……加上 有一只ai形象在工作的东西”）：她右边的空地上，
 * 每件在跑的事站一个分身（最多 5 个，多的写“+N”），按它在做什么换图、动起来，旁边写哪件事、现在在做什么、干了多久；点一下打开右栏“工作区”。
 * 在跑、却没有进度卡片的会话（换版本重启后接着跑的、审核放行后接着跑的）也站一个，写“接着干”，不计时。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import type * as types from '../Types.ts';
import * as images from './Images.ts';


/** 多久问一次进度，毫秒。 */
const REFRESH_MS = 2000;

/** 闲着时多久换一种样子，毫秒。 */
const IDLE_CHANGE_MS = 45_000;

/** 眨眼间隔和闭眼多久，毫秒。 */
const BLINK_EVERY_MS = 5000;
const BLINK_MS = 160;

/** 敲锤两张图来回换的间隔，毫秒。 */
const GAVEL_MS = 600;

/** 做完、出错的样子留多久，毫秒。 */
const AFTER_MS = 8000;

/** 干活条最多站几个（标题栏就这么宽），多的写“+N”。 */
const MAX_WORKERS = 5;

/** 闲着的几种样子（每种有 _1、_2 两张）。 */
const IDLE_KINDS = ['idle_watch', 'idle_think', 'idle_float', 'idle_bubble', 'idle_wave', 'idle_wink', 'idle_sleepy'];

/** 分派的几种样子。 */
const DISPATCH_KINDS = ['dispatch_judge', 'dispatch_captain', 'dispatch_map'];

/** 查资料的几种样子。 */
const SEARCH_KINDS = ['search_magnifier', 'search_book'];

/** 算作“查资料”的工具。 */
const SEARCH_TOOLS = /调用 (web_search|find|read|memory)/;


/** 现在是什么状态。 */
export type Mood = 'idle' | 'dispatch' | 'work' | 'search' | 'wait' | 'done' | 'error';


/**
 * 随便挑一个。
 * @param list 候选。
 */
function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}


/**
 * 从这个机器人的进度算出现在的状态。
 * @param items 进度（新的在前）。
 * @param waiting 机器人在等人点审核。
 */
export function moodOf(items: types.ProgressView[], waiting: boolean): Mood {
  /** 还在做的。 */
  const live = items.filter((item) => item.endedAt === undefined);
  /** 刚做完的。 */
  const recent = items.find((item) => item.endedAt !== undefined && Date.now() - item.endedAt < AFTER_MS);
  if (live.some((item) => item.stage === 'dispatching')) {
    return 'dispatch';
  }
  if (waiting) {
    return 'wait';
  }
  if (live.some((item) => SEARCH_TOOLS.test(item.action))) {
    return 'search';
  }
  if (live.length > 0) {
    return 'work';
  }
  if (recent?.stage === 'error') {
    return 'error';
  }
  return recent?.stage === 'done' ? 'done' : 'idle';
}


/**
 * 干活条上一件事用哪张图：分派是船长，查资料拿放大镜或看书，等审核举牌子，别的是抱文件或打字的分身。
 * @param item 这件事的进度。
 * @param index 第几个（同一种样子错开两张图，站在一起不一样）。
 * @returns 图的名字（images.IMAGES 的键）。
 */
export function workerFigure(item: types.ProgressView, index: number): string {
  /** 第几张。 */
  const n = index % 2 === 0 ? 1 : 2;
  if (item.stage === 'dispatching') {
    return `dispatch_captain_${n}`;
  }
  if (SEARCH_TOOLS.test(item.action)) {
    return `${index % 2 === 0 ? 'search_magnifier' : 'search_book'}_1`;
  }
  return `${Math.floor(index / 2) % 2 === 0 ? 'work_mini_typing' : 'work_mini'}_${n}`;
}


/**
 * 干了多久，写成计时器的样子：“0:35”“12:05”“1:02:05”。
 * @param ms 毫秒。
 */
export function clockOf(ms: number): string {
  /** 一共几秒。 */
  const total = Math.max(0, Math.floor(ms / 1000));
  /** 时、分、秒。 */
  const [hours, minutes, seconds] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  /** 两位数。 */
  const two = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${String(hours)}:${two(minutes)}:${two(seconds)}` : `${String(minutes)}:${two(seconds)}`;
}


/**
 * 干活条：每件在跑的事一个分身，带着哪件事、现在在做什么、干了多久。没在干活时什么也不画。
 * @param props live 还在做的事（新的在前）；onOpen 点一下做什么。
 */
function WorkStrip(props: { live: types.ProgressView[]; onOpen: () => void }): react.JSX.Element | null {
  const t = i18n.useT();
  /** 现在，每秒走一下，计时跟着跳。 */
  const [now, setNow] = react.useState(Date.now());
  react.useEffect(() => {
    if (props.live.length === 0) {
      return undefined;
    }
    /** 定时器。 */
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [props.live.length]);
  if (props.live.length === 0) {
    return null;
  }
  //M 先开始的站前面，和左栏“正在做的事”一个顺序。
  /** 站出来的几个。 */
  const shown = [...props.live].sort((left, right) => left.startedAt - right.startedAt).slice(0, MAX_WORKERS);
  return (
    <div className="jm-workstrip" aria-label={t('正在干活：{count} 件', { count: props.live.length })}>
      {shown.map((item, index) => (
        <button
          key={item.id}
          type="button"
          className={`jm-worker jm-worker-${item.stage === 'dispatching' ? 'dispatch' : 'work'}`}
          style={{ animationDelay: `${String(index * 0.35)}s` }}
          title={`${item.sessionTitle ?? item.text}\n${item.action}${item.model ? `\n${item.model}` : ''}`}
          onClick={props.onOpen}
        >
          <img className="jm-worker-figure" style={{ animationDelay: `${String(index * 0.25)}s` }} src={images.IMAGES[workerFigure(item, index)] ?? images.IMAGES.work_mini_1} alt="" />
          <span className="jm-worker-text">
            <span className="jm-worker-title">{item.sessionTitle ?? item.text}</span>
            <span className="jm-worker-action">
              <span className="jm-worker-doing">{item.action}</span>
              <span className="jm-worker-dots" aria-hidden="true"><i /><i /><i /></span>
              {item.startedAt > 0 && <span className="jm-worker-clock">{clockOf(now - item.startedAt)}</span>}
            </span>
          </span>
        </button>
      ))}
      {props.live.length > MAX_WORKERS && <span className="jm-worker-more">+{props.live.length - MAX_WORKERS}</span>}
    </div>
  );
}


/**
 * 标题栏的鲸鱼娘。
 * @param props bot 是现在看的机器人。
 */
export function Mascot(props: { bot: string | undefined }): react.JSX.Element | null {
  const t = i18n.useT();
  const openPanel = context.useUi((state) => state.openPanel);
  /** 这个机器人的进度。 */
  const [items, setItems] = react.useState<types.ProgressView[]>([]);
  /** 这个机器人在跑的会话（有的没有进度卡片）。 */
  const [running, setRunning] = react.useState<api.SessionBrief[]>([]);
  /** 机器人在不在等人点审核。 */
  const waiting = context.useUi((state) => state.bots.find((item) => item.name === props.bot)?.status === 'waiting');
  /** 这一种状态里挑中的样子和第几张（换状态、闲着到点时重挑）。 */
  const [variant, setVariant] = react.useState({ kind: 'idle_watch', n: 1 });
  /** 眨眼、敲锤：第二张图在不在显示。 */
  const [alt, setAlt] = react.useState(false);
  /** 还在做的事。 */
  const live = items.filter((item) => item.endedAt === undefined);
  /** 在跑、却没有进度卡片的会话，补成一件事（不计时：开始时间是 0）。 */
  const orphans = running
    .filter((session) => !live.some((item) => item.sessionId === session.id))
    .map((session, index): types.ProgressView => ({ id: -1 - index, bot: props.bot ?? '', messageIds: [], text: session.title, sessionId: session.id, sessionTitle: session.title, model: session.model, stage: 'running', action: t('接着干'), startedAt: 0 }));
  /** 现在的状态。 */
  const mood = moodOf([...items, ...orphans], waiting);

  react.useEffect(() => {
    if (!props.bot) {
      return undefined;
    }
    /** 停了没有。 */
    let stopped = false;
    /** 问一次。 */
    const load = (): void => {
      void api.progress(props.bot ?? '').then((next) => !stopped && setItems(next), () => undefined);
      void api.sessions(props.bot ?? '', 'running').then((next) => !stopped && setRunning(next), () => undefined);
    };
    load();
    /** 定时器。 */
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [props.bot]);

  //M 换状态时重挑样子；闲着时隔一阵换一种。
  react.useEffect(() => {
    /** 挑一种。 */
    const choose = (): void => {
      /** 这种状态的候选。 */
      const kinds = { idle: IDLE_KINDS, dispatch: DISPATCH_KINDS, search: SEARCH_KINDS, work: ['work_lead'], wait: ['wait_approval'], done: ['done_happy'], error: ['error_oops'] }[mood];
      setVariant({ kind: pick(kinds), n: pick([1, 2]) });
    };
    choose();
    if (mood !== 'idle') {
      return undefined;
    }
    /** 定时器。 */
    const timer = setInterval(choose, IDLE_CHANGE_MS);
    return () => clearInterval(timer);
  }, [mood]);

  //M 看着你那张会眨眼；法官那张会敲锤。
  react.useEffect(() => {
    setAlt(false);
    if (variant.kind === 'idle_watch') {
      /** 定时器。 */
      const timer = setInterval(() => {
        setAlt(true);
        setTimeout(() => setAlt(false), BLINK_MS);
      }, BLINK_EVERY_MS);
      return () => clearInterval(timer);
    }
    if (variant.kind === 'dispatch_judge') {
      /** 定时器。 */
      const timer = setInterval(() => setAlt((old) => !old), GAVEL_MS);
      return () => clearInterval(timer);
    }
    return undefined;
  }, [variant]);

  if (!props.bot) {
    return null;
  }
  /** 第二张图的名字（眨眼、敲锤）。 */
  const altKind = { idle_watch: 'idle_watch_blink', dispatch_judge: 'dispatch_judge_hit' }[variant.kind];
  /** 主图。 */
  const src = images.IMAGES[`${alt && altKind ? altKind : variant.kind}_${variant.n}`] ?? images.IMAGES.idle_watch_1;
  /** 给人看的一句话。 */
  const label = { idle: t('闲着'), dispatch: t('正在分派'), work: t('正在干活'), search: t('正在查资料'), wait: t('等你审核'), done: t('做完了'), error: t('出错了') }[mood];
  return (
    <div className="jm-mascot-area">
      <antd.Popover placement="bottom" content={<img className="jm-mascot-full" src={src} alt={label} />}>
        <div className={`jm-mascot jm-mascot-${mood}`} aria-label={label}>
          <img className="jm-mascot-main" src={src} alt={label} />
        </div>
      </antd.Popover>
      <WorkStrip live={[...live, ...orphans]} onOpen={() => openPanel('workspace')} />
    </div>
  );
}
