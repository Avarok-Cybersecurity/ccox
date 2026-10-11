// fs.mjs — local filesystem I/O: the event payload, a diff file, bundled
// definitions, and the report/summary/outputs CCOX writes.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CcoxError } from '../core/errors.mjs';

export function readText(path, kind) {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new CcoxError(kind, `cannot read ${path}: ${e.message}`);
  }
}

export function readJson(path, kind) {
  const text = readText(path, kind);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CcoxError(kind, `${path} is not valid JSON: ${e.message}`);
  }
}

/** Every *.md directly inside `dir`, as { fileName, text }. */
export function readMarkdownDir(dir) {
  if (!existsSync(dir)) throw new CcoxError('definitions', `definitions directory ${dir} does not exist`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => ({ fileName: e.name, text: readText(join(dir, e.name), 'definitions') }));
}

export function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function appendText(path, text) {
  appendFileSync(path, text);
}
