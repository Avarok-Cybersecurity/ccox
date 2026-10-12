// listing.mjs — GitHub's changed-file listings, verified complete and turned
// into the file records parseUnifiedDiff() produces.
//
// Contract: a listing is used only when it provably names every changed file
// (the pull request's `changed_files`, the compare cap, or the commit's line
// stats); otherwise diff_truncated / diff_too_large. Scope is applied first:
// a file GitHub sent without a `patch` is fine outside allowed-directories,
// and inside it is never skipped silently. Its diff is computed from the two
// versions (diffHunks), or it is reported binary, or the run fails with
// diff_unavailable naming it.

import { CcoxError } from './errors.mjs';
import { parsePatch } from './diff.mjs';
import { diffHunks, looksBinary } from './linediff.mjs';
import { isInScope } from './scope.mjs';

/** GitHub REST limits (documented API behaviour, not tunables). */
export const FILES_PAGE_SIZE = 100; // per_page maximum of the files listings
export const PULL_FILES_CAP = 3000; // pulls/{n}/files lists at most 3000 files
export const COMMIT_FILES_CAP = 3000; // commits/{sha} pages its files up to 3000
export const COMPARE_FILES_CAP = 300; // compare lists at most 300 files, on page 1 only

const STATUS = Object.freeze({
  added: 'added',
  removed: 'deleted',
  modified: 'modified',
  changed: 'modified', // mode or type change
  renamed: 'renamed',
  copied: 'copied',
  unchanged: 'modified',
});

function requireUniquePaths(entries, what) {
  const seen = new Set();
  for (const e of entries) {
    if (typeof e?.filename !== 'string' || e.filename === '') {
      throw new CcoxError('github', `${what} lists an entry without a filename`);
    }
    if (seen.has(e.filename)) throw new CcoxError('diff_truncated', `${what} lists ${e.filename} twice; the listing shifted while it was paged`);
    seen.add(e.filename);
  }
}

/** A pull request's listing is complete when it names exactly `changed_files` distinct files. */
export function verifyPullListing({ pr, entries, changedFiles }) {
  if (!Number.isSafeInteger(changedFiles) || changedFiles < 0) {
    throw new CcoxError('github', `PR #${pr} reports no changed_files count`);
  }
  if (changedFiles > PULL_FILES_CAP) {
    throw new CcoxError(
      'diff_too_large',
      `PR #${pr} changes ${changedFiles} files; GitHub lists at most ${PULL_FILES_CAP}, so the whole diff cannot be judged`,
    );
  }
  requireUniquePaths(entries, `PR #${pr} files`);
  if (entries.length !== changedFiles) {
    throw new CcoxError('diff_truncated', `GitHub reports ${changedFiles} changed file(s) for PR #${pr} but listed ${entries.length}`);
  }
}

/** True when a compare listing is provably complete: below the cap at which GitHub stops listing. */
export function compareListingComplete(entries) {
  requireUniquePaths(entries, 'compare');
  return entries.length < COMPARE_FILES_CAP;
}

/**
 * When compare is capped, a merge group can still be listed completely from
 * its head commit, but only if that commit's one parent is the group's base
 * (one squashed entry). Returns null when it can, else the reason it cannot.
 */
export function commitFallbackProblem({ parents, baseSha }) {
  if (parents.length === 1 && parents[0] === baseSha) return null;
  return `the merge group head has ${parents.length} parent(s) (${parents.join(', ') || 'none'}), not exactly the base ${baseSha}; ` +
    'only a one-entry squash merge group can be listed beyond compare\'s 300 files (merge queue: max_entries_to_build 1, merge_method SQUASH)';
}

/** A commit's listing is complete when it is under the cap and its line counts sum to the commit's stats. */
export function verifyCommitListing({ sha, entries, stats }) {
  if (entries.length >= COMMIT_FILES_CAP) {
    throw new CcoxError('diff_too_large', `commit ${sha} lists ${entries.length} files, GitHub's cap; the whole diff cannot be verified`);
  }
  requireUniquePaths(entries, `commit ${sha} files`);
  const sum = (key) => entries.reduce((n, e) => n + (Number.isSafeInteger(e[key]) ? e[key] : NaN), 0);
  if (!Number.isSafeInteger(stats?.additions) || !Number.isSafeInteger(stats?.deletions)) {
    throw new CcoxError('github', `commit ${sha} reports no line stats`);
  }
  if (sum('additions') !== stats.additions || sum('deletions') !== stats.deletions) {
    throw new CcoxError(
      'diff_truncated',
      `commit ${sha} reports +${stats.additions}/-${stats.deletions} lines but its listed files sum to +${sum('additions')}/-${sum('deletions')}`,
    );
  }
}

/**
 * Map listing entries to file records. Entries with a patch are parsed; an
 * entry without one becomes a content request when it is in scope and has
 * content to judge, else a record with no hunks (scope and partitionFiles
 * then exclude or skip it with its reason).
 * Returns { files: (record | null)[], requests, withoutPatch } where each
 * request { index, path, oldPath, status } fills files[index].
 */
export function planListing(entries, allowlist) {
  const files = [];
  const requests = [];
  const withoutPatch = [];
  for (const e of entries) {
    const status = STATUS[e.status];
    if (!status) throw new CcoxError('github', `${e.filename} has unknown status ${JSON.stringify(e.status)}`);
    const path = e.filename;
    const oldPath = status === 'added' ? null : typeof e.previous_filename === 'string' ? e.previous_filename : path;
    const record = { path, oldPath, newPath: status === 'deleted' ? null : path, status, binary: false, hunks: [] };
    if (typeof e.patch === 'string') {
      files.push({ ...record, hunks: parsePatch(e.patch, path) });
      continue;
    }
    withoutPatch.push(path);
    // A rename with no changed lines carries no content change to judge.
    const pureRename = status === 'renamed' && e.changes === 0;
    if (isInScope(allowlist, path) && status !== 'deleted' && !pureRename) {
      requests.push({ index: files.length, path, oldPath, status });
      files.push(null);
    } else {
      files.push(record);
    }
  }
  return { files, requests, withoutPatch };
}

/**
 * Fill the content requests from the two versions of each file
 * (`texts`: path -> { oldText, newText }, oldText '' for an added file).
 * A binary file becomes a binary record; a text file gets its computed hunks,
 * refused with file_over_budget past `maxChangedLines`.
 */
export function completeListing(plan, texts, maxChangedLines) {
  const files = [...plan.files];
  const contentDiffed = [];
  for (const req of plan.requests) {
    const t = texts.get(req.path);
    if (!t) throw new CcoxError('diff_unavailable', `${req.path}: GitHub listed it without a patch and its contents were not read`);
    const record = { path: req.path, oldPath: req.oldPath, newPath: req.path, status: req.status, binary: false, hunks: [] };
    if (looksBinary(t.oldText) || looksBinary(t.newText)) {
      files[req.index] = { ...record, binary: true };
      continue;
    }
    try {
      files[req.index] = { ...record, hunks: diffHunks(t.oldText, t.newText, maxChangedLines) };
    } catch (e) {
      if (e instanceof CcoxError && e.kind === 'file_over_budget') {
        throw new CcoxError('file_over_budget', `${req.path}: its diff (computed from contents, GitHub sent no patch) has ${e.message}, over max-diff-bytes`);
      }
      throw e;
    }
    contentDiffed.push(req.path);
  }
  return { files, contentDiffed };
}
