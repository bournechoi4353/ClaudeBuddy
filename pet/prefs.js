// Validation for the pet brain's own preferences. Pure, so main.js and the tests share it.
// Everything else in prefs.json keeps flowing through unchanged.

const { REACTION_CONFIG } = require('./config');

const CHATTINESS_LEVELS = Object.keys(REACTION_CONFIG.chattiness);

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * A place for the weather feature: { label, latitude, longitude }. Coordinates are rounded to
 * 2 decimals (about 1 km) so a precise location is never stored or sent. Returns null if invalid.
 */
function cleanPlace(place) {
  if (!place || typeof place !== 'object') return null;
  const { latitude, longitude } = place;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const label = typeof place.label === 'string' ? place.label.slice(0, 100) : '';
  return { label, latitude: round2(latitude), longitude: round2(longitude) };
}

/** Returns a copy of the updates with the pet brain keys checked. Bad values are dropped or coerced. */
function sanitizePetUpdates(updates) {
  if (!updates || typeof updates !== 'object') return updates;
  const out = { ...updates };
  if ('petBrainEnabled' in out) out.petBrainEnabled = out.petBrainEnabled === true;
  if ('petChattiness' in out && !CHATTINESS_LEVELS.includes(out.petChattiness)) delete out.petChattiness;
  if ('petWeatherEnabled' in out) out.petWeatherEnabled = out.petWeatherEnabled === true;
  if ('petWeatherPlace' in out) {
    if (out.petWeatherPlace === null) {
      out.petWeatherPlace = null; // clearing the place is allowed
    } else {
      const place = cleanPlace(out.petWeatherPlace);
      if (place) out.petWeatherPlace = place; else delete out.petWeatherPlace;
    }
  }
  return out;
}

module.exports = { sanitizePetUpdates, cleanPlace, CHATTINESS_LEVELS };
