fn main() {
    build_macos_capture();
    // ARCH=arm does not identify the ARM ISA, and rustc does not emit a v7 cfg feature.
    println!(
        "cargo:rustc-env=AMBRA_SERVER_TARGET={}",
        std::env::var("TARGET").expect("TARGET")
    );
    println!("cargo:rerun-if-changed=build.rs");
}

// This helper is linked only into the independently installed server executable.
fn build_macos_capture() {
    use std::{path::PathBuf, process::Command};
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let object = out.join("soloist-macos.o");
    let archive = out.join("libambra_soloist_macos.a");
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => panic!("unsupported macOS server architecture"),
    };
    let status = Command::new("xcrun")
        .args([
            "clang",
            "-arch",
            arch,
            "-fobjc-arc",
            "-std=c11",
            "-mmacosx-version-min=11.0",
            "-O2",
            "-c",
            "src/soloist/capture/macos.m",
            "-o",
        ])
        .arg(&object)
        .status()
        .expect("macOS server capture requires Xcode command line tools");
    assert!(
        status.success(),
        "could not compile server Core Audio capture"
    );
    let status = Command::new("xcrun")
        .args(["ar", "crs"])
        .arg(&archive)
        .arg(&object)
        .status()
        .expect("could not archive Core Audio capture");
    assert!(
        status.success(),
        "could not archive server Core Audio capture"
    );
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=ambra_soloist_macos");
    println!("cargo:rustc-link-lib=framework=CoreAudio");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!(
        "cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}",
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("Info.plist")
            .display()
    );
    println!("cargo:rerun-if-changed=src/soloist/capture/macos.m");
    println!("cargo:rerun-if-changed=Info.plist");
}
