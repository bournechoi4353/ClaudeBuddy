// The router: which tier answers what. It is a fixed table, not a model decision.
//
//   ambient     the pet's own unprompted lines (reaction bubbles)   -> local   (Smart lines, with the built-in bank as fallback)
//   user_text   anything the user types to the pet                  -> claude
//   tool        every tool call: Gmail, Docs, Spotify and the rest  -> claude
//
// Anything not in the table goes to Claude, the path the app has always used. The local model
// is reachable only through the 'ambient' route, and nothing the user types can select it.
// Claude is never used for ambient lines.

const ROUTES = Object.freeze({
  ambient: 'local',
  user_text: 'claude',
  tool: 'claude',
});

/** 'local' or 'claude'. Unknown kinds, and inherited property names, route to 'claude'. */
function routeFor(kind) {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ROUTES, kind) ? ROUTES[kind] : 'claude';
}

module.exports = { routeFor, ROUTES };
