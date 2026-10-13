// Standalone builds are windowed apps, including fast local debug builds.
#![cfg_attr(all(target_os = "windows", not(dev)), windows_subsystem = "windows")]

fn main() {
    ambra_lib::run()
}
