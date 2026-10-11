// The README's usage snippet is what consumers copy into a workflow that runs
// on pull_request_target with secrets. It must never check out the PR head.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const actionYml = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');

function usageSnippet() {
  const begin = readme.indexOf('<!-- ccox:usage:begin -->');
  const end = readme.indexOf('<!-- ccox:usage:end -->');
  assert.ok(begin !== -1 && end > begin, 'README carries the usage markers');
  const m = /```yaml\n([\s\S]*?)\n```/.exec(readme.slice(begin, end));
  assert.ok(m, 'a yaml block sits between the markers');
  return m[1];
}

const HEAD_CHECKOUT = [
  /actions\/checkout/i,
  /github\.event\.pull_request\.head/,
  /github\.head_ref/,
  /refs\/pull\//,
  /merge_group\.head_(sha|ref)/,
  /^\s*ref:/m,
];

test('the usage snippet has no checkout step and no head-ref checkout', () => {
  const snippet = usageSnippet();
  for (const re of HEAD_CHECKOUT) assert.doesNotMatch(snippet, re);
  assert.doesNotMatch(snippet, /^\s*(run|shell):/m, 'no step that could execute PR content');
});

test('the usage snippet triggers on pull_request_target and merge_group with minimal permissions', () => {
  const snippet = usageSnippet();
  assert.match(snippet, /^on:\n {2}pull_request_target:\n {2}merge_group:\n/m);
  assert.doesNotMatch(snippet, /^ {2}pull_request:/m);
  assert.match(snippet, /^permissions:\n {2}contents: read\n {2}pull-requests: write\n\n/m);
  assert.equal((snippet.match(/^\s+- uses:/gm) ?? []).length, 1, 'exactly one step: CCOX itself');
  assert.match(snippet, /- uses: Avarok-Cybersecurity\/ccox@/);
});

test('the usage snippet sets every required input of action.yml', () => {
  const block = actionYml.slice(actionYml.indexOf('\ninputs:\n'), actionYml.indexOf('\noutputs:\n'));
  const required = [...block.matchAll(/^ {2}([a-z0-9-]+):\n(?: {4}.*\n)*? {4}required: true$/gm)].map((m) => m[1]);
  assert.ok(required.length >= 10, `found required inputs: ${required}`);
  const snippet = usageSnippet();
  for (const name of required) assert.match(snippet, new RegExp(`^ {10}${name}:`, 'm'), name);
});

test('action.yml itself never checks out code', () => {
  for (const re of HEAD_CHECKOUT.slice(0, 4)) assert.doesNotMatch(actionYml, re);
  const uses = [...actionYml.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.deepEqual(uses, ['actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a']);
});
