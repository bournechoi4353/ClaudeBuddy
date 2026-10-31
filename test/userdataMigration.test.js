const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateLegacyUserData } = require('../userdata-migration');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'drizzle-migrate-'));
}

test('the old settings are copied to the new folder on first start, and the old folder is untouched', () => {
  const appData = tmp();
  fs.mkdirSync(path.join(appData, 'Clawd'));
  fs.writeFileSync(path.join(appData, 'Clawd', 'prefs.json'), '{"petName":"x","spotifyRefreshToken":"t"}');
  fs.writeFileSync(path.join(appData, 'Clawd', 'other.txt'), 'keep me');
  const userData = path.join(appData, 'Drizzle');

  const result = migrateLegacyUserData({ appData, userData });
  assert.strictEqual(result.migrated, true);
  assert.strictEqual(fs.readFileSync(path.join(userData, 'prefs.json'), 'utf8'), '{"petName":"x","spotifyRefreshToken":"t"}');
  assert.strictEqual(fs.readFileSync(path.join(appData, 'Clawd', 'prefs.json'), 'utf8'), '{"petName":"x","spotifyRefreshToken":"t"}', 'the original is still there');
  assert.strictEqual(fs.readFileSync(path.join(appData, 'Clawd', 'other.txt'), 'utf8'), 'keep me');
  assert.deepStrictEqual(fs.readdirSync(userData), ['prefs.json'], 'only the settings are copied');
});

test('settings that already exist in the new folder are never replaced', () => {
  const appData = tmp();
  fs.mkdirSync(path.join(appData, 'Clawd'));
  fs.writeFileSync(path.join(appData, 'Clawd', 'prefs.json'), '{"old":true}');
  const userData = path.join(appData, 'Drizzle');
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, 'prefs.json'), '{"new":true}');

  assert.deepStrictEqual(migrateLegacyUserData({ appData, userData }), { migrated: false, reason: 'already-present' });
  assert.strictEqual(fs.readFileSync(path.join(userData, 'prefs.json'), 'utf8'), '{"new":true}');
});

test('a second start does nothing more', () => {
  const appData = tmp();
  fs.mkdirSync(path.join(appData, 'clawd'));
  fs.writeFileSync(path.join(appData, 'clawd', 'prefs.json'), '{"a":1}');
  const userData = path.join(appData, 'Drizzle');
  assert.strictEqual(migrateLegacyUserData({ appData, userData }).migrated, true);
  fs.writeFileSync(path.join(userData, 'prefs.json'), '{"a":2}'); // the user changed something since
  assert.strictEqual(migrateLegacyUserData({ appData, userData }).migrated, false);
  assert.strictEqual(fs.readFileSync(path.join(userData, 'prefs.json'), 'utf8'), '{"a":2}');
});

test('a fresh install with no old settings just starts clean', () => {
  const appData = tmp();
  const userData = path.join(appData, 'Drizzle');
  assert.deepStrictEqual(migrateLegacyUserData({ appData, userData }), { migrated: false, reason: 'no-legacy-prefs' });
  assert.ok(!fs.existsSync(path.join(userData, 'prefs.json')));
});

test('an old name that is really the same folder is not copied onto itself', () => {
  const appData = tmp();
  const userData = path.join(appData, 'clawd'); // as if the app still had the old name
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, 'prefs.json'), '{"same":true}');
  assert.strictEqual(migrateLegacyUserData({ appData, userData }).migrated, false);
  assert.strictEqual(fs.readFileSync(path.join(userData, 'prefs.json'), 'utf8'), '{"same":true}');
  fs.rmSync(path.join(userData, 'prefs.json'));
  assert.deepStrictEqual(migrateLegacyUserData({ appData, userData: path.join(appData, 'Clawd') }), { migrated: false, reason: 'no-legacy-prefs' });
});

test('a failure is reported, never thrown, so the app still starts', () => {
  const logs = [];
  const result = migrateLegacyUserData({ appData: null, userData: null, log: (m) => logs.push(m) });
  assert.deepStrictEqual(result, { migrated: false, reason: 'error' });
  assert.strictEqual(logs.length, 1);
});
