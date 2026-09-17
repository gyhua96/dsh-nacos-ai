# Nacos AI authoring guide

This guide describes generic Nacos content that can be consumed by the DSH Nacos AI plugin.

## Publish standalone Skills first

A Nacos Skill is the canonical location for Skill content. Publish each complete Skill as a standalone Nacos Skill and set an online version.

A Skill ZIP accepted by the Nacos `SkillZipParser` contains a root `SKILL.md` with YAML frontmatter:

```markdown
---
name: example-skill
description: Example reusable workflow
---

# Example Skill

Instructions for the model...
```

Do not put DSH plugin configuration, tools, credentials, or executable settings in Skill Markdown.

## Publish generic AgentSpecs

An AgentSpec contains generic metadata and text instruction resources, normally `AGENTS.md`. AgentSpecs should reference Skills by name only; do not duplicate standalone Skill bodies inside the AgentSpec.

For Nacos ZIP import, an AgentSpec archive uses this minimal layout:

```text
manifest.json
AGENTS.md
```

`manifest.json` needs `worker.suggested_name`:

```json
{
  "version": "1.0.0",
  "description": "Example generic agent",
  "worker": {
    "suggested_name": "example-agent"
  },
  "skillReferences": ["example-skill"]
}
```

The `skillReferences` list is generic association metadata. The DSH plugin uses its own local mapping as the final authority for which Skills are allowed and materialized.

## DSH local mapping

On the DSH side, map the AgentSpec to local policy:

```json
{
  "example-agent": {
    "toolProfile": "full-access",
    "instructionResources": ["AGENTS.md"],
    "skillReferences": ["example-skill"]
  }
}
```

The mapping is deliberately not uploaded to Nacos.

## Publish order

1. Create/update the standalone Skill and publish its version online.
2. Create/update the AgentSpec and publish its version online.
3. In DSH, open **Settings → Nacos**, refresh the catalog, and download the selected AgentSpec.

## Prohibited content

Never publish the following in AgentSpec/Skill content:

- `dshPreset`, Cordis configuration, tool profiles, or MCP profiles.
- Nacos/DSH passwords, tokens, API keys, certificates, or private keys.
- Tool commands, local paths, environment variables, URLs with embedded credentials, or headers.
