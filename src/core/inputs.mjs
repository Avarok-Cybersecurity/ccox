// inputs.mjs — action inputs and the triggering event, validated.
//
// Contract: INPUT_SPEC is the single list of inputs the entrypoint reads
// (action.yml must declare exactly these; a test enforces it). Defaults live
// only in action.yml; here every value is required and checked, and all
// problems are reported together. The functions below take raw strings and
// parsed event JSON and never read the environment themselves.

import { CcoxError } from './errors.mjs';
import { compileAllowlist } from './scope.mjs';
import { STRUCTURED_MODES } from './verdict.mjs';

export const PROVIDERS = Object.freeze(['openrouter', 'openai-compatible']);
export const REASONING_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high']);

export const INPUT_SPEC = Object.freeze([
  { name: 'provider', key: 'provider', kind: 'enum', values: PROVIDERS },
  { name: 'endpoint', key: 'endpoint', kind: 'endpoint' },
  { name: 'api-key', key: 'apiKey', kind: 'string' },
  { name: 'model', key: 'model', kind: 'string' },
  { name: 'structured-mode', key: 'structuredMode', kind: 'enum', values: STRUCTURED_MODES },
  { name: 'allowed-directories', key: 'allowedDirectories', kind: 'regex-lines' },
  { name: 'compliance-definitions-path', key: 'definitionsPath', kind: 'optional-repo-path' },
  { name: 'max-diff-bytes', key: 'maxDiffBytes', kind: 'int', min: 1024, max: 4_000_000 },
  { name: 'seed', key: 'seed', kind: 'int', min: 0, max: 2_147_483_647 },
  { name: 'reasoning-effort', key: 'reasoningEffort', kind: 'enum', values: REASONING_EFFORTS },
  { name: 'max-tokens', key: 'maxTokens', kind: 'int', min: 256, max: 1_000_000 },
  { name: 'request-timeout-ms', key: 'requestTimeoutMs', kind: 'int', min: 1000, max: 3_600_000 },
  { name: 'max-retries', key: 'maxAttempts', kind: 'int', min: 1, max: 10 },
  { name: 'report-dir', key: 'reportDir', kind: 'string' },
  { name: 'artifact-name', key: 'artifactName', kind: 'string' },
  { name: 'artifact-retention-days', key: 'artifactRetentionDays', kind: 'int', min: 1, max: 90 },
  { name: 'comment-on-pr', key: 'commentOnPr', kind: 'bool' },
  { name: 'github-token', key: 'githubToken', kind: 'optional-string' },
  { name: 'diff-file', key: 'diffFile', kind: 'optional-string' },
]);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function parseOne(spec, raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const optional = spec.kind.startsWith('optional-');
  if (value === '') {
    if (optional) return '';
    throw new Error('is required');
  }
  switch (spec.kind) {
    case 'string':
    case 'optional-string':
      return value;
    case 'enum':
      if (!spec.values.includes(value)) throw new Error(`must be one of ${spec.values.join(' | ')}, got ${JSON.stringify(value)}`);
      return value;
    case 'bool':
      if (value !== 'true' && value !== 'false') throw new Error(`must be "true" or "false", got ${JSON.stringify(value)}`);
      return value === 'true';
    case 'int': {
      if (!/^\d+$/.test(value)) throw new Error(`must be a base-10 integer, got ${JSON.stringify(value)}`);
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < spec.min || n > spec.max) throw new Error(`must be in ${spec.min}..${spec.max}, got ${value}`);
      return n;
    }
    case 'endpoint': {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new Error(`must be an absolute URL, got ${JSON.stringify(value)}`);
      }
      const plainOk = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
      if (url.protocol !== 'https:' && !plainOk) throw new Error('must use https:// (plain http only to a loopback host)');
      return value.replace(/\/+$/, '');
    }
    case 'regex-lines': {
      const lines = value.split('\n').map((s) => s.trim()).filter(Boolean);
      return compileAllowlist(lines).map((a) => a.source);
    }
    case 'optional-repo-path': {
      const path = value.replace(/\/+$/, '');
      if (path.startsWith('/') || path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
        throw new Error(`must be a repository-relative directory without "." or ".." segments, got ${JSON.stringify(value)}`);
      }
      return path;
    }
    default:
      throw new Error(`unknown input kind ${spec.kind}`);
  }
}

/**
 * Validate raw input strings (keyed by input name).
 * Returns { ok: true, config } or { ok: false, problems, reportDir } where
 * reportDir is the report-dir value when that one input was valid, so even an
 * input error can still be written as a report.
 */
export function parseInputs(raw) {
  const config = {};
  const problems = [];
  for (const spec of INPUT_SPEC) {
    try {
      config[spec.key] = parseOne(spec, raw[spec.name]);
    } catch (e) {
      const why = e instanceof CcoxError ? e.message : `input "${spec.name}" ${e.message}`;
      problems.push(why);
    }
  }
  if (problems.length === 0) {
    const needsGithub = config.diffFile === '' || config.definitionsPath !== '' || config.commentOnPr;
    if (needsGithub && config.githubToken === '') {
      problems.push('input "github-token" is required to fetch the diff, read base-branch definitions or comment');
    }
  }
  if (problems.length > 0) {
    return { ok: false, problems, reportDir: typeof config.reportDir === 'string' ? config.reportDir : null };
  }
  return { ok: true, config };
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function requireSha(value, what) {
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    throw new CcoxError('event', `${what} is missing or not a commit sha: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The parts of the triggering event CCOX acts on.
 * kind: pull (pull_request / pull_request_target) | merge_group | other.
 */
export function resolveEventContext({ eventName, event, repository }) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository ?? '')) {
    throw new CcoxError('event', `repository must be "owner/name", got ${JSON.stringify(repository)}`);
  }
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const pr = event?.pull_request;
    if (!Number.isSafeInteger(pr?.number)) throw new CcoxError('event', `${eventName} payload has no pull_request.number`);
    return {
      kind: 'pull',
      eventName,
      repository,
      pr: pr.number,
      baseSha: requireSha(pr.base?.sha, 'pull_request.base.sha'),
      headSha: requireSha(pr.head?.sha, 'pull_request.head.sha'),
    };
  }
  if (eventName === 'merge_group') {
    const mg = event?.merge_group;
    return {
      kind: 'merge_group',
      eventName,
      repository,
      pr: null,
      baseSha: requireSha(mg?.base_sha, 'merge_group.base_sha'),
      headSha: requireSha(mg?.head_sha, 'merge_group.head_sha'),
    };
  }
  return { kind: 'other', eventName, repository, pr: null, baseSha: null, headSha: null };
}

/** Where the diff comes from. diff-file wins; otherwise the event decides. */
export function planDiffSource(config, ctx) {
  if (config.diffFile !== '') return { type: 'diff-file', path: config.diffFile };
  if (ctx.kind === 'pull') return { type: 'pulls', pr: ctx.pr };
  if (ctx.kind === 'merge_group') return { type: 'compare', base: ctx.baseSha, head: ctx.headSha };
  throw new CcoxError(
    'event',
    `event "${ctx.eventName}" carries no diff; run on pull_request_target or merge_group (or pass diff-file)`,
  );
}

/**
 * Where definitions come from. A configured path is ALWAYS read at the base
 * commit, so a pull request cannot weaken the rules it is judged by.
 */
export function planDefinitionsSource(config, ctx) {
  if (config.definitionsPath === '') return { type: 'bundled', path: 'compliances', ref: null };
  if (!ctx.baseSha) {
    throw new CcoxError(
      'event',
      `compliance-definitions-path is read from the base commit, and event "${ctx.eventName}" has none`,
    );
  }
  return { type: 'base-ref', path: config.definitionsPath, ref: ctx.baseSha };
}

/**
 * Identify the running action: explicit repository/ref when the runner
 * provides them, else derived from the action path
 * (.../_actions/<owner>/<repo>/<ref>), else null (a local `uses: ./`).
 */
export function actionIdentity({ repository, ref, actionPath }) {
  if (repository && ref) return { repository, ref };
  const m = /\/_actions\/([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(actionPath ?? '');
  if (m) return { repository: `${m[1]}/${m[2]}`, ref: m[3] };
  return { repository: null, ref: null };
}
