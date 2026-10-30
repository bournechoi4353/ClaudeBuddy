'use strict';
// weather.js: opt-in weather lookup that returns the name of a raincloud pose.
// Runs in the Electron main process or plain Node. Uses the global fetch (Node 18+, Electron 28+).
//
// Privacy: the only thing sent is latitude and longitude rounded to 2 decimals (about 1 km),
// and only after the user turns the feature on and picks a place. Keep the place on the device.
//
// Provider: Open-Meteo. Its free tier is for NON-COMMERCIAL use only, under CC-BY 4.0 (credit
// "Weather data by Open-Meteo.com"), with limits of 10,000 calls per day. A subscription or an
// ad-supported app counts as commercial there. Swap in another provider or a paid plan before
// charging for ClaudeBuddy. Read https://open-meteo.com/en/terms to confirm the current terms.

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const MIN_REFRESH_MS = 15 * 60 * 1000; // the provider updates "current" every 15 minutes

function round2(n) { return Math.round(n * 100) / 100; }

// Turn a place name into coordinates. Returns up to 5 candidates so the user can pick one.
async function geocode(name, fetchFn = fetch) {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=5&language=en&format=json`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`geocode failed: ${res.status}`);
  const body = await res.json();
  return (body.results || []).map((r) => ({
    label: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
    latitude: round2(r.latitude),
    longitude: round2(r.longitude),
  }));
}

// Pick a pose from current conditions. Order matters: the worst weather wins.
// code is the WMO weather code, tempC is Celsius, windKmh is km/h, isDay is 1 or 0.
function poseFor({ code, isDay, tempC, windKmh }) {
  if (code >= 95 && code <= 99) return 'wx_thunder';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'wx_snow';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'wx_rain';
  if (code >= 51 && code <= 57) return 'wx_drizzle';
  if (code === 45 || code === 48) return 'wx_fog';
  if (typeof tempC === 'number' && tempC <= 0) return 'wx_cold';
  if (typeof tempC === 'number' && tempC >= 32) return 'wx_hot';
  if (typeof windKmh === 'number' && windKmh >= 40) return 'wx_windy';
  if (code === 3) return 'wx_overcast';
  if (code === 1 || code === 2) return isDay ? 'wx_partly' : 'wx_clear_night';
  if (code === 0) return isDay ? 'wx_clear_day' : 'wx_clear_night';
  return null; // unknown code: let the caller fall back to the normal idle pose
}

// createWeatherSource({ latitude, longitude }) returns { getPose(), getLast() }.
// getPose() never throws. It returns the cached pose, refreshes at most every 15 minutes,
// backs off after a failure, and returns null when it has nothing, so the pet shows idle.
function createWeatherSource({ latitude, longitude, fetchFn = fetch, now = Date.now }) {
  let lastPose = null, lastAt = -Infinity, failures = 0, inflight = null;
  const url = `${FORECAST_URL}?latitude=${round2(latitude)}&longitude=${round2(longitude)}` +
    '&current=weather_code,is_day,temperature_2m,wind_speed_10m&timezone=auto';

  async function refresh() {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`weather failed: ${res.status}`);
    const cur = (await res.json()).current;
    if (!cur || typeof cur.weather_code !== 'number') throw new Error('unexpected weather response');
    lastPose = poseFor({
      code: cur.weather_code,
      isDay: cur.is_day,
      tempC: cur.temperature_2m,
      windKmh: cur.wind_speed_10m,
    });
    failures = 0;
  }

  return {
    async getPose() {
      const wait = failures ? Math.min(MIN_REFRESH_MS * 2 ** failures, 6 * 3600 * 1000) : MIN_REFRESH_MS;
      if (now() - lastAt >= wait) {
        lastAt = now();
        if (!inflight) {
          inflight = refresh().catch(() => { failures += 1; }).finally(() => { inflight = null; });
        }
        await inflight;
      }
      return lastPose;
    },
    getLast() { return lastPose; },
  };
}

module.exports = { geocode, poseFor, createWeatherSource, MIN_REFRESH_MS };
