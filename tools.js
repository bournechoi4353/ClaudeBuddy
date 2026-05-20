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
    const maxDim = 1280;
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
    thumbnailSize: { width: 1280, height: 800 },
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
    ],
  });
}

module.exports = {
  buildServer,
  allowedTools: [
    'mcp__clawd__now',
    'mcp__clawd__frontmost_window',
    'mcp__clawd__see_screen',
    'mcp__clawd__see_window',
    'mcp__clawd__spotify_status',
    'mcp__clawd__spotify_play_pause',
    'mcp__clawd__spotify_next',
    'mcp__clawd__spotify_previous',
    'mcp__clawd__spotify_play_uri',
    'mcp__clawd__spotify_play',
    'mcp__clawd__spotify_search',
  ],
};
