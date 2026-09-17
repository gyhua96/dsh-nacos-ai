# Configuration reference

All configuration described here is local to DSH. It is not part of a Nacos AgentSpec or Skill.

## Connection

Use **Settings → Nacos** to configure:

| Setting | Meaning |
| --- | --- |
| Server URL | Base URL of the Nacos Server instance. |
| Namespace | Nacos namespace used for AgentSpecs and Skills. |
| API plane | `console` by default; use `admin` only if your Nacos deployment exposes that API plane. |
| Username/password | Used only for the Nacos login request. |

The plugin writes connection metadata to DSH Settings (`nacos-agent-specs`) and writes the returned access token to DSH Credentials under `NACOS_ACCESS_TOKEN` by default.

## Local tool profiles

Open **Settings → Nacos → Full-access tool policy**. The **Tool profiles JSON** editor holds an object whose keys are profile IDs and values are arrays of local Cordis loader rows.

```json
{
  "full-access": [
    { "id": "tool-pwsh", "name": "@deepseek-ai/dsh-tool-pwsh" },
    { "id": "tool-fs", "name": "@deepseek-ai/dsh-tool-fs" },
    { "id": "tool-web", "name": "@deepseek-ai/dsh-tool-web", "config": { "fetch": true } }
  ]
}
```

The plugin default is `full-access`. This only controls which tool plugins the local preset mounts. DSH host sandbox, approval, and permission policy still determine actual execution access.

Avoid adding host-wide providers/tools such as `@deepseek-ai/dsh-skill-filesystem` and `@deepseek-ai/dsh-tool-skill` inside a preset profile if they are already mounted by the host. Duplicate registrations cause Cordis load failures.

## AgentSpec mappings

The **Preset mappings JSON** editor maps a Nacos AgentSpec name to local consumption policy:

```json
{
  "example-agent": {
    "displayName": "Example agent",
    "toolProfile": "full-access",
    "instructionResources": ["AGENTS.md"],
    "skillReferences": ["example-skill"],
    "mcpProfiles": []
  }
}
```

| Field | Required | Description |
| --- | --- | --- |
| `displayName` | no | Local DSH display name. |
| `toolProfile` | no | Key from Tool profiles; defaults to `full-access`. |
| `instructionResources` | no | Nacos resource file names combined into the DSH system prompt. Defaults to `AGENTS.md`, `IDENTITY.md`, `SOUL.md`. |
| `skillReferences` | no | Names of independently published Nacos Skills that the preset may download. |
| `mcpProfiles` | no | Locally declared, reviewed MCP profile IDs. |

After changing a mapping or profile, download the AgentSpec again to regenerate its local DSH preset.

## Static profile patch

The installed plugin includes `cordis.patch.yml` with a disabled default entry. You can enable it and set non-secret defaults in your DSH profile patch. Do not put passwords or access tokens there.
