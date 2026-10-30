const test = require('node:test');
const assert = require('node:assert');
const { sanitizePetUpdates, CHATTINESS_LEVELS } = require('../pet/prefs');

test('chattiness accepts only the known levels', () => {
  assert.deepStrictEqual(CHATTINESS_LEVELS.sort(), ['high', 'low', 'normal']);
  for (const level of CHATTINESS_LEVELS) {
    assert.strictEqual(sanitizePetUpdates({ petChattiness: level }).petChattiness, level);
  }
  assert.ok(!('petChattiness' in sanitizePetUpdates({ petChattiness: 'shouty' })));
  assert.ok(!('petChattiness' in sanitizePetUpdates({ petChattiness: 3 })));
});

test('the master switch is a strict boolean', () => {
  assert.strictEqual(sanitizePetUpdates({ petBrainEnabled: true }).petBrainEnabled, true);
  assert.strictEqual(sanitizePetUpdates({ petBrainEnabled: false }).petBrainEnabled, false);
  assert.strictEqual(sanitizePetUpdates({ petBrainEnabled: 'yes' }).petBrainEnabled, false);
  assert.strictEqual(sanitizePetUpdates({ petBrainEnabled: 1 }).petBrainEnabled, false);
});

test('other preferences pass through untouched and inputs are not mutated', () => {
  const input = { petName: 'clawd', crabSpeed: 0.5, petChattiness: 'bogus' };
  const out = sanitizePetUpdates(input);
  assert.deepStrictEqual(out, { petName: 'clawd', crabSpeed: 0.5 });
  assert.strictEqual(input.petChattiness, 'bogus');
  assert.strictEqual(sanitizePetUpdates(null), null);
  assert.strictEqual(sanitizePetUpdates(undefined), undefined);
});
