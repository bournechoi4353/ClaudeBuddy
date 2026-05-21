// Phase 5/6: tools that give Clawd context about the user's machine.
// Built lazily because the SDK is ESM-only and has to be dynamic-imported.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { desktopCapturer, screen, BrowserWindow, systemPreferences, app: electronApp } = require('electron');
const { z } = require('zod');

function pickLocalSpotifyDevice(devices) {
  if (!devices || devices.length === 0) return null;
  // 1. Currently active Computer (most reliable signal it's the one playing audio here).
  const activeComputer = devices.find((d) => d.is_active && d.type === 'Computer');
  if (activeComputer) return activeComputer;
  // 2. Match by hostname — Spotify desktop names itself after macOS's computer name.
  const norm = (s) => (s || '').toLowerCase().replace(/[-_.]/g, ' ').replace(/\s+/g, ' ').trim().replace(/ local$/, '');
  const hn = norm(os.hostname());
  const byName = devices.find((d) => {
    if (d.type !== 'Computer') return false;
    const dn = norm(d.name);
    return dn && (dn === hn || dn.includes(hn) || hn.includes(dn));
  });
  if (byName) return byName;
  // 3. Any Computer device.
  const anyComputer = devices.find((d) => d.type === 'Computer');
  if (anyComputer) return anyComputer;
  // 4. Last resort — first device of any type.
  return devices[0];
}

// Re-read prefs every few seconds so the user can drop in Spotify credentials
// without restarting Clawd.
let _cachedPrefs = null;
let _cachedPrefsAt = 0;
function getPrefs() {
  if (_cachedPrefs && Date.now() - _cachedPrefsAt < 5000) return _cachedPrefs;
  try {
    const p = path.join(electronApp.getPath('userData'), 'prefs.json');
    _cachedPrefs = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    _cachedPrefs = {};
  }
  _cachedPrefsAt = Date.now();
  return _cachedPrefs;
}

function osascriptRun(script) {
  return new Promise((resolve, reject) => {
    const p = spawn('osascript', ['-e', script]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `osascript exit ${code}`));
    });
  });
}

async function isAppRunning(name) {
  try {
    const r = await osascriptRun(`tell application "System Events" to count (every process whose name is "${name}")`);
    return parseInt(r, 10) > 0;
  } catch {
    return false;
  }
}

// Robust app launcher: uses LaunchServices via `open -a` (more reliable than
// AppleScript's "tell application X to launch", which sometimes races),
// then polls until the app's process exists. Background flag `-g` keeps focus
// where it was.
async function ensureAppRunning(appName, maxWaitMs = 6000) {
  if (await isAppRunning(appName)) return true;
  await new Promise((resolve) => {
    const p = spawn('open', ['-a', appName, '-g']);
    p.on('close', () => resolve());
    p.on('error', () => resolve());
  });
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isAppRunning(appName)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function nowHandler() {
  const d = new Date();
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const text = `${days[d.getDay()]}, ${d.toLocaleString()}`;
  return { content: [{ type: 'text', text }] };
}

function assertScreenPermission() {
  if (process.platform !== 'darwin') return;
  if (!systemPreferences.getMediaAccessStatus) return;
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status !== 'granted') {
    throw new Error(
      `screen recording permission is "${status}". open System Settings → Privacy & Security → Screen Recording, enable Clawd, then fully quit & relaunch Clawd (a relaunch is required for macOS to honor the new permission).`
    );
  }
}

async function captureScreenPng() {
  assertScreenPermission();
  // Briefly hide Clawd so he doesn't appear in his own screenshot.
  const wins = BrowserWindow.getAllWindows();
  const mainWin = wins[0];
  const prevOpacity = mainWin ? mainWin.getOpacity() : 1;
  if (mainWin) mainWin.setOpacity(0);
  await new Promise((r) => setTimeout(r, 80));

  try {
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    // Claude vision is most effective at up to 1568px on the long edge; the
    // API downscales anything larger. Capturing at this size gives us much
    // sharper text (Chrome web content was illegible at 1280).
    const maxDim = 1568;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    const tw = Math.max(1, Math.floor(width * scale));
    const th = Math.max(1, Math.floor(height * scale));

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: tw, height: th },
    });
    const primary = sources[0];
    if (!primary) throw new Error('no screen source available');
    return primary.thumbnail.toPNG();
  } finally {
    if (mainWin) mainWin.setOpacity(prevOpacity);
  }
}

async function seeScreenHandler() {
  try {
    const png = await captureScreenPng();
    return {
      content: [
        {
          type: 'image',
          data: png.toString('base64'),
          mimeType: 'image/png',
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: 'could not capture screen: ' + err.message }],
      isError: true,
    };
  }
}

async function captureWindowByQuery(query) {
  assertScreenPermission();
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    // 1568 is the largest size Claude vision uses without internal downscale.
    // Earlier 1280 made browser text unreadable on Retina displays.
    thumbnailSize: { width: 1568, height: 1568 },
  });
  const q = (query || '').toLowerCase().trim();
  const match = sources.find((s) => s.name && s.name.toLowerCase().includes(q));
  if (!match) {
    const available = sources.map((s) => s.name).filter(Boolean);
    const err = new Error(`no window matched "${query}"`);
    err.available = available;
    throw err;
  }
  return match.thumbnail.toPNG();
}

async function seeWindowHandler({ query }) {
  try {
    const png = await captureWindowByQuery(query);
    return {
      content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }],
    };
  } catch (err) {
    const hint = err.available ? '\navailable windows: ' + err.available.join(' | ') : '';
    return {
      content: [{ type: 'text', text: (err.message || String(err)) + hint }],
      isError: true,
    };
  }
}

// ---- Spotify (macOS desktop app via AppleScript) ----

async function spotifyRunning() {
  try {
    const r = await osascriptRun(
      'tell application "System Events" to count (every process whose name is "Spotify")'
    );
    return parseInt(r, 10) > 0;
  } catch {
    return false;
  }
}

async function spotifyStatusHandler() {
  if (!(await spotifyRunning())) {
    return { content: [{ type: 'text', text: 'spotify is not open' }] };
  }
  try {
    const out = await osascriptRun(`tell application "Spotify"
set s to player state as text
set n to ""
set a to ""
try
  set n to name of current track
  set a to artist of current track
end try
return s & "|" & n & "|" & a
end tell`);
    const [state, name, artist] = out.split('|');
    const playing = name ? `"${name}"${artist ? ' by ' + artist : ''}` : '(nothing)';
    return { content: [{ type: 'text', text: `${state}: ${playing}` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'spotify error: ' + err.message }], isError: true };
  }
}

async function spotifyPlayPauseHandler() {
  try {
    await osascriptRun('tell application "Spotify" to playpause');
    return { content: [{ type: 'text', text: 'toggled' }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'spotify error: ' + err.message }], isError: true };
  }
}

async function spotifyNextHandler() {
  try {
    await osascriptRun('tell application "Spotify" to next track');
    return { content: [{ type: 'text', text: 'skipped' }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'spotify error: ' + err.message }], isError: true };
  }
}

async function spotifyPreviousHandler() {
  try {
    await osascriptRun('tell application "Spotify" to previous track');
    return { content: [{ type: 'text', text: 'went back' }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'spotify error: ' + err.message }], isError: true };
  }
}

async function spotifyPlayUriHandler({ uri }) {
  if (!/^spotify:(track|album|playlist|artist):/.test(uri)) {
    return {
      content: [{ type: 'text', text: 'invalid spotify uri — must look like spotify:track:abc123' }],
      isError: true,
    };
  }
  try {
    await osascriptRun(`if application "Spotify" is not running then
tell application "Spotify" to launch
set ready to false
repeat 50 times
try
tell application "Spotify" to get player state
set ready to true
exit repeat
end try
try
tell application "System Events" to set visible of process "Spotify" to false
end try
delay 0.1
end repeat
if not ready then error "spotify did not become responsive within 5 seconds"
end if
tell application "System Events" to set visible of process "Spotify" to false
tell application "Spotify" to play track "${uri.replace(/"/g, '')}"
tell application "System Events" to set visible of process "Spotify" to false`);
    return { content: [{ type: 'text', text: 'playing ' + uri }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'spotify error: ' + err.message }], isError: true };
  }
}

// ---- Spotify Web API via per-user OAuth (PKCE).
// User connects once through the menubar; refresh_token lives in prefs.json.

const spotifyAuth = require('./spotify-auth');

async function spotifyApiSearchTrack(query, token) {
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`spotify search failed (${res.status})`);
  const data = await res.json();
  return data.tracks && data.tracks.items && data.tracks.items[0];
}

async function spotifyGetDevices(token) {
  const res = await fetch('https://api.spotify.com/v1/me/player/devices', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new Error('NEEDS_RECONNECT');
  if (res.status === 403) throw new Error('NEEDS_RECONNECT_SCOPES');
  if (!res.ok) throw new Error(`devices ${res.status}`);
  const data = await res.json();
  return data.devices || [];
}

async function spotifyApiPlay(token, trackUri, deviceId, contextUri) {
  const qs = deviceId ? `?device_id=${deviceId}` : '';
  // Playing with `uris` makes Spotify stop after the track. Playing with a
  // `context_uri` (the album) + offset keeps the music going through the rest
  // of the album, and Spotify's Autoplay setting kicks in for singles.
  const body = contextUri
    ? { context_uri: contextUri, offset: { uri: trackUri }, position_ms: 0 }
    : { uris: [trackUri] };
  const res = await fetch(`https://api.spotify.com/v1/me/player/play${qs}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error('NEEDS_RECONNECT');
  if (res.status === 403) {
    const t = await res.text();
    if (/premium/i.test(t)) throw new Error('PREMIUM_REQUIRED');
    throw new Error('NEEDS_RECONNECT_SCOPES');
  }
  if (res.status === 404) throw new Error('NO_ACTIVE_DEVICE');
  if (!res.ok && res.status !== 204) {
    const t = await res.text();
    throw new Error(`play ${res.status}: ${t}`);
  }
}

// Cold-start helper: launch Spotify desktop without surfacing. Aggressively
// hides during startup, polls until it can answer AppleScript so we know the
// app is fully initialized (and therefore registered as a Spotify Connect
// device the Web API can target).
async function ensureSpotifyRunningHidden() {
  await osascriptRun(`if application "Spotify" is not running then
tell application "Spotify" to launch
set ready to false
repeat 50 times
try
tell application "Spotify" to get player state
set ready to true
exit repeat
end try
try
tell application "System Events" to set visible of process "Spotify" to false
end try
delay 0.1
end repeat
if not ready then error "spotify did not become responsive within 5 seconds"
end if
try
tell application "System Events" to set visible of process "Spotify" to false
end try`);
}

// AppleScript fallback for users without Premium / new scopes / network access.
// Captures whichever app the user was in, plays via Spotify desktop's AppleScript
// API, then restores focus to the original app — even if Spotify briefly grabs
// the foreground, the user gets snapped back to their work within milliseconds.
async function playViaAppleScript(uri) {
  // Every step is wrapped in try blocks so a failure in focus capture or
  // hiding never prevents the actual play command from running.
  return osascriptRun(`set frontProcName to ""
try
tell application "System Events" to set frontProcName to name of (first application process whose frontmost is true)
end try
if application "Spotify" is not running then
tell application "Spotify" to launch
set ready to false
repeat 50 times
try
tell application "Spotify" to get player state
set ready to true
exit repeat
end try
try
tell application "System Events" to set visible of process "Spotify" to false
end try
delay 0.1
end repeat
if not ready then error "spotify did not become responsive within 5 seconds"
end if
try
tell application "System Events" to set visible of process "Spotify" to false
end try
tell application "Spotify" to play track "${uri.replace(/"/g, '')}"
try
tell application "System Events" to set visible of process "Spotify" to false
end try
try
if frontProcName is not "" then
tell application "System Events" to set frontmost of process frontProcName to true
end if
end try`);
}

function persistRotatedRefreshToken(newRefresh) {
  try {
    const fresh = { ...getPrefs(), spotifyRefreshToken: newRefresh };
    const p = path.join(electronApp.getPath('userData'), 'prefs.json');
    fs.writeFileSync(p, JSON.stringify(fresh, null, 2));
    _cachedPrefs = fresh;
    _cachedPrefsAt = Date.now();
  } catch (_) {}
}

async function spotifyPlayHandler({ query }) {
  const prefs = getPrefs();
  const refreshToken = prefs.spotifyRefreshToken;
  if (!refreshToken) {
    return {
      content: [
        {
          type: 'text',
          text:
            "spotify isn't connected. tell the user to click the clawd label in their menubar and pick 'Connect Spotify' — one-time login, no setup.",
        },
      ],
      isError: true,
    };
  }
  // Step 1: search for the track. Search works for both Free and Premium accounts.
  let track;
  let token;
  try {
    token = await spotifyAuth.getAccessToken(refreshToken, persistRotatedRefreshToken);
    track = await spotifyApiSearchTrack(query, token);
  } catch (err) {
    return { content: [{ type: 'text', text: 'spotify search failed: ' + (err.message || err) }], isError: true };
  }
  if (!track) {
    return { content: [{ type: 'text', text: `no spotify results for "${query}"` }] };
  }

  // Step 2: try the Web API play first (zero window flash — Premium-only).
  let apiPlayed = false;
  try {
    await ensureSpotifyRunningHidden();
    let devices = await spotifyGetDevices(token);
    let device = pickLocalSpotifyDevice(devices);
    if (!device) {
      await new Promise((r) => setTimeout(r, 800));
      devices = await spotifyGetDevices(token);
      device = pickLocalSpotifyDevice(devices);
    }
    if (!device) throw new Error('no device after launch');
    const contextUri = track.album && track.album.uri;
    await spotifyApiPlay(token, track.uri, device.id, contextUri);
    apiPlayed = true;
  } catch (apiErr) {
    // Common reasons we fall through: PREMIUM_REQUIRED (Free account),
    // NEEDS_RECONNECT_SCOPES (user connected before we added playback scopes),
    // NEEDS_RECONNECT (token revoked), network issue. Try the AppleScript path
    // instead — works for everyone but the Spotify window may briefly flicker.
  }

  // Step 3: AppleScript fallback. Hides Spotify and restores focus to the user's
  // previous app, so even if Spotify surfaces, the user isn't yanked out of their work.
  if (!apiPlayed) {
    try {
      await playViaAppleScript(track.uri);
    } catch (err) {
      return { content: [{ type: 'text', text: 'spotify error: ' + (err.message || err) }], isError: true };
    }
  }

  const artists = (track.artists || []).map((a) => a.name).join(', ');
  return {
    content: [{ type: 'text', text: `playing "${track.name}"${artists ? ' by ' + artists : ''}` }],
  };
}

async function spotifySearchHandler({ query }) {
  const q = (query || '').replace(/"/g, '');
  if (!q) {
    return { content: [{ type: 'text', text: 'no search query given' }], isError: true };
  }
  try {
    await osascriptRun(`tell application "Spotify" to activate
open location "spotify:search:${q}"`);
    return {
      content: [
        {
          type: 'text',
          text: `opened spotify with search for "${q}". (clawd can play a specific track if given a spotify URI, but search→play requires the spotify web api which isn't wired up yet.)`,
        },
      ],
    };
  } catch (err) {
    return { content: [{ type: 'text', text: 'spotify error: ' + err.message }], isError: true };
  }
}

// ---- Calendar (macOS Calendar.app via AppleScript) ----

async function calendarHandler({ days }) {
  await ensureAppRunning('Calendar');
  const dayCount = Math.max(1, Math.min(7, days || 1));
  const script = `set output to ""
tell application "Calendar"
set startDate to current date
set endDate to startDate + (${dayCount} * 24 * 60 * 60)
repeat with cal in calendars
try
set evs to (every event of cal whose start date is greater than or equal to startDate and start date is less than or equal to endDate)
repeat with ev in evs
set output to output & (summary of ev as text) & " | " & ((start date of ev) as text) & " | " & (name of cal) & linefeed
end repeat
end try
end repeat
end tell
return output`;
  try {
    const out = await osascriptRun(script);
    if (!out.trim()) {
      return { content: [{ type: 'text', text: `no calendar events in the next ${dayCount} day(s)` }] };
    }
    return { content: [{ type: 'text', text: out }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'calendar error: ' + err.message + ' (Clawd may need Calendar permission)' }], isError: true };
  }
}

async function addCalendarEventHandler({ title, start, end, calendar, notes }) {
  if (!title || !start) {
    return { content: [{ type: 'text', text: 'need at least title and start time' }], isError: true };
  }
  const startDate = new Date(start);
  if (isNaN(startDate.getTime())) {
    return { content: [{ type: 'text', text: 'invalid start time — use ISO 8601 (e.g. 2026-05-21T15:00:00)' }], isError: true };
  }
  const endDate = end ? new Date(end) : new Date(startDate.getTime() + 60 * 60 * 1000);
  if (isNaN(endDate.getTime())) {
    return { content: [{ type: 'text', text: 'invalid end time' }], isError: true };
  }
  const titleSafe = title.replace(/"/g, '\\"');
  const notesSafe = (notes || '').replace(/"/g, '\\"');
  const calName = (calendar || '').replace(/"/g, '');
  const setDate = (varName, d) => `set ${varName} to current date
set year of ${varName} to ${d.getFullYear()}
set month of ${varName} to ${d.getMonth() + 1}
set day of ${varName} to ${d.getDate()}
set hours of ${varName} to ${d.getHours()}
set minutes of ${varName} to ${d.getMinutes()}
set seconds of ${varName} to 0`;
  const calSelector = calName ? `calendar "${calName}"` : 'calendar 1';
  await ensureAppRunning('Calendar');
  const script = `tell application "Calendar"
${setDate('startDate', startDate)}
${setDate('endDate', endDate)}
tell ${calSelector}
set newEvent to make new event with properties {summary:"${titleSafe}", start date:startDate, end date:endDate}
${notesSafe ? `set description of newEvent to "${notesSafe}"` : ''}
end tell
end tell`;
  try {
    await osascriptRun(script);
    return { content: [{ type: 'text', text: `added "${title}" on ${startDate.toLocaleString()}` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'could not add event: ' + err.message }], isError: true };
  }
}

// ---- Weather (Open-Meteo + ipapi.co — no API keys) ----

const WEATHER_CODES = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'foggy', 48: 'foggy',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow',
  77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'heavy showers',
  85: 'light snow showers', 86: 'snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
};

async function weatherHandler() {
  try {
    const locRes = await fetch('https://ipapi.co/json/', { headers: { 'User-Agent': 'Clawd/0.1' } });
    if (!locRes.ok) throw new Error(`location lookup ${locRes.status}`);
    const loc = await locRes.json();
    const { latitude, longitude, city } = loc;
    if (latitude == null || longitude == null) throw new Error('no location returned');

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    const wRes = await fetch(weatherUrl);
    if (!wRes.ok) throw new Error(`weather ${wRes.status}`);
    const data = await wRes.json();
    const c = data.current || {};
    const desc = WEATHER_CODES[c.weather_code] || 'unknown';
    const text = `${city || 'your area'}: ${Math.round(c.temperature_2m)}°F, ${desc}, wind ${Math.round(c.wind_speed_10m)} mph`;
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'weather error: ' + (err.message || err) }], isError: true };
  }
}

// ---- Notes (macOS Notes.app via AppleScript) ----

async function getNotesHandler({ limit }) {
  await ensureAppRunning('Notes');
  const n = Math.max(1, Math.min(20, limit || 5));
  const script = `set output to ""
tell application "Notes"
set theNotes to notes
set countNotes to count of theNotes
set maxN to ${n}
if countNotes < maxN then set maxN to countNotes
repeat with i from 1 to maxN
set theNote to item i of theNotes
set output to output & "---" & linefeed & (name of theNote) & linefeed & (plaintext of theNote) & linefeed
end repeat
end tell
return output`;
  try {
    const out = await osascriptRun(script);
    return { content: [{ type: 'text', text: out || 'no notes found' }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'notes error: ' + err.message + ' (Clawd may need Notes permission)' }], isError: true };
  }
}

async function saveNoteHandler({ title, body }) {
  if (!title || !body) {
    return { content: [{ type: 'text', text: 'need both title and body' }], isError: true };
  }
  const safeTitle = title.replace(/"/g, '\\"');
  const safeBody = body.replace(/"/g, '\\"').replace(/\n/g, '<br>');
  await ensureAppRunning('Notes');
  const script = `tell application "Notes"
make new note with properties {name:"${safeTitle}", body:"<h1>${safeTitle}</h1>${safeBody}"}
end tell`;
  try {
    await osascriptRun(script);
    return { content: [{ type: 'text', text: `saved note: "${title}"` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'note save error: ' + err.message }], isError: true };
  }
}

// ---- Timers (in-memory; main process holds the setTimeout) ----

const activeTimers = new Map(); // id -> { endsAt, label }
let timerIdCounter = 0;
let onTimerEnd = null; // set from main.js so we can send IPC

function setTimerEndCallback(cb) {
  onTimerEnd = cb;
}

async function startTimerHandler({ minutes, label }) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0 || m > 600) {
    return { content: [{ type: 'text', text: 'minutes must be between 0 and 600' }], isError: true };
  }
  const id = ++timerIdCounter;
  const ms = m * 60_000;
  const endsAt = Date.now() + ms;
  const labelStr = (label || `${m} minute`).toString();
  const handle = setTimeout(() => {
    activeTimers.delete(id);
    if (onTimerEnd) {
      try { onTimerEnd({ id, label: labelStr }); } catch (_) {}
    }
  }, ms);
  activeTimers.set(id, { endsAt, label: labelStr, handle });
  return { content: [{ type: 'text', text: `timer set for ${m} min ("${labelStr}"). i will hop when it's done.` }] };
}

async function listTimersHandler() {
  if (activeTimers.size === 0) {
    return { content: [{ type: 'text', text: 'no active timers' }] };
  }
  const now = Date.now();
  const lines = [];
  for (const [id, t] of activeTimers) {
    const remainSec = Math.max(0, Math.round((t.endsAt - now) / 1000));
    const mm = Math.floor(remainSec / 60);
    const ss = String(remainSec % 60).padStart(2, '0');
    lines.push(`#${id}: ${t.label} — ${mm}:${ss} remaining`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function cancelTimerHandler({ id }) {
  const target = id ? activeTimers.get(Number(id)) : null;
  if (!target && activeTimers.size === 1) {
    // No id given but there's exactly one — cancel it.
    const [onlyId, only] = activeTimers.entries().next().value;
    clearTimeout(only.handle);
    activeTimers.delete(onlyId);
    return { content: [{ type: 'text', text: `cancelled timer "${only.label}"` }] };
  }
  if (!target) {
    return { content: [{ type: 'text', text: 'no matching timer to cancel' }], isError: true };
  }
  clearTimeout(target.handle);
  activeTimers.delete(Number(id));
  return { content: [{ type: 'text', text: `cancelled timer "${target.label}"` }] };
}

// ---- Browser tab reader (Chrome / Safari) ----
// Bypasses screenshot OCR entirely: gets the active tab's URL via AppleScript,
// fetches the page directly, strips HTML to readable text. Much more reliable
// than reading pixels for web content.

function stripHtmlToText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|p|div|li|tr|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readBrowserTabHandler({ browser }) {
  const which = (browser || '').toLowerCase();
  let appName = 'Google Chrome';
  if (which.includes('safari')) appName = 'Safari';
  await ensureAppRunning(appName);

  let getTabScript;
  if (appName === 'Safari') {
    getTabScript = `tell application "Safari"
return (URL of current tab of front window) & "|||" & (name of current tab of front window)
end tell`;
  } else {
    getTabScript = `tell application "Google Chrome"
return (URL of active tab of front window) & "|||" & (title of active tab of front window)
end tell`;
  }

  let url, title;
  try {
    const out = await osascriptRun(getTabScript);
    [url, title] = out.split('|||');
  } catch (err) {
    return { content: [{ type: 'text', text: `${appName} has no open windows — open a tab first.` }], isError: true };
  }
  if (!url) return { content: [{ type: 'text', text: 'no active tab found' }], isError: true };

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Clawd/0.1' },
      redirect: 'follow',
    });
    if (!res.ok) {
      return {
        content: [{ type: 'text', text: `URL: ${url}\nTitle: ${title || '(no title)'}\n\nServer returned ${res.status} — page is probably auth-protected; try see_window("${appName.toLowerCase()}") instead.` }],
      };
    }
    const html = await res.text();
    const text = stripHtmlToText(html).slice(0, 5000);
    if (text.length < 50) {
      return {
        content: [{ type: 'text', text: `URL: ${url}\nTitle: ${title || '(no title)'}\n\nPage looks empty (likely a single-page app that renders content via JavaScript). Use see_window("${appName.toLowerCase()}") instead.` }],
      };
    }
    return {
      content: [{ type: 'text', text: `URL: ${url}\nTitle: ${title || '(no title)'}\n\nContent:\n${text}` }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Could not fetch ${url}: ${err.message}. Try see_window("${appName.toLowerCase()}") for a screenshot fallback.` }],
      isError: true,
    };
  }
}

async function frontmostHandler() {
  try {
    const script = `tell application "System Events"
set frontApp to name of first application process whose frontmost is true
try
tell process frontApp
set frontWindow to name of front window
end tell
on error
set frontWindow to ""
end try
return frontApp & "::" & frontWindow
end tell`;
    const out = await osascriptRun(script);
    const [appName, windowTitle] = out.split('::');
    const titlePart = windowTitle ? ` (${windowTitle})` : '';
    return { content: [{ type: 'text', text: `${appName}${titlePart}` }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: 'could not read frontmost window: ' + err.message }],
      isError: true,
    };
  }
}

async function buildServer(sdk) {
  const { tool, createSdkMcpServer } = sdk;
  return createSdkMcpServer({
    name: 'clawd',
    version: '0.1.0',
    tools: [
      tool(
        'now',
        'Returns the current local date, time, and day of week. Call when the user asks about time, day, or how late it is.',
        {},
        nowHandler
      ),
      tool(
        'frontmost_window',
        'Returns the macOS app currently in the foreground and its window title (if accessibility permission allows). Call when the user asks "what app is open" or "what window am i in" — a lightweight peek that does not capture pixels.',
        {},
        frontmostHandler
      ),
      tool(
        'see_screen',
        'Captures a screenshot of WHATEVER IS VISIBLE on the screen right now (the front-facing layer) and returns it as an image. Use for "describe / read / analyze what i see", or when the user has not specified a particular app and is asking about whatever is in front.',
        {},
        seeScreenHandler
      ),
      tool(
        'see_window',
        'Captures a specific application window by a substring of its title or app name, EVEN IF that window is behind other windows. Use when the user names a particular app or page ("read my chrome tab", "what is on my slack", "look at the youtube window", "see google"). Pass the shortest identifying substring you can.',
        { query: z.string().describe('substring of the window title or app name, e.g. "chrome", "youtube", "slack", "google"') },
        seeWindowHandler
      ),
      tool(
        'read_browser_tab',
        'Reads the active tab of Google Chrome (or Safari) by fetching the actual page HTML and extracting clean text. Far more accurate than reading screenshots for web content. PREFER this over see_window/see_screen whenever the user asks about a website, browser tab, "google", "the website", "the page", etc. Falls back gracefully if the page is empty (SPA) or auth-protected.',
        { browser: z.string().optional().describe('"chrome" (default) or "safari"') },
        readBrowserTabHandler
      ),
      tool(
        'spotify_status',
        'Returns whether Spotify is open and what is currently playing (track, artist, playback state).',
        {},
        spotifyStatusHandler
      ),
      tool(
        'spotify_play_pause',
        'Toggles Spotify play/pause. Use for "pause my music", "resume", "play" with no song specified.',
        {},
        spotifyPlayPauseHandler
      ),
      tool(
        'spotify_next',
        'Skips to the next Spotify track. Use for "next song", "skip".',
        {},
        spotifyNextHandler
      ),
      tool(
        'spotify_previous',
        'Goes back to the previous Spotify track. Use for "previous", "go back a song".',
        {},
        spotifyPreviousHandler
      ),
      tool(
        'spotify_play_uri',
        'Plays a specific Spotify track/album/playlist by URI (spotify:track:..., spotify:album:..., etc.). Only call if the user gives you an actual URI.',
        { uri: z.string().describe('a spotify URI like spotify:track:6rqhFgbbKwnb9MLmUQDhG6') },
        spotifyPlayUriHandler
      ),
      tool(
        'spotify_play',
        'Searches Spotify and IMMEDIATELY PLAYS the first matching track. Use this for any "play X" request when the user names a song or artist. Requires Spotify API credentials in prefs.json; if missing, the tool returns an error explaining how to set them up and the user can fall back to spotify_search.',
        { query: z.string().describe('song name, artist, or "song by artist"') },
        spotifyPlayHandler
      ),
      tool(
        'spotify_search',
        'Opens Spotify with a search results page for the given query without playing anything. Use only if spotify_play failed because credentials are missing.',
        { query: z.string().describe('a song, artist, or album name to search for') },
        spotifySearchHandler
      ),
      tool(
        'calendar_events',
        'Returns upcoming events from the user\'s macOS Calendar. Use for "what\'s my next meeting", "what\'s on my calendar today", "any events this week".',
        { days: z.number().optional().describe('how many days ahead to look (1-7, default 1)') },
        calendarHandler
      ),
      tool(
        'add_calendar_event',
        'Creates a new event in macOS Calendar. Use when the user says "add to calendar", "schedule a meeting", "remind me on...". Convert relative times like "tomorrow 3pm" or "next monday" into ISO 8601 yourself, using the current time as reference. If end is omitted, defaults to 1 hour after start.',
        {
          title: z.string().describe('event title'),
          start: z.string().describe('ISO 8601 start datetime, e.g. "2026-05-21T15:00:00"'),
          end: z.string().optional().describe('ISO 8601 end datetime; defaults to 1 hour after start'),
          calendar: z.string().optional().describe('calendar name; defaults to the user\'s first calendar'),
          notes: z.string().optional().describe('event description / notes'),
        },
        addCalendarEventHandler
      ),
      tool(
        'weather',
        'Current weather at the user\'s location. Uses IP-based geolocation. Use for "do i need a jacket", "is it raining", "how hot is it outside".',
        {},
        weatherHandler
      ),
      tool(
        'get_notes',
        'Reads the most recent notes from macOS Notes.app. Returns title + body of each. Use when the user asks "what did I write down", "read my notes", "what was my last note".',
        { limit: z.number().optional().describe('how many recent notes to return (1-20, default 5)') },
        getNotesHandler
      ),
      tool(
        'save_note',
        'Creates a new note in macOS Notes.app with the given title and body. Use when the user says "save this", "remember this", "make a note that...".',
        {
          title: z.string().describe('short note title'),
          body: z.string().describe('note contents'),
        },
        saveNoteHandler
      ),
      tool(
        'start_timer',
        'Starts a countdown timer. When it ends, Clawd visibly reacts (hops, shows a thought bubble). Use for "set a 25 minute timer", "pomodoro", "remind me in 10 minutes".',
        {
          minutes: z.number().describe('timer duration in minutes (must be > 0, max 600)'),
          label: z.string().optional().describe('what the timer is for, e.g. "focus" or "tea"'),
        },
        startTimerHandler
      ),
      tool(
        'list_timers',
        'Lists currently running timers with their remaining time. Use for "what timers do I have", "how long left".',
        {},
        listTimersHandler
      ),
      tool(
        'cancel_timer',
        'Cancels a running timer by its ID. If only one timer is active, omitting id cancels it.',
        { id: z.number().optional().describe('timer id from list_timers; omit if only one is running') },
        cancelTimerHandler
      ),
    ],
  });
}

module.exports = {
  buildServer,
  setTimerEndCallback,
  allowedTools: [
    'mcp__clawd__now',
    'mcp__clawd__frontmost_window',
    'mcp__clawd__see_screen',
    'mcp__clawd__see_window',
    'mcp__clawd__read_browser_tab',
    'mcp__clawd__spotify_status',
    'mcp__clawd__spotify_play_pause',
    'mcp__clawd__spotify_next',
    'mcp__clawd__spotify_previous',
    'mcp__clawd__spotify_play_uri',
    'mcp__clawd__spotify_play',
    'mcp__clawd__spotify_search',
    'mcp__clawd__calendar_events',
    'mcp__clawd__add_calendar_event',
    'mcp__clawd__weather',
    'mcp__clawd__get_notes',
    'mcp__clawd__save_note',
    'mcp__clawd__start_timer',
    'mcp__clawd__list_timers',
    'mcp__clawd__cancel_timer',
  ],
};
