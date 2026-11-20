#Requires -Version 5.1
<#
.SYNOPSIS
    Knetsec_Ai 一键安装脚本（Windows）。

.DESCRIPTION
    依次完成：环境检查（Node.js >= 22.5、npm）→ npm install → 生成 .env
    → 创建 data 运行期目录 → 构建 shared/server/web → 可选注册登录自启计划任务。
    脚本幂等，可重复执行：已存在的 .env 与目录不会覆盖。

.PARAMETER InstallDir
    仓库根目录，默认 D:\Knetsec_Ai。

.PARAMETER SkipBuild
    跳过构建（只安装依赖与准备目录），用于快速拉起开发模式。

.PARAMETER CreateScheduledTask
    注册"登录时自动启动"的计划任务（需要管理员权限，失败会给出替代方案）。

.PARAMETER TaskName
    计划任务名称，默认 Knetsec_Ai。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\deploy\scripts\install.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\deploy\scripts\install.ps1 -CreateScheduledTask
#>
[CmdletBinding()]
param(
    [string]$InstallDir = 'D:\Knetsec_Ai',
    [switch]$SkipBuild,
    [switch]$CreateScheduledTask,
    [string]$TaskName = 'Knetsec_Ai'
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "    [OK] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "    [注意] $Message" -ForegroundColor Yellow
}

function Fail {
    param([string]$Message)
    Write-Host "    [错误] $Message" -ForegroundColor Red
    exit 1
}

Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host ' Knetsec_Ai 安装程序（AI 安全 x 网络安全实时情报平台）' -ForegroundColor DarkCyan
Write-Host '============================================================' -ForegroundColor DarkCyan

Write-Step "检查安装目录：$InstallDir"
$packageJson = Join-Path $InstallDir 'package.json'
if (-not (Test-Path $packageJson)) {
    Fail "找不到 $packageJson，请确认仓库路径（可通过 -InstallDir 指定）。"
}
Set-Location $InstallDir
Write-Ok '仓库根目录存在'

Write-Step '检查 Node.js 与 npm'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Fail '未检测到 Node.js。请先安装 Node.js 24 LTS：https://nodejs.org/zh-cn'
}
$nodeVersion = (& node -v).Trim()
if ($LASTEXITCODE -ne 0) {
    Fail '执行 node -v 失败。'
}
$majorText = $nodeVersion.TrimStart('v').Split('.')[0]
$nodeMajor = 0
[void][int]::TryParse($majorText, [ref]$nodeMajor)
if ($nodeMajor -lt 22) {
    Fail "当前 Node.js 版本为 $nodeVersion，需要 >= 22.5（推荐 24 LTS）。"
}
$npmVersion = (& npm -v).Trim()
if ($LASTEXITCODE -ne 0) {
    Fail '执行 npm -v 失败。'
}
Write-Ok "Node.js $nodeVersion / npm $npmVersion"

Write-Step '安装依赖（npm install，首次约 1-3 分钟）'
& npm install
if ($LASTEXITCODE -ne 0) {
    Fail 'npm install 失败。请检查网络，或配置镜像：npm config set registry https://registry.npmmirror.com'
}
Write-Ok '依赖安装完成'

Write-Step '准备 .env 与运行期目录'
if (-not (Test-Path '.env')) {
    Copy-Item '.env.example' '.env'
    Write-Ok '已从 .env.example 生成 .env（默认管理员 admin / admin123，请首次登录后立即修改）'
}
else {
    Write-Warn '.env 已存在，保留现有配置'
}
foreach ($dir in @('data', 'data\reports', 'data\logs')) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}
Write-Ok '数据目录 data\、data\reports\、data\logs\ 就绪'

if (-not $SkipBuild) {
    Write-Step '构建 shared + server + web（npm run build）'
    & npm run build
    if ($LASTEXITCODE -ne 0) {
        Fail '构建失败，请查看上方 TypeScript 报错。'
    }
    Write-Ok '构建产物：packages\shared\dist、apps\server\dist、apps\web\dist'
}
else {
    Write-Warn '已跳过构建（-SkipBuild），生产模式启动前仍需执行 npm run build'
}

if ($CreateScheduledTask) {
    Write-Step "注册登录自启计划任务：$TaskName"
    $scriptPath = Join-Path $PSScriptRoot 'start.ps1'
    if (-not (Test-Path $scriptPath)) {
        Fail "找不到启动脚本 $scriptPath"
    }
    try {
        $argument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $scriptPath + '" -NoBrowser'
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Knetsec_Ai 情报平台登录自启' -Force | Out-Null
        Write-Ok "计划任务已注册（taskschd.msc 可查看；卸载：Unregister-ScheduledTask -TaskName $TaskName -Confirm:0）"
    }
    catch {
        Write-Warn "注册计划任务失败（通常需要以管理员身份运行）：$($_.Exception.Message)"
        Write-Warn '替代方案：任务计划程序手动创建，或使用 NSSM，详见 deploy\README.md'
    }
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host ' 安装完成。下一步：' -ForegroundColor Green
Write-Host '   1) 开发模式：npm run dev' -ForegroundColor Gray
Write-Host '   2) 生产模式：powershell -ExecutionPolicy Bypass -File .\deploy\scripts\start.ps1' -ForegroundColor Gray
Write-Host '   3) 访问地址：生产 http://127.0.0.1:8787 ／ 开发 http://127.0.0.1:5173' -ForegroundColor Gray
Write-Host '   4) 默认账号：admin / admin123（登录后立即修改）' -ForegroundColor Gray
Write-Host '============================================================' -ForegroundColor DarkCyan
