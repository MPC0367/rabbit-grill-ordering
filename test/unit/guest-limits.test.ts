// The guest bundle keeps its own copy of a few request bounds so it does not
// load zod (client/src/guest/visit/limits.ts). They must match the schemas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortionRequestBody } from '../../shared/schemas.ts';
import { PREFERRED_GRAMS } from '../../client/src/guest/visit/limits.ts';

test('preferred-weight bounds match PortionRequestBody', () => {
  const ok = (grams: number) => PortionRequestBody.safeParse({ item_id: 'itm_x', preferred_grams: grams, idempotency_key: 'k'.repeat(24) }).success;
  const probe = PortionRequestBody.safeParse({ item_id: 'itm_x', preferred_grams: PREFERRED_GRAMS.min, idempotency_key: 'k'.repeat(24) });
  assert.ok(probe.success, `a valid body is rejected for another reason: ${probe.success ? '' : JSON.stringify(probe.error.issues)}`);
  assert.equal(ok(PREFERRED_GRAMS.min), true);
  assert.equal(ok(PREFERRED_GRAMS.min - 1), false);
  assert.equal(ok(PREFERRED_GRAMS.max), true);
  assert.equal(ok(PREFERRED_GRAMS.max + 1), false);
});
