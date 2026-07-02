import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** The project pointer manifest, per ADR 023. A thin file in the project's git
 * presence that points at where the project record actually lives (Notion). We
 * read only the fields we compose into doctrine; unknown fields are ignored so
 * the manifest can grow without breaking the server. */

/** A governance source the find_governance index spans alongside the Notion
 * record — e.g. the guardrails corpus repo. Each path is either a directory
 * (whose `.md` files are listed) or a single `.md` file within the source;
 * every entry is read back the same way via read_file. Governance comes from
 * more than one source the way code does (filesystem or GitHub) — they index
 * together. */
export interface GovernanceSource {
  source: string;
  paths: string[];
}

export interface AigencyManifest {
  notion?: {
    workspaceRootPageId?: string;
    databases?: Record<string, string>;
    pages?: Record<string, string>;
  };
  /** Extra governance sources indexed by find_governance alongside the record. */
  governance?: GovernanceSource[];
}

/** The result of resolving the manifest — the parsed content plus the path of
 * the file that provided it, so callers (governance.ts) can derive the correct
 * base directory for relative source paths regardless of which candidate won. */
export interface ManifestResolution {
  manifest: AigencyManifest;
  /** Absolute path of the file that provided the manifest content. */
  sourcePath: string;
}

// ---------------------------------------------------------------------------
// AGENTS.md embedded-block parser
// ---------------------------------------------------------------------------

/** Extract the body of the first fenced code block whose info-string starts
 * with `verevoir-mcp` from a Markdown string. Returns `null` if no such block
 * is present. The parser is intentionally minimal: it handles both backtick
 * and tilde fences, ignores all other fenced blocks, and is robust to the
 * block appearing anywhere in the file alongside unrelated content. */
export function extractAgentsMdBlock(markdown: string): string | null {
  // Match a fenced block opening whose info-string starts with verevoir-mcp.
  // Capture the fence char so we can match the closing fence with the same char.
  const openRe = /^(```+|~~~+)[ \t]*verevoir-mcp\b.*$/m;
  const match = openRe.exec(markdown);
  if (!match) return null;

  const fenceChar = match[1][0]; // ` or ~
  const fenceLen = match[1].length;
  // The closing fence: same char, at least as many repetitions, optional
  // trailing whitespace, at the start of a line.
  const closeRe = new RegExp(`^${fenceChar === '`' ? '`' : '~'}{${fenceLen},}[ \\t]*$`, 'm');

  // Start searching after the opening fence line.
  const afterOpen = markdown.slice(match.index + match[0].length);
  // Skip the newline immediately after the opening fence.
  const body = afterOpen.startsWith('\n') ? afterOpen.slice(1) : afterOpen;
  const closeMatch = closeRe.exec(body);
  if (!closeMatch) return null;

  return body.slice(0, closeMatch.index);
}

// ---------------------------------------------------------------------------
// Candidate loaders — each returns ManifestResolution | null
// ---------------------------------------------------------------------------

/** Try to parse JSON from a string; returns null on any error. */
function tryParseJson(text: string): AigencyManifest | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as AigencyManifest;
  } catch {
    return null;
  }
}

/** Try to read a file as UTF-8 text; returns null if absent or unreadable. */
function tryReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Candidate 2: AGENTS.md in cwd, IF it contains a `verevoir-mcp` fenced
 * block. Returns null if the file is absent, contains no such block, or the
 * block contains invalid JSON — each of these degrades gracefully to the next
 * candidate (no throw). */
function tryAgentsMd(cwd: string): ManifestResolution | null {
  const path = join(cwd, 'AGENTS.md');
  const text = tryReadFile(path);
  if (text === null) return null;
  const block = extractAgentsMdBlock(text);
  if (block === null) return null;
  const manifest = tryParseJson(block);
  if (manifest === null) return null;
  return { manifest, sourcePath: path };
}

/** Candidate 3 / 4: a named JSON file in cwd. Returns null if absent,
 * unreadable, or not valid JSON. */
function tryJsonFile(cwd: string, filename: string): ManifestResolution | null {
  const path = join(cwd, filename);
  const text = tryReadFile(path);
  if (text === null) return null;
  const manifest = tryParseJson(text);
  if (manifest === null) return null;
  return { manifest, sourcePath: path };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolve the manifest source path for an explicit `--manifest <path>` arg.
 * Handles both JSON and `.md` (AGENTS.md-style) paths.  `argv` / `cwd` are
 * injectable for testing.
 *
 * - An explicit path wins every candidate; throws on a flag-value/missing path
 *   rather than falling back silently — a botched launch arg should fail loudly.
 * - A `.md` path is treated as AGENTS.md-style: the `verevoir-mcp` block is
 *   extracted and JSON-parsed.  All other paths are JSON-parsed directly.
 * - A present-but-malformed explicit manifest (bad JSON, missing block) throws,
 *   not degrades — the operator explicitly named a file; they expect it to work.
 */
function resolveExplicitManifest(argv: string[], cwd: string): ManifestResolution | null {
  const i = argv.indexOf('--manifest');
  if (i === -1) return null;

  const value = argv[i + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new Error('--manifest requires a path argument (e.g. --manifest /path/to/aigency.json)');
  }

  const path = resolve(cwd, value);

  if (path.endsWith('.md')) {
    const text = readFileSync(path, 'utf8'); // throws if missing
    const block = extractAgentsMdBlock(text);
    if (block === null) {
      throw new Error(
        `--manifest ${path}: no verevoir-mcp fenced block found in the Markdown file`
      );
    }
    const manifest = tryParseJson(block);
    if (manifest === null) {
      throw new Error(`--manifest ${path}: verevoir-mcp block contains invalid JSON`);
    }
    return { manifest, sourcePath: path };
  }

  // Non-.md path — parse as JSON; readFileSync throws on missing, JSON.parse
  // on malformed.
  const text = readFileSync(path, 'utf8');
  const manifest = tryParseJson(text);
  if (manifest === null) {
    throw new Error(`--manifest ${path}: file is not a valid JSON object`);
  }
  return { manifest, sourcePath: path };
}

/** Resolve which manifest to use, in precedence order (first win):
 *
 * 1. `--manifest <path>` — explicit arg wins; throws on a missing/bad value.
 *    If the path ends in `.md`, the `verevoir-mcp` fenced block is parsed.
 * 2. `AGENTS.md` in cwd — if it contains a `verevoir-mcp` fenced block with
 *    valid JSON. Absent file, missing block, or invalid JSON → fall through.
 * 3. `verevoir-mcp.json` in cwd — JSON.  Absent or invalid → fall through.
 * 4. `aigency.json` in cwd — JSON (legacy, permanent fallback).
 * 5. None found → returns `null` (no-project mode; server still starts).
 *
 * `argv` / `cwd` are injectable for testing. */
export function resolveManifest(
  argv: string[] = process.argv,
  cwd: string = process.cwd()
): ManifestResolution | null {
  // 1 — explicit --manifest flag (throws on a bad arg or a broken named file —
  // a botched launch arg fails loud, never degrades to no-project mode).
  const explicit = resolveExplicitManifest(argv, cwd);
  if (explicit) return explicit;

  // 2–4 — discovery: each candidate degrades to the next, never throws.
  return resolveDiscoveredManifest(cwd);
}

/** The discovery half of resolution (candidates 2–4): AGENTS.md block →
 * verevoir-mcp.json → aigency.json. Every step degrades gracefully — a missing
 * file, a missing block, or invalid JSON falls through to the next candidate,
 * and an exhausted chain returns `null` (no-project mode). Never throws, so a
 * caller can treat a null here as a genuine "no project configured" rather than
 * a failure to distinguish from a botched explicit `--manifest`. */
function resolveDiscoveredManifest(cwd: string): ManifestResolution | null {
  // 2 — AGENTS.md embedded block
  const agentsMd = tryAgentsMd(cwd);
  if (agentsMd) return agentsMd;

  // 3 — verevoir-mcp.json
  const verevMcp = tryJsonFile(cwd, 'verevoir-mcp.json');
  if (verevMcp) return verevMcp;

  // 4 — aigency.json (legacy, permanent fallback)
  return tryJsonFile(cwd, 'aigency.json');
}

// ---------------------------------------------------------------------------
// Legacy / convenience shims — kept so governance.ts and index.ts don't
// change their call sites for now.  The path returned is the winning source
// path from resolveManifest, or the legacy default, so dirname() still
// produces the right base directory.
// ---------------------------------------------------------------------------

/** @deprecated Prefer `resolveManifest()` — this shim exists for callers that
 * only need the path and don't have the resolution result at hand. */
export function manifestPath(argv: string[] = process.argv, cwd: string = process.cwd()): string {
  // For the --manifest flag case (which throws on bad args), we delegate to
  // resolveManifest so the same error surfaces.
  const i = argv.indexOf('--manifest');
  if (i !== -1) {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new Error(
        '--manifest requires a path argument (e.g. --manifest /path/to/aigency.json)'
      );
    }
    return resolve(cwd, value);
  }
  // Return the path of the winning candidate — or the aigency.json default
  // if nothing was found (loadManifest will return null for a missing file).
  const res = resolveManifest(argv, cwd);
  return res?.sourcePath ?? resolve(cwd, 'aigency.json');
}

/** Load the project manifest, using the full precedence resolution:
 * --manifest > AGENTS.md block > verevoir-mcp.json > aigency.json.
 *
 * Returns `null` in "no-project mode" when **discovery** finds nothing — no
 * AGENTS.md block, no `verevoir-mcp.json`, no `aigency.json` — so the server
 * still starts with only the universal doctrine.
 *
 * A botched explicit `--manifest` (no value, a value that is another flag, or a
 * named file that is missing / unparseable) **throws** rather than degrading to
 * null (STDIO-135): an operator who explicitly names a manifest expects it to
 * load, so the failure must be loud at startup, never a silent no-project mode.
 * Only discovery failures are swallowed. `argv` / `cwd` are injectable for
 * testing. */
export function loadManifest(
  argv: string[] = process.argv,
  cwd: string = process.cwd()
): AigencyManifest | null {
  // resolveManifest throws only for an explicit --manifest error; discovery
  // returns null rather than throwing. So letting it propagate gives exactly
  // the contract we want — loud on a bad --manifest, null on empty discovery.
  return resolveManifest(argv, cwd)?.manifest ?? null;
}

/** Notion page/database id → workspace URL the verevoir Notion tools accept. */
function notionUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, '')}`;
}

/** Render the project-specific doctrine section from a manifest, or `null` if
 * the manifest carries nothing we can point an agent at. This is the
 * project-specific layer that composes onto the universal doctrine: it names
 * *this* project's board and record so the "read the board / put work on the
 * board" steer resolves to concrete URLs rather than staying abstract. */
export function renderProjectDoctrine(manifest: AigencyManifest): string | null {
  const notion = manifest.notion;
  if (!notion) return null;

  const board = notion.databases?.work_tracker;
  const adrs = notion.databases?.adrs;
  const record = notion.workspaceRootPageId ?? notion.pages?.['start_here'];

  const lines: string[] = [];
  if (board) {
    lines.push(
      `- **Work tracker (the board):** ${notionUrl(board)} — read this first for project state; put work-shaped items here as cards.`
    );
  }
  if (record) {
    lines.push(
      `- **Project record (intent, futurespective, onboarding):** ${notionUrl(record)} — the project's durable context lives here.`
    );
  }
  if (adrs) {
    lines.push(`- **Decision records (ADRs):** ${notionUrl(adrs)}.`);
  }
  if (lines.length === 0) return null;

  return [
    '## This project',
    '',
    'Resolved from the project manifest. Reach all of these through the verevoir Notion tools (`list_cards` / `read_file` / `list_files`), not the local git tree:',
    '',
    ...lines,
  ].join('\n');
}

/** Compose the universal doctrine with this project's manifest-derived layer.
 * No-project mode (null manifest, or a manifest with nothing to point at)
 * returns the base doctrine unchanged. */
export function composeInstructions(base: string, manifest: AigencyManifest | null): string {
  const section = manifest ? renderProjectDoctrine(manifest) : null;
  return section ? `${base}\n\n${section}` : base;
}
