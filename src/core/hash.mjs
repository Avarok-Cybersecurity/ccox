// hash.mjs — sha256 over text. Deterministic and side-effect free.

import { createHash } from 'node:crypto';

/** sha256 of a string (UTF-8) or Buffer, as lowercase hex. */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}
