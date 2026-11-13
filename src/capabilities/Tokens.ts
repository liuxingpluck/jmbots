/**
 * 访问令牌（docs/界面/05_外部AI任务通道.md 第 3 节；用户 11-06 原话第 66 节）：外面来的请求要带一个有效的 token。
 * 可以有多个，每个有名字（给谁用的）、值、永久或临时（几分钟后失效）。存在运行时 data/tokens.json；
 * config 的 http.token 和环境变量 JMBOTS_TOKEN 照样认，当成永久的（不列出来，也不能在这里删）。只有本机能管：新建、刷新、删除。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';


/** 最近用过的时间多久写一次盘，毫秒（每个请求都写太勤）。 */
const USED_FLUSH_MS = 60_000;


/** 一个令牌。 */
export interface TokenInfo {
  /** 号（建的时间戳加随机数，删、刷新时用）。 */
  id: string;
  /** 名字：给谁用的，比如 grokbots、Claude、手机。 */
  name: string;
  /** 值：请求带的就是它。 */
  value: string;
  /** 临时的：建好或刷新后几分钟失效；永久的没有这一项。 */
  minutes?: number;
  /** 建的时间，毫秒。 */
  createdAt: number;
  /** 失效的时间，毫秒；永久的没有。 */
  expiresAt?: number;
  /** 最近一次用的时间，毫秒；没用过没有。 */
  usedAt?: number;
}


/**
 * 新的令牌值：jmb_ 开头，后面 24 个随机字符。
 */
function newValue(): string {
  return `jmb_${crypto.randomBytes(18).toString('base64url')}`;
}


/**
 * 两段字一样不一样（比较时间不随内容变，防按时间猜）。
 * @param actual 带来的。
 * @param expected 存着的。
 */
function sameText(actual: string, expected: string): boolean {
  /** 两边的字节。 */
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}


/**
 * 令牌的存取。HttpChannel（src/channels/Http.ts）启动时建一个。
 * 副作用：构造时读 data/tokens.json；改动时写回（先写临时文件再改名）。
 */
export class TokenStore {
  /** 令牌文件 data/tokens.json。 */
  private readonly file: string;

  /** config 的 http.token、环境变量 JMBOTS_TOKEN 那几个老的（空的已去掉），当成永久的。 */
  private readonly fixed: string[];

  /** 内存里的一份。 */
  private tokens: TokenInfo[] = [];

  /** 上次写盘的时间。 */
  private flushedAt = 0;

  /**
   * @param runtimeDir 运行时目录（令牌在 data/tokens.json）。
   * @param legacy config 的 http.token、环境变量 JMBOTS_TOKEN（空的跳过），当成永久的。
   */
  constructor(runtimeDir: string, legacy: string[]) {
    this.file = path.join(runtimeDir, 'data', 'tokens.json');
    try {
      this.tokens = JSON.parse(fs.readFileSync(this.file, 'utf8')) as TokenInfo[];
    } catch {
      this.tokens = [];
    }
    this.fixed = legacy.filter(Boolean);
  }

  /** 全部（新的在前），过期的也在，标着 expiresAt。 */
  list(): TokenInfo[] {
    /** 按建的时间从新到旧。 */
    const sorted = [...this.tokens].sort((left, right) => right.createdAt - left.createdAt);
    return sorted.map((item) => ({ ...item }));
  }

  /** 新建：minutes 写了是临时的。 */
  create(name: string, minutes?: number): TokenInfo {
    /** 名字。 */
    const label = name.trim();
    if (!label) {
      throw new Error('要写名字：给谁用的');
    }
    if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0)) {
      throw new Error(`临时令牌的分钟数要大于 0，现在是 ${String(minutes)}`);
    }
    /** 现在。 */
    const now = Date.now();
    /** 新的。 */
    const token: TokenInfo = {
      id: `${String(now)}${crypto.randomBytes(3).toString('hex')}`,
      name: label,
      value: newValue(),
      createdAt: now,
      ...(minutes ? { minutes, expiresAt: now + minutes * 60_000 } : {}),
    };
    this.tokens.push(token);
    this.save();
    return { ...token };
  }

  /** 换一个新值（旧值马上失效）；临时的从现在重新计时。 */
  refresh(id: string): TokenInfo {
    /** 那一个。 */
    const token = this.find(id);
    token.value = newValue();
    if (token.minutes) {
      token.expiresAt = Date.now() + token.minutes * 60_000;
    }
    this.save();
    return { ...token };
  }

  /** 删掉。 */
  remove(id: string): void {
    this.find(id);
    this.tokens = this.tokens.filter((item) => item.id !== id);
    this.save();
  }

  /** 有没有任何能用的令牌（含 config 里的）：一个都没有时，外面来的请求不查（和原来“配了 token 才查”一样）。 */
  hasAny(): boolean {
    return this.fixed.length > 0
      || this.tokens.some((item) => !item.expiresAt || item.expiresAt > Date.now());
  }

  /** 这个值对不对、过没过期；对的话记下用的时间。 */
  check(value: string): boolean {
    if (!value) {
      return false;
    }
    if (this.fixed.some((item) => sameText(value, item))) {
      return true;
    }
    /** 对上的那一个。 */
    const token = this.tokens.find(
      (item) => sameText(value, item.value) && (!item.expiresAt || item.expiresAt > Date.now()),
    );
    if (!token) {
      return false;
    }
    token.usedAt = Date.now();
    //M 用的时间不必每次都写盘：隔一分钟写一次就够看。
    if (Date.now() - this.flushedAt > USED_FLUSH_MS) {
      this.save();
    }
    return true;
  }

  /** 写盘。 */
  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, `${JSON.stringify(this.tokens, null, 2)}\n`, 'utf8');
    fs.renameSync(`${this.file}.tmp`, this.file);
    this.flushedAt = Date.now();
  }

  /**
   * 找一个。
   * @param id 号。
   * @throws 没有时抛错。
   */
  private find(id: string): TokenInfo {
    /** 那一个。 */
    const token = this.tokens.find((item) => item.id === id);
    if (!token) {
      throw new Error(`没有令牌 ${id}`);
    }
    return token;
  }
}
