// The one place that decides whether the pet brain runs.
// PET_BRAIN_LOCAL=1 in the environment is the gate, and it is off by default. When it is not
// set, nothing under pet/ or vendor/ is required or started, so the app behaves as before.
// Once the gate is open, the user can still switch the brain off in Preferences
// (prefs.petBrainEnabled === false).
//
// This file must stay free of requires so checking the flag never loads the brain.

/** True when the environment gate is open. */
function petBrainGate(env = process.env) {
  return !!env && env.PET_BRAIN_LOCAL === '1';
}

/** True when the pet brain should run: the gate is open and the user has not turned it off. */
function petBrainActive(prefs, env = process.env) {
  if (!petBrainGate(env)) return false;
  return !(prefs && prefs.petBrainEnabled === false);
}

/** True when PET_BRAIN_DEBUG=1, which turns on console logging of reactions. */
function petBrainDebug(env = process.env) {
  return !!env && env.PET_BRAIN_DEBUG === '1';
}

module.exports = { petBrainGate, petBrainActive, petBrainDebug };
