'use strict';
// Deterministic reaction rules for the ClaudeBuddy pet brain.
// Signals in, reaction name out. Pure function, no I/O, never throws.
// Mirrors docs/LABELING.md and scripts/audit_labels.py in the training repo.

const REACTIONS = Object.freeze([
  'focused', 'stuck', 'celebrate', 'late_night', 'long_idle', 'welcome_back', 'new_song',
  'music_paused', 'fast_context_switching', 'error_spotted', 'break_suggestion', 'greeting',
  'goodnight', 'morning_start', 'deep_work_streak', 'music_vibe', 'game_time', 'video_watching',
  'chat_chatter', 'reading_docs', 'fast_typing', 'short_idle', 'hydrate_nudge', 'lunch_break',
]);

const APP_CATEGORIES = Object.freeze(['code_editor', 'browser', 'video', 'game', 'chat', 'docs', 'music', 'terminal', 'other']);
const TYPING = Object.freeze(['none', 'slow', 'steady', 'fast']);
const MUSIC = Object.freeze(['none', 'playing', 'paused']);
const EVENTS = Object.freeze(['none', 'build_failed', 'build_passed', 'app_switched_often', 'returned_from_idle', 'long_session', 'error_dialog']);

const FIXED_EVENT_REACTION = Object.freeze({
  error_dialog: 'error_spotted',
  build_failed: 'stuck',
  build_passed: 'celebrate',
  returned_from_idle: 'welcome_back',
  app_switched_often: 'fast_context_switching',
});

const CODING_APPS = Object.freeze(['code_editor', 'terminal', 'docs']);

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** Fill in defaults and clamp values. Never throws. */
function normalizeSignals(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const idle = Number.isFinite(s.idle_s) ? Math.min(3600, Math.max(0, Math.floor(s.idle_s))) : 0;
  const hour = Number.isFinite(s.hour) ? ((Math.floor(s.hour) % 24) + 24) % 24 : 12;
  return {
    app_category: pick(s.app_category, APP_CATEGORIES, 'other'),
    idle_s: idle,
    typing: pick(s.typing, TYPING, 'none'),
    hour,
    music: pick(s.music, MUSIC, 'none'),
    event: pick(s.event, EVENTS, 'none'),
  };
}

/** Choose the reaction for a set of signals. */
function reactionFor(signals) {
  const { app_category: app, idle_s: idle, typing, hour, music, event } = normalizeSignals(signals);

  if (Object.prototype.hasOwnProperty.call(FIXED_EVENT_REACTION, event)) {
    return FIXED_EVENT_REACTION[event];
  }
  if (event === 'long_session') {
    if ((typing === 'fast' || typing === 'steady') && CODING_APPS.includes(app)) return 'deep_work_streak';
    return hour >= 9 && hour <= 17 ? 'hydrate_nudge' : 'break_suggestion';
  }

  // event is "none" from here on
  const night = hour >= 22 || hour <= 4;
  if (hour <= 4 && idle < 300) return 'late_night';
  if (night && idle >= 600) return 'goodnight';
  if (idle >= 600) return 'long_idle';
  if (idle >= 60) return hour === 12 || hour === 13 ? 'lunch_break' : 'short_idle';

  // active (idle under 60 seconds)
  if (app === 'game') return 'game_time';
  if (app === 'video') return 'video_watching';
  if (app === 'chat') return 'chat_chatter';
  if (app === 'docs' && (typing === 'none' || typing === 'slow')) return 'reading_docs';
  if (app === 'music' && music === 'playing') return 'new_song';
  if (music === 'playing') return 'music_vibe';
  if (music === 'paused') return 'music_paused';
  if (typing === 'fast') return 'fast_typing';
  if ((typing === 'steady' || typing === 'slow') && CODING_APPS.includes(app)) return 'focused';
  if (hour >= 5 && hour <= 8) return 'morning_start';
  return 'greeting';
}

/** Plain-word part of day for an hour. Used in the line prompt so the model does not have to guess from a number. */
function dayPart(hour) {
  const h = normalizeSignals({ hour }).hour;
  if (h >= 5 && h <= 11) return 'morning';
  if (h === 12 || h === 13) return 'midday';
  if (h >= 14 && h <= 17) return 'afternoon';
  if (h >= 18 && h <= 21) return 'evening';
  return 'night';
}

module.exports = { reactionFor, normalizeSignals, dayPart, REACTIONS, APP_CATEGORIES, TYPING, MUSIC, EVENTS };
