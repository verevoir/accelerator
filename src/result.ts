// Render a value as MCP tool-result text.
//
// Pretty-prints structured data and expands escaped control sequences
// (`\n`, `\t`, `\"`) so multi-line string fields — file content, card
// bodies, diffs, commit messages — read as real newlines and quotes for
// the consumer (the LLM, and the human watching) instead of the literal
// `\n` / `\"` that `JSON.stringify` emits (STDIO-315).
//
// The output favours readability over round-trippable JSON: its only
// consumer reads it, it is not re-parsed. Structural quotes (around keys
// and values) are untouched — only escapes *inside* string values are
// expanded — so the shape stays legible.
export function jsonText(value: unknown): string {
  if (typeof value === 'string') return value;
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) return String(value);
  return json.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
}
