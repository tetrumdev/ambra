//! WASAPI process-loopback capture, restricted to Soloist's process tree.
//!
//! Windows' process-loopback API does not suppress the target's physical render.
//! Keep the public capability closed until Soloist exposes a supported silent render
//! route. Muting a session can mute its captured samples; muting an endpoint changes
//! unrelated applications. Neither is an acceptable substitute for isolation.
use super::{
    super::{Error, ErrorCode},
    Capability,
};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc as sync_channel,
    },
    thread::JoinHandle,
    time::Duration,
};
use tokio::{process::Command, sync::mpsc};
use windows::{
    Win32::{
        Media::Audio::*,
        System::{
            Com::StructuredStorage::{
                PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
            },
            Com::{
                BLOB, COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize, IAgileObject,
                IAgileObject_Impl,
            },
            Variant::VT_BLOB,
        },
    },
    core::{ComObject, HRESULT, Interface, Ref, implement},
};

const SUPPRESSION_UNAVAILABLE: &str = "Windows process loopback cannot suppress Soloist speaker playback. Soloist has no supported silent WASAPI output route. Lossless capture is disabled; Spotify uses librespot High.";

pub fn capability() -> Capability {
    Capability {
        available: false,
        reason: SUPPRESSION_UNAVAILABLE.into(),
    }
}
fn unavailable(message: &str) -> Error {
    Error::new(ErrorCode::CaptureUnavailable, message)
}
fn native_error(_: windows::core::Error) -> Error {
    unavailable(
        "WASAPI process capture failed. Requires Windows build 20348 or newer, an interactive audio session, and supported 44,100 Hz stereo capture; retry playback.",
    )
}

pub struct Capture {
    pid: Option<u32>,
    cancelled: Arc<AtomicBool>,
    delivering: Arc<AtomicBool>,
    failure: Arc<Mutex<Option<Error>>>,
    receiver: mpsc::Receiver<Vec<u8>>,
    sender: Option<mpsc::Sender<Vec<u8>>>,
    worker: Option<JoinHandle<()>>,
    pending: Vec<u8>,
    offset: usize,
}
impl Capture {
    pub async fn start(_root: &Path) -> Result<Self, Error> {
        // Check before the caller launches Soloist. Never permit audible preroll.
        if !capability().available {
            return Err(unavailable(SUPPRESSION_UNAVAILABLE));
        }
        let (sender, receiver) = mpsc::channel(8);
        Ok(Self {
            pid: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            delivering: Arc::new(AtomicBool::new(false)),
            failure: Arc::new(Mutex::new(None)),
            sender: Some(sender),
            receiver,
            worker: None,
            pending: Vec::new(),
            offset: 0,
        })
    }
    pub fn route(&self, _command: &mut Command) {}
    pub async fn target(&mut self, pid: u32) -> Result<(), Error> {
        if !capability().available {
            return Err(unavailable(SUPPRESSION_UNAVAILABLE));
        }
        if pid == 0 || self.pid.is_some() {
            return Err(unavailable("Invalid or duplicate WASAPI process target"));
        }
        let sender = self
            .sender
            .take()
            .ok_or_else(|| unavailable("WASAPI capture already targeted"))?;
        let cancelled = self.cancelled.clone();
        let delivering = self.delivering.clone();
        let failure = self.failure.clone();
        let (ready, received) = tokio::sync::oneshot::channel();
        self.worker = Some(std::thread::spawn(move || {
            if let Err(error) = capture_process(pid, &cancelled, &delivering, &sender, ready) {
                *failure.lock().unwrap() = Some(error);
            }
        }));
        self.pid = Some(pid);
        tokio::time::timeout(Duration::from_secs(10), received)
            .await
            .map_err(|_| unavailable("WASAPI process activation timed out"))?
            .map_err(|_| {
                self.failure
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| unavailable("WASAPI process activation failed"))
            })?
    }
    pub fn check_alive(&mut self) -> Result<(), Error> {
        if let Some(error) = self.failure.lock().unwrap().clone() {
            return Err(error);
        }
        if self.worker.as_ref().is_some_and(JoinHandle::is_finished) {
            return Err(unavailable("WASAPI capture stopped; retry playback"));
        }
        Ok(())
    }
    pub async fn suspend(&self, suspended: bool) -> Result<(), Error> {
        // Stopping a loopback client does not stop Soloist's render clock. Fail rather
        // than drop content when transport needs backpressure after delivery starts.
        if suspended && self.delivering.load(Ordering::Acquire) {
            return Err(unavailable(
                "WASAPI cannot suspend Soloist rendering during output backpressure; retry playback",
            ));
        }
        self.delivering.store(!suspended, Ordering::Release);
        Ok(())
    }
    pub async fn verify_route(&self, pid: u32) -> Result<bool, Error> {
        if let Some(error) = self.failure.lock().unwrap().clone() {
            return Err(error);
        }
        Ok(self.pid == Some(pid)
            && self
                .worker
                .as_ref()
                .is_some_and(|worker| !worker.is_finished()))
    }
    pub fn discard_pending(&mut self) -> Result<(), Error> {
        if self.delivering.load(Ordering::Acquire) {
            return Err(unavailable("Cannot discard active WASAPI audio"));
        }
        self.pending.clear();
        self.offset = 0;
        while self.receiver.try_recv().is_ok() {}
        Ok(())
    }
    pub async fn read(&mut self, bytes: &mut [u8]) -> Result<usize, Error> {
        if bytes.is_empty() {
            return Ok(0);
        }
        self.check_alive()?;
        if self.offset == self.pending.len() {
            self.pending = self.receiver.recv().await.ok_or_else(|| {
                self.failure
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| unavailable("WASAPI capture disconnected"))
            })?;
            self.offset = 0;
        }
        let length = bytes.len().min(self.pending.len() - self.offset);
        bytes[..length].copy_from_slice(&self.pending[self.offset..self.offset + length]);
        self.offset += length;
        Ok(length)
    }
    pub async fn stop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        self.receiver.close();
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            let _ = tokio::task::spawn_blocking(move || worker.join()).await;
        }
        self.pending.clear();
        self.pid = None;
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        self.receiver.close();
        // No native handles cross threads. The worker owns COM and closes its client.
    }
}

#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct Activation {
    completed: sync_channel::Sender<()>,
    // Heap allocation remains valid until Windows releases its callback, including
    // after a caller timeout. The PROPVARIANT borrows this stable allocation.
    _parameters: Box<AUDIOCLIENT_ACTIVATION_PARAMS>,
    variant: PROPVARIANT,
}
// Immutable activation storage; only the thread-safe sender is used by callback.
unsafe impl Send for Activation {}
unsafe impl Sync for Activation {}
impl IAgileObject_Impl for Activation_Impl {}
impl IActivateAudioInterfaceCompletionHandler_Impl for Activation_Impl {
    fn ActivateCompleted(
        &self,
        _operation: Ref<IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let _ = self.completed.send(());
        Ok(())
    }
}
struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
struct RunningClient(IAudioClient);
impl Drop for RunningClient {
    fn drop(&mut self) {
        unsafe {
            let _ = self.0.Stop();
        }
    }
}

fn capture_process(
    pid: u32,
    cancelled: &AtomicBool,
    delivering: &AtomicBool,
    sender: &mpsc::Sender<Vec<u8>>,
    ready: tokio::sync::oneshot::Sender<Result<(), Error>>,
) -> Result<(), Error> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(native_error)?;
        let _apartment = Apartment;
        let mut parameters = Box::new(AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        });
        let variant = PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    Anonymous: PROPVARIANT_0_0_0 {
                        blob: BLOB {
                            cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                            pBlobData: (&mut *parameters as *mut AUDIOCLIENT_ACTIVATION_PARAMS)
                                .cast(),
                        },
                    },
                    ..Default::default()
                }),
            },
        };
        let (completed, completion) = sync_channel::channel();
        let callback = ComObject::new(Activation {
            completed,
            _parameters: parameters,
            variant,
        });
        let handler: IActivateAudioInterfaceCompletionHandler = callback.to_interface();
        let operation = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&callback.variant),
            &handler,
        )
        .map_err(native_error)?;
        completion
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| unavailable("WASAPI process activation timed out"))?;
        let mut result = HRESULT(0);
        let mut interface = None;
        operation
            .GetActivateResult(&mut result, &mut interface)
            .map_err(native_error)?;
        result.ok().map_err(native_error)?;
        let client: IAudioClient = interface
            .ok_or_else(|| unavailable("WASAPI returned no audio interface"))?
            .cast()
            .map_err(native_error)?;
        // Request an exact capture format. No automatic resampling flags. A driver
        // that cannot provide this format must fail instead of mislabelling PCM.
        let format = WAVEFORMATEX {
            wFormatTag: 3,
            nChannels: 2,
            nSamplesPerSec: 44_100,
            nAvgBytesPerSec: 352_800,
            nBlockAlign: 8,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                0,
                0,
                &format,
                None,
            )
            .map_err(native_error)?;
        let capture: IAudioCaptureClient = client.GetService().map_err(native_error)?;
        client.Start().map_err(native_error)?;
        let _running = RunningClient(client);
        let _ = ready.send(Ok(()));
        let mut received_audio = false;
        while !cancelled.load(Ordering::Acquire) {
            if capture.GetNextPacketSize().map_err(native_error)? == 0 {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            let mut data = std::ptr::null_mut();
            let mut frames = 0;
            let mut flags = 0;
            capture
                .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                .map_err(native_error)?;
            // Copy at most 32 KiB per packet into a bounded channel. Never block the
            // audio engine while holding its buffer. ReleaseBuffer runs on every path.
            let copied = (|| {
                if !delivering.load(Ordering::Acquire) {
                    return Ok(Vec::new());
                }
                if frames as usize > 32_768 / 8 {
                    return Err(unavailable("WASAPI packet exceeds capture buffer limit"));
                }
                if received_audio && flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
                    return Err(unavailable("WASAPI reported lost audio; retry playback"));
                }
                received_audio = true;
                if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                    return Ok(vec![0; frames as usize * 8]);
                }
                if data.is_null() {
                    return Err(unavailable("WASAPI returned an invalid audio buffer"));
                }
                let samples = std::slice::from_raw_parts(data.cast::<f32>(), frames as usize * 2);
                float_pcm(samples)
            })();
            capture.ReleaseBuffer(frames).map_err(native_error)?;
            let copied = copied?;
            if !copied.is_empty() {
                sender.try_send(copied).map_err(|_| {
                    unavailable("WASAPI output stalled; bounded capture buffer is full")
                })?;
            }
        }
        Ok(())
    }
}

fn float_pcm(samples: &[f32]) -> Result<Vec<u8>, Error> {
    let mut result = Vec::with_capacity(samples.len() * 4);
    for &sample in samples {
        if !sample.is_finite() {
            return Err(unavailable("WASAPI returned nonfinite PCM"));
        }
        let value = (f64::from(sample).clamp(-1.0, 1.0) * 2_147_483_648.0)
            .round()
            .clamp(i32::MIN as f64, i32::MAX as f64) as i32;
        result.extend_from_slice(&value.to_le_bytes());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn suppression_requirement_prevents_lossless_advertisement() {
        assert!(!capability().available);
        assert!(capability().reason.contains("speaker"));
    }
    #[test]
    fn float_format_conversion_preserves_sign_and_clips() {
        let bytes = float_pcm(&[-1.0, 0.0, 0.5, 1.0, 2.0]).unwrap();
        let values: Vec<_> = bytes
            .chunks_exact(4)
            .map(|b| i32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        assert_eq!(values, [i32::MIN, 0, 1 << 30, i32::MAX, i32::MAX]);
        assert!(float_pcm(&[f32::NAN]).is_err());
    }
    #[tokio::test]
    async fn unsupported_capture_fails_before_launch() {
        assert!(Capture::start(Path::new(".")).await.is_err());
    }
}
