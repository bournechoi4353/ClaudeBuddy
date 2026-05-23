// Google OAuth 2.0 Authorization Code Flow with PKCE.
//
// Same pattern as spotify-auth.js. Each user authorizes their own Google
// account; their refresh token lives in prefs.json. Gmail/Docs/Drive API
// calls go against that user's own quota.
//
// Developer setup (one-time):
//   1. https://console.cloud.google.com → create project "Clawd"
//   2. Enable APIs: Gmail API, Google Docs API, Google Drive API
//   3. OAuth consent screen → External → Testing mode → add yourself as a
//      Test User; add scopes (gmail.modify, documents.readonly, drive.readonly).
//   4. Credentials → Create Credentials → OAuth client ID → type "Desktop".
//   5. Under Authorized redirect URIs add:  http://127.0.0.1:8889/google-callback
//   6. Copy the Client ID into the CLIENT_ID constant below.

const crypto = require('crypto');
const http = require('http');
const { shell } = require('electron');

// Replace this with the client ID from your Google Cloud OAuth credentials.
// Format: <numbers>-<hash>.apps.googleusercontent.com
const CLIENT_ID = '292383281461-7ef4tmkbb7h5ci8daf2mamaela3iq2dp.apps.googleusercontent.com';
// Desktop OAuth clients in Google Cloud require client_secret on the token
// exchange even with PKCE. Lazy-loaded so a missing google-secrets.js file
// only breaks Google features, not the whole app.
function loadClientSecret() {
  try {
    const v = require('./google-secrets').CLIENT_SECRET;
    if (!v || v === 'PASTE_YOUR_GOOGLE_CLIENT_SECRET_HERE') return null;
    return v;
  } catch (_) {
    return null;
  }
}
const CLIENT_SECRET = loadClientSecret();
const REDIRECT_PORT = 8889;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/google-callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',          // read + send Gmail
  'https://www.googleapis.com/auth/documents.readonly',    // read Google Docs
  'https://www.googleapis.com/auth/drive.readonly',         // list/read Drive files
].join(' ');

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
</head><body><main><h1>clawd is connected to google</h1><p>you can close this tab.</p></main></body></html>`;

const ERROR_HTML = (msg) => `<!doctype html><html><head><meta charset="utf-8"><title>Clawd error</title>
<style>body{font-family:-apple-system,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f0e6}main{text-align:center}h1{font-size:22px;color:#a00;margin:0 0 8px}</style>
</head><body><main><h1>connection failed</h1><p>${msg}</p></main></body></html>`;

function connect() {
  return new Promise((resolve, reject) => {
    if (!CLIENT_ID || CLIENT_ID.startsWith('YOUR_')) {
      reject(new Error("Google OAuth client ID isn't configured yet. The Clawd developer needs to set up a Google Cloud OAuth credential. See README → Google setup."));
      return;
    }
    if (!CLIENT_SECRET) {
      reject(new Error("Google OAuth client secret is missing (google-secrets.js not present or unfilled). If you installed via the curl one-liner, the maintainer hasn't shipped a secret in their repo — you'll need to fork Clawd and add your own."));
      return;
    }

    const { verifier, challenge } = generatePKCE();
    const state = base64url(crypto.randomBytes(16));
    let timeoutHandle = null;
    let server = null;

    const finish = (err, result) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (server) { try { server.close(); } catch (_) {} }
      err ? reject(err) : resolve(result);
    };

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
      if (url.pathname !== '/google-callback') {
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
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
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
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state,
        access_type: 'offline',
        prompt: 'consent',
      })}`;
      shell.openExternal(authUrl);
    });

    timeoutHandle = setTimeout(() => finish(new Error('timed out waiting for Google login')), 5 * 60_000);
  });
}

async function refreshFromToken(refreshToken) {
  if (!CLIENT_SECRET) {
    throw new Error('Google client secret missing — reconnect via the menubar after the maintainer ships secrets.');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`token refresh ${res.status}: ${t}`);
  }
  return await res.json();
}

async function getAccessToken(refreshToken, onRefresh) {
  if (accessToken && Date.now() < accessTokenExpires) return accessToken;
  if (!refreshToken) throw new Error('not connected to Google — open the menubar and click Connect Google');
  const tokens = await refreshFromToken(refreshToken);
  accessToken = tokens.access_token;
  accessTokenExpires = Date.now() + tokens.expires_in * 1000 - 60_000;
  if (tokens.refresh_token && tokens.refresh_token !== refreshToken && typeof onRefresh === 'function') {
    onRefresh(tokens.refresh_token);
  }
  return accessToken;
}

function clearCache() {
  accessToken = null;
  accessTokenExpires = 0;
}

module.exports = { connect, getAccessToken, clearCache, REDIRECT_URI, CLIENT_ID };
