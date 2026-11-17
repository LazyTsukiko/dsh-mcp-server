# dsh-workpc MCP Server

自研轻量 MCP 服务器（零依赖，纯 Node 标准库），把**工作电脑上的 DeepSeek Harness (DSH)** 以 MCP 工具形式暴露给云端 AstrBot，让 AstrBot 的 agent 能自主调用 DSH 在本机真实执行任务。

## 架构

```
QQ 消息 → AstrBot 容器（云 ECS）
  → agent 自主调用 mcp__dsh__* 工具
  → http://host.docker.internal:8090/mcp   （ECS 宿主机）
  → SSH 反向隧道（本机 OpenSSH → ECS sshd，需 GatewayPorts clientspecified）
  → 本机 node dsh-mcp-server/server.mjs   （127.0.0.1:8090）
  → dsh --profile headless --patch headless-patch.yml （真实执行）
  → 结果回流到群聊
```

## 仓库内容

| 文件 | 用途 |
|---|---|
| `dsh-mcp-server/server.mjs` | MCP 服务器本体（唯一代码文件，零依赖） |
| `headless-patch.yml` | dsh headless profile 的模型提供商覆盖层 |
| `skill/SKILL.md` | 部署到 AstrBot 容器 `/AstrBot/data/skills/dsh-workpc/SKILL.md` 的 agent 技能 |
| `docker-compose.yml` | AstrBot + NapCat 联合部署示例（astrbot 服务含 `extra_hosts: host.docker.internal:host-gateway`） |
| `tunnel-start.vbs.example` | Windows 开机自启启动器模板（SSH 隧道 + MCP 服务器） |

## 工具集

| 工具 | 参数 | 说明 |
|---|---|---|
| `agent_run` | task（必填）、cwd、timeout_sec（默认900s，上限1800s）、session_id | 在工作电脑上真实执行任务（文件读写、bash、代码），返回 DSH 最终答复；返回值含 session_id 可续接多轮 |
| `list_sessions` | 无 | 列出本机 DSH 持久会话（id/工作区/最近活动） |
| `echo` | text | 连通性测试 |

认证：所有请求须带 `Authorization: Bearer <DSH_MCP_TOKEN>`。

## 部署步骤

### 1. 本机（运行 DSH 的电脑）

```bash
# 生成 SSH 密钥并把公钥装到 ECS 的 authorized_keys
ssh-keygen -t ed25519 -f id_dsh_tunnel

# 启动 MCP 服务器（认证 token 通过环境变量注入）
DSH_MCP_TOKEN=<你的token> node dsh-mcp-server/server.mjs
```

要求：本机已安装 DSH（`dsh` 命令可用），且 headless 能通过 `headless-patch.yml` 找到模型提供商（凭据来自 DSH 凭据服务或环境变量）。

### 2. ECS（运行 AstrBot 的服务器）

1. `sshd_config` 加一行 `GatewayPorts clientspecified` 并重启 sshd（允许隧道绑定 docker 网桥 IP）
2. 用 `docker-compose.yml` 部署（astrbot 服务已含 `extra_hosts`）
3. 本机启动 SSH 反向隧道：`ssh -N -R 172.17.0.1:8090:127.0.0.1:8090 root@<ECS>`（参考 `tunnel-start.vbs.example`）

### 3. AstrBot WebUI

- **插件 → MCP**：添加 Streamable HTTP 服务器，命名 `dsh`，URL `http://host.docker.internal:8090/mcp`，Header `Authorization: Bearer <DSH_MCP_TOKEN>`
- **技能**：把 `skill/SKILL.md` 部署到容器 `/AstrBot/data/skills/dsh-workpc/SKILL.md`，并在 `skills.json` 注册启用

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_MCP_TOKEN` | `change-me` | MCP Bearer 认证 token |
| `DSH_HEADLESS_PATCH` | `headless-patch.yml` | headless patch 覆盖层路径 |
| `DSH_DEFAULT_CWD` | `D:\dsh\workspace` | agent_run 默认工作目录 |

## 已知限制

- headless 不支持自定义会话标题
- 单次任务最长 30 分钟（timeout 上限），运行过程不实时可见，结束后落盘
- headless 走独立 profile，模型配置由 `headless-patch.yml` 提供
- 工具调用层没有按用户区分权限（AstrBot 上游限制），建议用平台白名单把入口收紧到管理员本人
