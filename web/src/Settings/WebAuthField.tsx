/**
 * 外网反向代理登录鉴权（`server.web_auth`）配置表单：
 * 对接 `src7/plugins/http/WebAuth.ts` 与 `src7/plugins/settings/ConfigFile.ts`。
 * 始终使用密码遮罩输入，绝不回显明文密码或哈希摘要原文；修改新密码时在前端计算 SHA-256 摘要写入。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as i18n from '../I18n.ts';
import * as editsModule from './Edits.ts';
import * as fields from './Fields.tsx';


/** 当前启用的密码校验方式。 */
type VerifierMode = 'scrypt' | 'sha256' | 'password' | 'none';

/** 挂载时捕获的原始密码校验字段快照，用于在清空新密码输入时恢复原配置。 */
interface VerifierSnapshot {
  /** 原 `password_scrypt` 字段值。 */
  passwordScrypt: unknown;
  /** 原 `password_sha256` 字段值。 */
  passwordSha256: unknown;
  /** 原 `password` 字段值（后端可能已脱敏为代号）。 */
  password: unknown;
}


/** 判定值是否为非空普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}


/**
 * 计算整数的 32 位无符号右旋。
 * @param value 32 位数值。
 * @param bits 右旋位数。
 */
function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}


/**
 * 按素数列表生成 SHA-256 所需的初始状态向量与轮常量，避免硬编码大数组。
 * @returns 长度为 8 的初值数组与长度为 64 的轮常量数组。
 */
function buildSha256Tables(): { initHash: number[]; roundK: number[] } {
  const primes: number[] = [];
  let candidate = 2;
  while (primes.length < 64) {
    let prime = true;
    for (let div = 2; div * div <= candidate; div += 1) {
      if (candidate % div === 0) {
        prime = false;
        break;
      }
    }
    if (prime) {
      primes.push(candidate);
    }
    candidate += 1;
  }
  const scale = 2 ** 32;
  const initHash = primes.slice(0, 8).map((num) => Math.floor((Math.sqrt(num) % 1) * scale) >>> 0);
  const roundK = primes.map((num) => Math.floor((Math.cbrt(num) % 1) * scale) >>> 0);
  return { initHash, roundK };
}


/** 模块级缓存一次 SHA-256 常量表。 */
const SHA256_TABLES = buildSha256Tables();


/**
 * 计算 UTF-8 字符串的 64 位小写十六进制 SHA-256 摘要。
 * 说明：内网 HTTP 地址无 `crypto.subtle` 上下文，因此采用纯 JS 同步实现。
 * @param text 明文输入。
 * @returns 64 位小写十六进制摘要。
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLength / 0x1_0000_0000);
  const lowBits = bitLength >>> 0;
  view.setUint32(paddedLength - 8, highBits, false);
  view.setUint32(paddedLength - 4, lowBits, false);

  const hash = [...SHA256_TABLES.initHash];
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let idx = 0; idx < 16; idx += 1) {
      schedule[idx] = view.getUint32(offset + idx * 4, false);
    }
    for (let idx = 16; idx < 64; idx += 1) {
      const w15 = schedule[idx - 15]!;
      const w2 = schedule[idx - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      schedule[idx] = (schedule[idx - 16]! + s0 + schedule[idx - 7]! + s1) >>> 0;
    }

    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;

    for (let idx = 0; idx < 64; idx += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ ((~e) & g);
      const temp1 = (h + s1 + ch + SHA256_TABLES.roundK[idx]! + schedule[idx]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }

  return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
}


/** 识别当前 `server.web_auth` 正在使用的密码校验方式。 */
function getVerifierMode(webAuth: Record<string, unknown>): VerifierMode {
  if (typeof webAuth['password_scrypt'] === 'string' && webAuth['password_scrypt'].trim() !== '') {
    return 'scrypt';
  }
  if (typeof webAuth['password_sha256'] === 'string' && webAuth['password_sha256'].trim() !== '') {
    return 'sha256';
  }
  if (typeof webAuth['password'] === 'string' && webAuth['password'] !== '') {
    return 'password';
  }
  return 'none';
}


/**
 * 保存前校验 `server.web_auth` 完整性，避免写出缺账号或缺密码的配置导致重启失败。
 * @param draft 当前设置草稿。
 * @param t 翻译函数。
 * @returns 通过返回空串，不通过返回中文报错提示。
 */
export function validateWebAuthDraft(draft: unknown, t: i18n.Translate): string {
  const raw = editsModule.getAt(draft, ['server', 'web_auth']);
  if (!isRecord(raw)) return '';

  const username = raw['username'];
  if (typeof username !== 'string' || username.trim() === '') {
    return t('外网登录鉴权已开启：请填写 server.web_auth.username');
  }
  if (getVerifierMode(raw) === 'none') {
    return t('外网登录鉴权已开启：请设置登录密码后再保存');
  }
  return '';
}


/** 读出校验快照，供回退清零时使用。 */
function readVerifierSnapshot(draft: unknown): VerifierSnapshot {
  return {
    passwordScrypt: editsModule.getAt(draft, ['server', 'web_auth', 'password_scrypt']),
    passwordSha256: editsModule.getAt(draft, ['server', 'web_auth', 'password_sha256']),
    password: editsModule.getAt(draft, ['server', 'web_auth', 'password']),
  };
}


/** 根据校验方式返回状态标签配色与文案。 */
function getVerifierBadge(mode: VerifierMode, t: i18n.Translate): { color: string; text: string } {
  if (mode === 'scrypt') {
    return { color: 'success', text: t('已启用 · scrypt 盐值哈希') };
  }
  if (mode === 'sha256') {
    return { color: 'success', text: t('已启用 · SHA-256 摘要') };
  }
  if (mode === 'password') {
    return { color: 'processing', text: t('已启用 · 已设置密码') };
  }
  return { color: 'warning', text: t('待设置密码（保存前请填写新密码）') };
}


/**
 * 渲染 `server.web_auth` 外网反代登录鉴权设置块。
 * @param props 当前设置草稿与增量编辑回调。
 */
export function WebAuthField(props: {
  draft: unknown;
  onEdit: (edit: editsModule.Edit) => void;
}): react.JSX.Element {
  //M 读取当前语言翻译函数及草稿内的 server.web_auth 配置状态。
  const t = i18n.useT();
  const initialRef = react.useRef<VerifierSnapshot | null>(null);
  if (initialRef.current === null) {
    initialRef.current = readVerifierSnapshot(props.draft);
  }
  /** 仅保存用户本次新输入的密码草稿，绝不回显已有密码或哈希。 */
  const [newPassword, setNewPassword] = react.useState('');

  const rawWebAuth = editsModule.getAt(props.draft, ['server', 'web_auth']);
  const enabled = isRecord(rawWebAuth);

  /** 切换外网登录鉴权总开关。 */
  const toggleEnabled = (next: boolean): void => {
    setNewPassword('');
    if (!next) {
      //M 关闭外网登录门禁时删除 server.web_auth 整段配置。
      props.onEdit({ path: ['server', 'web_auth'], delete: true });
      return;
    }

    //M 初次开启时默认填入 admin 账号并等待用户设置登录密码。
    props.onEdit({ path: ['server', 'web_auth'], value: { username: 'admin' } });
  };

  /** 密码输入变化：写入 SHA-256 摘要并清理旧校验字段；清空输入时还原初始校验配置。 */
  const handlePasswordChange = (next: string): void => {
    setNewPassword(next);
    if (next === '') {
      const initial = initialRef.current!;
      //M 用户清空本次输入的新密码时，按初始快照恢复或清理各校验字段。
      if (initial.passwordScrypt !== undefined) {
        props.onEdit({ path: ['server', 'web_auth', 'password_scrypt'], value: initial.passwordScrypt });
      }
      if (initial.passwordSha256 !== undefined) {
        props.onEdit({ path: ['server', 'web_auth', 'password_sha256'], value: initial.passwordSha256 });
      }
      if (initial.passwordSha256 === undefined) {
        props.onEdit({ path: ['server', 'web_auth', 'password_sha256'], delete: true });
      }
      if (initial.password !== undefined) {
        props.onEdit({ path: ['server', 'web_auth', 'password'], value: initial.password });
      }
      return;
    }

    //G 若原本存有优先级的 password_scrypt 或明文 password，需同步删除以免覆盖新设摘要。
    if (editsModule.getAt(props.draft, ['server', 'web_auth', 'password_scrypt']) !== undefined) {
      props.onEdit({ path: ['server', 'web_auth', 'password_scrypt'], delete: true });
    }
    if (editsModule.getAt(props.draft, ['server', 'web_auth', 'password']) !== undefined) {
      props.onEdit({ path: ['server', 'web_auth', 'password'], delete: true });
    }
    //M 将明文密码单向转为 64 位 SHA-256 摘要写回草稿，不在配置或日志中保留明文。
    props.onEdit({ path: ['server', 'web_auth', 'password_sha256'], value: sha256Hex(next) });
  };

  let statusNode: react.ReactNode = <antd.Tag>{t('未启用（外网反代不弹登录页）')}</antd.Tag>;
  let mode: VerifierMode = 'none';
  if (enabled) {
    mode = getVerifierMode(rawWebAuth);
    const badge = getVerifierBadge(mode, t);
    statusNode = <antd.Tag color={badge.color}>{badge.text}</antd.Tag>;
  }

  let passwordPlaceholder = t('输入外网登录密码（保存时自动转为 SHA-256 摘要，不存明文）');
  if (mode !== 'none') {
    passwordPlaceholder = t('已设置密码（留空保持原密码；输入新密码可覆盖）');
  }
  const webAuthHint = t(
    '仅对经 Nginx 注入 X-External-Proxy: 1 的外网访问生效，'
    + '本机 127.0.0.1 与内网直连零打扰。保存后需重启生效',
  );

  //M 渲染外网反代登录鉴权开关、状态徽章及启用后的账号与遮罩密码输入框。
  return (
    <div className="jm-sc-webauth-box">
      <fields.Row label={t('外网反代登录鉴权 server.web_auth')} hint={webAuthHint} path={['server', 'web_auth']}>
        <div className="jm-sc-inline-row">
          <antd.Switch checked={enabled} onChange={toggleEnabled} />
          {statusNode}
        </div>
      </fields.Row>
      {enabled && (
        <div className="jm-sc-webauth-fields">
          <fields.TextField
            label={t('外网登录账号 username')}
            hint={t('外网 AuthGate 登录页使用的用户名（不区分大小写）')}
            placeholder="admin"
            draft={props.draft}
            path={['server', 'web_auth', 'username']}
            onEdit={props.onEdit}
          />
          <fields.Row
            label={t('设置 / 修改密码')}
            hint={t('密码框永不回显已存密码或哈希摘要；修改账号或密码后旧的 30 天外网会话会自动失效')}
            path={['server', 'web_auth', 'password_sha256']}
          >
            <antd.Input.Password
              value={newPassword}
              autoComplete="new-password"
              placeholder={passwordPlaceholder}
              onChange={(event) => handlePasswordChange(event.target.value)}
            />
          </fields.Row>
        </div>
      )}
    </div>
  );
}
