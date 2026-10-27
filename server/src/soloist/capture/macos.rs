//! Server-only macOS 14.2 process tap. Native input is converted to protocol S32LE.
//! Capture never mixes unrelated processes or adds a physical output device.
use super::super::{Error, ErrorCode};
use super::Capability;
use std::{
    ffi::c_void,
    path::Path,
    ptr::NonNull,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::process::Command;

unsafe extern "C" {
    fn ambra_tap_available() -> i32;
    fn ambra_tap_process(pid: u32) -> u32;
    fn ambra_tap_open(pid: u32, error: *mut i32) -> *mut c_void;
    fn ambra_tap_close(tap: *mut c_void);
    fn ambra_tap_check(tap: *mut c_void, pid: u32) -> i32;
    fn ambra_tap_deliver(tap: *mut c_void);
    fn ambra_tap_read(tap: *mut c_void, destination: *mut u8, capacity: usize) -> usize;
    #[cfg(test)]
    fn ambra_tap_test_ring() -> i32;
}

pub fn capability() -> Capability {
    // This queries OS availability only. Permission is requested by Core Audio when IO starts.
    let available = unsafe { ambra_tap_available() != 0 };
    Capability {
        available,
        reason: if available {
            "Core Audio process taps available; grant Ambra Server system audio recording permission when prompted. A logged-in audio session and 44,100 Hz stereo format are required."
        } else {
            "Soloist capture requires macOS 14.2 or newer."
        }.into(),
    }
}

fn failure(status: i32) -> Error {
    let message = match status {
        -10001 => {
            "Core Audio tap format changed or is unsupported. Capture requires native 44,100 Hz stereo Float32 or signed Int32; Ambra does not silently resample."
        }
        -10002 => {
            "Core Audio capture buffer overflowed. Output stalled; retry playback at the saved position."
        }
        -10003 => {
            "Soloist Core Audio process disappeared or no audio session is available. Run Ambra Server in a logged-in macOS audio session."
        }
        _ => {
            "Core Audio process tap failed. Grant Ambra Server system audio recording permission in System Settings > Privacy & Security, then retry. A logged-in audio session is required."
        }
    };
    Error::new(
        ErrorCode::CaptureUnavailable,
        &format!("{message} (Core Audio status {status})"),
    )
}

struct NativeTap(NonNull<c_void>);
// Only the IO callback writes the ring. Rust is the single consumer. Shared control
// operations are atomic or read-only Core Audio queries; destruction requires &mut Capture.
unsafe impl Send for NativeTap {}
unsafe impl Sync for NativeTap {}
impl Drop for NativeTap {
    fn drop(&mut self) {
        unsafe { ambra_tap_close(self.0.as_ptr()) };
    }
}

pub struct Capture {
    tap: Option<NativeTap>,
    pid: Option<u32>,
    delivering: AtomicBool,
}
impl Capture {
    pub async fn start(_root: &Path) -> Result<Self, Error> {
        let capability = capability();
        if !capability.available {
            return Err(Error::new(
                ErrorCode::CaptureUnavailable,
                &capability.reason,
            ));
        }
        Ok(Self {
            tap: None,
            pid: None,
            delivering: AtomicBool::new(false),
        })
    }

    pub fn route(&self, _command: &mut Command) {
        // Runtime starts Soloist at zero volume; target() installs a permanently
        // muted process tap before Runtime raises Soloist's rendering volume.
    }

    pub async fn target(&mut self, pid: u32) -> Result<(), Error> {
        if self.pid == Some(pid) && self.tap.is_some() {
            return Ok(());
        }
        if self.tap.is_some() {
            return Err(failure(-10003));
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while unsafe { ambra_tap_process(pid) } == 0 {
            if tokio::time::Instant::now() >= deadline {
                return Err(failure(-10003));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // Permission/UI and native construction must not block Tokio's worker.
        // The owning return value cleans up even if this future is cancelled.
        let task = tokio::task::spawn_blocking(move || {
            let mut status = 0;
            let pointer = unsafe { ambra_tap_open(pid, &mut status) };
            NonNull::new(pointer)
                .map(NativeTap)
                .ok_or_else(|| failure(status))
        });
        self.tap = Some(
            tokio::time::timeout(Duration::from_secs(30), task)
                .await
                .map_err(|_| failure(-10003))?
                .map_err(|_| failure(-10003))??,
        );
        self.pid = Some(pid);
        Ok(())
    }

    pub fn check_alive(&mut self) -> Result<(), Error> {
        let (Some(tap), Some(pid)) = (&self.tap, self.pid) else {
            return Err(failure(-10003));
        };
        let status = unsafe { ambra_tap_check(tap.0.as_ptr(), pid) };
        if status == 0 {
            Ok(())
        } else {
            Err(failure(status))
        }
    }

    pub async fn verify_route(&self, pid: u32) -> Result<bool, Error> {
        let Some(tap) = &self.tap else {
            return Ok(false);
        };
        if self.pid != Some(pid) {
            return Err(failure(-10003));
        }
        let status = unsafe { ambra_tap_check(tap.0.as_ptr(), pid) };
        if status == 0 {
            Ok(true)
        } else {
            Err(failure(status))
        }
    }

    pub async fn suspend(&self, suspended: bool) -> Result<(), Error> {
        if !suspended {
            let tap = self.tap.as_ref().ok_or_else(|| failure(-10003))?;
            unsafe { ambra_tap_deliver(tap.0.as_ptr()) };
            self.delivering.store(true, Ordering::Release);
        }
        // Core Audio cannot backpressure the renderer. After pre-roll, retain every
        // sample in the bounded native ring; overflow fails instead of dropping audio.
        // Never stop the IOProc here: the tap must keep physical playback muted.
        Ok(())
    }

    pub fn discard_pending(&mut self) -> Result<(), Error> {
        // Initial delivery is disabled inside the native callback. No audio is queued
        // until suspend(false); unlike Linux, discarding a live ring is forbidden.
        if self.delivering.load(Ordering::Acquire) {
            return Err(failure(-10003));
        }
        Ok(())
    }

    pub async fn read(&mut self, bytes: &mut [u8]) -> Result<usize, Error> {
        if bytes.len() < 8 {
            return Err(failure(-10001));
        }
        loop {
            self.check_alive()?;
            let tap = self.tap.as_ref().ok_or_else(|| failure(-10003))?;
            let count = unsafe { ambra_tap_read(tap.0.as_ptr(), bytes.as_mut_ptr(), bytes.len()) };
            if count != 0 {
                return Ok(count);
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    pub async fn stop(&mut self) {
        self.tap.take();
        self.pid = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_converts_pcm_aligns_reads_and_rejects_overflow() {
        assert_eq!(unsafe { ambra_tap_test_ring() }, 1);
    }

    #[tokio::test]
    async fn capture_rejects_unbound_process_and_cleans_up_idempotently() {
        if !capability().available {
            return;
        }
        let mut capture = Capture::start(Path::new("unused")).await.unwrap();
        assert!(!capture.verify_route(u32::MAX).await.unwrap());
        assert!(capture.check_alive().is_err());
        assert!(capture.suspend(false).await.is_err());
        capture.stop().await;
        capture.stop().await;
    }
}
