import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/;
export const STATUS = Object.freeze({
  READY: 'ready',
  READY_EMPTY: 'ready-empty',
  UNAVAILABLE: 'unavailable',
  INVALID_RESPONSE: 'invalid-response',
});

export class NacosAgentSpecError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'NacosAgentSpecError';
    this.code = code;
  }
}

export function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Nacos serverUrl must use HTTP(S)');
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

export function safePresetId(value) {
  if (typeof value !== 'string' || !PRESET_ID.test(value)) {
    throw new NacosAgentSpecError('NACOS_AGENTSPEC_INVALID_ID', `AgentSpec name is not a safe DSH preset id: ${String(value)}`);
  }
  return value;
}

function unwrapResult(body, context) {
  if (!body || typeof body !== 'object') throw new NacosAgentSpecError('NACOS_AGENTSPEC_RESPONSE_INVALID', `${context}: response is not JSON object`);
  if (body.code && body.code !== 0 && body.code !== 200) {
    throw new NacosAgentSpecError('NACOS_AGENTSPEC_RESPONSE_INVALID', `${context}: Nacos result error ${body.code}: ${body.message ?? ''}`);
  }
  return Object.hasOwn(body, 'data') ? body.data : body;
}

export class NacosAgentSpecClient {
  constructor({ serverUrl, accessToken, fetchImpl = globalThis.fetch, timeoutMs = 8000, apiPlane = 'console' }) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
    if (!['console', 'admin'].includes(apiPlane)) throw new Error('apiPlane must be console or admin');
    this.baseUrl = normalizeBaseUrl(serverUrl);
    this.accessToken = accessToken;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.apiPlane = apiPlane;
    this.apiBase = `/v3/${apiPlane}/ai/agentspecs`;
  }

  async request(path, params = {}, { md5 } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    if (md5) url.searchParams.set('md5', md5);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { accept: 'application/json' };
      if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
      const response = await this.fetch(url, { headers, signal: controller.signal });
      if (response.status === 304) return { notModified: true, headers: response.headers };
      const text = await response.text();
      if (!response.ok) {
        const routeAbsent = response.status === 404 || /No static resource/i.test(text);
        const code = response.status === 401 || response.status === 403
          ? 'NACOS_AGENTSPEC_ACCESS_DENIED'
          : routeAbsent ? 'NACOS_AGENTSPEC_ENDPOINT_UNAVAILABLE' : 'NACOS_AGENTSPEC_HTTP_ERROR';
        throw new NacosAgentSpecError(code, `Nacos ${path} returned HTTP ${response.status}`);
      }
      let body;
      try { body = JSON.parse(text); } catch (error) { throw new NacosAgentSpecError('NACOS_AGENTSPEC_RESPONSE_INVALID', `${path}: invalid JSON`, error); }
      return { data: unwrapResult(body, path), headers: response.headers };
    } catch (error) {
      if (error instanceof NacosAgentSpecError) throw error;
      const timeout = controller.signal.aborted;
      throw new NacosAgentSpecError(timeout ? 'NACOS_AGENTSPEC_TRANSPORT_UNAVAILABLE' : 'NACOS_AGENTSPEC_TRANSPORT_UNAVAILABLE', `Nacos request failed: ${path}`, error);
    } finally { clearTimeout(timer); }
  }

  async listAll({ namespaceId = 'public', pageSize = 100 } = {}) {
    const items = [];
    let pageNo = 1;
    for (;;) {
      const { data } = await this.request(`${this.apiBase}/list`, { namespaceId, pageNo, pageSize });
      const pageItems = data?.pageItems;
      if (!Array.isArray(pageItems)) throw new NacosAgentSpecError('NACOS_AGENTSPEC_RESPONSE_INVALID', 'admin list response has no pageItems array');
      items.push(...pageItems);
      const pages = Number(data.pagesAvailable);
      if (!Number.isInteger(pages) || pages < pageNo || pageNo >= pages) return { items, totalCount: Number(data.totalCount ?? items.length) };
      pageNo++;
    }
  }

  async getMeta({ namespaceId = 'public', name }) {
    safePresetId(name);
    return this.request(this.apiBase, { namespaceId, agentSpecName: name });
  }

  async getVersionSpec({ namespaceId = 'public', name, version }) {
    safePresetId(name);
    if (typeof version !== 'string' || version.length === 0) throw new NacosAgentSpecError('NACOS_AGENTSPEC_RESPONSE_INVALID', `${name}: no online version was provided by inventory`);
    return this.request(`${this.apiBase}/version`, { namespaceId, agentSpecName: name, version });
  }

  async getRuntimeSpec({ namespaceId = 'public', name, md5 }) {
    safePresetId(name);
    return this.request('/v3/client/ai/agentspecs', { namespaceId, name }, { md5 });
  }

  async listAllSkills({ namespaceId = 'public', pageSize = 100, keyword = '' } = {}) {
    const items = [];
    let pageNo = 1;
    for (;;) {
      const { data } = await this.request(`/v3/${this.apiPlane ?? 'console'}/ai/skills/list`, { namespaceId, pageNo, pageSize, keyword });
      const pageItems = data?.pageItems;
      if (!Array.isArray(pageItems)) throw new NacosAgentSpecError('NACOS_SKILL_RESPONSE_INVALID', 'Skill list response has no pageItems array');
      items.push(...pageItems);
      const pages = Number(data.pagesAvailable);
      if (!Number.isInteger(pages) || pages < pageNo || pageNo >= pages) return { items, totalCount: Number(data.totalCount ?? items.length) };
      pageNo++;
    }
  }

  async getSkill({ namespaceId = 'public', name }) {
    safeSkillId(name, 'Nacos Skill');
    return this.request(`/v3/${this.apiPlane ?? 'console'}/ai/skills`, { namespaceId, skillName: name });
  }

  async getSkillVersion({ namespaceId = 'public', name, version }) {
    safeSkillId(name, 'Nacos Skill');
    if (typeof version !== 'string' || version.length === 0) throw new NacosAgentSpecError('NACOS_SKILL_RESPONSE_INVALID', `${name}: no online Skill version was provided by inventory`);
    return this.request(`/v3/${this.apiPlane ?? 'console'}/ai/skills/version`, { namespaceId, skillName: name, version });
  }
}

const SAFE_SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_BYTES = 262144;

export function safeSkillId(value, context = 'skill') {
  if (typeof value !== 'string' || !SAFE_SKILL_ID.test(value)) throw new NacosAgentSpecError('NACOS_AGENTSPEC_UNSUPPORTED', `${context}: skill id must match ${SAFE_SKILL_ID}`);
  return value;
}

/**
 * Admit only explicitly declared text skill resources. Nacos remains the data
 * source; it never supplies executable Cordis rows, paths, URLs, or MCP
 * connection credentials.
 */
function parseSkillReferences(localMapping, specName) {
  const references = localMapping?.skillReferences ?? [];
  if (!Array.isArray(references) || references.some((name) => typeof name !== 'string')) throw new NacosAgentSpecError('NACOS_AGENTSPEC_UNSUPPORTED', `${specName}: local skillReferences must be a string array`);
  const seen = new Set();
  return references.map((name) => {
    safeSkillId(name, specName);
    if (seen.has(name)) throw new NacosAgentSpecError('NACOS_AGENTSPEC_UNSUPPORTED', `${specName}: duplicate local Skill reference ${name}`);
    seen.add(name);
    return name;
  });
}

function parseMcpProfiles(localMapping, permittedMcpProfiles, specName) {
  const profiles = localMapping?.mcpProfiles ?? [];
  if (!Array.isArray(profiles) || profiles.some((profile) => typeof profile !== 'string')) throw new NacosAgentSpecError('NACOS_AGENTSPEC_UNSUPPORTED', `${specName}: local mcpProfiles must be a string array`);
  const seen = new Set();
  return profiles.map((profile) => {
    if (!SAFE_SKILL_ID.test(profile) || seen.has(profile) || !permittedMcpProfiles.includes(profile)) throw new NacosAgentSpecError('NACOS_AGENTSPEC_UNSUPPORTED', `${specName}: unapproved locally mapped MCP profile ${profile}`);
    seen.add(profile);
    return profile;
  });
}

/** Translate generic Nacos resources using a deployment-owned local mapping. */
export function parseSupportedManifest(agentSpec, permittedToolProfiles, permittedMcpProfiles = [], localMappings = {}) {
  safePresetId(agentSpec?.name);
  const local = localMappings?.[agentSpec.name] ?? {};
  if (!local || typeof local !== 'object' || Array.isArray(local)) throw new NacosAgentSpecError('NACOS_AGENTSPEC_UNSUPPORTED', `${agentSpec.name}: local mapping must be an object`);
  // Nacos console versions return the map as `resource`, `resources`, or wrap
  // it under agentSpec/version data. Root ZIP files have type "" (or omit it).
  const resourceMap = agentSpec.resource ?? agentSpec.resources ?? agentSpec.agentSpec?.resource ?? agentSpec.agentSpec?.resources ?? agentSpec.agentSpecVersion?.resource ?? agentSpec.agentSpecVersion?.resources ?? {};
  const resources = (Array.isArray(resourceMap) ? resourceMap : Object.values(resourceMap)).filter((resource) => resource && typeof resource === 'object');
  const names = local.instructionResources ?? ['AGENTS.md', 'IDENTITY.md', 'SOUL.md'];
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) throw new NacosAgentSpecError('NACOS_AGENTSPEC_UNSUPPORTED', `${agentSpec.name}: local instructionResources must be a string array`);
  const instructions = names.map((name) => resources.find((resource) => (resource?.type === 'config' || resource?.type === '') && resource.name === name)).filter(Boolean).map((resource) => `# ${resource.name}\n${resource.content}`);
  const prompt = instructions.join('\n\n');
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 65536) throw new NacosAgentSpecError('NACOS_AGENTSPEC_UNSUPPORTED', `${agentSpec.name}: requires a 1..65536 character generic config resource selected by local instructionResources`);
  // This plugin defaults to one broad local profile. DSH host sandbox and
  // permission policy still governs real file/process access independently.
  const toolProfile = local.toolProfile ?? 'full-access';
  if (typeof toolProfile !== 'string' || !permittedToolProfiles.includes(toolProfile)) throw new NacosAgentSpecError('NACOS_AGENTSPEC_UNSUPPORTED', `${agentSpec.name}: unapproved locally mapped tool profile`);
  return { id: agentSpec.name, name: local.displayName ?? agentSpec.name, description: agentSpec.description ?? '', systemPrompt: prompt, toolProfile, skillReferences: parseSkillReferences(local, agentSpec.name), skills: [], mcpProfiles: parseMcpProfiles(local, permittedMcpProfiles, agentSpec.name), revision: agentSpec.version ?? agentSpec.resolvedVersion };
}

const quote = (value) => JSON.stringify(String(value));
export function compilePreset(spec, toolProfiles, presetDirectory = '', mcpProfiles = {}) {
  const selectedMcpRows = (spec.mcpProfiles ?? []).flatMap((profile) => mcpProfiles[profile] ?? []);
  const profileRows = toolProfiles[spec.toolProfile] ?? [];
  // Skill providers and the `skill` tool are host-wide services. A preset mounts
  // in the same Cordis scope, so it must never add its own copies; doing so
  // causes duplicate `filesystem` / `skill` registrations. The DSH profile owns
  // the single Skill filesystem root used by all mounted presets.
  const rows = [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: spec.systemPrompt } },
    { id: 'project-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    ...profileRows,
    ...selectedMcpRows,
  ];
  const yaml = rows.map((row) => {
    const out = [`- id: ${quote(row.id)}`, `  name: ${quote(row.name)}`];
    if (row.config) {
      out.push('  config:');
      for (const [key, value] of Object.entries(row.config)) out.push(`    ${key}: ${typeof value === 'string' ? quote(value) : JSON.stringify(value)}`);
    }
    return out.join('\n');
  }).join('\n');
  return { composition: `${yaml}\n`, metadata: `name: ${quote(spec.name)}\ndescription: ${quote(spec.description || 'Synced from Nacos AgentSpec')}\n`, generated: JSON.stringify({ source: 'nacos-agentspec', id: spec.id, revision: spec.revision ?? null, sha256: sha256(spec.systemPrompt), skills: (spec.skills ?? []).map(({ id, sha256 }) => ({ id, sha256 })), mcpProfiles: spec.mcpProfiles ?? [] }, null, 2) + '\n' };
}

async function writePresetFiles(directory, preset, toolProfiles, mcpProfiles) {
  const files = compilePreset(preset, toolProfiles, directory, mcpProfiles);
  await Promise.all(Object.entries({ 'agent.cordis.yml': files.composition, 'preset.yml': files.metadata, 'generated.json': files.generated }).map(([name, content]) => writeFile(join(directory, name), content, { encoding: 'utf8', mode: 0o600 })));
  for (const skill of preset.skills ?? []) {
    const skillPath = join(directory, 'skills', safeSkillId(skill.id), 'SKILL.md');
    await mkdir(dirname(skillPath), { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(skillPath, skill.content, { encoding: 'utf8', mode: 0o600 }),
      writeFile(join(dirname(skillPath), 'generated.json'), skillGenerated(preset, skill), { encoding: 'utf8', mode: 0o600 }),
    ]);
  }
}

export function sha256(input) { return createHash('sha256').update(input).digest('hex'); }

export function skillSummary(skill, revision, localHash) {
  const sizeBytes = Buffer.byteLength(skill.content, 'utf8');
  return { id: skill.id, sizeBytes, sha256: skill.sha256, remoteRevision: revision ?? null, downloaded: localHash !== undefined, localHash: localHash ?? null, updateAvailable: localHash !== undefined && localHash !== skill.sha256 };
}

function skillGenerated(preset, skill) {
  return JSON.stringify({ source: 'nacos-agentspec', presetId: preset.id, revision: preset.revision ?? null, skillId: skill.id, sha256: skill.sha256, downloadedAt: new Date().toISOString() }, null, 2) + '\n';
}

function standaloneSkillResource(remote) {
  const resources = [remote?.resource, remote?.resources, remote?.files, remote?.skill?.resource, remote?.skill?.resources, remote?.skillVersion?.resource, remote?.skillVersion?.resources]
    .flatMap((value) => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [])
    .filter((value) => value && typeof value === 'object');
  return resources.find((resource) => resource.type === 'skill' && typeof resource.content === 'string')
    ?? resources.find((resource) => /^SKILL\.md$/i.test(String(resource.name ?? '')) && typeof resource.content === 'string')
    ?? resources.find((resource) => typeof resource.content === 'string');
}

export function parseStandaloneSkill(remote, fallback = {}) {
  const name = remote?.name ?? remote?.skillName ?? fallback.name;
  const id = safeSkillId(name, 'Nacos Skill');
  const resource = standaloneSkillResource(remote);
  // Nacos 3.2.x standalone Skill versions use `skillMd` for SKILL.md body.
  let content = remote?.skillMd ?? remote?.content ?? remote?.skillContent ?? remote?.skill?.skillMd ?? remote?.skill?.content ?? remote?.skillVersion?.skillMd ?? remote?.skillVersion?.content ?? resource?.content;
  // A Nacos Skill version may package the body inside a plain JSON resource envelope.
  // This only unwraps text; it never evaluates arbitrary remote configuration.
  if (typeof content === 'string' && content.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(content);
      content = parsed.skillMd ?? parsed.content ?? parsed.skillContent ?? standaloneSkillResource(parsed)?.content ?? content;
    } catch { /* Skill Markdown may legitimately contain braces */ }
  }
  if (typeof content !== 'string' || content.length === 0 || Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) throw new NacosAgentSpecError('NACOS_SKILL_INVALID', `${id}: Skill response has no supported text body (expected content, skillContent, or a text SKILL.md/resource entry)`);
  const encoding = remote?.metadata?.encoding ?? resource?.metadata?.encoding;
  if (encoding !== undefined && !['utf-8', 'utf8', 'text/plain'].includes(String(encoding).toLowerCase())) throw new NacosAgentSpecError('NACOS_SKILL_INVALID', `${id}: Skill has unsupported encoding`);
  return { id, name: remote?.displayName ?? name, description: remote?.description ?? fallback.description ?? '', content, sha256: sha256(content), revision: remote?.version ?? remote?.resolvedVersion ?? fallback.revision ?? null };
}

function marketplaceSkillGenerated(skill) {
  return JSON.stringify({ source: 'nacos-skill-market', id: skill.id, revision: skill.revision, sha256: skill.sha256, downloadedAt: new Date().toISOString() }, null, 2) + '\n';
}

export async function readLocalMarketplaceSkill(root, skillId) {
  try { return JSON.parse(await readFile(join(resolve(root), safeSkillId(skillId, 'Nacos Skill'), 'generated.json'), 'utf8')); } catch { return undefined; }
}

export async function materializeMarketplaceSkill(root, skill) {
  const destination = resolve(root); const id = safeSkillId(skill.id, 'Nacos Skill');
  const target = join(destination, id); const staging = join(destination, `.staging-${id}-${process.pid}-${Date.now()}`); const previous = join(destination, `.previous-${id}-${process.pid}-${Date.now()}`);
  await mkdir(destination, { recursive: true, mode: 0o700 }); await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await Promise.all([writeFile(join(staging, 'SKILL.md'), skill.content, { encoding: 'utf8', mode: 0o600 }), writeFile(join(staging, 'generated.json'), marketplaceSkillGenerated(skill), { encoding: 'utf8', mode: 0o600 })]);
    try { await rename(target, previous); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await rename(staging, target); await rm(previous, { recursive: true, force: true }); return target;
  } catch (error) { await rm(staging, { recursive: true, force: true }); try { await rename(previous, target); } catch {} throw error; }
}

export async function readLocalSkill(root, presetId, skillId) {
  try { return JSON.parse(await readFile(join(resolve(root), safePresetId(presetId), 'skills', safeSkillId(skillId), 'generated.json'), 'utf8')); } catch { return undefined; }
}

/** Atomically replace only one compiler-owned Skill directory. */
export async function materializeSkill(root, preset, skill) {
  const destination = resolve(root);
  const presetId = safePresetId(preset.id);
  const skillId = safeSkillId(skill.id);
  const skillsRoot = join(destination, presetId, 'skills');
  const target = join(skillsRoot, skillId);
  const staging = join(skillsRoot, `.staging-${skillId}-${process.pid}-${Date.now()}`);
  const previous = join(skillsRoot, `.previous-${skillId}-${process.pid}-${Date.now()}`);
  await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await Promise.all([
      writeFile(join(staging, 'SKILL.md'), skill.content, { encoding: 'utf8', mode: 0o600 }),
      writeFile(join(staging, 'generated.json'), skillGenerated(preset, skill), { encoding: 'utf8', mode: 0o600 }),
    ]);
    try { await rename(target, previous); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await rename(staging, target);
    await rm(previous, { recursive: true, force: true });
    return target;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    try { await rename(previous, target); } catch { /* original did not exist */ }
    throw error;
  }
}

/** Atomically replace this preset's complete compiler-owned Skill generation. */
export async function materializeSkills(root, preset) {
  const destination = resolve(root);
  const presetId = safePresetId(preset.id);
  const presetRoot = join(destination, presetId);
  const skillsRoot = join(presetRoot, 'skills');
  const staging = join(presetRoot, `.skills-staging-${process.pid}-${Date.now()}`);
  const previous = join(presetRoot, `.skills-previous-${process.pid}-${Date.now()}`);
  await mkdir(presetRoot, { recursive: true, mode: 0o700 });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const skill of preset.skills ?? []) {
      const directory = join(staging, safeSkillId(skill.id));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await Promise.all([
        writeFile(join(directory, 'SKILL.md'), skill.content, { encoding: 'utf8', mode: 0o600 }),
        writeFile(join(directory, 'generated.json'), skillGenerated(preset, skill), { encoding: 'utf8', mode: 0o600 }),
      ]);
    }
    try { await rename(skillsRoot, previous); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await rename(staging, skillsRoot);
    await rm(previous, { recursive: true, force: true });
    return skillsRoot;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    try { await rename(previous, skillsRoot); } catch { /* original did not exist */ }
    throw error;
  }
}

export async function publishMirror(root, presets, toolProfiles, mcpProfiles = {}) {
  const destination = resolve(root);
  const staging = `${destination}.staging-${process.pid}-${Date.now()}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const preset of presets) {
      const path = join(staging, safePresetId(preset.id));
      await mkdir(path, { recursive: true, mode: 0o700 });
      await writePresetFiles(path, preset, toolProfiles, mcpProfiles);
    }
    await writeFile(join(staging, 'manifest.json'), JSON.stringify({ generation: sha256(JSON.stringify(presets.map(({ id, revision }) => ({ id, revision })))), presetCount: presets.length, createdAt: new Date().toISOString() }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const previous = `${destination}.previous`;
    await rm(previous, { recursive: true, force: true });
    try { await rename(destination, previous); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await rename(staging, destination);
    await rm(previous, { recursive: true, force: true });
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

/** Atomically write only one selected preset, never a complete namespace mirror. */
export async function materializePreset(root, preset, toolProfiles, mcpProfiles = {}) {
  const destination = resolve(root);
  const id = safePresetId(preset.id);
  const target = join(destination, id);
  const staging = join(destination, `.staging-${id}-${process.pid}-${Date.now()}`);
  const previous = join(destination, `.previous-${id}-${process.pid}-${Date.now()}`);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await writePresetFiles(staging, preset, toolProfiles, mcpProfiles);
    try { await rename(target, previous); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await rename(staging, target);
    await rm(previous, { recursive: true, force: true });
    return target;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    try { await rename(previous, target); } catch { /* original did not exist */ }
    throw error;
  }
}

export async function readCachedManifest(root) {
  try { return JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')); } catch { return undefined; }
}
