// linediff.mjs — the line diff of two file versions, as unified-diff hunks.
//
// Used when GitHub lists an in-scope file without a `patch`: the diff is
// computed here from the base and head contents. Contract: the edit script is
// minimal (Myers' O(ND) algorithm, linear-space variant), the hunks carry
// CONTEXT_LINES of context like `git diff`, and their shape is exactly what
// parsePatch() yields, so the rest of CCOX cannot tell the two sources apart.
// A file whose edit distance exceeds `maxChangedLines` is refused with
// file_over_budget before the search grows past that bound.

import { CcoxError } from './errors.mjs';

/** Context lines around each change, as `git diff` (-U3). */
export const CONTEXT_LINES = 3;
/** git's binary heuristic: a NUL within the first 8000 bytes. */
const BINARY_SNIFF_CHARS = 8000;

/** True when either version looks binary by git's NUL heuristic. */
export function looksBinary(text) {
  return text.slice(0, BINARY_SNIFF_CHARS).includes('\u0000');
}

/**
 * Lines of a text. The last line of a text without a trailing newline keeps a
 * marker in its comparison key, so "x" and "x\n" differ as they do in git.
 */
function splitLines(text) {
  if (text === '') return { texts: [], keys: [], lastNoNewline: false };
  const texts = text.split('\n');
  const lastNoNewline = !text.endsWith('\n');
  if (!lastNoNewline) texts.pop();
  const keys = texts.map((t, i) => (lastNoNewline && i === texts.length - 1 ? `${t}\n` : t));
  return { texts, keys, lastNoNewline };
}

/**
 * The middle snake of a[aLo,aHi) vs b[bLo,bHi): the overlapping forward and
 * backward paths of an optimal edit script. Returns its start (x, y), end
 * (u, v), relative to aLo/bLo, and the edit distance d of the range.
 */
function middleSnake(a, aLo, aHi, b, bLo, bHi, maxD) {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const delta = n - m;
  const odd = (delta & 1) !== 0;
  const limit = Math.ceil((n + m) / 2);
  const off = limit + 1;
  const vf = new Int32Array(2 * limit + 3);
  const vb = new Int32Array(2 * limit + 3);
  for (let d = 0; d <= limit; d++) {
    if (2 * d - 1 > maxD) {
      throw new CcoxError('file_over_budget', `more than ${maxD} changed lines`);
    }
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && vf[off + k - 1] < vf[off + k + 1]) ? vf[off + k + 1] : vf[off + k - 1] + 1;
      let y = x - k;
      const x0 = x;
      const y0 = y;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x += 1;
        y += 1;
      }
      vf[off + k] = x;
      if (odd && k >= delta - (d - 1) && k <= delta + (d - 1) && x + vb[off + delta - k] >= n) {
        return { x: x0, y: y0, u: x, v: y, d: 2 * d - 1 };
      }
    }
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && vb[off + k - 1] < vb[off + k + 1]) ? vb[off + k + 1] : vb[off + k - 1] + 1;
      let y = x - k;
      const x0 = x;
      const y0 = y;
      while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) {
        x += 1;
        y += 1;
      }
      vb[off + k] = x;
      if (!odd && delta - k >= -d && delta - k <= d && x + vf[off + delta - k] >= n) {
        return { x: n - x, y: m - y, u: n - x0, v: m - y0, d: 2 * d };
      }
    }
  }
  throw new CcoxError('internal', 'line diff found no middle snake');
}

/** Append the matched index pairs [i, j] of an optimal alignment, in order. */
function align(a, aLo, aHi, b, bLo, bHi, maxD, out) {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    out.push([aLo, bLo]);
    aLo += 1;
    bLo += 1;
  }
  const tail = [];
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
    aHi -= 1;
    bHi -= 1;
    tail.push([aHi, bHi]);
  }
  if (aLo < aHi && bLo < bHi) {
    const s = middleSnake(a, aLo, aHi, b, bLo, bHi, maxD);
    align(a, aLo, aLo + s.x, b, bLo, bLo + s.y, maxD, out);
    for (let i = 0; i < s.u - s.x; i++) out.push([aLo + s.x + i, bLo + s.y + i]);
    align(a, aLo + s.u, aHi, b, bLo + s.v, bHi, maxD, out);
  }
  for (let i = tail.length - 1; i >= 0; i--) out.push(tail[i]);
}

/** The edit script as one op per line: context, removed or added, with 0-based indexes. */
function editScript(a, b, maxD) {
  const pairs = [];
  align(a, 0, a.length, b, 0, b.length, maxD, pairs);
  const ops = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length]]) {
    for (; i < pi; i++) ops.push({ type: 'removed', i, j: null });
    for (; j < pj; j++) ops.push({ type: 'added', i: null, j });
    if (pi < a.length) ops.push({ type: 'context', i: pi, j: pj });
    i = pi + 1;
    j = pj + 1;
  }
  const changed = ops.filter((o) => o.type !== 'context').length;
  if (changed > maxD) throw new CcoxError('file_over_budget', `more than ${maxD} changed lines`);
  return ops;
}

/** git's hunk start: the first line number, or the line before the hunk when that side is empty. */
function hunkStart(count, linesBefore) {
  return count > 0 ? linesBefore + 1 : linesBefore;
}

/**
 * Unified-diff hunks turning `oldText` into `newText`, shaped as parsePatch()
 * returns them. Refuses an edit script of more than `maxChangedLines` lines.
 */
export function diffHunks(oldText, newText, maxChangedLines) {
  if (!Number.isSafeInteger(maxChangedLines) || maxChangedLines < 0) {
    throw new CcoxError('internal', `maxChangedLines must be a non-negative integer, got ${maxChangedLines}`);
  }
  const before = splitLines(oldText);
  const after = splitLines(newText);
  const ops = editScript(before.keys, after.keys, maxChangedLines);
  const changes = ops.flatMap((o, k) => (o.type === 'context' ? [] : [k]));
  const groups = [];
  for (const k of changes) {
    const last = groups[groups.length - 1];
    if (last && k - last.end - 1 <= 2 * CONTEXT_LINES) last.end = k;
    else groups.push({ start: k, end: k });
  }
  return groups.map(({ start, end }) => {
    const from = Math.max(0, start - CONTEXT_LINES);
    const slice = ops.slice(from, Math.min(ops.length, end + CONTEXT_LINES + 1));
    const lines = slice.map((o) => {
      const line = {
        type: o.type,
        text: o.type === 'added' ? after.texts[o.j] : before.texts[o.i],
        oldLine: o.i === null ? null : o.i + 1,
        newLine: o.j === null ? null : o.j + 1,
      };
      const lastOld = o.i !== null && o.type !== 'added' && before.lastNoNewline && o.i === before.texts.length - 1;
      const lastNew = o.j !== null && after.lastNoNewline && o.j === after.texts.length - 1;
      if (lastOld || lastNew) line.noNewlineAtEnd = true;
      return line;
    });
    const oldCount = slice.filter((o) => o.i !== null).length;
    const newCount = slice.filter((o) => o.j !== null).length;
    const oldStart = hunkStart(oldCount, countBefore(ops, from, 'i'));
    const newStart = hunkStart(newCount, countBefore(ops, from, 'j'));
    return {
      oldStart, oldCount, newStart, newCount,
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      lines,
    };
  });
}

/** Lines of one side ('i' old, 'j' new) that precede ops[k]. */
function countBefore(ops, k, side) {
  return ops.slice(0, k).filter((o) => o[side] !== null).length;
}
