# Clawd one-line installer for Windows.
#
#   irm https://raw.githubusercontent.com/bournechoi4353/ClaudeBuddy/main/install.ps1 | iex
#
# Downloads the source into %LOCALAPPDATA%\Clawd-src, installs dependencies, and
# wires up Start Menu + Desktop shortcuts that launch it. The Windows counterpart
# to install.sh (macOS).
#
# It runs the app straight from source via the bundled Electron rather than
# packaging with electron-builder - on Windows electron-builder needs admin /
# Developer Mode to extract winCodeSign's macOS symlinks, which an ordinary
# one-liner can't assume. Running from source is exactly what `npm start` does.
#
# Notes baked in from real-world Windows pain:
#   - Installs under %LOCALAPPDATA% (never OneDrive-synced) to keep node_modules
#     out of cloud sync.
#   - Repairs Electron's binary if its download cache is broken (a frequent
#     Windows failure that otherwise leaves no electron.exe).
#   - Forces TLS 1.2 so downloads work on stock Windows PowerShell 5.1.
#   - Strips ELECTRON_RUN_AS_NODE, which otherwise makes Electron run as plain
#     Node and crash on startup.
#   - Adds Node to PATH itself; the Node MSI doesn't always do it.

# Run via `irm | iex` executes in the caller's session, so stash anything we
# change globally and restore it in the finally block at the end.
$origEAP = $ErrorActionPreference
$origPP  = $ProgressPreference
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # Invoke-WebRequest is ~10x faster without the progress UI on PS 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoZip = 'https://github.com/bournechoi4353/ClaudeBuddy/archive/refs/heads/main.zip'
$SrcDir  = Join-Path $env:LOCALAPPDATA 'Clawd-src'   # the app runs from here (outside OneDrive)

function Step($m) { Write-Host "`n> $m" -ForegroundColor Cyan }
function Info($m) { Write-Host "  $m" -ForegroundColor Gray }
function Ok($m)   { Write-Host $m -ForegroundColor Green }
function Fail($m) { Write-Host $m -ForegroundColor Red }

# Pull the latest Machine + User PATH into this session (after a winget install
# the new entries aren't in $env:Path yet).
function Update-SessionPath {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($m, $u) | Where-Object { $_ }) -join ';'
}

function Find-Exe($name) {
  Update-SessionPath
  $c = Get-Command $name -ErrorAction SilentlyContinue
  if ($c) { return $c.Source } else { return $null }
}

# Make sure node_modules\electron\dist\electron.exe actually exists. Electron's
# postinstall (@electron/get) routinely no-ops on Windows when its download cache
# holds a corrupt/partial zip - it reports "Cache hit" and extracts only a stub,
# leaving no electron.exe. We can't trust it, so verify and, if missing, fetch the
# release zip ourselves and extract it (Expand-Archive succeeds where @electron/get
# fails, and downloading fresh sidesteps the bad cache).
function Repair-Electron($srcDir, $node) {
  $dist        = Join-Path $srcDir 'node_modules\electron\dist'
  $electronExe = Join-Path $dist 'electron.exe'
  if (Test-Path $electronExe) { return $true }

  # One shot at Electron's own installer (cheap if the cache is actually fine).
  & $node (Join-Path $srcDir 'node_modules\electron\install.js') 2>$null | Out-Null
  if (Test-Path $electronExe) { return $true }

  $ver = (Get-Content (Join-Path $srcDir 'node_modules\electron\package.json') -Raw | ConvertFrom-Json).version
  $abi = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $url = "https://github.com/electron/electron/releases/download/v$ver/electron-v$ver-win32-$abi.zip"
  $zip = Join-Path $env:TEMP "electron-v$ver-win32-$abi.zip"
  $ex  = Join-Path $env:TEMP "electron-v$ver-win32-$abi-unzip"
  Info "Fetching Electron $ver directly (working around a bad download cache)."
  Invoke-WebRequest -Uri $url -OutFile $zip
  if (Test-Path $ex) { Remove-Item $ex -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $ex -Force
  if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
  New-Item -ItemType Directory -Path $dist -Force | Out-Null
  Copy-Item (Join-Path $ex '*') $dist -Recurse -Force
  # electron's loader reads this relative exe name from path.txt
  Set-Content -Path (Join-Path $srcDir 'node_modules\electron\path.txt') -Value 'electron.exe' -Encoding ascii -NoNewline
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Remove-Item $ex -Recurse -Force -ErrorAction SilentlyContinue
  return (Test-Path $electronExe)
}

$origDir = Get-Location

try {
  Write-Host "Installing Clawd..." -ForegroundColor White

  # ---- preflight -------------------------------------------------------------

  if ($env:OS -ne 'Windows_NT') {
    Fail "This installer is for Windows. On macOS use install.sh."
    return
  }

  # Node.js 20+
  Step "Checking Node.js"
  $node = Find-Exe 'node'
  $needNode = $true
  if ($node) {
    try {
      $v = (& $node --version) -replace '^v', ''
      if ([int]($v.Split('.')[0]) -ge 20) { $needNode = $false; Info "Node v$v found." }
      else { Info "Node v$v is too old (need 20+); upgrading." }
    } catch { }
  }
  if ($needNode) {
    $winget = Find-Exe 'winget'
    if (-not $winget) {
      Fail "Node.js 20+ is required, and winget isn't available to install it automatically."
      Info "Install Node 20+ from https://nodejs.org and re-run this installer."
      return
    }
    Step "Installing Node.js LTS (via winget)"
    & $winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    if ($LASTEXITCODE -ne 0) {
      Fail "winget failed to install Node.js (exit $LASTEXITCODE). Install Node 20+ from https://nodejs.org and re-run."
      return
    }
    # The Node MSI doesn't reliably register itself on PATH; add it ourselves.
    $nodeDir = Join-Path $env:ProgramFiles 'nodejs'
    if (Test-Path (Join-Path $nodeDir 'node.exe')) {
      $env:Path = "$env:Path;$nodeDir"
      $up = [Environment]::GetEnvironmentVariable('Path', 'User')
      if (($up -split ';') -notcontains $nodeDir) {
        [Environment]::SetEnvironmentVariable('Path', ($up.TrimEnd(';') + ';' + $nodeDir), 'User')
      }
    }
    $node = Find-Exe 'node'
    if (-not $node) {
      Fail "Node installed but isn't on PATH yet. Open a NEW terminal and re-run the installer."
      return
    }
    Ok "Node $(& $node --version) installed."
  }

  # Use npm.cmd specifically (it lives beside node.exe). Resolving plain 'npm'
  # can yield npm.ps1, which a default 'Restricted' execution policy refuses to
  # run ("running scripts is disabled on this system"); the .cmd shim is a batch
  # file and isn't governed by the execution policy.
  $npm = Join-Path (Split-Path $node) 'npm.cmd'
  if (-not (Test-Path $npm)) {
    $g = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
    if ($g) { $npm = $g.Source }
  }
  if (-not $npm -or -not (Test-Path $npm)) { Fail "npm.cmd wasn't found next to Node."; return }

  # Claude Code heads-up (chat won't work without it, but it's not needed to build)
  if (-not (Test-Path (Join-Path $env:USERPROFILE '.claude\.credentials.json'))) {
    Info "Heads up: Clawd chats through your Claude Pro/Max subscription via Claude Code."
    Info "After install, get it from https://claude.com/code and run 'claude login'."
  }

  # ---- fetch source ----------------------------------------------------------

  Step "Downloading source"
  $tmpZip     = Join-Path $env:TEMP 'clawd-src.zip'
  $tmpExtract = Join-Path $env:TEMP 'clawd-src-extract'
  Invoke-WebRequest -Uri $RepoZip -OutFile $tmpZip
  if (Test-Path $tmpExtract) { Remove-Item $tmpExtract -Recurse -Force }
  Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
  # GitHub nests the tree under <repo>-<branch>\
  $inner = Get-ChildItem $tmpExtract -Directory | Select-Object -First 1
  if (-not $inner) { Fail "The downloaded source looks empty."; return }

  # Stop a running Clawd before we replace its source/node_modules. It runs as
  # electron.exe out of $SrcDir; match by path so we don't touch other Electron
  # apps (VS Code, etc.).
  Get-Process electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($SrcDir, [System.StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  if (Test-Path $SrcDir) { Remove-Item $SrcDir -Recurse -Force }
  Move-Item $inner.FullName $SrcDir
  Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
  Remove-Item $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue
  Set-Location $SrcDir
  Ok "Source at $SrcDir"

  # ---- npm install -----------------------------------------------------------

  Step "Installing dependencies (a minute or two)"
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  & $npm install --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { Fail "npm install failed."; return }

  # Electron's binary download frequently no-ops on Windows (corrupt @electron/get
  # cache). Verify it landed and repair it ourselves if not.
  if (-not (Repair-Electron $SrcDir $node)) {
    Fail "Electron binary couldn't be installed. Re-run the installer; if it persists, antivirus may be blocking electron.exe."
    return
  }

  # The subscription chat needs the platform-specific Claude SDK binary, pulled
  # by npm as an optionalDependency keyed on os/cpu.
  $sdkRoot = Join-Path $SrcDir 'node_modules\@anthropic-ai'
  $sdk = Get-ChildItem $sdkRoot -Filter 'claude-agent-sdk-win32-*' -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $sdk -or -not (Test-Path (Join-Path $sdk.FullName 'claude.exe'))) {
    Info "Note: the Windows Claude SDK binary was not pulled - chat may not work until a clean reinstall."
  }

  # ---- install (shortcuts) ---------------------------------------------------
  #
  # We deliberately DON'T package with electron-builder. On Windows it extracts
  # winCodeSign, whose archive contains macOS symlinks that can't be created
  # without admin / Developer Mode ("a required privilege is not held by the
  # client"), so the build fails for ordinary users. Instead we run the app
  # straight from source through the bundled Electron - byte-for-byte what
  # `npm start` does, and what the app already expects: app.isPackaged stays
  # false, so resolveClaudeBinary() finds the SDK binary under node_modules.
  # Shortcuts just launch electron.exe with the app directory as its argument.

  Step "Creating shortcuts"
  $electronExe = Join-Path $SrcDir 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $electronExe)) { Fail "Electron runtime missing - install did not complete."; return }
  $appArg = '"' + $SrcDir + '"'

  $shell = New-Object -ComObject WScript.Shell
  foreach ($lnk in @(
      (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Clawd.lnk'),
      (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Clawd.lnk'))) {
    $s = $shell.CreateShortcut($lnk)
    $s.TargetPath       = $electronExe
    $s.Arguments        = $appArg
    $s.WorkingDirectory = $SrcDir
    $s.IconLocation     = $electronExe
    $s.Description       = 'Clawd - a pixel crab that is also Claude'
    $s.Save()
  }
  Ok "Installed to $SrcDir."

  # ---- launch ----------------------------------------------------------------

  Step "Launching Clawd"
  Start-Process -FilePath $electronExe -ArgumentList $appArg -WorkingDirectory $SrcDir

  Write-Host ""
  Ok "Done. Clawd is running - look at the bottom of your screen."
  Write-Host ""
  Write-Host "Settings: right-click the crab, or click the Clawd icon in the system tray" -ForegroundColor White
  Write-Host "(bottom-right by the clock - it may be under the '^' hidden-icons arrow)." -ForegroundColor White
  Write-Host ""
  Write-Host "If chat shows an error, set up Claude:" -ForegroundColor White
  Write-Host "  1. Install Claude Code: https://claude.com/code"
  Write-Host "  2. Run: claude login"
  Write-Host ""
  Write-Host "Shortcuts added to the Start Menu and Desktop. Re-run this one-liner anytime to update." -ForegroundColor White
}
catch {
  Fail "Install failed: $($_.Exception.Message)"
  Info "Re-run the one-liner to retry. If it keeps failing, please open an issue with the message above."
}
finally {
  Set-Location $origDir
  $ErrorActionPreference = $origEAP
  $ProgressPreference    = $origPP
}
