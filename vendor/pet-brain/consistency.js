'use strict';
// Does a line contradict its own signals? Word-level heuristic: it can miss things and can flag fair lines.
// Used as a runtime guard (petBrain.js), as a training-data filter, and in the evaluation.
const { normalizeSignals } = require('./rules.js');
const { duration_words: DURATION_WORDS } = require('./persona.json');

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** Returns a list of short reasons. An empty list means no contradiction was found. */
function signalMismatches(line, signals) {
  const s = normalizeSignals(signals);
  const text = ` ${String(line).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')} `;
  const has = (...words) => words.some((w) => text.includes(` ${w} `));
  const h = s.hour;
  const out = [];
  if (has('midnight') && !(h >= 22 || h <= 3)) out.push('midnight');
  if (has('night', 'tonight') && !(h >= 19 || h <= 5)) out.push('night');
  // "two in the morning" is natural for any hour before noon; dawn and sunrise need a tighter window
  if (has('morning') && h > 11) out.push('morning');
  if (has('sunrise', 'dawn', 'sunshine', 'breakfast') && !(h >= 4 && h <= 10)) out.push('dawn');
  if (has('afternoon') && !(h >= 12 && h <= 18)) out.push('afternoon');
  if (has('evening') && !(h >= 17 && h <= 23)) out.push('evening');
  if (has('lunch', 'lunchtime', 'noon', 'midday') && !(h >= 11 && h <= 14)) out.push('lunch');
  // clock times: "at one", "at 3"
  for (const m of text.matchAll(/ at (one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2}) /g)) {
    const n = NUMBER_WORDS[m[1]] || Number(m[1]);
    if (n >= 1 && n <= 12 && n !== (h % 12 || 12)) out.push(`clock:${m[1]}`);
  }
  // a duration claim ("a long pause") needs a reason in the signals
  if (has(...DURATION_WORDS) && s.idle_s < 300 && s.event !== 'long_session' && s.event !== 'returned_from_idle') out.push('duration');
  if (has('music', 'song', 'songs', 'tune', 'tunes', 'track', 'beat') && s.music === 'none' && s.app_category !== 'music') out.push('music');
  if (has('video', 'movie') && s.app_category !== 'video') out.push('video');
  if (has('game', 'gaming') && s.app_category !== 'game') out.push('game');
  if (has('chat', 'chatting') && s.app_category !== 'chat') out.push('chat');
  if (has('docs', 'reading') && s.app_category !== 'docs') out.push('docs');
  if (has('terminal') && s.app_category !== 'terminal') out.push('terminal');
  if (has('editor') && s.app_category !== 'code_editor') out.push('editor');
  if (has('browser', 'browsing') && s.app_category !== 'browser') out.push('browser');
  if (has('build') && !['build_passed', 'build_failed'].includes(s.event)) out.push('build');
  if (has('error') && s.event !== 'error_dialog') out.push('error');
  return out;
}

module.exports = { signalMismatches };
