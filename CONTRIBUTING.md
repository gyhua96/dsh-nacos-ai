# Contributing

## Development setup

- Node.js version supported by your DSH deployment.
- pnpm `11.25.0` (see `package.json`).
- A DSH Web profile for manual integration testing.
- A Nacos Server with AI AgentSpec and Skill APIs enabled if testing network interactions.

```bash
pnpm install
pnpm check
pnpm test
```

## Scope

This project is an integration plugin between DSH and Nacos AI AgentSpec/Skill features. Keep Nacos content generic and keep all DSH-specific runtime policy local.

## Before opening a pull request

1. Run `pnpm check` and `pnpm test`.
2. Do not commit `node_modules`, `.tgz` packages, generated content, or local DSH runtime caches.
3. Do not commit server addresses, usernames, passwords, access tokens, certificates, private keys, or proprietary AgentSpec/Skill content.
4. Add regression tests for parser or materialization behavior changes.
5. Document user-visible configuration changes in English and Chinese when practical.

## Security reports

Do not disclose secrets in public issues. See [Security model](./docs/security.md).
