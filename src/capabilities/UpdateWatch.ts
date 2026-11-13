/**
 * 新版本发审核卡片（用户 11-06：“既然壳子 我可以去点击 更新版本，那就 说明可以作为 功能接口提供出来的，后续也要变成 发送审核卡片 在我不在电脑前 能够用飞书之类的去审核哈”）。
 * 隔一会问基地有没有新版本；有就记一条待确认、发卡片到能发的渠道，放行就叫基地换。
 * 拒绝过的版本不再问（左下角还能手动更新）；换完或换失败以后，把结果发回发过卡片的渠道。
 * 基地没开、没配地址就什么也不做。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as utils from '../utils/Utils.ts';
import * as versions from '../Versions.ts';
import type * as approvalsModule from './Approvals.ts';
import type * as depsModule from './Deps.ts';
import type * as resourcesModule from '../resources/Resources.ts';


/** 多久问一次基地，毫秒。 */
const POLL_MS = 60_000;

/** 启动后等多久才第一次问：等渠道连上，换版本的结果才发得出去。 */
const FIRST_CHECK_MS = 10_000;

/** 问基地最多等多久，毫秒。 */
const REQUEST_TIMEOUT_MS = 5000;

/** 卡片上更新内容最多多少字。 */
const CHANGES_MAX_CHARS = 600;

/** 来了更新的版本时，旧卡片算谁拒绝的。 */
const SUPERSEDED = '有更新的版本了';


/** 基地的 /update 回的（local/src/supervisor.rs 的 status）。 */
interface UpdateStatus {
  /** 正在跑的版本。 */
  current: { version: string } | null;
  /** 能换的新版本；没有是 null。 */
  available: { version: string; changes: { version: string; changes: string[] }[] } | null;
  /** 正在换吗。 */
  applying: boolean;
  /** 上一次换的结果。 */
  message: string;
}


/** 记在 data/update_watch.json 的：程序重启以后还要知道。 */
interface SavedState {
  /** 用户拒绝过的版本，不再问。 */
  declined?: string;
  /** 放行以后正在换的版本，和结果发回哪些渠道。 */
  swapping?: { version: string; channels: string[] };
}


/**
 * 问基地现在的更新状态。
 * @param base 基地的地址。
 * @returns 状态；基地没开、回的不对是 undefined。
 */
async function fetchStatus(base: string): Promise<UpdateStatus | undefined> {
  try {
    /** 回应。 */
    const response = await fetch(`${base}/update`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response.ok ? ((await response.json()) as UpdateStatus) : undefined;
  } catch {
    return undefined;
  }
}


/**
 * 盯新版本：隔一会问基地，有新版本发审核卡片，放行就叫基地换。
 * 入口 src/entries/App.ts 建一个，调 start()。
 */
export class UpdateWatch {
  /** 发过卡片的版本和待确认号；这个进程记着的。 */
  asked: { version: string; id: number } | undefined;

  /** 这个进程已经叫基地开始换了（测试要读它，等基地完成 apply）。 */
  applied: boolean | undefined;

  /** 是否已经停了：stop() 之后不再约下一次。 */
  private stopped = false;

  /** 下一次问的定时器。 */
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param resources 运行时资源：运行时目录、indexUrl 设置、机器人列表；入口建。
   * @param approvals 待确认登记表：新版本挂一条待确认；入口建。
   * @param out 往渠道发东西的出口：渠道中心 ChannelHub（src/channels/index.ts），入口 src/entries/App.ts 最先建它，
   *   渠道开起来以前发会报“渠道没开”。
   */
  constructor(
    private readonly resources: resourcesModule.Resources,
    private readonly approvals: approvalsModule.Approvals,
    private readonly out: depsModule.Outlet,
  ) {}

  /**
   * 开始盯新版本。
   * 副作用：起一个一直跑的定时器（每分钟问一次，启动后 10 秒第一次问）。
   */
  start(): void {
    this.stopped = false;
    this.timer = setTimeout(() => this.tick(), FIRST_CHECK_MS);
  }

  /** 停下：清掉定时器，不再问。 */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * 问一次：放行过的报结果；有没问过的新版本就发卡片。
   * 副作用：发卡片、发话，写状态文件。
   */
  async check(): Promise<void> {
    /** 基地的地址。 */
    const base = this.resources.getSetting('indexUrl')?.replace(/\/+$/, '');
    /** 基地说的状态。 */
    const status = base ? await fetchStatus(base) : undefined;
    //G 基地没开、正在换：等下一次。
    if (!base || !status || status.applying) {
      return;
    }
    /** 记着的。 */
    const saved = await this.readSaved();

    //M 放行过的报结果。同一个进程要等它真的叫基地开始换以后才算：决定和开始换之间不能抢着报“没换成”。
    if (saved.swapping && (this.asked?.version !== saved.swapping.version || this.applied)) {
      /** 那个版本。 */
      const { version, channels } = saved.swapping;
      await this.writeSaved({ ...saved, swapping: undefined });
      //M 换没换成看自己的版本号：报结果的就是正在跑的这个进程。不看基地的 current，它 30 秒才扫一次，
      //M 新进程起来 10 秒就来报，那时基地手里还是旧版本号，会把换好了报成“没更新到 X：换好了”（11-06 用户截图里 0.3.4、0.3.5 都这样）。
      /** 报给用户的结果。 */
      const resultText = versions.VERSIONS[0]?.version === version
        ? `已更新到 ${version}。`
        : `没更新到 ${version}：${status.message || '基地没说原因'}`;
      await this.notify(channels, resultText);
      return;
    }

    //G 没有新版本、拒绝过、问过了：不问。
    /** 新版本。 */
    const available = status.available;
    /** 发卡片用哪个机器人。 */
    const bot = this.resources.listBots()[0]?.name;
    if (!available || !bot || saved.declined === available.version
      || this.asked?.version === available.version) {
      return;
    }

    //M 来了更新的版本，旧卡片作废，发新的。
    if (this.asked) {
      this.approvals.decide(this.asked.id, false, SUPERSEDED);
    }
    /** 待确认。 */
    const asked = this.approvals.ask({
      bot,
      sessionId: '',
      title: `有新版本 ${available.version}`,
      command: `更新到 ${available.version}（现在是 ${status.current?.version ?? '未知'}）`,
      workDir: '',
      review: {
        what: utils.truncate(
          available.changes.flatMap((item) => item.changes).join('；'),
          CHANGES_MAX_CHARS,
        ),
        risk: '后端会重启，正在跑的会话会被打断。基地先试运行新版本，通过才替换，失败退回旧版本。',
        advice: '不急的话等手上的活干完再放行，这张卡片一直有效。',
      },
    });
    this.asked = { version: available.version, id: asked.id };
    this.applied = false;
    /** 那条待确认。 */
    const pending = this.approvals.list().find((item) => item.id === asked.id)!;
    /** 卡片发到了哪些渠道。 */
    const channels = await this.out.sendApproval('http', {}, pending)
      .catch(() => [] as string[]);
    void asked.wait
      .then((decision) => this.onDecided(base, available.version, channels, decision))
      .catch((error: unknown) => {
        console.error(`${utils.formatTime()} 处理更新的决定出错：${utils.errorText(error)}`);
      });
  }

  /** 问一次，再约下一次；出错不能让它停下。 */
  private tick(): void {
    void this.check()
      .catch((error: unknown) => {
        console.error(`${utils.formatTime()} 查新版本出错：${utils.errorText(error)}`);
      })
      .finally(() => {
        if (!this.stopped) {
          this.timer = setTimeout(() => this.tick(), POLL_MS);
        }
      });
  }

  /** 状态文件的路径。 */
  private stateFile(): string {
    return path.join(this.resources.dir, 'data', 'update_watch.json');
  }

  /**
   * 读状态文件。
   * @returns 记着的；没有或坏了是空的。
   */
  private async readSaved(): Promise<SavedState> {
    try {
      return JSON.parse(await fs.readFile(this.stateFile(), 'utf8')) as SavedState;
    } catch {
      return {};
    }
  }

  /**
   * 写状态文件。
   * @param saved 要记的。
   */
  private async writeSaved(saved: SavedState): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile()), { recursive: true });
    await fs.writeFile(this.stateFile(), JSON.stringify(saved), 'utf8');
  }

  /**
   * 把话发到几个渠道（发给最近私聊的人）；一个发不出去不挡别的。
   * @param channels 渠道名。
   * @param text 话。
   */
  private async notify(channels: string[], text: string): Promise<void> {
    for (const channel of channels) {
      await this.out.send(channel, {}, text).catch((error: unknown) => {
        console.error(`${utils.formatTime()} 更新结果没发到 ${channel}：${utils.errorText(error)}`);
      });
    }
  }

  /**
   * 用户决定了：放行就叫基地换，拒绝就记下这个版本不再问。
   * @param base 基地的地址。
   * @param version 这张卡片说的版本。
   * @param channels 卡片发到了哪些渠道。
   * @param decision 用户的决定。
   * 副作用：写状态文件；叫基地换版本（后端随后会重启）；失败时发话。
   */
  private async onDecided(
    base: string,
    version: string,
    channels: string[],
    decision: approvalsModule.ApprovalDecision,
  ): Promise<void> {
    /** 记着的。 */
    const saved = await this.readSaved();
    if (!decision.approve) {
      if (decision.by !== SUPERSEDED) {
        await this.writeSaved({ ...saved, declined: version });
      }
      return;
    }
    await this.writeSaved({ ...saved, swapping: { version, channels } });
    try {
      /** 回应。 */
      const response = await fetch(`${base}/update/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      this.applied = true;
    } catch (error) {
      await this.writeSaved(saved);
      const failText = `没开始更新到 ${version}：${utils.errorText(error)}。可以在左下角手动更新。`;
      await this.notify(channels, failText);
    }
  }
}
