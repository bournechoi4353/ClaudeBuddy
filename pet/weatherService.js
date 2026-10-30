// Opt-in "Weather mood". Turns the user's chosen place into a raincloud weather pose
// and reports pose changes. Does nothing, and makes no network request, unless it has been
// configured with enabled: true and a place.
//
// What leaves the machine: only the place's latitude and longitude, rounded to 2 decimals
// (about 1 km), sent to Open-Meteo. No account, no identifier. Like any web request it
// shows the user's IP address to Open-Meteo. Choosing a city also sends the typed name to
// Open-Meteo's geocoder once, when the user presses Find in Preferences.
//
// LICENSING: Open-Meteo's free tier is for NON-COMMERCIAL use only (CC BY 4.0, with credit
// "Weather data by Open-Meteo.com"). Revisit the provider or buy a plan before any paid
// release of ClaudeBuddy. See https://open-meteo.com/en/terms.

const weather = require('../vendor/pet-brain/weather.js');

/**
 * @param {{
 *   onPose: (pose: string | null) => void,
 *   createSource?: typeof weather.createWeatherSource,
 *   refreshMs?: number,
 * }} options
 */
function createWeatherService({ onPose, createSource = weather.createWeatherSource, refreshMs = weather.MIN_REFRESH_MS }) {
  // Never poll faster than the provider's own update interval.
  const intervalMs = Math.max(refreshMs, weather.MIN_REFRESH_MS);

  let source = null;
  let placeKey = '';
  let timer = null;
  let lastPose = null;

  function report(pose) {
    if (pose !== lastPose) {
      lastPose = pose;
      onPose(pose);
    }
  }

  /** Fetch (or reuse the cached) pose. The source itself refuses to refresh more than every 15 minutes. */
  async function refresh() {
    if (!source) return;
    try {
      report(await source.getPose());
    } catch (_) {
      // Fail silently: keep whatever pose we had, or the normal idle pose.
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    source = null;
    placeKey = '';
    report(null);
  }

  /** Apply the user's settings: { enabled: boolean, place: { latitude, longitude } | null }. */
  function configure({ enabled, place } = {}) {
    const valid = place && Number.isFinite(place.latitude) && Number.isFinite(place.longitude);
    if (!enabled || !valid) {
      stop();
      return;
    }
    const key = `${place.latitude},${place.longitude}`;
    if (source && key === placeKey) return;
    stop();
    placeKey = key;
    source = createSource({ latitude: place.latitude, longitude: place.longitude });
    timer = setInterval(refresh, intervalMs);
    refresh();
  }

  return { configure, refresh, stop, isRunning: () => !!source };
}

module.exports = { createWeatherService };
