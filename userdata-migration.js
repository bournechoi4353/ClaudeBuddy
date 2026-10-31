// The app used to be called Clawd, so Electron kept its data (prefs.json with the settings and the
// Spotify and Google logins) in a folder called Clawd. Now that it is Drizzle that folder is new and
// empty. On the first start, carry the settings over by copying prefs.json. The old folder is left
// exactly as it was, nothing is deleted, and an existing prefs.json in the new folder is never replaced.

const fs = require('fs');
const path = require('path');

const LEGACY_NAMES = ['Clawd', 'clawd'];

/**
 * @param {{ appData: string, userData: string, legacy?: string[], log?: (message: string) => void }} options
 * @returns {{ migrated: boolean, from?: string, reason?: string }}
 */
function migrateLegacyUserData({ appData, userData, legacy = LEGACY_NAMES, log = () => {} }) {
  try {
    const target = path.join(userData, 'prefs.json');
    if (fs.existsSync(target)) return { migrated: false, reason: 'already-present' };
    for (const name of legacy) {
      const dir = path.join(appData, name);
      // On a case-insensitive disk an old name can point at the same folder as the new one.
      if (dir.toLowerCase() === userData.toLowerCase()) continue;
      const source = path.join(dir, 'prefs.json');
      if (!fs.existsSync(source)) continue;
      fs.mkdirSync(userData, { recursive: true });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      log(`copied settings from ${source}`);
      return { migrated: true, from: source };
    }
    return { migrated: false, reason: 'no-legacy-prefs' };
  } catch (err) {
    log(`could not copy the old settings: ${err.message}`);
    return { migrated: false, reason: 'error' };
  }
}

module.exports = { migrateLegacyUserData, LEGACY_NAMES };
