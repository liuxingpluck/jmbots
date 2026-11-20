/**
 * 外置微信收费插件独立离线 Ed25519 授权校验与 HTTP 业务门禁（对齐 `/jmbots/v1/license` 协议契约）。
 * 全程在本地使用公钥验签、核对到期时间、机器指纹与必选功能位，零外联请求，仓库不保存任何私钥。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as fastify from 'fastify';
import * as protocol from './Protocol.ts';


/** 本收费插件的固定产品标识。 */
export const LICENSE_PRODUCT_ID = 'jmbots-wechat';

/** 运行本插件必须具备的基础功能位标识。 */
export const REQUIRED_FEATURE = 'wechat-read';

/** 紧凑激活码字符串的标准前缀。 */
export const LICENSE_TOKEN_PREFIX = 'jmbots-lic-v1';

/** 标准 Ed25519 SPKI DER 编码的固定 12 字节 ASN.1 前缀（后跟 32 字节原始公钥）。 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** 内置默认发行版 Ed25519 32 字节公钥（十六进制）；测试可通过 `--license-pubkey` 注入临时公钥。 */
export const DEFAULT_OFFICIAL_PUBKEY_HEX = '3d3bb994ff95cfcfad8343bd21265894b005511161a49ca1911bea50ceacd7a1';

/** 允许在未授权或过期状态下正常访问的生命周期与授权管理路由集合。 */
const PUBLIC_LIFECYCLE_PATHS = new Set([
  '/',
  '/jmbots/v1/info',
  '/jmbots/v1/health',
  '/jmbots/v1/license',
  '/jmbots/v1/exit',
]);


/** 与 `programs` v1 协议严格一致的授权状态枚举。 */
export type LicenseState = 'licensed' | 'expired' | 'none' | 'free';

/** 许可证载荷结构（签名覆盖的明文 JSON 字段）。 */
export interface LicensePayload {
  /** 产品标识，必须为 `'jmbots-wechat'`。 */
  product: string;
  /** 唯一许可证编号。 */
  licenseId: string;
  /** 可选客户或席位显示名称。 */
  customer?: string;
  /** 签发时刻（Unix 毫秒）。 */
  issuedAt: number;
  /** 到期时刻（Unix 毫秒）。 */
  expiresAt: number;
  /** 绑定的本机机器指纹；省略或为 `'*'` 时表示不限单机指纹。 */
  machineFingerprint?: string;
  /** 已开通的功能位列表（须含 `'wechat-read'`）。 */
  features: string[];
}

/** `/jmbots/v1/license` 返回及内部门禁读取的授权核验状态。 */
export interface LicenseStatus {
  /** 协议固定成功标记，供宿主 `readLicense` 识别。 */
  ok: true;
  /** 当前授权状态。 */
  state: LicenseState;
  /** 本机机器指纹（便于用户复制申请离线激活码）。 */
  machineFingerprint: string;
  /** 未授权或过期时的细分错误码。 */
  code?: string;
  /** 未授权或过期时的中文说明。 */
  reason?: string;
  /** 已验真许可证编号。 */
  licenseId?: string;
  /** 已验真客户标识。 */
  customer?: string;
  /** 已验真许可证到期时间（Unix 毫秒）。 */
  expiresAt?: number;
  /** 已验真许可证功能位列表。 */
  features?: string[];
}

/** 构造授权门禁时的配置选项。 */
export interface LicenseGuardOptions {
  /** 许可证持久化文件路径（默认 `<data>/license.json`）。 */
  licenseFile: string;
  /** 可选覆盖的 Ed25519 公钥（支持 64 位原始公钥 hex、88 位 SPKI DER hex 或 PEM）。 */
  publicKey?: string;
  /** 可选注入的机器指纹（默认取本机离线指纹）。 */
  machineFingerprint?: string;
  /** 可选注入的时钟函数（供单测模拟到期时间演进）。 */
  now?: () => number;
  /** 可选的必备功能位列表（默认 `['wechat-read']`）。 */
  requiredFeatures?: readonly string[];
}


/**
 * 计算本机稳定、无外联、脱敏的 32 位十六进制机器指纹。
 */
export function computeMachineFingerprint(): string {
  const raw = [
    'jmbots-wechat-fp-v1',
    os.platform(),
    os.arch(),
    os.hostname().trim().toLowerCase(),
  ].join(':');
  //M 对平台、架构与主机名做单向 SHA-256 截断，不读取网卡或隐私序列号。
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
}


/**
 * 将 64 位原始公钥 hex、88 位 SPKI DER hex 或 PEM 文本解析为 Node `KeyObject` 公钥。
 * @param rawKey 公钥字符串（省略时使用内置发行版公钥）。
 */
export function parseEd25519PublicKey(rawKey?: string): crypto.KeyObject {
  let text = DEFAULT_OFFICIAL_PUBKEY_HEX;
  if (rawKey !== undefined && rawKey.trim() !== '') {
    text = rawKey.trim();
  }

  if (text.includes('BEGIN PUBLIC KEY')) {
    return crypto.createPublicKey(text);
  }
  if (/^[0-9a-fA-F]{64}$/u.test(text)) {
    //M 32 字节原始 Ed25519 公钥拼上固定 12 字节 ASN.1 SPKI 前缀后导入。
    const rawBytes = Buffer.from(text, 'hex');
    const der = Buffer.concat([ED25519_SPKI_PREFIX, rawBytes]);
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  }
  if (/^[0-9a-fA-F]{88}$/u.test(text)) {
    const der = Buffer.from(text, 'hex');
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  }

  throw new Error('无效的 Ed25519 授权公钥格式（须为 64 位十六进制或 PEM）');
}


/**
 * 将 `KeyObject` 公钥导出为 64 位小写十六进制原始 32 字节公钥（便于测试或命令行传参）。
 * @param publicKey Ed25519 公钥对象。
 */
export function exportPublicKeyHex(publicKey: crypto.KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(der).subarray(der.byteLength - 32).toString('hex');
}


/**
 * 使用调用方持有的 Ed25519 私钥离线签发紧凑许可证激活码（供单测现场生成临时密钥签发测试证）。
 * @param payload 待签发的许可证载荷。
 * @param privateKey 调用方持有的 Ed25519 私钥对象。
 */
export function signLicenseToken(payload: LicensePayload, privateKey: crypto.KeyObject): string {
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  //M Ed25519 纯模式签名（algorithm 传 null）。
  const sigBytes = crypto.sign(null, payloadBytes, privateKey);
  const encodedPayload = payloadBytes.toString('base64url');
  const encodedSig = sigBytes.toString('base64url');
  return `${LICENSE_TOKEN_PREFIX}.${encodedPayload}.${encodedSig}`;
}


/**
 * 从许可证文件内容或紧凑激活码字符串中拆出受签名保护的原始载荷字节与 64 字节签名。
 * @param rawInput 原始文件内容或激活码文本。
 */
function unpackSignedLicense(rawInput: string): { payloadBytes: Buffer; signatureBytes: Buffer } | undefined {
  const trimmed = rawInput.trim();
  if (trimmed === '') return undefined;

  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined;

    const rec = parsed as Record<string, unknown>;
    if (typeof rec['token'] === 'string') {
      //M JSON 外壳包装 `{"token":"..."}` 时递归按紧凑激活码拆包。
      return unpackSignedLicense(rec['token']);
    }
    const rawPayload = rec['payload'];
    const rawSig = rec['signature'];
    if (typeof rawPayload !== 'string' || typeof rawSig !== 'string') return undefined;

    let payloadBytes = Buffer.from(rawPayload, 'base64url');
    if (rawPayload.trim().startsWith('{')) {
      payloadBytes = Buffer.from(rawPayload, 'utf8');
    }
    let signatureBytes = Buffer.from(rawSig.trim(), 'base64url');
    if (/^[0-9a-fA-F]{128}$/u.test(rawSig.trim())) {
      signatureBytes = Buffer.from(rawSig.trim(), 'hex');
    }
    if (payloadBytes.byteLength === 0 || signatureBytes.byteLength !== 64) return undefined;

    return { payloadBytes, signatureBytes };
  }

  const parts = trimmed.split('.');
  let payloadPart = '';
  let sigPart = '';
  if (parts.length === 3 && parts[0] === LICENSE_TOKEN_PREFIX) {
    payloadPart = parts[1] ?? '';
    sigPart = parts[2] ?? '';
  }
  if (parts.length === 2) {
    payloadPart = parts[0] ?? '';
    sigPart = parts[1] ?? '';
  }
  if (payloadPart === '' || sigPart === '') return undefined;

  try {
    const payloadBytes = Buffer.from(payloadPart, 'base64url');
    const signatureBytes = Buffer.from(sigPart, 'base64url');
    if (payloadBytes.byteLength === 0 || signatureBytes.byteLength !== 64) return undefined;

    return { payloadBytes, signatureBytes };
  } catch {
    return undefined;
  }
}


/**
 * 纯离线校验一份许可证文本：依次验 Ed25519 签名、产品标识、机器指纹、必选功能位与到期时间。
 * @param rawInput 待校验的许可证文本（为空时判为缺失 `none`）。
 * @param verifyOptions 公钥、本机指纹、当前毫秒时间与必选功能位。
 */
export function verifyLicenseContent(
  rawInput: string | undefined,
  verifyOptions: {
    publicKey: crypto.KeyObject;
    machineFingerprint: string;
    nowMs: number;
    requiredFeatures: readonly string[];
  },
): LicenseStatus {
  const fp = verifyOptions.machineFingerprint;
  if (rawInput === undefined || rawInput.trim() === '') {
    return {
      ok: true,
      state: 'none',
      code: 'missing_license',
      reason: '未授权：尚未配置微信客服插件许可证',
      machineFingerprint: fp,
    };
  }

  //M 拆解载荷字节与 Ed25519 64 字节签名。
  const unpacked = unpackSignedLicense(rawInput);
  if (unpacked === undefined) {
    return {
      ok: true,
      state: 'none',
      code: 'malformed_license',
      reason: '未授权：许可证格式无法识别',
      machineFingerprint: fp,
    };
  }

  let signatureValid = false;
  try {
    //M 使用公钥对原始载荷字节做离线 Ed25519 签名验证。
    signatureValid = crypto.verify(
      null,
      unpacked.payloadBytes,
      verifyOptions.publicKey,
      unpacked.signatureBytes,
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return {
      ok: true,
      state: 'none',
      code: 'invalid_signature',
      reason: '未授权：许可证签名校验失败',
      machineFingerprint: fp,
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(unpacked.payloadBytes.toString('utf8'));
  } catch {
    return {
      ok: true,
      state: 'none',
      code: 'invalid_payload',
      reason: '未授权：许可证内容损坏',
      machineFingerprint: fp,
    };
  }
  if (typeof decoded !== 'object' || decoded === null) {
    return {
      ok: true,
      state: 'none',
      code: 'invalid_payload',
      reason: '未授权：许可证内容损坏',
      machineFingerprint: fp,
    };
  }

  const record = decoded as Record<string, unknown>;
  const product = record['product'];
  const licenseId = record['licenseId'];
  const customer = record['customer'];
  const issuedAt = record['issuedAt'];
  const expiresAt = record['expiresAt'];
  const boundMachine = record['machineFingerprint'];
  const featuresRaw = record['features'];

  if (product !== LICENSE_PRODUCT_ID) {
    return {
      ok: true,
      state: 'none',
      code: 'wrong_product',
      reason: '未授权：许可证产品标识不匹配',
      machineFingerprint: fp,
    };
  }
  if (typeof licenseId !== 'string' || licenseId.trim() === '') {
    return {
      ok: true,
      state: 'none',
      code: 'invalid_payload',
      reason: '未授权：许可证缺少编号',
      machineFingerprint: fp,
    };
  }
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    return {
      ok: true,
      state: 'none',
      code: 'invalid_payload',
      reason: '未授权：许可证签发时间无效',
      machineFingerprint: fp,
    };
  }
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    return {
      ok: true,
      state: 'none',
      code: 'invalid_payload',
      reason: '未授权：许可证到期时间无效',
      machineFingerprint: fp,
    };
  }

  if (typeof boundMachine === 'string' && boundMachine.trim() !== '' && boundMachine.trim() !== '*') {
    if (boundMachine.trim().toLowerCase() !== fp.toLowerCase()) {
      return {
        ok: true,
        state: 'none',
        code: 'machine_mismatch',
        reason: '未授权：许可证绑定的机器指纹与本机不符',
        machineFingerprint: fp,
      };
    }
  }

  const features: string[] = [];
  if (Array.isArray(featuresRaw)) {
    for (const item of featuresRaw) {
      if (typeof item === 'string' && item.trim() !== '') {
        //M 收集许可证内声明的有效功能位名称。
        features.push(item.trim());
      }
    }
  }
  for (const required of verifyOptions.requiredFeatures) {
    if (!features.includes(required)) {
      return {
        ok: true,
        state: 'none',
        code: 'missing_feature',
        reason: `未授权：许可证缺少必需功能位 ${required}`,
        machineFingerprint: fp,
      };
    }
  }

  if (verifyOptions.nowMs >= expiresAt) {
    return {
      ok: true,
      state: 'expired',
      code: 'license_expired',
      reason: '未授权：微信客服插件许可证已过期',
      licenseId,
      expiresAt,
      features,
      machineFingerprint: fp,
    };
  }

  const okStatus: LicenseStatus = {
    ok: true,
    state: 'licensed',
    licenseId,
    expiresAt,
    features,
    machineFingerprint: fp,
  };
  if (typeof customer === 'string' && customer.trim() !== '') {
    okStatus.customer = customer.trim();
  }
  return okStatus;
}


/**
 * 管理磁盘许可证加载、实时到期重算、在线写入激活与 Fastify 业务接口门禁。
 */
export class LicenseGuard {
  private readonly licenseFile: string;
  private readonly publicKey: crypto.KeyObject;
  private readonly machineFingerprint: string;
  private readonly now: () => number;
  private readonly requiredFeatures: readonly string[];
  private cachedRaw: string | undefined;
  private cachedMtimeMs = -1;

  constructor(options: LicenseGuardOptions) {
    this.licenseFile = path.resolve(options.licenseFile);
    //M 解析离线验签公钥并计算本机指纹。
    this.publicKey = parseEd25519PublicKey(options.publicKey);
    this.machineFingerprint = options.machineFingerprint ?? computeMachineFingerprint();
    this.now = options.now ?? (() => Date.now());
    this.requiredFeatures = options.requiredFeatures ?? [REQUIRED_FEATURE];
  }

  /**
   * 读取最新的许可证授权状态（文件变更自动重读，且每次按当前时间实时检查是否过期）。
   */
  getStatus(): LicenseStatus {
    const stat = fs.statSync(this.licenseFile, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      this.cachedRaw = undefined;
      this.cachedMtimeMs = -1;
    }
    if (stat?.isFile() && stat.mtimeMs !== this.cachedMtimeMs) {
      try {
        this.cachedRaw = fs.readFileSync(this.licenseFile, 'utf8');
        this.cachedMtimeMs = stat.mtimeMs;
      } catch {
        this.cachedRaw = undefined;
        this.cachedMtimeMs = -1;
      }
    }

    //M 按当前时钟核验已加载的许可证文本。
    return verifyLicenseContent(this.cachedRaw, {
      publicKey: this.publicKey,
      machineFingerprint: this.machineFingerprint,
      nowMs: this.now(),
      requiredFeatures: this.requiredFeatures,
    });
  }

  /**
   * 当前是否处于有效已授权状态（`state === 'licensed'`）。
   */
  isAuthorized(): boolean {
    //M 实时读取最新状态并判断是否为 licensed。
    return this.getStatus().state === 'licensed';
  }

  /**
   * 校验并原子保存新的激活码；仅当新许可证验签通过且未过期时才落盘覆盖。
   * @param tokenText 用户或宿主提交的激活码字符串。
   */
  activate(tokenText: string): { accepted: boolean; status: LicenseStatus } {
    //M 先在内存完整验签，拒绝损坏或过期的激活码覆盖现有文件。
    const checked = verifyLicenseContent(tokenText, {
      publicKey: this.publicKey,
      machineFingerprint: this.machineFingerprint,
      nowMs: this.now(),
      requiredFeatures: this.requiredFeatures,
    });
    if (checked.state !== 'licensed') {
      return { accepted: false, status: checked };
    }

    fs.mkdirSync(path.dirname(this.licenseFile), { recursive: true });
    const persisted = `${JSON.stringify({ token: tokenText.trim() }, null, 2)}\n`;
    const tempPath = `${this.licenseFile}.${String(process.pid)}.tmp`;
    fs.writeFileSync(tempPath, persisted, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.licenseFile);
    this.cachedRaw = persisted;
    this.cachedMtimeMs = fs.statSync(this.licenseFile).mtimeMs;
    return { accepted: true, status: checked };
  }

  /**
   * 在 Fastify 应用上挂载 `GET/PUT /jmbots/v1/license` 路由与全业务接口未授权拦截钩子。
   * @param app 外置微信 Fastify 实例。
   * @param hostKey 可选宿主密钥；登记了渠道时 `PUT /jmbots/v1/license` 要求核验宿主密钥。
   */
  mount(app: fastify.FastifyInstance, hostKey?: string): void {
    //M 挂载供宿主与客服页只读查询授权状态的 v1 契约入口。
    app.get('/jmbots/v1/license', (_request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      //M 实时计算并返回当前许可证状态。
      return this.getStatus();
    });

    //M 挂载在线提交激活码并原子落盘的更新入口。
    app.put('/jmbots/v1/license', { bodyLimit: 16_384 }, (request, reply) => {
      if (hostKey !== undefined) {
        const given = request.headers[protocol.KEY_HEADER];
        //G 登记了渠道密钥时必须通过宿主密钥校验。
        if (!protocol.isSameKey(hostKey, given)) {
          //G 拦截未携带正确宿主密钥的激活写请求。
          return reply.code(401).send({ ok: false, error: '更新许可证需要经过主站认证' });
        }
      }
      const body = request.body as { token?: unknown } | null | undefined;
      const token = body?.token;
      if (typeof token !== 'string' || token.trim() === '') {
        //G 缺少非空激活码字符串时直接返回 400。
        return reply.code(400).send({ ok: false, code: 'bad_request', error: '请提供有效的许可证激活码' });
      }

      //M 核验激活码并在有效时持久化写入本地 license.json。
      const outcome = this.activate(token);
      if (!outcome.accepted) {
        return reply.code(400).send({
          ok: false,
          state: outcome.status.state,
          code: outcome.status.code ?? 'unlicensed',
          error: outcome.status.reason ?? '未授权：许可证无效',
        });
      }
      return outcome.status;
    });

    app.addHook('onRequest', (request, reply, done) => {
      const rawUrl = request.url;
      const pathname = rawUrl.split('?')[0] ?? rawUrl;
      //G 放行健康检查、身份信息、优雅退出、客服页外壳与许可证查询/激活接口。
      if (PUBLIC_LIFECYCLE_PATHS.has(pathname)) {
        done();
        return;
      }

      //M 每次业务请求前核对最新授权状态。
      const current = this.getStatus();
      if (current.state === 'licensed') {
        done();
        return;
      }

      const reason = current.reason ?? '未授权：请先配置有效的微信客服插件许可证';
      const code = current.code ?? 'unlicensed';
      //G 未授权或已过期时统一返回 402 阻断业务调用（不调用 done 立即终止后续路由）。
      void reply.code(402).header('Cache-Control', 'private, no-store').send({
        ok: false,
        status: 'failed',
        state: current.state,
        code,
        error: reason,
        reason,
      });
    });
  }
}
