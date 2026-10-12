import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { newSideRanges, parsePatch, parseUnifiedDiff, unquoteGitPath } from '../src/core/diff.mjs';
import { CcoxError } from '../src/core/errors.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/diffs/${name}`, import.meta.url), 'utf8');
const byPath = (files) => new Map(files.map((f) => [f.path, f]));

test('edge-case diff from real git: every section parsed with the right status', () => {
  const files = byPath(parseUnifiedDiff(fixture('edge-cases.diff')));
  assert.deepEqual([...files.keys()].sort(), [
    'crates/core/added.rs', 'crates/core/blob.bin', 'crates/core/gone.rs', 'crates/core/lib.rs',
    'crates/core/new_name.rs', 'crates/core/old_name.rs', 'crates/core/tab\tname.rs', 'docs/with space.md', 'tool.sh',
  ]);
  assert.equal(files.get('crates/core/added.rs').status, 'added');
  assert.equal(files.get('crates/core/added.rs').oldPath, null);
  assert.equal(files.get('crates/core/gone.rs').status, 'deleted');
  assert.equal(files.get('crates/core/gone.rs').newPath, null);
  assert.equal(files.get('tool.sh').hunks.length, 0, 'mode-only change has no hunks');
});

test('added file: new-side lines numbered from the hunk start', () => {
  const f = byPath(parseUnifiedDiff(fixture('edge-cases.diff'))).get('crates/core/added.rs');
  assert.deepEqual(f.hunks[0].lines, [{ type: 'added', text: 'new file', oldLine: null, newLine: 1 }]);
  assert.deepEqual(newSideRanges(f), [{ start: 1, end: 1 }]);
});

test('binary file is flagged and has no hunks', () => {
  const f = byPath(parseUnifiedDiff(fixture('edge-cases.diff'))).get('crates/core/blob.bin');
  assert.equal(f.binary, true);
  assert.equal(f.status, 'added');
  assert.deepEqual(f.hunks, []);
});

test('deleted file: only removed lines, no new-side range', () => {
  const f = byPath(parseUnifiedDiff(fixture('edge-cases.diff'))).get('crates/core/gone.rs');
  assert.deepEqual(f.hunks[0].lines.map((l) => l.type), ['removed']);
  assert.deepEqual(newSideRanges(f), []);
});

test('"\\ No newline at end of file" marks the last line and is not counted', () => {
  const f = byPath(parseUnifiedDiff(fixture('edge-cases.diff'))).get('crates/core/lib.rs');
  const lines = f.hunks[0].lines;
  assert.deepEqual(lines.map((l) => [l.type, l.newLine]), [
    ['context', 1], ['removed', null], ['added', 2], ['added', 3],
  ]);
  assert.equal(lines[3].noNewlineAtEnd, true);
  assert.equal(lines[3].text, 'fn c() {}');
});

test('quoted path with an escaped tab, and a path with spaces (git appends a TAB)', () => {
  const files = byPath(parseUnifiedDiff(fixture('edge-cases.diff')));
  assert.ok(files.has('crates/core/tab\tname.rs'));
  assert.equal(files.get('docs/with space.md').newPath, 'docs/with space.md');
  assert.equal(unquoteGitPath('"a/caf\\303\\251.rs"'), 'a/café.rs');
});

test('renames: with content change (hunks) and pure rename (no hunks)', () => {
  const files = byPath(parseUnifiedDiff(fixture('renames.diff')));
  const changed = files.get('crates/core/r2.rs');
  assert.equal(changed.status, 'renamed');
  assert.equal(changed.oldPath, 'crates/core/r.rs');
  assert.deepEqual(newSideRanges(changed), [{ start: 7, end: 13 }]);
  const pure = files.get('docs/pure.rs');
  assert.equal(pure.status, 'renamed');
  assert.equal(pure.oldPath, 'crates/core/pure.rs');
  assert.deepEqual(pure.hunks, []);
});

test('a diff cut short mid-hunk is diff_truncated, not a shorter diff', () => {
  const text = fixture('pr.diff');
  const cut = text.slice(0, text.indexOf('+    std::fs::read_to_string'));
  assert.throws(() => parseUnifiedDiff(cut), (e) => e instanceof CcoxError && e.kind === 'diff_truncated');
});

test('a hunk with more lines than its header declares is rejected', () => {
  const text = 'diff --git a/x.rs b/x.rs\n--- a/x.rs\n+++ b/x.rs\n@@ -1 +1 @@\n-a\n+b\n+c\n';
  assert.throws(() => parseUnifiedDiff(text), (e) => e instanceof CcoxError && e.kind === 'diff');
});

test('text outside any diff section is rejected', () => {
  assert.throws(() => parseUnifiedDiff('hello\n'), (e) => e.kind === 'diff');
  assert.deepEqual(parseUnifiedDiff(''), []);
});

test('a GitHub patch (hunks only) parses exactly like the same hunks in a unified diff', () => {
  const full = byPath(parseUnifiedDiff(fixture('pr.diff'))).get('crates/core/src/lib.rs');
  const patch = fixture('pr.diff').split('\n').slice(4, 12).join('\n');
  assert.deepEqual(parsePatch(patch, 'crates/core/src/lib.rs'), full.hunks);
  assert.deepEqual(parsePatch('', 'empty.rs'), []);
});

test('a patch line outside any hunk, or a hunk cut short, is refused', () => {
  assert.throws(() => parsePatch('@@ -1 +1 @@\n-a\n+b\n+stray', 'f.rs'), (e) => e instanceof CcoxError && e.kind === 'diff' && /outside any hunk/.test(e.message));
  assert.throws(() => parsePatch('@@ -1,2 +1,2 @@\n-a\n+b', 'f.rs'), (e) => e.kind === 'diff_truncated');
});
