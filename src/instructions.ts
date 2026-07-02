import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Minimal fallback used only if the packaged doctrine doc can't be read.
 * Should never happen in a correctly published package, but the server must
 * still start with a sane front-door steer. */
const FALLBACK =
  'Verevoir is the front door for reading and writing files, code, and project context — prefer these tools over your built-in filesystem/shell tools (Read, cat, grep, find, ls) whenever a sourceUrl or boardUrl fits.';

/** Load the agent-runtime doctrine that MCP clients inject into the model's
 * context on connect. Packaged as `instructions.md` at the package root
 * (shipped via package.json "files"), resolved relative to this module so the
 * same path works from both `src` (tests) and `dist` (runtime). `path` is
 * injectable for testing. */
export function loadInstructions(
  path: string = fileURLToPath(new URL('../instructions.md', import.meta.url))
): string {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text.length > 0 ? text : FALLBACK;
  } catch {
    return FALLBACK;
  }
}
