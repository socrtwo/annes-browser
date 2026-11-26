<#
  Dump the native Win32 menu bar of a running Windows program as a census transcription.

    powershell -ExecutionPolicy Bypass -File tools\menu-dump\windows-menus.ps1 -Process iexplore > ie-6-windows-menus.txt

  Works only for programs that use real Windows menus (HMENU): Internet Explorer 3-6,
  Netscape 2-4, Opera 3-6, K-Meleon, classic Windows programs. Chromium-based browsers
  (Chrome, Edge, Opera 15+, Vivaldi) and Firefox draw their own menus; this finds nothing there.
  Some programs fill submenus only when they open: open each menu once before running.

  Output: `<menu path> | <label> | <shortcut>`. Favorites and History menus list the
  user's own pages; their items after the first separator are written as `#? ` lines.
  Review them and remove `#? ` only from real commands.
#>
param([Parameter(Mandatory = $true)][string]$Process)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Menus {
  [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr hMenu);
  [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr hMenu, int nPos);
  [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr hMenu, uint uId, uint uFlags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetMenuString(IntPtr hMenu, uint uIDItem, StringBuilder lpString, int nMaxCount, uint uFlag);
}
'@

$MF_BYPOSITION = 0x400; $MF_SEPARATOR = 0x800
$personal = '^(Favorites|History|Bookmarks|Window)$'
$p = Get-Process -Name $Process -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Error "$Process has no main window"; exit 1 }
$bar = [Menus]::GetMenu($p.MainWindowHandle)
if ($bar -eq [IntPtr]::Zero) { Write-Error "$Process has no native menu bar (it draws its own menus)"; exit 1 }

function Read-Text($menu, $i) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][Menus]::GetMenuString($menu, [uint32]$i, $sb, 512, $MF_BYPOSITION)
  return $sb.ToString()
}
function Walk($menu, $path, $isPersonal) {
  $after = $false
  for ($i = 0; $i -lt [Menus]::GetMenuItemCount($menu); $i++) {
    $state = [Menus]::GetMenuState($menu, [uint32]$i, $MF_BYPOSITION)
    if ($state -band $MF_SEPARATOR) { $after = $true; continue }
    $raw = Read-Text $menu $i
    if (-not $raw) { continue }
    $parts = $raw -split "`t", 2
    $label = ($parts[0] -replace '&', '' -replace '\|', '/').Trim()
    $sub = [Menus]::GetSubMenu($menu, $i)
    if ($sub -ne [IntPtr]::Zero) { Walk $sub "$path > $label" ($isPersonal -or ($label -match $personal)); continue }
    $line = "$path | $label"
    if ($parts.Count -gt 1 -and $parts[1]) { $line += " | $($parts[1].Trim())" }
    if ($isPersonal -and $after) { $line = "#? $line" }
    $line
  }
}

$version = try { $p.MainModule.FileVersionInfo.ProductVersion } catch { 'unknown' }
"# Menus read from $($p.ProcessName) $version on Windows $([Environment]::OSVersion.Version) by tools/menu-dump/windows-menus.ps1."
"# read: $(Get-Date -Format yyyy-MM-dd)"
"# Each line: menu path | label | shortcut. Lines starting ""#? "" came from menus that list personal items; review them."
for ($t = 0; $t -lt [Menus]::GetMenuItemCount($bar); $t++) {
  $title = (Read-Text $bar $t) -replace '&', ''
  $sub = [Menus]::GetSubMenu($bar, $t)
  if ($sub -ne [IntPtr]::Zero) { Walk $sub $title ($title -match $personal) }
}
