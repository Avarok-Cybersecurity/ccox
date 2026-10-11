import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseUnifiedDiff } from '../src/core/diff.mjs';
import { CcoxError } from '../src/core/errors.mjs';
import { batchFiles, compileAllowlist, isInScope, partitionFiles } from '../src/core/scope.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/diffs/${name}`, import.meta.url), 'utf8');

test('unanchored-regex trap: "crates/" covers crates/ and never docs/crates/', () => {
  const allow = compileAllowlist(['crates/']);
  assert.equal(isInScope(allow, 'crates/core/src/lib.rs'), true);
  assert.equal(isInScope(allow, 'docs/crates/notes.md'), false);
  assert.equal(isInScope(allow, 'vendor/crates/x.rs'), false);
});

test('the trap on a real diff: docs/crates/notes.md is excluded', () => {
  const { scanned, excluded } = partitionFiles(parseUnifiedDiff(fixture('pr.diff')), compileAllowlist(['crates/']));
  assert.deepEqual(scanned.map((f) => f.path), ['crates/core/src/lib.rs']);
  assert.deepEqual(excluded, ['docs/crates/notes.md']);
});

test('alternation is anchored as a whole: "a/|b/" does not match x/b/', () => {
  const allow = compileAllowlist(['crates/core/|src/']);
  assert.equal(isInScope(allow, 'src/main.rs'), true);
  assert.equal(isInScope(allow, 'docs/src/main.rs'), false);
});

test('an explicit leading ^ keeps working', () => {
  assert.equal(isInScope(compileAllowlist(['^crates/']), 'crates/a.rs'), true);
});

test('empty allowlist is an input error, never "scan everything" or "scan nothing"', () => {
  for (const empty of [[], undefined, null]) {
    assert.throws(() => compileAllowlist(empty), (e) => e instanceof CcoxError && e.kind === 'input' && /empty/.test(e.message));
  }
  assert.throws(() => compileAllowlist(['  ']), (e) => e.kind === 'input');
});

test('an invalid regex is an input error naming the entry', () => {
  assert.throws(() => compileAllowlist(['crates/(']), (e) => e.kind === 'input' && e.message.includes('crates/('));
});

test('partition: binary, deleted and content-free in-scope files are skipped with a reason', () => {
  const edge = parseUnifiedDiff(fixture('edge-cases.diff'));
  const renames = parseUnifiedDiff(fixture('renames.diff'));
  const { scanned, excluded, skipped } = partitionFiles([...edge, ...renames], compileAllowlist(['crates/', 'tool\\.sh$']));
  assert.deepEqual(scanned.map((f) => f.path).sort(), [
    'crates/core/added.rs', 'crates/core/lib.rs', 'crates/core/new_name.rs', 'crates/core/r2.rs', 'crates/core/tab\tname.rs',
  ]);
  assert.deepEqual(skipped.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: 'crates/core/blob.bin', reason: 'binary' },
    { path: 'crates/core/gone.rs', reason: 'deleted' },
    { path: 'crates/core/old_name.rs', reason: 'deleted' },
    { path: 'tool.sh', reason: 'no_content_change' },
  ]);
  // A file renamed out of the allowlist is judged by its new path.
  assert.deepEqual(excluded.sort(), ['docs/pure.rs', 'docs/with space.md']);
});

const fake = (path, size) => ({ path, size });

test('batching keeps order, never splits, and stays within the budget', () => {
  const files = [fake('a', 400), fake('b', 500), fake('c', 100), fake('d', 1000), fake('e', 1)];
  const batches = batchFiles(files, 1000, (f) => f.size);
  assert.deepEqual(batches.map((b) => b.files.map((f) => f.path)), [['a', 'b', 'c'], ['d'], ['e']]);
  assert.deepEqual(batches.map((b) => b.bytes), [1000, 1000, 1]);
  assert.ok(batches.every((b) => b.bytes <= 1000));
});

test('one file over budget is file_over_budget, never silently dropped', () => {
  const files = [fake('small.rs', 10), fake('huge.rs', 1001)];
  assert.throws(
    () => batchFiles(files, 1000, (f) => f.size),
    (e) => e instanceof CcoxError && e.kind === 'file_over_budget' && e.message.includes('huge.rs'),
  );
});

test('no scoped files means no batches', () => {
  assert.deepEqual(batchFiles([], 1000, () => 1), []);
});
