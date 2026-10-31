const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { poseFor, createWeatherSource, geocode, MIN_REFRESH_MS } = require('../vendor/pet-brain/weather.js');
const meta = require('../renderer/raincloud/raincloud_v2.json');

const MIN = 60 * 1000;

// Shape recorded from a real Open-Meteo request on 2026-10-30 (latitude=39.04, longitude=-77.49).
const REAL_FORECAST = {
  latitude: 39.04,
  longitude: -77.49,
  timezone: 'America/New_York',
  current_units: { time: 'iso8601', interval: 'seconds', weather_code: 'wmo code', is_day: '', temperature_2m: '°C', wind_speed_10m: 'km/h' },
  current: { time: '2026-10-30T00:15', interval: 900, weather_code: 0, is_day: 0, temperature_2m: 12.0, wind_speed_10m: 6.0 },
};

test('every WMO code maps to a pose that exists in the sheet', () => {
  const codes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 97, 99];
  for (const code of codes) {
    for (const isDay of [0, 1]) {
      const pose = poseFor({ code, isDay, tempC: 15, windKmh: 5 });
      assert.ok(pose && meta.poses[pose], `code ${code} isDay ${isDay} -> ${pose}`);
    }
  }
});

test('poseFor picks the worst weather first and returns null for unknown codes', () => {
  assert.strictEqual(poseFor({ code: 0, isDay: 1, tempC: 20, windKmh: 5 }), 'wx_clear_day');
  assert.strictEqual(poseFor({ code: 0, isDay: 0, tempC: 20, windKmh: 5 }), 'wx_clear_night');
  assert.strictEqual(poseFor({ code: 3, isDay: 1, tempC: -3, windKmh: 5 }), 'wx_cold');
  assert.strictEqual(poseFor({ code: 1, isDay: 1, tempC: 35, windKmh: 5 }), 'wx_hot');
  assert.strictEqual(poseFor({ code: 2, isDay: 1, tempC: 15, windKmh: 55 }), 'wx_windy');
  assert.strictEqual(poseFor({ code: 95, isDay: 1, tempC: 35, windKmh: 55 }), 'wx_thunder');
  assert.strictEqual(poseFor({ code: 999, isDay: 1, tempC: 15, windKmh: 5 }), null);
});

test('the real response shape produces a pose', async () => {
  let url = '';
  const source = createWeatherSource({
    latitude: 39.0438, longitude: -77.4874, now: () => 0,
    fetchFn: async (u) => { url = u; return { ok: true, json: async () => REAL_FORECAST }; },
  });
  assert.strictEqual(await source.getPose(), 'wx_clear_night');
  assert.ok(url.includes('latitude=39.04') && url.includes('longitude=-77.49'), 'coordinates rounded to 2 decimals');
  assert.ok(url.includes('current=weather_code,is_day,temperature_2m,wind_speed_10m'));
  assert.ok(!/[?&](key|token|user|id)=/i.test(url), 'no account or identifier in the request');
});

test('weather refreshes at most every 15 minutes and backs off after a failure', async () => {
  let t = 0;
  let calls = 0;
  let mode = 'ok';
  const fetchFn = async () => {
    calls += 1;
    if (mode === 'fail') return { ok: false, status: 500 };
    return { ok: true, json: async () => ({ current: { weather_code: 61, is_day: 1, temperature_2m: 10, wind_speed_10m: 8 } }) };
  };
  const source = createWeatherSource({ latitude: 1, longitude: 2, fetchFn, now: () => t });
  assert.strictEqual(await source.getPose(), 'wx_rain');
  assert.strictEqual(calls, 1);
  t += 5 * MIN; await source.getPose(); assert.strictEqual(calls, 1, 'cached inside 15 minutes');
  t += 11 * MIN; mode = 'fail';
  assert.strictEqual(await source.getPose(), 'wx_rain', 'keeps the last pose when a refresh fails');
  assert.strictEqual(calls, 2);
  t += 16 * MIN; await source.getPose(); assert.strictEqual(calls, 2, 'backs off after a failure');
  assert.strictEqual(MIN_REFRESH_MS, 15 * MIN);
});

test('offline returns null, never throws', async () => {
  const source = createWeatherSource({ latitude: 0, longitude: 0, now: () => 0, fetchFn: async () => { throw new Error('offline'); } });
  assert.strictEqual(await source.getPose(), null);
});

test('geocode returns rounded coordinates and a readable label', async () => {
  const results = await geocode('Ashburn', async () => ({
    ok: true,
    json: async () => ({ results: [{ name: 'Ashburn', admin1: 'Virginia', country: 'United States', latitude: 39.04372, longitude: -77.48749 }] }),
  }));
  assert.deepStrictEqual(results, [{ label: 'Ashburn, Virginia, United States', latitude: 39.04, longitude: -77.49 }]);
  assert.deepStrictEqual(await geocode('Nowhere', async () => ({ ok: true, json: async () => ({}) })), []);
});

test('weather poses replace only ambient reactions, never event reactions', async () => {
  const { createRaincloud } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'raincloud', 'raincloud_v2.js')).href);
  const cloud = createRaincloud(meta, {});
  // Ambient: the weather pose wins.
  for (const reaction of ['short_idle', 'music_paused', 'video_watching', 'game_time', 'chat_chatter', 'idle']) {
    assert.strictEqual(cloud.poseFor(reaction, 'wx_rain'), 'wx_rain', reaction);
  }
  // Event and attention reactions keep their own pose.
  assert.strictEqual(cloud.poseFor('stuck', 'wx_rain'), 'drizzle');
  assert.strictEqual(cloud.poseFor('celebrate', 'wx_thunder'), 'sunbreak');
  assert.strictEqual(cloud.poseFor('error_spotted', 'wx_snow'), 'storm');
  assert.strictEqual(cloud.poseFor('focused', 'wx_clear_day'), 'focus');
  // No weather, or a pose that is not in the sheet: normal poses.
  assert.strictEqual(cloud.poseFor('short_idle', null), 'idle');
  assert.strictEqual(cloud.poseFor('short_idle', 'wx_nonsense'), 'idle');
});
