// End to end: src/main.mjs runs as the action would (a child process with the
// INPUT_* / GITHUB_* environment), against a real local HTTP server playing
// GitHub and the model endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256Hex } from '../src/core/hash.mjs';
import { COMMENT_MARKER, REPORT_SCHEMA } from '../src/core/report.mjs';
import { startFakeServices } from './helpers/fake-services.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const MAIN = new URL('../src/main.mjs', import.meta.url).pathname;
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const SAMPLE = read('./fixtures/definitions/sample.md');
const WEAKENED = SAMPLE.replace(/## Rules[\s\S]*?## Compliant/, '## Rules\n\n- `io-in-core`: anything goes.\n\n## Compliant');
const PR_DIFF = read('./fixtures/diffs/pr.diff');
const answer = (name, status = 200) => ({ status, body: read(`./fixtures/responses/${name}`) });

const TREES = {
  [BASE]: { compliances: [{ name: 'sample.md', text: SAMPLE }] },
  // The head carries a weakened copy: CCOX must never read it.
  [HEAD]: { compliances: [{ name: 'sample.md', text: WEAKENED }] },
};

function inputs(services, overrides = {}) {
  return {
    provider: 'openrouter',
    endpoint: `${services.url}/llm`,
    'api-key': 'sk-e2e-secret',
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    'structured-mode': 'tool_call',
    'allowed-directories': 'crates/',
    'compliance-definitions-path': 'compliances',
    'max-diff-bytes': '60000',
    seed: '42',
    'reasoning-effort': 'low',
    'max-tokens': '4096',
    'request-timeout-ms': '10000',
    'max-retries': '1',
    'report-dir': 'out',
    'artifact-name': 'ccox-report-test-1',
    'artifact-retention-days': '90',
    'comment-on-pr': 'true',
    'github-token': 'ghs_e2e',
    'diff-file': '',
    ...overrides,
  };
}

async function runAction({ services, eventName, event, overrides }) {
  const dir = mkdtempSync(join(tmpdir(), 'ccox-e2e-'));
  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify(event));
  const outputFile = join(dir, 'output.txt');
  const summaryFile = join(dir, 'summary.md');
  writeFileSync(outputFile, '');
  writeFileSync(summaryFile, '');
  const env = {
    PATH: process.env.PATH,
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKSPACE: dir,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: eventName,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_API_URL: `${services.url}/api`,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_RUN_ID: '1001',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: 'ccox',
    GITHUB_SERVER_URL: 'https://github.com',
  };
  for (const [name, value] of Object.entries(inputs(services, overrides))) {
    env[`INPUT_${name.replace(/-/g, '_').toUpperCase()}`] = value;
  }
  const { code, stdout } = await new Promise((resolve) => {
    execFile(process.execPath, [MAIN], { env }, (error, out) => resolve({ code: error ? error.code : 0, stdout: out }));
  });
  const outputs = {};
  for (const m of readFileSync(outputFile, 'utf8').matchAll(/^([a-z-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
  let report = null;
  try {
    report = JSON.parse(readFileSync(join(dir, 'out', 'ccox-report.json'), 'utf8'));
  } catch {
    report = null;
  }
  return { code, stdout, outputs, report, summary: readFileSync(summaryFile, 'utf8'), dir };
}

const prEvent = { pull_request: { number: 7, base: { sha: BASE }, head: { sha: HEAD } } };

async function withServices(options, fn) {
  const services = await startFakeServices({ diff: PR_DIFF, changedFiles: 2, baseSha: BASE, headSha: HEAD, trees: TREES, ...options });
  try {
    await fn(services);
  } finally {
    await services.close();
  }
}

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
    assert.equal(r.report.compliances[0].batches[0].raw_response_sha256, sha256Hex(read('./fixtures/responses/tool_call-violation.json')));
    assert.match(r.stdout, /::error file=crates\/core\/src\/lib\.rs,line=6,endLine=6,title=CCOX sample\/io-in-core::/);
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

test('GitHub file count disagrees with the diff: diff_truncated, exit 2', () => withServices(
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
