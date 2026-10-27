//! Opt-in Windows validation without Spotify credentials. Requires the configured
//! server driver. The source emits silence until its private route is verified.
use super::*;
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance, CoTaskMemFree};

#[test]
#[ignore = "Internal child of windows_virtual_route_captures_exact_pcm; do not run directly"]
fn render_fixture() {
    let release =
        std::env::var_os("AMBRA_WASAPI_FIXTURE_RELEASE").expect("capture test parent required");
    let _apartment = route::Apartment::enter().unwrap();
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).unwrap();
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .unwrap();
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None).unwrap();
        let format = client.GetMixFormat().unwrap();
        assert!(!format.is_null());
        let wave = format.read_unaligned();
        let rate = wave.nSamplesPerSec;
        let channels = wave.nChannels;
        let bits = wave.wBitsPerSample;
        assert_eq!((rate, channels, bits), (44_100, 2, 32));
        client
            .Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 1_000_000, 0, format, None)
            .unwrap();
        CoTaskMemFree(Some(format.cast()));
        let render: IAudioRenderClient = client.GetService().unwrap();
        let volume: ISimpleAudioVolume = client.GetService().unwrap();
        volume.SetMasterVolume(1.0, std::ptr::null()).unwrap();
        volume.SetMute(false, std::ptr::null()).unwrap();
        let capacity = client.GetBufferSize().unwrap();
        client.Start().unwrap();
        let _running = RunningClient(client.clone());
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            let frames = capacity - client.GetCurrentPadding().unwrap();
            if frames > 0 {
                let samples = render.GetBuffer(frames).unwrap().cast::<f32>();
                let enabled = Path::new(&release).is_file();
                for index in 0..frames as usize {
                    samples
                        .add(index * 2)
                        .write(if enabled { 0.25 } else { 0.0 });
                    samples
                        .add(index * 2 + 1)
                        .write(if enabled { -0.5 } else { 0.0 });
                }
                render.ReleaseBuffer(frames, 0).unwrap();
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

#[tokio::test]
#[ignore = "Requires Windows build 20348+, the consented/configured server VB-CABLE driver, and an audio session"]
async fn windows_virtual_route_captures_exact_pcm() {
    let status = capability();
    assert!(status.available, "{}", status.reason);
    let directory = crate::soloist::tests::directory();
    let release = directory.join("start-audio");
    let mut capture = Capture::start(&directory).await.unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--ignored",
            "--exact",
            "soloist::capture::windows::native_tests::render_fixture",
        ])
        .env("AMBRA_WASAPI_FIXTURE_RELEASE", &release)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    capture.route(&mut command);
    let mut child = command.spawn().unwrap();
    let pid = child.id().unwrap();
    capture.target(pid).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !capture.verify_route(pid).await.unwrap() {
            capture.check_alive().unwrap();
            assert!(child.try_wait().unwrap().is_none(), "render fixture exited");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("source must be routed silently before generating samples");
    capture.discard_pending().unwrap();
    capture.suspend(false).await.unwrap();
    std::fs::write(&release, b"verified").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut bytes = [0; crate::live_pcm::MAX_CHUNK];
        loop {
            let count = capture.read(&mut bytes).await.unwrap();
            for frame in bytes[..count].chunks_exact(8) {
                let left = i32::from_le_bytes(frame[..4].try_into().unwrap());
                let right = i32::from_le_bytes(frame[4..].try_into().unwrap());
                if left != 0 || right != 0 {
                    assert_eq!((left, right), (1 << 29, -(1 << 30)));
                    return;
                }
            }
        }
    })
    .await
    .expect("exact source PCM must reach the server capture");
    assert!(child.try_wait().unwrap().is_none());
    capture.stop().await;
    tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .expect("capture job must terminate its source")
        .unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}
