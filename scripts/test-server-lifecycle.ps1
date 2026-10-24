param([string]$Executable = (Join-Path $PSScriptRoot '../server/target/debug/ambra-server.exe'))
$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('ambra-background-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$env:AMBRA_CONFIG_DIR = Join-Path $testRoot 'config'
$env:AMBRA_DATA_DIR = Join-Path $testRoot 'data'
$env:AMBRA_CACHE_DIR = Join-Path $testRoot 'cache'
$reservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$reservation.Start()
$port = $reservation.LocalEndpoint.Port
$reservation.Stop()
$env:AMBRA_SERVER_ADDRESS = "127.0.0.1:$port"
$base = 'http://' + $env:AMBRA_SERVER_ADDRESS
$runtimePath = Join-Path $env:AMBRA_DATA_DIR 'server-runtime.json'
$serverPid = $null

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AmbraTrayTest {
    public delegate bool EnumWindowsProc(IntPtr window, IntPtr param);
    [DllImport("user32.dll")] public static extern bool EnumThreadWindows(uint thread, EnumWindowsProc callback, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr window, System.Text.StringBuilder name, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr window, uint message, UIntPtr wp, IntPtr lp);
}
'@

function Wait-Stopped([int]$Id) {
    $process = Get-Process -Id $Id -ErrorAction SilentlyContinue
    if ($process -and -not $process.WaitForExit(5000)) { throw 'The background server did not stop.' }
}

try {
    & $Executable start
    if ($LASTEXITCODE -ne 0) { throw 'Background startup failed.' }
    $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
    $serverPid = [int]$runtime.pid
    if ((Invoke-RestMethod "$base/api/health").status -ne 'ok') { throw 'The server did not survive its launcher exiting.' }
    $process = Get-Process -Id $serverPid
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) { throw 'The background server opened a visible window.' }
    $tray = [IntPtr]::Zero
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $candidate = [IntPtr]::Zero
        do {
            $candidate = [AmbraTrayTest]::FindWindowExW([IntPtr]::Zero, $candidate, 'AmbraServerTray', $null)
            [uint32]$owner = 0
            if ($candidate -ne [IntPtr]::Zero) {
                [void][AmbraTrayTest]::GetWindowThreadProcessId($candidate, [ref]$owner)
                if ($owner -eq $serverPid) { $tray = $candidate; break }
            }
        } while ($candidate -ne [IntPtr]::Zero)
        if ($tray -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 100
    }
    if ($tray -eq [IntPtr]::Zero) {
        $foundWindows = [System.Collections.Generic.List[string]]::new()
        $foundTray = @{ Window = [IntPtr]::Zero }
        foreach ($nativeThread in (Get-Process -Id $serverPid).Threads) {
            [void][AmbraTrayTest]::EnumThreadWindows($nativeThread.Id, {
                param($window, $param)
                $name = [Text.StringBuilder]::new(256)
                [void][AmbraTrayTest]::GetClassNameW($window, $name, 256)
                $foundWindows.Add($name.ToString())
                if ($name.ToString() -eq 'AmbraServerTray') { $foundTray.Window = $window }
                return $true
            }, [IntPtr]::Zero)
        }
        $tray = $foundTray.Window
        if ($tray -eq [IntPtr]::Zero) { throw ('The native tray window was not created. Found: ' + ($foundWindows -join ', ')) }
    }
    & $Executable start
    if ($LASTEXITCODE -ne 0 -or (Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json).pid -ne $serverPid) { throw 'Starting twice created a second server.' }
    "Native tray active; no visible window. Working set: $([math]::Round($process.WorkingSet64 / 1MB, 1)) MB."
    # Same WM_COMMAND emitted by selecting the tray's Stop server menu item.
    [void][AmbraTrayTest]::PostMessageW($tray, 0x0111, [UIntPtr]::new([uint32]1), [IntPtr]::Zero)
    Wait-Stopped $serverPid
    $serverPid = $null
    & $Executable start
    if ($LASTEXITCODE -ne 0) { throw 'Restarting the stopped server failed.' }
    $serverPid = [int](Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json).pid
    & $Executable stop
    if ($LASTEXITCODE -ne 0) { throw 'CLI stop failed.' }
    Wait-Stopped $serverPid
    $serverPid = $null
    'PASS: launcher independence, native tray, duplicate-start protection, tray stop, restart and CLI stop.'
} catch {
    $log = Join-Path $env:AMBRA_DATA_DIR 'server.log'
    if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 30 }
    throw
} finally {
    if ($serverPid -and (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) { Stop-Process -Id $serverPid }
}
