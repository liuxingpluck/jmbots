/**
 * 飞书开放接口的统一调用：本插件所有开放接口（发消息、下载、云文档……）都过 call。
 * 它管三件事：HTTP 429 限流（和复用的连接刚被断掉）时退让重试；飞书交回的错误码换成看得懂的中文；权限不够时补一句该开什么权限。
 * 遇到 429 按 500·2ⁿ 毫秒等待，最多 5 次。错误消息包括错误码和说明。
 *
 * SDK 出错有两种样子（node_modules/@larksuiteoapi/node-sdk/lib/index.js）：
 *   HTTP 不是 2xx（429、400……）：SDK 原样抛 axios 的错，e.response.status 是 HTTP 状态，e.response.data 里有飞书的 code、msg。
 *   HTTP 200 但业务失败：SDK 交回 body，里面 code 不是 0。上传类接口（image.create、file.create、uploadAll）成功时不带 code。
 */
import * as textModule from '../../utils/Text.ts';


/** 429 最多再试几次。 */
export const RETRY_TIMES = 5;

/** 第一次重试前等多久，毫秒；以后每次翻倍（0.5、1、2、4、8 秒）。 */
const RETRY_WAIT_MS = 500;

/** 飞书“请求太频繁”的业务错误码：HTTP 200 也可能带它，和 429 一样退让。 */
const RATE_LIMIT_CODES = new Set([99991400, 1770019]);

/** 连接被对面断掉的几种：一般是复用的空闲连接刚被服务器关掉，请求没到对面，可以再试。 */
const NETWORK_RESET = /socket hang up|ECONNRESET|EPIPE/u;

/** 权限类错误码：应用没开权限、没发布版本、不在可用范围。 */
const PERMISSION_CODES = new Set([99991672, 99991679, 99991668, 230027, 234009, 1770032, 1063002, 91204]);


/**
 * 确定没发出去的错：飞书回了错误码或 4xx（请求到了、被拒了），或者地址不对根本没发。
 * 别的错（断网、超时、5xx）不知道飞书收没收，照旧是普通 Error。
 * 发消息回退（Media.message）和发送回执（Feishu.send）靠它分“确定没发”和“不知道”。
 */
export class NotSent extends Error {}


/** 飞书接口交回的业务结果里我们看的两项。 */
interface Coded {
  code?: unknown;
  msg?: unknown;
}


/**
 * 把飞书的错误码换成一句中文；权限类的补上该开的权限。
 * @param action 在做什么，比如“发消息”“云文档建文档”。
 * @param code 飞书的错误码。
 * @param msg 飞书的说明。
 * @returns 一句话。
 */
export function getExplain(action: string, code: number, msg: unknown): string {
  let said = '没有说明';
  if (typeof msg === 'string' && msg !== '') {
    said = msg;
  }
  let text = `飞书${action}失败：错误码 ${String(code)}，${said}`;

  //M 权限类：云文档的动作要 docx、drive 权限，别的（收发消息、下载资源）要 im 权限。开完权限要发布一次版本才生效。
  if (PERMISSION_CODES.has(code) || /permission|scope|access denied|forbidden|权限/iu.test(said)) {
    let need = 'im:message、im:message:send_as_bot、im:resource';
    if (action.startsWith('云文档')) {
      need = 'docx:document、drive:drive';
    }
    //M 云文档给权限：把人、群加成协作者要 docs:permission.member:create（分享云文档），再加 drive:drive。
    if (action.startsWith('云文档给')) {
      need = 'docs:permission.member:create（分享云文档）、docx:document、drive:drive';
    }
    //M 撤回消息：im:message、im:message:recall、im:message:send_as_bot 三个开一个就行；撤自己发的不用别的。
    if (action.startsWith('撤回')) {
      need = 'im:message:recall（撤回消息；开 im:message 或 im:message:send_as_bot 也行）';
    }
    //M 拉群历史要读群里所有消息：im:message.group_msg 是“获取群组中所有消息”，im:message:readonly 是读消息；机器人还得在群里。
    if (action.startsWith('拉群历史')) {
      need = 'im:message.group_msg（获取群组中所有消息）、im:message:readonly（获取单聊、群组消息）';
    }
    text += `。请在飞书开放平台给应用开权限 ${need}，再发布一次版本`;
  }
  return text;
}


/**
 * 跑一次 SDK 调用：429 和限流错误码退让重试，失败抛中文的错。
 * @param action 在做什么，写进错误里，比如“发消息”。云文档的动作以“云文档”开头，权限提示按它挑。
 * @param run 真正的调用，比如 () => client.im.v1.message.create(…)。重试时会再调一次。
 * @param waitMs 第一次重试前等多久，毫秒；测试可以调小。
 * @returns SDK 交回的东西，原样。
 * @throws 重试完还是限流、HTTP 出错、业务码不是 0 时抛错；错误里不带令牌和密钥（只取飞书的 code、msg 和 HTTP 状态）。
 */
export async function call<T>(action: string, run: () => Promise<T>, waitMs = RETRY_WAIT_MS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let result: T;
    try {
      result = await run();
    } catch (error) {
      const response = (error as { response?: { status?: number; data?: unknown } } | null)?.response;
      const body = (response?.data ?? undefined) as Coded | undefined;
      const limited = response?.status === 429 || (typeof body?.code === 'number' && RATE_LIMIT_CODES.has(body.code));
      //M 无 HTTP 响应时提取错误文本判定是否为对端提前断连（可安全退让重试）。
      const reset = response === undefined && NETWORK_RESET.test(textModule.getErrorMessage(error));

      //G 限流、连接刚被断掉，还能再试 → 等 0.5、1、2、4、8 秒再来。
      if ((limited || reset) && attempt < RETRY_TIMES) {
        await Bun.sleep(waitMs * 2 ** attempt);
        continue;
      }
      //G 飞书回了错误码：请求到了、被拒了 → 确定没发。
      if (typeof body?.code === 'number') {
        //M 飞书返回明确错误码时换成中文报错说明，按确定未发出抛出。
        const reason = getExplain(action, body.code, body.msg);
        throw new NotSent(reason);
      }
      let status = '';
      if (response?.status !== undefined) {
        status = `HTTP ${String(response.status)} `;
      }
      const said = `飞书${action}失败：${status}${textModule.getErrorMessage(error)}`;

      //G 4xx：请求到了、被拒了 → 确定没发。断网、超时、5xx 不知道收没收，照旧是普通 Error。
      const code = response?.status ?? 0;
      if (code >= 400 && code < 500) {
        throw new NotSent(said);
      }
      //G 保留传输原异常，供排查发送结果不确定的原因。
      const options = { cause: error };
      throw new Error(said, options);
    }

    //M HTTP 200：带 code 的看 code；上传类不带 code，直接算成功。
    const coded = result as Coded | null;
    if (coded !== null && typeof coded === 'object' && typeof coded.code === 'number' && coded.code !== 0) {
      if (RATE_LIMIT_CODES.has(coded.code) && attempt < RETRY_TIMES) {
        await Bun.sleep(waitMs * 2 ** attempt);
        continue;
      }
      //M 飞书返回明确业务错误码且非可重试限流，翻译为中文权限/错误说明并抛出 NotSent。
      const reason = getExplain(action, coded.code, coded.msg);
      throw new NotSent(reason);
    }
    return result;
  }
}
