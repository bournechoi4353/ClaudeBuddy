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

module.exports = { MIN, HOUR, EVENT_CONFIG };
