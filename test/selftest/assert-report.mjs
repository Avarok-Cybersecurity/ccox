// assert-report.mjs — the self-test workflow's assertion step.
//
// Reads the CCOX step's outcome and outputs from the environment
// (FIXTURE, OUTCOME, STATUS, VIOLATIONS, REPORT_FILE), the report file and
// expectations.json, prints what the model answered, and exits 1 unless the
// run matches one of the fixture's acceptable outcomes (check.mjs).

import { readFileSync } from 'node:fs';

import { checkRun } from './check.mjs';

function required(name) {
  const value = process.env[name];
  if (value === undefined) throw new Error(`environment variable ${name} is not set`);
  return value;
}

function main() {
  const fixture = required('FIXTURE');
  const expectations = JSON.parse(readFileSync(new URL('./expectations.json', import.meta.url), 'utf8'));
  if (!Object.hasOwn(expectations, fixture)) throw new Error(`expectations.json has no entry for fixture ${fixture}`);
  const reportFile = required('REPORT_FILE');
  if (reportFile === '') throw new Error('the CCOX step produced no report-file output');
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const outputs = { status: required('STATUS'), violations: required('VIOLATIONS') };
  const outcome = required('OUTCOME');

  console.log(`fixture ${fixture}: step ${outcome}, status ${report.status}, violations ${JSON.stringify(outputs.violations)}`);
  if (report.error) console.log(`error ${report.error.kind}: ${report.error.message}`);
  for (const c of report.compliances) {
    console.log(`${c.name}: ${c.status}, injection_suspected ${c.injection_suspected}, ${c.batches.length} model call(s)`);
    for (const v of c.violations) console.log(`  ${v.rule} ${v.file}:${v.line_start}-${v.line_end} ${JSON.stringify(v.evidence)}`);
  }
  const problems = checkRun({ outcomes: expectations[fixture], outcome, outputs, report });
  for (const p of problems) console.log(`::error title=self-test ${fixture}::${p}`);
  return problems.length === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (e) {
  console.log(`::error title=self-test::${e.message}`);
  process.exitCode = 1;
}
