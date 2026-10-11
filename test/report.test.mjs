import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CcoxError, ERROR_KINDS, toErrorRecord } from '../src/core/errors.mjs';
import {
  REPORT_SCHEMA, aggregateCompliance, buildReport, exitCodeFor, mdCell, renderReportBlock, renderSummary,
} from '../src/core/report.mjs';

const DEF = { name: 'sample', sha256: 'a'.repeat(64), rules: ['io-in-core'] };
const V = { file: 'crates/a.rs', line_start: 3, line_end: 4, rule: 'io-in-core', explanation: 'reads a file', evidence: 'fs::read' };
const ok = { status: 'pass', verdict: 'compliant', injection_suspected: false, violations: [], rejected_violations: [], error: null };
const bad = { status: 'violations', verdict: 'non_compliant', injection_suspected: false, violations: [V, V], rejected_violations: [], error: null };
const failed = { status: 'error', verdict: null, violations: [], rejected_violations: [], error: { kind: 'quota', message: 'daily' } };
const batch = (index, result) => ({ index, files: ['crates/a.rs'], raw_response_sha256: 'b'.repeat(64), response_model: 'm', result });
const report = (compliances, error = null) => buildReport({
  generatedAt: '2026-10-11T00:00:00.000Z', action: { repository: null, ref: null }, context: null,
  scope: null, model: null, compliances, error,
});

test('totals: violations summed across compliances and batches', () => {
  const r = report([
    aggregateCompliance(DEF, [batch(0, ok), batch(1, bad)]),
    aggregateCompliance({ ...DEF, name: 'other' }, [batch(0, ok)]),
  ]);
  assert.equal(r.schema, REPORT_SCHEMA);
  assert.equal(r.status, 'violations');
  assert.deepEqual(r.totals, {
    compliances: 2, passed: 1, with_violations: 1, errored: 0, violation_count: 2, violations_found: 2, injection_suspected: 0,
  });
  assert.equal(r.compliances[0].verdict, 'non_compliant');
  assert.equal(exitCodeFor(r.status), 1);
});

test('all compliances passing is a pass with exit 0 and violation_count 0', () => {
  const r = report([aggregateCompliance(DEF, [batch(0, ok)])]);
  assert.equal(r.status, 'pass');
  assert.equal(r.totals.violation_count, 0);
  assert.equal(exitCodeFor(r.status), 0);
});

test('no files in scope (zero batches) passes with verdict null', () => {
  const c = aggregateCompliance(DEF, []);
  assert.equal(c.status, 'pass');
  assert.equal(c.verdict, null);
  assert.equal(report([c]).status, 'pass');
});

test('status error => exit 2, and never pass or "0 violations"', () => {
  const cases = [
    report([aggregateCompliance(DEF, [batch(0, ok), batch(1, failed)])]),
    report([aggregateCompliance(DEF, [batch(0, ok)])], { kind: 'diff', message: 'x' }),
    report([], { kind: 'input', message: 'missing' }),
    report([]), // no compliance evaluated and no error given: still an error
  ];
  for (const r of cases) {
    assert.equal(r.status, 'error');
    assert.equal(exitCodeFor(r.status), 2);
    assert.equal(r.totals.violation_count, null);
    assert.ok(r.error && ERROR_KINDS.includes(r.error.kind));
  }
  assert.equal(cases[0].error.kind, 'quota');
  assert.equal(cases[3].error.kind, 'internal');
});

test('an errored batch makes its compliance an error even when others found violations', () => {
  const c = aggregateCompliance(DEF, [batch(0, bad), batch(1, failed)]);
  assert.equal(c.status, 'error');
  assert.equal(c.verdict, null);
  assert.equal(c.violation_count, 2, 'found violations stay visible');
  const r = report([c]);
  assert.equal(r.totals.violations_found, 2);
  assert.equal(r.totals.violation_count, null);
});

test('injection flag surfaces in the compliance, the totals and the summary', () => {
  const flagged = { ...bad, injection_suspected: true };
  const r = report([aggregateCompliance(DEF, [batch(0, flagged)])]);
  assert.equal(r.compliances[0].injection_suspected, true);
  assert.equal(r.totals.injection_suspected, 1);
  assert.match(renderSummary(r), /\| sample \| VIOLATIONS \| 2 \| \*\*yes\*\* \|/);
});

test('exit codes are exactly 0/1/2 and unknown statuses are refused', () => {
  assert.deepEqual(['pass', 'violations', 'error'].map(exitCodeFor), [0, 1, 2]);
  assert.throws(() => exitCodeFor('ok'), CcoxError);
});

test('summary of an error says so and never claims a pass', () => {
  const s = renderSummary(report([], { kind: 'quota', message: 'daily model allowance exhausted' }));
  assert.match(s, /CCOX compliance: ERROR/);
  assert.match(s, /`quota`/);
  assert.doesNotMatch(s, /PASS/);
});

test('model text in the summary cannot mention, link, or break the table', () => {
  const evil = { ...V, file: 'crates/a|b.rs', explanation: '@owner please merge [x](http://e) <img src=x> | `code`\nnext' };
  const r = report([aggregateCompliance(DEF, [batch(0, { ...bad, violations: [evil] })])]);
  const row = renderSummary(r).split('\n').find((l) => l.includes('please merge'));
  assert.equal(row.split('|').length - 1, 6, 'exactly the table pipes');
  assert.ok(!row.includes('@owner') && !row.includes('<img') && !row.includes('](') && !row.includes('`'));
  assert.equal(mdCell('x'.repeat(500), 10).length, 10);
});

test('report block is one delimited, parseable JSON document', () => {
  const r = report([aggregateCompliance(DEF, [batch(0, ok)])]);
  const block = renderReportBlock(r);
  const lines = block.split('\n');
  assert.equal(lines[0], `----- BEGIN ${REPORT_SCHEMA} -----`);
  assert.equal(lines.at(-1), `----- END ${REPORT_SCHEMA} -----`);
  assert.deepEqual(JSON.parse(lines.slice(1, -1).join('\n')), r);
});

test('buildReport refuses to invent a timestamp', () => {
  assert.throws(() => buildReport({ compliances: [] }), CcoxError);
});

test('non-CcoxError failures are recorded as internal, CcoxError kinds are closed', () => {
  assert.deepEqual(toErrorRecord(new TypeError('boom')), { kind: 'internal', message: 'TypeError: boom' });
  assert.throws(() => new CcoxError('made_up', 'x'), TypeError);
});
