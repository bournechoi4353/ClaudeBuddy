const test = require('node:test');
const assert = require('node:assert');
const { createEventLayer } = require('../pet/events');
const { categorizeApp } = require('../pet/appCategories');
const { petBrainGate, petBrainActive } = require('../pet/flag');
const { reactionFor } = require('../vendor/pet-brain/rules.js');

const SEC = 1000;
const MIN = 60 * SEC;

// Feed `seconds` one-second samples starting at `from`, return the next free timestamp.
function feed(layer, from, seconds, sample) {
  let t = from;
  for (let i = 0; i < seconds; i += 1) {
    layer.ingest({ at: t, ...sample });
    t += SEC;
  }
  return t;
}

test('categorizeApp maps known names and defaults to other', () => {
  assert.strictEqual(categorizeApp('Visual Studio Code'), 'code_editor');
  assert.strictEqual(categorizeApp('Cursor'), 'code_editor');
  assert.strictEqual(categorizeApp('iTerm2'), 'terminal');
  assert.strictEqual(categorizeApp('Google Chrome'), 'browser');
  assert.strictEqual(categorizeApp('Spotify'), 'music');
  assert.strictEqual(categorizeApp('Slack'), 'chat');
  assert.strictEqual(categorizeApp('Notion'), 'docs');
  assert.strictEqual(categorizeApp('VLC'), 'video');
  assert.strictEqual(categorizeApp('Steam'), 'game');
  assert.strictEqual(categorizeApp('  slack '), 'chat');
  assert.strictEqual(categorizeApp('Figma'), 'other');
  assert.strictEqual(categorizeApp(''), 'other');
  assert.strictEqual(categorizeApp(null), 'other');
  assert.strictEqual(categorizeApp(42), 'other');
});

test('read returns exactly the six signal fields in valid ranges', () => {
  const layer = createEventLayer();
  layer.ingest({ at: 1000, frontApp: 'Code', idleSec: 4, music: 'playing', hour: 15 });
  const s = layer.read(1000);
  assert.deepStrictEqual(Object.keys(s).sort(), ['app_category', 'event', 'hour', 'idle_s', 'music', 'typing']);
  assert.strictEqual(s.app_category, 'code_editor');
  assert.strictEqual(s.idle_s, 4);
  assert.strictEqual(s.hour, 15);
  assert.strictEqual(s.music, 'playing');
  assert.strictEqual(s.event, 'none');
});

test('read before any sample gives safe defaults', () => {
  const s = createEventLayer().read(0);
  assert.strictEqual(s.app_category, 'other');
  assert.strictEqual(s.typing, 'none');
  assert.strictEqual(s.music, 'none');
  assert.strictEqual(s.event, 'none');
});

test('garbage samples are ignored and never throw', () => {
  const layer = createEventLayer();
  assert.doesNotThrow(() => {
    layer.ingest(null);
    layer.ingest(undefined);
    layer.ingest({});
    layer.ingest({ at: 'now' });
    layer.ingest({ at: NaN });
    layer.ingest({ at: 5, idleSec: 'lots', music: 'loud', typing: 'wild', frontApp: 7 });
    layer.pushEvent('not_an_event', 5);
    layer.pushEvent('build_failed', 'later');
  });
  const s = layer.read(5);
  assert.strictEqual(s.event, 'none');
  assert.strictEqual(s.music, 'none');
});

test('hour comes from the timestamp when the sample does not give one', () => {
  const layer = createEventLayer();
  const at = new Date(2026, 5, 1, 23, 30, 0).getTime();
  layer.ingest({ at, idleSec: 0 });
  assert.strictEqual(layer.read(at).hour, 23);
});

test('typing proxy buckets by the share of active samples', () => {
  const layer = createEventLayer();
  let t = feed(layer, 0, 30, { idleSec: 0 });
  assert.strictEqual(layer.read(t).typing, 'fast');

  const steady = createEventLayer();
  // about 60 percent active
  t = 0;
  for (let i = 0; i < 30; i += 1) { steady.ingest({ at: t, idleSec: i % 5 < 3 ? 0 : 10 }); t += SEC; }
  assert.strictEqual(steady.read(t).typing, 'steady');

  const slow = createEventLayer();
  t = 0;
  for (let i = 0; i < 30; i += 1) { slow.ingest({ at: t, idleSec: i % 5 === 0 ? 0 : 10 }); t += SEC; }
  assert.strictEqual(slow.read(t).typing, 'slow');

  const none = createEventLayer();
  t = feed(none, 0, 30, { idleSec: 20 });
  assert.strictEqual(none.read(t).typing, 'none');
});

test('typing proxy forgets samples older than the window', () => {
  const layer = createEventLayer();
  let t = feed(layer, 0, 30, { idleSec: 0 });
  assert.strictEqual(layer.read(t).typing, 'fast');
  t = feed(layer, t, 40, { idleSec: 30 });
  assert.strictEqual(layer.read(t).typing, 'none');
});

test('a real typing value on the sample overrides the proxy', () => {
  const layer = createEventLayer();
  layer.ingest({ at: 0, idleSec: 60, typing: 'fast' });
  assert.strictEqual(layer.read(0).typing, 'fast');
  layer.ingest({ at: SEC, idleSec: 60 });
  assert.strictEqual(layer.read(SEC).typing, 'none');
});

test('returned_from_idle fires once after a long idle ends', () => {
  const layer = createEventLayer();
  let t = feed(layer, 0, 5, { idleSec: 0 });
  layer.ingest({ at: t, idleSec: 6 * 60 });
  t += SEC;
  assert.strictEqual(layer.read(t).event, 'none');
  layer.ingest({ at: t, idleSec: 0 });
  assert.strictEqual(layer.read(t).event, 'returned_from_idle');
  assert.strictEqual(layer.read(t).event, 'none', 'consumed after one read');
  t = feed(layer, t + SEC, 5, { idleSec: 0 });
  assert.strictEqual(layer.read(t).event, 'none', 'does not fire again without another absence');
});

test('a short pause does not count as being away', () => {
  const layer = createEventLayer();
  layer.ingest({ at: 0, idleSec: 0 });
  layer.ingest({ at: SEC, idleSec: 120 });
  layer.ingest({ at: 2 * SEC, idleSec: 0 });
  assert.strictEqual(layer.read(2 * SEC).event, 'none');
});

test('app_switched_often fires after enough changes in a minute, not after slow changes', () => {
  const layer = createEventLayer();
  const apps = ['Code', 'Slack', 'Safari', 'Notion', 'Terminal', 'Figma', 'Code'];
  let t = 0;
  for (const app of apps) { layer.ingest({ at: t, frontApp: app, idleSec: 0 }); t += 5 * SEC; }
  assert.strictEqual(layer.read(t).event, 'app_switched_often');

  const slow = createEventLayer();
  t = 0;
  for (const app of apps) { slow.ingest({ at: t, frontApp: app, idleSec: 0 }); t += 30 * SEC; }
  assert.strictEqual(slow.read(t).event, 'none');
});

test('staying in one app, or an unknown app name, is not a switch', () => {
  const layer = createEventLayer();
  let t = 0;
  for (let i = 0; i < 20; i += 1) { layer.ingest({ at: t, frontApp: i % 2 ? 'Code' : '', idleSec: 0 }); t += SEC; }
  assert.strictEqual(layer.read(t).event, 'none');
});

test('long_session fires after the configured stretch and re-arms', () => {
  const layer = createEventLayer({ config: { longSessionMs: 10 * MIN, longSessionRepeatMs: 10 * MIN } });
  let t = 0;
  let seen = 0;
  for (let i = 0; i < 25 * 60; i += 1) {
    layer.ingest({ at: t, idleSec: 0 });
    if (layer.read(t).event === 'long_session') seen += 1;
    t += SEC;
  }
  assert.strictEqual(seen, 2, 'once at 10 minutes and once at 20 minutes');
});

test('a break resets the work session', () => {
  const layer = createEventLayer({ config: { longSessionMs: 10 * MIN } });
  let t = feed(layer, 0, 9 * 60, { idleSec: 0 });
  layer.ingest({ at: t, idleSec: 6 * 60 }); // break
  t += SEC;
  t = feed(layer, t, 9 * 60, { idleSec: 0 });
  assert.notStrictEqual(layer.read(t).event, 'long_session');
});

test('pushed events are validated, prioritized, read once, and expire', () => {
  const layer = createEventLayer();
  layer.pushEvent('build_passed', 0);
  layer.pushEvent('build_failed', 0);
  layer.pushEvent('bogus', 0);
  assert.strictEqual(layer.read(1, { consume: false }).event, 'build_failed', 'peek does not consume');
  assert.strictEqual(layer.read(1).event, 'build_failed', 'higher priority first');
  assert.strictEqual(layer.read(1).event, 'build_passed');
  assert.strictEqual(layer.read(1).event, 'none');

  layer.pushEvent('error_dialog', 0);
  assert.strictEqual(layer.read(2 * MIN).event, 'none', 'stale event dropped');
});

test('event signals flow into the real rules', () => {
  const layer = createEventLayer();
  layer.pushEvent('build_failed', 0);
  assert.strictEqual(reactionFor(layer.read(0)), 'stuck');
  layer.pushEvent('build_passed', 0);
  assert.strictEqual(reactionFor(layer.read(0)), 'celebrate');
  layer.pushEvent('error_dialog', 0);
  assert.strictEqual(reactionFor(layer.read(0)), 'error_spotted');
});

test('the output carries no content fields', () => {
  const layer = createEventLayer();
  layer.ingest({ at: 0, frontApp: 'Code', idleSec: 0, windowTitle: 'secret.txt', url: 'https://x', keys: 'abc' });
  const s = layer.read(0);
  assert.deepStrictEqual(Object.keys(s).sort(), ['app_category', 'event', 'hour', 'idle_s', 'music', 'typing']);
  assert.ok(!JSON.stringify(s).includes('secret'));
});

test('flag helpers: on by default, only PET_BRAIN_LOCAL=0 closes the gate, prefs can switch it off', () => {
  assert.strictEqual(petBrainGate({}), true, 'on with nothing set');
  assert.strictEqual(petBrainGate({ PET_BRAIN_LOCAL: '1' }), true);
  assert.strictEqual(petBrainGate({ PET_BRAIN_LOCAL: 'true' }), true, 'only an exact 0 turns it off');
  assert.strictEqual(petBrainGate({ PET_BRAIN_LOCAL: '' }), true);
  assert.strictEqual(petBrainGate({ PET_BRAIN_LOCAL: '0' }), false);
  assert.strictEqual(petBrainActive({}, {}), true);
  assert.strictEqual(petBrainActive({}, { PET_BRAIN_LOCAL: '1' }), true);
  assert.strictEqual(petBrainActive({ petBrainEnabled: false }, {}), false, 'the Preferences switch turns it off');
  assert.strictEqual(petBrainActive({ petBrainEnabled: true }, { PET_BRAIN_LOCAL: '0' }), false, 'the environment wins over prefs');
  assert.strictEqual(petBrainActive({}, { PET_BRAIN_LOCAL: '0' }), false);
});
