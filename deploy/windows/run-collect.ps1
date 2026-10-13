<#
用法:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\run-collect.ps1

说明:
  计划任务「定时采集」实际调用的包装脚本。它做四件事：
    1. 以脚本自身位置推导仓库根目录（$PSScriptRoot 的两层上级），并把工作目录切过去；
    2. 确认 config.json 与 data/logs 存在；
    3. 调 `qq-archive collect --once` 跑一轮采集；
    4. 把这一轮的 stdout/stderr 落盘，并按数量轮转日志（保留最近 N 份）。

  为什么是 `collect --once` 而不是常驻的 `collect`：
  常驻进程崩掉后只能靠计划任务在下次触发时重启，中间会有一段采集空窗；
  拆成「每 N 分钟跑一轮」之后，每一轮都是全新进程，不存在「进程悄悄死了但任务还显示
  正在运行」这种状态，与 Linux 侧的 `Restart=always` 相比更容易观测。

  退出码直接透传给计划任务，所以「上次运行结果」列里非 0 就代表这一轮失败了。
  注意 2 和 3 不是脚本自身的错误：
    2 = 配置里 collector.kind 不是 onebot（采集未启用，属正常状态）
    3 = 连不上 OneBot（NapCat / LLOneBot 没在跑，或 baseUrl / token 不对）
  完整退出码语义见仓库根 README 与 docs/DEPLOYMENT.md。
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$ConfigPath = '',
    [int]$KeepLogs = 30,
    [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

#region 通用小工具（各脚本各自复制一份，保持单文件可独立分发）

function Write-Step {
    param([string]$Message)
    Write-Host ("[collect] " + $Message)
}

function Write-Warn {
    param([string]$Message)
    Write-Host ("[collect][警告] " + $Message) -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host ("[collect][错误] " + $Message) -ForegroundColor Red
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
    # 计划任务的动作里存的是绝对路径，所以必须解析成完整路径再交给调用方。
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
    # 只按数量轮转：保留最近 $Keep 份，删掉更早的。默认 30 份 ≈ 30 轮采集。
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
            # 正在被占用（极少见）时跳过即可，不要因此让本轮采集失败。
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

function Show-FailureTail {
    param([string]$Text, [int]$Lines = 20)

    if ($Text -eq '') { return }
    $all = @($Text -split "`r?`n")
    if ($all.Count -le $Lines) { return $all }
    return ($all[($all.Count - $Lines)..($all.Count - 1)])
}

#endregion

#region 主流程

$repo = Resolve-RepoRoot -Override $RepoRoot
$config = Resolve-RepoConfigPath -Repo $repo -Override $ConfigPath
$scriptName = Get-ScriptDirName -FullPath $PSCommandPath

Set-Location -LiteralPath $repo

if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
    Write-Warn ("配置文件不存在：" + $config)
    Write-Warn "本轮将按内置默认值运行（CLI 会尝试在仓库根生成 config.json）。"
    Write-Warn "建议先跑一次 install.ps1，它会从 config.example.json 复制一份并生成登录令牌。"
}

$logDir = Get-ConfigLogDir -ConfigFullPath $config
if ($logDir -eq '') {
    $logDir = Join-Path $repo 'data\logs'
}
Ensure-Directory -Path $logDir -Label '日志'

$node = Get-NodeInvocation -Repo $repo
$argList = New-NodeArgumentList -Entry $node.Entry -Arguments @('--config', $config, 'collect', '--once')

Write-Step ("仓库根目录：" + $repo)
Write-Step ("配置文件：" + $config)
Write-Step ("Node：" + $node.Exe)

if ($DryRun) {
    Write-Step "[DryRun] 即将执行："
    Write-Step ('  "' + $node.Exe + '" ' + $argList)
    Write-Step ("[DryRun] 日志目录：" + $logDir)
    exit 0
}

Invoke-LogRotation -LogDir $logDir -Pattern 'qq-archive-collect-*.log' -Keep $KeepLogs

$stamp = Get-RunStamp
$stdout = Join-Path $logDir ('qq-archive-collect-' + $stamp + '.log')
$stderr = Join-Path $logDir ('qq-archive-collect-' + $stamp + '.err.log')

Write-Step ("开始采集，日志：" + $stdout)

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

# stderr 为空就把空文件清掉，避免日志目录里堆一堆 0 字节文件。
if (Test-Path -LiteralPath $stderr) {
    if ((Get-Item -LiteralPath $stderr).Length -eq 0) {
        Remove-Item -LiteralPath $stderr -Force -ErrorAction SilentlyContinue
        $stderr = ''
    }
}

if ($exit -eq 0) {
    Write-Step '本轮采集成功（退出码 0）'
}
elseif ($exit -eq 2) {
    Write-Warn '采集未启用：配置里 collector.kind 不是 "onebot"（退出码 2）。'
    Write-Warn '这不是故障：纯离线导入的用户不需要采集。要启用请改配置后重跑 install.ps1。'
}
elseif ($exit -eq 3) {
    Write-Fail '连不上 OneBot 采集端（退出码 3）。'
    Write-Fail '请确认 NapCat / LLOneBot 在运行，且 collector.baseUrl 与 collector.token 正确。'
}
else {
    Write-Fail ("本轮采集失败，退出码 " + $exit + "。请查看：" + $stdout)
}

if ($stderr -ne '' -and (Test-Path -LiteralPath $stderr)) {
    $errText = Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue
    $tail = Show-FailureTail -Text ([string]$errText) -Lines 20
    if ($null -ne $tail -and $tail -ne '') {
        Write-Fail '----- stderr 末尾 -----'
        foreach ($line in @($tail)) { Write-Host ([string]$line) }
        Write-Fail '-----------------------'
    }
}

# 退出码透传给计划任务，这样「上次运行结果」列能直接看出成败。
exit $exit

#endregion
