# 10 · GitHub 发布过程记录与仓库运维指南

> 项目：Knetsec_Ai　发布仓库：https://github.com/kumu-1342/Knetsec_Ai
> 账号：kumu-1342　可见性：Public　默认分支：master　发布日期：2026-11-20 23:00（Asia/Shanghai）
> 本文记录本次从「本地仓库」到「GitHub 公开仓库」的完整操作过程、遇到的三类真实问题与处理方式，以及后续仓库运维命令，供复现与交接使用。

---

## 1. 发布结果速览

| 项 | 结果 |
|---|---|
| 仓库地址 | https://github.com/kumu-1342/Knetsec_Ai |
| 可见性 | Public（公开） |
| 默认分支 | master（本地 master 跟踪 origin/master） |
| 提交数 | 14（历史作者已统一为 kumu-1342） |
| 文件数 | 156 个受版本控制文件，约 2.1 MB（不含 node_modules / data） |
| 仓库描述 | Knetsec_Ai ｜ AI 安全 × 网络安全实时情报平台：多源采集、自动去重打标、自动周报、Vue3 管理面板 |
| Topics | ai-security、cybersecurity、threat-intelligence、vulnerability-management、ai-security-tools、fastify、vue3、typescript、sqlite、security-intelligence |
| CI | GitHub Actions `CI`（job `ci`），最近运行 #45036961498 成功，用时 54s |
| 分支保护 | master：Required check `ci`（strict）、禁止强推/删除、需解决会话；管理员可绕过（单人维护） |
| 最近提交 | `71e9898 ci: 升级 checkout/setup-node 到 v7，消除 Node 20 弃用告警` |

---

## 2. 发布前检查

### 2.1 本地仓库状态

| 检查项 | 命令 | 结果 |
|---|---|---|
| 分支与最新提交 | `git branch -vv` | master，8 个提交，工作区干净 |
| 远程配置 | `git remote -v` | 发布前无 remote（纯本地仓库） |
| 提交作者 | `git log --format='%an <%ae>'` | 全部为 `Knetsec <knetsec@local>`（开发期占位身份） |

### 2.2 敏感信息审计（公开仓库必做）

发布前对全部受控文件做了四类检查，确认可以公开：

| 检查 | 结果 |
|---|---|
| 是否跟踪 `.env` | 未跟踪（`.gitignore` 已忽略） |
| 是否跟踪 `data/`（数据库/报告/日志/JWT 密钥） | 未跟踪 |
| 是否跟踪 `node_modules/`、`dist/` | 未跟踪 |
| 是否含真实 Token / 密钥 | 仅文档示例占位符 `ghp_xxxxxxxxxxxxxxxxxxxx`，无真实凭据 |

> 结论：仓库可安全公开。数据库、运行日志、`.env`、Playwright 缓存等均不进入版本库。

### 2.3 工具与网络

| 检查 | 结果 | 处理 |
|---|---|---|
| GitHub CLI | 未安装 | 使用 winget 安装 `GitHub.cli` 2.105.0 |
| 本机 Git 凭据 | 无 credential helper、无 SSH Key、无 Token 环境变量 | 走 gh 设备码授权 |
| `api.github.com` 直连 | 稳定（200，约 0.4s） | 可用于 API 操作 |
| `github.com` 直连 | 间歇超时 / TLS handshake timeout | 改走本机 Clash 代理 `127.0.0.1:7897` |
| 代理可用性 | `curl -x http://127.0.0.1:7897 https://github.com` → 200 | 用于 gh 授权与 git push |

---

## 3. 安装 GitHub CLI

```powershell
winget install --id GitHub.cli --exact --source winget `
  --accept-source-agreements --accept-package-agreements --silent

# 安装位置
C:\Program Files\GitHub CLI\gh.exe
gh --version   # gh version 2.105.0 (2026-11-17)
```

> 安装后当前 PowerShell 会话的 PATH 可能尚未刷新，因此后续命令统一使用 gh 的绝对路径，避免「命令找不到」。

---

## 4. 授权：本次发布最曲折的一步

### 4.1 尝试一：直连设备码登录（失败）

```powershell
& 'C:\Program Files\GitHub CLI\gh.exe' auth login `
  --hostname github.com --git-protocol https --web
```

输出一次性代码并打开浏览器，但随后报错：

```text
failed to authenticate via web browser: Post "https://github.com/login/device/code": net/http: TLS handshake timeout
```

**原因**：本机网络（移动热点出口）到 `github.com` 直连不稳定，而 `api.github.com` 正常，说明是域名/线路层面的可达性问题，不是账号或 CLI 问题。

### 4.2 定位代理

```powershell
# 发现 Clash Verge 正在运行，监听 127.0.0.1:7897（mixed 端口）
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq 7897 }

# 验证代理可用
curl.exe -x http://127.0.0.1:7897 -sS -o NUL -w "%{http_code}" https://github.com
# => 200

# 验证 git 走代理可用
git -c http.proxy=http://127.0.0.1:7897 ls-remote --heads https://github.com/git/git.git
```

### 4.3 尝试二、三：带代理的设备码登录（仍有波折）

设置 `HTTPS_PROXY` / `HTTP_PROXY` 后重新发起登录，设备码阶段正常，但 OAuth Token 交换阶段仍偶发：

```text
failed to authenticate via web browser: Post "https://github.com/login/oauth/access_token": unexpected EOF
```

处理措施：

1. 临时开启 Windows 系统代理（让浏览器也能访问 GitHub 授权页）：

```powershell
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
# 记录原值：ProxyEnable=0
Set-ItemProperty $key -Name ProxyEnable -Value 1
Set-ItemProperty $key -Name ProxyServer -Value '127.0.0.1:7897'
Set-ItemProperty $key -Name ProxyOverride -Value '<local>'
```

2. 保持 `HTTPS_PROXY=http://127.0.0.1:7897` 重新执行 `gh auth login --web`；
3. 在浏览器打开 https://github.com/login/device ，输入一次性代码并 Authorize。

最终成功：

```text
✓ Authentication complete.
✓ Logged in as kumu-1342
# 凭据保存在 Windows 凭据管理器（keyring），不落明文文件
```

> 经验：设备码本身只负责「证明你是谁」，真正的 Token 交换是另一次 HTTPS 请求；两者都可能受网络影响。遇到 `TLS handshake timeout` / `unexpected EOF` 时，优先怀疑网络线路并引入代理，而不是重复点授权。

---

## 5. 统一 Git 身份与历史重写

发布前的 8 个提交作者是占位身份 `Knetsec <knetsec@local>`，公开后不会关联到 GitHub 账号。发布时统一为账号的 noreply 邮箱：

```powershell
$u = gh api user | ConvertFrom-Json
$name  = if ($u.name) { $u.name } else { $u.login }
$email = "$($u.id)+$($u.login)@users.noreply.github.com"

git config user.name  $name
git config user.email $email

# 备份当前历史后，逐提交重置作者（不改变文件内容）
git branch -f backup-pre-rewrite HEAD
git rebase --root --exec "git commit --amend --no-edit --reset-author"

# 校验：文件树必须与备份完全一致
git diff --stat backup-pre-rewrite HEAD    # 空输出 = 内容零变化
```

| 项 | 结果 |
|---|---|
| 作者 | 8 个提交全部变为 `kumu-1342 <255930430+kumu-1342@users.noreply.github.com>` |
| 文件内容 | 与重写前完全一致（diff 为空） |
| 提交哈希 | 因作者变更而变化（最新提交 `08d6b08` → `9378312`） |
| 备份分支 | 推送验证成功后删除 |

---

## 6. 创建仓库并推送

```powershell
cd D:\Knetsec_Ai
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'

gh repo create Knetsec_Ai --public --source=. --remote=origin --push `
  --description "Knetsec_Ai ｜ AI 安全 × 网络安全实时情报平台：多源采集、自动去重打标、自动周报、Vue3 管理面板"
```

输出：

```text
https://github.com/kumu-1342/Knetsec_Ai
branch 'master' set up to track 'origin/master'.
 * [new branch]      HEAD -> master
```

该命令一次完成三件事：通过 API 创建公开仓库、添加 `origin` 远程、推送当前分支并建立跟踪关系。

---

## 7. 仓库元数据与验证

```powershell
# 补充 Topics（便于被发现）
gh repo edit --add-topic ai-security,cybersecurity,threat-intelligence,`
  vulnerability-management,ai-security-tools,fastify,vue3,typescript,sqlite,security-intelligence

# 查看仓库信息
gh repo view --json name,owner,url,visibility,defaultBranchRef,description,createdAt
```

验证结果：

| 验证项 | 结果 |
|---|---|
| 仓库可访问 | https://github.com/kumu-1342/Knetsec_Ai（HTTP 200） |
| 可见性 | PUBLIC |
| 默认分支 | master |
| 远程地址 | https://github.com/kumu-1342/Knetsec_Ai.git |
| 远程分支 | `refs/heads/master` = `9378312698f85a46515d47159ee6cc79f5390d0f`（与本地一致） |
| 工作区 | `git status` 干净 |

---

## 8. 发布后收尾

| 事项 | 处理 |
|---|---|
| 临时系统代理 | 发布完成后恢复为原值 `ProxyEnable=0`（不改变用户日常网络设置） |
| 备份分支 `backup-pre-rewrite` | 推送验证通过后删除 |
| GitHub 凭据 | 存于 Windows 凭据管理器（gh keyring），不在仓库中 |
| 敏感文件 | 全程未提交 `.env`、`data/`、`node_modules/` |

---

## 9. 日常协作与运维命令

```powershell
# 克隆到新机器
git clone https://github.com/kumu-1342/Knetsec_Ai.git

# 日常提交与推送（本机已配置 gh 凭据）
git add -A
git commit -m "feat: 描述"
git push

# 拉取远端更新
git pull --rebase

# 查看仓库状态 / 打开网页
gh repo view --web

# 新增协作者
gh api -X PUT repos/kumu-1342/Knetsec_Ai/collaborators/<用户名> -f permission=push

# 改为私有（如需）
gh repo edit --visibility private
```

### 9.1 已落地的仓库设置（2026-11-22 补充）

| 项 | 状态 | 说明 |
|---|---|---|
| MIT License | ✅ 已添加 | `LICENSE`，README 许可证章节已同步 |
| CI 工作流 | ✅ 已启用 | `.github/workflows/ci.yml`：`npm ci → typecheck → lint → test → build`；运行 #45036961498 成功（54s） |
| Dependabot | ✅ 已启用 | 每周一检查 npm 依赖，已自动开出 5 个 PR（含 4 个主版本升级，建议人工评估） |
| Dependabot 安全告警 | ✅ 已启用 | 公开仓库依赖漏洞告警 |
| master 分支保护 | ✅ 已启用 | Required status check = `ci`（strict）、禁止强推、禁止删除分支、要求解决会话；`enforce_admins=false` 保证单人维护可直接推送 |
| 安全扫描 | ✅ 默认开启 | 公开仓库自动启用 secret scanning（GitHub 免费能力） |

> 说明：分支保护开启了 `ci` 必需检查，但保留管理员绕过，避免单人维护时被自己的规则锁死；多人协作时可改为「Require PR + 至少 1 个审批」。

### 9.2 后续可选增强

1. **About**：补充项目主页/文档链接；
2. **Branch protection**：为 `master` 开启「Require PR before merging + Require status checks」；
3. **GitHub Actions**：增加 `ci.yml`（`npm ci && npm run typecheck && npm test && npm run build`）；
4. **Secrets**：如需 Actions 调 GitHub API，添加 `GITHUB_TOKEN`（默认自带）与 NVD Key；
5. **Security**：开启 Dependabot alerts 与 secret scanning（公开仓库免费）。

---

## 10. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `gh: command not found` | 安装后 PATH 未刷新 | 用绝对路径 `C:\Program Files\GitHub CLI\gh.exe`，或重开终端 |
| `TLS handshake timeout` / `unexpected EOF` | `github.com` 直连线路不稳 | 设置 `HTTPS_PROXY=http://127.0.0.1:7897`；浏览器同步开系统代理 |
| 设备码页面打不开 | 浏览器未走代理 | 临时开启系统代理或使用可访问 GitHub 的网络 |
| `git push` 401/403 | 凭据失效或无权限 | `gh auth status` 检查；`gh auth setup-git` 重配 credential helper |
| 推送大文件失败 | 单文件 >100MB 或仓库超限 | 用 Git LFS；检查是否误提交 `data/`、`node_modules/` |
| 想撤销公开 | 仓库含敏感信息 | 立即 `gh repo edit --visibility private`，并用 `git filter-repo`/BFG 清理历史后强推 |

---

## 11. 安全注意事项

1. **不要提交** `.env`、`data/`（含 `knetsec.db`、`.jwt-secret`）、`node_modules/`、`dist/`；`.gitignore` 已覆盖；
2. 公开仓库中的示例 Token（如 `ghp_xxxxxxxx`）只是占位符，切勿替换为真实值；
3. 若误提交真实 Token：立即到 GitHub → Settings → Developer settings 撤销，再改写历史（`git filter-repo --invert-paths`）并强推；
4. 本机 gh 凭据保存在 Windows 凭据管理器，换机或共用电脑时用 `gh auth logout` 清理；
5. 公开仓库的 Actions 日志与 Issue 内容同样公开，避免粘贴内部信息。

---

## 12. 本次发布时间线

| 时间 | 事件 |
|---|---|
| 22:33 | 收到发布需求，检查本地仓库、凭据与网络 |
| 22:36 | 安装 GitHub CLI 2.105.0（winget） |
| 22:38 | 首次设备码登录，`github.com` TLS 超时失败 |
| 22:45-22:55 | 两轮重试仍失败；定位 Clash 代理 7897，验证 `curl`/`git` 走代理可用 |
| 22:57 | 开启系统代理，重新发起设备码登录 |
| 22:59 | 授权成功，登录为 kumu-1342 |
| 22:59 | 统一 Git 身份，重写 8 个提交作者（内容零变化） |
| 23:00 | 创建公开仓库并推送 master，补充 description 与 topics |
| 23:05 | 验证远程分支、可见性、默认分支；清理备份分支、恢复系统代理 |
| 23:10 | 本文档写入仓库并推送 |

---

## 附录：本次命令全集（可复制复现）

```powershell
# 1) 安装 gh
winget install --id GitHub.cli --exact --source winget --accept-source-agreements --accept-package-agreements --silent

# 2) 代理（按实际环境替换端口）
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'

# 3) 设备码登录
& 'C:\Program Files\GitHub CLI\gh.exe' auth login --hostname github.com --git-protocol https --web

# 4) 统一身份
$u = gh api user | ConvertFrom-Json
git config user.name  ($u.name ?? $u.login)
git config user.email "$($u.id)+$($u.login)@users.noreply.github.com"
git rebase --root --exec "git commit --amend --no-edit --reset-author"

# 5) 创建并推送
gh repo create Knetsec_Ai --public --source=. --remote=origin --push --description "Knetsec_Ai ｜ AI 安全 × 网络安全实时情报平台"

# 6) 元数据
gh repo edit --add-topic ai-security,cybersecurity,threat-intelligence,vulnerability-management,fastify,vue3,typescript,sqlite

# 7) 验证
gh repo view --json name,owner,url,visibility,defaultBranchRef
git ls-remote --heads origin
```

---

*本文档随仓库一同公开；如后续调整仓库可见性或协作流程，请同步更新本文。*