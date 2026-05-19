// Phase 5: tools that give Clawd context about the user's machine.
// Built lazily because the SDK is ESM-only and has to be dynamic-imported.

const { spawn } = require('child_process');

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
        'Returns the macOS app currently in the foreground and its window title (if accessibility permission allows). Call when the user asks "what am i doing", "what app is open", or anything about their current screen.',
        {},
        frontmostHandler
      ),
    ],
  });
}

module.exports = {
  buildServer,
  allowedTools: ['mcp__clawd__now', 'mcp__clawd__frontmost_window'],
};
