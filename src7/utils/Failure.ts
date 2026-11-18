/**
 * 带状态码的错误：HTTP 接口的处理函数里抛它，接口外面的错误处理照 status 回 { error: message }。
 * 原来 files-api、http/Tokens、relay/Routes、settings/ConfigFile、web-api/Trace 各写了一模一样的一份，11-17 合成这一份。
 */


/** 带状态码的错误。 */
export class Failure extends Error {
  /**
   * @param status HTTP 状态码，如 400 请求不对、403 不给看、404 没有这个东西、409 冲突、503 缺服务。
   * @param message 回给调用方的一句话。
   */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
