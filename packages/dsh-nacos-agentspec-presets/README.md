# @dsh-nacos/ai

DSH plugin for Nacos AI AgentSpecs and standalone Skills.

For project-level documentation, see the repository [README](../../README.md) and [Chinese README](../../README.zh-CN.md).

## Plugin behavior

- Adds **Settings → Nacos** in DSH Web.
- Uses one Nacos connection and access token for AgentSpecs and Skills.
- Fetches catalog metadata only when the user requests it.
- Downloads only selected online AgentSpecs or Skills.
- Converts selected AgentSpecs to a local DSH preset atomically.
- Resolves Skills through the Nacos Skill marketplace using locally approved names.
- Provides a local policy editor for tool profiles and AgentSpec mappings.

## Security boundary

Nacos content is treated as untrusted publication data. The plugin accepts generic instruction resources and Skill Markdown only. Tool loader rows, tool permissions, MCP endpoints, commands, credentials, and environment variables remain local DSH configuration.

See [Security model](../../docs/security.md) and [configuration reference](../../docs/configuration.md).

## Commands

From the repository root:

```bash
pnpm check
pnpm test
pnpm pack:plugin
```
