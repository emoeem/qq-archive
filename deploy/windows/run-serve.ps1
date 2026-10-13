<#
用法:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\run-serve.ps1

说明:
  计划任务「网页服务（登录时启动）」实际调用的包装脚本。它做四件事：
    1. 以脚本自身位置推导仓库根目录（$PSScriptRoot 的两层上级），并把工作目录切过去；
    2. 确认 config.json 与日志目录存在；
    3. 前台常驻运行 `qq-archive serve`；
    4. 把整段运行的 stdout/stderr 落盘，并按数量轮转日志（保留最近 N 份）。

  这是一个「长驻」脚本：serve 不返回，它就跟着一直不返回，进程生命周期与计划任务
  的这次运行一一对应。计划任务在「用户注销 / 停止任务」时会 TerminateProcess，
  整棵进程树（powershell + node）会被直接杀掉，**不会有优雅关闭**。
  所以：能靠 `qq-archive backup` 先备份就先生成，数据库是 SQLite + WAL，被杀掉
  通常不会损坏，但未 checkpoint 的 WAL 要等下次启动才会合并。

  想手动停：任务管理器结束 node.exe，或
    Stop-ScheduledTask -TaskName QQArchive-Serve
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$ConfigPath = '',
    [int]$KeepLogs = 8,
    [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

#region 通用小工具（各脚本各自复制一份，保持单文件可独立分发）

function Write-Step {
    param([string]$Message)
    Write-Host ("[serve] " + $Message)
}

function Write-Warn {
    param([string]$Message)
    Write-Host ("[serve][警告] " + $Message) -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host ("[serve][错误] " + $Message) -ForegroundColor Red
}

function Get-ScriptDirName {
    # 只是给下面的 throw 信息加一点上下文，避免消息里出现整条绝对路径。
    param([string]$FullPath)
    return [System.IO.Path]::GetFileName($FullPath)
}

function Resolve-RepoRoot {
    param([string]$Override)

    if ($Override -ne '') {
        $candidate = $Override
    }
    else {
        # $PSScriptRoot = <仓库根>\deploy\windows，向上两层即仓库根。
        $candidate = Join-Path $PSScriptRoot '..\..'
    }

    try {
        $full = [System.IO.Path]::GetFullPath($candidate)
    }
    catch {
        throw ("仓库根目录无法解析，请用 -RepoRoot 显式指定（收到：" + $candidate + "）")
    }

    $entry = Join-Path $full 'apps\cli\src\main.ts'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
        throw ("这不像仓库根目录：找不到 apps\cli\src\main.ts（解析结果：" + $full + "）。请用 -RepoRoot 指定。")
    }
    return $full
}

function Resolve-RepoConfigPath {
    param([string]$Repo, [string]$Override)

    if ($Override -ne '') {
        return $Override
    }
    return (Join-Path $Repo 'config.json')
}

function Get-ConfigLogDir {
    # 从配置文件里读出日志目录。只做一层 JSON 解析，绝不修改配置文件。
    # 读不到时返回空串，调用方自行回退到 <仓库根>\data\logs。
    param([string]$ConfigFullPath)

    if (-not (Test-Path -LiteralPath $ConfigFullPath -PathType Leaf)) { return '' }

    try {
        $raw = Get-Content -LiteralPath $ConfigFullPath -Raw -Encoding UTF8
        $obj = $raw | ConvertFrom-Json
    }
    catch {
        return ''
    }

    if ($null -eq $obj) { return '' }
    $storage = $obj.storage
    if ($null -eq $storage) { return '' }

    $logDir = [string]$storage.logDir
    if ($logDir -ne '') {
        if ([System.IO.Path]::IsPathRooted($logDir)) { return $logDir }
        return ([System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetDirectoryName($ConfigFullPath)) $logDir)))
    }

    # logDir 为空时 CLI 用 <dataDir>/logs；dataDir 同样相对配置文件所在目录解析。
    $dataDir = [string]$storage.dataDir
    if ($dataDir -eq '') { $dataDir = '.\data' }
    if (-not [System.IO.Path]::IsPathRooted($dataDir)) {
        $dataDir = Join-Path ([System.IO.Path]::GetDirectoryName($ConfigFullPath)) $dataDir
    }
    return ([System.IO.Path]::GetFullPath((Join-Path $dataDir 'logs')))
}

function Ensure-Directory {
    param([string]$Path, [string]$Label)

    if (Test-Path -LiteralPath $Path -PathType Container) { return }
    try {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
    catch {
        throw ($Label + " 目录创建失败：" + $Path + "（" + $_.Exception.Message + "）")
    }
}

function Get-NodeInvocation {
    # 返回 @{ Exe = 'node 可执行文件完整路径'; Entry = 'CLI 的 .ts 入口' }。
    param([string]$Repo)

    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $cmd) {
        throw '找不到 node 命令。请先安装 Node.js ≥ 22.5 并确认它在 PATH 里；运行 install.ps1 可自动检测。'
    }

    $exe = [string]$cmd.Source
    if ($exe -eq '') { $exe = [string]$cmd.Path }
    if ($exe -eq '') {
        throw '找到了 node 命令，但无法解析它的可执行文件路径。请检查 PATH。'
    }

    return @{
        Exe   = $exe
        Entry = (Join-Path $Repo 'apps\cli\src\main.ts')
    }
}

function ConvertTo-ArgToken {
    param([string]$Value)

    if ($Value -eq '') { return '""' }
    # 引用点前连续的反斜杠要翻倍，否则结尾的 \" 会把引号转义掉。
    if ($Value -match '[\s"]') {
        $slashCount = 0
        $i = $Value.Length - 1
        while ($i -ge 0 -and $Value[$i] -eq '\') { $slashCount++; $i-- }
        $escaped = $Value.Substring(0, $Value.Length - $slashCount) + ('\' * ($slashCount * 2))
        return ('"' + $escaped + '"')
    }
    return $Value
}

function New-NodeArgumentList {
    param([string]$Entry, [string[]]$Arguments)

    $tokens = @()
    $tokens += ConvertTo-ArgToken '--experimental-strip-types'
    $tokens += ConvertTo-ArgToken $Entry
    foreach ($item in @($Arguments)) {
        if ($null -eq $item) { continue }
        $tokens += ConvertTo-ArgToken ([string]$item)
    }
    return ($tokens -join ' ')
}

function Invoke-LogRotation {
    # 只按数量轮转：保留最近 $Keep 份，删掉更早的。
    param([string]$LogDir, [string]$Pattern, [int]$Keep)

    if ($Keep -lt 1) { return }
    if (-not (Test-Path -LiteralPath $LogDir -PathType Container)) { return }

    $old = @(Get-ChildItem -LiteralPath $LogDir -Filter $Pattern -File -ErrorAction SilentlyContinue |
        Sort-Object -Property LastWriteTime -Descending |
        Select-Object -Skip $Keep)
    if ($old.Count -eq 0) { return }

    $removed = 0
    foreach ($f in $old) {
        try {
            Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
            $removed++
        }
        catch {
            # 正在被占用（极少见）时跳过即可，不要因此让本次启动失败。
            Write-Warn ("旧日志删除失败，已跳过：" + $f.Name)
        }
    }
    if ($removed -gt 0) {
        Write-Step ("日志轮转：删除 " + $removed + " 份旧日志，保留最近 " + $Keep + " 份")
    }
}

function Get-RunStamp {
    return (Get-Date -Format 'yyyyMMdd-HHmmss')
}

#endregion

#region 主流程

$repo = Resolve-RepoRoot -Override $RepoRoot
$config = Resolve-RepoConfigPath -Repo $repo -Override $ConfigPath
$scriptName = Get-ScriptDirName -FullPath $PSCommandPath

Set-Location -LiteralPath $repo

if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
    Write-Warn ("配置文件不存在：" + $config)
    Write-Warn "服务将按内置默认值启动（CLI 会尝试在仓库根生成 config.json，并写入随机登录令牌）。"
    Write-Warn "建议先跑一次 install.ps1，它会从 config.example.json 复制一份并生成登录令牌。"
}

$logDir = Get-ConfigLogDir -ConfigFullPath $config
if ($logDir -eq '') {
    $logDir = Join-Path $repo 'data\logs'
}
Ensure-Directory -Path $logDir -Label '日志'

$node = Get-NodeInvocation -Repo $repo
$argList = New-NodeArgumentList -Entry $node.Entry -Arguments @('--config', $config, 'serve')

Write-Step ("仓库根目录：" + $repo)
Write-Step ("配置文件：" + $config)
Write-Step ("Node：" + $node.Exe)
Write-Step '登录令牌可用 `node bin\qq-archive.mjs token` 或 `node --experimental-strip-types apps\cli\src\main.ts token` 查看。'

if ($DryRun) {
    Write-Step "[DryRun] 即将执行："
    Write-Step ('  "' + $node.Exe + '" ' + $argList)
    Write-Step ("[DryRun] 日志目录：" + $logDir)
    exit 0
}

Invoke-LogRotation -LogDir $logDir -Pattern 'qq-archive-serve-*.log' -Keep $KeepLogs

$stamp = Get-RunStamp
$stdout = Join-Path $logDir ('qq-archive-serve-' + $stamp + '.log')
$stderr = Join-Path $logDir ('qq-archive-serve-' + $stamp + '.err.log')

Write-Step ("启动服务，日志：" + $stdout)
Write-Step '停止方式：Stop-ScheduledTask -TaskName QQArchive-Serve（或结束 node.exe）'

$exit = 1
try {
    $proc = Start-Process -FilePath $node.Exe -ArgumentList $argList -WorkingDirectory $repo `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $exit = [int]$proc.ExitCode
}
catch {
    Write-Fail ("启动 Node 失败：" + $_.Exception.Message)
    exit 1
}

if ($exit -eq 0) {
    Write-Step '服务已正常退出（退出码 0）'
}
else {
    Write-Fail ("服务退出，退出码 " + $exit + "。stderr 与完整输出见：" + $stdout)
}

# 退出码透传给计划任务。
exit $exit

#endregion
