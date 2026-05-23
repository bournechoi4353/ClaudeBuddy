// Google OAuth client secret. Paired with the Client ID in google-auth.js.
//
// Where to get it:
//   console.cloud.google.com → your Clawd project → APIs & Services →
//   Credentials → click the OAuth client you created → "Client secret" field.
//
// Despite the name, for installed/desktop OAuth apps with PKCE this is not
// a real secret in the cryptographic sense — Google explicitly allows it to
// be embedded in distributed apps. It's gitignored by default so it stays
// out of public commits; if you want strangers to be able to use Clawd's
// Google features, you'll have to either commit this file or fork the repo
// and ship your own build with their own secret.
//
// Replace the placeholder below.

module.exports = {
  CLIENT_SECRET: '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',
};
