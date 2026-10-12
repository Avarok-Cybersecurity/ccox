// errors.mjs — the one error type CCOX raises, and the closed set of kinds it
// may carry. Every failure that reaches the report is a CcoxError, so the
// report's `error.kind` is always one of ERROR_KINDS (docs/report-schema.md).

export const ERROR_KINDS = Object.freeze([
  'input', // an action input is missing or invalid
  'event', // the triggering event cannot be evaluated
  'definitions', // compliance definitions are missing or malformed
  'github', // a GitHub API call failed
  'diff', // the diff is malformed
  'diff_truncated', // the diff or the changed-file listing is incomplete
  'diff_too_large', // more changed files than GitHub can list completely
  'diff_unavailable', // an in-scope file has no patch and its contents could not be read
  'file_over_budget', // one in-scope file alone exceeds max-diff-bytes
  'provider', // the model endpoint failed
  'quota', // a daily allowance is exhausted; retrying will not help
  'timeout', // the model endpoint did not answer in time
  'parse', // the model answer carries no readable verdict
  'invalid_verdict', // the verdict does not match the schema
  'invalid_violation', // a violation names an out-of-scope file or a line outside the hunks
  'injection_suspected', // the model suspected prompt injection and still answered compliant
  'internal', // anything else; always a bug in CCOX
]);

export class CcoxError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message
   * @param {{ transient?: boolean }} [options] transient = retrying may succeed
   */
  constructor(kind, message, { transient = false } = {}) {
    super(message);
    if (!ERROR_KINDS.includes(kind)) {
      throw new TypeError(`CcoxError: unknown kind ${JSON.stringify(kind)}`);
    }
    this.name = 'CcoxError';
    this.kind = kind;
    this.transient = transient;
  }
}

/** Map any thrown value to the report's `{ kind, message }` shape. */
export function toErrorRecord(e) {
  if (e instanceof CcoxError) return { kind: e.kind, message: e.message };
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return { kind: 'internal', message };
}
