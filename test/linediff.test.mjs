// The content diff CCOX computes when GitHub lists an in-scope file without
// a patch. Checked against an independent oracle (a brute-force LCS table)
// on seeded random inputs, and by round-tripping through parsePatch(): the
// hunks must apply, be minimal, and have exactly the shape a GitHub patch has.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePatch } from '../src/core/diff.mjs';
import { CcoxError } from '../src/core/errors.mjs';
import { CONTEXT_LINES, diffHunks, looksBinary } from '../src/core/linediff.mjs';

const UNBOUNDED = 1_000_000;

/** Deterministic PRNG (mulberry32), so a failure reproduces from its seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomText(next, maxLines) {
  const n = Math.floor(next() * (maxLines + 1));
  const lines = Array.from({ length: n }, () => 'abcd'[Math.floor(next() * 4)]);
  if (n === 0) return '';
  return lines.join('\n') + (next() < 0.8 ? '\n' : '');
}

/** Minimal number of changed lines, by the textbook LCS table (the oracle). */
function minimalChanges(oldText, newText) {
  const key = (text) => {
    if (text === '') return [];
    const ls = text.split('\n');
    if (text.endsWith('\n')) ls.pop();
    else ls[ls.length - 1] += '\n<no newline>';
    return ls;
  };
  const a = key(oldText);
  const b = key(newText);
  const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  }
  return a.length + b.length - 2 * t[0][0];
}

const linesOf = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/** Apply hunks to the old lines; returns the new lines. Fails if a hunk does not match. */
function apply(oldText, hunks) {
  const old = linesOf(oldText);
  const out = [];
  let i = 0;
  for (const h of hunks) {
    const startIdx = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    while (i < startIdx) out.push(old[i++]);
    for (const l of h.lines) {
      if (l.type !== 'added') assert.equal(old[i++], l.text, `hunk ${h.header} does not match the old text`);
      if (l.type !== 'removed') out.push(l.text);
    }
  }
  while (i < old.length) out.push(old[i++]);
  return out;
}

/** Render hunks as the patch text GitHub would send. */
function render(hunks) {
  return hunks.map((h) => [h.header, ...h.lines.flatMap((l) => {
    const line = `${l.type === 'added' ? '+' : l.type === 'removed' ? '-' : ' '}${l.text}`;
    return l.noNewlineAtEnd ? [line, '\\ No newline at end of file'] : [line];
  })].join('\n')).join('\n');
}

test('random pairs: hunks apply, are minimal, and round-trip through parsePatch', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const next = rng(seed);
    const oldText = randomText(next, 30);
    const newText = randomText(next, 30);
    const hunks = diffHunks(oldText, newText, UNBOUNDED);
    const changed = hunks.flatMap((h) => h.lines).filter((l) => l.type !== 'context').length;
    assert.equal(changed, minimalChanges(oldText, newText), `seed ${seed}: edit script is minimal`);
    assert.deepEqual(apply(oldText, hunks), linesOf(newText), `seed ${seed}: hunks apply`);
    assert.deepEqual(parsePatch(render(hunks), 'f'), hunks, `seed ${seed}: same shape as a parsed patch`);
  }
});

test('identical texts give no hunks', () => {
  assert.deepEqual(diffHunks('a\nb\n', 'a\nb\n', 0), []);
  assert.deepEqual(diffHunks('', '', 0), []);
});

test('a change in a long file is shown with three context lines and real line numbers', () => {
  const old = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const neu = [...old];
  neu[9] = 'changed';
  const hunks = diffHunks(`${old.join('\n')}\n`, `${neu.join('\n')}\n`, UNBOUNDED);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].header, '@@ -7,7 +7,7 @@');
  assert.equal(hunks[0].lines.filter((l) => l.type === 'context').length, 2 * CONTEXT_LINES);
  assert.deepEqual(hunks[0].lines.find((l) => l.type === 'added'), { type: 'added', text: 'changed', oldLine: null, newLine: 10 });
});

test('distant changes are separate hunks; near ones merge', () => {
  const old = Array.from({ length: 40 }, (_, i) => `l${i}`);
  const far = [...old];
  far[2] = 'x';
  far[30] = 'y';
  assert.equal(diffHunks(`${old.join('\n')}\n`, `${far.join('\n')}\n`, UNBOUNDED).length, 2);
  const near = [...old];
  near[2] = 'x';
  near[9] = 'y';
  assert.equal(diffHunks(`${old.join('\n')}\n`, `${near.join('\n')}\n`, UNBOUNDED).length, 1);
});

test('an added file starts at -0,0 like git', () => {
  const [h] = diffHunks('', 'a\nb\n', UNBOUNDED);
  assert.equal(h.header, '@@ -0,0 +1,2 @@');
});

test('a missing trailing newline is a change and is marked', () => {
  const hunks = diffHunks('a\nb\n', 'a\nb', UNBOUNDED);
  const lines = hunks[0].lines;
  assert.deepEqual(lines.map((l) => l.type), ['context', 'removed', 'added']);
  assert.equal(lines[2].noNewlineAtEnd, true);
  assert.equal(lines[1].noNewlineAtEnd, undefined);
});

test('an edit script over the bound is file_over_budget, at the bound it passes', () => {
  const old = 'a\nb\nc\nd\n';
  const neu = 'w\nx\ny\nz\n';
  assert.equal(diffHunks(old, neu, 8)[0].lines.length, 8);
  assert.throws(() => diffHunks(old, neu, 7), (e) => e instanceof CcoxError && e.kind === 'file_over_budget');
  assert.throws(() => diffHunks(old, neu, -1), (e) => e.kind === 'internal');
});

test('binary detection follows git: a NUL in the first 8000 characters', () => {
  assert.equal(looksBinary('text\u0000more'), true);
  assert.equal(looksBinary('plain text\n'), false);
  assert.equal(looksBinary(`${'x'.repeat(8000)}\u0000`), false);
});
