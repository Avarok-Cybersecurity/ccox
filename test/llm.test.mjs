// The provider port is exercised through its pure classifier with recorded
// response bodies, and the retry loop through a scripted fetch (the HTTP
// boundary itself; no mocking framework). The end-to-end suite covers the
// same paths over a real local HTTP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CcoxError } from '../src/core/errors.mjs';
import { classifyProviderResponse, requestCompletion } from '../src/adapters/llm.mjs';

const body = (name) => readFileSync(new URL(`./fixtures/responses/${name}`, import.meta.url), 'utf8');
const classify = (status, name, resetHeader = null) => classifyProviderResponse({ status, text: body(name), resetHeader });
const throwsKind = (fn, kind, transient) => assert.throws(fn, (e) => {
  assert.ok(e instanceof CcoxError);
  assert.equal(e.kind, kind);
  assert.equal(e.transient, transient);
  return true;
});

test('a normal completion is returned as parsed JSON', () => {
  assert.equal(classify(200, 'tool_call-violation.json').choices.length, 1);
});

test('HTTP 200 with an error body is an error, transient when the provider is saturated', () => {
  throwsKind(() => classify(200, 'error-200-transient.json'), 'provider', true);
});

test('the per-day free-model allowance is kind quota and NOT retried (200 or 429)', () => {
  throwsKind(() => classify(429, 'error-429-daily.json'), 'quota', false);
  throwsKind(() => classify(200, 'error-429-daily.json'), 'quota', false);
  assert.throws(() => classify(429, 'error-429-daily.json'), /resets at 2025-10-12T00:00:00.000Z/);
});

test('a short burst 429 is transient; an unroutable request is not; 5xx is transient', () => {
  throwsKind(() => classify(429, 'error-429-burst.json'), 'provider', true);
  // Recorded live: json_schema with require_parameters has no endpoint on the free model (HTTP 404).
  throwsKind(() => classify(404, 'error-400-unsupported.json'), 'provider', false);
  throwsKind(() => classifyProviderResponse({ status: 503, text: 'Service Unavailable', resetHeader: null }), 'provider', true);
  throwsKind(() => classifyProviderResponse({ status: 200, text: '<html>', resetHeader: null }), 'provider', false);
});

function scriptedFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const [status, name] = script[Math.min(calls.length - 1, script.length - 1)];
    return new Response(body(name), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

const opts = { endpoint: 'https://llm.example/v1', apiKey: 'sk-secret', provider: 'openrouter', body: { model: 'm' }, timeoutMs: 5000, maxAttempts: 3 };

test('transient failures are retried with backoff, then the answer is returned', async () => {
  const { fetchImpl, calls } = scriptedFetch([[200, 'error-200-transient.json'], [502, 'error-200-transient.json'], [200, 'tool_call-compliant.json']]);
  const sleeps = [];
  const r = await requestCompletion(opts, { fetchImpl, sleep: async (ms) => sleeps.push(ms), log: () => {} });
  assert.equal(r.attempts, 3);
  assert.deepEqual(sleeps, [700, 1400]);
  assert.equal(r.raw, body('tool_call-compliant.json'));
  assert.equal(calls[0].url, 'https://llm.example/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-secret');
});

test('quota stops at the first attempt', async () => {
  const { fetchImpl, calls } = scriptedFetch([[429, 'error-429-daily.json']]);
  await assert.rejects(
    requestCompletion(opts, { fetchImpl, sleep: async () => {}, log: () => {} }),
    (e) => e.kind === 'quota',
  );
  assert.equal(calls.length, 1);
});

test('retries are bounded by max-retries and the last error surfaces', async () => {
  const { fetchImpl, calls } = scriptedFetch([[503, 'error-200-transient.json']]);
  await assert.rejects(
    requestCompletion({ ...opts, maxAttempts: 2 }, { fetchImpl, sleep: async () => {}, log: () => {} }),
    (e) => e.kind === 'provider' && e.transient,
  );
  assert.equal(calls.length, 2);
});

test('a network failure is a transient provider error; a timeout is kind timeout', async () => {
  const refuse = async () => {
    throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
  };
  await assert.rejects(
    requestCompletion({ ...opts, maxAttempts: 1 }, { fetchImpl: refuse, sleep: async () => {}, log: () => {} }),
    (e) => e.kind === 'provider' && /ECONNREFUSED/.test(e.message),
  );
  // A stalled socket keeps the event loop alive; the interval stands in for it
  // (AbortSignal.timeout's own timer is unref'd).
  const hang = (url, init) => new Promise((_, reject) => {
    const socket = setInterval(() => {}, 1000);
    init.signal.addEventListener('abort', () => {
      clearInterval(socket);
      reject(init.signal.reason);
    });
  });
  await assert.rejects(
    requestCompletion({ ...opts, timeoutMs: 20, maxAttempts: 1 }, { fetchImpl: hang, sleep: async () => {}, log: () => {} }),
    (e) => e.kind === 'timeout',
  );
});
