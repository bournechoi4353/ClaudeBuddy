'use strict';
// Persona rules for the deadpan roommate. Same checks as scripts/deadpan.py in the training repo.
const persona = require('./persona.json');

const WORD_RE = /[A-Za-z0-9']+/g;

function wordCount(line) {
  return typeof line === 'string' ? (line.match(/\S+/g) || []).length : 0;
}

/** Problems with one line against the persona's per-line rules. An empty list means the line fits. */
function personaProblems(line) {
  if (typeof line !== 'string' || line.trim() === '') return ['empty line'];
  const out = [];
  const n = wordCount(line);
  if (n < persona.min_words) out.push(`${n} words (min ${persona.min_words})`);
  if (n > persona.max_words) out.push(`${n} words (max ${persona.max_words})`);
  if (!/[.!?]["')]?$/.test(line.trim())) out.push('no sentence-ending punctuation');
  if (/\b[A-Z]{3,}\b/.test(line)) out.push('all-caps word');
  const low = line.toLowerCase();
  for (const p of persona.pressure_phrases) if (low.includes(p)) out.push(`pressure: ${p}`);
  return out;
}

const RESTATE = new Set(Object.values(persona.restate_words).flat());

/** True if the line names a signal value (app, hour, idle, typing or music word, or any digit). */
function restatesSignal(line) {
  if (typeof line !== 'string') return false;
  if (/\d/.test(line)) return true;
  const words = (line.toLowerCase().replace(/o'clock/g, 'clock').match(WORD_RE) || []);
  return words.some((w) => RESTATE.has(w));
}

module.exports = { personaProblems, restatesSignal, wordCount };
