// verdict.mjs — the verdict contract and the parser that enforces it.
//
// Contract: the model's answer is untrusted. It is extracted for the chosen
// structured mode, validated against the same JSON Schema the request sent
// (one source: verdictSchema), checked for internal consistency, and every
// violation must name a file of the batch and a line range inside one of
// that file's hunks. Anything else is an error result, never a pass.

import { CcoxError } from './errors.mjs';
import { newSideRanges } from './diff.mjs';

export const VERDICT_TOOL_NAME = 'report_verdict';
export const STRUCTURED_MODES = Object.freeze(['tool_call', 'json_schema', 'text']);

/** JSON Schema of one verdict; `rule` is limited to the definition's rule ids. */
export function verdictSchema(ruleIds) {
  if (!Array.isArray(ruleIds) || ruleIds.length === 0) {
    throw new CcoxError('definitions', 'a verdict schema needs at least one rule id');
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'injection_suspected', 'violations'],
    properties: {
      verdict: { type: 'string', enum: ['compliant', 'non_compliant'] },
      injection_suspected: { type: 'boolean' },
      violations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['file', 'line_start', 'line_end', 'rule', 'explanation', 'evidence'],
          properties: {
            file: { type: 'string', minLength: 1 },
            line_start: { type: 'integer', minimum: 1 },
            line_end: { type: 'integer', minimum: 1 },
            rule: { type: 'string', enum: [...ruleIds] },
            explanation: { type: 'string', minLength: 1 },
            evidence: { type: 'string' },
          },
        },
      },
    },
  };
}

function typeOk(value, type) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return Number.isSafeInteger(value);
    default:
      throw new CcoxError('internal', `schema type ${type} is not supported by the validator`);
  }
}

/** Validate against the schema subset verdictSchema uses. Returns problem strings. */
export function validateAgainstSchema(value, schema, at = '$') {
  if (!typeOk(value, schema.type)) return [`${at}: expected ${schema.type}`];
  const problems = [];
  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    problems.push(`${at}: shorter than ${schema.minLength}`);
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    problems.push(`${at}: below ${schema.minimum}`);
  }
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) problems.push(`${at}: missing "${key}"`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (!sub) {
        if (schema.additionalProperties === false) problems.push(`${at}: unexpected "${key}"`);
        continue;
      }
      problems.push(...validateAgainstSchema(v, sub, `${at}.${key}`));
    }
  }
  if (schema.type === 'array') {
    value.forEach((item, i) => problems.push(...validateAgainstSchema(item, schema.items, `${at}[${i}]`)));
  }
  return problems;
}

function messageText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CcoxError('parse', `${what} is not valid JSON (${e.message}): ${JSON.stringify(text.slice(0, 200))}`);
  }
}

/** Pull the verdict object out of a chat-completions response for `mode`. */
export function extractPayload(mode, data) {
  const choice = data?.choices?.[0];
  if (!choice) throw new CcoxError('parse', 'response has no choices');
  if (choice.finish_reason === 'length') {
    throw new CcoxError('parse', 'answer was cut off (finish_reason "length"); raise max-tokens');
  }
  const message = choice.message;
  if (mode === 'tool_call') {
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (calls.length !== 1) {
      throw new CcoxError(
        'parse',
        `expected exactly one ${VERDICT_TOOL_NAME} call, got ${calls.length}` +
          (messageText(message) ? `; text: ${JSON.stringify(messageText(message).slice(0, 200))}` : ''),
      );
    }
    const fn = calls[0]?.function;
    if (fn?.name !== VERDICT_TOOL_NAME) {
      throw new CcoxError('parse', `model called ${JSON.stringify(fn?.name)}, not ${VERDICT_TOOL_NAME}`);
    }
    if (typeof fn.arguments === 'string') return parseJson(fn.arguments, 'tool-call arguments');
    if (fn.arguments && typeof fn.arguments === 'object') return fn.arguments;
    throw new CcoxError('parse', 'tool call carries no arguments');
  }
  if (mode === 'json_schema') {
    const text = messageText(message).trim();
    if (!text) throw new CcoxError('parse', 'answer has no content');
    return parseJson(text, 'answer');
  }
  if (mode === 'text') {
    const blocks = [...messageText(message).matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g)];
    if (blocks.length !== 1) {
      throw new CcoxError('parse', `expected exactly one fenced json block, found ${blocks.length}`);
    }
    return parseJson(blocks[0][1], 'fenced json block');
  }
  throw new CcoxError('internal', `unknown structured mode ${JSON.stringify(mode)}`);
}

/** Split violations into those citing a batch file inside a hunk, and the rest. */
export function checkViolations(violations, files) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const accepted = [];
  const rejected = [];
  for (const v of violations) {
    const file = byPath.get(v.file);
    if (!file) {
      rejected.push({ ...v, reason: 'file is not one of the scoped files in this batch' });
    } else if (v.line_end < v.line_start) {
      rejected.push({ ...v, reason: 'line_end is before line_start' });
    } else if (!newSideRanges(file).some((r) => v.line_start >= r.start && v.line_end <= r.end)) {
      rejected.push({ ...v, reason: 'line range is not inside a single hunk of the new file' });
    } else {
      accepted.push(v);
    }
  }
  return { accepted, rejected };
}

function errorResult(e, extra = {}) {
  if (!(e instanceof CcoxError)) throw e;
  return {
    status: 'error',
    verdict: null,
    injection_suspected: false,
    violations: [],
    rejected_violations: [],
    error: { kind: e.kind, message: e.message },
    ...extra,
  };
}

/**
 * Judge one batch answer. Returns
 *   { status: pass|violations|error, verdict, injection_suspected,
 *     violations, rejected_violations, error }
 * and never throws for anything the model sent.
 */
export function judgeResponse({ mode, data, schema, files }) {
  let payload;
  try {
    payload = extractPayload(mode, data);
  } catch (e) {
    return errorResult(e);
  }
  const problems = validateAgainstSchema(payload, schema);
  if (problems.length > 0) {
    return errorResult(new CcoxError('invalid_verdict', `verdict does not match the schema: ${problems.slice(0, 8).join('; ')}`));
  }
  const { verdict, injection_suspected: injection, violations } = payload;
  const base = { verdict, injection_suspected: injection };
  if ((verdict === 'compliant') !== (violations.length === 0)) {
    return errorResult(
      new CcoxError('invalid_verdict', `verdict "${verdict}" contradicts ${violations.length} violation(s)`),
      base,
    );
  }
  const { accepted, rejected } = checkViolations(violations, files);
  if (rejected.length > 0) {
    return {
      ...errorResult(
        new CcoxError('invalid_violation', `${rejected.length} violation(s) cite a file or line outside the scoped hunks`),
        base,
      ),
      violations: accepted,
      rejected_violations: rejected,
    };
  }
  if (injection && verdict === 'compliant') {
    return errorResult(
      new CcoxError('injection_suspected', 'the model suspected prompt injection in the diff and answered compliant; not accepted as a pass'),
      base,
    );
  }
  return {
    status: verdict === 'compliant' ? 'pass' : 'violations',
    verdict,
    injection_suspected: injection,
    violations: accepted,
    rejected_violations: [],
    error: null,
  };
}
