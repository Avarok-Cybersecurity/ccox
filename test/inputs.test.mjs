import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  INPUT_SPEC, actionIdentity, parseInputs, planDefinitionsSource, planDiffSource, resolveEventContext,
} from '../src/core/inputs.mjs';

const VALID = Object.freeze({
  provider: 'openrouter',
  endpoint: 'https://openrouter.ai/api/v1/',
  'api-key': 'sk-test',
  model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
  'structured-mode': 'tool_call',
  'allowed-directories': 'crates/\n\n  src/  \n',
  'compliance-definitions-path': 'compliances/',
  'max-diff-bytes': '60000',
  seed: '42',
  'reasoning-effort': 'low',
  'max-tokens': '8192',
  'request-timeout-ms': '300000',
  'max-retries': '3',
  'report-dir': 'ccox-report',
  'artifact-name': 'ccox-report-ccox-1',
  'artifact-retention-days': '90',
  'comment-on-pr': 'true',
  'github-token': 'ghs_x',
  'diff-file': '',
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('a complete input set parses, normalised', () => {
  const r = parseInputs(VALID);
  assert.equal(r.ok, true);
  assert.equal(r.config.endpoint, 'https://openrouter.ai/api/v1');
  assert.deepEqual(r.config.allowedDirectories, ['crates/', 'src/']);
  assert.equal(r.config.definitionsPath, 'compliances');
  assert.equal(r.config.maxAttempts, 3);
  assert.equal(r.config.commentOnPr, true);
});

test('every required input is required: all missing ones are reported together', () => {
  const r = parseInputs({});
  assert.equal(r.ok, false);
  const required = INPUT_SPEC.filter((s) => !s.kind.startsWith('optional-')).map((s) => s.name);
  for (const name of required) assert.ok(r.problems.some((p) => p.includes(`"${name}"`) || p.includes(name)), name);
  assert.equal(r.reportDir, null);
});

test('an input error still yields a usable report-dir', () => {
  const r = parseInputs({ ...VALID, seed: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reportDir, 'ccox-report');
});

for (const [name, value] of [
  ['provider', 'acme'], ['structured-mode', 'json'], ['reasoning-effort', 'max'], ['comment-on-pr', 'yes'],
  ['seed', '-1'], ['max-diff-bytes', '10'], ['max-retries', '0'], ['artifact-retention-days', '91'],
  ['endpoint', 'http://openrouter.ai/api/v1'], ['endpoint', 'not a url'],
  ['compliance-definitions-path', '../other'], ['compliance-definitions-path', '/abs'],
  ['allowed-directories', '\n \n'], ['allowed-directories', 'crates/('],
]) {
  test(`invalid ${name}=${JSON.stringify(value)} is refused`, () => {
    const r = parseInputs({ ...VALID, [name]: value });
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 1);
  });
}

test('plain http is accepted only for a loopback endpoint', () => {
  assert.equal(parseInputs({ ...VALID, endpoint: 'http://127.0.0.1:8080/v1' }).ok, true);
});

test('github-token is required whenever GitHub is needed', () => {
  assert.equal(parseInputs({ ...VALID, 'github-token': '' }).ok, false);
  const selfTest = { ...VALID, 'github-token': '', 'diff-file': 'x.diff', 'compliance-definitions-path': '', 'comment-on-pr': 'false' };
  assert.equal(parseInputs(selfTest).ok, true);
});

test('event: pull_request_target and merge_group resolve their shas', () => {
  const pr = resolveEventContext({
    eventName: 'pull_request_target', repository: 'o/r',
    event: { pull_request: { number: 7, base: { sha: SHA_A }, head: { sha: SHA_B } } },
  });
  assert.deepEqual(pr, { kind: 'pull', eventName: 'pull_request_target', repository: 'o/r', pr: 7, baseSha: SHA_A, headSha: SHA_B });
  const mg = resolveEventContext({
    eventName: 'merge_group', repository: 'o/r', event: { merge_group: { base_sha: SHA_A, head_sha: SHA_B } },
  });
  assert.equal(mg.kind, 'merge_group');
  assert.equal(mg.pr, null);
  assert.throws(() => resolveEventContext({ eventName: 'merge_group', repository: 'o/r', event: {} }), (e) => e.kind === 'event');
});

test('diff source: pulls for PRs, compare for merge groups, diff-file overrides, other events refused', () => {
  const cfg = parseInputs(VALID).config;
  const pr = { kind: 'pull', eventName: 'pull_request_target', pr: 7, baseSha: SHA_A, headSha: SHA_B };
  const mg = { kind: 'merge_group', eventName: 'merge_group', pr: null, baseSha: SHA_A, headSha: SHA_B };
  const push = { kind: 'other', eventName: 'push', pr: null, baseSha: null, headSha: null };
  assert.deepEqual(planDiffSource(cfg, pr), { type: 'pulls', pr: 7 });
  assert.deepEqual(planDiffSource(cfg, mg), { type: 'compare', base: SHA_A, head: SHA_B });
  assert.deepEqual(planDiffSource({ ...cfg, diffFile: 'x.diff' }, push), { type: 'diff-file', path: 'x.diff' });
  assert.throws(() => planDiffSource(cfg, push), (e) => e.kind === 'event');
});

test('definitions are read at the BASE sha, never the head; bundled when unset', () => {
  const cfg = parseInputs(VALID).config;
  const pr = { kind: 'pull', eventName: 'pull_request_target', pr: 7, baseSha: SHA_A, headSha: SHA_B };
  assert.deepEqual(planDefinitionsSource(cfg, pr), { type: 'base-ref', path: 'compliances', ref: SHA_A });
  assert.deepEqual(planDefinitionsSource({ ...cfg, definitionsPath: '' }, pr), { type: 'bundled', path: 'compliances', ref: null });
  const push = { kind: 'other', eventName: 'push', baseSha: null };
  assert.throws(() => planDefinitionsSource(cfg, push), (e) => e.kind === 'event');
});

test('action identity: explicit, derived from the action path, or null for a local action', () => {
  assert.deepEqual(actionIdentity({ repository: 'A/ccox', ref: 'v1', actionPath: '' }), { repository: 'A/ccox', ref: 'v1' });
  assert.deepEqual(
    actionIdentity({ repository: '', ref: '', actionPath: '/home/runner/work/_actions/Avarok-Cybersecurity/ccox/v1' }),
    { repository: 'Avarok-Cybersecurity/ccox', ref: 'v1' },
  );
  assert.deepEqual(actionIdentity({ actionPath: '/home/runner/work/repo/repo' }), { repository: null, ref: null });
});

test('action.yml declares exactly the inputs the entrypoint reads, each mapped to its INPUT_ env', () => {
  const yml = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  const inputsBlock = yml.slice(yml.indexOf('\ninputs:\n'), yml.indexOf('\noutputs:\n'));
  const declared = [...inputsBlock.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]);
  assert.deepEqual(declared.sort(), INPUT_SPEC.map((s) => s.name).sort());
  for (const { name } of INPUT_SPEC) {
    const env = `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
    assert.ok(yml.includes(`${env}: \${{ inputs.${name} }}`), `${env} mapping`);
  }
});
