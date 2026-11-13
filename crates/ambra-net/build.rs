use std::{env, path::PathBuf, process::Command};

fn main() {
    let target = env::var("TARGET").unwrap();
    let os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
        "aarch64" => "arm64", "x86_64" => "amd64", "arm" => "arm", other => panic!("Tailcat architecture: {other}"),
    };
    let goos = match os.as_str() {
        "macos" => "darwin", "ios" => "ios", "android" => "android", "linux" => "linux", "windows" => "windows", other => panic!("Tailcat OS: {other}"),
    };
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let archive = out.join("libambra_tailcat.a");
    let mut build = Command::new("go");
    build.current_dir("tailcat").env("CGO_ENABLED", "1").env("GOOS", goos).env("GOARCH", arch);
    for key in [format!("CC_{}", target.replace('-', "_")), "CC".into()] {
        println!("cargo:rerun-if-env-changed={key}");
        if let Some(cc) = env::var_os(&key) { build.env("CC", cc); break; }
    }
    if os == "ios" {
        let sdk = if target.ends_with("-sim") || arch == "amd64" { "iphonesimulator" } else { "iphoneos" };
        let output = Command::new("xcrun").args(["--sdk", sdk, "--show-sdk-path"]).output().expect("iOS requires Xcode");
        assert!(output.status.success(), "iOS SDK unavailable");
        let sdk = String::from_utf8(output.stdout).unwrap();
        let clang_target = if target.ends_with("-sim") || arch == "amd64" { format!("{}-apple-ios15.0-simulator", if arch == "amd64" {"x86_64"} else {"arm64"}) } else { "arm64-apple-ios15.0".into() };
        let flags = format!("-isysroot {} -target {clang_target}", sdk.trim());
        build.env("CC", "clang").env("CGO_CFLAGS", &flags).env("CGO_LDFLAGS", flags);
    }
    let tags = std::fs::read_to_string("tailcat/build-tags.txt").unwrap();
    let status = build.args(["build", "-mod=readonly", "-trimpath", "-buildmode=c-archive", "-tags", tags.trim(), "-o"]).arg(&archive).arg("github.com/tailscale/tailcat/cmd/libtailcat").status().expect("Tailcat builds require Go 1.27.4 and a C compiler");
    assert!(status.success(), "Tailcat native library build failed for {target}");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=ambra_tailcat");
    match os.as_str() {
        "macos" | "ios" => { for framework in ["CoreFoundation", "Security", "SystemConfiguration", "Foundation", "IOKit"] { println!("cargo:rustc-link-lib=framework={framework}"); } }
        "linux" | "android" => { for library in ["pthread", "dl", "m"] { println!("cargo:rustc-link-lib={library}"); } }
        "windows" => { for library in ["ws2_32", "winmm", "ntdll", "bcrypt", "iphlpapi", "userenv"] { println!("cargo:rustc-link-lib={library}"); } }
        _ => unreachable!(),
    }
    for file in ["tailcat/go.mod", "tailcat/go.sum", "tailcat/build-tags.txt", "build.rs"] { println!("cargo:rerun-if-changed={file}"); }
}
