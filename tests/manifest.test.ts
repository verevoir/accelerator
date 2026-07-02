import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  manifestPath,
  loadManifest,
  resolveManifest,
  extractAgentsMdBlock,
  renderProjectDoctrine,
  composeInstructions,
  type AigencyManifest,
} from '../src/manifest.js';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
const FIXTURE_AIGENCY = join(FIXTURES_DIR, 'aigency.json');
const FIXTURE_AGENTS_MD = join(FIXTURES_DIR, 'AGENTS.md');
const FIXTURE_AGENTS_MD_NO_BLOCK = join(FIXTURES_DIR, 'AGENTS-no-block.md');
const FIXTURE_AGENTS_MD_BAD_JSON = join(FIXTURES_DIR, 'AGENTS-bad-json.md');
const EMPTY_DIR = join(FIXTURES_DIR, 'empty-dir');

// ---------------------------------------------------------------------------
// extractAgentsMdBlock
// ---------------------------------------------------------------------------
describe('extractAgentsMdBlock', () => {
  it('extracts the body of a verevoir-mcp fenced block', () => {
    const md = [
      '## Context',
      '',
      'Some prose.',
      '',
      '```verevoir-mcp',
      '{ "notion": {} }',
      '```',
    ].join('\n');
    expect(extractAgentsMdBlock(md)).toBe('{ "notion": {} }\n');
  });

  it('returns null when no verevoir-mcp fence is present', () => {
    const md = ['## Context', '', '```json', '{ "x": 1 }', '```'].join('\n');
    expect(extractAgentsMdBlock(md)).toBeNull();
  });

  it('returns null when the opening fence has no matching close', () => {
    const md = ['```verevoir-mcp', '{ "notion": {} }'].join('\n');
    expect(extractAgentsMdBlock(md)).toBeNull();
  });

  it('ignores unrelated fenced blocks before the verevoir-mcp block', () => {
    const md = [
      '```bash',
      'echo hello',
      '```',
      '',
      '```verevoir-mcp',
      '{ "governance": [] }',
      '```',
    ].join('\n');
    expect(extractAgentsMdBlock(md)).toBe('{ "governance": [] }\n');
  });

  it('handles tilde fences', () => {
    const md = ['~~~verevoir-mcp', '{ "notion": {} }', '~~~'].join('\n');
    expect(extractAgentsMdBlock(md)).toBe('{ "notion": {} }\n');
  });

  it('handles info-string with trailing content after verevoir-mcp', () => {
    // e.g. ```verevoir-mcp json
    const md = ['```verevoir-mcp json', '{ "notion": {} }', '```'].join('\n');
    expect(extractAgentsMdBlock(md)).toBe('{ "notion": {} }\n');
  });
});

// ---------------------------------------------------------------------------
// manifestPath (legacy shim — kept for backward-compatibility)
// ---------------------------------------------------------------------------
describe('manifestPath', () => {
  it('prefers an explicit --manifest arg (resolved to absolute)', () => {
    const p = manifestPath(['node', 'bin.js', '--manifest', '/srv/proj/aigency.json'], '/wherever');
    expect(p).toBe('/srv/proj/aigency.json');
  });

  it('falls back to aigency.json in the working directory when no files present', () => {
    expect(manifestPath(['node', 'bin.js'], EMPTY_DIR)).toBe(join(EMPTY_DIR, 'aigency.json'));
  });

  it('returns the winning source path when candidates are present in cwd', () => {
    // FIXTURES_DIR has aigency.json — that wins as the last-resort fallback
    // (no AGENTS.md or verevoir-mcp.json there, only aigency.json)
    const p = manifestPath(['node', 'bin.js'], FIXTURES_DIR);
    expect(p).toContain('fixtures');
  });

  it('throws when --manifest has no following value (rather than silently falling back)', () => {
    expect(() => manifestPath(['node', 'bin.js', '--manifest'], '/srv/proj')).toThrow(
      '--manifest requires a path'
    );
  });

  it('throws when --manifest is followed by another flag', () => {
    expect(() => manifestPath(['node', 'bin.js', '--manifest', '--verbose'], '/srv/proj')).toThrow(
      '--manifest requires a path'
    );
  });
});

// ---------------------------------------------------------------------------
// resolveManifest — precedence
// ---------------------------------------------------------------------------
describe('resolveManifest precedence', () => {
  it('explicit --manifest beats AGENTS.md, verevoir-mcp.json, and aigency.json', () => {
    // Point --manifest directly at the aigency.json fixture (within a dir
    // that also has AGENTS.md and verevoir-mcp.json if they existed).
    const res = resolveManifest(['node', 'bin.js', '--manifest', FIXTURE_AIGENCY], FIXTURES_DIR);
    expect(res?.sourcePath).toBe(FIXTURE_AIGENCY);
    expect(res?.manifest?.notion?.databases?.['work_tracker']).toBe(
      'aaaa1111-2222-3333-4444-555566667777'
    );
  });

  it('AGENTS.md with a valid verevoir-mcp block beats verevoir-mcp.json and aigency.json', () => {
    // agents-dir has AGENTS.md + verevoir-mcp.json + aigency.json
    const agentsDir = join(FIXTURES_DIR, 'agents-dir');
    const res = resolveManifest(['node', 'bin.js'], agentsDir);
    expect(res?.sourcePath).toBe(join(agentsDir, 'AGENTS.md'));
    expect(res?.manifest?.notion?.databases?.['work_tracker']).toBe('agents-tracker-id');
  });

  it('verevoir-mcp.json beats aigency.json when no AGENTS.md block', () => {
    // vmcp-dir has verevoir-mcp.json + aigency.json but no AGENTS.md
    const vmcpDir = join(FIXTURES_DIR, 'vmcp-dir');
    const res = resolveManifest(['node', 'bin.js'], vmcpDir);
    expect(res?.sourcePath).toBe(join(vmcpDir, 'verevoir-mcp.json'));
    expect(res?.manifest?.notion?.databases?.['work_tracker']).toBe('vmcp-tracker-id');
  });

  it('aigency.json wins as the permanent fallback', () => {
    // aigency-only-dir has only aigency.json
    const aigencyDir = join(FIXTURES_DIR, 'aigency-only-dir');
    const res = resolveManifest(['node', 'bin.js'], aigencyDir);
    expect(res?.sourcePath).toBe(join(aigencyDir, 'aigency.json'));
    expect(res?.manifest?.notion?.databases?.['work_tracker']).toBe('legacy-tracker-id');
  });

  it('returns null (no-project mode) when no files are present', () => {
    const res = resolveManifest(['node', 'bin.js'], EMPTY_DIR);
    expect(res).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveManifest — AGENTS.md parsing behaviour
// ---------------------------------------------------------------------------
describe('resolveManifest AGENTS.md block parsing', () => {
  it('falls through to the next candidate when AGENTS.md has no verevoir-mcp block', () => {
    // no-block-dir has AGENTS.md (no verevoir-mcp fence) + aigency.json
    const dir = join(FIXTURES_DIR, 'no-block-dir');
    const res = resolveManifest(['node', 'bin.js'], dir);
    expect(res?.sourcePath).toBe(join(dir, 'aigency.json'));
  });

  it('falls through when AGENTS.md verevoir-mcp block contains malformed JSON', () => {
    // bad-json-dir has AGENTS.md with a bad-JSON block + aigency.json
    const dir = join(FIXTURES_DIR, 'bad-json-dir');
    const res = resolveManifest(['node', 'bin.js'], dir);
    expect(res?.sourcePath).toBe(join(dir, 'aigency.json'));
  });
});

// ---------------------------------------------------------------------------
// resolveManifest — winning source path (governance base-dir correctness)
// ---------------------------------------------------------------------------
describe('resolveManifest sourcePath (governance base dir)', () => {
  it('sourcePath is the AGENTS.md path when that source wins', () => {
    const agentsDir = join(FIXTURES_DIR, 'agents-dir');
    const res = resolveManifest(['node', 'bin.js'], agentsDir);
    expect(res?.sourcePath).toBe(join(agentsDir, 'AGENTS.md'));
  });

  it('sourcePath is the verevoir-mcp.json path when that source wins', () => {
    const vmcpDir = join(FIXTURES_DIR, 'vmcp-dir');
    const res = resolveManifest(['node', 'bin.js'], vmcpDir);
    expect(res?.sourcePath).toBe(join(vmcpDir, 'verevoir-mcp.json'));
  });

  it('sourcePath is the aigency.json path when that source wins', () => {
    const aigencyDir = join(FIXTURES_DIR, 'aigency-only-dir');
    const res = resolveManifest(['node', 'bin.js'], aigencyDir);
    expect(res?.sourcePath).toBe(join(aigencyDir, 'aigency.json'));
  });
});

// ---------------------------------------------------------------------------
// loadManifest
// ---------------------------------------------------------------------------
describe('loadManifest', () => {
  it('parses a real manifest via --manifest flag', () => {
    const m = loadManifest(['node', 'bin.js', '--manifest', FIXTURE_AIGENCY], FIXTURES_DIR);
    expect(m?.notion?.databases?.['work_tracker']).toBe('aaaa1111-2222-3333-4444-555566667777');
  });

  it('returns null (no-project mode) when no files are present', () => {
    expect(loadManifest(['node', 'bin.js'], EMPTY_DIR)).toBeNull();
  });

  it('returns null when the cwd has no valid manifest candidates', () => {
    // A directory that only has non-JSON content falls back to null.
    const nonJson = join(FIXTURES_DIR, 'non-json-dir');
    expect(loadManifest(['node', 'bin.js'], nonJson)).toBeNull();
  });

  // A botched explicit --manifest must fail loud at startup, never degrade to
  // no-project mode (STDIO-135). Only discovery failures degrade to null.
  it('throws (does not return null) when --manifest has no following value', () => {
    expect(() => loadManifest(['node', 'bin.js', '--manifest'], EMPTY_DIR)).toThrow(
      '--manifest requires a path'
    );
  });

  it('throws when --manifest is followed by another flag', () => {
    expect(() => loadManifest(['node', 'bin.js', '--manifest', '--verbose'], EMPTY_DIR)).toThrow(
      '--manifest requires a path'
    );
  });

  it('throws when --manifest points at a missing file', () => {
    expect(() =>
      loadManifest(['node', 'bin.js', '--manifest', join(EMPTY_DIR, 'nope.json')], EMPTY_DIR)
    ).toThrow();
  });

  it('throws when --manifest points at an invalid-JSON file', () => {
    const broken = join(FIXTURES_DIR, 'non-json-dir', 'aigency.json');
    expect(() => loadManifest(['node', 'bin.js', '--manifest', broken], EMPTY_DIR)).toThrow(
      'not a valid JSON object'
    );
  });

  it('throws when --manifest points at an .md with no verevoir-mcp block', () => {
    expect(() =>
      loadManifest(['node', 'bin.js', '--manifest', FIXTURE_AGENTS_MD_NO_BLOCK], EMPTY_DIR)
    ).toThrow('no verevoir-mcp fenced block');
  });
});

// ---------------------------------------------------------------------------
// renderProjectDoctrine
// ---------------------------------------------------------------------------
describe('renderProjectDoctrine', () => {
  it('names the board, record, and ADRs as dashless Notion URLs', () => {
    const m = loadManifest(['node', 'bin.js', '--manifest', FIXTURE_AIGENCY], FIXTURES_DIR);
    const section = renderProjectDoctrine(m!);
    expect(section).toContain('## This project');
    // work_tracker id, dashes stripped
    expect(section).toContain('https://www.notion.so/aaaa1111222233334444555566667777');
    // workspaceRootPageId as the project record
    expect(section).toContain('https://www.notion.so/11112222333344445555666677778888');
    // adrs db
    expect(section).toContain('https://www.notion.so/bbbb1111222233334444555566667777');
    expect(section).toContain('put work-shaped items here as cards');
  });

  it('falls back to the start_here page as the record when no workspace root', () => {
    const m: AigencyManifest = {
      notion: { pages: { start_here: 'cccc1111-2222-3333-4444-555566667777' } },
    };
    expect(renderProjectDoctrine(m)).toContain(
      'https://www.notion.so/cccc1111222233334444555566667777'
    );
  });

  it('returns null when there is nothing to point an agent at', () => {
    expect(renderProjectDoctrine({})).toBeNull();
    expect(renderProjectDoctrine({ notion: {} })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// composeInstructions
// ---------------------------------------------------------------------------
describe('composeInstructions', () => {
  const BASE = 'UNIVERSAL DOCTRINE';

  it('appends the project section when a usable manifest is present', () => {
    const m = loadManifest(['node', 'bin.js', '--manifest', FIXTURE_AIGENCY], FIXTURES_DIR);
    const out = composeInstructions(BASE, m);
    expect(out.startsWith(BASE)).toBe(true);
    expect(out).toContain('## This project');
  });

  it('returns the base unchanged in no-project mode', () => {
    expect(composeInstructions(BASE, null)).toBe(BASE);
  });

  it('returns the base unchanged when the manifest has nothing to point at', () => {
    expect(composeInstructions(BASE, { notion: {} })).toBe(BASE);
  });
});

// ---------------------------------------------------------------------------
// --manifest with .md path
// ---------------------------------------------------------------------------
describe('resolveManifest --manifest with .md path', () => {
  it('parses the verevoir-mcp block from an AGENTS.md path supplied via --manifest', () => {
    const res = resolveManifest(['node', 'bin.js', '--manifest', FIXTURE_AGENTS_MD], FIXTURES_DIR);
    expect(res?.sourcePath).toBe(FIXTURE_AGENTS_MD);
    expect(res?.manifest?.notion?.databases?.['work_tracker']).toBe('explicit-agents-tracker-id');
  });

  it('throws when --manifest points at an .md with no verevoir-mcp block', () => {
    expect(() =>
      resolveManifest(['node', 'bin.js', '--manifest', FIXTURE_AGENTS_MD_NO_BLOCK], FIXTURES_DIR)
    ).toThrow('no verevoir-mcp fenced block');
  });

  it('throws when --manifest points at an .md with a malformed JSON block', () => {
    expect(() =>
      resolveManifest(['node', 'bin.js', '--manifest', FIXTURE_AGENTS_MD_BAD_JSON], FIXTURES_DIR)
    ).toThrow('invalid JSON');
  });

  it('throws when --manifest has no following value', () => {
    expect(() => resolveManifest(['node', 'bin.js', '--manifest'], '/anywhere')).toThrow(
      '--manifest requires a path'
    );
  });
});
