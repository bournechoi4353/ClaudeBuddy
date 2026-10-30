// Maps a frontmost app name to one of the pet brain's app categories.
// Only the app name is used. Window titles, URLs and document names are never read.
// Names are the ones platform.getFrontmostApp() returns on macOS and Windows.

const BY_NAME = {
  code_editor: [
    'Code', 'Visual Studio Code', 'Cursor', 'Windsurf', 'Xcode', 'Sublime Text', 'Zed', 'Nova',
    'BBEdit', 'TextMate', 'Atom', 'IntelliJ IDEA', 'PyCharm', 'WebStorm', 'GoLand', 'CLion',
    'RubyMine', 'PhpStorm', 'Rider', 'Android Studio', 'Visual Studio', 'Notepad++',
  ],
  terminal: [
    'Terminal', 'iTerm2', 'iTerm', 'Warp', 'Ghostty', 'Alacritty', 'kitty', 'WezTerm', 'Hyper',
    'Windows Terminal',
  ],
  browser: [
    'Google Chrome', 'Safari', 'Arc', 'Firefox', 'Brave Browser', 'Brave', 'Microsoft Edge',
    'Opera', 'Vivaldi', 'Orion', 'Chromium',
  ],
  video: [
    'VLC', 'QuickTime Player', 'IINA', 'TV', 'Plex', 'Infuse', 'mpv', 'Netflix', 'Disney+',
    'Movies & TV',
  ],
  chat: [
    'Slack', 'Discord', 'Messages', 'Telegram', 'WhatsApp', 'Signal', 'zoom.us', 'Zoom',
    'Microsoft Teams', 'Teams', 'FaceTime', 'Element', 'Skype',
  ],
  docs: [
    'Notion', 'Obsidian', 'Preview', 'Pages', 'Microsoft Word', 'Word', 'Notes', 'Bear', 'Typora',
    'Books', 'Kindle', 'Adobe Acrobat', 'Acrobat Reader', 'Logseq', 'Evernote', 'Craft',
  ],
  music: [
    'Spotify', 'Music', 'Apple Music', 'iTunes', 'Tidal', 'Deezer', 'YouTube Music', 'Amazon Music',
  ],
};

// A few game launchers and games are matched by pattern since their app names vary.
const GAME_PATTERN = /minecraft|roblox|steam|epic games|battle\.net|valorant|fortnite|league of legends|dota|counter-strike/i;

const LOOKUP = new Map();
for (const [category, names] of Object.entries(BY_NAME)) {
  for (const name of names) LOOKUP.set(name.toLowerCase(), category);
}

/** Category for an app name. Unknown or empty names are 'other'. Never throws. */
function categorizeApp(name) {
  if (typeof name !== 'string') return 'other';
  const key = name.trim().toLowerCase();
  if (!key) return 'other';
  if (LOOKUP.has(key)) return LOOKUP.get(key);
  if (GAME_PATTERN.test(key)) return 'game';
  return 'other';
}

module.exports = { categorizeApp };
