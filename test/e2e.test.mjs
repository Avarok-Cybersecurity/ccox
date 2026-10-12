// End to end: src/main.mjs runs as the action would (a child process with the
// INPUT_* / GITHUB_* environment), against a real local HTTP server playing
// GitHub and the model endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { sha256Hex } from '../src/core/hash.mjs';
import { COMMENT_MARKER, REPORT_SCHEMA } from '../src/core/report.mjs';
import {
  BASE, HEAD, SAMPLE, TREES, answer, prEvent, read, runAction, withServices,
} from './helpers/action-run.mjs';

test('pull_request_target with a violation: exit 1, report, outputs, annotation, sticky comment', () => withServices(
  { completions: [answer('tool_call-violation.json')] },
  async (services) => {
    const r = await runAction({ services, eventName: 'pull_request_target', event: prEvent });
    assert.equal(r.code, 1, r.stdout);
    assert.deepEqual(
      { status: r.outputs.status, violations: r.outputs.violations, report: r.outputs['report-file'] },
      { status: 'violations', violations: '1', report: join(r.dir, 'out', 'ccox-report.json') },
    );
    assert.equal(r.report.schema, REPORT_SCHEMA);
    assert.equal(r.report.totals.violation_count, 1);
    assert.deepEqual(r.report.scope.files_scanned, ['crates/core/src/lib.rs']);
    assert.deepEqual(r.report.scope.files_excluded, ['docs/crates/notes.md']);
    assert.equal(r.report.context.definitions.ref, BASE);
    assert.equal(r.report.compliances[0].definition_sha256, sha256Hex(SAMPLE), 'definitions came from the base sha');
    assert.equal(r.report.compliances[0].batches[0].raw_response_sha256, sha256Hex(read('fixtures/responses/tool_call-violation.json')));
    assert.match(r.stdout, /::error file=crates\/core\/src\/lib\.rs,line=5,endLine=7,title=CCOX sample\/io-in-core::/);
    assert.match(r.stdout, /::add-mask::sk-e2e-secret/);
    const printed = r.stdout.slice(r.stdout.indexOf(`----- BEGIN ${REPORT_SCHEMA} -----`));
    assert.deepEqual(JSON.parse(printed.split('\n').slice(1, printed.split('\n').indexOf(`----- END ${REPORT_SCHEMA} -----`)).join('\n')), r.report);
    assert.match(r.summary, /CCOX compliance: VIOLATIONS \(1\)/);

    const contentReads = services.requests.filter((q) => q.path.includes('/contents/'));
    assert.ok(contentReads.length > 0 && contentReads.every((q) => q.query.ref === BASE), 'every definition read pinned to base');
    const llm = services.requests.filter((q) => q.path === '/llm/chat/completions');
    assert.equal(llm.length, 1);
    const body = JSON.parse(llm[0].body);
    assert.equal(body.temperature, 0);
    assert.equal(body.seed, 42);
    assert.equal(body.tool_choice.function.name, 'report_verdict');
    assert.ok(!body.messages[1].content.includes('docs/crates/notes.md'), 'out-of-scope file never reaches the model');
    assert.ok(body.messages[1].content.includes(SAMPLE));
    const comment = services.requests.find((q) => q.method === 'POST' && q.path.endsWith('/issues/7/comments'));
    assert.ok(JSON.parse(comment.body).body.startsWith(COMMENT_MARKER));
    assert.deepEqual(r.report.comment, { status: 'created' });
  },
));

test('compliant answer: exit 0, status pass, violations 0', () => withServices(
  { completions: [answer('tool_call-compliant.json')] },
  async (services) => {
    const r = await runAction({ services, eventName: 'pull_request_target', event: prEvent });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.outputs.status, 'pass');
    assert.equal(r.outputs.violations, '0');
  },
));

test('merge_group: compare diff, base-sha definitions, no comment', () => withServices(
  { completions: [answer('tool_call-compliant.json')] },
  async (services) => {
    const r = await runAction({ services, eventName: 'merge_group', event: { merge_group: { base_sha: BASE, head_sha: HEAD, head_ref: 'refs/heads/gh-readonly-queue/main/pr-7-x' } } });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.report.context.diff_source, 'compare');
    assert.equal(r.report.comment.status, 'skipped');
    assert.ok(services.requests.some((q) => q.path.endsWith(`/compare/${BASE}...${HEAD}`)));
    assert.ok(!services.requests.some((q) => q.path.includes('/issues/')));
  },
));

for (const [name, completions, kind] of [
  ['daily quota', [answer('error-429-daily.json', 429)], 'quota'],
  ['200-with-error body', [answer('error-200-transient.json')], 'provider'],
  ['unparsable answer', [answer('tool_call-prose-only.json')], 'parse'],
  ['out-of-scope violation', [answer('tool_call-out-of-scope.json')], 'invalid_violation'],
  ['injection + compliant', [answer('tool_call-injection-compliant.json')], 'injection_suspected'],
]) {
  test(`${name}: exit 2, status error, never "0 violations"`, () => withServices({ completions }, async (services) => {
    const r = await runAction({ services, eventName: 'pull_request_target', event: prEvent });
    assert.equal(r.code, 2, r.stdout);
    assert.equal(r.outputs.status, 'error');
    assert.equal(r.outputs.violations, '');
    assert.equal(r.report.status, 'error');
    assert.equal(r.report.error.kind, kind);
    assert.equal(r.report.totals.violation_count, null);
    assert.match(r.summary, /CCOX compliance: ERROR/);
  }));
}

test('definitions missing at the base sha: exit 2, kind github, model never called', () => withServices(
  { completions: [answer('tool_call-compliant.json')], trees: { [HEAD]: TREES[HEAD] } },
  async (services) => {
    const r = await runAction({ services, eventName: 'pull_request_target', event: prEvent });
    assert.equal(r.code, 2);
    assert.equal(r.report.error.kind, 'github');
    assert.ok(!services.requests.some((q) => q.path.startsWith('/llm')));
  },
));

test('GitHub file count disagrees with the listing: diff_truncated, exit 2', () => withServices(
  { completions: [answer('tool_call-compliant.json')], changedFiles: 3 },
  async (services) => {
    const r = await runAction({ services, eventName: 'pull_request_target', event: prEvent });
    assert.equal(r.code, 2);
    assert.equal(r.report.error.kind, 'diff_truncated');
  },
));

test('invalid inputs still produce a written error report and exit 2', () => withServices(
  { completions: [answer('tool_call-compliant.json')] },
  async (services) => {
    const r = await runAction({ services, eventName: 'pull_request_target', event: prEvent, overrides: { 'allowed-directories': '' } });
    assert.equal(r.code, 2);
    assert.equal(r.report.error.kind, 'input');
    assert.match(r.report.error.message, /allowed-directories/);
    assert.equal(r.outputs.status, 'error');
  },
));

test('an event without a diff (push) is an error, not a pass', () => withServices(
  { completions: [answer('tool_call-compliant.json')] },
  async (services) => {
    const r = await runAction({ services, eventName: 'push', event: {}, overrides: { 'compliance-definitions-path': '' } });
    assert.equal(r.code, 2);
    assert.equal(r.report.status, 'error');
  },
));
