<#
用法:
  # 默认：只移除计划任务，保留 config.json 与 data 目录（含数据库、媒体、备份）
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\uninstall.ps1

  # 连数据一起删除（**不可恢复**，会二次确认）
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\uninstall.ps1 -PurgeData

  # 只移除任务、不碰数据目录（等价于默认行为）
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\uninstall.ps1 -KeepData

参数:
  -TaskName      定时采集任务名，默认 QQArchive-Collect
  -ServeTaskName 网页服务任务名，默认 QQArchive-Serve
  -RepoRoot      仓库根目录，默认由 $PSScriptRoot 向上两层推导
  -PurgeData     删除 <仓库根>\data（会要求确认；配合 -Force 跳过确认）
  -KeepData      显式声明保留数据（与 -PurgeData 互斥，默认行为）
  -Force         配合 -PurgeData 时跳过交互确认（适合无人值守脚本）

说明:
  **本脚本不会动 config.json** —— 它含登录令牌，而且是用户自己复制修改过的文件，
  卸载器擅自删除风险太大。要删请自己确认后手动删。

  默认只删「本脚本管理的两个任务」。如果你把任务名改成过别的名字，请用 -TaskName /
  -ServeTaskName 传进来，否则会找不到（不会误删其他任务）。
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$TaskName = 'QQArchive-Collect',
    [string]$ServeTaskName = 'QQArchive-Serve',
    [switch]$PurgeData,
    [switch]$KeepData,
    [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

#region 通用小工具（各脚本各自复制一份，保持单文件可独立分发）

function Write-Step {
    param([string]$Message)
    Write-Host ("[uninstall] " + $Message)
}

function Write-Warn {
    param([string]$Message)
    Write-Host ("[uninstall][警告] " + $Message) -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host ("[uninstall][错误] " + $Message) -ForegroundColor Red
}

function Get-ScriptDirName {
    # 只是给下面的 throw 信息加一点上下文，避免消息里出现整条绝对路径。
    param([string]$FullPath)
    return [System.IO.Path]::GetFileName($FullPath)
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

    return @{
        Name  = $Name
        Task  = $task
        State = [string]$task.State
    }
}

function Show-TaskState {
    param([string]$Name)

    $state = Get-TaskState -Name $Name
    if ($null -eq $state) {
        Write-Host ('  ' + $Name + ' : 未注册')
        return
    }
    Write-Host ('  ' + $Name + ' : ' + $state.State)
}

function Remove-ManagedTasks {
    param([string]$Collect, [string]$Serve)

    $removed = 0
    Write-Step '移除计划任务...'

    foreach ($taskName in (Get-ManagedTaskNames -Collect $Collect -Serve $Serve)) {
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
            throw ('移除任务失败：' + $taskName + '：' + $_.Exception.Message +
                '（如果任务是别人用管理员身份注册的，请用管理员身份重跑本脚本。）')
        }
    }

    Write-Step ('共移除 ' + $removed + ' 个任务。')
}

#endregion

#region 数据清理

function Remove-ArchiveData {
    param([string]$Repo, [bool]$SkipConfirm)

    $dataDir = Join-Path $Repo 'data'

    if (-not (Test-Path -LiteralPath $dataDir -PathType Container)) {
        Write-Step ('数据目录不存在，无需清理：' + $dataDir)
        return
    }

    # 安全护栏：只允许删除「仓库根下的 data」这一层。多一道判断，
    # 避免以后有人把 $Repo 传错成一个危险路径时把别的东西删掉。
    $expectedParent = [System.IO.Path]::GetFullPath($Repo)
    $actualParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $dataDir))
    if ($actualParent -ne $expectedParent) {
        throw ('数据目录不在预期位置，拒绝删除：' + $dataDir)
    }

    $sizeMb = 0
    try {
        $bytes = (Get-ChildItem -LiteralPath $dataDir -Recurse -File -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum
        if ($null -ne $bytes) { $sizeMb = [math]::Round(($bytes / 1MB), 2) }
    }
    catch {
        $sizeMb = 0
    }

    Write-Warn ('即将**永久删除**数据目录：' + $dataDir + '（约 ' + $sizeMb + ' MB）')
    Write-Warn '里面包含归档数据库、媒体文件与全部备份，删除后无法恢复。'
    Write-Warn '建议先确认备份已复制到别处，或改用不带 -PurgeData 的方式卸载。'

    if (-not $SkipConfirm) {
        $answer = Read-Host '确认删除请输入 yes（其他任何输入都会取消）'
        if ($answer -ne 'yes') {
            Write-Step '已取消删除，数据保持不动。'
            return
        }
    }

    try {
        Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction Stop
        Write-Step ('已删除数据目录：' + $dataDir)
    }
    catch {
        throw ('删除数据目录失败：' + $dataDir + '：' + $_.Exception.Message +
            '（文件可能正被 node.exe 占用，请先确认没有残留进程。）')
    }
}

#endregion

#region 入口

$repo = Resolve-RepoRoot -Override $RepoRoot
$scriptName = Get-ScriptDirName -FullPath $PSCommandPath

if ($PurgeData -and $KeepData) {
    throw '参数冲突：-PurgeData 与 -KeepData 不能同时使用。请二选一。'
}

Write-Host ''
Write-Step ('仓库根目录：' + $repo)
Write-Host ''
Write-Host '当前任务状态：'
Show-TaskState -Name $TaskName
Show-TaskState -Name $ServeTaskName
Write-Host ''

if (-not (Test-Admin)) {
    Write-Warn '当前不是管理员。如果任务是以当前用户身份注册的，普通权限即可移除；'
    Write-Warn '如果是以 SYSTEM 注册的，请改用管理员身份重跑本脚本。'
}

Remove-ManagedTasks -Collect $TaskName -Serve $ServeTaskName

if ($PurgeData) {
    Write-Host ''
    Remove-ArchiveData -Repo $repo -SkipConfirm ([bool]$Force)
    exit 0
}

Write-Host ''
Write-Step '数据保留：'
Write-Step ('  ' + (Join-Path $repo 'data') + '   （数据库 / 媒体 / 备份）')
Write-Step ('  ' + (Join-Path $repo 'config.json') + '   （配置文件，本脚本不动它）')
Write-Step '如需彻底清理，重新运行并加上 -PurgeData。'
Write-Host ''
Write-Step '卸载完成。'

exit 0

#endregion
