#!/bin/bash
# Clawd one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/bournechoi4353/ClaudeBuddy/main/install.sh | bash
#
# Clones the source, builds Clawd locally, signs with a self-signed cert,
# installs to /Applications.

set -e

REPO_URL="https://github.com/bournechoi4353/ClaudeBuddy.git"
SRC_DIR="$HOME/Library/Application Support/Clawd-src"

c_red()   { printf "\033[31m%s\033[0m\n" "$1"; }
c_green() { printf "\033[32m%s\033[0m\n" "$1"; }
c_blue()  { printf "\033[34m%s\033[0m\n" "$1"; }
c_bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
step()    { printf "\n\033[1;34m▸ %s\033[0m\n" "$1"; }

c_bold "Installing Clawd..."

# ---- preflight ---------------------------------------------------------------

if [[ "$(uname)" != "Darwin" ]]; then
  c_red "Clawd only runs on macOS."
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  c_red "Clawd only supports Apple Silicon (M1/M2/M3/M4) for now."
  exit 1
fi

if ! command -v node &>/dev/null; then
  c_red "Node.js is not installed."
  echo "Install Node 20+ first:"
  echo "  Homebrew:  brew install node"
  echo "  Manually:  https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
if (( NODE_MAJOR < 20 )); then
  c_red "Node 20+ required (you have $(node --version))."
  exit 1
fi

if ! command -v git &>/dev/null; then
  c_red "git is not installed."
  echo "Install: xcode-select --install"
  exit 1
fi

if [[ ! -f "$HOME/.claude/.credentials.json" ]]; then
  c_blue "Heads up: Clawd needs Claude Code installed and logged in to chat."
  c_blue "After install, visit https://claude.com/code, then run: claude login"
fi

# ---- clone or update ---------------------------------------------------------

step "Fetching source"
if [[ -d "$SRC_DIR/.git" ]]; then
  echo "Updating existing source at $SRC_DIR"
  git -C "$SRC_DIR" fetch --quiet origin
  git -C "$SRC_DIR" reset --hard origin/main --quiet
else
  rm -rf "$SRC_DIR"
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone --quiet --depth=1 "$REPO_URL" "$SRC_DIR"
fi

cd "$SRC_DIR"

# ---- npm install -------------------------------------------------------------

step "Installing dependencies (this can take a minute)"
npm install --silent 2>&1 | tail -3 || true

# ---- self-signed cert --------------------------------------------------------

step "Setting up code-signing"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "Clawd Self-Signed"; then
  echo "Self-signed cert already in keychain — skipping."
else
  bash scripts/setup-self-signed.sh
fi

# ---- build -------------------------------------------------------------------

step "Building Clawd.app"
npm run pack 2>&1 | tail -3 || true

if [[ ! -d "dist/mac-arm64/Clawd.app" ]]; then
  c_red "Build failed — no Clawd.app produced."
  exit 1
fi

# ---- install -----------------------------------------------------------------

step "Installing to /Applications"
# If Clawd is running, kill it so we can overwrite.
pkill -f "Clawd.app" 2>/dev/null || true
sleep 1
rm -rf /Applications/Clawd.app
cp -R dist/mac-arm64/Clawd.app /Applications/

# ---- done --------------------------------------------------------------------

c_green ""
c_green "Done."
echo
c_bold "First launch:"
echo "  1. Open Finder → Applications"
echo "  2. RIGHT-CLICK Clawd → Open  (one-time Gatekeeper warning)"
echo "  3. Click Open in the dialog"
echo
c_bold "If you haven't yet, set up Claude:"
echo "  1. Install Claude Code: https://claude.com/code"
echo "  2. In a terminal:  claude login"
echo "  3. Sign in with your Pro/Max account"
echo
c_bold "Optional — Spotify auto-play:"
echo "  Click 'clawd' in the menubar → Connect Spotify"
echo
