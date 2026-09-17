# Security model

## Trust boundary

Nacos is a generic content publishing system; DSH is the runtime that controls tools and permissions. This plugin preserves that boundary.

### Data accepted from Nacos

- AgentSpec identity, description, version, and generic metadata.
- Text instruction resources selected locally, such as `AGENTS.md`.
- Standalone Skill Markdown (`SKILL.md`) selected by locally configured Skill names.

### Data never accepted from Nacos as runtime policy

- Cordis plugin names or loader rows.
- DSH tool profiles or permissions.
- MCP endpoint URLs, headers, commands, arguments, working directories, or environment variables.
- Nacos/LLM/API credentials, passwords, access tokens, certificates, or private keys.
- Executable configuration, JavaScript YAML tags, or arbitrary local paths.

## Credentials

- Nacos passwords are submitted only to the login endpoint and discarded.
- Nacos access tokens are stored via the DSH credential service and never rendered in the UI.
- The repository and sample configuration must not contain real URLs with credentials, tokens, passwords, or private keys.

## Content validation

- AgentSpec and Skill names must match safe identifiers before any local path is constructed.
- Instruction and Skill text sizes are bounded.
- Malformed responses, unavailable routes, unauthorized requests, and unsupported structures fail closed.
- Local files are written to a staging location and atomically moved into their final cache directory.

## Tool profiles

`full-access` is a convenience name for a local profile containing broad DSH tool loaders. It is not a bypass for DSH host security. Sandbox and approval behavior stays under control of the hosting DSH profile and its deployment policy.

For production, review every loader row in local tool profiles and use the least privilege needed by your organization.

## Reporting issues

Do not file public issues containing credentials, access tokens, sensitive AgentSpec/Skill text, or internal Nacos addresses. Redact the information and include only the minimum reproducible details.
