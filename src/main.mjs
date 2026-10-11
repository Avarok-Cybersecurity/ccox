// main.mjs — CCOX entrypoint and composition root.
//
// Reads the INPUT_* environment the composite action maps, wires the
// adapters (GitHub, model endpoint, filesystem) into the pure core, and
// always ends the same way: one ccox-report/v1 printed to the log and
// written to <report-dir>, the markdown summary, step outputs, and exit code
// 0 (pass), 1 (violations) or 2 (error). Any failure anywhere is an error
// report; nothing on a failure path can produce "0 violations".

import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CcoxError, toErrorRecord } from './core/errors.mjs';
import { sha256Hex } from './core/hash.mjs';
import {
  INPUT_SPEC, actionIdentity, parseInputs, planDefinitionsSource, planDiffSource, resolveEventContext,
} from './core/inputs.mjs';
import { parseUnifiedDiff } from './core/diff.mjs';
import { batchFiles, compileAllowlist, partitionFiles } from './core/scope.mjs';
import { buildMessages, buildRequestBody, loadDefinitions, renderFileDiff } from './core/prompt.mjs';
import { judgeResponse, verdictSchema } from './core/verdict.mjs';
import {
  COMMENT_MARKER, aggregateCompliance, buildReport, exitCodeFor, renderReportBlock, renderSummary,
} from './core/report.mjs';
import { createGitHub } from './adapters/github.mjs';
import { requestCompletion } from './adapters/llm.mjs';
import { appendText, readJson, readMarkdownDir, readText, writeText } from './adapters/fs.mjs';

const ACTION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_FILE = 'ccox-report.json';
const SUMMARY_FILE = 'ccox-summary.md';

const log = (msg) => process.stdout.write(`${msg}\n`);

function inputEnvName(name) {
  return `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
}

/** Escape a workflow-command value (and, for properties, ':' and ','). */
function escapeCommand(value, property = false) {
  let s = String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  if (property) s = s.replace(/:/g, '%3A').replace(/,/g, '%2C');
  return s;
}

/** Step output in the heredoc form; a value containing newlines cannot forge outputs. */
function setOutput(env, name, value) {
  if (!env.GITHUB_OUTPUT) return;
  const delim = `ccox_${randomBytes(16).toString('hex')}`;
  appendText(env.GITHUB_OUTPUT, `${name}<<${delim}\n${String(value)}\n${delim}\n`);
}

function runRecord(env) {
  const id = env.GITHUB_RUN_ID ?? null;
  const url = id && env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${id}`
    : null;
  return { id, attempt: env.GITHUB_RUN_ATTEMPT ?? null, job: env.GITHUB_JOB ?? null, url };
}

async function loadDiff(config, ctx, github, workspace, state) {
  const source = planDiffSource(config, ctx);
  state.context.diff_source = source.type;
  if (source.type === 'diff-file') {
    const path = isAbsolute(source.path) ? source.path : resolve(workspace, source.path);
    return { text: readText(path, 'diff'), expectedFiles: null };
  }
  if (source.type === 'pulls') {
    const r = await github.pullDiff(source.pr);
    if (r.headSha !== ctx.headSha) {
      throw new CcoxError('event', `PR #${source.pr} head is ${r.headSha}, but this run is for ${ctx.headSha}; the newer run judges the newer head`);
    }
    return { text: r.diff, expectedFiles: r.expectedFiles };
  }
  const r = await github.compareDiff(source.base, source.head);
  return { text: r.diff, expectedFiles: r.expectedFiles };
}

async function judgeAll(config, definitions, batches, deps) {
  const compliances = [];
  for (const definition of definitions) {
    const schema = verdictSchema(definition.rules);
    const results = [];
    for (const [index, batch] of batches.entries()) {
      const entry = { index, files: batch.files.map((f) => f.path) };
      try {
        const messages = buildMessages({
          definition, files: batch.files, nonce: deps.nonce(), mode: config.structuredMode, schema,
          batchIndex: index, batchCount: batches.length,
        });
        const body = buildRequestBody({
          model: config.model, provider: config.provider, mode: config.structuredMode, seed: config.seed,
          maxTokens: config.maxTokens, reasoningEffort: config.reasoningEffort, messages, schema,
        });
        const { data, raw, attempts } = await requestCompletion(
          {
            endpoint: config.endpoint, apiKey: config.apiKey, provider: config.provider, body,
            timeoutMs: config.requestTimeoutMs, maxAttempts: config.maxAttempts,
          },
          deps,
        );
        entry.raw_response_sha256 = sha256Hex(raw);
        entry.response_model = typeof data.model === 'string' ? data.model : null;
        entry.result = judgeResponse({ mode: config.structuredMode, data, schema, files: batch.files });
        log(`[ccox] ${definition.name} batch ${index + 1}/${batches.length}: ${entry.result.status} (${attempts} attempt(s))`);
      } catch (e) {
        entry.result = { status: 'error', verdict: null, violations: [], rejected_violations: [], error: toErrorRecord(e) };
        log(`[ccox] ${definition.name} batch ${index + 1}/${batches.length}: error ${entry.result.error.kind}: ${entry.result.error.message}`);
      }
      results.push(entry);
    }
    compliances.push(aggregateCompliance(definition, results));
  }
  return compliances;
}

/** Everything up to the verdicts. Fills `state` as it goes, so a failure still reports what was known. */
async function evaluate(env, deps, state) {
  const raw = Object.fromEntries(INPUT_SPEC.map((s) => [s.name, env[inputEnvName(s.name)]]));
  const parsed = parseInputs(raw);
  if (!parsed.ok) {
    state.reportDir = parsed.reportDir;
    throw new CcoxError('input', parsed.problems.join('; '));
  }
  const config = parsed.config;
  state.config = config;
  state.reportDir = config.reportDir;
  state.model = {
    provider: config.provider, endpoint: config.endpoint, model: config.model,
    structured_mode: config.structuredMode, temperature: 0, seed: config.seed,
    reasoning_effort: config.reasoningEffort, max_tokens: config.maxTokens,
  };
  if (!env.GITHUB_WORKSPACE) throw new CcoxError('event', 'GITHUB_WORKSPACE is not set');
  if (!env.GITHUB_EVENT_PATH) throw new CcoxError('event', 'GITHUB_EVENT_PATH is not set');
  const ctx = resolveEventContext({
    eventName: env.GITHUB_EVENT_NAME, event: readJson(env.GITHUB_EVENT_PATH, 'event'), repository: env.GITHUB_REPOSITORY,
  });
  state.ctx = ctx;
  state.context = {
    repository: ctx.repository, event: ctx.eventName, pr: ctx.pr, base_sha: ctx.baseSha, head_sha: ctx.headSha,
    definitions: null, diff_source: null, run: runRecord(env),
  };
  if (config.githubToken !== '' && !env.GITHUB_API_URL) throw new CcoxError('event', 'GITHUB_API_URL is not set');
  const github = config.githubToken === '' ? null : createGitHub(
    {
      apiUrl: env.GITHUB_API_URL, token: config.githubToken, repository: ctx.repository,
      timeoutMs: config.requestTimeoutMs, maxAttempts: config.maxAttempts,
    },
    deps,
  );
  state.github = github;

  const defSource = planDefinitionsSource(config, ctx);
  state.context.definitions = { source: defSource.type, path: defSource.path, ref: defSource.ref };
  const entries = defSource.type === 'bundled'
    ? readMarkdownDir(join(ACTION_ROOT, defSource.path))
    : await github.definitionsAt(defSource.path, defSource.ref);
  const definitions = loadDefinitions(entries);
  log(`[ccox] ${definitions.length} compliance definition(s) from ${defSource.type}: ${definitions.map((d) => d.name).join(', ')}`);

  const diff = await loadDiff(config, ctx, github, env.GITHUB_WORKSPACE, state);
  const files = parseUnifiedDiff(diff.text);
  if (diff.expectedFiles !== null && files.length !== diff.expectedFiles) {
    throw new CcoxError('diff_truncated', `GitHub reports ${diff.expectedFiles} changed file(s) but the diff holds ${files.length}`);
  }
  const allowlist = compileAllowlist(config.allowedDirectories);
  const { scanned, excluded, skipped } = partitionFiles(files, allowlist);
  const sizes = new Map(scanned.map((f) => [f, Buffer.byteLength(renderFileDiff(f))]));
  const batches = batchFiles(scanned, config.maxDiffBytes, (f) => sizes.get(f));
  state.scope = {
    allowed_directories: [...config.allowedDirectories],
    files_changed: files.length,
    files_scanned: scanned.map((f) => f.path),
    files_excluded: excluded,
    files_skipped: skipped,
    scanned_bytes: [...sizes.values()].reduce((a, b) => a + b, 0),
    max_diff_bytes: config.maxDiffBytes,
    batches: batches.length,
  };
  log(`[ccox] ${files.length} changed file(s): ${scanned.length} judged in ${batches.length} batch(es), ${excluded.length} out of scope, ${skipped.length} skipped`);
  state.compliances = await judgeAll(config, definitions, batches, deps);
}

async function postComment(state, summary) {
  const { config, ctx, github } = state;
  if (!config?.commentOnPr) return { status: 'skipped', reason: 'comment-on-pr is false or inputs are invalid' };
  if (!ctx?.pr) return { status: 'skipped', reason: 'no pull request (merge_group or other event)' };
  try {
    return { status: await github.upsertStickyComment(ctx.pr, COMMENT_MARKER, `${COMMENT_MARKER}\n${summary}`) };
  } catch (e) {
    const { kind, message } = toErrorRecord(e);
    log(`::warning::CCOX could not post the PR comment (${kind}): ${escapeCommand(message)}`);
    return { status: 'failed', reason: `${kind}: ${message}` };
  }
}

function annotate(report) {
  if (report.status === 'error') {
    log(`::error title=CCOX error (${report.error.kind})::${escapeCommand(report.error.message)}`);
  }
  for (const c of report.compliances) {
    if (c.injection_suspected) log(`::warning title=CCOX::${escapeCommand(`${c.name}: the model suspected prompt injection in the diff`)}`);
    for (const v of c.violations) {
      const props = `file=${escapeCommand(v.file, true)},line=${v.line_start},endLine=${v.line_end},title=${escapeCommand(`CCOX ${c.name}/${v.rule}`, true)}`;
      log(`::error ${props}::${escapeCommand(v.explanation)}`);
    }
  }
}

function writeOutputs(env, report, paths) {
  setOutput(env, 'status', report.status);
  setOutput(env, 'violations', report.totals.violation_count === null ? '' : report.totals.violation_count);
  setOutput(env, 'report-file', paths.report);
  setOutput(env, 'summary-file', paths.summary);
}

async function run(env, deps) {
  for (const name of ['api-key', 'github-token']) {
    const secret = (env[inputEnvName(name)] ?? '').trim();
    if (secret && env.GITHUB_ACTIONS === 'true') log(`::add-mask::${secret}`);
  }
  const state = { config: null, ctx: null, github: null, reportDir: null, context: null, scope: null, model: null, compliances: [] };
  let error = null;
  try {
    await evaluate(env, deps, state);
  } catch (e) {
    error = toErrorRecord(e);
  }
  const action = actionIdentity({
    repository: env.CCOX_ACTION_REPOSITORY, ref: env.CCOX_ACTION_REF, actionPath: env.GITHUB_ACTION_PATH,
  });
  const build = (err) => buildReport({
    generatedAt: deps.now(), action, context: state.context, scope: state.scope, model: state.model,
    compliances: state.compliances, error: err,
  });
  let report = build(error);
  const summary = renderSummary(report);
  report.comment = await postComment(state, summary);

  const paths = { report: '', summary: '' };
  try {
    if (state.reportDir === null) throw new CcoxError('input', 'report-dir is invalid, so no report file can be written');
    if (!isAbsolute(state.reportDir) && !env.GITHUB_WORKSPACE) {
      throw new CcoxError('event', 'GITHUB_WORKSPACE is not set, so the relative report-dir cannot be resolved');
    }
    const dir = isAbsolute(state.reportDir) ? state.reportDir : resolve(env.GITHUB_WORKSPACE, state.reportDir);
    paths.report = join(dir, REPORT_FILE);
    paths.summary = join(dir, SUMMARY_FILE);
    // The summary first: if anything fails, no report file claiming success exists.
    writeText(paths.summary, summary);
    writeText(paths.report, `${JSON.stringify(report, null, 2)}\n`);
  } catch (e) {
    const comment = report.comment;
    report = build(error ?? toErrorRecord(e));
    report.comment = comment;
    paths.report = '';
    paths.summary = '';
    log(`::error::CCOX could not write its report: ${escapeCommand(toErrorRecord(e).message)}`);
  }
  try {
    if (env.GITHUB_STEP_SUMMARY) appendText(env.GITHUB_STEP_SUMMARY, `${renderSummary(report)}\n`);
  } catch (e) {
    log(`::warning::CCOX could not append the step summary: ${escapeCommand(toErrorRecord(e).message)}`);
  }
  log(renderReportBlock(report));
  annotate(report);
  writeOutputs(env, report, paths);
  return exitCodeFor(report.status);
}

const deps = {
  fetchImpl: globalThis.fetch,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log,
  now: () => new Date().toISOString(),
  nonce: () => randomBytes(16).toString('hex'),
};
run(process.env, deps).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    // Last resort: the report itself could not be produced.
    log(`::error::CCOX failed before producing a report: ${escapeCommand(e?.stack ?? String(e))}`);
    process.exitCode = 2;
  },
);
