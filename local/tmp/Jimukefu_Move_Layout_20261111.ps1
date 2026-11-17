# 用途：按已确认的目录方案搬迁积木客服；只移动项目内列出的目录，不读取运行数据内容。
# 运行：powershell -NoProfile -File 本文件。输入为下方固定项目路径；输出为 var/backups 下的源码快照和迁移清单。
# 副作用：复制源码与文档作为备份、移动目录。运行前必须停止积木客服；不操作微信、浏览器、系统设置。
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath('F:/aidata/AIJMBots/jmbotsData/program/jimukefu')
$projectPrefix = $projectRoot.TrimEnd('\') + '\'

function ProjectPath([string]$relative) {
    $absolute = [IO.Path]::GetFullPath((Join-Path $projectRoot $relative))
    if (-not $absolute.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw '迁移路径必须位于积木客服项目内'
    }
    return $absolute
}

# 所有源和目标在移动前完整检查，禁止覆盖已存在的目标。
$moves = @(
    @('web/dist', 'var/web'),
    @('web', 'src/web'),
    @('scripts/dev', 'src/dev'),
    @('prompts', 'src/prompts'),
    @('wechat_cli', 'python/wechat_cli'),
    @('pyproject.toml', 'python/pyproject.toml'),
    @('requirements.lock.txt', 'python/requirements.lock.txt'),
    @('runtimes', 'third_party/runtimes'),
    @('zotherGit', 'third_party/sources'),
    @('licenses', 'third_party/licenses'),
    @('cache/downloads', 'third_party/downloads'),
    @('备课', 'docs/备课'),
    @('PROGRESS.md', 'docs/PROGRESS.md'),
    @('data', 'var/data'),
    @('cache', 'var/cache'),
    @('logs', 'var/logs'),
    @('tmp', 'var/tmp')
)
foreach ($move in $moves) {
    $source = ProjectPath $move[0]
    $target = ProjectPath $move[1]
    if (Test-Path -LiteralPath $target) { throw ('迁移目标已存在：' + $move[1]) }
    if ((Test-Path -LiteralPath $source) -and (Get-Item -LiteralPath $source).LinkType) {
        throw ('源目录是链接，须先核对：' + $move[0])
    }
}

# 只备份程序源码和当前文档；不复制账号配置、聊天、密钥或运行目录。
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupRelative = 'var/backups/Layout_' + $stamp
$backupRoot = ProjectPath $backupRelative
New-Item -ItemType Directory -Path $backupRoot | Out-Null
$snapshotFiles = @()
foreach ($relative in @('src', 'scripts', 'web', 'wechat_cli', 'tests')) {
    $snapshotFiles += Get-ChildItem -LiteralPath (ProjectPath $relative) -Recurse -File |
        Where-Object { $_.FullName -notmatch '[\\/](__pycache__|dist)[\\/]' -and $_.Extension -in @('.ts','.tsx','.css','.html','.py','.md','.json','.cmd') }
}
$snapshotFiles += Get-ChildItem -LiteralPath (ProjectPath 'docs') -File -Filter '*.md'
foreach ($relative in @('README.md','PROGRESS.md','package.json','pyproject.toml','requirements.lock.txt','tsconfig.json','tsconfig.check.json','.gitignore','启动积木客服.cmd')) {
    $snapshotFiles += Get-Item -LiteralPath (ProjectPath $relative)
}
$hashes = @()
foreach ($file in $snapshotFiles) {
    $relative = $file.FullName.Substring($projectPrefix.Length)
    $destination = Join-Path $backupRoot $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination
    $originalHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    if ($originalHash -ne (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash) { throw '源码快照校验失败' }
    $hashes += [PSCustomObject]@{ path = $relative; sha256 = $originalHash }
}
$hashes | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $backupRoot 'Source_Hashes.json') -Encoding UTF8
Write-Output ('SOURCE_BACKUP=' + $backupRelative + '; FILES=' + $snapshotFiles.Count)

# 由现有管理脚本停止指定服务；该脚本不会按进程名批量结束其他服务。
& (ProjectPath 'runtimes/bun/bun.exe') (ProjectPath 'scripts/dev/Dev_Server.ts') stop
if ($LASTEXITCODE -ne 0) { throw '积木客服服务未停止，不迁移运行目录' }
$listeners = Get-NetTCPConnection -LocalPort 30391 -State Listen -ErrorAction SilentlyContinue
if ($listeners) { throw '30391 仍在监听，不迁移运行目录' }

$completed = @()
foreach ($move in $moves) {
    $source = ProjectPath $move[0]
    $target = ProjectPath $move[1]
    if (-not (Test-Path -LiteralPath $source)) { continue }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Move-Item -LiteralPath $source -Destination $target
    if ((Test-Path -LiteralPath $source) -or -not (Test-Path -LiteralPath $target)) { throw ('目录迁移校验失败：' + $move[0]) }
    $completed += [PSCustomObject]@{ from = $move[0]; to = $move[1] }
    $completed | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $backupRoot 'Moves.json') -Encoding UTF8
    Write-Output ($move[0] + ' -> ' + $move[1])
}

# 只移除搬空后的 scripts 目录；非递归，里面还有任何内容就保留。
$oldScripts = ProjectPath 'scripts'
if ((Test-Path -LiteralPath $oldScripts) -and -not (Get-ChildItem -LiteralPath $oldScripts -Force)) {
    [IO.Directory]::Delete($oldScripts, $false)
}
Write-Output ('MOVED=' + $completed.Count)
