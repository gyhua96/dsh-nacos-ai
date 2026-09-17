# 离线安装

## 构建离线包

在一台具备 Node.js、pnpm 和依赖缓存的构建机上运行：

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm pack:plugin
```

`pnpm pack:plugin` 会在 `packages/dsh-nacos-agentspec-presets/` 生成一个 `.tgz`。

## 安装到 DSH Web profile

将 `.tgz` 复制到目标机器后执行：

```powershell
dsh plugin --profile web add C:\path\to\dsh-nacos-ai-0.2.0.tgz --offline
```

若 `dsh plugin` 不支持透传 `--offline`，可直接使用目标 profile 的 pnpm：

```powershell
pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" add C:\path\to\dsh-nacos-ai-0.2.0.tgz --offline
```

安装后重启 DSH Web Host，打开 **设置 → Nacos** 并保存自己的 Nacos 连接。

## 离线前置条件

目标机的 DSH profile 或 pnpm store 必须已经具备插件依赖所需的 DSH 包。插件 tarball 不包含 `node_modules`。

## 安全注意事项

离线包不应包含 Nacos 地址、用户名、密码、token、证书、私钥或内部 Skill/AgentSpec 内容。所有连接信息由目标 DSH 用户在本地设置页面自行保存。
