import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NacosAgentSpecClient, NacosAgentSpecError, materializePreset, parseSupportedManifest, publishMirror } from '../src/core.js';
import { NacosAgentSpecBrowser } from '../src/index.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json', ...headers } });

test('admin list paginates all AgentSpec summaries', async () => {
  const seen = [];
  const client = new NacosAgentSpecClient({
    serverUrl: 'http://nacos.example', accessToken: 'secret', apiPlane: 'console',
    fetchImpl: async (url) => {
      seen.push(url.toString());
      const page = Number(url.searchParams.get('pageNo'));
      return json({ totalCount: 2, pageNumber: page, pagesAvailable: 2, pageItems: [{ name: `preset-${page}`, enable: true, onlineCnt: 1 }] });
    },
  });
  const result = await client.listAll({ pageSize: 1 });
  assert.equal(result.items.length, 2);
  assert.match(seen[0], /\/v3\/console\/ai\/agentspecs\/list/);
  assert.match(seen[0], /namespaceId=public/);
});

test('route absence fails closed with stable endpoint code', async () => {
  const client = new NacosAgentSpecClient({ serverUrl: 'http://nacos.example', fetchImpl: async () => new Response('caused: No static resource v3/client/ai/agentspecs.;', { status: 500 }) });
  await assert.rejects(() => client.getRuntimeSpec({ name: 'valid-id' }), (error) => error instanceof NacosAgentSpecError && error.code === 'NACOS_AGENTSPEC_ENDPOINT_UNAVAILABLE');
});

test('generic Nacos resources compile only through local DSH mappings', () => {
  const mapping = { reviewer: { displayName: 'Reviewer', toolProfile: 'readonly', instructionResources: ['AGENTS.md'], skillReferences: ['guide'] } };
  const spec = parseSupportedManifest({ name: 'reviewer', description: 'Review code', content: JSON.stringify({ version: '1.0' }), resource: { agents: { name: 'AGENTS.md', type: 'config', content: 'Review safely.' } } }, ['readonly'], [], mapping);
  assert.equal(spec.id, 'reviewer');
  assert.deepEqual(spec.skillReferences, ['guide']);
  const rootZipResponse = parseSupportedManifest({ name: 'senior-developer', resources: { AGENTS_md: { name: 'AGENTS.md', type: '', content: 'Root ZIP imported Nacos instructions.' } } }, ['readonly'], [], { 'senior-developer': { toolProfile: 'readonly', instructionResources: ['AGENTS.md'] } });
  assert.equal(rootZipResponse.systemPrompt, '# AGENTS.md\nRoot ZIP imported Nacos instructions.');
  assert.throws(() => parseSupportedManifest({ name: 'reviewer', content: '{}' }, ['readonly']), /requires a 1\.\.65536/);
  assert.throws(() => parseSupportedManifest({ name: '../escape', content: '{}' }, ['readonly']), /safe DSH preset id/);
});

test('browser makes no Nacos request until the user opens the list', async () => {
  let calls = 0;
  const root = await mkdtemp(join(tmpdir(), 'nacos-browser-'));
  try {
    const browser = new NacosAgentSpecBrowser({ serverUrl: 'http://nacos.example', accessTokenEnv: 'TOKEN', namespaceId: 'public', apiPlane: 'console', mirrorRoot: root, timeoutMs: 100, pageSize: 100, toolProfiles: { readonly: [], 'coding-safe': [] } }, { getenv: () => 'token', fetch: async () => { calls++; return json({ totalCount: 0, pageNumber: 1, pagesAvailable: 1, pageItems: [] }); } });
    assert.equal(calls, 0);
    await browser.list();
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('materializing one preset writes only that preset directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nacos-one-'));
  try {
    await materializePreset(root, { id: 'reviewer', name: 'Reviewer', description: '', systemPrompt: 'Review safely.', toolProfile: 'readonly', revision: 'v1' }, { readonly: [] });
    assert.match(await readFile(join(root, 'reviewer', 'agent.cordis.yml'), 'utf8'), /dsh-persona/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resolved standalone Skills and local MCP profiles compile safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nacos-skill-mcp-'));
  try {
    const preset = parseSupportedManifest({
      name: 'developer', version: 'v2', content: JSON.stringify({ version: 'v2' }),
      resource: { agents: { name: 'AGENTS.md', type: 'config', content: 'Use selected capabilities.' } },
    }, ['readonly'], ['catalog'], { developer: { toolProfile: 'readonly', instructionResources: ['AGENTS.md'], skillReferences: ['nacos-guide'], mcpProfiles: ['catalog'] } });
    preset.skills = [{ id: 'nacos-guide', content: '---\nname: nacos-guide\ndescription: Nacos guide\n---\nUse the approved workflow.', sha256: 'test' }];
    await materializePreset(root, preset, { readonly: [] }, { catalog: [{ id: 'mcp-catalog', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'catalog', transport: 'streamable-http', url: 'https://mcp.example/mcp', headers: {} } }] });
    const directory = join(root, 'developer');
    assert.match(await readFile(join(directory, 'skills', 'nacos-guide', 'SKILL.md'), 'utf8'), /approved workflow/);
    const composition = await readFile(join(directory, 'agent.cordis.yml'), 'utf8');
    assert.doesNotMatch(composition, /dsh-skill-filesystem/);
    assert.doesNotMatch(composition, /dsh-tool-skill/);
    assert.match(composition, /dsh-mcp-client/);
    const generated = await readFile(join(directory, 'generated.json'), 'utf8');
    assert.match(generated, /nacos-guide/);
    assert.match(generated, /catalog/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unsafe or unapproved local mapping choices fail closed', () => {
  const resource = { agents: { name: 'AGENTS.md', type: 'config', content: 'Review safely.' } };
  const make = () => ({ name: 'reviewer', content: '{}', resource });
  assert.throws(() => parseSupportedManifest(make(), ['readonly'], [], { reviewer: { toolProfile: 'readonly', instructionResources: ['AGENTS.md'], skillReferences: ['../escape'] } }), /skill id/);
  assert.throws(() => parseSupportedManifest(make(), ['readonly'], ['catalog'], { reviewer: { toolProfile: 'readonly', instructionResources: ['AGENTS.md'], mcpProfiles: ['arbitrary-server'] } }), /unapproved locally mapped MCP profile/);
});

test('Skill APIs fetch version only on demand and download/update selected resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nacos-skill-api-'));
  const calls = [];
  const agent = { name: 'reviewer', version: 'v1', content: JSON.stringify({ version: 'v1' }), resource: { agents: { name: 'AGENTS.md', type: 'config', content: 'Review safely.' } } };
  const standaloneSkill = { name: 'review-guide', description: 'Review guide', skillMd: '---\nname: review-guide\ndescription: Review guide\n---\nReview safely.' };
  try {
    const browser = new NacosAgentSpecBrowser({ serverUrl: 'http://nacos.example', accessTokenEnv: 'TOKEN', namespaceId: 'public', apiPlane: 'console', mirrorRoot: root, timeoutMs: 100, pageSize: 100, toolProfiles: { readonly: [] }, agentSpecMappings: { reviewer: { toolProfile: 'readonly', instructionResources: ['AGENTS.md'], skillReferences: ['review-guide'] } } }, { getenv: () => 'token', fetch: async url => {
      calls.push(url.pathname);
      if (url.pathname.includes('/ai/skills/') && url.pathname.endsWith('/version')) return json(standaloneSkill);
      if (url.pathname.includes('/ai/skills')) return json({ versions: [{ version: 'v1', status: 'online' }], description: 'Review guide' });
      if (url.pathname.endsWith('/list')) return json({ totalCount: 1, pageNumber: 1, pagesAvailable: 1, pageItems: [{ name: 'reviewer', enable: true, onlineCnt: 1 }] });
      if (url.pathname.endsWith('/version')) return json(agent);
      return json({ versions: [{ version: 'v1', status: 'online' }] });
    } });
    await browser.list();
    assert.equal(calls.filter(path => path.endsWith('/version')).length, 0);
    const listed = await browser.listSkills('reviewer');
    assert.deepEqual(listed.items.map(({ id, sizeBytes }) => ({ id, sizeBytes })), [{ id: 'review-guide', sizeBytes: Buffer.byteLength(standaloneSkill.skillMd) }]);
    assert.equal(Object.hasOwn(listed.items[0], 'content'), false);
    const first = await browser.downloadSkill('reviewer', 'review-guide');
    assert.equal(first.upToDate, false);
    assert.match(await readFile(join(root, 'reviewer', 'skills', 'review-guide', 'SKILL.md'), 'utf8'), /Review safely/);
    const second = await browser.downloadSkill('reviewer', 'review-guide');
    assert.equal(second.upToDate, true);
    const all = await browser.downloadSkills('reviewer');
    assert.equal(all.upToDate, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('mirror publishing creates complete generated preset atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nacos-mirror-'));
  const target = join(root, 'mirror');
  try {
    await publishMirror(target, [{ id: 'reviewer', name: 'Reviewer', description: 'Review code', systemPrompt: 'Review safely.', toolProfile: 'readonly', revision: 'v1' }], { readonly: [{ id: 'read', name: '@deepseek-ai/dsh-tool-fs' }] });
    assert.match(await readFile(join(target, 'reviewer', 'agent.cordis.yml'), 'utf8'), /dsh-persona/);
    assert.match(await readFile(join(target, 'manifest.json'), 'utf8'), /presetCount/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
