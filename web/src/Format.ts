/** 显示用的格式化函数，文档列表和文档正文共用。 */


/** 把毫秒时间戳显示成本地时间，例如 `10-29 14:05`。 */
export function formatTime(timestamp: number): string {
  /** 要显示的时间点。 */
  const time = new Date(timestamp);
  return `${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}


/** 补成两位数字，例如 5 → '05'。 */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}
