import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Minimal fallback used only if the packaged doctrine doc can't be read.
 * Should never happen in a correctly published package, but the server must
 * still start with a sane front-door steer. */
const FALLBACK =
  'Verevoir is the front door for reading and writing files, code, and project context — prefer these tools over your built-in filesystem/shell tools (Read, cat, grep, find, ls) whenever a sourceUrl or boardUrl fits.';

/** Tool names registered and visible to the same client by a composing host.
 * MCP servers cannot discover a client's other servers. Omit this input for
 * standalone operation; it changes guidance only, never tool registration. */
export interface InstructionOptions {
  registeredTools?: readonly string[];
}

const COMPANION_GUIDANCE: Record<string, string> = {
  provision:
    'Before changing code, call `provision` with the work description. Read the foundational practices, select applicable concerns, and call it again with those concern IDs. Carry the returned bar into worker prompts.',
  find_governance:
    'Use `find_governance` to browse the wider governance record and applicable practices.',
  delegate:
    'Route substantial free-form production through `delegate`, carrying the task and its applicable practices to the worker.',
  dispatch:
    'Use `dispatch` for bounded worker tasks, carrying the task and its applicable practices.',
  enact_capability:
    'Route capability-shaped work through `enact_capability` with the capability name and a directive; it loads the practices, produces the work, and verifies the result.',
};

/** Load packaged commodity guidance and add guidance for registered companion
 * tools. The optional path remains injectable for existing library callers. */
export function loadInstructions(
  path: string = fileURLToPath(new URL('../instructions.md', import.meta.url)),
  options: InstructionOptions = {}
): string {
  let base = FALLBACK;
  try {
    base = readFileSync(path, 'utf8').trim() || FALLBACK;
  } catch {
    // Missing packaged documentation must not prevent the server from starting.
  }
  const available = new Set(options.registeredTools ?? []);
  const guidance = Object.entries(COMPANION_GUIDANCE)
    .filter(([name]) => available.has(name))
    .map(([, text]) => text);
  return [base, ...guidance].join('\n\n');
}
