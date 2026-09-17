import { NacosAgentSpecClient, NacosAgentSpecError, STATUS, materializeMarketplaceSkill, materializePreset, materializeSkill, materializeSkills, parseStandaloneSkill, parseSupportedManifest, readLocalMarketplaceSkill, readLocalSkill, safePresetId, safeSkillId, skillSummary } from './core.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import z from '@deepseek-ai/schemastery';

export const name = 'nacos-agentspec-presets';
export const inject = ['credentials', 'settings'];

const CONNECTION_SETTINGS = z.object({
  serverUrl: z.string().default(''),
  username: z.string().default(''),
  namespaceId: z.string().default('public'),
  apiPlane: z.union([z.const('console'), z.const('admin')]).default('console'),
});
const CONNECTION_NAMESPACE = 'nacos-agent-specs';
const POLICY_NAMESPACE = 'nacos-agent-spec-policy';
const TOKEN_REF = 'NACOS_ACCESS_TOKEN';
const LOCAL_POLICY_SETTINGS = z.object({
  // JSON keeps arbitrary local Cordis tool row config intact while still making
  // it editable in Settings. It is never uploaded to Nacos.
  toolProfilesJson: z.string().default(''),
  agentSpecMappingsJson: z.string().default(''),
});
const parsePolicyObject = (value, label) => {
  if (value === '') return undefined;
  let parsed;
  try { parsed = JSON.parse(value); } catch (error) { throw new NacosAgentSpecError('NACOS_AGENTSPEC_POLICY_INVALID', `${label} must be valid JSON`, error); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new NacosAgentSpecError('NACOS_AGENTSPEC_POLICY_INVALID', `${label} must be a JSON object`);
  return parsed;
};

// Deployment-owned adapter mapping: never read DSH tool/MCP choices from Nacos.
const agentSpecMappings = (config) => config.agentSpecMappings ?? {};

/**
 * Metadata roster and one-preset materializer.
 * Deliberately has no startup sync: constructing this service makes no Nacos
 * request and writes no AgentSpec preset files.
 */
export class NacosAgentSpecBrowser {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.ctx = dependencies.ctx;
    this.connectionSettings = dependencies.connectionSettings;
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.getenv = dependencies.getenv ?? ((key) => process.env[key]);
    this.accessToken = dependencies.accessToken;
    this.roster = [];
    this.marketRoot = config.skillMarketRoot ?? join(config.mirrorRoot, '..', 'nacos-skill-market');
    this.status = { state: 'idle', downloadedPresetCount: 0 };
    this.writeQueues = new Map();
  }

  async withPresetWrite(id, action) {
    const safeId = safePresetId(id);
    const previous = this.writeQueues.get(safeId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.writeQueues.set(safeId, next);
    try { return await next; } finally { if (this.writeQueues.get(safeId) === next) this.writeQueues.delete(safeId); }
  }

  settings() { return this.connectionSettings?.get?.() ?? { serverUrl: this.config.serverUrl, username: '', namespaceId: this.config.namespaceId ?? 'public', apiPlane: this.config.apiPlane ?? 'console' }; }

  async client() {
    const settings = this.settings();
    const token = this.ctx?.credentials ? (await this.ctx.credentials.resolve(credentialRef(this.config.tokenRef ?? TOKEN_REF)))?.value : this.accessToken ?? this.getenv(this.config.accessTokenEnv);
    if (!token) throw new NacosAgentSpecError('NACOS_AGENTSPEC_ACCESS_DENIED', 'Nacos authentication is required. Save a shared Nacos connection and sign in from Nacos Settings.');
    if (!settings.serverUrl) throw new NacosAgentSpecError('NACOS_AGENTSPEC_CONNECTION_INVALID', 'Nacos server URL is required. Configure it in the shared Nacos connection panel.');
    return new NacosAgentSpecClient({ serverUrl: settings.serverUrl, accessToken: token, fetchImpl: this.fetch, timeoutMs: this.config.timeoutMs, apiPlane: settings.apiPlane });
  }

  async signIn(username, password) {
    const settings = this.settings();
    if (typeof username !== 'string' || typeof password !== 'string' || username === '' || password === '') throw new NacosAgentSpecError('NACOS_AGENTSPEC_ACCESS_DENIED', 'Nacos username and password are required');
    if (!settings.serverUrl) throw new NacosAgentSpecError('NACOS_AGENTSPEC_CONNECTION_INVALID', 'Nacos server URL is required before signing in');
    const response = await this.fetch(new URL('/v1/auth/login', settings.serverUrl), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ username, password }), signal: AbortSignal.timeout(this.config.timeoutMs) });
    const body = await response.json().catch(() => ({}));
    const token = body.accessToken ?? body.token;
    if (!response.ok || typeof token !== 'string' || token === '') throw new NacosAgentSpecError('NACOS_AGENTSPEC_ACCESS_DENIED', body.message ?? `Nacos login failed with HTTP ${response.status}`);
    if (this.ctx?.credentials) await this.ctx.credentials.set(credentialRef(this.config.tokenRef ?? TOKEN_REF), token);
    else this.accessToken = token; // test/fallback only
    if (this.connectionSettings) await this.connectionSettings.update({ username });
    return { authenticated: true };
  }

  async localRevision(id) {
    try { return JSON.parse(await readFile(join(this.config.mirrorRoot, id, 'generated.json'), 'utf8')).revision ?? null; } catch { return null; }
  }

  async localSkills(id) {
    try {
      const generated = JSON.parse(await readFile(join(this.config.mirrorRoot, id, 'generated.json'), 'utf8'));
      return new Map((generated.skills ?? []).filter((skill) => skill && typeof skill.id === 'string' && typeof skill.sha256 === 'string').map((skill) => [skill.id, skill.sha256]));
    } catch { return new Map(); }
  }

  async onlineSpec(id) {
    const client = await this.client();
    const meta = await client.getMeta({ namespaceId: this.settings().namespaceId, name: id });
    const online = meta.data?.versions?.find((version) => version.status === 'online');
    if (!online?.version) throw new NacosAgentSpecError('NACOS_AGENTSPEC_NOT_ONLINE', `${id} has no online AgentSpec version`);
    const response = await client.getVersionSpec({ namespaceId: this.settings().namespaceId, name: id, version: online.version });
    const preset = parseSupportedManifest(response.data, Object.keys(this.config.toolProfiles), Object.keys(this.config.mcpProfiles ?? {}), agentSpecMappings(this.config));
    // Skill bodies are published separately in Nacos Skill market. Resolve them
    // server-side by locally approved names; AgentSpec content never carries bodies.
    preset.skills = await Promise.all(preset.skillReferences.map(async (skillId) => {
      const skill = await this.marketplaceSkill(skillId);
      return { id: skillId, content: skill.content, sha256: skill.sha256, revision: skill.revision };
    }));
    preset.revision ??= online.version;
    return { online, preset };
  }

  /** Discover the standalone Nacos Skill market; this is separate from AgentSpec resources. */
  async listMarketplaceSkills({ keyword = '' } = {}) {
    const client = await this.client();
    const result = await client.listAllSkills({ namespaceId: this.settings().namespaceId, pageSize: this.config.skillMarketPageSize ?? this.config.pageSize, keyword });
    const needle = keyword.trim().toLocaleLowerCase();
    const items = await Promise.all(result.items
      .filter((item) => needle === '' || `${item.name}\n${item.description ?? ''}`.toLocaleLowerCase().includes(needle))
      .map(async (item) => {
        const id = safeSkillId(item.name, 'Nacos Skill'); const local = await readLocalMarketplaceSkill(this.marketRoot, id);
        const revision = item.onlineVersion ?? item.labels?.latest ?? item.version ?? null;
        return { id, name: item.name, description: item.description ?? '', labels: item.labels ?? {}, source: item.from ?? null, scope: item.scope ?? null, enabled: item.enable === true, onlineCount: Number(item.onlineCnt ?? 0), remoteRevision: revision, downloaded: local !== undefined, localRevision: local?.revision ?? null, localHash: local?.sha256 ?? null, updateAvailable: local !== undefined && revision !== null && local.revision !== revision };
      }));
    this.status = { state: items.length ? STATUS.READY : 'ready-empty-marketplace-skills', skillMarketTotalCount: result.totalCount, skillMarketVisibleCount: items.length };
    return { items, ...this.status };
  }

  async marketplaceSkill(id) {
    const client = await this.client(); safeSkillId(id, 'Nacos Skill');
    const metadata = await client.getSkill({ namespaceId: this.settings().namespaceId, name: id });
    const online = metadata.data?.versions?.find((version) => version.status === 'online') ?? metadata.data?.versions?.find((version) => version.version === metadata.data?.onlineVersion);
    const version = online?.version ?? metadata.data?.onlineVersion ?? metadata.data?.version;
    if (!version) throw new NacosAgentSpecError('NACOS_SKILL_NOT_ONLINE', `${id} has no online Skill version`);
    const response = await client.getSkillVersion({ namespaceId: this.settings().namespaceId, name: id, version });
    try { return parseStandaloneSkill(response.data, { name: id, description: metadata.data?.description ?? '', revision: version }); }
    catch (error) {
      if (error instanceof NacosAgentSpecError && error.code === 'NACOS_SKILL_INVALID') {
        const describe = (value, depth = 0) => {
          if (depth > 2) return typeof value;
          if (Array.isArray(value)) return { array: value.length, first: value.length ? describe(value[0], depth + 1) : undefined };
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key, typeof item === 'string' ? `string(${item.length})` : describe(item, depth + 1)]));
          return typeof value;
        };
        // The signature reports only field names, value types, array sizes and
        // string lengths. It never exposes a Skill body or credential.
        const signature = JSON.stringify(describe(response.data));
        throw new NacosAgentSpecError('NACOS_SKILL_INVALID', `${id}: unsupported Nacos Skill version payload shape: ${signature}`, error);
      }
      throw error;
    }
  }

  /** Return the complete text/detail of one standalone Skill only after explicit selection. */
  async marketplaceSkillDetail(id) {
    const skill = await this.marketplaceSkill(id);
    this.status = { state: STATUS.READY, lastMarketplaceSkillDetail: skill.id };
    return { id: skill.id, name: skill.name, description: skill.description, revision: skill.revision, sha256: skill.sha256, sizeBytes: Buffer.byteLength(skill.content, 'utf8'), skillMd: skill.content, status: this.status };
  }

  /** Return one AgentSpec's online metadata, manifest and resources after explicit selection. */
  async presetDetail(id) {
    safePresetId(id);
    const client = await this.client();
    const meta = await client.getMeta({ namespaceId: this.settings().namespaceId, name: id });
    const online = meta.data?.versions?.find((version) => version.status === 'online');
    if (!online?.version) throw new NacosAgentSpecError('NACOS_AGENTSPEC_NOT_ONLINE', `${id} has no online AgentSpec version`);
    const response = await client.getVersionSpec({ namespaceId: this.settings().namespaceId, name: id, version: online.version });
    const remote = response.data;
    let manifest;
    try { manifest = typeof remote?.content === 'string' ? JSON.parse(remote.content) : undefined; } catch { manifest = undefined; }
    const resources = Object.values(remote?.resource ?? {}).map((resource) => ({ name: resource?.name ?? '', type: resource?.type ?? 'unknown', metadata: resource?.metadata ?? {}, content: typeof resource?.content === 'string' ? resource.content : '' }));
    this.status = { state: STATUS.READY, lastPresetDetail: id };
    return { id, name: remote?.name ?? id, description: remote?.description ?? meta.data?.description ?? '', revision: remote?.version ?? online.version, namespaceId: remote?.namespaceId ?? this.settings().namespaceId, metadata: meta.data ?? {}, manifest, manifestText: typeof remote?.content === 'string' ? remote.content : '', resources, status: this.status };
  }

  async downloadMarketplaceSkill(id) {
    const safeId = safeSkillId(id, 'Nacos Skill');
    return this.withPresetWrite(`market-${safeId}`, async () => {
      const skill = await this.marketplaceSkill(safeId); const local = await readLocalMarketplaceSkill(this.marketRoot, safeId);
      const upToDate = local?.revision === skill.revision && local?.sha256 === skill.sha256;
      const path = upToDate ? join(this.marketRoot, safeId) : await materializeMarketplaceSkill(this.marketRoot, skill);
      this.status = { state: STATUS.READY, lastMarketplaceSkill: safeId, upToDate };
      return { id: safeId, path, revision: skill.revision, sha256: skill.sha256, upToDate, updated: !upToDate && local !== undefined, status: this.status };
    });
  }

  /** Fetches only compact list metadata. It never fetches version content. */
  async list({ keyword = '' } = {}) {
    const client = await this.client();
    const result = await client.listAll({ namespaceId: this.settings().namespaceId, pageSize: this.config.pageSize });
    const needle = keyword.trim().toLocaleLowerCase();
    this.roster = result.items.map((item) => ({
      id: item.name,
      name: item.name,
      description: item.description ?? '',
      labels: item.labels ?? {},
      scope: item.scope,
      enabled: item.enable === true,
      onlineCount: Number(item.onlineCnt ?? 0),
      downloaded: false,
      localRevision: null,
      remoteRevision: item.onlineVersion ?? item.version ?? null,
      skillCount: 0,
      mcpProfileCount: 0,
    })).filter((item) => needle === '' || `${item.name}\n${item.description}`.toLocaleLowerCase().includes(needle));
    await Promise.all(this.roster.map(async (row) => {
      row.localRevision = await this.localRevision(row.id);
      row.downloaded = row.localRevision !== null;
      // Only already-downloaded rows need a detail metadata request to expose
      // Update. New rows remain list-only until the user presses Download.
      if (row.downloaded) {
        const meta = await client.getMeta({ namespaceId: this.settings().namespaceId, name: row.id });
        row.remoteRevision = meta.data?.versions?.find((version) => version.status === 'online')?.version ?? row.remoteRevision;
      }
      row.updateAvailable = row.downloaded && row.remoteRevision !== null && row.remoteRevision !== row.localRevision;
    }));
    this.status = { state: 'listed', totalCount: result.totalCount, visibleCount: this.roster.length };
    return { items: this.roster, ...this.status };
  }

  /** Lists only Skill metadata after an explicit user selection. */
  async listSkills(id) {
    safePresetId(id);
    const { preset } = await this.onlineSpec(id);
    const local = await Promise.all(preset.skills.map(async (skill) => [skill.id, (await readLocalSkill(this.config.mirrorRoot, id, skill.id))?.sha256]));
    const items = preset.skills.map((skill) => skillSummary(skill, preset.revision, new Map(local).get(skill.id)));
    this.status = { state: items.length ? STATUS.READY : 'ready-empty-skills', lastSkillList: id, skillCount: items.length };
    return { id, remoteRevision: preset.revision ?? null, items, ...this.status };
  }

  /** Download or update exactly one declared Skill, without creating a session. */
  async downloadSkill(id, skillId) {
    safePresetId(id);
    return this.withPresetWrite(id, async () => {
      const { preset } = await this.onlineSpec(id);
      const skill = preset.skills.find((item) => item.id === skillId);
      if (!skill) throw new NacosAgentSpecError('NACOS_AGENTSPEC_SKILL_NOT_DECLARED', `${id}: Skill ${String(skillId)} is not declared by the current online AgentSpec`);
      const local = await readLocalSkill(this.config.mirrorRoot, id, skill.id);
      const upToDate = local?.revision === (preset.revision ?? null) && local?.sha256 === skill.sha256;
      const path = upToDate ? join(this.config.mirrorRoot, id, 'skills', skill.id) : await materializeSkill(this.config.mirrorRoot, preset, skill);
      const item = skillSummary(skill, preset.revision, local?.sha256);
      const status = { state: STATUS.READY, lastDownloadedSkill: skill.id, lastSkillPreset: id, upToDate };
      this.status = status;
      return { id, path, skill: { ...item, downloaded: true, localHash: skill.sha256, updateAvailable: false }, updated: !upToDate && local !== undefined, upToDate, status };
    });
  }

  /** Download/update every declared Skill as one atomic Skill generation. */
  async downloadSkills(id) {
    safePresetId(id);
    return this.withPresetWrite(id, async () => {
      const { preset } = await this.onlineSpec(id);
      const local = new Map(await Promise.all(preset.skills.map(async (skill) => [skill.id, (await readLocalSkill(this.config.mirrorRoot, id, skill.id))?.sha256])));
      const before = preset.skills.map((skill) => skillSummary(skill, preset.revision, local.get(skill.id)));
      const allCurrent = before.every((skill) => skill.downloaded && !skill.updateAvailable);
      const path = allCurrent ? join(this.config.mirrorRoot, id, 'skills') : await materializeSkills(this.config.mirrorRoot, preset);
      const items = before.map((skill) => ({ ...skill, downloaded: true, localHash: skill.sha256, updateAvailable: false, outcome: allCurrent || skill.downloaded ? 'up-to-date' : 'downloaded' }));
      const status = { state: preset.skills.length ? STATUS.READY : 'ready-empty-skills', lastDownloadedSkills: id, skillCount: items.length, upToDate: allCurrent };
      this.status = status;
      return { id, path, remoteRevision: preset.revision ?? null, items, upToDate: allCurrent, status };
    });
  }

  /** Downloads and compiles exactly one online AgentSpec after user selection. */
  async download(id) {
    safePresetId(id);
    return this.withPresetWrite(id, async () => {
      const { online, preset } = await this.onlineSpec(id);
      const path = await materializePreset(this.config.mirrorRoot, preset, this.config.toolProfiles, this.config.mcpProfiles ?? {});
      const row = this.roster.find((item) => item.id === id);
      if (row) { row.downloaded = true; row.skillCount = preset.skills.length; row.mcpProfileCount = preset.mcpProfiles.length; }
      this.status = { state: STATUS.READY, downloadedPresetCount: (this.status.downloadedPresetCount ?? 0) + 1, lastDownloaded: id, lastDownloadedSkillCount: preset.skills.length, lastDownloadedMcpProfiles: preset.mcpProfiles };
      return { id, path, version: online.version, skillCount: preset.skills.length, mcpProfiles: preset.mcpProfiles, status: this.status };
    });
  }
}

/**
 * Source-mode Typert service. The gateway discovers the visible binding and
 * method descriptors without generated DSH source changes.
 */
export class NacosAgentSpecRemote extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, 'nacosAgentSpecs');
    this.ctx = ctx;
    this.config = config;
    this.connectionSettings = ctx.settings.register(CONNECTION_NAMESPACE, CONNECTION_SETTINGS, { base: { serverUrl: config.serverUrl ?? '', username: '', namespaceId: config.namespaceId ?? 'public', apiPlane: config.apiPlane ?? 'console' } });
    this.policySettings = ctx.settings.register(POLICY_NAMESPACE, LOCAL_POLICY_SETTINGS, { base: { toolProfilesJson: '', agentSpecMappingsJson: '' } });
    this.browser = new NacosAgentSpecBrowser(config, { ctx, connectionSettings: this.connectionSettings });
  }
  effectivePolicy() {
    const stored = this.policySettings.get();
    const toolProfiles = parsePolicyObject(stored.toolProfilesJson, 'Tool profiles') ?? this.config.toolProfiles ?? {};
    const mappings = parsePolicyObject(stored.agentSpecMappingsJson, 'AgentSpec mappings') ?? this.config.agentSpecMappings ?? {};
    return { toolProfiles, mappings, stored };
  }
  async policy() {
    const { toolProfiles, mappings, stored } = this.effectivePolicy();
    return { toolProfilesJson: stored.toolProfilesJson || JSON.stringify(toolProfiles, null, 2), agentSpecMappingsJson: stored.agentSpecMappingsJson || JSON.stringify(mappings, null, 2), profileNames: Object.keys(toolProfiles), mappingNames: Object.keys(mappings) };
  }
  async savePolicy(toolProfilesJson, agentSpecMappingsJson) {
    const toolProfiles = parsePolicyObject(toolProfilesJson, 'Tool profiles');
    const mappings = parsePolicyObject(agentSpecMappingsJson, 'AgentSpec mappings');
    for (const [name, rows] of Object.entries(toolProfiles ?? {})) {
      if (!Array.isArray(rows)) throw new NacosAgentSpecError('NACOS_AGENTSPEC_POLICY_INVALID', `Tool profile ${name} must be an array of Cordis loader rows`);
    }
    await this.policySettings.update({ toolProfilesJson, agentSpecMappingsJson });
    return this.policy();
  }
  async connection() {
    const value = this.connectionSettings.get();
    const info = await this.ctx.credentials.describe(credentialRef(this.browser.config.tokenRef ?? TOKEN_REF));
    return { serverUrl: value.serverUrl, username: value.username, namespaceId: value.namespaceId, apiPlane: value.apiPlane, tokenConfigured: info.configured, tokenSource: info.source ?? null, tokenWritable: info.writable };
  }
  async saveConnection(serverUrl, username, namespaceId, apiPlane) {
    if (typeof serverUrl !== 'string' || typeof username !== 'string' || typeof namespaceId !== 'string' || !['console', 'admin'].includes(apiPlane)) throw new NacosAgentSpecError('NACOS_AGENTSPEC_CONNECTION_INVALID', 'Invalid Nacos connection configuration');
    // normalizeBaseUrl inside the client validates protocol and rejects malformed URLs.
    new NacosAgentSpecClient({ serverUrl, accessToken: 'validation-only', apiPlane });
    await this.connectionSettings.update({ serverUrl, username, namespaceId, apiPlane });
    return this.connection();
  }
  applyPolicy() { const { toolProfiles, mappings } = this.effectivePolicy(); this.browser.config.toolProfiles = toolProfiles; this.browser.config.agentSpecMappings = mappings; }
  async clearAuthentication() { await this.ctx.credentials.unset(credentialRef(this.browser.config.tokenRef ?? TOKEN_REF)); return this.connection(); }
  async signIn(username, password) { return this.browser.signIn(username, password); }
  async list(keyword) { this.applyPolicy(); return this.browser.list({ keyword: typeof keyword === 'string' ? keyword : '' }); }
  async download(id) { this.applyPolicy();
    if (typeof id !== 'string' || id.length === 0) throw new NacosAgentSpecError('NACOS_AGENTSPEC_INVALID_ID', 'A preset id is required');
    return this.browser.download(id);
  }
  async listSkills(id) { this.applyPolicy(); return this.browser.listSkills(id); }
  async listMarketplaceSkills(keyword) { return this.browser.listMarketplaceSkills({ keyword: typeof keyword === 'string' ? keyword : '' }); }
  async marketplaceSkillDetail(id) { return this.browser.marketplaceSkillDetail(id); }
  async presetDetail(id) { this.applyPolicy(); return this.browser.presetDetail(id); }
  async downloadMarketplaceSkill(id) { return this.browser.downloadMarketplaceSkill(id); }
  async downloadSkill(id, skillId) { this.applyPolicy(); return this.browser.downloadSkill(id, skillId); }
  async downloadSkills(id) { this.applyPolicy(); return this.browser.downloadSkills(id); }
  async status() { return this.browser.status; }
}
Object.defineProperty(NacosAgentSpecRemote.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', { value: Object.freeze({ version: 1, methods: Object.freeze([
  Object.freeze({ method: 'connection', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'policy', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'savePolicy', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'saveConnection', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'clearAuthentication', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'signIn', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'list', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'download', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'listSkills', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'listMarketplaceSkills', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'marketplaceSkillDetail', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'presetDetail', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'downloadMarketplaceSkill', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'downloadSkill', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'downloadSkills', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'status', invocation: Object.freeze({ kind: 'direct' }) }),
]) }) });

/** No startup network work. The visible Remote service only fetches on list/download. */
export function apply(ctx, config) {
  return new NacosAgentSpecRemote(ctx, config);
}

export { NacosAgentSpecClient, NacosAgentSpecError, STATUS } from './core.js';
