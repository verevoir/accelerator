import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolHost } from '../src/permissions.js';
import { resolveSourceUrls } from '../src/source-selection.js';
import { registerSourceTools } from '../src/tools/source.js';
import { composeInstructions, resolveManifest, type ManifestResolution } from '../src/manifest.js';

vi.mock('../src/manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/manifest.js')>();
  return { ...actual, resolveManifest: vi.fn(actual.resolveManifest) };
});
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const tools: Record<string, Handler> = {};
registerSourceTools({
  registerTool(name: string, _config: unknown, handler: Handler) {
    tools[name] = handler;
  },
} as unknown as ToolHost);
let root: string;
let core: string;
let schema: string;
let manifest: ManifestResolution;
beforeEach(() => {
  vi.stubEnv('ACCELERATOR_TOOLS', 'read');
  root = realpathSync(mkdtempSync(join(tmpdir(), 'accelerator-sets-')));
  core = join(root, 'repositories/core');
  schema = join(root, 'repositories/schema');
  mkdirSync(core, { recursive: true });
  mkdirSync(schema);
  writeFileSync(join(root, 'repositories/README.md'), 'not a source');
  writeFileSync(
    join(core, 'index.ts'),
    "import { threeWayMerge } from 'schema';\nexport function runSync() { return threeWayMerge(); }"
  );
  writeFileSync(join(schema, 'index.ts'), 'export function threeWayMerge() { return 42; }');
  manifest = {
    sourcePath: join(root, 'verevoir-mcp.json'),
    manifest: { sourceSets: { leafset: 'repositories/*' } },
  };
  vi.mocked(resolveManifest).mockReturnValue(manifest);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(resolveManifest).mockReset();
  rmSync(root, { recursive: true, force: true });
});

it('expands sorted directories relative to the manifest independently of process cwd, ignoring files', () => {
  expect(resolveSourceUrls({ sourceSet: 'leafset' }, manifest)).toEqual([core, schema]);
});

it('combines relative paths, file URLs, and remote sources in declared order without duplicates', () => {
  manifest.manifest.sourceSets = {
    mixed: [
      'repositories/schema',
      pathToFileURL(core).href,
      'https://gitlab.com/group/project',
      'repositories/schema',
    ],
  };
  expect(resolveSourceUrls({ sourceSet: 'mixed' }, manifest)).toEqual([
    schema,
    core,
    'https://gitlab.com/group/project',
  ]);
});

it.each(['grep', 'find_symbol', 'code_graph'])(
  '%s over a named set matches the explicit repository list',
  async (tool) => {
    const query = { pattern: 'threeWayMerge', name: 'threeWayMerge', symbol: 'threeWayMerge' };
    expect(await tools[tool]({ sourceSet: 'leafset', ...query })).toEqual(
      await tools[tool]({ sourceUrls: [core, schema], ...query })
    );
  }
);

it('resolves the cross-repository call through a named set', async () => {
  const result = await tools.code_graph({ sourceSet: 'leafset', symbol: 'runSync' });
  expect(result.content[0].text).toContain(`calls: [${schema}] threeWayMerge`);
});

it('keeps source-labelled graph rendering for a singleton named set', async () => {
  manifest.manifest.sourceSets = { only: 'repositories/schema' };
  expect(await tools.code_graph({ sourceSet: 'only', symbol: 'threeWayMerge' })).toEqual(
    await tools.code_graph({ sourceUrls: [schema], symbol: 'threeWayMerge' })
  );
});

it.each([
  [{}, 'exactly one'],
  [{ sourceSet: 'leafset', sourceUrl: '/a' }, 'exactly one'],
  [{ sourceSet: 'leafset', sourceUrls: ['/a'] }, 'exactly one'],
  [{ sourceSet: '' }, 'nonblank'],
  [{ sourceSet: 'missing' }, 'Unknown source set'],
  [{ sourceSet: 'toString' }, 'Unknown source set'],
])('rejects invalid source selection %j', (selection, message) => {
  expect(() => resolveSourceUrls(selection, manifest)).toThrow(message);
});

it.each([
  [[], 'nonempty'],
  [[''], 'nonblank'],
  [[3], 'nonblank'],
  [null, 'nonempty'],
  ['repositories/missing/*', 'source set'],
  ['repositories/README.md', 'directory'],
  ['repositories/**', 'Only'],
  ['repositories/*/nested', 'Only'],
])('rejects malformed or unexpandable set %j', (value, message) => {
  manifest.manifest.sourceSets = { broken: value } as never;
  expect(() => resolveSourceUrls({ sourceSet: 'broken' }, manifest)).toThrow(message);
});

it('rejects a glob with no directories instead of silently querying nothing', () => {
  mkdirSync(join(root, 'empty'));
  manifest.manifest.sourceSets = { empty: 'empty/*' };
  expect(() => resolveSourceUrls({ sourceSet: 'empty' }, manifest)).toThrow(
    'matched no directories'
  );
});

it('reports unknown sets without a discovered manifest', () => {
  expect(() => resolveSourceUrls({ sourceSet: 'leafset' }, null)).toThrow('Unknown source set');
});

it('loads source sets from the selected manifest file even with a different discovery cwd', async () => {
  writeFileSync(manifest.sourcePath, JSON.stringify(manifest.manifest));
  const actual = await vi.importActual<typeof import('../src/manifest.js')>('../src/manifest.js');
  const loaded = actual.resolveManifest(
    ['node', 'bin', '--manifest', manifest.sourcePath],
    '/unrelated'
  );
  expect(resolveSourceUrls({ sourceSet: 'leafset' }, loaded)).toEqual([core, schema]);
});

it('advertises named sets even without a Notion record', () => {
  expect(composeInstructions('base', manifest.manifest)).toBe(
    'base\n\nNamed source sets: "leafset". Pass sourceSet to code_graph, grep, or find_symbol instead of sourceUrl/sourceUrls.'
  );
});

it('does not load the manifest for an explicit URL selection', () => {
  vi.mocked(resolveManifest).mockImplementation(() => {
    throw new Error('broken manifest');
  });
  expect(resolveSourceUrls({ sourceUrls: [core] })).toEqual([core]);
});

it('validates mixed selectors before consulting the manifest', () => {
  vi.mocked(resolveManifest).mockImplementation(() => {
    throw new Error('broken manifest');
  });
  expect(() => resolveSourceUrls({ sourceUrl: core, sourceSet: 'leafset' })).toThrow('exactly one');
});

it('supports source sets through the pi registration seam', async () => {
  const { default: install } = await import('../src/pi.js');
  const registered: import('../src/pi.js').PiToolDefinition[] = [];
  install({ registerTool: (tool) => registered.push(tool), on: () => {} });
  const graph = registered.find((tool) => tool.name === 'code_graph')!;
  const result = await graph.execute('query', { sourceSet: 'leafset', symbol: 'runSync' });
  expect(result.content[0].text).toContain(`calls: [${schema}] threeWayMerge`);
});

it.each([null, [], 'invalid'])('rejects malformed sourceSets collections %j', (sets) => {
  manifest.manifest.sourceSets = sets as never;
  expect(() => resolveSourceUrls({ sourceSet: 'leafset' }, manifest)).toThrow('Unknown source set');
});

it('includes symlinks to directories in wildcard source sets', () => {
  const alias = join(root, 'repositories/link');
  symlinkSync(core, alias, 'dir');
  expect(resolveSourceUrls({ sourceSet: 'leafset' }, manifest)).toEqual([core, alias, schema]);
});

it('rejects remote glob patterns', () => {
  manifest.manifest.sourceSets = { remote: 'https://gitlab.com/group/*' };
  expect(() => resolveSourceUrls({ sourceSet: 'remote' }, manifest)).toThrow('Remote source globs');
});

it.each(['repositories/core', 'repositories/*'])(
  'treats the manifest directory literally when resolving %s',
  (entry) => {
    const base = join(root, 'workspace[1]');
    const nestedCore = join(base, 'repositories/core');
    mkdirSync(nestedCore, { recursive: true });
    const nestedManifest = {
      sourcePath: join(base, 'verevoir-mcp.json'),
      manifest: { sourceSets: { literal: entry } },
    };
    expect(resolveSourceUrls({ sourceSet: 'literal' }, nestedManifest)).toEqual([nestedCore]);
  }
);
