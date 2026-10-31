// The offline tests that came with the v2 sheet, run as part of the suite. They live in test/raincloudV2/
// with only their file paths changed (and test_weather.js exports its promise so a failure reaches
// this runner instead of exiting the process).

const test = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('v2 player and manifest (test_v2.mjs)', async () => {
  await import(pathToFileURL(path.join(__dirname, 'raincloudV2', 'test_v2.mjs')).href);
});

test('v2 weather poses and Open-Meteo handling (test_weather.js)', async () => {
  await require('./raincloudV2/test_weather.js');
});
