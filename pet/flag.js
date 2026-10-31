// The one place that decides whether the pet brain runs, and with it the raincloud sprite.
// It is ON by default. PET_BRAIN_LOCAL=0 in the environment closes the gate for that run, which
// brings back the original crab and leaves the rest of the app exactly as it was before the
// pet brain existed. Any other value, or none, leaves the gate open. Once the gate is open, the
// user can still switch the brain off in Preferences (prefs.petBrainEnabled === false).
//
// This file must stay free of requires so checking the flag never loads the brain.

/** True unless the environment closes the gate with PET_BRAIN_LOCAL=0. */
function petBrainGate(env = process.env) {
  return !(env && env.PET_BRAIN_LOCAL === '0');
}

/** True when the pet brain should run: the gate is open and the user has not turned it off. */
function petBrainActive(prefs, env = process.env) {
  if (!petBrainGate(env)) return false;
  return !(prefs && prefs.petBrainEnabled === false);
}

/** True when PET_BRAIN_DEBUG=1, which turns on console logging of reactions and the pose cycler in the tray. */
function petBrainDebug(env = process.env) {
  return !!env && env.PET_BRAIN_DEBUG === '1';
}

module.exports = { petBrainGate, petBrainActive, petBrainDebug };
