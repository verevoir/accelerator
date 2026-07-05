// @verevoir/accelerator/edit — pure surgical-edit ops over file content.
//
// A family of pure (string in, EditResult out) operations the mutation tools
// wire to a source adapter's read + write: applyEdit (exact oldString→newString,
// unique unless replaceAll), applyMultiEdit (an atomic sequence of edits),
// applyInsert (before/after a unique anchor) and applyDeleteBlock (remove a
// unique block). Each throws rather than silently no-op on empty / absent /
// ambiguous input, and uses split/join rather than String.replace so a `$` in
// inserted text can't trigger replacement-pattern expansion ($&, $1, …).

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

/** Apply edits in order (each an applyEdit — unique match unless replaceAll);
 * return the total replacement count. Throws, applying nothing, if any edit
 * fails its match or if `edits` is empty. */
export function applyMultiEdit(
  content: string,
  edits: { oldString: string; newString: string; replaceAll?: boolean }[]
): EditResult {
  if (edits.length === 0) {
    throw new Error('applyMultiEdit: edits array must not be empty');
  }
  let working = content;
  let totalReplacements = 0;
  for (const edit of edits) {
    const result = applyEdit(working, edit.oldString, edit.newString, edit.replaceAll ?? false);
    working = result.content;
    totalReplacements += result.replacements;
  }
  return { content: working, replacements: totalReplacements };
}

/** Insert `text` before/after the unique occurrence of `anchor`. Throws if
 * `anchor` or `text` is empty, or `anchor` is absent or non-unique. */
export function applyInsert(
  content: string,
  anchor: string,
  text: string,
  position: 'before' | 'after'
): EditResult {
  if (anchor === '') {
    throw new Error('applyInsert: anchor must not be empty');
  }
  if (text === '') {
    throw new Error('applyInsert: text must not be empty — nothing to insert');
  }
  const parts = content.split(anchor);
  const matches = parts.length - 1;
  if (matches === 0) {
    throw new Error('applyInsert: anchor not found in the file');
  }
  if (matches > 1) {
    throw new Error(
      `applyInsert: anchor matches ${matches} times — add surrounding context to make it unique`
    );
  }
  if (position === 'before') {
    return { content: parts[0] + text + anchor + parts[1], replacements: 1 };
  } else {
    return { content: parts[0] + anchor + text + parts[1], replacements: 1 };
  }
}

/** Remove the UNIQUE occurrence of `block` from `content`. Throw a clear
 * Error on empty / not-found / ambiguous (more than one match). */
export function applyDeleteBlock(content: string, block: string): EditResult {
  if (block === '') {
    throw new Error('applyDeleteBlock: block must not be empty');
  }
  const parts = content.split(block);
  const matches = parts.length - 1;
  if (matches === 0) {
    throw new Error('applyDeleteBlock: block not found in the file');
  }
  if (matches > 1) {
    throw new Error(
      `applyDeleteBlock: block matches ${matches} times — add surrounding context to make it unique`
    );
  }
  return { content: parts[0] + parts[1], replacements: 1 };
}
