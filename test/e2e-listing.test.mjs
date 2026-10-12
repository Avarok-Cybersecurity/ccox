// End to end on large changes: the changed files come from GitHub's paged
// files listings (never the single-diff media type, which GitHub refuses past
// 300 files or 20,000 lines), are verified complete, and every in-scope file
// is judged, diffed from its contents, reported binary, or fails the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addedEntry, entriesFromDiff } from './helpers/fake-services.mjs';
import { BASE, HEAD, PR_DIFF, answer, prEvent, runAction, withServices } from './helpers/action-run.mjs';

const MERGE_BASE = 'c'.repeat(40);
const COMPLIANT = [answer('tool_call-compliant.json')];
const IN_SCOPE = entriesFromDiff(PR_DIFF).filter((e) => e.filename.startsWith('crates/'));
const docs = (n) => Array.from({ length: n }, (_, i) => addedEntry(`docs/page${i}.md`));
const LARGE = [...IN_SCOPE, ...docs(349)];
const mgEvent = { merge_group: { base_sha: BASE, head_sha: HEAD, head_ref: 'refs/heads/gh-readonly-queue/main/pr-7-x' } };

const llmBodies = (services) => services.requests.filter((q) => q.path === '/llm/chat/completions').map((q) => JSON.parse(q.body).messages[1].content);
const askedForDiffMedia = (services) => services.requests.some((q) => (q.headers.accept ?? '').includes('diff'));
const contentReads = (services) => services.requests.filter((q) => q.path.includes('/contents/') && !q.path.includes('/contents/compliances'));

test('a 350-file PR is listed over four pages, verified complete, and judged', () => withServices(
  { files: LARGE, changedFiles: LARGE.length, completions: COMPLIANT },
  async (services) => {
    const r = await runAction({ services, eventName: 'pull_request_target', event: prEvent });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.report.context.diff_source, 'pulls');
    assert.equal(r.report.scope.files_changed, 350);
    assert.equal(r.report.scope.files_expected, 350);
    assert.deepEqual(r.report.scope.files_scanned, ['crates/core/src/lib.rs']);
    assert.equal(r.report.scope.files_excluded.length, 349);
    const pages = services.requests.filter((q) => q.path.endsWith('/pulls/7/files'));
    assert.deepEqual(pages.map((q) => [q.query.per_page, q.query.page]), [['100', '1'], ['100', '2'], ['100', '3'], ['100', '4']]);
    assert.equal(askedForDiffMedia(services), false, 'never the single-diff media type');
    assert.match(llmBodies(services)[0], /std::fs::read_to_string/);
    assert.match(r.summary, /350 of 350 changed file\(s\) listed/);
  },
));

test('changed_files disagrees with the listing: diff_truncated, the model is never asked', () => withServices(
  { files: LARGE, changedFiles: LARGE.length + 1, completions: COMPLIANT },
  async (services) => {
    const r = await runAction({ services, eventName: 'pull_request_target', event: prEvent });
    assert.equal(r.code, 2);
    assert.equal(r.report.error.kind, 'diff_truncated');
    assert.match(r.report.error.message, /351 changed file\(s\) for PR #7 but listed 350/);
    assert.equal(llmBodies(services).length, 0);
  },
));

test('in-scope file without a patch: diffed from its merge-base and head contents, then judged', () => withServices(
  {
    files: [...LARGE, { filename: 'crates/core/src/big.rs', status: 'modified', additions: 1, deletions: 1, changes: 2 }],
    changedFiles: LARGE.length + 1,
    mergeBase: MERGE_BASE,
    blobs: {
      [MERGE_BASE]: { 'crates/core/src/big.rs': 'fn a() {}\nfn b() {}\n' },
      [HEAD]: { 'crates/core/src/big.rs': 'fn a() {}\nfn b() { std::env::var("X").unwrap(); }\n' },
    },
    completions: COMPLIANT,
  },
  async (services) => {
    const r = await runAction({ services, eventName: 'pull_request_target', event: prEvent });
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(r.report.scope.files_without_patch, ['crates/core/src/big.rs']);
    assert.deepEqual(r.report.scope.files_content_diffed, ['crates/core/src/big.rs']);
    assert.deepEqual(r.report.scope.files_scanned, ['crates/core/src/lib.rs', 'crates/core/src/big.rs']);
    assert.deepEqual(contentReads(services).map((q) => q.query.ref), [MERGE_BASE, HEAD], 'old side at the merge base (three-dot), new at head');
    assert.match(llmBodies(services)[0], /=== file: crates\/core\/src\/big\.rs \(modified\) ===\n@@ -1,2 \+1,2 @@\n1\| fn a\(\) \{\}\n \|-fn b\(\) \{\}\n2\|\+fn b\(\) \{ std::env::var/);
  },
));

test('in-scope file without a patch whose contents cannot be read: diff_unavailable naming it', () => withServices(
  {
    files: [...IN_SCOPE, { filename: 'crates/core/src/big.rs', status: 'modified', additions: 1, deletions: 1, changes: 2 }],
    changedFiles: 2,
    completions: COMPLIANT,
  },
  async (services) => {
    const r = await runAction({ services, eventName: 'pull_request_target', event: prEvent });
    assert.equal(r.code, 2);
    assert.equal(r.report.error.kind, 'diff_unavailable');
    assert.match(r.report.error.message, /^crates\/core\/src\/big\.rs: GitHub listed it without a patch/);
    assert.equal(llmBodies(services).length, 0);
  },
));

test('out-of-scope file without a patch and an in-scope binary: no content read for the first, the second reported, neither judged', () => withServices(
  {
    files: [
      ...IN_SCOPE,
      { filename: 'docs/huge.md', status: 'modified', additions: 4000, deletions: 3000, changes: 7000 },
      { filename: 'crates/core/logo.png', status: 'added', additions: 0, deletions: 0, changes: 0 },
    ],
    changedFiles: 3,
    blobs: { [HEAD]: { 'crates/core/logo.png': '\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR' } },
    completions: COMPLIANT,
  },
  async (services) => {
    const r = await runAction({ services, eventName: 'pull_request_target', event: prEvent });
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(r.report.scope.files_without_patch, ['docs/huge.md', 'crates/core/logo.png']);
    assert.deepEqual(r.report.scope.files_content_diffed, []);
    assert.deepEqual(r.report.scope.files_excluded, ['docs/huge.md']);
    assert.deepEqual(r.report.scope.files_skipped, [{ path: 'crates/core/logo.png', reason: 'binary' }]);
    assert.deepEqual(contentReads(services).map((q) => q.path), ['/api/repos/o/r/contents/crates/core/logo.png']);
    assert.ok(!llmBodies(services)[0].includes('logo.png'), 'a binary file never reaches the model');
    assert.match(r.summary, /1 skipped \(1 binary, not judged\)/);
  },
));

test('merge_group under compare\'s cap: compare listing, no commit fallback', () => withServices(
  { files: entriesFromDiff(PR_DIFF), changedFiles: 2, completions: COMPLIANT },
  async (services) => {
    const r = await runAction({ services, eventName: 'merge_group', event: mgEvent });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.report.context.diff_source, 'compare');
    assert.ok(!services.requests.some((q) => q.path.includes('/commits/')));
  },
));

test('merge_group past compare\'s 300-file cap: listed completely from the squashed head commit', () => withServices(
  { files: LARGE, changedFiles: LARGE.length, completions: COMPLIANT },
  async (services) => {
    const r = await runAction({ services, eventName: 'merge_group', event: mgEvent });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.report.context.diff_source, 'commit');
    assert.equal(r.report.scope.files_changed, 350);
    assert.equal(r.report.scope.files_expected, null);
    assert.deepEqual(r.report.scope.files_scanned, ['crates/core/src/lib.rs']);
    assert.equal(services.requests.filter((q) => q.path.endsWith(`/commits/${HEAD}`)).length, 4);
    assert.equal(askedForDiffMedia(services), false);
  },
));

for (const [name, options, kind] of [
  ['a head with two parents', { commitParents: [BASE, MERGE_BASE] }, 'diff_too_large'],
  ['line stats that the listing does not add up to', { commitStats: { additions: 999, deletions: 0 } }, 'diff_truncated'],
]) {
  test(`merge_group past the cap with ${name}: ${kind}, the model is never asked`, () => withServices(
    { files: LARGE, changedFiles: LARGE.length, completions: COMPLIANT, ...options },
    async (services) => {
      const r = await runAction({ services, eventName: 'merge_group', event: mgEvent });
      assert.equal(r.code, 2);
      assert.equal(r.report.error.kind, kind);
      assert.equal(llmBodies(services).length, 0);
    },
  ));
}
