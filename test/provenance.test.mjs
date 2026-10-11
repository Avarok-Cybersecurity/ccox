// Provider-response fixtures are recorded from the live model wherever the
// model can produce them (fixtures/responses/provenance.json). A live fixture
// must stay byte-identical to the recording, and every fixture says where it
// came from: live, derived from a live one by one stated mutation, or
// hand-written because the provider cannot produce it on demand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { sha256Hex } from '../src/core/hash.mjs';

const dir = new URL('./fixtures/responses/', import.meta.url);
const provenance = JSON.parse(readFileSync(new URL('provenance.json', dir), 'utf8'));
const fixtures = readdirSync(dir).filter((n) => n !== 'provenance.json');

test('every response fixture has exactly one provenance entry', () => {
  assert.deepEqual([...fixtures].sort(), Object.keys(provenance).sort());
});

test('live fixtures are byte-identical to the recorded response bodies', () => {
  const live = Object.entries(provenance).filter(([, p]) => p.source === 'live');
  assert.ok(live.length >= 5, 'most fixtures are live recordings');
  for (const [name, p] of live) {
    assert.equal(sha256Hex(readFileSync(new URL(name, dir), 'utf8')), p.sha256, name);
    assert.match(p.recorded_by, /^https:\/\/github\.com\/Avarok-Cybersecurity\/ccox\/actions\/runs\/\d+$/);
  }
});

test('derived fixtures name a live source and their mutation', () => {
  for (const [name, p] of Object.entries(provenance)) {
    assert.ok(['live', 'derived', 'hand-written'].includes(p.source), name);
    if (p.source === 'derived') {
      assert.equal(provenance[p.from]?.source, 'live', `${name} derives from a live fixture`);
      assert.ok(p.mutation.length > 0, name);
    }
  }
});
