/**
 * 密钥替身（Secrets）：把密钥真值换成一个代号（如 {{secret:1}}），要用的时候在最后一刻换回来。
 * 为什么不能像旧版 utils.redactSecrets 那样直接抹成 ***：抹掉之后那个值就废了，命令也就做不成了；
 * 替身让模型、数据库、日志从头到尾只见到代号，真值只在 unmask 那一层出现。
 * 本模块不读 config.yaml、不碰文件、不打印也不记录真值；除了 unmask 的返回值本身，任何函数都不交出真值。
 */


/** 替身的开头，如 {{secret:1}} 里的 “{{secret:”。 */
const NAME_HEAD = '{{secret:';

/** 替身的结尾。 */
const NAME_TAIL = '}}';

/** 文字里本来就有 {{secret:N}} 字样时，mask 先把它转义成这个，unmask 时再还原。 */
const LITERAL_HEAD = '{{secret-literal:';

/** 认得出的替身字样；括号里的数字是编号。 */
const NAME_PATTERN = /\{\{secret:(\d+)\}\}/g;

/** mask 转义过的字样，只由本模块生成，unmask 时还原成 {{secret:N}}。 */
const LITERAL_PATTERN = /\{\{secret-literal:(\d+)\}\}/g;

/** 长度不到 8 的真值不参与替换：太短会误伤正常文字。 */
const MIN_SECRET_LENGTH = 8;


/**
 * 密钥替身：真值 ↔ 代号来回换；只露 mask、unmask、names、add，没有取得真值的口子。
 * 入口 src/entries/App.ts 建一个，所有模块共用。
 * 构造时就把真值去重、按长度从长到短排好，mask/unmask 每次调用不再重排。
 */
export class Secrets {
  /** 真值 → 替身，mask 用。 */
  private readonly nameByValue = new Map<string, string>();

  /** 编号 → 真值，unmask 用。 */
  private readonly valueByNumber = new Map<number, string>();

  /** 按编号排好的替身列表，names() 用（列表里只有代号，没有真值）。 */
  private readonly aliasNames: string[] = [];

  /** 替换顺序：真值按长度从长到短，免得短密钥把长密钥切坏。 */
  private readonly maskOrder: string[];

  /**
   * @param values 密钥真值，即 Resources.getSecretValues() 返回的那些；
   *   空串和不到 8 个字的值直接忽略。没有合格的真值时 mask/unmask 都原样返回，names() 是空列表。
   * 副作用：无（只读参数，不读文件、不写日志、不打印）。
   */
  constructor(values: string[]) {
    /** 合格的真值：去重，保持传进来的顺序；编号按这个顺序从 1 开始，被忽略的、重复的不占号。 */
    const accepted = [...new Set(values)].filter((value) => value.length >= MIN_SECRET_LENGTH);

    //M 先把编号定下来：编号只跟传进来的顺序有关，跟后面按长度排序无关。
    for (const [offset, value] of accepted.entries()) {
      /** 这一条真值的编号，从 1 开始。 */
      const number = offset + 1;
      /** 这一条真值的替身。 */
      const name = `${NAME_HEAD}${number}${NAME_TAIL}`;
      this.nameByValue.set(value, name);
      this.valueByNumber.set(number, value);
      this.aliasNames.push(name);
    }

    //M 替换顺序另外排：长的先换，否则短密钥会把长密钥切坏（如 abcd1234 和 abcd12345678）。
    this.maskOrder = [...accepted].sort((left, right) => right.length - left.length);
  }

  /** 出去的方向：真值换成替身；输入文字，输出换过的文字，无副作用。 */
  mask(text: string): string {
    //G 没有合格真值就没什么可藏，原样返回（也就不用动文字里本来有的替身字样）。
    if (this.maskOrder.length === 0) {
      return text;
    }
    //M 文字里本来就有的 {{secret:N}} 不是我们生成的代号，先转义掉，否则 unmask 会把它当成代号换回真值。
    //G 转义成 {{secret-literal:N}}：跟真替身 {{secret:N}} 差一个 “-literal”，unmask 分得开；代价是原文不能恰好也写这个记号。
    let masked = text.replace(NAME_PATTERN, `${LITERAL_HEAD}$1${NAME_TAIL}`);
    //M 长的先换；同一个真值出现多次，由 split/join 一次全换。
    for (const value of this.maskOrder) {
      /** 这条真值对应的替身。 */
      const name = this.nameByValue.get(value);
      //G 两边来自同一份数据，查不到只可能是内部状态坏了；跳过，绝不把真值露出去。
      if (name === undefined) {
        continue;
      }
      masked = masked.split(value).join(name);
    }
    return masked;
  }

  /** 回来的方向：替身换回真值；输入文字，输出换回的文字（认不出的替身原样留着），无副作用。 */
  unmask(text: string): string {
    //G 没有替身就没什么可换，原样返回。
    if (this.valueByNumber.size === 0) {
      return text;
    }
    //M 认得出的替身换回真值；编号超范围的认不出来，原样留着，不抛错。
    const restored = text.replace(NAME_PATTERN, (matched: string, digits: string): string => {
      /** 替身里的编号。 */
      const number = Number(digits);
      /** 编号对应的真值。 */
      const value = this.valueByNumber.get(number);
      //G 认不出来（编号超范围）就原样留着。
      if (value === undefined) {
        return matched;
      }
      return value;
    });
    //M 最后还原 mask 转义过的字样；放在替身替换之后，免得刚还原出来的 {{secret:N}} 又被当成替身换掉。
    return restored.replace(LITERAL_PATTERN, `${NAME_HEAD}$1${NAME_TAIL}`);
  }

  /** 有哪些替身代号，如 ['{{secret:1}}', '{{secret:2}}']；输出代号列表（不含真值），无副作用。 */
  names(): string[] {
    //M 返回副本：调用方改了列表也不会打乱内部编号，列表里只有代号、没有真值。
    return [...this.aliasNames];
  }

  /**
   * 运行时加几个密钥真值（网页新建机器人时的飞书 app_secret，docs/界面/01_界面设计.md 6.2）：
   * 编号接着往后排，已有的、不到 8 个字的忽略。输入真值列表；改替身表，不打印。
   */
  add(values: string[]): void {
    for (const value of values) {
      if (value.length < MIN_SECRET_LENGTH || this.nameByValue.has(value)) {
        continue;
      }
      /** 编号：接着已有的往后排。 */
      const number = this.aliasNames.length + 1;
      /** 替身。 */
      const name = `${NAME_HEAD}${number}${NAME_TAIL}`;
      this.nameByValue.set(value, name);
      this.valueByNumber.set(number, value);
      this.aliasNames.push(name);
      this.maskOrder.push(value);
    }
    //M 照旧长的先换。
    this.maskOrder.sort((left, right) => right.length - left.length);
  }
}
