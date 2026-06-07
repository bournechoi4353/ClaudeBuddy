# Clawd uninstaller (Windows).
#
# Removes the app, its data, its shortcuts, and its Add/Remove Programs entry.
# Per-user, no admin needed. This is what the "Uninstall" button in
# Settings > Apps > Installed apps runs (registered by install.ps1), and you can
# also run it by hand.

$ErrorActionPreference = 'SilentlyContinue'
Set-Location $env:TEMP   # never run from inside the directory we're about to delete

$SrcDir = Join-Path $env:LOCALAPPDATA 'Clawd-src'

# Stop the running app (it runs as electron.exe out of $SrcDir); match by path so
# other Electron apps (VS Code, etc.) are left alone.
Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($SrcDir, [System.StringComparison]::OrdinalIgnoreCase) } |
  Stop-Process -Force
Start-Sleep -Milliseconds 600

# App, user data/prefs, shortcuts.
Remove-Item $SrcDir -Recurse -Force
Remove-Item (Join-Path $env:APPDATA 'Clawd') -Recurse -Force
Remove-Item (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Clawd.lnk') -Force
Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Clawd.lnk') -Force

# Launch-at-login entry, only if it points at our install.
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$rk = Get-Item $runKey -ErrorAction SilentlyContinue
if ($rk) {
  foreach ($n in $rk.GetValueNames()) {
    if (([string]$rk.GetValue($n)) -match 'Clawd-src' -or $n -eq 'Clawd') {
      Remove-ItemProperty -Path $runKey -Name $n
    }
  }
}

# Finally, the Add/Remove Programs entry itself - this de-lists Clawd.
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Clawd' -Recurse -Force

Write-Host "Clawd uninstalled."
