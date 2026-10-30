// Event layer: turns raw desktop signals into the signal objects rules.js expects.
// Pure and deterministic. No I/O, no timers, no clock of its own: every call carries
// its own timestamp, so tests can drive it with fake time.
//
// Feed it samples (about once a second) with ingest(), push external events with
// pushEvent(), and call read() when it is time to decide on a reaction.

const { EVENTS, TYPING, MUSIC, normalizeSignals } = require('../vendor/pet-brain/rules.js');
const { categorizeApp } = require('./appCategories');
const { EVENT_CONFIG } = require('./config');

// When several events are waiting, the first one in this list is read first.
const EVENT_PRIORITY = Object.freeze([
  'error_dialog', 'build_failed', 'build_passed', 'returned_from_idle', 'app_switched_often', 'long_session',
]);

function isTime(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * @param {{ config?: Partial<typeof EVENT_CONFIG> }} [options]
 */
function createEventLayer(options = {}) {
  const cfg = { ...EVENT_CONFIG, ...(options.config || {}) };

  let frontApp = '';
  let idleSec = 0;
  let music = 'none';
  let typingOverride = null;
  let hourOverride = null;
  let lastAt = null;

  const activity = [];       // { at, active } within the typing window
  const switches = [];       // timestamps of frontmost-app changes
  let wasAway = false;
  let sessionStartAt = null; // null while on a break
  let nextLongSessionAt = null;
  const pending = new Map(); // event name -> time it was queued

  function queue(name, at) {
    if (EVENTS.includes(name) && name !== 'none') pending.set(name, at);
  }

  function trim(list, key, from) {
    while (list.length && (key ? list[0][key] : list[0]) < from) list.shift();
  }

  /** Record one raw sample: { at, frontApp?, idleSec?, music?, typing?, hour? }. Never throws. */
  function ingest(sample) {
    if (!sample || !isTime(sample.at)) return;
    const at = sample.at;
    lastAt = at;

    if (isTime(sample.idleSec)) idleSec = Math.max(0, sample.idleSec);
    if (MUSIC.includes(sample.music)) music = sample.music;
    typingOverride = TYPING.includes(sample.typing) ? sample.typing : null;
    hourOverride = isTime(sample.hour) ? sample.hour : null;

    // Frontmost-app changes. An empty name means "unknown", not a change.
    if (typeof sample.frontApp === 'string' && sample.frontApp.trim()) {
      const name = sample.frontApp.trim();
      if (frontApp && name !== frontApp) {
        switches.push(at);
        trim(switches, null, at - cfg.switchWindowMs);
        if (switches.length >= cfg.switchCount) {
          queue('app_switched_often', at);
          switches.length = 0;
        }
      }
      frontApp = name;
    }

    // Input activity share, used as the typing pace.
    activity.push({ at, active: idleSec <= cfg.activeIdleS });
    trim(activity, 'at', at - cfg.typingWindowMs);

    // Coming back from being away.
    if (idleSec >= cfg.awayIdleS) wasAway = true;
    if (wasAway && idleSec < cfg.backIdleS) {
      queue('returned_from_idle', at);
      wasAway = false;
    }

    // Work session length. A long enough idle ends the session.
    if (idleSec >= cfg.breakIdleS) {
      sessionStartAt = null;
      nextLongSessionAt = null;
    } else if (sessionStartAt === null) {
      sessionStartAt = at;
      nextLongSessionAt = at + cfg.longSessionMs;
    } else if (at >= nextLongSessionAt) {
      queue('long_session', at);
      nextLongSessionAt = at + cfg.longSessionRepeatMs;
    }
  }

  /** Queue an event from outside the layer, for example a shell or editor hook. Unknown names are ignored. */
  function pushEvent(name, at) {
    if (isTime(at)) queue(name, at);
  }

  function typingAt(at) {
    if (typingOverride) return typingOverride;
    trim(activity, 'at', at - cfg.typingWindowMs);
    if (!activity.length) return 'none';
    const share = activity.filter((s) => s.active).length / activity.length;
    if (share >= cfg.typingFast) return 'fast';
    if (share >= cfg.typingSteady) return 'steady';
    if (share >= cfg.typingSlow) return 'slow';
    return 'none';
  }

  function takeEvent(at, consume) {
    for (const [name, queuedAt] of pending) {
      if (at - queuedAt > cfg.eventTtlMs) pending.delete(name);
    }
    for (const name of EVENT_PRIORITY) {
      if (pending.has(name)) {
        if (consume) pending.delete(name);
        return name;
      }
    }
    return 'none';
  }

  /**
   * Current signals in the shape rules.js expects. Reading consumes the event it reports,
   * so an event is reported once. Pass { consume: false } to look without consuming.
   */
  function read(at, { consume = true } = {}) {
    const now = isTime(at) ? at : (lastAt === null ? 0 : lastAt);
    const hour = hourOverride !== null ? hourOverride : new Date(now).getHours();
    return normalizeSignals({
      app_category: categorizeApp(frontApp),
      idle_s: idleSec,
      typing: typingAt(now),
      hour,
      music,
      event: takeEvent(now, consume),
    });
  }

  return { ingest, pushEvent, read };
}

module.exports = { createEventLayer, EVENT_PRIORITY };
