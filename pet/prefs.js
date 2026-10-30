// Validation for the pet brain's own preferences. Pure, so main.js and the tests share it.
// Everything else in prefs.json keeps flowing through unchanged.

const { REACTION_CONFIG } = require('./config');

const CHATTINESS_LEVELS = Object.keys(REACTION_CONFIG.chattiness);

/** Returns a copy of the updates with the pet brain keys checked. Bad values are dropped or coerced. */
function sanitizePetUpdates(updates) {
  if (!updates || typeof updates !== 'object') return updates;
  const out = { ...updates };
  if ('petBrainEnabled' in out) out.petBrainEnabled = out.petBrainEnabled === true;
  if ('petChattiness' in out && !CHATTINESS_LEVELS.includes(out.petChattiness)) delete out.petChattiness;
  return out;
}

module.exports = { sanitizePetUpdates, CHATTINESS_LEVELS };
