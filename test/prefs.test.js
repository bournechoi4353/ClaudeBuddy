const test = require('node:test');
const assert = require('node:assert');
const { sanitizePetUpdates, cleanPlace, CHATTINESS_LEVELS } = require('../pet/prefs');

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

test('weather mood is a strict boolean and off unless true', () => {
  assert.strictEqual(sanitizePetUpdates({ petWeatherEnabled: true }).petWeatherEnabled, true);
  assert.strictEqual(sanitizePetUpdates({ petWeatherEnabled: 'on' }).petWeatherEnabled, false);
  assert.strictEqual(sanitizePetUpdates({ petWeatherEnabled: 1 }).petWeatherEnabled, false);
});

test('a weather place is rounded to 2 decimals and validated', () => {
  assert.deepStrictEqual(
    sanitizePetUpdates({ petWeatherPlace: { label: 'Ashburn, Virginia', latitude: 39.04372, longitude: -77.48749, extra: 'x' } }).petWeatherPlace,
    { label: 'Ashburn, Virginia', latitude: 39.04, longitude: -77.49 },
  );
  for (const bad of [{ latitude: 91, longitude: 0 }, { latitude: 0, longitude: 181 }, { latitude: '1', longitude: 2 }, { latitude: NaN, longitude: 2 }, 'home', 7, {}]) {
    assert.ok(!('petWeatherPlace' in sanitizePetUpdates({ petWeatherPlace: bad })), JSON.stringify(bad));
  }
  assert.strictEqual(sanitizePetUpdates({ petWeatherPlace: null }).petWeatherPlace, null, 'clearing is allowed');
  assert.strictEqual(cleanPlace({ latitude: 1, longitude: 2, label: 'x'.repeat(500) }).label.length, 100);
});

test('smart lines is a strict boolean and off unless true', () => {
  assert.strictEqual(sanitizePetUpdates({ petSmartLines: true }).petSmartLines, true);
  assert.strictEqual(sanitizePetUpdates({ petSmartLines: false }).petSmartLines, false);
  assert.strictEqual(sanitizePetUpdates({ petSmartLines: 'on' }).petSmartLines, false);
  assert.strictEqual(sanitizePetUpdates({ petSmartLines: 1 }).petSmartLines, false);
});

test('the model path is a trimmed string of sane length, or dropped', () => {
  assert.strictEqual(sanitizePetUpdates({ petModelPath: '  /models/pet.gguf  ' }).petModelPath, '/models/pet.gguf');
  assert.strictEqual(sanitizePetUpdates({ petModelPath: '' }).petModelPath, '', 'empty goes back to the default location');
  for (const bad of [42, null, {}, ['/a'], 'x'.repeat(1025)]) {
    assert.ok(!('petModelPath' in sanitizePetUpdates({ petModelPath: bad })), JSON.stringify(bad).slice(0, 30));
  }
});

test('reduce animation is a strict boolean', () => {
  assert.strictEqual(sanitizePetUpdates({ petReduceMotion: true }).petReduceMotion, true);
  assert.strictEqual(sanitizePetUpdates({ petReduceMotion: false }).petReduceMotion, false);
  assert.strictEqual(sanitizePetUpdates({ petReduceMotion: 'on' }).petReduceMotion, false);
  assert.ok(!('petReduceMotion' in sanitizePetUpdates({ petChattiness: 'low' })), 'absent stays absent, so the system setting decides');
});
