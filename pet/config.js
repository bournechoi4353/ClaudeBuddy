// Every tunable number for the pet brain lives here, so behavior can be adjusted
// in one place. Times are in milliseconds unless the name says otherwise.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// ---- Event layer (pet/events.js) ----

const EVENT_CONFIG = Object.freeze({
  // Typing is approximated from how much of the recent time the system saw input
  // (keyboard or mouse). The app has no real keystroke signal and must not add one.
  activeIdleS: 1.5,          // a sample with idle at or below this counts as "input happening"
  typingWindowMs: 30 * 1000, // trailing window used for the activity share
  typingFast: 0.8,           // share of active samples for each bucket
  typingSteady: 0.45,
  typingSlow: 0.15,

  // returned_from_idle: idle reached awayIdleS, then input resumed.
  awayIdleS: 5 * 60,
  backIdleS: 3,

  // app_switched_often: this many frontmost-app changes inside the window.
  switchCount: 6,
  switchWindowMs: 60 * 1000,

  // long_session: continuous work with no break of breakIdleS or more.
  breakIdleS: 5 * 60,
  longSessionMs: 90 * MIN,
  longSessionRepeatMs: 90 * MIN,

  // A queued event that was never read is dropped after this long.
  eventTtlMs: 60 * 1000,
});

// ---- Reaction layer (pet/reactions.js) ----

const REACTION_CONFIG = Object.freeze({
  // No bubbles this soon after launch, so the pet does not ambush the user.
  startupQuietMs: 30 * 1000,
  // Minimum time between any two bubbles, whatever the reaction.
  globalMinGapMs: 2 * MIN,
  // Used for a reaction with no entry below.
  defaultCooldownMs: 30 * MIN,
  // Minimum time before the same reaction can show a bubble again.
  cooldownMs: Object.freeze({
    stuck: 5 * MIN,
    celebrate: 5 * MIN,
    error_spotted: 5 * MIN,
    welcome_back: 10 * MIN,
    new_song: 10 * MIN,
    fast_context_switching: 20 * MIN,
    short_idle: 20 * MIN,
    music_paused: 30 * MIN,
    reading_docs: 30 * MIN,
    fast_typing: 30 * MIN,
    focused: 45 * MIN,
    music_vibe: 45 * MIN,
    chat_chatter: 45 * MIN,
    game_time: 60 * MIN,
    video_watching: 60 * MIN,
    late_night: 60 * MIN,
    long_idle: 60 * MIN,
    break_suggestion: 60 * MIN,
    hydrate_nudge: 60 * MIN,
    deep_work_streak: 90 * MIN,
    greeting: 3 * HOUR,
    lunch_break: 3 * HOUR,
    goodnight: 4 * HOUR,
    morning_start: 6 * HOUR,
  }),
  // Chattiness multiplies every cooldown and the global gap. Higher means quieter.
  chattiness: Object.freeze({ low: 2, normal: 1, high: 0.5 }),
  defaultChattiness: 'normal',
});

// ---- Smart lines: the local model (pet/modelService.js) ----

const MODEL_CONFIG = Object.freeze({
  // Unload the model after this long without writing a line. It frees about 1.4 GB.
  idleUnloadMs: 10 * MIN,
  // petBrain gives the model this long to answer a line, then uses a built-in line instead.
  timeoutMs: 1500,
  // 'cpu' or 'metal'. macOS has no CPU-only prebuilt binary, so 'cpu' there means the Metal
  // binary with zero GPU layers. See docs/PET_BRAIN.md, "Smart lines".
  gpu: 'cpu',
  threads: 4,
  // After a failed load, wait this long before trying again.
  loadRetryMs: 5 * MIN,
  // Give up on a load that has not finished by now.
  startupTimeoutMs: 60 * 1000,
});

module.exports = { MIN, HOUR, EVENT_CONFIG, REACTION_CONFIG, MODEL_CONFIG };
