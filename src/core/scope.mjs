// scope.mjs — which changed files the oracle judges, and in which batches.
//
// Contract: `allowed-directories` entries are regular expressions matched at
// the START of the repository-relative path (the action anchors them), so
// `crates/` covers `crates/core/lib.rs` and never `docs/crates/notes.md`.
// An empty allowlist is an error, not "scan everything" or "scan nothing".
// Batching never splits a file and never drops one: a single file whose
// rendered diff exceeds the budget is an error.

import { CcoxError } from './errors.mjs';

/** Compile allowlist entries into start-anchored RegExps. */
export function compileAllowlist(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new CcoxError(
      'input',
      'allowed-directories is empty: list at least one path regex (one per line) naming the code CCOX must judge',
    );
  }
  return patterns.map((source) => {
    if (typeof source !== 'string' || source.trim() === '') {
      throw new CcoxError('input', `allowed-directories entry ${JSON.stringify(source)} is blank`);
    }
    try {
      return { source, re: new RegExp(`^(?:${source})`) };
    } catch (e) {
      throw new CcoxError('input', `allowed-directories entry ${JSON.stringify(source)} is not a valid regular expression: ${e.message}`);
    }
  });
}

export function isInScope(allowlist, path) {
  return allowlist.some(({ re }) => re.test(path));
}

/**
 * Split parsed diff files into:
 *   scanned  — in scope with new-side content (sent to the model)
 *   excluded — paths outside the allowlist
 *   skipped  — in scope but nothing to judge: { path, reason } with reason
 *              binary | deleted | no_content_change (pure rename, mode change)
 * Scope follows `path` (the new path; the old one for deletions): code moved
 * out of the allowlist is no longer judged, code moved into it is.
 */
export function partitionFiles(files, allowlist) {
  const scanned = [];
  const excluded = [];
  const skipped = [];
  for (const f of files) {
    if (!isInScope(allowlist, f.path)) {
      excluded.push(f.path);
    } else if (f.binary) {
      skipped.push({ path: f.path, reason: 'binary' });
    } else if (f.status === 'deleted') {
      skipped.push({ path: f.path, reason: 'deleted' });
    } else if (!f.hunks.some((h) => h.newCount > 0)) {
      skipped.push({ path: f.path, reason: 'no_content_change' });
    } else {
      scanned.push(f);
    }
  }
  return { scanned, excluded, skipped };
}

/**
 * Greedy, order-preserving batches whose summed `sizeOf(file)` stays within
 * `maxBytes`. Returns an array of { files, bytes }.
 */
export function batchFiles(files, maxBytes, sizeOf) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new CcoxError('input', `max-diff-bytes must be a positive integer, got ${maxBytes}`);
  }
  const batches = [];
  let current = { files: [], bytes: 0 };
  for (const f of files) {
    const size = sizeOf(f);
    if (size > maxBytes) {
      throw new CcoxError(
        'file_over_budget',
        `${f.path} renders to ${size} bytes of diff, over max-diff-bytes ${maxBytes}; ` +
          'raise max-diff-bytes or split the change (CCOX never judges a partial file)',
      );
    }
    if (current.files.length > 0 && current.bytes + size > maxBytes) {
      batches.push(current);
      current = { files: [], bytes: 0 };
    }
    current.files.push(f);
    current.bytes += size;
  }
  if (current.files.length > 0) batches.push(current);
  return batches;
}
