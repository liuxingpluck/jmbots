"""目录迁移后的路径更新：只处理显式列出的程序源码、测试和当前文档。

运行：项目便携 Python -B 本文件。输入为固定项目根；输出为更新计数和目录说明。
副作用：更新源码中的路径及文档；不遍历运行数据，不读取密钥、聊天或第三方源码。
迁移备份位于项目 var/backups；本脚本保留供核对，不自动清理。
"""
import json
import re
from pathlib import Path

ROOT = Path('F:/aidata/AIJMBots/jmbotsData/program/jimukefu')
MAPPING = {
    'data': 'var/data', 'cache': 'var/cache', 'tmp': 'var/tmp', 'logs': 'var/logs',
    'runtimes': 'third_party/runtimes', 'web': 'src/web', 'prompts': 'src/prompts',
    'zotherGit': 'third_party/sources', 'licenses': 'third_party/licenses',
    'wechat_cli': 'python/wechat_cli',
}


def write(relative, text):
    """将 UTF-8 源码写回明确的项目内文件。"""
    file = ROOT / relative
    if not file.resolve().is_relative_to(ROOT):
        raise ValueError('更新目标必须在项目内')
    file.write_text(text, encoding='utf-8', newline='')


def update_paths(text):
    """更新目录字面量；不替换 data 事件名、WAV 头或数据库列名。"""
    text = text.replace('../web/', '../src/web/')
    text = text.replace('scripts/dev/', 'src/dev/')
    for slash in ('\\\\', '\\'):
        text = text.replace('scripts' + slash + 'dev' + slash, 'src' + slash + 'dev' + slash)
    # 打包产物属于运行目录，先处理，防止被当作网页源码目录。
    text = re.sub(r'(?<![\w/\\])web/dist', 'var/web', text)
    text = re.sub(r"(path\.(?:posix\.)?(?:join|resolve)\(\s*[^\n]*?,\s*)(['\"])web\2,\s*(['\"])dist\3", r"\1'var/web'", text)
    prefix = r'(?<![A-Za-z0-9_/\\])(' + '|'.join(MAPPING) + r')([/\\]+)'
    def prefix_replace(match):
        separator = match[2]
        return MAPPING[match[1]].replace('/', separator) + separator
    text = re.sub(prefix, prefix_replace, text)
    # 只修改路径函数的第一个目录参数，不碰嵌套的 cache/tmp 子目录名。
    path_call = r"((?:path\.(?:posix\.)?(?:join|resolve)|managed)\(\s*(?:(?:ROOT|root|directory|current\.directory|third\.directory|r\.directory)\s*,\s*)?)(['\"])(data|cache|tmp|logs|runtimes|web|prompts)\2"
    text = re.sub(path_call, lambda m: m[1] + m[2] + MAPPING[m[3]] + m[2], text)
    text = re.sub(r"((?:ROOT|PROJECT_ROOT)\s*/\s*)(['\"])(data|cache|tmp|logs|runtimes)\2", lambda m: m[1] + m[2] + MAPPING[m[3]] + m[2], text)
    text = re.sub(r"((?:Path|os\.path\.join)\(\s*)(['\"])(data|cache|tmp|logs|runtimes)\2", lambda m: m[1] + m[2] + MAPPING[m[3]] + m[2], text)
    text = text.replace("const DEFAULT_DIR = 'data'", "const DEFAULT_DIR = 'var/data'")
    text = text.replace("config.stateDir ?? 'data'", "config.stateDir ?? 'var/data'")
    return text


changed = []
for folder in ('src', 'tests', 'python/wechat_cli'):
    for file in (ROOT / folder).rglob('*'):
        if not file.is_file() or file.suffix not in ('.ts', '.tsx', '.py', '.cmd') or '__pycache__' in file.parts:
            continue
        original = file.read_text(encoding='utf-8-sig')
        updated = update_paths(original)
        if file.suffix == '.py':
            updated = updated.replace('sys.path.insert(0, str(ROOT))', 'sys.path.insert(0, str(ROOT / "python"))')
            updated = updated.replace('if str(ROOT) not in sys.path:', 'if str(ROOT / "python") not in sys.path:')
        if updated != original:
            relative = file.relative_to(ROOT)
            write(relative, updated)
            changed.append(str(relative))

# Python 包多了一层目录；已有账号配置的旧绝对路径只在解析时重定位，不改配置内容。
portable_file = Path('python/wechat_cli/core/portable.py')
portable = (ROOT / portable_file).read_text(encoding='utf-8')
portable = portable.replace('parents[2]', 'parents[3]')
portable = portable.replace(
    '    return str(p)\n',
    '    # 兼容搬迁前保存在账号配置和缓存索引中的项目内绝对路径。\n'
    '    relative = p.relative_to(ROOT)\n'
    '    if relative.parts and relative.parts[0] in {"data", "cache", "tmp", "logs"}:\n'
    '        p = (ROOT / "var" / relative).resolve()\n'
    '        if p != ROOT and ROOT not in p.parents:\n'
    '            raise ValueError("Managed path escapes jimukefu directory")\n'
    '    return str(p)\n',
)
write(portable_file, portable)
cache_file = Path('python/wechat_cli/core/db_cache.py')
cache_text = (ROOT / cache_file).read_text(encoding='utf-8')
cache_text = cache_text.replace('os.path.realpath(info["path"])', 'os.path.realpath(managed(info["path"]))')
write(cache_file, cache_text)

# 子进程只搜索新的 Python 源码目录，工作目录仍为项目根。
python_file = Path('src/services/Python.ts')
python_text = (ROOT / python_file).read_text(encoding='utf-8')
python_text = python_text.replace('PYTHONPATH: paths.root,', "PYTHONPATH: paths.managed('python'),")
write(python_file, python_text)
for relative in ('src/dev/Verify_Media.ts',):
    text = (ROOT / relative).read_text(encoding='utf-8')
    text = text.replace('PYTHONPATH: ROOT,', "PYTHONPATH: path.join(ROOT, 'python'),")
    write(relative, text)

# 便携 Python 在项目根运行脚本时，由验证脚本显式加入 python/。
verify = ROOT / 'src/dev/Verify_Accounts_Read.py'
text = verify.read_text(encoding='utf-8')
text = text.replace('sys.path.insert(0, str(ROOT / "python"))', 'sys.path.insert(0, str(ROOT / "python"))')
write(verify.relative_to(ROOT), text)

# 迁移源码/产物目录后，媒体测试需分别建立首页目录和产物目录。
media_test = Path('tests/Media.test.ts')
text = (ROOT / media_test).read_text(encoding='utf-8')
text = text.replace("  fs.writeFileSync(path.join(directory, 'src/web', 'index.html')", "  fs.mkdirSync(path.join(directory, 'src/web'), { recursive: true });\n  fs.writeFileSync(path.join(directory, 'src/web', 'index.html')")
write(media_test, text)

# 四处类型断言由前面的 header/长度检查保证，保持原有解析行为。
wxgf = Path('src/utils/Wxgf.ts')
text = (ROOT / wxgf).read_text(encoding='utf-8')
text = text.replace('(data[7] << 8) | data[8]', '(data[7]! << 8) | data[8]!')
text = text.replace('(data[9] << 8) | data[10]', '(data[9]! << 8) | data[10]!')
write(wxgf, text)

# 运行脚本使用新位置；只修改子进程的临时环境，不改系统环境。
for relative in ('src/dev/Run_Server.cmd', '启动积木客服.cmd'):
    text = (ROOT / relative).read_text(encoding='utf-8')
    text = text.replace('%CD%\\runtimes\\', '%CD%\\third_party\\runtimes\\')
    text = text.replace('%~dp0runtimes\\', '%~dp0third_party\\runtimes\\')
    text = text.replace('%CD%\\logs\\', '%CD%\\var\\logs\\')
    text = text.replace('%CD%\\tmp', '%CD%\\var\\tmp')
    text = text.replace('%~dp0tmp', '%~dp0var\\tmp')
    write(relative, text)

for relative in ('tsconfig.json', 'tsconfig.check.json'):
    config = json.loads((ROOT / relative).read_text(encoding='utf-8'))
    config['include'] = ['src/**/*.ts', 'src/**/*.tsx', 'tests/**/*.ts']
    config['exclude'] = ['node_modules', 'docs', 'third_party', 'var', 'src/dev']
    write(relative, json.dumps(config, ensure_ascii=False, indent=2) + '\n')

write('.gitignore', '/node_modules/\n/var/\n/third_party/runtimes/\n/docs/备课/弃用_*/\n__pycache__/\n*.pyc\n')

# 路径回归检查：只用合成路径，不接触实际账号配置、聊天或密钥。
test = Path('tests/portable_test.py')
text = (ROOT / test).read_text(encoding='utf-8')
insertion = '''    def test_migrated_directories(self):
        self.assertEqual(Path(portable.STATE_DIR), ROOT / "var/data" / portable.ACCOUNT)
        self.assertEqual(Path(portable.CACHE_DIR), ROOT / "var/cache" / portable.ACCOUNT)

    def test_legacy_managed_paths(self):
        for folder in ("data", "cache", "tmp", "logs"):
            legacy = ROOT / folder / "synthetic" / "file.json"
            expected = ROOT / "var" / folder / "synthetic" / "file.json"
            self.assertEqual(Path(portable.managed(legacy)), expected)

'''
text = text.replace('    def test_duplicate_chat(self):', insertion + '    def test_duplicate_chat(self):')
write(test, text)

# 当前说明同步新路径；历史交接和进度只加迁移指路，保留当时的事实。
for relative in ('README.md', 'docs/开发规则.md', 'docs/微信操控规划.md', 'docs/大漠识字找图.md'):
    text = (ROOT / relative).read_text(encoding='utf-8')
    write(relative, update_paths(text))
for relative in ('docs/交接_20261110.md', 'docs/沟通记录.md', 'docs/进度存档_20261110.md', 'docs/PROGRESS.md'):
    text = (ROOT / relative).read_text(encoding='utf-8')
    first, separator, rest = text.partition('\n')
    notice = '\n> 2026-11-11 目录已迁移。以下保留历史路径；当前目录、启动命令和对照见 [目录结构](目录结构.md)。\n'
    write(relative, first + separator + notice + rest)

print(json.dumps({'updated_source_files': len(changed), 'legacy_runtime_paths': 'resolved in Python only; source data unchanged'}, ensure_ascii=False))
