// report.mjs — the ccox-report/v1 document, its markdown summary, exit codes.
//
// Contract (docs/report-schema.md): status is "pass" only when no run-level
// error occurred, at least one compliance was evaluated, and every compliance
// passed. Any error makes the status "error", the exit code 2, and
// totals.violation_count null — an errored run never reads as 0 violations.

import { CcoxError } from './errors.mjs';

export const REPORT_SCHEMA = 'ccox-report/v1';
export const COMMENT_MARKER = '<!-- ccox:report -->';
const EXIT_CODES = Object.freeze({ pass: 0, violations: 1, error: 2 });
const MAX_TABLE_ROWS = 50;

export function exitCodeFor(status) {
  if (!(status in EXIT_CODES)) throw new CcoxError('internal', `unknown status ${JSON.stringify(status)}`);
  return EXIT_CODES[status];
}

/**
 * Fold one compliance's batch results into its report entry. `batches` holds
 * { index, files, raw_response_sha256, response_model, result } where result
 * is a judgeResponse() value, or { status: 'error', error } when the call
 * itself failed.
 */
export function aggregateCompliance(definition, batches) {
  const results = batches.map((b) => b.result);
  const firstError = results.find((r) => r.status === 'error');
  const violations = results.flatMap((r) => r.violations ?? []);
  const verdicts = results.map((r) => r.verdict ?? null);
  let verdict = null;
  if (verdicts.length > 0 && verdicts.every((v) => v !== null)) {
    verdict = verdicts.includes('non_compliant') ? 'non_compliant' : 'compliant';
  }
  let status = 'pass';
  if (firstError) status = 'error';
  else if (violations.length > 0) status = 'violations';
  return {
    name: definition.name,
    definition_sha256: definition.sha256,
    rules: [...definition.rules],
    status,
    verdict,
    injection_suspected: results.some((r) => r.injection_suspected === true),
    violation_count: violations.length,
    violations,
    rejected_violations: results.flatMap((r) => r.rejected_violations ?? []),
    error: firstError ? firstError.error : null,
    batches: batches.map((b) => ({
      index: b.index,
      files: [...b.files],
      status: b.result.status,
      verdict: b.result.verdict ?? null,
      raw_response_sha256: b.raw_response_sha256 ?? null,
      response_model: b.response_model ?? null,
    })),
  };
}

/** Assemble the report. `error` is a run-level { kind, message } or null. */
export function buildReport({ generatedAt, action, context, scope, model, compliances, error }) {
  if (typeof generatedAt !== 'string' || generatedAt === '') {
    throw new CcoxError('internal', 'buildReport needs an injected generatedAt timestamp');
  }
  let runError = error ?? null;
  if (!runError && compliances.length === 0) {
    runError = { kind: 'internal', message: 'no compliance was evaluated' };
  }
  const errored = compliances.filter((c) => c.status === 'error');
  if (!runError && errored.length > 0) {
    runError = { kind: errored[0].error.kind, message: `compliance "${errored[0].name}": ${errored[0].error.message}` };
  }
  const found = compliances.reduce((n, c) => n + c.violation_count, 0);
  let status = 'pass';
  if (runError) status = 'error';
  else if (found > 0) status = 'violations';
  return {
    schema: REPORT_SCHEMA,
    generated_at: generatedAt,
    status,
    error: runError,
    action,
    context,
    scope,
    model,
    compliances,
    totals: {
      compliances: compliances.length,
      passed: compliances.filter((c) => c.status === 'pass').length,
      with_violations: compliances.filter((c) => c.status === 'violations').length,
      errored: errored.length,
      violation_count: status === 'error' ? null : found,
      violations_found: found,
      injection_suspected: compliances.filter((c) => c.injection_suspected).length,
    },
  };
}

/**
 * Make untrusted text (model output, file names) inert inside a markdown
 * table cell: one line, no pipes, no HTML, no mentions, no links, no code
 * spans that could break out, and bounded length.
 */
export function mdCell(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const cut = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return cut
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '&#64;')
    .replace(/`/g, '&#96;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/\*/g, '&#42;')
    .replace(/_/g, '&#95;')
    .replace(/\|/g, '&#124;');
}

const STATUS_LABEL = { pass: 'PASS', violations: 'VIOLATIONS', error: 'ERROR' };

/** Markdown summary for the step summary, the summary file and the PR comment. */
export function renderSummary(report) {
  const t = report.totals;
  const head = report.status === 'violations'
    ? `## CCOX compliance: ${STATUS_LABEL.violations} (${t.violation_count})`
    : `## CCOX compliance: ${STATUS_LABEL[report.status]}`;
  const out = [head, ''];
  if (report.error) {
    out.push(`**Error** \`${report.error.kind}\`: ${mdCell(report.error.message, 600)}`, '');
    out.push('An errored run is never a pass and never "0 violations". Fix the cause and re-run.', '');
  }
  if (report.compliances.length > 0) {
    out.push('| compliance | status | violations | injection suspected |', '|---|---|---|---|');
    for (const c of report.compliances) {
      out.push(`| ${mdCell(c.name)} | ${STATUS_LABEL[c.status]} | ${c.violation_count} | ${c.injection_suspected ? '**yes**' : 'no'} |`);
    }
    out.push('');
  }
  const rows = report.compliances.flatMap((c) => c.violations.map((v) => ({ c, v })));
  if (rows.length > 0) {
    out.push('| compliance | file | lines | rule | explanation |', '|---|---|---|---|---|');
    for (const { c, v } of rows.slice(0, MAX_TABLE_ROWS)) {
      out.push(`| ${mdCell(c.name)} | ${mdCell(v.file)} | ${v.line_start}-${v.line_end} | ${mdCell(v.rule)} | ${mdCell(v.explanation, 300)} |`);
    }
    if (rows.length > MAX_TABLE_ROWS) out.push('', `${rows.length - MAX_TABLE_ROWS} more in the JSON report.`);
    out.push('');
  }
  const rejected = report.compliances.flatMap((c) => c.rejected_violations.map((v) => ({ c, v })));
  if (rejected.length > 0) {
    out.push(`${rejected.length} cited violation(s) were rejected (outside the scoped files or hunks); see the JSON report.`, '');
  }
  if (report.scope) {
    const s = report.scope;
    const binary = s.files_skipped.filter((f) => f.reason === 'binary').length;
    const listed = s.files_expected === null ? `${s.files_changed}` : `${s.files_changed} of ${s.files_expected}`;
    out.push(
      `Scope: ${listed} changed file(s) listed; ${s.files_scanned.length} judged, ${s.files_excluded.length} outside allowed-directories, ` +
        `${s.files_skipped.length} skipped (${binary} binary, not judged), ${s.batches} batch(es).`,
    );
    if (s.files_without_patch.length > 0) {
      out.push(
        `${s.files_without_patch.length} file(s) came without a patch from GitHub; ` +
          `${s.files_content_diffed.length} in scope were diffed from their base and head contents.`,
      );
    }
  }
  if (report.model) out.push(`Model: ${mdCell(report.model.model, 120)} (${report.model.structured_mode}).`);
  out.push(`Report: \`${REPORT_SCHEMA}\` in the job log and the workflow artifact.`, '');
  return out.join('\n');
}

/** The report as one delimited block for the job log. */
export function renderReportBlock(report) {
  return [`----- BEGIN ${REPORT_SCHEMA} -----`, JSON.stringify(report, null, 2), `----- END ${REPORT_SCHEMA} -----`].join('\n');
}
