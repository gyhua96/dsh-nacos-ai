# 离线安装 @dsh-nacos/ai

在联网构建机执行：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @dsh-nacos/ai check
pnpm --filter @dsh-nacos/ai test
pnpm --filter @dsh-nacos/ai pack:offline
```

将生成的 `.tgz` 复制到目标机器，然后安装到 DSH Web profile：

```powershell
dsh plugin --profile web add C:\path\to\dsh-nacos-ai-0.2.0.tgz --offline
```

若 `dsh plugin` 不支持 `--offline` 参数透传：

```powershell
pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" add C:\path\to\dsh-nacos-ai-0.2.0.tgz --offline
```

安装后重启 DSH Web Host，打开 **设置 → Nacos** 并配置自己的 Nacos Server、namespace 和账号。

离线包不包含 `node_modules`，目标机器的 DSH profile 或 pnpm store 需要已有兼容版本的 DSH 依赖。不要在离线包、profile patch 或仓库中保存密码、token、证书、私钥或内部地址。
