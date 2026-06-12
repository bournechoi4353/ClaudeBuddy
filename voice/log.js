// Voice-path timing log → userData/voice-timing.log. Each leg of the pipeline
// (VAD capture is renderer-side; everything else logs here) appends one line so
// "it was slow/deaf just now" can be diagnosed from the file instead of guessed:
//   tail -50 ~/Library/Application\ Support/Clawd/voice-timing.log
// Truncated when it grows past ~2MB. Never throws into the calling path.

const fs = require('fs');
const path = require('path');

let logPath = null;
let checkedSize = false;

function file() {
  if (!logPath) {
    const { app } = require('electron');
    logPath = path.join(app.getPath('userData'), 'voice-timing.log');
  }
  return logPath;
}

function vlog(tag, msg) {
  try {
    const p = file();
    if (!checkedSize) {
      checkedSize = true;
      try {
        if (fs.statSync(p).size > 2 * 1024 * 1024) fs.truncateSync(p, 0);
      } catch (_) {}
    }
    fs.appendFile(p, `${new Date().toISOString()} [${tag}] ${msg}\n`, () => {});
  } catch (_) {}
}

module.exports = { vlog };
