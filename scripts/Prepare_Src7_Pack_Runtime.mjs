/**
 * 给打包试运行准备独立的 jmbotsData：从已有测试配置复制（不打印密钥），改端口，加上 notify、progress、memory-graph 和基地地址，复制后端 exe 和出厂提示词。
 * 用法：bun scripts/Prepare_Src7_Pack_Runtime.mjs --pack <打包目录> --server-port 15761 --shell-port 15762
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

const ROOT = path.resolve(import.meta.dir, '..');

function option(name, fallback = '') {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} 后面要写值`);
  return value;
}

const packDir = path.resolve(option('pack'));
const serverPort = Number(option('server-port', '15761'));
const shellPort = Number(option('shell-port', '15762'));
if (!Number.isInteger(serverPort) || !Number.isInteger(shellPort)) throw new Error('端口要是整数');

const runtime = path.join(packDir, 'jmbotsData');
fs.mkdirSync(path.join(runtime, 'data', 'logs'), { recursive: true });

const srcConfig = path.join(ROOT, 'cache', 'test-src7-real8', 'config.yaml');
const raw = fs.readFileSync(srcConfig, 'utf8');
const data = yaml.parse(raw);
data.server = { ...(data.server ?? {}), port: serverPort };
data.engine = { ...(data.engine ?? {}), index_url: `http://127.0.0.1:${String(shellPort)}` };
data.local = { ...(data.local ?? {}), port: shellPort, host: '127.0.0.1' };
const plugins = Array.isArray(data.plugins) ? data.plugins : [];
const names = plugins.map((item) => (typeof item === 'string' ? item : item?.name));
if (!names.includes('notify')) plugins.push({ name: 'notify' });
if (!names.includes('progress')) plugins.push({ name: 'progress' });
// 图谱页 /graph/ 由 memory-graph 托管；不配就回落到聊天首页。
if (!names.includes('memory-graph')) plugins.push({ name: 'memory-graph' });
data.plugins = plugins;
fs.writeFileSync(path.join(runtime, 'config.yaml'), yaml.stringify(data), 'utf8');

const promptsSrc = path.join(ROOT, 'prompts');
const promptsDest = path.join(runtime, 'prompts');
fs.mkdirSync(promptsDest, { recursive: true });
if (fs.existsSync(promptsSrc)) {
  for (const name of fs.readdirSync(promptsSrc)) {
    if (!name.endsWith('.md') || name === 'README.md') continue;
    const dest = path.join(promptsDest, name);
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(promptsSrc, name), dest);
  }
}

const exeName = process.platform === 'win32' ? 'jmbots-server.exe' : 'jmbots-server';
const built = path.join(packDir, exeName);
if (fs.existsSync(built)) fs.copyFileSync(built, path.join(runtime, exeName));

console.log(JSON.stringify({
  runtime,
  serverPort,
  shellPort,
  hasServer: fs.existsSync(path.join(runtime, exeName)),
  plugins: data.plugins.map((item) => (typeof item === 'string' ? item : item.name)),
  default_model: data.default_model,
}, null, 2));
