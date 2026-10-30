// Main-process glue for the pet brain. Gathers the raw signals the app can provide
// (system idle time, frontmost app, music state), feeds them to the event layer, and
// asks the reaction layer once in a while whether a bubble is due.
//
// Only required when the pet brain is active (see pet/flag.js), so with the flag off
// none of this code is loaded.

const { createEventLayer } = require('./events');
const { createReactionLayer } = require('./reactions');
const { petBrainDebug } = require('./flag');
const { createPetBrain } = require('../vendor/pet-brain/petBrain.js');

const SAMPLE_MS = 1000;      // idle time and activity share
const MUSIC_MS = 20 * 1000;  // music state, so Spotify is not asked every second
const EVALUATE_MS = 5 * 1000; // how often to ask whether a bubble is due

// Outcomes where the pending event should stay queued and try again on the next evaluation.
const RETRY_REASONS = new Set(['startup-quiet', 'global-gap', 'fullscreen', 'busy', 'error']);

/**
 * @param {{
 *   platform: { isFrontmostFullscreen(): Promise<boolean>, getMusicState(): Promise<string> },
 *   powerMonitor: { getSystemIdleTime(): number },
 *   emit?: (channel: string, payload: object) => void,
 *   getPrefs?: () => object,
 *   now?: () => number,
 *   env?: object,
 *   createBrain?: () => object,
 * }} deps
 */
function createPetController(deps) {
  const { platform, powerMonitor, emit = () => {}, getPrefs = () => ({}), now = Date.now, env = process.env } = deps;
  const log = petBrainDebug(env) ? (message) => console.log(`[pet-brain] ${message}`) : () => {};

  const events = createEventLayer();
  const reactions = createReactionLayer({
    now,
    log,
    createBrain: deps.createBrain || (() => createPetBrain({})),
    isFullscreen: () => platform.isFrontmostFullscreen(),
    chattiness: getPrefs().petChattiness,
  });

  let frontApp = '';
  let music = 'none';
  let evaluating = false;
  let timers = [];

  function sample() {
    let idleSec = 0;
    try { idleSec = powerMonitor.getSystemIdleTime(); } catch (_) {}
    events.ingest({ at: now(), frontApp, idleSec, music });
  }

  async function refreshMusic() {
    try { music = await platform.getMusicState(); } catch (_) { music = 'none'; }
  }

  /** One evaluation: read the signals and show a bubble if the reaction layer allows it. */
  async function evaluate() {
    if (evaluating) return null;
    evaluating = true;
    try {
      const at = now();
      const signals = events.read(at, { consume: false });
      const decision = await reactions.consider(signals);
      if (!RETRY_REASONS.has(decision.reason)) events.read(at); // the event was dealt with: consume it
      if (decision.ok) {
        log(`signals ${JSON.stringify(signals)}`);
        emit('pet-brain-bubble', { reaction: decision.reaction, line: decision.line, source: decision.source });
      }
      return decision;
    } finally {
      evaluating = false;
    }
  }

  function start() {
    if (timers.length) return;
    refreshMusic();
    timers = [
      setInterval(sample, SAMPLE_MS),
      setInterval(refreshMusic, MUSIC_MS),
      setInterval(() => { evaluate().catch(() => {}); }, EVALUATE_MS),
    ];
    log('started');
  }

  function stop() {
    for (const t of timers) clearInterval(t);
    timers = [];
    log('stopped');
  }

  return {
    start,
    stop,
    sample,
    evaluate,
    /** Called by the existing frontmost-app poll in main.js. */
    noteFrontApp(name) { if (typeof name === 'string') frontApp = name; },
    /** For an external source, such as a shell or editor hook, to report build or error events. */
    pushEvent(name) { events.pushEvent(name, now()); },
    setChattiness: (level) => reactions.setChattiness(level),
    resetLineHistory: () => reactions.resetLineHistory(),
    resetTimers: () => reactions.resetTimers(),
    dispose() {
      stop();
      return reactions.dispose();
    },
  };
}

module.exports = { createPetController };
