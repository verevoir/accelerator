import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as router from '../src/router.js';
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
let outside: string;
let core: string;
let schema: string;
let manifest: ManifestResolution;
beforeEach(() => {
  vi.stubEnv('ACCELERATOR_TOOLS', 'read');
  root = realpathSync(mkdtempSync(join(tmpdir(), 'accelerator-sets-')));
  outside = root + '-outside';
  mkdirSync(join(outside, 'child'), { recursive: true });
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(resolveManifest).mockReset();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

it('expands sorted directories relative to the manifest independently of process cwd, ignoring files', () => {
  expect(resolveSourceUrls({ sourceSet: 'leafset' }, manifest)).toEqual([core, schema]);
});

it('combines relative paths and remote sources in declared order without duplicates', () => {
  manifest.manifest.sourceSets = {
    mixed: [
      'repositories/schema',
      'repositories/core',
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
  const shared = join(root, 'shared');
  mkdirSync(shared);
  symlinkSync(shared, alias, 'dir');
  expect(resolveSourceUrls({ sourceSet: 'leafset' }, manifest)).toEqual([core, schema, shared]);
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

function boundedSet(kind: string, count: number): string[] {
  const sources = Array.from({ length: count }, (_, index) =>
    kind === 'explicit'
      ? `https://gitlab.com/group/repo-${index}`
      : join(root, 'bounded', `repo-${String(index).padStart(3, '0')}`)
  );
  if (kind === 'wildcard') {
    for (const source of sources) mkdirSync(source, { recursive: true });
  }
  manifest.manifest.sourceSets = { bounded: kind === 'explicit' ? sources : 'bounded/*' };
  return sources;
}

it.each(['explicit', 'wildcard'])('accepts exactly 100 sources in a %s set', (kind) => {
  const sources = boundedSet(kind, 100);
  expect(resolveSourceUrls({ sourceSet: 'bounded' }, manifest)).toEqual(sources);
});

it.each(
  ['explicit', 'wildcard'].flatMap((kind) =>
    ['grep', 'find_symbol', 'code_graph'].map((tool) => [kind, tool])
  )
)('rejects a 101-source %s set before %s routes any source', async (kind, tool) => {
  boundedSet(kind, 101);
  const adapter = vi.spyOn(router, 'pickSourceAdapter').mockImplementation(() => {
    throw new Error('oversized sets must not route sources');
  });
  await expect(
    tools[tool]({ sourceSet: 'bounded', pattern: 'needle', name: 'needle', symbol: 'needle' })
  ).rejects.toThrow('Select at most 100 sources per call.');
  expect(adapter).not.toHaveBeenCalled();
});

it('advertises multiple named sets in sorted order', () => {
  expect(composeInstructions('base', { sourceSets: { zeta: 'z', alpha: 'a' } })).toBe(
    'base\n\nNamed source sets: "alpha", "zeta". Pass sourceSet to code_graph, grep, or find_symbol instead of sourceUrl/sourceUrls.'
  );
});

it.each([['leafset'], [], 'leafset', 42].map((sourceSets) => ({ sourceSets })))(
  'does not advertise malformed sets %j',
  ({ sourceSets }) => {
    expect(composeInstructions('base', { sourceSets } as never)).toBe('base');
  }
);

it.each(['absolute', 'file URL', 'parent', 'symlink', 'glob target', 'glob root'])(
  'rejects an escaping %s source set before routing',
  async (kind) => {
    symlinkSync(outside, join(root, 'repositories/escape'), 'dir');
    const entries: Record<string, string> = {
      absolute: outside,
      'file URL': pathToFileURL(outside).href,
      parent: `../${basename(outside)}`,
      symlink: 'repositories/escape',
      'glob target': 'repositories/*',
      'glob root': 'repositories/escape/*',
    };
    manifest.manifest.sourceSets = { escape: entries[kind] };
    const adapter = vi.spyOn(router, 'pickSourceAdapter').mockImplementation(() => {
      throw new Error('unsafe source must not be routed');
    });
    await expect(tools.grep({ sourceSet: 'escape', pattern: 'secret' })).rejects.toThrow(
      /relative local paths|outside the manifest directory/
    );
    expect(adapter).not.toHaveBeenCalled();
  }
);

it.each(['absolute', 'file URL'])(
  'requires relative configuration even for an internal %s',
  (kind) => {
    manifest.manifest.sourceSets = {
      internal: kind === 'absolute' ? core : pathToFileURL(core).href,
    };
    expect(() => resolveSourceUrls({ sourceSet: 'internal' }, manifest)).toThrow(
      'relative local paths'
    );
  }
);

it('keeps explicit source selectors independent of manifest containment', () => {
  expect(
    resolveSourceUrls({ sourceUrls: [outside, pathToFileURL(outside).href] }, manifest)
  ).toEqual([outside, pathToFileURL(outside).href]);
});
