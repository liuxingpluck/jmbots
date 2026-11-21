/**
 * 宿主机守卫的正式探针：内存用 node:os 直接读；显存复用 programs 插件的 ResourceProbe（同一份 nvidia-smi 读法，不另写一套）；
 * 占用前 5 的进程只在超线告警时拉一次（Windows 用 tasklist，别的系统用 ps，显存用 nvidia-smi --query-compute-apps）。
 * 每个探针都不抛错：读不到交回 null 或空数组，不卡守卫的主循环。
 */
import * as childProcess from 'node:child_process';
import * as os from 'node:os';
import * as resourceProbeModule from '../programs/ResourceProbe.ts';
import type * as types from './Types.ts';


/** 拉进程清单的超时，毫秒。 */
const TOP_TIMEOUT_MS = 4000;

/** 交回前几名。 */
const TOP_COUNT = 5;

/** 进程清单的三种文字格式：Windows tasklist 的 CSV、ps 的空格分列、nvidia-smi 的 CSV。 */
export type TopFormat = 'tasklist' | 'ps' | 'nvidia';


/**
 * 建正式探针。
 * @param nvidiaSmi nvidia-smi 的命令名或路径（配置 nvidia_smi）。
 * @returns 交给 HostGuard 用的四个函数。
 */
export function createProbes(nvidiaSmi: string): types.HostProbes {
  //M 显存交给 programs 的 ResourceProbe 读：它已处理好逐卡、MiB 换字节、N/A 和超时。
  const resourceProbe = new resourceProbeModule.ResourceProbe(nvidiaSmi);

  return {
    probeRam: async () => readRam(),
    probeVram: async () => {
      const sample = await resourceProbe.read(AbortSignal.timeout(TOP_TIMEOUT_MS));
      return pickBusiestGpu(sample.gpus);
    },
    probeTop: async (line) => readTop(line, nvidiaSmi),
    now: () => Date.now(),
  };
}


/**
 * 读宿主机物理内存：总量减可用（Windows 上 freemem 就是可用物理内存，和任务管理器的“已用”同口径）。
 * @returns 已用和总量，字节；读数不合理交回 null。
 */
function readRam(): types.Usage | null {
  const total = os.totalmem();
  const free = os.freemem();
  //G 总量要是正数，可用不能超出总量；不合理就当读不到，不伪造成 0。
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(free) || free < 0 || free > total) return null;

  return { used: total - free, total };
}


/**
 * 多张卡里取用得最多的那张（红线按单卡算，不把几张卡相加）。
 * @param gpus ResourceProbe 读出的逐卡显存；null 是读不到。
 * @returns 那张卡的已用和总量；没有卡交回 null。
 */
export function pickBusiestGpu(gpus: resourceProbeModule.GpuSample[] | null): types.Usage | null {
  if (gpus === null || gpus.length === 0) return null;

  let busiest = gpus[0] as resourceProbeModule.GpuSample;
  for (const gpu of gpus) {
    if (gpu.used > busiest.used) {
      busiest = gpu;
    }
  }
  return { used: busiest.used, total: busiest.total };
}


/**
 * 拉占用前 5 的进程。
 * @param line ram 拉内存的，vram 拉显存的。
 * @param nvidiaSmi nvidia-smi 的命令名或路径。
 * @returns 前 5 名；命令失败或超时交回空数组。
 */
async function readTop(line: types.LineName, nvidiaSmi: string): Promise<types.TopProcess[]> {
  //M 显存：问 nvidia-smi 各进程用了多少（Windows 的 WDDM 模式下常是 N/A，解析时跳过）。
  if (line === 'vram') {
    const query = '--query-compute-apps=pid,process_name,used_memory';
    const text = await runText(nvidiaSmi, [query, '--format=csv,noheader,nounits']);
    return parseTop(text, 'nvidia');
  }

  //M 内存：Windows 用 tasklist 的 CSV，别的系统用 ps。
  if (process.platform === 'win32') {
    const text = await runText('tasklist', ['/fo', 'csv', '/nh']);
    return parseTop(text, 'tasklist');
  }
  const text = await runText('ps', ['-eo', 'pid=,rss=,comm=']);
  return parseTop(text, 'ps');
}


/**
 * 跑一条只读命令拿输出文字；不套 shell、隐藏窗口、4 秒超时。
 * @param file 命令名或路径。
 * @param args 参数。
 * @returns 标准输出；失败、超时交回空串。
 */
function runText(file: string, args: string[]): Promise<string> {
  const options = {
    timeout: TOP_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8' as const,
  };
  return new Promise((resolve) => {
    childProcess.execFile(file, args, options, (error, stdout) => {
      if (error !== null) {
        resolve('');
        return;
      }
      resolve(stdout);
    });
  });
}


/**
 * 把三种进程清单文字解析成按占用从大到小的前 5 名。
 * - tasklist：`"映像名","PID","会话名","会话#","内存使用"`，内存形如 `123,456 K`（千分位随系统区域变，只取数字）。
 * - ps：`PID RSS(KB) 命令`，空格分列。
 * - nvidia：`pid, process_name, used_memory(MiB)`，用量是 N/A 的跳过。
 * @param text 命令输出。
 * @param format 哪种格式。
 * @returns 前 5 名；一行都认不出交回空数组。
 */
export function parseTop(text: string, format: TopFormat): types.TopProcess[] {
  const result: types.TopProcess[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const row = raw.trim();
    if (row === '') continue;

    //M 按格式把一行拆成 进程号、进程名、占用 MB。
    const fields = splitRow(row, format);
    if (fields === null) continue;

    //G 进程号要是正整数、占用要是有限的非负数，认不出的行跳过。
    if (!Number.isSafeInteger(fields.pid) || fields.pid <= 0) continue;
    if (!Number.isFinite(fields.mb) || fields.mb < 0) continue;

    result.push(fields);
  }

  //M 从大到小排，取前 5。
  result.sort((left, right) => right.mb - left.mb);
  return result.slice(0, TOP_COUNT);
}


/**
 * 按格式拆一行。
 * @param row 去掉首尾空白的一行。
 * @param format 哪种格式。
 * @returns 进程号、名字、MB；列数不对交回 null。
 */
function splitRow(row: string, format: TopFormat): types.TopProcess | null {
  //M tasklist：去掉首尾引号按 "," 切；内存一列去掉千分位和 K，按 KB 换成 MB。
  if (format === 'tasklist') {
    const cells = row.replace(/^"|"$/gu, '').split('","');
    if (cells.length < 5) return null;

    const kb = Number((cells[4] as string).replace(/\D/gu, ''));
    return { pid: Number(cells[1]), name: cells[0] as string, mb: Math.round(kb / 1024) };
  }

  //M ps：前两列是 PID 和 RSS(KB)，剩下的都是命令名（可能带空格）。
  if (format === 'ps') {
    const cells = row.split(/\s+/u);
    if (cells.length < 3) return null;

    const kb = Number(cells[1]);
    return { pid: Number(cells[0]), name: cells.slice(2).join(' '), mb: Math.round(kb / 1024) };
  }

  //M nvidia：逗号分三列；用量是 [N/A] 时 Number 得 NaN，交给上面跳过。
  const cells = row.split(',').map((cell) => cell.trim());
  if (cells.length < 3) return null;

  return { pid: Number(cells[0]), name: cells[1] as string, mb: Number(cells[2]) };
}
