// GitHub file listings: completeness rules and the mapping to file records.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CcoxError } from '../src/core/errors.mjs';
import {
  COMPARE_FILES_CAP, PULL_FILES_CAP, commitFallbackProblem, compareListingComplete, completeListing, planListing,
  verifyCommitListing, verifyPullListing,
} from '../src/core/listing.mjs';
import { compileAllowlist, partitionFiles } from '../src/core/scope.mjs';

const ALLOW = compileAllowlist(['crates/']);
const kind = (k) => (e) => e instanceof CcoxError && e.kind === k;
const added = (filename) => ({ filename, status: 'added', additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1 @@\n+x' });
const many = (n, prefix = 'docs/f') => Array.from({ length: n }, (_, i) => added(`${prefix}${i}.md`));

test('pull listing: complete when it names exactly changed_files distinct files', () => {
  verifyPullListing({ pr: 7, entries: many(350), changedFiles: 350 });
  assert.throws(() => verifyPullListing({ pr: 7, entries: many(350), changedFiles: 351 }), kind('diff_truncated'));
  assert.throws(() => verifyPullListing({ pr: 7, entries: many(2), changedFiles: 1 }), kind('diff_truncated'));
  const dup = [...many(2), added('docs/f0.md')];
  assert.throws(() => verifyPullListing({ pr: 7, entries: dup, changedFiles: 3 }), kind('diff_truncated'), 'a repeated file cannot stand in for a missing one');
  assert.throws(() => verifyPullListing({ pr: 7, entries: [], changedFiles: undefined }), kind('github'));
});

test('pull listing: more files than GitHub can list is diff_too_large, never a partial judgement', () => {
  assert.throws(
    () => verifyPullListing({ pr: 7, entries: many(PULL_FILES_CAP), changedFiles: PULL_FILES_CAP + 1 }),
    (e) => e.kind === 'diff_too_large' && /3001/.test(e.message),
  );
  verifyPullListing({ pr: 7, entries: many(PULL_FILES_CAP), changedFiles: PULL_FILES_CAP });
});

test('compare listing is trusted only below its 300-file cap', () => {
  assert.equal(compareListingComplete(many(COMPARE_FILES_CAP - 1)), true);
  assert.equal(compareListingComplete(many(COMPARE_FILES_CAP)), false);
});

test('commit fallback only for a head whose single parent is the base', () => {
  const base = 'a'.repeat(40);
  assert.equal(commitFallbackProblem({ parents: [base], baseSha: base }), null);
  assert.match(commitFallbackProblem({ parents: [base, 'c'.repeat(40)], baseSha: base }), /2 parent/);
  assert.match(commitFallbackProblem({ parents: ['c'.repeat(40)], baseSha: base }), /not exactly the base/);
  assert.match(commitFallbackProblem({ parents: [], baseSha: base }), /0 parent/);
});

test('commit listing: line stats must equal the sum over the listed files', () => {
  const entries = many(400);
  verifyCommitListing({ sha: 's', entries, stats: { additions: 400, deletions: 0 } });
  assert.throws(() => verifyCommitListing({ sha: 's', entries, stats: { additions: 401, deletions: 0 } }), kind('diff_truncated'));
  assert.throws(() => verifyCommitListing({ sha: 's', entries, stats: null }), kind('github'));
  assert.throws(() => verifyCommitListing({ sha: 's', entries: many(3000), stats: { additions: 3000, deletions: 0 } }), kind('diff_too_large'));
});

test('plan: patches are parsed; statuses map onto the diff parser\'s', () => {
  const entries = [
    { filename: 'crates/a.rs', status: 'modified', changes: 2, patch: '@@ -1 +1 @@\n-a\n+b' },
    { filename: 'crates/gone.rs', status: 'removed', changes: 1, patch: '@@ -1 +0,0 @@\n-a' },
    { filename: 'crates/new.rs', previous_filename: 'crates/old.rs', status: 'renamed', changes: 1, patch: '@@ -1,0 +2 @@\n+c' },
  ];
  const plan = planListing(entries, ALLOW);
  assert.deepEqual(plan.requests, []);
  assert.deepEqual(plan.withoutPatch, []);
  assert.deepEqual(plan.files.map((f) => [f.path, f.status, f.oldPath, f.newPath]), [
    ['crates/a.rs', 'modified', 'crates/a.rs', 'crates/a.rs'],
    ['crates/gone.rs', 'deleted', 'crates/gone.rs', null],
    ['crates/new.rs', 'renamed', 'crates/old.rs', 'crates/new.rs'],
  ]);
  assert.deepEqual(plan.files[0].hunks[0].lines.map((l) => l.type), ['removed', 'added']);
  assert.throws(() => planListing([{ filename: 'x', status: 'exploded' }], ALLOW), kind('github'));
});

test('plan: scope first — a patchless file is requested only when in scope and has content to judge', () => {
  const entries = [
    { filename: 'docs/huge.md', status: 'modified', changes: 5000 },
    { filename: 'crates/big.rs', status: 'modified', changes: 5000 },
    { filename: 'crates/logo.png', status: 'added', changes: 0 },
    { filename: 'crates/moved.rs', previous_filename: 'crates/was.rs', status: 'renamed', changes: 0 },
    { filename: 'crates/dead.rs', status: 'removed', changes: 3000 },
  ];
  const plan = planListing(entries, ALLOW);
  assert.deepEqual(plan.withoutPatch, entries.map((e) => e.filename));
  assert.deepEqual(plan.requests, [
    { index: 1, path: 'crates/big.rs', oldPath: 'crates/big.rs', status: 'modified' },
    { index: 2, path: 'crates/logo.png', oldPath: null, status: 'added' },
  ]);
  assert.equal(plan.files[1], null);
  const texts = new Map([
    ['crates/big.rs', { oldText: 'a\n', newText: 'b\n' }],
    ['crates/logo.png', { oldText: '', newText: '\u0089PNG\r\n\u001a\n\u0000\u0000' }],
  ]);
  const { files, contentDiffed } = completeListing(plan, texts, 100);
  assert.deepEqual(contentDiffed, ['crates/big.rs']);
  const { scanned, excluded, skipped } = partitionFiles(files, ALLOW);
  assert.deepEqual(scanned.map((f) => f.path), ['crates/big.rs']);
  assert.deepEqual(excluded, ['docs/huge.md']);
  assert.deepEqual(skipped, [
    { path: 'crates/logo.png', reason: 'binary' },
    { path: 'crates/moved.rs', reason: 'no_content_change' },
    { path: 'crates/dead.rs', reason: 'deleted' },
  ]);
});

test('complete: an unread request is diff_unavailable naming the file; a diff over the bound is file_over_budget', () => {
  const plan = planListing([{ filename: 'crates/big.rs', status: 'modified', changes: 2 }], ALLOW);
  assert.throws(() => completeListing(plan, new Map(), 100), (e) => e.kind === 'diff_unavailable' && e.message.includes('crates/big.rs'));
  const texts = new Map([['crates/big.rs', { oldText: 'a\nb\n', newText: 'c\nd\n' }]]);
  assert.throws(() => completeListing(plan, texts, 3), (e) => e.kind === 'file_over_budget' && e.message.includes('crates/big.rs'));
  assert.equal(completeListing(plan, texts, 4).files[0].hunks.length, 1);
});
