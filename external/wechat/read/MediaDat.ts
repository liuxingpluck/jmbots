/**
 * 微信图片 .dat 纯 Bun 解密与本地缩略图定位（支持微信 3.x 单字节 XOR 与微信 4.x V1/V2 AES-128-ECB + XOR）。
 * 只读访问本机微信已落盘文件与统计目录文件名，不联网、不扫进程内存、不向日志输出任何密钥或 UIN。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';


/** 微信 4.x V2 图片加密文件 6 字节魔数头（\x07\x08V2\x08\x07）。 */
export const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]);

/** 微信 4.x V1 图片加密文件 6 字节魔数头（\x07\x08V1\x08\x07）。 */
export const V1_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07]);

/** V1 / V2 加密图片的固定头部长度，单位字节。 */
const V2_HEADER_SIZE = 15;

/** AES-128 块与密钥字节数。 */
const AES_BLOCK_SIZE = 16;

/** 遍历目录文件名收集候选 UIN 时的最大访问条目数。 */
const DEFAULT_MAX_UIN_SCAN_FILES = 4000;

/** 匹配统计文件名中的 UIN（如 key_123456_xxx.statistic）。 */
const UIN_IN_FILENAME_RE = /(?:^|[_-])key_(\d{2,12})(?:[_.-]|$)/iu;

/** 匹配纯数字主文件名的统计/配置文件。 */
const BARE_UIN_STEM_RE = /^\d{4,12}$/u;

/** 收集 UIN 时跳过的海量媒体与缓存子目录名（小写）。 */
const SKIP_UIN_DIRS = new Set(['msg', 'attach', 'cache', 'video', 'file', 'image', 'temp', 'tmp']);

/** 常见图片与微信自有格式的文件头签名表。 */
const IMAGE_SIGNATURES: ReadonlyArray<{ magic: Buffer; mime: string }> = [
  { magic: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg' },
  { magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' },
  { magic: Buffer.from('GIF8', 'ascii'), mime: 'image/gif' },
  { magic: Buffer.from('BM', 'ascii'), mime: 'image/bmp' },
  { magic: Buffer.from('wxgf', 'ascii'), mime: 'image/wxgf' },
  { magic: Buffer.from('RIFF', 'ascii'), mime: 'image/webp' },
];


/** 已验证的微信 4.x V2 账号图片解密密钥（禁止打印到控制台或错误回执）。 */
export interface ImageCipherKey {
  /** 16 字节 AES-128-ECB 密钥。 */
  aesKey: Buffer;
  /** 尾部单字节异或掩码（0 至 255）。 */
  xorKey: number;
  /** 派生该密钥所用的数值 UIN（未知时为 0）。 */
  uin: number;
}

/** 解密成功后的图片字节与媒体类型。 */
export interface DecodedImage {
  /** 明文图片完整字节。 */
  data: Buffer;
  /** 依据文件头嗅探出的标准 MIME 类型。 */
  mime: string;
}

/** 图片文件解密时的上下文选项。 */
export interface DecryptImageOptions {
  /** 可选的项目内 image_key.json 持久化路径；命中新密钥后自动写回复用。 */
  keyFilePath?: string;
  /** 当前微信账号 wxid（用于与 UIN 拼接派生 V2 密钥）。 */
  accountName?: string;
  /** 用于按文件名枚举候选 UIN 的微信账号根目录列表。 */
  searchRoots?: readonly string[];
}

/** 图片解密失败的固定分类码（与原媒体回执一致）。 */
export type ImageDatErrorCode = 'not_found' | 'need_image_key' | 'decrypt_failed';

/** 带分类错误码的图片解密结果。 */
export type DecryptImageOutcome =
  | { ok: true; image: DecodedImage }
  | { ok: false; code: ImageDatErrorCode };


/**
 * 判断缓冲区前缀是否与给定魔数字节完全一致。
 * @param data 待检查字节。
 * @param magic 目标魔数。
 */
function hasPrefix(data: Uint8Array, magic: Uint8Array): boolean {
  if (data.byteLength < magic.byteLength) return false;

  for (let index = 0; index < magic.byteLength; index += 1) {
    if (data[index] !== magic[index]) return false;
  }
  return true;
}


/**
 * 根据明文头部字节嗅探图片 MIME 类型；无法识别时返回 `application/octet-stream`。
 * @param data 明文字节。
 */
export function sniffImageMime(data: Uint8Array): string {
  if (data.byteLength === 0) return 'application/octet-stream';

  for (const item of IMAGE_SIGNATURES) {
    //G 检查前缀是否匹配当前图片签名。
    if (!hasPrefix(data, item.magic)) {
      continue;
    }
    //G RIFF 容器还须在偏移 8..12 处确认为 WEBP，排除 WAV 音频。
    if (item.mime === 'image/webp' && data.byteLength >= 12) {
      const tag = Buffer.from(data.subarray(8, 12)).toString('ascii');
      if (tag !== 'WEBP') {
        continue;
      }
    }
    return item.mime;
  }
  return 'application/octet-stream';
}


/**
 * 判断字节头部是否为已知受支持的图片格式。
 * @param data 待检查字节。
 */
export function isSupportedImageBytes(data: Uint8Array): boolean {
  //M 嗅探结果不是通用二进制流即视为有效图片头。
  return sniffImageMime(data) !== 'application/octet-stream';
}


/**
 * 由数值 UIN 与账号 wxid 派生微信 4.x V2 图片的 16 字节 ASCII AES 密钥与单字节 XOR 密钥。
 * @param uin 账号 UIN 正整数或数字字符串。
 * @param accountName 清洗后的账号 wxid。
 */
export function deriveV2ImageKeys(uin: number | bigint | string, accountName: string): ImageCipherKey {
  const bigUin = BigInt(uin);
  const textInput = `${bigUin.toString(10)}${accountName}`;
  const md5Hex = crypto.createHash('md5').update(textInput, 'utf8').digest('hex');
  const aesKey = Buffer.from(md5Hex.slice(0, AES_BLOCK_SIZE), 'ascii');
  const xorKey = Number(bigUin & 0xffn);
  return { aesKey, xorKey, uin: Number(bigUin) };
}


/**
 * 解密老版微信整文件单字节 XOR 图片：用文件首字节与已知图片魔数异或反推密钥并校验完整魔数。
 * @param data 原始 .dat 文件字节。
 * @returns 解出的图片字节；若是 V1/V2 格式或无法匹配任何图片魔数则返回 undefined。
 */
export function decryptXorDat(data: Uint8Array): Buffer | undefined {
  if (data.byteLength < 4) return undefined;
  //G V1 / V2 头部走专用 AES-ECB 解密分支，不当单字节 XOR 误解。
  if (hasPrefix(data, V2_MAGIC) || hasPrefix(data, V1_MAGIC)) return undefined;

  const firstByte = data[0]!;
  for (const sig of IMAGE_SIGNATURES) {
    const xorKey = firstByte ^ sig.magic[0]!;
    const checkLen = Math.min(sig.magic.byteLength, data.byteLength);
    let matches = true;
    for (let index = 0; index < checkLen; index += 1) {
      if ((data[index]! ^ xorKey) !== sig.magic[index]!) {
        matches = false;
        break;
      }
    }
    if (!matches) {
      continue;
    }
    //G RIFF 头还须核对偏移 8..12 异或还原后确实是 WEBP。
    if (sig.mime === 'image/webp' && data.byteLength >= 12) {
      const webp = Buffer.allocUnsafe(4);
      for (let k = 0; k < 4; k += 1) {
        webp[k] = data[8 + k]! ^ xorKey;
      }
      if (webp.toString('ascii') !== 'WEBP') {
        continue;
      }
    }

    const plain = Buffer.allocUnsafe(data.byteLength);
    for (let pos = 0; pos < data.byteLength; pos += 1) {
      plain[pos] = data[pos]! ^ xorKey;
    }
    return plain;
  }
  return undefined;
}


/**
 * 解密微信 4.x V2（或同布局 V1）的 .dat 数据：15 字节头 + AES-128-ECB(PKCS7) + 单字节 XOR 尾部。
 * @param data 原始 .dat 字节。
 * @param aesKey 16 字节 AES-128 密钥。
 * @param xorKey 0..255 单字节尾部异或掩码。
 * @param expectedMagic 预期 6 字节头部魔数，默认 V2_MAGIC。
 * @returns 明文图片字节；头部、长度、PKCS7 填充或图片签名不合法时返回 undefined。
 */
export function decryptV2Dat(
  data: Uint8Array,
  aesKey: Uint8Array,
  xorKey: number,
  expectedMagic: Uint8Array = V2_MAGIC,
): Buffer | undefined {
  //G 校验头部魔数、密钥长度以及至少包含 1 个 AES 块。
  if (!hasPrefix(data, expectedMagic)) return undefined;
  if (data.byteLength < V2_HEADER_SIZE + AES_BLOCK_SIZE) return undefined;
  if (aesKey.byteLength !== AES_BLOCK_SIZE) return undefined;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const xorSize = view.getUint32(10, true);
  const aesSize = data.byteLength - V2_HEADER_SIZE - xorSize;
  if (aesSize < AES_BLOCK_SIZE || aesSize % AES_BLOCK_SIZE !== 0) return undefined;
  if (xorSize > data.byteLength - V2_HEADER_SIZE) return undefined;

  //M 关闭自动填充做 AES-128-ECB 整块解密，再手工校验 PKCS7 填充避免错密钥抛底层异常。
  const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, null);
  decipher.setAutoPadding(false);
  const cipherSlice = data.subarray(V2_HEADER_SIZE, V2_HEADER_SIZE + aesSize);
  const decryptedHead = Buffer.concat([decipher.update(cipherSlice), decipher.final()]);

  const padLen = decryptedHead[decryptedHead.byteLength - 1] ?? 0;
  if (padLen < 1 || padLen > AES_BLOCK_SIZE) return undefined;

  for (let i = decryptedHead.byteLength - padLen; i < decryptedHead.byteLength; i += 1) {
    if (decryptedHead[i] !== padLen) return undefined;
  }

  const unpaddedHead = decryptedHead.subarray(0, decryptedHead.byteLength - padLen);
  const maskedTail = data.subarray(V2_HEADER_SIZE + aesSize);
  const output = Buffer.allocUnsafe(unpaddedHead.byteLength + maskedTail.byteLength);
  unpaddedHead.copy(output, 0);

  const mask = xorKey & 0xff;
  for (let i = 0; i < maskedTail.byteLength; i += 1) {
    output[unpaddedHead.byteLength + i] = maskedTail[i]! ^ mask;
  }

  //G 还原出的头部必须是可识别图片魔数才认定成功。
  if (!isSupportedImageBytes(output)) return undefined;

  return output;
}


/**
 * 自动按头部魔数分发解密（V2 / V1 / 老版 XOR / 已是明文图片）。
 * @param data 原始 .dat 字节。
 * @param key 可选的 V1/V2 账号图片密钥。
 */
export function decryptDatBuffer(data: Uint8Array, key?: ImageCipherKey): DecodedImage | undefined {
  if (data.byteLength === 0) return undefined;

  if (hasPrefix(data, V2_MAGIC)) {
    if (key === undefined) return undefined;
    //M 按 V2 布局解密并嗅探图片类型。
    const plain = decryptV2Dat(data, key.aesKey, key.xorKey, V2_MAGIC);
    if (plain === undefined) return undefined;
    return { data: plain, mime: sniffImageMime(plain) };
  }

  if (hasPrefix(data, V1_MAGIC)) {
    if (key === undefined) return undefined;
    //M V1 拥有与 V2 完全一致的分段布局，仅文件头魔数不同。
    const plain = decryptV2Dat(data, key.aesKey, key.xorKey, V1_MAGIC);
    if (plain === undefined) return undefined;
    return { data: plain, mime: sniffImageMime(plain) };
  }

  //M 尝试老版单字节 XOR 解密。
  const xorPlain = decryptXorDat(data);
  if (xorPlain !== undefined) {
    return { data: xorPlain, mime: sniffImageMime(xorPlain) };
  }

  //G 极少数本地缓存已是明文图片，核对魔数通过后直接返回。
  if (isSupportedImageBytes(data)) {
    const copy = Buffer.from(data);
    return { data: copy, mime: sniffImageMime(copy) };
  }
  return undefined;
}


/**
 * 用 V2 文件的首个 16 字节 AES 密文块快速检验候选 AES 密钥能否解出合法图片签名。
 * @param sampleDat V2 .dat 样本字节。
 * @param aesKey 16 字节候选 AES 密钥。
 */
export function verifyV2AesKeyHead(sampleDat: Uint8Array, aesKey: Uint8Array): boolean {
  if (!hasPrefix(sampleDat, V2_MAGIC) || sampleDat.byteLength < V2_HEADER_SIZE + AES_BLOCK_SIZE) {
    return false;
  }
  if (aesKey.byteLength !== AES_BLOCK_SIZE) return false;

  const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, null);
  decipher.setAutoPadding(false);
  const firstBlock = sampleDat.subarray(V2_HEADER_SIZE, V2_HEADER_SIZE + AES_BLOCK_SIZE);
  //M 仅解密首个 16 字节块用于检查明文图片魔数头。
  const plainBlock = Buffer.concat([decipher.update(firstBlock), decipher.final()]);
  //M 检查首块明文前几个字节是否命中常见图片头。
  return isSupportedImageBytes(plainBlock);
}


/**
 * 若 V2 文件尾部为 XOR 掩码后的 JPEG 结束标记（FF D9），从末尾两字节快速反推候选 XOR 字节。
 * @param sampleDat V2 .dat 样本字节。
 */
function guessXorFromJpegTail(sampleDat: Uint8Array): number | undefined {
  if (!hasPrefix(sampleDat, V2_MAGIC) || sampleDat.byteLength < V2_HEADER_SIZE + 2) {
    return undefined;
  }
  const secondLast = sampleDat[sampleDat.byteLength - 2]!;
  const last = sampleDat[sampleDat.byteLength - 1]!;
  const candidate = secondLast ^ 0xff;
  if ((last ^ candidate) === 0xd9) return candidate;

  return undefined;
}


/**
 * 在给定的微信目录内仅凭文件名枚举候选 UIN（跳过海量 msg/attach 目录，绝不读取文件内容）。
 * @param rootDir 微信账号目录或统计目录。
 * @param maxFiles 最多检查的目录项上限。
 */
export function collectUinCandidates(rootDir: string, maxFiles = DEFAULT_MAX_UIN_SCAN_FILES): number[] {
  if (rootDir === '' || !fs.existsSync(rootDir)) return [];

  const found: number[] = [];
  const seen = new Set<number>();
  const stack: string[] = [rootDir];
  let visited = 0;

  while (stack.length > 0 && visited < maxFiles) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      visited += 1;
      const name = entry.name;
      const keyMatch = UIN_IN_FILENAME_RE.exec(name);
      if (keyMatch !== null && keyMatch[1] !== undefined) {
        const uin = Number.parseInt(keyMatch[1], 10);
        if (Number.isSafeInteger(uin) && uin > 0 && !seen.has(uin)) {
          seen.add(uin);
          //M 收入从 key_<uin> 文件名提取出的候选 UIN。
          found.push(uin);
        }
      }

      const parsedPath = path.parse(name);
      const extLower = parsedPath.ext.toLowerCase();
      const isStatExt = extLower === '.statistic' || extLower === '.stat' || extLower === '.ini';
      if (isStatExt && BARE_UIN_STEM_RE.test(parsedPath.name)) {
        const uin = Number.parseInt(parsedPath.name, 10);
        if (Number.isSafeInteger(uin) && uin > 0 && !seen.has(uin)) {
          seen.add(uin);
          //M 收入纯数字统计/配置文件名对应的候选 UIN。
          found.push(uin);
        }
      }

      if (entry.isDirectory() && visited < maxFiles) {
        const lowerName = name.toLowerCase();
        if (!SKIP_UIN_DIRS.has(lowerName)) {
          //M 非附件与缓存目录继续入栈遍历。
          stack.push(path.join(current, name));
        }
      }
    }
  }
  return found;
}


/**
 * 为一份 V2 样本匹配可用图片解密密钥：先核验已存密钥，再枚举目录 UIN 候选派生并验首块。
 * @param sampleDat V2 .dat 样本字节。
 * @param accountName 账号 wxid（自动兼容剥除尾部随机十六进制后缀）。
 * @param searchRoots 枚举 UIN 文件名的根目录列表。
 * @param stored 可选的已缓存密钥。
 */
export function discoverV2ImageKeys(
  sampleDat: Uint8Array,
  accountName: string,
  searchRoots: readonly string[],
  stored?: ImageCipherKey,
): ImageCipherKey | undefined {
  if (!hasPrefix(sampleDat, V2_MAGIC)) return undefined;

  if (stored !== undefined) {
    //M 已有缓存密钥通过首块签名校验时直接复用。
    if (verifyV2AesKeyHead(sampleDat, stored.aesKey)) return stored;
  }

  //M 收集去重后的候选 UIN 清单。
  const uins: number[] = [];
  const seenUin = new Set<number>();
  for (const root of searchRoots) {
    for (const uin of collectUinCandidates(root)) {
      if (!seenUin.has(uin)) {
        seenUin.add(uin);
        uins.push(uin);
      }
    }
  }

  const nameVariants = [accountName];
  const suffixMatch = /^(.+)_([0-9a-fA-F]{4,})$/u.exec(accountName);
  if (suffixMatch !== null && suffixMatch[1] !== undefined && !nameVariants.includes(suffixMatch[1])) {
    //M 追加剥除尾部十六进制随机后缀的纯 wxid 变体。
    nameVariants.push(suffixMatch[1]);
  }

  //M 先用 JPEG 尾巴猜测的 XOR 加速筛选，未命中时再全量尝试派生值（兼容 PNG/GIF 样本）。
  const xorGuess = guessXorFromJpegTail(sampleDat);
  for (const uin of uins) {
    for (const name of nameVariants) {
      //M 派生候选密钥并在内存核验首块图片签名。
      const derived = deriveV2ImageKeys(uin, name);
      if (xorGuess !== undefined && derived.xorKey !== xorGuess) {
        continue;
      }
      if (verifyV2AesKeyHead(sampleDat, derived.aesKey)) {
        return derived;
      }
    }
  }

  if (xorGuess !== undefined) {
    for (const uin of uins) {
      for (const name of nameVariants) {
        //M 尾部并非 JPEG 时回退试完整派生密钥。
        const derived = deriveV2ImageKeys(uin, name);
        if (verifyV2AesKeyHead(sampleDat, derived.aesKey)) {
          return derived;
        }
      }
    }
  }
  return undefined;
}


/**
 * 从本地 image_key.json 读取已验证的账号图片密钥；不存在或损坏时返回 undefined。
 * @param filePath 密钥缓存文件路径。
 */
export function loadStoredImageKey(filePath: string | undefined): ImageCipherKey | undefined {
  if (filePath === undefined || filePath === '' || !fs.existsSync(filePath)) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;

  const record = raw as Record<string, unknown>;
  const aesHex = record['aes'];
  const xorVal = record['xor'];
  const uinVal = record['uin'];
  if (typeof aesHex !== 'string' || !/^[0-9a-fA-F]{32}$/u.test(aesHex)) return undefined;
  if (typeof xorVal !== 'number' || !Number.isInteger(xorVal)) return undefined;

  let uin = 0;
  if (typeof uinVal === 'number' && Number.isInteger(uinVal) && uinVal >= 0) {
    uin = uinVal;
  }
  return {
    aesKey: Buffer.from(aesHex, 'hex'),
    xorKey: xorVal & 0xff,
    uin,
  };
}


/**
 * 将验证通过的账号图片密钥原子写入本地 image_key.json（权限 0600）。
 * @param filePath 目标保存路径。
 * @param key 已验证的图片密钥。
 */
export function saveStoredImageKey(filePath: string, key: ImageCipherKey): void {
  if (key.aesKey.byteLength !== AES_BLOCK_SIZE) {
    throw new Error('图片 AES 密钥长度不合法');
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify({
    aes: key.aesKey.toString('hex'),
    xor: key.xorKey & 0xff,
    uin: key.uin,
  });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}


/**
 * 解密磁盘上的一份 .dat 图片文件，区分缺少 V2 账号密钥与数据损坏两种失败码。
 * @param datPath 已定位的 .dat 文件路径。
 * @param options 密钥缓存路径、账号 wxid 与 UIN 搜索目录。
 */
export function decryptImageDatFile(
  datPath: string,
  options: DecryptImageOptions = {},
): DecryptImageOutcome {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(datPath);
  } catch {
    return { ok: false, code: 'not_found' };
  }
  if (raw.byteLength === 0) return { ok: false, code: 'decrypt_failed' };

  //M 先试无需账号密钥的老版单字节 XOR。
  const xorDecoded = decryptXorDat(raw);
  if (xorDecoded !== undefined) {
    return {
      ok: true,
      image: { data: xorDecoded, mime: sniffImageMime(xorDecoded) },
    };
  }

  //M 读取本地已存的账号图片密钥。
  const stored = loadStoredImageKey(options.keyFilePath);

  if (hasPrefix(raw, V2_MAGIC)) {
    //M V2 格式：先校验或发现 UIN 派生密钥，首次发现后持久化留存。
    const accountName = options.accountName ?? '';
    const roots = options.searchRoots ?? [];
    const matchedKey = discoverV2ImageKeys(raw, accountName, roots, stored);
    if (matchedKey === undefined) {
      return { ok: false, code: 'need_image_key' };
    }
    if (
      options.keyFilePath !== undefined
      && options.keyFilePath !== ''
      && (stored === undefined || !stored.aesKey.equals(matchedKey.aesKey) || stored.xorKey !== matchedKey.xorKey)
    ) {
      try {
        //M 将新验证通过的 V2 图片密钥写入账号媒体目录。
        saveStoredImageKey(options.keyFilePath, matchedKey);
      } catch {
        // 缓存写入失败不阻断当次已解出的图片返回。
      }
    }

    //M 用已核实的密钥完整解密 V2 文件。
    const plain = decryptV2Dat(raw, matchedKey.aesKey, matchedKey.xorKey, V2_MAGIC);
    if (plain === undefined) return { ok: false, code: 'decrypt_failed' };

    return { ok: true, image: { data: plain, mime: sniffImageMime(plain) } };
  }

  if (hasPrefix(raw, V1_MAGIC)) {
    if (stored === undefined) return { ok: false, code: 'need_image_key' };
    //M 用已缓存密钥尝试解密 V1 文件。
    const plain = decryptV2Dat(raw, stored.aesKey, stored.xorKey, V1_MAGIC);
    if (plain === undefined) return { ok: false, code: 'decrypt_failed' };

    return { ok: true, image: { data: plain, mime: sniffImageMime(plain) } };
  }

  if (isSupportedImageBytes(raw)) {
    return { ok: true, image: { data: raw, mime: sniffImageMime(raw) } };
  }
  return { ok: false, code: 'decrypt_failed' };
}


/**
 * 在微信 `msg/attach/<md5(chat)>/<YYYY-MM>/Img` 目录中按候选 MD5 定位图片的 `.dat` 文件路径。
 * 只在目标会话自己的哈希目录内查找，绝不全盘扫描其余聊天的附件。
 * @param dbDir 微信账号的 db_storage 目录。
 * @param chat 会话原始 username。
 * @param createTime 消息 Unix 秒级时间戳。
 * @param md5s 由 MsgView.extractImageMd5s 提取的候选 32 位小写 MD5 列表。
 * @param preferThumb 是否优先返回缩略图（`*_t.dat` / `*_th.dat`），默认 true。
 */
export function findImageDatPath(
  dbDir: string,
  chat: string,
  createTime: number,
  md5s: readonly string[],
  preferThumb = true,
): string | undefined {
  if (dbDir === '' || chat === '' || md5s.length === 0 || !fs.existsSync(dbDir)) return undefined;

  let wechatBase = dbDir;
  if (path.basename(dbDir) === 'db_storage') {
    wechatBase = path.dirname(dbDir);
  }
  const attachRoot = path.join(wechatBase, 'msg', 'attach');
  if (!fs.existsSync(attachRoot)) return undefined;

  let monthFolder = '';
  if (createTime > 0) {
    const dt = new Date(createTime * 1000);
    const yyyy = String(dt.getFullYear());
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    monthFolder = `${yyyy}-${mm}`;
  }

  const chatHash = crypto.createHash('md5').update(chat, 'utf8').digest('hex');
  const chatAttachDir = path.join(attachRoot, chatHash);
  if (!fs.existsSync(chatAttachDir)) return undefined;

  const wantedNames: string[] = [];
  for (const rawMd5 of md5s) {
    const md5 = rawMd5.toLowerCase();
    if (!/^[0-9a-f]{32}$/u.test(md5)) {
      continue;
    }
    if (preferThumb) {
      //M 优先排缩略图后缀，缺失时再回退原图。
      wantedNames.push(`${md5}_t.dat`, `${md5}_th.dat`, `${md5}.dat`);
    }
    if (!preferThumb) {
      //M 优先排高清原图，缺失时再回退缩略图。
      wantedNames.push(`${md5}.dat`, `${md5}_t.dat`);
    }
  }
  if (wantedNames.length === 0) return undefined;

  //M 先精确检查当月 Img 目录与会话根，命中率最高且零目录遍历。
  const directFolders: string[] = [];
  if (monthFolder !== '') {
    directFolders.push(path.join(chatAttachDir, monthFolder, 'Img'));
  }
  //M 同时把会话哈希根目录纳入直查候选。
  directFolders.push(chatAttachDir);

  for (const folder of directFolders) {
    if (!fs.existsSync(folder)) {
      continue;
    }
    for (const fileName of wantedNames) {
      const candidate = path.join(folder, fileName);
      const stat = fs.statSync(candidate, { throwIfNoEntry: false });
      if (stat?.isFile()) return candidate;
    }
  }

  //M 跨月归档偏移时（例如午夜前后收图），仅在本会话哈希目录的月份/Img 子目录内按文件名查找。
  const wantedLower = new Set(wantedNames.map((n) => n.toLowerCase()));
  const stack: string[] = [chatAttachDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile()) {
        if (wantedLower.has(entry.name.toLowerCase())) return fullPath;
        continue;
      }
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (lower === 'img' || /^\d{4}-\d{2}$/u.test(lower)) {
          stack.push(fullPath);
        }
      }
    }
  }
  return undefined;
}
