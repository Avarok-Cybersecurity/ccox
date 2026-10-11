// The live self-test's wiring and its assertion logic, offline. The live run
// itself is .github/workflows/selftest.yml; this suite proves that its
// assertion rejects every wrong outcome, and that the workflow, the fixtures
// and expectations.json name the same fixtures (one source of truth).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { parseUnifiedDiff } from '../src/core/diff.mjs';
import { compileAllowlist, partitionFiles } from '../src/core/scope.mjs';
import { aggregateCompliance, buildReport } from '../src/core/report.mjs';
import { checkRun } from './selftest/check.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const expectations = JSON.parse(read('./selftest/expectations.json'));
const workflow = read('../.github/workflows/selftest.yml');

const definition = { name: 'sbio', sha256: '0'.repeat(64), rules: ['io-in-core', 'clock-in-core'] };
const IO = { file: 'crates/ledger-core/src/statement.rs', line_start: 43, line_end: 46, rule: 'io-in-core', explanation: 'reads a file', evidence: 'std::fs::read_to_string' };
const CLOCK = { file: 'crates/ledger-core/src/aging.rs', line_start: 28, line_end: 28, rule: 'clock-in-core', explanation: 'reads the clock', evidence: 'SystemTime::now()' };

/** A report the way main.mjs builds it, for `fixture`, from per-batch judge results. */
function reportFor(fixture, results, error = null) {
  const files = parseUnifiedDiff(read(`./fixtures/diffs/${fixture}.diff`));
  const { scanned, excluded, skipped } = partitionFiles(files, compileAllowlist(['crates/']));
  const batches = results.map((result, index) => ({ index, files: scanned.map((f) => f.path), raw_response_sha256: 'f'.repeat(64), response_model: 'm', result }));
  const scope = { allowed_directories: ['crates/'], files_changed: files.length, files_scanned: scanned.map((f) => f.path), files_excluded: excluded, files_skipped: skipped, scanned_bytes: 1, max_diff_bytes: 60000, batches: results.length };
  return buildReport({ generatedAt: 't', action: { repository: null, ref: null }, context: null, scope, model: null, compliances: [aggregateCompliance(definition, batches)], error });
}

const answered = (violations, injection = false) => ({
  status: violations.length > 0 ? 'violations' : 'pass', verdict: violations.length > 0 ? 'non_compliant' : 'compliant',
  injection_suspected: injection, violations, rejected_violations: [], error: null,
});
const outputsOf = (report) => ({ status: report.status, violations: report.totals.violation_count === null ? '' : String(report.totals.violation_count) });
const run = (fixture, report, overrides = {}) => checkRun({
  outcomes: expectations[fixture], outcome: report.status === 'pass' ? 'success' : 'failure', outputs: outputsOf(report), report, ...overrides,
});

test('workflow matrix, fixture diffs and expectations name the same fixtures', () => {
  const m = /^ {8}fixture: \[([^\]]+)\]$/m.exec(workflow);
  assert.ok(m, 'selftest.yml declares a fixture matrix');
  const matrix = m[1].split(',').map((s) => s.trim());
  assert.deepEqual([...matrix].sort(), Object.keys(expectations).sort());
  for (const name of matrix) assert.ok(existsSync(new URL(`./fixtures/diffs/${name}.diff`, import.meta.url)), name);
  assert.match(workflow, /diff-file: test\/fixtures\/diffs\/\$\{\{ matrix\.fixture \}\}\.diff/);
  assert.match(workflow, /compliance-definitions-path: ''/, 'the self-test judges with the bundled definitions');
});

test('every expectation key is known and every cited line is an added line of its fixture', () => {
  for (const [fixture, outcomes] of Object.entries(expectations)) {
    const files = new Map(parseUnifiedDiff(read(`./fixtures/diffs/${fixture}.diff`)).map((f) => [f.path, f]));
    for (const o of outcomes) {
      for (const c of o.must_cite ?? []) {
        const added = files.get(c.file)?.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'added').map((l) => l.newLine) ?? [];
        assert.ok(added.includes(c.line), `${fixture}: ${c.file}:${c.line} is not an added line`);
      }
    }
  }
});

test('known-violating: both citations present passes; each wrong answer fails', () => {
  assert.deepEqual(run('known-violating', reportFor('known-violating', [answered([IO, CLOCK])])), []);
  const wrong = {
    'clock missing': [answered([IO])],
    'wrong rule': [answered([IO, { ...CLOCK, rule: 'io-in-core' }])],
    'line not covered': [answered([IO, { ...CLOCK, line_start: 29, line_end: 30 }])],
    'compliant answer': [answered([])],
    'injection flagged': [answered([IO, CLOCK], true)],
    'two model calls': [answered([IO, CLOCK]), answered([])],
  };
  for (const [why, results] of Object.entries(wrong)) {
    assert.notDeepEqual(run('known-violating', reportFor('known-violating', results)), [], why);
  }
});

test('injection: violations with the flag, or the injection_suspected error, pass; nothing else does', () => {
  const write = { ...IO, file: 'crates/ledger-core/src/export.rs', line_start: 21, line_end: 25 };
  assert.deepEqual(run('injection', reportFor('injection', [answered([write], true)])), []);
  const refused = { ...answered([], true), status: 'error', error: { kind: 'injection_suspected', message: 'x' } };
  assert.deepEqual(run('injection', reportFor('injection', [refused])), []);
  assert.notDeepEqual(run('injection', reportFor('injection', [answered([])])), [], 'fooled into a pass');
  assert.notDeepEqual(run('injection', reportFor('injection', [answered([write])])), [], 'injection not flagged');
  const parseError = { ...answered([]), status: 'error', verdict: null, error: { kind: 'parse', message: 'x' } };
  assert.notDeepEqual(run('injection', reportFor('injection', [parseError])), [], 'any other error');
});

test('known-compliant: a pass passes; a violation fails', () => {
  assert.deepEqual(run('known-compliant', reportFor('known-compliant', [answered([])])), []);
  assert.notDeepEqual(run('known-compliant', reportFor('known-compliant', [answered([CLOCK])])), []);
});

test('out-of-scope: zero model calls and nothing scanned; a model call fails', () => {
  assert.deepEqual(run('out-of-scope', reportFor('out-of-scope', [])), []);
  assert.notDeepEqual(run('out-of-scope', reportFor('out-of-scope', [answered([])])), []);
});

test('outputs or step outcome that disagree with the report fail the run', () => {
  const report = reportFor('known-compliant', [answered([])]);
  assert.notDeepEqual(run('known-compliant', report, { outputs: { status: 'pass', violations: '' } }), []);
  assert.notDeepEqual(run('known-compliant', report, { outputs: { status: 'violations', violations: '0' } }), []);
  assert.notDeepEqual(run('known-compliant', report, { outcome: 'failure' }), []);
  const errored = reportFor('known-compliant', [], { kind: 'quota', message: 'x' });
  assert.notDeepEqual(run('known-compliant', errored), [], 'an errored run never matches a pass');
});

test('an unknown expectation key is a problem, not a silently skipped check', () => {
  const report = reportFor('known-compliant', [answered([])]);
  const problems = run('known-compliant', report, { outcomes: [{ status: 'pass', violatons: 0 }] });
  assert.ok(problems.some((p) => /unknown expectation key "violatons"/.test(p)), problems.join('\n'));
});
