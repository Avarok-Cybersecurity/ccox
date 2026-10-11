// http.mjs — fetch with a hard timeout, and retry with exponential backoff.
//
// Contract: only errors marked `transient` are retried (700ms * 2^n between
// attempts); everything else surfaces on the first failure. Network failures
// and timeouts become CcoxErrors so they reach the report with a kind.

import { CcoxError } from '../core/errors.mjs';

export const RETRY_BASE_MS = 700;

/**
 * fetch() that aborts after timeoutMs. `kind` labels network failures
 * (e.g. 'github' or 'provider'); timeouts are always kind 'timeout'.
 */
export async function fetchWithTimeout(fetchImpl, url, init, { timeoutMs, kind }) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new CcoxError('timeout', `${init.method ?? 'GET'} ${redactUrl(url)} did not answer within ${timeoutMs} ms`, { transient: true });
    }
    throw new CcoxError(kind, `${init.method ?? 'GET'} ${redactUrl(url)} failed: ${e?.cause?.message ?? e?.message ?? e}`, { transient: true });
  }
}

/** Read a response body as text, mapping a body-read timeout like a request timeout. */
export async function readBody(response, { what, kind }) {
  try {
    return await response.text();
  } catch (e) {
    const failure = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : kind;
    throw new CcoxError(failure, `${what}: reading the response body failed: ${e?.message ?? e}`, { transient: true });
  }
}

function redactUrl(url) {
  const u = new URL(url);
  u.search = '';
  return u.toString();
}

/** Run `operation` up to maxAttempts times, retrying only transient CcoxErrors. */
export async function withRetry(operation, { maxAttempts, sleep, log, label }) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const transient = error instanceof CcoxError && error.transient;
      if (!transient || attempt === maxAttempts) break;
      const backoff = RETRY_BASE_MS * 2 ** (attempt - 1);
      log(`[${label}] transient failure (attempt ${attempt}/${maxAttempts}), retrying in ${backoff} ms: ${error.message}`);
      await sleep(backoff);
    }
  }
  throw lastError;
}
