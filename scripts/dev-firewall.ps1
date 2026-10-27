#Requires -RunAsAdministrator
# Run once as administrator (and again after upgrading bun, whose node shim moves with its
# version). Lets devices on private networks reach the Ambra server (38147) and Expo's dev
# server (8081, for the phone app), and stops Windows asking about them.
#
# Windows asks whenever a program listens without a rule for every type of network it's on,
# and a dismissed prompt leaves rules that block it everywhere, overriding any allow. So each
# program gets both answers: allowed on private networks, blocked on public ones.
$ErrorActionPreference = 'Stop'
$prefix = 'Ambra development'

$server = (Get-Command ambra-server -ErrorAction SilentlyContinue).Source
$programs = @()
if ($server) { $programs += $server }
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if ($bun) { $programs += $bun }
# `bun run` puts a node.exe shim in front of PATH, so Metro listens as that program.
$programs += @(Get-ChildItem $env:TEMP -Directory -Filter 'bun-node-*' |
  ForEach-Object { Join-Path $_.FullName 'node.exe' } | Where-Object { Test-Path $_ })

function Get-ProgramRules {
  # Every rule's program in one query: asking rule by rule takes minutes on a typical machine.
  $byName = @{}
  Get-NetFirewallRule -Direction Inbound | ForEach-Object { $byName[$_.Name] = $_ }
  Get-NetFirewallApplicationFilter -All | Where-Object {
    ($server -and $_.Program -eq $server) -or
      $_.Program -like '*\bun-node-*\node.exe' -or ($bun -and $_.Program -eq $bun)
  } | ForEach-Object { if ($byName[$_.InstanceID]) { [pscustomobject]@{ Rule = $byName[$_.InstanceID]; Program = $_.Program } } }
}

Write-Host 'Removing earlier rules for these programs...'
$old = @(Get-ProgramRules | ForEach-Object { $_.Rule.Name })
foreach ($name in $old | Select-Object -Unique) { Remove-NetFirewallRule -Name $name -ErrorAction SilentlyContinue }

# netsh can report "an unrecoverable error" (0x8032000a, 0x6) after it has added the rule, so
# its exit code isn't trusted; the rules are checked below instead.
foreach ($program in $programs) {
  netsh advfirewall firewall add rule name="$prefix`: $program" dir=in action=allow program="$program" profile=private enable=yes | Out-Null
  netsh advfirewall firewall add rule name="$prefix (public networks): $program" dir=in action=block program="$program" profile=public enable=yes | Out-Null
}

$rules = @(Get-ProgramRules)
$failed = $false
foreach ($program in $programs) {
  $mine = @($rules | Where-Object { $_.Program -eq $program })
  $allowed = $mine | Where-Object { $_.Rule.Action -eq 'Allow' -and "$($_.Rule.Profile)" -eq 'Private' }
  $blocked = $mine | Where-Object { $_.Rule.Action -eq 'Block' -and "$($_.Rule.Profile)" -eq 'Public' }
  $stray = $mine | Where-Object { $_.Rule.Action -eq 'Block' -and "$($_.Rule.Profile)" -match 'Private' }
  if (-not $allowed -or $stray) { $failed = $true; Write-Host "FAILED  $program (allowed on private networks: $([bool]$allowed), blocked there: $([bool]$stray))" }
  # Only matters while a public network is connected: without it, Windows will ask again.
  elseif (-not $blocked) { Write-Host "OK      $program (no public-network rule; answer Allow if Windows asks)" }
  else { Write-Host "OK      $program" }
}
if ($failed) { throw 'Some rules are missing; restarting Windows usually clears firewall errors like these.' }
Write-Host 'Done.'
