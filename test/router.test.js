const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { routeFor, ROUTES } = require('../pet/router');
const { createPetController } = require('../pet/controller');
const { createModelService } = require('../pet/modelService');
const { reactionFor } = require('../vendor/pet-brain/rules.js');
const { REACTION_CONFIG } = require('../pet/config');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('routing table: ambient is local, every user request and tool call is Claude', () => {
  assert.strictEqual(routeFor('ambient'), 'local');
  assert.strictEqual(routeFor('user_text'), 'claude');
  assert.strictEqual(routeFor('tool'), 'claude');
  assert.deepStrictEqual(Object.values(ROUTES).filter((r) => r === 'local').length, 1, 'exactly one route reaches the local model');
});

test('anything unknown routes to Claude, never to the local model', () => {
  for (const kind of ['', 'chat', 'gmail', 'docs', 'spotify', 'AMBIENT', ' ambient', 'ambient ', 'constructor', '__proto__', 'toString', 'hasOwnProperty', null, undefined, 7, {}, [], ['ambient']]) {
    assert.strictEqual(routeFor(kind), 'claude', String(kind));
  }
});

test('the Claude path never references the pet brain or the local model', () => {
  // agent.js is the typed-message path, tools.js holds every Gmail, Docs and Spotify tool.
  for (const file of ['agent.js', 'tools.js', 'google-auth.js', 'spotify-auth.js']) {
    const source = read(file);
    for (const pattern of [/pet\//, /pet-brain/i, /modelService/, /node-llama-cpp/, /petBrain/, /petController/]) {
      assert.ok(!pattern.test(source), `${file} mentions ${pattern}`);
    }
  }
});

test('the chat-send handler (typed messages) never touches the pet brain', () => {
  const main = read('main.js');
  const start = main.indexOf("ipcMain.on('chat-send'");
  const end = main.indexOf("ipcMain.on('chat-reset'");
  assert.ok(start > 0 && end > start, 'found the chat-send handler');
  const handler = main.slice(start, end);
  for (const pattern of [/petController/, /modelService/, /pet-brain/, /vendor/, /petBrain/]) {
    assert.ok(!pattern.test(handler), `chat-send mentions ${pattern}`);
  }
  assert.match(handler, /agent\.chat\(/, 'typed messages still go to Claude');
});

test('Claude is never used for ambient lines: the pet modules do not load the agent or the SDK', () => {
  for (const file of fs.readdirSync(path.join(root, 'pet'))) {
    const source = read(path.join('pet', file));
    assert.ok(!/require\([^)]*agent/.test(source), `pet/${file} requires the agent`);
    assert.ok(!/claude-agent-sdk|@anthropic-ai/.test(source), `pet/${file} references the SDK`);
  }
});

test('nothing the renderer can send reaches the model', () => {
  const channels = [...read('preload.js').matchAll(/ipcRenderer\.(?:send|invoke)\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(channels.length > 5);
  const petChannels = channels.filter((c) => c.startsWith('pet-brain:'));
  // These are the only pet brain requests the renderer can make. None of them takes text to answer.
  assert.deepStrictEqual(petChannels.sort(), [
    'pet-brain:geocode', 'pet-brain:model-status', 'pet-brain:pick-model', 'pet-brain:reset-lines',
  ]);
  assert.ok(!channels.some((c) => /generate|ambient|line|prompt|complete/i.test(c.replace('pet-brain:reset-lines', ''))), 'no channel asks for a generated line');
});

test('only the pet controller loads the model service', () => {
  const users = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git' || entry.name === 'test') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs)$/.test(entry.name) && /require\(['"][^'"]*modelService['"]\)/.test(fs.readFileSync(full, 'utf8'))) users.push(path.relative(root, full));
    }
  };
  walk(root);
  assert.deepStrictEqual(users.sort(), ['pet/controller.js']);
});

test('an ambient line asks the model; a user message in the same session never does', async () => {
  const asked = [];
  const model = {
    backend: { start: async () => true, generate: async (prompt) => { asked.push(prompt); return { text: '', stopReason: 'abort' }; }, dispose: async () => {} },
    takeFallbackReason: () => null,
    configure() {}, status: () => ({}), statusLine: () => '', dispose: async () => {},
  };
  const START = new Date(2026, 5, 1, 14, 0, 0).getTime();
  const clock = { t: START };
  const controller = createPetController({
    now: () => clock.t,
    env: {},
    modelService: model,
    platform: { isFrontmostFullscreen: async () => false, getMusicState: async () => 'none' },
    powerMonitor: { getSystemIdleTime: () => 30 },
    emit: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve)); // let the brain mark its backend ready

  // The Claude side: a typed message and a Gmail/Spotify tool call. These run through agent.js and
  // tools.js, which have no way to reach the controller or the model. Nothing here may add a call.
  const claudeSide = () => routeFor('user_text') === 'claude' && routeFor('tool') === 'claude';
  assert.ok(claudeSide());
  assert.strictEqual(asked.length, 0);

  clock.t += REACTION_CONFIG.startupQuietMs + 1000;
  controller.sample();
  await controller.evaluate(); // an ambient line
  assert.strictEqual(asked.length, 1, 'the ambient line asked the model');
  assert.match(asked[0], /^<\|im_start\|>system/, 'with the pet prompt, built only from coarse signals');
  assert.ok(!/gmail|spotify|docs|password|@/i.test(asked[0]));
  assert.ok(claudeSide());
  assert.strictEqual(asked.length, 1, 'user requests added no model calls');
  await controller.dispose();
});
