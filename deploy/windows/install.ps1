<#
用法:
  # 默认：注册「当前用户」的计划任务，**不需要管理员权限**
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install.ps1

  # 查看状态 / 卸载
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install.ps1 -Action Status
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install.ps1 -Action Uninstall

  # 以 SYSTEM 身份运行（需管理员；注销后仍持续采集，但看不到映射的网络驱动器）
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install.ps1 -Action Install -RunAsSystem

参数:
  -Action       Install（默认）| Uninstall | Status
  -ConfigPath   配置文件路径，默认 <仓库根>\config.json
  -RepoRoot     仓库根目录，默认由 $PSScriptRoot 向上两层推导
  -InstallPath  计划任务的「起始位置」，默认等于 -RepoRoot
  -TaskName     定时采集任务名，默认 QQArchive-Collect
  -ServeTaskName 网页服务任务名，默认 QQArchive-Serve
  -CollectIntervalMinutes 采集间隔分钟数，默认 15
  -MinNodeMajor 要求的 Node 主版本，默认 22（同时要求 ≥ 22.5）
  -KeepCollectLogs / -KeepServeLogs 日志保留份数
  -RunAsSystem  以 SYSTEM 身份注册任务（需管理员）

说明:
  本脚本只用 Windows 自带的任务计划程序（ScheduledTasks 模块，Windows 8 / Server 2012
  起随系统提供），**不依赖 NSSM**、不下载任何东西、不写入注册表服务项。
  幂等：重复执行会先注销同名任务再重建，并保留已有 config.json 与数据目录。
#>
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Uninstall', 'Status')]
    [string]$Action = 'Install',
    [string]$ConfigPath = '',
    [string]$RepoRoot = '',
    [string]$InstallPath = '',
    [string]$TaskName = 'QQArchive-Collect',
    [string]$ServeTaskName = 'QQArchive-Serve',
    [int]$CollectIntervalMinutes = 15,
    [int]$MinNodeMajor = 22,
    [int]$KeepCollectLogs = 30,
    [int]$KeepServeLogs = 8,
    [switch]$RunAsSystem
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:MinNodeMinor = 5   # Node 22.5 起才有 node:sqlite，低于它跑不起来。

#region 通用小工具（各脚本各自复制一份，保持单文件可独立分发）

function Write-Step {
    param([string]$Message)
    Write-Host ("[install] " + $Message)
}

function Write-Warn {
    param([string]$Message)
    Write-Host ("[install][警告] " + $Message) -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host ("[install][错误] " + $Message) -ForegroundColor Red
}

function Get-ScriptDirName {
    # 只是给下面的 throw 信息加一点上下文，避免消息里出现整条绝对路径。
    param([string]$FullPath)
    return [System.IO.Path]::GetFileName($FullPath)
}

function Remove-BlankLine {
    # 过滤掉外部程序的空行并 trim，便于后续用正则解析版本号。
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
    # 只用于「提示」和「RunAsSystem 的前提检查」，不作为安装的前置条件。
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

function Resolve-AbsolutePath {
    # 把可能是相对路径的输入按「相对于给定基准目录」解析成绝对路径。
    # 计划任务的动作里存的是绝对路径，所以任何进入任务的路径都要先过这一道。
    param([string]$Path, [string]$Base, [string]$Label)

    if ($Path -eq '') { return $Path }

    try {
        if ([System.IO.Path]::IsPathRooted($Path)) {
            return [System.IO.Path]::GetFullPath($Path)
        }
        return [System.IO.Path]::GetFullPath((Join-Path $Base $Path))
    }
    catch {
        throw ($Label + " 路径无法解析：" + $Path)
    }
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

#region Node 检测

function Test-NodeVersion {
    <#
    返回 @{ Version = 'v24.21.0'; Major = 24; Minor = 21; Exe = 'C:\...\node.exe' }。
    不满足最低版本时 throw —— 让安装直接失败，比装完才发现跑不起来好。
    #>
    param([int]$RequiredMajor, [int]$RequiredMinor)

    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $cmd) {
        throw ('找不到 node 命令。请先安装 Node.js ' + $RequiredMajor + '.' + $RequiredMinor + ' 或更高版本（https://nodejs.org/），然后重开一个终端。')
    }

    $exe = [string]$cmd.Source
    if ($exe -eq '') { $exe = [string]$cmd.Path }
    if ($exe -eq '') {
        throw '找到了 node 命令，但无法解析它的可执行文件路径。请检查 PATH 后重试。'
    }

    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $rawLines = & $exe --version 2>&1
    $ErrorActionPreference = $oldPref

    $lines = Remove-BlankLine -Lines $rawLines
    if ($lines.Count -eq 0) {
        throw ('`node --version` 没有输出，无法判断版本。请手动运行 `node --version` 排查。')
    }

    $versionText = [string]$lines[0]
    if ($versionText -notmatch '^v(\d+)\.(\d+)\.(\d+)') {
        throw ('无法解析 Node 版本号（`node --version` 输出：「' + $versionText + '」）。')
    }

    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    $patch = [int]$Matches[3]

    if ($major -lt $RequiredMajor -or ($major -eq $RequiredMajor -and $minor -lt $RequiredMinor)) {
        throw ('Node 版本过低：当前 ' + $versionText + '，需要 v' + $RequiredMajor + '.' + $RequiredMinor + ' 或更高。' +
            '（本项目用 node:sqlite 与 TypeScript 类型剥离，低版本无法运行。）')
    }

    return @{
        Version = $versionText
        Major   = $major
        Minor   = $minor
        Patch   = $patch
        Exe     = $exe
    }
}

#endregion

#region 命令构造

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

function New-NodeAction {
    # 返回一个 ScheduledTasks 的 Execute 动作，直接用 node.exe 启动 CLI，
    # 不经过 bash / shim，这样「上次运行结果」就是 node 的真实退出码。
    param([string]$NodeExe, [string]$Entry, [string[]]$Arguments, [string]$WorkDir)

    $argList = New-NodeArgumentList -Entry $Entry -Arguments $Arguments
    return (New-ScheduledTaskAction -Execute $NodeExe -Argument $argList -WorkingDirectory $WorkDir)
}

function New-PowerShellAction {
    # 包装脚本用 powershell.exe -File 启动；-ExecutionPolicy Bypass 是必须的：
    # 默认策略 Restricted 会让「从网上下载的脚本」直接拒绝执行，且不会有友好提示。
    param([string]$WrapperPath, [string[]]$Arguments, [string]$WorkDir)

    $argList = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $WrapperPath + '"'
    foreach ($item in @($Arguments)) {
        if ($null -eq $item -or [string]$item -eq '') { continue }
        $argList = $argList + ' ' + (ConvertTo-ArgToken ([string]$item))
    }
    return (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argList -WorkingDirectory $WorkDir)
}

#endregion

#region 计划任务

function Get-ManagedTaskNames {
    param([string]$Collect, [string]$Serve)

    return @($Collect, $Serve) | Where-Object { $_ -ne '' -and $null -ne $_ }
}

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
        Name    = $Name
        Task    = $task
        Info    = $info
        State   = [string]$task.State
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

function Show-TaskState {
    param([string]$Name)

    $state = Get-TaskState -Name $Name
    if ($null -eq $state) {
        Write-Host ('  ' + $Name + ' : 未注册')
        return $false
    }

    Write-Host ('  ' + $Name + ' : ' + $state.State)
    if ($null -ne $state.Info) {
        Write-Host ('    上次运行 : ' + [string]$state.Info.LastRunTime)
        Write-Host ('    上次结果 : ' + (Get-RunResultText -Code $state.Info.LastTaskResult))
        Write-Host ('    下次运行 : ' + [string]$state.Info.NextRunTime)
    }
    return $true
}

function Register-CollectTask {
    param(
        [string]$Name,
        [string]$WrapperPath,
        [string]$WorkDir,
        [string]$ConfigFullPath,
        [int]$IntervalMinutes,
        [int]$KeepLogs
    )

    $taskArgs = @('-ConfigPath', $ConfigFullPath, '-KeepLogs', [string]$KeepLogs)
    $action = New-PowerShellAction -WrapperPath $WrapperPath -Arguments $taskArgs -WorkDir $WorkDir

    # 任务计划程序的最小重复间隔是 1 分钟；用 RepetitionInterval 表达「每 N 分钟」。
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

    # 「失败后重启」在 Task Scheduler 里是 RestartCount / RestartInterval，
    # 不对应任何 ErrorAction。注意 -RestartCount 只在 Windows 8+ 的 cmdlet 上存在。
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)

    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings `
        -Description 'QQ 聊天记录归档系统：每 N 分钟运行一次 qq-archive collect --once' -Force | Out-Null

    Write-Step ('已注册定时采集任务：' + $Name + '（每 ' + $IntervalMinutes + ' 分钟）')
}

function Register-ServeTask {
    param(
        [string]$Name,
        [string]$WrapperPath,
        [string]$WorkDir,
        [string]$ConfigFullPath,
        [int]$KeepLogs
    )

    $taskArgs = @('-ConfigPath', $ConfigFullPath, '-KeepLogs', [string]$KeepLogs)
    $action = New-PowerShellAction -WrapperPath $WrapperPath -Arguments $taskArgs -WorkDir $WorkDir

    # 登录时启动：serve 常驻，注销后随之结束（见 README 的「后台作业在注销时会停止」）。
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $trigger.Delay = 'PT30S'

    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit ([TimeSpan]::Zero)

    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings `
        -Description 'QQ 聊天记录归档系统：登录时启动 qq-archive serve（网页 + API）' -Force | Out-Null

    Write-Step ('已注册网页服务任务：' + $Name + '（登录时启动）')
}

#endregion

#region 动作实现

function Invoke-Status {
    param([string]$Repo, [string]$CollectTask, [string]$ServeTask, [string]$ConfigFullPath)

    Write-Host ''
    Write-Host '== QQ 归档系统（Windows）状态 =='
    Write-Host ''

    Write-Host '计划任务：'
    $collectOk = Show-TaskState -Name $CollectTask
    $serveOk = Show-TaskState -Name $ServeTask

    Write-Host ''
    Write-Host '配置：'
    if (Test-Path -LiteralPath $ConfigFullPath -PathType Leaf) {
        Write-Host ('  存在 : ' + $ConfigFullPath)
    }
    else {
        Write-Host ('  缺失 : ' + $ConfigFullPath)
    }

    $wrapper = Join-Path $Repo 'deploy\windows\status.ps1'
    if (Test-Path -LiteralPath $wrapper -PathType Leaf) {
        Write-Host ''
        Write-Host '（详细状态与日志尾部请运行 deploy\windows\status.ps1）'
    }

    Write-Host ''
    if ($collectOk -and $serveOk) { return 0 }
    return 1
}

function Invoke-Install {
    param(
        [string]$Repo,
        [string]$ConfigFullPath,
        [string]$WorkDir,
        [string]$CollectTask,
        [string]$ServeTask,
        [int]$IntervalMinutes,
        [int]$KeepCollectLogs,
        [int]$KeepServeLogs,
        [bool]$AsSystem
    )

    $isAdmin = Test-Admin
    if ($AsSystem -and -not $isAdmin) {
        throw '以 SYSTEM 身份注册任务需要管理员权限。请用「以管理员身份运行」打开 PowerShell 后重试，或去掉 -RunAsSystem。'
    }

    # 1) 工作目录与包装脚本
    if (-not (Test-Path -LiteralPath $WorkDir -PathType Container)) {
        throw ('工作目录不存在：' + $WorkDir + '。计划任务的工作目录必须是真实存在的路径。')
    }

    $wrapperCollect = Join-Path $Repo 'deploy\windows\run-collect.ps1'
    $wrapperServe = Join-Path $Repo 'deploy\windows\run-serve.ps1'
    foreach ($w in @($wrapperCollect, $wrapperServe)) {
        if (-not (Test-Path -LiteralPath $w -PathType Leaf)) {
            throw ('缺少包装脚本：' + $w + '。请确认 deploy\windows 目录完整。')
        }
    }

    # 2) Node 版本（不满足直接 throw，不留下半套安装）
    $node = Test-NodeVersion -RequiredMajor $MinNodeMajor -RequiredMinor $script:MinNodeMinor
    Write-Step ('Node ' + $node.Version + '  (' + $node.Exe + ')')

    # 3) 目录
    $dataDir = Join-Path $Repo 'data'
    Ensure-Directory -Path $dataDir -Label '数据'
    Ensure-Directory -Path (Join-Path $dataDir 'logs') -Label '日志'
    Ensure-Directory -Path (Join-Path $dataDir 'backups') -Label '备份'
    Ensure-Directory -Path (Join-Path $dataDir 'media') -Label '媒体'

    # 4) 配置文件
    if (Test-Path -LiteralPath $ConfigFullPath -PathType Leaf) {
        Write-Step ('配置文件已存在，保留不动：' + $ConfigFullPath)
    }
    else {
        $example = Join-Path $Repo 'config.example.json'
        if (-not (Test-Path -LiteralPath $example -PathType Leaf)) {
            throw ('找不到示例配置：' + $example + '。请在仓库根目录运行本脚本。')
        }
        Copy-Item -LiteralPath $example -Destination $ConfigFullPath -Force
        Write-Step ('已从 config.example.json 生成：' + $ConfigFullPath)
        Write-Step '首次运行时会自动生成登录令牌并写回该文件（用 `qq-archive token` 查看）。'
        Write-Warn 'config.json 含登录令牌。建议右键 → 属性 → 安全里把继承关掉，只保留你自己的账户。'
    }

    # 5) 采集是否需要提示：kind=none 时任务会以退出码 2 结束，这是正常状态不是故障。
    $collectorKind = ''
    try {
        $cfgObj = (Get-Content -LiteralPath $ConfigFullPath -Raw -Encoding UTF8) | ConvertFrom-Json
        if ($null -ne $cfgObj -and $null -ne $cfgObj.collector) {
            $collectorKind = [string]$cfgObj.collector.kind
        }
    }
    catch {
        Write-Warn ('配置文件不是合法 JSON，无法读取 collector.kind：' + $_.Exception.Message)
    }

    if ($collectorKind -ne 'onebot') {
        Write-Warn 'collector.kind 不是 "onebot"：定时采集任务会以退出码 2 结束（采集未启用）。'
        Write-Warn '这是正常状态。要真正开始采集，请编辑配置后重跑本脚本，或直接跑一次 run-collect.ps1 验证。'
    }

    # 6) 注册任务（先注销旧的，保证幂等）
    Write-Step '注册计划任务（同名旧任务会先被移除）...'
    foreach ($taskName in (Get-ManagedTaskNames -Collect $CollectTask -Serve $ServeTask)) {
        if ($null -ne (Get-TaskState -Name $taskName)) {
            try {
                Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
                Write-Step ('已移除旧任务：' + $taskName)
            }
            catch {
                throw ('无法移除旧任务 ' + $taskName + '：' + $_.Exception.Message)
            }
        }
    }

    Register-CollectTask -Name $CollectTask -WrapperPath $wrapperCollect -WorkDir $WorkDir `
        -ConfigFullPath $ConfigFullPath -IntervalMinutes $IntervalMinutes -KeepLogs $KeepCollectLogs

    Register-ServeTask -Name $ServeTask -WrapperPath $wrapperServe -WorkDir $WorkDir `
        -ConfigFullPath $ConfigFullPath -KeepLogs $KeepServeLogs

    # 7) 立即跑一次 collect，让用户马上看到结果（也验证 Node 路径与配置没问题）。
    Write-Step '立即运行一轮采集以验证安装...'
    $dryArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $wrapperCollect, '-ConfigPath', $ConfigFullPath)
    try {
        $dryExit = (Start-Process -FilePath 'powershell.exe' -ArgumentList $dryArgs -WorkingDirectory $WorkDir `
            -NoNewWindow -Wait -PassThru).ExitCode
        if ($dryExit -eq 0) {
            Write-Step '首轮采集成功。'
        }
        elseif ($dryExit -eq 2) {
            Write-Step '验收通过：采集未启用（退出码 2），任务本身工作正常。'
        }
        elseif ($dryExit -eq 3) {
            Write-Warn '采集端不可达（退出码 3）。这是采集端没启动或配置不对，安装本身是成功的。'
        }
        else {
            Write-Warn ('首轮采集退出码 ' + $dryExit + '，请查看 data\logs 下最新日志。')
        }
    }
    catch {
        Write-Warn ('无法立即运行一轮采集：' + $_.Exception.Message)
    }

    # 8) 汇总
    $logDir = Get-ConfigLogDir -ConfigFullPath $ConfigFullPath
    if ($logDir -eq '') { $logDir = Join-Path $Repo 'data\logs' }

    Write-Host ''
    Write-Host '== 安装完成 =='
    Write-Host ('  仓库根目录   : ' + $Repo)
    Write-Host ('  配置文件     : ' + $ConfigFullPath)
    Write-Host ('  数据目录     : ' + (Join-Path $Repo 'data'))
    Write-Host ('  日志目录     : ' + $logDir)
    Write-Host ('  采集任务     : ' + $CollectTask + '（每 ' + $IntervalMinutes + ' 分钟）')
    Write-Host ('  网页任务     : ' + $ServeTask + '（登录时启动）')
    if ($AsSystem) {
        Write-Host '  运行身份     : SYSTEM（需管理员；映射的网络驱动器不可见）'
    }
    else {
        Write-Host '  运行身份     : 当前用户'
    }
    Write-Host ''
    Write-Host '下一步：'
    Write-Host '  1) 查看状态          powershell -ExecutionPolicy Bypass -File deploy\windows\status.ps1'
    Write-Host '  2) 立即跑一轮采集    powershell -ExecutionPolicy Bypass -File deploy\windows\run-collect.ps1'
    Write-Host '  3) 打开网页          http://127.0.0.1:8787/ （令牌用 `node bin\qq-archive.mjs token` 查看）'
    Write-Host '  4) 卸载              powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -Action Uninstall'
    Write-Host ''
    return 0
}

function Invoke-Uninstall {
    param([string]$CollectTask, [string]$ServeTask)

    Write-Step '开始卸载（默认保留数据目录）...'

    $removed = 0
    foreach ($taskName in (Get-ManagedTaskNames -Collect $CollectTask -Serve $ServeTask)) {
        $state = Get-TaskState -Name $taskName
        if ($null -eq $state) {
            Write-Step ('未找到任务，跳过：' + $taskName)
            continue
        }

        if ($state.State -eq 'Running') {
            try {
                Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
                Write-Step ('已停止正在运行的任务：' + $taskName)
            }
            catch {
                Write-Warn ('停止任务失败（继续卸载）：' + $taskName + '：' + $_.Exception.Message)
            }
        }

        try {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
            Write-Step ('已移除任务：' + $taskName)
            $removed++
        }
        catch {
            throw ('移除任务失败：' + $taskName + '：' + $_.Exception.Message)
        }
    }

    Write-Step ('卸载完成，共移除 ' + $removed + ' 个任务。数据目录与 config.json 已保留。')
    return 0
}

#endregion

#region 入口

$repo = Resolve-RepoRoot -Override $RepoRoot
$scriptName = Get-ScriptDirName -FullPath $PSCommandPath

if ($Action -eq 'Status') {
    $statusConfig = Resolve-RepoConfigPath -Repo $repo -Override $ConfigPath
    exit (Invoke-Status -Repo $repo -CollectTask $TaskName -ServeTask $ServeTaskName -ConfigFullPath $statusConfig)
}

if ($Action -eq 'Uninstall') {
    exit (Invoke-Uninstall -CollectTask $TaskName -ServeTask $ServeTaskName)
}

# ---- Install ----
if ($TaskName -eq $ServeTaskName) {
    throw ('定时采集任务名与网页服务任务名相同（都是 ' + $TaskName + '）。请用 -ServeTaskName 区分，否则两个任务会互相覆盖。')
}
if ($CollectIntervalMinutes -lt 1) {
    throw ('采集间隔必须 ≥ 1 分钟（收到 ' + $CollectIntervalMinutes + '）。')
}

if ($InstallPath -eq '') {
    $workDir = $repo
}
else {
    $workDir = Resolve-AbsolutePath -Path $InstallPath -Base $repo -Label 'InstallPath'
}

$installConfig = Resolve-RepoConfigPath -Repo $repo -Override $ConfigPath
$installConfig = Resolve-AbsolutePath -Path $installConfig -Base $repo -Label 'ConfigPath'

if (-not (Test-Admin)) {
    Write-Warn '当前不是管理员。注册「当前用户」的计划任务不需要管理员权限，将继续执行。'
}

Write-Host ''
Write-Step ('仓库根目录：' + $repo)
Write-Step ('工作目录  ：' + $workDir)
Write-Step ('配置文件  ：' + $installConfig)

$code = Invoke-Install -Repo $repo -ConfigFullPath $installConfig -WorkDir $workDir `
    -CollectTask $TaskName -ServeTask $ServeTaskName -IntervalMinutes $CollectIntervalMinutes `
    -KeepCollectLogs $KeepCollectLogs -KeepServeLogs $KeepServeLogs -AsSystem ([bool]$RunAsSystem)

exit $code

#endregion
