// diff.mjs — parse a git unified diff (as GitHub's diff media type returns it).
//
// Contract: every byte of input belongs to a `diff --git` section; hunk line
// counts are honoured exactly, so a diff cut short mid-hunk raises
// `diff_truncated` instead of quietly yielding fewer lines. Paths come from
// the most specific header available (+++/---, rename/copy lines, then the
// `diff --git` line) with git's C-style quoting decoded.

import { CcoxError } from './errors.mjs';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// Extended header lines git may emit between `diff --git` and the first hunk.
const IGNORED_HEADERS = [
  'old mode ', 'new mode ', 'similarity index ', 'dissimilarity index ', 'index ',
];

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Decode git's C-style quoted path ("a/tab\tname") into a string. */
export function unquoteGitPath(token) {
  if (!token.startsWith('"')) return token;
  if (!token.endsWith('"') || token.length < 2) {
    throw new CcoxError('diff', `malformed quoted path ${JSON.stringify(token)}`);
  }
  const body = token.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body[i + 1];
    if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]);
      i += 1;
    } else if (/^[0-7]{3}$/.test(body.slice(i + 1, i + 4))) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      throw new CcoxError('diff', `unknown escape in quoted path ${JSON.stringify(token)}`);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Path from a `--- a/x` / `+++ b/x` marker; null for /dev/null. */
function markerPath(rest, prefix) {
  // git appends a TAB after names that contain spaces.
  const token = rest.endsWith('\t') ? rest.slice(0, -1) : rest;
  if (token === '/dev/null') return null;
  const path = unquoteGitPath(token);
  if (!path.startsWith(prefix)) {
    throw new CcoxError('diff', `expected ${prefix} prefix in ${JSON.stringify(rest)}`);
  }
  return path.slice(prefix.length);
}

/** Paths from `diff --git a/X b/Y`; null when the unquoted form is ambiguous. */
function gitHeaderPaths(rest) {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(rest);
    if (!m) return null;
    return { a: unquoteGitPath(m[1]).slice(2), b: unquoteGitPath(m[2]).slice(2) };
  }
  if ((rest.length - 1) % 2 !== 0) return null;
  const half = (rest.length - 1) / 2;
  const a = rest.slice(0, half);
  const b = rest.slice(half + 1);
  if (!a.startsWith('a/') || !b.startsWith('b/') || a.slice(2) !== b.slice(2)) return null;
  return { a: a.slice(2), b: b.slice(2) };
}

function parseHunk(lines, start, path) {
  const m = HUNK_RE.exec(lines[start]);
  if (!m) throw new CcoxError('diff', `malformed hunk header in ${path}: ${JSON.stringify(lines[start])}`);
  const hunk = {
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
    header: lines[start],
    lines: [],
  };
  let oldLeft = hunk.oldCount;
  let newLeft = hunk.newCount;
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let i = start + 1;
  while (oldLeft > 0 || newLeft > 0) {
    if (i >= lines.length || lines[i].startsWith('diff --git ') || lines[i].startsWith('@@')) {
      throw new CcoxError(
        'diff_truncated',
        `hunk ${hunk.header} in ${path} ends early (${oldLeft} old / ${newLeft} new lines missing)`,
      );
    }
    const line = lines[i];
    const tag = line === '' ? ' ' : line[0];
    const text = line.slice(1);
    if (tag === ' ') {
      hunk.lines.push({ type: 'context', text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      oldLeft -= 1;
      newLeft -= 1;
    } else if (tag === '-') {
      hunk.lines.push({ type: 'removed', text, oldLine, newLine: null });
      oldLine += 1;
      oldLeft -= 1;
    } else if (tag === '+') {
      hunk.lines.push({ type: 'added', text, oldLine: null, newLine });
      newLine += 1;
      newLeft -= 1;
    } else if (tag === '\\') {
      markNoNewline(hunk, path);
    } else {
      throw new CcoxError('diff', `unexpected line in hunk ${hunk.header} of ${path}: ${JSON.stringify(line.slice(0, 80))}`);
    }
    if (oldLeft < 0 || newLeft < 0) {
      throw new CcoxError('diff', `hunk ${hunk.header} in ${path} has more lines than its header declares`);
    }
    i += 1;
  }
  while (i < lines.length && lines[i].startsWith('\\')) {
    markNoNewline(hunk, path);
    i += 1;
  }
  return { hunk, next: i };
}

function markNoNewline(hunk, path) {
  const last = hunk.lines[hunk.lines.length - 1];
  if (!last) throw new CcoxError('diff', `"\\ No newline" marker before any line in ${path}`);
  last.noNewlineAtEnd = true;
}

/**
 * Parse a unified diff into file records:
 *   { path, oldPath, newPath, status, binary, hunks: [{ oldStart, oldCount,
 *     newStart, newCount, header, lines: [{ type, text, oldLine, newLine }] }] }
 * `status` is added | deleted | renamed | copied | modified; `path` is the new
 * path (the old one for deletions).
 */
export function parseUnifiedDiff(text) {
  if (typeof text !== 'string') throw new CcoxError('diff', 'diff is not text');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const files = [];
  let i = 0;
  while (i < lines.length) {
    const first = lines[i];
    if (!first.startsWith('diff --git ')) {
      throw new CcoxError('diff', `line ${i + 1} is outside any "diff --git" section: ${JSON.stringify(first.slice(0, 80))}`);
    }
    const header = gitHeaderPaths(first.slice('diff --git '.length));
    const rec = { status: 'modified', binary: false, minus: undefined, plus: undefined, from: null, to: null };
    i += 1;
    while (i < lines.length && !lines[i].startsWith('diff --git ') && !lines[i].startsWith('@@')) {
      i = parseHeaderLine(lines, i, rec);
    }
    const oldPath = rec.minus !== undefined ? rec.minus : rec.from ?? header?.a ?? null;
    const newPath = rec.plus !== undefined ? rec.plus : rec.to ?? header?.b ?? null;
    if (rec.status === 'added' && oldPath !== null && rec.minus !== undefined) {
      throw new CcoxError('diff', `added file ${newPath} has a non-null old side`);
    }
    const path = rec.status === 'deleted' ? oldPath : newPath;
    if (!path) throw new CcoxError('diff', `cannot determine the path of section ${JSON.stringify(first.slice(0, 120))}`);
    const file = {
      path,
      oldPath: rec.status === 'added' ? null : oldPath,
      newPath: rec.status === 'deleted' ? null : newPath,
      status: rec.status,
      binary: rec.binary,
      hunks: [],
    };
    while (i < lines.length && lines[i].startsWith('@@')) {
      if (file.binary) throw new CcoxError('diff', `binary file ${path} carries a text hunk`);
      const { hunk, next } = parseHunk(lines, i, path);
      file.hunks.push(hunk);
      i = next;
    }
    if (i < lines.length && !lines[i].startsWith('diff --git ')) {
      throw new CcoxError('diff', `unexpected line after the hunks of ${path}: ${JSON.stringify(lines[i].slice(0, 80))}`);
    }
    files.push(file);
  }
  return files;
}

function parseHeaderLine(lines, i, rec) {
  const h = lines[i];
  if (h.startsWith('--- ')) rec.minus = markerPath(h.slice(4), 'a/');
  else if (h.startsWith('+++ ')) rec.plus = markerPath(h.slice(4), 'b/');
  else if (h.startsWith('new file mode ')) rec.status = 'added';
  else if (h.startsWith('deleted file mode ')) rec.status = 'deleted';
  else if (h.startsWith('rename from ')) {
    rec.status = 'renamed';
    rec.from = unquoteGitPath(h.slice('rename from '.length));
  } else if (h.startsWith('rename to ')) rec.to = unquoteGitPath(h.slice('rename to '.length));
  else if (h.startsWith('copy from ')) {
    rec.status = 'copied';
    rec.from = unquoteGitPath(h.slice('copy from '.length));
  } else if (h.startsWith('copy to ')) rec.to = unquoteGitPath(h.slice('copy to '.length));
  else if (h.startsWith('Binary files ') && h.endsWith(' differ')) rec.binary = true;
  else if (h === 'GIT binary patch') {
    rec.binary = true;
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('diff --git ')) j += 1;
    return j;
  } else if (!IGNORED_HEADERS.some((p) => h.startsWith(p))) {
    throw new CcoxError('diff', `unknown diff header line: ${JSON.stringify(h.slice(0, 80))}`);
  }
  return i + 1;
}

/** Every [start, end] new-file line range covered by a file's hunks (empty ranges dropped). */
export function newSideRanges(file) {
  return file.hunks
    .filter((h) => h.newCount > 0)
    .map((h) => ({ start: h.newStart, end: h.newStart + h.newCount - 1 }));
}
