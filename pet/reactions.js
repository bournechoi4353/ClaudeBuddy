// Reaction layer: decides whether a set of signals should produce a bubble right now,
// and if so which line. Rules pick the reaction, the pet brain picks the line, and this
// module adds the manners: per-reaction cooldowns, a global gap between bubbles, a quiet
// period after launch, and silence while the user is in a full-screen app.
//
// Line choice (shuffle bag, never the same line twice in a row, even across a reshuffle)
// is done by the vendored pet brain, which shows each reaction's lines in shuffled cycles.
// This layer only calls it after every gate has passed, so a suppressed reaction never
// uses up a line.

const { reactionFor } = require('../vendor/pet-brain/rules.js');
const { REACTION_CONFIG } = require('./config');

/**
 * @param {{
 *   createBrain: () => { react(signals: object): Promise<{ reaction: string, line: string, source?: string }> },
 *   now?: () => number,
 *   config?: object,
 *   isFullscreen?: () => Promise<boolean> | boolean,
 *   chattiness?: 'low' | 'normal' | 'high',
 *   log?: (message: string) => void,
 * }} options
 */
function createReactionLayer(options) {
  const cfg = { ...REACTION_CONFIG, ...(options.config || {}) };
  const now = options.now || Date.now;
  const isFullscreen = options.isFullscreen || (() => false);
  const log = options.log || (() => {});
  const startedAt = now();

  let brain = options.createBrain();
  let chattiness = cfg.chattiness[options.chattiness] ? options.chattiness : cfg.defaultChattiness;
  const lastShownAt = new Map(); // reaction -> time of its last bubble
  let lastAnyAt = -Infinity;
  let inFlight = false;

  function scale() {
    return cfg.chattiness[chattiness];
  }

  function cooldownFor(reaction) {
    const base = Object.prototype.hasOwnProperty.call(cfg.cooldownMs, reaction)
      ? cfg.cooldownMs[reaction]
      : cfg.defaultCooldownMs;
    return base * scale();
  }

  // The evaluation loop runs every few seconds, so only log a block when it changes.
  let lastBlockLog = '';
  function blocked(reaction, reason) {
    const message = `blocked ${reaction}: ${reason}`;
    if (message !== lastBlockLog) log(message);
    lastBlockLog = message;
    return { ok: false, reaction, reason };
  }

  /**
   * Decide on a bubble for these signals. Resolves to
   *   { ok: true, reaction, line, source }          show this bubble
   *   { ok: false, reaction, reason }               stay quiet; reason is one of
   *     'startup-quiet', 'global-gap', 'cooldown', 'fullscreen', 'busy', 'error'
   * Never rejects.
   */
  async function consider(signals) {
    const reaction = reactionFor(signals);
    if (inFlight) return blocked(reaction, 'busy');

    const t = now();
    if (t - startedAt < cfg.startupQuietMs) return blocked(reaction, 'startup-quiet');
    if (t - lastAnyAt < cfg.globalMinGapMs * scale()) return blocked(reaction, 'global-gap');
    if (t - (lastShownAt.has(reaction) ? lastShownAt.get(reaction) : -Infinity) < cooldownFor(reaction)) {
      return blocked(reaction, 'cooldown');
    }

    inFlight = true;
    try {
      let fullscreen = false;
      try { fullscreen = !!(await isFullscreen()); } catch (_) { fullscreen = false; }
      if (fullscreen) return blocked(reaction, 'fullscreen');

      const result = await brain.react(signals);
      const shownAt = now();
      lastShownAt.set(reaction, shownAt);
      lastAnyAt = shownAt;
      lastBlockLog = '';
      log(`show ${result.reaction} (${result.source || 'canned'}): ${result.line}`);
      return { ok: true, reaction: result.reaction, line: result.line, source: result.source || 'canned' };
    } catch (err) {
      return blocked(reaction, 'error');
    } finally {
      inFlight = false;
    }
  }

  return {
    consider,
    /** low, normal or high. Unknown values are ignored. */
    setChattiness(level) {
      if (cfg.chattiness[level]) chattiness = level;
    },
    getChattiness: () => chattiness,
    /** Forget which lines were shown (starts every reaction's shuffle bag fresh). Cooldowns are kept. */
    resetLineHistory() {
      const old = brain;
      brain = options.createBrain();
      if (old && old.dispose) Promise.resolve(old.dispose()).catch(() => {});
    },
    /** Forget cooldowns and the global gap. Used by the debug cycler and tests. */
    resetTimers() {
      lastShownAt.clear();
      lastAnyAt = -Infinity;
    },
    dispose() {
      if (brain && brain.dispose) return Promise.resolve(brain.dispose()).catch(() => {});
      return Promise.resolve();
    },
  };
}

module.exports = { createReactionLayer };
