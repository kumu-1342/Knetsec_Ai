#Requires -Version 5.1
<#
.SYNOPSIS
    Knetsec_Ai 启动脚本（Windows）。

.DESCRIPTION
    启动前检查：Node.js、依赖、.env、构建产物、端口占用；启动后等待 /health
    通过再提示访问地址。生产模式默认前台运行（Ctrl+C 停止），加 -Background
    可后台运行并写日志到 data\logs\；开发模式调用 npm run dev（server + Vite）。

.PARAMETER Mode
    prod（默认）= 生产模式，node apps/server/dist/index.js，server 托管面板；
    dev          = 开发模式，npm run dev（server:8787 + web:5173，热更新）。

.PARAMETER Port
    服务端口，默认 8787（可通过环境变量 KNETSEC_PORT 覆盖）。

.PARAMETER NoBrowser
    启动成功后不自动打开浏览器。

.PARAMETER Background
    生产模式下后台运行（隐藏窗口），日志写入 data\logs\server.stdout.log 与 server.stderr.log。

.PARAMETER Stop
    停止正在运行的实例（结束监听该端口的 node 进程）后退出。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\deploy\scripts\start.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\deploy\scripts\start.ps1 -Background
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\deploy\scripts\start.ps1 -Stop
#>
[CmdletBinding()]
param(
    [ValidateSet('prod', 'dev')]
    [string]$Mode = 'prod',
    [int]$Port = 8787,
    [switch]$NoBrowser,
    [switch]$Background,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

function Write-Step {
    param([string]$Message)
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

function Test-PortInUse {
    param([int]$PortNumber)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $PortNumber)
        $client.Close()
        return $true
    }
    catch {
        return $false
    }
}

function Stop-KnetsecOnPort {
    param([int]$PortNumber)
    $connections = Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue
    if (-not $connections) {
        Write-Warn "端口 $PortNumber 上没有正在监听的进程。"
        return
    }
    foreach ($connection in $connections) {
        $processId = $connection.OwningProcess
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($null -eq $process) { continue }
        if ($process.ProcessName -notmatch 'node') {
            Write-Warn "端口 $PortNumber 被非 Node 进程占用：$($process.ProcessName) (PID $processId)，已跳过。"
            continue
        }
        Stop-Process -Id $processId -Force
        Write-Ok "已停止进程 $($process.ProcessName) (PID $processId)"
    }
}

if ($Stop) {
    Write-Step "停止监听端口 $Port 的 Knetsec_Ai 进程"
    Stop-KnetsecOnPort -PortNumber $Port
    exit 0
}

if ($env:KNETSEC_PORT -and -not $PSBoundParameters.ContainsKey('Port')) {
    $parsedPort = 0
    if ([int]::TryParse($env:KNETSEC_PORT, [ref]$parsedPort)) {
        $Port = $parsedPort
    }
}

Write-Step "启动 Knetsec_Ai（模式：$Mode）"
Write-Host "    仓库根目录：$repoRoot" -ForegroundColor Gray

if (-not (Test-Path 'node_modules')) {
    Fail '未找到 node_modules，请先运行：npm install（或执行 deploy\scripts\install.ps1）'
}

if (-not (Test-Path '.env')) {
    Copy-Item '.env.example' '.env'
    Write-Warn '未找到 .env，已从 .env.example 生成（默认 admin / admin123）'
}

if (Test-PortInUse -PortNumber $Port) {
    Fail "端口 $Port 已被占用。可先执行：.\deploy\scripts\start.ps1 -Stop，或修改 KNETSEC_PORT。"
}

if ($Mode -eq 'prod') {
    if (-not (Test-Path 'apps\server\dist\index.js')) {
        Fail '未找到 apps\server\dist\index.js，请先执行：npm run build（或 install.ps1）'
    }
    if (-not (Test-Path 'apps\web\dist\index.html')) {
        Fail '未找到 apps\web\dist\index.html，请先执行：npm run build（面板由 server 托管）'
    }

    $env:NODE_ENV = 'production'
    $env:KNETSEC_PORT = "$Port"

    if (-not (Test-Path 'data\logs')) {
        New-Item -ItemType Directory -Path 'data\logs' -Force | Out-Null
    }

    $url = "http://127.0.0.1:$Port/"

    if ($Background) {
        $stdout = Join-Path $repoRoot 'data\logs\server.stdout.log'
        $stderr = Join-Path $repoRoot 'data\logs\server.stderr.log'
        $process = Start-Process -FilePath 'node' -ArgumentList 'apps/server/dist/index.js' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        Write-Ok "后台启动，PID = $($process.Id)"

        $healthy = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            if ($process.HasExited) { break }
            try {
                $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2
                if ($response.StatusCode -eq 200) { $healthy = $true; break }
            }
            catch {
                # 服务尚未就绪，继续等待
            }
        }

        if ($healthy) {
            Write-Ok "健康检查通过：$url"
        }
        else {
            Write-Warn "30 秒内未通过健康检查，请查看日志：$stderr"
        }

        Write-Host ''
        Write-Host "    访问地址：$url" -ForegroundColor Green
        Write-Host "    日志文件：$stdout" -ForegroundColor Gray
        Write-Host "    停止实例：powershell -ExecutionPolicy Bypass -File .\deploy\scripts\start.ps1 -Stop" -ForegroundColor Gray

        if (-not $NoBrowser -and $healthy) {
            Start-Process $url
        }
        exit 0
    }

    Write-Host ''
    Write-Host "    访问地址：$url（Ctrl+C 停止）" -ForegroundColor Green
    Write-Host '    默认账号：admin / admin123（登录后请立即修改）' -ForegroundColor Gray
    Write-Host ''

    if (-not $NoBrowser) {
        Start-Job -ScriptBlock {
            param([string]$TargetUrl)
            Start-Sleep -Seconds 4
            Start-Process $TargetUrl
        } -ArgumentList $url | Out-Null
    }

    & node 'apps/server/dist/index.js'
    exit $LASTEXITCODE
}

# 开发模式：Vite 5173 + Fastify 8787（scripts/dev.mjs 统一管理）
$env:KNETSEC_PORT = "$Port"
Write-Host ''
Write-Host "    开发地址：http://127.0.0.1:5173（/api 自动代理到 $Port）" -ForegroundColor Green
Write-Host '    停止：Ctrl+C' -ForegroundColor Gray
Write-Host ''

& npm run dev
exit $LASTEXITCODE
