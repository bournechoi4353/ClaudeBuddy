const test = require('node:test');
const assert = require('node:assert');
const { createWeatherService } = require('../pet/weatherService');
const { MIN_REFRESH_MS } = require('../vendor/pet-brain/weather.js');

function fixture(pose = 'wx_rain', opts = {}) {
  const created = [];
  const poses = [];
  let current = pose;
  let throwing = false;
  const service = createWeatherService({
    onPose: (p) => poses.push(p),
    createSource: (args) => {
      created.push(args);
      return { getPose: async () => { if (throwing) throw new Error('offline'); return current; } };
    },
    ...opts,
  });
  return {
    service, created, poses,
    setPose: (p) => { current = p; },
    setThrowing: (v) => { throwing = v; },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('off by default: no source is created and nothing is requested', async () => {
  const { service, created, poses } = fixture();
  service.configure({ enabled: false, place: { latitude: 1, longitude: 2 } });
  service.configure({});
  service.configure();
  assert.strictEqual(created.length, 0);
  assert.strictEqual(service.isRunning(), false);
  assert.deepStrictEqual(poses, []);
});

test('enabled without a place does nothing', () => {
  const { service, created } = fixture();
  service.configure({ enabled: true, place: null });
  service.configure({ enabled: true, place: { latitude: 'x', longitude: 2 } });
  assert.strictEqual(created.length, 0);
});

test('enabled with a place fetches once and reports the pose', async () => {
  const { service, created, poses } = fixture('wx_snow');
  service.configure({ enabled: true, place: { latitude: 39.04, longitude: -77.49 } });
  await tick();
  assert.deepStrictEqual(created, [{ latitude: 39.04, longitude: -77.49 }]);
  assert.deepStrictEqual(poses, ['wx_snow']);
  service.stop();
});

test('configuring the same place again does not restart or refetch', async () => {
  const { service, created } = fixture();
  service.configure({ enabled: true, place: { latitude: 1, longitude: 2 } });
  service.configure({ enabled: true, place: { latitude: 1, longitude: 2 } });
  assert.strictEqual(created.length, 1);
  service.configure({ enabled: true, place: { latitude: 3, longitude: 4 } });
  assert.strictEqual(created.length, 2);
  service.stop();
});

test('turning it off clears the pose and stops', async () => {
  const { service, poses } = fixture('wx_fog');
  service.configure({ enabled: true, place: { latitude: 1, longitude: 2 } });
  await tick();
  service.configure({ enabled: false, place: { latitude: 1, longitude: 2 } });
  assert.deepStrictEqual(poses, ['wx_fog', null]);
  assert.strictEqual(service.isRunning(), false);
});

test('a failing source is silent and keeps the last pose', async () => {
  const { service, poses, setThrowing } = fixture('wx_rain');
  service.configure({ enabled: true, place: { latitude: 1, longitude: 2 } });
  await tick();
  setThrowing(true);
  await assert.doesNotReject(service.refresh());
  assert.deepStrictEqual(poses, ['wx_rain']);
  service.stop();
});

test('repeated identical poses are reported once', async () => {
  const { service, poses } = fixture('wx_rain');
  service.configure({ enabled: true, place: { latitude: 1, longitude: 2 } });
  await tick();
  await service.refresh();
  await service.refresh();
  assert.deepStrictEqual(poses, ['wx_rain']);
  service.stop();
});

test('the polling timer is never faster than 15 minutes, even if asked', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls = [];
  const service = createWeatherService({
    refreshMs: 1000, // asking for 1 second
    onPose: () => {},
    createSource: () => ({ getPose: async () => { calls.push(1); return 'wx_rain'; } }),
  });
  service.configure({ enabled: true, place: { latitude: 1, longitude: 2 } });
  assert.strictEqual(calls.length, 1, 'one fetch on enable');
  t.mock.timers.tick(MIN_REFRESH_MS - 1);
  assert.strictEqual(calls.length, 1, 'no timer fetch before 15 minutes');
  t.mock.timers.tick(1);
  assert.strictEqual(calls.length, 2, 'next fetch at 15 minutes');
  service.stop();
});
