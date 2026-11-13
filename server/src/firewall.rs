//! Windows Firewall rules for the server's own listeners.
//!
//! Windows blocks inbound connections to a program until it has a rule, and a dismissed
//! "allow access" prompt leaves Block rules that override any Allow. Devices on the network
//! (and through the router-forwarded port) then see the server's ports silently time out,
//! and fall back to slow NAT traversal. So the server keeps its own rules, asking Windows
//! for permission (one UAC prompt) only when they are missing or overridden:
//!
//! The rules cover the secure listener, the plain HTTP port and LAN discovery, on private and
//! domain networks only. Peers on the same network skip the signed knock the router-forwarded
//! port requires, so a network Windows treats as public (a café's) stays closed; when the
//! server's own network is marked public, that is reported instead of opened.
//!
//! The listener's owner is asked once per executable; after a refusal the tray offers to ask
//! again, and `/api/network/status` reports the state.

use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(windows), allow(dead_code))]
pub enum State {
    /// Not Windows, or LAN sharing is off.
    #[default]
    NotNeeded,
    Checking,
    Open,
    /// The rules are missing and the owner hasn't been asked yet, or asking failed.
    Blocked,
    /// The owner refused the permission prompt.
    Declined,
    /// The rules are in place, but Windows treats this network as public, where they don't apply.
    PublicNetwork,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: State,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ports {
    pub secure: u16,
    pub http: u16,
    pub discovery: u16,
}

static STATUS: std::sync::RwLock<Status> = std::sync::RwLock::new(Status { state: State::NotNeeded, error: None });

pub fn status() -> Status {
    STATUS.read().unwrap_or_else(|p| p.into_inner()).clone()
}

#[cfg(not(windows))]
pub fn ensure(_ports: Ports, _ask: bool) {}

#[cfg(windows)]
pub use windows::{ensure, retry};

#[cfg(windows)]
mod windows {
    use super::{Ports, STATUS, State, Status};
    use base64::Engine;
    use std::{os::windows::process::CommandExt, process::Command, sync::Mutex};

    /// Rules this server owns are found by this group, and are current when their
    /// description matches what this version would write.
    const GROUP: &str = "Ambra Server";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    /// The ports last asked for, so the tray can ask again.
    static PORTS: Mutex<Option<Ports>> = Mutex::new(None);
    /// One check or prompt at a time.
    static RUNNING: Mutex<()> = Mutex::new(());

    fn set(state: State, error: Option<String>) {
        *STATUS.write().unwrap_or_else(|p| p.into_inner()) = Status { state, error };
    }

    fn quoted(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }

    fn encoded(script: &str) -> String {
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// Runs a script in a hidden PowerShell and returns its trimmed output.
    fn powershell(script: &str) -> Result<String, String> {
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded(script)])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("Could not run PowerShell: {error}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if output.status.success() {
            Ok(stdout)
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            Err(if stderr.is_empty() { stdout } else { stderr })
        }
    }

    fn description(ports: Ports) -> String {
        format!("Lets other devices reach Ambra Server (secure {}, http {}, discovery {}).", ports.secure, ports.http, ports.discovery)
    }

    /// Inbound rules whose program is this executable, matched the way Windows compares paths.
    /// One query for every rule: asking rule by rule takes minutes on a typical machine.
    fn rules_function(program: &str) -> String {
        format!(
            r#"$program = {program}
function Get-ProgramRules {{
  $byName = @{{}}
  Get-NetFirewallRule -Direction Inbound | ForEach-Object {{ $byName[$_.Name] = $_ }}
  Get-NetFirewallApplicationFilter -All | Where-Object {{
    $_.Program -eq $program -or [Environment]::ExpandEnvironmentVariables($_.Program) -eq $program
  }} | ForEach-Object {{ $byName[$_.InstanceID] }} | Where-Object {{ $_ }}
}}"#,
            program = quoted(program),
        )
    }

    /// Prints `open` when this executable has current rules and nothing blocks it, `public`
    /// when it does but a connected network is marked public, and `blocked` otherwise.
    fn check_script(program: &str, ports: Ports) -> String {
        format!(
            r#"$ErrorActionPreference = 'Stop'
{rules}
$rules = @(Get-ProgramRules | Where-Object {{ "$($_.Enabled)" -eq 'True' }})
$blocked = @($rules | Where-Object {{ "$($_.Action)" -eq 'Block' }}).Count -gt 0
$mine = @($rules | Where-Object {{ $_.Group -eq {group} -and $_.Description -eq {description} -and "$($_.Action)" -eq 'Allow' }}).Count
$public = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object {{ "$($_.NetworkCategory)" -eq 'Public' }}).Count -gt 0
if ($blocked -or $mine -lt 3) {{ 'blocked' }} elseif ($public) {{ 'public' }} else {{ 'open' }}"#,
            rules = rules_function(program),
            group = quoted(GROUP),
            description = quoted(&description(ports)),
        )
    }

    /// Replaces this server's rules and removes Block rules for its executable, which would
    /// otherwise override them. Other programs' rules, and other Allow rules, are untouched.
    fn apply_script(program: &str, ports: Ports) -> String {
        format!(
            r#"$ErrorActionPreference = 'Stop'
{rules}
$description = {description}
Get-NetFirewallRule -Group {group} -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-ProgramRules | Where-Object {{ "$($_.Action)" -eq 'Block' }} | Remove-NetFirewallRule
$common = @{{ Group = {group}; Description = $description; Direction = 'Inbound'; Action = 'Allow'; Program = $program; Profile = 'Private,Domain' }}
New-NetFirewallRule @common -DisplayName 'Ambra Server (secure connections)' -Protocol TCP -LocalPort {secure} | Out-Null
New-NetFirewallRule @common -DisplayName 'Ambra Server (local network)' -Protocol TCP -LocalPort {http} | Out-Null
New-NetFirewallRule @common -DisplayName 'Ambra Server (discovery)' -Protocol UDP -LocalPort {discovery} | Out-Null"#,
            rules = rules_function(program),
            description = quoted(&description(ports)),
            group = quoted(GROUP),
            secure = ports.secure,
            http = ports.http,
            discovery = ports.discovery,
        )
    }

    /// Runs `apply_script` directly when already elevated, otherwise through one UAC prompt.
    /// Prints `declined` when the owner refuses the prompt.
    fn elevate_script(apply: &str) -> String {
        let administrator = "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";
        format!(
            r#"$ErrorActionPreference = 'Stop'
if ({administrator}) {{
  & ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{encoded}'))))
  'applied'
}} else {{
  try {{
    $process = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
      -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','{encoded}'
  }} catch {{
    # ERROR_CANCELLED: the owner chose No on the permission prompt.
    if ($_.Exception.InnerException.NativeErrorCode -eq 1223) {{ 'declined'; exit 0 }}
    throw
  }}
  if ($process.ExitCode -eq 0) {{ 'applied' }} else {{ throw "The firewall change failed ($($process.ExitCode))." }}
}}"#,
            encoded = encoded(apply),
        )
    }

    /// The owner refused for this executable; asked again only through the tray.
    fn declined_path() -> std::path::PathBuf {
        crate::storage::data_path("firewall-declined.txt")
    }

    fn declined_for(program: &str) -> bool {
        std::fs::read_to_string(declined_path()).is_ok_and(|saved| saved == program)
    }

    /// Checks the rules, and when they're missing asks for them: always when `ask`, otherwise
    /// only if the owner hasn't already refused for this executable. Blocks; run off the runtime.
    pub fn ensure(ports: Ports, ask: bool) {
        let Ok(_running) = RUNNING.lock() else { return };
        *PORTS.lock().unwrap_or_else(|p| p.into_inner()) = Some(ports);
        let program = match std::env::current_exe() {
            Ok(path) => path.to_string_lossy().into_owned(),
            Err(error) => return set(State::Blocked, Some(error.to_string())),
        };
        set(State::Checking, None);
        match powershell(&check_script(&program, ports)) {
            Ok(answer) if answer == "open" => return set(State::Open, None),
            Ok(answer) if answer == "public" => return public(),
            Ok(_) => {}
            Err(error) => return set(State::Blocked, Some(error)),
        }
        if !ask && declined_for(&program) {
            return set(State::Declined, None);
        }
        // Blocked while the prompt waits, so the tray can ask again if it's left unanswered.
        set(State::Blocked, None);
        match powershell(&elevate_script(&apply_script(&program, ports))) {
            Ok(answer) if answer.ends_with("declined") => {
                let _ = std::fs::write(declined_path(), &program);
                return set(State::Declined, None);
            }
            Ok(_) => {}
            Err(error) => return set(State::Blocked, Some(error)),
        }
        let _ = std::fs::remove_file(declined_path());
        match powershell(&check_script(&program, ports)) {
            Ok(answer) if answer == "open" => set(State::Open, None),
            Ok(answer) if answer == "public" => public(),
            Ok(_) => set(State::Blocked, Some("Windows Firewall still blocks Ambra Server".into())),
            Err(error) => set(State::Blocked, Some(error)),
        }
    }

    fn public() {
        set(State::PublicNetwork, Some("Windows treats this network as public. Set it to private in Settings > Network & internet so other devices can connect.".into()));
    }

    /// Asks again, from the tray, for the ports the server listens on.
    pub fn retry() {
        let Some(ports) = *PORTS.lock().unwrap_or_else(|p| p.into_inner()) else { return };
        std::thread::spawn(move || ensure(ports, true));
    }
}
