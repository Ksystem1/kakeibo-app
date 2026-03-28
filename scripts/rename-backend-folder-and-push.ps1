# Rename 6-char JP folder -> backend, then git add / commit / push (ASCII-only source)
$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$git = "C:\Program Files\Git\bin\git.exe"
if (-not (Test-Path $git)) { $git = "git" }

$utf8 = New-Object System.Text.UTF8Encoding $false
$bytes = [byte[]]@(0xE3,0x83,0x90,0xE3,0x83,0x83,0xE3,0x82,0xAF,0xE3,0x82,0xA8,0xE3,0x83,0xB3,0xE3,0x83,0x89)
$jpName = $utf8.GetString($bytes)
$from = Join-Path $repoRoot $jpName
$to = Join-Path $repoRoot "backend"

if (Test-Path -LiteralPath $from) {
  if (Test-Path -LiteralPath $to) {
    Write-Error "Both JP folder and backend exist. Resolve manually."
    exit 1
  }
  Write-Host "git mv -> backend"
  & $git mv -- "$from" "$to"
} else {
  Write-Host "Skip rename: JP folder not found (likely already backend)."
}

& $git add .
$status = & $git status --porcelain
if ($status) {
  & $git commit -m "Rename folder from バックエンド to backend for App Runner"
} else {
  Write-Host "Skip commit: nothing to stage."
}

$branch = & $git branch --show-current
Write-Host "git push origin $branch"
& $git push origin $branch
