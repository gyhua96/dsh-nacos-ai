# DSH Nacos AI

[English](./README.md) · 中文

用于连接 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness) 与 **Nacos AI AgentSpec**、**Nacos Skill 市场**的 DSH 插件。

插件在 DSH 的 **设置 → Nacos** 提供统一入口：配置连接、登录、浏览在线 AgentSpec 和 Skill、查看详情，并按需下载为 DSH 可使用的本地预设和 Skill。

> **状态：实验性。** 本项目基于仓库中使用的 Nacos AI Console API 与 DSH `0.1.5-rc` API 开发；用于生产前请在自己的 Nacos/DSH 版本上完成兼容性验证。

## 功能

- AgentSpec 与 Skill 市场共用同一个 Nacos 连接和认证状态。
- 安全认证：Server URL、namespace 等保存到 DSH Settings；access token 保存到 DSH Credentials；密码绝不持久化。
- 按需加载：插件启动时不请求 Nacos、不下载内容、不写入 preset。
- AgentSpec：读取通用 Nacos 指令资源，例如 `AGENTS.md`；兼容 Nacos 官方 ZIP 导入后返回的根资源。
- 独立 Skill：按 DSH 本地审核过的 Skill 名称，从 Nacos Skill 市场获取完整 `SKILL.md`。
- 本地策略隔离：工具、权限、Cordis loader、显示名、资源选择、Skill 选择均只由 DSH 本地配置决定，绝不从 Nacos 内容接收。
- 在 **设置 → Nacos → 全权限工具策略** 内编辑本地工具 profile 与 AgentSpec 映射。
- AgentSpec/Skill 使用 staging + 原子替换写入；不合法响应直接拒绝。

## 架构边界

```text
Nacos AI
  ├─ AgentSpec：通用 metadata + AGENTS.md 等指令资源
  └─ Skill 市场：独立发布的完整 SKILL.md
                  │
                  ▼
DSH Nacos AI 插件
  ├─ 共享连接和凭据 token
  ├─ 本地策略（工具 profile、映射、审核的 Skill 名称）
  └─ 按需下载到本地
                  │
                  ▼
DSH Agent Preset 与宿主级 Skill provider
```

Nacos 是通用发布平台，不能在 AgentSpec/Skill 中放入 DSH 私有运行时信息。禁止发布：Cordis loader 行、tool 权限、MCP URL、命令、环境变量、token、密码、私钥、带凭据的 URL 等。

## 安装

### 从源码构建

```powershell
pnpm install
pnpm check
pnpm test
pnpm pack:plugin
```

构建出的 `.tgz` 位于插件包目录。安装到 DSH Web profile：

```powershell
dsh plugin --profile web add C:\path\to\dsh-nacos-ai-0.2.0.tgz
```

重启 DSH Web Host 后，打开 **设置 → Nacos**。

### 离线安装

见[离线安装说明](./docs/offline-install.zh-CN.md)。

## 使用流程

1. 打开 **设置 → Nacos**，保存 Nacos Server URL、namespace 与 API plane；
2. 登录。密码只会用于一次登录请求，保存的是 DSH Credentials 中的 access token；
3. 在 **Agent Presets** 中加载在线目录、选择一个 AgentSpec 并下载；
4. 在 **Skill 市场** 中按需下载独立 Skill；
5. 在 **全权限工具策略** 中设置本地工具 profile 和 AgentSpec 映射；修改策略后重新下载对应 preset 使其生效。

## 本地工具策略

远程 AgentSpec 不能授予任何 DSH 工具。工具策略只存在 DSH 本地：

- **工具 Profiles（JSON）**：定义本地 Cordis loader 行；
- **Preset 映射（JSON）**：为每个 AgentSpec 选择工具 profile、指令资源和独立 Skill 名称。

示例：

```json
{
  "example-agent": {
    "toolProfile": "full-access",
    "instructionResources": ["AGENTS.md"],
    "skillReferences": ["example-skill"]
  }
}
```

更多内容见：[配置参考](./docs/configuration.md)、[安全模型](./docs/security.md)、[Nacos 发布指南](./docs/nacos-authoring.md)。

## 开发

```powershell
pnpm check
pnpm test
```

测试无网络依赖，覆盖分页、响应校验、通用 AgentSpec 资源解析、独立 Skill 解析和原子化本地落盘。

## 许可证

[Apache License 2.0](./LICENSE)。
