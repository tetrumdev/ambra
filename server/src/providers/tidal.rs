use std::{
    env, fs,
    io::{self, Write},
    path::PathBuf,
    process::Stdio,
    time::Duration,
};

use tidlers::{
    TidalClient,
    auth::TidalAuth,
    client::models::{
        playback::AudioQuality,
        track::playback::{DashManifest, ParsedTrackManifest, TrackPlaybackInfoResponse},
    },
};
use tokio::{io::AsyncWriteExt, process::Command};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

const EXAMPLE_TRACK_ID: &str = "66035607";

pub async fn run() -> Result<()> {
    let mut client = authenticated_client().await?;
    let track_id = track_id()?;

    client.set_audio_quality(AudioQuality::High);

    println!("Fetching track {track_id}...");
    let track = client.get_track(track_id.as_str()).await?;
    println!("Playing: {} - {}", track.artist.name, track.title);

    if !track.allow_streaming || !track.stream_ready {
        return Err(io::Error::other("Tidal reports that this track is not streamable").into());
    }

    let playback = client
        .get_track_postpaywall_playback_info(track_id.as_str(), None)
        .await?;

    println!(
        "Quality: {}, format: {}, codec: {}",
        playback.audio_quality,
        playback.get_mime_type().as_deref().unwrap_or("unknown"),
        playback.get_codecs().as_deref().unwrap_or("unknown")
    );

    play_with_mpv(&playback, track.duration).await
}

async fn authenticated_client() -> Result<TidalClient> {
    if let Some(client) = restore_session().await? {
        println!("Using saved Tidal session");
        return Ok(client);
    }

    let auth = TidalAuth::with_pkce();
    let mut client = TidalClient::new(&auth);
    let login_url = client.initiate_pkce_login()?;

    println!("Visit this URL and sign in:\n{login_url}\n");
    print!("Paste the full callback URL: ");
    io::stdout().flush()?;

    let mut redirect_url = String::new();
    io::stdin().read_line(&mut redirect_url)?;
    client.finish_pkce_login(redirect_url.trim()).await?;
    client.refresh_user_info().await?;
    save_session(&client)?;

    let username = client
        .user_info
        .as_ref()
        .map(|user| user.username.as_str())
        .unwrap_or("unknown user");
    println!("Logged in as {username}");

    Ok(client)
}

async fn restore_session() -> Result<Option<TidalClient>> {
    let session_json = match fs::read_to_string(session_path()) {
        Ok(session_json) => session_json,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };

    let mut client = match TidalClient::from_json(&session_json) {
        Ok(client) => client,
        Err(error) => {
            eprintln!("Saved Tidal session is invalid ({error}); signing in again");
            return Ok(None);
        }
    };

    if let Err(error) = client.refresh_access_token(false).await {
        eprintln!("Saved Tidal session cannot be refreshed ({error}); signing in again");
        return Ok(None);
    }

    if let Err(error) = client.refresh_user_info().await {
        eprintln!("Saved Tidal session cannot load the user ({error}); signing in again");
        return Ok(None);
    }

    save_session(&client)?;
    Ok(Some(client))
}

fn save_session(client: &TidalClient) -> Result<()> {
    let path = session_path();
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options.open(&path)?;
    file.write_all(client.get_json().as_bytes())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }

    Ok(())
}

fn session_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".tidal-session.json")
}

fn track_id() -> Result<String> {
    if let Some(track_id) = env::args().nth(1) {
        validate_track_id(&track_id)?;
        return Ok(track_id);
    }

    print!("Tidal track ID [{EXAMPLE_TRACK_ID}]: ");
    io::stdout().flush()?;

    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    let input = input.trim();
    let track_id = if input.is_empty() {
        EXAMPLE_TRACK_ID.to_owned()
    } else {
        input.to_owned()
    };

    validate_track_id(&track_id)?;
    Ok(track_id)
}

fn validate_track_id(track_id: &str) -> Result<()> {
    track_id.parse::<u64>().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("'{track_id}' is not a numeric Tidal track ID"),
        )
    })?;
    Ok(())
}

async fn play_with_mpv(
    playback: &TrackPlaybackInfoResponse,
    track_duration_seconds: u64,
) -> Result<()> {
    match playback.manifest_parsed.as_ref() {
        Some(ParsedTrackManifest::Json(manifest)) => {
            let stream_url = manifest.urls.first().ok_or_else(|| {
                io::Error::other("Tidal playback manifest contains no stream URL")
            })?;
            play_direct_stream(stream_url).await
        }
        Some(ParsedTrackManifest::Dash(manifest)) => {
            play_dash_stream(manifest, track_duration_seconds).await
        }
        None => Err(io::Error::other("Tidlers did not parse the playback manifest").into()),
    }
}

async fn play_direct_stream(stream_url: &str) -> Result<()> {
    println!("Starting mpv...");

    let status = Command::new("mpv")
        .arg("--no-video")
        .arg("--force-window=no")
        .arg("--")
        .arg(stream_url)
        .status()
        .await
        .map_err(mpv_start_error)?;

    ensure_mpv_succeeded(status)
}

async fn play_dash_stream(manifest: &DashManifest, track_duration_seconds: u64) -> Result<()> {
    let init_url = manifest.get_init_url().ok_or_else(|| {
        io::Error::other("Tidal DASH manifest contains no initialization segment")
    })?;
    let start_number = manifest.start_number.unwrap_or(1);
    let segment_count = dash_segment_count(manifest, track_duration_seconds);

    match segment_count {
        Some(count) => println!("Starting mpv with {count} DASH media segments..."),
        None => println!("Starting mpv with DASH media segments..."),
    }

    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;

    let mut child = Command::new("mpv")
        .arg("--no-video")
        .arg("--force-window=no")
        .arg("--demuxer-lavf-format=mp4")
        .arg("--")
        .arg("-")
        .stdin(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(mpv_start_error)?;

    let mut mpv_input = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("Could not open mpv input"))?;

    let init_url = normalize_dash_url(init_url);
    let init_bytes = download_segment(&http_client, &init_url, "initialization").await?;
    mpv_input.write_all(&init_bytes).await?;

    let maximum_segments = segment_count.unwrap_or(999);
    let mut streamed_segments = 0;
    let mut consecutive_failures = 0;

    for offset in 0..maximum_segments {
        let segment_number = start_number
            .checked_add(offset)
            .ok_or_else(|| io::Error::other("DASH segment number overflowed"))?;
        let segment_url = manifest
            .get_segment_url(segment_number)
            .ok_or_else(|| io::Error::other("Tidal DASH manifest contains no media template"))?;
        let segment_url = normalize_dash_url(&segment_url);

        match download_segment(
            &http_client,
            &segment_url,
            &format!("media segment {segment_number}"),
        )
        .await
        {
            Ok(bytes) => {
                mpv_input.write_all(&bytes).await?;
                streamed_segments += 1;
                consecutive_failures = 0;
            }
            Err(_) if segment_count.is_none() => {
                consecutive_failures += 1;
                if consecutive_failures >= 3 {
                    println!("Reached end of DASH stream after {streamed_segments} media segments");
                    break;
                }
            }
            Err(error) => return Err(error),
        }
    }

    if streamed_segments == 0 {
        return Err(io::Error::other("No Tidal DASH media segments were streamed").into());
    }

    mpv_input.shutdown().await?;
    drop(mpv_input);

    let status = child.wait().await?;
    ensure_mpv_succeeded(status)
}

fn normalize_dash_url(url: &str) -> String {
    url.replace("&amp;", "&")
}

fn dash_segment_count(manifest: &DashManifest, track_duration_seconds: u64) -> Option<u32> {
    let timescale = u64::from(manifest.timescale?);
    let segment_duration = u64::from(manifest.duration?);
    if timescale == 0 || segment_duration == 0 {
        return None;
    }

    let track_duration = track_duration_seconds.checked_mul(timescale)?;
    let count = track_duration
        .checked_add(segment_duration - 1)?
        .checked_div(segment_duration)?;
    count.try_into().ok()
}

async fn download_segment(
    client: &reqwest::Client,
    url: &str,
    description: &str,
) -> Result<Vec<u8>> {
    let response = client.get(url).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(
            io::Error::other(format!("Tidal returned HTTP {status} for {description}")).into(),
        );
    }

    let bytes = response.bytes().await?;
    if bytes.is_empty() {
        return Err(io::Error::other(format!("Tidal returned an empty {description}")).into());
    }

    Ok(bytes.to_vec())
}

fn mpv_start_error(error: io::Error) -> io::Error {
    if error.kind() == io::ErrorKind::NotFound {
        io::Error::new(
            io::ErrorKind::NotFound,
            "mpv was not found; install it or add it to PATH",
        )
    } else {
        error
    }
}

fn ensure_mpv_succeeded(status: std::process::ExitStatus) -> Result<()> {
    if !status.success() {
        return Err(io::Error::other(format!("mpv exited with status {status}")).into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{dash_segment_count, normalize_dash_url};
    use tidlers::client::models::track::playback::DashManifest;

    #[test]
    fn decodes_xml_entities_in_signed_dash_urls() {
        let encoded = "https://audio.example/segment?token=abc&amp;expires=123";

        assert_eq!(
            normalize_dash_url(encoded),
            "https://audio.example/segment?token=abc&expires=123"
        );
    }

    #[test]
    fn calculates_dash_segment_count_from_track_duration() {
        let manifest = DashManifest {
            mime_type: "audio/mp4".to_owned(),
            codecs: "mp4a.40.2".to_owned(),
            urls: Vec::new(),
            bitrate: None,
            initialization_url: None,
            media_url_template: None,
            timescale: Some(1_000),
            duration: Some(4_000),
            start_number: Some(1),
        };

        assert_eq!(dash_segment_count(&manifest, 230), Some(58));
    }
}
