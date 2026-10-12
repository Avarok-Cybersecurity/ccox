// Runs src/main.mjs as the action would (a child process with the INPUT_* /
// GITHUB_* environment) against the local fake services; shared by the
// end-to-end suites.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { entriesFromDiff, startFakeServices } from './fake-services.mjs';

export const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const MAIN = new URL('../../src/main.mjs', import.meta.url).pathname;
export const BASE = 'a'.repeat(40);
export const HEAD = 'b'.repeat(40);
export const SAMPLE = read('./fixtures/definitions/sample.md');
const WEAKENED = SAMPLE.replace(/## Rules[\s\S]*?## Compliant/, '## Rules\n\n- `io-in-core`: anything goes.\n\n## Compliant');
export const PR_DIFF = read('./fixtures/diffs/pr.diff');
export const answer = (name, status = 200) => ({ status, body: read(`./fixtures/responses/${name}`) });

export const TREES = {
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

export async function runAction({ services, eventName, event, overrides }) {
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

export const prEvent = { pull_request: { number: 7, base: { sha: BASE }, head: { sha: HEAD } } };

export async function withServices(options, fn) {
  const services = await startFakeServices({ files: entriesFromDiff(PR_DIFF), changedFiles: 2, baseSha: BASE, headSha: HEAD, trees: TREES, ...options });
  try {
    await fn(services);
  } finally {
    await services.close();
  }
}

