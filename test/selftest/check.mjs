// check.mjs — does one live self-test run match its fixture's expectation?
//
// Pure: takes the action's step outcome and outputs, the parsed
// ccox-report/v1 and the fixture's acceptable outcomes
// (test/selftest/expectations.json), and returns the problems found. The run
// matches when ANY one acceptable outcome holds; an empty `problems` means it
// does. Every key of an outcome is checked; an unknown key is a problem, so a
// typo in the expectations cannot silently weaken them.

const OUTCOME_KEYS = new Set([
  'status', 'violations', 'min_violations', 'error_kind', 'injection_suspected',
  'files_scanned', 'files_excluded', 'model_calls', 'must_cite',
]);
const STEP_OUTCOME = { pass: 'success', violations: 'failure', error: 'failure' };

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Problems that make the outputs and the report disagree, whatever the fixture. */
export function consistencyProblems({ outcome, outputs, report }) {
  const problems = [];
  if (report?.schema !== 'ccox-report/v1') return [`report schema is ${JSON.stringify(report?.schema)}, not ccox-report/v1`];
  if (outputs.status !== report.status) problems.push(`output status ${JSON.stringify(outputs.status)} != report status ${JSON.stringify(report.status)}`);
  const count = report.totals.violation_count;
  const expectedOutput = count === null ? '' : String(count);
  if (outputs.violations !== expectedOutput) problems.push(`output violations ${JSON.stringify(outputs.violations)} != ${JSON.stringify(expectedOutput)}`);
  if (STEP_OUTCOME[report.status] !== outcome) problems.push(`step outcome ${outcome} does not match status ${report.status}`);
  return problems;
}

function citationProblems(cites, violations) {
  return cites
    .filter((c) => !violations.some((v) => v.file === c.file && v.rule === c.rule && v.line_start <= c.line && c.line <= v.line_end))
    .map((c) => `no ${c.rule} violation in ${c.file} covers line ${c.line}`);
}

/** Problems of one acceptable outcome against the report. */
export function outcomeProblems(expected, report) {
  const problems = [];
  for (const key of Object.keys(expected)) {
    if (!OUTCOME_KEYS.has(key)) problems.push(`unknown expectation key ${JSON.stringify(key)}`);
  }
  const violations = report.compliances.flatMap((c) => c.violations);
  const flagged = report.compliances.some((c) => c.injection_suspected);
  const calls = report.compliances.reduce((n, c) => n + c.batches.length, 0);
  const check = (key, actual, ok = same(expected[key], actual)) => {
    if (key in expected && !ok) problems.push(`${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(actual)}`);
  };
  check('status', report.status);
  check('violations', report.totals.violation_count);
  check('min_violations', violations.length, violations.length >= expected.min_violations);
  check('error_kind', report.error?.kind ?? null);
  check('injection_suspected', flagged);
  check('files_scanned', report.scope?.files_scanned ?? null);
  check('files_excluded', report.scope?.files_excluded ?? null);
  check('model_calls', calls);
  if (expected.must_cite) problems.push(...citationProblems(expected.must_cite, violations));
  return problems;
}

/**
 * @param {{ outcomes: object[], outcome: string, outputs: {status: string, violations: string}, report: object }} run
 * @returns {string[]} problems; empty when the run matches one acceptable outcome
 */
export function checkRun({ outcomes, outcome, outputs, report }) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return ['no acceptable outcome is declared for this fixture'];
  const consistency = consistencyProblems({ outcome, outputs, report });
  if (consistency.length > 0) return consistency;
  const perOutcome = outcomes.map((o) => outcomeProblems(o, report));
  if (perOutcome.some((p) => p.length === 0)) return [];
  return perOutcome.flatMap((p, i) => p.map((msg) => `outcome ${i + 1}: ${msg}`));
}
