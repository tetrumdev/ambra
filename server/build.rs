fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rustc-check-cfg=cfg(ambra_development_build)");
    // Keep release forwarding disabled even if a packager enables debug assertions.
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        println!("cargo:rustc-cfg=ambra_development_build");
    }
}
