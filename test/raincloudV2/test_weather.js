const assert = require('assert');
const fs = require('fs');
const { poseFor, createWeatherSource, geocode } = require('../../vendor/pet-brain/weather.js');
const meta = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', '..', 'renderer', 'raincloud', 'raincloud_v2.json'), 'utf8'));

// every WMO code from the Open-Meteo table maps to a pose that exists in the sheet (or null)
const codes = [0,1,2,3,45,48,51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,97,99];
for (const code of codes) for (const isDay of [0,1]) {
  const p = poseFor({ code, isDay, tempC: 15, windKmh: 5 });
  assert(p && meta.poses[p], `code ${code} isDay ${isDay} -> ${p}`);
}
assert.strictEqual(poseFor({ code: 0, isDay: 1, tempC: 20, windKmh: 5 }), 'wx_clear_day');
assert.strictEqual(poseFor({ code: 0, isDay: 0, tempC: 20, windKmh: 5 }), 'wx_clear_night');
assert.strictEqual(poseFor({ code: 3, isDay: 1, tempC: -3, windKmh: 5 }), 'wx_cold');
assert.strictEqual(poseFor({ code: 1, isDay: 1, tempC: 35, windKmh: 5 }), 'wx_hot');
assert.strictEqual(poseFor({ code: 2, isDay: 1, tempC: 15, windKmh: 55 }), 'wx_windy');
assert.strictEqual(poseFor({ code: 95, isDay: 1, tempC: 35, windKmh: 55 }), 'wx_thunder');
assert.strictEqual(poseFor({ code: 999, isDay: 1, tempC: 15, windKmh: 5 }), null);

// all rows in the manifest are unique and inside the sheet
const rows = Object.values(meta.poses).map((p) => p.row);
assert.strictEqual(new Set(rows).size, rows.length);
assert.strictEqual(Math.max(...rows) + 1, 28);
for (const r of Object.values(meta.reactions)) assert(meta.poses[r], `missing pose ${r}`);

module.exports = (async () => {
  let t = 0, calls = 0, mode = 'ok', lastUrl = '';
  const fetchFn = async (url) => {
    calls++; lastUrl = url;
    if (mode === 'fail') return { ok: false, status: 500 };
    return { ok: true, json: async () => ({ current: { weather_code: 61, is_day: 1, temperature_2m: 10, wind_speed_10m: 8 } }) };
  };
  const src = createWeatherSource({ latitude: 39.0438, longitude: -77.4874, fetchFn, now: () => t });
  assert.strictEqual(await src.getPose(), 'wx_rain');
  assert(lastUrl.includes('latitude=39.04') && lastUrl.includes('longitude=-77.49'), lastUrl);
  assert(lastUrl.includes('current=weather_code,is_day,temperature_2m,wind_speed_10m'));
  assert.strictEqual(calls, 1);
  t += 5 * 60 * 1000; await src.getPose(); assert.strictEqual(calls, 1, 'cached within 15 min');
  t += 11 * 60 * 1000; mode = 'fail'; assert.strictEqual(await src.getPose(), 'wx_rain', 'keeps last pose when refresh fails'); assert.strictEqual(calls, 2);
  t += 16 * 60 * 1000; await src.getPose(); assert.strictEqual(calls, 2, 'backs off after a failure');
  const bad = createWeatherSource({ latitude: 0, longitude: 0, fetchFn: async () => { throw new Error('offline'); }, now: () => 0 });
  assert.strictEqual(await bad.getPose(), null, 'offline returns null');
  const geo = await geocode('Ashburn', async () => ({ ok: true, json: async () => ({ results: [{ name: 'Ashburn', admin1: 'Virginia', country: 'United States', latitude: 39.04372, longitude: -77.48749 }] }) }));
  assert.deepStrictEqual(geo, [{ label: 'Ashburn, Virginia, United States', latitude: 39.04, longitude: -77.49 }]);
  console.log('ALL TESTS PASSED');
})();
