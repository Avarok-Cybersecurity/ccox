import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseUnifiedDiff } from '../src/core/diff.mjs';
import { compileAllowlist, partitionFiles } from '../src/core/scope.mjs';
import { parseDefinition } from '../src/core/prompt.mjs';
import { judgeResponse, validateAgainstSchema, verdictSchema } from '../src/core/verdict.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const response = (name) => JSON.parse(read(`./fixtures/responses/${name}`));
const definition = parseDefinition('sample.md', read('./fixtures/definitions/sample.md'));
const schema = verdictSchema(definition.rules);
// The batch the oracle saw: only the in-scope file of pr.diff.
const { scanned } = partitionFiles(parseUnifiedDiff(read('./fixtures/diffs/pr.diff')), compileAllowlist(['crates/']));
const judge = (mode, name) => judgeResponse({ mode, data: response(name), schema, files: scanned });

// The violations exactly as the live model answered (fixtures/responses/provenance.json).
const EXPECTED_VIOLATION = {
  file: 'crates/core/src/lib.rs', line_start: 5, line_end: 7, rule: 'io-in-core',
  explanation: 'Core file reads filesystem via std::fs::read_to_string, violating io-in-core rule.',
  evidence: 'pub fn load(path: &str) -> String {    std::fs::read_to_string(path).unwrap()}',
};
const TEXT_VIOLATION = {
  ...EXPECTED_VIOLATION,
  explanation: 'The added function `load` uses `std::fs::read_to_string` to read from the filesystem, which is prohibited in core business logic.',
  evidence: 'pub fn load(path: &str) -> String {\n    std::fs::read_to_string(path).unwrap()\n}',
};

for (const [mode, name, expected] of [
  ['tool_call', 'tool_call-violation.json', EXPECTED_VIOLATION],
  ['tool_call', 'tool_call-arguments-object.json', EXPECTED_VIOLATION],
  ['json_schema', 'json_schema-violation.json', EXPECTED_VIOLATION],
  ['text', 'text-violation.json', TEXT_VIOLATION],
]) {
  test(`${mode}: ${name} parses to one violation`, () => {
    const r = judge(mode, name);
    assert.equal(r.status, 'violations');
    assert.equal(r.verdict, 'non_compliant');
    assert.deepEqual(r.violations, [expected]);
    assert.equal(r.error, null);
  });
}

test('tool_call: compliant answer is a pass with no violations', () => {
  const r = judge('tool_call', 'tool_call-compliant.json');
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.violations, []);
});

test('a response for one mode does not parse under another (no silent fallback)', () => {
  assert.equal(judge('json_schema', 'tool_call-violation.json').error.kind, 'parse');
  assert.equal(judge('tool_call', 'json_schema-violation.json').error.kind, 'parse');
  assert.equal(judge('text', 'tool_call-violation.json').error.kind, 'parse');
});

for (const [name, mode, kind] of [
  ['text-two-blocks.json', 'text', 'parse'],
  ['text-prose-and-json.json', 'text', 'parse'],
  ['tool_call-bad-json.json', 'tool_call', 'parse'],
  ['tool_call-length.json', 'tool_call', 'parse'],
  ['tool_call-prose-only.json', 'tool_call', 'parse'],
  ['tool_call-inconsistent.json', 'tool_call', 'invalid_verdict'],
  ['tool_call-unknown-rule.json', 'tool_call', 'invalid_verdict'],
  ['tool_call-extra-key.json', 'tool_call', 'invalid_verdict'],
]) {
  test(`${name} is an error of kind ${kind}, never a pass`, () => {
    const r = judge(mode, name);
    assert.equal(r.status, 'error');
    assert.equal(r.error.kind, kind);
    assert.deepEqual(r.violations, []);
  });
}

test('a violation naming an out-of-scope file is rejected and the batch errors', () => {
  const r = judge('tool_call', 'tool_call-out-of-scope.json');
  assert.equal(r.status, 'error');
  assert.equal(r.error.kind, 'invalid_violation');
  assert.equal(r.rejected_violations.length, 1);
  assert.equal(r.rejected_violations[0].file, 'docs/crates/notes.md');
  assert.match(r.rejected_violations[0].reason, /not one of the scoped files/);
});

test('a violation citing lines outside every hunk is rejected and the batch errors', () => {
  const r = judge('tool_call', 'tool_call-outside-hunk.json');
  assert.equal(r.status, 'error');
  assert.equal(r.error.kind, 'invalid_violation');
  assert.match(r.rejected_violations[0].reason, /not inside a single hunk/);
});

test('a line range running past the end of its hunk is rejected; one inside it is accepted', () => {
  const files = parseUnifiedDiff(read('./fixtures/diffs/renames.diff')).filter((f) => f.hunks.length > 0);
  const data = response('tool_call-violation.json');
  const args = { verdict: 'non_compliant', injection_suspected: false, violations: [{ ...EXPECTED_VIOLATION, file: 'crates/core/r2.rs', line_start: 13, line_end: 14 }] };
  data.choices[0].message.tool_calls[0].function.arguments = JSON.stringify(args);
  assert.equal(judgeResponse({ mode: 'tool_call', data, schema, files }).error.kind, 'invalid_violation');
  args.violations[0].line_end = 13;
  data.choices[0].message.tool_calls[0].function.arguments = JSON.stringify(args);
  assert.equal(judgeResponse({ mode: 'tool_call', data, schema, files }).status, 'violations');
});

test('injection suspected + compliant is an error, not a pass; the flag surfaces', () => {
  const r = judge('tool_call', 'tool_call-injection-compliant.json');
  assert.equal(r.status, 'error');
  assert.equal(r.error.kind, 'injection_suspected');
  assert.equal(r.injection_suspected, true);
});

test('injection suspected + violations keeps the violations and the flag', () => {
  // Recorded on injection.diff, so judged against that diff's scoped files.
  const files = partitionFiles(parseUnifiedDiff(read('./fixtures/diffs/injection.diff')), compileAllowlist(['crates/'])).scanned;
  const r = judgeResponse({ mode: 'tool_call', data: response('tool_call-injection-violation.json'), schema, files });
  assert.equal(r.status, 'violations');
  assert.equal(r.injection_suspected, true);
  assert.deepEqual(r.violations.map((v) => [v.file, v.line_start, v.line_end, v.rule]), [['crates/ledger-core/src/export.rs', 24, 24, 'io-in-core']]);
});

test('schema validator rejects wrong types, missing keys and bad integers', () => {
  const ok = { verdict: 'compliant', injection_suspected: false, violations: [] };
  assert.deepEqual(validateAgainstSchema(ok, schema), []);
  assert.ok(validateAgainstSchema({ ...ok, injection_suspected: 'no' }, schema).length > 0);
  assert.ok(validateAgainstSchema({ verdict: 'compliant', violations: [] }, schema).length > 0);
  const v = { ...EXPECTED_VIOLATION, line_start: 1.5 };
  assert.ok(validateAgainstSchema({ verdict: 'non_compliant', injection_suspected: false, violations: [v] }, schema).length > 0);
  assert.ok(validateAgainstSchema({ verdict: 'non_compliant', injection_suspected: false, violations: [{ ...EXPECTED_VIOLATION, line_start: 0 }] }, schema).length > 0);
});
