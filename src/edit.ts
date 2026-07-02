// @verevoir/accelerator/edit — pure surgical-edit logic for the `edit_file` tool.
//
// Mirrors the built-in Edit's semantics: replace an exact `oldString`
// with `newString`, requiring a unique match unless `replaceAll`. Pure
// (string in, string out) so it's trivially testable; the tool wires it
// to a source adapter's read + write. Uses split/join rather than
// String.replace so a `$` in `newString` can't trigger replacement-
// pattern expansion ($&, $1, …).

export interface EditResult {
  content: string;
  replacements: number;
}

/** Replace `oldString` with `newString` in `content`. Requires a unique
 * match unless `replaceAll` is set; throws (rather than silently
 * no-op-ing or mangling) on empty / identical / absent / ambiguous
 * input, so the caller surfaces a clear error instead of a bad write. */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false
): EditResult {
  if (oldString === '') {
    throw new Error('edit_file: oldString must not be empty');
  }
  if (oldString === newString) {
    throw new Error('edit_file: oldString and newString are identical — nothing to change');
  }
  const parts = content.split(oldString);
  const replacements = parts.length - 1;
  if (replacements === 0) {
    throw new Error('edit_file: oldString not found in the file');
  }
  if (replacements > 1 && !replaceAll) {
    throw new Error(
      `edit_file: oldString matches ${replacements} times — add surrounding context to make it unique, or pass replaceAll: true`
    );
  }
  return { content: parts.join(newString), replacements };
}
