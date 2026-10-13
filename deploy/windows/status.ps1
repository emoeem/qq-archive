<#
用法:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\status.ps1

  # 多看几行日志、指定任务名
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\status.ps1 -TailLines 80
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\status.ps1 -TaskName QQArchive-Collect -ServeTaskName QQArchive-Serve

参数:
  -RepoRoot      仓库根目录，默认由 $PSScriptRoot 向上两层推导
  -ConfigPath    配置文件路径，默认 <仓库根>\config.json
  -TaskName      定时采集任务名，默认 QQArchive-Collect
  -ServeTaskName 网页服务任务名，默认 QQArchive-Serve
  -TailLines     每个日志文件展示的末尾行数，默认 40

说明:
  只读脚本：不修改任务、不写配置、不删日志。输出四块——
    1. 计划任务状态（含「上次运行结果」，非 0 会附上人话解释）
    2. 配置与路径（config.json 是否存在、数据/日志目录在哪）
    3. 最新日志的末尾 N 行（采集与网页各取一份最新的）
    4. 环境（Node 版本、是否管理员）

  退出码：0 = 两个任务都已注册；1 = 至少有一个任务未注册（便于脚本化判断）。
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$ConfigPath = '',
    [string]$TaskName = 'QQArchive-Collect',
    [string]$ServeTaskName = 'QQArchive-Serve',
    [int]$TailLines = 40
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

#region 通用小工具（各脚本各自复制一份，保持单文件可独立分发）

function Write-Step {
    param([string]$Message)
    Write-Host ("[status] " + $Message)
}

function Write-Warn {
    param([string]$Message)
    Write-Host ("[status][警告] " + $Message) -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host ("[status][错误] " + $Message) -ForegroundColor Red
}

function Write-Section {
    param([string]$Title)
    Write-Host ''
    Write-Host ('== ' + $Title + ' ==')
}

function Get-ScriptDirName {
    # 只是给下面的 throw 信息加一点上下文，避免消息里出现整条绝对路径。
    param([string]$FullPath)
    return [System.IO.Path]::GetFileName($FullPath)
}

function Remove-BlankLine {
    param([object]$Lines)

    $out = @()
    foreach ($line in @($Lines)) {
        if ($null -eq $line) { continue }
        $text = ([string]$line).Trim()
        if ($text -eq '') { continue }
        $out += $text
    }
    return $out
}

function Test-Admin {
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
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

#endregion

#region 计划任务

function Get-TaskState {
    # 返回 $null（不存在）或 hashtable；任务不存在时不抛异常。
    param([string]$Name)

    if ($Name -eq '') { return $null }

    try {
        $task = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
    }
    catch {
        return $null
    }

    $info = $null
    try {
        $info = Get-ScheduledTaskInfo -TaskName $Name -ErrorAction Stop
    }
    catch {
        $info = $null
    }

    return @{
        Name  = $Name
        Task  = $task
        Info  = $info
        State = [string]$task.State
    }
}

function Get-RunResultText {
    # 把计划任务的 LastTaskResult 数字翻译成人话。
    param([object]$Code)

    if ($null -eq $Code) { return '未知' }
    $n = [int]$Code

    switch ($n) {
        0 { return '成功 (0x0)' }
        1 { return '失败：不正确的函数或通用错误 (0x1)' }
        2 { return '失败：找不到文件 (0x2)' }
        10 { return '失败：环境不正确 (0xA)' }
        267008 { return '任务已就绪 (0x41300)' }
        267009 { return '正在运行 (0x41301)' }
        267010 { return '任务已禁用 (0x41302)' }
        267011 { return '任务尚未运行 (0x41303)' }
        267012 { return '任务没有更多运行 (0x41304)' }
        267014 { return '任务已由用户终止 (0x41306)' }
        3221225786 { return '被 Ctrl+C 终止 (0xC000013A)' }
        2147942402 { return '失败：系统找不到指定的文件（检查 Node 路径）(0x80070002)' }
        2147942405 { return '失败：拒绝访问（检查任务账户权限）(0x80070005)' }
        default { return ('0x' + $n.ToString('X8')) }
    }
}

function Show-TaskSection {
    param([string]$CollectTask, [string]$ServeTask)

    Write-Section '计划任务'

    $registered = 0
    foreach ($taskName in @($CollectTask, $ServeTask)) {
        if ($taskName -eq '') { continue }

        $state = Get-TaskState -Name $taskName
        if ($null -eq $state) {
            Write-Warn ($taskName + ' : 未注册')
            continue
        }
        $registered++

        Write-Host ('  ' + $taskName + ' : ' + $state.State)

        if ($null -eq $state.Info) {
            Write-Host '    上次运行 : 无法读取（可能需要管理员权限）'
            continue
        }

        $resultCode = $state.Info.LastTaskResult
        Write-Host ('    上次运行 : ' + [string]$state.Info.LastRunTime)
        Write-Host ('    上次结果 : ' + (Get-RunResultText -Code $resultCode))
        Write-Host ('    下次运行 : ' + [string]$state.Info.NextRunTime)

        if ($null -ne $resultCode) {
            $n = [int]$resultCode
            if ($n -eq 2) {
                Write-Host '              └─ 采集未启用（collector.kind 不是 "onebot"），属正常状态。'
            }
            elseif ($n -eq 3) {
                Write-Host '              └─ 连不上 OneBot 采集端：检查 NapCat/LLOneBot 是否在运行、baseUrl/token 是否正确。'
            }
            elseif ($n -ne 0 -and $n -ne 267009 -and $n -ne 267011) {
                Write-Host '              └─ 非 0 退出：查看下面的日志尾部，或直接手跑 run-collect.ps1 看完整输出。'
            }
        }
    }

    return $registered
}

#endregion

#region 日志

function Show-LogSection {
    param([string]$LogDir, [string]$Pattern, [string]$Label, [int]$Lines)

    Write-Host ''
    Write-Host ('-- ' + $Label + ' --')

    if (-not (Test-Path -LiteralPath $LogDir -PathType Container)) {
        Write-Warn ('日志目录不存在：' + $LogDir)
        return
    }

    $files = @(Get-ChildItem -LiteralPath $LogDir -Filter $Pattern -File -ErrorAction SilentlyContinue |
        Sort-Object -Property LastWriteTime -Descending)
    if ($files.Count -eq 0) {
        Write-Warn ('还没有日志文件（' + $Pattern + '）')
        $cliLogs = @(Get-ChildItem -LiteralPath $LogDir -File -ErrorAction SilentlyContinue |
            Sort-Object -Property LastWriteTime -Descending | Select-Object -First 3)
        if ($cliLogs.Count -gt 0) {
            Write-Host '    目录下另有这些文件（CLI 自己写的日志）：'
            foreach ($f in $cliLogs) {
                Write-Host ('      ' + $f.Name + '  ' + $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
            }
        }
        return
    }

    $latest = $files[0]
    Write-Host ('  文件 : ' + $latest.Name)
    Write-Host ('  时间 : ' + $latest.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') + '（' + $latest.Length + ' 字节）')
    Write-Host ('  末尾 ' + $Lines + ' 行：')

    $tail = @(Get-Content -LiteralPath $latest.FullName -Tail $Lines -ErrorAction SilentlyContinue)
    if ($tail.Count -eq 0) {
        Write-Host '    （空文件）'
        return
    }
    foreach ($line in $tail) {
        Write-Host ('    ' + [string]$line)
    }
}

#endregion

#region 环境

function Show-EnvSection {
    param([string]$Repo, [string]$ConfigFullPath, [string]$LogDir)

    Write-Section '配置与路径'

    Write-Host ('  仓库根目录 : ' + $Repo)
    if (Test-Path -LiteralPath $ConfigFullPath -PathType Leaf) {
        $size = (Get-Item -LiteralPath $ConfigFullPath).Length
        Write-Host ('  配置文件   : ' + $ConfigFullPath + '（存在，' + $size + ' 字节）')
    }
    else {
        Write-Warn ('  配置文件   : ' + $ConfigFullPath + '（不存在，任务会按默认值运行）')
    }

    $dataDir = Join-Path $Repo 'data'
    if (Test-Path -LiteralPath $dataDir -PathType Container) {
        Write-Host ('  数据目录   : ' + $dataDir)
    }
    else {
        Write-Warn ('  数据目录   : ' + $dataDir + '（不存在）')
    }
    Write-Host ('  日志目录   : ' + $LogDir)

    $dbPath = Join-Path $dataDir 'archive.db'
    if (Test-Path -LiteralPath $dbPath -PathType Leaf) {
        $dbSize = [math]::Round(((Get-Item -LiteralPath $dbPath).Length / 1MB), 2)
        Write-Host ('  数据库     : ' + $dbPath + '（' + $dbSize + ' MB）')
    }
    else {
        Write-Host ('  数据库     : ' + $dbPath + '（尚未创建，首次运行后出现）')
    }
}

function Show-NodeSection {
    Write-Section '环境'

    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $cmd) {
        Write-Fail '  找不到 node 命令。计划任务的采集/网页都会失败（退出码 0x2）。'
    }
    else {
        $exe = [string]$cmd.Source
        if ($exe -eq '') { $exe = [string]$cmd.Path }

        $oldPref = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $rawLines = & $exe --version 2>&1
        $ErrorActionPreference = $oldPref

        $lines = Remove-BlankLine -Lines $rawLines
        $versionText = '无法解析'
        if ($lines.Count -gt 0) { $versionText = [string]$lines[0] }

        Write-Host ('  node       : ' + $versionText + '  (' + $exe + ')')
        if ($versionText -match '^v(\d+)\.(\d+)') {
            $major = [int]$Matches[1]
            $minor = [int]$Matches[2]
            if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
                Write-Fail '              └─ 版本过低：本项目需要 Node ≥ 22.5。'
            }
        }
    }

    if (Test-Admin) {
        Write-Host '  当前身份   : 管理员'
    }
    else {
        Write-Host '  当前身份   : 普通用户（查询他人注册的任务可能读不到「上次结果」）'
    }
}

#endregion

#region 入口

$repo = Resolve-RepoRoot -Override $RepoRoot
$config = Resolve-RepoConfigPath -Repo $repo -Override $ConfigPath
$scriptName = Get-ScriptDirName -FullPath $PSCommandPath

Write-Host ''
Write-Host '====== QQ 聊天记录归档系统 · Windows 状态 ======'

$registered = Show-TaskSection -CollectTask $TaskName -ServeTask $ServeTask

Show-EnvSection -Repo $repo -ConfigFullPath $config -LogDir (Get-ConfigLogDir -ConfigFullPath $config)

$logDir = Get-ConfigLogDir -ConfigFullPath $config
if ($logDir -eq '') { $logDir = Join-Path $repo 'data\logs' }

Write-Section '日志尾部'
Show-LogSection -LogDir $logDir -Pattern 'qq-archive-serve-*.log' -Label '网页服务（最新一份）' -Lines $TailLines
Show-LogSection -LogDir $logDir -Pattern 'qq-archive-collect-*.log' -Label '定时采集（最新一份）' -Lines $TailLines

Show-NodeSection

Write-Host ''
if ($registered -eq 2) {
    Write-Host '结论：两个计划任务都已注册。'
    exit 0
}
Write-Host ('结论：只有 ' + $registered + '/2 个任务已注册。请运行 install.ps1 安装，或用 -TaskName 指定正确的任务名。')
exit 1

#endregion
