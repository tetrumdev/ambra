use std::{env, path::PathBuf, process::Command};

fn main() {
    let target = env::var("TARGET").unwrap();
    let os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        "arm" => "arm",
        other => panic!("Tailcat architecture: {other}"),
    };
    let goos = match os.as_str() {
        "macos" => "darwin",
        "ios" => "ios",
        "android" => "android",
        "linux" => "linux",
        "windows" => "windows",
        other => panic!("Tailcat OS: {other}"),
    };
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let shared = os == "android";
    let archive = out.join(if shared {
        "libambra_tailcat.so"
    } else if target.ends_with("msvc") {
        "ambra_tailcat.lib"
    } else {
        "libambra_tailcat.a"
    });
    let mut build = Command::new("go");
    build.env("GOMAXPROCS", "2");
    if os == "windows" && env::var("HOST").unwrap() != target {
        build.env("CC", "x86_64-w64-mingw32-gcc");
    }
    if os == "macos" {
        let flags = format!(
            "-arch {} -mmacosx-version-min=11.0",
            if arch == "amd64" { "x86_64" } else { "arm64" }
        );
        build.env("CGO_CFLAGS", &flags).env("CGO_LDFLAGS", flags);
    }
    build
        .current_dir("tailcat")
        .env("CGO_ENABLED", "1")
        .env("GOOS", goos)
        .env("GOARCH", arch);
    for key in [
        format!("CC_{target}"),
        format!("CC_{}", target.replace('-', "_")),
        "TARGET_CC".into(),
        "CC".into(),
    ] {
        println!("cargo:rerun-if-env-changed={key}");
        if let Some(cc) = env::var_os(&key) {
            build.env("CC", cc);
            break;
        }
    }
    if shared {
        let flags = [
            format!("CFLAGS_{target}"),
            format!("CFLAGS_{}", target.replace('-', "_")),
            "TARGET_CFLAGS".into(),
            "CFLAGS".into(),
        ]
        .into_iter()
        .find_map(|key| {
            println!("cargo:rerun-if-env-changed={key}");
            env::var(key).ok()
        })
        .unwrap_or_default();
        build.env("CGO_CFLAGS", &flags);
        let pages = if arch == "arm" {
            ""
        } else {
            " -Wl,-z,max-page-size=16384"
        };
        build.env(
            "CGO_LDFLAGS",
            format!("{flags} -Wl,-soname,libambra_tailcat.so{pages}"),
        );
    }
    if os == "ios" {
        let sdk = if target.ends_with("-sim") || arch == "amd64" {
            "iphonesimulator"
        } else {
            "iphoneos"
        };
        let output = Command::new("xcrun")
            .args(["--sdk", sdk, "--show-sdk-path"])
            .output()
            .expect("iOS requires Xcode");
        assert!(output.status.success(), "iOS SDK unavailable");
        let sdk = String::from_utf8(output.stdout).unwrap();
        let clang_target = if target.ends_with("-sim") || arch == "amd64" {
            format!(
                "{}-apple-ios15.0-simulator",
                if arch == "amd64" { "x86_64" } else { "arm64" }
            )
        } else {
            "arm64-apple-ios15.0".into()
        };
        let flags = format!("-isysroot {} -target {clang_target}", sdk.trim());
        build
            .env("CC", "clang")
            .env("CGO_CFLAGS", &flags)
            .env("CGO_LDFLAGS", flags);
    }
    let tags = std::fs::read_to_string("tailcat/build-tags.txt").unwrap();
    let status = build
        .args([
            "build",
            "-mod=readonly",
            "-trimpath",
            if shared {
                "-buildmode=c-shared"
            } else {
                "-buildmode=c-archive"
            },
            "-tags",
            tags.trim(),
            "-o",
        ])
        .arg(&archive)
        .arg("github.com/tailscale/tailcat/cmd/libtailcat")
        .status()
        .expect("Tailcat builds require Go 1.27.4 and a C compiler");
    assert!(
        status.success(),
        "Tailcat native library build failed for {target}"
    );
    println!("cargo:rustc-link-search=native={}", out.display());
    println!(
        "cargo:rustc-link-lib={}={}",
        if shared { "dylib" } else { "static" },
        "ambra_tailcat"
    );
    if shared {
        // Publish the dependent library beside the Rust cdylib for Android packaging.
        let profile = out
            .ancestors()
            .nth(3)
            .expect("Cargo target/profile/build/package/out");
        std::fs::copy(&archive, profile.join("libambra_tailcat.so"))
            .expect("publish Android Tailcat library");
    }
    match os.as_str() {
        "macos" | "ios" => {
            for framework in [
                "CoreFoundation",
                "Security",
                "SystemConfiguration",
                "Foundation",
            ] {
                println!("cargo:rustc-link-lib=framework={framework}");
            }
            if os == "macos" {
                println!("cargo:rustc-link-lib=framework=IOKit");
            }
        }
        "linux" => {
            for library in ["pthread", "dl", "m"] {
                println!("cargo:rustc-link-lib={library}");
            }
        }
        "android" => {
            for library in ["dl", "m", "log"] {
                println!("cargo:rustc-link-lib={library}");
            }
        }
        "windows" => {
            for library in ["ws2_32", "winmm", "ntdll", "bcrypt", "iphlpapi", "userenv"] {
                println!("cargo:rustc-link-lib={library}");
            }
        }
        _ => unreachable!(),
    }
    for file in [
        "tailcat/go.mod",
        "tailcat/go.sum",
        "tailcat/build-tags.txt",
        "build.rs",
    ] {
        println!("cargo:rerun-if-changed={file}");
    }
}
