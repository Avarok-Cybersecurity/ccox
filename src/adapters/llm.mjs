// llm.mjs — the chat-completions call, and how its failures are classified.
//
// Contract: OpenRouter-style providers can fail as HTTP 200 with an `error`
// body, so every response passes through classifyProviderResponse. A saturated
// provider (429, 5xx, "ResourceExhausted", "overloaded") is transient and
// retried. A per-day free-model allowance is kind `quota` and is NOT retried:
// backoff cannot clear it before its reset stamp.

import { CcoxError } from '../core/errors.mjs';
import { fetchWithTimeout, readBody, withRetry } from './http.mjs';

const TRANSIENT_TEXT = /ResourceExhausted|rate.?limit|overloaded|temporarily unavailable/i;
const DAILY_LIMIT_TEXT = /free-models-per-day|per-?day|daily/i;
const APP_TITLE = 'CCOX';
const APP_REFERER = 'https://github.com/Avarok-Cybersecurity/ccox';

function dailyQuota(errorBody, resetHeader) {
  const meta = errorBody?.metadata ?? {};
  const source = String(meta.limit_source ?? '');
  const message = String(errorBody?.message ?? '');
  if (!DAILY_LIMIT_TEXT.test(source) && !DAILY_LIMIT_TEXT.test(message)) return null;
  const reset = Number(meta.headers?.['X-RateLimit-Reset'] ?? resetHeader);
  return { resetAt: Number.isFinite(reset) && reset > 0 ? reset : null };
}

function quotaError(message, quota) {
  const when = quota.resetAt ? ` (resets at ${new Date(quota.resetAt).toISOString()})` : '';
  return new CcoxError('quota', `daily model allowance exhausted${when}: ${message}`);
}

function codeNumber(code) {
  const n = typeof code === 'string' ? Number(code) : code;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Turn one HTTP exchange into parsed JSON, or throw a classified CcoxError.
 * @param {{ status: number, text: string, resetHeader: string|null }} res
 */
export function classifyProviderResponse({ status, text, resetHeader }) {
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (status < 200 || status >= 300) {
    const quota = status === 429 ? dailyQuota(body?.error, resetHeader) : null;
    if (quota) throw quotaError(body.error.message ?? 'daily limit reached', quota);
    throw new CcoxError('provider', `model endpoint answered HTTP ${status}: ${text.slice(0, 500)}`, {
      transient: status === 429 || status >= 500,
    });
  }
  if (body === null || typeof body !== 'object') {
    throw new CcoxError('provider', `model endpoint returned invalid JSON: ${text.slice(0, 200)}`);
  }
  if (body.error) {
    const message = String(body.error.message ?? 'unknown error');
    const quota = dailyQuota(body.error, resetHeader);
    if (quota) throw quotaError(message, quota);
    const code = codeNumber(body.error.code);
    throw new CcoxError('provider', `model endpoint reported an error${code ? ` (${code})` : ''}: ${message}`, {
      transient: code === 429 || code >= 500 || TRANSIENT_TEXT.test(message),
    });
  }
  return body;
}

function headersFor(provider, apiKey) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = APP_REFERER;
    headers['X-Title'] = APP_TITLE;
  }
  return headers;
}

/**
 * POST <endpoint>/chat/completions with retries.
 * Returns { data, raw, attempts } where raw is the exact response body text.
 */
export async function requestCompletion(
  { endpoint, apiKey, provider, body, timeoutMs, maxAttempts },
  { fetchImpl, sleep, log },
) {
  const url = `${endpoint}/chat/completions`;
  const payload = JSON.stringify(body);
  let attempts = 0;
  const result = await withRetry(async (attempt) => {
    attempts = attempt;
    const response = await fetchWithTimeout(
      fetchImpl,
      url,
      { method: 'POST', headers: headersFor(provider, apiKey), body: payload },
      { timeoutMs, kind: 'provider' },
    );
    const raw = await readBody(response, { what: 'model endpoint', kind: 'provider' });
    const data = classifyProviderResponse({
      status: response.status,
      text: raw,
      resetHeader: response.headers.get('X-RateLimit-Reset'),
    });
    return { data, raw };
  }, { maxAttempts, sleep, log, label: 'llm' });
  return { ...result, attempts };
}
