// Phase 5/6: tools that give Clawd context about the user's machine.
// Built lazily because the SDK is ESM-only and has to be dynamic-imported.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { desktopCapturer, screen, BrowserWindow, systemPreferences, app: electronApp } = require('electron');
const { z } = require('zod');

// ---- Codex CLI delegation ----
// Common locations a Codex CLI install might land.
const CODEX_PATHS = [
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  (process.env.HOME || '') + '/.local/bin/codex',
  (process.env.HOME || '') + '/.codex/bin/codex',
  // Codex desktop app bundles the CLI inside its Resources directory.
  '/Applications/Codex.app/Contents/Resources/codex',
];
function findCodexBinary() {
  for (const p of CODEX_PATHS) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (_) {}
  }
  return null;
}

async function consultCodexHandler({ prompt, context }) {
  const codexPath = findCodexBinary();
  if (!codexPath) {
    return {
      content: [{
        type: 'text',
        text: "codex isn't installed on this machine. answer the question yourself using your own knowledge — don't mention codex to the user.",
      }],
      isError: true,
    };
  }
  const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;
  try {
    const result = await new Promise((resolve, reject) => {
      const proc = spawn(codexPath, ['exec', '--skip-git-repo-check', fullPrompt], {
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const killer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch (_) {}
      }, 60_000);
      proc.stdout.on('data', (d) => (out += d.toString()));
      proc.stderr.on('data', (d) => (err += d.toString()));
      proc.on('close', (code) => {
        clearTimeout(killer);
        if (code === 0) resolve(out);
        else reject(new Error(err.trim() || `codex exit ${code}`));
      });
      proc.on('error', (e) => {
        clearTimeout(killer);
        reject(e);
      });
    });
    // Strip ANSI escape sequences that may leak through despite NO_COLOR.
    const cleaned = result.replace(/\x1b\[[0-9;]*m/g, '').trim();
    return {
      content: [{
        type: 'text',
        text: cleaned || '(codex returned an empty response)',
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: 'codex error: ' + (err.message || err) + ' — answer from your own knowledge instead.' }],
      isError: true,
    };
  }
}

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

async function captureAllScreensPng() {
  assertScreenPermission();
  // Briefly hide every Clawd window so he doesn't appear in his own screenshots.
  const wins = BrowserWindow.getAllWindows();
  const snap = wins.map((w) => ({ w, prev: w.getOpacity() }));
  snap.forEach(({ w }) => w.setOpacity(0));
  await new Promise((r) => setTimeout(r, 80));

  try {
    // Capture every connected display. 1568 max on the long edge — Claude
    // vision's sweet spot.
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1568, height: 1568 },
    });
    if (!sources || sources.length === 0) throw new Error('no screen sources available');
    return sources.map((s) => ({ name: s.name || 'screen', png: s.thumbnail.toPNG() }));
  } finally {
    snap.forEach(({ w, prev }) => w.setOpacity(prev));
  }
}

async function seeScreenHandler() {
  try {
    const screens = await captureAllScreensPng();
    const content = [];
    if (screens.length > 1) {
      content.push({
        type: 'text',
        text: `The user has ${screens.length} displays. Here are all of them:`,
      });
    }
    screens.forEach((s, i) => {
      if (screens.length > 1) {
        content.push({ type: 'text', text: `--- ${s.name} (display ${i + 1} of ${screens.length}) ---` });
      }
      content.push({ type: 'image', data: s.png.toString('base64'), mimeType: 'image/png' });
    });
    return { content };
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

async function deleteCalendarEventHandler({ title, start }) {
  if (!title) {
    return { content: [{ type: 'text', text: 'need a title (substring is fine)' }], isError: true };
  }
  await ensureAppRunning('Calendar');
  const titleSafe = title.replace(/"/g, '\\"');

  // Optional ±30min window around a provided start time, so the user can say
  // "delete tomorrow's 3pm sync" without nuking the recurring series.
  let dateSetup = '';
  let dateConstraint = '';
  if (start) {
    const d = new Date(start);
    if (isNaN(d.getTime())) {
      return { content: [{ type: 'text', text: 'invalid start time — use ISO 8601 (e.g. 2026-05-28T15:00:00)' }], isError: true };
    }
    const before = new Date(d.getTime() - 30 * 60 * 1000);
    const after = new Date(d.getTime() + 30 * 60 * 1000);
    const setDate = (varName, dt) => `set ${varName} to current date
set year of ${varName} to ${dt.getFullYear()}
set month of ${varName} to ${dt.getMonth() + 1}
set day of ${varName} to ${dt.getDate()}
set hours of ${varName} to ${dt.getHours()}
set minutes of ${varName} to ${dt.getMinutes()}
set seconds of ${varName} to 0`;
    dateSetup = `${setDate('beforeDate', before)}\n${setDate('afterDate', after)}\n`;
    dateConstraint = ' and start date is greater than or equal to beforeDate and start date is less than or equal to afterDate';
  }

  const script = `${dateSetup}set deleteTarget to missing value
set matchCount to 0
set matchInfo to ""
tell application "Calendar"
repeat with cal in calendars
try
set evs to (every event of cal whose summary contains "${titleSafe}"${dateConstraint})
repeat with ev in evs
set matchCount to matchCount + 1
set matchInfo to matchInfo & (summary of ev as text) & " | " & ((start date of ev) as text) & " | " & (name of cal) & linefeed
if matchCount is 1 then
set deleteTarget to ev
end if
end repeat
end try
end repeat
if matchCount is 1 then
delete deleteTarget
return "DELETED|||" & matchInfo
end if
return "MULTI|||" & matchCount & "|||" & matchInfo
end tell`;
  try {
    const out = await osascriptRun(script);
    if (out.startsWith('DELETED|||')) {
      return { content: [{ type: 'text', text: 'deleted: ' + out.slice('DELETED|||'.length).trim() }] };
    }
    if (out.startsWith('MULTI|||')) {
      const rest = out.slice('MULTI|||'.length);
      const idx = rest.indexOf('|||');
      const nStr = rest.slice(0, idx);
      const info = rest.slice(idx + 3).trim();
      const n = parseInt(nStr, 10);
      if (n === 0) {
        return { content: [{ type: 'text', text: `no calendar events matched "${title}"` }] };
      }
      return {
        content: [{
          type: 'text',
          text: `${n} events match "${title}" — be more specific (add a start time or a longer title substring). matches:\n${info}`,
        }],
      };
    }
    return { content: [{ type: 'text', text: 'unexpected calendar response: ' + out }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'could not delete: ' + err.message + ' (Calendar permission may be needed)' }], isError: true };
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

// ---- Web search ----
// Uses DuckDuckGo's HTML endpoint (no API key, no rate limit) for the result
// list, then fetches the top pages' actual content so Clawd has real material
// to work from instead of just snippets.

function parseDuckDuckGoResults(html) {
  const results = [];
  const titleRe = /<a\s+[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a\s+[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const titles = [];
  const snippets = [];
  let m;
  while ((m = titleRe.exec(html)) !== null) titles.push({ url: m[1], title: m[2] });
  while ((m = snipRe.exec(html)) !== null) snippets.push(m[1]);
  for (let i = 0; i < titles.length; i++) {
    let url = titles[i].url;
    // DDG wraps result URLs in /l/?uddg=<encoded> — unwrap.
    if (url.includes('/l/?') && url.includes('uddg=')) {
      const u = url.match(/uddg=([^&]+)/);
      if (u) url = decodeURIComponent(u[1]);
    }
    if (url.startsWith('//')) url = 'https:' + url;
    const title = stripHtmlToText(titles[i].title).trim();
    const snippet = snippets[i] ? stripHtmlToText(snippets[i]).trim() : '';
    if (title && /^https?:\/\//.test(url)) results.push({ title, url, snippet });
  }
  return results;
}

async function webSearchHandler({ query }) {
  if (!query || !query.trim()) {
    return { content: [{ type: 'text', text: 'no query given' }], isError: true };
  }
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  let html;
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`search server ${res.status}`);
    html = await res.text();
  } catch (err) {
    return { content: [{ type: 'text', text: 'web search failed: ' + (err.message || err) }], isError: true };
  }

  const results = parseDuckDuckGoResults(html).slice(0, 5);
  if (results.length === 0) {
    return { content: [{ type: 'text', text: `no results for "${query}"` }] };
  }

  // Fetch the top 3 pages in parallel and pull readable text from each.
  const fetchPage = async (r) => {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(r.url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9' },
      });
      clearTimeout(to);
      if (!res.ok) return null;
      const pageHtml = await res.text();
      return stripHtmlToText(pageHtml).slice(0, 3000);
    } catch {
      return null;
    }
  };
  const fetched = await Promise.all(results.slice(0, 3).map(fetchPage));
  fetched.forEach((text, i) => {
    if (text && text.length > 100) results[i].content = text;
  });

  const formatted = results
    .map((r, i) => {
      let out = `[${i + 1}] ${r.title}\n    ${r.url}`;
      if (r.snippet) out += `\n    ${r.snippet}`;
      if (r.content) out += `\n\n    --- Page content ---\n    ${r.content.split('\n').slice(0, 40).join('\n    ')}`;
      return out;
    })
    .join('\n\n');

  return {
    content: [{ type: 'text', text: `Search results for "${query}":\n\n${formatted}` }],
  };
}

// ---- Google APIs via per-user OAuth (Gmail / Docs / Drive) ----
const googleAuth = require('./google-auth');

function persistGoogleRotatedRefresh(newRefresh) {
  try {
    const fresh = { ...getPrefs(), googleRefreshToken: newRefresh };
    const p = path.join(electronApp.getPath('userData'), 'prefs.json');
    fs.writeFileSync(p, JSON.stringify(fresh, null, 2));
    _cachedPrefs = fresh;
    _cachedPrefsAt = Date.now();
  } catch (_) {}
}

async function getGoogleToken() {
  const prefs = getPrefs();
  return googleAuth.getAccessToken(prefs.googleRefreshToken, persistGoogleRotatedRefresh);
}

function googleNotConnectedError() {
  return {
    content: [{ type: 'text', text: "google isn't connected. tell the user to click the clawd label in their menubar and pick 'Connect Google' — one-time login." }],
    isError: true,
  };
}

async function gmailRecentHandler({ count }) {
  if (!getPrefs().googleRefreshToken) return googleNotConnectedError();
  try {
    const token = await getGoogleToken();
    const n = Math.max(1, Math.min(20, count || 5));
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${n}&labelIds=INBOX`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!listRes.ok) throw new Error(`list ${listRes.status}`);
    const data = await listRes.json();
    const messages = data.messages || [];
    if (messages.length === 0) return { content: [{ type: 'text', text: 'inbox is empty' }] };

    const fetchOne = async (m) => {
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return null;
      const d = await r.json();
      const headers = (d.payload && d.payload.headers) || [];
      const get = (h) => (headers.find((x) => x.name === h) || {}).value || '';
      return { from: get('From'), subject: get('Subject'), date: get('Date'), snippet: d.snippet || '' };
    };
    const details = (await Promise.all(messages.map(fetchOne))).filter(Boolean);
    const out = details.map((m) => `---\nFrom: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\nSnippet: ${m.snippet}`).join('\n');
    return { content: [{ type: 'text', text: out }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'gmail error: ' + (err.message || err) }], isError: true };
  }
}

async function gmailSearchHandler({ query }) {
  if (!getPrefs().googleRefreshToken) return googleNotConnectedError();
  if (!query) return { content: [{ type: 'text', text: 'no search query' }], isError: true };
  try {
    const token = await getGoogleToken();
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=5`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!listRes.ok) throw new Error(`search ${listRes.status}`);
    const data = await listRes.json();
    const messages = data.messages || [];
    if (messages.length === 0) return { content: [{ type: 'text', text: `no gmail messages match "${query}"` }] };

    const fetchOne = async (m) => {
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return null;
      const d = await r.json();
      const headers = (d.payload && d.payload.headers) || [];
      const get = (h) => (headers.find((x) => x.name === h) || {}).value || '';
      return { from: get('From'), subject: get('Subject'), date: get('Date'), snippet: d.snippet || '' };
    };
    const details = (await Promise.all(messages.map(fetchOne))).filter(Boolean);
    const out = details.map((m) => `---\nFrom: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\nSnippet: ${m.snippet}`).join('\n');
    return { content: [{ type: 'text', text: out }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'gmail search error: ' + (err.message || err) }], isError: true };
  }
}

async function gmailSendHandler({ to, subject, body }) {
  if (!getPrefs().googleRefreshToken) return googleNotConnectedError();
  if (!to || !subject || !body) {
    return { content: [{ type: 'text', text: 'need to, subject, and body' }], isError: true };
  }
  try {
    const token = await getGoogleToken();
    const rfc822 = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      '',
      body,
    ].join('\r\n');
    const raw = Buffer.from(rfc822).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`send ${res.status}: ${t}`);
    }
    return { content: [{ type: 'text', text: `sent email to ${to}` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'gmail send error: ' + (err.message || err) }], isError: true };
  }
}

async function driveSearchHandler({ query }) {
  if (!getPrefs().googleRefreshToken) return googleNotConnectedError();
  if (!query) return { content: [{ type: 'text', text: 'no search query' }], isError: true };
  try {
    const token = await getGoogleToken();
    const q = `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`;
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=10&fields=files(id,name,mimeType,modifiedTime,webViewLink)`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`drive ${res.status}`);
    const data = await res.json();
    const files = data.files || [];
    if (files.length === 0) return { content: [{ type: 'text', text: `no drive files match "${query}"` }] };
    const out = files.map((f) => `${f.name} (${f.mimeType.replace('application/vnd.google-apps.', '')}) — ${f.id}\n  modified ${f.modifiedTime}\n  ${f.webViewLink}`).join('\n\n');
    return { content: [{ type: 'text', text: out }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'drive search error: ' + (err.message || err) }], isError: true };
  }
}

async function docsReadHandler({ documentId }) {
  if (!getPrefs().googleRefreshToken) return googleNotConnectedError();
  if (!documentId) return { content: [{ type: 'text', text: 'need a document id (use drive_search to find one)' }], isError: true };
  try {
    const token = await getGoogleToken();
    const res = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`docs ${res.status}`);
    const data = await res.json();
    // Walk the document's body content and concatenate text runs.
    const lines = [];
    const elements = (data.body && data.body.content) || [];
    for (const el of elements) {
      if (!el.paragraph) continue;
      const runs = el.paragraph.elements || [];
      const text = runs.map((r) => (r.textRun && r.textRun.content) || '').join('');
      lines.push(text);
    }
    const text = lines.join('').slice(0, 5000);
    return { content: [{ type: 'text', text: `Title: ${data.title || '(untitled)'}\n\n${text}` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'docs read error: ' + (err.message || err) }], isError: true };
  }
}

// ---- Mail (macOS Mail.app via AppleScript) — kept as a fallback ----
// Works for any account synced to Mail.app, including Gmail. User has to have
// added their account to System Settings → Internet Accounts at least once.

async function getRecentEmailsHandler({ count }) {
  await ensureAppRunning('Mail');
  const n = Math.max(1, Math.min(20, count || 5));
  const script = `tell application "Mail"
set output to ""
set theMessages to messages of inbox
set total to count of theMessages
set maxN to ${n}
if total < maxN then set maxN to total
repeat with i from 1 to maxN
set m to item i of theMessages
set output to output & "---" & linefeed
try
set output to output & "From: " & (sender of m) & linefeed
end try
try
set output to output & "Subject: " & (subject of m) & linefeed
end try
try
set output to output & "Date: " & ((date received of m) as text) & linefeed
end try
try
set snip to content of m as text
if (length of snip) > 250 then set snip to (text 1 thru 250 of snip)
set output to output & "Snippet: " & snip & linefeed
end try
end repeat
return output
end tell`;
  try {
    const out = await osascriptRun(script);
    return { content: [{ type: 'text', text: out || 'inbox is empty' }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: 'mail error: ' + err.message + ' (Mail.app may need full disk / contacts permission)' }],
      isError: true,
    };
  }
}

async function searchEmailsHandler({ query }) {
  if (!query || !query.trim()) {
    return { content: [{ type: 'text', text: 'no search query' }], isError: true };
  }
  await ensureAppRunning('Mail');
  const q = query.replace(/"/g, '\\"');
  const script = `tell application "Mail"
set output to ""
set hits to {}
try
set hits to (messages of inbox whose (subject contains "${q}") or (content contains "${q}"))
end try
set total to count of hits
set maxN to 5
if total < maxN then set maxN to total
repeat with i from 1 to maxN
set m to item i of hits
set output to output & "---" & linefeed
try
set output to output & "From: " & (sender of m) & linefeed
end try
try
set output to output & "Subject: " & (subject of m) & linefeed
end try
try
set output to output & "Date: " & ((date received of m) as text) & linefeed
end try
end repeat
return output
end tell`;
  try {
    const out = await osascriptRun(script);
    return { content: [{ type: 'text', text: out || `no emails matched "${query}"` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'mail search error: ' + err.message }], isError: true };
  }
}

async function sendEmailHandler({ to, subject, body }) {
  if (!to || !subject || !body) {
    return { content: [{ type: 'text', text: 'need to, subject, and body' }], isError: true };
  }
  await ensureAppRunning('Mail');
  const toSafe = to.replace(/"/g, '\\"');
  const subjSafe = subject.replace(/"/g, '\\"');
  const bodySafe = body.replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const script = `tell application "Mail"
set newMsg to make new outgoing message with properties {subject:"${subjSafe}", content:"${bodySafe}", visible:false}
tell newMsg
make new to recipient at end of to recipients with properties {address:"${toSafe}"}
end tell
send newMsg
end tell`;
  try {
    await osascriptRun(script);
    return { content: [{ type: 'text', text: `sent email to ${to}` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'could not send email: ' + err.message }], isError: true };
  }
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

async function listAllBrowserTabs(appName) {
  const script = appName === 'Safari'
    ? `tell application "Safari"
set output to ""
repeat with w in windows
try
repeat with t in tabs of w
set output to output & (URL of t) & "|||" & (name of t) & linefeed
end repeat
end try
end repeat
return output
end tell`
    : `tell application "Google Chrome"
set output to ""
repeat with w in windows
try
repeat with t in tabs of w
set output to output & (URL of t) & "|||" & (title of t) & linefeed
end repeat
end try
end repeat
return output
end tell`;
  const out = await osascriptRun(script);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf('|||');
      if (idx < 0) return { url: line, title: '' };
      return { url: line.slice(0, idx), title: line.slice(idx + 3) };
    });
}

async function readBrowserTabHandler({ query, browser }) {
  const which = (browser || '').toLowerCase();
  let appName = 'Google Chrome';
  if (which.includes('safari')) appName = 'Safari';
  await ensureAppRunning(appName);

  let tabs;
  try {
    tabs = await listAllBrowserTabs(appName);
  } catch (err) {
    return { content: [{ type: 'text', text: `${appName} has no open windows — open a tab first.` }], isError: true };
  }
  if (!tabs.length) {
    return { content: [{ type: 'text', text: `${appName} has no open tabs` }], isError: true };
  }

  // Pick the tab to read.
  let chosen;
  let preFetchedText = null; // populated if the deep search finds a content match
  if (query) {
    const q = query.toLowerCase();
    chosen =
      tabs.find((t) => t.title.toLowerCase().includes(q)) ||
      tabs.find((t) => t.url.toLowerCase().includes(q));

    // Content-search fallback: URL/title didn't match — try fetching each tab's
    // HTML in parallel and looking for the query inside the page body. Capped
    // at the first 15 tabs with a 4s timeout per tab so it doesn't hang.
    if (!chosen) {
      const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Clawd/0.1';
      const probeOne = async (tab) => {
        try {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 4000);
          const res = await fetch(tab.url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': ua } });
          clearTimeout(to);
          if (!res.ok) return null;
          const html = await res.text();
          const text = stripHtmlToText(html);
          if (text.toLowerCase().includes(q)) return { tab, text };
          return null;
        } catch {
          return null;
        }
      };
      const results = await Promise.all(tabs.slice(0, 15).map(probeOne));
      const hit = results.find((r) => r !== null);
      if (hit) {
        chosen = hit.tab;
        preFetchedText = hit.text;
      }
    }

    if (!chosen) {
      const list = tabs.slice(0, 15).map((t, i) => `  ${i + 1}. ${t.title || '(untitled)'} — ${t.url}`).join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `No ${appName} tab matched "${query}" by URL, title, or page content. Open tabs:\n${list}\n\nTry calling read_browser_tab with a different query, or ask the user to switch to the right tab.`,
          },
        ],
      };
    }
  } else {
    // No query — default to the active tab of front window.
    const activeScript = appName === 'Safari'
      ? `tell application "Safari" to return (URL of current tab of front window) & "|||" & (name of current tab of front window)`
      : `tell application "Google Chrome" to return (URL of active tab of front window) & "|||" & (title of active tab of front window)`;
    try {
      const out = await osascriptRun(activeScript);
      const idx = out.indexOf('|||');
      chosen = idx > -1 ? { url: out.slice(0, idx), title: out.slice(idx + 3) } : tabs[0];
    } catch {
      chosen = tabs[0];
    }
  }

  // If content search already pulled the text, use it directly.
  if (preFetchedText) {
    return {
      content: [
        {
          type: 'text',
          text: `URL: ${chosen.url}\nTitle: ${chosen.title || '(no title)'}\n\nContent:\n${preFetchedText.slice(0, 5000)}`,
        },
      ],
    };
  }

  // Fetch and extract.
  try {
    const res = await fetch(chosen.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Clawd/0.1' },
      redirect: 'follow',
    });
    if (!res.ok) {
      return {
        content: [
          {
            type: 'text',
            text: `URL: ${chosen.url}\nTitle: ${chosen.title || '(no title)'}\n\nServer returned ${res.status} — page is probably auth-protected; try see_window("${appName.toLowerCase()}") instead.`,
          },
        ],
      };
    }
    const html = await res.text();
    const text = stripHtmlToText(html).slice(0, 5000);
    if (text.length < 50) {
      return {
        content: [
          {
            type: 'text',
            text: `URL: ${chosen.url}\nTitle: ${chosen.title || '(no title)'}\n\nPage looks empty (likely a single-page app that renders via JavaScript). Use see_window("${appName.toLowerCase()}") instead.`,
          },
        ],
      };
    }
    return {
      content: [
        { type: 'text', text: `URL: ${chosen.url}\nTitle: ${chosen.title || '(no title)'}\n\nContent:\n${text}` },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Could not fetch ${chosen.url}: ${err.message}. Try see_window("${appName.toLowerCase()}") for a screenshot fallback.` }],
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
        'web_search',
        'Searches the web (via DuckDuckGo) for the query and ALSO fetches the actual content of the top 3 result pages so you have real material to work with — not just snippets. Use for "search X", "look up X", "what\'s the latest on X", "find out about X", or any time the user wants information beyond your training cutoff. Always synthesize across the page contents in your reply rather than dumping a list.',
        { query: z.string().describe('what to search for, in plain language. include dates, names, model numbers, etc. if relevant.') },
        webSearchHandler
      ),
      tool(
        'read_browser_tab',
        'Reads a tab of Google Chrome (or Safari) by fetching its page HTML and extracting clean text. PREFER this over see_window/see_screen whenever the user asks about a website, browser tab, "google", "the website", "the page", etc. Pass a `query` substring (e.g. "clawdbuddy", "github", "youtube") to find a specific tab across ALL windows — even tabs in background windows or other monitors. With no query, reads the active tab of the front window. Returns the list of all tabs if nothing matches the query so you can retry.',
        {
          query: z.string().optional().describe('substring of the target tab\'s title or URL — e.g. "clawdbuddy", "github". omit to read the active tab.'),
          browser: z.string().optional().describe('"chrome" (default) or "safari"'),
        },
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
        'delete_calendar_event',
        'Deletes a single event from macOS Calendar by title substring. Use when the user says "delete X from my calendar", "cancel my X meeting", "remove that event". SAFETY: if more than one event matches the title, the tool returns the list of matches and refuses to delete — relay the matches to the user and ask which one (then re-call with a more specific title or with the start time). Always pass `start` as ISO 8601 if the user gave a time, to disambiguate recurring events.',
        {
          title: z.string().describe('substring of the event title to delete'),
          start: z.string().optional().describe('optional ISO 8601 start datetime to narrow to a specific occurrence within ±30 minutes'),
        },
        deleteCalendarEventHandler
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
        'gmail_recent',
        "Returns the most recent emails from the user's Gmail inbox via the Gmail API. PREFER this over get_recent_emails when the user is on Gmail. Requires the user to have connected their Google account (menubar → Connect Google).",
        { count: z.number().optional().describe('how many recent emails (1-20, default 5)') },
        gmailRecentHandler
      ),
      tool(
        'gmail_search',
        "Searches Gmail using Gmail's native search query syntax (e.g. 'from:bob', 'subject:invoice', 'has:attachment'). PREFER this over search_emails.",
        { query: z.string().describe('Gmail search query — supports operators like from:, to:, subject:, has:attachment, after:YYYY/MM/DD') },
        gmailSearchHandler
      ),
      tool(
        'gmail_send',
        'Sends an email through the connected Gmail account. PREFER this over send_email when the user is on Gmail.',
        {
          to: z.string().describe('recipient email address'),
          subject: z.string().describe('subject line'),
          body: z.string().describe('email body'),
        },
        gmailSendHandler
      ),
      tool(
        'drive_search',
        'Searches the user\'s Google Drive for files by name substring. Returns id + name + type + view link + modified date for up to 10 files. Use to find a Doc/Sheet/Slide to read.',
        { query: z.string().describe('name substring to look for, e.g. "project plan", "invoice", "clawd"') },
        driveSearchHandler
      ),
      tool(
        'docs_read',
        'Reads the text content of a Google Doc by its document ID (use drive_search first to find IDs). Returns the title plus the body text.',
        { documentId: z.string().describe('Google Doc ID — looks like "1AbC2dEfG..." (from drive_search results or a Docs URL)') },
        docsReadHandler
      ),
      tool(
        'get_recent_emails',
        'Returns the most recent emails from the macOS Mail.app inbox. FALLBACK only — prefer gmail_recent when the user is on Gmail and Google is connected.',
        { count: z.number().optional().describe('how many recent emails (1-20, default 5)') },
        getRecentEmailsHandler
      ),
      tool(
        'search_emails',
        'Searches the macOS Mail.app inbox for emails whose subject or body contains the query. Use for "find email from <person>", "did i get an email about <thing>", "search emails for <topic>".',
        { query: z.string().describe('text to search for in subject or body') },
        searchEmailsHandler
      ),
      tool(
        'send_email',
        'Sends an email via macOS Mail.app from the user\'s default account. Use when the user says "email X about Y", "send an email to X".',
        {
          to: z.string().describe('recipient email address'),
          subject: z.string().describe('subject line'),
          body: z.string().describe('email body'),
        },
        sendEmailHandler
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
      tool(
        'consult_codex',
        'Delegates a code-heavy or programmer-tuned question to the OpenAI Codex CLI running locally as a subprocess. Codex is a code-specialized model — use it as a second opinion for: debugging code the user shared, low-level systems/kernel questions, regex authoring, SQL optimization, library API specifics, build errors, language gotchas, complex algorithms. NOT for: simple syntax, "what does this code do" explanations, general concepts (handle those yourself). Pass the user\'s question as `prompt`. If they shared code, pass it in `context` and reference it from the prompt. After the tool returns, rewrite the answer in your small-crab voice — 1 or 2 short sentences. Never paste the raw output. If the tool errors with "codex isn\'t installed", just answer the question yourself with your own knowledge and never mention codex to the user.',
        {
          prompt: z.string().describe('the question or task to send to Codex, in plain language'),
          context: z.string().optional().describe('optional extra context, e.g. code the user pasted, error output, file content'),
        },
        consultCodexHandler
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
    'mcp__clawd__web_search',
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
    'mcp__clawd__delete_calendar_event',
    'mcp__clawd__weather',
    'mcp__clawd__get_notes',
    'mcp__clawd__save_note',
    'mcp__clawd__gmail_recent',
    'mcp__clawd__gmail_search',
    'mcp__clawd__gmail_send',
    'mcp__clawd__drive_search',
    'mcp__clawd__docs_read',
    'mcp__clawd__get_recent_emails',
    'mcp__clawd__search_emails',
    'mcp__clawd__send_email',
    'mcp__clawd__start_timer',
    'mcp__clawd__list_timers',
    'mcp__clawd__cancel_timer',
    'mcp__clawd__consult_codex',
  ],
};
