// Spotify OAuth 2.0 Authorization Code Flow with PKCE.
//
// Why PKCE: lets a desktop app authenticate users with just a client ID — no
// client secret in the source code. Each user authorizes their own Spotify
// account; their refresh token lives in prefs.json. Search/playback API calls
// then go against that user's own quota.
//
// Developer setup (one-time): create a Spotify app at
// developer.spotify.com/dashboard, set the redirect URI exactly to
// http://127.0.0.1:8888/callback, copy the Client ID into CLIENT_ID below.

const crypto = require('crypto');
const http = require('http');
const { shell } = require('electron');

const CLIENT_ID = 'a7cbeda6f646478fa39c1db56dc03a92'; // Clawd's Spotify app
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const REDIRECT_PORT = 8888;
// Scopes:
//   user-read-private             — minimum required to make the auth dialog show a clear line.
//   user-modify-playback-state    — lets us start playback via the Web API instead of AppleScript,
//                                   so Spotify doesn't surface its window.
//   user-read-playback-state      — lets us list devices and pick the desktop one.
const SCOPES = 'user-read-private user-modify-playback-state user-read-playback-state';

let accessToken = null;
let accessTokenExpires = 0;

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generatePKCE() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Clawd connected</title>
<style>body{font-family:-apple-system,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f0e6;color:#000}main{text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#444}</style>
</head><body><main><h1>clawd is connected to spotify</h1><p>you can close this tab.</p></main></body></html>`;

const ERROR_HTML = (msg) => `<!doctype html><html><head><meta charset="utf-8"><title>Clawd error</title>
<style>body{font-family:-apple-system,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f0e6}main{text-align:center}h1{font-size:22px;color:#a00;margin:0 0 8px}</style>
</head><body><main><h1>connection failed</h1><p>${msg}</p></main></body></html>`;

// Kicks off the OAuth flow. Resolves with { access_token, refresh_token, expires_in }.
function connect() {
  return new Promise((resolve, reject) => {
    const { verifier, challenge } = generatePKCE();
    const state = base64url(crypto.randomBytes(16));
    let timeoutHandle = null;
    let server = null;

    const finish = (err, result) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (server) {
        try { server.close(); } catch (_) {}
      }
      err ? reject(err) : resolve(result);
    };

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const errParam = url.searchParams.get('error');

      if (errParam) {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(ERROR_HTML(errParam));
        finish(new Error('user denied: ' + errParam));
        return;
      }
      if (!code || returnedState !== state) {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(ERROR_HTML('state mismatch'));
        finish(new Error('state mismatch'));
        return;
      }

      try {
        const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            code_verifier: verifier,
          }),
        });
        if (!tokenRes.ok) {
          const t = await tokenRes.text();
          throw new Error(`token exchange ${tokenRes.status}: ${t}`);
        }
        const tokens = await tokenRes.json();
        accessToken = tokens.access_token;
        accessTokenExpires = Date.now() + tokens.expires_in * 1000 - 60_000;
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(SUCCESS_HTML);
        finish(null, tokens);
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(ERROR_HTML(err.message));
        finish(err);
      }
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        finish(new Error(`port ${REDIRECT_PORT} already in use — close whatever is using it and try again`));
      } else {
        finish(err);
      }
    });

    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const authUrl = `https://accounts.spotify.com/authorize?${new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state,
        scope: SCOPES,
      })}`;
      shell.openExternal(authUrl);
    });

    timeoutHandle = setTimeout(() => finish(new Error('timed out waiting for Spotify login')), 5 * 60_000);
  });
}

async function refreshFromToken(refreshToken) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`token refresh ${res.status}: ${t}`);
  }
  return await res.json();
}

// Returns a valid access token. Refreshes via the stored refresh_token if needed.
// onRefresh is called with the new refresh_token if Spotify rotated it.
async function getAccessToken(refreshToken, onRefresh) {
  if (accessToken && Date.now() < accessTokenExpires) return accessToken;
  if (!refreshToken) throw new Error('not connected to Spotify — open the menubar and click Connect Spotify');
  const tokens = await refreshFromToken(refreshToken);
  accessToken = tokens.access_token;
  accessTokenExpires = Date.now() + tokens.expires_in * 1000 - 60_000;
  // Spotify sometimes returns a new refresh_token; persist it if so.
  if (tokens.refresh_token && tokens.refresh_token !== refreshToken && typeof onRefresh === 'function') {
    onRefresh(tokens.refresh_token);
  }
  return accessToken;
}

function clearCache() {
  accessToken = null;
  accessTokenExpires = 0;
}

module.exports = { connect, getAccessToken, clearCache, CLIENT_ID };
