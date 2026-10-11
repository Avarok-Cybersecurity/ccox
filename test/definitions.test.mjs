// The definitions bundled with the action (compliances/) are what a consumer
// gets with `compliance-definitions-path: ''`. They load through the same
// parser the action uses, and sbio.md declares exactly its documented rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readMarkdownDir } from '../src/adapters/fs.mjs';
import { loadDefinitions } from '../src/core/prompt.mjs';

const dir = fileURLToPath(new URL('../compliances', import.meta.url));

test('every file in compliances/ is a loadable definition', () => {
  const names = readdirSync(dir);
  assert.ok(names.length > 0);
  for (const n of names) assert.match(n, /^[a-z0-9][a-z0-9-]*\.md$/, `${n} is not a definition file`);
  assert.equal(loadDefinitions(readMarkdownDir(dir)).length, names.length);
});

test('sbio.md declares its five rules, stays within 300 lines, and keeps each code block within 25 lines', () => {
  const sbio = loadDefinitions(readMarkdownDir(dir)).find((d) => d.name === 'sbio');
  assert.ok(sbio, 'compliances/sbio.md is bundled');
  assert.deepEqual(sbio.rules, ['io-in-core', 'concrete-adapter-in-core', 'config-in-core', 'clock-in-core', 'implicit-default']);
  assert.ok(sbio.text.split('\n').length <= 300);
  const blocks = [...sbio.text.matchAll(/```rust\n([\s\S]*?)```/g)].map((m) => m[1].split('\n').length - 1);
  assert.ok(blocks.length >= 8, `expected a non-compliant and a compliant block per example, found ${blocks.length}`);
  for (const n of blocks) assert.ok(n <= 25, `a code block has ${n} lines`);
});
