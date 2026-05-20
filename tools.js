// Phase 5/6: tools that give Clawd context about the user's machine.
// Built lazily because the SDK is ESM-only and has to be dynamic-imported.

const { spawn } = require('child_process');
const { desktopCapturer, screen, BrowserWindow } = require('electron');
const { z } = require('zod');

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

async function captureScreenPng() {
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
    if (!primary) throw new Error('no screen source available (check Screen Recording permission)');
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
    await osascriptRun(`tell application "Spotify"
activate
play track "${uri.replace(/"/g, '')}"
end tell`);
    return { content: [{ type: 'text', text: 'playing ' + uri }] };
  } catch (err) {
    return { content: [{ type: 'text', text: 'spotify error: ' + err.message }], isError: true };
  }
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
        'spotify_search',
        'Opens Spotify with a search results page for the given query. Use for "play <song>" requests — it cannot auto-play the result (that requires the Spotify Web API which is not configured), but it brings up the song in Spotify for the user to click.',
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
    'mcp__clawd__spotify_search',
  ],
};
